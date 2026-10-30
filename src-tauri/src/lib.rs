mod audio;
mod control;
mod engine;
mod ffmpeg;
mod games;
mod library;
mod monitors;
mod settings;
mod updater;

use settings::Settings;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct AppState {
    pub(crate) settings: Arc<Mutex<Settings>>,
    settings_path: PathBuf,
    pub(crate) engine: engine::Engine,
    thumbs_dir: PathBuf,
    flyout_hidden_at: Mutex<Instant>,
}

fn settings_of(app: &AppHandle) -> Settings {
    app.state::<AppState>().settings.lock().unwrap().clone()
}

/// Clips folder/<Game or Desktop>/<Game or Desktop> <label><timestamp>.mkv
fn output_path(s: &Settings, label: &str) -> PathBuf {
    let folder = games::clip_folder();
    let ts = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let dir = PathBuf::from(&s.clips_dir).join(&folder);
    let mut p = dir.join(format!("{folder} {label}{ts}.mkv"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{folder} {label}{ts} ({n}).mkv"));
        n += 1;
    }
    p
}

fn save_now(app: &AppHandle, seconds: Option<u32>) -> Result<String, String> {
    let s = settings_of(app);
    let out = output_path(&s, "");
    app.state::<AppState>()
        .engine
        .save_clip(seconds.unwrap_or(s.buffer_seconds), &out)?;
    let path = out.to_string_lossy().into_owned();
    let _ = app.emit("clip-saved", &path);
    Ok(path)
}

/// Start or stop a recording. Returns the saved file when stopping.
fn toggle_record_now(app: &AppHandle) -> Result<Option<String>, String> {
    let st = app.state::<AppState>();
    if st.engine.is_recording() {
        let files = st.engine.stop_recording()?;
        for f in &files {
            let _ = app.emit("clip-saved", f);
        }
        let _ = app.emit("recording-changed", false);
        Ok(files.into_iter().next())
    } else {
        let out = output_path(&settings_of(app), "Recording ");
        st.engine.start_recording(&out)?;
        let _ = app.emit("recording-changed", true);
        Ok(None)
    }
}

fn in_background(app: &AppHandle, job: fn(&AppHandle) -> Result<(), String>) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(e) = job(&app) {
            let _ = app.emit("clip-error", e);
        }
    });
}

/// Register both hotkeys; on failure the previous ones are restored.
fn apply_hotkeys(app: &AppHandle, save: &str, record: &str) -> Result<(), String> {
    if Shortcut::from_str(save).ok() == Shortcut::from_str(record).ok() {
        return Err("The clip and record hotkeys can't be the same.".into());
    }
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(save).map_err(|e| format!("Couldn't use hotkey \"{save}\": {e}"))?;
    gs.register(record).map_err(|e| format!("Couldn't use hotkey \"{record}\": {e}"))?;
    Ok(())
}

/// The app icon, with a red "live" dot in the corner while capturing (like OBS).
fn tray_icon(base: &tauri::image::Image<'_>, live: bool) -> tauri::image::Image<'static> {
    let (w, h) = (base.width(), base.height());
    let mut px = base.rgba().to_vec();
    if live {
        let size = w.min(h) as f32;
        let r = size * 0.16; // dot radius
        let ring = size * 0.05; // dark outline so it reads on any taskbar
        let (cx, cy) = (w as f32 - r - ring, h as f32 - r - ring);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let color = if d <= r {
                    Some([0xFF, 0x3B, 0x30])
                } else if d <= r + ring {
                    Some([0x0E, 0x10, 0x14])
                } else {
                    None
                };
                if let Some([cr, cg, cb]) = color {
                    // Soft 1px edge
                    let edge = (r + ring - d).clamp(0.0, 1.0);
                    let i = ((y * w + x) * 4) as usize;
                    let a = edge;
                    px[i] = (cr as f32 * a + px[i] as f32 * (1.0 - a)) as u8;
                    px[i + 1] = (cg as f32 * a + px[i + 1] as f32 * (1.0 - a)) as u8;
                    px[i + 2] = (cb as f32 * a + px[i + 2] as f32 * (1.0 - a)) as u8;
                    px[i + 3] = (255.0 * a + px[i + 3] as f32 * (1.0 - a)) as u8;
                }
            }
        }
    }
    tauri::image::Image::new_owned(px, w, h)
}

fn apply_autostart(app: &AppHandle, on: bool) {
    let a = app.autolaunch();
    let _ = if on { a.enable() } else { a.disable() };
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_flyout(app: &AppHandle, at: PhysicalPosition<f64>) {
    let Some(w) = app.get_webview_window("flyout") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    // A click on the tray icon blurs (and hides) the flyout first; don't reopen it.
    if app.state::<AppState>().flyout_hidden_at.lock().unwrap().elapsed() < Duration::from_millis(300) {
        return;
    }
    let size = w.outer_size().unwrap_or_default();
    let (w_, h_) = (size.width as f64, size.height as f64);
    let x = (at.x - w_ + 24.0).max(0.0);
    let y = if at.y > h_ { at.y - h_ - 16.0 } else { at.y + 16.0 };
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.show();
    let _ = w.set_focus();
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------- commands ----------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    settings_of(&app)
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let settings = settings.sanitized();
    let st = app.state::<AppState>();
    let old = st.settings.lock().unwrap().clone();
    if old.hotkey != settings.hotkey || old.record_hotkey != settings.record_hotkey {
        if let Err(e) = apply_hotkeys(&app, &settings.hotkey, &settings.record_hotkey) {
            let _ = apply_hotkeys(&app, &old.hotkey, &old.record_hotkey);
            return Err(e);
        }
    }
    if old.clips_dir != settings.clips_dir {
        std::fs::create_dir_all(&settings.clips_dir)
            .map_err(|e| format!("Can't use that clips folder: {e}"))?;
    }
    settings::save(&st.settings_path, &settings)?;
    *st.settings.lock().unwrap() = settings.clone();
    if old.launch_on_startup != settings.launch_on_startup {
        apply_autostart(&app, settings.launch_on_startup);
    }
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}

#[tauri::command]
fn get_status(app: AppHandle) -> engine::Status {
    app.state::<AppState>().engine.status()
}

#[tauri::command]
fn restart_capture(app: AppHandle) {
    app.state::<AppState>().engine.restart();
}

#[tauri::command]
fn list_monitors() -> Vec<monitors::Monitor> {
    monitors::list()
}

#[tauri::command]
fn list_audio_inputs() -> Vec<String> {
    audio::input_devices()
}

#[tauri::command]
async fn save_clip(app: AppHandle, seconds: Option<u32>) -> Result<String, String> {
    blocking(move || save_now(&app, seconds)).await
}

#[tauri::command]
async fn toggle_recording(app: AppHandle) -> Result<Option<String>, String> {
    blocking(move || toggle_record_now(&app)).await
}

#[tauri::command]
async fn list_clips(app: AppHandle) -> Result<Vec<library::ClipFile>, String> {
    let s = settings_of(&app);
    blocking(move || Ok(library::scan(PathBuf::from(&s.clips_dir).as_path(), &s.external_files))).await
}

#[tauri::command]
async fn probe_file(path: String) -> Result<library::Probe, String> {
    blocking(move || library::probe(&path)).await
}

#[tauri::command]
async fn thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let dir = app.state::<AppState>().thumbs_dir.clone();
    blocking(move || library::thumbnail(&path, &dir)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewAudio {
    first_title: String,
    extra: Vec<library::PreviewTrack>,
}

/// Audio tracks Studio has to play next to the video (the video plays track 1 itself).
#[tauri::command]
async fn preview_audio(app: AppHandle, path: String) -> Result<PreviewAudio, String> {
    let cache = app.state::<AppState>().thumbs_dir.with_file_name("preview");
    blocking(move || {
        Ok(PreviewAudio { first_title: library::first_track_title(&path), extra: library::preview_tracks(&path, &cache)? })
    })
    .await
}

#[tauri::command]
async fn remux_mp4(app: AppHandle, path: String) -> Result<String, String> {
    let keep = settings_of(&app).keep_original_after_remux;
    blocking(move || library::remux_mp4(&path, keep)).await
}

/// Run an edit; if `replace`, swap the checked result in for the original.
async fn edit(
    app: AppHandle,
    path: String,
    replace: bool,
    expected_secs: Option<f64>,
    f: impl FnOnce(&str) -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    let original = path.clone();
    let out = blocking(move || f(&path)).await?;
    if !replace {
        return Ok(out);
    }
    let o = original.clone();
    let final_path = blocking(move || library::replace_original(&o, &out, expected_secs)).await?;
    // Keep an imported file in the list even if its extension changed.
    let mut s = settings_of(&app);
    if let Some(p) = s.external_files.iter_mut().find(|p| **p == original) {
        *p = final_path.clone();
        let _ = set_settings(app, s);
    }
    Ok(final_path)
}

fn duration_of(path: &str) -> Option<f64> {
    library::probe(path).ok().map(|p| p.duration).filter(|d| *d > 0.0)
}

#[tauri::command]
async fn trim_clip(app: AppHandle, path: String, start: f64, end: f64, exact: bool, replace: bool) -> Result<String, String> {
    edit(app, path, replace, Some(end - start), move |p| library::trim(p, start, end, exact)).await
}

#[tauri::command]
async fn export_h264(app: AppHandle, path: String, replace: bool) -> Result<String, String> {
    let secs = duration_of(&path);
    edit(app, path, replace, secs, library::export_h264).await
}

#[tauri::command]
async fn compress_clip(app: AppHandle, path: String, target_mb: u32, replace: bool) -> Result<String, String> {
    let secs = duration_of(&path);
    edit(app, path, replace, secs, move |p| library::compress(p, target_mb)).await
}

/// Open Explorer with the file selected (or the folder itself, for a folder).
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("That file isn't there anymore.".into());
    }
    let mut cmd = std::process::Command::new("explorer");
    // Explorer wants exactly: /select,"C:\path with spaces\file.mkv"
    // (Rust's normal quoting wraps the whole thing, which Explorer ignores.)
    if p.is_dir() {
        cmd.raw_arg(format!("\"{path}\""));
    } else {
        cmd.raw_arg(format!("/select,\"{path}\""));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Move clips to the Recycle Bin. Imported files stay listed so Undo brings them back.
#[tauri::command]
async fn delete_clips(app: AppHandle, paths: Vec<String>) -> Result<library::DeleteResult, String> {
    let s = settings_of(&app);
    let res = blocking(move || {
        Ok(library::delete_clips(&paths, PathBuf::from(&s.clips_dir).as_path(), &s.external_files))
    })
    .await?;
    let _ = app.emit("clips-changed", ());
    Ok(res)
}

#[tauri::command]
async fn restore_clips(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let n = blocking(move || library::restore_clips(&paths)).await?;
    let _ = app.emit("clips-changed", ());
    Ok(n)
}

#[tauri::command]
fn add_external_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let mut s = settings_of(&app);
    for p in paths {
        if !s.external_files.contains(&p) {
            s.external_files.push(p);
        }
    }
    set_settings(app, s)
}

#[tauri::command]
fn remove_external_file(app: AppHandle, path: String) -> Result<(), String> {
    let mut s = settings_of(&app);
    s.external_files.retain(|p| p != &path);
    set_settings(app, s)
}

#[tauri::command]
fn open_in_studio(app: AppHandle, path: String) {
    show_main(&app);
    let _ = app.emit_to("main", "open-in-studio", path);
    if let Some(f) = app.get_webview_window("flyout") {
        let _ = f.hide();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn get_update_state(app: AppHandle) -> updater::UpdateState {
    updater::state(&app)
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    let auto = settings_of(&app).auto_update;
    updater::check(&app, auto).await
}

/// Download (if needed) and install now. Rewind restarts on the new version.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if !updater::has_ready_update(&app) {
        updater::check(&app, true).await?;
    }
    updater::install(&app)
}

#[tauri::command]
fn hide_flyout(app: AppHandle) {
    if let Some(f) = app.get_webview_window("flyout") {
        let _ = f.hide();
    }
}

#[cfg(test)]
mod tests {
    /// Renders the tray icon with its live dot so it can be looked at.
    /// Input/output: raw 64x64 RGBA in %TEMP%.
    #[test]
    #[ignore]
    fn tray_dot_preview() {
        let dir = std::env::temp_dir();
        let px = std::fs::read(dir.join("rewind_icon.rgba")).unwrap();
        let base = tauri::image::Image::new_owned(px, 64, 64);
        let live = super::tray_icon(&base, true);
        std::fs::write(dir.join("rewind_icon_live.rgba"), live.rgba()).unwrap();
        let idle = super::tray_icon(&base, false);
        assert_eq!(idle.rgba(), base.rgba(), "no dot when idle");
    }
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // `Rewind.exe --save-clip` etc. control the running copy; a plain launch shows it.
            if !control::handle_args(app, &args) {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let s = settings_of(app);
                    if Shortcut::from_str(&s.record_hotkey).ok().as_ref() == Some(shortcut) {
                        in_background(app, |a| toggle_record_now(a).map(|_| ()));
                    } else {
                        in_background(app, |a| save_now(a, None).map(|_| ()));
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            ffmpeg::init(app.path().resource_dir().ok());

            let cfg_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&cfg_dir)?;
            let settings_path = cfg_dir.join("settings.json");
            let mut s = settings::load(&settings_path);
            if s.clips_dir.is_empty() {
                let videos = app.path().video_dir().unwrap_or_else(|_| cfg_dir.clone());
                s.clips_dir = videos.join("Rewind").to_string_lossy().into_owned();
            }
            let _ = std::fs::create_dir_all(&s.clips_dir);
            let _ = settings::save(&settings_path, &s);

            let local = app.path().app_local_data_dir()?;
            // Preview audio is cheap to rebuild; start each session clean.
            let _ = std::fs::remove_dir_all(local.join("preview"));
            let scratch_dir = local.join("scratch");
            let _ = std::fs::create_dir_all(&scratch_dir);
            let shared = Arc::new(Mutex::new(s.clone()));
            let engine = engine::Engine::start(shared.clone(), local.join("buffer"));
            app.manage(AppState {
                settings: shared,
                settings_path,
                engine,
                thumbs_dir: local.join("thumbs"),
                flyout_hidden_at: Mutex::new(Instant::now() - Duration::from_secs(5)),
            });

            // A recording interrupted by a crash or power cut is rebuilt from its pieces.
            {
                let (h, clips, scratch) = (handle.clone(), PathBuf::from(&s.clips_dir), scratch_dir);
                thread::spawn(move || {
                    for f in engine::recover_recordings(&clips, &scratch) {
                        let _ = h.emit("clip-saved", &f);
                    }
                });
            }

            app.manage(updater::Updates::default());
            updater::start(handle.clone());
            control::start(handle.clone());

            if let Err(e) = apply_hotkeys(&handle, &s.hotkey, &s.record_hotkey) {
                eprintln!("{e}");
            }
            apply_autostart(&handle, s.launch_on_startup);

            // Tray icon: left click opens the flyout, right click shows the menu.
            let save = MenuItem::with_id(app, "save", "Save clip", true, None::<&str>)?;
            let record = MenuItem::with_id(app, "record", "Start / stop recording", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Rewind", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Pause / resume buffer", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Rewind", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&save, &record, &open, &toggle, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Rewind")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "save" => in_background(app, |a| save_now(a, None).map(|_| ())),
                    "record" => in_background(app, |a| toggle_record_now(a).map(|_| ())),
                    "open" => show_main(app),
                    "toggle" => {
                        let mut s = settings_of(app);
                        s.buffer_enabled = !s.buffer_enabled;
                        let _ = set_settings(app.clone(), s);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = e
                    {
                        toggle_flyout(tray.app_handle(), position);
                    }
                })
                .build(app)?;

            // Push engine status to both windows once a second, announce
            // recordings the engine finished on its own (e.g. low disk space),
            // and keep the tray icon's red dot in step with capture.
            let h = handle.clone();
            let base_icon = app.default_window_icon().cloned().expect("app icon").to_owned();
            thread::spawn(move || {
                let mut shown: Option<(bool, bool)> = None;
                loop {
                thread::sleep(Duration::from_secs(1));
                let engine = &h.state::<AppState>().engine;
                let st = engine.status();
                let state = (st.running, st.recording);
                if shown != Some(state) {
                    shown = Some(state);
                    if let Some(tray) = h.tray_by_id("main") {
                        let _ = tray.set_icon(Some(tray_icon(&base_icon, st.running)));
                        let tip = match state {
                            (_, true) => "Rewind · Recording",
                            (true, false) => "Rewind · Replay buffer on",
                            _ => "Rewind · Paused",
                        };
                        let _ = tray.set_tooltip(Some(tip));
                    }
                }
                let (finished, err) = engine.take_finished_recordings();
                for f in finished {
                    let _ = h.emit("clip-saved", &f);
                }
                if let Some(e) = err {
                    let _ = h.emit("clip-error", e);
                    let _ = h.emit("recording-changed", false);
                }
                let _ = h.emit("engine-status", st);
                }
            });

            // Launched by a command (e.g. Stream Deck) while not running: start
            // quietly in the tray. There's nothing buffered yet to save.
            let by_command = std::env::args().any(|a| a.starts_with("--") && a != "--minimized");
            let minimized = by_command || (std::env::args().any(|a| a == "--minimized") && s.start_minimized);
            if !minimized {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                // Closing the window keeps Rewind running in the tray.
                api.prevent_close();
                let _ = window.emit("main-hidden", ());
                let _ = window.hide();
            }
            ("main", WindowEvent::Resized(_)) => {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.emit("main-hidden", ());
                }
            }
            ("flyout", WindowEvent::Focused(false)) => {
                let _ = window.hide();
                *window.app_handle().state::<AppState>().flyout_hidden_at.lock().unwrap() = Instant::now();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            get_status,
            restart_capture,
            list_monitors,
            list_audio_inputs,
            save_clip,
            toggle_recording,
            list_clips,
            probe_file,
            thumbnail,
            preview_audio,
            remux_mp4,
            trim_clip,
            export_h264,
            compress_clip,
            reveal_file,
            delete_clips,
            restore_clips,
            add_external_files,
            remove_external_file,
            open_in_studio,
            show_main_window,
            hide_flyout,
            get_update_state,
            check_for_updates,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Rewind")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // A downloaded update installs on quit (after the engine stops).
                if settings_of(app).auto_update && updater::has_ready_update(app) {
                    let _ = updater::install(app);
                }
                // Finishes an active recording before quitting.
                app.state::<AppState>().engine.shutdown();
            }
        });
}
