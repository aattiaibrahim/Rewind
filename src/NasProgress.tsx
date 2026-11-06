import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, ClipFile, fmtSize, NasState } from "./api";

/** The NAS copier's state, live. */
export function useNasState() {
  const [n, setN] = useState<NasState | null>(null);
  useEffect(() => {
    api.getNasState().then(setN).catch(() => {});
    const un = listen<NasState>("nas-state", (e) => setN(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return n;
}

/** "about 1 h 20 min", "12 min", "under a minute". */
export function fmtEta(secs: number) {
  if (secs < 60) return "under a minute";
  const m = Math.round(secs / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  return `about ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Is there copying going on (or waiting) worth showing? */
export function nasBusy(n: NasState | null) {
  return !!n && n.enabled && n.reachable && n.pendingBytes > 0;
}

/**
 * Copy progress to the NAS: a bar plus clips, GB, percent, speed and time left.
 * `compact` is the sidebar version (two short lines).
 */
export function NasProgress({ n, compact = false }: { n: NasState | null; compact?: boolean }) {
  if (!n || !nasBusy(n)) return null;
  const total = n.totalBytes || n.pendingBytes;
  const done = n.totalBytes ? n.doneBytes : 0;
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const pctText = pct >= 10 || pct === 0 ? Math.floor(pct) : pct.toFixed(1);
  const clipsLeft = n.totalFiles ? n.totalFiles - n.doneFiles : n.pending;
  const state = n.paused
    ? "Paused while you play"
    : n.checking
      ? "Checking the copy"
      : n.copying
        ? `Copying`
        : "Waiting";
  const speed = !n.paused && n.rate > 0 ? `${fmtSize(n.rate)}/s` : null;
  const eta = !n.paused && n.etaSecs != null ? `${fmtEta(n.etaSecs)} left` : null;
  return (
    <div className={`nas-progress ${compact ? "compact" : ""}`} role="status" aria-label="Copying to the NAS">
      <div className="nas-progress-head">
        <span>
          {compact ? "NAS: " : ""}
          {state}
        </span>
        <span className="mono">{pctText}%</span>
      </div>
      <div className="meter" aria-hidden="true">
        <div className={n.paused ? "paused" : ""} style={{ width: `${pct}%` }} />
      </div>
      <div className="nas-progress-meta">
        {fmtSize(n.pendingBytes)} left · {clipsLeft} clip{clipsLeft === 1 ? "" : "s"}
        {!compact && total ? ` · ${fmtSize(done)} of ${fmtSize(total)} copied` : ""}
        {speed && !compact ? ` · ${speed}` : ""}
        {eta ? ` · ${eta}` : ""}
      </div>
      {!compact && n.copying && !n.paused && (
        <div className="nas-progress-file muted" title={n.copying}>
          {n.checking ? "Checking " : ""}
          {n.copying}
        </div>
      )}
    </div>
  );
}

/** Where a clip stands with the NAS, for its badge. */
export function nasStatus(clip: ClipFile, nasOn: boolean): "synced" | "waiting" | "nas-only" | null {
  if (clip.location === "nas") return "nas-only";
  if (clip.onNas) return "synced";
  // Other recorders' folders aren't copied, so they get no badge.
  if (nasOn && clip.location === "local") return "waiting";
  return null;
}

const NAS_TIP = {
  synced: "Safely copied to the NAS",
  waiting: "Not on the NAS yet: it copies once you're out of game",
  "nas-only": "Only on the NAS (not on this PC)",
} as const;

/** A small NAS icon with a status mark, like iCloud's cloud icons. */
export function NasBadge({ status }: { status: ReturnType<typeof nasStatus> }) {
  if (!status) return null;
  return (
    <span className={`nas-badge ${status}`} title={NAS_TIP[status]} aria-label={NAS_TIP[status]} role="img">
      <svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true">
        {/* the NAS: a box with two drive bays and a light */}
        <rect x="1" y="2" width="13" height="12" rx="2.2" fill="currentColor" opacity="0.92" />
        <rect x="3.2" y="4.4" width="8.6" height="2.4" rx="0.8" fill="var(--nas-bg)" />
        <rect x="3.2" y="8.6" width="8.6" height="2.4" rx="0.8" fill="var(--nas-bg)" />
        <circle cx="15.2" cy="11.2" r="4.3" fill="var(--nas-mark)" stroke="var(--nas-bg)" strokeWidth="1.4" />
        {status === "synced" && <path d="M13.3 11.3l1.3 1.3 2.4-2.6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        {status === "waiting" && <path d="M13.3 11.2h3.8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />}
        {status === "nas-only" && <path d="M15.2 9.3v3.5M13.7 11.5l1.5 1.5 1.5-1.5" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </span>
  );
}
