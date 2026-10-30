import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  selected,
  onClick,
  onToggle,
  onDelete,
  onToast,
  onChanged,
}: {
  clip: ClipFile;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: (e: React.MouseEvent) => void;
  onDelete: () => void;
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
    <button className={`card ${selected ? "selected" : ""}`} onClick={onClick} title={clip.path}>
      <div className="thumb">
        {thumb && <img src={thumb} alt="" loading="lazy" />}
        <span
          className={`check ${selected ? "on" : ""}`}
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${clip.name}`}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(e);
          }}
        >
          {selected ? "✓" : ""}
        </span>
        {info && (
          <span className="badge bl" title="Video codec · file container">
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
              api.reveal(clip.path).catch((err) => onToast(errText(err), true));
            }}
            title="Show in Explorer"
          >
            Show
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Move to the Recycle Bin"
          >
            Delete
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
  onDelete,
  hotkey,
}: {
  clips: ClipFile[] | null;
  onOpen: (path: string) => void;
  onToast: (t: string, err?: boolean) => void;
  onChanged: () => void;
  /** Asks for confirmation, then deletes. Resolves true if deleted. */
  onDelete: (paths: string[]) => Promise<boolean>;
  hotkey: string;
}) {
  const [folder, setFolder] = useState("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

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

  const visible = useMemo(() => groups.flatMap((g) => g.items.map((c) => c.path)), [groups]);

  // Drop selections that disappeared (deleted, filtered out).
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((p) => visible.includes(p)));
      return keep.size === s.size ? s : keep;
    });
  }, [visible]);

  const selecting = selected.size > 0;

  const toggle = useCallback((path: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
    anchor.current = path;
  }, []);

  const selectRange = useCallback(
    (path: string) => {
      const from = anchor.current ? visible.indexOf(anchor.current) : -1;
      const to = visible.indexOf(path);
      if (from < 0 || to < 0) return toggle(path);
      const [a, b] = from < to ? [from, to] : [to, from];
      setSelected((s) => new Set([...s, ...visible.slice(a, b + 1)]));
    },
    [visible, toggle],
  );

  const clickCard = (path: string) => (e: React.MouseEvent) => {
    if (e.shiftKey) selectRange(path);
    else if (e.ctrlKey || e.metaKey || selecting) toggle(path);
    else onOpen(path);
  };

  const deleteSelected = useCallback(async () => {
    if (!selected.size) return;
    if (await onDelete([...selected])) setSelected(new Set());
  }, [selected, onDelete]);

  // Delete removes the selection, Ctrl+A selects everything shown, Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.key === "Delete" && selected.size) {
        e.preventDefault();
        deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && visible.length) {
        e.preventDefault();
        setSelected(new Set(visible));
      } else if (e.key === "Escape" && selected.size) {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, visible, deleteSelected]);

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

  const selectedBytes = (clips ?? []).filter((c) => selected.has(c.path)).reduce((n, c) => n + c.size, 0);

  return (
    <div className={`page ${selecting ? "selecting" : ""}`}>
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

      {selecting ? (
        <div className="select-bar" role="toolbar" aria-label="Selected clips">
          <strong style={{ fontSize: 13, padding: "0 6px" }}>
            {selected.size} selected <span className="muted">· {fmtSize(selectedBytes)}</span>
          </strong>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => setSelected(new Set(visible))}>
            Select all ({visible.length})
          </button>
          <button className="btn small" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button className="btn small danger" onClick={deleteSelected}>
            Delete {selected.size}
          </button>
        </div>
      ) : (
        folders.length > 1 && (
          <div className="chips">
            {folders.map((f) => (
              <button key={f} className={`chip ${f === folder ? "on" : ""}`} onClick={() => setFolder(f)}>
                {f}
              </button>
            ))}
            <span className="muted" style={{ fontSize: 12, alignSelf: "center", marginLeft: "auto" }}>
              Tip: Ctrl+click or Shift+click to select several
            </span>
          </div>
        )
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
        groups.map((g) => {
          const allInDay = g.items.every((c) => selected.has(c.path));
          return (
            <section key={g.day} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row" style={{ gap: 12 }}>
                <div className="label">{g.day}</div>
                {selecting && (
                  <button
                    className="btn small"
                    onClick={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        g.items.forEach((c) => (allInDay ? n.delete(c.path) : n.add(c.path)));
                        return n;
                      })
                    }
                  >
                    {allInDay ? "Unselect day" : "Select day"}
                  </button>
                )}
              </div>
              <div className="grid">
                {g.items.map((c) => (
                  <ClipCard
                    key={c.path}
                    clip={c}
                    selected={selected.has(c.path)}
                    onClick={clickCard(c.path)}
                    onToggle={(e) => (e.shiftKey ? selectRange(c.path) : toggle(c.path))}
                    onDelete={() => onDelete(selected.has(c.path) ? [...selected] : [c.path])}
                    onToast={onToast}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
