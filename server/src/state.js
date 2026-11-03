// Keeps the scanned library in memory and rescans when the folder changes.

import { watch } from "node:fs";
import { scanLibrary } from "./library.js";

export class Library {
  constructor(root, { rescanSeconds = 60, debounceMs = 1500 } = {}) {
    this.root = root;
    this.rescanSeconds = rescanSeconds;
    this.debounceMs = debounceMs;
    this.clips = [];
    this.byId = new Map();
    this.version = 0;
    this.scannedAt = null;
    this.scanning = null;
    this.again = false;
  }

  async start() {
    await this.rescan();
    this.watch();
    // Watch events can be missed (SMB/NFS mounts, folders created later): rescan now and then too.
    if (this.rescanSeconds > 0) this.timer = setInterval(() => this.rescan(), this.rescanSeconds * 1000).unref();
  }

  watch() {
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, () => this.soon());
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      // No recursive watch on this platform/filesystem: the periodic rescan covers it.
    }
  }

  soon() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.rescan(), this.debounceMs);
  }

  /** One scan at a time; a request during a scan runs one more afterwards. */
  async rescan() {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.again = false;
          const clips = await scanLibrary(this.root);
          const sig = (list) => list.map((c) => `${c.rel}|${c.size}|${c.mtime}`).sort().join("\n");
          if (this.version === 0 || sig(clips) !== sig(this.clips)) {
            this.clips = clips;
            this.byId = new Map(clips.map((c) => [c.id, c]));
            this.version++;
          }
          this.scannedAt = new Date().toISOString();
        } while (this.again);
      } catch (e) {
        console.error("scan failed:", e.message);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.watcher?.close();
  }
}
