import { useState } from "react";
import { api, codecLabel, errText, fmtDuration, Status } from "./api";

export function statusLine(s: Status | null) {
  if (!s) return "Starting…";
  if (!s.enabled) return "Paused";
  if (!s.running) return "Restarting capture…";
  return `${s.height}p${s.fps} · ${codecLabel(s.encoder)} · ${s.monitor ?? ""}`;
}

export function BufferCard({ status, hotkey }: { status: Status | null; hotkey: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = !!status?.running;
  const pct = status && status.bufferSeconds ? (status.bufferedSeconds / status.bufferSeconds) * 100 : 0;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.saveClip();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="buffer-card">
      <div className="buffer-head" style={{ color: on ? "var(--accent)" : "var(--muted)" }}>
        <span className={`dot ${on ? "on" : status?.lastError && status.enabled ? "err" : ""}`} />
        {on ? "REPLAY BUFFER ON" : status?.enabled === false ? "BUFFER PAUSED" : "BUFFER STARTING"}
      </div>
      <div className="meter" aria-hidden="true">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="buffer-meta">
        {status ? `${fmtDuration(status.bufferedSeconds)} of ${fmtDuration(status.bufferSeconds)} held` : "—"}
        <br />
        {statusLine(status)}
      </div>
      {status?.lastError && !on && status.enabled && <div className="err-text">{status.lastError}</div>}
      {err && <div className="err-text">{err}</div>}
      <button className="btn primary" disabled={!on || busy} onClick={save}>
        {busy ? "Saving…" : `Save clip · ${hotkey}`}
      </button>
    </div>
  );
}
