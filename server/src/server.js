// HTTP API and static files. Read-only towards the clips folder.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gamesOf } from "../public/group.js";
import { Media } from "./media.js";

export const VERSION = (process.env.REWIND_SERVER_VERSION || "dev").slice(0, 7);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
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

export async function createServer({ library, media }) {
  const route = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, clips: library.clips.length });

    if (url.pathname === "/api/clips") {
      const etag = `"v${library.version}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      return send(res, 200, { clips: library.clips, games: gamesOf(library.clips), scannedAt: library.scannedAt, version: VERSION }, {
        etag,
        "cache-control": "no-cache",
      });
    }

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
      } catch (e) {
        return send(res, 500, { error: String(e.message || e).slice(-500) });
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
