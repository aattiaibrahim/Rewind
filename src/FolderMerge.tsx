import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errText, MoveOutcome, SimilarFolders } from "./api";

/**
 * Games saved under more than one folder spelling ("VALORANT" here, "Valorant" on
 * the NAS). Checked when the app opens and whenever the clips or settings change
 * (a NAS sync that brings new folders sends clips-changed).
 */
export function useSimilarFolders() {
  const [list, setList] = useState<SimilarFolders[]>([]);
  const refresh = useCallback(() => {
    api.similarGameFolders().then(setList).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const a = listen("clips-changed", refresh);
    const b = listen("settings-changed", refresh);
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, [refresh]);
  return [list, refresh] as const;
}

/** Keys we've already popped a notice for this session, so it says so once per game. */
export function useNewSimilar(list: SimilarFolders[], notify: (games: SimilarFolders[]) => void) {
  const told = useRef(new Set<string>());
  useEffect(() => {
    const fresh = list.filter((s) => !told.current.has(s.key));
    if (!fresh.length) return;
    fresh.forEach((s) => told.current.add(s.key));
    notify(fresh);
  }, [list, notify]);
}

export function spellings(s: SimilarFolders) {
  return s.names.map((n) => `“${n.name}”`).join(" and ");
}

function where(n: { here: number; nas: number }) {
  const parts = [];
  if (n.here) parts.push(`${n.here} on this PC`);
  if (n.nas) parts.push(`${n.nas} on the NAS`);
  return parts.join(", ") || "empty";
}

/** The banner at the top of the app. */
export function SimilarBanner({ list, onReview, onLater }: { list: SimilarFolders[]; onReview: () => void; onLater: () => void }) {
  const one = list.length === 1;
  return (
    <div className="update-banner" role="status">
      <span>
        <strong>
          {one ? "One game is" : `${list.length} games are`} saved under different folder names
        </strong>{" "}
        <span className="muted" style={{ whiteSpace: "pre-wrap" }}>
          {one ? spellings(list[0]) : `${spellings(list[0])}, and more`}. Merge them so each game's clips stay together.
        </span>
      </span>
      <span className="row">
        <button className="btn small" onClick={onLater}>
          Later
        </button>
        <button className="btn small primary" onClick={onReview}>
          Review…
        </button>
      </span>
    </div>
  );
}

/**
 * Pick one spelling per game and merge, or keep them separate. Merging moves the
 * folders on this PC and the NAS, and can be undone like "Move into Hindsight".
 */
export function MergeDialog({
  list,
  onClose,
  onMerged,
  onError,
}: {
  list: SimilarFolders[];
  onClose: () => void;
  onMerged: (target: string, out: MoveOutcome) => void;
  onError: (msg: string) => void;
}) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  useEffect(() => {
    if (!list.length && !busy) onClose();
  }, [list, busy, onClose]);

  const merge = async (s: SimilarFolders) => {
    const target = pick[s.key] ?? s.suggested;
    setBusy(s.key);
    try {
      onMerged(target, await api.mergeGameFolders(s.key, target));
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const keep = (s: SimilarFolders) => api.keepFoldersSeparate(s.key).catch((e) => onError(errText(e)));

  return createPortal(
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal merge-modal" role="dialog" aria-modal="true" aria-labelledby="merge-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="merge-title">Same game, different folder names</h2>
        <p className="muted">
          Pick the name to keep. Hindsight moves the clips into that folder on this PC and on the NAS, and saves new clips there
          too. Nothing is overwritten, and Undo in Settings → Library puts everything back.
        </p>
        {list.map((s) => {
          const chosen = pick[s.key] ?? s.suggested;
          return (
            <div className="merge-game" key={s.key}>
              <div className="merge-names" role="radiogroup" aria-label={`Folder name for ${s.suggested}`}>
                {s.names.map((n) => (
                  <label key={n.name} className={`merge-name ${chosen === n.name ? "on" : ""}`}>
                    <input
                      type="radio"
                      name={`merge-${s.key}`}
                      checked={chosen === n.name}
                      onChange={() => setPick((p) => ({ ...p, [s.key]: n.name }))}
                      disabled={!!busy}
                    />
                    <span className="merge-label">{n.name}</span>
                    <small className="muted">{where(n)}</small>
                  </label>
                ))}
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn small" disabled={!!busy} onClick={() => keep(s)} title="Don't ask about this game again">
                  Keep separate
                </button>
                <button className="btn small primary" style={{ whiteSpace: "pre" }} disabled={!!busy} onClick={() => merge(s)}>
                  {busy === s.key ? "Merging…" : `Merge into “${chosen}”`}
                </button>
              </div>
            </div>
          );
        })}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button ref={closeBtn} className="btn" onClick={onClose} disabled={!!busy}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
