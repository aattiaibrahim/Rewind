import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ClipFile, codecLabel, errText, fmtSize, fmtTime, PreviewAudio, Probe, Settings } from "./api";
import { useThumb } from "./hooks";

type Job = { label: string } | null;

function loadNumber(key: string, fallback: number) {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered */
  }
}

function save(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable: volume just isn't remembered */
  }
}

/** Speaker with 0, 1 or 2 sound waves, or a cross when muted. */
function SpeakerIcon({ level }: { level: number }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" />
      {level === 0 ? (
        <>
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          {level > 0.5 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
        </>
      )}
    </svg>
  );
}
type Result = { text: string; path?: string; err?: boolean } | null;

const Icon = {
  play: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" />
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
  exitFullscreen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </svg>
  ),
  theater: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
    </svg>
  ),
  theaterOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M15 6v12" />
    </svg>
  ),
};

/** The app window, or null in the browser preview. */
function appWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function StripItem({ clip, current, onOpen }: { clip: ClipFile; current: boolean; onOpen: (p: string) => void }) {
  const thumb = useThumb(clip.path, clip.modified);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <button
      ref={ref}
      className={`strip-item ${current ? "on" : ""}`}
      onClick={() => !current && onOpen(clip.path)}
      title={clip.path}
      aria-current={current ? "true" : undefined}
    >
      <div className="strip-thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</div>
      <span>{clip.name}</span>
    </button>
  );
}

/** Thumbnails of recent clips, to jump between them. */
function ClipStrip({ clips, current, onOpen }: { clips: ClipFile[]; current: string; onOpen: (p: string) => void }) {
  if (clips.length < 2) return null;
  return (
    <div className="strip" role="list" aria-label="Clips">
      {clips.map((c) => (
        <StripItem key={c.path} clip={c} current={c.path === current} onOpen={onOpen} />
      ))}
    </div>
  );
}

function PickerCard({ clip, onOpen }: { clip: ClipFile; onOpen: (p: string) => void }) {
  const thumb = useThumb(clip.path, clip.modified);
  const when = new Date(clip.modified).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <button className="card" onClick={() => onOpen(clip.path)} title={clip.path}>
      <div className="thumb">
        {thumb && <img src={thumb} alt="" loading="lazy" />}
        <div className="thumb-play" aria-hidden="true">{Icon.play}</div>
      </div>
      <div className="card-title">{clip.name}</div>
      <div className="card-meta">
        {clip.folder} · {when} · {fmtSize(clip.size)}
      </div>
    </button>
  );
}

export function Studio({
  path,
  clips,
  onOpen,
  onDone,
  onDelete,
  settings,
  update,
}: {
  path: string | null;
  clips: ClipFile[] | null;
  onOpen: (path: string) => void;
  onDone: () => void;
  onDelete: (paths: string[]) => Promise<boolean>;
  settings: Settings | null;
  update: (p: Partial<Settings>) => Promise<void>;
}) {
  const replace = !!settings?.replaceOriginalOnEdit;
  const [reload, setReload] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [theater, setTheater] = useState(() => loadJson("rewind.theater", false));
  // Overlay controls: shown while the pointer moves over the video, hidden after a moment of stillness.
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const idle = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setActive(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setActive(false), 2200);
  }, []);
  useEffect(() => () => window.clearTimeout(idle.current), []);
  const [info, setInfo] = useState<Probe | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(() => loadNumber("rewind.volume", 1));
  const [muted, setMutedState] = useState(() => loadNumber("rewind.muted", 0) === 1);
  const setVolume = useCallback((v: number) => {
    const clamped = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    setVolumeState(clamped);
    if (clamped > 0) setMutedState(false); // turning it up unmutes, like most players
    save("rewind.volume", clamped);
  }, []);
  const toggleMute = useCallback(() => setMutedState((m) => !m), []);
  useEffect(() => save("rewind.muted", muted ? 1 : 0), [muted]);
  // The video element only plays the first audio track; other tracks (the
  // mic) play from their own <audio> elements, kept in sync with the video.
  const [tracks, setTracks] = useState<PreviewAudio | null>(null);
  const extraAudio = useRef<Map<number, HTMLAudioElement>>(new Map());
  const [trackVol, setTrackVol] = useState<Record<string, number>>(() => loadJson("rewind.trackVolume", {}));
  const [trackMuted, setTrackMuted] = useState<Record<string, boolean>>({});
  const tv = (title: string) => trackVol[title] ?? 1;
  const setTrack = (title: string, v: number) => {
    const next = { ...trackVol, [title]: Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 };
    setTrackVol(next);
    saveJson("rewind.trackVolume", next);
    if (v > 0) setTrackMuted((m) => ({ ...m, [title]: false }));
  };
  // Keep every element's volume in step (also after it remounts for a new clip).
  useEffect(() => {
    const allMuted = muted || volume === 0;
    const v = video.current;
    if (v) {
      const first = tracks?.firstTitle ?? "Game";
      v.volume = Math.min(1, volume * tv(first));
      v.muted = allMuted || !!trackMuted[first];
    }
    tracks?.extra.forEach((t) => {
      const a = extraAudio.current.get(t.index);
      if (a) {
        a.volume = Math.min(1, volume * tv(t.title));
        a.muted = allMuted || !!trackMuted[t.title];
      }
    });
  });
  // Mirror play / pause / seek / speed from the video onto the extra tracks,
  // and nudge them back if they drift more than ~60 ms.
  const syncExtra = useCallback((hard = false) => {
    const v = video.current;
    if (!v) return;
    extraAudio.current.forEach((a) => {
      if (hard || Math.abs(a.currentTime - v.currentTime) > 0.06) a.currentTime = v.currentTime;
      a.playbackRate = v.playbackRate;
      if (v.paused && !a.paused) a.pause();
      if (!v.paused && a.paused) a.play().catch(() => {});
    });
  }, []);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [playError, setPlayError] = useState(false);
  const [job, setJob] = useState<Job>(null);
  const [result, setResult] = useState<Result>(null);
  const [targetMb, setTargetMb] = useState(10);

  useEffect(() => {
    setInfo(null);
    setPlayError(false);
    setResult(null);
    setTime(0);
    setRange([0, 0]);
    setDuration(0);
    setTracks(null);
    if (!path) return;
    let alive = true;
    api
      .previewAudio(path)
      .then((t) => alive && setTracks(t))
      .catch(() => {});
    api
      .probe(path, String(reload))
      .then((p) => {
        setInfo(p);
        setDuration((d) => d || p.duration);
        setRange((r) => (r[1] ? r : [0, p.duration]));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, reload]);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || t));
    setTime(v.currentTime);
  }, []);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= range[1] - 0.05) v.currentTime = range[0];
      v.play();
    } else v.pause();
  }, [range]);

  // Fullscreen: Rewind's window goes fullscreen and the player covers it.
  // (Not the browser Fullscreen API, which embedded web views can refuse.)
  // Esc, F or the button leave it.
  const toggleFullscreen = useCallback(() => setFullscreen((f) => !f), []);
  const wasFullscreen = useRef(false);
  useEffect(() => {
    if (fullscreen === wasFullscreen.current) return;
    wasFullscreen.current = fullscreen;
    appWindow()?.setFullscreen(fullscreen).catch(() => {});
  }, [fullscreen]);
  useEffect(
    () => () => {
      if (wasFullscreen.current) appWindow()?.setFullscreen(false).catch(() => {});
    },
    [],
  );
  const toggleTheater = useCallback(() => {
    setTheater((t: boolean) => {
      saveJson("rewind.theater", !t);
      return !t;
    });
  }, []);

  // Minimized, hidden to the tray, or covered: pause right where it is.
  useEffect(() => {
    const pause = () => video.current?.pause();
    const onVis = () => document.hidden && pause();
    document.addEventListener("visibilitychange", onVis);
    const un = listen("main-hidden", pause);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      un.then((f) => f());
    };
  }, []);

  // Keyboard: Space play, I / O set points, arrows step.
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      const v = video.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "i" || e.key === "I") setRange(([, b]) => [Math.min(v.currentTime, b - 0.1), b]);
      else if (e.key === "o" || e.key === "O") setRange(([a]) => [a, Math.max(v.currentTime, a + 0.1)]);
      else if (e.key === "ArrowLeft") seek(v.currentTime - (e.shiftKey ? 1 / 60 : 5));
      else if (e.key === "ArrowRight") seek(v.currentTime + (e.shiftKey ? 1 / 60 : 5));
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        setVolume(volume + 0.1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setVolume(volume - 0.1);
      } else if (e.key === "m" || e.key === "M") toggleMute();
      else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.altKey) toggleFullscreen();
      else if (e.key === "Escape" && fullscreen) setFullscreen(false);
      else if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.altKey && !fullscreen) toggleTheater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, toggle, seek, volume, setVolume, toggleMute, toggleFullscreen, toggleTheater, fullscreen]);

  // Dragging on the timeline: handles move in/out, anywhere else scrubs.
  const drag = (kind: "in" | "out" | "seek") => (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = bar.current;
    if (!el || !duration) return;
    el.setPointerCapture(e.pointerId);
    const at = (x: number) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration;
    };
    const apply = (x: number) => {
      const t = at(x);
      if (kind === "in") setRange(([, b]) => [Math.min(t, b - 0.1), b]);
      else if (kind === "out") setRange(([a]) => [a, Math.max(t, a + 0.1)]);
      seek(t);
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // The fullscreen progress bar: click or drag to jump.
  const scrubProgress = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const to = (x: number) => {
      const r = el.getBoundingClientRect();
      seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration);
    };
    to(e.clientX);
    const move = (ev: PointerEvent) => to(ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const run = async (label: string, fn: () => Promise<string>, replaces = false) => {
    setJob({ label });
    setResult(null);
    try {
      const out = await fn();
      onDone();
      if (replaces) {
        // The edit now lives where the original was: show it.
        video.current?.pause();
        onOpen(out);
        setReload((k) => k + 1);
        setResult({ text: `Replaced the original with your edit (old file is in the Recycle Bin).` });
        return;
      }
      setResult({ text: `Saved ${out.split("\\").pop()}`, path: out });
    } catch (e) {
      setResult({ text: errText(e), err: true });
    } finally {
      setJob(null);
    }
  };

  if (!path) {
    const recent = (clips ?? []).slice(0, 12);
    return (
      <div className="page">
        <h1>Studio</h1>
        {recent.length === 0 ? (
          <div className="empty">
            <strong>No clips yet</strong>
            <span>Save a clip with your hotkey, then edit it here.</span>
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>Pick a clip to edit. Recent clips:</p>
            <div className="grid">
              {recent.map((c) => (
                <PickerCard key={c.path} clip={c} onOpen={onOpen} />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const [a, b] = range;
  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");
  const name = path.split("\\").pop() ?? path;
  const busy = !!job;
  const wholeFile = a <= 0.01 && duration - b <= 0.05;

  return (
    <div className="studio">
      <div className="studio-top">
        <div className="studio-title" style={{ flex: 1 }} title={path}>
          {name}
        </div>
        <button
          className="btn"
          disabled={busy || wholeFile}
          title="Cuts on the nearest keyframes. Instant, no quality loss."
          onClick={() => run("Saving trim…", () => api.trim(path, a, b, false, replace), replace)}
        >
          Save trim (fast)
        </button>
        <button
          className="btn primary"
          disabled={busy || wholeFile}
          title="Frame-accurate. Re-encodes on your GPU."
          onClick={() => run("Saving exact trim…", () => api.trim(path, a, b, true, replace), replace)}
        >
          Save trim (exact)
        </button>
      </div>
      <div className={`studio-body ${theater ? "theater" : ""}`}>
        <div className="stage">
          <div
            ref={wrap}
            className={`video-wrap ${fullscreen ? "fs" : ""} ${hover && (active || !playing) ? "ui" : ""} ${fullscreen && playing && !active ? "idle" : ""}`}
            onPointerMove={() => {
              setHover(true);
              poke();
            }}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
          >
            <video
              key={`${path}#${reload}`}
              ref={video}
              src={convertFileSrc(path)}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (isFinite(d) && d > 0) {
                  setDuration(d);
                  setRange((r) => (r[1] ? r : [0, d]));
                }
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                setTime(v.currentTime);
                if (!v.paused && v.currentTime >= range[1]) v.pause();
                syncExtra();
              }}
              onPlay={() => {
                setPlaying(true);
                syncExtra(true);
              }}
              onPause={() => {
                setPlaying(false);
                syncExtra();
              }}
              onSeeked={() => syncExtra(true)}
              onRateChange={() => syncExtra()}
              onWaiting={() => extraAudio.current.forEach((a) => a.pause())}
              onPlaying={() => syncExtra(true)}
              onError={() => setPlayError(true)}
            />
            {!playError && (
              <div
                className={`vid-overlay ${playing ? "playing" : "paused"}`}
                onClick={(e) => e.target === e.currentTarget && toggle()}
                onDoubleClick={(e) => e.target === e.currentTarget && toggleFullscreen()}
              >
                <button
                  className="vid-center"
                  aria-label={playing ? "Pause" : "Play"}
                  onClick={toggle}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {playing ? Icon.pause : Icon.play}
                </button>
                <div className="vid-bar">
                  {fullscreen && (
                    <>
                      <button className="vid-btn" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
                        {playing ? Icon.pause : Icon.play}
                      </button>
                      <span className="mono vid-time">
                        {fmtTime(time)} / {fmtTime(duration)}
                      </span>
                      <div className="vid-progress" onPointerDown={scrubProgress}>
                        <div style={{ width: duration ? `${(time / duration) * 100}%` : 0 }} />
                      </div>
                    </>
                  )}
                  {!fullscreen && <span style={{ flex: 1 }} />}
                  {!fullscreen && (
                    <button
                      className="vid-btn"
                      aria-label={theater ? "Exit theater mode" : "Theater mode"}
                      title={theater ? "Exit theater mode (T)" : "Theater mode (T)"}
                      onClick={toggleTheater}
                    >
                      {theater ? Icon.theaterOff : Icon.theater}
                    </button>
                  )}
                  <button
                    className="vid-btn"
                    aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                    title={fullscreen ? "Exit fullscreen (F or Esc)" : "Fullscreen (F)"}
                    onClick={toggleFullscreen}
                  >
                    {fullscreen ? Icon.exitFullscreen : Icon.fullscreen}
                  </button>
                </div>
              </div>
            )}
            {playError && (
              <div className="video-msg">
                <strong style={{ color: "var(--text)" }}>The preview can't play this file's format</strong>
                <span>Edits still work. To preview it, make an MP4 or H.264 copy:</span>
                <div className="row">
                  <button className="btn" disabled={busy} onClick={() => run("Remuxing…", () => api.remuxMp4(path))}>
                    Remux to MP4
                  </button>
                  <button className="btn" disabled={busy} onClick={() => run("Exporting…", () => api.exportH264(path))}>
                    Export H.264
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="transport">
            <button className="round" aria-label="Back 5 seconds" onClick={() => seek(time - 5)}>
              «
            </button>
            <button className="round play" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
              {playing ? "❚❚" : "▶"}
            </button>
            <button className="round" aria-label="Forward 5 seconds" onClick={() => seek(time + 5)}>
              »
            </button>
            <span className="mono">
              {fmtTime(time)} / {fmtTime(duration)}
            </span>
            <div className="volume" role="group" aria-label="Volume">
              <button
                className="round"
                aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                aria-pressed={muted || volume === 0}
                title="Mute (M)"
                onClick={() => (volume === 0 ? setVolume(0.5) : toggleMute())}
              >
                <SpeakerIcon level={muted ? 0 : volume} />
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                aria-label="Volume"
                title="Volume (↑ / ↓)"
                value={muted ? 0 : Math.round(volume * 100)}
                onChange={(e) => setVolume(Number(e.target.value) / 100)}
                style={{ width: 96 }}
              />
              <span className="mono" style={{ width: 38, textAlign: "right" }}>
                {muted ? "Muted" : `${Math.round(volume * 100)}%`}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <button className="btn small" onClick={() => setRange(([, y]) => [Math.min(time, y - 0.1), y])}>
              Set start (I)
            </button>
            <button className="btn small" onClick={() => setRange(([x]) => [x, Math.max(time, x + 0.1)])}>
              Set end (O)
            </button>
            <button className="btn small" onClick={() => setRange([0, duration])}>
              Reset
            </button>
          </div>
          <div className="timeline" ref={bar} onPointerDown={drag("seek")}>
            <div className="tl-range" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }}>
              <div className="tl-handle in" onPointerDown={drag("in")} />
              <div className="tl-handle out" onPointerDown={drag("out")} />
            </div>
            <div className="tl-head" style={{ left: pct(time) }} />
          </div>
          <div className="tl-foot">
            <span className="mono">
              Start {fmtTime(a)} · End {fmtTime(b)} · Length {fmtTime(Math.max(0, b - a))}
            </span>
            <span>Space play · I / O set points · ← → 5 s · Shift+← → one frame · ↑ ↓ volume · M mute · T theater · F fullscreen</span>
          </div>
          {!theater && <ClipStrip clips={(clips ?? []).slice(0, 30)} current={path} onOpen={onOpen} />}
        </div>

        <aside className="side">
          <div className="label">File</div>
          <div className="facts">
            <span>Video</span>
            <span>{info ? `${codecLabel(info.codec)} · ${info.height}p${Math.round(info.fps)}` : "…"}</span>
            <span>Container</span>
            <span>{info ? info.container.split(",")[0].toUpperCase() : "…"}</span>
            <span>Audio</span>
            <span>{info ? (info.audioTracks ? `${info.audioTracks} track(s)` : "None") : "…"}</span>
            <span>Size</span>
            <span>{fmtSize(clips?.find((c) => c.path === path)?.size ?? 0)}</span>
          </div>

          {tracks && (tracks.extra.length > 0 || (info?.audioTracks ?? 0) > 0) && (
            <>
              <div className="label">Preview audio</div>
              <div className="stack">
                {[{ index: 0, title: tracks.firstTitle, path: "" }, ...tracks.extra].map((t) => {
                  const off = !!trackMuted[t.title] || tv(t.title) === 0;
                  return (
                    <div key={t.index} className="row track-row">
                      <button
                        className="round small-round"
                        aria-label={off ? `Unmute ${t.title}` : `Mute ${t.title}`}
                        aria-pressed={off}
                        onClick={() =>
                          tv(t.title) === 0 ? setTrack(t.title, 1) : setTrackMuted((m) => ({ ...m, [t.title]: !m[t.title] }))
                        }
                      >
                        <SpeakerIcon level={off ? 0 : tv(t.title)} />
                      </button>
                      <span className="track-name" title={t.title}>
                        {t.title.replace(" audio", "")}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        aria-label={`${t.title} volume`}
                        value={off ? 0 : Math.round(tv(t.title) * 100)}
                        onChange={(e) => setTrack(t.title, Number(e.target.value) / 100)}
                        style={{ flex: 1, width: 0 }}
                      />
                      <span className="mono" style={{ width: 34, textAlign: "right", fontSize: 11 }}>
                        {off ? "Off" : `${Math.round(tv(t.title) * 100)}%`}
                      </span>
                    </div>
                  );
                })}
                <span className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
                  Only changes what you hear here. Saved files keep every track as recorded.
                </span>
              </div>
              {tracks.extra.map((t) => (
                <audio
                  key={`${t.path}#${reload}`}
                  ref={(el) => {
                    if (el) extraAudio.current.set(t.index, el);
                    else extraAudio.current.delete(t.index);
                  }}
                  src={convertFileSrc(t.path)}
                  preload="auto"
                  onLoadedData={() => syncExtra(true)}
                />
              ))}
            </>
          )}
          <div className="label">This file only</div>
          <div className="stack">
            <button className="btn block" disabled={busy} onClick={() => run("Remuxing…", () => api.remuxMp4(path))}>
              Remux to MP4 (no quality loss)
            </button>
            <button
              className="btn block"
              disabled={busy}
              onClick={() => run("Exporting H.264…", () => api.exportH264(path, replace), replace)}
            >
              Export as H.264 MP4
            </button>
            <div className="row">
              <button
                className="btn block"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => run(`Compressing to ${targetMb} MB…`, () => api.compress(path, targetMb, replace), replace)}
              >
                Compress to
              </button>
              <select
                className="select"
                aria-label="Target size"
                value={targetMb}
                onChange={(e) => setTargetMb(Number(e.target.value))}
              >
                <option value={10}>10 MB</option>
                <option value={25}>25 MB</option>
                <option value={50}>50 MB</option>
                <option value={100}>100 MB</option>
              </select>
            </div>
            <button className="btn block" onClick={() => api.reveal(path)}>
              Show in Explorer
            </button>
            <button
              className="btn block"
              style={{ color: "#ffb3b3" }}
              disabled={busy}
              onClick={() => {
                video.current?.pause();
                onDelete([path]);
              }}
            >
              Delete this clip…
            </button>
          </div>
          <label className="row" style={{ fontSize: 13, color: "var(--text-2)", cursor: "pointer" }}>
            <input
              type="checkbox"
              className="switch"
              checked={replace}
              onChange={(e) => update({ replaceOriginalOnEdit: e.target.checked })}
            />
            Replace the original with my edit
          </label>
          <span className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {replace
              ? "Trims, exports and compresses overwrite this file. The old version goes to the Recycle Bin."
              : "The original is kept. Edits are saved as new files next to it."}
          </span>
          {job && <div className="result">{job.label}</div>}
          {result && (
            <div className={`result ${result.err ? "err" : ""}`}>
              {result.text}
              {result.path && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn small" onClick={() => onOpen(result.path!)}>
                    Open it
                  </button>
                  <button className="btn small" onClick={() => api.reveal(result.path!)}>
                    Show
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
