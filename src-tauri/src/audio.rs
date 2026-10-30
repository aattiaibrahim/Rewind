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
    let stop = Arc::new(AtomicBool::new(false));
    let queue: Queue = Arc::new(Mutex::new(VecDeque::new()));
    let (tx, rx) = mpsc::channel::<Result<(u32, u16, String), String>>();

    // The cpal stream has to stay on the thread that made it.
    {
        let (stop, queue) = (stop.clone(), queue.clone());
        thread::spawn(move || match open_stream(&src, queue) {
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

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    {
        let (stop, queue) = (stop.clone(), queue.clone());
        thread::spawn(move || pump(listener, queue, rate, channels as usize, delay, stop));
    }
    Ok(Capture { stop, rate, channels, url: format!("tcp://127.0.0.1:{port}"), device })
}

fn open_stream(src: &Source, q: Queue) -> Result<(cpal::Stream, u32, u16, String), String> {
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
        SampleFormat::F32 => build::<f32>(&dev, &config, in_ch, mono, q, max),
        SampleFormat::I16 => build::<i16>(&dev, &config, in_ch, mono, q, max),
        SampleFormat::I32 => build::<i32>(&dev, &config, in_ch, mono, q, max),
        SampleFormat::U16 => build::<u16>(&dev, &config, in_ch, mono, q, max),
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
    max: usize,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    dev.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
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

    let t0 = Instant::now();
    let cushion = rate as u64 / 10; // stay 100 ms behind real time to absorb device jitter
    let backlog = rate as usize * 3 / 10;
    let mut written: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(rate as usize * ch * 4 / 10);
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
                // The device got ahead of the clock; drop the oldest audio to resync.
                let drop_frames = avail - need - cushion as usize;
                q.drain(..drop_frames * ch);
            }
            let take = need.min(q.len() / ch);
            for s in q.drain(..take * ch) {
                buf.extend_from_slice(&s.to_le_bytes());
            }
            buf.resize(buf.len() + (need - take) * ch * 4, 0); // silence
        }
        if sock.write_all(&buf).is_err() {
            return;
        }
        written += need as u64;
    }
}
