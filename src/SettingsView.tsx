import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, bufferEstimateMb, Monitor, Settings } from "./api";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input type="checkbox" className="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
  );
}

function hotkeyFrom(e: React.KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  let key = e.code;
  if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  // A bare letter would fire while typing; require a modifier unless it's an F-key.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join("+");
}

function HotkeyInput({ value, label, onPick }: { value: string; label: string; onPick: (hk: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <div className="setting">
      <span>
        {label}
        <small>{listening ? "Press the keys now… (Esc to cancel)" : "Click, then press a combo"}</small>
      </span>
      <input
        className="text-input"
        aria-label={label}
        readOnly
        value={listening ? "…" : value}
        onFocus={() => setListening(true)}
        onBlur={() => setListening(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          if (e.key === "Escape") return (e.target as HTMLInputElement).blur();
          const hk = hotkeyFrom(e);
          if (hk) {
            onPick(hk);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export function SettingsView({
  settings,
  update,
  onError,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [mics, setMics] = useState<string[]>([]);
  useEffect(() => {
    api.listMonitors().then(setMonitors).catch(() => {});
    api.listAudioInputs().then(setMics).catch(() => {});
  }, []);

  const set = (p: Partial<Settings>) => update(p).catch((e) => onError(String(e)));
  const s = settings;

  const pickFolder = async () => {
    const dir = await open({ directory: true, title: "Where should clips be saved?", defaultPath: s.clipsDir });
    if (typeof dir === "string") set({ clipsDir: dir });
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="settings-grid">
        <section className="group">
          <h2>General</h2>
          <label className="setting">
            <span>Launch with Windows</span>
            <Toggle label="Launch with Windows" checked={s.launchOnStartup} onChange={(v) => set({ launchOnStartup: v })} />
          </label>
          <label className="setting">
            <span>
              Start in the tray when launched with Windows
              <small>The replay buffer still starts right away</small>
            </span>
            <Toggle label="Start in tray" checked={s.startMinimized} onChange={(v) => set({ startMinimized: v })} />
          </label>
          <label className="setting">
            <span>Replay buffer</span>
            <Toggle label="Replay buffer on" checked={s.bufferEnabled} onChange={(v) => set({ bufferEnabled: v })} />
          </label>
          <HotkeyInput label="Save clip hotkey" value={s.hotkey} onPick={(hk) => set({ hotkey: hk })} />
          <HotkeyInput label="Start / stop recording hotkey" value={s.recordHotkey} onPick={(hk) => set({ recordHotkey: hk })} />
        </section>

        <section className="group">
          <h2>Recording</h2>
          <label className="setting">
            <span>
              Encoder
              <small>All run on your NVIDIA GPU (NVENC)</small>
            </span>
            <select className="select" value={s.encoder} onChange={(e) => set({ encoder: e.target.value as Settings["encoder"] })}>
              <option value="av1">AV1 (smallest files)</option>
              <option value="hevc">HEVC / H.265</option>
              <option value="h264">H.264 (plays everywhere)</option>
            </select>
          </label>
          <label className="setting">
            <span>
              Quality: CQ {s.quality}
              <small>Lower = sharper and bigger. 20–26 is a good range.</small>
            </span>
            <input
              type="range"
              min={15}
              max={35}
              value={s.quality}
              aria-label="Quality"
              onChange={(e) => set({ quality: Number(e.target.value) })}
            />
          </label>
          <label className="setting">
            <span>Frame rate</span>
            <select className="select" value={s.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
              {[30, 60, 120, 144].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
          <label className="setting">
            <span>
              Keep the replay buffer in RAM
              <small>
                {s.bufferInRam
                  ? `No SSD wear. Uses about ${bufferEstimateMb(s)} MB of memory while gaming.`
                  : `Uses about ${bufferEstimateMb(s)} MB on disk and rewrites it constantly.`}
              </small>
            </span>
            <Toggle label="Buffer in RAM" checked={s.bufferInRam} onChange={(v) => set({ bufferInRam: v })} />
          </label>
          {s.bufferInRam && bufferEstimateMb(s) > 4000 && (
            <div className="err-text" style={{ padding: "4px 0" }}>
              That's a lot of memory for one buffer. Consider a shorter replay, or turn RAM off for very long buffers.
            </div>
          )}
          <label className="setting">
            <span>
              Replay length
              <small>How far back a saved clip reaches</small>
            </span>
            <select className="select" value={s.bufferSeconds} onChange={(e) => set({ bufferSeconds: Number(e.target.value) })}>
              {[15, 30, 60, 120, 180, 300, 600, 1200].map((v) => (
                <option key={v} value={v}>
                  {v < 60 ? `${v} seconds` : `${v / 60} min`}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="group">
          <h2>Audio</h2>
          <label className="setting">
            <span>
              Desktop audio
              <small>Game and app sound from your default speakers or headset (track 1)</small>
            </span>
            <Toggle label="Desktop audio" checked={s.desktopAudio} onChange={(v) => set({ desktopAudio: v })} />
          </label>
          <label className="setting">
            <span>
              Microphone
              <small>Recorded on its own track (track 2), so you can turn it down later</small>
            </span>
            <Toggle label="Microphone" checked={s.micEnabled} onChange={(v) => set({ micEnabled: v })} />
          </label>
          {s.micEnabled && (
            <>
              <label className="setting">
                <span>Mic device</span>
                <select className="select" value={s.micDevice} onChange={(e) => set({ micDevice: e.target.value })}>
                  <option value="">Windows default</option>
                  {mics.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting">
                <span>
                  Mono microphone
                  <small>Your voice in both ears instead of one side</small>
                </span>
                <Toggle label="Mono microphone" checked={s.micMono} onChange={(v) => set({ micMono: v })} />
              </label>
            </>
          )}
          <span className="muted" style={{ fontSize: 11, paddingTop: 8, lineHeight: 1.5 }}>
            Exports and Discord-size compresses mix both tracks into one so they play everywhere.
          </span>
        </section>

        <section className="group">
          <h2>Display &amp; capture</h2>
          <label className="setting">
            <span>
              Which monitor
              <small>Re-picked automatically after Win+P or plugging in a screen</small>
            </span>
            <select
              className="select"
              value={s.monitorMode}
              onChange={(e) => set({ monitorMode: e.target.value as Settings["monitorMode"] })}
            >
              <option value="primary">Follow primary</option>
              <option value="cursor">Follow my cursor</option>
              <option value="fixed">Always one monitor</option>
            </select>
          </label>
          {s.monitorMode === "fixed" && (
            <label className="setting">
              <span>Monitor</span>
              <select className="select" value={s.fixedMonitor} onChange={(e) => set({ fixedMonitor: e.target.value })}>
                <option value="">Choose…</option>
                {monitors.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name.replace("\\\\.\\", "")} · {m.width}×{m.height}
                    {m.primary ? " (primary)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="setting">
            <span>Show mouse cursor in clips</span>
            <Toggle label="Capture cursor" checked={s.drawCursor} onChange={(v) => set({ drawCursor: v })} />
          </label>
          <div className="setting">
            <span>
              Detected monitors
              <small>
                {monitors.map((m) => `${m.name.replace("\\\\.\\", "")} ${m.width}×${m.height}${m.primary ? " ★" : ""}`).join(" · ") ||
                  "—"}
              </small>
            </span>
            <button className="btn small" onClick={() => api.listMonitors().then(setMonitors)}>
              Refresh
            </button>
          </div>
        </section>

        <section className="group">
          <h2>Files</h2>
          <div className="setting">
            <span>
              Clips folder
              <small style={{ wordBreak: "break-all" }}>{s.clipsDir}</small>
            </span>
            <div className="row">
              <button className="btn small" onClick={() => api.reveal(s.clipsDir)}>
                Open
              </button>
              <button className="btn small" onClick={pickFolder}>
                Change…
              </button>
            </div>
          </div>
          <div className="setting">
            <span>
              Folders
              <small>Clips from a detected game go in a folder named after it. Everything else goes in “Desktop”.</small>
            </span>
          </div>
          <div className="setting">
            <span>
              Saved clip format
              <small>MKV survives crashes. Remux any file to MP4 when you want it.</small>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              MKV
            </span>
          </div>
          <label className="setting">
            <span>
              Keep the original after remuxing to MP4
              <small>Off sends the original to the Recycle Bin</small>
            </span>
            <Toggle
              label="Keep original after remux"
              checked={s.keepOriginalAfterRemux}
              onChange={(v) => set({ keepOriginalAfterRemux: v })}
            />
          </label>
          <label className="setting">
            <span>
              Replace the original when I save an edit
              <small>Trims, exports and compresses overwrite the file. The old one goes to the Recycle Bin.</small>
            </span>
            <Toggle
              label="Replace original on edit"
              checked={s.replaceOriginalOnEdit}
              onChange={(v) => set({ replaceOriginalOnEdit: v })}
            />
          </label>
          <div className="setting">
            <span>
              Videos opened from other folders
              <small>{s.externalFiles.length} file(s) shown under “Imported”</small>
            </span>
            <button
              className="btn small"
              disabled={!s.externalFiles.length}
              onClick={() => set({ externalFiles: [] })}
              title="Removes them from the list only. Files are not deleted."
            >
              Clear list
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
