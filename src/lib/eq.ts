/**
 * EQ state: the backend is the source of truth, localStorage is the restore
 * point, and the browser-only fallback keeps the panel reviewable without the
 * host.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getEq,
  setEqBand,
  setEqEnabled,
  setEqPreset,
  setLimiterEnabled,
  type EqState,
} from "./engine";

const STORAGE_KEY = "arima.eq.v1";
export const CUSTOM_PRESET = "custom";

/** Only used when there is no host (plain `npm run dev` in a browser). */
const DEMO_STATE: EqState = {
  enabled: true,
  limiterEnabled: true,
  gain: 1,
  bands: [6, 6, 5, 3, 0, 0, 0, 0, -1, -2],
  frequencies: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  gainLimitDb: 12,
  presets: [
    { id: "flat", label: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: "bass", label: "Bass Boost", gains: [6, 6, 5, 3, 0, 0, 0, 0, -1, -2] },
    { id: "vocal", label: "Vocal", gains: [-2, -2, -1, 0, 1, 3, 3, 2, 1, -1] },
    { id: "rock", label: "Rock", gains: [3, 3, 2, 0, -2, -1, 2, 3, 3, 3] },
    { id: "guly", label: "Guly", gains: [5, 5, 3, 1, 0, -1, -2, -3, -4, -5] },
  ],
};

interface StoredEq {
  enabled: boolean;
  limiterEnabled: boolean;
  bands: number[];
}

function loadStored(): StoredEq | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEq>;
    if (!Array.isArray(parsed.bands) || parsed.bands.length !== 10) return null;
    return {
      enabled: parsed.enabled ?? true,
      limiterEnabled: parsed.limiterEnabled ?? true,
      bands: parsed.bands.map(Number),
    };
  } catch {
    return null;
  }
}

function persist(state: EqState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: state.enabled,
        limiterEnabled: state.limiterEnabled,
        bands: state.bands,
      } satisfies StoredEq),
    );
  } catch {
    /* storage unavailable — EQ just will not survive a restart */
  }
}

export function useEq(notify: (message: string, kind?: "error" | "info") => void) {
  const [state, setState] = useState<EqState | null>(null);

  /* Adopt the backend state, then re-apply whatever the user had last time. */
  useEffect(() => {
    let cancelled = false;

    getEq()
      .catch(() => DEMO_STATE)
      .then(async (base) => {
        if (cancelled) return;
        const stored = loadStored();
        if (!stored) {
          setState(base);
          return;
        }

        // Push the restored values back into the engine, which starts flat.
        await Promise.all([
          setEqEnabled(stored.enabled).catch(() => {}),
          setLimiterEnabled(stored.limiterEnabled).catch(() => {}),
          // Band-by-band so a preset match is re-derived, not assumed.
          ...stored.bands.map((gain, index) => setEqBand(index, gain).catch(() => {})),
        ]).catch(() => {});

        if (cancelled) return;
        setState({ ...base, enabled: stored.enabled, limiterEnabled: stored.limiterEnabled, bands: stored.bands });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: EqState) => {
    setState(next);
    persist(next);
  }, []);

  const setBand = useCallback(
    (index: number, gainDb: number) => {
      setState((prev) => {
        if (!prev) return prev;
        const bands = prev.bands.map((value, i) => (i === index ? gainDb : value));
        const next = { ...prev, bands };
        persist(next);
        return next;
      });
      setEqBand(index, gainDb).catch((error) => {
        notify(error instanceof Error ? error.message : String(error), "error");
      });
    },
    [notify],
  );

  const applyPreset = useCallback(
    (id: string) => {
      const preset = state?.presets.find((candidate) => candidate.id === id);
      if (!preset) return;

      update({ ...state!, bands: [...preset.gains] });
      setEqPreset(id).catch((error) => {
        notify(error instanceof Error ? error.message : String(error), "error");
      });
    },
    [state, update, notify],
  );

  const toggleEnabled = useCallback(
    (enabled: boolean) => {
      if (!state) return;
      update({ ...state, enabled });
      setEqEnabled(enabled).catch(() => {});
    },
    [state, update],
  );

  const toggleLimiter = useCallback(
    (enabled: boolean) => {
      if (!state) return;
      update({ ...state, limiterEnabled: enabled });
      setLimiterEnabled(enabled).catch(() => {});
    },
    [state, update],
  );

  /** Which preset the current bands correspond to, or "custom". */
  const presetId = useMemo(() => {
    if (!state) return CUSTOM_PRESET;
    const match = state.presets.find(
      (preset) =>
        preset.gains.length === state.bands.length &&
        preset.gains.every((gain, i) => Math.abs(gain - state.bands[i]) < 0.01),
    );
    return match?.id ?? CUSTOM_PRESET;
  }, [state]);

  return {
    eq: state,
    presetId,
    setBand,
    applyPreset,
    toggleEnabled,
    toggleLimiter,
    reset: () => applyPreset("flat"),
  };
}
