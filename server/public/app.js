import { filterClips, gamesOf, groupClips } from "./group.js";

const $ = (id) => document.getElementById(id);
const list = $("list");
const search = $("search");
const gameSel = $("game");
const more = $("more");
const PAGE = 120;

let clips = [];
let etag = null;
let shown = PAGE;

// ---- helpers ----

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter(Boolean));
  return e;
}

function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function duration(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function dayLabel(day) {
  const d = new Date(`${day}T12:00:00`);
  const today = new Date();
  const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key(d) === key(today)) return "Today";
  if (key(d) === key(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

const api = (id, action) => `api/clips/${encodeURIComponent(id)}/${action}`;

// ---- library ----

async function load() {
  try {
    const res = await fetch("api/clips", { cache: "no-cache" });
    const tag = res.headers.get("etag");
    if (tag && tag === etag) return;
    const data = await res.json();
    etag = tag;
    clips = data.clips;
    document.querySelector(".brand").title = `Rewind Server ${data.version}`;
    fillGames(data.games);
    render();
  } catch (e) {
    if (!clips.length) list.replaceChildren(el("p", { class: "empty error", text: "Can't reach Rewind Server." }));
  }
}

function fillGames(games) {
  const current = gameSel.value;
  gameSel.replaceChildren(el("option", { value: "", text: "All games" }), ...games.map((g) => el("option", { value: g, text: g })));
  gameSel.value = games.includes(current) ? current : "";
}

function render() {
  const found = filterClips(clips, { search: search.value, game: gameSel.value });
  $("count").textContent = clips.length ? `${found.length === clips.length ? "" : `${found.length} of `}${clips.length} clips` : "";
  if (!clips.length) {
    list.replaceChildren(
      el("div", { class: "empty" }, el("b", { text: "No clips yet" }), "Clips appear here once Rewind copies them to the NAS."),
    );
    more.hidden = true;
    return;
  }
  if (!found.length) {
    list.replaceChildren(el("div", { class: "empty" }, el("b", { text: "Nothing matches" }), "Try another search or game."));
    more.hidden = true;
    return;
  }
  // Only render the first `shown` clips; the rest load as you scroll.
  const visible = new Set(groupFlat(found).slice(0, shown).map((c) => c.id));
  const sections = [];
  for (const { day, games } of groupClips(found)) {
    const parts = [];
    let dayCount = 0;
    for (const { game, clips: gc } of games) {
      const cards = gc.filter((c) => visible.has(c.id)).map(card);
      dayCount += gc.length;
      if (cards.length) {
        parts.push(el("section", { class: "game" }, el("h3", { text: game }, el("span", { text: String(gc.length) })), el("div", { class: "grid" }, ...cards)));
      }
    }
    if (parts.length) {
      sections.push(el("section", { class: "day" }, el("h2", { text: dayLabel(day) }, el("span", { text: `${dayCount} clip${dayCount === 1 ? "" : "s"}` })), ...parts));
    }
  }
  list.replaceChildren(...sections);
  more.hidden = found.length <= shown;
}

/** Clips in display order (day, then game, then time). */
function groupFlat(found) {
  return groupClips(found).flatMap((d) => d.games.flatMap((g) => g.clips));
}

function card(c) {
  const img = el("img", { src: api(c.id, "thumb.jpg"), alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.classList.add("broken"));
  return el(
    "button",
    { class: "card", title: c.name, onclick: () => openClip(c) },
    el("div", { class: "thumb" }, img, c.recording && el("span", { class: "badge rec", text: "REC" }), el("span", { class: "badge ext", text: c.ext })),
    el(
      "div",
      { class: "info" },
      el("span", { class: "time", text: c.takenAt.slice(11, 16) }),
      el("span", { class: "sub", text: [c.pc, size(c.size)].filter(Boolean).join(" · ") }),
    ),
  );
}

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
  history.replaceState(null, "", `#clip=${c.id}`);
  $("player-title").textContent = `${c.game} · ${c.takenAt.slice(0, 10)} ${c.takenAt.slice(11)}`;
  $("player-meta").textContent = [c.pc, size(c.size), c.ext.toUpperCase()].filter(Boolean).join(" · ");
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

  $("player-meta").textContent = [c.pc, duration(info.duration), info.video && `${info.video.height}p ${info.video.codec.toUpperCase()}`, size(c.size)]
    .filter(Boolean)
    .join(" · ");

  if (info.directPlay) return playSrc(api(c.id, "original"));
  if (info.web.state === "ready") return showWeb(c, info);
  if (info.web.state === "working" || info.web.state === "queued") return convert(c, info);

  // Try the original first: desktop browsers often play MKV/HEVC/AV1. Phones usually can't.
  $("convert").hidden = false;
  $("convert").onclick = () => convert(c, info);
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
    convert(c, info);
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

async function convert(c, info) {
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
    return setStatus("Can't reach Rewind Server.", null, true);
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
  if (st.state === "ready") return showWeb(c, info);
  setStatus(`Conversion failed${st.error ? `: ${st.error}` : "."}`, null, true);
  $("convert").hidden = false;
  $("convert").textContent = "Try again";
}

function showWeb(c, info) {
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
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close(); // click on the backdrop
});

// ---- filters, paging, refresh ----

function syncUrl() {
  const p = new URLSearchParams();
  if (search.value) p.set("q", search.value);
  if (gameSel.value) p.set("game", gameSel.value);
  const qs = p.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

search.addEventListener("input", () => {
  shown = PAGE;
  syncUrl();
  render();
});
gameSel.addEventListener("change", () => {
  shown = PAGE;
  syncUrl();
  render();
});

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !more.hidden) {
    shown += PAGE;
    render();
  }
}, { rootMargin: "800px" }).observe(more);

const params = new URLSearchParams(location.search);
search.value = params.get("q") || "";

await load();
if (params.get("game")) {
  gameSel.value = params.get("game");
  render();
}
const deep = /#clip=([\w-]+)/.exec(location.hash);
if (deep) {
  const c = clips.find((x) => x.id === deep[1]);
  if (c) openClip(c);
}
setInterval(() => {
  if (!document.hidden) load();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
