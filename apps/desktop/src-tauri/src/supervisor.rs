//! Starting and watching `fr daemon` (ADR 0026): spawn with an argv array, detached from the
//! shell's console and process group, stdout and stderr appended to
//! `<logs>/daemon-shell.log`; wait for a fresh `daemon.json` that answers `/health`; and
//! watch the exit code on a thread so the restart contract (`restart.rs`) can be applied.
//! Closing the window leaves the daemon running (the shell stays in the tray). Quit stops it
//! (U-018, ADR 0094): `stop_for_quit` asks it to shut down over HTTP and ends the process tree
//! when it does not go; the process the shell started is ended whatever its state, also while
//! it is still starting or hangs (`end_own_tree`, U-062). A daemon older than the runtime the
//! app carries (ADR 0092) is ended by `stop_process` so the bundled one can take its place.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::daemon::{
    DaemonClient, DaemonFile, Health, HealthError, daemon_file_path, is_fresh, read_daemon_file,
};
use crate::install::FrCommand;

pub const DAEMON_LOG: &str = "daemon-shell.log";
/// `tsx` compile plus runtime composition (migrations, vault) on a cold disk. The first start
/// of a fresh install compiles every source file and, on Windows, has each file scanned by the
/// antivirus, so the budget is generous; later starts read tsx's cache.
pub const START_TIMEOUT: Duration = Duration::from_secs(150);
/// How long an outdated daemon gets to go away after `stop_process`.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(15);
pub const POLL: Duration = Duration::from_millis(250);
/// After a restart exit, how long a user service gets to relaunch the daemon before the shell
/// does it.
pub const EXTERNAL_GRACE: Duration = Duration::from_secs(3);

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn daemon_log_path(logs_dir: &Path) -> PathBuf {
    logs_dir.join(DAEMON_LOG)
}

#[derive(Debug)]
pub struct Spawned {
    pub child: Child,
    pub pid: u32,
}

/// Start `fr daemon`. The argv is `cmd.program cmd.args… daemon`; nothing is interpreted by a
/// shell on either OS.
pub fn spawn_daemon(cmd: &FrCommand, logs_dir: &Path) -> Result<Spawned, String> {
    std::fs::create_dir_all(logs_dir)
        .map_err(|e| format!("could not create {}: {e}", logs_dir.display()))?;
    let log_path = daemon_log_path(logs_dir);
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("could not open {}: {e}", log_path.display()))?;
    let _ = writeln!(log, "[shell] starting: {}", cmd.describe());
    let stderr = log
        .try_clone()
        .map_err(|e| format!("could not duplicate the log handle: {e}"))?;

    let mut command = Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    if let Some(cwd) = &cmd.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &cmd.env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: a Ctrl-C or kill aimed at the shell never reaches the daemon.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", cmd.program.display()))?;
    let pid = child.id();
    log::info!("fr daemon started (pid {pid}, {})", cmd.describe());
    Ok(Spawned { child, pid })
}

/// Poll for a `daemon.json` that is not `before` (the file on disk before the spawn, if it
/// parsed) and answers `/health`, or fail when the child exits first or `START_TIMEOUT`
/// passes. The daemon's pid is usually a grandchild of `pid` (tsx, `fr.cmd`), so the file
/// is judged by `daemon::is_fresh`, not by pid equality.
pub async fn wait_for_daemon(
    runtime_dir: &Path,
    child: &mut Child,
    pid: u32,
    before: Option<&DaemonFile>,
) -> Result<(DaemonFile, Health, DaemonClient), String> {
    let started = Instant::now();
    let path = daemon_file_path(runtime_dir);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "fr daemon exited with {} before it was ready",
                status
                    .code()
                    .map(|c| format!("code {c}"))
                    .unwrap_or_else(|| "a signal".into())
            ));
        }
        if let Ok(file) = read_daemon_file(&path)
            && is_fresh(&file, Some(pid), before)
            && let Ok(client) = DaemonClient::from_file(&file)
            && let Ok(health) = client.health().await
        {
            return Ok((file, health, client));
        }
        if started.elapsed() > START_TIMEOUT {
            return Err(format!(
                "fr daemon did not write a healthy daemon.json within {} s",
                START_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Wait up to `grace` for a daemon the shell did not start (a user service's) to come up with
/// a `daemon.json` that differs from `previous` and answers `/health`.
pub async fn wait_for_external(
    runtime_dir: &Path,
    previous: Option<&DaemonFile>,
    grace: Duration,
) -> Option<(DaemonFile, Health, DaemonClient)> {
    let started = Instant::now();
    let path = daemon_file_path(runtime_dir);
    loop {
        if let Ok(file) = read_daemon_file(&path)
            && is_fresh(&file, None, previous)
            && let Ok(client) = DaemonClient::from_file(&file)
            && let Ok(health) = client.health().await
        {
            return Some((file, health, client));
        }
        if started.elapsed() > grace {
            return None;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// What came of waiting for a daemon that runs but answers slowly (U-065).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlowWait {
    /// It answered `/health`: attach.
    Answered(Health),
    /// It no longer accepts connections (or answers badly): it is gone, another may start.
    Gone(HealthError),
    /// Still no answer in time after the whole budget.
    StillSlow,
}

/// Probe `/health` until it answers, stops listening, or `budget` passes. A time-out is never
/// taken for "gone": only a refused connection or a bad answer is.
pub async fn wait_for_answer(client: &DaemonClient, budget: Duration) -> SlowWait {
    let started = Instant::now();
    loop {
        match client.health().await {
            Ok(h) => return SlowWait::Answered(h),
            Err(HealthError::Slow(_)) => {}
            Err(e) => return SlowWait::Gone(e),
        }
        if started.elapsed() > budget {
            return SlowWait::StillSlow;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// The argv that ends process `pid` and its children: `taskkill /PID <pid> /T /F` on Windows,
/// `kill -TERM <pid>` elsewhere (the daemon ends its sessions and closes on SIGTERM).
pub fn stop_argv(pid: u32, windows: bool) -> (String, Vec<String>) {
    if windows {
        (
            "taskkill".into(),
            vec!["/PID".into(), pid.to_string(), "/T".into(), "/F".into()],
        )
    } else {
        ("kill".into(), vec!["-TERM".into(), pid.to_string()])
    }
}

/// End an outdated daemon (ADR 0092) and wait until its `/health` stops answering.
pub async fn stop_process(pid: u32, client: &DaemonClient) -> Result<(), String> {
    end_process(pid)?;
    if wait_until_gone(client, STOP_TIMEOUT).await {
        Ok(())
    } else {
        Err(format!(
            "the daemon (pid {pid}) still answers after {} s",
            STOP_TIMEOUT.as_secs()
        ))
    }
}

/// How long Quit waits for the daemon to go after `POST /shutdown` before it ends the tree.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long Quit waits after ending the tree for `/health` to stop answering, and how long the
/// process the shell started gets after a TERM before it is killed.
pub const QUIT_FORCE_WAIT: Duration = Duration::from_secs(5);
/// How long Quit lets the process the shell started end by itself once the daemon has stopped
/// answering, before it ends that process's tree (U-062). Longer than the daemon's own bounded
/// exit (`EXIT_DEADLINE_MS`, 8 s, in `packages/runtime/src/cli/main.ts`).
pub const QUIT_CHILD_WAIT: Duration = Duration::from_secs(10);

/// The argv that ends the process the shell spawned with everything under it: `taskkill /PID
/// <pid> /T /F` on Windows (the tree), `kill -s TERM|KILL -- -<pid>` elsewhere (its process
/// group: `spawn_daemon` makes the child the leader of its own group, and tsx and the daemon
/// under it stay in that group).
pub fn group_stop_argv(pid: u32, windows: bool, force: bool) -> (String, Vec<String>) {
    if windows {
        return stop_argv(pid, true);
    }
    let signal = if force { "KILL" } else { "TERM" };
    (
        "kill".into(),
        vec!["-s".into(), signal.into(), "--".into(), format!("-{pid}")],
    )
}

/// End the process the shell started and everything under it, whatever its state: still
/// starting (the splash), hung, or already gone (U-062). The pid is the shell's own child,
/// recorded only while the shell holds its `Child` and cleared once it was reaped, so it never
/// names an unrelated process. Unix: TERM to the group, so the daemon can close its store, and
/// KILL when the leader still runs after `QUIT_FORCE_WAIT`. Windows: the tree at once.
pub async fn end_own_tree(pid: u32) -> Result<(), String> {
    if pid == 0 || pid == std::process::id() {
        return Err(format!("refusing to end pid {pid}"));
    }
    let (program, args) = group_stop_argv(pid, cfg!(windows), false);
    let first = run_stop(&program, &args);
    if cfg!(windows) {
        return first;
    }
    if first.is_err() && crate::daemon::pid_alive(pid) == Some(false) {
        // The group was already gone (kill answers "no such process"): nothing to end.
        return Ok(());
    }
    let started = Instant::now();
    while crate::daemon::pid_alive(pid) == Some(true) {
        if started.elapsed() > QUIT_FORCE_WAIT {
            log::warn!(
                "pid {pid} still runs {} s after TERM; killing its group",
                QUIT_FORCE_WAIT.as_secs()
            );
            let (program, args) = group_stop_argv(pid, false, true);
            return run_stop(&program, &args);
        }
        tokio::time::sleep(POLL).await;
    }
    first
}

/// The processes Quit ends when the daemon did not go by itself: the pid `daemon.json` names
/// (the daemon) and the one the shell spawned (`node …/tsx` or `fr.cmd`, the daemon's parent),
/// each once. On Windows each is ended with its tree, which takes what the daemon started.
pub fn quit_targets(file_pid: Option<u32>, child_pid: Option<u32>) -> Vec<u32> {
    let mut pids = Vec::new();
    for pid in [file_pid, child_pid].into_iter().flatten() {
        if pid != 0 && pid != std::process::id() && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

/// What Quit did to the daemon, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitOutcome {
    /// Nothing answered `/health`: there was no daemon to stop.
    NotRunning,
    /// It stopped after `POST /shutdown`.
    Stopped,
    /// It did not stop by itself (or is older than the route, as 1.0.4 is); these pids were
    /// ended.
    Forced(Vec<u32>),
    /// It still answers after everything was tried.
    StillRunning(String),
}

/// End one process (and on Windows its tree) without waiting for anything else.
fn end_process(pid: u32) -> Result<(), String> {
    let (program, args) = stop_argv(pid, cfg!(windows));
    run_stop(&program, &args)
}

fn run_stop(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command
        .status()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} {} ended with {status}", args.join(" ")))
    }
}

async fn wait_until_gone(client: &DaemonClient, budget: Duration) -> bool {
    let started = Instant::now();
    while client.health().await.is_ok() {
        if started.elapsed() > budget {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
    true
}

/// Quit (U-018, ADR 0094): ask the daemon to stop every run and exit (`POST /shutdown`), wait
/// for `/health` to stop answering, and end the process tree when it does not. A pid from
/// `daemon.json` is only ended while the daemon still answers, so a stale file never ends an
/// unrelated process that reused its pid. The process the shell started (`child_pid`) is its
/// own child, so it is ended whatever its state (U-062): when nothing answers because there is
/// no `daemon.json` yet (the splash) or because the daemon hangs.
pub async fn stop_for_quit(
    client: Option<&DaemonClient>,
    file_pid: Option<u32>,
    child_pid: Option<u32>,
) -> QuitOutcome {
    let answering = match client {
        Some(c) => c.health().await.is_ok(),
        None => false,
    };
    let (true, Some(client)) = (answering, client) else {
        return match child_pid {
            Some(pid) => {
                log::warn!(
                    "Quit: no daemon answers; ending the process the shell started (pid {pid}) and its tree"
                );
                match end_own_tree(pid).await {
                    Ok(()) => QuitOutcome::Forced(vec![pid]),
                    Err(e) => QuitOutcome::StillRunning(format!("pid {pid}: {e}")),
                }
            }
            None => QuitOutcome::NotRunning,
        };
    };
    match client.post_json("/shutdown", &serde_json::json!({})).await {
        Ok((status, _)) if (200..300).contains(&status) => {
            if wait_until_gone(client, QUIT_TIMEOUT).await {
                return QuitOutcome::Stopped;
            }
            log::warn!(
                "the daemon still answers {} s after POST /shutdown; ending it",
                QUIT_TIMEOUT.as_secs()
            );
        }
        Ok((status, _)) => log::warn!("POST /shutdown answered {status}; ending the daemon"),
        Err(e) => log::warn!("POST /shutdown failed ({e}); ending the daemon"),
    }
    if client.health().await.is_err() {
        return QuitOutcome::Stopped;
    }
    let pids = quit_targets(file_pid, child_pid);
    if pids.is_empty() {
        return QuitOutcome::StillRunning("daemon.json names no pid".into());
    }
    for pid in &pids {
        // The shell's own child is ended with its group (tsx and the daemon under it).
        let ended = if Some(*pid) == child_pid {
            end_own_tree(*pid).await
        } else {
            end_process(*pid)
        };
        if let Err(e) = ended {
            log::warn!("could not end pid {pid}: {e}");
        }
    }
    if wait_until_gone(client, QUIT_FORCE_WAIT).await {
        QuitOutcome::Forced(pids)
    } else {
        QuitOutcome::StillRunning(format!(
            "pids {pids:?} were ended but the daemon still answers"
        ))
    }
}

/// Wait for the child on its own thread and report the exit code (`None` for a signal).
pub fn watch_exit(mut child: Child, on_exit: impl FnOnce(Option<i32>) + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("fr-daemon-wait".into())
        .spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            on_exit(code);
        });
    if let Err(e) = spawned {
        log::error!("could not watch the daemon process: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_uses_an_argv_and_takes_the_process_tree_on_windows() {
        assert_eq!(
            stop_argv(4242, true),
            (
                "taskkill".to_string(),
                vec!["/PID", "4242", "/T", "/F"]
                    .into_iter()
                    .map(String::from)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(
            stop_argv(4242, false),
            (
                "kill".to_string(),
                vec!["-TERM".to_string(), "4242".to_string()]
            )
        );
    }

    #[test]
    fn quit_ends_the_daemon_and_the_process_the_shell_spawned_once_each() {
        assert_eq!(quit_targets(Some(15436), Some(15422)), vec![15436, 15422]);
        // The shell spawned the daemon itself (a direct `node` start): one pid.
        assert_eq!(quit_targets(Some(15436), Some(15436)), vec![15436]);
        // Attached to a daemon the shell did not start.
        assert_eq!(quit_targets(Some(15436), None), vec![15436]);
        assert_eq!(quit_targets(None, Some(15422)), vec![15422]);
        assert!(quit_targets(None, None).is_empty());
        // Never pid 0 (a process group on Unix) and never the shell itself.
        assert!(quit_targets(Some(0), None).is_empty());
        assert!(quit_targets(Some(std::process::id()), None).is_empty());
    }

    #[test]
    fn the_shells_own_child_is_ended_with_its_group() {
        assert_eq!(
            group_stop_argv(15422, false, false),
            (
                "kill".to_string(),
                vec!["-s", "TERM", "--", "-15422"]
                    .into_iter()
                    .map(String::from)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(group_stop_argv(15422, false, true).1[1], "KILL");
        // Windows: the tree, at once.
        assert_eq!(group_stop_argv(15422, true, false), stop_argv(15422, true));
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fr-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A process the way `spawn_daemon` starts one (its own group, no window) with a child of
    /// its own, like `node …/tsx` and the daemon under it. Returns the grandchild's pid where
    /// the test can learn it (Unix).
    fn spawn_tree(dir: &Path) -> (Child, Option<u32>) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let file = dir.join("grandchild.pid");
            let child = Command::new("sh")
                .args(["-c", "sleep 60 & echo $! > \"$0\"; wait"])
                .arg(&file)
                .stdin(Stdio::null())
                .process_group(0)
                .spawn()
                .expect("spawn sh");
            let started = Instant::now();
            let grandchild = loop {
                if let Some(pid) = std::fs::read_to_string(&file)
                    .ok()
                    .and_then(|t| t.trim().parse::<u32>().ok())
                {
                    break pid;
                }
                assert!(started.elapsed() < Duration::from_secs(10), "no grandchild");
                std::thread::sleep(Duration::from_millis(20));
            };
            (child, Some(grandchild))
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = dir;
            let child = Command::new("cmd")
                .args(["/d", "/c", "ping -n 60 127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
                .spawn()
                .expect("spawn cmd");
            (child, None)
        }
    }

    fn assert_tree_gone(child: &mut Child, grandchild: Option<u32>) {
        let started = Instant::now();
        while child.try_wait().expect("try_wait").is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "the process the shell started is still running"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        if let Some(pid) = grandchild {
            while crate::daemon::pid_alive(pid) == Some(true) {
                assert!(
                    started.elapsed() < Duration::from_secs(15),
                    "the daemon under it (pid {pid}) is still running"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    /// U-062: Quit during the first start (the splash: no `daemon.json` yet, so no client)
    /// ended nothing and left the daemon running. The process the shell started is ended with
    /// everything under it.
    #[tokio::test]
    async fn quit_during_the_splash_ends_the_process_the_shell_started() {
        let dir = temp_dir("quit-splash");
        let (mut child, grandchild) = spawn_tree(&dir);
        let pid = child.id();
        assert_eq!(
            stop_for_quit(None, None, Some(pid)).await,
            QuitOutcome::Forced(vec![pid])
        );
        assert_tree_gone(&mut child, grandchild);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// U-062: a daemon that accepts connections but never answers (hung) was "not running" to
    /// Quit, which left it behind. The shell's own child is ended; the pid `daemon.json` names
    /// is not touched without an answer (it may be stale).
    #[tokio::test]
    async fn quit_ends_a_hung_daemon_the_shell_started_but_never_a_pid_it_cannot_verify() {
        use crate::test_http::{Route, TestServer};
        let server = TestServer::start(vec![Route::json("GET", "/health", 200, "{}").hanging()]);
        let client =
            DaemonClient::new(&server.url, crate::secret::Secret::new("t")).expect("client");
        let dir = temp_dir("quit-hung");
        let (mut child, grandchild) = spawn_tree(&dir);
        let pid = child.id();
        let outcome = stop_for_quit(Some(&client), Some(u32::MAX - 7), Some(pid)).await;
        assert_eq!(outcome, QuitOutcome::Forced(vec![pid]));
        assert_tree_gone(&mut child, grandchild);
        assert_eq!(
            server.seen(),
            vec!["GET /health"],
            "no /shutdown to a hung daemon"
        );
        // Nothing the shell started and nothing answering: nothing to do.
        assert_eq!(
            stop_for_quit(Some(&client), Some(u32::MAX - 7), None).await,
            QuitOutcome::NotRunning
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The normal path: the daemon answers, takes `POST /shutdown` and goes; nothing is ended.
    #[tokio::test]
    async fn quit_asks_a_daemon_that_answers_to_shut_down() {
        use crate::test_http::{Route, TestServer, health_body};
        let server = TestServer::start(vec![
            Route::json("GET", "/health", 200, &health_body(0)),
            Route::json("POST", "/shutdown", 202, r#"{"stopping":true}"#).then_close(),
        ]);
        let client =
            DaemonClient::new(&server.url, crate::secret::Secret::new("t")).expect("client");
        assert_eq!(
            stop_for_quit(Some(&client), Some(u32::MAX - 7), None).await,
            QuitOutcome::Stopped
        );
        let seen = server.seen();
        assert_eq!(seen[..2], ["GET /health", "POST /shutdown"]);
    }

    /// U-065: a slow daemon is waited for. Its answer attaches; a refused connection means it
    /// is gone; a daemon that keeps not answering is reported, never replaced.
    #[tokio::test]
    async fn waiting_for_a_slow_daemon_tells_answered_gone_and_still_slow_apart() {
        use crate::test_http::{Route, TestServer, health_body, refused_url};
        let token = || crate::secret::Secret::new("t");
        let up = TestServer::start(vec![Route::json("GET", "/health", 200, &health_body(2))]);
        let client = DaemonClient::new(&up.url, token()).expect("client");
        match wait_for_answer(&client, Duration::from_secs(5)).await {
            SlowWait::Answered(h) => assert_eq!(h.active_sessions, 2),
            other => panic!("expected an answer, got {other:?}"),
        }
        let gone = DaemonClient::new(&refused_url(), token()).expect("client");
        assert!(matches!(
            wait_for_answer(&gone, Duration::from_secs(5)).await,
            SlowWait::Gone(HealthError::Unreachable(_))
        ));
        let hung = TestServer::start(vec![Route::json("GET", "/health", 200, "{}").hanging()]);
        let slow = DaemonClient::new(&hung.url, token()).expect("client");
        let started = Instant::now();
        assert_eq!(
            wait_for_answer(&slow, Duration::from_secs(2)).await,
            SlowWait::StillSlow
        );
        assert!(started.elapsed() >= Duration::from_secs(2));
    }

    #[test]
    fn log_path_is_under_the_logs_dir() {
        assert_eq!(
            daemon_log_path(Path::new("/x/logs")),
            Path::new("/x/logs").join("daemon-shell.log")
        );
    }

    /// Spawning with a program that does not exist fails with a readable error and never
    /// touches a shell; the log file is created first with the start line.
    #[test]
    fn spawn_failure_is_reported_and_logged() {
        let dir = std::env::temp_dir().join(format!("fr-spawn-test-{}", uuid::Uuid::new_v4()));
        let cmd = FrCommand {
            program: dir.join("definitely-missing-fr"),
            args: vec![],
            cwd: None,
            env: Vec::new(),
            source: crate::install::FrSource::PathLookup,
        };
        let err = spawn_daemon(&cmd, &dir.join("logs")).unwrap_err();
        assert!(err.contains("could not start"));
        let log = std::fs::read_to_string(daemon_log_path(&dir.join("logs"))).expect("log exists");
        assert!(log.contains("[shell] starting:"));
        assert!(log.contains("definitely-missing-fr"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
