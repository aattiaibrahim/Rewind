import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, ClipFile, codecLabel, errText, fmtDuration, fmtSize, Probe, VIDEO_EXTENSIONS } from "./api";
import { useThumb } from "./hooks";

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function containerLabel(path: string) {
  const ext = path.split(".").pop()?.toUpperCase() ?? "";
  return ext === "M4V" ? "MP4" : ext;
}

function ClipCard({
  clip,
  onOpen,
  onToast,
  onChanged,
}: {
  clip: ClipFile;
  onOpen: () => void;
  onToast: (t: string, err?: boolean) => void;
  onChanged: () => void;
}) {
  const thumb = useThumb(clip.path, clip.modified);
  const [info, setInfo] = useState<Probe | null>(null);
  useEffect(() => {
    api.probe(clip.path, String(clip.modified)).then(setInfo).catch(() => {});
  }, [clip.path, clip.modified]);

  const isMp4 = clip.path.toLowerCase().endsWith(".mp4");
  const time = new Date(clip.modified).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const remux = async (e: React.MouseEvent) => {
    e.stopPropagation();
    onToast("Remuxing to MP4…");
    try {
      const out = await api.remuxMp4(clip.path);
      onToast(`Saved ${out.split("\\").pop()} (same video, new MP4 container)`);
      onChanged();
    } catch (err) {
      onToast(errText(err), true);
    }
  };

  return (
    <button className="card" onClick={onOpen} title={clip.path}>
      <div className="thumb">
        {thumb && <img src={thumb} alt="" loading="lazy" />}
        {info && (
          <span className="badge tl" title="Video codec · file container">
            {codecLabel(info.codec)} · {containerLabel(clip.path)}
          </span>
        )}
        {info && <span className="badge br">{fmtDuration(info.duration)}</span>}
        <div className="card-actions">
          {!isMp4 && (
            <span role="button" tabIndex={0} onClick={remux} title="Make an MP4 copy of this file (no quality loss)">
              MP4
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              api.reveal(clip.path);
            }}
            title="Show in Explorer"
          >
            Show
          </span>
        </div>
      </div>
      <div className="card-title">{clip.name}</div>
      <div className="card-meta">
        {clip.folder} · {time} · {fmtSize(clip.size)}
      </div>
    </button>
  );
}

export function Library({
  clips,
  onOpen,
  onToast,
  onChanged,
  hotkey,
}: {
  clips: ClipFile[] | null;
  onOpen: (path: string) => void;
  onToast: (t: string, err?: boolean) => void;
  onChanged: () => void;
  hotkey: string;
}) {
  const [folder, setFolder] = useState("All");
  const [query, setQuery] = useState("");

  const folders = useMemo(() => {
    const set = new Set((clips ?? []).map((c) => c.folder));
    return ["All", ...[...set].sort((a, b) => (a === "Imported" ? 1 : b === "Imported" ? -1 : a.localeCompare(b)))];
  }, [clips]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (clips ?? []).filter(
      (c) => (folder === "All" || c.folder === folder) && (!q || `${c.name} ${c.folder}`.toLowerCase().includes(q)),
    );
    const out: { day: string; items: ClipFile[] }[] = [];
    for (const c of list) {
      const day = dayLabel(c.modified);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(c);
    }
    return out;
  }, [clips, folder, query]);

  const openAny = async () => {
    const picked = await open({
      multiple: true,
      title: "Open videos from anywhere",
      filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      await api.addExternal(paths);
      if (paths.length === 1) onOpen(paths[0]);
    } catch (e) {
      onToast(errText(e), true);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h1 style={{ flex: 1 }}>Clips</h1>
        <label className="search">
          <span className="muted" style={{ fontSize: 12 }}>
            Search
          </span>
          <input placeholder="clips, games…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="btn" onClick={openAny}>
          Open any video…
        </button>
      </div>
      {folders.length > 1 && (
        <div className="chips">
          {folders.map((f) => (
            <button key={f} className={`chip ${f === folder ? "on" : ""}`} onClick={() => setFolder(f)}>
              {f}
            </button>
          ))}
        </div>
      )}

      {clips === null ? null : clips.length === 0 ? (
        <div className="empty">
          <strong>No clips yet</strong>
          <span>
            Play something and press <span className="kbd">{hotkey}</span> to save the last moments. Or open a video from
            anywhere on your PC to edit it.
          </span>
          <button className="btn" onClick={openAny}>
            Open any video…
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <strong>Nothing matches</strong>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="label">{g.day}</div>
            <div className="grid">
              {g.items.map((c) => (
                <ClipCard key={c.path} clip={c} onOpen={() => onOpen(c.path)} onToast={onToast} onChanged={onChanged} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
