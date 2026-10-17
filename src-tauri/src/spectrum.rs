//! Spectrum analyser.
//!
//! The FFT runs on its own thread, never in the audio callback: a 2048-point
//! transform per buffer would cause dropouts. The audio thread only pushes
//! mono samples into a bounded channel and drops them if the UI falls behind.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Receiver;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SPECTRUM_EVENT: &str = "spectrum";

/// 2048 is the larger of the two window sizes the spec allows: better frequency
/// resolution in the bass, where the log banding is densest.
pub const FFT_SIZE: usize = 2048;
pub const BIN_COUNT: usize = 64;

/// ~45 Hz, inside the 30–60 Hz budget.
const EMIT_INTERVAL: Duration = Duration::from_millis(22);

const MIN_HZ: f32 = 30.0;
const MAX_HZ: f32 = 16_000.0;
/// Anything quieter than this reads as zero.
const FLOOR_DB: f32 = -90.0;

/// Per-tick smoothing: quick to rise, slower to fall, so bars do not flicker.
const ATTACK: f32 = 0.55;
const RELEASE: f32 = 0.10;

/// Faster decay used when nothing is playing, so the display reaches zero in
/// roughly 300 ms (about 13 ticks at 45 Hz) instead of lingering.
const IDLE_DECAY: f32 = 0.30;
const IDLE_FLOOR: f32 = 0.002;

/// Samples the audio thread may queue before we start dropping them.
const CHANNEL_CAPACITY: usize = 16_384;

#[derive(Debug, Clone, Serialize)]
pub struct SpectrumPayload {
    pub bins: Vec<f32>,
    /// Loudest band, 0.0..1.0.
    pub peak: f32,
}

fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            let x = std::f32::consts::TAU * i as f32 / (size.saturating_sub(1)).max(1) as f32;
            0.5 * (1.0 - x.cos())
        })
        .collect()
}

/// Log-spaced FFT bin ranges, one per output band.
fn band_edges(sample_rate: f32) -> Vec<(usize, usize)> {
    let usable = FFT_SIZE / 2;
    let nyquist = (sample_rate * 0.5).max(MIN_HZ * 2.0);
    let ratio = MAX_HZ / MIN_HZ;

    (0..BIN_COUNT)
        .map(|band| {
            let low_hz = MIN_HZ * ratio.powf(band as f32 / BIN_COUNT as f32);
            let high_hz = MIN_HZ * ratio.powf((band + 1) as f32 / BIN_COUNT as f32);
            let to_bin = |hz: f32| ((hz / nyquist) * usable as f32).round() as usize;

            // Keep DC out, and never let a band collapse to an empty range.
            let low = to_bin(low_hz).clamp(1, usable - 1);
            let high = to_bin(high_hz).max(low + 1).min(usable);
            (low, high)
        })
        .collect()
}

/// The centre frequency of a band, used by the tests to locate a tone.
#[cfg(test)]
fn band_centre(band: usize, _sample_rate: f32) -> f32 {
    let ratio = MAX_HZ / MIN_HZ;
    MIN_HZ * ratio.powf((band as f32 + 0.5) / BIN_COUNT as f32)
}

/// Reusable FFT scratch. Owned by the analyser thread so nothing allocates per
/// tick.
struct Analyser {
    fft: Arc<dyn Fft<f32>>,
    hann: Vec<f32>,
    buffer: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    edges: Vec<(usize, usize)>,
    sample_rate: f32,
}

impl Analyser {
    fn new(sample_rate: f32) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];

        Self {
            fft,
            hann: hann_window(FFT_SIZE),
            buffer: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            scratch,
            edges: band_edges(sample_rate),
            sample_rate,
        }
    }

    fn set_sample_rate(&mut self, sample_rate: f32) {
        if (sample_rate - self.sample_rate).abs() < 1.0 {
            return;
        }
        self.sample_rate = sample_rate;
        self.edges = band_edges(sample_rate);
    }

    /// Windowed magnitude per band, normalised to 0.0..1.0. No temporal
    /// smoothing — the caller owns that.
    fn magnitudes(&mut self, samples: &[f32]) -> Vec<f32> {
        debug_assert_eq!(samples.len(), FFT_SIZE);

        for (slot, (sample, window)) in self
            .buffer
            .iter_mut()
            .zip(samples.iter().zip(self.hann.iter()))
        {
            *slot = Complex::new(sample * window, 0.0);
        }

        self.fft
            .process_with_scratch(&mut self.buffer, &mut self.scratch);

        // Hann coherent gain is 0.5, and a real sine splits across two bins.
        let scale = 4.0 / FFT_SIZE as f32;

        self.edges
            .iter()
            .map(|&(low, high)| {
                let magnitude = self.buffer[low..high]
                    .iter()
                    .fold(0.0f32, |max, bin| max.max(bin.norm() * scale));

                let db = 20.0 * magnitude.max(1e-9).log10();
                ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
            })
            .collect()
    }
}

/// Start the analyser thread. Returns immediately.
pub fn spawn(app: AppHandle, receiver: Receiver<f32>, sample_rate: Arc<AtomicU32>) {
    std::thread::spawn(move || {
        let mut analyser = Analyser::new(sample_rate.load(Ordering::Relaxed).max(1) as f32);
        let mut smoothed = vec![0.0f32; BIN_COUNT];

        // Circular history of the most recent samples.
        let mut history = vec![0.0f32; FFT_SIZE];
        let mut cursor = 0usize;
        let mut frame = vec![0.0f32; FFT_SIZE];

        loop {
            std::thread::sleep(EMIT_INTERVAL);

            analyser.set_sample_rate(sample_rate.load(Ordering::Relaxed).max(1) as f32);

            let mut fresh = 0usize;
            while let Ok(sample) = receiver.try_recv() {
                history[cursor] = sample;
                cursor = (cursor + 1) % FFT_SIZE;
                fresh += 1;
                // Never spin here; catching up is the UI's problem, not ours.
                if fresh >= FFT_SIZE {
                    break;
                }
            }

            if fresh == 0 {
                // Nothing is playing: let the display fall to zero and publish
                // the decay so the canvas animates down instead of snapping.
                if smoothed.iter().all(|value| *value == 0.0) {
                    // Already dark — stop emitting entirely until audio returns,
                    // so an idle player costs nothing on the IPC bus.
                    continue;
                }

                let mut peak = 0.0f32;
                for value in smoothed.iter_mut() {
                    *value -= *value * IDLE_DECAY;
                    if *value < IDLE_FLOOR {
                        *value = 0.0;
                    }
                    peak = peak.max(*value);
                }
                let _ = app.emit(
                    SPECTRUM_EVENT,
                    &SpectrumPayload {
                        bins: smoothed.clone(),
                        peak,
                    },
                );
                continue;
            }

            // Linearise the ring, oldest sample first.
            for (i, slot) in frame.iter_mut().enumerate() {
                *slot = history[(cursor + i) % FFT_SIZE];
            }

            let measured = analyser.magnitudes(&frame);
            let mut peak = 0.0f32;
            for (value, target) in smoothed.iter_mut().zip(measured) {
                let coefficient = if target > *value { ATTACK } else { RELEASE };
                *value += (target - *value) * coefficient;
                peak = peak.max(*value);
            }

            let _ = app.emit(
                SPECTRUM_EVENT,
                &SpectrumPayload {
                    bins: smoothed.clone(),
                    peak,
                },
            );
        }
    });
}

/// Bounded channel feeding the analyser: the audio thread never blocks.
pub fn channel() -> (crossbeam_channel::Sender<f32>, Receiver<f32>) {
    crossbeam_channel::bounded(CHANNEL_CAPACITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 48_000.0;

    fn tone(frequency: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|i| (std::f32::consts::TAU * frequency * i as f32 / FS).sin())
            .collect()
    }

    fn loudest_band(bins: &[f32]) -> usize {
        bins.iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(index, _)| index)
            .unwrap()
    }

    /* ---- step 6: FFT on a known signal ---- */

    #[test]
    fn a_1khz_tone_lands_in_the_band_that_contains_1khz() {
        let mut analyser = Analyser::new(FS);
        let bins = analyser.magnitudes(&tone(1000.0));

        let detected = loudest_band(&bins);
        let expected = (0..BIN_COUNT)
            .min_by(|a, b| {
                (band_centre(*a, FS) - 1000.0)
                    .abs()
                    .partial_cmp(&(band_centre(*b, FS) - 1000.0).abs())
                    .unwrap()
            })
            .unwrap();

        assert!(
            (detected as i32 - expected as i32).abs() <= 1,
            "1 kHz landed in band {detected}, expected {expected}"
        );
        assert!(bins[detected] > 0.5, "tone should be loud, got {}", bins[detected]);
    }

    #[test]
    fn a_60hz_tone_lands_low_and_a_12khz_tone_lands_high() {
        let mut analyser = Analyser::new(FS);
        let low = loudest_band(&analyser.magnitudes(&tone(60.0)));
        let high = loudest_band(&analyser.magnitudes(&tone(12_000.0)));

        assert!(low < BIN_COUNT / 4, "60 Hz landed at band {low}");
        assert!(high > BIN_COUNT * 3 / 4, "12 kHz landed at band {high}");
        assert!(low < high);
    }

    #[test]
    fn silence_reads_as_zero() {
        let mut analyser = Analyser::new(FS);
        let bins = analyser.magnitudes(&vec![0.0f32; FFT_SIZE]);
        assert!(
            bins.iter().all(|value| *value == 0.0),
            "silence produced energy: {:?}",
            bins.iter().filter(|v| **v > 0.0).collect::<Vec<_>>()
        );
    }

    #[test]
    fn bands_are_log_spaced_and_cover_the_audible_range() {
        let edges = band_edges(FS);
        assert_eq!(edges.len(), BIN_COUNT);

        for (index, &(low, high)) in edges.iter().enumerate() {
            assert!(low < high, "band {index} is empty");
            assert!(high <= FFT_SIZE / 2, "band {index} exceeds Nyquist");
        }
        // Contiguous and non-decreasing across the spectrum.
        for pair in edges.windows(2) {
            assert!(pair[0].0 <= pair[1].0);
        }
        // The top band has to reach well above 10 kHz.
        let (_, top) = edges[BIN_COUNT - 1];
        let top_hz = top as f32 / (FFT_SIZE / 2) as f32 * (FS / 2.0);
        assert!(top_hz > 10_000.0, "top band only reaches {top_hz} Hz");
    }

    #[test]
    fn a_low_sample_rate_does_not_produce_empty_bands() {
        let edges = band_edges(22_050.0);
        for (index, &(low, high)) in edges.iter().enumerate() {
            assert!(low < high, "band {index} collapsed at 22.05 kHz");
        }
    }
}
