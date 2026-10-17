import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { VerticalSlider } from "./VerticalSlider";
import { CUSTOM_PRESET } from "../lib/eq";
import type { EqState } from "../lib/engine";

interface EqModalProps {
  open: boolean;
  onClose: () => void;
  eq: EqState | null;
  presetId: string;
  onBand: (index: number, gainDb: number) => void;
  onPreset: (id: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleLimiter: (enabled: boolean) => void;
  onReset: () => void;
}

/** Half-decibel steps: finer than anyone can hear, coarse enough to be stable. */
function quantise(value: number): number {
  return Math.round(value * 2) / 2;
}

function formatDb(value: number): string {
  const settled = Math.abs(value) < 0.05 ? 0 : value;
  return `${settled > 0 ? "+" : ""}${settled.toFixed(1)}`;
}

function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch" title={label}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

/** Ten-band peaking EQ, driven entirely by the Rust DSP chain. */
export function EqModal({
  open,
  onClose,
  eq,
  presetId,
  onBand,
  onPreset,
  onToggleEnabled,
  onToggleLimiter,
  onReset,
}: EqModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Эквалайзер" width={580}>
      {!eq ? (
        <p className="text-[12px] text-ink-dim">Читаю состояние движка…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-[13px]">
              <Toggle checked={eq.enabled} onChange={onToggleEnabled} label="EQ включён" />
              <span className={eq.enabled ? "text-ink" : "text-ink-dim"}>
                {eq.enabled ? "EQ включён" : "EQ выключен (bypass)"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="select-wrap">
                <select
                  className="select"
                  value={presetId}
                  onChange={(event) => onPreset(event.target.value)}
                  aria-label="Пресет эквалайзера"
                >
                  {eq.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                  <option value={CUSTOM_PRESET}>Custom</option>
                </select>
                <Icon name="chevron-down" className="h-3.5 w-3.5" />
              </div>
              <button type="button" className="btn focus-arima" onClick={onReset}>
                Reset
              </button>
            </div>
          </div>

          {/* Bypassed bands stay visible but stop responding, so the panel
              still shows what will come back. */}
          <div
            className={[
              "flex items-end justify-between gap-1.5 transition-opacity duration-250",
              eq.enabled ? "opacity-100" : "pointer-events-none opacity-40",
            ].join(" ")}
          >
            {eq.frequencies.map((hz, index) => (
              <div key={hz} className="flex flex-col items-center gap-2">
                <span className="font-mono text-[10px] tabular-nums text-ink-dim">
                  {formatDb(eq.bands[index] ?? 0)}
                </span>
                <VerticalSlider
                  value={eq.bands[index] ?? 0}
                  min={-eq.gainLimitDb}
                  max={eq.gainLimitDb}
                  onChange={(value) => onBand(index, quantise(value))}
                  onCommit={(value) => onBand(index, quantise(value))}
                  bipolar
                  height={150}
                  ariaLabel={`${hz} Гц`}
                />
                <span className="font-mono text-[10px] text-ink-dim">{bandLabel(hz)}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 text-[13px]">
            <div>
              <div>Лимитер</div>
              <div className="mt-0.5 text-[11px] text-ink-dim">
                Порог −1 дБFS, release 50 мс. Держит 200 % без хрипа.
              </div>
            </div>
            <Toggle checked={eq.limiterEnabled} onChange={onToggleLimiter} label="Лимитер" />
          </div>
        </>
      )}
    </Modal>
  );
}
