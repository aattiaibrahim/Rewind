import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipFile } from "./api";
import { useNearView, useThumb } from "./hooks";

export type Memory = { label: string; years: number; clips: ClipFile[] };

const DAY = 86_400_000;

/**
 * Clips from this date in earlier years, like Immich's "On this day":
 * "1 year ago today", "2 years ago". A year with nothing on the exact day
 * falls back to that week ("This week, 1 year ago"). Newest year first.
 */
export function memoriesFor(clips: ClipFile[], now = new Date()): Memory[] {
  const out: Memory[] = [];
  const years = new Map<number, ClipFile[]>();
  for (const c of clips) {
    const d = new Date(c.modified);
    const back = now.getFullYear() - d.getFullYear();
    if (back >= 1 && back <= 20) years.set(back, [...(years.get(back) ?? []), c]);
  }
  for (const back of [...years.keys()].sort((a, b) => a - b)) {
    const list = years.get(back)!;
    const sameDay = list.filter((c) => {
      const d = new Date(c.modified);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    });
    // The same date that year, ±3 days.
    const then = new Date(now);
    then.setFullYear(now.getFullYear() - back);
    const week = list.filter((c) => Math.abs(c.modified - then.getTime()) <= 3.5 * DAY);
    const ago = `${back} year${back === 1 ? "" : "s"} ago`;
    if (sameDay.length) out.push({ label: `${ago} today`, years: back, clips: sameDay.sort((a, b) => a.modified - b.modified) });
    else if (week.length) out.push({ label: `This week, ${ago}`, years: back, clips: week.sort((a, b) => a.modified - b.modified) });
  }
  return out;
}

function MemoryCard({ m, onOpen }: { m: Memory; onOpen: () => void }) {
  const [ref, near] = useNearView<HTMLButtonElement>(".lib-page", "200px");
  const cover = m.clips[0];
  const thumb = useThumb(near ? cover.path : "", cover.modified);
  const games = [...new Set(m.clips.map((c) => c.folder))];
  return (
    <button ref={ref} className="memory-card" onClick={onOpen} title={`${m.clips.length} clip${m.clips.length === 1 ? "" : "s"}: ${games.join(", ")}`}>
      {thumb && <img src={thumb} alt="" />}
      <span className="memory-shade" />
      <span className="memory-text">
        <strong>{m.label}</strong>
        <small>
          {new Date(cover.modified).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · {m.clips.length} clip
          {m.clips.length === 1 ? "" : "s"}
        </small>
      </span>
    </button>
  );
}

/** The "On this day" strip at the top of the library (nothing when there's nothing). */
export function OnThisDay({ clips, onOpenClip }: { clips: ClipFile[]; onOpenClip: (path: string) => void }) {
  const today = new Date().toDateString();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("rewind.memoriesHidden") === today;
    } catch {
      return false;
    }
  });
  const memories = useMemo(() => memoriesFor(clips), [clips]);
  const [open, setOpen] = useState<Memory | null>(null);
  if (hidden || memories.length === 0) return null;
  return (
    <section className="memories" aria-label="On this day">
      <div className="memories-head">
        <h3>On this day</h3>
        <button
          className="btn small"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem("rewind.memoriesHidden", today);
            } catch {
              /* only hides it for today */
            }
          }}
          title="Hide until tomorrow"
        >
          Hide for today
        </button>
      </div>
      <div className="memories-row">
        {memories.map((m) => (
          <MemoryCard key={m.label} m={m} onOpen={() => setOpen(m)} />
        ))}
      </div>
      {open && <MemoryViewer memory={open} onClose={() => setOpen(null)} onOpenClip={onOpenClip} />}
    </section>
  );
}

/** Watch a memory's clips one after another: plays through, swipe or ← → to move. */
export function MemoryViewer({ memory, onClose, onOpenClip }: { memory: Memory; onClose: () => void; onOpenClip: (path: string) => void }) {
  const [i, setI] = useState(0);
  const [muted, setMuted] = useState(true);
  const n = memory.clips.length;
  const clip = memory.clips[Math.min(i, n - 1)];
  const go = useCallback((d: number) => setI((x) => Math.min(n - 1, Math.max(0, x + d))), [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);
  const start = useRef<number | null>(null);
  const when = new Date(clip.modified).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal del-preview memory-viewer" role="dialog" aria-modal="true" aria-label={memory.label} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ flex: 1 }}>{memory.label}</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {i + 1} / {n}
          </span>
        </div>
        <div
          className="del-stage"
          onPointerDown={(e) => {
            start.current = e.pointerType === "mouse" && (e.target as HTMLElement).tagName === "VIDEO" ? null : e.clientX;
          }}
          onPointerUp={(e) => {
            if (start.current == null) return;
            const dx = e.clientX - start.current;
            start.current = null;
            if (Math.abs(dx) >= 60) go(dx < 0 ? 1 : -1);
          }}
        >
          <MemorySlide key={clip.path} clip={clip} muted={muted} onEnded={() => (i < n - 1 ? go(1) : undefined)} />
          <button className="del-nav prev round" aria-label="Previous clip (←)" disabled={i === 0} onClick={() => go(-1)}>
            ‹
          </button>
          <button className="del-nav next round" aria-label="Next clip (→)" disabled={i >= n - 1} onClick={() => go(1)}>
            ›
          </button>
        </div>
        <div className="row del-meta">
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong className="del-name" title={clip.path}>
              {clip.name}
            </strong>
            <small className="muted">
              {clip.folder} · {when}
            </small>
          </span>
          <button className="btn small" onClick={() => setMuted((m) => !m)}>
            {muted ? "Sound on" : "Mute"}
          </button>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>
            Plays straight through. ← → or swipe to move.
          </span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onClose();
              onOpenClip(clip.path);
            }}
          >
            Open in editor
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MemorySlide({ clip, muted, onEnded }: { clip: ClipFile; muted: boolean; onEnded: () => void }) {
  const thumb = useThumb(clip.path, clip.modified);
  const [failed, setFailed] = useState(false);
  if (failed) return thumb ? <img className="del-media" src={thumb} alt="" /> : <div className="del-media" />;
  return (
    <video
      className="del-media"
      src={convertFileSrc(clip.path)}
      poster={thumb ?? undefined}
      autoPlay
      muted={muted}
      playsInline
      controls
      onEnded={onEnded}
      onError={() => setFailed(true)}
    />
  );
}
