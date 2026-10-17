import { Icon } from "./Icon";
import { Slider } from "./Slider";
import { formatTime, type ShortcutAction } from "../lib/types";

interface TransportProps {
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  liked: boolean;
  onDispatch: (action: ShortcutAction) => void;
  onSeek: (position: number) => void;
  onVolume: (volume: number) => void;
  onToggleLike: () => void;
  onOpenEq: () => void;
}

export function Transport({
  isPlaying,
  position,
  duration,
  volume,
  liked,
  onDispatch,
  onSeek,
  onVolume,
  onToggleLike,
  onOpenEq,
}: TransportProps) {
  const muted = volume === 0;

  return (
    <footer className="transport glass">
      <div className="flex items-center gap-2.5 font-mono text-[10px] tabular-nums text-ink-dim">
        <span>{formatTime(position)}</span>
        <Slider
          value={position}
          max={duration || 1}
          onChange={onSeek}
          ariaLabel="Позиция"
          className="min-w-0 flex-1"
        />
        <span>{formatTime(duration)}</span>
      </div>

      <div className="flex h-12 items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3">
          <button
            type="button"
            className={["icon-btn like focus-arima", liked ? "is-active" : ""].join(" ")}
            onClick={onToggleLike}
            title="В любимое"
          >
            <Icon name={liked ? "heart-filled" : "heart"} className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="ctrl focus-arima"
            onClick={() => onDispatch("prev")}
            title="Предыдущий"
          >
            <Icon name="prev" className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            className="ctrl ctrl--play focus-arima"
            onClick={() => onDispatch("play_pause")}
            title={isPlaying ? "Пауза" : "Играть"}
          >
            <Icon name={isPlaying ? "pause" : "play"} className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="ctrl focus-arima"
            onClick={() => onDispatch("next")}
            title="Следующий"
          >
            <Icon name="next" className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            className="ctrl focus-arima"
            onClick={() => onDispatch("stop")}
            title="Стоп"
          >
            <Icon name="stop" className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex flex-1 items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="focus-arima text-ink-dim transition-colors duration-150 hover:text-ink"
              onClick={() => onDispatch("mute")}
              title="Без звука"
            >
              <Icon
                name={muted ? "volume-mute" : "volume"}
                className="h-4 w-4"
              />
            </button>
            <Slider
              value={volume}
              max={2}
              onChange={onVolume}
              ariaLabel="Громкость"
              className="w-[110px]"
              midTick
            />
            <span className="vol-val">{Math.round(volume * 100)}%</span>
          </div>
          <button
            type="button"
            className="icon-btn focus-arima"
            onClick={onOpenEq}
            title="Эквалайзер"
          >
            <Icon name="sliders" className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
    </footer>
  );
}
