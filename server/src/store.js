// Server state kept in the data folder (hindsight-state.json): which clips are
// "Keep whole", which files the NAS editor made or edited, hidden notices, and
// when the library was last looked at (for "new clips from other PCs").

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Names the desktop and the NAS editor give their outputs (same rule as the desktop's To trim). */
export const MADE_BY_EDIT = /\((trim|remux|H\.264|repaired|audio|\d+ MB)( \(\d+\))?\)|\((trimmed|good part)\)/i;
/** Folders of edits, not raw clips. */
export const EDIT_FOLDERS = new Set(["edits", "exports", "montages"]);

const k = (rel) => rel.toLowerCase();

export class Store {
  constructor(dir) {
    this.file = path.join(dir, "hindsight-state.json");
    this.data = { keepWhole: {}, made: {}, edited: {}, hidden: {}, seenAt: 0 };
    this.version = 0;
  }

  async init() {
    try {
      Object.assign(this.data, JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      // first run: everything up to now counts as seen
    }
    if (!this.data.seenAt) {
      this.data.seenAt = Date.now();
      await this.save();
    }
  }

  async save() {
    this.version++;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data));
    await rename(tmp, this.file);
  }

  /** A clip nobody has trimmed or edited yet, and not marked "Keep whole". */
  toTrim(clip) {
    const rel = k(clip.rel);
    return !EDIT_FOLDERS.has((clip.folder ?? clip.game).toLowerCase()) && !MADE_BY_EDIT.test(clip.name) && !this.data.made[rel] && !this.data.edited[rel] && !this.data.keepWhole[rel];
  }

  async keepWhole(rel, on = true) {
    if (on) this.data.keepWhole[k(rel)] = Date.now();
    else delete this.data.keepWhole[k(rel)];
    await this.save();
  }

  madeHere(rel) {
    return !!this.data.made[k(rel)];
  }

  /** The NAS editor made `out` from `source`. */
  async recordEdit(source, out) {
    if (source) this.data.edited[k(source)] = Date.now();
    if (out) this.data.made[k(out)] = Date.now();
    await this.save();
  }

  /**
   * May an edit replace this clip's file? Only when it exists only on the NAS:
   * no PC name in its file name (so no PC's sync owns it), or the NAS editor made it.
   * Otherwise a PC that later edits its own copy would overwrite the NAS edit.
   */
  nasOnly(clip) {
    return !clip.pc || this.madeHere(clip.rel);
  }

  isHidden(id) {
    return !!this.data.hidden[id];
  }

  async hide(id) {
    this.data.hidden[id] = Date.now();
    await this.save();
  }

  async markSeen(at = Date.now()) {
    this.data.seenAt = at;
    await this.save();
  }
}
