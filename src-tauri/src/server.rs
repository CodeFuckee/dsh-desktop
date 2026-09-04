//! dsh server subprocess management: runtime resolution, spawning, stdout
//! URL-line parsing, and process-tree termination.
//!
//! The packaged app never serves the harness frontend itself — it spawns the
//! real `dsh web` server (the only host that injects `window.__DSH_BOOT__`)
//! and points the webview at the readiness URL this module extracts.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The readiness line prefix `dsh web` prints once the server listens
/// (the web runtime's `printUrl` default): `dsh web: <url>`.
pub const DSH_URL_LINE_PREFIX: &str = "dsh web: ";

/// Node executable name on this platform.
pub const NODE_EXE: &str = {
    #[cfg(windows)]
    {
        "node.exe"
    }
    #[cfg(not(windows))]
    {
        "node"
    }
};

/// Relative path of the dsh CLI entry inside the runtime app prefix.
pub const DSH_BIN_REL: &str = "app/node_modules/@deepseek-ai/dsh/lib/bin.js";

/// Incremental stdout line parser.
///
/// Feed it arbitrary chunks; it returns the first URL found on a line starting
/// with [`DSH_URL_LINE_PREFIX`]. Unmatched lines and partial line fragments are
/// accumulated in `pending` (which the caller owns and reuses across calls).
/// `\r\n` line endings and a trailing `(LAN: ...)` suffix are tolerated.
pub fn parse_url_line(chunk: &str, pending: &mut String) -> Option<String> {
    pending.push_str(chunk);
    loop {
        let newline = pending.find('\n')?;
        let line = pending[..newline].trim_end_matches('\r').trim().to_string();
        pending.drain(..=newline);
        if let Some(rest) = line.strip_prefix(DSH_URL_LINE_PREFIX) {
            let url = rest.split_whitespace().next()?.to_string();
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
}

/// Resolved runtime layout: the node executable and the dsh CLI entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub node: PathBuf,
    pub bin_js: PathBuf,
}

/// Resolve the runtime tree. Candidate roots, in order:
///
/// 1. `env_override` — `DSH_DESKTOP_RUNTIME` (dev runs, tests)
/// 2. `<resource_dir>/runtime` — the packaged `bundle.resources` target
/// 3. `dev_fallback` — `<CARGO_MANIFEST_DIR>/runtime` (dev runs of `tauri dev`)
///
/// Returns a message describing exactly which piece is missing on failure.
pub fn resolve_runtime(
    resource_dir: &Path,
    env_override: Option<&OsStr>,
    dev_fallback: Option<&Path>,
) -> Result<RuntimePaths, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(env) = env_override {
        candidates.push(PathBuf::from(env));
    }
    candidates.push(resource_dir.join("runtime"));
    if let Some(fallback) = dev_fallback {
        candidates.push(fallback.to_path_buf());
    }

    let mut last_missing = String::new();
    for root in candidates {
        match runtime_at(&root) {
            Ok(paths) => return Ok(paths),
            Err(missing) => {
                last_missing = format!("{}: {}", root.display(), missing);
            }
        }
    }
    Err(format!(
        "no usable dsh runtime found ({}). Run `npm run prepare:runtime` first.",
        last_missing
    ))
}

fn runtime_at(root: &Path) -> Result<RuntimePaths, String> {
    let node = root.join(NODE_EXE);
    if !node.is_file() {
        return Err(format!("node executable \"{}\" is missing", NODE_EXE));
    }
    let bin_js = root.join(DSH_BIN_REL);
    if !bin_js.is_file() {
        return Err(format!("dsh entry is missing (\"{}\")", DSH_BIN_REL));
    }
    Ok(RuntimePaths { node, bin_js })
}

/// The spawn command used to boot the local dsh web server.
///
/// `--no-open` keeps the OS default browser closed (the webview is the
/// surface); `--port 0` lets the OS assign a free port, sidestepping
/// conflicts; on Unix the child gets its own process group so termination can
/// reach the whole tree.
pub fn build_spawn_command(node: &Path, bin_js: &Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg(bin_js)
        .args(["web", "--no-open", "--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Best-effort termination of the dsh process tree.
///
/// Unix: `SIGTERM` to the child's process group, wait up to `grace`, then
/// `SIGKILL` the group. Windows: `taskkill /T /F` (tree kill).
pub fn terminate(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let group = -pid;
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        let deadline = Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/pid", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (child, grace);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ---- parse_url_line ---------------------------------------------------

    #[test]
    fn parses_simple_readiness_line() {
        let mut pending = String::new();
        let url = parse_url_line("dsh web: http://127.0.0.1:3080/\n", &mut pending);
        assert_eq!(url.as_deref(), Some("http://127.0.0.1:3080/"));
    }

    #[test]
    fn parses_line_with_lan_suffix() {
        let mut pending = String::new();
        let url = parse_url_line(
            "dsh web: http://127.0.0.1:53421/?token=abc (LAN: http://192.168.1.5:53421)\n",
            &mut pending,
        );
        assert_eq!(url.as_deref(), Some("http://127.0.0.1:53421/?token=abc"));
    }

    #[test]
    fn parses_windows_crlf_line() {
        let mut pending = String::new();
        let url = parse_url_line("dsh web: http://127.0.0.1:3080/\r\n", &mut pending);
        assert_eq!(url.as_deref(), Some("http://127.0.0.1:3080/"));
    }

    #[test]
    fn ignores_unrelated_lines_before_the_url() {
        let mut pending = String::new();
        assert!(parse_url_line("some log line\n", &mut pending).is_none());
        assert!(parse_url_line("[info] another line\n", &mut pending).is_none());
        let url = parse_url_line("dsh web: http://127.0.0.1:9/\n", &mut pending);
        assert_eq!(url.as_deref(), Some("http://127.0.0.1:9/"));
    }

    #[test]
    fn waits_for_complete_lines_across_chunks() {
        let mut pending = String::new();
        assert!(parse_url_line("dsh web: http://127.0.0.", &mut pending).is_none());
        assert!(parse_url_line("1:3080/", &mut pending).is_none());
        let url = parse_url_line("\n", &mut pending);
        assert_eq!(url.as_deref(), Some("http://127.0.0.1:3080/"));
    }

    #[test]
    fn empty_url_after_prefix_is_not_a_match() {
        let mut pending = String::new();
        assert!(parse_url_line("dsh web: \n", &mut pending).is_none());
    }

    #[test]
    fn does_not_match_other_lines_containing_the_prefix() {
        let mut pending = String::new();
        assert!(parse_url_line("not dsh web: http://x/\n", &mut pending).is_none());
    }

    #[test]
    fn handles_multiple_lines_in_one_chunk() {
        let mut pending = String::new();
        // first call returns the first match, second line stays unread
        let url = parse_url_line("line a\ndsh web: http://a/\ndsh web: http://b/\n", &mut pending);
        assert_eq!(url.as_deref(), Some("http://a/"));
        // the remainder (dsh web: http://b/) is still pending
        assert!(pending.contains("http://b/"));
    }

    #[test]
    fn empty_chunk_is_a_noop() {
        let mut pending = String::from("x");
        assert!(parse_url_line("", &mut pending).is_none());
        assert_eq!(pending, "x");
    }

    // ---- resolve_runtime --------------------------------------------------

    fn write_file(dir: &Path, rel: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn resolves_a_valid_runtime_tree() {
        let dir = tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        write_file(&runtime, NODE_EXE);
        write_file(&runtime, DSH_BIN_REL);
        let paths = resolve_runtime(dir.path(), None, None).unwrap();
        assert_eq!(paths.node, runtime.join(NODE_EXE));
        assert_eq!(paths.bin_js, runtime.join(DSH_BIN_REL));
    }

    #[test]
    fn resolves_from_packaged_runtime_subdir() {
        let dir = tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        write_file(&runtime, NODE_EXE);
        write_file(&runtime, DSH_BIN_REL);
        let paths = resolve_runtime(dir.path(), None, None).unwrap();
        assert_eq!(paths.node, runtime.join(NODE_EXE));
    }

    #[test]
    fn env_override_wins_over_resource_dir() {
        let dir = tempdir().unwrap();
        // both candidates valid; env override must win
        write_file(dir.path(), NODE_EXE);
        write_file(dir.path(), DSH_BIN_REL);
        let alt = tempdir().unwrap();
        write_file(alt.path(), NODE_EXE);
        write_file(alt.path(), DSH_BIN_REL);
        let paths = resolve_runtime(dir.path(), Some(alt.path().as_os_str()), None).unwrap();
        assert_eq!(paths.node, alt.path().join(NODE_EXE));
    }

    #[test]
    fn empty_dir_reports_the_missing_piece() {
        let dir = tempdir().unwrap();
        let err = resolve_runtime(dir.path(), None, None).unwrap_err();
        assert!(err.contains("node executable"), "err: {err}");
    }

    #[test]
    fn missing_bin_reports_dsh_entry() {
        let dir = tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        write_file(&runtime, NODE_EXE);
        let err = resolve_runtime(dir.path(), None, None).unwrap_err();
        assert!(err.contains("dsh entry is missing"), "err: {err}");
    }

    #[test]
    fn falls_back_to_dev_runtime_when_packaged_dir_is_empty() {
        let pack = tempdir().unwrap();
        let dev = tempdir().unwrap();
        let dev_runtime = dev.path().join("runtime");
        write_file(&dev_runtime, NODE_EXE);
        write_file(&dev_runtime, DSH_BIN_REL);
        let paths = resolve_runtime(pack.path(), None, Some(&dev_runtime)).unwrap();
        assert_eq!(paths.node, dev_runtime.join(NODE_EXE));
    }

    #[test]
    fn paths_with_spaces_and_unicode_resolve() {
        let dir = tempdir().unwrap();
        let runtime = dir.path().join("rün time 空格");
        write_file(&runtime, NODE_EXE);
        write_file(&runtime, DSH_BIN_REL);
        // env-override semantics: the override is the runtime root itself
        let paths = resolve_runtime(dir.path(), Some(runtime.as_os_str()), None).unwrap();
        assert!(paths.node.starts_with(&runtime));
        assert!(paths.bin_js.starts_with(&runtime));
    }

    // ---- build_spawn_command ---------------------------------------------

    #[test]
    fn spawn_command_uses_pinned_args() {
        let dir = tempdir().unwrap();
        let node = dir.path().join(NODE_EXE);
        let bin = dir.path().join(DSH_BIN_REL);
        let cmd = build_spawn_command(&node, &bin);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        let expected: Vec<String> = vec![
            bin.to_string_lossy().into_owned(),
            "web".into(),
            "--no-open".into(),
            "--port".into(),
            "0".into(),
        ];
        let got: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(got, expected);
        let program = cmd.get_program().to_string_lossy().into_owned();
        assert_eq!(program, node.to_string_lossy().into_owned());
    }

    #[test]
    fn spawn_command_is_repeatable_idempotently() {
        let dir = tempdir().unwrap();
        let node = dir.path().join(NODE_EXE);
        let bin = dir.path().join(DSH_BIN_REL);
        let a = build_spawn_command(&node, &bin);
        let b = build_spawn_command(&node, &bin);
        assert_eq!(
            a.get_args().collect::<Vec<_>>(),
            b.get_args().collect::<Vec<_>>()
        );
    }

    // ---- terminate (best effort on unix) ----------------------------------

    #[cfg(unix)]
    #[test]
    fn terminate_kills_a_spawned_child() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().unwrap();
        terminate(&mut child, Duration::from_millis(500));
        assert!(child.try_wait().unwrap().is_some(), "child should be reaped");
    }

    // The terminate windows/unix distinction is covered on respective CI
    // runners; the unix test above is skipped on non-unix hosts.
}