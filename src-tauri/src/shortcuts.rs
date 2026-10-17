//! Global hotkeys, registered from Rust.
//!
//! Deliberate scope decision: only media keys and *modified* combinations are
//! grabbed system-wide. Space and the bare arrow keys are handled window-scoped
//! in the frontend instead — a global grab on Space would swallow the spacebar
//! in every other application, which is hostile for a background player.

use tauri::{plugin::TauriPlugin, AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState,
};

const GLOBAL_SHORTCUTS: &[&str] = &[
    // Hardware / OS media keys.
    "MediaPlayPause",
    "MediaTrackNext",
    "MediaTrackPrevious",
    "MediaStop",
    // Keyboard fallbacks that will not collide with normal typing.
    "CommandOrControl+Alt+Space",
    "CommandOrControl+Alt+ArrowRight",
    "CommandOrControl+Alt+ArrowLeft",
];

/// Map a pressed shortcut to the verb the frontend understands.
///
/// Unmodified arrows are unambiguous here because no unmodified arrow key is
/// ever registered globally.
fn action_for(shortcut: &Shortcut) -> Option<&'static str> {
    match shortcut.key {
        Code::MediaPlayPause | Code::Space => Some("play_pause"),
        Code::MediaTrackNext | Code::ArrowRight => Some("next"),
        Code::MediaTrackPrevious | Code::ArrowLeft => Some("prev"),
        Code::MediaStop => Some("stop"),
        _ => None,
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(
            |app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent| {
                // Pressed only — handling Released too would fire every command twice.
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if let Some(action) = action_for(shortcut) {
                    let _ = app.emit("shortcut", action);
                }
            },
        )
        .build()
}

/// Register every global hotkey. Failures are reported, never fatal: another
/// application may already own a media key, and the app must still start.
pub fn register(app: &AppHandle) {
    let manager = app.global_shortcut();
    for spec in GLOBAL_SHORTCUTS {
        match manager.register(*spec) {
            Ok(()) => println!("[arima] global shortcut registered: {spec}"),
            Err(err) => eprintln!("[arima] could not register '{spec}': {err}"),
        }
    }
}
