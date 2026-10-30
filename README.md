# Rewind

A lightweight replay-buffer clipper for Windows that records on your NVIDIA GPU (NVENC), with a built-in trimmer that opens any video on your PC.

## What works now

- **Replay buffer on NVENC**: AV1, HEVC or H.264, 15 s to 20 min, constant-quality mode.
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

- RAM buffer option, per-game profiles, per-app audio tracks, the in-game overlay, a multi-track editor (text, merge), HDR tone-mapping, and auto-update.

## How it works

ffmpeg's `ddagrab` captures the monitor on the GPU and feeds frames straight into NVENC, with no CPU copy. Output goes to 2-second MKV segments in a rolling ring under `%LOCALAPPDATA%\com.rewind.app\buffer`. Saving joins the newest segments without re-encoding (`-c copy`), so it is instant and lossless.

A supervisor thread (`src-tauri/src/engine.rs`) checks the monitor layout every second. If it changes, or ffmpeg exits, it starts a new capture "generation" on the right monitor. ffmpeg runs in a Windows job object, so it always dies with the app.

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
