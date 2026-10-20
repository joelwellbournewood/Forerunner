//! What the shell does: attach to or start the daemon, react to its exit, and the tray
//! actions (kill switch, resume, pause email, update and restart). Every action talks to the
//! daemon through `DaemonClient`; nothing here enforces a limit on its own, the daemon does.

use std::time::Instant;

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
use crate::install::{RealFs, locate_fr};
use crate::restart::{ExitAction, decide_after_exit, read_restart_request, remove_restart_request};
use crate::state::{Busy, EmailAction, SharedState, StreamMode, lock};
use crate::supervisor::{
    EXTERNAL_GRACE, daemon_log_path, spawn_daemon, wait_for_daemon, wait_for_external, watch_exit,
};
use crate::{events, tray, windows};

pub fn shared(app: &AppHandle) -> SharedState {
    app.state::<SharedState>().inner().clone()
}

fn notify(app: &AppHandle, title: &str, body: &str) {
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
    let (dirs, previous) = {
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
    let alive = file
        .as_ref()
        .ok()
        .and_then(|f| f.pid)
        .and_then(daemon::pid_alive);
    let decision = match daemon::precheck(file, alive) {
        Ok(file) => match DaemonClient::from_file(&file) {
            Ok(client) => {
                let health = client.health().await;
                daemon::decide(file, health)
            }
            Err(reason) => AttachDecision::Start { reason },
        },
        Err(reason) => AttachDecision::Start { reason },
    };

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
                previous.as_ref(),
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

/// The daemon process the shell started has ended: apply the restart contract.
pub fn handle_daemon_exit(app: AppHandle, code: Option<i32>) {
    tauri::async_runtime::spawn(async move {
        let state = shared(&app);
        let (dirs, consecutive, previous) = {
            let mut s = lock(&state);
            s.client = None;
            s.child_pid = None;
            s.status.reachable = false;
            s.stream = StreamMode::Off;
            s.busy = None;
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
                        code.map(|c| format!("code {c}"))
                            .unwrap_or_else(|| "by a signal".into()),
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

/// The email routes the tray uses, as `emailRouteTable()` in
/// `packages/capabilities/src/email/routes.ts` names them (`:agentId` filled in). The probe
/// reads the settings route; pause and resume are the toggle. A test checks these paths
/// against the route table's source so a rename there breaks the shell's build, not the tray.
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

/// Tray: "Update and restart" (spec M). Confirms, `POST /updates/apply`, then waits for the
/// daemon to exit with the restart contract. A daemon the shell started reports its exit to
/// `handle_daemon_exit`; a daemon started by something else is watched through `/health`.
pub fn update_and_restart(app: AppHandle) {
    let app2 = app.clone();
    app.dialog()
        .message("Install the staged update and restart the daemon? Running sessions are stopped and resume afterwards; the UI reloads.")
        .title("Forerunner: update and restart")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update and restart".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            tauri::async_runtime::spawn(apply_update(app2));
        });
}

async fn apply_update(app: AppHandle) {
    let state = shared(&app);
    let (client, is_child, dirs) = {
        let mut s = lock(&state);
        let Some(c) = s.client.clone() else {
            return;
        };
        s.busy = Some(Busy::Updating);
        s.restart.expected = true;
        (c, s.child_pid.is_some(), s.dirs.clone())
    };
    tray::refresh(&app);
    match client.post_json("/updates/apply", &json!({})).await {
        Ok((status, v)) if (200..300).contains(&status) => {
            log::info!("update accepted: {}", v);
            notify(
                &app,
                "Forerunner is updating",
                "The daemon restarts in a moment; the window reloads when it is back.",
            );
            if is_child {
                // handle_daemon_exit takes over when the process ends.
                return;
            }
            // Not our process: wait for it to go away, then apply the same contract with the
            // exit code the request names.
            let started = Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if client.health().await.is_err() {
                    let code = read_restart_request(&dirs.runtime)
                        .and_then(|r| r.exit_code)
                        .or(Some(crate::restart::RESTART_EXIT_CODES[0]));
                    handle_daemon_exit(app.clone(), code);
                    return;
                }
                if started.elapsed() > std::time::Duration::from_secs(90) {
                    {
                        let mut s = lock(&state);
                        s.busy = None;
                        s.restart.expected = false;
                    }
                    fail_dialog(
                        &app,
                        "Update did not restart the daemon",
                        "The daemon accepted the update but kept running for 90 s. Check the updates screen and the daemon log.",
                    );
                    return;
                }
            }
        }
        Ok((status, v)) => {
            {
                let mut s = lock(&state);
                s.busy = None;
                s.restart.expected = false;
            }
            fail_dialog(&app, "Update not applied", &error_message(status, &v));
        }
        Err(e) => {
            {
                let mut s = lock(&state);
                s.busy = None;
                s.restart.expected = false;
            }
            fail_dialog(&app, "Update not applied", &e);
        }
    }
}
