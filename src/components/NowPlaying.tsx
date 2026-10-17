import { Slider } from "./Slider";
import { useCover } from "../lib/covers";
import { SOURCE_LABEL, formatTime, type Track } from "../lib/types";
import type { ReactNode } from "react";

interface NowPlayingProps {
  track?: Track;
  isPlaying: boolean;
  position: number;
  duration: number;
  busy?: boolean;
  onAddFolder: () => void;
  onAddFiles: () => void;
  onSeek: (position: number) => void;
  /** Spectrum canvas, supplied by the parent so this component stays dumb. */
  visualizer?: ReactNode;
}

/** Ring geometry from the reference: r=154 inside a 320×320 stage. */
const ARC_RADIUS = 154;
const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS;

const DEFAULT_COVER = "radial-gradient(circle at 38% 32%, #e63946 0%, #7a1418 46%, #0b0b0d 100%)";

export function NowPlaying({
  track,
  isPlaying,
  position,
  duration,
  busy = false,
  onAddFolder,
  onAddFiles,
  onSeek,
  visualizer,
}: NowPlayingProps) {
  const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
  // Artwork is fetched per track and cached, not carried in the folder listing.
  const cover = useCover(track?.id, track?.hasCover ?? false);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5">
      <div className="disc-stage">
        <svg className="disc-ring" viewBox="0 0 320 320" aria-hidden="true">
          <circle className="ring-track" cx="160" cy="160" r={ARC_RADIUS} />
          <circle
            className="ring-arc"
            cx="160"
            cy="160"
            r={ARC_RADIUS}
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={ARC_LENGTH * (1 - ratio)}
          />
        </svg>

        <div className={["disc", isPlaying ? "is-playing" : ""].join(" ")}>
          {cover ? (
            <img
              src={cover}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          ) : (
            <div className="disc-cover" style={{ background: DEFAULT_COVER }} />
          )}
        </div>
      </div>

      <h1 className="track-title">{track?.title ?? "Ничего не играет"}</h1>
      <div className="text-center text-[14px] text-ink-dim">
        {track?.artist ?? "Добавь папку с музыкой или перетащи файлы в окно"}
      </div>

      {track ? (
        <div className="source-badge">{SOURCE_LABEL[track.source]}</div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="btn focus-arima" onClick={onAddFolder} disabled={busy}>
            {busy ? "Сканирую…" : "Добавить папку"}
          </button>
          <button type="button" className="btn focus-arima" onClick={onAddFiles} disabled={busy}>
            Добавить файлы
          </button>
        </div>
      )}

      {/* Slot for the spectrum canvas; the component itself is owned by App. */}
      {visualizer}

      <div className="mt-2.5 flex w-full max-w-[560px] flex-col gap-1">
        <Slider value={position} max={duration || 1} onChange={onSeek} ariaLabel="Позиция" />
        <div className="flex justify-between font-mono text-[11px] tabular-nums text-ink-dim">
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
