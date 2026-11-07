# Workflows

## Build and test
- **Frontend:** `npx tsc --noEmit -p .` (type check), `npm run build`.
- **Rust:** `cd src-tauri && cargo test --lib -- --test-threads=1`.
  - Run tests one at a time: NVENC limits how many sessions can be open, and the user's own copy may be running.
  - Live checks are ignored by default, for example `cargo test --lib live_game_icons -- --ignored --nocapture`.
- **Server:** `cd server && node --test`.
- Never play sound in tests or previews (the user is at the desk).

## Preview (browser pane, uses `devMock.ts`)
- The launch configs are in `C:\Users\Admin\Desktop\.claude\launch.json`:
  - `rewind-ui` (Vite on 1420);
  - `hindsight-docs` (the website on 8434);
  - `hindsight-server-local` (server on 8421).
- The pane is often hidden, so screenshots time out. Use `javascript_tool`, `find` and `read_page`, or the scripts below.

## Screenshots and the demo video (headless Chrome, sharp)
- `node scripts/screenshots.mjs <outDir>` with `rewind-ui` running gives `library`, `studio`, `totrim`, `notifications` and `appearance` at 2000×1175 (1400×822 at 1.43x).
- `node scripts/demo-video.mjs <framesDir>` records library → open clip → start and end → Save trim, at about 13.5 fps.
- **Encoding the demo:** the bundled ffmpeg (`%LOCALAPPDATA%\Rewind\ffmpeg\ffmpeg.exe`) has **no libx264**; use `-c:v h264_nvenc -preset p7 -rc vbr -cq 26 -b:v 0`.
- Website images go in `docs/img/`; README copies go in `docs/screenshots/`.

## Releasing the desktop app (only after the user says yes)
1. **Bump the version** in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (UTF-8 without BOM, so write it through PowerShell `UTF8Encoding($false)`), then run `cd src-tauri && cargo update -p rewind --offline`.
2. **Commit** with `git commit -F <file>` and the `Co-Authored-By` trailer, then push main.
3. **Run the release script:** `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -Notes "..."`, in the background.
   - Run it as its own process (from bash like this). Running it inside the PowerShell tool fails, because PowerShell 5.1 treats pnpm's normal stderr as an error.
   - The script builds and signs the installer (key at `%USERPROFILE%\.tauri\rewind-updater.key`, never committed), renames it to `Hindsight_<ver>_x64-setup.exe`, writes `latest.json`, packs the Stream Deck plugin, and creates the release titled "Hindsight <ver>".
4. **Check the release:**
   - `gh release view v<ver> --repo aattiaibrahim/hindsight --json assets`
   - `curl -sL https://github.com/aattiaibrahim/hindsight/releases/latest/download/latest.json`, and confirm the installer URL in it returns 200.
- The updater endpoints are the hindsight repo first and the old Rewind repo as a fallback (`tauri.conf.json`).

## Server image
- `.github/workflows/hindsight-server-image.yml` builds on pushes to `server/**` and on `server-v*` tags.
- GitHub Actions may be blocked by a billing lock. If so, the image can't build until the user sorts it out with GitHub.
- Deploying to the user's TrueNAS needs their sign-in in the browser pane. The NAS address and name never go in the repo.

## Website
- Pushing main publishes `docs/` (Pages branch build).
- `site.js` fills in the version, size, date and download total from the GitHub API at runtime. Update the fallback numbers in `index.html` on release.

## GitHub
- The repo is `aattiaibrahim/hindsight` (`gh` is logged in with the `repo` scope only).
- Deleting packages needs `gh auth refresh -h github.com -s read:packages,delete:packages`, run by the user.
