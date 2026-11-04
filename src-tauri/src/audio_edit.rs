//! Audio in the editor: waveforms for each track, and the edits Studio can
//! make to them (louder/quieter, and muted stretches) when a clip is saved.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::ffmpeg;

/// Samples per second the waveform is drawn from. Enough for a smooth shape,
/// little enough that a 20-minute clip decodes in a couple of seconds.
const RATE: u32 = 2000;

/// One track's loudness over time: `levels[i]` covers `step` seconds, 0–255
/// on a dB-like scale so quiet speech still shows.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub step: f64,
    pub levels: Vec<u8>,
}

/// Every audio track's waveform, cached next to the preview audio.
pub fn waveforms(path: &str, tracks: u32, cache: &Path) -> Result<Vec<Waveform>, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    let key = format!("{:016x}", h.finish());
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    // One decode per track, side by side.
    let jobs: Vec<_> = (0..tracks)
        .map(|i| {
            let (path, file) = (path.to_string(), cache.join(format!("{key}_w{i}.bin")));
            std::thread::spawn(move || -> Result<Waveform, String> {
                if let Ok(b) = fs::read(&file) {
                    if b.len() > 8 {
                        return Ok(Waveform { step: f64::from_le_bytes(b[..8].try_into().unwrap()), levels: b[8..].to_vec() });
                    }
                }
                let w = decode(&path, i)?;
                let mut b = w.step.to_le_bytes().to_vec();
                b.extend(&w.levels);
                let _ = fs::write(&file, b);
                Ok(w)
            })
        })
        .collect();
    jobs.into_iter().map(|j| j.join().map_err(|_| "waveform step crashed".to_string())?).collect()
}

pub(crate) fn decode(path: &str, track: u32) -> Result<Waveform, String> {
    let mut c = ffmpeg::cmd("ffmpeg");
    c.args(["-hide_banner", "-loglevel", "error", "-i"]).arg(path).args([
        "-map",
        &format!("0:a:{track}"),
        "-vn",
        "-ac",
        "1",
        "-ar",
        &RATE.to_string(),
        "-f",
        "s16le",
        "-",
    ]);
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    ffmpeg::adopt(&child);
    let mut raw = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let _ = child.wait();
    let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    Ok(levels(&samples, RATE))
}

/// Peak per bucket, mapped from -54..0 dBFS to 0..255. About 20 buckets a
/// second, so even a long clip stays small.
pub fn levels(samples: &[i16], rate: u32) -> Waveform {
    let per = (rate / 20).max(1) as usize;
    let levels = samples
        .chunks(per)
        .map(|c| {
            let peak = c.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
            if peak <= 0.0 {
                return 0;
            }
            let db = 20.0 * peak.log10();
            (((db + 54.0) / 54.0).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect();
    Waveform { step: per as f64 / rate as f64, levels }
}

/// What Studio changed on one track.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackEdit {
    /// Louder or quieter, in dB (0 = as recorded).
    #[serde(default)]
    pub gain_db: f64,
    /// Silenced stretches, in seconds of the original file.
    #[serde(default)]
    pub mutes: Vec<[f64; 2]>,
}

/// Edits for every track, in track order. Missing tracks are unchanged.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct AudioEdit(pub Vec<TrackEdit>);

impl AudioEdit {
    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|t| t.gain_db.abs() < 0.05 && t.mutes.is_empty())
    }

    /// ffmpeg filters for track `i` (comma-joined, ready to go before other
    /// filters), or None if it's unchanged. `offset` is subtracted from the
    /// mute times, for when the input's timestamps start at a cut point.
    pub fn filter(&self, i: usize, offset: f64) -> Option<String> {
        let t = self.0.get(i)?;
        let mut parts = Vec::new();
        if t.gain_db.abs() >= 0.05 {
            parts.push(format!("volume={:.2}dB", t.gain_db.clamp(-30.0, 30.0)));
        }
        let spans: Vec<String> = t
            .mutes
            .iter()
            .filter(|[a, b]| b > a)
            .map(|[a, b]| format!("between(t,{:.3},{:.3})", (a - offset).max(0.0), (b - offset).max(0.0)))
            .collect();
        if !spans.is_empty() {
            parts.push(format!("volume=0:enable='{}'", spans.join("+")));
        }
        (!parts.is_empty()).then(|| parts.join(","))
    }

    /// `[0:a:i]` with this track's filters, as a filtergraph input chain:
    /// "[0:a:1]volume=3dB," or "[0:a:1]" when unchanged.
    pub fn chain(&self, i: usize, offset: f64) -> String {
        match self.filter(i, offset) {
            Some(f) => format!("[0:a:{i}]{f},"),
            None => format!("[0:a:{i}]"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_follow_loudness() {
        let mut s = vec![0i16; 2000];
        s.extend(vec![16384i16; 2000]);
        let w = levels(&s, 2000);
        assert_eq!(w.levels.len(), 40);
        assert_eq!(w.levels[0], 0);
        assert!(w.levels[39] > 220, "{}", w.levels[39]);
        assert!((w.step - 0.05).abs() < 1e-9);
    }

    #[test]
    fn builds_filters() {
        let e = AudioEdit(vec![
            TrackEdit::default(),
            TrackEdit { gain_db: 6.0, mutes: vec![[2.0, 3.5], [10.0, 11.0]] },
        ]);
        assert!(e.filter(0, 0.0).is_none());
        assert_eq!(e.filter(1, 1.0).unwrap(), "volume=6.00dB,volume=0:enable='between(t,1.000,2.500)+between(t,9.000,10.000)'");
        assert_eq!(e.chain(0, 0.0), "[0:a:0]");
        assert!(!e.is_empty());
        assert!(AudioEdit(vec![TrackEdit::default()]).is_empty());
    }
}
