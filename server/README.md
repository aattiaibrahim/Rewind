# Hindsight Server (Hindsight on the NAS)

Renamed from Rewind Server. The image is now `ghcr.io/aattiaibrahim/hindsight-server`; the old
`rewind-server` image gets every release too, so an install made under the old name keeps updating.

A small web app that runs on your NAS and lets you browse, watch and tidy your Hindsight clips from
any browser on the local network, including on your phone.

Capture still happens on the gaming PC. The desktop app saves each clip locally, then copies it
to the NAS folder. Hindsight Server reads that folder:

```
<clips dataset>/
  VALORANT/
    VALORANT 2026-11-03 21-14-03 - GAMING-PC.mkv
    VALORANT 2026-11-03 21-14-03 - GAMING-PC (2).mkv
    .VALORANT 2026-11-03 22-00-00 - GAMING-PC.mkv.rewind-partial   <- still copying, ignored
  Apex Legends/
    Apex Legends Recording 2026-11-03 20-01-10 - GAMING-PC.mkv
  .hindsight-trash/                                                 <- cleanup's trash, hidden
```

**Clips**
- The same look as the desktop library: day headings ("Today", "Mon, Nov 2") with the clip count,
  game chips, thumbnail cards with the length, PC and source tags and a Damaged badge, and the
  date timeline down the right side (drag it, or tap it on a phone).
- Three views: **Gallery** (by day), **Folders** (one per game, with covers, counts and sizes)
  and **List** (one row per clip). Sort by newest, oldest, biggest or longest.
- **Filters:** PC, the recorder it was made with (Hindsight, Medal, NVIDIA), clips or recordings,
  length, date range, and damaged only. Filters live in the address, so a filtered view can be
  bookmarked.
- An overview card shows how many clips you have, how much space they take, and which games use
  the most.
- A clip that ffprobe can't read is marked **Damaged**. Lengths and codecs are read in the
  background and kept in the cache.
- Folders that differ only by case or spacing ("VALORANT" and "Valorant") show as one game.
- Also shows clips from other recorders (Medal, NVIDIA, `.mov`/`.webm`), using the date in the
  file name when there is one.
- **Playback:** H.264 MP4 clips play directly. For MKV, HEVC or AV1 clips, the browser tries the
  original first. If that fails (for example on an iPhone), the server makes an H.264 MP4 copy
  once, stores it in the cache and plays that. The copy mixes the desktop and mic tracks.
- **Downloads:** the original file, and the phone version once it exists.
- **Share:** in the player, **Share link** uploads the phone version to Catbox (kept, up to 200 MB)
  or Litterbox (72 hours, up to 1 GB) and shows a link that plays inside Discord and on phones.
  Links you've made are shown again the next time you open the clip. Nothing is uploaded unless
  you press Share.
- **On this day:** clips from this date in earlier years ("1 year ago today") at the top of the
  library; tap one to watch them through with Previous / Next.

**Montage**
- Pick a length (30 s to 10 min), which clips (random, a date range, edited or unedited ones), a
  game, and how much of each clip (the end, where a replay's action usually is, the middle or the
  start). Then reorder, trim (in / out) or remove clips, add a song (uploaded from your phone or
  PC) and set the clip and song volumes.
- The montage is made on the NAS with ffmpeg (every clip scaled to one size, the song looped and
  faded out at the end) and kept in the cache for a day to download. The clips folder isn't touched.

**Storage**
- The storage button shows the space your clips use and what's free on the NAS. It opens a
  breakdown per game, the dataset's used and free space, and the cache size.

**Cleanup** (needs `ALLOW_CHANGES=1`, see below)
- Lists the biggest clips. For each one:
  - **Delete** moves it to a hidden trash on the NAS for 30 days (`TRASH_DAYS`).
  - **Shrink** swaps it for the smaller H.264 copy, with the same name and date. The original goes
    to the trash.
  - **Keep** hides it until you press **Run cleanup check** again.
- **Trash** lists what's waiting to be removed, with **Restore**, and **Empty trash** to remove
  everything now.
- Hindsight's NAS sync remembers what it already copied, so a clip deleted here isn't copied back.

Without `ALLOW_CHANGES=1`, the server never writes to the clips folder. Cleanup then only lists the
biggest clips, and Keep still works.

Port: **8420**. No database and no accounts.

## Install on TrueNAS SCALE

These steps are for TrueNAS SCALE 24.10 (Electric Eel) or later, where apps run on Docker. They
were tested on 25.10 (Goldeye).

The image is published at **`ghcr.io/aattiaibrahim/hindsight-server`** (amd64 and arm64), with ffmpeg
included. TrueNAS downloads it once. After that, the app starts and runs with no internet.

### 1. Clips dataset and user

Use the dataset your SMB share points at, the one Hindsight copies to, for example
`/mnt/tank/clips`. The container runs as your SMB user and the `builtin_users` group (gid 545),
which can read and change SMB-share datasets by default, so no permission changes are needed.
Find your uid under Credentials → Users (the first user you create is usually 3000).

### 2. Install with YAML

**Apps → Discover Apps → ⋮ (next to Custom App) → Install via YAML**. Name it `hindsight-server` and
paste this, with your own path, uid and time zone:

```yaml
services:
  hindsight-server:
    image: ghcr.io/aattiaibrahim/hindsight-server:0.3.0
    restart: unless-stopped
    user: "3000:545"
    ports:
      - "8420:8420"
    environment:
      TZ: America/Los_Angeles
      MAX_CACHE_GB: "20"
      ALLOW_CHANGES: "1"      # cleanup may delete (to the trash) and shrink clips
    volumes:
      - /mnt/tank/clips:/clips    # add :ro and drop ALLOW_CHANGES for a strictly read-only server
      - hindsight-cache:/cache
volumes:
  hindsight-cache: {}
```

If the app shows **Stopped** after saving, press Start (▶) in the Controls column. Then open
`http://<nas-ip>:8420`. On a phone, use "Add to Home Screen" to open it like an app.

### Or with the Custom App form

**Apps → Discover Apps → Custom App**:

- Image repository `ghcr.io/aattiaibrahim/hindsight-server`, tag `0.3.0`
- User `3000`, group `545`
- Port: container **8420** → host **8420**, TCP
- Storage: host path `/mnt/tank/clips` → `/clips` (tick **read-only** for a read-only server); an
  ixVolume → `/cache`
- Environment: `TZ`, `ALLOW_CHANGES=1` for cleanup, plus any settings from the table below

### Cache

Thumbnails, phone versions and the background clip info go in the `/cache` volume. Phone versions
are capped at `MAX_CACHE_GB` (default 20 GB), and the copies watched least recently are removed
first.

### Updating

The page shows the running version when you hover over the HINDSIGHT logo, and so does
`http://<nas-ip>:8420/healthz` (`release` and the Git commit).

Each release is tagged with its number, for example `0.2.0`, on the
[package page](https://github.com/aattiaibrahim/hindsight/pkgs/container/hindsight-server). Every
change in between also gets `latest` and `sha-<commit>`.

TrueNAS only downloads an image it doesn't already have, so it won't fetch a newer `latest` on its
own. To update, open the app's **Edit**, change the image tag to the new release and save. TrueNAS
downloads that image and restarts the app; the cache is kept. Going back is the same: put the old
tag back.

## Settings

All settings are environment variables.

| Variable | Default | |
|----------|---------|--|
| `CLIPS_DIR` | `/clips` | Clips folder inside the container |
| `CACHE_DIR` | `/cache` | Thumbnails, phone versions, clip info |
| `PORT` | `8420` | HTTP port |
| `TZ` | UTC | Time zone. Only used for files whose names have no timestamp |
| `ALLOW_CHANGES` | off | `1` lets cleanup delete (to the trash), shrink and restore. Needs a writable clips folder |
| `TRASH_DAYS` | `30` | How long deleted clips stay in the trash |
| `RESCAN_SECONDS` | `60` | Full rescan interval, on top of watching the folder. `0` turns it off |
| `MAX_CACHE_GB` | `20` | Cap for phone versions. `0` means no cap |
| `TRANSCODE_JOBS` | `1` | How many conversions run at once |
| `X264_PRESET` | `veryfast` | Use `ultrafast` on slow CPUs, or `medium` for smaller files |
| `H264_ENCODER` | `libx264` | ffmpeg encoder for phone versions |

A 1-minute 1080p60 clip takes roughly 20 to 60 seconds to convert on a typical NAS CPU. The player
and Shrink show progress while it works. Each clip is only converted once.

## Security

There's no login. Anyone who can reach port 8420 can watch and download your clips, and with
`ALLOW_CHANGES=1` also delete them (to the trash). Keep it on your home network, and don't forward
the port on your router. Share links are the exception you choose: a shared clip is public to
anyone with its link. To watch clips away from home, use a VPN such as Tailscale or WireGuard
(both are available as TrueNAS apps).

## Run it locally

You need Docker, or Node 22+ and ffmpeg.

```bash
cd server
node scripts/make-samples.js sample-clips   # a few short test clips with silent audio
docker compose up --build                   # http://localhost:8420
```

Or without Docker:

```bash
CLIPS_DIR=sample-clips CACHE_DIR=.cache ALLOW_CHANGES=1 node src/main.js
```

## Tests

```bash
cd server
npm test
```

The tests cover file-name parsing, grouping, filters, sorting, folders, search, skipping hidden and
partial files, cleanup (Keep, the trash, restore, expiry, Shrink, read-only mode), storage, and the
HTTP API (byte ranges, downloads). If ffmpeg is on the PATH, they also make a silent AV1 test clip
and check the thumbnail, the H.264 phone version and the Damaged check. Without ffmpeg, those tests
are skipped.

## How it's built

- `src/library.js`: scans the folder, parses file names, skips hidden and `*.rewind-partial` files.
- `src/state.js`: keeps the list in memory, watches the folder and rescans.
- `src/media.js`: ffprobe, thumbnails, the H.264 conversion and the background clip info.
- `src/cleanup.js`: the biggest-clips list, Keep, the trash and Shrink.
- `src/server.js`: the JSON API and file serving, with byte ranges so seeking works.
- `public/`: the web page (plain JavaScript, no build step). `group.js` (grouping, filters,
  sorting) is shared with the tests. Fonts: Geist, under the SIL Open Font License
  (`public/fonts/OFL.txt`).

There are no npm dependencies.
