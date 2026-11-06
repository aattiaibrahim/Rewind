// Montage on the NAS page: the same questions as the desktop app (how long,
// which clips, how much of each), then an editable list (order, in / out,
// remove), a song, volumes, and a download when it's made on the NAS.

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
};
const t = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const EDIT_MARK = /\((trim|H\.264|rescued|audio|\d+ MB)( \d+)?\)/i;
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const thumb = (c) => `api/clips/${encodeURIComponent(c.id)}/thumb.jpg`;

function cut(length, seconds, take) {
  if (!seconds || seconds >= length) return [0, length];
  if (take === "start") return [0, seconds];
  if (take === "middle") return [(length - seconds) / 2, (length + seconds) / 2];
  return [length - seconds, length];
}

const total = (pieces) => pieces.reduce((n, p) => n + (p.end - p.start), 0);

/** Mount the montage screen into `root`. `getClips` returns the library's clips. */
export function montage(root, getClips) {
  const s = { length: 120, source: "random", from: "", to: "", game: "", per: 15, take: "end" };
  let pieces = null;
  let song = null; // { id, name, duration }
  let songDb = -6;
  let clipDb = 0;
  let height = 1080;
  let job = null;

  const chips = (opts, value, set) =>
    el("div", { class: "chips" }, ...opts.map(([v, label]) => el("button", { class: `chip ${value === v ? "on" : ""}`, onclick: () => (set(v), draw()) }, label)));

  function pool() {
    return getClips().filter((c) => {
      if (/^montages$/i.test(c.game)) return false;
      if (s.game && key(c.game) !== key(s.game)) return false;
      const edited = EDIT_MARK.test(c.name) || /^edits$/i.test(c.game);
      if (s.source === "edited" && !edited) return false;
      if (s.source === "unedited" && edited) return false;
      if (s.source === "range") {
        if (s.from && c.day < s.from) return false;
        if (s.to && c.day > s.to) return false;
      }
      return !c.damaged;
    });
  }

  function create() {
    const list = pool();
    const order = s.source === "random" ? list.sort(() => Math.random() - 0.5) : list.sort((a, b) => a.mtime - b.mtime);
    pieces = [];
    for (const c of order) {
      if (total(pieces) >= s.length) break;
      const len = c.duration || 0;
      if (len < 1) continue;
      const [start, end] = cut(len, s.per, s.take);
      pieces.push({ c, start, end, len });
    }
    const over = total(pieces) - s.length;
    const last = pieces.at(-1);
    if (last && over > 0 && last.end - last.start - over >= 2) last.start += over;
    draw();
  }

  function setup() {
    const games = [...new Map(getClips().filter((c) => !/^montages$/i.test(c.game)).map((c) => [key(c.game), c.game])).values()].sort();
    const n = pool().length;
    return el(
      "div",
      { class: "montage-setup" },
      el("h3", { text: "How long should it be?" }),
      chips([[30, "30 s"], [60, "1 min"], [120, "2 min"], [180, "3 min"], [300, "5 min"], [600, "10 min"]], s.length, (v) => (s.length = v)),
      el("h3", { text: "Which clips?" }),
      el(
        "div",
        { class: "setup-cards" },
        ...[
          ["random", "Random clips", "A shuffle of the library"],
          ["range", "From a time frame", "Between two dates, in order"],
          ["edited", "Edited clips only", "Trimmed or exported ones"],
          ["unedited", "Unedited clips only", "Straight from the replay buffer"],
        ].map(([v, title, sub]) =>
          el("button", { class: `setup-card ${s.source === v ? "on" : ""}`, onclick: () => ((s.source = v), draw()) }, el("strong", { text: title }), el("small", { text: sub })),
        ),
      ),
      s.source === "range" &&
        el(
          "div",
          { class: "row" },
          el("input", { type: "date", value: s.from, onchange: (e) => ((s.from = e.target.value), draw()), "aria-label": "From" }),
          el("span", { class: "muted", text: "to" }),
          el("input", { type: "date", value: s.to, onchange: (e) => ((s.to = e.target.value), draw()), "aria-label": "To" }),
        ),
      el("h3", { text: "Game" }),
      chips([["", "All"], ...games.map((g) => [g, g])], s.game, (v) => (s.game = v)),
      el("h3", { text: "How much of each clip?" }),
      chips([[5, "5 s"], [10, "10 s"], [15, "15 s"], [20, "20 s"], [30, "30 s"], [0, "Whole clip"]], s.per, (v) => (s.per = v)),
      s.per > 0 && chips([["end", "The end"], ["middle", "The middle"], ["start", "The start"]], s.take, (v) => (s.take = v)),
      el(
        "div",
        { class: "row end" },
        el("span", { class: "muted", text: `${n} clip${n === 1 ? "" : "s"} to choose from. You can change everything afterwards.` }),
        el("button", { class: "btn primary", disabled: n === 0 || null, onclick: create }, "Create montage"),
      ),
    );
  }

  const preview = el("video", { class: "montage-preview", controls: true, playsinline: true });
  function play(p) {
    preview.src = `api/clips/${encodeURIComponent(p.c.id)}/original`;
    preview.currentTime = p.start;
    preview.play().catch(() => {});
    preview.ontimeupdate = () => preview.currentTime >= p.end && preview.pause();
  }

  async function uploadSong(file) {
    const status = root.querySelector(".song-status");
    if (status) status.textContent = "Uploading…";
    const res = await fetch("api/songs", { method: "POST", headers: { "x-filename": file.name }, body: file });
    const j = await res.json();
    if (!res.ok) {
      if (status) status.textContent = j.error || "Couldn't upload the song.";
      return;
    }
    song = { id: j.id, name: file.name, duration: j.duration };
    draw();
  }

  async function exportIt() {
    job = { state: "working", progress: 0 };
    draw();
    const res = await fetch("api/montage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pieces: pieces.map((p) => ({ id: p.c.id, start: p.start, end: p.end })), song: song?.id, songDb, clipDb, height, fps: 30 }),
    });
    job = await res.json();
    if (!res.ok) job = { state: "failed", error: job.error };
    while (job.state === "working") {
      draw();
      await new Promise((r) => setTimeout(r, 1500));
      job = await (await fetch(`api/montage/${job.id}`)).json();
    }
    draw();
  }

  function editor() {
    const rows = pieces.map((p, i) =>
      el(
        "div",
        { class: "mrow" },
        el("img", { src: thumb(p.c), alt: "", loading: "lazy", onclick: () => play(p) }),
        el("div", { class: "mrow-main" }, el("strong", { text: p.c.name }), el("small", { class: "muted", text: `${p.c.game} · uses ${t(p.end - p.start)} of ${t(p.len)}` })),
        el(
          "label",
          { class: "mrow-range" },
          "In",
          el("input", { type: "range", min: 0, max: p.len, step: 0.5, value: p.start, oninput: (e) => ((p.start = Math.min(+e.target.value, p.end - 0.5)), (e.target.nextSibling.textContent = t(p.start))), onchange: draw }),
          el("span", { class: "mono", text: t(p.start) }),
        ),
        el(
          "label",
          { class: "mrow-range" },
          "Out",
          el("input", { type: "range", min: 0, max: p.len, step: 0.5, value: p.end, oninput: (e) => ((p.end = Math.max(+e.target.value, p.start + 0.5)), (e.target.nextSibling.textContent = t(p.end))), onchange: draw }),
          el("span", { class: "mono", text: t(p.end) }),
        ),
        el(
          "div",
          { class: "mrow-btns" },
          el("button", { class: "round", title: "Earlier", disabled: i === 0 || null, onclick: () => (pieces.splice(i - 1, 0, pieces.splice(i, 1)[0]), draw()) }, "↑"),
          el("button", { class: "round", title: "Later", disabled: i === pieces.length - 1 || null, onclick: () => (pieces.splice(i + 1, 0, pieces.splice(i, 1)[0]), draw()) }, "↓"),
          el("button", { class: "round", title: "Remove", onclick: () => (pieces.splice(i, 1), draw()) }, "✕"),
        ),
      ),
    );
    const songInput = el("input", { type: "file", accept: "audio/*", hidden: true, onchange: (e) => e.target.files[0] && uploadSong(e.target.files[0]) });
    return el(
      "div",
      { class: "montage-editor" },
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn small", onclick: () => ((pieces = null), (job = null), draw()) }, "← Start over"),
        el("span", { class: "muted", text: `${pieces.length} clips · ${t(total(pieces))}` }),
      ),
      el("div", { class: "montage-top" }, preview, el("p", { class: "muted", text: "Tap a thumbnail to watch that part." })),
      el("div", { class: "mrows" }, ...rows),
      el(
        "div",
        { class: "montage-sound" },
        el("h3", { text: "Sound" }),
        el(
          "div",
          { class: "row" },
          song ? el("span", { text: `♪ ${song.name}` }) : el("span", { class: "muted song-status", text: "No song" }),
          songInput,
          el("button", { class: "btn small", onclick: () => songInput.click() }, song ? "Change song" : "Add a song"),
          song && el("button", { class: "btn small", onclick: () => ((song = null), draw()) }, "Remove"),
        ),
        el(
          "label",
          { class: "mrow-range" },
          "Clips",
          el("input", { type: "range", min: -60, max: 10, step: 1, value: clipDb, oninput: (e) => ((clipDb = +e.target.value), (e.target.nextSibling.textContent = clipDb <= -60 ? "Off" : `${clipDb > 0 ? "+" : ""}${clipDb} dB`)) }),
          el("span", { class: "mono", text: clipDb <= -60 ? "Off" : `${clipDb > 0 ? "+" : ""}${clipDb} dB` }),
        ),
        song &&
          el(
            "label",
            { class: "mrow-range" },
            "Song",
            el("input", { type: "range", min: -40, max: 10, step: 1, value: songDb, oninput: (e) => ((songDb = +e.target.value), (e.target.nextSibling.textContent = `${songDb > 0 ? "+" : ""}${songDb} dB`)) }),
            el("span", { class: "mono", text: `${songDb > 0 ? "+" : ""}${songDb} dB` }),
          ),
      ),
      el(
        "div",
        { class: "row end" },
        el(
          "select",
          { "aria-label": "Size", onchange: (e) => (height = +e.target.value) },
          ...[720, 1080].map((h) => el("option", { value: h, selected: h === height || null }, `${h}p`)),
        ),
        job?.state === "working"
          ? el("span", { class: "mono", text: `Making it on the NAS… ${Math.round((job.progress || 0) * 100)}%` })
          : el("button", { class: "btn primary", disabled: !pieces.length || null, onclick: exportIt }, "Make montage"),
      ),
      job?.state === "ready" && el("a", { class: "btn primary", href: `api/montage/${job.id}/file`, download: true }, "Download montage"),
      job?.state === "failed" && el("p", { class: "notice", text: job.error || "Making the montage failed." }),
      el("p", { class: "muted small", text: "Made on the NAS (it can take a few minutes) and kept for a day to download." }),
    );
  }

  function draw() {
    const scroll = root.closest(".page")?.scrollTop;
    root.replaceChildren(pieces ? editor() : setup());
    if (scroll != null) root.closest(".page").scrollTop = scroll;
  }
  return { draw };
}
