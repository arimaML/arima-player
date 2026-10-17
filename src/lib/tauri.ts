/**
 * Thin, failure-tolerant bridge to the Tauri host.
 *
 * Every call degrades to a no-op when the UI is opened in a plain browser
 * (`npm run dev` without the Tauri shell), so the frontend stays developable
 * and testable on its own.
 */
import type { ShortcutAction } from "./types";

/** True only inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Subscribe to playback commands originating in Rust (tray menu, global
 * media keys). Returns an unsubscribe function.
 */
export async function onShortcut(
  handler: (action: ShortcutAction) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("shortcut", (event) => {
    handler(event.payload as ShortcutAction);
  });
}

