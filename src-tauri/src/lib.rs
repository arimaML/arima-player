//! Arima Player — host process.
//!
//! Stage 0 owns the shell (window lifecycle, tray, hotkeys); Stage 1 adds the
//! local audio engine. Decode → output happens entirely in Rust.

mod audio;
mod background;
mod commands;
mod db;
mod dsp;
mod library;
mod shortcuts;
mod spectrum;
mod tray;

use std::io::Write;
use std::path::PathBuf;

use tauri::{Emitter, Manager, WebviewWindow, WindowEvent};

/// Where a panic gets recorded when there is no console to print to.
fn panic_log_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))?;
    Some(base.join("Arima Player").join("arima.log"))
}

/// Release builds use the Windows GUI subsystem, so stdout and stderr go
/// nowhere: a panic that kills the process leaves no trace at all. Mirror
/// panics into a log file so a silent exit is still diagnosable.
fn install_panic_logger() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown location".to_owned());

        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_owned());

        let line = format!("[arima] panic at {location}: {message}");

        // Harmless when there is no console.
        eprintln!("{line}");

        if let Some(path) = panic_log_path() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = writeln!(file, "{line}");
            }
        }
    }));
}

/// Apply the OS-level translucency effect to the window.
///
/// Mica is preferred: it is cheap for the compositor on Windows 11. Acrylic is
/// the fallback for Windows 10 1809+. Either needs `transparent: true` in the
/// window config to be visible at all. A failure is never fatal — the CSS
/// background behind the glass still looks correct on its own.
fn apply_vibrancy(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if window_vibrancy::apply_mica(window, Some(true)).is_ok() {
            println!("[arima] window effect: mica");
            return Ok(());
        }
        match window_vibrancy::apply_acrylic(window, Some((10, 10, 12, 160))) {
            Ok(()) => {
                println!("[arima] window effect: acrylic");
                Ok(())
            }
            Err(err) => Err(format!("vibrancy unavailable: {err}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Linux falls back to the CSS blur layer; macOS uses its own material.
        let _ = window;
        Err("vibrancy is only wired up for Windows".to_owned())
    }
}

fn clear_vibrancy(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window_vibrancy::clear_mica(window)
            .or_else(|_| window_vibrancy::clear_acrylic(window))
            .map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

/// Toggle the translucency effect from the settings window.
#[tauri::command]
fn set_vibrancy(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    if enabled {
        apply_vibrancy(&window)
    } else {
        clear_vibrancy(&window)
    }
}

pub fn run() {
    install_panic_logger();

    tauri::Builder::default()
        .plugin(shortcuts::plugin())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // A missing tray is not fatal — the window still runs — but it is
            // reported, because it changes how the window behaves on close.
            if let Err(err) = tray::build(app) {
                eprintln!("[arima] tray unavailable: {err}");
            }
            shortcuts::register(app.handle());

            // The library database lives in the app data directory. A failure
            // here is reported but not fatal: the player still works, just with
            // an empty library.
            match app.path().app_data_dir() {
                Ok(data_dir) => match db::Library::open(&data_dir) {
                    Ok(library) => {
                        println!("[arima] library: {}", library.database_path());
                        app.manage(library);
                    }
                    Err(err) => eprintln!("[arima] library unavailable: {err}"),
                },
                Err(err) => eprintln!("[arima] no app data dir: {err}"),
            }

            // Never fatal: with no output device the app still opens and the
            // engine reports why playback is unavailable.
            let (tap, tap_rx) = spectrum::channel();
            let engine = audio::AudioEngine::new(tap);
            let sample_rate = engine.sample_rate_handle();
            app.manage(engine);
            audio::spawn_state_pump(app.handle().clone());

            // The FFT lives on its own thread; running it in the audio callback
            // would cause dropouts.
            spectrum::spawn(app.handle().clone(), tap_rx, sample_rate);

            // Windows are created before this hook runs, so "main" exists here.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = apply_vibrancy(&window) {
                    eprintln!("[arima] {err}");
                }
            }

            println!("[arima] engine initialised");
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window parks Arima in the tray instead of exiting.
            WindowEvent::CloseRequested { api, .. } => {
                // Only when a tray exists — otherwise hiding would leave the
                // app running with no way to bring the window back.
                if window.app_handle().tray_by_id(tray::TRAY_ID).is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // Files dropped on the window are forwarded as paths; the library
            // then resolves tags for them.
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                let files: Vec<String> = paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect();
                let _ = window.emit("library:dropped", files);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::play_track,
            commands::toggle_play,
            commands::stop,
            commands::seek,
            commands::set_gain,
            commands::get_state,
            commands::get_folder,
            commands::search_all,
            commands::library_count,
            commands::library_path,
            commands::import_folder,
            commands::import_paths,
            commands::refresh_folders,
            commands::set_liked,
            commands::get_cover,
            commands::reveal_in_folder,
            commands::set_eq_band,
            commands::set_eq_preset,
            commands::set_eq_enabled,
            commands::set_limiter_enabled,
            commands::get_eq,
            background::get_background,
            background::set_background,
            background::reset_background,
            set_vibrancy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arima Player");
}
