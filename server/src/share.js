// Share a clip: upload its phone-friendly H.264 copy (plays inside Discord and
// on every phone) to Catbox or Litterbox and hand back the link. Same hosts as
// the desktop app. Nothing is uploaded unless someone presses Share.

import { openAsBlob } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const HOSTS = {
  // Free, no account, kept for good, up to 200 MB.
  catbox: { url: "https://catbox.moe/user/api.php", maxBytes: 200 * 1024 * 1024, label: "Catbox" },
  // Free, no account, kept 72 hours, up to 1 GB.
  litterbox: { url: "https://litterbox.catbox.moe/resources/internals/api.php", maxBytes: 1024 * 1024 * 1024, label: "Litterbox", time: "72h" },
};

export class Shares {
  constructor(cacheDir, fetchImpl = globalThis.fetch) {
    this.file = path.join(cacheDir, "shares.json");
    this.fetch = fetchImpl;
    this.links = {};
    this.loaded = readFile(this.file, "utf8")
      .then((t) => (this.links = JSON.parse(t)))
      .catch(() => {});
  }

  /** Links made for a clip so far (newest first), dropping expired Litterbox ones. */
  async list(id) {
    await this.loaded;
    const now = Date.now();
    return (this.links[id] ?? []).filter((l) => !l.expires || l.expires > now);
  }

  /** Upload `file` (the clip's H.264 copy) and remember the link. */
  async share(id, file, name, host = "catbox") {
    const h = HOSTS[host];
    if (!h) throw Object.assign(new Error("Unknown host"), { status: 400 });
    const blob = await openAsBlob(file, { type: "video/mp4" });
    if (blob.size > h.maxBytes) {
      throw Object.assign(new Error(`It's ${Math.round(blob.size / 1048576)} MB: ${h.label} takes up to ${Math.round(h.maxBytes / 1048576)} MB.`), { status: 413 });
    }
    const form = new FormData();
    form.append("reqtype", "fileupload");
    if (h.time) form.append("time", h.time);
    form.append("fileToUpload", blob, name.replace(/\.[^.]+$/, "") + ".mp4");
    const res = await this.fetch(h.url, { method: "POST", body: form, headers: { "user-agent": "HindsightServer" } });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https:\/\//.test(text)) throw Object.assign(new Error(`${h.label} said: ${text.slice(0, 200) || res.status}`), { status: 502 });
    const link = { url: text, host, at: Date.now(), expires: h.time ? Date.now() + 72 * 3600 * 1000 : null };
    await this.loaded;
    this.links[id] = [link, ...(this.links[id] ?? [])].slice(0, 10);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.links));
    return link;
  }
}
