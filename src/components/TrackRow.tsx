import { useState } from "react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { useCover } from "../lib/covers";
import { formatTime, relativeTime, type Track } from "../lib/types";

interface TrackRowProps {
  track: Track;
  active: boolean;
  isPlaying: boolean;
  /** «Недавние» shows when the track was last played. */
  showLastPlayed?: boolean;
  onPlay: () => void;
  onPlayNext: () => void;
  onEnqueue: () => void;
  onToggleLike: () => void;
  onReveal: () => void;
}

/** Where a floating menu was summoned from, in viewport coordinates. */
interface Anchor {
  x: number;
  y: number;
}

/**
 * One library row, shared by the folder listing and the search results.
 *
 * The row owns its context menu so a right click anywhere on it — and the `⋯`
 * button — open the same menu anchored correctly, without the list having to
 * track which row is open.
 */
export function TrackRow({
  track,
  active,
  isPlaying,
  showLastPlayed = false,
  onPlay,
  onPlayNext,
  onEnqueue,
  onToggleLike,
  onReveal,
}: TrackRowProps) {
  const cover = useCover(track.id, track.hasCover);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const items: MenuItem[] = [
    { id: "play", label: "Играть", icon: "play", onSelect: onPlay },
    { id: "next", label: "Играть следующим", icon: "next", onSelect: onPlayNext },
    { id: "queue", label: "В очередь", icon: "plus", onSelect: onEnqueue },
    {
      id: "like",
      label: track.isLiked ? "Убрать из Любимого" : "В Любимое",
      icon: track.isLiked ? "heart-filled" : "heart",
      onSelect: onToggleLike,
    },
  ];

  // A streamed track has no file on disk, so the entry is left out entirely
  // rather than shown greyed: an action that can never apply is noise.
  if (track.source === "local") {
    items.push({
      id: "reveal",
      label: "Показать в папке",
      icon: "folder",
      onSelect: onReveal,
    });
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onPlay}
        onContextMenu={(event) => {
          event.preventDefault();
          setAnchor({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPlay();
          }
        }}
        className={["queue-item group cursor-pointer", active ? "active" : ""].join(" ")}
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

        <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums text-ink-dim">
          {showLastPlayed && track.lastPlayed !== null && (
            <span className="opacity-70">{relativeTime(track.lastPlayed)}</span>
          )}
          <span>{formatTime(track.duration)}</span>
        </span>

        {/* Actions stay out of the way until the row is hovered — unless the
            track is already liked, in which case the heart is the state. */}
        <span
          className={[
            "flex shrink-0 items-center gap-0.5 transition-opacity duration-150",
            track.isLiked
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          ].join(" ")}
        >
          <button
            type="button"
            title={track.isLiked ? "Убрать из любимого" : "В любимое"}
            className={["icon-btn focus-arima h-7 w-7", track.isLiked ? "like is-active" : ""].join(
              " ",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onToggleLike();
            }}
          >
            <Icon name={track.isLiked ? "heart-filled" : "heart"} className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Добавить в очередь"
            className="icon-btn focus-arima h-7 w-7"
            onClick={(event) => {
              event.stopPropagation();
              onEnqueue();
            }}
          >
            <Icon name="plus" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Ещё"
            aria-haspopup="menu"
            className="icon-btn focus-arima h-7 w-7"
            onClick={(event) => {
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              setAnchor({ x: box.left, y: box.bottom + 4 });
            }}
          >
            <Icon name="more" className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {anchor && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={items}
          onClose={() => setAnchor(null)}
          width={218}
        />
      )}
    </>
  );
}
