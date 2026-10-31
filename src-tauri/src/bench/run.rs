//! Runs the performance test: the same game, measured with no recorder, then
//! with each recorder in turn. Voice prompts tell the player what to do, since
//! they're in the game and can't see Rewind's window.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use super::measure::{self, App, Window};

const OBS_EXE: &str = r"C:\Program Files\obs-studio\bin\64bit\obs64.exe";
/// Recorder counts as "on" above this much video-encoder use.
const ENCODING: f64 = 0.3;

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<Option<Report>> = Mutex::new(None);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Which others to compare: obs, nvidia, medal.
    pub compare: Vec<App>,
    pub seconds: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub name: String,
    pub app: Option<App>,
    pub window: Option<Window>,
    pub skipped: Option<String>,
    pub note: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub game: String,
    pub started: String,
    pub seconds: u32,
    pub cores: usize,
    pub phases: Vec<Phase>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: String,
    detail: String,
    waiting_for_user: bool,
    done: usize,
    total: usize,
}

pub fn last_report() -> Option<Report> {
    LAST.lock().unwrap().clone()
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

pub fn cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

fn presentmon(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("presentmon").join("PresentMon.exe");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../vendor/presentmon/PresentMon.exe"))
}

/// Say something out loud (Windows' built-in voice), without waiting.
fn say(text: &str) {
    let script = format!(
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('{}')",
        text.replace('\'', "''")
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000)
        .spawn();
}

fn foreground_pid() -> Option<u32> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

fn alive(pid: u32) -> bool {
    measure::exe_of(pid).is_some()
}

struct Ctx {
    app: AppHandle,
    total: usize,
    done: usize,
}

impl Ctx {
    fn progress(&self, step: &str, detail: &str, waiting: bool) {
        let _ = self.app.emit(
            "bench-progress",
            Progress { step: step.into(), detail: detail.into(), waiting_for_user: waiting, done: self.done, total: self.total },
        );
    }
    fn check(&self, game: u32) -> Result<(), String> {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("Test cancelled.".into());
        }
        if !alive(game) {
            return Err("The game closed, so the test stopped.".into());
        }
        Ok(())
    }
    /// Sleep in small steps so cancel / game exit is noticed quickly.
    fn wait(&self, secs: u64, game: u32) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            self.check(game)?;
            thread::sleep(Duration::from_millis(250));
        }
        Ok(())
    }
    /// Wait until `app` is (or stops) using the video encoder, up to `secs`.
    fn wait_encoding(&self, app: App, on: bool, secs: u64, game: u32) -> Result<bool, String> {
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            self.check(game)?;
            if (measure::encoder_use(app) > ENCODING) == on {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn set_rewind_buffer(app: &AppHandle, on: bool) {
    let mut s = crate::settings_of(app);
    if s.buffer_enabled != on {
        s.buffer_enabled = on;
        let _ = crate::set_settings(app.clone(), s);
    }
}

/// Close OBS. Returns false if it's still running (e.g. it runs as
/// administrator, which a normal app isn't allowed to close).
pub(crate) fn close_obs() -> bool {
    let _ = Command::new("taskkill").args(["/IM", "obs64.exe"]).creation_flags(0x0800_0000).output();
    let until = Instant::now() + Duration::from_secs(6);
    while Instant::now() < until && obs_running() {
        thread::sleep(Duration::from_millis(300));
    }
    // OBS asks before quitting while its replay buffer runs; it was started
    // with --disable-shutdown-check, so ending it is safe.
    if obs_running() {
        let _ = Command::new("taskkill").args(["/F", "/IM", "obs64.exe"]).creation_flags(0x0800_0000).output();
        thread::sleep(Duration::from_secs(1));
    }
    !obs_running()
}

/// Start OBS minimized with its replay buffer running (the user's own OBS
/// settings). Returns false if Windows refuses because OBS is set to "Run as
/// administrator" (error 740): then the user starts it themselves.
pub(crate) fn launch_obs() -> bool {
    match Command::new(OBS_EXE)
        .args(["--startreplaybuffer", "--minimize-to-tray", "--disable-shutdown-check", "--disable-updater"])
        .current_dir(Path::new(OBS_EXE).parent().unwrap())
        .spawn()
    {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[rewind] couldn't start OBS: {e}");
            false
        }
    }
}

fn obs_running() -> bool {
    measure::app_pids().get(&App::Obs).is_some_and(|p| !p.is_empty())
}

pub fn start(app: AppHandle, opts: Options) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::Relaxed) {
        return Err("A performance test is already running.".into());
    }
    CANCEL.store(false, Ordering::Relaxed);
    thread::spawn(move || {
        let restore_buffer = crate::settings_of(&app).buffer_enabled;
        let report = run(&app, &opts);
        set_rewind_buffer(&app, restore_buffer);
        if report.error.is_none() {
            say("Performance test finished. Switch back to Rewind to see the results.");
        }
        *LAST.lock().unwrap() = Some(report.clone());
        let _ = app.emit("bench-done", report);
        RUNNING.store(false, Ordering::Relaxed);
    });
    Ok(())
}

fn run(app: &AppHandle, opts: &Options) -> Report {
    let secs = opts.seconds.clamp(10, 120);
    let mut report = Report {
        game: String::new(),
        started: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        seconds: secs,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        phases: Vec::new(),
        error: None,
    };
    let compare: Vec<App> = opts.compare.iter().copied().filter(|a| *a != App::Rewind).collect();
    let mut ctx = Ctx { app: app.clone(), total: 2 + compare.len(), done: 0 };
    let pm = presentmon(app);
    let scratch = std::env::temp_dir();
    if let Err(e) = run_phases(&mut ctx, &mut report, &compare, secs, &pm, &scratch) {
        if e != "Test cancelled." {
            say(&e);
        }
        report.error = Some(e);
        if compare.contains(&App::Obs) {
            let _ = close_obs();
        }
    }
    report
}

fn run_phases(
    ctx: &mut Ctx,
    report: &mut Report,
    compare: &[App],
    secs: u32,
    pm: &Path,
    scratch: &Path,
) -> Result<(), String> {
    // 1. Find the game: whatever is in front after a countdown.
    say("Switch to your game now. The performance test starts in ten seconds.");
    for i in (1..=10).rev() {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("Test cancelled.".into());
        }
        ctx.progress("Switch to your game", &format!("Starting in {i}…"), true);
        thread::sleep(Duration::from_secs(1));
    }
    let game = foreground_pid().ok_or("No game was in front.")?;
    let exe = measure::exe_of(game).unwrap_or_default();
    let lower = exe.to_ascii_lowercase();
    if ["rewind.exe", "explorer.exe", "msedgewebview2.exe", "claude.exe"].contains(&lower.as_str()) {
        return Err("No game was in front. Start a game, click Start, then switch to the game.".into());
    }
    report.game = exe.trim_end_matches(".exe").to_string();

    // 2. Baseline: nothing recording.
    ctx.progress("Baseline", "Stopping recorders…", false);
    set_rewind_buffer(&ctx.app, false);
    if obs_running() && !close_obs() && measure::encoder_use(App::Obs) > ENCODING {
        say("Please close OBS for the baseline.");
        ctx.progress("Baseline", "Close OBS…", true);
        if !ctx.wait_encoding(App::Obs, false, 60, game)? {
            return Err("OBS was still recording, so there's no clean baseline.".into());
        }
    }
    for other in [App::Nvidia, App::Medal] {
        if measure::encoder_use(other) > ENCODING {
            let who = if other == App::Nvidia { "NVIDIA Instant Replay" } else { "Medal" };
            say(&format!("Please turn off {who} for the baseline."));
            ctx.progress("Baseline", &format!("Turn off {who}…"), true);
            if !ctx.wait_encoding(other, false, 45, game)? {
                return Err(format!("{who} was still recording, so there's no clean baseline."));
            }
        }
    }
    ctx.wait(5, game)?;
    say("Measuring. Just keep playing.");
    ctx.progress("Baseline", "Measuring with nothing recording. Keep playing.", false);
    let w = measure::measure(secs, Some(game), pm, scratch);
    ctx.check(game)?;
    let note = w.frames.is_none().then(|| "No frames were measured. Is the game the window in front?".to_string());
    report.phases.push(Phase { name: "No recorder".into(), app: None, window: Some(w), skipped: None, note });
    ctx.done += 1;

    // 3. Rewind.
    ctx.progress("Rewind", "Starting Rewind's replay buffer…", false);
    set_rewind_buffer(&ctx.app, true);
    ctx.wait_encoding(App::Rewind, true, 20, game)?;
    ctx.wait(8, game)?;
    ctx.progress("Rewind", "Measuring Rewind. Keep playing.", false);
    let w = measure::measure(secs, Some(game), pm, scratch);
    ctx.check(game)?;
    report.phases.push(Phase { name: "Rewind".into(), app: Some(App::Rewind), window: Some(w), skipped: None, note: None });
    set_rewind_buffer(&ctx.app, false);
    ctx.done += 1;
    ctx.wait(3, game)?;

    // 4. The others.
    for &other in compare {
        let name = match other {
            App::Obs => "OBS replay buffer",
            App::Nvidia => "NVIDIA Instant Replay",
            App::Medal => "Medal",
            App::Rewind => continue,
        };
        let mut phase = Phase { name: name.into(), app: Some(other), window: None, skipped: None, note: None };
        let started = match other {
            App::Obs => {
                if !Path::new(OBS_EXE).exists() {
                    phase.skipped = Some("OBS isn't installed.".into());
                    false
                } else if measure::encoder_use(other) > ENCODING {
                    true // already recording
                } else {
                    ctx.progress(name, "Starting OBS with its replay buffer…", false);
                    let auto = !obs_running() && launch_obs();
                    if auto && ctx.wait_encoding(other, true, 30, game)? {
                        true
                    } else {
                        // OBS runs as administrator, or was open without its replay buffer.
                        say("Please start OBS and turn on its replay buffer now.");
                        ctx.progress(name, "Start OBS and turn on its replay buffer.", true);
                        ctx.wait_encoding(other, true, 90, game)?
                    }
                }
            }
            App::Nvidia => {
                say("Turn on NVIDIA Instant Replay now. Press Alt, Shift, F 10.");
                ctx.progress(name, "Turn on Instant Replay: press Alt+Shift+F10.", true);
                ctx.wait_encoding(other, true, 60, game)?
            }
            App::Medal => {
                say("Now open Medal and make sure clipping is on.");
                ctx.progress(name, "Open Medal and turn clipping on.", true);
                ctx.wait_encoding(other, true, 90, game)?
            }
            App::Rewind => false,
        };
        if started {
            ctx.wait(8, game)?;
            say("Measuring. Keep playing.");
            ctx.progress(name, &format!("Measuring {name}. Keep playing."), false);
            phase.window = Some(measure::measure(secs, Some(game), pm, scratch));
            ctx.check(game)?;
        } else if phase.skipped.is_none() {
            phase.skipped = Some(format!("{name} didn't start recording, so it was skipped."));
        }
        // Turn it off again.
        match other {
            App::Obs => {
                if !close_obs() {
                    say("Please close OBS now.");
                    ctx.progress(name, "Close OBS (it runs as administrator, so Rewind can't).", true);
                    if !ctx.wait_encoding(other, false, 60, game)? {
                        phase.note = Some("OBS was still recording afterwards.".into());
                    }
                }
            }
            App::Nvidia if started => {
                say("Now turn Instant Replay off. Alt, Shift, F 10.");
                ctx.progress(name, "Turn Instant Replay off: press Alt+Shift+F10.", true);
                if !ctx.wait_encoding(other, false, 45, game)? {
                    phase.note = Some("Instant Replay was still on afterwards.".into());
                }
            }
            App::Medal if started => {
                say("Now turn Medal's clipping off, or close Medal.");
                ctx.progress(name, "Turn Medal's clipping off or close Medal.", true);
                if !ctx.wait_encoding(other, false, 60, game)? {
                    phase.note = Some("Medal was still recording afterwards.".into());
                }
            }
            _ => {}
        }
        report.phases.push(phase);
        ctx.done += 1;
        ctx.wait(3, game)?;
    }
    Ok(())
}
