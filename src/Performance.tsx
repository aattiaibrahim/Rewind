import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, AppUse, BenchApp, BenchPhase, BenchProgress, BenchReport, errText } from "./api";

const OTHERS: { app: BenchApp; label: string; how: string }[] = [
  { app: "obs", label: "OBS replay buffer", how: "Started and stopped automatically" },
  { app: "nvidia", label: "NVIDIA Instant Replay", how: "A voice asks you to press Alt+Shift+F10" },
  { app: "medal", label: "Medal", how: "A voice asks you to turn clipping on" },
];

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);

/** The recorder's own use during its run, minus what it used with nothing recording. */
function recorderUse(p: BenchPhase, base: BenchPhase | undefined): AppUse | null {
  if (!p.app || !p.window) return null;
  const now = p.window.apps[p.app];
  if (!now) return null;
  const idle = base?.window?.apps[p.app];
  return {
    cpuPercent: Math.max(0, now.cpuPercent - (idle?.cpuPercent ?? 0)),
    ramMb: now.ramMb,
    gpu3dPercent: Math.max(0, now.gpu3dPercent - (idle?.gpu3dPercent ?? 0)),
    encoderPercent: now.encoderPercent,
  };
}

function asText(r: BenchReport) {
  const base = r.phases.find((p) => !p.app);
  const lines = [
    `Rewind performance test: ${r.game}, ${r.started}, ${r.seconds} s per run`,
    "Recorder | Avg FPS | 1% low | FPS cost | CPU (whole PC) | RAM | GPU | Encoder",
  ];
  for (const p of r.phases) {
    if (!p.window) {
      lines.push(`${p.name} | skipped: ${p.skipped ?? ""}`);
      continue;
    }
    const fr = p.window.frames;
    const u = recorderUse(p, base);
    const cost = fr && base?.window?.frames ? (1 - fr.avgFps / base.window.frames.avgFps) * 100 : null;
    lines.push(
      [
        p.name,
        fr ? f1(fr.avgFps) : "-",
        fr ? f1(fr.low1Fps) : "-",
        p.app ? (cost === null ? "-" : `${f1(cost)}%`) : "baseline",
        u ? `${f2(u.cpuPercent)}%` : "-",
        u ? `${Math.round(u.ramMb)} MB` : "-",
        u ? `${f1(u.gpu3dPercent)}%` : "-",
        u ? `${f1(u.encoderPercent)}%` : "-",
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

export function Performance() {
  const [compare, setCompare] = useState<BenchApp[]>(["obs", "nvidia", "medal"]);
  const [seconds, setSeconds] = useState(30);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.benchState().then(([r, last]) => {
      setRunning(r);
      setReport(last);
    });
    const a = listen<BenchProgress>("bench-progress", (e) => setProgress(e.payload));
    const b = listen<BenchReport>("bench-done", (e) => {
      setReport(e.payload);
      setRunning(false);
      setProgress(null);
    });
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, []);

  const start = async () => {
    setErr(null);
    try {
      await api.startBench(compare, seconds);
      setRunning(true);
      setReport(null);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const base = report?.phases.find((p) => !p.app);
  const baseFps = base?.window?.frames?.avgFps;
  const minutes = Math.ceil(((2 + compare.length) * (seconds + 15) + 10) / 60);

  return (
    <div className="page">
      <h1>Performance test</h1>
      <p className="muted" style={{ margin: 0, maxWidth: 760, lineHeight: 1.6 }}>
        Measures your game's frame rate with no recorder running, then with Rewind and each other recorder in turn, in the same
        game on the same PC. It also shows how much CPU, memory, GPU and video encoder each recorder uses. For a fair test, stand
        somewhere steady in-game (a menu, training range or spawn), because a busy fight changes FPS on its own.
      </p>

      {!running && (
        <section className="group" style={{ maxWidth: 760 }}>
          <h2>Compare Rewind with</h2>
          {OTHERS.map((o) => (
            <label key={o.app} className="setting">
              <span>
                {o.label}
                <small>{o.how}</small>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={compare.includes(o.app)}
                onChange={(e) =>
                  setCompare((c) => (e.target.checked ? [...c, o.app] : c.filter((x) => x !== o.app)))
                }
              />
            </label>
          ))}
          <label className="setting">
            <span>
              Length of each run
              <small>The whole test takes about {minutes} min</small>
            </span>
            <select className="select" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
              <option value={20}>20 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={60}>60 seconds</option>
            </select>
          </label>
          <div className="row" style={{ paddingTop: 12, gap: 12, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={start}>
              Start test
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Start your game first. After you press Start, switch to the game within 10 seconds. A voice guides you from there.
            </span>
          </div>
          {err && <div className="err-text">{err}</div>}
        </section>
      )}

      {running && (
        <section className="group" style={{ maxWidth: 760 }}>
          <h2>{progress?.step ?? "Starting…"}</h2>
          <p style={{ margin: "4px 0 12px", fontSize: 14, color: progress?.waitingForUser ? "var(--accent)" : "var(--text-2)" }}>
            {progress?.detail ?? "Switch to your game."}
          </p>
          <div className="meter" aria-hidden="true">
            <div style={{ width: `${progress ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <div className="row" style={{ paddingTop: 12 }}>
            <button className="btn" onClick={() => api.cancelBench()}>
              Cancel test
            </button>
          </div>
        </section>
      )}

      {report && (
        <section className="group" style={{ maxWidth: 1000 }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>
              Results{report.game ? `: ${report.game}` : ""} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{report.started}</span>
            </h2>
            <button
              className="btn small"
              onClick={() => {
                navigator.clipboard.writeText(asText(report)).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "Copied" : "Copy results"}
            </button>
          </div>
          {report.error && <div className="err-text" style={{ padding: "8px 0" }}>{report.error}</div>}
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="bench">
              <thead>
                <tr>
                  <th>Recorder</th>
                  <th>Avg FPS</th>
                  <th>1% low FPS</th>
                  <th>FPS cost</th>
                  <th title="Share of your whole CPU, on top of what it uses idle">CPU</th>
                  <th title="Private memory, including its replay buffer">RAM</th>
                  <th title="Graphics (3D) engine, on top of idle">GPU</th>
                  <th title="Video encoder chip">Encoder</th>
                </tr>
              </thead>
              <tbody>
                {report.phases.map((p) => {
                  const fr = p.window?.frames;
                  const u = recorderUse(p, base);
                  const cost = fr && baseFps ? (1 - fr.avgFps / baseFps) * 100 : null;
                  return (
                    <tr key={p.name} className={p.app === "rewind" ? "ours" : ""}>
                      <td>
                        {p.name}
                        {(p.skipped || p.note) && <div className="muted" style={{ fontSize: 11 }}>{p.skipped ?? p.note}</div>}
                      </td>
                      <td className="mono">{fr ? f1(fr.avgFps) : "–"}</td>
                      <td className="mono">{fr ? f1(fr.low1Fps) : "–"}</td>
                      <td className="mono">{!p.app ? "baseline" : cost === null ? "–" : `${cost > 0 ? "−" : "+"}${f1(Math.abs(cost))}%`}</td>
                      <td className="mono">{u ? `${f2(u.cpuPercent)}%` : "–"}</td>
                      <td className="mono">{u ? `${Math.round(u.ramMb)} MB` : "–"}</td>
                      <td className="mono">{u ? `${f1(u.gpu3dPercent)}%` : "–"}</td>
                      <td className="mono">{u ? `${f1(u.encoderPercent)}%` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.6, marginBottom: 0 }}>
            FPS cost compares each run with "No recorder". Differences under about 1–2% are within normal run-to-run variation. CPU is
            a share of your whole processor ({report.cores} threads). RAM includes each recorder's replay buffer. Run the test twice to
            see how consistent the numbers are.
          </p>
        </section>
      )}
    </div>
  );
}
