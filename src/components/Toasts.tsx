import { useEffect } from "react";
import { Icon } from "./Icon";

export interface ToastItem {
  id: number;
  message: string;
  kind: "error" | "info";
}

const LIFETIME_MS = 3200;

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [item.id, onDismiss]);

  return (
    <div className={["toast animate-rise", item.kind === "info" ? "toast--info" : ""].join(" ")}>
      <Icon name={item.kind === "error" ? "alert" : "image"} className="h-4 w-4 shrink-0" />
      <span>{item.message}</span>
    </div>
  );
}

export function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-[104px] left-1/2 z-[300] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((item) => (
        <Toast key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
