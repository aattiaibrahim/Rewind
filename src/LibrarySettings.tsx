import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, ClipFolder, NasState, Settings } from "./api";

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
}: {
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

  return (
    <section className="group">
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

      <div className="setting">
        <span>
          Clips from other recorders
          <small>Shows their clips in your library, grouped by game, without moving or copying anything.</small>
        </span>
        <button className="btn small" onClick={addFolder}>
          Add folder…
        </button>
      </div>
      {found.map((f) => (
        <label className="setting sub" key={f.path}>
          <span>
            {f.label}
            <small style={{ wordBreak: "break-all" }}>{f.exists ? f.path : `${f.path} (not found)`}</small>
          </span>
          <Toggle label={`Show ${f.label} clips`} checked={linked(f.path)} onChange={(v) => toggleLinked(f.path, v)} />
        </label>
      ))}
      {custom.map((p) => (
        <div className="setting sub" key={p}>
          <span>
            {p.split("\\").filter(Boolean).pop()}
            <small style={{ wordBreak: "break-all" }}>{p}</small>
          </span>
          <button className="btn small" onClick={() => toggleLinked(p, false)} title="Stops showing them. Files are not touched.">
            Remove
          </button>
        </div>
      ))}
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
