import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { isTauri } from "../lib/tauri";

/**
 * The window's own title bar.
 *
 * The OS frame is disabled (`decorations: false`), so this strip is the only
 * place left to drag the window by and the only place with window controls.
 * It sits in normal flow above the panels rather than floating over them: no
 * fixed positioning means it cannot end up on top of a modal or a toast.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  /* Keep the middle button honest: it shows "restore" only while the window is
     actually maximized. The browser has no window to ask, so this stays off. */
  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let off: (() => void) | undefined;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const window_ = getCurrentWindow();
      const sync = async () => setMaximized(await window_.isMaximized());

      await sync();
      const unlisten = await window_.onResized(() => void sync());
      if (disposed) unlisten();
      else off = unlisten;
    })();

    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const control = async (action: "minimize" | "toggle" | "close") => {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window_ = getCurrentWindow();
    if (action === "minimize") await window_.minimize();
    else if (action === "toggle") await window_.toggleMaximize();
    else await window_.close();
  };

  return (
    /* `deep` is the attribute value that matters here. A bare
       `data-tauri-drag-region` only fires when the click lands on that exact
       element (`el === composedPath[0]`), so a bar made of several children
       would leave gaps that do nothing. `deep` makes the whole subtree a drag
       region — and the buttons still opt out, because Tauri's hit test stops at
       any clickable element (button, input, a, label, [tabindex]…) that does
       not carry the attribute itself. */
    <header className="titlebar" data-tauri-drag-region="deep">
      <span className="titlebar-label">Arima Player</span>

      {/* Double click to maximize is not handled here: Tauri's own drag script
          turns a `detail === 2` mousedown inside a drag region into
          `internal_toggle_maximize`. Adding an onDoubleClick on top of it would
          toggle twice and the window would not move at all. */}

      <div className="titlebar-spacer" />

      <div className="titlebar-buttons">
        <button
          type="button"
          className="titlebar-btn focus-arima"
          title="Свернуть"
          aria-label="Свернуть"
          onClick={() => void control("minimize")}
        >
          <Icon name="minimize" className="h-3.5 w-3.5" strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="titlebar-btn focus-arima"
          title={maximized ? "Восстановить" : "Развернуть"}
          aria-label={maximized ? "Восстановить" : "Развернуть"}
          onClick={() => void control("toggle")}
        >
          <Icon
            name={maximized ? "restore" : "maximize"}
            className="h-3.5 w-3.5"
            strokeWidth={1.6}
          />
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn--close focus-arima"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={() => void control("close")}
        >
          <Icon name="x" className="h-3.5 w-3.5" strokeWidth={1.6} />
        </button>
      </div>
    </header>
  );
}
