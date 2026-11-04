import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, fmtSize, NasState } from "./api";

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
