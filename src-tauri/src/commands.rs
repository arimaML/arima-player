//! Tauri commands: the only door between the UI and the audio engine.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, State};

use crate::audio::{AudioEngine, EqState, PlaybackState, STATE_EVENT};
use crate::db::{Folder, ImportSummary, Library, Sort, Track};
use crate::library;

/// Re-publish state immediately after a command so the UI never waits a tick.
fn push(app: &AppHandle, engine: &AudioEngine) {
    let _ = app.emit(STATE_EVENT, &engine.snapshot());
}

#[tauri::command]
pub fn play_track(
    app: AppHandle,
    engine: State<'_, AudioEngine>,
    library: State<'_, Library>,
    path: String,
    track_id: Option<i64>,
) -> Result<(), String> {
    engine.play(&PathBuf::from(path))?;

    // A play is counted once the decoder is actually running, not on pause or
    // resume — and every restart of the same track counts again.
    if let Some(id) = track_id {
        if let Err(err) = library.register_play(id) {
            eprintln!("[arima] could not register play: {err}");
        }
    }

    push(&app, &engine);
    Ok(())
}

#[tauri::command]
pub fn toggle_play(app: AppHandle, engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.play_pause()?;
    push(&app, &engine);
    Ok(())
}

#[tauri::command]
pub fn stop(app: AppHandle, engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.stop()?;
    push(&app, &engine);
    Ok(())
}

#[tauri::command]
pub fn seek(app: AppHandle, engine: State<'_, AudioEngine>, position: f64) -> Result<(), String> {
    engine.seek(position)?;
    push(&app, &engine);
    Ok(())
}

#[tauri::command]
pub fn set_gain(app: AppHandle, engine: State<'_, AudioEngine>, value: f32) -> Result<(), String> {
    // Replaces the old `set_volume`: lift is now a real gain stage in the DSP
    // chain so the limiter can see the boosted signal. 0.0..=2.0.
    engine.set_gain(value);
    push(&app, &engine);
    Ok(())
}

#[tauri::command]
pub fn get_state(engine: State<'_, AudioEngine>) -> PlaybackState {
    engine.snapshot()
}

/* ------------------------------------------------------------------- EQ */

#[tauri::command]
pub fn set_eq_band(engine: State<'_, AudioEngine>, index: u8, gain_db: f32) -> Result<(), String> {
    if index as usize >= crate::dsp::BAND_COUNT {
        return Err(format!("Полоса {index} вне диапазона 0..9"));
    }
    engine.params().set_band(index as usize, gain_db);
    Ok(())
}

#[tauri::command]
pub fn set_eq_preset(engine: State<'_, AudioEngine>, name: String) -> Result<(), String> {
    let preset = crate::dsp::preset_by_id(&name)
        .ok_or_else(|| format!("Неизвестный пресет: {name}"))?;
    engine.params().set_bands(preset.gains);
    Ok(())
}

#[tauri::command]
pub fn set_eq_enabled(engine: State<'_, AudioEngine>, enabled: bool) {
    engine.params().set_eq_enabled(enabled);
}

#[tauri::command]
pub fn set_limiter_enabled(engine: State<'_, AudioEngine>, enabled: bool) {
    engine.params().set_limiter_enabled(enabled);
}

/// Everything the EQ panel needs to render itself from scratch.
#[tauri::command]
pub fn get_eq(engine: State<'_, AudioEngine>) -> EqState {
    engine.eq_state()
}

/* ---------------------------------------------------------------- library */

/// The four smart folders, straight from the database.
///
/// `sort` is `None` (or `"natural"`) for the folder's own order. An unknown
/// name is an error rather than a silent fallback: a typo in the UI must not
/// quietly reorder the list.
#[tauri::command]
pub fn get_folder(
    library: State<'_, Library>,
    folder: String,
    sort: Option<String>,
    descending: Option<bool>,
) -> Result<Vec<Track>, String> {
    let folder = Folder::parse(&folder).ok_or_else(|| format!("Неизвестная папка: {folder}"))?;

    let sort = match sort.as_deref() {
        None | Some("") | Some("natural") => None,
        Some(name) => Some(
            Sort::parse(name).ok_or_else(|| format!("Неизвестная сортировка: {name}"))?,
        ),
    };

    library.folder(folder, sort, descending.unwrap_or(false))
}

/// Global search: the whole library, not the folder on screen.
#[tauri::command]
pub fn search_all(library: State<'_, Library>, query: String) -> Result<Vec<Track>, String> {
    library.search(&query)
}

#[tauri::command]
pub fn library_count(library: State<'_, Library>) -> Result<i64, String> {
    library.count()
}

/// Where `library.db` lives — surfaced so the user can inspect or back it up.
#[tauri::command]
pub fn library_path(library: State<'_, Library>) -> String {
    library.database_path()
}

#[tauri::command]
pub fn set_liked(library: State<'_, Library>, track_id: i64, liked: bool) -> Result<(), String> {
    library.set_liked(track_id, liked)
}

/// Artwork for one row, fetched on demand so a folder listing stays small.
#[tauri::command]
pub fn get_cover(library: State<'_, Library>, track_id: i64) -> Result<Option<String>, String> {
    library.cover(track_id)
}

/// Show a local file in the OS file manager.
///
/// Only an existing file is accepted: a streamed track has nothing to show, and
/// a path that has been moved deserves a clear message rather than an empty
/// Explorer window.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("Файл не найден: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // Explorer wants `/select,<path>` as ONE argument, and it reports a
        // non-zero exit code even when it worked — so spawn and never wait.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|err| format!("Не открыть проводник: {err}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|err| format!("Не открыть Finder: {err}"))?;
        Ok(())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // There is no portable "reveal"; the containing directory is the
        // closest equivalent.
        let directory = target.parent().unwrap_or(&target).to_path_buf();
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|err| format!("Не открыть файловый менеджер: {err}"))?;
        Ok(())
    }
}

/// Scan a folder, import it, and remember it so the next launch can refresh.
/// Tag reading and image encoding are blocking, so this runs off the UI thread.
#[tauri::command]
pub async fn import_folder(
    library: State<'_, Library>,
    path: String,
) -> Result<ImportSummary, String> {
    let root = PathBuf::from(&path);
    library.remember_folder(&path)?;

    let scanned = tauri::async_runtime::spawn_blocking(move || library::scan_folder(&root))
        .await
        .map_err(|err| err.to_string())?;

    library.import(&scanned)
}

/// Resolve dropped files/folders, import them, and remember any directories.
#[tauri::command]
pub async fn import_paths(
    library: State<'_, Library>,
    paths: Vec<String>,
) -> Result<ImportSummary, String> {
    for path in &paths {
        if PathBuf::from(path).is_dir() {
            library.remember_folder(path)?;
        }
    }

    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let scanned = tauri::async_runtime::spawn_blocking(move || library::read_paths(&paths))
        .await
        .map_err(|err| err.to_string())?;

    library.import(&scanned)
}

/// Re-scan every remembered folder. Runs at startup so new files show up and
/// existing rows are refreshed rather than duplicated.
#[tauri::command]
pub async fn refresh_folders(library: State<'_, Library>) -> Result<ImportSummary, String> {
    let roots = library.folders()?;
    if roots.is_empty() {
        return Ok(ImportSummary {
            inserted: 0,
            updated: 0,
            total: library.count()?,
        });
    }

    let scanned = tauri::async_runtime::spawn_blocking(move || {
        let mut collected = Vec::new();
        for root in roots {
            let path = PathBuf::from(&root);
            if path.is_dir() {
                collected.extend(library::scan_folder(&path));
            }
        }
        collected
    })
    .await
    .map_err(|err| err.to_string())?;

    library.import(&scanned)
}
