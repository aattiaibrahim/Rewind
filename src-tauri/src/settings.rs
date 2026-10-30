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
    /// Start / stop a full recording
    pub record_hotkey: String,
    pub buffer_enabled: bool,
    pub launch_on_startup: bool,
    pub start_minimized: bool,
    pub keep_original_after_remux: bool,
    /// Trims / exports replace the file you edited (original goes to the Recycle Bin)
    pub replace_original_on_edit: bool,
    /// Videos opened from outside the clips folder
    pub external_files: Vec<String>,
    pub desktop_audio: bool,
    pub mic_enabled: bool,
    pub mic_mono: bool,
    /// "" = Windows default microphone
    pub mic_device: String,
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
            record_hotkey: "Alt+F9".into(),
            buffer_enabled: true,
            launch_on_startup: false,
            start_minimized: true,
            keep_original_after_remux: true,
            replace_original_on_edit: false,
            external_files: Vec::new(),
            desktop_audio: true,
            mic_enabled: true,
            mic_mono: true,
            mic_device: String::new(),
        }
    }
}

impl Settings {
    /// Pull every value into a range the engine can actually use.
    pub fn sanitized(mut self) -> Settings {
        let d = Settings::default();
        if !["av1", "hevc", "h264"].contains(&self.encoder.as_str()) {
            self.encoder = d.encoder;
        }
        if !["primary", "cursor", "fixed"].contains(&self.monitor_mode.as_str()) {
            self.monitor_mode = d.monitor_mode;
        }
        self.quality = self.quality.clamp(10, 45);
        self.fps = self.fps.clamp(15, 240);
        self.buffer_seconds = self.buffer_seconds.clamp(5, 1800);
        if self.hotkey.trim().is_empty() {
            self.hotkey = d.hotkey;
        }
        if self.record_hotkey.trim().is_empty() {
            self.record_hotkey = d.record_hotkey;
        }
        self.external_files.dedup();
        self
    }
}

/// Missing or broken settings fall back to defaults (a broken file is kept as .bak).
pub fn load(path: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(s) => s.sanitized(),
        Err(_) => {
            let _ = std::fs::copy(path, path.with_extension("json.bak"));
            Settings::default()
        }
    }
}

/// Write to a temp file first so a crash mid-save can't corrupt settings.
pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_clamps_bad_values() {
        let s = Settings { fps: 9999, quality: 0, buffer_seconds: 0, encoder: "xvid".into(), hotkey: " ".into(), ..Default::default() }
            .sanitized();
        assert_eq!((s.fps, s.quality, s.buffer_seconds), (240, 10, 5));
        assert_eq!(s.encoder, "av1");
        assert_eq!(s.hotkey, "Alt+F10");
    }

    #[test]
    fn defaults_have_mic_on_and_mono() {
        let s = Settings::default();
        assert!(s.mic_enabled && s.mic_mono && s.desktop_audio);
    }

    #[test]
    fn broken_file_falls_back_and_is_kept() {
        let dir = std::env::temp_dir().join(format!("rewind-test-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        std::fs::write(&p, "{ not json").unwrap();
        let s = load(&p);
        assert_eq!(s.hotkey, "Alt+F10");
        assert!(p.with_extension("json.bak").exists());
        save(&p, &s).unwrap();
        assert_eq!(load(&p).hotkey, "Alt+F10");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
