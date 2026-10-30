//! The replay buffer.
//!
//! ffmpeg grabs the monitor on the GPU (ddagrab) and encodes with NVENC into
//! 2-second MKV segments in a rolling ring on disk. Saving a clip joins the
//! last N segments without re-encoding.
//!
//! A supervisor thread checks the monitor layout every second. When it changes
//! (Win+P, a monitor plugged in, a resolution change) or ffmpeg dies, it starts
//! a fresh "generation" on the right monitor, so capture never stays black.

use crate::{audio, ffmpeg, monitors, settings::Settings};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const SEG_SECONDS: u32 = 2;
/// Video starts ~0.12 s before ffmpeg connects to the audio sockets (measured
/// with a flash + click test), so audio is shifted later by this much.
const AUDIO_DELAY_SECS: f64 = 0.12;

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
}

#[derive(Clone)]
struct Gen {
    dir: PathBuf,
    width: i32,
    height: i32,
    encoder: String,
    fps: u32,
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
        let (s, g, root) = (status.clone(), gens.clone(), buffer_root.clone());
        thread::spawn(move || supervise(settings, s, g, root, rx));
        Engine { status, gens, tx: Mutex::new(tx), buffer_root }
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    pub fn restart(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::Restart);
    }

    /// Stop ffmpeg cleanly before the app exits.
    pub fn shutdown(&self) {
        let (done_tx, done_rx) = channel();
        if self.tx.lock().unwrap().send(Cmd::Shutdown(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(Duration::from_secs(4));
        }
    }

    /// Write the last `seconds` of the buffer to `out` (an .mkv path).
    pub fn save_clip(&self, seconds: u32, out: &Path) -> Result<(), String> {
        let gens = self.gens.lock().unwrap().clone();
        let newest = gens.last().ok_or("The replay buffer isn't running yet.")?;

        // Wait for the segment being written right now, so the clip includes "now".
        let before = read_list(&newest.dir).last().cloned();
        let deadline = Instant::now() + Duration::from_millis(SEG_SECONDS as u64 * 1000 + 700);
        while Instant::now() < deadline && read_list(&newest.dir).last() == before.as_ref() {
            thread::sleep(Duration::from_millis(100));
        }

        let need = seconds.div_ceil(SEG_SECONDS) as usize;
        let segs = collect_segments(&gens, need);
        if segs.is_empty() {
            return Err("Nothing buffered yet. Wait a couple of seconds.".into());
        }

        let stamp = chrono::Local::now().format("%H%M%S%f");
        let list_path = self.buffer_root.join(format!("concat_{stamp}.txt"));
        let body: String = segs
            .iter()
            .map(|p| {
                let s = p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
                format!("file '{s}'\n")
            })
            .collect();
        fs::write(&list_path, body).map_err(|e| e.to_string())?;
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Can't create clip folder: {e}"))?;
        }
        let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"]);
        args.push(list_path.clone().into());
        args.extend(ffmpeg::args(&["-c", "copy"]));
        args.push(out.into());
        let result = ffmpeg::run("ffmpeg", &args);
        let _ = fs::remove_file(&list_path);
        result.map(|_| ())
    }
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
        if (g.width, g.height, &g.encoder, g.fps) != (newest.width, newest.height, &newest.encoder, newest.fps) {
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

fn segs_needed(buffer_seconds: u32) -> u32 {
    buffer_seconds.div_ceil(SEG_SECONDS) + 1
}

fn supervise(
    settings: Arc<Mutex<Settings>>,
    status: Arc<Mutex<Status>>,
    gens: Arc<Mutex<Vec<Gen>>>,
    root: PathBuf,
    rx: Receiver<Cmd>,
) {
    let mut cur: Option<Running> = None;
    let mut gen_no = 0u32;
    let mut retry_at = Instant::now();

    loop {
        let s = settings.lock().unwrap().clone();
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
                Ok(None) if !s.buffer_enabled || r.sig != sig => {
                    eprintln!("[rewind] restarting capture: settings or displays/devices changed");
                    stop(cur.take().unwrap())
                }
                _ => {}
            }
        }

        if cur.is_none() && s.buffer_enabled && Instant::now() >= retry_at {
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

        {
            let buffered = if cur.is_some() {
                let n = collect_segments(&gens.lock().unwrap(), usize::MAX).len() as u32;
                (n * SEG_SECONDS).min(s.buffer_seconds)
            } else {
                0
            };
            let mut st = status.lock().unwrap();
            st.enabled = s.buffer_enabled;
            st.running = cur.is_some();
            st.encoder = s.encoder.clone();
            st.fps = s.fps;
            st.buffer_seconds = s.buffer_seconds;
            st.buffered_seconds = buffered;
            if !st.running {
                st.monitor = None;
                st.audio.clear();
            }
        }

        match rx.recv_timeout(Duration::from_millis(1000)) {
            Ok(Cmd::Restart) => {
                if let Some(r) = cur.take() {
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

fn spawn(
    s: &Settings,
    m: &monitors::Monitor,
    generation: &Gen,
) -> Result<Spawned, String> {
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
