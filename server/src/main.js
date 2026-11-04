// Rewind Server: serves a Rewind clip library over the local network.
//
// Environment:
//   CLIPS_DIR      clips folder                        default /clips
//   ALLOW_CHANGES  1 = cleanup may trash/shrink files  default off (read-only)
//   TRASH_DAYS     days deleted clips stay in trash    default 30
//   CACHE_DIR      thumbnails and phone copies         default /cache
//   PORT           HTTP port                           default 8420
//   RESCAN_SECONDS full rescan interval, 0 = off       default 60
//   MAX_CACHE_GB   cap for converted copies, 0 = none  default 20
//   TRANSCODE_JOBS conversions at once                 default 1
//   H264_ENCODER   ffmpeg encoder                      default libx264

import path from "node:path";
import { Library } from "./state.js";
import { Cleanup } from "./cleanup.js";
import { Media } from "./media.js";
import { createServer, VERSION } from "./server.js";

const env = process.env;
const clipsDir = env.CLIPS_DIR || "/clips";
const cacheDir = env.CACHE_DIR || "/cache";
const port = Number(env.PORT || 8420);

const library = new Library(clipsDir, { rescanSeconds: Number(env.RESCAN_SECONDS ?? 60) });
const media = new Media({
  cacheDir,
  transcodeJobs: Number(env.TRANSCODE_JOBS || 1),
  maxCacheBytes: Number(env.MAX_CACHE_GB ?? 20) * 1024 ** 3,
});

await media.init();
const cleanup = new Cleanup({
  root: clipsDir,
  cacheDir,
  allow: env.ALLOW_CHANGES === "1" || env.ALLOW_CHANGES === "true",
  trashDays: Number(env.TRASH_DAYS || 30),
});
await cleanup.init();
console.log(cleanup.canChange ? `Cleanup can change files (trash kept ${cleanup.trashDays} days)` : "Read-only: cleanup only lists the biggest clips");
// Trash older than TRASH_DAYS goes for good, checked every 6 hours.
setInterval(() => cleanup.canChange && cleanup.purge().catch((e) => console.error("trash purge:", e.message)), 6 * 3600 * 1000).unref();
const fileOf = (clip) => path.join(clipsDir, ...clip.rel.split("/"));
library.onChange = (clips) => media.scanMeta(clips, fileOf);
await library.start();
const server = await createServer({ library, media, cleanup });
server.listen(port, () => {
  console.log(`Rewind Server ${VERSION}: ${library.clips.length} clips in ${clipsDir}, listening on :${port}`);
});

const stop = () => {
  library.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
