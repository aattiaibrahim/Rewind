//! Short confirmation sounds (like Medal's): a rising two-note chime when a
//! clip or recording is saved, a falling one when saving fails.
//!
//! The sounds are generated in memory (no asset files) and played with
//! PlaySound, asynchronously, so they never delay a save.

use std::sync::OnceLock;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
use windows::core::PCWSTR;

const RATE: u32 = 48_000;

/// A 16-bit mono WAV of the given notes (Hz, milliseconds), each with a soft
/// attack and decay so it doesn't click.
fn wav(notes: &[(f32, u32)], volume: f32) -> Vec<u8> {
    let mut samples: Vec<i16> = Vec::new();
    for &(hz, ms) in notes {
        let n = (RATE * ms / 1000) as usize;
        for i in 0..n {
            let t = i as f32 / RATE as f32;
            let attack = (i as f32 / (RATE as f32 * 0.004)).min(1.0);
            let decay = (-(t * 1000.0 / ms as f32) * 3.0).exp();
            // A little second harmonic makes it sound like a bell, not a beep.
            let s = (std::f32::consts::TAU * hz * t).sin() + 0.25 * (std::f32::consts::TAU * hz * 2.0 * t).sin();
            samples.push((s / 1.25 * attack * decay * volume * i16::MAX as f32) as i16);
        }
    }
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

fn saved_wav() -> &'static [u8] {
    static W: OnceLock<Vec<u8>> = OnceLock::new();
    W.get_or_init(|| wav(&[(1046.5, 70), (1568.0, 140)], 0.22)) // C6 → G6
}

fn failed_wav() -> &'static [u8] {
    static W: OnceLock<Vec<u8>> = OnceLock::new();
    W.get_or_init(|| wav(&[(392.0, 110), (261.6, 180)], 0.22)) // G4 → C4
}

fn play(bytes: &'static [u8]) {
    // SND_MEMORY + SND_ASYNC needs the buffer to outlive playback: it's static.
    unsafe {
        let _ = PlaySoundW(PCWSTR(bytes.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}

pub fn saved() {
    play(saved_wav());
}

pub fn failed() {
    play(failed_wav());
}

#[cfg(test)]
mod tests {
    use super::*;

    // Builds the sounds only; never plays them (tests must stay silent).
    #[test]
    fn sounds_are_valid_short_wavs() {
        for w in [saved_wav(), failed_wav()] {
            assert_eq!(&w[0..4], b"RIFF");
            assert_eq!(&w[8..16], b"WAVEfmt ");
            let data_len = u32::from_le_bytes(w[40..44].try_into().unwrap()) as usize;
            assert_eq!(w.len(), 44 + data_len);
            let secs = data_len as f32 / (RATE as f32 * 2.0);
            assert!(secs > 0.1 && secs < 0.5, "{secs} s");
            let peak = w[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs()).max().unwrap();
            assert!(peak > 2000 && peak < i16::MAX as u16 / 3, "peak {peak}");
        }
    }
}
