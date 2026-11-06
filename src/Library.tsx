import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ClipFile, codecLabel, errText, fmtDuration, fmtSize, Health, Probe, Upload, UploadProgress, VIDEO_EXTENSIONS } from "./api";
import { useNearView, useThumb } from "./hooks";
import { liveLink, progressText, ShareRequest, timeLeft } from "./Share";
import { Timeline } from "./Timeline";
import { DamagedStatus, damagedText } from "./Health";
import { DeletePreview } from "./DeletePreview";
import { GameIcon } from "./GameIcon";
import { OnThisDay } from "./OnThisDay";
import { HealReview } from "./HealReview";
import { NasBadge, nasStatus, useNasState } from "./NasProgress";
import { SlidingPill } from "./SlidingPill";

/** Where each list (all clips, damaged clips) was scrolled to, kept while you're in Studio (the page itself unmounts). */
const memories: Record<string, { scroll: number; folder: string; query: string; filters?: Filters }> = {};

type ViewMode = "gallery" | "folders" | "list";
type Sort = "new" | "old" | "big";
/** where: "" any, "pc" on this PC, "nas" on the NAS; sources: "Hindsight", "Medal"…; from/to: YYYY-MM-DD; minMb: 0 = any */
type Filters = { where: "" | "pc" | "nas"; sources: string[]; from: string; to: string; minMb: number };
const NO_FILTERS: Filters = { where: "", sources: [], from: "", to: "", minMb: 0 };
const TITLES: Record<string, string> = { clips: "Clips", local: "Local clips", synced: "Synced clips", damaged: "Damaged clips" };

const remembered = <T extends string>(k: string, d: T): T => {
  try {
    return (localStorage.getItem(`rewind.${k}`) as T) || d;
  } catch {
    return d;
  }
};
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(`rewind.${k}`, v);
  } catch {
    /* only a convenience */
  }
};
const sourceOf = (c: ClipFile) => (c.location === "linked" ? c.source : c.location === "nas" ? "Other PCs" : "Hindsight");
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A game's folder in Folders view: its newest clip as the cover, with count and size. */
function FolderTile({ name, items, onOpen }: { name: string; items: ClipFile[]; onOpen: () => void }) {
  const cover = items[0];
  const thumb = useThumb(cover.path, cover.modified);
  const bytes = items.reduce((n, c) => n + c.size, 0);
  return (
    <button className="folder-tile" onClick={onOpen} title={`Open ${name}`}>
      <div className="folder-cover">
        <div className="folder-back" />
        <div className="thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</div>
      </div>
      <div className="card-title folder-title">
        <GameIcon name={name} size={18} />
        {name}
      </div>
      <div className="card-meta">
        {items.length} clip{items.length === 1 ? "" : "s"} · {fmtSize(bytes)} · newest {dayLabel(cover.modified)}
      </div>
    </button>
  );
}

/** One clip in List view. */
function ClipRow({
  clip,
  selected,
  onClick,
  damage,
  nasOn,
}: {
  clip: ClipFile;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  damage?: Health;
  nasOn: boolean;
}) {
  const [rowRef, near] = useNearView<HTMLButtonElement>();
  const thumb = useThumb(near ? clip.path : "", clip.modified);
  const time = new Date(clip.modified).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <button ref={rowRef} className={`clip-row ${selected ? "selected" : ""}`} onClick={onClick} title={clip.path} data-path={clip.path}>
      <div className="clip-row-thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</div>
      <div className="clip-row-main">
        <div className="card-title">{clip.name}</div>
        <div className="card-meta">
          {clip.folder} · {time}
          {damage && damage.state !== "ok" && <span className="src-tag bad"> ⚠ Damaged</span>}
          {clip.location === "linked" && <span className="src-tag">{clip.source}</span>}
          <NasBadge status={nasStatus(clip, nasOn)} />
        </div>
      </div>
      <div className="clip-row-size">{fmtSize(clip.size)}</div>
    </button>
  );
}

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
  nasOn,
}: {
  /** NAS syncing is on (clips not copied yet get a "waiting" mark) */
  nasOn: boolean;
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
  // Only clips near the screen ask the drive for anything: with hundreds of
  // clips (or a slow hard drive) the ones you're looking at come first.
  const [cardRef, near] = useNearView<HTMLButtonElement>();
  const thumb = useThumb(near ? clip.path : "", clip.modified);
  const [info, setInfo] = useState<Probe | null>(null);
  useEffect(() => {
    if (near) api.probe(clip.path, String(clip.modified)).then(setInfo).catch(() => {});
  }, [near, clip.path, clip.modified]);

  const time = new Date(clip.modified).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <button
      ref={cardRef}
      className={`card ${selected ? "selected" : ""} ${returned ? "returned" : ""}`}
      onClick={onClick}
      title={clip.path}
      data-path={clip.path}
    >
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
          <NasBadge status={nasStatus(clip, nasOn)} />
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
  /** "damaged": the Damaged section (only the damaged clips); "local" / "synced": this PC's or the NAS's. */
  mode?: "clips" | "damaged" | "local" | "synced";
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
  const nas = useNasState();
  const nasOn = !!nas?.enabled;
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
  // Gallery / Folders / List, the sort, and filters (view and sort remembered for every list).
  const [viewMode, setViewModeState] = useState<ViewMode>(() => remembered<ViewMode>("viewMode", "gallery"));
  const [sort, setSortState] = useState<Sort>(() => remembered<Sort>("sort", "new"));
  const [filters, setFiltersState] = useState<Filters>(memory.filters ?? NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const setViewMode = (v: ViewMode) => {
    remember("viewMode", v);
    setViewModeState(v);
    if (v === "folders") setFolder("All");
  };
  const setSort = (v: Sort) => {
    remember("sort", v);
    setSortState(v);
  };
  const setFilters = (p: Partial<Filters>) => {
    const next = { ...filters, ...p };
    memory.filters = next;
    setFiltersState(next);
  };
  const activeFilters = (filters.where ? 1 : 0) + filters.sources.length + (filters.from || filters.to ? 1 : 0) + (filters.minMb ? 1 : 0);
  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clips ?? []) m.set(sourceOf(c), (m.get(sourceOf(c)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [clips]);

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

  /** Search and filters (not the game chip: Folders view groups by game itself). */
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (clips ?? []).filter((c) => {
      if (q && !`${c.name} ${c.folder} ${c.source}`.toLowerCase().includes(q)) return false;
      if (filters.where === "pc" && c.location === "nas") return false;
      if (filters.where === "nas" && !(c.onNas || c.location === "nas")) return false;
      if (filters.sources.length && !filters.sources.includes(sourceOf(c))) return false;
      const day = ymd(c.modified);
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      if (filters.minMb && c.size < filters.minMb * 1_048_576) return false;
      return true;
    });
    if (sort === "old") list.reverse();
    if (sort === "big") list.sort((a, b) => b.size - a.size);
    return list;
  }, [clips, query, filters, sort]);

  const groups = useMemo(() => {
    const want = gameKey(folder);
    const list = matching.filter((c) => folder === "All" || gameKey(c.folder) === want);
    if (sort === "big") return list.length ? [{ day: "Biggest first", ts: 0, items: list }] : [];
    const out: { day: string; ts: number; items: ClipFile[] }[] = [];
    for (const c of list) {
      const day = dayLabel(c.modified);
      if (out[out.length - 1]?.day !== day) out.push({ day, ts: c.modified, items: [] });
      out[out.length - 1].items.push(c);
    }
    return out;
  }, [matching, folder, sort]);

  /** Folders view: one per game (same game, any spelling), biggest collections first. */
  const gameFolders = useMemo(() => {
    const by = new Map<string, { name: string; items: ClipFile[] }>();
    for (const c of matching) {
      const k = gameKey(c.folder);
      if (!by.has(k)) by.set(k, { name: c.folder, items: [] });
      const f = by.get(k)!;
      if (c.location === "local") f.name = c.folder;
      f.items.push(c);
    }
    return [...by.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  }, [matching]);
  const atFolderRoot = viewMode === "folders" && folder === "All";

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
  // The date timeline only makes sense for the gallery in date order.
  const days = useMemo(
    () => (viewMode === "list" || atFolderRoot || sort === "big" ? [] : groups.map((g) => ({ key: g.day, ts: g.ts, count: g.items.length }))),
    [groups, viewMode, atFolderRoot, sort],
  );

  // Drop selections that disappeared (deleted, filtered out).
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((p) => visible.includes(p)));
      return keep.size === s.size ? s : keep;
    });
  }, [visible]);

  const selecting = selected.size > 0;
  const [previewing, setPreviewing] = useState(false);
  const [healing, setHealing] = useState(false);
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
        <h1 style={{ flex: 1 }}>{viewMode === "folders" && folder !== "All" ? folder : TITLES[mode] ?? "Clips"}</h1>
        <label className="search">
          <span className="muted" style={{ fontSize: 12 }}>
            Search
          </span>
          <input placeholder="clips, games…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="View">
          <SlidingPill />
          {(["gallery", "folders", "list"] as ViewMode[]).map((v) => (
            <button key={v} className={viewMode === v ? "on" : ""} onClick={() => setViewMode(v)}>
              {v === "gallery" ? "Gallery" : v === "folders" ? "Folders" : "List"}
            </button>
          ))}
        </div>
        <button className={`btn ${showFilters ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
          Filters{activeFilters > 0 && <span className="count">{activeFilters}</span>}
        </button>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
          <option value="big">Biggest first</option>
        </select>
        {mode === "clips" && (
          <button className="btn" onClick={openAny}>
            Open any video…
          </button>
        )}
        {damagedMode && !!clips?.length && (
          <button className="btn primary" onClick={() => setHealing(true)} title="Go through them one by one: watch what's kept, then heal or skip each">
            Review and heal ({clips.length})…
          </button>
        )}
      </div>
      {healing && clips && health && <HealReview clips={clips} health={health} onClose={() => setHealing(false)} onToast={onToast} />}
      {showFilters && (
        <div className="lib-filters">
          {mode === "clips" && (
            <div className="fgroup">
              <span className="label">Where</span>
              <SlidingPill />
              {(
                [
                  ["", "Anywhere"],
                  ["pc", "This PC"],
                  ["nas", "NAS"],
                ] as [Filters["where"], string][]
              ).map(([v, l]) => (
                <button key={v} className={`chip small ${filters.where === v ? "on" : ""}`} onClick={() => setFilters({ where: v })}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {sources.length > 1 && (
            <div className="fgroup">
              <span className="label">Made with</span>
              {sources.map(([s, n]) => (
                <button
                  key={s}
                  className={`chip small ${filters.sources.includes(s) ? "on" : ""}`}
                  onClick={() => setFilters({ sources: filters.sources.includes(s) ? filters.sources.filter((x) => x !== s) : [...filters.sources, s] })}
                >
                  {s} <small className="muted">{n}</small>
                </button>
              ))}
            </div>
          )}
          <div className="fgroup">
            <span className="label">Date</span>
            <input type="date" className="text-input date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" className="text-input date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} aria-label="To" />
          </div>
          <div className="fgroup">
            <span className="label">Size</span>
            <SlidingPill />
            {[0, 100, 500, 1024].map((mb) => (
              <button key={mb} className={`chip small ${filters.minMb === mb ? "on" : ""}`} onClick={() => setFilters({ minMb: mb })}>
                {mb === 0 ? "Any" : mb >= 1024 ? "Over 1 GB" : `Over ${mb} MB`}
              </button>
            ))}
            {activeFilters > 0 && (
              <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}
      {damagedMode && <DamagedStatus count={clips?.length ?? 0} />}
      {mode === "clips" && viewMode === "gallery" && !selecting && !query && folder === "All" && activeFilters === 0 && clips && (
        <OnThisDay clips={clips} onOpenClip={onOpen} />
      )}

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
        folders.length > 1 && !atFolderRoot && (
          <div className="chips">
            <SlidingPill />
            {folders.map((f) => (
              <button key={f} className={`chip game-chip ${f === folder ? "on" : ""}`} onClick={() => setFolder(f)}>
                {f !== "All" && <GameIcon name={f} size={16} />}
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
      ) : (atFolderRoot ? gameFolders.length === 0 : groups.length === 0) ? (
        <div className="empty">
          <strong>Nothing matches</strong>
          {activeFilters > 0 && (
            <button className="btn" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>
      ) : atFolderRoot ? (
        <div className="folder-grid">
          {gameFolders.map((f) => (
            <FolderTile key={f.name} name={f.name} items={f.items} onOpen={() => setFolder(f.name)} />
          ))}
        </div>
      ) : viewMode === "list" ? (
        <div className="clip-rows">
          {groups.flatMap((g) => g.items).map((c) => (
            <ClipRow key={c.path} clip={c} selected={selected.has(c.path)} onClick={clickCard(c.path)} damage={health?.[c.path]} nasOn={nasOn} />
          ))}
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
                    nasOn={nasOn}
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
