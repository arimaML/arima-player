//! System tray: the app's home when the window is closed.
//!
//! Menu layout per spec — Play/Pause, Next, Prev, Показать, Выход.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

/// Stable id so the icon can be retrieved later via `app.tray_by_id`.
pub const TRAY_ID: &str = "arima-tray";

/// Bring the main window back from the tray.
fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Forward a playback verb to the UI process.
///
/// The webview keeps running while hidden, so a tray command works even with
/// the window parked in the tray.
fn command(app: &AppHandle, action: &'static str) {
    if let Err(err) = app.emit("shortcut", action) {
        eprintln!("[arima] failed to emit {action}: {err}");
    }
}

pub fn build(app: &App) -> tauri::Result<()> {
    let play_pause = MenuItemBuilder::with_id("play_pause", "Играть / Пауза").build(app)?;
    let next = MenuItemBuilder::with_id("next", "Следующий").build(app)?;
    let prev = MenuItemBuilder::with_id("prev", "Предыдущий").build(app)?;
    let show = MenuItemBuilder::with_id("show", "Показать").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Выход").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&play_pause, &next, &prev])
        .separator()
        .items(&[&show, &quit])
        .build()?;

    TrayIconBuilder::with_id(TRAY_ID)
        // `include_image!` decodes the PNG at compile time; it MUST be RGBA.
        .icon(tauri::include_image!("./icons/32x32.png"))
        .tooltip("Arima Player")
        .menu(&menu)
        // Left click reveals the window; the menu belongs to right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "play_pause" => command(app, "play_pause"),
            "next" => command(app, "next"),
            "prev" => command(app, "prev"),
            "show" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        })
        .build(app)?;

    println!("[arima] tray icon ready (id = {TRAY_ID})");
    Ok(())
}
