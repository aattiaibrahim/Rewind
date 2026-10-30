//! Finding and running the bundled ffmpeg / ffprobe.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::OnceLock;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::core::PCWSTR;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Games always win CPU time over capture and exports.
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static JOB: OnceLock<usize> = OnceLock::new();

/// Use the copy bundled next to the app, or the one in vendor/ during development.
pub fn init(resource_dir: Option<PathBuf>) {
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../vendor/ffmpeg/bin"));
    let dir = match resource_dir.map(|r| r.join("ffmpeg")) {
        Some(d) if d.join("ffmpeg.exe").exists() => d,
        _ => dev,
    };
    let _ = DIR.set(dir);
}

pub fn exe(name: &str) -> PathBuf {
    DIR.get().cloned().unwrap_or_default().join(format!("{name}.exe"))
}

/// A command with no console window, at below-normal CPU priority.
pub fn cmd(name: &str) -> Command {
    let mut c = Command::new(exe(name));
    c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    c
}

/// Free space on the drive holding `path`, in bytes.
pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::HSTRING;
    // Walk up to a folder that exists (the clips folder may not be created yet).
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(p.as_os_str()), Some(&mut free), None, None).ok()? };
    Some(free)
}

/// Turn string literals into an argument list that can also hold paths.
pub fn args(a: &[&str]) -> Vec<std::ffi::OsString> {
    a.iter().map(|s| s.into()).collect()
}

/// Run to completion; Ok(stdout) on success, Err(last stderr lines) on failure.
pub fn run<S: AsRef<std::ffi::OsStr>>(name: &str, args: &[S]) -> Result<String, String> {
    let out = cmd(name)
        .args(args)
        .output()
        .map_err(|e| format!("Could not start {name}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(4).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// Put a child in a job object so it dies with Rewind, even if Rewind crashes.
pub fn adopt(child: &Child) {
    let raw = *JOB.get_or_init(|| unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
            return 0;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job.0 as usize
    });
    if raw != 0 {
        unsafe {
            let _ = AssignProcessToJobObject(
                HANDLE(raw as *mut c_void),
                HANDLE(child.as_raw_handle() as *mut c_void),
            );
        }
    }
}
