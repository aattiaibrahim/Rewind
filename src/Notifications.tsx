import { useState } from "react";
import { Icon, IconName } from "./icons";

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

const KIND_ICON: Record<NoticeKind, IconName> = { update: "download", folders: "folders", damaged: "damaged", dupes: "copy", sort: "cleanup", nas: "nas" };

function KindIcon({ kind }: { kind: NoticeKind }) {
  return (
    <span className={`notif-icon ${kind}`} aria-hidden="true">
      <Icon name={KIND_ICON[kind]} size={18} />
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
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
