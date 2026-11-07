// Records the website's demo: library → open a clip → set start and end → Save trim.
// node demo.mjs <framesDir>   (frames at 15 fps, 1400x822 CSS px at 1x)
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const out = process.argv[2];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9341", "--window-size=1400,822", "--hide-scrollbars", "--mute-audio",
  `--user-data-dir=${out}/../demo-profile`, "about:blank",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 50; i++) {
  try {
    list = await (await fetch("http://127.0.0.1:9341/json/list")).json();
    if (list.length) break;
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 822, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:1420/" });
await sleep(4000);
await js(`document.querySelector(".lib-page").scrollTop = 300`);
await sleep(800);

// A visible pointer, since headless Chrome draws none.
await js(`(() => { const d = document.createElement('div'); d.id='fake-cursor';
  d.style.cssText='position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;pointer-events:none;transition:transform .45s cubic-bezier(.2,.7,.2,1)';
  d.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>';
  document.body.appendChild(d); window.moveCursor=(x,y)=>{d.style.transform='translate('+x+'px,'+y+'px)'}; moveCursor(700,420); })()`);

let n = 0;
let recording = true;
const capture = (async () => {
  while (recording) {
    const t = Date.now();
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync(`${out}/f${String(n++).padStart(4, "0")}.jpg`, Buffer.from(r.result.data, "base64"));
    const wait = 66 - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
})();
const at = async (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); if (!r) return null; moveCursor(r.x + r.width/2, r.y + r.height/2); return [r.x + r.width/2, r.y + r.height/2]; })()`);
const hover = async (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

await sleep(900);
// Point at a clip and open it.
const c = await at(".lib .grid .card");
await sleep(500);
if (c) await hover(c[0], c[1]);
await sleep(900);
await js(`document.querySelector(".lib .grid .card").click()`);
await sleep(1800);
// Set the start a little in, the end before the finish.
const v = `document.querySelector('.studio video')`;
await js(`(() => { const v = ${v}; if (v) v.currentTime = 1.6; })()`);
await sleep(400);
const s = await at(".transport-pill .btn.pill");
await sleep(600);
await js(`[...document.querySelectorAll('.transport-pill .btn.pill')][0]?.click()`);
await sleep(900);
await js(`(() => { const v = ${v}; if (v) v.currentTime = 6.1; })()`);
await sleep(400);
await js(`(() => { const b=[...document.querySelectorAll('.transport-pill .btn.pill')][1]; const r=b.getBoundingClientRect(); moveCursor(r.x+r.width/2, r.y+r.height/2); })()`);
await sleep(700);
await js(`[...document.querySelectorAll('.transport-pill .btn.pill')][1]?.click()`);
await sleep(1100);
// Save the trim.
await at(".studio-top .btn.primary");
await sleep(800);
await js(`document.querySelector(".studio-top .btn.primary")?.click()`);
await sleep(2400);
recording = false;
await capture;
console.log("frames", n);
ws.close();
chrome.kill();
process.exit(0);
