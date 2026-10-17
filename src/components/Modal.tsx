import { useEffect, type ReactNode } from "react";
import { Icon } from "./Icon";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Reference sizes: settings 600×500, EQ 480 wide. */
  width?: number;
  height?: number;
  children: ReactNode;
}

export function Modal({ open, onClose, title, width = 520, height, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <div
      className={["modal-backdrop", open ? "open" : ""].join(" ")}
      onClick={(event) => {
        // Only a click on the backdrop itself dismisses.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal glass"
        style={{ width, height }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn focus-arima" onClick={onClose} title="Закрыть">
            <Icon name="x" className="h-[18px] w-[18px]" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-[18px]">
          {children}
        </div>
      </div>
    </div>
  );
}
