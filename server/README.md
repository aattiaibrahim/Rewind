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

These steps are for TrueNAS SCALE 24.10 (Electric Eel) or later, where apps run on Docker.

### 1. Datasets

You need two:

| What | Example path | Access |
|------|--------------|--------|
| Clips: the folder Rewind copies to (the one your SMB share points at) | `/mnt/tank/rewind` | read-only |
| Cache: thumbnails and phone versions | `/mnt/tank/apps/rewind-server/cache` | read/write |

The container needs to **read** the clips dataset and **write** the cache. The YAML below runs it
as uid/gid `568`, the TrueNAS `apps` user (`user:` line). Either:

- give `apps` read access to the clips dataset (Datasets → clips dataset → Edit Permissions → Add
  ACL entry: user `apps`, Read), and make `apps` the owner of the cache dataset; or
- set `user:` to the uid:gid that owns your clips (see `id <yourname>` in the TrueNAS shell).

The cache can grow. Phone versions are capped at `MAX_CACHE_GB` (default 20 GB), and the copies
watched least recently are removed first. Thumbnails are about 30 KB each.

### 2. Copy the app to the NAS

TrueNAS can't build an image from the Custom App form, so the YAML below builds it from the
`server/` folder. Copy that folder to the NAS, for example to `/mnt/tank/apps/rewind-server/src`,
over the SMB share or with:

```bash
scp -r server/ admin@truenas.local:/mnt/tank/apps/rewind-server/src
```

### 3. Install with YAML

**Apps → Discover Apps → ⋮ (top right) → Install via YAML**. Name it `rewind-server` and paste
this, with your own paths:

```yaml
services:
  rewind-server:
    build: /mnt/tank/apps/rewind-server/src
    image: rewind-server:local
    restart: unless-stopped
    user: "568:568"
    ports:
      - "8420:8420"
    environment:
      TZ: Europe/London        # your time zone
      MAX_CACHE_GB: "20"
    volumes:
      - /mnt/tank/rewind:/clips:ro
      - /mnt/tank/apps/rewind-server/cache:/cache
```

Then open `http://<nas-ip>:8420`. On a phone, use "Add to Home Screen" to open it like an app.

To update later, copy the new `server/` folder over the old one, then use **Edit** on the app and
save it (or Stop, then Start) so it rebuilds.

### Custom App form (once an image is in a registry)

If a ready-made image is ever published, for example to `ghcr.io`, you can use **Apps → Discover
Apps → Custom App** instead of YAML. The values match the YAML above:

- Image: the published image and tag
- Container port **8420** → host port **8420**, TCP
- Storage: host path `/mnt/tank/rewind` → `/clips`, **read-only** ticked; host path
  `/mnt/tank/apps/rewind-server/cache` → `/cache`
- Environment: `TZ`, plus any settings from the table below
- User and group: `568`, or the owner of your clips

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
