// Reads the clip library the Rewind desktop app writes to a NAS:
//   <root>/<Game>/<Game> [Recording ]<YYYY-MM-DD HH-MM-SS>[ - PCNAME][ (n)].mkv|.mp4
// Never writes to it.

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const VIDEO_EXTS = new Set([".mkv", ".mp4"]);
export const PARTIAL = ".rewind-partial";

const NAME_RE =
  /^(?<game>.+?) (?<rec>Recording )?(?<date>\d{4}-\d{2}-\d{2}) (?<h>\d{2})-(?<m>\d{2})-(?<s>\d{2})(?: - (?<pc>[A-Za-z0-9_-]+))?(?: \((?<n>\d+)\))?\.(?<ext>mkv|mp4)$/i;

/** Hidden files/folders and copies the desktop app is still writing. */
export function isSkipped(name) {
  return name.startsWith(".") || name.toLowerCase().endsWith(PARTIAL);
}

export function isVideo(name) {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

/**
 * Parse a Rewind clip name. Returns null for names that don't follow the pattern.
 * -> { game, recording, day, time, takenAt, pc, n, ext }
 */
export function parseClipName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const g = m.groups;
  const time = `${g.h}:${g.m}:${g.s}`;
  return {
    game: g.game,
    recording: Boolean(g.rec),
    day: g.date,
    time,
    takenAt: `${g.date}T${time}`,
    pc: g.pc || null,
    n: g.n ? Number(g.n) : 1,
    ext: g.ext.toLowerCase(),
  };
}

/** Local wall-clock time as "YYYY-MM-DDTHH:MM:SS" (used when a name has no timestamp). */
export function localStamp(date) {
  const p = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function clipId(rel) {
  return createHash("sha1").update(rel).digest("base64url").slice(0, 16);
}

/**
 * Build a clip record from a file name, its folder (the game) and stat info.
 * The folder wins over the name for the game, so clips always sit with their folder.
 */
export function makeClip(rel, info) {
  const name = path.posix.basename(rel);
  const folder = path.posix.dirname(rel);
  const parsed = parseClipName(name);
  const takenAt = parsed ? parsed.takenAt : localStamp(info.mtime);
  const game = folder !== "." ? folder.split("/")[0] : parsed?.game || "Other";
  return {
    id: clipId(rel),
    rel,
    name,
    game,
    pc: parsed?.pc ?? null,
    recording: parsed?.recording ?? false,
    n: parsed?.n ?? 1,
    takenAt,
    day: takenAt.slice(0, 10),
    ext: path.extname(name).slice(1).toLowerCase(),
    size: info.size,
    mtime: info.mtime.getTime(),
  };
}

/**
 * Scan the library: video files in the root and one level of game folders.
 * Hidden entries and partial copies are skipped.
 */
export async function scanLibrary(root) {
  const clips = [];
  const add = async (rel) => {
    try {
      const info = await stat(path.join(root, rel));
      if (info.isFile() && info.size > 0) clips.push(makeClip(rel, info));
    } catch {
      // vanished between readdir and stat (moved/renamed): skip
    }
  };
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  for (const entry of top) {
    if (isSkipped(entry.name)) continue;
    if (entry.isDirectory()) {
      let files;
      try {
        files = await readdir(path.join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!isSkipped(f.name) && f.isFile() && isVideo(f.name)) await add(`${entry.name}/${f.name}`);
      }
    } else if (entry.isFile() && isVideo(entry.name)) {
      await add(entry.name);
    }
  }
  return clips;
}
