import { useCallback, useEffect, useState } from "react";

interface VerticalSliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  ariaLabel: string;
  /** Fill grows out of the middle instead of the bottom (EQ bands). */
  bipolar?: boolean;
  height?: number;
}

/**
 * Vertical fader for the EQ.
 *
 * Same interaction contract as the horizontal `Slider` — window-level pointer
 * tracking so the gesture survives leaving the narrow track — but the axis is
 * inverted (up is louder) and a bipolar band fills from the 0 dB centre.
 */
export function VerticalSlider({
  value,
  min,
  max,
  onChange,
  onCommit,
  ariaLabel,
  bipolar = false,
  height = 150,
}: VerticalSliderProps) {
  const [dragging, setDragging] = useState(false);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  const span = max - min || 1;
  const ratio = Math.min(1, Math.max(0, (value - min) / span));

  const valueAt = useCallback(
    (clientY: number) => {
      if (!element) return value;
      const rect = element.getBoundingClientRect();
      // Top of the track is the maximum.
      const fraction = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      return min + fraction * span;
    },
    [element, min, span, value],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => onChange(valueAt(event.clientY));
    const onUp = (event: PointerEvent) => {
      setDragging(false);
      onCommit?.(valueAt(event.clientY));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, onChange, onCommit, valueAt]);

  // Fill geometry. For a bipolar band the fill starts at the centre line.
  const centre = bipolar ? (0 - min) / span : 0;
  const low = Math.min(ratio, centre);
  const high = Math.max(ratio, centre);

  return (
    <div
      ref={setElement}
      className={["vbar", dragging ? "is-dragging" : ""].join(" ")}
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(1))}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
        onChange(valueAt(event.clientY));
      }}
    >
      <div className="vbar-track" />
      {bipolar && <span className="vbar-centre" />}
      <div
        className="vbar-fill"
        style={{ bottom: `${low * 100}%`, height: `${(high - low) * 100}%` }}
      />
      <div className="vbar-thumb" style={{ bottom: `${ratio * 100}%` }} />
    </div>
  );
}
