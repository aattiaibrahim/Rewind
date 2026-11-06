// Makes a small sample library laid out like Rewind's NAS folder, for trying the server.
// All audio is silent. Usage: node scripts/make-samples.js <folder>
//
// Encoders used: libx264 (or H264_ENCODER), libx265 if present, libaom-av1/libsvtav1 if present.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const out = process.argv[2] || "sample-clips";
const encoders = execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
const has = (e) => new RegExp(`\\s${e}\\s`).test(encoders);
const h264 = process.env.H264_ENCODER || (has("libx264") ? "libx264" : "libopenh264");
const av1 = has("libsvtav1") ? ["libsvtav1", "-preset", "12"] : has("libaom-av1") ? ["libaom-av1", "-cpu-used", "8"] : null;
const hevc = has("libx265") ? ["libx265", "-preset", "ultrafast"] : null;

const today = new Date();
const day = (back) => {
  const d = new Date(today);
  d.setDate(d.getDate() - back);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** video codec args, container, seconds, number of silent audio tracks, pattern */
function clip(rel, { video, seconds = 4, tracks = 1, pattern = "testsrc2", size = "1280x720" }) {
  const file = path.join(out, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  const args = ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `${pattern}=size=${size}:rate=30`];
  for (let i = 0; i < tracks; i++) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-map", "0:v");
  for (let i = 0; i < tracks; i++) args.push("-map", `${i + 1}:a`);
  args.push("-t", String(seconds), "-pix_fmt", "yuv420p", "-c:v", ...video);
  args.push("-c:a", file.endsWith(".mp4") ? "aac" : "libopus", file);
  execFileSync(FFMPEG, args, { stdio: "inherit" });
  console.log("made", rel);
}

const x264 = [h264, ...(h264 === "libx264" ? ["-preset", "ultrafast"] : [])];
clip(`VALORANT/VALORANT ${day(0)} 21-14-03 - GAMING-PC.mkv`, { video: av1 || x264, tracks: 2 });
clip(`VALORANT/VALORANT ${day(0)} 21-14-03 - GAMING-PC (2).mkv`, { video: x264, tracks: 2, pattern: "smptebars" });
clip(`VALORANT/VALORANT ${day(1)} 19-02-44 - LAPTOP.mkv`, { video: hevc || x264, tracks: 1, pattern: "rgbtestsrc" });
clip(`Apex Legends/Apex Legends Recording ${day(0)} 20-01-10 - GAMING-PC.mkv`, { video: x264, seconds: 6, tracks: 2, pattern: "mandelbrot" });
clip(`Desktop/Desktop ${day(3)} 10-30-00.mp4`, { video: x264, tracks: 1, pattern: "testsrc" });

// Things the server must ignore.
writeFileSync(path.join(out, "VALORANT", `.VALORANT ${day(0)} 22-00-00 - GAMING-PC.mkv.rewind-partial`), "copy in progress");
mkdirSync(path.join(out, ".thumbs"), { recursive: true });
writeFileSync(path.join(out, ".thumbs", "ignored.mkv"), "hidden");
console.log("sample library ready in", out);
