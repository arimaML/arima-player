/** Domain types for Arima Player. */

export type Source = "local" | "youtube" | "soundcloud";

/** Mirrors `db::Track` on the Rust side. */
export interface Track {
  /** Row id in the library database. */
  id: number;
  title: string;
  artist: string;
  album: string;
  /** Seconds, converted from the stored milliseconds. */
  duration: number;
  source: Source;
  /** Absolute file path. */
  path: string;
  /** Whether artwork exists; the image itself is fetched per row and cached. */
  hasCover: boolean;
  /** Unix seconds. */
  dateAdded: number;
  playCount: number;
  /** Unix seconds, `null` until the track has been played. */
  lastPlayed: number | null;
  isLiked: boolean;
}

/** The four smart folders. */
export type FolderId = "liked" | "frequent" | "recent" | "all";

export const FOLDER_LABEL: Record<FolderId, string> = {
  liked: "Любимое",
  frequent: "Часто слушаю",
  recent: "Недавние",
  all: "Все треки",
};

/* ---- sorting ------------------------------------------------------------- */

/**
 * Orders the list header can ask for.
 *
 * `natural` is not "no order" — it is the order the folder already has in SQL,
 * which is what makes «Недавние» mean "recently played". It is only offered
 * where no other option expresses it.
 */
export type SortId = "natural" | "date" | "title" | "artist" | "duration" | "plays";

export const SORT_LABEL: Record<SortId, string> = {
  natural: "Недавно игравшие",
  date: "Дата добавления",
  title: "Имя",
  artist: "Артист",
  duration: "Длительность",
  plays: "Частота прослушивания",
};

/** Every folder except «Недавние» can express its own order with another entry:
 *  «Все треки» and «Любимое» are already newest-first, «Часто слушаю» is
 *  already by play count. «Недавние» is ordered by the last play, which nothing
 *  else in this list says, so it keeps an explicit first entry. */
export function sortOptions(folder: FolderId): SortId[] {
  const common: SortId[] = ["date", "title", "artist", "duration", "plays"];
  return folder === "recent" ? ["natural", ...common] : common;
}

/** What a folder shows before anyone touches the dropdown. */
export const DEFAULT_SORT: Record<FolderId, SortId> = {
  liked: "date",
  frequent: "plays",
  recent: "natural",
  all: "date",
};

/** Keep a stored or stale value inside what the folder actually offers. */
export function settleSort(folder: FolderId, sort: SortId | undefined): SortId {
  if (sort && sortOptions(folder).includes(sort)) return sort;
  return DEFAULT_SORT[folder];
}

/** "12 треков" with the right Russian plural form. */
export function trackCount(count: number): string {
  return `${count} ${plural(count, "трек", "трека", "треков")}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * "2 часа назад", "вчера", "3 дня назад" — used by the Недавние folder.
 * `now` is injectable so the boundary cases are testable by hand.
 */
export function relativeTime(unixSeconds: number, now: number = Date.now() / 1000): string {
  const seconds = Math.max(0, Math.floor(now - unixSeconds));

  if (seconds < 60) return "только что";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  }

  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) {
    return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks} ${plural(weeks, "неделю", "недели", "недель")} назад`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} ${plural(months, "месяц", "месяца", "месяцев")} назад`;
  }

  const years = Math.max(1, Math.floor(days / 365));
  return `${years} ${plural(years, "год", "года", "лет")} назад`;
}

/** Mirrors `audio::PlaybackState` on the Rust side. */
export interface PlaybackState {
  path: string | null;
  position: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
}

/**
 * Playback commands. These are the same verbs the system tray and the global
 * hotkeys emit, so every input path funnels through one reducer.
 */
export type ShortcutAction =
  | "play_pause"
  | "play"
  | "pause"
  | "stop"
  | "next"
  | "prev"
  | "seek_forward"
  | "seek_back"
  | "volume_up"
  | "volume_down"
  | "mute"
  | "show";

export const SOURCE_LABEL: Record<Source, string> = {
  local: "Локальные",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
};

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
