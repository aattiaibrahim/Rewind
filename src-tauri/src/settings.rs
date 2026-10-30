use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub clips_dir: String,
    /// "av1" | "hevc" | "h264"
    pub encoder: String,
    /// NVENC constant-quality value (lower = better, bigger files)
    pub quality: u32,
    pub fps: u32,
    pub buffer_seconds: u32,
    /// "primary" | "cursor" | "fixed"
    pub monitor_mode: String,
    /// Device name like \\.\DISPLAY1, used when monitor_mode == "fixed"
    pub fixed_monitor: String,
    pub draw_cursor: bool,
    pub hotkey: String,
    pub buffer_enabled: bool,
    pub launch_on_startup: bool,
    pub start_minimized: bool,
    pub keep_original_after_remux: bool,
    /// Videos opened from outside the clips folder
    pub external_files: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            clips_dir: String::new(),
            encoder: "av1".into(),
            quality: 24,
            fps: 60,
            buffer_seconds: 120,
            monitor_mode: "primary".into(),
            fixed_monitor: String::new(),
            draw_cursor: true,
            hotkey: "Alt+F10".into(),
            buffer_enabled: true,
            launch_on_startup: false,
            start_minimized: true,
            keep_original_after_remux: true,
            external_files: Vec::new(),
        }
    }
}

pub fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
