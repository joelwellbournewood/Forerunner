//! The shell's own subscription to `GET /events` (ADR 0031) and the health monitor.
//!
//! The stream is read from Rust with the token in the `Authorization` header: it keeps
//! working while the window is hidden in the tray (a hidden webview may be throttled), the
//! token never goes into a URL, and the tray learns kill-switch, inbox and desktop-control
//! changes from the same source (`desktop.indicator`, spec S.32; ADR 0067: every (re)opened
//! stream re-reads `GET /desktop/status`, since frames sent while it was down are lost). `notification` events become OS notifications exactly as received: quiet
//! hours and channel choice are the daemon's decision (spec K.8, phase 5).

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::actions::{self, shared};
use crate::restart::STABLE_AFTER_SECS;
use crate::secret::redact;
use crate::sse::{DaemonEvent, SseParser, parse_daemon_event};
use crate::state::{StreamMode, lock, needs_external_watch};
use crate::tray;

pub const MONITOR_INTERVAL: Duration = Duration::from_secs(10);
/// Failed probes before the daemon counts as unreachable.
pub const FAILURES_BEFORE_UNREACHABLE: u32 = 3;
pub const MIN_BACKOFF: Duration = Duration::from_secs(1);
pub const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// How long to wait before reopening `/events`, and the backoff to carry forward. A stream
/// that delivered at least one frame was a working connection: the next attempt waits the
/// minimum and the backoff resets. A stream that ended (or never opened) without a frame
/// waits the current backoff, which then doubles up to `MAX_BACKOFF`, so a daemon that
/// answers 200 and closes at once is never hammered in a tight loop.
pub fn reconnect_delay(backoff: Duration, delivered_frames: bool) -> (Duration, Duration) {
    if delivered_frames {
        (MIN_BACKOFF, MIN_BACKOFF)
    } else {
        let wait = backoff.clamp(MIN_BACKOFF, MAX_BACKOFF);
        (wait, (wait * 2).min(MAX_BACKOFF))
    }
}

/// Start the stream and monitor loops once per process.
pub fn ensure_loops(app: &AppHandle) {
    let state = shared(app);
    {
        let mut s = lock(&state);
        if s.loops_started {
            return;
        }
        s.loops_started = true;
    }
    tauri::async_runtime::spawn(run_events(app.clone()));
    tauri::async_runtime::spawn(run_monitor(app.clone()));
}

fn set_stream(app: &AppHandle, mode: StreamMode) {
    let state = shared(app);
    let mut s = lock(&state);
    s.stream = mode;
}

async fn run_events(app: AppHandle) {
    let mut backoff = MIN_BACKOFF;
    loop {
        let client = lock(&shared(&app)).client.clone();
        let Some(client) = client else {
            set_stream(&app, StreamMode::Off);
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        set_stream(&app, StreamMode::Connecting);
        let mut delivered = false;
        match client.open_events().await {
            Ok(res) => {
                set_stream(&app, StreamMode::Live);
                log::info!("subscribed to /events");
                tauri::async_runtime::spawn(actions::probe_desktop(app.clone()));
                let mut parser = SseParser::new();
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    match chunk {
                        Ok(bytes) => {
                            // Raw bytes: a chunk may end inside a multi-byte character.
                            for frame in parser.feed_bytes(&bytes) {
                                delivered = true;
                                if let Some(event) = parse_daemon_event(&frame) {
                                    handle_event(&app, event);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!(
                                "/events stream ended: {}",
                                redact(&e.to_string(), &[client.token()])
                            );
                            break;
                        }
                    }
                    // The daemon changed under us (restart, re-attach): resubscribe.
                    let same = lock(&shared(&app))
                        .client
                        .as_ref()
                        .map(|c| c.base_url() == client.base_url())
                        .unwrap_or(false);
                    if !same {
                        break;
                    }
                }
                for frame in parser.end() {
                    delivered = true;
                    if let Some(event) = parse_daemon_event(&frame) {
                        handle_event(&app, event);
                    }
                }
                set_stream(&app, StreamMode::Reconnecting);
            }
            Err(e) => {
                set_stream(&app, StreamMode::Reconnecting);
                log::warn!("/events not available: {e}");
            }
        }
        let (wait, next) = reconnect_delay(backoff, delivered);
        backoff = next;
        log::info!("reopening /events in {} s", wait.as_secs());
        tokio::time::sleep(wait).await;
    }
}

fn handle_event(app: &AppHandle, event: DaemonEvent) {
    match event {
        DaemonEvent::Notification(n) => {
            log::info!("notification from the daemon (level {})", n.level);
            if let Err(e) = app
                .notification()
                .builder()
                .title(n.title)
                .body(n.body)
                .show()
            {
                log::warn!("notification not shown: {e}");
            }
        }
        DaemonEvent::RestartRequested {
            reason,
            target_version,
            ..
        } => {
            log::info!("daemon announced a restart ({reason} to {target_version})");
            let state = shared(app);
            let watch = {
                let mut s = lock(&state);
                s.restart.expected = true;
                needs_external_watch(s.child_pid, s.busy)
            };
            if watch {
                // Not the shell's process and nobody is watching it yet (an apply or rollback
                // from the Updates screen): watch it go away and apply the restart contract, so
                // the window is rebuilt with the relaunched daemon's token instead of
                // keeping a stale one until Quit.
                tauri::async_runtime::spawn(actions::watch_external_restart(app.clone()));
            }
        }
        DaemonEvent::InboxChanged { blocking_count } => {
            let state = shared(app);
            let mut s = lock(&state);
            s.status.blocking_count = blocking_count;
            drop(s);
            tray::refresh(app);
        }
        DaemonEvent::DesktopIndicator(indicator) => {
            log::info!(
                "desktop control {}",
                if indicator.on { "active" } else { "ended" }
            );
            let state = shared(app);
            let mut s = lock(&state);
            s.apply_desktop_frame(&indicator);
            drop(s);
            tray::refresh(app);
        }
        DaemonEvent::Heartbeat | DaemonEvent::Other(_) => {}
    }
}

/// Every `MONITOR_INTERVAL`: refresh the tray from `/health`; after
/// `FAILURES_BEFORE_UNREACHABLE` misses mark the daemon unreachable and, when the daemon was
/// not the shell's own process and no restart is expected, look for a new `daemon.json`
/// (a user service may have relaunched it) without starting one.
async fn run_monitor(app: AppHandle) {
    loop {
        tokio::time::sleep(MONITOR_INTERVAL).await;
        let state = shared(&app);
        let (client, is_child, expected, busy) = {
            let s = lock(&state);
            (
                s.client.clone(),
                s.child_pid.is_some(),
                s.restart.expected,
                s.busy.is_some(),
            )
        };
        let Some(client) = client else {
            continue;
        };
        if busy {
            continue;
        }
        match client.health().await {
            Ok(h) => {
                let was_unreachable = {
                    let mut s = lock(&state);
                    let was_unreachable = !s.status.reachable;
                    s.status.reachable = true;
                    s.status.version = h.version;
                    s.status.kill_active = h.kill_active;
                    s.status.active_sessions = h.active_sessions;
                    s.status.last_error = None;
                    s.status.failures = 0;
                    let since = *s.restart.healthy_since.get_or_insert_with(Instant::now);
                    if s.restart.consecutive > 0 && since.elapsed().as_secs() >= STABLE_AFTER_SECS {
                        log::info!("the daemon stayed healthy; restart budget reset");
                        s.restart.consecutive = 0;
                    }
                    was_unreachable
                };
                tray::refresh(&app);
                if was_unreachable {
                    actions::probe_email(app.clone()).await;
                }
            }
            Err(e) => {
                let failures = {
                    let mut s = lock(&state);
                    s.status.failures += 1;
                    s.status.last_error = Some(e.clone());
                    let failures = s.status.failures;
                    if failures >= FAILURES_BEFORE_UNREACHABLE {
                        s.status.reachable = false;
                        s.restart.healthy_since = None;
                    }
                    failures
                };
                tray::refresh(&app);
                log::warn!("/health failed ({failures}): {e}");
                if failures >= FAILURES_BEFORE_UNREACHABLE && !is_child && !expected {
                    // Attach only; never start a daemon on the monitor's own initiative.
                    actions::bootstrap(app.clone(), false).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_that_ends_without_a_frame_backs_off_and_a_working_one_resets() {
        let (wait, next) = reconnect_delay(MIN_BACKOFF, false);
        assert_eq!(wait, MIN_BACKOFF, "a 200 that closes at once still waits");
        assert_eq!(next, MIN_BACKOFF * 2);
        let (wait, next) = reconnect_delay(next, false);
        assert_eq!(wait, Duration::from_secs(2));
        assert_eq!(next, Duration::from_secs(4));
        let (wait, next) = reconnect_delay(Duration::from_secs(16), false);
        assert_eq!(wait, MAX_BACKOFF);
        assert_eq!(next, MAX_BACKOFF);
        let (wait, next) = reconnect_delay(MAX_BACKOFF, true);
        assert_eq!(wait, MIN_BACKOFF);
        assert_eq!(next, MIN_BACKOFF);
        let (wait, _) = reconnect_delay(Duration::ZERO, false);
        assert_eq!(wait, MIN_BACKOFF, "never a zero wait");
    }
}
