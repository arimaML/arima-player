import logo from "../assets/logo.png";
import { Icon, type IconName } from "./Icon";
import { SOURCE_LABEL, type Source } from "../lib/types";

export type FolderId = "liked" | "frequent" | "recent" | "all";

const FOLDERS: { id: FolderId; label: string; icon: IconName }[] = [
  { id: "liked", label: "Любимое", icon: "heart" },
  { id: "frequent", label: "Часто слушаю", icon: "refresh" },
  { id: "recent", label: "Недавние", icon: "clock" },
  { id: "all", label: "Все треки", icon: "music" },
];

/**
 * Streaming sources are frozen for now: `hint === null` means "planned, not
 * built". Those rows stay visible and keep their normal colour — they carry a
 * «Скоро» badge and lose the pointer instead of looking like broken buttons.
 */
const SOURCES: { id: Source; icon: IconName; hint: string | null }[] = [
  { id: "local", icon: "monitor", hint: "mp3 · flac · opus · wav · m4a · aac" },
  { id: "youtube", icon: "youtube", hint: null },
  { id: "soundcloud", icon: "cloud", hint: null },
];

interface SidebarProps {
  activeFolder: FolderId;
  onSelectFolder: (id: FolderId) => void;
  activeSource: Source | null;
  onSelectSource: (id: Source) => void;
  trackCount: number;
  busy: boolean;
  onAddFolder: () => void;
  onAddFiles: () => void;
  onOpenSettings: () => void;
  /** Fired when a not-yet-built source is clicked; the row stays clickable so
   *  the app can explain itself rather than swallow the click. */
  onComingSoon: (label: string) => void;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="group-title">{title}</div>
      {children}
    </div>
  );
}

export function Sidebar({
  activeFolder,
  onSelectFolder,
  activeSource,
  onSelectSource,
  trackCount,
  busy,
  onAddFolder,
  onAddFiles,
  onOpenSettings,
  onComingSoon,
}: SidebarProps) {
  return (
    <aside className="glass flex min-h-0 flex-col px-3 py-3.5">
      <div className="flex items-center gap-2.5 px-2 pb-3.5 pt-0.5">
        {/* The same artwork the exe and the tray carry, so the app never shows
            two different marks. 128 px file in a 48 px box: crisp on 2x. */}
        <img src={logo} alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
        <div className="brand-name">Arima</div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <Group title="Библиотека">
          <button type="button" className="nav-item focus-arima" onClick={onAddFolder} disabled={busy}>
            <Icon name="folder" className="h-4 w-4" />
            <span>{busy ? "Сканирую…" : "Добавить папку"}</span>
          </button>
          <button type="button" className="nav-item focus-arima" onClick={onAddFiles} disabled={busy}>
            <Icon name="file-plus" className="h-4 w-4" />
            <span>Добавить файлы</span>
          </button>
        </Group>

        <Group title="Папки">
          {FOLDERS.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className={["nav-item focus-arima", activeFolder === folder.id ? "active" : ""].join(" ")}
              onClick={() => onSelectFolder(folder.id)}
            >
              <Icon name={folder.icon} className="h-4 w-4" />
              {folder.id === "all" ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{folder.label}</span>
                  <span className="nav-meta">{trackCount} треков</span>
                </span>
              ) : (
                <span>{folder.label}</span>
              )}
            </button>
          ))}
        </Group>

        <Group title="Источники">
          {SOURCES.map((source) => {
            const ready = source.hint !== null;
            return (
              <button
                key={source.id}
                type="button"
                className={[
                  "nav-item focus-arima",
                  ready ? "" : "nav-item--soon",
                  ready && activeSource === source.id ? "active" : "",
                ].join(" ")}
                // `aria-disabled`, not `disabled`: the row must stay focusable
                // and clickable so the click can be answered with a toast.
                aria-disabled={!ready}
                onClick={() =>
                  ready ? onSelectSource(source.id) : onComingSoon(SOURCE_LABEL[source.id])
                }
              >
                <Icon name={source.icon} className="h-4 w-4" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{SOURCE_LABEL[source.id]}</span>
                    {!ready && <span className="soon-badge">Скоро</span>}
                  </span>
                  {ready && <span className="nav-meta">{source.hint}</span>}
                </span>
              </button>
            );
          })}
        </Group>
      </div>

      <div className="mt-2 border-t border-line pt-2">
        <button type="button" className="nav-item focus-arima" onClick={onOpenSettings}>
          <Icon name="settings" className="h-4 w-4" />
          <span>Настройки</span>
        </button>
      </div>
    </aside>
  );
}
