// Montages and sharing. The render runs only when ffmpeg is installed;
// sharing uses a fake upload host, so nothing leaves the machine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { Montages, montageArgs } from "../src/montage.js";
import { Shares } from "../src/share.js";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const has = (cmd) => {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("montage", () => {
  test("joins pieces at one size, mixes tracks and fades the song", () => {
    const { args, total } = montageArgs(
      {
        pieces: [
          { file: "a.mkv", start: 1, end: 3, audioTracks: 2 },
          { file: "b.mp4", start: 0, end: 1.5, audioTracks: 0 },
        ],
        music: { file: "song.mp3", offset: 10, volumeDb: -6 },
        height: 720,
        fps: 30,
      },
      "out.mp4",
    );
    assert.equal(total, 3.5);
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.match(graph, /scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/);
    assert.match(graph, /\[0:a:0\]\[0:a:1\]amix=inputs=2/, "a clip's game and mic are mixed");
    assert.match(graph, /anullsrc/, "a clip without sound gets silence");
    assert.match(graph, /concat=n=2:v=1:a=1/);
    assert.match(graph, /afade=t=out:st=1.500:d=2/);
    assert.deepEqual(args.slice(args.indexOf("-stream_loop"), args.indexOf("-stream_loop") + 4), ["-stream_loop", "-1", "-ss", "10.000"]);
    assert.equal(args.at(-1), "out.mp4");
  });

  test("an empty montage is refused", () => {
    assert.throws(() => montageArgs({ pieces: [] }, "out.mp4"), /Add some clips/);
  });

  test("songs only by safe names", () => {
    const m = new Montages(tmpdir());
    assert.throws(() => m.songPath("../../etc/passwd"));
    assert.ok(m.songPath("0f1e-2d3c.mp3").endsWith("0f1e-2d3c.mp3"));
  });

  test("renders a real montage", { skip: !(has(FFMPEG) && has(FFPROBE)) && "ffmpeg not installed" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hindsight-montage-"));
    const clip = path.join(dir, "a.mkv");
    execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "mpeg4", "-c:a", "aac", clip]);
    const m = new Montages(dir, { encoder: "mpeg4" });
    const id = await m.start({ pieces: [{ file: clip, start: 0, end: 1.5, audioTracks: 1 }, { file: clip, start: 1, end: 3, audioTracks: 1 }], height: 360, fps: 30 });
    for (let i = 0; i < 100 && m.status(id).state === "working"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(m.status(id).state, "ready", m.status(id).error);
    const dur = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", m.file(id)]).toString());
    assert.ok(Math.abs(dur - 3.5) < 0.3, String(dur));
    await rm(dir, { recursive: true, force: true });
  });
});

describe("share", () => {
  test("uploads the phone version and remembers the link", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hindsight-share-"));
    const file = path.join(dir, "web.mp4");
    await writeFile(file, Buffer.alloc(1000, 1));
    let sent = null;
    const fake = async (url, opts) => {
      sent = { url, form: opts.body };
      return { ok: true, text: async () => "https://files.catbox.moe/abc123.mp4" };
    };
    const s = new Shares(dir, fake);
    const link = await s.share("clip1", file, "VALORANT 2026-11-06.mkv", "catbox");
    assert.equal(link.url, "https://files.catbox.moe/abc123.mp4");
    assert.equal(sent.url, "https://catbox.moe/user/api.php");
    assert.equal(sent.form.get("fileToUpload").name, "VALORANT 2026-11-06.mp4");
    assert.equal((await new Shares(dir, fake).list("clip1"))[0].url, link.url, "kept across restarts");
    const lit = await s.share("clip1", file, "a.mkv", "litterbox");
    assert.ok(lit.expires > Date.now());
    await assert.rejects(new Shares(dir, async () => ({ ok: false, status: 500, text: async () => "nope" })).share("c", file, "a.mkv"), /Catbox said/);
    await rm(dir, { recursive: true, force: true });
  });
});
