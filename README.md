<div align="center">

<img src="src/assets/logo.png" width="96" alt="Arima Player">

# Arima Player


[![Release](https://img.shields.io/github/v/release/arimaML/arima-player?style=flat-square&color=E0E0E0&labelColor=0D1117&label=release)](../../releases)
[![Downloads](https://img.shields.io/github/downloads/arimaML/arima-player/total?style=flat-square&color=E0E0E0&labelColor=0D1117)](../../releases)
[![License](https://img.shields.io/badge/license-MIT-E0E0E0?style=flat-square&labelColor=0D1117)](LICENSE)

[![Rust](https://img.shields.io/badge/Rust-1.90+-000000?style=flat-square&logo=rust&logoColor=white&labelColor=0D1117)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white&labelColor=0D1117)](https://www.typescriptlang.org)
[![Tauri](https://img.shields.io/badge/Tauri-2.12-24C8DB?style=flat-square&logo=tauri&logoColor=white&labelColor=0D1117)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=0D1117&labelColor=0D1117)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white&labelColor=0D1117)](https://vite.dev)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white&labelColor=0D1117)](https://tailwindcss.com)

[![Platform](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D6?style=flat-square&logo=windows&logoColor=white&labelColor=0D1117)](#requirements)
[![No Electron](https://img.shields.io/badge/electron-none-E0E0E0?style=flat-square&labelColor=0D1117)](#why-another-player)
[![Portable](https://img.shields.io/badge/portable-single%2017%20MB%20exe-E0E0E0?style=flat-square&labelColor=0D1117)](#download)

<!-- TODO: replace with a real screenshot or a short capture. A music player
     without a visual is the single biggest thing this README is missing.
     Drag the image into the GitHub editor to get an uploaded URL. -->

</div>

---

## Why another player

Most desktop players are a browser with a skin: a 150 MB Chromium payload, a
framework runtime, and audio decoded through an `<audio>` element that was never
designed for sample-accurate work.

Arima Player splits the job at the right seam — **Rust owns the audio path, the
web layer owns only the pixels**:

- Audio is decoded and rendered by a native Rust engine (`rodio`), not by the WebView
- The window is thin: WebView2, already present on modern Windows
- One portable `.exe`, ~17 MB, no installer, no runtime to babysit
- SQLite library stored next to your data, not in a hidden app container

## Features

**Audio engine**

- Plays local files — `mp3`, `flac`, `opus`, `wav`, `m4a`, `aac` — through the native engine
- 10-band equalizer with presets, built on cascaded biquad filters
- Gain up to 200% with a lookahead limiter, so pushing volume does not turn into clipping
- FFT visualizer driven by the actual audio stream, not a decorative fake

**Library**

- Local SQLite library: fast scans, no cloud, no accounts
- Smart folders: liked, frequently played, recently played
- Global search across the whole library
- Custom sort order per folder
- Context menu on any track

**Interface**

- Glass UI with a custom background image
- Frameless window with a custom title bar
- Queue, now-playing panel, toasts
- Global search and per-folder view state

**System**

- Tray icon with a playback menu, owned by Rust so it keeps working when the window is hidden
- Global media hotkeys, plus a window-scoped keyboard fallback
- Fully portable — move the `.exe`, keep your library

## Architecture

```
┌──────────────────────────────────────┐
│  React 19 + TypeScript 7             │  interface, state, layout
└─────────────────┬────────────────────┘
                  │  Tauri IPC — commands down, events up
┌─────────────────▼────────────────────┐
│  Rust core  (src-tauri/src)          │
│                                      │
│  audio.rs      rodio output sink     │
│  dsp.rs        biquad EQ + limiter   │
│  spectrum.rs   rustfft FFT frames    │
│  db.rs         rusqlite library      │
│  library.rs    scanning, smart sets  │
│  tray.rs       tray menu             │
│  shortcuts.rs  global hotkeys        │
└──────────────────────────────────────┘
```

The audio thread never blocks on the UI: spectrum frames and playback state
travel to the frontend over a channel, and the frontend only reads them.

## Tech stack

| Layer | Crate | Role |
|---|---|---|
| Playback | `rodio` 0.23 | decoding and device output |
| Metadata | `lofty` 0.25 | tags, duration, embedded covers |
| Equalizer | `biquad` 0.6 | 10-band filter bank |
| Spectrum | `rustfft` 6.4 | FFT for the visualizer |
| Storage | `rusqlite` 0.40 | bundled SQLite, no system dependency |
| Glass | `window-vibrancy` 0.8 | acrylic / mica backdrop |
| Threading | `crossbeam-channel` 0.5 | audio → UI messaging |
| Shell | `tauri` 2.12 | IPC, tray, window, single binary |
| Covers | `image` 0.25 | art decoding and caching |
| Frontend | React 19, TypeScript 7 | UI |
| Build | Vite 8, Tailwind CSS 4 | bundling, styling |

## Requirements

- **Windows 10 / 11, x64**
- WebView2 runtime — ships with modern Windows; on older builds install the
  [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) if the app opens a blank window

## Download

Grab **`arima.exe`** from the [latest release](../../releases/latest). No
installer — drop it anywhere and run it.

Your music files are never moved or modified.

## Keyboard shortcuts

Global (work while another app has focus):

| Shortcut | Action |
|---|---|
| `Media Play/Pause` | Play / pause |
| `Media Next` / `Media Previous` | Next / previous track |
| `Media Stop` | Stop |
| `Ctrl + Alt + Space` | Play / pause |
| `Ctrl + Alt + →` / `Ctrl + Alt + ←` | Next / previous track |

Window-scoped (only while the player is focused):

| Shortcut | Action |
|---|---|
| `Space` | Play / pause |
| `→` / `←` | Next / previous track |

Bare `Space` and arrows are deliberately *not* grabbed system-wide — a background
player that eats the spacebar everywhere is hostile.

## Where your data lives

```
%APPDATA%\com.arima.player\library.db      library database
%APPDATA%\com.arima.player\covers\         album art cache
%APPDATA%\com.arima.player\background.jpg  custom background
```

Delete that folder to reset everything. Your music files stay untouched.

## Build from source

Requirements: **Rust 1.90+**, **Node 20+**, and **Visual Studio Build Tools**
with the C++ desktop workload.

```bash
git clone https://github.com/arimaML/arima-player.git
cd arima-player
npm install
```

```bash
npm run tauri:dev          # dev build with hot reload
npm run tauri:build:exe    # portable release build
```

Output: `src-tauri/target/release/arima-player.exe`.

> Release builds need the `custom-protocol` feature. `npm run tauri:build:exe`
> sets it for you; a bare `cargo build --release` does not, and will produce a
> binary that expects the dev server on `:1420`.

## Roadmap

- [x] Native Rust audio engine, 10-band EQ, lookahead limiter
- [x] FFT visualizer, library, smart folders, search
- [x] Glass UI, tray, global hotkeys, portable build — **1.0.0**
- [ ] YouTube streaming
- [ ] SoundCloud streaming

Streaming sources are planned but not implemented. Something missing that you
want? Start a [Discussion](../../discussions).

## Contributing

No rules, no templates, no bureaucracy.

- Found a bug → [open an Issue](../../issues)
- Got an idea → [start a Discussion](../../discussions)
- Made an EQ preset or fixed a typo → send a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for the long version (it is four lines).

## License

MIT — do whatever you want with it. See [LICENSE](LICENSE).
