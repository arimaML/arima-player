import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { Slider } from "./Slider";
import type { AppSettings } from "../lib/appearance";
import type { EqState } from "../lib/engine";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  hasBackground: boolean;
  busy: boolean;
  onChooseBackground: () => void;
  onResetBackground: () => void;
  eq: EqState | null;
  onEqEnabled: (enabled: boolean) => void;
  onLimiter: (enabled: boolean) => void;
}

export function SettingsModal({
  open,
  onClose,
  settings,
  onUpdate,
  hasBackground,
  busy,
  onChooseBackground,
  onResetBackground,
  eq,
  onEqEnabled,
  onLimiter,
}: SettingsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Настройки" width={600} height={500}>
      <section className="settings-section">
        <h3>Внешний вид</h3>

        <div className="field">
          <div className="field-head">
            <span>Прозрачность стекла</span>
            <span className="field-val">{settings.glassOpacity}%</span>
          </div>
          <Slider
            value={settings.glassOpacity}
            min={40}
            max={90}
            onChange={(value) => onUpdate("glassOpacity", Math.round(value))}
            ariaLabel="Прозрачность стекла"
          />
        </div>

        <div className="field">
          <div className="field-head">
            <span>Размытие фона</span>
            <span className="field-val">{settings.glassBlur} px</span>
          </div>
          <Slider
            value={settings.glassBlur}
            min={0}
            max={40}
            onChange={(value) => onUpdate("glassBlur", Math.round(value))}
            ariaLabel="Размытие фона"
          />
        </div>

        <div className="field field-row">
          <span>Материал окна (mica / acrylic)</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.vibrancy}
              onChange={(event) => onUpdate("vibrancy", event.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>

        <div className="field">
          <div className="field-head">
            <span>Непрозрачность окна</span>
            <span className="field-val">{settings.windowOpacity}%</span>
          </div>
          <Slider
            value={settings.windowOpacity}
            min={40}
            max={100}
            onChange={(value) => onUpdate("windowOpacity", Math.round(value))}
            ariaLabel="Непрозрачность окна"
          />
          <p className="text-[11px] leading-relaxed text-ink-dim">
            Ниже 100 % рабочего стола видно сквозь окно — работает вместе с материалом окна.
          </p>
        </div>

        <div className="field">
          <div className="field-head">
            <span>Фон</span>
            <span className="field-val">{hasBackground ? "свой" : "градиент"}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn focus-arima" onClick={onChooseBackground} disabled={busy}>
              <span className="flex items-center gap-2">
                <Icon name="image" className="h-4 w-4" />
                {busy ? "Обрабатываю…" : "Сменить фон…"}
              </span>
            </button>
            <button
              type="button"
              className="btn btn--danger focus-arima"
              onClick={onResetBackground}
              disabled={busy || !hasBackground}
            >
              Сбросить фон
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-dim">
            Картинка проверяется, уменьшается до 2560 px по большей стороне и сохраняется
            как JPEG в папке приложения.
          </p>
        </div>
      </section>

      <section className="settings-section">
        <h3>Эквалайзер и визуализация</h3>

        <div className="field field-row">
          <span>EQ включён</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={eq?.enabled ?? false}
              disabled={!eq}
              onChange={(event) => onEqEnabled(event.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>

        <div className="field field-row">
          <span>Лимитер</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={eq?.limiterEnabled ?? false}
              disabled={!eq}
              onChange={(event) => onLimiter(event.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>

        <div className="field field-row">
          <span>Визуализация</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.visualizer}
              onChange={(event) => onUpdate("visualizer", event.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>Звук</h3>

        <div className="field field-row">
          <span>Громкость выше 100 %</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.volumeBoost}
              onChange={(event) => onUpdate("volumeBoost", event.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>

        <div className="field field-row">
          <span>Качество стриминга</span>
          <div className="select-wrap">
            <select
              className="select"
              value={settings.streamQuality}
              onChange={(event) =>
                onUpdate("streamQuality", event.target.value as AppSettings["streamQuality"])
              }
            >
              <option>Low</option>
              <option>Normal</option>
              <option>High</option>
              <option>Best</option>
            </select>
            <Icon name="chevron-down" className="h-3.5 w-3.5" />
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-dim">
          Ползунок громкости уже работает до 200 %. Ограничитель появится вместе с
          эквалайзером на этапе 2.
        </p>
      </section>
    </Modal>
  );
}
