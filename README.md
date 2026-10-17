# Arima Player

Local music player for Windows. Native Rust audio engine, no browser audio elements, no Electron.

## Features

- Plays local files (mp3, flac, opus, wav, m4a, aac) through a native Rust audio engine
- 10-band EQ with presets
- Gain up to 200% with lookahead limiter
- FFT visualizer driven by the actual audio stream
- Library with smart folders: liked, frequently played, recently played
- Global search across the library
- Custom sort order per folder
- Context menu on any track
- Glass UI with custom background support
- Frameless window with custom title bar
- Portable: single .exe, no installer
- Tray icon, global hotkeys

YouTube and SoundCloud streaming are planned but not implemented.

## Download

Grab the latest `arima-player.exe` from Releases. No installer. Move it anywhere, run it.

Windows 10/11 x64. WebView2 ships with modern Windows; on older systems install WebView2 Runtime if the app fails to start.

## Where your data lives

    %APPDATA%\com.arima.player\library.db      library database
    %APPDATA%\com.arima.player\covers\         album art cache
    %APPDATA%\com.arima.player\background.jpg  custom background

Delete the folder to reset everything. Your music files stay untouched.

## Build from source

Requires Rust, Node 20+, Visual Studio Build Tools with the C++ workload.

    git clone <repo-url>
    cd arima-player
    npm install
    npm run tauri:build:exe

Output: `src-tauri/target/release/arima-player.exe`.

## License

MIT. Do whatever you want with it.
