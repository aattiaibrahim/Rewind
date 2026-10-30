//! Audio capture for the replay buffer.
//!
//! Desktop audio is WASAPI loopback of the default output device; the mic is
//! the default (or chosen) input device, optionally downmixed to mono. Each
//! source is streamed to ffmpeg as raw f32 PCM over a localhost socket.
//!
//! WASAPI loopback delivers nothing while the PC is silent, so the writer paces
//! itself by the wall clock and fills gaps with silence. That keeps audio
//! locked to the video's timeline however long the buffer runs.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::collections::VecDeque;
use std::io::{ErrorKind, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

pub enum Source {
    Desktop,
    Mic { device: String, mono: bool },
}

/// A running capture. Dropping it stops the device and the socket writer.
pub struct Capture {
    stop: Arc<AtomicBool>,
    pub rate: u32,
    pub channels: u16,
    pub url: String,
    pub device: String,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

type Queue = Arc<Mutex<VecDeque<f32>>>;
/// Audio chunks with the moment Windows captured their first sample.
type Chunks = Arc<Mutex<VecDeque<(Instant, Vec<f32>)>>>;

/// Names of the current default output and input devices (to notice headset swaps).
pub fn default_devices() -> (Option<String>, Option<String>) {
    let h = cpal::default_host();
    (
        h.default_output_device().and_then(|d| d.name().ok()),
        h.default_input_device().and_then(|d| d.name().ok()),
    )
}

pub fn input_devices() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// `delay` seconds of silence are sent first, shifting this track later in time.
pub fn start(src: Source, delay: f64) -> Result<Capture, String> {
    let (stop, queue, rate, channels, device) = open(src, None)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    {
        let (stop, queue) = (stop.clone(), queue.clone());
        thread::spawn(move || pump(listener, queue, rate, channels as usize, delay, stop));
    }
    Ok(Capture { stop, rate, channels, url: format!("tcp://127.0.0.1:{port}"), device })
}

type Opened = (Arc<AtomicBool>, Queue, u32, u16, String);

/// Open the device on its own thread (cpal streams must stay on one thread).
/// With `chunks`, audio arrives timestamped there instead of in the queue.
fn open(src: Source, chunks: Option<Chunks>) -> Result<Opened, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let queue: Queue = Arc::new(Mutex::new(VecDeque::new()));
    let (tx, rx) = mpsc::channel::<Result<(u32, u16, String), String>>();

    // The cpal stream has to stay on the thread that made it.
    {
        let (stop, queue) = (stop.clone(), queue.clone());
        thread::spawn(move || match open_stream(&src, queue, chunks) {
            Ok((stream, rate, ch, name)) => {
                let _ = tx.send(Ok((rate, ch, name)));
                while !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(100));
                }
                drop(stream);
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        });
    }
    let (rate, channels, device) = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "The audio device didn't respond.".to_string())??;
    Ok((stop, queue, rate, channels, device))
}

fn open_stream(src: &Source, q: Queue, chunks: Option<Chunks>) -> Result<(cpal::Stream, u32, u16, String), String> {
    let host = cpal::default_host();
    let (dev, cfg, mono) = match src {
        Source::Desktop => {
            let d = host.default_output_device().ok_or("No speakers or headphones found.")?;
            let c = d.default_output_config().map_err(|e| e.to_string())?;
            (d, c, false)
        }
        Source::Mic { device, mono } => {
            let chosen = if device.is_empty() {
                None
            } else {
                host.input_devices()
                    .ok()
                    .and_then(|mut it| it.find(|d| d.name().ok().as_deref() == Some(device.as_str())))
            };
            let d = chosen.or_else(|| host.default_input_device()).ok_or("No microphone found.")?;
            let c = d.default_input_config().map_err(|e| e.to_string())?;
            (d, c, *mono)
        }
    };
    let name = dev.name().unwrap_or_default();
    let config: cpal::StreamConfig = cfg.config();
    let in_ch = config.channels as usize;
    let out_ch = if mono { 1 } else { config.channels };
    let rate = config.sample_rate.0;
    let max = rate as usize * out_ch as usize * 2; // never hold more than 2 s

    // On WASAPI, an input stream on an output device is loopback capture.
    let stream = match cfg.sample_format() {
        SampleFormat::F32 => build::<f32>(&dev, &config, in_ch, mono, q, chunks, max),
        SampleFormat::I16 => build::<i16>(&dev, &config, in_ch, mono, q, chunks, max),
        SampleFormat::I32 => build::<i32>(&dev, &config, in_ch, mono, q, chunks, max),
        SampleFormat::U16 => build::<u16>(&dev, &config, in_ch, mono, q, chunks, max),
        f => Err(format!("Unsupported audio format {f:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate, out_ch, name))
}

fn build<T>(
    dev: &cpal::Device,
    config: &cpal::StreamConfig,
    in_ch: usize,
    mono: bool,
    q: Queue,
    chunks: Option<Chunks>,
    max: usize,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    dev.build_input_stream(
        config,
        move |data: &[T], info: &cpal::InputCallbackInfo| {
            if let Some(chunks) = &chunks {
                // WASAPI reports when this buffer was captured (QPC-based, the
                // same clock as the video). Convert that to our clock.
                let ts = info.timestamp();
                let delay = ts.callback.duration_since(&ts.capture).unwrap_or_default();
                let at = Instant::now().checked_sub(delay).unwrap_or_else(Instant::now);
                let samples: Vec<f32> = if mono && in_ch > 1 {
                    data.chunks(in_ch)
                        .map(|f| f.iter().map(|&x| f32::from_sample(x)).sum::<f32>() / in_ch as f32)
                        .collect()
                } else {
                    data.iter().map(|&x| f32::from_sample(x)).collect()
                };
                let mut c = chunks.lock().unwrap();
                c.push_back((at, samples));
                while c.len() > 400 {
                    c.pop_front(); // nobody is reading: don't grow forever
                }
                return;
            }
            let mut q = q.lock().unwrap();
            if mono && in_ch > 1 {
                for frame in data.chunks(in_ch) {
                    let sum: f32 = frame.iter().map(|&x| f32::from_sample(x)).sum();
                    q.push_back(sum / in_ch as f32);
                }
            } else {
                q.extend(data.iter().map(|&x| f32::from_sample(x)));
            }
            while q.len() > max {
                q.pop_front();
            }
        },
        |e| eprintln!("audio stream error: {e}"),
        None,
    )
    .map_err(|e| e.to_string())
}

/// Feed ffmpeg at exactly `rate` frames per second of wall time.
fn pump(listener: TcpListener, q: Queue, rate: u32, ch: usize, delay: f64, stop: Arc<AtomicBool>) {
    let _ = listener.set_nonblocking(true);
    let give_up = Instant::now() + Duration::from_secs(20);
    let mut sock = loop {
        if stop.load(Ordering::Relaxed) || Instant::now() > give_up {
            return;
        }
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(_) => return,
        }
    };
    let _ = sock.set_nonblocking(false);
    let _ = sock.set_nodelay(true);
    q.lock().unwrap().clear(); // start the timeline now

    // Sync offset: a silent lead-in pushes every later sample back by `delay`.
    let lead = vec![0u8; (rate as f64 * delay) as usize * ch * 4];
    if sock.write_all(&lead).is_err() {
        return;
    }
    let mut bytes: Vec<u8> = Vec::new();
    pace(&q, rate, ch, &stop, Instant::now(), |frames| {
        bytes.clear();
        for s in frames {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        sock.write_all(&bytes).is_ok()
    });
}

/// Emit exactly `rate` frames per second of wall time from `t0` on: sample k
/// always means time t0 + k/rate. Gaps (silent loopback) become zeros; if the
/// device runs ahead of the clock, the oldest audio is dropped to resync.
fn pace(q: &Queue, rate: u32, ch: usize, stop: &AtomicBool, t0: Instant, mut emit: impl FnMut(&[f32]) -> bool) {
    let cushion = rate as u64 / 10; // stay 100 ms behind real time to absorb device jitter
    let backlog = rate as usize * 3 / 10;
    let mut written: u64 = 0;
    let mut buf: Vec<f32> = Vec::with_capacity(rate as usize * ch / 10);
    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(10));
        let due = (t0.elapsed().as_secs_f64() * rate as f64) as u64;
        if due <= written + cushion {
            continue;
        }
        let need = (due - cushion - written) as usize;
        buf.clear();
        {
            let mut q = q.lock().unwrap();
            let avail = q.len() / ch;
            if avail > need + backlog {
                let drop_frames = avail - need - cushion as usize;
                q.drain(..drop_frames * ch);
            }
            let take = need.min(q.len() / ch);
            buf.extend(q.drain(..take * ch));
            buf.resize(need * ch, 0.0); // silence
        }
        if !emit(&buf) {
            return;
        }
        written += need as u64;
    }
}

/// Audio kept in memory for the native engine. Frame k (counting from the
/// very first) is the sound at `start + k / rate` on the shared clock.
pub struct AudioRing {
    pub rate: u32,
    pub channels: u16,
    pub start: Instant,
    /// Absolute frame number of the oldest frame still held.
    base: u64,
    data: VecDeque<f32>,
    max_frames: usize,
}

impl AudioRing {
    fn push(&mut self, frames: &[f32]) {
        self.data.extend(frames.iter().copied());
        self.trim();
    }
    fn push_silence(&mut self, frames: usize) {
        self.data.resize(self.data.len() + frames * self.channels as usize, 0.0);
        self.trim();
    }
    fn trim(&mut self) {
        let ch = self.channels as usize;
        let excess = (self.data.len() / ch).saturating_sub(self.max_frames);
        if excess > 0 {
            self.data.drain(..excess * ch);
            self.base += excess as u64;
        }
    }
    /// Absolute frame number the next sample will get.
    fn head(&self) -> i64 {
        (self.base + (self.data.len() / self.channels as usize) as u64) as i64
    }
    fn frame_at(&self, t: Instant) -> i64 {
        if t >= self.start {
            ((t - self.start).as_secs_f64() * self.rate as f64).round() as i64
        } else {
            -(((self.start - t).as_secs_f64() * self.rate as f64).round() as i64)
        }
    }

    /// `frames` frames starting at time `from` (zeros where nothing is held).
    pub fn slice(&self, from: Instant, frames: usize) -> Vec<f32> {
        let ch = self.channels as usize;
        let mut out = vec![0f32; frames * ch];
        let first = if from >= self.start {
            ((from - self.start).as_secs_f64() * self.rate as f64).round() as i64
        } else {
            -(((self.start - from).as_secs_f64() * self.rate as f64).round() as i64)
        };
        let held_from = self.base as i64;
        let held_to = held_from + (self.data.len() / ch) as i64;
        for i in 0..frames as i64 {
            let abs = first + i;
            if abs >= held_from && abs < held_to {
                let src = ((abs - held_from) as usize) * ch;
                out[i as usize * ch..][..ch].copy_from_slice(&self.data.range(src..src + ch).copied().collect::<Vec<_>>());
            }
        }
        out
    }

    pub fn bytes(&self) -> usize {
        self.data.len() * 4
    }

    /// Time of the newest frame held.
    pub fn end_time(&self) -> Instant {
        let frames = self.base + (self.data.len() / self.channels as usize) as u64;
        self.start + Duration::from_secs_f64(frames as f64 / self.rate as f64)
    }
}

/// Capture into an in-memory ring (native engine) holding `seconds` of audio.
pub fn start_ring(src: Source, seconds: u32) -> Result<(Capture, Arc<Mutex<AudioRing>>), String> {
    let t0 = Instant::now();
    let chunks: Chunks = Arc::new(Mutex::new(VecDeque::new()));
    let (stop, _queue, rate, channels, device) = open(src, Some(chunks.clone()))?;
    let ring = Arc::new(Mutex::new(AudioRing {
        rate,
        channels,
        start: t0,
        base: 0,
        data: VecDeque::new(),
        max_frames: rate as usize * seconds as usize,
    }));
    {
        let (stop, ring) = (stop.clone(), ring.clone());
        thread::spawn(move || place(&chunks, &ring, &stop));
    }
    Ok((Capture { stop, rate, channels, url: String::new(), device }, ring))
}

/// Put each chunk at the exact spot its capture time says. Tiny timestamp
/// jitter (< 3 ms) is smoothed so back-to-back chunks join seamlessly; real
/// gaps (silent loopback) stay silent; overlaps are trimmed. Audio therefore
/// can't drift against the video, however long Rewind runs.
fn place(chunks: &Chunks, ring: &Arc<Mutex<AudioRing>>, stop: &AtomicBool) {
    let (rate, ch) = {
        let r = ring.lock().unwrap();
        (r.rate, r.channels as usize)
    };
    let tolerance = (rate as i64 * 3) / 1000;
    // During silence, keep the ring current up to this far behind "now".
    let idle_lag = Duration::from_millis(250);
    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(5));
        let batch: Vec<(Instant, Vec<f32>)> = chunks.lock().unwrap().drain(..).collect();
        let mut r = ring.lock().unwrap();
        for (at, samples) in batch {
            let frames = samples.len() / ch;
            let mut idx = r.frame_at(at);
            let head = r.head();
            if (idx - head).abs() <= tolerance {
                idx = head; // continuous with what we already have
            }
            let mut data = &samples[..];
            if idx < head {
                let skip = (head - idx) as usize;
                if skip >= frames {
                    continue; // entirely before what we hold already
                }
                data = &samples[skip * ch..];
            } else if idx > head {
                let gap = (idx - head) as usize;
                r.push_silence(gap);
            }
            r.push(data);
        }
        let now_idx = r.frame_at(Instant::now().checked_sub(idle_lag).unwrap_or_else(Instant::now));
        let head = r.head();
        if now_idx > head {
            r.push_silence((now_idx - head) as usize);
        }
    }
}
