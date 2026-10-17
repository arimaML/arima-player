/**
 * Browser-only fixture.
 *
 * When the UI runs outside the Tauri shell there is no database, so the folder
 * listing and the cover fetches are served from here instead. Inside the app
 * `isTauri()` is true and none of this is reachable.
 */
import type { FolderId, SortId, Track } from "./types";

/** A self-contained gradient cover, so the demo needs no image assets. */
export function demoCover(trackId: number): string | null {
  if (trackId % 7 === 4) return null; // one track without artwork, on purpose
  const hue = (trackId * 47) % 360;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">',
    "<defs>",
    '<radialGradient id="g" cx="38%" cy="32%" r="78%">',
    `<stop offset="0%" stop-color="hsl(${hue} 72% 56%)"/>`,
    `<stop offset="46%" stop-color="hsl(${hue} 62% 24%)"/>`,
    '<stop offset="100%" stop-color="#0b0b0d"/>',
    "</radialGradient>",
    "</defs>",
    '<rect width="256" height="256" fill="url(#g)"/>',
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const NOW = Math.floor(Date.now() / 1000);

function track(
  id: number,
  title: string,
  artist: string,
  album: string,
  durationSeconds: number,
  extra: Partial<Track> = {},
): Track {
  return {
    id,
    title,
    artist,
    album,
    duration: durationSeconds,
    source: "local",
    path: `demo/${id}.mp3`,
    hasCover: demoCover(id) !== null,
    dateAdded: NOW - (40 - id) * 86_400,
    playCount: 0,
    lastPlayed: null,
    isLiked: false,
    ...extra,
  };
}

/** Deliberately varied so every smart folder has something to show. */
export const DEMO_TRACKS: Track[] = [
  track(1, "Полночь", "Kolibri", "Ночная смена", 222, {
    playCount: 34,
    lastPlayed: NOW - 120,
    isLiked: true,
  }),
  track(2, "Стеклянный дождь", "Mira Vale", "Glass", 178, {
    playCount: 12,
    lastPlayed: NOW - 7_200,
    isLiked: true,
  }),
  track(3, "Северный ветер", "Arima Session", "Sessions", 255, {
    playCount: 7,
    lastPlayed: NOW - 26 * 3_600,
  }),
  track(4, "Тихий шум", "Без обложки", "Demos", 196, {
    playCount: 3,
    lastPlayed: NOW - 3 * 86_400,
    isLiked: true,
  }),
  track(5, "Гравитация", "Nova K", "Orbit", 201, {
    playCount: 1,
    lastPlayed: NOW - 9 * 86_400,
  }),
  track(6, "Послесловие", "Kolibri", "Ночная смена", 304, {
    playCount: 21,
    lastPlayed: NOW - 40 * 60,
  }),
  track(7, "Красная нить", "Mira Vale", "Glass", 187),
  track(8, "Тишина в ответ", "Arima Session", "Sessions", 241),
];

/** The same semantics as the SQL in `db::Folder::filter` plus its natural order. */
function folderRows(folder: FolderId): Track[] {
  switch (folder) {
    case "liked":
      return DEMO_TRACKS.filter((item) => item.isLiked).sort((a, b) => b.dateAdded - a.dateAdded);
    case "frequent":
      return DEMO_TRACKS.filter((item) => item.playCount > 0)
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, 200);
    case "recent":
      return DEMO_TRACKS.filter((item) => item.lastPlayed !== null)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        .slice(0, 200);
    case "all":
    default:
      return [...DEMO_TRACKS].sort((a, b) => b.dateAdded - a.dateAdded);
  }
}

export function demoFolder(folder: FolderId, sort?: SortId, descending = false): Track[] {
  // Design-review hook: `?empty` renders the empty state of any folder.
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("empty")) {
    return [];
  }

  const rows = folderRows(folder);
  if (!sort || sort === "natural") return rows;
  return sortRows(rows, sort, descending);
}

/**
 * Mirrors `db::Sort::order_by` — for the browser demo ONLY.
 *
 * The application never sorts a library in JavaScript: `get_folder` asks SQLite
 * for the order. This exists so a browser render (design review, screenshots)
 * behaves like the real thing instead of showing an unsorted list.
 */
export function sortRows(rows: Track[], sort: SortId, descending: boolean): Track[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const compare = (a: Track, b: Track): number => {
    switch (sort) {
      case "title":
        return collator.compare(a.title, b.title);
      case "artist":
        return collator.compare(a.artist, b.artist);
      case "duration":
        return a.duration - b.duration;
      case "plays":
        return b.playCount - a.playCount;
      case "date":
      default:
        return b.dateAdded - a.dateAdded;
    }
  };

  const sorted = [...rows].sort(compare);
  return descending && sort === "duration" ? sorted.reverse() : sorted;
}

/** The same fields `db::Library::search` matches, for the browser demo. */
export function demoSearch(query: string): Track[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  return DEMO_TRACKS.filter((item) =>
    `${item.title} ${item.artist} ${item.album}`.toLowerCase().includes(needle),
  ).sort((a, b) => b.dateAdded - a.dateAdded);
}
