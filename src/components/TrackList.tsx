import { useState } from "react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";
import { TrackRow } from "./TrackRow";
import {
  FOLDER_LABEL,
  SORT_LABEL,
  sortOptions,
  trackCount,
  type FolderId,
  type SortId,
  type Track,
} from "../lib/types";

interface TrackListProps {
  folder: FolderId;
  tracks: Track[];
  currentId: number | null;
  isPlaying: boolean;
  busy: boolean;
  /** The order SQL actually applied, not a request the UI keeps to itself. */
  sort: SortId;
  descending: boolean;
  onSort: (sort: SortId) => void;
  onPlay: (index: number) => void;
  onPlayNext: (track: Track) => void;
  onToggleLike: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onReveal: (track: Track) => void;
  onBack: () => void;
  onAddFolder: () => void;
  onAddFiles: () => void;
}

const FOLDER_ICON: Record<FolderId, IconName> = {
  liked: "heart",
  frequent: "refresh",
  recent: "clock",
  all: "music",
};

const EMPTY_HINT: Record<FolderId, string> = {
  liked: "Нажми ♡ на треке, чтобы добавить в Любимое",
  frequent: "Слушай треки — здесь появятся те, что ты чаще всего включаешь",
  recent: "Здесь будут треки, которые ты недавно слушал",
  all: "Добавь папку с музыкой или перетащи файлы в окно",
};

/**
 * The order chooser in the list header.
 *
 * It only reports the choice: the list is re-read from SQL, never re-sorted
 * here. Re-picking the active entry flips it, which only duration uses.
 */
function SortMenu({
  folder,
  sort,
  descending,
  onSort,
}: {
  folder: FolderId;
  sort: SortId;
  descending: boolean;
  onSort: (sort: SortId) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const arrow = sort === "duration" ? (descending ? " ↓" : " ↑") : "";
  const items: MenuItem[] = sortOptions(folder).map((option) => ({
    id: option,
    label: `${SORT_LABEL[option]}${option === "duration" ? (descending ? " ↓" : " ↑") : ""}`,
    checked: option === sort,
    onSelect: () => onSort(option),
  }));

  return (
    <>
      <button
        type="button"
        className="sort-btn focus-arima"
        aria-haspopup="menu"
        aria-label={`Сортировка: ${SORT_LABEL[sort]}`}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: box.left, y: box.bottom + 6 });
        }}
      >
        <span className="truncate">
          {SORT_LABEL[sort]}
          {arrow}
        </span>
        <Icon name="chevron-down" className="h-3.5 w-3.5 shrink-0" />
      </button>

      {anchor && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={items}
          onClose={() => setAnchor(null)}
          width={230}
        />
      )}
    </>
  );
}

export function TrackList({
  folder,
  tracks,
  currentId,
  isPlaying,
  busy,
  sort,
  descending,
  onSort,
  onPlay,
  onPlayNext,
  onToggleLike,
  onEnqueue,
  onReveal,
  onBack,
  onAddFolder,
  onAddFiles,
}: TrackListProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          className="icon-btn focus-arima"
          onClick={onBack}
          title="Вернуться к плееру"
        >
          <Icon name="chevron-right" className="h-[18px] w-[18px] rotate-180" />
        </button>
        <Icon name={FOLDER_ICON[folder]} className="h-4 w-4 shrink-0 text-ink-dim" />
        <span className="truncate text-[13px] text-ink">{FOLDER_LABEL[folder]}</span>
        <span className="shrink-0 text-[11px] text-ink-dim">— {trackCount(tracks.length)}</span>

        <div className="ml-auto shrink-0">
          <SortMenu folder={folder} sort={sort} descending={descending} onSort={onSort} />
        </div>
      </header>

      {tracks.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 pb-10 text-center">
          <Icon name={FOLDER_ICON[folder]} className="h-12 w-12 text-white/15" />
          <div className="text-[14px] text-ink">Здесь пока пусто</div>
          <div className="max-w-[340px] text-[12px] leading-relaxed text-ink-dim">
            {EMPTY_HINT[folder]}
          </div>
          {folder === "all" && (
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="btn focus-arima" onClick={onAddFolder} disabled={busy}>
                {busy ? "Сканирую…" : "Добавить папку"}
              </button>
              <button type="button" className="btn focus-arima" onClick={onAddFiles} disabled={busy}>
                Добавить файлы
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
          {tracks.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              active={track.id === currentId}
              isPlaying={isPlaying}
              showLastPlayed={folder === "recent"}
              onPlay={() => onPlay(index)}
              onPlayNext={() => onPlayNext(track)}
              onEnqueue={() => onEnqueue(track)}
              onToggleLike={() => onToggleLike(track)}
              onReveal={() => onReveal(track)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
