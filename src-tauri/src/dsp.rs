//! DSP chain: 10-band peaking EQ → gain ramp → limiter, plus the FFT tap.
//!
//! Everything on the audio path is allocation-free and lock-free: the UI thread
//! publishes parameters through atomics, the audio thread picks them up on a
//! revision counter, and processed samples are pushed to the spectrum thread
//! through an SPSC ring. No mutex is ever taken while audio is being produced.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use biquad::coefficients::Type;
use biquad::frequency::Hertz;
use biquad::{Biquad, Coefficients, DirectForm1};
use crossbeam_channel::Sender;
use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, Sample, SampleRate};

/* ------------------------------------------------------------------ bands */

pub const BAND_COUNT: usize = 10;

/// Band centres, low to high — the cascade runs in this order.
pub const BAND_FREQUENCIES: [f32; BAND_COUNT] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

pub const BAND_Q: f32 = 1.0;
pub const BAND_GAIN_LIMIT_DB: f32 = 12.0;

/* --------------------------------------------------------------- presets */

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub gains: [f32; BAND_COUNT],
}

pub const PRESETS: [Preset; 5] = [
    Preset {
        id: "flat",
        label: "Flat",
        gains: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    },
    Preset {
        id: "bass",
        label: "Bass Boost",
        gains: [6.0, 6.0, 5.0, 3.0, 0.0, 0.0, 0.0, 0.0, -1.0, -2.0],
    },
    Preset {
        id: "vocal",
        label: "Vocal",
        gains: [-2.0, -2.0, -1.0, 0.0, 1.0, 3.0, 3.0, 2.0, 1.0, -1.0],
    },
    Preset {
        id: "rock",
        label: "Rock",
        gains: [3.0, 3.0, 2.0, 0.0, -2.0, -1.0, 2.0, 3.0, 3.0, 3.0],
    },
    Preset {
        id: "guly",
        label: "Guly",
        gains: [5.0, 5.0, 3.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0],
    },
];

pub fn preset_by_id(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|preset| preset.id == id)
}

/* ---------------------------------------------------------- shared params */

/// Parameters published by the UI thread and consumed by the audio thread.
#[derive(Debug)]
pub struct DspParams {
    /// Bumped on every change; the audio thread rebuilds only when it moves.
    revision: AtomicU64,
    eq_enabled: AtomicBool,
    limiter_enabled: AtomicBool,
    gain: AtomicU32,
    bands: [AtomicU32; BAND_COUNT],
}

impl Default for DspParams {
    fn default() -> Self {
        Self::new()
    }
}

impl DspParams {
    pub fn new() -> Self {
        Self {
            revision: AtomicU64::new(1),
            eq_enabled: AtomicBool::new(true),
            limiter_enabled: AtomicBool::new(true),
            gain: AtomicU32::new(1.0f32.to_bits()),
            bands: std::array::from_fn(|_| AtomicU32::new(0.0f32.to_bits())),
        }
    }

    #[inline]
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    #[inline]
    fn touch(&self) {
        self.revision.fetch_add(1, Ordering::Release);
    }

    pub fn eq_enabled(&self) -> bool {
        self.eq_enabled.load(Ordering::Relaxed)
    }

    pub fn set_eq_enabled(&self, enabled: bool) {
        self.eq_enabled.store(enabled, Ordering::Relaxed);
        self.touch();
    }

    pub fn limiter_enabled(&self) -> bool {
        self.limiter_enabled.load(Ordering::Relaxed)
    }

    pub fn set_limiter_enabled(&self, enabled: bool) {
        self.limiter_enabled.store(enabled, Ordering::Relaxed);
        self.touch();
    }

    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    pub fn set_gain(&self, value: f32) {
        self.gain
            .store(value.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
        self.touch();
    }

    pub fn bands(&self) -> [f32; BAND_COUNT] {
        std::array::from_fn(|i| f32::from_bits(self.bands[i].load(Ordering::Relaxed)))
    }

    pub fn set_bands(&self, gains: [f32; BAND_COUNT]) {
        for (slot, value) in self.bands.iter().zip(gains) {
            slot.store(
                value.clamp(-BAND_GAIN_LIMIT_DB, BAND_GAIN_LIMIT_DB).to_bits(),
                Ordering::Relaxed,
            );
        }
        self.touch();
    }

    pub fn set_band(&self, index: usize, gain_db: f32) {
        if index >= BAND_COUNT {
            return;
        }
        self.bands[index].store(
            gain_db.clamp(-BAND_GAIN_LIMIT_DB, BAND_GAIN_LIMIT_DB).to_bits(),
            Ordering::Relaxed,
        );
        self.touch();
    }
}

/* -------------------------------------------------------------- filters */

/// All five coefficients of a biquad are public, so a true bypass is trivial.
fn bypass() -> Coefficients<f32> {
    Coefficients {
        a1: 0.0,
        a2: 0.0,
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
    }
}

/// Peaking coefficients for one band. Falls back to a bypass rather than
/// panicking if the requested frequency is not representable at this rate.
pub fn band_coefficients(index: usize, gain_db: f32, sample_rate: f32) -> Coefficients<f32> {
    let Some(&centre) = BAND_FREQUENCIES.get(index) else {
        return bypass();
    };
    let (Ok(fs), Ok(f0)) = (
        Hertz::from_hz(sample_rate),
        // Stay clear of Nyquist: at 22.05 kHz the 16 kHz band would not fit.
        Hertz::from_hz(centre.min(sample_rate * 0.45)),
    ) else {
        return bypass();
    };

    Coefficients::from_params(Type::PeakingEQ(gain_db), fs, f0, BAND_Q).unwrap_or_else(|_| bypass())
}

/// Coefficients for the whole cascade, in ascending frequency order.
pub fn cascade_coefficients(
    gains: &[f32; BAND_COUNT],
    sample_rate: f32,
) -> [Coefficients<f32>; BAND_COUNT] {
    std::array::from_fn(|i| band_coefficients(i, gains[i], sample_rate))
}

/// The full cascade, one biquad per band, in ascending frequency order.
pub fn build_cascade(gains: &[f32; BAND_COUNT], sample_rate: f32) -> [DirectForm1<f32>; BAND_COUNT] {
    std::array::from_fn(|i| DirectForm1::new(band_coefficients(i, gains[i], sample_rate)))
}

/* -------------------------------------------------------------- gain ramp */

/// Linear gain ramp so parameter changes cannot click.
struct GainRamp {
    current: f32,
    target: f32,
    step: f32,
}

impl GainRamp {
    fn new(initial: f32) -> Self {
        Self {
            current: initial,
            target: initial,
            step: 0.0,
        }
    }

    fn set_target(&mut self, target: f32, sample_rate: f32) {
        if (target - self.target).abs() < f32::EPSILON {
            return;
        }
        self.target = target;
        let frames = (GAIN_RAMP_SECONDS * sample_rate).max(1.0);
        self.step = (target - self.current) / frames;
    }

    /// Jump straight to the target — used after a seek, where a sweep would be
    /// audible as a fade.
    fn snap(&mut self) {
        self.current = self.target;
        self.step = 0.0;
    }

    #[inline]
    fn next(&mut self) -> f32 {
        let remaining = self.target - self.current;
        if remaining.abs() <= self.step.abs() || self.step == 0.0 {
            self.current = self.target;
        } else {
            self.current += self.step;
        }
        self.current
    }
}

pub const GAIN_RAMP_SECONDS: f32 = 0.05;

/* ---------------------------------------------------------------- limiter */

/// Ceiling of −1 dBFS.
pub const LIMITER_THRESHOLD: f32 = 0.891_251;
const LIMITER_RELEASE_SECONDS: f32 = 0.05;
const LIMITER_ATTACK_SECONDS: f32 = 0.0015;
const LIMITER_LOOKAHEAD_SECONDS: f32 = 0.005;

/// Time constant of a one-pole smoother, in samples.
fn smoothing_coefficient(seconds: f32, sample_rate: f32) -> f32 {
    let samples = (seconds * sample_rate).max(1.0);
    1.0 - (-1.0 / samples).exp()
}

/// Lookahead peak limiter.
///
/// The gain reduction is computed from the *incoming* sample while the output
/// is read from a delay line `lookahead` frames long, so the reduction has
/// already settled by the time the peak reaches the output. That is what keeps
/// 200 % playback from tearing.
struct Limiter {
    threshold: f32,
    attack: f32,
    release: f32,
    envelope: f32,
    gain: f32,
    delay: Vec<f32>,
    lookahead: usize,
    channels: usize,
    cursor: usize,
}

impl Limiter {
    fn new(channels: usize, sample_rate: f32) -> Self {
        let lookahead = ((LIMITER_LOOKAHEAD_SECONDS * sample_rate) as usize).max(1);
        Self {
            threshold: LIMITER_THRESHOLD,
            attack: smoothing_coefficient(LIMITER_ATTACK_SECONDS, sample_rate),
            release: smoothing_coefficient(LIMITER_RELEASE_SECONDS, sample_rate),
            envelope: 0.0,
            gain: 1.0,
            delay: vec![0.0; lookahead * channels],
            lookahead,
            channels,
            cursor: 0,
        }
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain = 1.0;
        self.cursor = 0;
        self.delay.fill(0.0);
    }

    fn process(&mut self, frame: &mut [f32]) {
        // Stereo-linked: one gain for all channels, driven by the loudest one.
        let peak = frame.iter().fold(0.0f32, |max, s| max.max(s.abs()));

        if peak > self.envelope {
            self.envelope = peak; // instant attack on the detector
        } else {
            self.envelope += (peak - self.envelope) * self.release;
        }

        let target = if self.envelope > self.threshold {
            self.threshold / self.envelope
        } else {
            1.0
        };
        let coeff = if target < self.gain {
            self.attack
        } else {
            self.release
        };
        self.gain += (target - self.gain) * coeff;

        for (channel, sample) in frame.iter_mut().enumerate() {
            let slot = self.cursor * self.channels + channel;
            let delayed = self.delay[slot];
            self.delay[slot] = *sample;
            *sample = delayed * self.gain;
        }
        self.cursor = (self.cursor + 1) % self.lookahead;
    }
}

/// Final safety ceiling. With the limiter on this never engages; with it off it
/// is the only thing standing between a 2× gain and integer wrap-around.
#[inline]
fn soft_clip(x: f32) -> f32 {
    const KNEE: f32 = 0.75;
    let magnitude = x.abs();
    if magnitude <= KNEE {
        return x;
    }
    let over = magnitude - KNEE;
    let shaped = (KNEE + over / (1.0 + over)).min(1.0);
    x.signum() * shaped
}

/* --------------------------------------------------------------- the stage */

/// Wraps any decoded source and applies the chain frame by frame.
///
/// Frames (not samples) are the unit of work because the gain and the limiter
/// are stereo-linked.
pub struct DspSource<S> {
    inner: S,
    params: Arc<DspParams>,
    channels: usize,
    sample_rate: f32,

    filters: Vec<[DirectForm1<f32>; BAND_COUNT]>,
    applied_revision: u64,
    applied_bands: [f32; BAND_COUNT],
    eq_enabled: bool,
    limiter_enabled: bool,
    ramp: GainRamp,
    limiter: Limiter,

    frame: Vec<f32>,
    cursor: usize,

    /// Mono-summed processed samples for the spectrum thread.
    ///
    /// A channel rather than an owned SPSC ring: the sender has to be cloned
    /// into every new source (one per track), which a ring producer cannot do.
    tap: Option<Sender<f32>>,
}

impl<S> DspSource<S>
where
    S: Source<Item = Sample>,
{
    pub fn new(inner: S, params: Arc<DspParams>, tap: Option<Sender<f32>>) -> Self {
        let channels = inner.channels().get() as usize;
        let sample_rate = inner.sample_rate().get() as f32;
        let bands = params.bands();

        Self {
            filters: (0..channels).map(|_| build_cascade(&bands, sample_rate)).collect(),
            applied_revision: 0,
            applied_bands: bands,
            eq_enabled: params.eq_enabled(),
            limiter_enabled: params.limiter_enabled(),
            ramp: GainRamp::new(params.gain()),
            limiter: Limiter::new(channels, sample_rate),
            frame: vec![0.0; channels],
            cursor: 0,
            tap,
            inner,
            params,
            channels,
            sample_rate,
        }
    }

    /// Pick up anything the UI thread published since the last frame.
    fn sync_params(&mut self) {
        let revision = self.params.revision();
        if revision == self.applied_revision {
            return;
        }
        self.applied_revision = revision;

        self.eq_enabled = self.params.eq_enabled();
        self.limiter_enabled = self.params.limiter_enabled();
        self.ramp.set_target(self.params.gain(), self.sample_rate);

        // Rebuilding the coefficients is only worth it when the bands moved:
        // a gain-only change would otherwise re-run ten trig calls per channel.
        let bands = self.params.bands();
        if bands != self.applied_bands {
            self.applied_bands = bands;
            let updated = cascade_coefficients(&bands, self.sample_rate);
            for cascade in self.filters.iter_mut() {
                for (slot, coefficients) in cascade.iter_mut().zip(updated.iter()) {
                    slot.update_coefficients(*coefficients);
                }
            }
        }
    }

    fn process_frame(&mut self) {
        if self.eq_enabled {
            for (channel, cascade) in self.filters.iter_mut().enumerate() {
                let mut value = self.frame[channel];
                for filter in cascade.iter_mut() {
                    value = filter.run(value);
                }
                self.frame[channel] = value;
            }
        }

        let gain = self.ramp.next();
        if gain != 1.0 {
            for sample in self.frame.iter_mut() {
                *sample *= gain;
            }
        }

        if self.limiter_enabled {
            self.limiter.process(&mut self.frame);
        }

        for sample in self.frame.iter_mut() {
            *sample = soft_clip(*sample);
        }

        if let Some(tap) = self.tap.as_ref() {
            let mono = self.frame.iter().sum::<f32>() / self.channels as f32;
            // A full channel only means the visualiser is behind; drop it.
            let _ = tap.try_send(mono);
        }
    }
}

impl<S> Iterator for DspSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    fn next(&mut self) -> Option<Self::Item> {
        if self.cursor == 0 {
            self.sync_params();
            for channel in 0..self.channels {
                self.frame[channel] = self.inner.next()?;
            }
            self.process_frame();
        }

        let sample = self.frame[self.cursor];
        self.cursor += 1;
        if self.cursor >= self.channels {
            self.cursor = 0;
        }
        Some(sample)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S> Source for DspSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // Otherwise the filter state rings across the jump and the gain ramp
        // replays from wherever it was.
        for cascade in self.filters.iter_mut() {
            for filter in cascade.iter_mut() {
                filter.reset_state();
            }
        }
        self.limiter.reset();
        self.ramp.snap();
        self.cursor = 0;
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 48_000.0;
    const FRAMES: usize = 96_000; // 2 s
    const SETTLE: usize = 24_000; // skip the filter transient

    fn sine(frequency: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| (std::f32::consts::TAU * frequency * i as f32 / FS).sin())
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Runs a signal through a cascade and reports the steady-state gain in dB.
    fn cascade_gain_db(gains: &[f32; BAND_COUNT], frequency: f32) -> f32 {
        let mut cascade = build_cascade(gains, FS);
        let input = sine(frequency, FRAMES);
        let output: Vec<f32> = input
            .iter()
            .map(|&sample| {
                let mut value = sample;
                for filter in cascade.iter_mut() {
                    value = filter.run(value);
                }
                value
            })
            .collect();
        20.0 * (rms(&output[SETTLE..]) / rms(&input[SETTLE..])).log10()
    }

    /* ---- step 1: a single biquad ---- */

    #[test]
    fn single_peaking_band_boosts_only_its_centre() {
        let mut cascade = [DirectForm1::new(bypass()); BAND_COUNT];
        // Band 5 is 1 kHz.
        cascade[5] = DirectForm1::new(band_coefficients(5, 12.0, FS));

        let apply = |frequency: f32| {
            let mut filters = cascade;
            let input = sine(frequency, FRAMES);
            let output: Vec<f32> = input
                .iter()
                .map(|&sample| {
                    let mut value = sample;
                    for filter in filters.iter_mut() {
                        value = filter.run(value);
                    }
                    value
                })
                .collect();
            20.0 * (rms(&output[SETTLE..]) / rms(&input[SETTLE..])).log10()
        };

        let at_centre = apply(1000.0);
        assert!(
            (at_centre - 12.0).abs() < 1.5,
            "expected ~+12 dB at 1 kHz, got {at_centre:.2} dB"
        );

        // An octave up the peaking filter should be well past its skirt.
        let off_centre = apply(8000.0);
        assert!(
            off_centre.abs() < 1.0,
            "1 kHz band should barely touch 8 kHz, got {off_centre:.2} dB"
        );
    }

    #[test]
    fn a_flat_cascade_is_transparent() {
        let flat = [0.0f32; BAND_COUNT];
        for frequency in [32.0, 250.0, 1000.0, 8000.0] {
            let gain = cascade_gain_db(&flat, frequency);
            assert!(
                gain.abs() < 0.2,
                "flat EQ changed {frequency} Hz by {gain:.3} dB"
            );
        }
    }

    /* ---- step 2: the ten-band cascade ---- */

    #[test]
    fn boosting_the_bass_band_lifts_bass_but_not_mids() {
        let mut gains = [0.0f32; BAND_COUNT];
        gains[0] = 9.0; // 32 Hz

        let bass = cascade_gain_db(&gains, 32.0);
        let mids = cascade_gain_db(&gains, 1000.0);

        assert!(bass > 5.0, "32 Hz band should lift 32 Hz, got {bass:.2} dB");
        assert!(mids.abs() < 1.0, "32 Hz band leaked into mids: {mids:.2} dB");
    }

    #[test]
    fn boosting_the_treble_band_lifts_treble_but_not_bass() {
        let mut gains = [0.0f32; BAND_COUNT];
        gains[9] = 9.0; // 16 kHz

        let treble = cascade_gain_db(&gains, 16000.0);
        let bass = cascade_gain_db(&gains, 100.0);

        assert!(treble > 4.0, "16 kHz band should lift 16 kHz, got {treble:.2} dB");
        assert!(bass.abs() < 1.0, "16 kHz band leaked into bass: {bass:.2} dB");
    }

    #[test]
    fn every_band_is_representable_at_this_rate() {
        for index in 0..BAND_COUNT {
            let coefficients = band_coefficients(index, 6.0, FS);
            assert_ne!(coefficients.b0, 1.0, "band {index} fell back to bypass");
        }
    }

    #[test]
    fn high_bands_fall_back_to_bypass_below_nyquist() {
        // 16 kHz cannot exist at a 22.05 kHz rate; it must clamp, not panic.
        let coefficients = band_coefficients(9, 6.0, 22_050.0);
        assert!(coefficients.b0.is_finite());
    }

    /* ---- step 4: presets ---- */

    #[test]
    fn presets_match_the_specification() {
        let flat = preset_by_id("flat").unwrap();
        assert_eq!(flat.gains, [0.0; BAND_COUNT]);

        let bass = preset_by_id("bass").unwrap();
        assert_eq!(bass.gains, [6.0, 6.0, 5.0, 3.0, 0.0, 0.0, 0.0, 0.0, -1.0, -2.0]);

        let guly = preset_by_id("guly").unwrap();
        assert_eq!(guly.gains, [5.0, 5.0, 3.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0]);

        assert!(preset_by_id("nope").is_none());
    }

    #[test]
    fn bass_preset_is_audibly_different_from_guly() {
        let bass = cascade_gain_db(&preset_by_id("bass").unwrap().gains, 32.0);
        let guly = cascade_gain_db(&preset_by_id("guly").unwrap().gains, 16000.0);
        // Guly cuts the top, Bass Boost lifts the bottom.
        assert!(bass > 3.0, "Bass Boost should lift lows, got {bass:.2}");
        assert!(guly < -1.0, "Guly should cut highs, got {guly:.2}");
    }

    /* ---- step 5: gain and limiter ---- */

    #[test]
    fn gain_ramp_reaches_its_target_without_jumping() {
        let mut ramp = GainRamp::new(1.0);
        ramp.set_target(2.0, FS);

        // Never more than one step's worth of change per frame.
        let first = ramp.next();
        assert!(
            (first - 1.0).abs() < 0.01,
            "gain jumped on the first frame: {first}"
        );

        for _ in 0..(GAIN_RAMP_SECONDS * FS) as usize {
            ramp.next();
        }
        assert!((ramp.current - 2.0).abs() < 1e-3, "ramp stalled at {}", ramp.current);
    }

    #[test]
    fn limiter_holds_a_hot_signal_at_the_ceiling() {
        let mut limiter = Limiter::new(2, FS);
        // 2× over the ceiling, the worst case the gain stage can produce.
        let frames = 48_000;
        let mut peak_out = 0.0f32;

        for i in 0..frames {
            let value = 1.8 * (std::f32::consts::TAU * 220.0 * i as f32 / FS).sin();
            let mut frame = [value, value];
            limiter.process(&mut frame);
            if i > 4800 {
                peak_out = peak_out.max(frame[0].abs().max(frame[1].abs()));
            }
        }

        assert!(
            peak_out <= LIMITER_THRESHOLD + 0.02,
            "limiter let {peak_out:.4} through, ceiling is {LIMITER_THRESHOLD:.4}"
        );
        assert!(peak_out > 0.5, "limiter choked the signal entirely: {peak_out:.4}");
    }

    #[test]
    fn limiter_leaves_a_quiet_signal_alone() {
        let mut limiter = Limiter::new(2, FS);
        let amplitude = 0.3;
        let frames = 24_000;
        let mut peak_out = 0.0f32;

        for i in 0..frames {
            let value = amplitude * (std::f32::consts::TAU * 440.0 * i as f32 / FS).sin();
            let mut frame = [value, value];
            limiter.process(&mut frame);
            if i > 4800 {
                peak_out = peak_out.max(frame[0].abs());
            }
        }

        assert!(
            (peak_out - amplitude).abs() < 0.02,
            "quiet signal was altered: {peak_out:.4} vs {amplitude}"
        );
    }

    #[test]
    fn soft_clip_is_monotonic_and_bounded() {
        let mut previous = f32::NEG_INFINITY;
        let mut value = -8.0f32;
        while value <= 8.0 {
            let out = soft_clip(value);
            assert!(out.abs() <= 1.0, "soft clip exceeded unity at {value}");
            assert!(out >= previous, "soft clip is not monotonic at {value}");
            previous = out;
            value += 0.05;
        }
    }

    /* ---- parameter plumbing ---- */

    #[test]
    fn params_clamp_and_publish() {
        let params = DspParams::new();
        assert_eq!(params.gain(), 1.0);
        assert!(params.eq_enabled());

        let before = params.revision();
        params.set_gain(5.0);
        assert_eq!(params.gain(), 2.0, "gain must clamp to 200%");
        assert!(params.revision() > before, "gain change must bump the revision");

        params.set_band(3, 99.0);
        assert_eq!(params.bands()[3], BAND_GAIN_LIMIT_DB);
        params.set_band(99, 5.0); // out of range must be ignored, not panic

        params.set_bands(preset_by_id("rock").unwrap().gains);
        assert_eq!(params.bands(), preset_by_id("rock").unwrap().gains);
    }
}
