import { Icon } from "./Icon";
import { useCover } from "../lib/covers";
import { formatTime, type Track } from "../lib/types";

interface QueueProps {
  queue: Track[];
  currentIndex: number;
  isPlaying: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (index: number) => void;
}

export function Queue({ queue, currentIndex, isPlaying, open, onToggle, onPick }: QueueProps) {
  return (
    <aside className="glass flex min-h-0 flex-col px-3 py-3.5">
      <div
        className={[
          "flex items-center pb-3",
          open ? "justify-between px-1" : "justify-center",
        ].join(" ")}
      >
        {open && (
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
            Очередь
          </span>
        )}
        <button
          type="button"
          className="icon-btn focus-arima"
          onClick={onToggle}
          title={open ? "Свернуть очередь" : "Развернуть очередь"}
        >
          <Icon
            name="chevron-right"
            className={["h-[18px] w-[18px] transition-transform", open ? "" : "rotate-180"].join(" ")}
          />
        </button>
      </div>

      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
          {queue.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-ink-dim">
              Очередь пуста. Включи трек — очередь соберётся из открытой папки.
            </div>
          )}

          {queue.map((track, index) => (
            <QueueRow
              key={`${track.id}-${index}`}
              track={track}
              active={index === currentIndex}
              isPlaying={isPlaying}
              onPick={() => onPick(index)}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function QueueRow({
  track,
  active,
  isPlaying,
  onPick,
}: {
  track: Track;
  active: boolean;
  isPlaying: boolean;
  onPick: () => void;
}) {
  const cover = useCover(track.id, track.hasCover);

  return (
    <button
      type="button"
      onClick={onPick}
      className={["queue-item focus-arima", active ? "active" : ""].join(" ")}
    >
      <span className="qi-thumb">
        {cover ? (
          <img
            src={cover}
            alt=""
            draggable={false}
            className="h-full w-full select-none object-cover"
          />
        ) : (
          <Icon name="music" className="h-4 w-4" />
        )}
        {active && (
          <span className="absolute inset-0 grid place-items-center bg-black/45 text-white">
            <Icon name={isPlaying ? "pause" : "play"} className="h-3.5 w-3.5" />
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] leading-tight">{track.title}</span>
        <span className="truncate text-[11px] leading-tight text-ink-dim">{track.artist}</span>
      </span>

      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-dim">
        {formatTime(track.duration)}
      </span>
    </button>
  );
}
