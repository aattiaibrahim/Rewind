//! The replay buffer and recorder.
//!
//! ffmpeg grabs the monitor on the GPU (ddagrab) and encodes with NVENC into
//! 2-second MKV segments in a rolling ring on disk. Saving a clip joins the
//! last N segments without re-encoding.
//!
//! Recording reuses the same capture: while it runs, every finished segment is
//! copied out of the ring into a hidden folder next to the final file, and on
//! stop they are joined. If Rewind crashes mid-recording, the copied segments
//! are still there and get recovered on the next start.
//!
//! A supervisor thread checks the monitor layout every second. When it changes
//! (Win+P, a monitor plugged in, a resolution change) or ffmpeg dies, it starts
//! a fresh "generation" on the right monitor, so capture never stays black.

use crate::{audio, ffmpeg, games, monitors, settings::Settings};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

pub const SEG_SECONDS: u32 = 2;
/// Video starts ~0.12 s before ffmpeg connects to the audio sockets (measured
/// with a flash + click test), so audio is shifted later by this much.
const AUDIO_DELAY_SECS: f64 = 0.12;
/// Refuse to save a clip with less free space than this.
const MIN_FREE_FOR_CLIP: u64 = 300 * 1024 * 1024;
/// Stop a recording automatically below this much free space.
const MIN_FREE_FOR_RECORDING: u64 = 1536 * 1024 * 1024;
pub const RECORDING_DIR_PREFIX: &str = ".rewind-recording-";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub running: bool,
    pub monitor: Option<String>,
    pub width: i32,
    pub height: i32,
    pub encoder: String,
    pub fps: u32,
    pub buffered_seconds: u32,
    pub buffer_seconds: u32,
    pub restarts: u32,
    pub last_error: Option<String>,
    /// e.g. ["Desktop: Speakers (Realtek)", "Mic (mono): USB Microphone"]
    pub audio: Vec<String>,
    pub audio_error: Option<String>,
    /// The game in front, if one is detected
    pub game: Option<String>,
    pub recording: bool,
    pub recording_seconds: u32,
    /// Set when a recording finishes (incl. auto-stop); the app turns it into an event
    pub finished_recordings: Vec<String>,
    pub recording_error: Option<String>,
}

#[derive(Clone)]
struct Gen {
    dir: PathBuf,
    width: i32,
    height: i32,
    encoder: String,
    fps: u32,
}

impl Gen {
    /// Segments with the same key can be joined without re-encoding.
    fn key(&self) -> String {
        format!("{}x{}_{}_{}", self.width, self.height, self.encoder, self.fps)
    }
}

struct Recording {
    started: Instant,
    tmp: PathBuf,
    out: PathBuf,
    seen: HashSet<(PathBuf, Option<SystemTime>)>,
    seq: u32,
    last_disk_check: Instant,
}

enum Cmd {
    Restart,
    Shutdown(Sender<()>),
}

struct Running {
    child: Child,
    sig: String,
    log: Arc<Mutex<VecDeque<String>>>,
    _audio: Vec<audio::Capture>,
}

struct Spawned {
    child: Child,
    log: Arc<Mutex<VecDeque<String>>>,
    audio: Vec<audio::Capture>,
    labels: Vec<String>,
    audio_error: Option<String>,
}

pub struct Engine {
    status: Arc<Mutex<Status>>,
    gens: Arc<Mutex<Vec<Gen>>>,
    rec: Arc<Mutex<Option<Recording>>>,
    tx: Mutex<Sender<Cmd>>,
    buffer_root: PathBuf,
}

impl Engine {
    pub fn start(settings: Arc<Mutex<Settings>>, buffer_root: PathBuf) -> Engine {
        let _ = fs::remove_dir_all(&buffer_root);
        let _ = fs::create_dir_all(&buffer_root);
        let (tx, rx) = channel();
        let status = Arc::new(Mutex::new(Status::default()));
        let gens = Arc::new(Mutex::new(Vec::new()));
        let rec = Arc::new(Mutex::new(None));
        let (s, g, r, root) = (status.clone(), gens.clone(), rec.clone(), buffer_root.clone());
        thread::spawn(move || supervise(settings, s, g, r, root, rx));
        Engine { status, gens, rec, tx: Mutex::new(tx), buffer_root }
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    /// Hand over finished recordings once (the caller announces them).
    pub fn take_finished_recordings(&self) -> (Vec<String>, Option<String>) {
        let mut st = self.status.lock().unwrap();
        (std::mem::take(&mut st.finished_recordings), st.recording_error.take())
    }

    pub fn restart(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::Restart);
    }

    /// Stop ffmpeg cleanly before the app exits (finishing any recording first).
    pub fn shutdown(&self) {
        if self.rec.lock().unwrap().is_some() {
            let _ = self.stop_recording();
        }
        let (done_tx, done_rx) = channel();
        if self.tx.lock().unwrap().send(Cmd::Shutdown(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(Duration::from_secs(4));
        }
    }

    /// Write the last `seconds` of the buffer to `out` (an .mkv path).
    pub fn save_clip(&self, seconds: u32, out: &Path) -> Result<(), String> {
        check_space(out, MIN_FREE_FOR_CLIP)?;
        let gens = self.gens.lock().unwrap().clone();
        let newest = gens.last().ok_or("The replay buffer isn't running yet.")?;
        wait_for_next_segment(newest);

        let need = seconds.div_ceil(SEG_SECONDS) as usize;
        let segs = collect_segments(&gens, need);
        if segs.is_empty() {
            return Err("Nothing buffered yet. Wait a couple of seconds.".into());
        }
        concat(&segs, out, &self.buffer_root)
    }

    pub fn is_recording(&self) -> bool {
        self.rec.lock().unwrap().is_some()
    }

    /// Start a full recording that will be saved to `out`.
    pub fn start_recording(&self, out: &Path) -> Result<(), String> {
        let mut rec = self.rec.lock().unwrap();
        if rec.is_some() {
            return Err("Already recording.".into());
        }
        check_space(out, MIN_FREE_FOR_RECORDING)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let tmp = out
            .parent()
            .ok_or("Bad recording path")?
            .join(format!("{RECORDING_DIR_PREFIX}{stamp}"));
        fs::create_dir_all(&tmp).map_err(|e| format!("Can't create the recording folder: {e}"))?;
        // Everything already in the buffer is from before "start": skip it.
        let mut seen = HashSet::new();
        for g in self.gens.lock().unwrap().iter() {
            for p in read_list(&g.dir) {
                let m = fs::metadata(&p).and_then(|m| m.modified()).ok();
                seen.insert((p, m));
            }
        }
        *rec = Some(Recording {
            started: Instant::now(),
            tmp,
            out: out.to_path_buf(),
            seen,
            seq: 0,
            last_disk_check: Instant::now(),
        });
        drop(rec);
        self.restart_if_idle();
        Ok(())
    }

    /// Stop recording and join the pieces. Returns the saved file(s).
    pub fn stop_recording(&self) -> Result<Vec<String>, String> {
        if let Some(newest) = self.gens.lock().unwrap().last().cloned() {
            wait_for_next_segment(&newest);
        }
        let mut guard = self.rec.lock().unwrap();
        let mut rec = guard.take().ok_or("Not recording.")?;
        copy_new_segments(&mut rec, &self.gens.lock().unwrap());
        drop(guard);
        finalize(&rec.tmp, &rec.out, &self.buffer_root)
    }

    fn restart_if_idle(&self) {
        // Nudge the supervisor so capture starts now if the buffer was paused.
        let _ = self.tx.lock().unwrap().send(Cmd::Restart);
    }
}

fn check_space(path: &Path, min: u64) -> Result<(), String> {
    match ffmpeg::free_bytes(path) {
        Some(free) if free < min => Err(format!(
            "Not enough disk space ({} MB free). Free some space or change the clips folder.",
            free / 1024 / 1024
        )),
        _ => Ok(()),
    }
}

/// Wait for the segment being written right now, so output includes "now".
fn wait_for_next_segment(newest: &Gen) {
    let before = read_list(&newest.dir).last().cloned();
    let deadline = Instant::now() + Duration::from_millis(SEG_SECONDS as u64 * 1000 + 700);
    while Instant::now() < deadline && read_list(&newest.dir).last() == before.as_ref() {
        thread::sleep(Duration::from_millis(100));
    }
}

/// Join segments into `out` without re-encoding.
fn concat(segs: &[PathBuf], out: &Path, scratch: &Path) -> Result<(), String> {
    let stamp = chrono::Local::now().format("%H%M%S%f");
    let list_path = scratch.join(format!("concat_{stamp}.txt"));
    let body: String = segs
        .iter()
        .map(|p| {
            let s = p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
            format!("file '{s}'\n")
        })
        .collect();
    fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    fs::write(&list_path, body).map_err(|e| e.to_string())?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Can't create clip folder: {e}"))?;
    }
    let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"]);
    args.push(list_path.clone().into());
    args.extend(ffmpeg::args(&["-map", "0", "-c", "copy"]));
    args.push(out.into());
    let result = ffmpeg::run("ffmpeg", &args);
    let _ = fs::remove_file(&list_path);
    if result.is_err() {
        let _ = fs::remove_file(out);
    }
    result.map(|_| ())
}

fn read_list(dir: &Path) -> Vec<PathBuf> {
    fs::read_to_string(dir.join("list.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| dir.join(l))
        .collect()
}

/// The newest `max` finished segments, reaching back into older generations
/// only while they have the same resolution/codec (so they join cleanly).
fn collect_segments(gens: &[Gen], max: usize) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let Some(newest) = gens.last() else {
        return out;
    };
    for g in gens.iter().rev() {
        if g.key() != newest.key() {
            break;
        }
        let mut segs = read_list(&g.dir);
        segs.append(&mut out);
        out = segs;
        if out.len() >= max {
            break;
        }
    }
    if out.len() > max {
        out.drain(..out.len() - max);
    }
    out
}

/// Copy finished segments that the recording hasn't taken yet.
/// File names carry order and format: 000012_1920x1080_av1_60.mkv
fn copy_new_segments(rec: &mut Recording, gens: &[Gen]) {
    for g in gens {
        for p in read_list(&g.dir) {
            let m = fs::metadata(&p).and_then(|m| m.modified()).ok();
            if rec.seen.insert((p.clone(), m)) {
                let dest = rec.tmp.join(format!("{:06}_{}.mkv", rec.seq, g.key()));
                if fs::copy(&p, &dest).is_ok() {
                    rec.seq += 1;
                }
            }
        }
    }
}

/// Join a recording folder into `out` (or "out (part N)" when the resolution
/// changed mid-recording), then delete the folder.
pub fn finalize(tmp: &Path, out: &Path, scratch: &Path) -> Result<Vec<String>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(tmp)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "mkv"))
        .collect();
    files.sort();
    if files.is_empty() {
        let _ = fs::remove_dir_all(tmp);
        return Err("The recording was too short to save.".into());
    }
    let key = |p: &PathBuf| {
        p.file_stem()
            .map(|s| s.to_string_lossy().split_once('_').map(|(_, k)| k.to_string()).unwrap_or_default())
            .unwrap_or_default()
    };
    let mut groups: Vec<Vec<PathBuf>> = Vec::new();
    for f in files {
        match groups.last_mut() {
            Some(g) if key(&g[0]) == key(&f) => g.push(f),
            _ => groups.push(vec![f]),
        }
    }
    let mut saved = Vec::new();
    let n = groups.len();
    for (i, g) in groups.iter().enumerate() {
        let target = if n == 1 {
            out.to_path_buf()
        } else {
            let stem = out.file_stem().unwrap_or_default().to_string_lossy();
            out.with_file_name(format!("{stem} (part {}).mkv", i + 1))
        };
        concat(g, &target, scratch)?;
        saved.push(target.to_string_lossy().into_owned());
    }
    let _ = fs::remove_dir_all(tmp);
    Ok(saved)
}

/// Turn leftover recording folders (from a crash) into files.
pub fn recover_recordings(clips_dir: &Path, scratch: &Path) -> Vec<String> {
    let mut saved = Vec::new();
    let mut dirs = Vec::new();
    for top in [clips_dir.to_path_buf()]
        .into_iter()
        .chain(fs::read_dir(clips_dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()))
    {
        for e in fs::read_dir(&top).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() && name.starts_with(RECORDING_DIR_PREFIX) {
                dirs.push((top.clone(), name, e.path()));
            }
        }
    }
    for (parent, name, dir) in dirs {
        let stamp = name.trim_start_matches(RECORDING_DIR_PREFIX);
        let out = parent.join(format!("Recovered recording {stamp}.mkv"));
        if let Ok(files) = finalize(&dir, &out, scratch) {
            saved.extend(files);
        }
    }
    saved
}

fn segs_needed(buffer_seconds: u32) -> u32 {
    buffer_seconds.div_ceil(SEG_SECONDS) + 1
}

fn supervise(
    settings: Arc<Mutex<Settings>>,
    status: Arc<Mutex<Status>>,
    gens: Arc<Mutex<Vec<Gen>>>,
    rec: Arc<Mutex<Option<Recording>>>,
    root: PathBuf,
    rx: Receiver<Cmd>,
) {
    let mut cur: Option<Running> = None;
    let mut gen_no = 0u32;
    let mut retry_at = Instant::now();

    loop {
        let s = settings.lock().unwrap().clone();
        let recording = rec.lock().unwrap().is_some();
        // A recording keeps capture running even if the replay buffer is paused.
        let want = s.buffer_enabled || recording;
        let mons = monitors::list();
        let picked = monitors::pick(&s.monitor_mode, &s.fixed_monitor, &mons);
        let devices = if s.desktop_audio || s.mic_enabled { audio::default_devices() } else { (None, None) };
        // Anything in here changing means "restart capture" (incl. a new default headset).
        let sig = format!(
            "{:?}|{:?}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}",
            mons,
            picked.as_ref().map(|m| m.index),
            s.encoder,
            s.quality,
            s.fps,
            s.draw_cursor,
            s.buffer_seconds,
            s.desktop_audio,
            s.mic_enabled,
            s.mic_mono,
            s.mic_device,
            devices,
        );

        if let Some(r) = cur.as_mut() {
            match r.child.try_wait() {
                Ok(Some(code)) => {
                    let log = r.log.lock().unwrap();
                    let tail: Vec<String> = log.iter().rev().take(3).rev().cloned().collect();
                    let mut st = status.lock().unwrap();
                    st.last_error = Some(format!("ffmpeg stopped ({code}). {}", tail.join(" ")));
                    eprintln!("[rewind] capture stopped: {:?}", st.last_error);
                    st.restarts += 1;
                    drop(st);
                    drop(log);
                    cur = None;
                    retry_at = Instant::now() + Duration::from_secs(2);
                }
                Ok(None) if !want || r.sig != sig => {
                    eprintln!("[rewind] restarting capture: settings or displays/devices changed");
                    stop(cur.take().unwrap())
                }
                _ => {}
            }
        }

        if cur.is_none() && want && Instant::now() >= retry_at {
            match picked {
                Some(m) => {
                    gen_no += 1;
                    let generation = Gen {
                        dir: root.join(format!("gen_{gen_no:04}")),
                        width: m.width,
                        height: m.height,
                        encoder: s.encoder.clone(),
                        fps: s.fps,
                    };
                    match spawn(&s, &m, &generation) {
                        Ok(sp) => {
                            let mut g = gens.lock().unwrap();
                            g.push(generation);
                            while g.len() > 4 {
                                let old = g.remove(0);
                                let _ = fs::remove_dir_all(&old.dir);
                            }
                            drop(g);
                            let mut st = status.lock().unwrap();
                            st.monitor = Some(m.label());
                            st.width = m.width;
                            st.height = m.height;
                            st.audio = sp.labels;
                            st.audio_error = sp.audio_error;
                            cur = Some(Running { child: sp.child, sig: sig.clone(), log: sp.log, _audio: sp.audio });
                        }
                        Err(e) => {
                            status.lock().unwrap().last_error = Some(e);
                            retry_at = Instant::now() + Duration::from_secs(3);
                        }
                    }
                }
                None => status.lock().unwrap().last_error = Some("No monitor found.".into()),
            }
        }

        // Recording: pull finished segments out of the ring; stop on low disk.
        let mut rec_secs = 0;
        let mut auto_stopped: Option<(Recording, String)> = None;
        {
            let mut guard = rec.lock().unwrap();
            if let Some(r) = guard.as_mut() {
                copy_new_segments(r, &gens.lock().unwrap());
                rec_secs = r.started.elapsed().as_secs() as u32;
                if r.last_disk_check.elapsed() > Duration::from_secs(5) {
                    r.last_disk_check = Instant::now();
                    if let Err(e) = check_space(&r.tmp, MIN_FREE_FOR_RECORDING) {
                        auto_stopped = Some((guard.take().unwrap(), format!("Recording stopped: {e}")));
                    }
                }
            }
        }
        if let Some((r, why)) = auto_stopped {
            let result = finalize(&r.tmp, &r.out, &root);
            let mut st = status.lock().unwrap();
            if let Ok(files) = result {
                st.finished_recordings.extend(files);
            }
            st.recording_error = Some(why);
        }

        {
            let buffered = if cur.is_some() {
                let n = collect_segments(&gens.lock().unwrap(), usize::MAX).len() as u32;
                (n * SEG_SECONDS).min(s.buffer_seconds)
            } else {
                0
            };
            let game = games::foreground_game();
            let mut st = status.lock().unwrap();
            st.enabled = s.buffer_enabled;
            st.running = cur.is_some();
            st.encoder = s.encoder.clone();
            st.fps = s.fps;
            st.buffer_seconds = s.buffer_seconds;
            st.buffered_seconds = buffered;
            st.game = game;
            st.recording = rec.lock().unwrap().is_some();
            st.recording_seconds = rec_secs;
            if !st.running {
                st.monitor = None;
                st.audio.clear();
            }
        }

        match rx.recv_timeout(Duration::from_millis(1000)) {
            Ok(Cmd::Restart) => {
                // Only a real restart if something is running and nothing is recording.
                if !rec.lock().unwrap().is_some()
                    && let Some(r) = cur.take()
                {
                    stop(r);
                }
                retry_at = Instant::now();
            }
            Ok(Cmd::Shutdown(done)) => {
                if let Some(r) = cur.take() {
                    stop(r);
                }
                let _ = fs::remove_dir_all(&root);
                let _ = done.send(());
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(r) = cur.take() {
                    stop(r);
                }
                return;
            }
        }
    }
}

fn spawn(s: &Settings, m: &monitors::Monitor, generation: &Gen) -> Result<Spawned, String> {
    fs::create_dir_all(&generation.dir).map_err(|e| e.to_string())?;

    // Audio first, so its sockets are listening when ffmpeg connects.
    let mut caps: Vec<(audio::Capture, &str, &str, String)> = Vec::new();
    let mut audio_errors = Vec::new();
    if s.desktop_audio {
        match audio::start(audio::Source::Desktop, AUDIO_DELAY_SECS) {
            Ok(c) => {
                let label = format!("Desktop: {}", c.device);
                caps.push((c, "Desktop audio", "192k", label));
            }
            Err(e) => audio_errors.push(format!("Desktop audio: {e}")),
        }
    }
    if s.mic_enabled {
        match audio::start(audio::Source::Mic { device: s.mic_device.clone(), mono: s.mic_mono }, AUDIO_DELAY_SECS) {
            Ok(c) => {
                let label = format!("Mic{}: {}", if c.channels == 1 { " (mono)" } else { "" }, c.device);
                caps.push((c, "Microphone", "96k", label));
            }
            Err(e) => audio_errors.push(format!("Mic: {e}")),
        }
    }

    let per = segs_needed(s.buffer_seconds);
    let codec = match s.encoder.as_str() {
        "h264" => "h264_nvenc",
        "hevc" => "hevc_nvenc",
        _ => "av1_nvenc",
    };
    let src = format!(
        "ddagrab=output_idx={}:framerate={}:draw_mouse={}",
        m.index,
        s.fps,
        if s.draw_cursor { 1 } else { 0 }
    );
    let gop = (s.fps * SEG_SECONDS).to_string();
    let cq = s.quality.to_string();
    let seg = SEG_SECONDS.to_string();
    let wrap = (per + 4).to_string();
    let list_size = (per + 2).to_string();

    let mut cmd = ffmpeg::cmd("ffmpeg");
    cmd.current_dir(&generation.dir)
        .args(["-hide_banner", "-loglevel", "warning", "-f", "lavfi", "-i", &src]);
    for (c, _, _, _) in &caps {
        // Raw PCM with a known format: skip ffmpeg's multi-second stream probing.
        cmd.args(["-probesize", "32", "-analyzeduration", "0"])
            .args(["-fflags", "nobuffer", "-f", "f32le"])
            .args(["-ar", &c.rate.to_string(), "-ac", &c.channels.to_string()])
            .args(["-i", &c.url]);
    }
    cmd.args(["-map", "0:v"]);
    for (i, (_, title, bitrate, _)) in caps.iter().enumerate() {
        cmd.args(["-map", &format!("{}:a", i + 1)])
            .arg(format!("-b:a:{i}"))
            .arg(bitrate)
            .arg(format!("-metadata:s:a:{i}"))
            .arg(format!("title={title}"));
    }
    if !caps.is_empty() {
        cmd.args(["-c:a", "aac", "-ar", "48000"]);
    }
    cmd.args(["-c:v", codec, "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", &cq, "-b:v", "0"])
        .args(["-g", &gop])
        .args(["-f", "segment", "-segment_time", &seg, "-segment_format", "matroska"])
        .args(["-segment_wrap", &wrap, "-segment_list", "list.txt"])
        .args(["-segment_list_size", &list_size, "-segment_list_type", "flat"])
        .args(["-reset_timestamps", "1", "seg_%03d.mkv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    ffmpeg::adopt(&child);

    let log = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(err) = child.stderr.take() {
        let log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut q = log.lock().unwrap();
                q.push_back(line);
                if q.len() > 30 {
                    q.pop_front();
                }
            }
        });
    }
    let labels = caps.iter().map(|(_, _, _, l)| l.clone()).collect();
    Ok(Spawned {
        child,
        log,
        audio: caps.into_iter().map(|(c, _, _, _)| c).collect(),
        labels,
        audio_error: if audio_errors.is_empty() { None } else { Some(audio_errors.join(" · ")) },
    })
}

/// Ask ffmpeg to finish its current segment ("q"), then force it if needed.
fn stop(mut r: Running) {
    if let Some(mut stdin) = r.child.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = r.child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = r.child.kill();
    let _ = r.child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_gen(dir: &Path, w: i32) -> Gen {
        Gen { dir: dir.to_path_buf(), width: w, height: 1080, encoder: "av1".into(), fps: 60 }
    }

    #[test]
    fn collect_takes_newest_and_stops_at_format_change() {
        let base = std::env::temp_dir().join(format!("rewind-test-collect-{}", std::process::id()));
        let (a, b, c) = (base.join("a"), base.join("b"), base.join("c"));
        for (d, names) in [(&a, "x1\nx2\n"), (&b, "y1\ny2\ny3\n"), (&c, "z1\n")] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("list.txt"), names).unwrap();
        }
        // a is 1440 wide (different format), b and c are 1920.
        let gens = vec![mk_gen(&a, 1440), mk_gen(&b, 1920), mk_gen(&c, 1920)];
        let all = collect_segments(&gens, usize::MAX);
        let names: Vec<String> = all.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["y1", "y2", "y3", "z1"]);
        let two = collect_segments(&gens, 2);
        assert_eq!(two.len(), 2);
        assert!(two[1].ends_with("z1"));
        let _ = fs::remove_dir_all(&base);
    }

    /// Real capture on this PC: buffer → clip, recording, crash recovery.
    /// Run with: cargo test live_ -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_capture_clip_recording_and_recovery() {
        crate::ffmpeg::init(None);
        let base = std::env::temp_dir().join(format!("rewind-test-live-{}", std::process::id()));
        let clips = base.join("clips");
        let s = Settings { clips_dir: clips.to_string_lossy().into(), buffer_seconds: 20, ..Default::default() };
        let engine = Engine::start(Arc::new(Mutex::new(s)), base.join("buffer"));
        let probe = |p: &Path| crate::library::probe(&p.to_string_lossy()).unwrap();

        // 1. Buffer fills.
        let t = Instant::now();
        while engine.status().buffered_seconds < 8 {
            assert!(t.elapsed() < Duration::from_secs(40), "buffer never filled: {:?}", engine.status().last_error);
            thread::sleep(Duration::from_millis(250));
        }
        let st = engine.status();
        println!("capturing {:?} {}x{} audio={:?} err={:?}", st.monitor, st.width, st.height, st.audio, st.audio_error);

        // 2. Save a 6 s clip.
        let clip = clips.join("Desktop").join("clip.mkv");
        engine.save_clip(6, &clip).unwrap();
        let p = probe(&clip);
        println!("clip: {:.2}s {} audio tracks {}", p.duration, p.codec, p.audio_tracks);
        assert!((5.5..=8.5).contains(&p.duration), "clip length {}", p.duration);
        assert_eq!(p.codec, "av1");
        assert_eq!(p.audio_tracks as usize, st.audio.len());

        // 3. Record ~7 s.
        let rec_out = clips.join("Desktop").join("recording.mkv");
        engine.start_recording(&rec_out).unwrap();
        assert!(engine.start_recording(&rec_out).is_err(), "no double start");
        thread::sleep(Duration::from_secs(7));
        assert!(engine.status().recording);
        let files = engine.stop_recording().unwrap();
        assert_eq!(files.len(), 1);
        let r = probe(Path::new(&files[0]));
        println!("recording: {:.2}s", r.duration);
        assert!((6.0..=11.5).contains(&r.duration), "recording length {}", r.duration);
        assert!(engine.stop_recording().is_err(), "no double stop");
        let leftovers = fs::read_dir(clips.join("Desktop")).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(RECORDING_DIR_PREFIX)).count();
        assert_eq!(leftovers, 0, "temp recording folder cleaned up");

        // 4. A crashed recording (pieces left behind) is recovered.
        let crashed = clips.join("Desktop").join(format!("{RECORDING_DIR_PREFIX}crash"));
        fs::create_dir_all(&crashed).unwrap();
        let g = engine.gens.lock().unwrap().last().cloned().unwrap();
        for (i, seg) in read_list(&g.dir).iter().take(3).enumerate() {
            fs::copy(seg, crashed.join(format!("{i:06}_{}.mkv", g.key()))).unwrap();
        }
        let recovered = recover_recordings(&clips, &base.join("scratch"));
        assert_eq!(recovered.len(), 1);
        let rv = probe(Path::new(&recovered[0]));
        println!("recovered: {:.2}s", rv.duration);
        assert!((5.0..=6.5).contains(&rv.duration));
        assert!(!crashed.exists());

        engine.shutdown();
        let _ = fs::remove_dir_all(&base);
    }
}
