import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { SearchBar } from "./components/SearchBar";
import { NowPlaying } from "./components/NowPlaying";
import { Queue } from "./components/Queue";
import { Transport } from "./components/Transport";
import { SettingsModal } from "./components/SettingsModal";
import { EqModal } from "./components/EqModal";
import { Visualizer } from "./components/Visualizer";
import { TrackList } from "./components/TrackList";
import { SearchResults } from "./components/SearchResults";
import { TitleBar } from "./components/TitleBar";
import { Toasts, type ToastItem } from "./components/Toasts";
import { usePlayer } from "./lib/usePlayer";
import { useAppearance } from "./lib/appearance";
import { useEq } from "./lib/eq";
import { CoverProvider } from "./lib/covers";
import type { Source } from "./lib/types";

/** The centre of the window either shows the player or a folder listing. */
type View = "player" | "browse";

function Shell() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const notify = useCallback((message: string, kind: "error" | "info" = "info") => {
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message, kind }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const player = usePlayer(notify);
  const appearance = useAppearance(notify);
  const eq = useEq(notify);

  const [view, setView] = useState<View>("player");
  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [queueOpen, setQueueOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eqOpen, setEqOpen] = useState(false);

  /* Ctrl/Cmd-K focuses search, as in the reference. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (view !== "browse") setView("browse");
        window.setTimeout(() => document.getElementById("searchInput")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view]);

  /* `?settings` / `?eq` / `?folder=` open a view on load — design review aids. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("settings")) setSettingsOpen(true);
    if (params.has("eq")) setEqOpen(true);
    const folder = params.get("folder");
    if (folder) {
      void player.selectFolder(folder as typeof player.folder);
      setView("browse");
    }
    // Intentionally one-shot: this is a deep link, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFolder = useCallback(
    (target: typeof player.folder) => {
      void player.selectFolder(target);
      setView("browse");
    },
    [player],
  );

  return (
    <>
      <div className={["bg", appearance.hasBackground ? "bg--image" : ""].join(" ")} />
      <div className="bg-veil" />

      {/* With no OS frame the title bar is the first row of the layout, so the
          panels below keep their own padding and nothing overlaps them. */}
      <div className="shell">
        <TitleBar />

        <div className="app">
          <div className={["workspace", queueOpen ? "" : "is-queue-collapsed"].join(" ")}>
            <Sidebar
              activeFolder={player.folder}
              onSelectFolder={openFolder}
              activeSource={activeSource}
              onSelectSource={(source) => {
                setActiveSource(source);
                openFolder("all");
              }}
              trackCount={player.total}
              busy={player.busy}
              onAddFolder={() => void player.addFolder()}
              onAddFiles={() => void player.addFiles()}
              onOpenSettings={() => setSettingsOpen(true)}
              onComingSoon={(label) => notify(`${label} — скоро`)}
            />

            <main className="main">
              <SearchBar
                value={player.searchQuery}
                onChange={player.setSearchQuery}
                onClear={player.clearSearch}
                busy={player.searching}
              />

              {/* A query takes over the centre of the window; `view` is left
                  alone, so clearing the field returns to exactly what was there
                  before — the player or the folder listing. */}
              {player.searchActive ? (
                <SearchResults
                  query={player.searchQuery}
                  tracks={player.results}
                  searching={player.searching}
                  currentId={player.current?.id ?? null}
                  isPlaying={player.isPlaying}
                  onClear={player.clearSearch}
                  onPlay={(index) => void player.playFromResults(index)}
                  onPlayNext={player.playNext}
                  onToggleLike={(track) => void player.toggleLike(track)}
                  onEnqueue={player.enqueue}
                  onReveal={(track) => void player.reveal(track)}
                />
              ) : view === "browse" ? (
                <TrackList
                  folder={player.folder}
                  tracks={player.tracks}
                  currentId={player.current?.id ?? null}
                  isPlaying={player.isPlaying}
                  busy={player.busy}
                  sort={player.sort}
                  descending={player.descending}
                  onSort={(sort) => void player.applySort(sort)}
                  onPlay={(index) => {
                    void player.playFromList(index);
                    setView("player");
                  }}
                  onPlayNext={player.playNext}
                  onToggleLike={(track) => void player.toggleLike(track)}
                  onEnqueue={player.enqueue}
                  onReveal={(track) => void player.reveal(track)}
                  onBack={() => setView("player")}
                  onAddFolder={() => void player.addFolder()}
                  onAddFiles={() => void player.addFiles()}
                />
              ) : (
                <NowPlaying
                  track={player.current}
                  isPlaying={player.isPlaying}
                  position={player.position}
                  duration={player.duration}
                  busy={player.busy}
                  onAddFolder={() => void player.addFolder()}
                  onAddFiles={() => void player.addFiles()}
                  onSeek={(value) => void player.seek(value)}
                  visualizer={
                    <Visualizer
                      enabled={appearance.settings.visualizer}
                      className="mt-1 h-16 w-full max-w-[560px]"
                    />
                  }
                />
              )}
            </main>

            <Queue
              queue={player.queue}
              currentIndex={player.currentIndex}
              isPlaying={player.isPlaying}
              open={queueOpen}
              onToggle={() => setQueueOpen((value) => !value)}
              onPick={(index) => void player.playQueueIndex(index)}
            />
          </div>

          <Transport
            isPlaying={player.isPlaying}
            position={player.position}
            duration={player.duration}
            volume={player.volume}
            liked={player.liked}
            onDispatch={(action) => void player.dispatch(action)}
            onSeek={(value) => void player.seek(value)}
            onVolume={(value) => void player.setVolume(value)}
            onToggleLike={player.toggleLikeCurrent}
            onOpenEq={() => setEqOpen(true)}
          />
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={appearance.settings}
        onUpdate={appearance.update}
        hasBackground={appearance.hasBackground}
        busy={appearance.busy}
        onChooseBackground={() => void appearance.chooseBackground()}
        onResetBackground={() => void appearance.clearBackground()}
        eq={eq.eq}
        onEqEnabled={eq.toggleEnabled}
        onLimiter={eq.toggleLimiter}
      />

      <EqModal
        open={eqOpen}
        onClose={() => setEqOpen(false)}
        eq={eq.eq}
        presetId={eq.presetId}
        onBand={eq.setBand}
        onPreset={eq.applyPreset}
        onToggleEnabled={eq.toggleEnabled}
        onToggleLimiter={eq.toggleLimiter}
        onReset={eq.reset}
      />

      <Toasts items={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default function App() {
  return (
    <CoverProvider>
      <Shell />
    </CoverProvider>
  );
}
