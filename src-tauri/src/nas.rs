//! NAS library.
//!
//! Clips always save to this PC first, so saving stays instant and works with
//! the NAS asleep or the network down. A background worker then copies each
//! finished clip to the NAS with the same `<Game>/<file>` layout, so every PC
//! shares one folder per game (file names carry the PC's name, see `pc_suffix`).
//!
//! - A copy goes to a hidden `.name.rewind-partial` file first and is renamed
//!   only once its size matches, so the NAS never shows a half-copied clip.
//! - Copied clips are remembered (nas-synced.txt), so a clip deleted on the NAS
//!   isn't copied back again.
//! - Optionally the local copy is removed once the NAS copy is verified.
//! - Nothing is copied while a game is running (in front or tabbed out of)
//!   or a recording is going, so it never costs frames.
//! - The worker never touches the network on the save path: duplicate-name
//!   checks use the cached NAS listing.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
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
/// Set while game folders are being merged: the worker skips its passes.
static HOLD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Folder renames from a merge ("old/" → "new/", lowercase) still to apply to
/// the copied-clips record, so a clip deleted on the NAS isn't copied back under
/// its new folder name.
static RENAMED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Pause copying (true) while folders are merged, then carry on (false).
pub fn hold(on: bool) {
    HOLD.store(on, std::sync::atomic::Ordering::SeqCst);
    if !on {
        wake();
    }
}

/// A game folder was renamed by a merge: copied clips under `from` now live under `to`.
pub fn folder_renamed(from: &str, to: &str) {
    RENAMED.lock().unwrap().push((format!("{}/", from.to_lowercase()), format!("{}/", to.to_lowercase())));
}

fn apply_renames(synced: &mut HashSet<String>, renames: &[(String, String)]) {
    for (from, to) in renames {
        let moved: Vec<String> = synced.iter().filter(|k| k.starts_with(from.as_str())).cloned().collect();
        for k in moved {
            synced.remove(&k);
            synced.insert(format!("{to}{}", &k[from.len()..]));
        }
    }
}
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

/// One sync pass: copy every settled clip that isn't on the NAS yet.
/// `synced` holds the keys of clips already copied (so deleting one on the NAS sticks).
pub fn sync_once(
    local: &Path,
    nas: &Path,
    synced: &mut HashSet<String>,
    remove_local: bool,
    min_age: Duration,
    mut on_copy: impl FnMut(Option<&str>),
    // Checked before each copy: true stops the pass (a game started).
    stop: &dyn Fn() -> bool,
) -> Result<Pass, String> {
    if !nas.is_dir() {
        return Err(format!("Can't reach {}", nas.display()));
    }
    let mut pass = Pass::default();
    let todo: Vec<_> = clips_in(local).into_iter().filter(|(p, _, _)| settled(p, min_age)).collect();
    for (src, rel, _) in todo {
        let key = rel_key(&rel);
        let dest = nas.join(rel.replace('/', "\\"));
        let local_size = size(&src);
        if synced.contains(&key) {
            // Already copied once. Free up space if asked and the NAS copy is still intact.
            if remove_local && local_size.is_some() && size(&dest) == local_size && fs::remove_file(&src).is_ok() {
                pass.removed.push(rel);
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
        on_copy(Some(&rel));
        let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = dest.with_file_name(format!(".{name}{PARTIAL}"));
        let copied = (|| -> Result<(), String> {
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
            if size(&tmp) != local_size {
                return Err("the copy came out the wrong size".into());
            }
            fs::rename(&tmp, &dest).map_err(|e| e.to_string())
        })();
        match copied {
            Ok(()) => {
                pass.pending -= 1;
                synced.insert(key);
                if remove_local && fs::remove_file(&src).is_ok() {
                    pass.removed.push(rel.clone());
                }
                pass.copied.push(rel);
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                pass.errors.push(format!("{rel}: {e}"));
            }
        }
    }
    on_copy(None);
    Ok(pass)
}

fn manifest_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("nas-synced.txt"))
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
        let mut synced_root = String::new();
        loop {
            {
                let (m, c) = &WAKE;
                let g = m.lock().unwrap();
                let (mut g, _) = c.wait_timeout_while(g, Duration::from_secs(30), |woken| !*woken).unwrap();
                *g = false;
            }
            if HOLD.load(std::sync::atomic::Ordering::SeqCst) {
                continue; // a merge is moving folders; `hold(false)` wakes us again
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
            if synced_root != s.nas_dir {
                synced = manifest.as_deref().map(|p| load_synced(p, &s.nas_dir)).unwrap_or_default();
                synced_root = s.nas_dir.clone();
            }
            let renames = std::mem::take(&mut *RENAMED.lock().unwrap());
            if !renames.is_empty() {
                apply_renames(&mut synced, &renames);
                if let Some(p) = &manifest {
                    save_synced(p, &s.nas_dir, &synced);
                }
            }
            let nas = PathBuf::from(&s.nas_dir);
            let a = app.clone();
            let result = sync_once(Path::new(&s.clips_dir), &nas, &mut synced, s.nas_remove_local, SETTLE, |now| {
                let now = now.map(|r| r.rsplit('/').next().unwrap_or(r).to_string());
                publish(&a, |st| st.copying = now);
            }, &|| crate::games::game_running());
            if let Some(p) = &manifest {
                save_synced(p, &s.nas_dir, &synced);
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

    #[test]
    fn merged_folders_keep_their_copied_record() {
        let mut synced: HashSet<String> =
            ["valorant/a.mkv", "valorant x/b.mkv", "desktop/c.mkv"].iter().map(|s| s.to_string()).collect();
        apply_renames(&mut synced, &[("valorant/".into(), "valorant!/".into())]);
        let mut v: Vec<&String> = synced.iter().collect();
        v.sort();
        assert_eq!(v, vec!["desktop/c.mkv", "valorant x/b.mkv", "valorant!/a.mkv"]);
    }

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
    fn nothing_is_copied_while_a_game_is_running() {
        let (local, nas) = (tmp("g-local"), tmp("g-nas"));
        fs::create_dir_all(&nas).unwrap();
        clip(&local, "VALORANT/a.mkv", 1000);
        let mut synced = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, true, Duration::ZERO, |_| {}, &|| true).unwrap();
        assert!(pass.copied.is_empty() && pass.removed.is_empty());
        assert_eq!(pass.pending, 1);
        assert!(local.join("VALORANT/a.mkv").exists() && !nas.join("VALORANT/a.mkv").exists());
        // Game closed: the next pass copies it.
        let pass = sync_once(&local, &nas, &mut synced, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied.len(), 1);
    }

    #[test]
    fn copies_clips_into_matching_game_folders() {
        let (local, nas) = (tmp("a-local"), tmp("a-nas"));
        clip(&local, "VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv", 1000);
        clip(&local, "Desktop/Desktop 2026-11-03 10-01-00 - PC1.mkv", 500);
        clip(&local, ".rewind-save-123/part.mkv", 50); // in-progress save: never copied
        let mut synced = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied.len(), 2, "{pass:?}");
        assert_eq!(pass.pending, 0);
        assert_eq!(size(&nas.join("VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv")), Some(1000));
        assert!(!nas.join(".rewind-save-123").exists());
        // No leftovers from the copy-then-rename.
        assert!(fs::read_dir(nas.join("VALORANT")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(PARTIAL)));
        // Local copies are kept unless asked.
        assert!(local.join("VALORANT/VALORANT 2026-11-03 10-00-00 - PC1.mkv").exists());
        // A second pass does nothing.
        let again = sync_once(&local, &nas, &mut synced, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(again.copied.is_empty() && again.errors.is_empty());
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn clips_still_being_written_wait() {
        let (local, nas) = (tmp("b-local"), tmp("b-nas"));
        clip(&local, "Game/new.mkv", 100);
        let mut synced = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, false, Duration::from_secs(60), |_| {}, &|| false).unwrap();
        assert!(pass.copied.is_empty());
        assert!(!nas.join("Game").exists());
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn deleting_on_the_nas_sticks_and_local_removal_needs_a_verified_copy() {
        let (local, nas) = (tmp("c-local"), tmp("c-nas"));
        let a = clip(&local, "Game/a.mkv", 300);
        let mut synced = HashSet::new();
        sync_once(&local, &nas, &mut synced, false, Duration::ZERO, |_| {}, &|| false).unwrap();
        // Deleted on the NAS: not copied back.
        fs::remove_file(nas.join("Game/a.mkv")).unwrap();
        let pass = sync_once(&local, &nas, &mut synced, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert!(pass.copied.is_empty());
        // ...and the local copy is kept, because there's no NAS copy to rely on.
        assert!(a.exists());
        // A new clip with "remove local" on: copied, verified, then removed here.
        let b = clip(&local, "Game/b.mkv", 400);
        let pass = sync_once(&local, &nas, &mut synced, true, Duration::ZERO, |_| {}, &|| false).unwrap();
        assert_eq!(pass.copied, vec!["Game/b.mkv".to_string()]);
        assert_eq!(pass.removed, vec!["Game/b.mkv".to_string()]);
        assert!(!b.exists());
        assert_eq!(size(&nas.join("Game/b.mkv")), Some(400));
        let _ = (fs::remove_dir_all(&local), fs::remove_dir_all(&nas));
    }

    #[test]
    fn a_different_file_with_the_same_name_is_never_overwritten() {
        let (local, nas) = (tmp("d-local"), tmp("d-nas"));
        clip(&local, "Game/x.mkv", 100);
        clip(&nas, "Game/x.mkv", 999);
        let mut synced = HashSet::new();
        let pass = sync_once(&local, &nas, &mut synced, true, Duration::ZERO, |_| {}, &|| false).unwrap();
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
        assert!(sync_once(&local, Path::new(r"Z:\no\such\nas"), &mut synced, false, Duration::ZERO, |_| {}, &|| false).is_err());
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
