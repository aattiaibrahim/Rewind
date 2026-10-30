//! Local control API for Stream Deck and other tools.
//!
//! Listens on 127.0.0.1 only (never the network) at CONTROL_PORT.
//!   GET  /status                       → JSON with buffer / recording / quality state
//!   POST /save?seconds=30              → save a clip (seconds optional: full buffer)
//!   POST /record/toggle                → start or stop recording
//!   POST /buffer/toggle                → pause / resume the replay buffer
//!   POST /quality?height=1080&cq=22    → change clip resolution and/or quality
//!
//! Every request must carry the header `X-Rewind: 1`. Browsers can't add a
//! custom header to a cross-site request without a CORS preflight, and the
//! preflight is only approved for local pages (Stream Deck's plugin runs from
//! a local file), so a website can't trigger Rewind behind your back.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const CONTROL_PORT: u16 = 52371;

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", CONTROL_PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[rewind] control API unavailable on port {CONTROL_PORT}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || {
                let _ = handle(stream, &app);
            });
        }
    });
}

/// Origins allowed to call us from a browser engine: local files (Stream Deck
/// plugins) and no origin at all (curl, scripts, other native apps).
fn allowed_origin(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => o == "null" || o.starts_with("file://"),
    }
}

fn handle(mut stream: TcpStream, app: &AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let origin = headers.get("origin").map(String::as_str);
    if !allowed_origin(origin) {
        return respond(&mut stream, 403, origin, r#"{"error":"forbidden origin"}"#);
    }
    if method == "OPTIONS" {
        return respond(&mut stream, 204, origin, "");
    }
    if headers.get("x-rewind").map(String::as_str) != Some("1") {
        return respond(&mut stream, 403, origin, r#"{"error":"missing X-Rewind header"}"#);
    }

    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let q: HashMap<&str, &str> = query.split('&').filter_map(|kv| kv.split_once('=')).collect();
    let (code, body) = match (method.as_str(), path) {
        ("GET", "/status") => (200, status_json(app)),
        ("POST", "/save") => {
            let secs = q.get("seconds").and_then(|s| s.parse::<u32>().ok()).filter(|s| *s > 0);
            match crate::save_now(app, secs) {
                Ok(p) => (200, serde_json::json!({ "ok": true, "path": p }).to_string()),
                Err(e) => (409, serde_json::json!({ "ok": false, "error": e }).to_string()),
            }
        }
        ("POST", "/record/toggle") => match crate::toggle_record_now(app) {
            Ok(saved) => (200, serde_json::json!({ "ok": true, "saved": saved }).to_string()),
            Err(e) => (409, serde_json::json!({ "ok": false, "error": e }).to_string()),
        },
        ("POST", "/buffer/toggle") => {
            let mut s = crate::settings_of(app);
            s.buffer_enabled = !s.buffer_enabled;
            match crate::set_settings(app.clone(), s) {
                Ok(()) => (200, status_json(app)),
                Err(e) => (409, serde_json::json!({ "ok": false, "error": e }).to_string()),
            }
        }
        ("POST", "/quality") => {
            let mut s = crate::settings_of(app);
            if let Some(h) = q.get("height").and_then(|v| v.parse().ok()) {
                s.output_height = h;
            }
            if let Some(cq) = q.get("cq").and_then(|v| v.parse().ok()) {
                s.quality = cq;
            }
            match crate::set_settings(app.clone(), s) {
                Ok(()) => (200, status_json(app)),
                Err(e) => (409, serde_json::json!({ "ok": false, "error": e }).to_string()),
            }
        }
        _ => (404, r#"{"error":"unknown endpoint"}"#.to_string()),
    };
    if method == "POST" && code == 200 {
        let _ = app.emit("control-action", path);
    }
    respond(&mut stream, code, origin, &body)
}

fn status_json(app: &AppHandle) -> String {
    let st = app.state::<crate::AppState>().engine.status();
    let s = crate::settings_of(app);
    serde_json::json!({
        "running": st.running,
        "bufferOn": st.running && st.enabled,
        "recording": st.recording,
        "recordingSeconds": st.recording_seconds,
        "bufferedSeconds": st.buffered_seconds,
        "bufferSeconds": st.buffer_seconds,
        "width": st.width,
        "height": st.height,
        "outputHeight": s.output_height,
        "quality": s.quality,
        "encoder": s.encoder,
        "fps": s.fps,
        "game": st.game,
    })
    .to_string()
}

fn respond(stream: &mut TcpStream, code: u16, origin: Option<&str>, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Conflict",
    };
    let cors = match origin {
        Some(o) if allowed_origin(Some(o)) => format!(
            "Access-Control-Allow-Origin: {o}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: X-Rewind\r\nAccess-Control-Allow-Private-Network: true\r\n"
        ),
        _ => String::new(),
    };
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors}Connection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

/// `Rewind.exe --save-clip [seconds]`, `--toggle-record`, `--toggle-buffer`:
/// works from Stream Deck's "Open" action, AutoHotkey, Task Scheduler, etc.
pub fn handle_args(app: &AppHandle, args: &[String]) -> bool {
    let mut it = args.iter().skip_while(|a| !a.starts_with("--"));
    let Some(cmd) = it.next() else { return false };
    let app = app.clone();
    match cmd.as_str() {
        "--save-clip" => {
            let secs = it.next().and_then(|s| s.parse::<u32>().ok());
            thread::spawn(move || {
                if let Err(e) = crate::save_now(&app, secs) {
                    let _ = app.emit("clip-error", e);
                }
            });
        }
        "--toggle-record" => {
            thread::spawn(move || {
                if let Err(e) = crate::toggle_record_now(&app) {
                    let _ = app.emit("clip-error", e);
                }
            });
        }
        "--toggle-buffer" => {
            let mut s = crate::settings_of(&app);
            s.buffer_enabled = !s.buffer_enabled;
            let _ = crate::set_settings(app, s);
        }
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::allowed_origin;

    #[test]
    fn only_local_origins_are_allowed() {
        assert!(allowed_origin(None));
        assert!(allowed_origin(Some("null")));
        assert!(allowed_origin(Some("file://")));
        assert!(!allowed_origin(Some("https://evil.example")));
        assert!(!allowed_origin(Some("http://localhost:3000")));
    }
}
