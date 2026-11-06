import { facet, filterClips, folders, gamesOf, groupByDay, sortBy } from "./group.js";

const $ = (id) => document.getElementById(id);
const list = $("list");
const scroller = $("scroller");
const search = $("search");
const chipsEl = $("chips");

// What's shown. Mode and sort are remembered per browser; the rest lives in the address.
const remembered = (k, d) => {
  try {
    return localStorage.getItem(`hs.${k}`) || d;
  } catch {
    return d;
  }
};
const remember = (k, v) => {
  try {
    localStorage.setItem(`hs.${k}`, v);
  } catch {
    /* only a convenience */
  }
};
let view = "clips"; // clips | cleanup | trash
let mode = remembered("mode", "gallery"); // gallery | folders | list
let order = remembered("sort", "new");
let game = "";
const EMPTY = { pcs: [], sources: [], kind: "", from: "", to: "", length: "", damaged: false };
let filters = { ...EMPTY };
let clips = [];
let etag = null;
let canChange = false;
let freeBytes = null;

// ---- helpers ----

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== ""));
  return e;
}

function size(bytes) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function duration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const dayTs = (day) => new Date(`${day}T12:00:00`).getTime();

/** "Today", "Yesterday", "Mon, Nov 2" (with the year when it isn't this year), like the desktop app. */
function dayLabel(day) {
  const d = new Date(dayTs(day));
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeOf(c) {
  const [h, m] = c.takenAt.slice(11, 16).split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function ago(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const codecLabel = (c) => ({ av1: "AV1", hevc: "HEVC", h264: "H.264", vp9: "VP9", mpeg2video: "MPEG-2" })[c] ?? (c || "").toUpperCase();
const sourceLabel = (s) => s || "Hindsight";
const api = (id, action) => `api/clips/${encodeURIComponent(id)}/${action}`;
const postJson = async (url) => {
  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

// ---- library ----

async function load() {
  try {
    const res = await fetch("api/clips", { cache: "no-cache" });
    const tag = res.headers.get("etag");
    if (tag && tag === etag) return;
    const data = await res.json();
    etag = tag;
    clips = data.clips;
    canChange = data.canChange;
    $("brand").title = `Hindsight on the NAS · ${data.release} (${data.version})`;
    if (view === "clips") render();
  } catch {
    if (!clips.length) list.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "Can't reach the server" }), "Check that the NAS is on."));
  }
}

const activeFilters = () =>
  filters.pcs.length + filters.sources.length + !!filters.kind + !!(filters.from || filters.to) + !!filters.length + !!filters.damaged;

function visibleClips() {
  return sortBy(filterClips(clips, { search: search.value, game, ...filters }), order);
}

function renderChips() {
  const games = gamesOf(clips);
  if (game && !games.includes(game)) game = "";
  const chip = (value, label) =>
    el("button", { class: `chip ${game === value ? "on" : ""}`, onclick: () => setGame(value), "aria-pressed": String(game === value) }, label);
  const kids = games.length > 1 && mode !== "folders" ? [chip("", "All"), ...games.map((g) => chip(g, g))] : [];
  const damaged = clips.filter((c) => c.damaged).length;
  if (damaged && mode !== "folders") {
    kids.push(
      el("button", { class: `chip bad ${filters.damaged ? "on" : ""}`, onclick: () => setFilters({ damaged: !filters.damaged }) }, "⚠ Damaged", el("small", { text: String(damaged) })),
    );
  }
  chipsEl.replaceChildren(...kids);
  chipsEl.hidden = !kids.length;
}

function setGame(g) {
  game = g;
  syncUrl();
  render();
  scroller.scrollTop = 0;
}

function setFilters(p) {
  filters = { ...filters, ...p };
  syncUrl();
  render();
}

/** The library at a glance: how many, how big, which games take the space. Unique to the NAS page. */
function renderSummary() {
  const box = $("summary");
  if (!clips.length) return (box.hidden = true);
  box.hidden = false;
  const total = clips.reduce((n, c) => n + c.size, 0);
  const pcs = new Set(clips.map((c) => c.pc).filter(Boolean));
  const fs = folders(clips).sort((a, b) => b.bytes - a.bytes);
  const top = fs.slice(0, 6);
  const rest = fs.slice(6).reduce((n, f) => n + f.bytes, 0);
  const shade = (i) => `color-mix(in srgb, var(--accent) ${100 - i * 14}%, var(--line-2))`;
  const seg = (bytes, color, title) => {
    const i = el("i", { title });
    i.style.width = `${(bytes / total) * 100}%`;
    i.style.background = color;
    return i;
  };
  box.replaceChildren(
    el(
      "div",
      { class: "summary-head" },
      el("span", { class: "eyebrow", text: "Your library on the NAS" }),
      el(
        "span",
        { class: "summary-stats" },
        el("b", { text: clips.length.toLocaleString() }),
        ` clip${clips.length === 1 ? "" : "s"} · `,
        el("b", { text: size(total) }),
        pcs.size ? ` · from ${pcs.size} PC${pcs.size === 1 ? "" : "s"}` : "",
        freeBytes !== null ? ` · ${size(freeBytes)} free` : "",
      ),
    ),
    el("div", { class: "summary-bar" }, ...top.map((f, i) => seg(f.bytes, shade(i), `${f.game}: ${size(f.bytes)}`)), rest ? seg(rest, "var(--line-2)", `Other games: ${size(rest)}`) : null),
    el(
      "div",
      { class: "summary-legend" },
      ...top.map((f, i) =>
        el(
          "button",
          { class: `legend ${game === f.game ? "on" : ""}`, onclick: () => setGame(game === f.game ? "" : f.game), title: `Show only ${f.game}` },
          el("i", { class: "dot", style: `background: ${shade(i)}` }),
          f.game,
          el("small", { text: size(f.bytes) }),
        ),
      ),
    ),
  );
}

function renderFilters() {
  const panel = $("filters");
  const n = activeFilters();
  $("filters-count").hidden = !n;
  $("filters-count").textContent = String(n);
  const toggleIn = (key, value) => {
    const cur = filters[key];
    setFilters({ [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] });
  };
  const group = (label, ...kids) => el("div", { class: "fgroup" }, el("span", { class: "flabel", text: label }), el("div", { class: "fopts" }, ...kids));
  const opt = (on, label, onclick, count) => el("button", { class: `chip small ${on ? "on" : ""}`, onclick }, label, count !== undefined ? el("small", { text: String(count) }) : null);
  const pcs = facet(clips, "pc");
  const sources = facet(clips, "source");
  const date = (key, label) => {
    const i = el("input", { type: "date", class: "date", value: filters[key], "aria-label": label });
    i.addEventListener("change", () => setFilters({ [key]: i.value }));
    return i;
  };
  panel.replaceChildren(
    pcs.length > 1 || (pcs.length && pcs[0][0]) ? group("PC", ...pcs.map(([v, c]) => opt(filters.pcs.includes(v), v || "Unknown", () => toggleIn("pcs", v), c))) : null,
    sources.length > 1 ? group("Made with", ...sources.map(([v, c]) => opt(filters.sources.includes(v), sourceLabel(v), () => toggleIn("sources", v), c))) : null,
    group(
      "Type",
      opt(!filters.kind, "Any", () => setFilters({ kind: "" })),
      opt(filters.kind === "clip", "Clips", () => setFilters({ kind: "clip" })),
      opt(filters.kind === "recording", "Recordings", () => setFilters({ kind: "recording" })),
    ),
    group(
      "Length",
      opt(!filters.length, "Any", () => setFilters({ length: "" })),
      opt(filters.length === "short", "Under 30 s", () => setFilters({ length: "short" })),
      opt(filters.length === "medium", "30 s – 2 min", () => setFilters({ length: "medium" })),
      opt(filters.length === "long", "Over 2 min", () => setFilters({ length: "long" })),
    ),
    group("Date", date("from", "From"), el("span", { class: "muted", text: "to" }), date("to", "To")),
    group("", opt(filters.damaged, "⚠ Damaged only", () => setFilters({ damaged: !filters.damaged })), n ? el("button", { class: "btn small", onclick: () => setFilters({ ...EMPTY }) }, "Clear filters") : null),
  );
}

function render() {
  renderSummary();
  renderChips();
  renderFilters();
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("sort").value = order;
  const found = visibleClips();
  $("clips-title").textContent = mode === "folders" && game ? game : "Clips";
  if (!clips.length) {
    list.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "No clips yet" }), el("span", { text: "Clips show up here once Hindsight copies them to the NAS." })));
    return timeline.set([]);
  }
  if (!found.length) {
    list.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "Nothing matches" }), activeFilters() ? el("button", { class: "btn", onclick: () => setFilters({ ...EMPTY }) }, "Clear filters") : null));
    return timeline.set([]);
  }
  if (mode === "folders" && !game) return renderFolders(found);
  const crumbs = mode === "folders" ? el("button", { class: "btn small back", onclick: () => setGame("") }, "‹ All folders") : null;
  if (mode === "list") {
    list.replaceChildren(...[crumbs, el("div", { class: "rows list" }, ...found.map(listRow))].filter(Boolean));
    return timeline.set([]);
  }
  // Gallery: by day for date orders (with the timeline); one grid for size and length.
  if (order === "big" || order === "long") {
    list.replaceChildren(...[crumbs, el("div", { class: "grid" }, ...found.map(card))].filter(Boolean));
    return timeline.set([]);
  }
  const days = groupByDay(found);
  if (order === "old") {
    days.reverse();
    days.forEach((d) => d.clips.reverse());
  }
  list.replaceChildren(
    ...[crumbs].filter(Boolean),
    ...days.map(({ day, clips: items }) =>
      el(
        "section",
        { class: "day", "data-day": day },
        el("div", { class: "day-head" }, el("h3", { text: dayLabel(day) }), el("span", { class: "muted", text: `${items.length} clip${items.length === 1 ? "" : "s"}` })),
        el("div", { class: "grid" }, ...items.map(card)),
      ),
    ),
  );
  timeline.set(days.map((d) => ({ key: d.day, ts: dayTs(d.day) })));
}

function thumbImg(c) {
  const img = el("img", { src: api(c.id, "thumb.jpg"), alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.classList.add("broken"));
  return img;
}

function tags(c) {
  return [
    c.damaged && el("span", { class: "src-tag bad", title: c.why ? `Can't be read: ${c.why}` : "Can't be read", text: "⚠ Damaged" }),
    c.recording && el("span", { class: "src-tag rec", text: "● REC" }),
    c.source && el("span", { class: "src-tag", text: c.source }),
    c.pc && el("span", { class: "src-tag", text: c.pc }),
  ];
}

function card(c) {
  const meta = [c.game, `${dayLabel(c.day)} ${timeOf(c)}`, size(c.size), c.codec && `${codecLabel(c.codec)} ${c.ext.toUpperCase()}`].filter(Boolean).join(" · ");
  return el(
    "button",
    { class: "card", title: c.name, onclick: () => openClip(c) },
    el(
      "div",
      { class: "thumb" },
      thumbImg(c),
      c.duration ? el("span", { class: "badge", text: duration(c.duration) }) : null,
      el("div", { class: "card-tags" }, ...tags(c)),
      el("div", { class: "card-over" }, el("div", { class: "card-title", text: c.name }), el("div", { class: "card-meta", text: meta })),
    ),
  );
}

function renderFolders(found) {
  const fs = folders(found);
  list.replaceChildren(
    el(
      "div",
      { class: "folders" },
      ...fs.map((f) =>
        el(
          "button",
          { class: "folder", onclick: () => setGame(f.game), title: `Open ${f.game}` },
          el("div", { class: "folder-cover" }, ...f.clips.slice(0, 3).map((c, i) => el("div", { class: `cover c${i}` }, thumbImg(c)))),
          el("div", { class: "folder-name", text: f.game }),
          el("div", { class: "folder-meta", text: `${f.clips.length} clip${f.clips.length === 1 ? "" : "s"} · ${size(f.bytes)} · newest ${dayLabel(f.newest.day)}` }),
        ),
      ),
    ),
  );
  timeline.set([]);
}

function listRow(c) {
  return el(
    "button",
    { class: "row-item", onclick: () => openClip(c), title: c.name },
    el("div", { class: "row-thumb" }, thumbImg(c)),
    el(
      "div",
      { class: "row-main" },
      el("div", { class: "row-title", text: c.name }),
      el("div", { class: "row-meta" }, `${c.game} · ${dayLabel(c.day)} ${timeOf(c)}${c.duration ? ` · ${duration(c.duration)}` : ""}${c.codec ? ` · ${codecLabel(c.codec)}` : ""}`, " ", ...tags(c)),
    ),
    el("div", { class: "row-size", text: size(c.size) }),
  );
}

// ---- date scrubber (a port of the desktop app's Timeline.tsx) ----

const timeline = (() => {
  const rail = $("rail");
  let days = [];
  let marks = [];
  let dragging = false;
  const view = el("div", { class: "tl-view" });
  const bubble = el("div", { class: "tl-bubble" });

  const label = (ts) =>
    new Date(ts).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });

  function measure() {
    const total = Math.max(1, scroller.scrollHeight);
    const h = rail.clientHeight;
    let lastMonth = "";
    let lastYear = "";
    let lastLabelY = -99;
    marks = [];
    const ticks = [];
    for (const d of days) {
      const sec = list.querySelector(`[data-day="${CSS.escape(d.key)}"]`);
      if (!sec) continue;
      const y = (sec.offsetTop / total) * h;
      const date = new Date(d.ts);
      const month = date.toLocaleDateString(undefined, { month: "short" });
      const year = String(date.getFullYear());
      const m = { key: d.key, ts: d.ts, y };
      // Like Immich: every year gets a label where it starts; months where they change, if there's room.
      if (year !== lastYear) {
        m.year = year;
        if (y - lastLabelY > 26) m.month = month;
        lastLabelY = y;
      } else if (month !== lastMonth && y - lastLabelY > 16) {
        m.month = month;
        lastLabelY = y;
      }
      lastMonth = month;
      lastYear = year;
      marks.push(m);
      const tick = el("span", { class: `tl-day ${m.month || m.year ? "month" : ""} ${m.year ? "year" : ""}` });
      tick.style.top = `${y}px`;
      if (m.month || m.year) tick.append(el("em", {}, m.year && el("b", { text: m.year }), m.month || ""));
      ticks.push(tick);
    }
    rail.replaceChildren(view, ...ticks, bubble);
    position();
  }

  function position() {
    const total = Math.max(1, scroller.scrollHeight);
    const h = rail.clientHeight;
    view.style.top = `${(scroller.scrollTop / total) * h}px`;
    view.style.height = `${Math.max(3, (scroller.clientHeight / total) * h)}px`;
  }

  const dayAt = (y) => {
    let best = marks[0];
    for (const m of marks) if (m.y <= y + 1) best = m;
    return best;
  };

  function jump(clientY) {
    const rect = rail.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const d = dayAt(y);
    // Snap to the start of the day under the pointer, like Immich.
    const sec = d && list.querySelector(`[data-day="${CSS.escape(d.key)}"]`);
    scroller.scrollTop = sec ? sec.offsetTop - 8 : (y / rect.height) * scroller.scrollHeight;
  }

  function hover(clientY) {
    const rect = rail.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const d = dayAt(y);
    if (!d) return;
    bubble.textContent = label(d.ts);
    bubble.style.top = `${y}px`;
    rail.classList.add("active");
  }

  rail.addEventListener("pointermove", (e) => {
    if (rail.classList.contains("empty-rail")) return;
    hover(e.clientY);
    if (dragging) jump(e.clientY);
  });
  rail.addEventListener("pointerleave", () => !dragging && rail.classList.remove("active"));
  rail.addEventListener("pointerdown", (e) => {
    if (rail.classList.contains("empty-rail")) return;
    dragging = true;
    rail.setPointerCapture(e.pointerId);
    hover(e.clientY);
    jump(e.clientY);
  });
  const stop = () => {
    dragging = false;
    if (matchMedia("(hover: none)").matches) rail.classList.remove("active");
  };
  rail.addEventListener("pointerup", stop);
  rail.addEventListener("pointercancel", stop);
  scroller.addEventListener("scroll", position, { passive: true });
  new ResizeObserver(() => days.length > 1 && measure()).observe(list);
  addEventListener("resize", () => days.length > 1 && measure());

  return {
    set(next) {
      days = next;
      const empty = days.length < 2;
      rail.classList.toggle("empty-rail", empty);
      if (empty) rail.replaceChildren();
      else requestAnimationFrame(measure);
    },
  };
})();

// ---- player ----

const dialog = $("player");
const video = $("video");
let session = 0; // bumps on every open/close so stale polls stop

function setStatus(text, progress = null, isError = false) {
  $("status").hidden = !text;
  $("status-text").textContent = text || "";
  $("status-text").className = isError ? "error" : "";
  $("status-bar").parentElement.hidden = progress === null;
  if (progress !== null) $("status-bar").style.width = `${Math.round(progress * 100)}%`;
}

function playSrc(src) {
  setStatus("");
  video.src = src;
  video.play().catch(() => {});
}

async function openClip(c) {
  const my = ++session;
  history.replaceState(null, "", `${location.pathname}${location.search}#clip=${c.id}`);
  $("player-title").textContent = `${c.game} · ${dayLabel(c.day)}, ${timeOf(c)}`;
  $("player-meta").textContent = [c.pc, c.source, size(c.size), c.ext.toUpperCase()].filter(Boolean).join(" · ");
  $("dl-original").href = `${api(c.id, "original")}?download`;
  $("dl-web").hidden = true;
  $("convert").hidden = true;
  $("try-original").hidden = true;
  $("note").hidden = true;
  video.removeAttribute("src");
  video.load();
  setStatus("Loading…");
  if (!dialog.open) dialog.showModal();

  let info;
  try {
    info = await (await fetch(api(c.id, "info"))).json();
  } catch {
    info = null;
  }
  if (my !== session) return;
  if (!info || info.error) return setStatus(`Can't read this clip${info?.error ? `: ${info.error}` : "."}`, null, true);

  $("player-meta").textContent = [c.pc, c.source, duration(info.duration), info.video && `${info.video.height}p ${codecLabel(info.video.codec)}`, size(c.size)]
    .filter(Boolean)
    .join(" · ");

  if (info.directPlay) return playSrc(api(c.id, "original"));
  if (info.web.state === "ready") return showWeb(c);
  if (info.web.state === "working" || info.web.state === "queued") return convert(c);

  // Try the original first: desktop browsers often play MKV/HEVC/AV1. Phones usually can't.
  $("convert").hidden = false;
  $("convert").onclick = () => convert(c);
  if (info.audio.length > 1) {
    $("note").hidden = false;
    $("note").textContent = "The original has separate desktop and mic tracks; the browser plays only the first. The phone version mixes them.";
  }
  tryOriginal(c, info, my);
}

function tryOriginal(c, info, my) {
  let settled = false;
  const fail = () => {
    if (settled || my !== session) return;
    settled = true;
    cleanup();
    convert(c);
  };
  const ok = () => {
    if (settled || my !== session) return;
    // Some browsers "play" an unsupported video track as audio only.
    if (info.video && video.videoWidth === 0) return fail();
    settled = true;
    cleanup();
  };
  const timer = setTimeout(fail, 8000);
  const cleanup = () => {
    clearTimeout(timer);
    video.removeEventListener("error", fail);
    video.removeEventListener("loadeddata", ok);
  };
  video.addEventListener("error", fail);
  video.addEventListener("loadeddata", ok);
  playSrc(api(c.id, "original"));
}

async function convert(c) {
  const my = session;
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("convert").hidden = true;
  setStatus("Making a version that plays everywhere…", 0);
  let st;
  try {
    st = await (await fetch(api(c.id, "web"), { method: "POST" })).json();
  } catch {
    return setStatus("Can't reach the server.", null, true);
  }
  while (my === session && (st.state === "queued" || st.state === "working")) {
    setStatus(st.state === "queued" ? "Waiting for another conversion to finish…" : `Making a version that plays everywhere… ${Math.round(st.progress * 100)}%`, st.progress);
    await new Promise((r) => setTimeout(r, 1500));
    if (my !== session) return;
    try {
      st = await (await fetch(api(c.id, "web"))).json();
    } catch {
      /* keep polling */
    }
  }
  if (my !== session) return;
  if (st.state === "ready") return showWeb(c);
  setStatus(`Conversion failed${st.error ? `: ${st.error}` : "."}`, null, true);
  $("convert").hidden = false;
  $("convert").textContent = "Try again";
}

function showWeb(c) {
  $("dl-web").hidden = false;
  $("dl-web").href = `${api(c.id, "web.mp4")}?download`;
  $("try-original").hidden = false;
  $("try-original").onclick = () => {
    $("try-original").hidden = true;
    playSrc(api(c.id, "original"));
  };
  playSrc(api(c.id, "web.mp4"));
}

function closePlayer() {
  session++;
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

$("close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", closePlayer);
dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());

// ---- storage ----

async function loadStorage() {
  try {
    const s = await (await fetch("api/storage", { cache: "no-cache" })).json();
    const pct = s.disk ? s.disk.used / s.disk.total : 0;
    freeBytes = s.disk ? s.disk.free : null;
    $("storage-text").replaceChildren(
      el("span", { class: "used", text: s.disk ? `${size(s.clips.bytes)} · ` : size(s.clips.bytes) }),
      s.disk && el("span", { text: `${size(s.disk.free)} free` }),
    );
    $("storage-fill").style.width = `${Math.round(pct * 100)}%`;
    $("storage-fill").parentElement.className = `meter ${pct > 0.95 ? "full" : pct > 0.85 ? "high" : ""}`;
    if (view === "clips") renderSummary();
    return s;
  } catch {
    return null;
  }
}

async function openStorage() {
  const dlg = $("storage");
  if (!dlg.open) dlg.showModal();
  const s = await loadStorage();
  if (!s) {
    $("storage-body").replaceChildren(el("p", { class: "error", text: "Can't read the storage right now." }));
    return;
  }
  $("storage-sub").textContent = `${s.clips.count} clips in ${s.games.length} game${s.games.length === 1 ? "" : "s"}`;
  const parts = [];
  if (s.disk) {
    const other = Math.max(0, s.disk.used - s.clips.bytes);
    const w = (b) => `${((b / s.disk.total) * 100).toFixed(2)}%`;
    const clipBar = el("i", { class: "clips" });
    clipBar.style.width = w(Math.min(s.clips.bytes, s.disk.used));
    const otherBar = el("i", { class: "other" });
    otherBar.style.width = w(other);
    parts.push(
      el(
        "div",
        { class: "disk" },
        el("div", { class: "disk-bar" }, clipBar, otherBar),
        el(
          "div",
          { class: "disk-legend" },
          el("span", {}, el("i", { class: "dot", style: "background: var(--accent)" }), "Clips ", el("b", { text: size(s.clips.bytes) })),
          other > 0 && el("span", {}, el("i", { class: "dot", style: "background: color-mix(in srgb, var(--accent) 35%, var(--line-2))" }), "Other files ", el("b", { text: size(other) })),
          el("span", {}, el("i", { class: "dot", style: "background: var(--line-2)" }), "Free ", el("b", { text: size(s.disk.free) })),
          el("span", {}, "of ", el("b", { text: size(s.disk.total) })),
        ),
        el("small", { class: "muted", text: `Thumbnails and phone versions use ${size(s.cache.bytes)} more, in the app's own storage.` }),
      ),
    );
  }
  const top = s.games[0]?.bytes || 1;
  parts.push(
    el(
      "div",
      { class: "games" },
      el("h3", { text: "By game" }),
      ...s.games.map((g) => {
        const bar = el("i");
        bar.style.width = `${Math.max(1, (g.bytes / top) * 100)}%`;
        return el(
          "div",
          { class: "game-row" },
          el("span", { text: g.game }),
          el("b", { text: size(g.bytes) }),
          el("div", { class: "gbar" }, bar),
          el("small", { text: `${g.count} clip${g.count === 1 ? "" : "s"} · ${Math.round((g.bytes / Math.max(1, s.clips.bytes)) * 100)}%` }),
        );
      }),
    ),
  );
  $("storage-body").replaceChildren(...parts);
}

$("storage-btn").addEventListener("click", openStorage);
$("storage-close").addEventListener("click", () => $("storage").close());
$("storage").addEventListener("click", (e) => e.target === $("storage") && $("storage").close());
$("storage-cleanup").addEventListener("click", () => {
  $("storage").close();
  showView("cleanup");
});

// ---- cleanup ----

async function loadCleanup() {
  const box = $("cleanup-list");
  let data;
  try {
    data = await (await fetch("api/cleanup", { cache: "no-cache" })).json();
  } catch {
    return box.replaceChildren(el("p", { class: "error", text: "Can't reach the server." }));
  }
  canChange = data.canChange;
  $("cleanup-readonly").hidden = data.canChange;
  const pct = Math.round((data.shownBytes / Math.max(1, data.totalBytes)) * 100);
  $("cleanup-lead").replaceChildren(
    el(
      "span",
      {},
      data.clips.length
      ? `The ${data.clips.length} biggest clips use ${size(data.shownBytes)}, ${pct}% of all your clips. `
      : "Nothing left to look at: every big clip has been kept or cleaned up. ",
    data.canChange ? `Delete moves a clip to the trash for ${data.trashDays} days. Shrink swaps it for a smaller H.264 copy. ` : "",
    "Keep hides it until your next cleanup check.",
    data.kept ? el("span", { class: "muted", text: ` ${data.kept} kept since the last check.` }) : null,
    ),
  );
  box.replaceChildren(...data.clips.map((c) => cleanupRow(c, data)));
}

function cleanupRow(c, data) {
  const status = el("span", { class: "row-status muted" });
  const buttons = [];
  const act = async (label, fn) => {
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = label;
    try {
      await fn();
      row.classList.add("gone");
      setTimeout(() => {
        row.remove();
        load();
        loadStorage();
        loadTrashCount();
      }, 250);
    } catch (e) {
      status.textContent = e.message;
      status.className = "row-status error";
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  const shrink = async () => {
    for (;;) {
      const st = await postJson(api(c.id, "shrink"));
      if (st.state === "done") return (status.textContent = `Saved ${size(st.saved)}`);
      if (st.state === "failed") throw new Error(st.error || "The H.264 copy failed.");
      status.textContent = st.state === "queued" ? "Waiting for another conversion…" : `Making the smaller copy… ${Math.round((st.progress || 0) * 100)}%`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  const btn = (label, cls, title, fn, needsChange) => {
    const b = el("button", { class: `btn small ${cls}`, title: needsChange && !data.canChange ? "Changes are off on this server" : title, onclick: (e) => (e.stopPropagation(), fn()) }, label);
    if (needsChange && !data.canChange) b.disabled = true;
    buttons.push(b);
    return b;
  };
  const row = el(
    "div",
    { class: "row-item" },
    el("button", { class: "row-thumb", onclick: () => openClip(c), title: "Play" }, thumbImg(c), c.duration ? el("span", { class: "badge", text: duration(c.duration) }) : null),
    el(
      "div",
      { class: "row-main" },
      el("div", { class: "row-title", text: c.name }),
      el("div", { class: "row-meta" }, `${c.game} · ${dayLabel(c.day)}${c.codec ? ` · ${c.height ? `${c.height}p ` : ""}${codecLabel(c.codec)}` : ""}`, " ", ...tags(c)),
      status,
    ),
    el("div", { class: "row-size big", text: size(c.size) }),
    el(
      "div",
      { class: "row-actions" },
      btn("Keep", "", "Hide it until the next cleanup check", () => act("Keeping…", () => postJson(api(c.id, "keep")))),
      btn("Shrink", "", "Swap it for a smaller H.264 copy (the original goes to the trash)", () => act("Shrinking…", shrink), true),
      btn("Delete", "danger", `Move it to the trash for ${data.trashDays} days`, () => act("Deleting…", () => postJson(api(c.id, "trash"))), true),
    ),
  );
  return row;
}

$("check").addEventListener("click", async () => {
  $("check").disabled = true;
  try {
    await postJson("api/cleanup/check");
    await loadCleanup();
  } finally {
    $("check").disabled = false;
  }
});

// ---- trash ----

async function loadTrashCount() {
  try {
    const t = await (await fetch("api/trash", { cache: "no-cache" })).json();
    $("trash-count").textContent = t.items.length ? String(t.items.length) : "";
    return t;
  } catch {
    return null;
  }
}

async function loadTrash() {
  const t = await loadTrashCount();
  const box = $("trash-list");
  if (!t) return box.replaceChildren(el("p", { class: "error", text: "Can't reach the server." }));
  $("empty-trash").hidden = !t.items.length || !t.canChange;
  $("trash-lead").textContent = t.items.length
    ? `${t.items.length} clip${t.items.length === 1 ? "" : "s"}, ${size(t.bytes)}. Each one is removed for good ${t.trashDays} days after it was deleted. Restore puts it back where it was.`
    : `Deleted clips wait here for ${t.trashDays} days before they're removed for good.`;
  box.replaceChildren(
    ...(t.items.length ? [] : [el("div", { class: "empty" }, el("strong", { text: "The trash is empty" }))]),
    ...t.items.map((e) => {
      const status = el("span", { class: "row-status muted" });
      const restore = el("button", { class: "btn small" }, "Restore");
      restore.disabled = !t.canChange;
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          await postJson(`api/trash/${encodeURIComponent(e.id)}/restore`);
          loadTrash();
          load();
          loadStorage();
        } catch (err) {
          status.textContent = err.message;
          restore.disabled = false;
        }
      });
      const gone = new Date(e.removeAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return el(
        "div",
        { class: "row-item" },
        el("div", { class: "row-thumb trashed", text: "🗑" }),
        el("div", { class: "row-main" }, el("div", { class: "row-title", text: e.name }), el("div", { class: "row-meta", text: `${e.game} · ${e.why} ${ago(e.trashedAt)} · removed for good on ${gone}` }), status),
        el("div", { class: "row-size", text: size(e.size) }),
        el("div", { class: "row-actions" }, restore),
      );
    }),
  );
}

$("empty-trash").addEventListener("click", async () => {
  if (!confirm("Remove everything in the trash for good? This can't be undone.")) return;
  try {
    await postJson("api/trash/empty");
  } catch (e) {
    alert(e.message);
  }
  loadTrash();
  loadStorage();
});

// ---- views, filters, refresh ----

function showView(v) {
  view = v;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === v));
  for (const name of ["clips", "cleanup", "trash"]) $(`view-${name}`).hidden = name !== v;
  scroller.scrollTop = 0;
  if (v === "clips") render();
  else timeline.set([]);
  if (v === "cleanup") loadCleanup();
  if (v === "trash") loadTrash();
  syncUrl();
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    remember("mode", mode);
    if (mode === "folders") game = "";
    syncUrl();
    render();
  }),
);
$("sort").addEventListener("change", () => {
  order = $("sort").value;
  remember("sort", order);
  render();
});
$("filters-btn").addEventListener("click", () => {
  const open = $("filters").hidden;
  $("filters").hidden = !open;
  $("filters-btn").setAttribute("aria-expanded", String(open));
});

function syncUrl() {
  const p = new URLSearchParams();
  if (view !== "clips") p.set("view", view);
  if (search.value) p.set("q", search.value);
  if (game) p.set("game", game);
  for (const [k, v] of Object.entries(filters)) {
    if (Array.isArray(v) ? v.length : v) p.set(k, Array.isArray(v) ? v.join("|") : String(v));
  }
  const qs = p.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

search.addEventListener("input", () => {
  syncUrl();
  render();
});

const params = new URLSearchParams(location.search);
search.value = params.get("q") || "";
game = params.get("game") || "";
for (const k of Object.keys(EMPTY)) {
  const v = params.get(k);
  if (v === null) continue;
  filters[k] = Array.isArray(EMPTY[k]) ? v.split("|") : typeof EMPTY[k] === "boolean" ? v === "true" : v;
}
if (activeFilters()) $("filters").hidden = false;

await load();
loadStorage();
loadTrashCount();
if (["cleanup", "trash"].includes(params.get("view"))) showView(params.get("view"));
const deep = /#clip=([\w-]+)/.exec(location.hash);
if (deep) {
  const c = clips.find((x) => x.id === deep[1]);
  if (c) openClip(c);
}
setInterval(() => {
  if (!document.hidden) load();
}, 15000);
setInterval(() => {
  if (!document.hidden) loadStorage();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    load();
    loadStorage();
  }
});
