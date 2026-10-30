//! Monitor list (in the same order ffmpeg's ddagrab uses) and the foreground app.

use serde::Serialize;
use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, POINT};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId,
};
use windows::core::PWSTR;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// DXGI output index on the first GPU (what ddagrab's output_idx expects)
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

impl Monitor {
    pub fn label(&self) -> String {
        let short = self.name.trim_start_matches(r"\\.\").replace("DISPLAY", "Display ");
        format!("{short} · {}×{}", self.width, self.height)
    }
}

pub fn list() -> Vec<Monitor> {
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return out;
        };
        let Ok(adapter) = factory.EnumAdapters1(0) else {
            return out;
        };
        let mut i = 0;
        while let Ok(output) = adapter.EnumOutputs(i) {
            if let Ok(d) = output.GetDesc() {
                let r = d.DesktopCoordinates;
                let name = String::from_utf16_lossy(&d.DeviceName)
                    .trim_end_matches('\0')
                    .to_string();
                out.push(Monitor {
                    index: i,
                    name,
                    x: r.left,
                    y: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                    primary: r.left == 0 && r.top == 0,
                });
            }
            i += 1;
        }
    }
    out
}

fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// Which monitor to capture right now. Falls back to the primary, then to any.
pub fn pick(mode: &str, fixed: &str, mons: &[Monitor]) -> Option<Monitor> {
    let primary = || mons.iter().find(|m| m.primary).or(mons.first()).cloned();
    match mode {
        "cursor" => cursor()
            .and_then(|(x, y)| {
                mons.iter()
                    .find(|m| x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                    .cloned()
            })
            .or_else(primary),
        "fixed" => mons.iter().find(|m| m.name == fixed).cloned().or_else(primary),
        _ => primary(),
    }
}

/// A folder-friendly name for the app in front (e.g. "VALORANT"), or "Desktop".
pub fn foreground_app() -> Option<String> {
    const DESKTOP: &[&str] = &[
        "explorer",
        "rewind",
        "searchhost",
        "shellexperiencehost",
        "startmenuexperiencehost",
        "applicationframehost",
        "lockapp",
    ];
    let path = unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        String::from_utf16_lossy(&buf[..len as usize])
    };
    let stem = Path::new(&path).file_stem()?.to_string_lossy().to_string();
    if DESKTOP.contains(&stem.to_lowercase().as_str()) {
        return Some("Desktop".into());
    }
    let mut name = stem;
    for suffix in ["-Win64-Shipping", "-Win64", "_x64", "64", "-Shipping"] {
        if let Some(s) = name.strip_suffix(suffix) {
            name = s.to_string();
        }
    }
    let clean: String = name
        .chars()
        .filter(|c| !r#"<>:"/\|?*"#.contains(*c))
        .collect();
    if clean.trim().is_empty() { None } else { Some(clean.trim().to_string()) }
}
