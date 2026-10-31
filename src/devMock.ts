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
    thumbnail: (a) => `/preview-thumb-${((a.path as string).length % 3) + 1}.jpg`,
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
    bench_state: () => [false, sampleBenchReport()],
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

// A believable 3-round result so the Performance page can be laid out in preview.
function sampleBenchReport() {
  const st = (mean: number, sd: number, n = 3) => ({ mean, sd, n, ci95: n > 1 ? ((n === 2 ? 12.706 : 4.303) * sd) / Math.sqrt(n) : null });
  const fr = (fps: number, gpu = 0.96) => ({
    frames: Math.round(fps * 20), avgFps: fps, low1Fps: fps * 0.71, avgFrameMs: 1000 / fps,
    gpuBusyMs: (1000 / fps) * gpu, cpuBusyMs: (1000 / fps) * 0.55, syncInterval: 0, presentMode: "Hardware: Independent Flip",
  });
  const orders = [["obs", "rewind", "medal", "nvidia"], ["rewind", "nvidia", "obs", "medal"], ["nvidia", "medal", "rewind", "obs"]];
  const hit: Record<string, number> = { rewind: 0.004, obs: 0.021, nvidia: 0.009, medal: 0.017 };
  const runs: unknown[] = [];
  let t = 0;
  let base = 282;
  const push = (round: number, app: string | null, fps: number, excluded: string | null = null) => {
    runs.push({ round, app, atSecs: t, frames: fr(fps), apps: {}, excluded });
    t += 34;
  };
  push(1, null, base);
  orders.forEach((order, ri) =>
    order.forEach((app, ai) => {
      if (app === "medal" && ri === 2) {
        push(ri + 1, app, 0, "Medal wasn't recording for the whole run.");
      } else push(ri + 1, app, base * (1 - hit[app]) + ((ai * 7 + ri * 3) % 5) - 2);
      base -= 0.35;
      push(ri + 1, null, base + ((ai * 5 + ri) % 3) - 1);
    }),
  );
  return {
    game: "VALORANT-Win64-Shipping", started: "2026-10-30 21:10", seconds: 20, rounds: 3, cores: 16, warmupSecs: 20, minutes: 17.4,
    runs,
    baseline: { runs: 13, fps: st(280.0, 1.6, 13), low1: st(198.8, 2.9, 13), noisePercent: 0.5, driftPercent: -1.5, gpuBusyShare: 0.96, cpuBusyShare: 0.55, vsync: false, presentMode: "Hardware: Independent Flip" },
    results: [
      { app: "rewind", runs: 3, fpsCost: st(0.4, 0.5), low1Cost: st(0.6, 1.2), gpuMsAdded: st(0.01, 0.01), cpuPercent: st(0.14, 0.03), gpu3dPercent: st(1.4, 0.2), encoderPercent: st(8.9, 0.4), ramMb: st(688, 4), verdict: "noMeasurableCost" },
      { app: "obs", runs: 3, fpsCost: st(2.1, 0.4), low1Cost: st(2.8, 1.1), gpuMsAdded: st(0.07, 0.01), cpuPercent: st(0.78, 0.06), gpu3dPercent: st(2.3, 0.3), encoderPercent: st(14.2, 0.6), ramMb: st(651, 9), verdict: "costs" },
      { app: "nvidia", runs: 3, fpsCost: st(0.9, 0.6), low1Cost: st(1.0, 1.4), gpuMsAdded: st(0.03, 0.01), cpuPercent: st(0.27, 0.04), gpu3dPercent: st(1.1, 0.2), encoderPercent: st(10.1, 0.5), ramMb: st(412, 6), verdict: "noMeasurableCost" },
      { app: "medal", runs: 2, fpsCost: st(1.7, 0.3, 2), low1Cost: st(2.2, 0.9, 2), gpuMsAdded: st(0.06, 0.02, 2), cpuPercent: st(1.9, 0.2, 2), gpu3dPercent: st(2.0, 0.3, 2), encoderPercent: st(11.0, 0.4, 2), ramMb: st(540, 12, 2), verdict: "noMeasurableCost" },
    ],
    settings: [
      { app: "rewind", width: 1920, height: 1080, fps: 60, codec: "AV1 (NVENC)", quality: "CQ 24", bufferSecs: 120, source: "Rewind settings" },
      { app: "obs", width: 1920, height: 1080, fps: 60, codec: "AV1 (NVENC)", quality: "CQP 16", bufferSecs: 180, source: 'OBS profile "Untitled"' },
      { app: "nvidia", width: 1920, height: 1080, fps: 60, codec: null, quality: null, bufferSecs: 180, source: "NVIDIA Instant Replay settings (codec and bitrate aren't stored where Rewind can read them)" },
      { app: "medal", width: null, height: null, fps: null, codec: "HEVC", quality: "7Mbps", bufferSecs: null, source: "Medal settings (resolution, FPS and clip length aren't stored where Rewind can read them)" },
    ],
    skipped: [],
    warnings: [
      "Rewind couldn't read Medal's resolution and frame rate. Check they match Rewind's (1920×1080 at 60 fps).",
      "1 of 25 runs failed a check and were left out (see All runs).",
    ],
    error: null,
  };
}

