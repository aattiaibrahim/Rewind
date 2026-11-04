// Hindsight Stream Deck plugin. Talks to Hindsight's local control API
// (127.0.0.1 only) and keeps every key's state in sync once a second.

const API = "http://127.0.0.1:52371";
const QUALITY_NAMES = { 30: "Small", 26: "Balanced", 22: "High", 18: "Max" };

let ws = null;
let lastStatus = null;
const keys = new Map(); // context -> { action, settings, shown: {title, state} }

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function call(method, path) {
  const res = await fetch(API + path, { method, headers: { "X-Rewind": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

// Entry point Stream Deck calls when it loads the plugin.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, pluginUUID, registerEvent) {
  ws = new WebSocket("ws://127.0.0.1:" + port);
  ws.onopen = () => {
    send({ event: registerEvent, uuid: pluginUUID });
    poll();
  };
  ws.onmessage = (m) => onMessage(JSON.parse(m.data));
}

function kind(action) {
  return action.split(".").pop(); // save | record | buffer | quality
}

function onMessage({ event, action, context, payload }) {
  switch (event) {
    case "willAppear":
      keys.set(context, { action: kind(action), settings: (payload && payload.settings) || {}, shown: {} });
      render(context);
      if (keys.size === 1) poll();
      break;
    case "willDisappear":
      keys.delete(context);
      break;
    case "didReceiveSettings":
      if (keys.has(context)) {
        keys.get(context).settings = (payload && payload.settings) || {};
        keys.get(context).shown = {};
        render(context);
      }
      break;
    case "keyDown":
      press(context);
      break;
  }
}

// Show a short message on the key (e.g. "Saving…", "Saved") instead of the
// live title; render() puts the normal title back when it expires.
function flash(context, title, ms) {
  const key = keys.get(context);
  if (!key) return;
  key.flashUntil = ms ? Date.now() + ms : Infinity;
  send({ event: "setTitle", context, payload: { title, target: 0 } });
  key.shown.title = title;
  if (ms) setTimeout(() => render(context), ms + 20);
}

async function press(context) {
  const key = keys.get(context);
  if (!key || key.busy) return;
  const s = key.settings || {};
  key.busy = true;
  try {
    if (key.action === "save") {
      // Hindsight replies only once the clip is written, so the check mark means "it's on disk".
      flash(context, "Saving…");
      const sec = Number(s.seconds || 0);
      await call("POST", "/save" + (sec ? "?seconds=" + sec : ""));
      flash(context, "Saved", 1500);
      send({ event: "showOk", context });
    } else if (key.action === "record") {
      const wasRecording = !!(lastStatus && lastStatus.recording);
      if (wasRecording) flash(context, "Saving…");
      await call("POST", "/record/toggle");
      if (wasRecording) flash(context, "Saved", 1500);
      send({ event: "showOk", context });
    } else if (key.action === "buffer") {
      await call("POST", "/buffer/toggle");
    } else if (key.action === "quality") {
      const q = new URLSearchParams();
      if (s.height !== undefined && s.height !== "" && s.height !== "keep") q.set("height", s.height);
      if (s.cq !== undefined && s.cq !== "" && s.cq !== "keep") q.set("cq", s.cq);
      await call("POST", "/quality?" + q.toString());
      send({ event: "showOk", context });
    }
    await poll();
  } catch (e) {
    flash(context, lastStatus ? "Failed" : "Hindsight\noff", 2000);
    send({ event: "showAlert", context });
  } finally {
    key.busy = false;
  }
}

async function poll() {
  try {
    lastStatus = await call("GET", "/status");
  } catch (e) {
    lastStatus = null; // Hindsight isn't running
  }
  keys.forEach((_, context) => render(context));
}

setInterval(() => {
  if (keys.size) poll();
}, 1000);

function mmss(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function heightLabel(h) {
  h = Number(h);
  if (!h) return "Screen";
  return h === 2160 ? "4K" : h + "p";
}

function qualityTitle(s) {
  const parts = [];
  if (s.height !== undefined && s.height !== "" && s.height !== "keep") parts.push(heightLabel(s.height));
  if (s.cq !== undefined && s.cq !== "" && s.cq !== "keep") parts.push(QUALITY_NAMES[s.cq] || "CQ " + s.cq);
  return parts.length ? parts.join("\n") : "Set me";
}

function render(context) {
  const key = keys.get(context);
  if (!key) return;
  const st = lastStatus;
  let title = "";
  let state = 0;
  if (!st) {
    title = key.action === "quality" ? qualityTitle(key.settings) : "Hindsight\noff";
  } else if (key.action === "save") {
    title = st.bufferOn ? "" : "Paused";
  } else if (key.action === "record") {
    state = st.recording ? 1 : 0;
    title = st.recording ? mmss(st.recordingSeconds) : "";
  } else if (key.action === "buffer") {
    state = st.bufferOn ? 1 : 0;
    title = st.bufferOn ? "On" : "Off";
  } else if (key.action === "quality") {
    title = qualityTitle(key.settings);
  }
  // Only send changes, so the deck isn't flooded every second. A flash message stays until it expires.
  const flashing = key.flashUntil && Date.now() < key.flashUntil;
  if (!flashing && key.shown.title !== title) {
    send({ event: "setTitle", context, payload: { title, target: 0 } });
    key.shown.title = title;
  }
  if ((key.action === "record" || key.action === "buffer") && key.shown.state !== state) {
    send({ event: "setState", context, payload: { state } });
    key.shown.state = state;
  }
}
