//! Old recorder folders that "Move into Hindsight" emptied.
//!
//! Once every clip from a linked folder (Medal, Outplayed, …) has moved into
//! Hindsight, the folder is just left behind. Hindsight offers to remove it,
//! but only when all of this holds:
//! - a move log shows clips really were moved out of it (not copied);
//! - not one video is left anywhere inside it;
//! - it isn't a drive, a Windows folder (Videos, Desktop…), or a folder that
//!   holds Hindsight's own clips or the NAS.
//!
//! Removing it sends it to the Recycle Bin and stops showing it in the library.
//! Undo for the move still works afterwards: moving a clip back recreates its folder.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OldFolder {
    pub path: String,
    /// The folder's own name ("Medal")
    pub label: String,
    /// Clips that were moved out of it
    pub moved: usize,
    /// Other files still in it (thumbnails, settings…) and their size
    pub files: usize,
    pub bytes: u64,
}

/// `a` is `b` or a folder inside it.
fn within(a: &Path, b: &Path) -> bool {
    let (a, b) = (a.to_string_lossy().to_lowercase().replace('/', "\\"), b.to_string_lossy().to_lowercase().replace('/', "\\"));
    let b = b.trim_end_matches('\\');
    a == b || a.starts_with(&format!("{b}\\"))
}

/// Folders that must never be offered: drives, the user's own Windows folders,
/// and anything holding Hindsight's clips or the NAS.
fn protected(p: &Path, keep: &[PathBuf]) -> bool {
    if p.parent().is_none() || p.components().count() <= 2 {
        return true; // a whole drive
    }
    if keep.iter().any(|k| within(k, p)) {
        return true;
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        if within(&home, p) {
            return true; // the user folder itself, or one above it
        }
        for f in ["Videos", "Desktop", "Documents", "Downloads", "Pictures", "Music", "OneDrive", "AppData"] {
            if library_same(&home.join(f), p) {
                return true;
            }
        }
    }
    false
}

fn library_same(a: &Path, b: &Path) -> bool {
    within(a, b) && within(b, a)
}

/// Videos, other files and their bytes inside `dir` (all the way down).
fn contents(dir: &Path) -> (usize, usize, u64) {
    let (mut videos, mut files, mut bytes) = (0, 0, 0);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else {
            videos += 1; // can't look inside: treat as not empty, to be safe
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if crate::library::is_video(&p) || p.to_string_lossy().ends_with(".rewind-partial") {
                videos += 1;
            } else {
                files += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (videos, files, bytes)
}

/// How many clips the move logs say were moved (not copied) out of `dir`.
fn moved_out_of(dir: &Path, logs: &Path) -> usize {
    let Ok(rd) = fs::read_dir(logs) else { return 0 };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .flat_map(|log| crate::consolidate::read_log(&log))
        .filter(|m| !m.copied && within(&m.from, dir))
        .count()
}

/// Linked folders that are empty of clips now that they moved into Hindsight.
/// `keep`: Hindsight's clips folder and the NAS. `logs`: the move logs folder.
pub fn find(linked: &[String], keep: &[PathBuf], logs: &Path) -> Vec<OldFolder> {
    linked
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir() && !protected(p, keep))
        .filter_map(|p| {
            let moved = moved_out_of(&p, logs);
            if moved == 0 {
                return None;
            }
            let (videos, files, bytes) = contents(&p);
            (videos == 0).then(|| OldFolder {
                label: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned()),
                path: p.to_string_lossy().into_owned(),
                moved,
                files,
                bytes,
            })
        })
        .collect()
}

/// Check `path` again (it has to be offered right now), then send it to the Recycle Bin.
pub fn remove(path: &str, linked: &[String], keep: &[PathBuf], logs: &Path) -> Result<(), String> {
    if !find(linked, keep, logs).iter().any(|f| f.path == path) {
        return Err("That folder isn't safe to remove any more (something is in it again). Nothing was deleted.".into());
    }
    let p = Path::new(path);
    #[cfg(test)]
    {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    }
    #[cfg(not(test))]
    {
        // Its leftovers are small; still, never delete for good if the Recycle Bin would.
        for e in walk_files(p) {
            crate::library::recycle_check(&e)?;
        }
        trash::delete(p).map_err(|e| format!("Couldn't move it to the Recycle Bin: {e}"))
    }
}

#[cfg(not(test))]
fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hindsight-old-{name}-{}", std::process::id())).join("Recorders");
        let _ = fs::remove_dir_all(d.parent().unwrap());
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn log(logs: &Path, from: &Path, copied: bool) {
        fs::create_dir_all(logs).unwrap();
        let m = crate::consolidate::Move { from: from.to_path_buf(), to: PathBuf::from(r"C:\x\y.mp4"), size: 1, copied };
        fs::write(logs.join("20260101-000000-Medal.jsonl"), serde_json::to_string(&m).unwrap() + "\n").unwrap();
    }

    #[test]
    fn offers_only_emptied_folders_and_removes_them() {
        let base = tmp("offer");
        let medal = base.join("Medal");
        let logs = base.join("moves");
        fs::create_dir_all(medal.join("Clips/Valorant")).unwrap();
        fs::write(medal.join("settings.json"), b"{}").unwrap();
        fs::write(medal.join("Clips/Valorant/a.mp4"), b"v").unwrap();
        let linked = vec![medal.to_string_lossy().into_owned()];
        let keep = vec![base.join("Hindsight")];

        // No move yet: never offered.
        assert!(find(&linked, &keep, &logs).is_empty());
        // Moved, but a clip is still there: not offered.
        log(&logs, &medal.join("Clips/Valorant/b.mp4"), false);
        assert!(find(&linked, &keep, &logs).is_empty());
        // Every clip gone: offered, with what's left in it.
        fs::remove_file(medal.join("Clips/Valorant/a.mp4")).unwrap();
        let found = find(&linked, &keep, &logs);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].label.as_str(), found[0].moved, found[0].files), ("Medal", 1, 1));
        // A clip turning up again is caught at the last moment.
        fs::write(medal.join("new.mkv"), b"v").unwrap();
        assert!(remove(&found[0].path, &linked, &keep, &logs).is_err());
        assert!(medal.exists());
        fs::remove_file(medal.join("new.mkv")).unwrap();
        remove(&found[0].path, &linked, &keep, &logs).unwrap();
        assert!(!medal.exists());
        let _ = fs::remove_dir_all(base.parent().unwrap());
    }

    #[test]
    fn copies_and_protected_folders_are_never_offered() {
        let base = tmp("protect");
        let obs = base.join("OBS");
        let logs = base.join("moves");
        fs::create_dir_all(&obs).unwrap();
        // Copied in (the originals stay): not offered.
        log(&logs, &obs.join("a.mp4"), true);
        let linked = vec![obs.to_string_lossy().into_owned()];
        assert!(find(&linked, &[], &logs).is_empty());
        // Moved, but it holds Hindsight's own clips folder: not offered.
        log(&logs, &obs.join("a.mp4"), false);
        assert_eq!(find(&linked, &[], &logs).len(), 1);
        assert!(find(&linked, &[obs.join("Hindsight")], &logs).is_empty());
        // Drives and the user's own folders.
        assert!(protected(Path::new(r"C:\"), &[]));
        assert!(!protected(Path::new(r"D:\Medal"), &[]), "a recorder folder at the top of a drive is fine");
        if let Ok(home) = std::env::var("USERPROFILE") {
            assert!(protected(&PathBuf::from(&home).join("Videos"), &[]));
            assert!(protected(&PathBuf::from(&home), &[]));
            assert!(!protected(&PathBuf::from(&home).join("Videos").join("Medal"), &[]));
        }
        let _ = fs::remove_dir_all(base.parent().unwrap());
    }
}
