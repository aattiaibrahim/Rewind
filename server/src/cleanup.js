// Cleanup: the biggest clips, and what to do with each (delete to a trash on the
// NAS, shrink to the H.264 copy, or keep). Changing anything needs ALLOW_CHANGES=1
// and a writable clips folder; without them this is a read-only list.
//
// - The trash is a hidden folder in the clips folder (`.hindsight-trash`), so a
//   delete is a rename on the same disk, Hindsight's sync never copies it back,
//   and the scanners skip it. Its index lives next to the files (trash.json), so
//   it survives a lost cache. Anything older than TRASH_DAYS is removed for good.
// - "Keep" hides a clip from the list until the next cleanup check.

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export const TRASH = ".hindsight-trash";
const DAY = 24 * 3600 * 1000;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `dir/name`, or `dir/stem (2).ext`… if that's taken. */
async function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let n = 2; await exists(p); n++) p = path.join(dir, `${stem} (${n})${ext}`);
  return p;
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}

export class Cleanup {
  constructor({ root, cacheDir, allow = false, trashDays = 30 }) {
    this.root = root;
    this.allow = allow;
    this.trashDays = trashDays;
    this.trashDir = path.join(root, TRASH);
    this.indexFile = path.join(this.trashDir, "trash.json");
    this.keptFile = path.join(cacheDir, "cleanup.json");
    this.kept = {}; // clip id -> size it had when kept (a changed clip shows up again)
    this.trash = [];
    this.canChange = false;
  }

  async init() {
    try {
      this.kept = JSON.parse(await readFile(this.keptFile, "utf8")).kept ?? {};
    } catch {
      this.kept = {};
    }
    this.canChange = this.allow && (await access(this.root, constants.W_OK).then(() => true, () => false));
    try {
      this.trash = JSON.parse(await readFile(this.indexFile, "utf8"));
    } catch {
      this.trash = [];
    }
    if (this.canChange) await this.purge();
  }

  /** Biggest clips first, without the ones you kept since the last check. */
  list(clips, limit = 40) {
    const open = clips.filter((c) => this.kept[c.id] !== c.size).sort((a, b) => b.size - a.size);
    const total = clips.reduce((n, c) => n + c.size, 0);
    const shown = open.slice(0, limit);
    return {
      canChange: this.canChange,
      trashDays: this.trashDays,
      kept: clips.filter((c) => this.kept[c.id] === c.size).length,
      totalBytes: total,
      shownBytes: shown.reduce((n, c) => n + c.size, 0),
      clips: shown,
    };
  }

  async keep(clip) {
    this.kept[clip.id] = clip.size;
    await writeJson(this.keptFile, { kept: this.kept });
  }

  /** A new cleanup check: everything you kept is listed again. */
  async check() {
    this.kept = {};
    await writeJson(this.keptFile, { kept: this.kept });
  }

  needChange() {
    if (!this.canChange) {
      throw Object.assign(new Error("Changes are off on this server (set ALLOW_CHANGES=1 and mount the clips folder read-write)."), { status: 403 });
    }
  }

  async saveTrash() {
    await mkdir(this.trashDir, { recursive: true });
    await writeJson(this.indexFile, this.trash);
  }

  /** Move a clip into the trash. `why` is shown in the trash list. */
  async toTrash(clip, why = "deleted") {
    this.needChange();
    const from = path.join(this.root, ...clip.rel.split("/"));
    const dir = path.join(this.trashDir, ...path.posix.dirname(clip.rel).split("/").filter((p) => p !== "."));
    await mkdir(dir, { recursive: true });
    const to = await freePath(dir, clip.name);
    await rename(from, to);
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      rel: clip.rel,
      file: path.relative(this.trashDir, to).split(path.sep).join("/"),
      name: clip.name,
      game: clip.game,
      size: clip.size,
      takenAt: clip.takenAt,
      why,
      trashedAt: Date.now(),
    };
    this.trash.push(entry);
    await this.saveTrash();
    return entry;
  }

  trashList() {
    return {
      canChange: this.canChange,
      trashDays: this.trashDays,
      bytes: this.trash.reduce((n, e) => n + e.size, 0),
      items: [...this.trash]
        .sort((a, b) => b.trashedAt - a.trashedAt)
        .map((e) => ({ ...e, removeAt: e.trashedAt + this.trashDays * DAY })),
    };
  }

  /** Put a clip back where it was (with " (2)" if that name is taken again). */
  async restore(id) {
    this.needChange();
    const e = this.trash.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error("It's not in the trash anymore."), { status: 404 });
    const from = path.join(this.trashDir, ...e.file.split("/"));
    const dir = path.join(this.root, ...path.posix.dirname(e.rel).split("/").filter((p) => p !== "."));
    await mkdir(dir, { recursive: true });
    const to = await freePath(dir, path.posix.basename(e.rel));
    await rename(from, to);
    this.trash = this.trash.filter((x) => x.id !== id);
    await this.saveTrash();
  }

  /** Remove trashed clips for good: all of them, or those past TRASH_DAYS. */
  async purge(all = false) {
    if (!all && !this.trash.length) return 0;
    this.needChange();
    const cutoff = Date.now() - this.trashDays * DAY;
    const gone = this.trash.filter((e) => all || e.trashedAt < cutoff);
    for (const e of gone) await rm(path.join(this.trashDir, ...e.file.split("/")), { force: true });
    if (gone.length) {
      this.trash = this.trash.filter((e) => !gone.includes(e));
      await this.saveTrash();
    }
    return gone.length;
  }

  /**
   * Replace a clip with its (smaller) H.264 copy from the cache: the original goes
   * to the trash, the copy takes its place with the same name and date (.mp4).
   */
  async shrink(clip, webFile) {
    this.needChange();
    const web = await stat(webFile);
    if (web.size >= clip.size) {
      throw Object.assign(new Error("The H.264 copy isn't smaller than the original, so there's nothing to gain."), { status: 409 });
    }
    const dir = path.join(this.root, ...path.posix.dirname(clip.rel).split("/").filter((p) => p !== "."));
    const base = clip.name.replace(/\.[^.]+$/, "");
    const tmp = path.join(dir, `.${base}.mp4.rewind-partial`);
    await copyFile(webFile, tmp);
    if ((await stat(tmp)).size !== web.size) {
      await rm(tmp, { force: true });
      throw new Error("The copy came out the wrong size.");
    }
    await this.toTrash(clip, "replaced by a smaller copy");
    const to = await freePath(dir, `${base}.mp4`);
    await rename(tmp, to);
    const when = new Date(clip.mtime);
    await utimes(to, when, when).catch(() => {});
    return { saved: clip.size - web.size, name: path.basename(to) };
  }
}
