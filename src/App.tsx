import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ShareConfirm, ShareRequest, useUploads } from "./Share";
import { useHealth } from "./Health";
import type { UploadProgress } from "./api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { api, errText } from "./api";
import { BufferCard } from "./BufferCard";
import { Cleanup } from "./Cleanup";
import { ConfirmDelete } from "./ConfirmDelete";
import { ConfirmUpdate, updateInterrupts } from "./ConfirmUpdate";
import { MergeDialog, spellings, useSimilarFolders } from "./FolderMerge";
import { Notice, Notifications } from "./Notifications";
import { useNasState } from "./NasProgress";
import type { MoveOutcome } from "./api";
import { useAppearance, useClips, useSettings, useStatus, useUpdate } from "./hooks";
import { Library } from "./Library";
import { Performance } from "./Performance";
import logo from "./logo.svg";
import { SettingsView } from "./SettingsView";
import { Studio } from "./Studio";
import { SlidingPill } from "./SlidingPill";
import { MontageView } from "./Montage";

type View = "clips" | "local" | "synced" | "damaged" | "cleanup" | "montage" | "studio" | "performance" | "settings";
/** The clip lists (Studio goes back to whichever you came from). */
type ListView = "clips" | "local" | "synced" | "damaged";
const isList = (v: View): v is ListView => v === "clips" || v === "local" || v === "synced" || v === "damaged";
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
  useAppearance(settings);
  const [clips, refresh] = useClips();
  const uploads = useUploads();
  const health = useHealth(clips);
  const [shareReq, setShareReq] = useState<ShareRequest | null>(null);
  const upd = useUpdate();
  const [installing, setInstalling] = useState(false);
  // Hiding an update notice is remembered by the notification center.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const toast = useCallback((text: string, err = false, sub?: string, action?: ToastAction) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, err, sub, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err || action ? 8000 : 4500);
  }, []);
  const dropToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  // Same game under different folder names (this PC vs the NAS): a notice once,
  // a banner until it's dealt with, and the merge dialog.
  const [similar] = useSimilarFolders();
  const [mergeOpen, setMergeOpen] = useState(false);
  const onMerged = useCallback(
    (target: string, out: MoveOutcome) => {
      if (out.failed.length) {
        const [file, why] = out.failed[0];
        toast(`${out.failed.length} file${out.failed.length === 1 ? "" : "s"} couldn't be moved into “${target}”`, true, `${file.split("\\").pop()}: ${why}`);
      } else {
        const undo = () =>
          api
            .undoLastMove()
            .then(() => toast("Put the folders back as they were"))
            .catch((e) => toast(errText(e), true));
        toast(`Merged into “${target}”`, false, "On this PC and the NAS. New clips go there too.", { label: "Undo", run: undo });
      }
    },
    [toast],
  );
  // Share: ask first (unless turned off in Settings → Sharing), then upload.
  const requestShare = useCallback(
    (r: ShareRequest) => {
      if (settings && !settings.confirmUploads) api.uploadClip(r.path, r.host).catch((e) => toast(errText(e), true));
      else setShareReq(r);
    },
    [settings, toast],
  );

  const showBanner =
    upd && (upd.stage === "ready" || upd.stage === "available") && upd.version;
  const [askUpdate, setAskUpdate] = useState(false);
  const interrupts = updateInterrupts(status);
  const installNow = async () => {
    setInstalling(true);
    try {
      await api.installUpdate();
    } catch (e) {
      toast(errText(e), true);
      setInstalling(false);
      setAskUpdate(false);
    }
  };
  // Restarting would stop a recording or pause capture mid-game: say so and ask first.
  const requestInstall = () => (interrupts.length ? setAskUpdate(true) : installNow());
  const closeAskUpdate = useCallback(() => setAskUpdate(false), []);

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
    const d = listen<View>("show-view", (e) => setView(e.payload));
    // Uploads (also automatic ones): say when the link is ready, or why it failed.
    const u = listen<UploadProgress>("upload-progress", (e) => {
      const p = e.payload;
      const name = p.path.split("\\").pop();
      if (p.stage === "done" && p.url) {
        const url = p.url;
        toast(p.warning ? "Link copied, but it won't open on this network" : "Link copied", !!p.warning, p.warning ?? `${name} · ${url.replace(/^https?:\/\//, "").split("?")[0]}`, {
          label: "Open",
          run: () => openUrl(url).catch(() => {}),
        });
      } else if (p.stage === "error") {
        toast(p.error ?? "Upload failed", true, name);
      }
    });
    return () => {
      [a, b, c, d, u].forEach((p) => p.then((f) => f()));
    };
  }, [toast, openInStudio]);

  // Studio has no tab of its own: it opens when you click a clip. Performance
  // only shows in Benchmark mode (Settings → Advanced).
  // Damaged clips (found by the background health check), for their own section.
  const damagedClips = useMemo(
    () => (clips ? clips.filter((c) => health[c.path] && health[c.path].state !== "ok") : null),
    [clips, health],
  );

  // Duplicates on this PC (worked out ahead of time, so this is quick).
  const [dupes, setDupes] = useState(0);
  useEffect(() => {
    if (!clips) return;
    const t = setTimeout(() => api.findDuplicates().then((s) => setDupes(s.length)).catch(() => {}), 4000);
    return () => clearTimeout(t);
  }, [clips]);
  const nasNow = useNasState();
  // Everything that used to be a banner or a pop-up, in the notification center.
  const notices: Notice[] = [];
  if (showBanner && upd?.version)
    notices.push({
      id: `update:${upd.version}`,
      title: `Hindsight ${upd.version} is ${upd.stage === "ready" ? "ready" : "available"}`,
      detail: status?.recording ? "Restarting stops and saves your recording." : "It also installs by itself the next time Hindsight closes.",
      tone: "good",
      actions: [{ label: "Restart to update", run: () => requestInstall(), primary: true }],
    });
  if (similar.length)
    notices.push({
      id: `similar:${similar.map((s) => s.key).join(",")}`,
      title: similar.length === 1 ? "One game is saved under different folder names" : `${similar.length} games are saved under different folder names`,
      detail: spellings(similar[0]) + (similar.length > 1 ? ", and more" : ""),
      actions: [{ label: "Review", run: () => setMergeOpen(true), primary: true }],
    });
  if (damagedClips?.length)
    notices.push({
      id: `damaged:${damagedClips.length}`,
      title: `${damagedClips.length} damaged clip${damagedClips.length === 1 ? "" : "s"}`,
      detail: "They won't play properly all the way through. You can try to repair them or keep their good part.",
      tone: "warn",
      actions: [{ label: "Open Damaged", run: () => setView("damaged"), primary: true }],
    });
  if (dupes)
    notices.push({
      id: `dupes:${dupes}`,
      title: `${dupes} clip${dupes === 1 ? " is" : "s are"} saved twice on this PC`,
      detail: "Checked byte for byte. Copies on the NAS never count.",
      actions: [{ label: "Open Cleanup", run: () => setView("cleanup"), primary: true }],
    });
  if (nasNow?.enabled && !nasNow.reachable)
    notices.push({
      id: `nas:${nasNow.lastError ?? ""}`,
      title: "Can't reach the NAS",
      detail: "Clips keep saving on this PC and copy over once it's back.",
      tone: "warn",
      actions: [{ label: "NAS settings", run: () => setView("settings") }],
    });
  // With a NAS: the clips on this PC, and the ones on the NAS (synced from here, or from other PCs).
  const syncing = !!settings?.nasDir;
  const localClips = useMemo(() => (clips ? clips.filter((c) => c.location !== "nas") : null), [clips]);
  const syncedClips = useMemo(() => (clips ? clips.filter((c) => c.onNas || c.location === "nas") : null), [clips]);
  // Which list Studio goes back to.
  const [listView, setListView] = useState<ListView>("clips");
  useEffect(() => {
    if (isList(view)) setListView(view);
    if ((view === "local" || view === "synced") && !syncing) setView("clips");
  }, [view, syncing]);
  /** [view, label, sub-item under Clips] */
  const nav: [View, string, boolean?][] = [
    ["clips", "Clips"],
    ...(syncing
      ? ([
          ["local", "Local clips", true],
          ["synced", "Synced clips", true],
        ] as [View, string, boolean][])
      : []),
    ["damaged", "Damaged"],
    ["cleanup", "Cleanup"],
    ["montage", "Montage"],
    ...(settings?.benchmarkMode ? ([["performance", "Performance"]] as [View, string][]) : []),
    ["settings", "Settings"],
  ];
  const navOn = (id: View) => view === id || (id === listView && view === "studio");
  const backToClips = useCallback(() => setView(listView), [listView]);
  // Mouse back / forward (buttons 4 and 5) and Alt+← / Alt+→, like a browser:
  // back = Studio → your clips, and on the clips → the top;
  // forward = from the clips, reopen the clip you just left.
  useEffect(() => {
    const back = () => {
      if (document.querySelector(".modal-backdrop")) return;
      if (view === "studio") setView(listView);
      else if (isList(view)) window.dispatchEvent(new Event("rewind-top"));
      else setView("clips");
    };
    const forward = () => {
      if (document.querySelector(".modal-backdrop")) return;
      if (isList(view) && studioPath) setView("studio");
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        if (e.button === 3) back();
        else forward();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (e.key === "ArrowLeft") back();
        else forward();
      }
    };
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("keydown", onKey);
    };
  }, [view, studioPath, listView]);
  // Turning Benchmark mode off while on its page, or the open clip going away
  // (deleted): go back to the clips.
  useEffect(() => {
    if ((view === "performance" && settings && !settings.benchmarkMode) || (view === "studio" && !studioPath)) setView("clips");
  }, [view, settings, studioPath]);

  return (
    <div className="shell">
      <nav className="nav">
        <SlidingPill selector=".nav-item.on" />
        <div className="brand">
          <img src={logo} alt="" width={26} height={26} />
          HINDSIGHT
          <span className="beta-tag" title="Hindsight is in beta: thanks for testing it">
            BETA
          </span>
          {upd?.current && <span className="brand-version">v{upd.current}</span>}
        </div>
        {nav.map(([id, label, sub]) => (
          <button
            key={id}
            className={`nav-item ${sub ? "nav-sub" : ""} ${navOn(id) ? "on" : ""}`}
            onClick={() => (id === view && isList(id) ? window.dispatchEvent(new Event("rewind-top")) : setView(id))}
          >
            {label}
            {id === "damaged" && !!damagedClips?.length && (
              <span className="nav-badge" title={`${damagedClips.length} damaged clip${damagedClips.length === 1 ? "" : "s"}`}>
                {damagedClips.length}
              </span>
            )}
          </button>
        ))}
        <Notifications notices={notices} />
        <div className="nav-spacer" />
        <BufferCard status={status} hotkey={settings?.hotkey ?? "Alt+F10"} recordHotkey={settings?.recordHotkey ?? "Alt+F9"} />
      </nav>
      <main className="main">
        {view === "clips" && (
          <Library
            clips={clips}
            onOpen={openInStudio}
            onToast={(t, e) => toast(t, e)}
            onChanged={refresh}
            onDelete={requestDelete}
            hotkey={settings?.hotkey ?? "Alt+F10"}
            uploads={uploads.progress}
            links={uploads.history}
            focusPath={studioPath}
            onShare={requestShare}
            health={health}
          />
        )}
        {(view === "local" || view === "synced") && (
          <Library
            key={view}
            clips={view === "local" ? localClips : syncedClips}
            mode={view}
            onOpen={openInStudio}
            onToast={(t, e) => toast(t, e)}
            onChanged={refresh}
            onDelete={requestDelete}
            hotkey={settings?.hotkey ?? "Alt+F10"}
            uploads={uploads.progress}
            links={uploads.history}
            focusPath={studioPath}
            onShare={requestShare}
            health={health}
          />
        )}
        {view === "cleanup" && settings && (
          <Cleanup
            clips={clips}
            settings={settings}
            update={update}
            onOpen={openInStudio}
            onDelete={requestDelete}
            onToast={(t, e) => toast(t, e)}
            onChanged={refresh}
          />
        )}
        {view === "montage" && <MontageView clips={clips} onOpen={openInStudio} />}
        {view === "damaged" && (
          <Library
            clips={damagedClips}
            mode="damaged"
            onOpen={openInStudio}
            onToast={(t, e) => toast(t, e)}
            onChanged={refresh}
            onDelete={requestDelete}
            hotkey={settings?.hotkey ?? "Alt+F10"}
            uploads={uploads.progress}
            links={uploads.history}
            focusPath={studioPath}
            onShare={requestShare}
            health={health}
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
            onBack={backToClips}
            uploads={uploads.progress}
            links={uploads.history}
            onShare={requestShare}
            health={health[studioPath ?? ""]}
            onRescued={(p) => {
              refresh();
              openInStudio(p);
              toast("Rescued the good part", false, p.split("\\").pop());
            }}
          />
        )}
        {view === "performance" && <Performance />}
        {view === "settings" && settings && (
          <SettingsView
            settings={settings}
            update={update}
            onError={(m) => toast(m, true)}
            onInstall={requestInstall}
            installing={installing}
          />
        )}
      </main>
      {shareReq && settings && (
        <ShareConfirm
          req={shareReq}
          settings={settings}
          update={update}
          onClose={() => setShareReq(null)}
          onOpenSettings={() => {
            try {
              localStorage.setItem("rewind.settingsTab", "sharing");
            } catch {
              /* only a convenience */
            }
            setView("settings");
          }}
          onError={(m) => toast(m, true)}
        />
      )}
      {askUpdate && upd?.version && (
        <ConfirmUpdate
          version={upd.version}
          reasons={interrupts.length ? interrupts : ["Hindsight closes and reopens on the new version."]}
          busy={installing}
          onConfirm={installNow}
          onCancel={closeAskUpdate}
        />
      )}
      {mergeOpen && (
        <MergeDialog list={similar} onClose={() => setMergeOpen(false)} onMerged={onMerged} onError={(m) => toast(m, true)} />
      )}
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
