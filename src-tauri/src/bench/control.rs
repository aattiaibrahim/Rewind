//! Switching NVIDIA Instant Replay and Medal on and off during the
//! performance test, so the player doesn't have to.
//!
//! - NVIDIA: presses the player's own Instant Replay shortcut (read from
//!   NVIDIA's settings, Alt+Shift+F10 by default).
//! - Medal: closed to stop clipping, opened again to start it.
//!
//! The caller checks the encoder afterwards, and asks the player by voice
//! only if this didn't work.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
    MapVirtualKeyW, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_MINIMIZE, SW_RESTORE,
    SetForegroundWindow, ShowWindow,
};
use windows::core::BOOL;

use super::measure::{self, App};

const NO_WINDOW: u32 = 0x0800_0000;
const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_ALT: u16 = 0x12;
const VK_F10: u16 = 0x79;

/// The Instant Replay on/off shortcut from NVIDIA's settings, as virtual-key
/// codes (modifiers first). Alt+Shift+F10 if it can't be read.
pub fn nvidia_shortcut() -> Vec<u16> {
    const KEY: &str = r"Software\NVIDIA Corporation\Global\ShadowPlay\NVSPCAPS";
    let read = |name: &str| super::recorders::reg_u32(KEY, name);
    let keys: Vec<u16> = match read("IRToggleHKeyCount") {
        Some(n) if (1..=4).contains(&n) => (0..n).filter_map(|i| read(&format!("IRToggleHKey{i}"))).map(|v| v as u16).collect(),
        _ => Vec::new(),
    };
    if keys.is_empty() || keys.iter().any(|&k| k == 0 || k > 0xFE) {
        return vec![VK_ALT, VK_SHIFT, VK_F10];
    }
    keys
}

/// "Alt+Shift+F10", for the voice prompt if pressing it didn't work.
pub fn shortcut_name(keys: &[u16]) -> String {
    keys.iter()
        .map(|&k| match k {
            VK_ALT => "Alt".to_string(),
            VK_SHIFT => "Shift".to_string(),
            VK_CONTROL => "Ctrl".to_string(),
            0x70..=0x87 => format!("F{}", k - 0x6F),
            0x30..=0x39 | 0x41..=0x5A => (k as u8 as char).to_string(),
            _ => format!("key {k}"),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn key(vk: u16, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    // Arrows, Insert/Delete, Home/End, Page keys are "extended".
    if matches!(vk, 0x21..=0x28 | 0x2D | 0x2E) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// Press a shortcut like a person would: hold the modifiers, tap the last
/// key, let go in reverse order, with short gaps so it's picked up.
pub fn press(keys: &[u16]) {
    for &k in keys {
        unsafe { SendInput(&[key(k, false)], std::mem::size_of::<INPUT>() as i32) };
        thread::sleep(Duration::from_millis(40));
    }
    thread::sleep(Duration::from_millis(80));
    for &k in keys.iter().rev() {
        unsafe { SendInput(&[key(k, true)], std::mem::size_of::<INPUT>() as i32) };
        thread::sleep(Duration::from_millis(40));
    }
}

fn medal_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Medal")).filter(|d| d.join("Medal.exe").exists())
}

pub fn medal_running() -> bool {
    measure::app_pids().get(&App::Medal).is_some_and(|p| !p.is_empty())
}

/// Open Medal (it starts clipping by itself when clipping is on in its
/// settings). Its window is minimized and the game brought back to the front.
pub fn open_medal(game: u32) -> bool {
    let Some(dir) = medal_dir() else { return false };
    // Medal.exe in its folder is the launcher that starts the current version.
    if Command::new(dir.join("Medal.exe")).current_dir(&dir).creation_flags(NO_WINDOW).spawn().is_err() {
        return false;
    }
    // Medal's window can take a while to appear and takes focus when it does.
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        thread::sleep(Duration::from_millis(500));
        if minimize_windows_of(App::Medal) {
            thread::sleep(Duration::from_millis(300));
            focus(game);
            break;
        }
    }
    focus(game);
    true
}

/// Close every Medal process. False if any are still running.
pub fn close_medal() -> bool {
    let pids = measure::app_pids().remove(&App::Medal).unwrap_or_default();
    for pid in pids {
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).creation_flags(NO_WINDOW).output();
    }
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until && medal_running() {
        thread::sleep(Duration::from_millis(300));
    }
    !medal_running()
}

/// Visible top-level windows of a process.
fn windows_of(pids: &[u32]) -> Vec<HWND> {
    struct Find<'a> {
        pids: &'a [u32],
        out: Vec<HWND>,
    }
    unsafe extern "system" fn each(hwnd: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Find) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if f.pids.contains(&pid) && unsafe { IsWindowVisible(hwnd) }.as_bool() {
            f.out.push(hwnd);
        }
        BOOL(1)
    }
    let mut f = Find { pids, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut f as *mut Find as isize));
    }
    f.out
}

/// Minimize an app's windows. True if it had any.
fn minimize_windows_of(app: App) -> bool {
    let pids = measure::app_pids().remove(&app).unwrap_or_default();
    let wins = windows_of(&pids);
    for &w in &wins {
        unsafe {
            if !IsIconic(w).as_bool() {
                let _ = ShowWindow(w, SW_MINIMIZE);
            }
        }
    }
    !wins.is_empty()
}

/// Bring the game back to the front if something took it.
pub fn focus(game: u32) {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
        if pid == game {
            return;
        }
        let Some(&w) = windows_of(&[game]).first() else { return };
        if IsIconic(w).as_bool() {
            let _ = ShowWindow(w, SW_RESTORE);
        }
        // Windows only lets the app that last had input change the front
        // window; a tap of Alt counts as that.
        press(&[VK_ALT]);
        let _ = SetForegroundWindow(w);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_shortcuts() {
        assert_eq!(shortcut_name(&[VK_ALT, VK_SHIFT, VK_F10]), "Alt+Shift+F10");
        assert_eq!(shortcut_name(&[VK_CONTROL, 0x5A]), "Ctrl+Z");
    }

    /// Reads this PC's NVIDIA shortcut (settings only, presses nothing).
    #[test]
    #[ignore]
    fn live_nvidia_shortcut() {
        let k = nvidia_shortcut();
        println!("{k:?} = {}", shortcut_name(&k));
    }
}
