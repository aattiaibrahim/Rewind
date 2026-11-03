// Rewind Server: serves a Rewind clip library over the local network.
//
// Environment:
//   CLIPS_DIR      clips folder (read-only)            default /clips
//   CACHE_DIR      thumbnails and phone copies         default /cache
//   PORT           HTTP port                           default 8420
//   RESCAN_SECONDS full rescan interval, 0 = off       default 60
//   MAX_CACHE_GB   cap for converted copies, 0 = none  default 20
//   TRANSCODE_JOBS conversions at once                 default 1
//   H264_ENCODER   ffmpeg encoder                      default libx264

import { Library } from "./state.js";
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
await library.start();
const server = await createServer({ library, media });
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
