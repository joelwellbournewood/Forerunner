//! The shell's one piece of state, shared by the tray, the event loops and the supervisor,
//! and the pure derivation of what the tray shows from it (`tray_view`). Everything the tray
//! enables is decided here from facts the daemon reported, never from a guess: the kill switch
//! needs a reachable daemon that is not already frozen, "Pause email" needs the daemon to have
//! answered the email routes, "Update and restart" needs a reachable daemon and no update in
//! flight, and the desktop-control state (spec S.32; ADR 0067) is the last `desktop.indicator`
//! frame or the `desktopControl` the shell re-read from `GET /desktop/status` on reconnect.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use crate::daemon::{DaemonClient, DaemonFile};
use crate::dirs::AppDirs;
use crate::secret::Secret;
use crate::sse::DesktopIndicator;

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

/// Desktop control as the daemon last reported it (spec S.32): on with the application,
/// session and agent it named, or off. The tray shows it while `active`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopControl {
    pub active: bool,
    pub app: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
}

impl DesktopControl {
    /// Take a `desktop.indicator` frame (or the status view read as one): on replaces every
    /// name, off clears them, so an off never leaves a stale application in the tray.
    pub fn apply(&mut self, indicator: &DesktopIndicator) {
        *self = if indicator.on {
            Self {
                active: true,
                app: indicator.app.clone(),
                session_id: indicator.session_id.clone(),
                agent_id: indicator.agent_id.clone(),
            }
        } else {
            Self::default()
        };
    }

    /// "code", or "the desktop" while the controller has not named an application yet.
    pub fn app_label(&self) -> &str {
        self.app.as_deref().unwrap_or("the desktop")
    }
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
    pub desktop: DesktopControl,
    /// The order of what set `desktop` (ADR 0067); see `begin_desktop_read`.
    pub desktop_order: DesktopOrder,
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

/// Every `desktop.indicator` frame (or fresh answer) and every `GET /desktop/status` read
/// started takes the next number; `applied` is the number of what set the state last.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DesktopOrder {
    next: u64,
    applied: u64,
}

impl ShellState {
    /// A frame, or the daemon's answer to a stop: always the newest word, applied at once.
    pub fn apply_desktop_frame(&mut self, indicator: &DesktopIndicator) {
        self.desktop_order.next += 1;
        self.desktop_order.applied = self.desktop_order.next;
        self.desktop.apply(indicator);
    }

    /// A status read starts; pass the token to `apply_desktop_read` with its answer.
    pub fn begin_desktop_read(&mut self) -> u64 {
        self.desktop_order.next += 1;
        self.desktop_order.next
    }

    /// The answer of the read `token` started: applied only if no frame and no later read
    /// landed since it started. The read and the `/events` stream are two connections, so an
    /// answer given before an `on` frame can arrive after it; applying it would clear the
    /// tray for the whole burst (the controller sends no further frame). Returns whether it
    /// was applied.
    pub fn apply_desktop_read(&mut self, token: u64, indicator: &DesktopIndicator) -> bool {
        if token <= self.desktop_order.applied {
            return false;
        }
        self.desktop_order.applied = token;
        self.desktop.apply(indicator);
        true
    }

    pub fn new(dirs: AppDirs, install_id: String, shell_version: String) -> Self {
        Self {
            dirs,
            install_id,
            shell_version,
            client: None,
            status: DaemonStatus::default(),
            email: EmailState::default(),
            desktop: DesktopControl::default(),
            desktop_order: DesktopOrder::default(),
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
    /// The text next to the tray icon where the platform shows one (Linux app indicators):
    /// set only while desktop control is active, so it cannot be missed.
    pub title: Option<String>,
    /// "Desktop control: active (code)" while on, "Desktop control: off" otherwise.
    pub desktop_text: String,
    /// The status item opens the window (where the banner and its stop button are) while on.
    pub desktop_enabled: bool,
    pub desktop_stop_text: String,
    pub desktop_stop_enabled: bool,
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
/// already (the watcher sets `Busy::Updating` while it runs; the tray no longer applies
/// updates, it opens the Updates screen).
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

    // Desktop control is the first thing the tooltip says while it is on (spec S.32). An
    // unreachable daemon keeps the last report on screen, marked as such: hiding it could
    // hide control that is still going on.
    let desktop = &s.desktop;
    let tooltip = if desktop.active {
        let mut head = format!("DESKTOP CONTROL ACTIVE: {}", desktop.app_label());
        if let Some(session) = &desktop.session_id {
            head.push_str(&format!(" (session {session})"));
        }
        if !reachable {
            head.push_str(" — last reported");
        }
        format!("{head}\n{tooltip}")
    } else {
        tooltip
    };
    let title = desktop
        .active
        .then(|| format!("Desktop control active ({})", desktop.app_label()));
    let (desktop_text, desktop_enabled, desktop_stop_text, desktop_stop_enabled) =
        if !desktop.active {
            (
                "Desktop control: off".to_string(),
                false,
                "Stop desktop control (not active)".to_string(),
                false,
            )
        } else if !reachable {
            (
                format!(
                    "Desktop control: last reported active ({}; daemon not reachable)",
                    desktop.app_label()
                ),
                true,
                "Stop desktop control (daemon not reachable)".to_string(),
                false,
            )
        } else {
            (
                format!("Desktop control: active ({})", desktop.app_label()),
                true,
                "Stop desktop control".to_string(),
                true,
            )
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

    // "Updates…" opens the Updates screen; checking and installing are the screen's own
    // buttons (the human's decision of 2026-10-25, ADR 0015 amendment).
    let (update_text, update_enabled) = match s.busy {
        Some(Busy::Updating) => ("Updating and restarting…".to_string(), false),
        Some(Busy::Starting) => ("Updates… (starting)".to_string(), false),
        None if reachable => ("Updates…".to_string(), true),
        None => ("Updates… (daemon not reachable)".to_string(), false),
    };

    TrayView {
        tooltip,
        title,
        desktop_text,
        desktop_enabled,
        desktop_stop_text,
        desktop_stop_enabled,
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
    fn update_item_opens_the_updates_screen_and_never_installs() {
        // The human's decision of 2026-10-25 (ADR 0015 amendment): the tray only opens the
        // Updates screen, where "Check for updates" and "Update and restart" are separate clicks.
        let s = reachable();
        let v = tray_view(&s);
        assert_eq!(v.update_text, "Updates…");
        assert!(v.update_enabled);
        assert!(tray_view(&base()).update_text.starts_with("Updates…"));
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

    fn indicator(on: bool, app: Option<&str>, session: Option<&str>) -> DesktopIndicator {
        DesktopIndicator {
            on,
            app: app.map(str::to_string),
            session_id: session.map(str::to_string),
            agent_id: on.then(|| "agent_a".to_string()),
        }
    }

    /// Spec S.32: the tray shows desktop control while the daemon reports it on (title,
    /// tooltip, the status item and an enabled stop) and clears every trace of it on off.
    #[test]
    fn desktop_control_shows_in_the_tray_while_on_and_clears_on_off() {
        let mut s = reachable();
        let v = tray_view(&s);
        assert_eq!(v.title, None);
        assert_eq!(v.desktop_text, "Desktop control: off");
        assert!(!v.desktop_enabled && !v.desktop_stop_enabled);
        assert_eq!(v.tooltip, "Forerunner 0.1.0 — 2 running sessions");

        s.desktop
            .apply(&indicator(true, Some("code"), Some("sess_1")));
        let v = tray_view(&s);
        assert_eq!(v.title.as_deref(), Some("Desktop control active (code)"));
        assert_eq!(v.desktop_text, "Desktop control: active (code)");
        assert!(v.desktop_enabled);
        assert_eq!(v.desktop_stop_text, "Stop desktop control");
        assert!(v.desktop_stop_enabled);
        assert_eq!(
            v.tooltip,
            "DESKTOP CONTROL ACTIVE: code (session sess_1)\nForerunner 0.1.0 — 2 running sessions"
        );
        // The rest of the menu is unchanged by it.
        assert!(v.kill_enabled && v.update_enabled);

        s.desktop.apply(&indicator(false, None, None));
        assert_eq!(s.desktop, DesktopControl::default());
        let v = tray_view(&s);
        assert_eq!(v.title, None);
        assert_eq!(v.desktop_text, "Desktop control: off");
        assert!(!v.desktop_stop_enabled);
        assert!(!v.tooltip.contains("DESKTOP CONTROL"));
    }

    #[test]
    fn desktop_control_without_an_app_says_the_desktop_and_a_new_on_replaces_the_names() {
        let mut s = reachable();
        s.desktop.apply(&indicator(true, None, None));
        let v = tray_view(&s);
        assert_eq!(v.desktop_text, "Desktop control: active (the desktop)");
        assert_eq!(
            v.title.as_deref(),
            Some("Desktop control active (the desktop)")
        );
        assert!(
            v.tooltip
                .starts_with("DESKTOP CONTROL ACTIVE: the desktop\n")
        );
        s.desktop
            .apply(&indicator(true, Some("gimp"), Some("sess_2")));
        assert_eq!(s.desktop.app.as_deref(), Some("gimp"));
        assert_eq!(s.desktop.session_id.as_deref(), Some("sess_2"));
        assert_eq!(tray_view(&s).desktop_text, "Desktop control: active (gimp)");
    }

    #[test]
    fn desktop_control_stays_visible_but_not_stoppable_while_the_daemon_is_unreachable() {
        let mut s = reachable();
        s.desktop
            .apply(&indicator(true, Some("code"), Some("sess_1")));
        s.status.reachable = false;
        let v = tray_view(&s);
        assert!(v.title.is_some());
        assert!(v.desktop_text.contains("last reported active (code"));
        assert!(!v.desktop_stop_enabled);
        assert!(
            v.tooltip
                .starts_with("DESKTOP CONTROL ACTIVE: code (session sess_1) — last reported\n")
        );
        assert!(v.tooltip.ends_with("daemon not reachable"));
    }

    /// ADR 0067: the status re-read on reconnect never overwrites a newer frame.
    #[test]
    fn a_desktop_status_read_never_overwrites_a_newer_frame() {
        let mut s = reachable();
        // The stream opens: the re-read starts while control is off ...
        let read = s.begin_desktop_read();
        // ... the agent's first action sends `on` on the stream, which arrives first ...
        s.apply_desktop_frame(&indicator(true, Some("code"), Some("sess_1")));
        // ... and the answer, given before the action, lands last: dropped.
        assert!(!s.apply_desktop_read(read, &indicator(false, None, None)));
        assert!(s.desktop.active);
        assert_eq!(tray_view(&s).desktop_text, "Desktop control: active (code)");

        // A read started after the frame lands (a missed off on a reconnect).
        let read = s.begin_desktop_read();
        assert!(s.apply_desktop_read(read, &indicator(false, None, None)));
        assert!(!s.desktop.active);

        // Two reads in flight: the later one wins, whichever answer lands first.
        let first = s.begin_desktop_read();
        let second = s.begin_desktop_read();
        assert!(s.apply_desktop_read(second, &indicator(true, Some("gimp"), None)));
        assert!(!s.apply_desktop_read(first, &indicator(false, None, None)));
        assert_eq!(s.desktop.app.as_deref(), Some("gimp"));
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
