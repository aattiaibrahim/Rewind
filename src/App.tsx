import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { api, errText } from "./api";
import { BufferCard } from "./BufferCard";
import { ConfirmDelete } from "./ConfirmDelete";
import { useClips, useSettings, useStatus, useUpdate } from "./hooks";
import { Library } from "./Library";
import { Performance } from "./Performance";
import logo from "./logo.svg";
import { SettingsView } from "./SettingsView";
import { Studio } from "./Studio";

type View = "clips" | "studio" | "performance" | "settings";
type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; sub?: string; err?: boolean; action?: ToastAction };
type PendingDelete = { paths: string[]; resolve: (deleted: boolean) => void };

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
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const toast = useCallback((text: string, err = false, sub?: string, action?: ToastAction) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, err, sub, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err || action ? 8000 : 4500);
  }, []);
  const dropToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

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

  const openInStudio = useCallback((path: string) => {
    setStudioPath(path);
    setView("studio");
  }, []);

  /** Ask first; resolves true if the clips were deleted. */
  const requestDelete = useCallback(
    (paths: string[]) => new Promise<boolean>((resolve) => setPendingDelete({ paths, resolve })),
    [],
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { paths, resolve } = pendingDelete;
    setDeleting(true);
    // Let go of a clip that's open in Studio, or Windows won't let it be moved.
    if (studioPath && paths.includes(studioPath)) {
      setStudioPath(null);
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const res = await api.deleteClips(paths);
      const n = res.deleted.length;
      if (n) {
        const restore = () =>
          api
            .restoreClips(res.deleted)
            .then((k) => toast(`Restored ${k} clip${k === 1 ? "" : "s"}`))
            .catch((e) => toast(errText(e), true));
        toast(`Moved ${n} clip${n === 1 ? "" : "s"} to the Recycle Bin`, false, undefined, { label: "Undo", run: restore });
      }
      if (res.failed.length) {
        const [path, why] = res.failed[0];
        toast(
          `Couldn't delete ${res.failed.length} clip${res.failed.length === 1 ? "" : "s"}`,
          true,
          `${path.split("\\").pop()}: ${why}`,
        );
      }
      refresh();
      resolve(n > 0);
    } catch (e) {
      toast(errText(e), true);
      resolve(false);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const cancelDelete = useCallback(() => {
    setPendingDelete((p) => {
      p?.resolve(false);
      return null;
    });
  }, []);

  useEffect(() => {
    const a = listen<string>("clip-saved", (e) =>
      toast("Clip saved", false, e.payload.split("\\").pop(), { label: "Trim", run: () => openInStudio(e.payload) }),
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
    ["performance", "Performance"],
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
            onDelete={requestDelete}
            hotkey={settings?.hotkey ?? "Alt+F10"}
          />
        )}
        {view === "studio" && (
          <Studio
            path={studioPath}
            clips={clips}
            onOpen={openInStudio}
            onDone={refresh}
            onDelete={requestDelete}
            settings={settings}
            update={update}
          />
        )}
        {view === "performance" && <Performance />}
        {view === "settings" && settings && (
          <SettingsView settings={settings} update={update} onError={(m) => toast(m, true)} />
        )}
      </main>
      {pendingDelete && (
        <ConfirmDelete paths={pendingDelete.paths} busy={deleting} onConfirm={confirmDelete} onCancel={cancelDelete} />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>
            <div className="toast-bar" />
            <div className="toast-body">
              <span>{t.text}</span>
              {t.sub && <small>{t.sub}</small>}
            </div>
            {t.action && (
              <button
                className="btn small"
                onClick={() => {
                  t.action!.run();
                  dropToast(t.id);
                }}
              >
                {t.action.label}
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
