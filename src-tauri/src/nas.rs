//! NAS library.
//!
//! Clips always save to this PC first, so saving stays instant and works with
//! the NAS asleep or the network down. A background worker then copies each
//! finished clip to the NAS with the same `<Game>/<file>` layout, so every PC
//! shares one folder per game (file names carry the PC's name, see `pc_suffix`).
//!
//! - A copy goes to a hidden `.name.rewind-partial` file first and is renamed
//!   only once it's verified: the copy is read back from the NAS (past
//!   Windows' cache) and its SHA-256 must match the original's, byte for
//!   byte. So the NAS never shows a half-copied or garbled clip.
//! - Copied clips are remembered (nas-synced.txt), so a clip deleted on the NAS
//!   isn't copied back again.
//! - Optionally the local copy is freed up, only once the NAS copy is verified
//!   that way (clips copied by older versions are verified first), and it goes
//!   to the Recycle Bin rather than being deleted outright.
//! - Nothing is copied while a game is running (in front or tabbed out of)
//!   or a recording is going, so it never costs frames.
//! - The worker never touches the network on the save path: duplicate-name
//!   checks use the cached NAS listing.

use serde::Serialize;
use std::collections::HashSet;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Files changed more recently than this may still be written (a save, a recording).
const SETTLE: Duration = Duration::from_secs(15);
const PARTIAL: &str = ".rewind-partial";

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NasState {
    pub enabled: bool,
    pub reachable: bool,
    /// Clips on this PC not on the NAS yet
    pub pending: usize,
    /// File being copied right now
    pub copying: Option<String>,
    /// Clips copied since Hindsight started
    pub copied: usize,
    pub last_error: Option<String>,
    /// When the last full pass finished (ms since 1970)
    pub last_sync: Option<i64>,
    /// Waiting because a game is running or a clip is recording
    pub paused: bool,
    /// This pass: clips and bytes to copy, and how many are done
    pub total_files: usize,
    pub done_files: usize,
    pub total_bytes: u64,
    pub done_bytes: u64,
    /// Bytes still to copy (stays set while paused)
    pub pending_bytes: u64,
    /// Reading the NAS copy back to check it
    pub checking: bool,
    /// Average speed this pass (bytes per second), counting the checks
    pub rate: f64,
    /// Time left at that speed
    pub eta_secs: Option<u64>,
}

/// Where a sync pass is up to, for the progress display.
#[derive(Clone, Copy, Debug, Default)]
pub struct Step<'a> {
    /// The clip being copied or checked (None = the pass is over)
    pub file: Option<&'a str>,
    pub checking: bool,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: usize,
    pub total_files: usize,
}

#[derive(Clone, Debug)]
pub struct NasFile {
    pub path: PathBuf,
    /// `<Game>/<file>` with forward slashes
    pub rel: String,
    pub folder: String,
}

#[derive(Default)]
struct Listing {
    root: String,
    files: Vec<NasFile>,
    rels: HashSet<String>,
}

static STATE: Mutex<Option<NasState>> = Mutex::new(None);
static LISTING: Mutex<Option<Listing>> = Mutex::new(None);
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

/// " - GAMING-PC": added to clip names when a NAS is shared by several PCs.
pub fn pc_suffix() -> String {
    let name: String = std::env::var("COMPUTERNAME")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if name.is_empty() { String::new() } else { format!(" - {name}") }
}

fn rel_key(rel: &str) -> String {
    rel.replace('\\', "/").to_lowercase()
}

/// `<Game>/<file>` of a clip inside the clips folder.
fn rel_of(clips_dir: &Path, p: &Path) -> Option<String> {
    let r = p.strip_prefix(clips_dir).ok()?;
    Some(r.to_string_lossy().replace('\\', "/"))
}

/// Would this new clip's name clash with one already on the NAS? (cached listing, no network)
pub fn exists_on_nas(s: &crate::settings::Settings, local: &Path) -> bool {
    if s.nas_dir.is_empty() {
        return false;
    }
    let Some(rel) = rel_of(Path::new(&s.clips_dir), local) else { return false };
    let l = LISTING.lock().unwrap();
    l.as_ref().is_some_and(|l| l.root == s.nas_dir && l.rels.contains(&rel_key(&rel)))
}

/// Clips on the NAS (cached; refreshed by the worker).
pub fn listing(nas_dir: &str) -> Vec<NasFile> {
    let l = LISTING.lock().unwrap();
    match l.as_ref() {
        Some(l) if !nas_dir.is_empty() && l.root == nas_dir => l.files.clone(),
        _ => Vec::new(),
    }
}

pub fn state() -> NasState {
    STATE.lock().unwrap().clone().unwrap_or_default()
}

/// A clip was just saved: copy it once it has settled (no need to wait for the 30 s tick).
pub fn clip_saved() {
    std::thread::spawn(|| {
        std::thread::sleep(SETTLE + Duration::from_secs(1));
        wake();
    });
}

/// Run a pass now (settings changed, or "Sync now").
pub fn wake() {
    let (m, c) = &WAKE;
    *m.lock().unwrap() = true;
    c.notify_one();
}

fn is_video(p: &Path) -> bool {
    crate::library::is_video(p)
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Videos in `<root>` and its game folders (one level, like the clips folder).
fn clips_in(root: &Path) -> Vec<(PathBuf, String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            if let Ok(inner) = fs::read_dir(&p) {
                for f in inner.flatten() {
                    let fname = f.file_name().to_string_lossy().into_owned();
                    let fp = f.path();
                    if !hidden(&fname) && fp.is_file() && is_video(&fp) {
                        out.push((fp, format!("{name}/{fname}"), name.clone()));
                    }
                }
            }
        } else if is_video(&p) {
            out.push((p, name.clone(), "Other".into()));
        }
    }
    out
}

fn scan_nas(root: &Path) -> Vec<NasFile> {
    clips_in(root).into_iter().map(|(path, rel, folder)| NasFile { path, rel, folder }).collect()
}

#[derive(Default, Debug, PartialEq)]
pub struct Pass {
    pub copied: Vec<String>,
    pub removed: Vec<String>,
    pub pending: usize,
    pub pending_bytes: u64,
    pub errors: Vec<String>,
}

fn settled(p: &Path, min_age: Duration) -> bool {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() >= min_age)
        .unwrap_or(false)
}

fn size(p: &Path) -> Option<u64> {
    fs::metadata(p).ok().map(|m| m.len())
}

const CHUNK: usize = 1 << 20;

fn sha256_of(mut r: impl Read, buf: &mut [u8]) -> std::io::Result<[u8; 32]> {
    let mut h = Sha256::new();
    loop {
        let n = r.read(buf)?;
        if n == 0 {
            return Ok(h.finalize().into());
        }
        h.update(&buf[..n]);
    }
}

/// SHA-256 of a file as it really is on disk (or the NAS), not as Windows
/// remembers it from writing it a moment ago: read with no cache.
fn sha256_uncached(p: &Path) -> Result<[u8; 32], String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
    // Uncached reads need a buffer aligned to the disk's sector size.
    // Uncached reads go over the network one at a time, so bigger reads are faster.
    const READ: usize = 4 << 20;
    let mut v = vec![0u8; READ + 4096];
    let off = v.as_ptr().align_offset(4096);
    let buf = &mut v[off..off + READ];
    let uncached = fs::File::options().read(true).custom_flags(FILE_FLAG_NO_BUFFERING).open(p).and_then(|f| sha256_of(f, buf));
    match uncached {
        Ok(h) => Ok(h),
        // Some shares refuse uncached reads: an ordinary read still catches a bad copy.
        Err(_) => fs::File::open(p).and_then(|f| sha256_of(f, buf)).map_err(|e| e.to_string()),
    }
}

/// Copy `src` to `tmp`, fingerprinting it on the way, then read `tmp` back
/// and check it's identical. Keeps the clip's date.
fn copy_verified(src: &Path, tmp: &Path, progress: &mut dyn FnMut(u64, bool)) -> Result<(), String> {
    let mut r = fs::File::open(src).map_err(|e| e.to_string())?;
    let modified = r.metadata().and_then(|m| m.modified()).ok();
    let mut w = fs::File::create(tmp).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut sent = 0u64;
    loop {
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        sent += n as u64;
        progress(sent, false);
    }
    if let Some(t) = modified {
        let _ = w.set_modified(t);
    }
    w.sync_all().map_err(|e| e.to_string())?;
    drop(w);
    let want: [u8; 32] = h.finalize().into();
    progress(sent, true);
    if sha256_uncached(tmp)? != want {
        return Err("the copy on the NAS didn't match the original, so it was thrown away and will be tried again".into());
    }
    Ok(())
}

/// Are the clip here and its NAS copy identical? (For clips copied before
/// copies were verified.)
fn same_contents(local: &Path, nas: &Path) -> Result<bool, String> {
    let mut buf = vec![0u8; CHUNK];
    let a = fs::File::open(local).and_then(|f| sha256_of(f, &mut buf)).map_err(|e| e.to_string())?;
    Ok(sha256_uncached(nas)? == a)
}

/// Freed-up local copies go to the Recycle Bin (tests delete outright).
fn recycle(p: &Path) -> Result<(), String> {
    #[cfg(test)]
    return fs::remove_file(p).map_err(|e| e.to_string());
    #[cfg(not(test))]
    trash::delete(p).map_err(|e| e.to_string())
}

/// One sync pass: copy every settled clip that isn't on the NAS yet.
/// `synced` holds the keys of clips already copied (so deleting one on the NAS sticks).
pub fn sync_once(
    local: &Path,
    nas: &Path,
    synced: &mut HashSet<String>,
    // Keys of clips whose NAS copy is known identical (only those are ever freed up here).
    verified: &mut HashSet<String>,
    remove_local: bool,
    min_age: Duration,
    mut on_copy: impl FnMut(Step),
    // Checked before each copy: true stops the pass (a game started).
    stop: &dyn Fn() -> bool,
) -> Result<Pass, String> {
    if !nas.is_dir() {
        return Err(format!("Can't reach {}", nas.display()));
    }
    let mut pass = Pass::default();
    let todo: Vec<_> = clips_in(local).into_iter().filter(|(p, _, _)| settled(p, min_age)).collect();
    // What this pass will copy, for the progress display.
    let (mut total_files, mut total_bytes) = (0usize, 0u64);
    for (src, rel, _) in &todo {
        if !synced.contains(&rel_key(rel)) && size(&nas.join(rel.replace('/', "\\"))).is_none() {
            total_files += 1;
            total_bytes += size(src).unwrap_or(0);
        }
    }
    let (mut done_files, mut done_bytes) = (0usize, 0u64);
    for (src, rel, _) in todo {
        let key = rel_key(&rel);
        let dest = nas.join(rel.replace('/', "\\"));
        let local_size = size(&src);
        if synced.contains(&key) {
            // Already copied once. Free up space if asked, the NAS copy is still
            // there, and it's identical (checked once, the first time).
            if !remove_local || local_size.is_none() || size(&dest) != local_size {
                continue;
            }
            if !verified.contains(&key) {
                if stop() {
                    continue;
                }
                on_copy(Step { file: Some(&rel), checking: true, done_bytes, total_bytes, done_files, total_files });
                match same_contents(&src, &dest) {
                    Ok(true) => {
                        verified.insert(key.clone());
                    }
                    Ok(false) => {
                        pass.errors.push(format!("{rel}: the NAS copy isn't identical to this one, so this one is kept"));
                        continue;
                    }
                    Err(e) => {
                        pass.errors.push(format!("{rel}: couldn't check the NAS copy ({e}), so this one is kept"));
                        continue;
                    }
                }
            }
            match recycle(&src) {
                Ok(()) => pass.removed.push(rel),
                Err(e) => pass.errors.push(format!("{rel}: couldn't move the local copy to the Recycle Bin ({e})")),
            }
            continue;
        }
        match size(&dest) {
            Some(n) if Some(n) == local_size => {
                synced.insert(key);
                continue;
            }
            Some(_) => {
                pass.errors.push(format!("{rel}: a different file with that name is already on the NAS"));
                continue;
            }
            None => {}
        }
        pass.pending += 1;
        if stop() {
            continue; // counted as waiting, copied on a later pass
        }
        on_copy(Step { file: Some(&rel), checking: false, done_bytes, total_bytes, done_files, total_files });
        let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = dest.with_file_name(format!(".{name}{PARTIAL}"));
        let copied = (|| -> Result<(), String> {
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            copy_verified(&src, &tmp, &mut |n, checking| {
                on_copy(Step { file: Some(&rel), checking, done_bytes: done_bytes + n, total_bytes, done_files, total_files })
            })?;
            if size(&tmp) != local_size {
                return Err("the copy came out the wrong size".into());
            }
            fs::rename(&tmp, &dest).map_err(|e| e.to_string())
        })();
        match copied {
            Ok(()) => {
                pass.pending -= 1;
                done_files += 1;
                done_bytes += local_size.unwrap_or(0);
                synced.insert(key.clone());
                verified.insert(key);
                if remove_local {
                    match recycle(&src) {
                        Ok(()) => pass.removed.push(rel.clone()),
                        Err(e) => pass.errors.push(format!("{rel}: couldn't move the local copy to the Recycle Bin ({e})")),
                    }
                }
                pass.copied.push(rel);
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                pass.errors.push(format!("{rel}: {e}"));
            }
        }
    }
    pass.pending_bytes = total_bytes.saturating_sub(done_bytes);
    on_copy(Step { file: None, checking: false, done_bytes, total_bytes, done_files, total_files });
    Ok(pass)
}

fn manifest_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("nas-synced.txt"))
}

/// Same format as the synced list: clips whose NAS copy was checked identical.
fn verified_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("nas-verified.txt"))
}

/// Lines are "<nas root>|<key>", so switching NAS folders starts fresh.
fn load_synced(path: &Path, root: &str) -> HashSet<String> {
    let prefix = format!("{}|", root.to_lowercase());
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

fn save_synced(path: &Path, root: &str, synced: &HashSet<String>) {
    let prefix = root.to_lowercase();
    let mut lines: Vec<String> = fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with(&format!("{prefix}|")))
        .map(str::to_string)
        .collect();
    lines.extend(synced.iter().map(|k| format!("{prefix}|{k}")));
    let tmp = path.with_extension("txt.tmp");
    if fs::write(&tmp, lines.join("\n")).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn publish(app: &AppHandle, f: impl FnOnce(&mut NasState)) {
    let snapshot = {
        let mut s = STATE.lock().unwrap();
        let st = s.get_or_insert_with(NasState::default);
        f(st);
        st.clone()
    };
    let _ = app.emit("nas-state", snapshot);
}

/// Background worker: a pass every 30 s, or right after `wake()`.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut synced: HashSet<String> = HashSet::new();
        let mut verified: HashSet<String> = HashSet::new();
        let mut synced_root = String::new();
        loop {
            {
                let (m, c) = &WAKE;
                let g = m.lock().unwrap();
                let (mut g, _) = c.wait_timeout_while(g, Duration::from_secs(30), |woken| !*woken).unwrap();
                *g = false;
            }
            let s = app.state::<crate::AppState>().settings.lock().unwrap().clone();
            if s.nas_dir.is_empty() {
                *LISTING.lock().unwrap() = None;
                publish(&app, |st| *st = NasState::default());
                continue;
            }
            // Copying reads the SSD and uses the network: wait until the game is closed.
            let app_busy = {
                let st = app.state::<crate::AppState>();
                st.engine.is_recording()
            };
            if crate::games::game_running() || app_busy {
                publish(&app, |st| {
                    st.enabled = true;
                    st.paused = true;
                    st.copying = None;
                });
                continue;
            }
            publish(&app, |st| st.paused = false);
            if crate::engine::saves_in_progress() > 0 {
                std::thread::sleep(Duration::from_secs(3));
                wake();
                continue;
            }
            let manifest = manifest_path(&app);
            let verified_file = verified_path(&app);
            if synced_root != s.nas_dir {
                synced = manifest.as_deref().map(|p| load_synced(p, &s.nas_dir)).unwrap_or_default();
                verified = verified_file.as_deref().map(|p| load_synced(p, &s.nas_dir)).unwrap_or_default();
                synced_root = s.nas_dir.clone();
            }
            let nas = PathBuf::from(&s.nas_dir);
            let a = app.clone();
            let mut started: Option<std::time::Instant> = None;
            let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
            let mut last_file = String::new();
            let result = sync_once(Path::new(&s.clips_dir), &nas, &mut synced, &mut verified, s.nas_remove_local, SETTLE, |step| {
                let file = step.file.map(|r| r.rsplit('/').next().unwrap_or(r).to_string());
                // Throttled: a clip is hundreds of 1 MB chunks.
                let new_file = file.as_deref().unwrap_or("") != last_file;
                if !new_file && step.file.is_some() && last_emit.elapsed() < Duration::from_millis(400) {
                    return;
                }
                last_emit = std::time::Instant::now();
                last_file = file.clone().unwrap_or_default();
                let since = *started.get_or_insert_with(std::time::Instant::now);
                let secs = since.elapsed().as_secs_f64();
                let rate = if secs > 2.0 { step.done_bytes as f64 / secs } else { 0.0 };
                let left = step.total_bytes.saturating_sub(step.done_bytes);
                publish(&a, |st| {
                    st.copying = file;
                    st.checking = step.checking;
                    st.total_files = step.total_files;
                    st.done_files = step.done_files;
                    st.total_bytes = step.total_bytes;
                    st.done_bytes = step.done_bytes;
                    st.pending_bytes = left;
                    st.rate = rate;
                    st.eta_secs = (rate > 0.0 && left > 0).then(|| (left as f64 / rate) as u64);
                });
            }, &|| crate::games::game_running());
            if let Some(p) = &manifest {
                save_synced(p, &s.nas_dir, &synced);
            }
            if let Some(p) = &verified_file {
                save_synced(p, &s.nas_dir, &verified);
            }
            let reachable = result.is_ok();
            let mut changed = false;
            match &result {
                Ok(pass) => {
                    changed = !pass.copied.is_empty() || !pass.removed.is_empty();
                    publish(&app, |st| {
                        st.enabled = true;
                        st.reachable = true;
                        st.pending = pass.pending;
                        st.pending_bytes = pass.pending_bytes;
                        st.copied += pass.copied.len();
                        st.last_error = pass.errors.first().cloned();
                        st.last_sync = Some(now_ms());
                    });
                }
                Err(e) => publish(&app, |st| {
                    st.enabled = true;
                    st.reachable = false;
                    st.copying = None;
                    st.last_error = Some(e.clone());
                }),
            }
            // Refresh the NAS listing (other PCs' clips show up in the library).
            if reachable {
                let files = scan_nas(&nas);
                let rels: HashSet<String> = files.iter().map(|f| rel_key(&f.rel)).collect();
                let mut l = LISTING.lock().unwrap();
                let before = l.as_ref().filter(|l| l.root == s.nas_dir).map(|l| l.rels.clone());
                changed |= before.as_ref() != Some(&rels);
                *l = Some(Listing { root: s.nas_dir.clone(), files, rels });
            }
            if changed {
                let _ = app.emit("clips-changed", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rewind-nas-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn clip(root: &Path, rel: &str, bytes: usize) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, vec![7u8; bytes]).unwrap();
        p
    }

    #[test]
    fn progress_counts_files_and_bytes() {
        let (local, nas) = (tmp("p-local"), tmp("p-nas"));
        clip(&local, "A/a.mkv", 3 << 20);
        clip(&local, "B/b.mkv", 1 << 20);
        fs::create_dir_all(&nas).unwrap();
        let (mut synced, mut verified) = (HashSet::new(), HashSet::new());
        let mut steps: Vec<(u64, u64, usize, usize, bool)> = Vec::new();
        let on = |s: Step| steps.push((s.done_bytes, s.total_bytes, s.done_files, s.total_files, s.checking));
        sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, on, &|| false).unwrap();
        let total = 4u64 << 20;
        assert!(steps.iter().all(|s| s.1 == total && s.3 == 2), "{steps:?}");
        assert!(steps.windows(2).all(|w| w[1].0 >= w[0].0), "bytes only go up");
        assert!(steps.iter().any(|s| s.4), "the check shows up");
        assert_eq!(steps.last().unwrap().0, total);
        assert_eq!(steps.last().unwrap().2, 2);
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn nothing_is_copied_while_a_game_is_running() {
        let (local, nas) = (tmp("g-local"), tmp("g-nas"));
        fs::create_dir_all(&nas).unwrap();
        clip(&local, "VALORANT/a.mkv", 1000);
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| true).unwrap();
        assert!(pass.copied.is_empty() && pass.removed.is_empty());
        assert_eq!(pass.pending, 1);
        assert!(local.join("VALORANT/a.mkv").exists() && !nas.join("VALORANT/a.mkv").exists());
        // Game closed: the next pass copies it.
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied.len(), 1);
    }

    #[test]
    fn copies_clips_into_matching_game_folders() {
        let (local, nas) = (tmp("a-local"), tmp("a-nas"));
        clip(&local, "VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv", 1000);
        clip(&local, "Desktop/Desktop 2026-11-03 10-01-00 - PC1.mkv", 500);
        clip(&local, ".rewind-save-123/part.mkv", 50); // in-progress save: never copied
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied.len(), 2, "{pass:?}");
        assert_eq!(pass.pending, 0);
        assert_eq!(size(&nas.join("VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv")), Some(1000));
        assert!(!nas.join(".rewind-save-123").exists());
        // No leftovers from the copy-then-rename.
        assert!(fs::read_dir(nas.join("VALORANT")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(PARTIAL)));
        // Local copies are kept unless asked.
        assert!(local.join("VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv").exists());
        // A second pass does nothing.
        let again = sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(again.copied.is_empty() && again.errors.is_empty());
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn clips_still_being_written_wait() {
        let (local, nas) = (tmp("b-local"), tmp("b-nas"));
        clip(&local, "Game/new.mkv", 100);
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::from_secs(60), |_| {}, &|| false).unwrap();
        assert!(pass.copied.is_empty());
        assert!(!nas.join("Game").exists());
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn deleting_on_the_nas_sticks_and_local_removal_needs_a_verified_copy() {
        let (local, nas) = (tmp("c-local"), tmp("c-nas"));
        let a = clip(&local, "Game/a.mkv", 300);
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        // Deleted on the NAS: not copied back.
        fs::remove_file(nas.join("Game/a.mkv")).unwrap();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(pass.copied.is_empty());
        // ...and the local copy is kept, because there's no NAS copy to rely on.
        assert!(a.exists());
        // A new clip with "remove local" on: copied, verified, then removed here.
        let b = clip(&local, "Game/b.mkv", 400);
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied, vec!["Game/b.mkv".to_string()]);
        assert_eq!(pass.removed, vec!["Game/b.mkv".to_string()]);
        assert!(!b.exists());
        assert_eq!(size(&nas.join("Game/b.mkv")), Some(400));
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn a_garbled_nas_copy_never_frees_up_the_local_clip() {
        let (local, nas) = (tmp("v-local"), tmp("v-nas"));
        let a = clip(&local, "Game/a.mkv", 5000);
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        sync_once(&local, &nas, &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        // The copy is identical and keeps the clip's date.
        assert_eq!(fs::read(&a).unwrap(), fs::read(nas.join("Game/a.mkv")).unwrap());
        let date = |p: &Path| fs::metadata(p).unwrap().modified().unwrap();
        assert_eq!(date(&a), date(&nas.join("Game/a.mkv")));
        // Like a clip copied by an older version: synced, never checked. Then the
        // NAS copy goes bad without changing size (a flaky drive or network).
        verified.clear();
        let mut bytes = fs::read(nas.join("Game/a.mkv")).unwrap();
        bytes[2500] ^= 0xff;
        fs::write(nas.join("Game/a.mkv"), bytes).unwrap();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(pass.removed.is_empty(), "{pass:?}");
        assert!(pass.errors[0].contains("isn't identical"), "{pass:?}");
        assert!(a.exists(), "the local clip must be kept");
        // Fixed on the NAS: now it's checked, found identical, and freed up.
        fs::copy(&a, nas.join("Game/a.mkv")).unwrap();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.removed, vec!["Game/a.mkv".to_string()]);
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn a_different_file_with_the_same_name_is_never_overwritten() {
        let (local, nas) = (tmp("d-local"), tmp("d-nas"));
        clip(&local, "Game/x.mkv", 100);
        clip(&nas, "Game/x.mkv", 999);
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, &mut verified, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(pass.copied.is_empty());
        assert_eq!(pass.errors.len(), 1);
        assert_eq!(size(&nas.join("Game/x.mkv")), Some(999));
        assert!(local.join("Game/x.mkv").exists());
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn unreachable_nas_is_an_error_not_a_crash() {
        let local = tmp("e-local");
        let mut synced = HashSet::new();
        let mut verified = HashSet::new();
        assert!(sync_once(&local, Path::new(r"Z:\no\such\nas"), &mut synced, &mut verified, false, Duration::ZERO, |_| {}, &|| false).is_err());
        let _ = fs::remove_dir_all(&local);
    }

    #[test]
    fn synced_list_is_per_nas_folder() {
        let d = tmp("f-manifest");
        let p = d.join("nas-synced.txt");
        let a: HashSet<String> = ["game/a.mkv".to_string()].into();
        let b: HashSet<String> = ["game/b.mkv".to_string()].into();
        save_synced(&p, r"\\nas\one", &a);
        save_synced(&p, r"\\nas\two", &b);
        assert_eq!(load_synced(&p, r"\\nas\one"), a);
        assert_eq!(load_synced(&p, r"\\NAS\two"), b);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn pc_suffix_is_safe_in_file_names() {
        let s = pc_suffix();
        assert!(s.is_empty() || (s.starts_with(" - ") && !s[3..].contains(['\\', '/', ':', '*', '?'])));
    }
}

#[cfg(test)]
mod live {
    /// Verified copy to a real share, timed: REWIND_NAS_TEST=\server\share
    /// cargo test live_nas_verify -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_nas_verify() {
        let Ok(share) = std::env::var("REWIND_NAS_TEST") else { return };
        let dir = std::path::Path::new(&share).join(".rewind-verify-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = std::env::temp_dir().join("rewind-verify-src.bin");
        let data: Vec<u8> = (0..200u32 << 20).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        let tmp = dir.join(".x.mkv.rewind-partial");
        let t = std::time::Instant::now();
        super::copy_verified(&src, &tmp, &mut |_, _| {}).unwrap();
        let secs = t.elapsed().as_secs_f64();
        println!("200 MB copied + verified in {secs:.1} s ({:.0} MB/s)", 200.0 / secs);
        let t = std::time::Instant::now();
        assert!(super::same_contents(&src, &tmp).unwrap());
        println!("re-check of existing copy: {:.1} s", t.elapsed().as_secs_f64());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&src);
        assert!(!dir.exists());
    }
}

