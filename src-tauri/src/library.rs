//! Clip library: listing files, probing, thumbnails, and per-file tools
//! (remux, trim, export, compress). Originals are never modified.

use crate::ffmpeg;
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::ffi::OsString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const VIDEO_EXT: &[&str] = &["mkv", "mp4", "mov", "webm", "m4v", "avi", "ts", "flv"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipFile {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
    pub modified: i64,
    pub external: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub duration: f64,
    pub codec: String,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub audio_tracks: u32,
    pub container: String,
}

fn is_video(p: &Path) -> bool {
    p.extension()
        .map(|e| VIDEO_EXT.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn clip_file(p: &Path, folder: String, external: bool) -> Option<ClipFile> {
    let meta = fs::metadata(p).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(ClipFile {
        path: p.to_string_lossy().into_owned(),
        name: p.file_stem()?.to_string_lossy().into_owned(),
        folder,
        size: meta.len(),
        modified,
        external,
    })
}

/// Clips folder (and one level of game subfolders) plus files opened from elsewhere.
pub fn scan(clips_dir: &Path, external: &[String]) -> Vec<ClipFile> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(clips_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let folder = e.file_name().to_string_lossy().into_owned();
                if let Ok(inner) = fs::read_dir(&p) {
                    for f in inner.flatten() {
                        let fp = f.path();
                        if fp.is_file() && is_video(&fp) {
                            out.extend(clip_file(&fp, folder.clone(), false));
                        }
                    }
                }
            } else if is_video(&p) {
                out.extend(clip_file(&p, "Other".into(), false));
            }
        }
    }
    for ext in external {
        let p = Path::new(ext);
        if p.starts_with(clips_dir) {
            continue;
        }
        out.extend(clip_file(p, "Imported".into(), true));
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

fn parse_rate(r: &str) -> f64 {
    match r.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(0.0));
            if d > 0.0 { n / d } else { 0.0 }
        }
        None => r.parse().unwrap_or(0.0),
    }
}

pub fn probe(path: &str) -> Result<Probe, String> {
    let mut args = ffmpeg::args(&[
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate",
        "-of",
        "json",
    ]);
    args.push(path.into());
    let json: Value = serde_json::from_str(&ffmpeg::run("ffprobe", &args)?).map_err(|e| e.to_string())?;
    let mut p = Probe {
        duration: json["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0),
        container: json["format"]["format_name"].as_str().unwrap_or("").to_string(),
        ..Default::default()
    };
    for s in json["streams"].as_array().into_iter().flatten() {
        match s["codec_type"].as_str() {
            Some("video") if p.codec.is_empty() => {
                p.codec = s["codec_name"].as_str().unwrap_or("").to_string();
                p.width = s["width"].as_i64().unwrap_or(0);
                p.height = s["height"].as_i64().unwrap_or(0);
                p.fps = parse_rate(s["avg_frame_rate"].as_str().unwrap_or("0"));
            }
            Some("audio") => p.audio_tracks += 1,
            _ => {}
        }
    }
    Ok(p)
}

pub fn thumbnail(path: &str, cache: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    let out = cache.join(format!("{:016x}.jpg", h.finish()));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    for seek in ["1", "0"] {
        let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-y", "-ss", seek, "-i"]);
        args.push(path.into());
        args.extend(ffmpeg::args(&["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"]));
        args.push(out.clone().into());
        if ffmpeg::run("ffmpeg", &args).is_ok() && out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
    }
    Err("Couldn't make a thumbnail".into())
}

/// "<dir>/<stem><suffix>.<ext>", adding (2), (3)… if it already exists.
fn unique(src: &Path, suffix: &str, ext: &str) -> PathBuf {
    let dir = src.parent().unwrap_or(Path::new("."));
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut p = dir.join(format!("{stem}{suffix}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}{suffix} ({n}).{ext}"));
        n += 1;
    }
    p
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn nvenc_for(codec: &str) -> &'static str {
    match codec {
        "av1" => "av1_nvenc",
        "hevc" => "hevc_nvenc",
        _ => "h264_nvenc",
    }
}

fn finish(args: Vec<OsString>, out: PathBuf) -> Result<String, String> {
    match ffmpeg::run("ffmpeg", &args) {
        Ok(_) => Ok(out.to_string_lossy().into_owned()),
        Err(e) => {
            let _ = fs::remove_file(&out);
            Err(e)
        }
    }
}

/// Same video/audio, new MP4 container. No quality loss, takes a second.
pub fn remux_mp4(path: &str, keep_original: bool) -> Result<String, String> {
    let src = Path::new(path);
    let out = unique(src, if ext_of(src) == "mp4" { " (remux)" } else { "" }, "mp4");
    let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-i"]);
    args.push(path.into());
    args.extend(ffmpeg::args(&["-map", "0", "-c", "copy", "-movflags", "+faststart"]));
    args.push(out.clone().into());
    let result = finish(args, out)?;
    if !keep_original {
        trash::delete(src).map_err(|e| format!("Remuxed, but couldn't recycle the original: {e}"))?;
    }
    Ok(result)
}

/// Fast = cut on keyframes, no re-encode. Exact = frame-accurate, re-encoded on NVENC.
pub fn trim(path: &str, start: f64, end: f64, exact: bool) -> Result<String, String> {
    if end <= start {
        return Err("The end point has to be after the start point.".into());
    }
    let src = Path::new(path);
    let ext = match ext_of(src).as_str() {
        "mkv" | "mp4" | "webm" | "mov" => ext_of(src),
        _ => "mp4".into(),
    };
    let out = unique(src, " (trim)", &ext);
    let (ss, to) = (format!("{start:.3}"), format!("{end:.3}"));
    let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-ss", &ss, "-to", &to, "-i"]);
    args.push(path.into());
    args.extend(ffmpeg::args(&["-map", "0:v:0", "-map", "0:a?"]));
    if exact {
        let codec = probe(path).map(|p| p.codec).unwrap_or_default();
        args.extend(ffmpeg::args(&["-c:v", nvenc_for(&codec), "-preset", "p5", "-cq", "20", "-b:v", "0", "-c:a", "copy"]));
    } else {
        args.extend(ffmpeg::args(&["-c", "copy", "-avoid_negative_ts", "make_zero"]));
    }
    if ext == "mp4" {
        args.extend(ffmpeg::args(&["-movflags", "+faststart"]));
    }
    args.push(out.clone().into());
    finish(args, out)
}

/// Map video plus one audio track: desktop + mic mixed when there are several,
/// because most players and Discord only play the first track.
fn map_mixed_audio(args: &mut Vec<OsString>, audio_tracks: u32) {
    args.extend(ffmpeg::args(&["-map", "0:v:0"]));
    match audio_tracks {
        0 => {}
        1 => args.extend(ffmpeg::args(&["-map", "0:a:0"])),
        n => {
            let inputs: String = (0..n).map(|i| format!("[0:a:{i}]")).collect();
            let graph = format!("{inputs}amix=inputs={n}:duration=longest:normalize=0[mix]");
            args.extend(ffmpeg::args(&["-filter_complex", &graph, "-map", "[mix]"]));
        }
    }
}

/// Swap an edited file in for the original. The original goes to the Recycle Bin.
pub fn replace_original(original: &str, edited: &str) -> Result<String, String> {
    let orig = Path::new(original);
    let new_ext = ext_of(Path::new(edited));
    let target = orig.with_extension(&new_ext);
    trash::delete(orig).map_err(|e| format!("Saved the edit, but couldn't recycle the original: {e}"))?;
    if target.exists() && target != orig {
        trash::delete(&target).map_err(|e| e.to_string())?;
    }
    fs::rename(edited, &target).map_err(|e| format!("Couldn't rename the edit: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// An H.264 + AAC MP4 that plays everywhere (audio tracks mixed into one).
pub fn export_h264(path: &str) -> Result<String, String> {
    let info = probe(path)?;
    let out = unique(Path::new(path), " (H.264)", "mp4");
    let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-i"]);
    args.push(path.into());
    map_mixed_audio(&mut args, info.audio_tracks);
    args.extend(ffmpeg::args(&[
        "-c:v", "h264_nvenc", "-preset", "p5", "-cq", "21", "-b:v", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    ]));
    args.push(out.clone().into());
    finish(args, out)
}

/// Fit under `target_mb` (e.g. Discord's limit). Drops to 720p when the bitrate gets low.
pub fn compress(path: &str, target_mb: u32) -> Result<String, String> {
    let info = probe(path)?;
    if info.duration <= 0.0 {
        return Err("Couldn't read the video length.".into());
    }
    let audio_kbps = if info.audio_tracks > 0 { 128.0 } else { 0.0 };
    let total_kbps = target_mb as f64 * 8.0 * 1024.0 * 0.93 / info.duration;
    let video_kbps = (total_kbps - audio_kbps).max(300.0).round() as u64;
    let out = unique(Path::new(path), &format!(" ({target_mb} MB)"), "mp4");
    let (b, buf) = (format!("{video_kbps}k"), format!("{}k", video_kbps * 2));
    let mut args = ffmpeg::args(&["-hide_banner", "-loglevel", "error", "-i"]);
    args.push(path.into());
    map_mixed_audio(&mut args, info.audio_tracks);
    if video_kbps < 2500 && info.height > 720 {
        args.extend(ffmpeg::args(&["-vf", "scale=-2:720"]));
    }
    args.extend(ffmpeg::args(&[
        "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-b:v", &b, "-maxrate", &b, "-bufsize", &buf,
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    ]));
    args.push(out.clone().into());
    finish(args, out)
}
