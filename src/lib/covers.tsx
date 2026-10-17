import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getCover } from "./engine";
import { demoCover } from "./demo";
import { isTauri } from "./tauri";

interface CoverApi {
  covers: Record<number, string>;
  request: (trackId: number) => void;
}

const CoverContext = createContext<CoverApi>({ covers: {}, request: () => {} });

/**
 * Session cache for artwork.
 *
 * Folder listings carry only a `hasCover` flag. Embedding every image as base64
 * would push megabytes through IPC on each folder switch, and most rows are
 * never scrolled into view — so each image is fetched once, on first use.
 */
export function CoverProvider({ children }: { children: ReactNode }) {
  const [covers, setCovers] = useState<Record<number, string>>({});
  const requested = useRef(new Set<number>());

  const request = useCallback((trackId: number) => {
    if (!Number.isFinite(trackId) || requested.current.has(trackId)) return;
    requested.current.add(trackId);

    const source = isTauri()
      ? getCover(trackId)
      : Promise.resolve(demoCover(trackId));

    source
      .then((url) => {
        if (url) setCovers((prev) => ({ ...prev, [trackId]: url }));
      })
      .catch(() => {
        /* no host, or no artwork — the note icon stands in */
      });
  }, []);

  const value = useMemo(() => ({ covers, request }), [covers, request]);
  return <CoverContext.Provider value={value}>{children}</CoverContext.Provider>;
}

/** Artwork for one track, fetched on first use. */
export function useCover(trackId: number | undefined, hasCover: boolean): string | undefined {
  const { covers, request } = useContext(CoverContext);

  useEffect(() => {
    if (trackId !== undefined && hasCover) request(trackId);
  }, [trackId, hasCover, request]);

  return trackId !== undefined ? covers[trackId] : undefined;
}
