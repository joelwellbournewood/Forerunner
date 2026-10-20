//! The shell's one piece of state, shared by the tray, the event loops and the supervisor,
//! and the pure derivation of what the tray shows from it (`tray_view`). Everything the tray
//! enables is decided here from facts the daemon reported, never from a guess: the kill switch
//! needs a reachable daemon that is not already frozen, "Pause email" needs the daemon to have
//! answered the email routes, "Update and restart" needs a reachable daemon and no update in
//! flight.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use crate::daemon::{DaemonClient, DaemonFile};
use crate::dirs::AppDirs;
use crate::secret::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailAction {
    Pause,
    Resume,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmailState {
    /// The daemon answered `GET /agents/:id/email/settings` (the routes of
    /// `packages/capabilities/src/email`).
    pub available: bool,
    pub agent_id: Option<String>,
    pub paused: Option<bool>,
    /// Why it is not available, for the menu text.
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamMode {
    #[default]
    Off,
    Connecting,
    Live,
    Reconnecting,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DaemonStatus {
    pub reachable: bool,
    pub version: String,
    pub kill_active: bool,
    pub active_sessions: u64,
    pub blocking_count: u64,
    pub last_error: Option<String>,
    /// Consecutive failed health probes.
    pub failures: u32,
}

#[derive(Debug, Clone, Default)]
pub struct RestartCycle {
    /// Relaunches since the daemon last stayed healthy for `restart::STABLE_AFTER_SECS`.
    pub consecutive: u32,
    pub healthy_since: Option<Instant>,
    /// "Update and restart" was accepted: the next exit is expected.
    pub expected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Starting,
    Updating,
}

#[derive(Debug)]
pub struct ShellState {
    pub dirs: AppDirs,
    pub install_id: String,
    pub shell_version: String,
    pub client: Option<DaemonClient>,
    pub status: DaemonStatus,
    pub email: EmailState,
    pub stream: StreamMode,
    pub restart: RestartCycle,
    /// Set when the shell started the daemon itself (the supervisor thread waits on it).
    pub child_pid: Option<u32>,
    pub busy: Option<Busy>,
    /// The `daemon.json` the shell attached to last; freshness is judged against it.
    pub last_file: Option<DaemonFile>,
    /// What the main window was built with; a different url or token rebuilds the window.
    pub injected: Option<(String, Secret)>,
    pub loops_started: bool,
    pub window_saved_at: Option<Instant>,
    /// The daemon stopped on purpose or gave up: do not attach again until the human asks.
    pub halted: bool,
}

impl ShellState {
    pub fn new(dirs: AppDirs, install_id: String, shell_version: String) -> Self {
        Self {
            dirs,
            install_id,
            shell_version,
            client: None,
            status: DaemonStatus::default(),
            email: EmailState::default(),
            stream: StreamMode::Off,
            restart: RestartCycle::default(),
            child_pid: None,
            busy: None,
            last_file: None,
            injected: None,
            loops_started: false,
            window_saved_at: None,
            halted: false,
        }
    }
}

pub type SharedState = Arc<Mutex<ShellState>>;

/// Lock without panicking on a poisoned mutex: the state is plain data, so the last write
/// before a panic elsewhere is still the best information available.
pub fn lock(state: &SharedState) -> MutexGuard<'_, ShellState> {
    state.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the tray menu shows: text and enabled flag per item, plus the icon tooltip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub tooltip: String,
    pub kill_text: String,
    pub kill_enabled: bool,
    pub resume_text: String,
    pub resume_enabled: bool,
    pub email_text: String,
    pub email_enabled: bool,
    pub email_action: Option<EmailAction>,
    pub update_text: String,
    pub update_enabled: bool,
}

/// Whether a `restart.requested` event must start the shell's own watch for the daemon to
/// go away (`actions::watch_external_restart`): only for a daemon the shell did not start (a
/// child reports its exit to the supervisor thread) and only when nothing is watching it
/// already ("Update and restart" from the tray sets `Busy::Updating` before it posts).
pub fn needs_external_watch(child_pid: Option<u32>, busy: Option<Busy>) -> bool {
    child_pid.is_none() && busy.is_none()
}

pub fn tray_view(s: &ShellState) -> TrayView {
    let reachable = s.status.reachable;
    let tooltip = if let Some(Busy::Starting) = s.busy {
        "Forerunner — starting the daemon…".to_string()
    } else if let Some(Busy::Updating) = s.busy {
        "Forerunner — updating and restarting…".to_string()
    } else if !reachable {
        if s.halted {
            "Forerunner — daemon stopped (Open starts it)".to_string()
        } else {
            "Forerunner — daemon not reachable".to_string()
        }
    } else {
        let mut t = format!(
            "Forerunner {} — {} running session{}",
            s.status.version,
            s.status.active_sessions,
            if s.status.active_sessions == 1 {
                ""
            } else {
                "s"
            }
        );
        if s.status.blocking_count > 0 {
            t.push_str(&format!(", {} waiting on you", s.status.blocking_count));
        }
        if s.status.kill_active {
            t.push_str("; kill switch active");
        }
        if s.email.paused == Some(true) {
            t.push_str("; email paused");
        }
        t
    };

    let (kill_text, kill_enabled, resume_text, resume_enabled) = if !reachable {
        (
            "Kill switch: stop everything (daemon not reachable)".to_string(),
            false,
            "Resume".to_string(),
            false,
        )
    } else if s.status.kill_active {
        (
            "Kill switch: active".to_string(),
            false,
            "Resume".to_string(),
            true,
        )
    } else {
        (
            "Kill switch: stop everything".to_string(),
            true,
            "Resume (nothing is stopped)".to_string(),
            false,
        )
    };

    let (email_text, email_enabled, email_action) = if !reachable {
        (
            "Pause email (daemon not reachable)".to_string(),
            false,
            None,
        )
    } else if !s.email.available {
        (
            format!(
                "Pause email (not available: {})",
                if s.email.reason.is_empty() {
                    "no email routes"
                } else {
                    &s.email.reason
                }
            ),
            false,
            None,
        )
    } else {
        match s.email.paused {
            Some(true) => ("Resume email".to_string(), true, Some(EmailAction::Resume)),
            Some(false) => ("Pause email".to_string(), true, Some(EmailAction::Pause)),
            None => ("Pause email (state unknown)".to_string(), false, None),
        }
    };

    let (update_text, update_enabled) = match s.busy {
        Some(Busy::Updating) => ("Updating and restarting…".to_string(), false),
        Some(Busy::Starting) => ("Update and restart (starting)".to_string(), false),
        None if reachable => ("Update and restart".to_string(), true),
        None => (
            "Update and restart (daemon not reachable)".to_string(),
            false,
        ),
    };

    TrayView {
        tooltip,
        kill_text,
        kill_enabled,
        resume_text,
        resume_enabled,
        email_text,
        email_enabled,
        email_action,
        update_text,
        update_enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dirs::{AppDirsOptions, Platform, app_dirs};
    use crate::env::MapEnv;

    fn base() -> ShellState {
        let dirs = app_dirs(
            &MapEnv::new(&[("FORERUNNER_HOME", "/tmp/fr")]),
            &AppDirsOptions {
                platform: Some(Platform::Linux),
                cwd: Some("/".into()),
                ..Default::default()
            },
        );
        ShellState::new(dirs, "id".into(), "0.1.0".into())
    }

    fn reachable() -> ShellState {
        let mut s = base();
        s.status.reachable = true;
        s.status.version = "0.1.0".into();
        s.status.active_sessions = 2;
        s
    }

    #[test]
    fn unreachable_daemon_disables_every_action() {
        let v = tray_view(&base());
        assert!(!v.kill_enabled && !v.resume_enabled && !v.email_enabled && !v.update_enabled);
        assert!(v.kill_text.contains("not reachable"));
        assert_eq!(v.tooltip, "Forerunner — daemon not reachable");
        let mut halted = base();
        halted.halted = true;
        assert!(tray_view(&halted).tooltip.contains("stopped"));
    }

    #[test]
    fn kill_switch_and_resume_follow_kill_active() {
        let s = reachable();
        let v = tray_view(&s);
        assert!(v.kill_enabled);
        assert_eq!(v.kill_text, "Kill switch: stop everything");
        assert!(!v.resume_enabled);
        assert_eq!(v.tooltip, "Forerunner 0.1.0 — 2 running sessions");
        let mut frozen = reachable();
        frozen.status.kill_active = true;
        frozen.status.active_sessions = 1;
        frozen.status.blocking_count = 3;
        let v = tray_view(&frozen);
        assert!(!v.kill_enabled);
        assert!(v.resume_enabled);
        assert_eq!(v.resume_text, "Resume");
        assert_eq!(
            v.tooltip,
            "Forerunner 0.1.0 — 1 running session, 3 waiting on you; kill switch active"
        );
    }

    #[test]
    fn email_item_needs_the_routes_and_toggles() {
        let mut s = reachable();
        s.email.reason = "the daemon has no email routes yet".into();
        let v = tray_view(&s);
        assert!(!v.email_enabled);
        assert_eq!(v.email_action, None);
        assert!(v.email_text.contains("no email routes yet"));
        s.email.available = true;
        s.email.paused = Some(false);
        let v = tray_view(&s);
        assert!(v.email_enabled);
        assert_eq!(v.email_text, "Pause email");
        assert_eq!(v.email_action, Some(EmailAction::Pause));
        s.email.paused = Some(true);
        let v = tray_view(&s);
        assert_eq!(v.email_text, "Resume email");
        assert_eq!(v.email_action, Some(EmailAction::Resume));
        assert!(v.tooltip.ends_with("; email paused"));
        s.email.paused = None;
        assert!(!tray_view(&s).email_enabled);
    }

    #[test]
    fn update_item_follows_busy_state() {
        let mut s = reachable();
        assert!(tray_view(&s).update_enabled);
        s.busy = Some(Busy::Updating);
        let v = tray_view(&s);
        assert!(!v.update_enabled);
        assert_eq!(v.tooltip, "Forerunner — updating and restarting…");
        s.busy = Some(Busy::Starting);
        assert!(!tray_view(&s).update_enabled);
        assert_eq!(tray_view(&s).tooltip, "Forerunner — starting the daemon…");
    }

    /// A restart announced over `/events` for a daemon the shell did not start (the human
    /// pressed "Update and restart" in the UI) needs the shell to watch it go away; a child
    /// is watched by the supervisor thread, and the tray's own update already watches.
    #[test]
    fn restart_announcements_start_a_watch_only_for_an_unwatched_external_daemon() {
        assert!(needs_external_watch(None, None));
        assert!(!needs_external_watch(Some(10), None));
        assert!(!needs_external_watch(None, Some(Busy::Updating)));
        assert!(!needs_external_watch(None, Some(Busy::Starting)));
    }

    #[test]
    fn state_debug_hides_the_injected_token() {
        let mut s = reachable();
        let mut t = String::from("tra"); // not-a-secret
        t.push_str("y_0123456789abcdefghijklmnopqrstuvwxyz"); // not-a-secret
        s.injected = Some(("http://127.0.0.1:1".into(), Secret::new(t.clone())));
        assert!(!format!("{s:?}").contains(&t));
    }
}
