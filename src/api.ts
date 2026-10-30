import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type Encoder = "av1" | "hevc" | "h264";
export type MonitorMode = "primary" | "cursor" | "fixed";

export type Settings = {
  clipsDir: string;
  encoder: Encoder;
  quality: number;
  fps: number;
  outputHeight: number;
  bufferSeconds: number;
  bufferInRam: boolean;
  captureEngine: "native" | "ffmpeg";
  monitorMode: MonitorMode;
  fixedMonitor: string;
  drawCursor: boolean;
  hotkey: string;
  recordHotkey: string;
  bufferEnabled: boolean;
  launchOnStartup: boolean;
  autoUpdate: boolean;
  startMinimized: boolean;
  keepOriginalAfterRemux: boolean;
  replaceOriginalOnEdit: boolean;
  externalFiles: string[];
  desktopAudio: boolean;
  micEnabled: boolean;
  micMono: boolean;
  micDevice: string;
};

export type Status = {
  enabled: boolean;
  running: boolean;
  monitor: string | null;
  width: number;
  height: number;
  encoder: string;
  fps: number;
  bufferedSeconds: number;
  bufferSeconds: number;
  restarts: number;
  lastError: string | null;
  audio: string[];
  audioError: string | null;
  game: string | null;
  recording: boolean;
  recordingSeconds: number;
  inRam: boolean;
  bufferMb: number;
  engine: "native" | "ffmpeg";
};

export type UpdateState = {
  current: string;
  stage: "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error" | "";
  version: string | null;
  notes: string | null;
  error: string | null;
};

export type PreviewAudio = { firstTitle: string; extra: { index: number; title: string; path: string }[] };

export type DeleteResult ={ deleted: string[]; failed: [string, string][] };

export type ClipFile = {
  path: string;
  name: string;
  folder: string;
  size: number;
  modified: number;
  external: boolean;
};

export type Probe = {
  duration: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  audioTracks: number;
  container: string;
};

export type Monitor = {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
};

// Thumbnails and probes spawn ffmpeg, so only run a few at a time.
const MAX_JOBS = 3;
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_JOBS) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const thumbCache = new Map<string, Promise<string>>();
const probeCache = new Map<string, Promise<Probe>>();

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  getStatus: () => invoke<Status>("get_status"),
  restartCapture: () => invoke<void>("restart_capture"),
  listMonitors: () => invoke<Monitor[]>("list_monitors"),
  saveClip: (seconds?: number) => invoke<string>("save_clip", { seconds: seconds ?? null }),
  toggleRecording: () => invoke<string | null>("toggle_recording"),
  listClips: () => invoke<ClipFile[]>("list_clips"),
  probe: (path: string, key = "") => {
    const k = path + key;
    if (!probeCache.has(k)) {
      const p = limited(() => invoke<Probe>("probe_file", { path }));
      p.catch(() => probeCache.delete(k));
      probeCache.set(k, p);
    }
    return probeCache.get(k)!;
  },
  thumbnail: (path: string, key = "") => {
    const k = path + key;
    if (!thumbCache.has(k)) {
      const p = limited(() => invoke<string>("thumbnail", { path })).then(convertFileSrc);
      p.catch(() => thumbCache.delete(k));
      thumbCache.set(k, p);
    }
    return thumbCache.get(k)!;
  },
  previewAudio: (path: string) => invoke<PreviewAudio>("preview_audio", { path }),
  remuxMp4: (path: string) => invoke<string>("remux_mp4", { path }),
  trim: (path: string, start: number, end: number, exact: boolean, replace = false) =>
    invoke<string>("trim_clip", { path, start, end, exact, replace }),
  exportH264: (path: string, replace = false) => invoke<string>("export_h264", { path, replace }),
  compress: (path: string, targetMb: number, replace = false) =>
    invoke<string>("compress_clip", { path, targetMb, replace }),
  listAudioInputs: () => invoke<string[]>("list_audio_inputs"),
  reveal: (path: string) => invoke<void>("reveal_file", { path }),
  deleteClips: (paths: string[]) => invoke<DeleteResult>("delete_clips", { paths }),
  restoreClips: (paths: string[]) => invoke<number>("restore_clips", { paths }),
  addExternal: (paths: string[]) => invoke<void>("add_external_files", { paths }),
  removeExternal: (path: string) => invoke<void>("remove_external_file", { path }),
  openInStudio: (path: string) => invoke<void>("open_in_studio", { path }),
  showMain: () => invoke<void>("show_main_window"),
  hideFlyout: () => invoke<void>("hide_flyout"),
  getUpdateState: () => invoke<UpdateState>("get_update_state"),
  checkForUpdates: () => invoke<string | null>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),
};

export const VIDEO_EXTENSIONS = ["mkv", "mp4", "mov", "webm", "m4v", "avi", "ts", "flv"];

export function fmtDuration(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m.toString().padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

export function fmtSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function codecLabel(codec: string) {
  return ({ av1: "AV1", hevc: "HEVC", h264: "H.264", vp9: "VP9" } as Record<string, string>)[codec] ?? codec.toUpperCase();
}

export function errText(e: unknown) {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Rough RAM-free disk use of the buffer, for the settings hint (MB). */
export function bufferEstimateMb(s: Pick<Settings, "bufferSeconds" | "quality" | "encoder">) {
  const base = { av1: 22, hevc: 28, h264: 40 }[s.encoder]; // Mbps at CQ 20, busy 1440p60 game
  const mbps = base * Math.pow(0.88, s.quality - 20);
  return Math.round((mbps * s.bufferSeconds) / 8);
}
