import { useCallback, useEffect, useState } from "react";

interface SliderProps {
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
  /** Fired once on release — avoids flooding the audio engine while dragging. */
  onCommit?: (value: number) => void;
  ariaLabel: string;
  className?: string;
  /** Draw the 100 % tick; the volume bar runs 0–200 %. */
  midTick?: boolean;
}

/**
 * The reference's `.bar` control: a hairline track that thickens on hover with
 * a thumb that scales in. Deliberately not `<input type="range">` — the
 * reference draws its own, and native range inputs cannot be styled to match
 * consistently across WebView2.
 */
export function Slider({
  value,
  min = 0,
  max,
  onChange,
  onCommit,
  ariaLabel,
  className = "",
  midTick = false,
}: SliderProps) {
  const [dragging, setDragging] = useState(false);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  const span = max - min || 1;
  const ratio = Math.min(1, Math.max(0, (value - min) / span));

  const valueAt = useCallback(
    (clientX: number) => {
      if (!element) return value;
      const rect = element.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return min + fraction * span;
    },
    [element, min, span, value],
  );

  /* While dragging, listen on the window so the gesture survives the pointer
     leaving the (only 14px tall) track. */
  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => onChange(valueAt(event.clientX));
    const onUp = (event: PointerEvent) => {
      setDragging(false);
      onCommit?.(valueAt(event.clientX));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, onChange, onCommit, valueAt]);

  return (
    <div
      ref={setElement}
      className={["bar", dragging ? "is-dragging" : "", className].join(" ")}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
        onChange(valueAt(event.clientX));
      }}
    >
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${ratio * 100}%` }}>
          <div className="bar-thumb" />
        </div>
        {midTick && <span className="vol-tick" />}
      </div>
    </div>
  );
}
