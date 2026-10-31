//! Runs the performance test. See `stats.rs` for the method: runs alternate
//! nothing-recording and one recorder (B R B R B …) over several rounds, in a
//! shuffled order each round, after a warm-up. Every run is checked: the game
//! must stay in front, a baseline must have no recorder encoding, and a
//! recorder run must have its recorder encoding the whole time. Runs that fail
//! a check are kept in the report but left out of the results.
//!
//! Voice prompts tell the player what to do, since they're in the game and
//! can't see Rewind's window.

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

use super::measure::{self, App};
use super::recorders::{self, RecorderSettings};
use super::stats::{self, Baseline, Comparison, Run};

const OBS_EXE: &str = r"C:\Program Files\obs-studio\bin\64bit\obs64.exe";
/// Recorder counts as "on" above this much video-encoder use (%).
const ENCODING: f64 = 0.3;
/// Unmeasured play before the first run, so shader compiles, caches and
/// clocks settle first.
const WARMUP_SECS: u64 = 20;
/// Wait after a recorder starts encoding before measuring.
const SETTLE_ON_SECS: u64 = 8;
/// Wait after a recorder stops before measuring a baseline.
const SETTLE_OFF_SECS: u64 = 5;

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<Option<Report>> = Mutex::new(None);

fn default_rounds() -> u32 {
    3
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Which others to compare: obs, nvidia, medal.
    pub compare: Vec<App>,
    /// Length of each run.
    pub seconds: u32,
    /// How many times each recorder is measured.
    #[serde(default = "default_rounds")]
    pub rounds: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    pub app: App,
    pub reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub game: String,
    pub started: String,
    pub seconds: u32,
    pub rounds: u32,
    pub cores: usize,
    pub warmup_secs: u64,
    /// Total test length, minutes.
    pub minutes: f64,
    /// Every run in the order it happened, including left-out ones.
    pub runs: Vec<Run>,
    pub baseline: Baseline,
    pub results: Vec<Comparison>,
    pub settings: Vec<RecorderSettings>,
    pub skipped: Vec<Skip>,
    pub warnings: Vec<String>,
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

pub fn name(app: App) -> &'static str {
    match app {
        App::Rewind => "Rewind",
        App::Obs => "OBS replay buffer",
        App::Nvidia => "NVIDIA Instant Replay",
        App::Medal => "Medal",
    }
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

/// A different order each round (xorshift seeded from the clock).
fn shuffle(v: &mut [App], seed: &mut u64) {
    for i in (1..v.len()).rev() {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        v.swap(i, (*seed % (i as u64 + 1)) as usize);
    }
}

struct Ctx {
    app: AppHandle,
    game: u32,
    pm: PathBuf,
    scratch: PathBuf,
    secs: u32,
    t0: Option<Instant>,
    total: usize,
    done: usize,
    step: String,
}

impl Ctx {
    fn progress(&self, detail: &str, waiting: bool) {
        let _ = self.app.emit(
            "bench-progress",
            Progress { step: self.step.clone(), detail: detail.into(), waiting_for_user: waiting, done: self.done, total: self.total },
        );
    }
    fn check(&self) -> Result<(), String> {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("Test cancelled.".into());
        }
        if !alive(self.game) {
            return Err("The game closed, so the test stopped.".into());
        }
        Ok(())
    }
    /// Sleep in small steps so cancel / game exit is noticed quickly.
    fn wait(&self, secs: u64) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            self.check()?;
            thread::sleep(Duration::from_millis(250));
        }
        Ok(())
    }
    /// Wait until `app` is (or stops) using the video encoder, up to `secs`.
    fn wait_encoding(&self, app: App, on: bool, secs: u64) -> Result<bool, String> {
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            self.check()?;
            if (measure::encoder_use(app) > ENCODING) == on {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Make sure the game is in front before a run.
    fn game_in_front(&self) -> Result<bool, String> {
        if foreground_pid() == Some(self.game) {
            return Ok(true);
        }
        say("Switch back to your game.");
        self.progress("Switch back to your game.", true);
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            self.check()?;
            if foreground_pid() == Some(self.game) {
                thread::sleep(Duration::from_secs(2));
                return Ok(true);
            }
            thread::sleep(Duration::from_millis(250));
        }
        Ok(false)
    }

    /// One measured run, checked. `app` None = baseline.
    fn run(&mut self, round: u32, app: Option<App>) -> Result<Run, String> {
        let what = app.map(name).unwrap_or("nothing");
        let in_front = self.game_in_front()?;
        let mut excluded = None;
        if !in_front {
            excluded = Some("The game wasn't the window in front.".to_string());
        }
        if app.is_none() {
            // A clean baseline: no recorder may be encoding.
            let on: Vec<&str> = measure::encoder_use_all().into_iter().filter(|(_, v)| *v > ENCODING).map(|(a, _)| name(a)).collect();
            if !on.is_empty() && excluded.is_none() {
                excluded = Some(format!("{} was still recording.", on.join(" and ")));
            }
        }
        self.progress(&format!("Measuring with {what} recording. Keep playing, stay where you are."), false);
        let t0 = *self.t0.get_or_insert_with(Instant::now);
        let at_secs = t0.elapsed().as_secs_f64();
        let (game, mut ticks, mut away) = (self.game, 0u32, 0u32);
        let w = measure::measure_with(self.secs, Some(game), &self.pm, &self.scratch, || {
            ticks += 1;
            if foreground_pid() != Some(game) {
                away += 1;
            }
        });
        self.check()?;
        if excluded.is_none() {
            if w.frames.is_none() {
                excluded = Some("No frames were measured.".into());
            } else if away * 10 > ticks.max(1) {
                excluded = Some("You switched away from the game during this run.".into());
            } else if let Some(a) = app {
                if w.apps.get(&a).map(|u| u.encoder_percent).unwrap_or(0.0) <= ENCODING {
                    excluded = Some(format!("{} wasn't recording for the whole run.", name(a)));
                }
            }
        }
        self.done += 1;
        Ok(Run { round, app, at_secs, frames: w.frames, apps: w.apps, excluded })
    }

    /// Start a recorder. Ok(false) if it never started encoding.
    fn turn_on(&self, app: App, round: u32, rounds: u32) -> Result<bool, String> {
        let r = if rounds > 1 { format!("Round {round} of {rounds}. ") } else { String::new() };
        match app {
            App::Rewind => {
                self.progress("Starting Rewind's replay buffer…", false);
                set_rewind_buffer(&self.app, true);
                self.wait_encoding(App::Rewind, true, 20)
            }
            App::Obs => {
                if measure::encoder_use(App::Obs) > ENCODING {
                    return Ok(true);
                }
                self.progress("Starting OBS with its replay buffer…", false);
                if !obs_running() && launch_obs() && self.wait_encoding(App::Obs, true, 30)? {
                    return Ok(true);
                }
                // OBS runs as administrator, or was open without its replay buffer.
                say(&format!("{r}Start OBS and turn on its replay buffer now."));
                self.progress("Start OBS and turn on its replay buffer.", true);
                self.wait_encoding(App::Obs, true, 90)
            }
            App::Nvidia => {
                say(&format!("{r}Turn on NVIDIA Instant Replay. Press Alt, Shift, F 10."));
                self.progress("Turn on Instant Replay: press Alt+Shift+F10.", true);
                self.wait_encoding(App::Nvidia, true, 60)
            }
            App::Medal => {
                say(&format!("{r}Turn on Medal's clipping."));
                self.progress("Open Medal and turn clipping on.", true);
                self.wait_encoding(App::Medal, true, 90)
            }
        }
    }

    /// Stop a recorder. Ok(false) if it's still encoding.
    fn turn_off(&self, app: App) -> Result<bool, String> {
        match app {
            App::Rewind => {
                set_rewind_buffer(&self.app, false);
                self.wait_encoding(App::Rewind, false, 15)
            }
            App::Obs => {
                if close_obs() {
                    return Ok(true);
                }
                say("Close OBS now.");
                self.progress("Close OBS (it runs as administrator, so Rewind can't).", true);
                self.wait_encoding(App::Obs, false, 60)
            }
            App::Nvidia => {
                say("Turn Instant Replay off. Alt, Shift, F 10.");
                self.progress("Turn Instant Replay off: press Alt+Shift+F10.", true);
                self.wait_encoding(App::Nvidia, false, 45)
            }
            App::Medal => {
                say("Turn Medal's clipping off, or close Medal.");
                self.progress("Turn Medal's clipping off or close Medal.", true);
                self.wait_encoding(App::Medal, false, 60)
            }
        }
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
    let rounds = opts.rounds.clamp(1, 10);
    let mut compare: Vec<App> = vec![App::Rewind];
    compare.extend(opts.compare.iter().copied().filter(|a| *a != App::Rewind));
    compare.dedup();

    let s = crate::settings_of(app);
    let st = app.state::<crate::AppState>().engine.status();
    let mut settings = vec![recorders::rewind(&s, (st.width, st.height))];
    settings.extend(compare.iter().skip(1).map(|&a| recorders::read(a)));

    let mut report = Report {
        game: String::new(),
        started: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        seconds: secs,
        rounds,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        warmup_secs: WARMUP_SECS,
        minutes: 0.0,
        runs: Vec::new(),
        baseline: Baseline::default(),
        results: Vec::new(),
        settings,
        skipped: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };
    let began = Instant::now();
    let mut ctx = Ctx {
        app: app.clone(),
        game: 0,
        pm: presentmon(app),
        scratch: std::env::temp_dir(),
        secs,
        t0: None,
        total: 1 + rounds as usize * compare.len(),
        done: 0,
        step: "Switch to your game".into(),
    };
    if let Err(e) = run_rounds(&mut ctx, &mut report, &compare, rounds) {
        if e != "Test cancelled." {
            say(&e);
        }
        report.error = Some(e);
        if compare.contains(&App::Obs) {
            let _ = close_obs();
        }
    }
    report.minutes = began.elapsed().as_secs_f64() / 60.0;
    report.baseline = stats::baseline(&report.runs);
    report.results = compare.iter().map(|&a| stats::compare(&report.runs, a)).collect();
    report.warnings = stats::warnings(&report.baseline, &report.results);
    report.warnings.extend(recorders::mismatches(&report.settings));
    let left_out = report.runs.iter().filter(|r| r.excluded.is_some()).count();
    if left_out > 0 {
        report.warnings.push(format!("{left_out} of {} runs failed a check and were left out (see All runs).", report.runs.len()));
    }
    report
}

fn run_rounds(ctx: &mut Ctx, report: &mut Report, compare: &[App], rounds: u32) -> Result<(), String> {
    // 1. Find the game: whatever is in front after a countdown.
    say("Switch to your game now. The performance test starts in ten seconds.");
    for i in (1..=10).rev() {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("Test cancelled.".into());
        }
        ctx.progress(&format!("Starting in {i}…"), true);
        thread::sleep(Duration::from_secs(1));
    }
    let game = foreground_pid().ok_or("No game was in front.")?;
    let exe = measure::exe_of(game).unwrap_or_default();
    let lower = exe.to_ascii_lowercase();
    if ["rewind.exe", "explorer.exe", "msedgewebview2.exe", "claude.exe"].contains(&lower.as_str()) {
        return Err("No game was in front. Start a game, click Start, then switch to the game.".into());
    }
    report.game = exe.trim_end_matches(".exe").to_string();
    ctx.game = game;

    // 2. Nothing may be recording at the start.
    ctx.step = "Getting ready".into();
    ctx.progress("Stopping recorders…", false);
    for (app, v) in measure::encoder_use_all() {
        if v > ENCODING && !ctx.turn_off(app)? {
            return Err(format!("{} was still recording, so there's no clean baseline.", name(app)));
        }
    }

    // 3. Warm up, unmeasured.
    ctx.step = "Warming up".into();
    say("Warming up for twenty seconds. Stay where you are and keep playing.");
    ctx.progress(&format!("Playing for {WARMUP_SECS} s before measuring, so the game settles."), false);
    ctx.wait(WARMUP_SECS)?;

    // 4. Rounds: B, then each recorder followed by B, in a shuffled order.
    let mut seed = chrono::Local::now().timestamp_nanos_opt().unwrap_or(1) as u64 | 1;
    let mut active: Vec<App> = compare.to_vec();
    ctx.step = "Round 1: nothing recording".into();
    let r = ctx.run(1, None)?;
    report.runs.push(r);
    for round in 1..=rounds {
        let mut order = active.clone();
        shuffle(&mut order, &mut seed);
        for app in order {
            ctx.step = format!("Round {round} of {rounds}: {}", name(app));
            if !ctx.turn_on(app, round, rounds)? {
                let reason = format!("{} didn't start recording, so it was left out.", name(app));
                say(&reason);
                report.skipped.push(Skip { app, reason });
                active.retain(|a| *a != app);
                ctx.total -= (rounds - round + 1) as usize;
                continue;
            }
            ctx.wait(SETTLE_ON_SECS)?;
            let r = ctx.run(round, Some(app))?;
            report.runs.push(r);
            let off = ctx.turn_off(app)?;
            if !off {
                say(&format!("{} is still recording. The next run will be left out.", name(app)));
            }
            ctx.wait(SETTLE_OFF_SECS)?;
            ctx.step = format!("Round {round} of {rounds}: nothing recording");
            let r = ctx.run(round, None)?;
            report.runs.push(r);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuffle_keeps_every_recorder_and_varies_the_order() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..30 {
            let mut v = App::ALL.to_vec();
            shuffle(&mut v, &mut seed);
            let mut sorted = v.clone();
            sorted.sort_by_key(|a| *a as u8);
            assert_eq!(sorted, App::ALL.to_vec());
            seen.insert(v);
        }
        assert!(seen.len() > 5, "only {} different orders", seen.len());
    }
}
