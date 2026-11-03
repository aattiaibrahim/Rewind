import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, ClipFolder, errText, fmtSize, LastMove, MovePlan, NasState, Settings } from "./api";
import { ConfirmDialog } from "./ConfirmUpdate";
import { HealthSetting } from "./Health";

type MoveJob = { folders: string[]; plan: MovePlan | null; running: boolean; done: number; total: number };

function outcomeText(verb: string, o: { moved: number; failed: [string, string][] }) {
  const base = `${verb} ${o.moved} clip${o.moved === 1 ? "" : "s"}.`;
  if (!o.failed.length) return base;
  const [file, why] = o.failed[0];
  return `${base} ${o.failed.length} couldn't be: ${file.split("\\").pop()} (${why})${o.failed.length > 1 ? " and others" : ""}.`;
}

function useNasState() {
  const [n, setN] = useState<NasState | null>(null);
  useEffect(() => {
    api.getNasState().then(setN).catch(() => {});
    const un = listen<NasState>("nas-state", (e) => setN(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return n;
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function nasLine(s: Settings, n: NasState | null) {
  if (!s.nasDir) return "Off. Clips stay on this PC only.";
  if (!n || !n.enabled) return "Starting…";
  if (!n.reachable) return `Can't reach it right now. Clips keep saving here and copy over once it's back. (${n.lastError ?? ""})`;
  if (n.copying) return `Copying ${n.copying}…`;
  const parts = [n.pending ? `${n.pending} clip${n.pending === 1 ? "" : "s"} waiting to copy` : "Everything is copied"];
  if (n.lastSync) parts.push(`checked ${ago(n.lastSync)}`);
  if (n.lastError) parts.push(`problem: ${n.lastError}`);
  return parts.join(" · ");
}

/** Settings → Library: the NAS folder and other recorders' folders. */
export function LibrarySettings({
  s,
  set,
  Toggle,
  hidden,
}: {
  hidden?: boolean;
  s: Settings;
  set: (p: Partial<Settings>) => void;
  Toggle: (p: { label: string; checked: boolean; onChange: (v: boolean) => void }) => React.ReactElement;
}) {
  const nas = useNasState();
  const [found, setFound] = useState<ClipFolder[]>([]);
  useEffect(() => {
    api.recorderClipFolders().then(setFound).catch(() => {});
  }, []);

  const pickNas = async () => {
    const dir = await open({ directory: true, title: "Pick the NAS folder for clips (e.g. \\\\nas\\clips)", defaultPath: s.nasDir || undefined });
    if (typeof dir === "string") set({ nasDir: dir });
  };
  const linked = (p: string) => s.linkedFolders.some((f) => f.toLowerCase() === p.toLowerCase());
  const toggleLinked = (p: string, on: boolean) =>
    set({ linkedFolders: on ? [...s.linkedFolders, p] : s.linkedFolders.filter((f) => f.toLowerCase() !== p.toLowerCase()) });
  const addFolder = async () => {
    const dir = await open({ directory: true, title: "Show the clips in this folder in Rewind" });
    if (typeof dir === "string" && !linked(dir)) set({ linkedFolders: [...s.linkedFolders, dir] });
  };
  const custom = s.linkedFolders.filter((f) => !found.some((k) => k.path.toLowerCase() === f.toLowerCase()));

  // "Move into Rewind": plan first (nothing touched), confirm, then move with progress.
  const [job, setJob] = useState<MoveJob | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [last, setLast] = useState<LastMove | null>(null);
  const refreshLast = useCallback(() => {
    api.lastMove().then(setLast).catch(() => {});
  }, []);
  useEffect(() => {
    refreshLast();
    const un = listen<[number, number]>("move-progress", (e) =>
      setJob((j) => (j ? { ...j, done: e.payload[0], total: e.payload[1] } : j)),
    );
    return () => {
      un.then((f) => f());
    };
  }, [refreshLast]);
  const askMove = async (folders: string[]) => {
    setNote(null);
    setJob({ folders, plan: null, running: false, done: 0, total: 0 });
    try {
      const plan = await api.planMoveIntoRewind(folders);
      if (!plan.count) {
        setJob(null);
        setNote("Nothing to move: no finished clips in that folder.");
      } else setJob({ folders, plan, running: false, done: 0, total: plan.count });
    } catch (e) {
      setJob(null);
      setNote(errText(e));
    }
  };
  const doMove = async () => {
    if (!job?.plan) return;
    setJob({ ...job, running: true });
    try {
      setNote(outcomeText("Moved", await api.moveIntoRewind(job.folders)));
    } catch (e) {
      setNote(errText(e));
    } finally {
      setJob(null);
      refreshLast();
    }
  };
  const undo = async () => {
    try {
      setNote(outcomeText("Put back", await api.undoLastMove()));
    } catch (e) {
      setNote(errText(e));
    } finally {
      refreshLast();
    }
  };
  const closeMove = useCallback(() => setJob((j) => (j?.running ? j : null)), []);
  const moveButton = (path: string) =>
    linked(path) && (
      <button className="btn small" disabled={!!job} onClick={() => askMove([path])} title="Move these clips into Rewind's game folders">
        Move into Rewind…
      </button>
    );

  return (
    <section className="group" hidden={hidden}>
      <h2>Library &amp; NAS</h2>
      <div className="setting">
        <span>
          NAS folder
          <small style={{ wordBreak: "break-all" }}>{s.nasDir || "Not set"}</small>
          <small>
            Clips save to this PC first (instant, works offline), then copy to the NAS in the background into the same game
            folders. Several PCs can share one NAS: file names include each PC's name.
          </small>
          <small className={nas && s.nasDir && !nas.reachable && nas.enabled ? "err-text" : ""}>{nasLine(s, nas)}</small>
        </span>
        <div className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
          {s.nasDir && (
            <button className="btn small" onClick={() => api.syncNasNow()} title="Copy anything waiting right now">
              Sync now
            </button>
          )}
          {s.nasDir && (
            <button className="btn small" onClick={() => set({ nasDir: "" })}>
              Turn off
            </button>
          )}
          <button className="btn small" onClick={pickNas}>
            {s.nasDir ? "Change…" : "Choose…"}
          </button>
        </div>
      </div>
      {s.nasDir && (
        <label className="setting">
          <span>
            Free up space on this PC
            <small>Removes the copy here once it's safely on the NAS (checked by size first). Off keeps both.</small>
          </span>
          <Toggle label="Remove local copy" checked={s.nasRemoveLocal} onChange={(v) => set({ nasRemoveLocal: v })} />
        </label>
      )}

      <HealthSetting on={s.healthCheck} set={(v) => set({ healthCheck: v })} Toggle={Toggle} />
      <div className="setting">
        <span>
          Clips from other recorders
          <small>
            Shows their clips in your library, grouped by game, without moving or copying anything. Move them into Rewind's
            folders to tidy everything into one place.
          </small>
        </span>
        <span className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
          {s.linkedFolders.length > 1 && (
            <button
              className="btn small primary"
              disabled={!!job}
              onClick={() => askMove(s.linkedFolders)}
              title="Move every shown folder's clips into Rewind's game folders in one go"
            >
              Move all into Rewind…
            </button>
          )}
          <button className="btn small" onClick={addFolder}>
            Add folder…
          </button>
        </span>
      </div>
      {found.map((f) => (
        <div className="setting sub" key={f.path}>
          <span>
            {f.label}
            <small style={{ wordBreak: "break-all" }}>{f.exists ? f.path : `${f.path} (not found)`}</small>
          </span>
          <span className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
            {moveButton(f.path)}
            <Toggle label={`Show ${f.label} clips`} checked={linked(f.path)} onChange={(v) => toggleLinked(f.path, v)} />
          </span>
        </div>
      ))}
      {custom.map((p) => (
        <div className="setting sub" key={p}>
          <span>
            {p.split("\\").filter(Boolean).pop()}
            <small style={{ wordBreak: "break-all" }}>{p}</small>
          </span>
          <span className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
            {moveButton(p)}
            <button className="btn small" onClick={() => toggleLinked(p, false)} title="Stops showing them. Files are not touched.">
              Remove
            </button>
          </span>
        </div>
      ))}
      {last && (
        <div className="setting sub">
          <span>
            Last move: {last.count} clip{last.count === 1 ? "" : "s"} from {last.label}
            <small>{new Date(last.when).toLocaleString()} · Undo puts them back where they were, with their old names.</small>
          </span>
          <button className="btn small" disabled={!!job} onClick={undo}>
            Undo
          </button>
        </div>
      )}
      {note && (
        <div className="setting sub">
          <span>
            <small>{note}</small>
          </span>
        </div>
      )}
      {job?.plan && (
        <ConfirmDialog
          title={`Move ${job.plan.count} ${job.plan.label} clip${job.plan.count === 1 ? "" : "s"} into Rewind?`}
          confirmLabel={job.running ? `Moving ${Math.min(job.done + 1, job.total)} of ${job.total}…` : `Move ${fmtSize(job.plan.bytes)}`}
          busy={job.running}
          onConfirm={doMove}
          onCancel={closeMove}
        >
          <ul className="modal-list wrap">
            <li>
              Into {job.plan.folders.slice(0, 4).map(([f, n]) => `${f} (${n})`).join(", ")}
              {job.plan.folders.length > 4 ? ` and ${job.plan.folders.length - 4} more folders` : ""}, renamed like Rewind's
              clips, e.g. “{job.plan.examples[0]?.[0]}” → “{job.plan.examples[0]?.[1]}”.
            </li>
            <li>
              {job.plan.otherDrive
                ? "It's on another drive, so each clip is copied, checked, and only then removed from the old folder. This can take a while."
                : "Same drive, so it's instant: nothing is copied."}
            </li>
            <li>{job.plan.label} won't find these clips in its own app anymore.</li>
            <li>You can undo it afterwards: everything goes back where it was.</li>
          </ul>
        </ConfirmDialog>
      )}
      {!found.length && !custom.length && (
        <div className="setting sub">
          <span>
            <small>No Medal, OBS or NVIDIA folders found. Use Add folder… for any other recorder.</small>
          </span>
        </div>
      )}
    </section>
  );
}
