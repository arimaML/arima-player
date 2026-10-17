import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

/** One row of a floating glass menu. */
export interface MenuItem {
  id: string;
  label: string;
  /** Omitted by choosers such as the sort dropdown, which only show a check. */
  icon?: IconName;
  /** Draws the check mark in place of the icon. */
  checked?: boolean;
  /** Muted and inert — the action exists but does not apply here. */
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** Where the menu was summoned from, in viewport coordinates. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Sort dropdowns keep the check column; context menus do not need it. */
  width?: number;
}

/** Keep this much air between the menu and the window edge. */
const MARGIN = 8;

/**
 * A floating glass menu, shared by the track context menu and the sort
 * dropdown so both position, dismiss and look the same.
 *
 * It is portalled to `document.body` on purpose: `position: fixed` is relative
 * to the nearest ancestor with a `backdrop-filter` or `transform`, and the
 * glass panels have both — inside them the menu would be clipped and would
 * scroll with the pane it belongs to.
 */
export function ContextMenu({ x, y, items, onClose, width }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  /* Measure, then keep the whole menu inside the window: slide it left when it
     would overflow the side, and open upwards when it would fall off the
     bottom — which is what makes a right click on the last visible row work. */
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const { width: menuWidth, height: menuHeight } = element.getBoundingClientRect();
    const left = Math.min(Math.max(MARGIN, x), window.innerWidth - menuWidth - MARGIN);
    const fitsBelow = y + menuHeight + MARGIN <= window.innerHeight;
    const top = fitsBelow ? y : Math.max(MARGIN, y - menuHeight);

    setPosition({ left, top });
  }, [x, y, items, width]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Scrolling moves the row out from under the menu, so dismiss instead of
    // leaving it floating over unrelated content.
    const onScroll = () => onClose();

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="menu glass animate-rise"
      style={{ left: position.left, top: position.top, width }}
      role="menu"
      // A right click inside the menu must not close it and immediately reopen
      // the browser's own menu.
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={["menu-item focus-arima", item.checked ? "is-checked" : ""].join(" ")}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.checked ? (
            <Icon name="check" className="h-4 w-4 shrink-0 text-accent" />
          ) : item.icon ? (
            <Icon name={item.icon} className="h-4 w-4 shrink-0" />
          ) : (
            // Keeps the labels of a chooser aligned under one another.
            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
