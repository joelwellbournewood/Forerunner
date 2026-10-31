//! What the shell does: attach to or start the daemon, react to its exit, and the tray
//! actions (kill switch, resume, pause email, stop desktop control, update and restart, quit). Every action talks to the
//! daemon through `DaemonClient`; nothing here enforces a limit on its own, the daemon does.

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use crate::daemon::{
    self, AttachDecision, DaemonClient, DaemonFile, Health, daemon_file_path, error_message,
    read_daemon_file,
};
use crate::dirs::Platform;
use crate::env::ProcessEnv;
use crate::install::{self, RealFs, locate_fr};
use crate::restart::{
    ExitAction, decide_after_exit, external_daemon_gone, external_exit_code, read_restart_request,
    remove_restart_request,
};
use crate::sse::parse_desktop_indicator;
use crate::state::{Busy, EmailAction, SharedState, StreamMode, lock};
use crate::supervisor::{
    EXTERNAL_GRACE, QuitOutcome, daemon_log_path, spawn_daemon, stop_for_quit, stop_process,
    wait_for_daemon, wait_for_external, watch_exit,
};
use crate::{events, tray, windows};

/// How long "Update and restart" waits for a daemon the shell did not start to go away.
pub const EXTERNAL_RESTART_BUDGET: Duration = Duration::from_secs(90);
/// Pause between `/health` probes while waiting for that daemon.
pub const EXTERNAL_PROBE_PAUSE: Duration = Duration::from_secs(1);

pub fn shared(app: &AppHandle) -> SharedState {
    app.state::<SharedState>().inner().clone()
}

pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification not shown: {e}");
    }
}

/// An error the human must see; the tray stays so "Open" can try again.
pub fn fail_dialog(app: &AppHandle, title: &str, message: &str) {
    log::error!("{title}: {message}");
    windows::close_splash(app);
    {
        let state = shared(app);
        let mut s = lock(&state);
        s.busy = None;
    }
    tray::refresh(app);
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// Attach to the daemon named by `daemon.json` when it is healthy, else (when allowed) start
/// one and wait for it. Runs once at a time; a second call while one is in flight returns.
pub async fn bootstrap(app: AppHandle, allow_start: bool) {
    let state = shared(&app);
    let (dirs, last_attached) = {
        let mut s = lock(&state);
        if s.busy == Some(Busy::Starting) {
            return;
        }
        s.busy = Some(Busy::Starting);
        s.halted = false;
        (s.dirs.clone(), s.last_file.clone())
    };
    tray::refresh(&app);

    let file = read_daemon_file(&daemon_file_path(&dirs.runtime));
    // What a spawned daemon must replace before it counts as up: the file on disk now (a
    // stale or unhealthy daemon's), else the last file the shell attached to.
    let before = file.as_ref().ok().cloned().or(last_attached);
    let alive = file
        .as_ref()
        .ok()
        .and_then(|f| f.pid)
        .and_then(daemon::pid_alive);
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|d| install::bundled_runtime(&d));
    let mut decision = match daemon::precheck(file, alive) {
        Ok(file) => match DaemonClient::from_file(&file) {
            Ok(client) => {
                let health = client.health().await;
                daemon::decide(file, health)
            }
            Err(reason) => AttachDecision::Start { reason },
        },
        Err(reason) => AttachDecision::Start { reason },
    };
    // A daemon older than the runtime this app carries (one left running from an earlier
    // install or an old checkout) is stopped and replaced (ADR 0092).
    if allow_start
        && let AttachDecision::Attach(file, health) = &decision
        && let Some(reason) = daemon::outdated_reason(
            &health.version,
            bundled.as_ref().map(|b| b.version.as_str()),
        )
    {
        log::warn!("replacing the daemon at {}: {reason}", file.url);
        windows::show_splash(&app, "Updating the Forerunner background service…");
        let stopped = match (file.pid, DaemonClient::from_file(file)) {
            (Some(pid), Ok(client)) => stop_process(pid, &client).await,
            (None, _) => Err("its daemon.json names no pid".into()),
            (_, Err(e)) => Err(e),
        };
        match stopped {
            Ok(()) => decision = AttachDecision::Start { reason },
            Err(e) => {
                log::error!("could not stop the outdated daemon: {e}");
                fail_dialog(
                    &app,
                    "An older Forerunner background service is still running",
                    &format!(
                        "{reason}, and it could not be stopped ({e}).\n\nEnd it (the node process in the Task Manager or `fr daemon`), then open Forerunner again. Until then the app may show errors."
                    ),
                );
            }
        }
    }

    match decision {
        AttachDecision::Attach(file, health) => {
            log::info!(
                "attached to the daemon at {} (daemon.json version {}, health version {})",
                file.url,
                file.version.as_deref().unwrap_or("?"),
                health.version
            );
            attached(&app, file, health).await;
        }
        AttachDecision::Start { reason } => {
            if !allow_start {
                log::info!("daemon not attached ({reason}); not starting one now");
                let mut s = lock(&state);
                s.busy = None;
                s.status.reachable = false;
                drop(s);
                tray::refresh(&app);
                return;
            }
            log::info!("starting the daemon: {reason}");
            windows::show_splash(&app, "Starting the Forerunner daemon…");
            let cmd = match locate_fr(
                &ProcessEnv,
                &RealFs,
                &dirs.config,
                &dirs.data,
                Platform::current(),
                bundled.as_ref(),
            ) {
                Ok(c) => c,
                Err(e) => {
                    fail_dialog(&app, "Forerunner cannot start the daemon", &e.to_string());
                    return;
                }
            };
            let log_path = daemon_log_path(&dirs.logs);
            let mut spawned = match spawn_daemon(&cmd, &dirs.logs) {
                Ok(s) => s,
                Err(e) => {
                    fail_dialog(
                        &app,
                        "Forerunner cannot start the daemon",
                        &format!("{e}\n\nDaemon log: {}", log_path.display()),
                    );
                    return;
                }
            };
            {
                let mut s = lock(&state);
                s.child_pid = Some(spawned.pid);
            }
            windows::set_splash(&app, "Waiting for the daemon to listen…");
            let waited = wait_for_daemon(
                &dirs.runtime,
                &mut spawned.child,
                spawned.pid,
                before.as_ref(),
            )
            .await;
            // A child that already exited is reported once, by the dialog below; only a
            // running child is handed to the exit watcher.
            let already_gone = matches!(spawned.child.try_wait(), Ok(Some(_)));
            if already_gone {
                let mut s = lock(&state);
                s.child_pid = None;
                s.halted = true;
            } else {
                let app_for_exit = app.clone();
                watch_exit(spawned.child, move |code| {
                    handle_daemon_exit(app_for_exit, code)
                });
            }
            match waited {
                Ok((file, health, _client)) => {
                    log::info!(
                        "the daemon is up at {} (version {})",
                        file.url,
                        health.version
                    );
                    attached(&app, file, health).await;
                }
                Err(e) => {
                    fail_dialog(
                        &app,
                        "The Forerunner daemon did not start",
                        &format!(
                            "{e}.\n\nDaemon log: {}\n\nUse Open in the tray to try again.",
                            log_path.display()
                        ),
                    );
                }
            }
        }
    }
}

/// Record the attached daemon, build (or rebuild) the main window with its address and
/// token, start the event loops and learn whether the email routes exist.
pub async fn attached(app: &AppHandle, file: DaemonFile, health: Health) {
    let state = shared(app);
    let client = match DaemonClient::from_file(&file) {
        Ok(c) => c,
        Err(e) => {
            fail_dialog(app, "Forerunner cannot use the daemon", &e);
            return;
        }
    };
    let injection = {
        let mut s = lock(&state);
        s.client = Some(client);
        s.status.reachable = true;
        s.status.version = health.version.clone();
        s.status.kill_active = health.kill_active;
        s.status.active_sessions = health.active_sessions;
        s.status.last_error = None;
        s.status.failures = 0;
        s.restart.healthy_since = Some(Instant::now());
        s.restart.expected = false;
        s.busy = None;
        s.halted = false;
        s.last_file = Some(file.clone());
        crate::inject::Injection {
            daemon_url: file.url.clone(),
            daemon_token: file.token.clone(),
            install_id: s.install_id.clone(),
            platform: Platform::current().label().to_string(),
            shell_version: s.shell_version.clone(),
        }
    };
    windows::ensure_main(app, &injection).await;
    windows::close_splash(app);
    tray::refresh(app);
    events::ensure_loops(app);
    probe_email(app.clone()).await;
}

/// The daemon has ended: apply the restart contract. For the process the shell started the
/// supervisor thread reports the real exit code; for a daemon started by something else
/// `watch_external_restart` reports the code its restart request named (`None` without one).
pub fn handle_daemon_exit(app: AppHandle, code: Option<i32>) {
    tauri::async_runtime::spawn(async move {
        let state = shared(&app);
        if lock(&state).quitting {
            // Quit stopped it (U-018): expected, and the shell is about to end too.
            log::info!("fr daemon exited during Quit");
            return;
        }
        let (dirs, consecutive, previous) = {
            let mut s = lock(&state);
            s.client = None;
            s.child_pid = None;
            s.status.reachable = false;
            s.stream = StreamMode::Off;
            s.busy = None;
            // The expected exit happened (or a crash took its place); nothing is pending.
            s.restart.expected = false;
            (s.dirs.clone(), s.restart.consecutive, s.last_file.clone())
        };
        tray::refresh(&app);
        let request = read_restart_request(&dirs.runtime);
        let action = decide_after_exit(code, request.as_ref(), consecutive);
        log::info!(
            "fr daemon exited with {} (restart request: {}): {:?}",
            code.map(|c| c.to_string())
                .unwrap_or_else(|| "a signal".into()),
            request
                .as_ref()
                .map(|r| format!("{} to {}", r.reason, r.target_version))
                .unwrap_or_else(|| "none".into()),
            action
        );
        let log_path = daemon_log_path(&dirs.logs);
        match action {
            ExitAction::Restart { reason } => {
                remove_restart_request(&dirs.runtime);
                {
                    let mut s = lock(&state);
                    s.restart.consecutive += 1;
                    s.restart.healthy_since = None;
                    s.restart.expected = false;
                }
                windows::show_splash(&app, &format!("Restarting the daemon ({reason})…"));
                // A user service (ADR 0026) may relaunch it first; give it a moment.
                if let Some((file, health, _)) =
                    wait_for_external(&dirs.runtime, previous.as_ref(), EXTERNAL_GRACE).await
                {
                    log::info!("another supervisor relaunched the daemon; attaching");
                    attached(&app, file, health).await;
                } else {
                    bootstrap(app.clone(), true).await;
                }
            }
            ExitAction::GiveUp { reason } => {
                {
                    let mut s = lock(&state);
                    s.halted = true;
                }
                fail_dialog(
                    &app,
                    "Forerunner could not restart the daemon",
                    &format!(
                        "{reason}.\n\nDaemon log: {}\n\nUse Open in the tray to try again.",
                        log_path.display()
                    ),
                );
            }
            ExitAction::Crashed { code } => {
                {
                    let mut s = lock(&state);
                    s.halted = true;
                }
                fail_dialog(
                    &app,
                    "The Forerunner daemon stopped unexpectedly",
                    &format!(
                        "Exit {}.\n\nDaemon log: {}\n\nUse Open in the tray to start it again.",
                        code.map(|c| format!("code {c}")).unwrap_or_else(|| {
                            "without an exit code (a signal, or a daemon the shell did not start that left no restart request)".into()
                        }),
                        log_path.display()
                    ),
                );
            }
            ExitAction::Stopped => {
                let mut s = lock(&state);
                s.halted = true;
                drop(s);
                windows::close_splash(&app);
                tray::refresh(&app);
            }
        }
    });
}

/// The question Quit asks while sessions run, or `None` to quit at once (U-018, ADR 0094).
pub fn quit_confirm_text(active_sessions: u64) -> Option<String> {
    match active_sessions {
        0 => None,
        1 => Some("A session is running. Quitting stops it and the Forerunner background service.\n\nTo keep it working, close the window instead: Forerunner stays in the tray.".into()),
        n => Some(format!("{n} sessions are running. Quitting stops them and the Forerunner background service.\n\nTo keep them working, close the window instead: Forerunner stays in the tray.")),
    }
}

/// Tray: "Quit Forerunner" (U-018, ADR 0094). Asks first while a session runs, then stops the
/// daemon and everything it started, then ends the shell, so nothing keeps files in the
/// install folder open.
pub fn quit(app: AppHandle) {
    let active = lock(&shared(&app)).status.active_sessions;
    let Some(question) = quit_confirm_text(active) else {
        tauri::async_runtime::spawn(finish_quit(app));
        return;
    };
    let app2 = app.clone();
    app.dialog()
        .message(question)
        .title("Quit Forerunner")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit and stop".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                tauri::async_runtime::spawn(finish_quit(app2));
            }
        });
}

async fn finish_quit(app: AppHandle) {
    let state = shared(&app);
    let (client, runtime_dir, child_pid, last_pid) = {
        let mut s = lock(&state);
        if s.quitting {
            return;
        }
        s.quitting = true;
        (
            s.client.clone(),
            s.dirs.runtime.clone(),
            s.child_pid,
            s.last_file.as_ref().and_then(|f| f.pid),
        )
    };
    windows::save_main_state(&app);
    windows::hide_all(&app);
    // The file on disk names the daemon that runs now, even one started after the shell last
    // attached (a restart by a user service); the attached client is the fallback.
    let file = read_daemon_file(&daemon_file_path(&runtime_dir)).ok();
    let client = file
        .as_ref()
        .and_then(|f| DaemonClient::from_file(f).ok())
        .or(client);
    let file_pid = file.as_ref().and_then(|f| f.pid).or(last_pid);
    match client {
        Some(client) => match stop_for_quit(&client, file_pid, child_pid).await {
            QuitOutcome::StillRunning(why) => {
                log::error!("Quit could not stop the daemon: {why}")
            }
            outcome => log::info!("Quit: daemon {outcome:?}"),
        },
        None => log::info!("Quit: no daemon recorded"),
    }
    log::info!("quit from the tray; the shell ends");
    app.exit(0);
}

fn current_client(app: &AppHandle) -> Option<DaemonClient> {
    lock(&shared(app)).client.clone()
}

/// Tray: "Kill switch: stop everything" (spec S.8). Confirms, then `POST /kill {scope: "all"}`.
pub fn kill_switch(app: AppHandle) {
    let app2 = app.clone();
    app.dialog()
        .message("Stop every running session for every agent, revoke their run tokens and freeze claims?\n\nResume from the tray or the UI when you are ready.")
        .title("Forerunner kill switch")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Stop everything".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            tauri::async_runtime::spawn(async move {
                let Some(client) = current_client(&app2) else {
                    return;
                };
                let body = json!({ "scope": "all", "reason": "kill switch from the tray" });
                match client.post_json("/kill", &body).await {
                    Ok((status, v)) if (200..300).contains(&status) => {
                        let active = v.get("killActive").and_then(Value::as_bool).unwrap_or(true);
                        let stopped = v.get("stopped").and_then(Value::as_u64);
                        {
                            let state = shared(&app2);
                            let mut s = lock(&state);
                            s.status.kill_active = active;
                        }
                        tray::refresh(&app2);
                        notify(
                            &app2,
                            "Forerunner: kill switch active",
                            &match stopped {
                                Some(n) => format!("{n} session(s) stopped. Resume from the tray."),
                                None => "Everything stopped. Resume from the tray.".into(),
                            },
                        );
                    }
                    Ok((status, v)) => fail_dialog(
                        &app2,
                        "Kill switch failed",
                        &error_message(status, &v),
                    ),
                    Err(e) => fail_dialog(&app2, "Kill switch failed", &e),
                }
            });
        });
}

/// Tray: "Resume" after the kill switch (`POST /kill/resume`).
pub async fn resume(app: AppHandle) {
    let Some(client) = current_client(&app) else {
        return;
    };
    match client.post_json("/kill/resume", &json!({})).await {
        Ok((status, v)) if (200..300).contains(&status) => {
            let active = v
                .get("killActive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            {
                let state = shared(&app);
                let mut s = lock(&state);
                s.status.kill_active = active;
            }
            tray::refresh(&app);
        }
        Ok((status, v)) => fail_dialog(&app, "Resume failed", &error_message(status, &v)),
        Err(e) => fail_dialog(&app, "Resume failed", &e),
    }
}

/// The desktop-control routes the tray uses, as `desktopRouteTable()` in
/// `packages/capabilities/src/desktop/routes.ts` names them. The status carries
/// `desktopControl` (spec S.32; ADR 0067); revoke is "Stop desktop control".
pub const DESKTOP_STATUS_PATH: &str = "/desktop/status";
pub const DESKTOP_REVOKE_PATH: &str = "/desktop/revoke";

/// Re-read desktop control from `GET /desktop/status` (on every (re)opened `/events` stream:
/// frames sent while it was down are lost). A daemon without the route, or a failed read,
/// leaves the state as it is; the next frame or reconnect corrects it.
pub async fn probe_desktop(app: AppHandle) {
    let Some(client) = current_client(&app) else {
        return;
    };
    // A frame that arrives while the read is in flight is newer than its answer (ADR 0067).
    let token = {
        let state = shared(&app);
        let mut s = lock(&state);
        s.begin_desktop_read()
    };
    let indicator = match client.get_json(DESKTOP_STATUS_PATH).await {
        Ok((200, v)) => v.get("desktopControl").and_then(parse_desktop_indicator),
        Ok((status, v)) => {
            log::info!(
                "{DESKTOP_STATUS_PATH} answered {}",
                error_message(status, &v)
            );
            None
        }
        Err(e) => {
            log::warn!("{DESKTOP_STATUS_PATH} failed: {e}");
            None
        }
    };
    if let Some(indicator) = indicator {
        let applied = {
            let state = shared(&app);
            let mut s = lock(&state);
            s.apply_desktop_read(token, &indicator)
        };
        if applied {
            tray::refresh(&app);
        } else {
            log::info!("{DESKTOP_STATUS_PATH} answer dropped: a newer desktop.indicator landed");
        }
    }
}

/// "Stop desktop control": `POST /desktop/revoke` interrupts the action in flight, drops the
/// queued ones and refuses desktop actions until resumed; the tray follows the status the
/// daemon answers (the `desktop.indicator` off frame says the same).
pub async fn desktop_stop(app: AppHandle) {
    let Some(client) = current_client(&app) else {
        return;
    };
    let body = json!({ "reason": "stopped from the tray" });
    match client.post_json(DESKTOP_REVOKE_PATH, &body).await {
        Ok((status, v)) if (200..300).contains(&status) => {
            let indicator = v
                .get("status")
                .and_then(|s| s.get("desktopControl"))
                .and_then(parse_desktop_indicator);
            if let Some(indicator) = indicator {
                let state = shared(&app);
                let mut s = lock(&state);
                s.apply_desktop_frame(&indicator);
            }
            tray::refresh(&app);
        }
        Ok((status, v)) => fail_dialog(
            &app,
            "Stop desktop control failed",
            &error_message(status, &v),
        ),
        Err(e) => fail_dialog(&app, "Stop desktop control failed", &e),
    }
}

/// The email routes the tray uses, as `emailRouteTable()` in
/// `packages/capabilities/src/email/routes.ts` names them (`:agentId` filled in). The probe
/// reads the settings route; pause and resume are the toggle.
/// `tests::email_paths_match_the_route_table_source` reads that file's source, so a rename
/// there fails the shell's tests rather than the tray at runtime.
pub fn email_settings_path(agent_id: &str) -> String {
    format!("/agents/{agent_id}/email/settings")
}

pub fn email_action_path(agent_id: &str, action: EmailAction) -> String {
    let verb = match action {
        EmailAction::Pause => "pause",
        EmailAction::Resume => "resume",
    };
    format!("/agents/{agent_id}/email/{verb}")
}

/// Learn the principal agent (`GET /me`) and whether the daemon mounts the email routes
/// (`GET /agents/:id/email/settings`, the route table's GET): a 404 means "not available",
/// shown as such in the tray; 200 carries `settings.paused`.
pub async fn probe_email(app: AppHandle) {
    let Some(client) = current_client(&app) else {
        return;
    };
    let state = shared(&app);
    let agent_id = match client.get_json("/me").await {
        Ok((200, v)) => v
            .get("agent")
            .and_then(|a| a.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        Ok((status, v)) => {
            log::warn!("/me answered {}", error_message(status, &v));
            None
        }
        Err(e) => {
            log::warn!("/me failed: {e}");
            None
        }
    };
    let Some(agent_id) = agent_id else {
        let mut s = lock(&state);
        s.email.available = false;
        s.email.reason = "no principal agent reported by /me".into();
        drop(s);
        tray::refresh(&app);
        return;
    };
    let result = client.get_json(&email_settings_path(&agent_id)).await;
    {
        let mut s = lock(&state);
        s.email.agent_id = Some(agent_id);
        match result {
            Ok((200, v)) => {
                s.email.available = true;
                s.email.reason.clear();
                s.email.paused = v
                    .get("settings")
                    .and_then(|x| x.get("paused"))
                    .or_else(|| v.get("paused"))
                    .and_then(Value::as_bool)
                    .or(Some(false));
            }
            Ok((404, _)) => {
                s.email.available = false;
                s.email.reason = "the daemon has no email routes yet".into();
            }
            Ok((status, v)) => {
                s.email.available = false;
                s.email.reason = error_message(status, &v);
            }
            Err(e) => {
                s.email.available = false;
                s.email.reason = e;
            }
        }
    }
    tray::refresh(&app);
}

/// Tray: "Pause email" / "Resume email" (spec S.28), `POST /agents/:id/email/pause|resume`.
pub async fn email_toggle(app: AppHandle, action: EmailAction) {
    let state = shared(&app);
    let (client, agent_id) = {
        let s = lock(&state);
        match (&s.client, &s.email.agent_id, s.email.available) {
            (Some(c), Some(id), true) => (c.clone(), id.clone()),
            _ => return,
        }
    };
    match client
        .post_json(&email_action_path(&agent_id, action), &json!({}))
        .await
    {
        Ok((status, v)) if (200..300).contains(&status) => {
            let paused = v
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(action == EmailAction::Pause);
            {
                let mut s = lock(&state);
                s.email.paused = Some(paused);
            }
            tray::refresh(&app);
            notify(
                &app,
                if paused {
                    "Forerunner: email paused"
                } else {
                    "Forerunner: email resumed"
                },
                if paused {
                    "Nothing leaves the agent's mailbox until you resume."
                } else {
                    "The agent may send email again within its limits."
                },
            );
        }
        Ok((status, v)) => fail_dialog(&app, "Email pause failed", &error_message(status, &v)),
        Err(e) => fail_dialog(&app, "Email pause failed", &e),
    }
}

/// Watch a daemon the shell did not start go away after a restart was requested ("Update
/// and restart" on the Updates screen, announced over `/events`), then apply the
/// restart contract with the exit code its request names (ADR 0031 §4).
/// `restart::external_daemon_gone` decides when it is gone: one missed `/health` probe is
/// not an exit (the daemon may be staging the update: download, verify, unpack), a pid the
/// OS reports dead is, and without a pid signal (Windows) several consecutive misses
/// together with the request file the daemon writes right before it exits. The shell is
/// busy for the duration so the monitor never re-attaches underneath, and `restart.json` is
/// only removed by `handle_daemon_exit` once a relaunch is decided.
pub async fn watch_external_restart(app: AppHandle) {
    let state = shared(&app);
    let (client, dirs, pid) = {
        let mut s = lock(&state);
        let Some(c) = s.client.clone() else {
            return;
        };
        if s.child_pid.is_some() {
            // The supervisor thread reports a child's exit; nothing to watch here.
            return;
        }
        s.busy = Some(Busy::Updating);
        s.restart.expected = true;
        (c, s.dirs.clone(), s.last_file.as_ref().and_then(|f| f.pid))
    };
    tray::refresh(&app);
    let started = Instant::now();
    let mut misses = 0u32;
    loop {
        tokio::time::sleep(EXTERNAL_PROBE_PAUSE).await;
        misses = if client.health().await.is_ok() {
            0
        } else {
            misses + 1
        };
        let request = read_restart_request(&dirs.runtime);
        let alive = pid.and_then(daemon::pid_alive);
        if external_daemon_gone(misses, alive, request.is_some()) {
            log::info!(
                "the daemon the shell did not start is gone after {misses} missed probe(s) (pid alive: {alive:?}, restart request: {})",
                request.is_some()
            );
            handle_daemon_exit(app.clone(), external_exit_code(request.as_ref()));
            return;
        }
        if started.elapsed() > EXTERNAL_RESTART_BUDGET {
            {
                let mut s = lock(&state);
                s.busy = None;
                s.restart.expected = false;
            }
            fail_dialog(
                &app,
                "Update did not restart the daemon",
                &format!(
                    "The daemon accepted the update but kept running for {} s. Check the updates screen and the daemon log.",
                    EXTERNAL_RESTART_BUDGET.as_secs()
                ),
            );
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The route table the daemon mounts (`emailRouteTable()`), read at compile time: a
    /// rename there fails this test instead of the tray at runtime.
    const ROUTES_TS: &str = include_str!("../../../../packages/capabilities/src/email/routes.ts");

    #[test]
    fn quit_asks_only_while_sessions_run() {
        assert_eq!(quit_confirm_text(0), None);
        let one = quit_confirm_text(1).expect("asks");
        assert!(one.starts_with("A session is running"), "{one}");
        assert!(one.contains("close the window instead"), "{one}");
        let three = quit_confirm_text(3).expect("asks");
        assert!(three.starts_with("3 sessions are running"), "{three}");
    }

    #[test]
    fn email_paths_match_the_route_table_source() {
        assert!(
            ROUTES_TS.contains("export function emailRouteTable("),
            "packages/capabilities/src/email/routes.ts no longer defines emailRouteTable()"
        );
        for (path, template) in [
            (
                email_settings_path("a-1"),
                "/agents/:agentId/email/settings",
            ),
            (
                email_action_path("a-1", EmailAction::Pause),
                "/agents/:agentId/email/pause",
            ),
            (
                email_action_path("a-1", EmailAction::Resume),
                "/agents/:agentId/email/resume",
            ),
        ] {
            assert!(
                ROUTES_TS.contains(&format!("path: \"{template}\"")),
                "{template} is not in emailRouteTable()"
            );
            assert_eq!(path, template.replace(":agentId", "a-1"));
        }
    }

    /// The desktop control routes (`desktopRouteTable()`), read at compile time.
    const DESKTOP_ROUTES_TS: &str =
        include_str!("../../../../packages/capabilities/src/desktop/routes.ts");
    /// The controller whose `status()` carries `desktopControl` with `active`.
    const DESKTOP_CONTROLLER_TS: &str =
        include_str!("../../../../packages/capabilities/src/desktop/controller.ts");

    #[test]
    fn desktop_paths_and_the_status_field_match_the_capability_source() {
        assert!(DESKTOP_ROUTES_TS.contains("export function desktopRouteTable("));
        for path in [DESKTOP_STATUS_PATH, DESKTOP_REVOKE_PATH] {
            assert!(
                DESKTOP_ROUTES_TS.contains(&format!("path: \"{path}\"")),
                "{path} is not in desktopRouteTable()"
            );
        }
        assert!(
            DESKTOP_CONTROLLER_TS.contains("desktopControl: {")
                && DESKTOP_CONTROLLER_TS.contains("active: this.indicatorActive,"),
            "DesktopController.status() no longer reports desktopControl.active"
        );
    }

    #[test]
    fn external_watch_budget_outlasts_the_misses_it_needs() {
        // Ten misses at (pause + health timeout) each must fit inside the budget, or the
        // Windows path (no pid signal, no request) could never decide "gone".
        let per_probe = EXTERNAL_PROBE_PAUSE + daemon::HEALTH_TIMEOUT;
        assert!(per_probe * crate::restart::MISSES_WITHOUT_REQUEST < EXTERNAL_RESTART_BUDGET);
    }
}
