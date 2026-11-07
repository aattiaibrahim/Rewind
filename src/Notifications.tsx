import { useState } from "react";

export type NoticeKind = "update" | "folders" | "damaged" | "dupes" | "sort" | "nas";

export type Notice = {
  /** Stable while the notice says the same thing; hiding it hides this id. */
  id: string;
  kind: NoticeKind;
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

function saveHidden(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch {
    /* only remembered for this session */
  }
}

/** Which notices are hidden (remembered until a notice changes what it says). */
export function useNoticeState(notices: Notice[]) {
  const [hidden, setHidden] = useState<string[]>(loadHidden);
  const shown = notices.filter((n) => !hidden.includes(n.id));
  const set = (ids: string[]) => {
    // Forget ids no notice uses any more, so the list doesn't grow forever.
    const next = ids.filter((h) => notices.some((n) => n.id === h));
    setHidden(next);
    saveHidden(next);
  };
  return {
    shown,
    hiddenCount: notices.length - shown.length,
    hide: (id: string) => set([...hidden, id]),
    hideAll: () => set(notices.map((n) => n.id)),
    showHidden: () => set([]),
  };
}

type Group = "all" | "library" | "nas" | "updates";
const GROUP_OF: Record<NoticeKind, Group> = { update: "updates", folders: "library", damaged: "library", dupes: "library", sort: "library", nas: "nas" };
const GROUPS: [Group, string][] = [
  ["all", "All"],
  ["library", "Library"],
  ["nas", "NAS"],
  ["updates", "Updates"],
];

/** Tabler-style outline icons, one per kind of notice. */
function KindIcon({ kind }: { kind: NoticeKind }) {
  const paths: Record<NoticeKind, string[]> = {
    update: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
    folders: ["M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M8 13h8"],
    damaged: ["M12 9v4", "M12 17h.01", "M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
    dupes: ["M8 8h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z", "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"],
    sort: ["M12 3l1.9 4.6L19 9l-4 3.4L16 18l-4-2.6L8 18l1-5.6L5 9l5.1-1.4z"],
    nas: ["M4 5h16v6H4z", "M4 13h16v6H4z", "M8 8h.01", "M8 16h.01"],
  };
  return (
    <span className={`notif-icon ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {paths[kind].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}

/**
 * Notifications, as a page of their own (there can be a lot of them). One row
 * per notice with its action and an × to hide it; filters along the top.
 */
export function NotificationsPage({ state }: { state: ReturnType<typeof useNoticeState> }) {
  const [group, setGroup] = useState<Group>("all");
  const { shown, hiddenCount, hide, hideAll, showHidden } = state;
  const list = shown.filter((n) => group === "all" || GROUP_OF[n.kind] === group);
  const count = (g: Group) => shown.filter((n) => g === "all" || GROUP_OF[n.kind] === g).length;
  return (
    <div className="page notif-page">
      <div className="notif-top">
        <h1>Notifications</h1>
        <div className="notif-filters" role="tablist" aria-label="Show">
          {GROUPS.map(([g, label]) => (
            <button key={g} role="tab" aria-selected={group === g} className={`chip ${group === g ? "on" : ""}`} onClick={() => setGroup(g)}>
              {label} <span className="chip-n">{count(g)}</span>
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {hiddenCount > 0 && (
          <button className="btn small" onClick={showHidden} title="Show hidden notices again">
            Show {hiddenCount} hidden
          </button>
        )}
        {shown.length > 0 && (
          <button className="btn small" onClick={hideAll}>
            Hide all
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="notif-empty">
          <strong>You're all caught up</strong>
          <span className="muted">New things to look at show up here.</span>
        </div>
      ) : (
        <div className="notif-list">
          {list.map((n) => (
            <div key={n.id} className={`notif-row ${n.tone ?? "info"}`}>
              <KindIcon kind={n.kind} />
              <div className="notif-text">
                <strong>{n.title}</strong>
                {n.detail && <small>{n.detail}</small>}
              </div>
              <div className="notif-actions">
                {n.actions?.map((a) => (
                  <button key={a.label} className={`btn small ${a.primary ? "primary" : ""}`} onClick={a.run}>
                    {a.label}
                  </button>
                ))}
              </div>
              <button className="notif-x" onClick={() => hide(n.id)} title="Hide this until it changes" aria-label={`Hide “${n.title}”`}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
