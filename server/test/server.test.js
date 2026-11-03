// HTTP API against a temp library. The ffmpeg part runs only when ffmpeg is installed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Media } from "../src/media.js";
import { createServer } from "../src/server.js";
import { Library } from "../src/state.js";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("server", () => {
  let root, cache, server, base, library;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rewind-clips-"));
    cache = await mkdtemp(path.join(tmpdir(), "rewind-cache-"));
    await mkdir(path.join(root, "Game"));
    await writeFile(path.join(root, "Game", "Game 2026-11-03 10-00-00 - PC1.mkv"), Buffer.from("0123456789"));
    await writeFile(path.join(root, "Game", ".Game 2026-11-03 10-05-00 - PC1.mkv.rewind-partial"), "x");
    if (hasFfmpeg) {
      // Two seconds of test pattern with SILENT audio, in an MKV like Rewind writes.
      execFileSync(FFMPEG, [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000",
        "-map", "0:v", "-map", "1:a", "-map", "2:a", "-shortest",
        "-c:v", "libaom-av1", "-cpu-used", "8", "-c:a", "libopus",
        path.join(root, "Game", "Game 2026-11-03 11-00-00 - PC1.mkv"),
      ], { stdio: "ignore" });
    }
    library = new Library(root, { rescanSeconds: 0 });
    await library.start();
    const media = new Media({ cacheDir: cache });
    await media.init();
    server = await createServer({ library, media });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    library.stop();
    server.close();
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  const fake = () => library.clips.find((c) => c.name === "Game 2026-11-03 10-00-00 - PC1.mkv");

  test("lists clips without partial copies, with an ETag", async () => {
    const res = await fetch(`${base}/api/clips`);
    const data = await res.json();
    assert.ok(data.clips.every((c) => !c.name.includes("rewind-partial")));
    assert.ok(data.clips.some((c) => c.pc === "PC1"));
    assert.deepEqual(data.games, ["Game"]);
    assert.equal(typeof data.version, "string");
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.version, data.version);
    const again = await fetch(`${base}/api/clips`, { headers: { "if-none-match": res.headers.get("etag") } });
    assert.equal(again.status, 304);
  });

  test("serves the original with byte ranges and a download name", async () => {
    const c = fake();
    const part = await fetch(`${base}/api/clips/${c.id}/original`, { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await part.text(), "2345");
    const tail = await fetch(`${base}/api/clips/${c.id}/original`, { headers: { range: "bytes=-3" } });
    assert.equal(await tail.text(), "789");
    const bad = await fetch(`${base}/api/clips/${c.id}/original`, { headers: { range: "bytes=50-" } });
    assert.equal(bad.status, 416);
    const dl = await fetch(`${base}/api/clips/${c.id}/original?download`);
    assert.match(dl.headers.get("content-disposition"), /attachment; filename\*=UTF-8''Game%202026/);
  });

  test("unknown clips and path tricks are refused", async () => {
    assert.equal((await fetch(`${base}/api/clips/nope/original`)).status, 404);
    assert.notEqual((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 200);
  });

  test("serves the UI", async () => {
    const res = await fetch(`${base}/`);
    assert.match(await res.text(), /Rewind Server/);
  });

  test("thumbnail and phone version go to the cache, not the clips folder", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
    const c = library.clips.find((x) => x.name === "Game 2026-11-03 11-00-00 - PC1.mkv");
    const before = (await readdir(path.join(root, "Game"))).sort();

    const info = await (await fetch(`${base}/api/clips/${c.id}/info`)).json();
    assert.equal(info.video.codec, "av1");
    assert.equal(info.audio.length, 2);
    assert.equal(info.directPlay, false);

    const thumb = await fetch(`${base}/api/clips/${c.id}/thumb.jpg`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");
    assert.ok((await thumb.arrayBuffer()).byteLength > 500);

    let st = await (await fetch(`${base}/api/clips/${c.id}/web`, { method: "POST" })).json();
    for (let i = 0; i < 120 && st.state !== "ready" && st.state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await (await fetch(`${base}/api/clips/${c.id}/web`)).json();
    }
    assert.equal(st.state, "ready", st.error);
    const mp4 = await fetch(`${base}/api/clips/${c.id}/web.mp4`, { headers: { range: "bytes=0-" } });
    assert.equal(mp4.status, 206);
    assert.equal(mp4.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await mp4.arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp");

    const probe = JSON.parse(
      execFileSync(process.env.FFPROBE || "ffprobe", ["-v", "error", "-show_streams", "-of", "json", path.join(cache, "web", (await readdir(path.join(cache, "web")))[0])]),
    );
    assert.deepEqual(probe.streams.map((s) => s.codec_name), ["h264", "aac"]);

    assert.deepEqual((await readdir(path.join(root, "Game"))).sort(), before);
  });
});
