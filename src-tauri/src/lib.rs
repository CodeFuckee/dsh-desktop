//! dsh-desktop Tauri application: spawn the dsh web server, discover its
//! readiness URL, navigate the webview there, surface startup failures, and
//! guarantee the server process tree dies with the app.

pub mod server;

use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent};

/// stderr tail kept for the error view (lines).
const STDERR_TAIL_CAP: usize = 200;
/// URL-line timeout before the startup is reported as failed.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Navigation settle: retries while the webview is not ready.
const NAVIGATE_RETRIES: usize = 30;
const NAVIGATE_RETRY_DELAY: Duration = Duration::from_millis(200);

/// Events the server supervisor reports to the app dispatcher.
enum ServerEvent {
    UrlFound(String),
    Stderr(String),
    StdoutEnded,
    StderrEnded,
}

/// Per-app state shared between threads.
pub struct ServerState {
    child: Mutex<Option<std::process::Child>>,
    announced: AtomicBool,
    stderr_tail: Mutex<Vec<String>>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            announced: AtomicBool::new(false),
            stderr_tail: Mutex::new(Vec::new()),
        }
    }
}

impl ServerState {
    fn record_stderr(&self, line: String) {
        let mut tail = self.stderr_tail.lock().expect("stderr tail lock");
        tail.push(line);
        while tail.len() > STDERR_TAIL_CAP {
            tail.remove(0);
        }
    }

    fn stderr_summary(&self) -> String {
        let tail = self.stderr_tail.lock().expect("stderr tail lock");
        tail.join("\n")
    }
}

/// Show the error view in the main window.
fn show_error(app: &AppHandle, summary: &str, detail: &str) {
    let payload = serde_json::json!({ "summary": summary, "detail": detail });
    let code = format!(
        "window.__dshDesktopError && window.__dshDesktopError({})",
        serde_json::to_string(&payload).expect("json payload")
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&code);
    }
}

fn navigate_with_retry(window: &WebviewWindow, url: &str) -> bool {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(err) => {
            eprintln!("dsh-desktop: unparsable readiness URL {url:?}: {err}");
            return false;
        }
    };
    eprintln!("dsh-desktop: navigating to {url}");
    for attempt in 0..NAVIGATE_RETRIES {
        if window.navigate(parsed.clone()).is_ok() {
            eprintln!("dsh-desktop: navigate() accepted on attempt {attempt}");
            return true;
        }
        if attempt + 1 < NAVIGATE_RETRIES {
            thread::sleep(NAVIGATE_RETRY_DELAY);
        }
    }
    false
}

/// Monitor the webview after navigating to the launch-token URL.
///
/// The dsh browser-trust fence serves the GUI only after the browser-token
/// exchange completes (303 + session cookie -> clean `/`). If the webview's
/// first request arrives before the fence is fully mounted, the server
/// answers 401 ("dsh web authentication required") and the URL stays at
/// `/?token=...`. WKWebView/wry keep the cookie from a completed exchange,
/// so re-running the exchange is safe and converges.
///
/// Polls the webview URL (never unwrapping — wry can panic when the webview
/// has no committed URL) and re-navigates while the token query persists.
fn monitor_navigation(app: &AppHandle, token_url: String) {
    let debug = std::env::var_os("DSH_DESKTOP_DEBUG").is_some();
    let app = app.clone();
    thread::spawn(move || {
        for round in 0..12u32 {
            std::thread::sleep(Duration::from_millis(1500));
            let Some(window) = app.get_webview_window("main") else { return };
            let observed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| window.url().ok()))
                .ok()
                .flatten();
            let Some(current) = observed else {
                if debug {
                    eprintln!("dsh-desktop: [debug] round {round}: webview url unavailable");
                }
                continue;
            };
            let current_str = current.to_string();
            if debug {
                eprintln!("dsh-desktop: [debug] round {round} webview url = {current_str}");
            }
            if current_str.contains("token=") {
                // Exchange did not complete; the fence accepts the same
                // launch token again, so re-navigate to re-run it.
                eprintln!("dsh-desktop: auth exchange incomplete, retrying ({round})");
                if window.navigate(current).is_err() {
                    return; // webview is gone
                }
                continue;
            }
            if debug {
                eprintln!("dsh-desktop: [debug] auth exchange complete at `{current_str}`");
            }
            // Clean `/`: the exchange finished; stop watching.
            let _ = token_url;
            return;
        }
    });
}

/// Start `dsh web` and supervise it: parse the readiness URL, forward stderr,
/// and report unexpected exit. Runs in a background thread.
fn start_server(app: AppHandle, paths: server::RuntimePaths) {
    thread::spawn(move || {
        let state = app.state::<ServerState>();
        let mut child = match server::build_spawn_command(&paths.node, &paths.bin_js).spawn() {
            Ok(child) => child,
            Err(err) => {
                show_error(
                    &app,
                    "无法启动 DeepSeek Harness 服务",
                    &format!("spawn 失败：{err}"),
                );
                state.announced.store(true, Ordering::SeqCst);
                return;
            }
        };
        let stdout = child
            .stdout
            .take()
            .expect("dsh stdout piped (build_spawn_command)");
        let stderr = child
            .stderr
            .take()
            .expect("dsh stderr piped (build_spawn_command)");
        {
            let mut slot = state.child.lock().expect("child slot lock");
            *slot = Some(child);
        }

        let (tx, rx): (Sender<ServerEvent>, Receiver<ServerEvent>) = channel();
        let tx_stdout = tx.clone();
        let tx_stderr = tx.clone();

        // stdout reader: extract the "dsh web: <url>" readiness line.
        thread::spawn(move || {
            let mut pending = String::new();
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(url) = server::parse_url_line(&(line + "\n"), &mut pending) {
                    let _ = tx_stdout.send(ServerEvent::UrlFound(url));
                }
            }
            let _ = tx_stdout.send(ServerEvent::StdoutEnded);
        });

        // stderr reader: forward lines for the error view's tail.
        thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let _ = tx_stderr.send(ServerEvent::Stderr(line));
            }
            let _ = tx_stderr.send(ServerEvent::StderrEnded);
        });

        // Dispatcher. All state access stays on this thread — readers only
        // send events. When both pipes reach EOF the process is gone: reap it
        // from the shared slot and, if the server never became ready, surface
        // the failure. While the server runs, this loop idles on recv_timeout.
        let started = std::time::Instant::now();
        let mut url_announced = false;
        let mut stdout_ended = false;
        let mut stderr_ended = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ServerEvent::UrlFound(url)) => {
                    if state.announced.swap(true, Ordering::SeqCst) {
                        continue;
                    }
                    url_announced = true;
                    if let Some(window) = app.get_webview_window("main") {
                        if navigate_with_retry(&window, &url) {
                            monitor_navigation(&app, url.clone());
                            continue;
                        }
                    }
                    show_error(&app, "无法加载 DeepSeek Harness 界面", &url);
                }
                Ok(ServerEvent::Stderr(line)) => state.record_stderr(line),
                Ok(ServerEvent::StdoutEnded) => stdout_ended = true,
                Ok(ServerEvent::StderrEnded) => stderr_ended = true,
                Err(_) => {} // recv timeout, or every sender dropped
            }

            if stdout_ended && stderr_ended {
                let code = state
                    .child
                    .lock()
                    .expect("child slot lock")
                    .as_mut()
                    .and_then(|child| child.wait().ok())
                    .and_then(|status| status.code());
                if !state.announced.swap(true, Ordering::SeqCst) && !url_announced {
                    let mut detail = String::new();
                    if let Some(code) = code {
                        detail.push_str(&format!("进程退出码：{code}\n"));
                    }
                    let tail = state.stderr_summary();
                    if !tail.is_empty() {
                        detail.push_str("--- 服务输出（末尾） ---\n");
                        detail.push_str(&tail);
                    }
                    show_error(&app, "DeepSeek Harness 服务意外退出", &detail);
                }
                break;
            }

            // Startup hard timeout: the readiness line must arrive quickly.
            if !url_announced && started.elapsed() > STARTUP_TIMEOUT {
                if !state.announced.swap(true, Ordering::SeqCst) {
                    show_error(
                        &app,
                        "启动超时：未收到服务就绪信息",
                        &state.stderr_summary(),
                    );
                }
                break;
            }
        }
    });
}

/// Best-effort shutdown of the server tree, idempotent.
fn shutdown_server(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let mut slot = state.child.lock().expect("child slot lock");
    if let Some(mut child) = slot.take() {
        eprintln!("dsh-desktop: terminating dsh web (pid {})", child.id());
        server::terminate(&mut child, Duration::from_secs(3));
    }
}

#[tauri::command]
fn close_app(app: AppHandle) {
    app.exit(0);
}

/// Tauri entry point.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![close_app])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap_or_default();
            let env_override = std::env::var_os("DSH_DESKTOP_RUNTIME");
            let dev_fallback = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime");
            match server::resolve_runtime(
                &resource_dir,
                env_override.as_deref(),
                Some(&dev_fallback),
            ) {
                Ok(paths) => {
                    eprintln!(
                        "dsh-desktop: runtime resolved (node={}, dsh={})",
                        paths.node.display(),
                        paths.bin_js.display()
                    );
                    start_server(app.handle().clone(), paths);
                }
                Err(message) => {
                    show_error(app.handle(), "无法定位 dsh 运行时", &message);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                shutdown_server(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                shutdown_server(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_tail_is_capped() {
        let state = ServerState::default();
        for i in 0..(STDERR_TAIL_CAP + 50) {
            state.record_stderr(format!("line {i}"));
        }
        let summary = state.stderr_summary();
        let lines: Vec<&str> = summary.lines().collect();
        assert_eq!(lines.len(), STDERR_TAIL_CAP);
        // newest lines survive, oldest are dropped
        assert_eq!(lines.first().unwrap(), &"line 50");
        assert_eq!(lines.last().unwrap(), &"line 249");
    }

    #[test]
    fn stderr_tail_is_empty_initially() {
        let state = ServerState::default();
        assert_eq!(state.stderr_summary(), "");
    }
}