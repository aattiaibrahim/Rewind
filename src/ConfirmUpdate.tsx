import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Status } from "./api";

/** An in-app yes/no dialog. Focus starts on the safe choice; Escape or a click outside cancels. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Rendered on <body>, so a parent's animation or stacking can't put it behind the page.
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title">{title}</h2>
        {children}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button ref={cancelBtn} className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Things an update restart would interrupt right now (empty = safe to restart). */
export function updateInterrupts(status: Status | null): string[] {
  if (!status) return [];
  const out: string[] = [];
  if (status.recording) {
    const s = Math.floor(status.recordingSeconds);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    out.push(`You're recording (${t}). The recording stops and is saved to your clips first.`);
  }
  if (status.game) out.push(`${status.game} is open. Capture pauses for a few seconds while Hindsight restarts.`);
  return out;
}

export function ConfirmUpdate({
  version,
  reasons,
  busy,
  onConfirm,
  onCancel,
}: {
  version: string;
  reasons: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Restart to update to ${version}?`}
      confirmLabel={busy ? "Updating…" : "Save and restart"}
      cancelLabel="Later"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul className="modal-list wrap">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
        <li>The replay buffer starts empty again, so save a clip first if you want what's in it.</li>
      </ul>
      <p className="muted">Or click Later: the update installs by itself the next time Hindsight closes.</p>
    </ConfirmDialog>
  );
}
