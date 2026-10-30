# Rewind

A lightweight replay-buffer clipper for Windows that records on your NVIDIA GPU (NVENC), with a built-in trimmer that opens any video on your PC.

## What works now

- **Replay buffer on NVENC**: AV1, HEVC or H.264, 15 s to 20 min, constant-quality mode.
- **Save clip hotkey** (default `Alt+F10`). Clips go to `Videos\Rewind\<game>\`, named after the app in front.
- **Win+P safe capture**: the monitor is re-picked within about 1 s after Win+P, a resolution change or a monitor being plugged in. Modes: follow primary, follow cursor, or one fixed monitor.
- **Tray app**: left-click opens a quick flyout (save 30 s / 60 s / full, monitor mode, last clips); right-click shows a menu. Closing the window keeps it running in the tray.
- **Launch with Windows** (starts in the tray), single instance.
- **Library**: clips grouped by day and game, with search, thumbnails, codec and length.
- **Open any video** from any folder; it shows up under "Imported".
- **Studio**: preview, drag in/out handles, a fast trim (keyframe cut, no re-encode) and an exact trim (re-encoded on the GPU).
- **Per-file tools**: remux to MP4 (only for the file you pick), export H.264 MP4, compress to 10/25/50/100 MB. Originals are never changed.

## Not yet

- **Audio**: clips are video-only for now. Desktop, mic and per-app tracks via WASAPI are next.
- Game capture mode, the in-game overlay, a multi-track editor (text, merge), HDR tone-mapping, and auto-update.

## How it works

ffmpeg's `ddagrab` captures the monitor on the GPU and feeds frames straight into NVENC, with no CPU copy. Output goes to 2-second MKV segments in a rolling ring under `%LOCALAPPDATA%\com.rewind.app\buffer`. Saving joins the newest segments without re-encoding (`-c copy`), so it is instant and lossless.

A supervisor thread (`src-tauri/src/engine.rs`) checks the monitor layout every second. If it changes, or ffmpeg exits, it starts a new capture "generation" on the right monitor. ffmpeg runs in a Windows job object, so it always dies with the app.

## Develop

Requirements: Rust, Node + pnpm, Visual Studio C++ Build Tools, an NVIDIA GPU.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\get-ffmpeg.ps1   # once: LGPL FFmpeg into vendor\
pnpm install
pnpm tauri dev
```

Build an installer with `pnpm tauri build`. It bundles FFmpeg next to the app.
