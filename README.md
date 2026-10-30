# Rewind

A lightweight replay-buffer clipper for Windows that records on your NVIDIA GPU (NVENC), with a built-in trimmer that opens any video on your PC.

**[Download the latest installer](https://github.com/aattiaibrahim/Rewind/releases/latest)**. It needs Windows 10/11 and an NVIDIA GTX 10-series or newer (AV1 needs an RTX 40/50). The installer isn't code-signed yet, so Windows SmartScreen may warn you: click **More info → Run anyway**.

## What works now

- **Replay buffer on NVENC**: AV1, HEVC or H.264, 15 s to 20 min, constant-quality mode.
- **Buffer in RAM by default**: no constant SSD writes. A disk mode remains for very long buffers.
- **Tray icon shows a red dot** while capturing, like OBS.
- **Save clip hotkey** (default `Alt+F10`). Clips from a detected game go to `Videos\Rewind\<Game>\`; everything else goes to `Videos\Rewind\Desktop\`.
- **Full recording** (default `Alt+F9`, or the Record buttons). It reuses the same capture, so there's no second encoder. A crash mid-recording is recovered on the next start, and recording stops by itself if the disk drops below 1.5 GB free.
- **Game detection**: known game exes, game-library installs (Steam, Epic, Riot, Xbox, GOG, Ubisoft, EA, Rockstar, Battle.net) and fullscreen apps. Browsers, Discord, launchers and so on count as Desktop.
- **Capture always runs at below-normal CPU priority**, so games get the CPU first.
- **Win+P safe capture**: the monitor is re-picked within about 1 s after Win+P, a resolution change or a monitor being plugged in. Modes: follow primary, follow cursor, or one fixed monitor.
- **Tray app**: left-click opens a quick flyout (save 30 s / 60 s / full, monitor mode, last clips); right-click shows a menu. Closing the window keeps it running in the tray.
- **Launch with Windows** (starts in the tray), single instance.
- **Library**: clips grouped by day and game, with search, thumbnails, codec and length.
- **Open any video** from any folder; it shows up under "Imported".
- **Studio**: preview, drag in/out handles, a fast trim (keyframe cut, no re-encode) and an exact trim (re-encoded on the GPU).
- **Per-file tools**: remux to MP4 (only for the file you pick), export H.264 MP4, compress to 10/25/50/100 MB. Originals are never changed.

- **Audio**: desktop sound (WASAPI loopback, track 1) and the microphone (mono by default, track 2), both on by default. Synced to video within about 10 ms. Exports and compresses mix both tracks into one.
- **Replace original** option: trims, exports and compresses overwrite the edited file, and the old one goes to the Recycle Bin.

## Not yet

- Per-game profiles, per-app audio tracks, the in-game overlay, a multi-track editor (text, merge), HDR tone-mapping, and auto-update.

## How it works (native engine, default)

The pipeline works the same way OBS's does. Everything stays on the NVIDIA GPU, and audio and video share one clock:

1. **Windows Graphics Capture** hands Rewind each frame as a texture on the GPU that drives the monitor.
2. **The D3D11 Video Processor** converts and resizes it to NV12 on the GPU, at any output size including 4K and 720p.
3. **NVENC, called directly** (`src-tauri/src/native/nvenc.rs`), encodes AV1/HEVC/H.264 with constant quality and a keyframe every second.
4. Encoded packets go into a **RAM ring**, stamped on the shared high-precision clock (QPC).
5. **WASAPI audio** chunks carry Windows' own capture timestamps and go into RAM rings at their exact time on the same clock. Saving cuts video and audio for the same time window, so sync is built in (measured within about ±5 ms) and can't drift.

Measured on an RTX 5080 at 1080p60: about 2.5 ms of GPU encode per frame, about 3% of one CPU core for the whole capture, and a 12 s clip saved in under 1 s. Recordings stream to disk as they go, so a crash leaves parts that are recovered on the next start.

If the native engine can't start (no NVIDIA GPU, driver problem), Rewind falls back to the FFmpeg engine below. It can also be picked under **Settings → Display & capture → Capture engine**.

## How it works (compatibility engine)

ffmpeg's `ddagrab` captures the monitor on the GPU and feeds frames straight into NVENC, with no CPU copy. Output goes to 2-second MKV segments in a rolling ring. In RAM mode, ffmpeg streams each finished segment to Rewind over localhost and nothing touches the disk. In disk mode, segments go under `%LOCALAPPDATA%\com.rewind.app\buffer`. Saving joins the newest segments without re-encoding (`-c copy`), so it is instant and lossless.

A supervisor thread (`src-tauri/src/engine.rs`) checks the monitor layout every second. If it changes, or ffmpeg exits, it starts a new capture "generation" on the right monitor. ffmpeg runs in a Windows job object, so it always dies with the app.

## Stream Deck and other tools

- **Stream Deck plugin**: download `Rewind.streamDeckPlugin` from the [latest release](https://github.com/aattiaibrahim/Rewind/releases/latest) and double-click it. It has four actions:
  - **Save Clip**: full buffer or a set length per key.
  - **Record**: turns red and shows the timer.
  - **Replay Buffer**: on/off.
  - **Clip Quality**: switches resolution and quality per key, e.g. "1080p High" or "4K Max".
- **No plugin needed**: Stream Deck's built-in *Hotkey* action works with `Alt+F10` / `Alt+F9`, or run `Rewind.exe --save-clip [seconds]`, `--toggle-record` or `--toggle-buffer`.
- **Local API** (127.0.0.1:52371 only, header `X-Rewind: 1` required): `GET /status`, `POST /save?seconds=30`, `POST /record/toggle`, `POST /buffer/toggle`, `POST /quality?height=1080&cq=22`.

## Quality

Clip resolution can be **same as screen** (captured fully on the GPU), 4K, 1440p, 1080p or 720p. A different size is resized on the CPU, at about 1–5% CPU. Quality presets are Small / Balanced / High / Max, with a CQ slider for fine-tuning.

## Safety

- An edit only replaces the original after the new file is checked: it must be non-empty, readable and about the right length. The original goes to the Recycle Bin, never straight to deletion.
- Settings are written atomically. A corrupted settings file falls back to defaults and is kept as `settings.json.bak`.
- Settings values are clamped to usable ranges. If a hotkey can't be registered, the previous one is restored.
- Clip names never overwrite an existing file. Saving needs at least 300 MB free.
- ffmpeg runs in a job object, so it can't outlive the app.

## Tests

```powershell
cd src-tauri
cargo test                                   # unit + file-tool tests (needs an NVIDIA GPU)
cargo test live_ -- --ignored --nocapture    # real capture: buffer, clip, recording, recovery
```

## Develop

Requirements: Rust, Node + pnpm, Visual Studio C++ Build Tools, an NVIDIA GPU.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\get-ffmpeg.ps1   # once: LGPL FFmpeg into vendor\
pnpm install
pnpm tauri dev
```

Build an installer with `pnpm tauri build`. It bundles FFmpeg next to the app.

## License notes

Rewind bundles an LGPL build of FFmpeg. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
