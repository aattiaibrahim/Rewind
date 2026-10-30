//! Is the app in front a game, and what's it called?
//!
//! Used to file clips: a detected game gets its own folder, everything else
//! goes to "Desktop". Detection, in order:
//! 1. Never a game: browsers, chat, launchers, editors, video players…
//! 2. A known game exe (e.g. VALORANT-Win64-Shipping → "VALORANT").
//! 3. Installed in a game library (steamapps\common, Epic Games, Riot Games…),
//!    named after its folder there.
//! 4. Fullscreen or borderless-fullscreen, named from its window title.

use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
};
use windows::core::PWSTR;

pub const DESKTOP_FOLDER: &str = "Desktop";

const NOT_GAMES: &[&str] = &[
    "explorer", "rewind", "searchhost", "shellexperiencehost", "startmenuexperiencehost",
    "applicationframehost", "lockapp", "textinputhost", "taskmgr", "systemsettings",
    "chrome", "msedge", "firefox", "opera", "opera_gx", "brave", "vivaldi", "arc", "zen",
    "discord", "discordptb", "discordcanary", "slack", "teams", "ms-teams", "zoom", "telegram", "whatsapp",
    "spotify", "vlc", "mpc-hc64", "mpc-be64", "mpv", "potplayermini64", "wmplayer", "music.ui", "video.ui",
    "steam", "steamwebhelper", "epicgameslauncher", "battle.net", "riotclientservices", "riotclientux",
    "eadesktop", "origin", "upc", "ubisoftconnect", "galaxyclient", "gamingservices", "xboxpcapp",
    "obs64", "medal", "nvidia app", "nvcontainer", "code", "devenv", "notepad", "notepad++",
    "windowsterminal", "powershell", "pwsh", "cmd", "winword", "excel", "powerpnt", "outlook",
    "photoshop", "premiere pro", "afterfx", "resolve", "claude",
];

const KNOWN: &[(&str, &str)] = &[
    ("valorant-win64-shipping", "VALORANT"),
    ("r5apex", "Apex Legends"),
    ("r5apex_dx12", "Apex Legends"),
    ("cs2", "Counter-Strike 2"),
    ("fortniteclient-win64-shipping", "Fortnite"),
    ("league of legends", "League of Legends"),
    ("overwatch", "Overwatch 2"),
    ("rocketleague", "Rocket League"),
    ("minecraft.windows", "Minecraft"),
    ("gta5", "Grand Theft Auto V"),
    ("gta5_enhanced", "Grand Theft Auto V"),
    ("eldenring", "ELDEN RING"),
    ("cod", "Call of Duty"),
    ("destiny2", "Destiny 2"),
    ("dota2", "Dota 2"),
    ("robloxplayerbeta", "Roblox"),
    ("marvel-win64-shipping", "Marvel Rivals"),
    ("rainbowsix", "Rainbow Six Siege"),
    ("tslgame", "PUBG"),
    ("cyberpunk2077", "Cyberpunk 2077"),
    ("witcher3", "The Witcher 3"),
    ("helldivers2", "HELLDIVERS 2"),
    ("discovery", "THE FINALS"),
    ("deadlock", "Deadlock"),
    ("bf2042", "Battlefield 2042"),
    ("rdr2", "Red Dead Redemption 2"),
];

/// Library folders: the game's name is the folder right after the marker.
const LIBRARIES: &[&str] = &[
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\riot games\\",
    "\\xboxgames\\",
    "\\gog galaxy\\games\\",
    "\\ubisoft game launcher\\games\\",
    "\\ea games\\",
    "\\rockstar games\\",
    "\\battle.net\\games\\",
];

/// The pure decision, separate from Win32 so it can be tested.
pub fn classify(exe_path: &str, window_title: &str, fullscreen: bool) -> Option<String> {
    let path = Path::new(exe_path);
    let stem = path.file_stem()?.to_string_lossy().to_lowercase();
    if NOT_GAMES.contains(&stem.as_str()) {
        return None;
    }
    if let Some((_, title)) = KNOWN.iter().find(|(exe, _)| *exe == stem) {
        return Some(title.to_string());
    }
    let lower = exe_path.to_lowercase();
    for marker in LIBRARIES {
        if let Some(i) = lower.find(marker) {
            let rest = &exe_path[i + marker.len()..];
            if let Some(name) = rest.split(['\\', '/']).next().filter(|n| !n.is_empty() && rest.len() > n.len()) {
                // Riot keeps "VALORANT\live\..." etc.: the first folder is the game.
                return Some(name.to_string());
            }
        }
    }
    if fullscreen {
        let t = window_title.trim();
        if !t.is_empty() && t.chars().count() <= 60 {
            return Some(t.to_string());
        }
        return Some(clean_exe_name(&stem));
    }
    None
}

fn clean_exe_name(stem: &str) -> String {
    let mut name = stem.to_string();
    for suffix in ["-win64-shipping", "-win64", "_x64", "-shipping", "_dx12", "_dx11"] {
        if let Some(s) = name.strip_suffix(suffix) {
            name = s.to_string();
        }
    }
    name
}

/// Make a name safe to use as a Windows folder.
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    let reserved = ["con", "prn", "aux", "nul", "com1", "lpt1"];
    if cleaned.is_empty() || reserved.contains(&cleaned.to_lowercase().as_str()) {
        DESKTOP_FOLDER.into()
    } else {
        cleaned.chars().take(60).collect()
    }
}

/// The game in front right now, if any.
pub fn foreground_game() -> Option<String> {
    let (path, title, fullscreen) = foreground_info()?;
    classify(&path, &title, fullscreen)
}

/// Clip folder for right now: the game's name, or "Desktop".
pub fn clip_folder() -> String {
    foreground_game().map(|g| folder_name(&g)).unwrap_or_else(|| DESKTOP_FOLDER.into())
}

fn foreground_info() -> Option<(String, String, bool)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        Some((exe_path(hwnd)?, window_title(hwnd), is_fullscreen(hwnd)))
    }
}

unsafe fn exe_path(hwnd: HWND) -> Option<String> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let r = unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) };
    let _ = unsafe { CloseHandle(h) };
    r.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// Covers its whole monitor (exclusive or borderless fullscreen).
unsafe fn is_fullscreen(hwnd: HWND) -> bool {
    let mut r = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
        return false;
    }
    let mon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(mon, &mut info) }.as_bool() {
        return false;
    }
    let m = info.rcMonitor;
    r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_exe() {
        let p = r"C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe";
        assert_eq!(classify(p, "VALORANT  ", true).as_deref(), Some("VALORANT"));
    }

    #[test]
    fn steam_library_folder() {
        let p = r"D:\SteamLibrary\steamapps\common\Hades II\Ship\Hades2.exe";
        assert_eq!(classify(p, "Hades II", false).as_deref(), Some("Hades II"));
    }

    #[test]
    fn epic_library_folder() {
        let p = r"C:\Program Files\Epic Games\RocketLeague\Binaries\Win64\SomeGame.exe";
        assert_eq!(classify(p, "", false).as_deref(), Some("RocketLeague"));
    }

    #[test]
    fn browsers_and_apps_are_desktop() {
        assert_eq!(classify(r"C:\Program Files\Google\Chrome\Application\chrome.exe", "YouTube", true), None);
        assert_eq!(classify(r"C:\Windows\explorer.exe", "", true), None);
        assert_eq!(classify(r"C:\Users\x\AppData\Local\Discord\app-1.0\Discord.exe", "Discord", false), None);
        assert_eq!(classify(r"C:\Program Files (x86)\Steam\steam.exe", "Steam", true), None);
    }

    #[test]
    fn unknown_windowed_app_is_desktop() {
        assert_eq!(classify(r"C:\Tools\paint.exe", "Untitled - Paint", false), None);
    }

    #[test]
    fn unknown_fullscreen_app_uses_title() {
        assert_eq!(classify(r"C:\Games\Indie\game.exe", "Celeste", true).as_deref(), Some("Celeste"));
    }

    #[test]
    fn folder_names_are_safe() {
        assert_eq!(folder_name("Call of Duty: Black Ops 6"), "Call of Duty Black Ops 6");
        assert_eq!(folder_name("  ...  "), "Desktop");
        assert_eq!(folder_name("CON"), "Desktop");
        assert_eq!(folder_name("Halo?"), "Halo");
    }
}
