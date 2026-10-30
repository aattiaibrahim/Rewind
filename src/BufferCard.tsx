import { useState } from "react";
import { api, codecLabel, errText, fmtDuration, Status } from "./api";

export function statusLine(s: Status | null) {
  if (!s) return "Starting…";
  if (!s.running) return s.enabled ? "Restarting capture…" : "Paused";
  return `${s.height}p${s.fps} · ${codecLabel(s.encoder)} · ${s.monitor ?? ""}`;
}

export function audioLine(s: Status | null) {
  if (!s?.running) return null;
  return s.audio.length ? `Audio: ${s.audio.map((a) => a.split(":")[0]).join(" + ")}` : "No audio";
}

/** "Saving to: VALORANT" or "Saving to: Desktop" */
export function folderLine(s: Status | null) {
  return `Clips go to: ${s?.game ?? "Desktop"}`;
}

export function RecordButton({ status, hotkey, className = "" }: { status: Status | null; hotkey: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rec = !!status?.recording;
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.toggleRecording();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className={`btn ${rec ? "rec-on" : ""} ${className}`}
        disabled={busy || (!rec && !status)}
        onClick={toggle}
        title={`Start or stop a full recording (${hotkey})`}
      >
        <span className={`rec-dot ${rec ? "on" : ""}`} aria-hidden="true" />
        {busy ? (rec ? "Saving…" : "Starting…") : rec ? `Stop · ${fmtDuration(status!.recordingSeconds)}` : `Record · ${hotkey}`}
      </button>
      {err && <div className="err-text">{err}</div>}
    </>
  );
}

export function BufferCard({ status, hotkey, recordHotkey }: { status: Status | null; hotkey: string; recordHotkey: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = !!status?.running;
  const bufferOn = on && !!status?.enabled;
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
      <div className="buffer-head" style={{ color: bufferOn ? "var(--accent)" : "var(--muted)" }}>
        <span className={`dot ${bufferOn ? "on" : status?.lastError && status.enabled ? "err" : ""}`} />
        {bufferOn ? "REPLAY BUFFER ON" : status?.enabled === false ? "BUFFER PAUSED" : "BUFFER STARTING"}
      </div>
      <div className="meter" aria-hidden="true">
        <div style={{ width: `${bufferOn ? pct : 0}%` }} />
      </div>
      <div className="buffer-meta">
        {status && bufferOn ? `${fmtDuration(status.bufferedSeconds)} of ${fmtDuration(status.bufferSeconds)} held` : "—"}
        <br />
        {statusLine(status)}
        {audioLine(status) && (
          <>
            <br />
            {audioLine(status)}
          </>
        )}
        <br />
        {folderLine(status)}
      </div>
      {status?.lastError && !on && status.enabled && <div className="err-text">{status.lastError}</div>}
      {on && status?.audioError && <div className="err-text">{status.audioError}</div>}
      {err && <div className="err-text">{err}</div>}
      <button className="btn primary" disabled={!bufferOn || busy} onClick={save}>
        {busy ? "Saving…" : `Save clip · ${hotkey}`}
      </button>
      <RecordButton status={status} hotkey={recordHotkey} />
    </div>
  );
}
