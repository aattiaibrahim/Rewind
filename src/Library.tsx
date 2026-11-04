import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ClipFile, codecLabel, errText, fmtDuration, fmtSize, Health, Probe, Upload, UploadProgress, VIDEO_EXTENSIONS } from "./api";
import { useThumb } from "./hooks";
import { liveLink, progressText, ShareRequest, timeLeft } from "./Share";
import { Timeline } from "./Timeline";
import { DamagedStatus, damagedText } from "./Health";
import { DeletePreview } from "./DeletePreview";

/** Where each list (all clips, damaged clips) was scrolled to, kept while you're in Studio (the page itself unmounts). */
const memories: Record<string, { scroll: number; folder: string; query: string }> = {};

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  // Immich-style: "Mon, Nov 3", with the year when it isn't this year.
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
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
  upload,
  link,
  onShare,
  damage,
  returned,
  deleteCount = 1,
}: {
  /** How many clips its Delete removes (all selected ones when it's part of a selection) */
  deleteCount?: number;
  upload?: UploadProgress;
  /** Its newest link that still works */
  link: Upload | null;
  onShare: () => void;
  damage?: Health;
  /** The clip you just came back from: briefly highlighted */
  returned: boolean;
  clip: ClipFile;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onToast: (t: string, err?: boolean) => void;
}) {
  const thumb = useThumb(clip.path, clip.modified);
  const [info, setInfo] = useState<Probe | null>(null);
  useEffect(() => {
    api.probe(clip.path, String(clip.modified)).then(setInfo).catch(() => {});
  }, [clip.path, clip.modified]);

  const time = new Date(clip.modified).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <button className={`card ${selected ? "selected" : ""} ${returned ? "returned" : ""}`} onClick={onClick} title={clip.path} data-path={clip.path}>
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
        {info && <span className="badge br">{fmtDuration(info.duration)}</span>}
        <div className="card-actions">
          {/* No one-click MP4 here: it sat next to the checkbox and was easy to hit by mistake. It's in Studio. */}
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
              onShare();
            }}
            title="Upload and copy a link that plays inside Discord"
          >
            Share
          </span>
          {/* The NAS has no Recycle Bin, so clips only there are deleted on the NAS itself. */}
          {clip.location !== "nas" && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title={deleteCount > 1 ? `Move the ${deleteCount} selected clips to the Recycle Bin` : "Move to the Recycle Bin"}
            >
              {deleteCount > 1 ? `Delete ${deleteCount}` : "Delete"}
            </span>
          )}
        </div>
        {/* Status that matters at a glance stays visible; the rest shows on hover, like Immich. */}
        <div className="card-tags">
          {damage && damage.state !== "ok" && (
            <span className="src-tag bad" title={damagedText(damage)}>
              ⚠ Damaged
            </span>
          )}
          {upload && (
            <span className={`src-tag ${upload.stage === "error" ? "bad" : "ok"}`} title={upload.error ?? undefined}>
              {progressText(upload)}
            </span>
          )}
          {!upload && link && (
            <span className="src-tag ok" title={`Shared on ${link.host}: the link is in Studio`}>
              🔗 {timeLeft(link) ? `${timeLeft(link)} left` : "Shared"}
            </span>
          )}
          {clip.location === "linked" && <span className="src-tag">{clip.source}</span>}
          {clip.location === "nas" && (
            <span className="src-tag" title="Only on the NAS (for example from another PC)">
              NAS
            </span>
          )}
          {clip.onNas && (
            <span className="src-tag ok" title="Also safely copied to the NAS">
              ✓ NAS
            </span>
          )}
        </div>
        <div className="card-over">
          <div className="card-title">{clip.name}</div>
          <div className="card-meta">
            {clip.folder} · {time} · {fmtSize(clip.size)}
            {info && ` · ${codecLabel(info.codec)} ${containerLabel(clip.path)}`}
          </div>
        </div>
      </div>
    </button>
  );
}

/** "Counter-Strike 2" and "counter strike 2" are the same game. */
function gameKey(folder: string) {
  return folder.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function Library({
  clips,
  onOpen,
  onToast,
  onDelete,
  hotkey,
  uploads,
  links,
  focusPath,
  onShare,
  health,
  mode = "clips",
}: {
  /** "damaged": the Damaged section (the clips given are only the damaged ones). */
  mode?: "clips" | "damaged";
  health?: Record<string, Health>;
  onShare?: (r: ShareRequest) => void;
  /** The clip last opened in Studio: scrolled back to and highlighted */
  focusPath?: string | null;
  uploads?: Record<string, UploadProgress>;
  links?: Record<string, Upload[]>;
  clips: ClipFile[] | null;
  onOpen: (path: string) => void;
  onToast: (t: string, err?: boolean) => void;
  onChanged: () => void;
  /** Asks for confirmation, then deletes. Resolves true if deleted. */
  onDelete: (paths: string[]) => Promise<boolean>;
  hotkey: string;
}) {
  const memory = (memories[mode] ??= { scroll: 0, folder: "All", query: "" });
  const damagedMode = mode === "damaged";
  // Filter and search survive a trip to Studio too.
  const [folder, setFolderState] = useState(memory.folder);
  const [query, setQueryState] = useState(memory.query);
  const setFolder = (f: string) => {
    memory.folder = f;
    setFolderState(f);
  };
  const setQuery = (q: string) => {
    memory.query = q;
    setQueryState(q);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  // One chip per game, even when recorders spell it differently ("VALORANT" / "Valorant").
  // Hindsight's own folder name wins as the label.
  const folders = useMemo(() => {
    const label = new Map<string, string>();
    for (const c of clips ?? []) {
      const k = gameKey(c.folder);
      if (!label.has(k) || c.location === "local") label.set(k, c.folder);
    }
    const names = [...label.values()];
    return ["All", ...names.sort((a, b) => (a === "Imported" ? 1 : b === "Imported" ? -1 : a.localeCompare(b)))];
  }, [clips]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const want = gameKey(folder);
    const list = (clips ?? []).filter(
      (c) => (folder === "All" || gameKey(c.folder) === want) && (!q || `${c.name} ${c.folder} ${c.source}`.toLowerCase().includes(q)),
    );
    const out: { day: string; ts: number; items: ClipFile[] }[] = [];
    for (const c of list) {
      const day = dayLabel(c.modified);
      if (out[out.length - 1]?.day !== day) out.push({ day, ts: c.modified, items: [] });
      out[out.length - 1].items.push(c);
    }
    return out;
  }, [clips, folder, query]);

  const visible = useMemo(() => groups.flatMap((g) => g.items.map((c) => c.path)), [groups]);

  // Coming back from Studio: same scroll position, and the clip you opened glows
  // for a moment (scrolled into view if the list moved, e.g. a new clip arrived).
  const scroller = useRef<HTMLDivElement>(null);
  const [returnedTo, setReturnedTo] = useState<string | null>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc || restored.current || !clips?.length) return;
    restored.current = true;
    sc.scrollTop = memory.scroll;
    if (focusPath) {
      const card = sc.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusPath)}"]`);
      if (card) {
        const r = card.getBoundingClientRect();
        const v = sc.getBoundingClientRect();
        if (r.top < v.top + 80 || r.bottom > v.bottom) card.scrollIntoView({ block: "center" });
        setReturnedTo(focusPath);
        setTimeout(() => setReturnedTo(null), 2200);
      }
    }
  }, [clips, focusPath]);
  // "Back" again while already on the clips (mouse back button, Alt+←, Esc, or the
  // Clips tab): forget the old spot and go to the top.
  useEffect(() => {
    const top = () => {
      memory.scroll = 0;
      setReturnedTo(null);
      scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("rewind-top", top);
    return () => window.removeEventListener("rewind-top", top);
  }, []);
  const onScroll = () => {
    if (scroller.current) memory.scroll = scroller.current.scrollTop;
  };
  const days = useMemo(() => groups.map((g) => ({ key: g.day, ts: g.ts, count: g.items.length })), [groups]);

  // Drop selections that disappeared (deleted, filtered out).
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((p) => visible.includes(p)));
      return keep.size === s.size ? s : keep;
    });
  }, [visible]);

  const selecting = selected.size > 0;
  const [previewing, setPreviewing] = useState(false);
  // In the order they appear on the page.
  const selectedClips = useMemo(
    () => (clips ?? []).filter((c) => selected.has(c.path) && visible.includes(c.path)),
    [clips, selected, visible],
  );

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
      } else if (e.key === "Escape") {
        window.dispatchEvent(new Event("rewind-top"));
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
    <div className="lib">
      {previewing && selecting && (
        <DeletePreview
          clips={selectedClips}
          onKeep={(p) =>
            setSelected((s) => {
              const n = new Set(s);
              n.delete(p);
              return n;
            })
          }
          onClose={() => setPreviewing(false)}
          onDelete={async () => {
            setPreviewing(false);
            await deleteSelected();
          }}
        />
      )}
    <div className={`page lib-page ${selecting ? "selecting" : ""}`} ref={scroller} onScroll={onScroll}>
      <div className="toolbar">
        <h1 style={{ flex: 1 }}>{damagedMode ? "Damaged clips" : "Clips"}</h1>
        <label className="search">
          <span className="muted" style={{ fontSize: 12 }}>
            Search
          </span>
          <input placeholder="clips, games…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {!damagedMode && (
          <button className="btn" onClick={openAny}>
            Open any video…
          </button>
        )}
      </div>
      {damagedMode && <DamagedStatus count={clips?.length ?? 0} />}

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
          <button className="btn small" onClick={() => setPreviewing(true)} title="Look through the selected clips before deleting them">
            Preview
          </button>
          <button className="btn small danger" onClick={deleteSelected} title="Move the selected clips to the Recycle Bin (Delete)">
            Delete {selected.size} clip{selected.size === 1 ? "" : "s"}
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

      {clips === null ? null : clips.length === 0 && damagedMode ? (
        <div className="empty">
          <strong>No damaged clips</strong>
          <span>Every clip checked so far plays properly. Anything that doesn't will show up here.</span>
        </div>
      ) : clips.length === 0 ? (
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
            <section key={g.day} data-day={g.day} className="day">
              <div className="day-head">
                <h3>{g.day}</h3>
                <span className="muted">
                  {g.items.length} clip{g.items.length === 1 ? "" : "s"}
                </span>
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
                    deleteCount={selected.has(c.path) ? selected.size : 1}
                    onToast={onToast}
                    upload={uploads?.[c.path]}
                    link={liveLink(links?.[c.path])}
                    damage={health?.[c.path]}
                    onShare={() => onShare?.({ path: c.path })}
                    returned={c.path === returnedTo}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
    <Timeline scroller={scroller} days={days} />
    </div>
  );
}
