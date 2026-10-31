// Browser preview mode (dev only): when the UI runs in a normal browser
// instead of inside Rewind, fake the backend with sample clips so the
// interface can be clicked through without touching real files.

type Clip = { path: string; name: string; folder: string; size: number; modified: number; external: boolean };

export function installDevMock() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return; // real app

  const now = Date.now();
  const day = 86_400_000;
  let clips: Clip[] = [
    ["VALORANT", "Ace on Ascent", 0.1, 61],
    ["VALORANT", "1v3 clutch", 0.2, 48],
    ["Apex Legends", "Final ring", 0.3, 92],
    ["Desktop", "Bug repro", 0.4, 22],
    ["VALORANT", "Ranked win", 1.1, 75],
    ["Apex Legends", "Kraber headshot", 1.2, 40],
    ["Desktop", "Desktop 2026-10-28", 2.2, 18],
  ].map(([folder, name, ago, mb]) => ({
    path: `C:\\Users\\you\\Videos\\Rewind\\${folder}\\${name}.mkv`,
    name: name as string,
    folder: folder as string,
    size: (mb as number) * 1024 * 1024,
    modified: now - (ago as number) * day,
    external: false,
  }));
  const bin: Clip[] = [];
  const settings = {
    clipsDir: "C:\\Users\\you\\Videos\\Rewind", encoder: "av1", quality: 24, fps: 60, bufferSeconds: 120,
    bufferInRam: true, captureEngine: "native", monitorMode: "primary", fixedMonitor: "", drawCursor: true, hotkey: "Alt+F10",
    recordHotkey: "Alt+F9", bufferEnabled: true, launchOnStartup: false, autoUpdate: true, startMinimized: true,
    keepOriginalAfterRemux: true, replaceOriginalOnEdit: false, externalFiles: [], desktopAudio: true,
    micEnabled: true, micMono: true, micDevice: "",
  };
  const status = {
    enabled: true, running: true, monitor: "Display 1 · 1920×1080", width: 1920, height: 1080, encoder: "av1",
    fps: 60, bufferedSeconds: 120, bufferSeconds: 120, restarts: 0, lastError: null,
    audio: ["Desktop: Headphones", "Mic (mono): USB Mic"], audioError: null, game: null, recording: false,
    recordingSeconds: 0, inRam: true, bufferMb: 410, engine: "native",
  };
  const listeners = new Map<string, number[]>();
  const callbacks = new Map<number, (e: unknown) => void>();
  let nextCb = 1;
  const emit = (event: string) =>
    (listeners.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id: 0, payload: null }));

  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    get_settings: () => settings,
    get_status: () => status,
    get_update_state: () => ({ current: "dev", stage: "up-to-date", version: null, notes: null, error: null }),
    list_clips: () => clips,
    list_monitors: () => [],
    list_audio_inputs: () => [],
    probe_file: () => ({ duration: 45, codec: "av1", width: 1920, height: 1080, fps: 60, audioTracks: 2, container: "matroska" }),
    thumbnail: () => Promise.reject("no thumbnails in preview"),
    preview_audio: () => ({
      firstTitle: "Desktop audio",
      extra: [{ index: 1, title: "Microphone", path: "C:\\Users\\you\\preview\\mic.m4a" }],
    }),
    delete_clips: (a) => {
      const paths = a.paths as string[];
      bin.push(...clips.filter((c) => paths.includes(c.path)));
      clips = clips.filter((c) => !paths.includes(c.path));
      setTimeout(() => emit("clips-changed"));
      return { deleted: paths, failed: [] };
    },
    restore_clips: (a) => {
      const paths = a.paths as string[];
      const back = bin.filter((c) => paths.includes(c.path));
      clips = [...clips, ...back].sort((x, y) => y.modified - x.modified);
      setTimeout(() => emit("clips-changed"));
      return back.length;
    },
    bench_state: () => [
      false,
      {
        game: "VALORANT-Win64-Shipping",
        started: "2026-10-30 17:30",
        seconds: 30,
        cores: 16,
        error: null,
        phases: [
          { name: "No recorder", app: null, skipped: null, note: null, window: { seconds: 30, frames: { frames: 8460, avgFps: 282.1, low1Fps: 201.4, avgFrameMs: 3.54 }, apps: { rewind: { cpuPercent: 0.05, ramMb: 230, gpu3dPercent: 0, encoderPercent: 0 }, nvidia: { cpuPercent: 0.02, ramMb: 50, gpu3dPercent: 0, encoderPercent: 0 } } } },
          { name: "Rewind", app: "rewind", skipped: null, note: null, window: { seconds: 30, frames: { frames: 8391, avgFps: 279.8, low1Fps: 199.0, avgFrameMs: 3.57 }, apps: { rewind: { cpuPercent: 0.21, ramMb: 690, gpu3dPercent: 1.6, encoderPercent: 9.1 } } } },
          { name: "OBS replay buffer", app: "obs", skipped: null, note: null, window: { seconds: 30, frames: { frames: 8220, avgFps: 274.0, low1Fps: 190.2, avgFrameMs: 3.65 }, apps: { obs: { cpuPercent: 0.81, ramMb: 649, gpu3dPercent: 2.2, encoderPercent: 14.3 } } } },
          { name: "NVIDIA Instant Replay", app: "nvidia", skipped: null, note: null, window: { seconds: 30, frames: { frames: 8370, avgFps: 279.0, low1Fps: 197.5, avgFrameMs: 3.58 }, apps: { nvidia: { cpuPercent: 0.3, ramMb: 410, gpu3dPercent: 1.1, encoderPercent: 10.2 } } } },
          { name: "Medal", app: "medal", skipped: "Medal didn't start recording, so it was skipped.", note: null, window: null },
        ],
      },
    ],
    start_bench: () => null,
    cancel_bench: () => null,
    "plugin:event|listen": (a) => {
      const ev = a.event as string;
      listeners.set(ev, [...(listeners.get(ev) ?? []), a.handler as number]);
      return a.handler;
    },
    "plugin:event|unlisten": () => null,
  };

  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb: (e: unknown) => void) => {
      const id = nextCb++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    // Every sample clip plays the same generated test video (public/preview-sample.mp4).
    convertFileSrc: (p: string) =>
      p.endsWith("mic.m4a") ? "/preview-mic.m4a" : p.startsWith("C:\\Users\\you\\") ? "/preview-sample.mp4" : p,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const h = handlers[cmd];
      if (!h) {
        console.warn("[preview] no mock for", cmd);
        return null;
      }
      return h(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  console.info("[preview] Rewind UI running with fake sample clips");
}
