/**
 * Appearance: glass settings, custom wallpaper and window material.
 *
 * Settings live in localStorage; the wallpaper itself is owned by the host and
 * stored in `app_data_dir()` as a normalised JPEG.
 */
import { useCallback, useEffect, useState } from "react";

import {
  getBackground,
  pickImageFile,
  resetBackground,
  setBackground,
  setVibrancy,
  type BackgroundInfo,
} from "./engine";

export interface AppSettings {
  /** 0–100 in the UI; drives `--glass-alpha` as `v / 200`, as in the reference. */
  glassOpacity: number;
  /** 0–40 px; drives `--glass-blur`. */
  glassBlur: number;
  /** 40–90 %; opacity of the wallpaper layer. Below 100 the desktop shows through. */
  windowOpacity: number;
  /** OS-level window material (mica/acrylic). */
  vibrancy: boolean;
  /** Spectrum canvas under the disc. */
  visualizer: boolean;
  volumeBoost: boolean;
  streamQuality: "Low" | "Normal" | "High" | "Best";
}

const STORAGE_KEY = "arima.settings.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  glassOpacity: 65,
  glassBlur: 20,
  windowOpacity: 90,
  vibrancy: true,
  visualizer: true,
  volumeBoost: false,
  streamQuality: "High",
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const EMPTY_BACKGROUND: BackgroundInfo = { dataUrl: null, path: null };

export function useAppearance(notify: (message: string, kind?: "error" | "info") => void) {
  const [settings, setSettings] = useState<AppSettings>(load);
  const [background, setBackgroundState] = useState<BackgroundInfo>(EMPTY_BACKGROUND);
  const [busy, setBusy] = useState(false);

  /* Mirror settings into CSS custom properties and persist them. */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-alpha", (settings.glassOpacity / 200).toFixed(3));
    root.style.setProperty("--glass-blur", `${settings.glassBlur}px`);
    root.style.setProperty("--bg-opacity", (settings.windowOpacity / 100).toFixed(2));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable — settings just won't persist */
    }
  }, [settings]);

  /* Apply the wallpaper layer. */
  useEffect(() => {
    const root = document.documentElement;
    if (background.dataUrl) {
      root.style.setProperty("--bg-image", `url("${background.dataUrl}")`);
      root.dataset.hasBackground = "true";
    } else {
      root.style.removeProperty("--bg-image");
      delete root.dataset.hasBackground;
    }
  }, [background]);

  /* The host owns the window material; keep it in sync with the toggle. */
  useEffect(() => {
    setVibrancy(settings.vibrancy).catch(() => {
      /* no host (browser dev) or unsupported platform — CSS still works */
    });
  }, [settings.vibrancy]);

  /* Adopt whatever wallpaper the host already has. */
  useEffect(() => {
    getBackground()
      .then(setBackgroundState)
      .catch(() => {});
  }, []);

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const chooseBackground = useCallback(async () => {
    setBusy(true);
    try {
      const source = await pickImageFile();
      if (!source) return;
      const info = await setBackground(source);
      setBackgroundState(info);
      notify("Фон обновлён");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const clearBackground = useCallback(async () => {
    setBusy(true);
    try {
      await resetBackground();
      setBackgroundState(EMPTY_BACKGROUND);
      notify("Фон сброшен");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }, [notify]);

  return {
    settings,
    update,
    background,
    hasBackground: background.dataUrl !== null,
    busy,
    chooseBackground,
    clearBackground,
  };
}
