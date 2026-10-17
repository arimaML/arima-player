/**
 * Typed bridge to the Rust audio engine and library.
 *
 * Nothing here touches `<audio>`: the host owns decoding, DSP and output, and
 * this module only sends commands and receives state.
 */
import type { FolderId, PlaybackState, SortId, Track } from "./types";
import { isTauri } from "./tauri";

export const STATE_EVENT = "player:state";
export const DROPPED_EVENT = "library:dropped";
export const SPECTRUM_EVENT = "spectrum";

/** Thrown when the UI runs in a plain browser instead of the Tauri shell. */
export class NoHostError extends Error {
  constructor() {
    super("Аудиодвижок доступен только в приложении Arima Player");
    this.name = "NoHostError";
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NoHostError();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const playTrack = (path: string, trackId?: number) =>
  call<void>("play_track", { path, trackId: trackId ?? null });
export const togglePlay = () => call<void>("toggle_play");
export const stopPlayback = () => call<void>("stop");
export const seekTo = (position: number) => call<void>("seek", { position });

/**
 * Master gain, 0.0..2.0. Replaces the old `set_volume`: lift is applied by the
 * DSP gain stage so the limiter can see the boosted signal.
 */
export const applyGain = (value: number) => call<void>("set_gain", { value });
export const getState = () => call<PlaybackState>("get_state");

/* ---- library ------------------------------------------------------------- */

/** Mirrors `db::ImportSummary`. */
export interface ImportSummary {
  inserted: number;
  updated: number;
  total: number;
}

/**
 * One smart folder, ordered by SQL.
 *
 * The order is a parameter rather than something the UI does afterwards: the
 * database is the only place the library is ever sorted, so a large folder is
 * never re-sorted in JavaScript. `null` asks for the folder's own order.
 */
export const getFolder = (folder: FolderId, sort?: SortId, descending?: boolean) =>
  call<Track[]>("get_folder", {
    folder,
    sort: sort && sort !== "natural" ? sort : null,
    descending: descending ?? false,
  });

/** Global search: the whole library, not the folder on screen. */
export const searchAll = (query: string) => call<Track[]>("search_all", { query });

/** Reveal a local file in Explorer/Finder. */
export const revealInFolder = (path: string) => call<void>("reveal_in_folder", { path });

export const libraryCount = () => call<number>("library_count");
export const libraryPath = () => call<string>("library_path");
export const importFolder = (path: string) => call<ImportSummary>("import_folder", { path });
export const importPaths = (paths: string[]) => call<ImportSummary>("import_paths", { paths });
export const refreshFolders = () => call<ImportSummary>("refresh_folders");
export const setLiked = (trackId: number, liked: boolean) =>
  call<void>("set_liked", { trackId, liked });
export const getCover = (trackId: number) => call<string | null>("get_cover", { trackId });

/* ---- EQ ------------------------------------------------------------------ */

export interface PresetInfo {
  id: string;
  label: string;
  gains: number[];
}

/** Mirrors `audio::EqState`; the preset table lives in Rust so the UI never
 *  reimplements it. */
export interface EqState {
  enabled: boolean;
  limiterEnabled: boolean;
  gain: number;
  bands: number[];
  frequencies: number[];
  gainLimitDb: number;
  presets: PresetInfo[];
}

/** Mirrors `spectrum::SpectrumPayload`. */
export interface SpectrumPayload {
  bins: number[];
  peak: number;
}

export const getEq = () => call<EqState>("get_eq");
export const setEqBand = (index: number, gainDb: number) =>
  call<void>("set_eq_band", { index, gainDb });
export const setEqPreset = (name: string) => call<void>("set_eq_preset", { name });
export const setEqEnabled = (enabled: boolean) => call<void>("set_eq_enabled", { enabled });
export const setLimiterEnabled = (enabled: boolean) =>
  call<void>("set_limiter_enabled", { enabled });

/** Spectrum frames pushed by the analyser thread at ~45 Hz. */
export async function onSpectrum(
  handler: (payload: SpectrumPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SpectrumPayload>(SPECTRUM_EVENT, (event) => handler(event.payload));
}

/** Playback state pushed by the host while playing and on every change. */
export async function onPlaybackState(
  handler: (state: PlaybackState) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PlaybackState>(STATE_EVENT, (event) => handler(event.payload));
}

/** Paths of files/folders dropped onto the window. */
export async function onLibraryDropped(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>(DROPPED_EVENT, (event) => handler(event.payload));
}

/** Native folder picker, or `null` when cancelled. */
export async function pickMusicFolder(): Promise<string | null> {
  if (!isTauri()) throw new NoHostError();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Выбери папку с музыкой",
  });
  return typeof selected === "string" ? selected : null;
}

/** Native audio-file picker, or an empty array when cancelled. */
export async function pickMusicFiles(): Promise<string[]> {
  if (!isTauri()) throw new NoHostError();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    title: "Выбери аудиофайлы",
    filters: [
      { name: "Аудио", extensions: ["mp3", "flac", "opus", "wav", "m4a", "aac", "ogg"] },
    ],
  });
  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/* ---- appearance ---------------------------------------------------------- */

/** Mirrors `background::BackgroundInfo` on the Rust side. */
export interface BackgroundInfo {
  dataUrl: string | null;
  path: string | null;
}

export const getBackground = () => call<BackgroundInfo>("get_background");

/** Validate, downscale and store a wallpaper; returns the normalised image. */
export const setBackground = (source: string) =>
  call<BackgroundInfo>("set_background", { source });

export const resetBackground = () => call<void>("reset_background");

/** Toggle the OS window material (mica/acrylic). */
export const setVibrancy = (enabled: boolean) => call<void>("set_vibrancy", { enabled });

/** Native image picker for the wallpaper, or `null` when cancelled. */
export async function pickImageFile(): Promise<string | null> {
  if (!isTauri()) throw new NoHostError();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Выбери фон",
    filters: [{ name: "Изображения", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  });
  return typeof selected === "string" ? selected : null;
}
