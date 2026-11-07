import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipFile, fmtSize, mediaSrc } from "./api";
import { useThumb } from "./hooks";

/**
 * Look through the clips you're about to delete, one at a time: arrows,
 * ← / → keys, or swipe. "Keep this one" takes a clip out of the selection.
 */
export function DeletePreview({
  clips,
  onKeep,
  onDelete,
  onClose,
}: {
  clips: ClipFile[];
  /** Take this clip out of the selection */
  onKeep: (path: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const n = clips.length;
  const at = Math.min(i, Math.max(0, n - 1));
  const clip = clips[at];
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
  // Nothing left to delete (all kept): close.
  useEffect(() => {
    if (n === 0) onClose();
  }, [n, onClose]);

  // Swipe: a sideways drag of 60 px or more moves one clip.
  const start = useRef<number | null>(null);
  if (!clip) return null;
  const when = new Date(clip.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal del-preview" role="dialog" aria-modal="true" aria-label="Clips you're deleting" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ flex: 1 }}>
            Deleting {n} clip{n === 1 ? "" : "s"}
          </h2>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {at + 1} / {n}
          </span>
        </div>
        <div
          className="del-stage"
          onPointerDown={(e) => {
            // Dragging the video's own seek bar with the mouse isn't a swipe.
            start.current = e.pointerType === "mouse" && (e.target as HTMLElement).tagName === "VIDEO" ? null : e.clientX;
          }}
          onPointerUp={(e) => {
            if (start.current == null) return;
            const dx = e.clientX - start.current;
            start.current = null;
            if (Math.abs(dx) >= 60) go(dx < 0 ? 1 : -1);
          }}
        >
          <Slide key={clip.path} clip={clip} />
          <button className="del-nav prev round" aria-label="Previous clip (←)" disabled={at === 0} onClick={() => go(-1)}>
            ‹
          </button>
          <button className="del-nav next round" aria-label="Next clip (→)" disabled={at >= n - 1} onClick={() => go(1)}>
            ›
          </button>
        </div>
        <div className="row del-meta">
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong className="del-name" title={clip.path}>
              {clip.name}
            </strong>
            <small className="muted">
              {clip.folder} · {when} · {fmtSize(clip.size)}
            </small>
          </span>
          <button className="btn small" onClick={() => onKeep(clip.path)} title="Take this clip out of the selection">
            Keep this one
          </button>
        </div>
        <div className="del-dots" aria-hidden="true">
          {n <= 40 && clips.map((c, k) => <span key={c.path} className={k === at ? "on" : ""} onClick={() => setI(k)} />)}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>
            ← → or swipe to look through them. Deleted clips go to the Recycle Bin.
          </span>
          <button className="btn" onClick={onClose}>
            Back
          </button>
          <button className="btn danger" onClick={onDelete}>
            Delete {n}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The clip itself, muted and looping, with its thumbnail until it loads. */
function Slide({ clip }: { clip: ClipFile }) {
  const thumb = useThumb(clip.path, clip.modified);
  const [failed, setFailed] = useState(false);
  return failed ? (
    thumb ? <img className="del-media" src={thumb} alt="" /> : <div className="del-media" />
  ) : (
    <video
      className="del-media"
      src={mediaSrc(clip.path)}
      poster={thumb ?? undefined}
      autoPlay
      muted
      loop
      playsInline
      controls
      onError={() => setFailed(true)}
    />
  );
}
