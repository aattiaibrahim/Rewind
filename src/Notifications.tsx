import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type Notice = {
  /** Stable while the notice says the same thing; hiding it hides this id. */
  id: string;
  title: string;
  detail?: string;
  tone?: "info" | "warn" | "good";
  actions?: { label: string; run: () => void; primary?: boolean }[];
};

const KEY = "rewind.noticesHidden";

function loadHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

/**
 * The notification center: one bell in the sidebar instead of banners across
 * the top. Shows a count of what's new; the panel lists each notice with its
 * actions and a Hide (remembered until the notice changes).
 */
export function Notifications({ notices }: { notices: Notice[] }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string[]>(loadHidden);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = notices.filter((n) => !hidden.includes(n.id));
  const hide = (id: string) => {
    const next = [...hidden.filter((h) => notices.some((n) => n.id === h)), id];
    setHidden(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* only remembered for this session */
    }
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const r = btn.current?.getBoundingClientRect();
  return (
    <>
      <button ref={btn} className={`nav-item notif-btn ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        Notifications
        {shown.length > 0 && <span className="nav-badge notif-count">{shown.length}</span>}
      </button>
      {open &&
        createPortal(
          <div className="notif-backdrop" onClick={() => setOpen(false)}>
            <div
              className="notif-panel"
              role="dialog"
              aria-label="Notifications"
              style={{ left: (r?.right ?? 220) + 10, top: Math.max(12, (r?.top ?? 60) - 8) }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="notif-head">
                <strong>Notifications</strong>
                {hidden.length > 0 && (
                  <button
                    className="btn small"
                    onClick={() => {
                      setHidden([]);
                      try {
                        localStorage.removeItem(KEY);
                      } catch {
                        /* ignore */
                      }
                    }}
                    title="Show hidden notices again"
                  >
                    Show hidden
                  </button>
                )}
              </div>
              {shown.length === 0 ? (
                <p className="muted notif-empty">You're all caught up.</p>
              ) : (
                shown.map((n) => (
                  <div key={n.id} className={`notif ${n.tone ?? "info"}`}>
                    <strong>{n.title}</strong>
                    {n.detail && <small>{n.detail}</small>}
                    <div className="row notif-actions">
                      {n.actions?.map((a) => (
                        <button
                          key={a.label}
                          className={`btn small ${a.primary ? "primary" : ""}`}
                          onClick={() => {
                            setOpen(false);
                            a.run();
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                      <span style={{ flex: 1 }} />
                      <button className="btn small notif-hide" onClick={() => hide(n.id)} title="Hide this until it changes">
                        Hide
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
