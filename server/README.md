# Rewind Server

A small web app that runs on your NAS and lets you browse and watch your Rewind clips from any
browser on the local network, including on your phone.

Capture still happens on the gaming PC. The desktop app saves each clip locally, then copies it
to the NAS folder. Rewind Server only reads that folder:

```
<clips dataset>/
  VALORANT/
    VALORANT 2026-11-03 21-14-03 - GAMING-PC.mkv
    VALORANT 2026-11-03 21-14-03 - GAMING-PC (2).mkv
    .VALORANT 2026-11-03 22-00-00 - GAMING-PC.mkv.rewind-partial   <- still copying, ignored
  Apex Legends/
    Apex Legends Recording 2026-11-03 20-01-10 - GAMING-PC.mkv
```

- Also shows clips from other recorders (Medal, NVIDIA, `.mov`/`.webm`), using the date in the
  file name when there is one.
- Clips are grouped by day and game. You can search by game, PC name or date, and filter by game.
- Thumbnails are made with ffmpeg and stored in the **cache** volume. Nothing is ever written to
  the clips folder, which is mounted read-only.
- **Playback:** H.264 MP4 clips play directly. For MKV, HEVC or AV1 clips, the browser tries the
  original first, since desktop Chrome and Edge often play it. If that fails (for example on an
  iPhone), the server makes an H.264 MP4 copy once, stores it in the cache, and plays that. The
  copy mixes the desktop and mic tracks into one, because browsers only play the first audio track.
- **Downloads:** the original file, and the phone version once it exists.
- The folder is watched for changes and also fully rescanned every 60 seconds. New clips show up
  without restarting the server, and the page refreshes itself.
- No database and no accounts. Deleting clips isn't supported yet.

Port: **8420**.

## Install on TrueNAS SCALE

These steps are for TrueNAS SCALE 24.10 (Electric Eel) or later, where apps run on Docker. They
were tested on 25.10 (Goldeye).

TrueNAS doesn't build images from a `build:` line: it tries to pull the image and the install
silently ends with no container. So the app runs on the stock `node:22-alpine` image, with this
folder mounted read-only as the code. ffmpeg is installed when the container starts, so the first
start needs internet access and takes about 20 seconds.

### 1. Clips dataset and user

Use the dataset your SMB share points at, the one Rewind copies to, for example `/mnt/tank/clips`.
The container reads it as your SMB user and the `builtin_users` group (gid 545). That group can
read SMB-share datasets by default, so no permission changes are needed. Find your uid under
Credentials → Users (the first user you create is usually 3000).

### 2. Copy the app to the NAS

Copy this `server/` folder to the NAS. A hidden folder inside the clips share works, because
Rewind Server skips hidden folders:

```bash
robocopy server \NAS-NAMEclips.rewind-server /E /XD sample-clips node_modules
```

### 3. Install with YAML

**Apps → Discover Apps → ⋮ (next to Custom App) → Install via YAML**. Name it `rewind-server` and
paste this, with your own paths, uid and time zone:

```yaml
services:
  rewind-server:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    # Runs as root only to install ffmpeg and own /cache, then drops to uid 3000, gid 545.
    command:
      - sh
      - -c
      - apk add --no-cache ffmpeg tzdata su-exec && mkdir -p /cache && chown 3000:545 /cache && exec su-exec 3000:545 node src/main.js
    ports:
      - "8420:8420"
    environment:
      TZ: America/Los_Angeles
      MAX_CACHE_GB: "20"
    volumes:
      - /mnt/tank/clips/.rewind-server:/app:ro
      - /mnt/tank/clips:/clips:ro
      - rewind-cache:/cache
volumes:
  rewind-cache: {}
```

If the app shows **Stopped** after saving, press Start (▶) in the Controls column. Then open
`http://<nas-ip>:8420`. On a phone, use "Add to Home Screen" to open it like an app.

Thumbnails and phone versions are stored in the `rewind-cache` Docker volume. Phone versions are
capped at `MAX_CACHE_GB` (default 20 GB), and the copies watched least recently are removed first.

To update later, copy the new `server/` folder over the old one and restart the app.

### Custom App form (once an image is in a registry)

If a ready-made image is ever published, for example to `ghcr.io`, you can use **Apps → Discover
Apps → Custom App** instead of YAML. The image would already include ffmpeg, so there's no startup install:

- Image: the published image and tag
- Container port **8420** → host port **8420**, TCP
- Storage: host path `/mnt/tank/clips` → `/clips`, **read-only** ticked; a dataset or ixVolume → `/cache`
- Environment: `TZ`, plus any settings from the table below
- User `3000` (your SMB user), group `545`

No image is published yet.

## Settings

All settings are environment variables.

| Variable | Default | |
|----------|---------|--|
| `CLIPS_DIR` | `/clips` | Clips folder inside the container |
| `CACHE_DIR` | `/cache` | Thumbnails and phone versions |
| `PORT` | `8420` | HTTP port |
| `TZ` | UTC | Time zone. Only used for files whose names have no timestamp |
| `RESCAN_SECONDS` | `60` | Full rescan interval, on top of watching the folder. `0` turns it off |
| `MAX_CACHE_GB` | `20` | Cap for phone versions. `0` means no cap |
| `TRANSCODE_JOBS` | `1` | How many conversions run at once |
| `X264_PRESET` | `veryfast` | Use `ultrafast` on slow CPUs, or `medium` for smaller files |
| `H264_ENCODER` | `libx264` | ffmpeg encoder for phone versions |

A 1-minute 1080p60 clip takes roughly 20 to 60 seconds to convert on a typical NAS CPU. The player
shows progress while it works. Each clip is only converted once.

## Security

There's no login. Anyone who can reach port 8420 can watch and download your clips. Keep it on
your home network, and don't forward the port on your router. To watch clips away from home, use a
VPN such as Tailscale or WireGuard (both are available as TrueNAS apps).

## Run it locally

You need Docker, or Node 22+ and ffmpeg.

```bash
cd server
node scripts/make-samples.js sample-clips   # a few short test clips with silent audio
docker compose up --build                   # http://localhost:8420
```

Without Node on the host, you can make the samples with the image:

```bash
docker compose build
docker run --rm -v "$PWD/sample-clips:/out" -u "$(id -u)" rewind-server:latest node scripts/make-samples.js /out
```

Or without Docker:

```bash
CLIPS_DIR=sample-clips CACHE_DIR=.cache node src/main.js
```

## Tests

```bash
cd server
npm test
```

The tests cover file-name parsing, grouping, search, skipping hidden and partial files, and the HTTP
API (byte ranges, downloads). If ffmpeg is on the PATH, they also make a silent AV1 test clip and
check the thumbnail and the H.264 phone version, and that nothing was written to the clips folder.
Without ffmpeg, that test is skipped.

## How it's built

- `src/library.js`: scans the folder, parses Rewind file names, skips hidden and `*.rewind-partial` files.
- `src/state.js`: keeps the list in memory, watches the folder and rescans.
- `src/media.js`: ffprobe, thumbnails and the H.264 conversion, with a queue and a cache size cap.
- `src/server.js`: the JSON API and file serving, with byte ranges so seeking works.
- `public/`: the web page (plain JavaScript, no build step). `group.js` is shared with the tests.

There are no npm dependencies.
