import { Icon } from "./Icon";
import { TrackRow } from "./TrackRow";
import type { Track } from "../lib/types";

interface SearchResultsProps {
  query: string;
  tracks: Track[];
  searching: boolean;
  currentId: number | null;
  isPlaying: boolean;
  onClear: () => void;
  onPlay: (index: number) => void;
  onPlayNext: (track: Track) => void;
  onToggleLike: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onReveal: (track: Track) => void;
}

/**
 * The centre of the window while a query is active.
 *
 * Rows are the same component the folder listing uses, so every hover action
 * and the context menu behave identically here. The header carries the count
 * and the way back; the folder underneath is never touched.
 */
export function SearchResults({
  query,
  tracks,
  searching,
  currentId,
  isPlaying,
  onClear,
  onPlay,
  onPlayNext,
  onToggleLike,
  onEnqueue,
  onReveal,
}: SearchResultsProps) {
  const empty = tracks.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex shrink-0 items-center gap-2.5">
        <Icon name="search" className="h-4 w-4 shrink-0 text-ink-dim" />
        <span className="truncate text-[13px] text-ink">
          {empty && searching ? "Ищу…" : `Найдено: ${tracks.length}`}
        </span>
        <span className="truncate text-[11px] text-ink-dim">по запросу «{query.trim()}»</span>

        <button
          type="button"
          className="icon-btn focus-arima ml-auto shrink-0"
          onClick={onClear}
          title="Вернуться назад"
        >
          <Icon name="x" className="h-[18px] w-[18px]" />
        </button>
      </header>

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 pb-10 text-center">
          <Icon name="search" className="h-12 w-12 text-white/15" />
          <div className="text-[14px] text-ink">
            {searching ? "Ищу по библиотеке…" : "Ничего не найдено"}
          </div>
          <div className="max-w-[360px] text-[12px] leading-relaxed text-ink-dim">
            {searching
              ? "Поиск идёт по названию, исполнителю и альбому сразу во всей библиотеке."
              : "Поиск смотрит на название, исполнителя и альбом всей библиотеки, а не только открытой папки."}
          </div>
          <button type="button" className="btn focus-arima mt-2" onClick={onClear}>
            Вернуться
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
          {tracks.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              active={track.id === currentId}
              isPlaying={isPlaying}
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
