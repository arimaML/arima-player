//! Audio engine — local playback through rodio/cpal.
//!
//! Sound is produced entirely in Rust; the webview never touches `<audio>`.
//! The signal path is:
//!
//! ```text
//! Decoder (symphonia) → DspSource [10-band EQ → gain ramp → limiter] → Player → cpal
//!                                └──────────── mono tap ──→ spectrum thread
//! ```

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::Sender;
use rodio::{Decoder, DeviceSinkBuilder, Player, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::dsp::{self, DspParams, DspSource, PRESETS};

/// Event name used to push playback state to the UI.
pub const STATE_EVENT: &str = "player:state";

/// How often the position is pushed while something is playing.
const PUMP_INTERVAL: Duration = Duration::from_millis(250);

/// Everything the UI needs to draw the transport, in one payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    /// Absolute path of the loaded track, `None` when idle.
    pub path: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub is_playing: bool,
    /// Master gain, 0.0..2.0. Applied by the DSP stage, not by rodio.
    pub volume: f32,
}

/// Full EQ state, so a freshly loaded UI can rebuild the panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqState {
    pub enabled: bool,
    pub limiter_enabled: bool,
    pub gain: f32,
    pub bands: [f32; dsp::BAND_COUNT],
    pub frequencies: [f32; dsp::BAND_COUNT],
    pub gain_limit_db: f32,
    pub presets: Vec<PresetInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub gains: [f32; dsp::BAND_COUNT],
}

/// Playback engine.
///
/// The output device is opened lazily-tolerant: if no device can be opened the
/// app still starts and reports the reason, instead of dying at launch.
pub struct AudioEngine {
    player: Option<Player>,
    unavailable: Option<String>,
    current: Mutex<Current>,
    /// Shared with the audio thread and the UI commands.
    params: Arc<DspParams>,
    /// Clone handed to every new source; the spectrum thread owns the receiver.
    tap: Sender<f32>,
    /// Published to the spectrum thread, which needs it to place the bins.
    sample_rate: Arc<AtomicU32>,
}

#[derive(Default)]
struct Current {
    path: Option<String>,
    duration: Duration,
}

impl AudioEngine {
    pub fn new(tap: Sender<f32>) -> Self {
        let params = Arc::new(DspParams::new());
        let sample_rate = Arc::new(AtomicU32::new(48_000));

        let output = DeviceSinkBuilder::open_default_sink();
        let (player, unavailable) = match output {
            Ok(mut sink) => {
                let player = Player::connect_new(sink.mixer());
                sink.log_on_drop(false);

                // `MixerDeviceSink` owns the cpal stream, which is `!Send` on
                // Windows and so cannot live in Tauri's managed state. The output
                // device must exist for the whole process anyway; leak on purpose.
                std::mem::forget(sink);

                // Level control moved into the DSP chain so the limiter can see
                // the boosted signal. rodio's own volume stays at unity.
                player.set_volume(1.0);
                (Some(player), None)
            }
            Err(err) => {
                let message = format!("Аудиовыход недоступен: {err}");
                eprintln!("[arima] {message}");
                (None, Some(message))
            }
        };

        Self {
            player,
            unavailable,
            current: Mutex::new(Current::default()),
            params,
            tap,
            sample_rate,
        }
    }

    /// Handle the spectrum thread reads to place its bins.
    pub fn sample_rate_handle(&self) -> Arc<AtomicU32> {
        Arc::clone(&self.sample_rate)
    }

    pub fn params(&self) -> Arc<DspParams> {
        Arc::clone(&self.params)
    }

    fn player(&self) -> Result<&Player, String> {
        self.player.as_ref().ok_or_else(|| {
            self.unavailable
                .clone()
                .unwrap_or_else(|| "Аудиовыход недоступен".to_owned())
        })
    }

    /// Load and start a local file, replacing whatever was playing.
    pub fn play(&self, path: &Path) -> Result<(), String> {
        let player = self.player()?;

        let file = std::fs::File::open(path).map_err(|err| format!("Не открыть файл: {err}"))?;

        // `try_from` seeds the decoder with the byte length, which is what makes
        // backwards seeking work; `Decoder::new` alone cannot seek back.
        let decoder =
            Decoder::try_from(file).map_err(|err| format!("Не декодировать файл: {err}"))?;

        // Capture the duration before the decoder is moved into the DSP stage.
        let duration = decoder.total_duration().unwrap_or_default();
        let rate = decoder.sample_rate().get();
        self.sample_rate.store(rate, Ordering::Relaxed);

        let staged = DspSource::new(decoder, Arc::clone(&self.params), Some(self.tap.clone()));

        player.stop();
        player.append(staged);
        player.play();

        let mut current = self.current.lock().unwrap();
        current.path = Some(path.display().to_string());
        current.duration = duration;
        Ok(())
    }

    pub fn play_pause(&self) -> Result<(), String> {
        let player = self.player()?;
        if player.is_paused() {
            player.play();
        } else {
            player.pause();
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.player()?.stop();
        self.current.lock().unwrap().path = None;
        Ok(())
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        let target = Duration::from_secs_f64(seconds.max(0.0));
        self.player()?
            .try_seek(target)
            .map_err(|err| format!("Перемотка не удалась: {err}"))
    }

    /// 0.0 ..= 2.0, applied by the DSP gain stage (with its 50 ms ramp).
    pub fn set_gain(&self, value: f32) {
        self.params.set_gain(value);
    }

    pub fn eq_state(&self) -> EqState {
        EqState {
            enabled: self.params.eq_enabled(),
            limiter_enabled: self.params.limiter_enabled(),
            gain: self.params.gain(),
            bands: self.params.bands(),
            frequencies: dsp::BAND_FREQUENCIES,
            gain_limit_db: dsp::BAND_GAIN_LIMIT_DB,
            presets: PRESETS
                .iter()
                .map(|preset| PresetInfo {
                    id: preset.id,
                    label: preset.label,
                    gains: preset.gains,
                })
                .collect(),
        }
    }

    pub fn snapshot(&self) -> PlaybackState {
        let current = self.current.lock().unwrap();

        let (position, duration, is_playing) = match self.player.as_ref() {
            Some(player) => {
                let exhausted = player.empty();
                (
                    if exhausted {
                        0.0
                    } else {
                        player.get_pos().as_secs_f64()
                    },
                    current.duration.as_secs_f64(),
                    !player.is_paused() && !exhausted,
                )
            }
            None => (0.0, current.duration.as_secs_f64(), false),
        };

        PlaybackState {
            path: current.path.clone(),
            position,
            duration,
            is_playing,
            volume: self.params.gain(),
        }
    }
}

/// Push state to the UI while playing, and once whenever it changes.
///
/// Driven by a plain thread rather than a Tauri timer so it keeps ticking while
/// the window is hidden in the tray.
pub fn spawn_state_pump(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<PlaybackState> = None;
        loop {
            std::thread::sleep(PUMP_INTERVAL);

            let Some(engine) = app.try_state::<AudioEngine>() else {
                continue;
            };
            let state = engine.snapshot();

            if state.is_playing || last.as_ref() != Some(&state) {
                last = Some(state.clone());
                let _ = app.emit(STATE_EVENT, &state);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_construction_never_panics() {
        // On a machine with no output device this yields an unavailable engine
        // rather than aborting; either way the snapshot must be well-formed.
        let (tap, _rx) = crate::spectrum::channel();
        let engine = AudioEngine::new(tap);
        let state = engine.snapshot();
        assert!(!state.is_playing);
        assert_eq!(state.position, 0.0);
        assert_eq!(state.volume, 1.0);
    }

    #[test]
    fn gain_is_applied_to_the_dsp_stage_not_rodio() {
        let (tap, _rx) = crate::spectrum::channel();
        let engine = AudioEngine::new(tap);

        engine.set_gain(2.5);
        // Clamped to 200 %, and visible to the UI through both surfaces.
        assert_eq!(engine.snapshot().volume, 2.0);
        assert_eq!(engine.eq_state().gain, 2.0);

        engine.set_gain(0.0);
        assert_eq!(engine.snapshot().volume, 0.0);
    }

    #[test]
    fn eq_state_exposes_every_preset_and_band() {
        let (tap, _rx) = crate::spectrum::channel();
        let engine = AudioEngine::new(tap);

        let state = engine.eq_state();
        assert_eq!(state.bands, [0.0; dsp::BAND_COUNT], "EQ should start flat");
        assert_eq!(state.frequencies[0], 32.0);
        assert_eq!(state.frequencies[9], 16_000.0);
        assert_eq!(state.presets.len(), 5);
        assert!(state.enabled);
        assert!(state.limiter_enabled);
    }
}
