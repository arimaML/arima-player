import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyGain,
  getFolder,
  getState,
  importFolder,
  importPaths,
  libraryCount,
  onLibraryDropped,
  onPlaybackState,
  pickMusicFiles,
  pickMusicFolder,
  playTrack,
  refreshFolders,
  revealInFolder,
  searchAll,
  seekTo,
  setLiked,
  stopPlayback,
  togglePlay,
} from "./engine";
import { onShortcut, isTauri } from "./tauri";
import { demoFolder, demoSearch } from "./demo";
import {
  settleSort,
  type FolderId,
  type PlaybackState,
  type ShortcutAction,
  type SortId,
  type Track,
} from "./types";

const SEEK_STEP = 5;
const VOLUME_STEP = 0.05;

/** A keystroke must not become a query: let the typing settle first. */
const SEARCH_DEBOUNCE = 250;

/** Per-folder sort orders, remembered across restarts. */
const SORT_STORAGE_KEY = "arima.sort.v1";

interface SortState {
  sort: SortId;
  descending: boolean;
}

type SortByFolder = Record<FolderId, SortState>;

/** Mirrors `SortId::default` on the Rust side only in spirit: the folder's own
 *  order is the default wherever it is also an option. */
function defaultSorts(): SortByFolder {
  return {
    liked: { sort: "date", descending: false },
    frequent: { sort: "plays", descending: false },
    recent: { sort: "natural", descending: false },
    all: { sort: "date", descending: false },
  };
}

/** Read the stored orders, discarding anything a folder no longer offers. */
function loadSorts(): SortByFolder {
  const sorts = defaultSorts();
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return sorts;

    const stored = JSON.parse(raw) as Partial<Record<FolderId, Partial<SortState>>>;
    for (const folder of Object.keys(sorts) as FolderId[]) {
      const entry = stored[folder];
      if (!entry) continue;
      sorts[folder] = {
        sort: settleSort(folder, entry.sort),
        descending: Boolean(entry.descending),
      };
    }
  } catch {
    // A corrupt or unavailable store just means defaults: sorting is not
    // important enough to keep the player from starting.
  }
  return sorts;
}

function persistSorts(sorts: SortByFolder) {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sorts));
  } catch {
    /* private mode or no storage — defaults next launch */
  }
}

const IDLE: PlaybackState = {
  path: null,
  position: 0,
  duration: 0,
  isPlaying: false,
  volume: 1,
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The order is passed to SQL; the browser demo mirrors it with a fixture. */
async function fetchFolder(
  folder: FolderId,
  sort: SortId,
  descending: boolean,
): Promise<Track[]> {
  return isTauri() ? getFolder(folder, sort, descending) : demoFolder(folder, sort, descending);
}

/**
 * The library lives in SQLite, not in React state.
 *
 * `tracks` is the folder currently on screen and is reloaded from the database
 * after anything that could change it; `queue` is the playback queue, which is
 * snapshotted when playback starts so browsing another folder cannot silently
 * reorder what is playing.
 */
export function usePlayer(notify: (message: string, kind?: "error" | "info") => void) {
  const [folder, setFolderState] = useState<FolderId>("all");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<PlaybackState>(IDLE);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sorts, setSorts] = useState<SortByFolder>(loadSorts);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);

  const tracksRef = useRef(tracks);
  const queueRef = useRef(queue);
  const indexRef = useRef(currentIndex);
  const folderRef = useRef(folder);
  const stateRef = useRef(state);
  const sortsRef = useRef(sorts);
  const resultsRef = useRef(results);
  const previousRef = useRef({ playing: false, position: 0 });
  tracksRef.current = tracks;
  queueRef.current = queue;
  indexRef.current = currentIndex;
  folderRef.current = folder;
  stateRef.current = state;
  sortsRef.current = sorts;
  resultsRef.current = results;

  const current = currentIndex >= 0 ? queue[currentIndex] : undefined;

  /** A non-empty query is what switches the centre of the window to results. */
  const searchActive = searchQuery.trim().length > 0;

  /* ---- loading --------------------------------------------------------- */

  const loadFolder = useCallback(async (target: FolderId) => {
    const { sort, descending } = sortsRef.current[target];
    try {
      const list = await fetchFolder(target, sort, descending);
      setTracks(list);
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  /**
   * Change the order of the folder on screen.
   *
   * The list is re-read from SQL rather than re-sorted here: `get_folder` takes
   * the order and SQLite does the work, so a folder of any size costs one
   * indexed query. Re-picking the active option flips it, which is the only
   * order with a direction worth flipping.
   */
  const applySort = useCallback(
    async (sort: SortId) => {
      const target = folderRef.current;
      const current = sortsRef.current[target];
      const descending = current.sort === sort ? !current.descending : false;

      const next = { ...sortsRef.current, [target]: { sort, descending } };
      sortsRef.current = next;
      setSorts(next);
      persistSorts(next);

      await loadFolder(target);
    },
    [loadFolder],
  );

  const refreshTotal = useCallback(async () => {
    try {
      setTotal(isTauri() ? await libraryCount() : 8);
    } catch {
      /* nothing to show yet */
    }
  }, []);

  /* Startup: refresh the remembered folders, then show the active one. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isTauri()) {
        try {
          await refreshFolders();
        } catch {
          /* an empty or unavailable database is not an error */
        }
      }
      if (cancelled) return;
      await loadFolder(folderRef.current);
      await refreshTotal();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFolder, refreshTotal]);

  const selectFolder = useCallback(
    async (target: FolderId) => {
      setFolderState(target);
      folderRef.current = target;
      // Picking a folder is a deliberate navigation, so it also dismisses an
      // active search: otherwise the click would appear to do nothing at all.
      setSearchQuery("");
      await loadFolder(target);
    },
    [loadFolder],
  );

  /* ---- global search --------------------------------------------------- */

  /**
   * Debounced search over the whole library.
   *
   * The query is the only dependency, so each keystroke cancels the pending
   * timer and exactly one query is in flight. A cleared query empties the
   * results immediately instead of after the debounce.
   */
  useEffect(() => {
    const needle = searchQuery.trim();
    if (!needle) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = isTauri() ? await searchAll(needle) : demoSearch(needle);
          if (!cancelled) {
            setResults(hits);
            setError(null);
          }
        } catch (err) {
          if (!cancelled) setError(describe(err));
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  /** Back to whatever view the query interrupted. */
  const clearSearch = useCallback(() => setSearchQuery(""), []);

  /* ---- transport ------------------------------------------------------- */

  const playFromList = useCallback(async (index: number) => {
    const list = tracksRef.current;
    const track = list[index];
    if (!track) return;

    // Snapshot the visible folder as the queue, so later browsing does not
    // change what plays next.
    setQueue(list);
    queueRef.current = list;
    setCurrentIndex(index);
    indexRef.current = index;

    try {
      await playTrack(track.path, track.id);
      const now = Math.floor(Date.now() / 1000);
      const bump = (item: Track) =>
        item.id === track.id ? { ...item, playCount: item.playCount + 1, lastPlayed: now } : item;
      setTracks((prev) => prev.map(bump));
      setQueue((prev) => prev.map(bump));
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  /** Play a search result. The results themselves become the queue, exactly as
   *  the visible folder does when a row is clicked there. */
  const playFromResults = useCallback(async (index: number) => {
    const list = resultsRef.current;
    const track = list[index];
    if (!track) return;

    setQueue(list);
    queueRef.current = list;
    setCurrentIndex(index);
    indexRef.current = index;

    try {
      await playTrack(track.path, track.id);
      const now = Math.floor(Date.now() / 1000);
      const bump = (item: Track) =>
        item.id === track.id ? { ...item, playCount: item.playCount + 1, lastPlayed: now } : item;
      setResults((prev) => prev.map(bump));
      setQueue((prev) => prev.map(bump));
      setTracks((prev) => prev.map(bump));
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  const playQueueIndex = useCallback(async (index: number) => {
    const list = queueRef.current;
    const track = list[index];
    if (!track) return;

    setCurrentIndex(index);
    indexRef.current = index;

    try {
      await playTrack(track.path, track.id);
      const now = Math.floor(Date.now() / 1000);
      const bump = (item: Track) =>
        item.id === track.id ? { ...item, playCount: item.playCount + 1, lastPlayed: now } : item;
      setQueue((prev) => prev.map(bump));
      setTracks((prev) => prev.map(bump));
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  const enqueue = useCallback((track: Track) => {
    setQueue((prev) => {
      const next = [...prev, track];
      queueRef.current = next;
      return next;
    });
  }, []);

  /** Slot a track in right after the current one, so «дальше» reaches it next. */
  const playNext = useCallback(
    (track: Track) => {
      setQueue((prev) => {
        const at = indexRef.current;
        const next = [...prev];
        const where = at >= 0 && at + 1 <= next.length ? at + 1 : next.length;
        next.splice(where, 0, track);
        queueRef.current = next;
        return next;
      });
      notify(`«${track.title}» — следующим`);
    },
    [notify],
  );

  /** Open a local file in Explorer. A streamed track has no file to show. */
  const reveal = useCallback(
    async (track: Track) => {
      if (track.source !== "local") {
        notify("Этот трек не лежит на диске", "error");
        return;
      }
      try {
        await revealInFolder(track.path);
      } catch (err) {
        setError(describe(err));
      }
    },
    [notify],
  );

  const seek = useCallback(async (position: number) => {
    setState((prev) => ({ ...prev, position }));
    try {
      await seekTo(position);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  const setVolume = useCallback(async (volume: number) => {
    const clamped = Math.min(2, Math.max(0, volume));
    setState((prev) => ({ ...prev, volume: clamped }));
    try {
      await applyGain(clamped);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  /* ---- likes ----------------------------------------------------------- */

  const toggleLike = useCallback(
    async (track: Pick<Track, "id" | "isLiked">) => {
      const liked = !track.isLiked;
      const apply = (value: boolean) => {
        const update = (item: Track) => (item.id === track.id ? { ...item, isLiked: value } : item);
        setTracks((prev) => prev.map(update));
        setQueue((prev) => prev.map(update));
        setResults((prev) => prev.map(update));
      };

      apply(liked); // optimistic: the heart should not lag a database write
      try {
        await setLiked(track.id, liked);
        // Unliking from inside Любимое has to make the row disappear.
        if (folderRef.current === "liked") await loadFolder("liked");
      } catch (err) {
        apply(!liked);
        setError(describe(err));
      }
    },
    [loadFolder],
  );

  const toggleLikeCurrent = useCallback(() => {
    const track = queueRef.current[indexRef.current];
    if (track) void toggleLike(track);
  }, [toggleLike]);

  /* ---- importing ------------------------------------------------------- */

  const reportImport = useCallback(
    (summary: { inserted: number; updated: number; total: number }) => {
      setTotal(summary.total);
      if (summary.inserted === 0 && summary.updated === 0) {
        notify("В этом месте не нашлось аудиофайлов");
        return;
      }
      const parts = [`${summary.inserted} новых`, `${summary.updated} обновлено`];
      notify(`Импорт: ${parts.join(", ")} — всего ${summary.total}`);
    },
    [notify],
  );

  const addFolder = useCallback(async () => {
    setBusy(true);
    try {
      const directory = await pickMusicFolder();
      if (!directory) return;
      reportImport(await importFolder(directory));
      await loadFolder(folderRef.current);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [loadFolder, reportImport]);

  const addFiles = useCallback(async () => {
    setBusy(true);
    try {
      const files = await pickMusicFiles();
      if (files.length === 0) return;
      reportImport(await importPaths(files));
      await loadFolder(folderRef.current);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [loadFolder, reportImport]);

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        reportImport(await importPaths(paths));
        await loadFolder(folderRef.current);
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [loadFolder, reportImport],
  );

  /* ---- host events ----------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    onPlaybackState((next) => {
      const previous = previousRef.current;
      previousRef.current = { playing: next.isPlaying, position: next.position };
      setState(next);

      const finished =
        previous.playing &&
        !next.isPlaying &&
        next.position === 0 &&
        previous.position > 0.5 &&
        next.path !== null;

      if (finished) {
        const list = queueRef.current;
        const index = indexRef.current;
        if (index >= 0 && index + 1 < list.length) void playQueueIndex(index + 1);
      }
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [playQueueIndex]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    onLibraryDropped((paths) => {
      void addPaths(paths);
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [addPaths]);

  useEffect(() => {
    getState()
      .then(setState)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (error) notify(error, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  /* ---- tray menu + global media keys ----------------------------------- */

  const dispatch = useCallback(
    async (action: ShortcutAction) => {
      const snapshot = stateRef.current;
      const list = queueRef.current;
      const index = indexRef.current;

      try {
        switch (action) {
          case "play_pause":
            if (index < 0) {
              if (tracksRef.current.length > 0) await playFromList(0);
            } else {
              await togglePlay();
            }
            break;
          case "play":
            if (index < 0 && tracksRef.current.length > 0) await playFromList(0);
            else await togglePlay();
            break;
          case "pause":
            if (snapshot.isPlaying) await togglePlay();
            break;
          case "stop":
            await stopPlayback();
            setCurrentIndex(-1);
            indexRef.current = -1;
            break;
          case "next":
            if (list.length > 0) await playQueueIndex((index + 1) % list.length);
            break;
          case "prev":
            if (list.length > 0) {
              await playQueueIndex((index - 1 + list.length) % list.length);
            }
            break;
          case "seek_forward":
            await seek(Math.min(snapshot.duration, snapshot.position + SEEK_STEP));
            break;
          case "seek_back":
            await seek(Math.max(0, snapshot.position - SEEK_STEP));
            break;
          case "volume_up":
            await setVolume(snapshot.volume + VOLUME_STEP);
            break;
          case "volume_down":
            await setVolume(snapshot.volume - VOLUME_STEP);
            break;
          case "mute":
            await setVolume(snapshot.volume > 0 ? 0 : 1);
            break;
          default:
            break;
        }
        setError(null);
      } catch (err) {
        setError(describe(err));
      }
    },
    [playFromList, playQueueIndex, seek, setVolume],
  );

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    onShortcut((action) => void dispatch(action)).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const ctrl = event.ctrlKey || event.metaKey;
      let action: ShortcutAction | null = null;

      if (event.code === "Space") action = "play_pause";
      else if (event.code === "ArrowRight") action = ctrl ? "next" : "seek_forward";
      else if (event.code === "ArrowLeft") action = ctrl ? "prev" : "seek_back";
      else if (event.code === "ArrowUp") action = "volume_up";
      else if (event.code === "ArrowDown") action = "volume_down";
      else if (event.code === "KeyM") action = "mute";

      if (action) {
        event.preventDefault();
        void dispatch(action);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  return useMemo(
    () => ({
      folder,
      tracks,
      queue,
      total,
      current,
      currentIndex,
      liked: current?.isLiked ?? false,
      isPlaying: state.isPlaying,
      position: state.position,
      duration: state.duration || current?.duration || 0,
      volume: state.volume,
      busy,
      ready,
      error,
      /* sorting — per folder, and applied by SQL */
      sort: sorts[folder].sort,
      descending: sorts[folder].descending,
      applySort,
      /* global search */
      searchQuery,
      setSearchQuery,
      clearSearch,
      searchActive,
      searching,
      results,
      playFromResults,
      /* row actions */
      playNext,
      reveal,
      selectFolder,
      playFromList,
      playQueueIndex,
      enqueue,
      toggleLike,
      toggleLikeCurrent,
      dispatch,
      seek,
      setVolume,
      addFolder,
      addFiles,
      addPaths,
      reload: () => loadFolder(folderRef.current),
      dismissError: () => setError(null),
    }),
    [
      folder,
      tracks,
      queue,
      total,
      current,
      currentIndex,
      state,
      busy,
      ready,
      error,
      sorts,
      applySort,
      searchQuery,
      clearSearch,
      searchActive,
      searching,
      results,
      playFromResults,
      playNext,
      reveal,
      selectFolder,
      playFromList,
      playQueueIndex,
      enqueue,
      toggleLike,
      toggleLikeCurrent,
      dispatch,
      seek,
      setVolume,
      addFolder,
      addFiles,
      addPaths,
      loadFolder,
    ],
  );
}
