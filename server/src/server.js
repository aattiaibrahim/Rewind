// HTTP API and static files. Read-only towards the clips folder.

import { createReadStream } from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gamesOf } from "../public/group.js";
import { Media } from "./media.js";

export const VERSION = (process.env.REWIND_SERVER_VERSION || "dev").slice(0, 7);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
/** The release number (package.json), shown next to the commit. */
export const RELEASE = JSON.parse(
  await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, code, body, headers = {}) {
  const json = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, {
    "content-type": json ? "application/json" : "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

/** Serve a file with HTTP Range support (needed for seeking in <video>). */
export async function sendFile(req, res, file, { type, download, cache } = {}) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, "not found");
  }
  const size = info.size;
  const headers = {
    "content-type": type || "application/octet-stream",
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    "cache-control": cache || "no-cache",
  };
  if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
  }
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/**
 * Space used: clips per game and in total, the cache, and the clips dataset's
 * size and free space as the NAS reports them (statfs of the mounted folder).
 */
export async function storage(library, media) {
  const games = new Map();
  let bytes = 0;
  for (const c of library.clips) {
    bytes += c.size;
    const g = games.get(c.game) ?? { game: c.game, bytes: 0, count: 0 };
    g.bytes += c.size;
    g.count++;
    games.set(c.game, g);
  }
  let disk = null;
  try {
    const s = await statfs(library.root);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = { total, free, used: total - free };
  } catch {
    // not available on this filesystem
  }
  return {
    clips: { bytes, count: library.clips.length },
    games: [...games.values()].sort((a, b) => b.bytes - a.bytes),
    cache: { bytes: await media.cacheBytes() },
    disk,
  };
}

export async function createServer({ library, media, cleanup = null }) {
  const withMeta = (c) => ({ ...c, ...(media.meta(c) ?? {}) });
  const fail = (res, e) => send(res, e.status || 500, { error: String(e.message || e).slice(-500) });
  const post = (req) => req.method === "POST";

  const route = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    // ---- cleanup and trash ----
    if (cleanup && url.pathname === "/api/cleanup") {
      return send(res, 200, cleanup.list(library.clips.map(withMeta)), { "cache-control": "no-cache" });
    }
    if (cleanup && url.pathname === "/api/cleanup/check" && post(req)) {
      await cleanup.check();
      await library.rescan();
      return send(res, 200, cleanup.list(library.clips.map(withMeta)));
    }
    if (cleanup && url.pathname === "/api/trash") return send(res, 200, cleanup.trashList(), { "cache-control": "no-cache" });
    if (cleanup && url.pathname === "/api/trash/empty" && post(req)) {
      try {
        return send(res, 200, { removed: await cleanup.purge(true) });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (cleanup && parts[0] === "api" && parts[1] === "trash" && parts[3] === "restore" && post(req)) {
      try {
        await cleanup.restore(parts[2]);
        await library.rescan();
        return send(res, 200, { ok: true });
      } catch (e) {
        return fail(res, e);
      }
    }

    if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, release: RELEASE, clips: library.clips.length });

    if (url.pathname === "/api/clips") {
      // Changes when clips come or go, and as durations / damage checks come in.
      const etag = `"v${library.version}-m${media.metaVersion}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      const clips = library.clips.map(withMeta);
      return send(res, 200, { clips, games: gamesOf(library.clips), scannedAt: library.scannedAt, version: VERSION, release: RELEASE, canChange: !!cleanup?.canChange }, {
        etag,
        "cache-control": "no-cache",
      });
    }

    if (url.pathname === "/api/storage") return send(res, 200, await storage(library, media), { "cache-control": "no-cache" });

    if (url.pathname === "/api/rescan" && req.method === "POST") {
      await library.rescan();
      return send(res, 200, { clips: library.clips.length });
    }

    // /api/clips/:id/<action>
    if (parts[0] === "api" && parts[1] === "clips" && parts.length === 4) {
      const clip = library.byId.get(parts[2]);
      if (!clip) return send(res, 404, { error: "unknown clip" });
      const file = path.join(library.root, ...clip.rel.split("/"));
      const action = parts[3];
      try {
        if (action === "original") {
          const type = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[clip.ext] || "video/x-matroska";
          return sendFile(req, res, file, { type, download: url.searchParams.has("download") ? clip.name : null });
        }
        if (action === "thumb.jpg") {
          // Known to be unreadable: don't start ffmpeg on it for every page view.
          if (media.meta(clip)?.damaged) return send(res, 404, "no thumbnail: the clip can't be read");
          const out = await media.thumbnail(clip, file);
          return sendFile(req, res, out, { type: "image/jpeg", cache: "public, max-age=86400" });
        }
        if (action === "info") {
          const info = await media.probe(clip, file);
          return send(res, 200, { ...info, directPlay: Media.directPlayable(clip, info), web: await media.webStatus(clip) });
        }
        if (action === "web" && req.method === "POST") return send(res, 200, await media.prepareWeb(clip, file));
        if (action === "web") return send(res, 200, await media.webStatus(clip));
        if (action === "web.mp4") {
          const out = media.webPath(clip);
          if (req.headers.range === "bytes=0-" || !req.headers.range) media.touch(out);
          const base = clip.name.replace(/\.[^.]+$/, "");
          return sendFile(req, res, out, {
            type: "video/mp4",
            download: url.searchParams.has("download") ? `${base} (phone).mp4` : null,
          });
        }
        if (cleanup && action === "keep" && post(req)) {
          await cleanup.keep(clip);
          return send(res, 200, { ok: true });
        }
        if (cleanup && action === "trash" && post(req)) {
          const entry = await cleanup.toTrash(clip);
          await library.rescan();
          return send(res, 200, entry);
        }
        if (cleanup && action === "shrink" && post(req)) {
          cleanup.needChange();
          // Make (or wait for) the H.264 copy first; the page polls this until it's done.
          const st = await media.webStatus(clip);
          if (st.state !== "ready") return send(res, 200, st.state === "none" || st.state === "failed" ? await media.prepareWeb(clip, file) : st);
          const out = await cleanup.shrink(clip, media.webPath(clip));
          await library.rescan();
          return send(res, 200, { state: "done", ...out });
        }
      } catch (e) {
        return fail(res, e);
      }
      return send(res, 404, { error: "unknown action" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");

    // Static UI
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden");
    try {
      const body = await readFile(file);
      return send(res, 200, body, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    } catch {
      return send(res, 404, "not found");
    }
  };

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, "server error");
      else res.destroy();
    });
  });
}
