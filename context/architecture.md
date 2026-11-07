# Architecture

## Desktop app

**Frontend (`src/`, React + TypeScript, Vite):**
- `App.tsx`: the shell (icon rail, main panel, `StatusBar`) and the view switch.
  - Views: clips, local, synced, totrim, damaged, cleanup, montage, notifications, studio, performance, settings.
  - It also builds every notice for the Notifications page (`notices` with a `kind`) and the To trim list (`trimClips`).
- `Library.tsx`: every clip list (gallery, folders, list; modes clips, local, synced, totrim, damaged).
  - It stays mounted while Studio is open (`active` prop), so going back is instant.
- `Studio.tsx`: the editor (player, timeline, `AudioLanes`, side panel with exports and Share).
  - Theater mode is per visit only.
- `api.ts`: every `invoke` wrapper and shared type.
  - Thumbnails and probes go through a LIFO limiter (`limited`). `thumbNow` gives already-loaded thumbnails synchronously.
- `hooks.ts`: `useThumb`, `useNearView` (lazy cards), `useAppearance` (theme and accent attributes on `<html>`).
- `devMock.ts`: fake backend for the browser preview. **Every new Tauri command needs a mock entry** that returns the right shape; an undefined result has crashed the page before.
- `icons.tsx`: the one icon set (Lucide). `StatusBar.tsx`: the bottom bar. `Notifications.tsx`: the page and hidden-state hook.
- Other views: `Cleanup`, `Montage`, `SettingsView` and `LibrarySettings`, `HealReview`, `GameSort` (AI suggestions), `FolderMerge`, `OldFolder`, `Share`, `About` (with `BETA_TESTERS`).

**Backend (`src-tauri/src/`, Rust):**
- `lib.rs` has all the `#[tauri::command]`s (about 75) and the startup threads.
- **Recording:**
  - `engine.rs`: the replay buffer and recorder.
  - `native/`: WGC capture → GPU convert → NVENC → RAM ring.
  - `nvenc.rs` has `effective_encoder("auto")`: AV1, else HEVC, else H.264.
- **Audio:**
  - `audio.rs`: capture.
  - `app_audio.rs`: per-app loopback (Discord on its own track).
  - `audio_edit.rs`: waveforms and volume or mute edits.
- **Library:**
  - `library.rs`: listing, probing, thumbnails, and trim, export, compress, remux, MP3.
  - `prepare.rs`: probe cache, background thumbnails, and audio prepared ahead for the 30 newest clips.
- **Damage:** `health.rs` checks for damage, cuts a clip to its good part (`heal`) and re-encodes it (`repair`).
- **NAS sync (`nas.rs`):**
  - Copies are verified with SHA-256 read back uncached, then remembered in `nas-verified.txt`.
  - Edits replace the NAS copy, and the old one moves to `.hindsight-replaced/<date>/`.
  - Nothing runs while a game is running.
- **Tidying:**
  - `consolidate.rs`: "Move into Hindsight", logged so it can be undone.
  - `folder_merge.rs`: one game under several folder spellings. `folder_key` uses the tidy program name.
  - `old_folders.rs`: emptied recorder folders, sent to the Recycle Bin after a re-check.
  - `duplicates.rs`.
- **Games:**
  - `games.rs`: which game is in front, `tidy_program_name`, `game_running()`.
  - `game_icons.rs`: Steam icon lookup (strict `same_game` match and `STEAM_ALIASES`), custom logos, and the exe icon as a fallback.
  - `game_detect.rs`: the optional CLIP image model through ONNX Runtime. The pack is on the `ai-pack-v1` release.
- **Other:**
  - `montage.rs`, `upload.rs` (Catbox, Litterbox, Streamable, Discord), `updater.rs`, `control.rs` (Stream Deck API), `diag.rs` (the `log!` macro and diagnostics report), `settings.rs` (serde default, camelCase; validation in `sanitized()`).

## Where data lives on a PC
- **Settings:** `%APPDATA%\com.rewind.app\settings.json`. Move logs go in `moves\*.jsonl`, plus `edited.json`, `health.json`, `probes.json` and the `ai\` model pack.
- **Cache:** `%LOCALAPPDATA%\com.rewind.app\`: `thumbs\`, `preview\` (waveforms, extra audio tracks), `icons\` (`*.steam2.jpg`, `*.png`, `*.custom.*`, miss markers).
- **Installed app:** `%LOCALAPPDATA%\Rewind\rewind.exe`, with ffmpeg in `ffmpeg\`.
- **Clips:** `Videos\Rewind\<Game>\` by default, plus `Edits\`, `exports\` and `Montages\`.

## NAS app (`server/`, Node, plain JS, ffmpeg)
- `src/server.js` (routes), `library.js`, `media.js` (playback and thumbnails), `cleanup.js`, `montage.js`, `share.js`, `edit.js` (editor), `logos.js` (Steam logos), `notices.js`, `state.js`, `store.js`.
- `public/` holds the UI: `app.js`, `editor.js`, `montage.js`, `ui.js`, `icons.js` and `style.css`.
- Tests are in `test/` (`node --test`). The image is `ghcr.io/aattiaibrahim/hindsight-server`. The old `rewind-server` is no longer published.

## Website (`docs/`, GitHub Pages from main/docs)
- Files: `index.html`, `changelog.html` (built from the GitHub releases API), `site.css`, `site.js` (live facts and changelog), `img/` (`demo.mp4` and screenshots), `fonts/` (Geist, Archivo).
- `docs/screenshots/` holds the copies `README.md` uses.

## Other
- `streamdeck/`: the Stream Deck plugin.
- `scripts/`: `release.ps1`, `package-streamdeck.ps1`, `get-ffmpeg.ps1`, `screenshots.mjs`, `demo-video.mjs`.
- `benchmarks/`: performance test results.
