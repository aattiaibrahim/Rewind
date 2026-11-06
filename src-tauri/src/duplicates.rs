//! The same clip in two places: another recorder's folder and Hindsight's
//! (after a copy instead of a move), Medal's Clips and Imported, Ascent's
//! Clips and Downloads, a copy someone made by hand.
//!
//! Files are only compared when they're exactly the same size, then by a
//! fingerprint of their first and last megabyte, so a big library is checked
//! in moments. Only files that match on both are read in full to confirm, so
//! two different clips are never called copies. Nothing is deleted here: the
//! app shows each set and you choose which copy goes.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

const EDGE: u64 = 1 << 20;

/// Results so far, by (path, size, modified): a clip is only read once.
static SEEN: std::sync::Mutex<Option<HashMap<(String, u64, i64, bool), [u8; 32]>>> = std::sync::Mutex::new(None);

fn modified(path: &str) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn remembered(path: &str, size: u64, full: bool, f: impl FnOnce() -> Option<[u8; 32]>) -> Option<[u8; 32]> {
    let key = (path.to_string(), size, modified(path), full);
    if let Some(h) = SEEN.lock().unwrap().as_ref().and_then(|m| m.get(&key)) {
        return Some(*h);
    }
    let h = f()?;
    SEEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, h);
    Some(h)
}

fn full_hash(path: &str) -> Option<[u8; 32]> {
    let mut f = File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 4 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            return Some(h.finalize().into());
        }
        h.update(&buf[..n]);
    }
}

fn fingerprint(path: &str, size: u64) -> Option<[u8; 32]> {
    let mut f = File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; EDGE.min(size) as usize];
    f.read_exact(&mut buf).ok()?;
    h.update(&buf);
    if size > EDGE {
        f.seek(SeekFrom::Start(size.saturating_sub(EDGE).max(EDGE.min(size)))).ok()?;
        let mut tail = Vec::new();
        f.take(EDGE).read_to_end(&mut tail).ok()?;
        h.update(&tail);
    }
    h.update(size.to_le_bytes());
    Some(h.finalize().into())
}

/// Sets of paths holding the same clip (each set has 2+ paths). `clips` is
/// (path, size). Network paths are compared too, but read only when another
/// clip has their exact size.
pub fn find(clips: &[(String, u64)]) -> Vec<Vec<String>> {
    let mut by_size: HashMap<u64, Vec<&str>> = HashMap::new();
    for (p, s) in clips {
        if *s > 0 {
            by_size.entry(*s).or_default().push(p);
        }
    }
    let mut out = Vec::new();
    for (size, paths) in by_size {
        if paths.len() < 2 {
            continue;
        }
        let mut by_print: HashMap<[u8; 32], Vec<String>> = HashMap::new();
        for p in paths {
            if let Some(fp) = remembered(p, size, false, || fingerprint(p, size)) {
                by_print.entry(fp).or_default().push(p.to_string());
            }
        }
        // Same edges: confirm by reading them whole.
        for candidates in by_print.into_values().filter(|v| v.len() > 1) {
            let mut by_full: HashMap<[u8; 32], Vec<String>> = HashMap::new();
            for p in candidates {
                if let Some(h) = remembered(&p, size, true, || full_hash(&p)) {
                    by_full.entry(h).or_default().push(p);
                }
            }
            out.extend(by_full.into_values().filter(|v| v.len() > 1));
        }
    }
    for set in &mut out {
        set.sort();
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_copies_not_lookalikes() {
        let d = std::env::temp_dir().join(format!("rewind-dupes-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let clip: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let mut other = clip.clone();
        other[1_500_000] ^= 1; // same size, same start and end... different middle
        let mut edited = clip.clone();
        edited[10] ^= 1; // same size, different start
        for (n, b) in [("a.mp4", &clip), ("b.mp4", &clip), ("c.mp4", &edited), ("tiny1.mp4", &vec![1u8; 10]), ("tiny2.mp4", &vec![1u8; 10])] {
            std::fs::write(d.join(n), b).unwrap();
        }
        std::fs::write(d.join("lookalike.mp4"), &other).unwrap();
        let list: Vec<(String, u64)> = ["a.mp4", "b.mp4", "c.mp4", "lookalike.mp4", "tiny1.mp4", "tiny2.mp4"]
            .iter()
            .map(|n| (d.join(n).to_string_lossy().into_owned(), std::fs::metadata(d.join(n)).unwrap().len()))
            .collect();
        let sets = find(&list);
        assert_eq!(sets.len(), 2, "{sets:?}");
        assert!(sets.iter().any(|s| s.len() == 2 && s[0].ends_with("a.mp4") && s[1].ends_with("b.mp4")));
        assert!(sets.iter().any(|s| s[0].ends_with("tiny1.mp4")));
        let _ = std::fs::remove_dir_all(d);
    }
}

#[cfg(test)]
mod live {
    /// Real folders: REWIND_DUPE_DIRS="dir1;dir2" cargo test live_duplicates -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_duplicates() {
        let Ok(dirs) = std::env::var("REWIND_DUPE_DIRS") else { return };
        let mut list = Vec::new();
        for d in dirs.split(';') {
            let mut stack = vec![std::path::PathBuf::from(d)];
            while let Some(p) = stack.pop() {
                for e in std::fs::read_dir(&p).into_iter().flatten().flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if crate::library::is_video(&path) {
                        list.push((path.to_string_lossy().into_owned(), e.metadata().map(|m| m.len()).unwrap_or(0)));
                    }
                }
            }
        }
        let t = std::time::Instant::now();
        let sets = super::find(&list);
        println!("{} clips, {} duplicate sets in {:?}", list.len(), sets.len(), t.elapsed());
        let t = std::time::Instant::now();
        super::find(&list);
        println!("again: {:?}", t.elapsed());
        for s in sets.iter().take(15) {
            println!("  {}", s.join("  ==  "));
        }
    }
}
