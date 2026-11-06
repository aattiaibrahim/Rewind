import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Cleanup, TRASH } from "../src/cleanup.js";
import { scanLibrary } from "../src/library.js";

describe("cleanup", () => {
  let root, cache;
  const put = async (rel, bytes) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), Buffer.alloc(bytes, 1));
  };
  const make = async (allow = true, trashDays = 30) => {
    const c = new Cleanup({ root, cacheDir: cache, allow, trashDays });
    await c.init();
    return c;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hs-clean-"));
    cache = await mkdtemp(path.join(tmpdir(), "hs-clean-cache-"));
    await put("VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv", 3000);
    await put("VALORANT/VALORANT 2026-11-02 10-00-00 - PC1.mkv", 1000);
    await put("Rust/Rust 2026-11-01 10-00-00 - PC1.mkv", 2000);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  test("biggest first; Keep hides one until the next check", async () => {
    const c = await make();
    let clips = await scanLibrary(root);
    let l = c.list(clips);
    assert.deepEqual(l.clips.map((x) => x.size), [3000, 2000, 1000]);
    assert.equal(l.totalBytes, 6000);
    await c.keep(l.clips[0]);
    l = c.list(clips);
    assert.deepEqual(l.clips.map((x) => x.size), [2000, 1000]);
    assert.equal(l.kept, 1);
    // Remembered across restarts.
    l = (await make()).list(clips);
    assert.equal(l.kept, 1);
    await c.check();
    assert.equal(c.list(clips).clips.length, 3);
  });

  test("delete goes to a hidden trash that the scan skips, and restore puts it back", async () => {
    const c = await make();
    const big = (await scanLibrary(root)).find((x) => x.size === 3000);
    const entry = await c.toTrash(big);
    const after = await scanLibrary(root);
    assert.equal(after.length, 2);
    assert.ok((await readdir(path.join(root, TRASH, "VALORANT"))).includes(big.name));
    assert.equal(c.trashList().bytes, 3000);
    // The index lives on the NAS, next to the files.
    assert.equal(JSON.parse(await readFile(path.join(root, TRASH, "trash.json"), "utf8"))[0].rel, big.rel);
    await c.restore(entry.id);
    assert.equal((await scanLibrary(root)).length, 3);
    assert.equal(c.trashList().items.length, 0);
  });

  test("trash past its days is removed for good; Empty removes everything", async () => {
    const c = await make(true, 0);
    const clips = await scanLibrary(root);
    await c.toTrash(clips[0]);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await c.purge(), 1);
    assert.equal((await readdir(path.join(root, TRASH, path.dirname(clips[0].rel)))).length, 0);
    const k = await make(true, 30);
    await k.toTrash((await scanLibrary(root))[0]);
    assert.equal(await k.purge(), 0);
    assert.equal(await k.purge(true), 1);
  });

  test("shrink swaps in the smaller copy and trashes the original", async () => {
    const c = await make();
    const big = (await scanLibrary(root)).find((x) => x.size === 3000);
    const web = path.join(cache, "web.mp4");
    await writeFile(web, Buffer.alloc(500, 2));
    const out = await c.shrink(big, web);
    assert.equal(out.saved, 2500);
    assert.equal(out.name, "VALORANT 2026-11-03 10-00-00 - PC1.mp4");
    const now = await scanLibrary(root);
    const swapped = now.find((x) => x.name === out.name);
    assert.equal(swapped.size, 500);
    assert.equal(swapped.takenAt, big.takenAt);
    assert.equal(c.trashList().items[0].why, "replaced by a smaller copy");
    // A copy that isn't smaller is refused and nothing changes.
    await writeFile(web, Buffer.alloc(5000, 2));
    await assert.rejects(c.shrink(swapped, web), /isn't smaller/);
    assert.equal((await stat(path.join(root, swapped.rel))).size, 500);
  });

  test("with changes off it only lists", async () => {
    const c = await make(false);
    const clips = await scanLibrary(root);
    assert.equal(c.list(clips).canChange, false);
    await assert.rejects(c.toTrash(clips[0]), /Changes are off/);
    assert.equal((await scanLibrary(root)).length, 3);
  });
});
