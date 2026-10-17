import { Icon } from "./Icon";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  /** A query is in flight. */
  busy: boolean;
}

/**
 * The query box.
 *
 * It deliberately has no dropdown of its own any more: typing switches the
 * centre of the window to the results list, so the answers are shown in the
 * same place and the same shape as a folder.
 */
export function SearchBar({ value, onChange, onClear, busy }: SearchBarProps) {
  return (
    <div className="relative z-20">
      <div className="search glass">
        <Icon
          name="search"
          className={["h-4 w-4 transition-colors duration-200", busy ? "text-accent" : "text-ink-dim"].join(
            " ",
          )}
        />
        <input
          id="searchInput"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault();
              onClear();
            }
          }}
          placeholder="Поиск по всей библиотеке…"
          autoComplete="off"
          spellCheck={false}
        />
        {value ? (
          <button
            type="button"
            className="icon-btn focus-arima h-6 w-6"
            onClick={onClear}
            title="Очистить поиск"
          >
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="kbd">CTRL K</span>
        )}
      </div>
    </div>
  );
}
