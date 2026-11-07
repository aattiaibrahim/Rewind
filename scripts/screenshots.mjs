// Screenshots of the app (dev mock) for the website and README, at 2000x1175.
// Start the "rewind-ui" preview (Vite on 1420) first, then: node scripts/screenshots.mjs <outDir>
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new",
  "--remote-debugging-port=9339",
  "--window-size=1400,822",
  "--force-device-scale-factor=1.4286",
  "--hide-scrollbars",
  "--mute-audio",
  `--user-data-dir=${out}/../snap-profile`,
  "about:blank",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50; i++) {
  try {
    ver = await (await fetch("http://127.0.0.1:9339/json/list")).json();
    if (ver.length) break;
  } catch {}
  await sleep(200);
}
const page = ver.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const n = ++id;
    waiting.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 822, deviceScaleFactor: 1.4286, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.navigate", { url: "http://localhost:1420/" });
await sleep(3500);
const nav = (label) => js(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})); b && b.click(); return !!b })()`);
const shot = async (name) => {
  await sleep(1800);
  const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};

// Library
await nav("Clips"); await sleep(800); await js(`document.querySelector(".lib-page").scrollTop = 330`);
await shot("library");
// Studio: open the first clip
await js(`document.querySelector('.lib .card')?.click()`);
await sleep(1500);
await shot("studio");
await js(`document.querySelector('.studio-top .back')?.click()`);
// To trim
await nav("To trim");
await shot("totrim");
// Notifications
await nav("Notifications");
await shot("notifications");
// Appearance
await nav("Settings");
await sleep(500);
await js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Appearance'); b && b.click(); })()`);
await shot("appearance");
ws.close();
chrome.kill();
process.exit(0);
