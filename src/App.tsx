import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { api } from "./api";
import logo from "./logo.svg";
import { BufferCard } from "./BufferCard";
import { useClips, useSettings, useStatus, useUpdate } from "./hooks";
import { errText } from "./api";
import { Library } from "./Library";
import { SettingsView } from "./SettingsView";
import { Studio } from "./Studio";

type View = "clips" | "studio" | "settings";
type Toast = { id: number; text: string; sub?: string; err?: boolean; path?: string };

export default function App() {
  const [view, setView] = useState<View>("clips");
  const [studioPath, setStudioPath] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const status = useStatus();
  const [settings, update] = useSettings();
  const [clips, refresh] = useClips();
  const upd = useUpdate();
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showBanner =
    upd && (upd.stage === "ready" || upd.stage === "available") && upd.version && dismissed !== upd.version;
  const installNow = async () => {
    if (status?.recording && !confirm("A recording is running. Rewind will save it, then restart to update. Continue?")) return;
    setInstalling(true);
    try {
      await api.installUpdate();
    } catch (e) {
      toast(errText(e), true);
      setInstalling(false);
    }
  };

  const toast = useCallback((text: string, err = false, sub?: string, path?: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, err, sub, path }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 8000 : 4500);
  }, []);

  const openInStudio = useCallback((path: string) => {
    setStudioPath(path);
    setView("studio");
  }, []);

  useEffect(() => {
    const a = listen<string>("clip-saved", (e) =>
      toast("Clip saved", false, e.payload.split("\\").pop(), e.payload),
    );
    const b = listen<string>("clip-error", (e) => toast(e.payload, true));
    const c = listen<string>("open-in-studio", (e) => openInStudio(e.payload));
    return () => {
      [a, b, c].forEach((p) => p.then((f) => f()));
    };
  }, [toast, openInStudio]);

  const nav: [View, string][] = [
    ["clips", "Clips"],
    ["studio", "Studio"],
    ["settings", "Settings"],
  ];

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <img src={logo} alt="" width={26} height={26} />
          REWIND
        </div>
        {nav.map(([id, label]) => (
          <button key={id} className={`nav-item ${view === id ? "on" : ""}`} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
        <div className="nav-spacer" />
        <BufferCard status={status} hotkey={settings?.hotkey ?? "Alt+F10"} recordHotkey={settings?.recordHotkey ?? "Alt+F9"} />
      </nav>
      <main className="main">
        {showBanner && (
          <div className="update-banner" role="status">
            <span>
              <strong>Rewind {upd!.version}</strong>{" "}
              {upd!.stage === "ready" ? "is downloaded and ready." : "is available."}{" "}
              {upd!.stage === "ready" && (
                <span className="muted">It also installs by itself the next time Rewind closes.</span>
              )}
            </span>
            <span className="row">
              <button className="btn small" onClick={() => setDismissed(upd!.version)}>
                Later
              </button>
              <button className="btn small primary" disabled={installing} onClick={installNow}>
                {installing ? "Updating…" : "Restart to update"}
              </button>
            </span>
          </div>
        )}
        {view === "clips" && (
          <Library
            clips={clips}
            onOpen={openInStudio}
            onToast={(t, e) => toast(t, e)}
            onChanged={refresh}
            hotkey={settings?.hotkey ?? "Alt+F10"}
          />
        )}
        {view === "studio" && (
          <Studio
            path={studioPath}
            clips={clips}
            onOpen={openInStudio}
            onDone={refresh}
            settings={settings}
            update={update}
          />
        )}
        {view === "settings" && settings && (
          <SettingsView settings={settings} update={update} onError={(m) => toast(m, true)} />
        )}
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>
            <div className="toast-bar" />
            <div className="toast-body">
              <span>{t.text}</span>
              {t.sub && <small>{t.sub}</small>}
            </div>
            {t.path && (
              <button className="btn small" onClick={() => openInStudio(t.path!)}>
                Trim
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Make the flyout close itself on Escape.
export function useEscapeToHide() {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && api.hideFlyout();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
}
