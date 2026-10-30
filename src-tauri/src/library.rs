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
                if folder.starts_with('.') {
                    continue; // in-progress recordings and other hidden folders
                }
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
        let original_secs = probe(path).map(|p| p.duration).ok();
        verify_output(Path::new(&result), original_secs)?;
        discard(src).map_err(|e| format!("Remuxed, but couldn't recycle the original: {e}"))?;
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
        // Audio is re-encoded too: copied audio can't be cut mid-packet and drifts out of sync.
        args.extend(ffmpeg::args(&[
            "-c:v", nvenc_for(&codec), "-preset", "p5", "-cq", "20", "-b:v", "0", "-c:a", "aac", "-b:a", "192k",
        ]));
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

/// Send a file to the Recycle Bin (tests delete outright instead).
fn discard(p: &Path) -> Result<(), String> {
    #[cfg(test)]
    return fs::remove_file(p).map_err(|e| e.to_string());
    #[cfg(not(test))]
    trash::delete(p).map_err(|e| e.to_string())
}

/// Safety check before touching an original: the new file must be a real,
/// playable video of a sensible length.
fn verify_output(edited: &Path, expected_secs: Option<f64>) -> Result<(), String> {
    let size = fs::metadata(edited).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("The edit came out empty, so the original was kept.".into());
    }
    let p = probe(&edited.to_string_lossy()).map_err(|_| "The edit couldn't be read back, so the original was kept.".to_string())?;
    if p.codec.is_empty() || p.duration <= 0.05 {
        return Err("The edit has no video, so the original was kept.".into());
    }
    if let Some(want) = expected_secs
        && (p.duration - want).abs() > want.max(1.0) * 0.25 + 1.5
    {
        return Err(format!(
            "The edit is {:.1}s but should be about {:.1}s, so the original was kept.",
            p.duration, want
        ));
    }
    Ok(())
}

/// Swap an edited file in for the original (original goes to the Recycle Bin).
/// Nothing is removed unless the edit checks out first.
pub fn replace_original(original: &str, edited: &str, expected_secs: Option<f64>) -> Result<String, String> {
    let orig = Path::new(original);
    let edited_p = Path::new(edited);
    verify_output(edited_p, expected_secs)?;
    let target = orig.with_extension(ext_of(edited_p));
    discard(orig).map_err(|e| format!("Saved the edit as a new file, but couldn't recycle the original: {e}"))?;
    if target.exists() && target != orig {
        discard(&target)?;
    }
    fs::rename(edited_p, &target).map_err(|e| format!("Couldn't move the edit into place: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A 6 s 720p60 test video with two audio tracks (like a real Rewind clip).
    fn sample(dir: &Path, name: &str) -> String {
        crate::ffmpeg::init(None);
        fs::create_dir_all(dir).unwrap();
        let out = dir.join(name);
        let mut args = ffmpeg::args(&[
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
            "-t", "6", "-map", "0:v", "-map", "1:a", "-map", "2:a",
            "-c:v", "av1_nvenc", "-g", "120", "-c:a", "aac",
        ]);
        args.push(out.clone().into());
        ffmpeg::run("ffmpeg", &args).expect("make sample");
        out.to_string_lossy().into_owned()
    }

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rewind-test-{name}-{}", std::process::id()))
    }

    #[test]
    fn probe_reads_tracks_and_length() {
        let d = tmp("probe");
        let p = probe(&sample(&d, "a.mkv")).unwrap();
        assert_eq!(p.codec, "av1");
        assert_eq!(p.audio_tracks, 2);
        assert!((p.duration - 6.0).abs() < 0.2, "duration {}", p.duration);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn trims_fast_and_exact_keep_both_audio_tracks() {
        let d = tmp("trim");
        let src = sample(&d, "a.mkv");
        let fast = trim(&src, 1.0, 4.0, false).unwrap();
        let exact = trim(&src, 1.5, 3.5, true).unwrap();
        let (f, e) = (probe(&fast).unwrap(), probe(&exact).unwrap());
        assert!((f.duration - 3.0).abs() < 2.1, "fast {}", f.duration); // keyframe-aligned
        assert!((e.duration - 2.0).abs() < 0.15, "exact {}", e.duration);
        assert_eq!((f.audio_tracks, e.audio_tracks), (2, 2));
        assert!(Path::new(&src).exists(), "original must be untouched");
        assert!(trim(&src, 3.0, 2.0, true).is_err(), "end before start is refused");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn remux_keeps_everything_and_original() {
        let d = tmp("remux");
        let src = sample(&d, "a.mkv");
        let out = remux_mp4(&src, true).unwrap();
        assert!(out.ends_with("a.mp4"));
        let p = probe(&out).unwrap();
        assert_eq!((p.codec.as_str(), p.audio_tracks), ("av1", 2));
        assert!(Path::new(&src).exists());
        // Remuxing again must not overwrite the first MP4.
        let out2 = remux_mp4(&src, true).unwrap();
        assert_ne!(out, out2);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn remux_without_keep_removes_original_only_after_success() {
        let d = tmp("remux-nokeep");
        let src = sample(&d, "a.mkv");
        let out = remux_mp4(&src, false).unwrap();
        assert!(Path::new(&out).exists());
        assert!(!Path::new(&src).exists());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn export_h264_mixes_audio_into_one_track() {
        let d = tmp("export");
        let out = export_h264(&sample(&d, "a.mkv")).unwrap();
        let p = probe(&out).unwrap();
        assert_eq!((p.codec.as_str(), p.audio_tracks), ("h264", 1));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn compress_hits_target_size() {
        let d = tmp("compress");
        let out = compress(&sample(&d, "a.mkv"), 1).unwrap();
        let size = fs::metadata(&out).unwrap().len();
        assert!(size <= 1024 * 1024 + 64 * 1024, "{size} bytes");
        assert_eq!(probe(&out).unwrap().audio_tracks, 1);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn replace_original_swaps_in_the_edit() {
        let d = tmp("replace");
        let src = sample(&d, "a.mkv");
        let edited = trim(&src, 1.0, 3.0, true).unwrap();
        let final_path = replace_original(&src, &edited, Some(2.0)).unwrap();
        assert_eq!(final_path, src, "same name, same place");
        assert!(!Path::new(&edited).exists());
        assert!((probe(&final_path).unwrap().duration - 2.0).abs() < 0.15);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn replace_original_refuses_a_bad_edit() {
        let d = tmp("replace-bad");
        let src = sample(&d, "a.mkv");
        let bad = d.join("broken.mkv");
        fs::write(&bad, b"not a video").unwrap();
        assert!(replace_original(&src, &bad.to_string_lossy(), None).is_err());
        let empty = d.join("empty.mkv");
        fs::write(&empty, b"").unwrap();
        assert!(replace_original(&src, &empty.to_string_lossy(), None).is_err());
        // A 6 s file posing as a 2 s trim is refused too.
        let copy = d.join("copy.mkv");
        fs::copy(&src, &copy).unwrap();
        assert!(replace_original(&src, &copy.to_string_lossy(), Some(2.0)).is_err());
        assert!(Path::new(&src).exists(), "original must survive every refusal");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn scan_skips_hidden_folders_and_groups_by_game() {
        let d = tmp("scan");
        fs::create_dir_all(d.join("VALORANT")).unwrap();
        fs::create_dir_all(d.join(".rewind-recording-x")).unwrap();
        fs::write(d.join("VALORANT").join("clip.mkv"), b"x").unwrap();
        fs::write(d.join(".rewind-recording-x").join("000001_seg.mkv"), b"x").unwrap();
        let clips = scan(&d, &[]);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].folder, "VALORANT");
        let _ = fs::remove_dir_all(d);
    }
}
