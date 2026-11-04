import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, ClipFile, errText, fmtTime, Health, HealthProgress } from "./api";

/** Health results for the clips on screen (only ones already checked). */
export function useHealth(clips: ClipFile[] | null) {
  const [health, setHealth] = useState<Record<string, Health>>({});
  useEffect(() => {
    if (!clips?.length) return;
    const paths = clips.map((c) => c.path);
    const load = () => api.clipHealth(paths).then(setHealth).catch(() => {});
    load();
    // New results arrive as the background check goes (it re-emits clips-changed on damage).
    const t = setInterval(load, 60_000);
    const un = listen("clips-changed", load);
    return () => {
      clearInterval(t);
      un.then((f) => f());
    };
  }, [clips]);
  return health;
}

export function damagedText(h: Health) {
  if (h.state === "unreadable") return "This file can't be read at all.";
  const parts = h.damaged.map(([a, b]) => `${fmtTime(a).replace(/\.\d+$/, "")}–${fmtTime(Math.min(b, h.duration)).replace(/\.\d+$/, "")}`);
  return `Damaged: ${parts.join(", ")} won't play properly.`;
}

/** Studio: what's wrong, and a one-click rescue of the good part. */
export function HealthNotice({ path, health, onRescued }: { path: string; health: Health | undefined; onRescued: (p: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!health || health.state === "ok") return null;
  const best = health.best;
  const rescue = async () => {
    setBusy(true);
    setErr(null);
    try {
      onRescued(await api.rescueClip(path));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="health-notice">
      <strong>⚠ {damagedText(health)}</strong>
      <small>
        The file was already like this when it was saved (it's common with NVIDIA and OBS MP4s after a driver hiccup or a
        crash). Hindsight's own clips are saved as MKV, which survives crashes, so they're far less likely to be hit.
      </small>
      {best && (
        <button className="btn small" disabled={busy} onClick={rescue} title="Copies the good part into a new file. Nothing is re-encoded and the original stays.">
          {busy
            ? "Rescuing…"
            : `Rescue the good part (${fmtTime(best[0]).replace(/\.\d+$/, "")}–${fmtTime(best[1]).replace(/\.\d+$/, "")})`}
        </button>
      )}
      {err && <small className="err-text">{err}</small>}
    </div>
  );
}

/** How far the background check has got, as one plain line. */
function statusText(p: HealthProgress | null, on = true) {
  if (!on) return "Off.";
  if (!p || !p.total) return "Starting…";
  if (p.checked >= p.total)
    return `All ${p.total} clips checked${p.damaged ? `, ${p.damaged} damaged (marked in your library)` : ", none damaged"}.`;
  return `${p.checked} of ${p.total} checked${p.damaged ? `, ${p.damaged} damaged so far` : ""}${p.paused ? " · paused while you play" : ""}.`;
}

function useHealthProgress() {
  const [p, setP] = useState<HealthProgress | null>(null);
  useEffect(() => {
    const load = () => api.healthProgress().then(setP).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return p;
}

/** Top of the Damaged section: what it is, and where the check is up to. */
export function DamagedStatus({ count }: { count: number }) {
  const p = useHealthProgress();
  return (
    <p className="muted damaged-status">
      {count > 0
        ? "These clips won't play properly all the way through. Open one to see which part is damaged and rescue the rest into a new file. The original is never changed."
        : "Hindsight checks your clips in the background, one at a time, only while you're not gaming or recording."}{" "}
      <span className="damaged-progress">{statusText(p)}</span>
    </p>
  );
}

/** Settings → Library: the background check's switch and progress. */
export function HealthSetting({
  on,
  set,
  Toggle,
}: {
  on: boolean;
  set: (v: boolean) => void;
  Toggle: (p: { label: string; checked: boolean; onChange: (v: boolean) => void }) => React.ReactElement;
}) {
  const p = useHealthProgress();
  const status = statusText(p, on);
  return (
    <label className="setting">
      <span>
        Check clips for damage
        <small>
          Finds clips that won't play properly and offers to rescue the good part. Runs only while no game is in front, on
          the graphics card's video decoder, one clip at a time, and stops the moment a game starts.
        </small>
        <small>{status}</small>
      </span>
      <Toggle label="Check clips for damage" checked={on} onChange={set} />
    </label>
  );
}
