//! The restart contract (ADR 0026, ADR 0029, spec M): "Update and restart" makes the daemon
//! write `<runtime>/restart.json` and exit with the code the file names (`RESTART_EXIT_CODE`,
//! 86 in `packages/runtime/src/daemon/restart.ts`; ADR 0026's text says 75, so both are
//! accepted when the file carries no code). The shell relaunches `fr daemon` once per request;
//! a relaunched build that rolls back (its own health check failed) gets one more relaunch
//! into the previous version; anything beyond that, and any other exit code, is a failure the
//! human sees as a dialog with the log path. The decision is `decide_after_exit`, pure and
//! tested; the supervisor applies it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::events::FAILURES_BEFORE_UNREACHABLE;

pub const RESTART_REQUEST_FILE: &str = "restart.json";
/// Accepted when `restart.json` carries no `exitCode`: 86 is the runtime's constant, 75 the
/// number ADR 0026 wrote down.
pub const RESTART_EXIT_CODES: &[i32] = &[86, 75];
/// Automatic relaunches per request before the shell gives up.
pub const MAX_RESTARTS: u32 = 1;
/// A relaunched daemon must stay healthy this long before the restart counter resets, so a
/// build that boots, answers `/health` and dies again cannot loop.
pub const STABLE_AFTER_SECS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartRequest {
    pub reason: String,
    pub target_version: String,
    pub from_version: Option<String>,
    pub requested_at: Option<String>,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}

/// Mirrors `readRestartRequest`: `schema` must be 1 and `targetVersion` a string; anything
/// else is "no request".
pub fn parse_restart_request(text: &str) -> Option<RestartRequest> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let target_version = v.get("targetVersion").and_then(Value::as_str)?.to_string();
    Some(RestartRequest {
        reason: v
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("update")
            .to_string(),
        target_version,
        from_version: v
            .get("fromVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        requested_at: v
            .get("requestedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        pid: v
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|p| u32::try_from(p).ok()),
        // `exitCode: 0` cannot mean "relaunch me" (0 is a clean stop); it reads as "no code".
        exit_code: v
            .get("exitCode")
            .and_then(Value::as_i64)
            .and_then(|c| i32::try_from(c).ok())
            .filter(|c| *c != 0),
    })
}

pub fn restart_request_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(RESTART_REQUEST_FILE)
}

pub fn read_restart_request(runtime_dir: &Path) -> Option<RestartRequest> {
    let text = std::fs::read_to_string(restart_request_path(runtime_dir)).ok()?;
    parse_restart_request(&text)
}

/// The shell removes the request once it has acted on it (ADR 0029).
pub fn remove_restart_request(runtime_dir: &Path) {
    let _ = std::fs::remove_file(restart_request_path(runtime_dir));
}

pub fn is_restart_exit(code: i32, request: &RestartRequest) -> bool {
    match request.exit_code {
        Some(expected) => code == expected,
        None => RESTART_EXIT_CODES.contains(&code),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitAction {
    /// Relaunch `fr daemon`; `reason` is the request's reason (update, rollback).
    Restart { reason: String },
    /// A restart was requested but the budget is spent: show the dialog, keep the request
    /// file for the human.
    GiveUp { reason: String },
    /// Any other non-zero exit (or a signal): show the dialog with the log path.
    Crashed { code: Option<i32> },
    /// Exit code 0: stopped on purpose (`fr kill`, a service stop). No dialog.
    Stopped,
}

/// `code` is `None` when the process ended by a signal. `consecutive_restarts` counts the
/// relaunches since the daemon was last healthy for `STABLE_AFTER_SECS`.
pub fn decide_after_exit(
    code: Option<i32>,
    request: Option<&RestartRequest>,
    consecutive_restarts: u32,
) -> ExitAction {
    if let (Some(c), Some(req)) = (code, request)
        && is_restart_exit(c, req)
    {
        if consecutive_restarts < MAX_RESTARTS {
            return ExitAction::Restart {
                reason: req.reason.clone(),
            };
        }
        // The relaunched build failed its health check and the daemon rolled back: the
        // previous version deserves its one relaunch too.
        if consecutive_restarts == MAX_RESTARTS && req.reason == "rollback" {
            return ExitAction::Restart {
                reason: req.reason.clone(),
            };
        }
        return ExitAction::GiveUp {
            reason: format!(
                "the daemon asked for a restart ({}) {} time(s) in a row without staying up",
                req.reason,
                consecutive_restarts + 1
            ),
        };
    }
    match code {
        Some(0) => ExitAction::Stopped,
        other => ExitAction::Crashed { code: other },
    }
}

/// Missed `/health` probes after which a daemon the shell did not start counts as gone even
/// though it wrote no restart request and the OS gives no pid signal (Windows): about 25 s
/// with the 1 s pause and 1.5 s timeout per probe, long enough to stage an update.
pub const MISSES_WITHOUT_REQUEST: u32 = 10;

/// Whether a daemon the shell did not start has gone away after "Update and restart", so the
/// restart contract may be applied to it. One missed probe is not an exit: the daemon may be
/// busy staging the update (download, verify, unpack) and still answer later; relaunching
/// beside it would leave two daemons writing `daemon.json`. The signals, in order: a pid the
/// OS reports dead is definitive; a pid reported alive is waited for; without a pid signal,
/// `FAILURES_BEFORE_UNREACHABLE` consecutive misses together with the restart request the
/// daemon writes right before it exits, or `MISSES_WITHOUT_REQUEST` misses on their own.
pub fn external_daemon_gone(
    consecutive_misses: u32,
    pid_alive: Option<bool>,
    request_present: bool,
) -> bool {
    if consecutive_misses == 0 {
        return false;
    }
    match pid_alive {
        Some(false) => true,
        Some(true) => false,
        None => {
            (request_present && consecutive_misses >= FAILURES_BEFORE_UNREACHABLE)
                || consecutive_misses >= MISSES_WITHOUT_REQUEST
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(reason: &str, exit_code: Option<i32>) -> RestartRequest {
        RestartRequest {
            reason: reason.into(),
            target_version: "0.2.0".into(),
            from_version: Some("0.1.0".into()),
            requested_at: Some("2026-10-20T10:00:00.000Z".into()),
            pid: Some(10),
            exit_code,
        }
    }

    #[test]
    fn parses_the_file_the_daemon_restarter_writes() {
        let text = r#"{"schema":1,"reason":"update","targetVersion":"0.2.0","fromVersion":"0.1.0","requestedAt":"2026-10-20T10:00:00.000Z","pid":10,"exitCode":86}"#;
        assert_eq!(
            parse_restart_request(text),
            Some(request("update", Some(86)))
        );
        assert_eq!(
            parse_restart_request(r#"{"schema":2,"targetVersion":"x"}"#),
            None
        );
        assert_eq!(parse_restart_request(r#"{"schema":1}"#), None);
        assert_eq!(parse_restart_request("garbage"), None);
        let minimal = parse_restart_request(r#"{"schema":1,"targetVersion":"0.2.0"}"#).unwrap();
        assert_eq!(minimal.reason, "update");
        assert_eq!(minimal.exit_code, None);
        // Exit code 0 can never mean "relaunch me": it reads as "no code given".
        let zero =
            parse_restart_request(r#"{"schema":1,"targetVersion":"0.2.0","exitCode":0}"#).unwrap();
        assert_eq!(zero.exit_code, None);
        assert_eq!(
            decide_after_exit(Some(0), Some(&zero), 0),
            ExitAction::Stopped
        );
        assert!(matches!(
            decide_after_exit(Some(86), Some(&zero), 0),
            ExitAction::Restart { .. }
        ));
    }

    /// A daemon the shell did not start is "gone" only on a definitive signal: a pid known
    /// dead, or (where the OS gives no pid signal) several missed probes together with the
    /// restart request it writes before exiting; a slow daemon that misses one probe while it
    /// stages the update is never relaunched beside itself.
    #[test]
    fn external_daemon_needs_a_definitive_signal_before_it_counts_as_gone() {
        assert!(!external_daemon_gone(1, None, false));
        assert!(!external_daemon_gone(1, None, true));
        assert!(!external_daemon_gone(FAILURES_BEFORE_UNREACHABLE - 1, None, true));
        assert!(external_daemon_gone(FAILURES_BEFORE_UNREACHABLE, None, true));
        assert!(!external_daemon_gone(FAILURES_BEFORE_UNREACHABLE, None, false));
        assert!(!external_daemon_gone(MISSES_WITHOUT_REQUEST - 1, None, false));
        assert!(external_daemon_gone(MISSES_WITHOUT_REQUEST, None, false));
        // A process known alive is waited for, however many probes it misses.
        assert!(!external_daemon_gone(MISSES_WITHOUT_REQUEST * 2, Some(true), true));
        // A process known dead is gone after the first miss, request or not.
        assert!(external_daemon_gone(1, Some(false), false));
        assert!(external_daemon_gone(1, Some(false), true));
        assert!(!external_daemon_gone(0, Some(false), true), "no miss yet");
    }

    #[test]
    fn restart_exit_follows_the_file_then_the_known_codes() {
        assert!(is_restart_exit(86, &request("update", Some(86))));
        assert!(!is_restart_exit(75, &request("update", Some(86))));
        assert!(is_restart_exit(86, &request("update", None)));
        assert!(is_restart_exit(75, &request("update", None)));
        assert!(!is_restart_exit(1, &request("update", None)));
    }

    #[test]
    fn first_restart_is_taken_second_gives_up() {
        let req = request("update", Some(86));
        assert_eq!(
            decide_after_exit(Some(86), Some(&req), 0),
            ExitAction::Restart {
                reason: "update".into()
            }
        );
        match decide_after_exit(Some(86), Some(&req), 1) {
            ExitAction::GiveUp { reason } => assert!(reason.contains("2 time(s)")),
            other => panic!("expected GiveUp, got {other:?}"),
        }
    }

    #[test]
    fn a_rollback_after_the_first_restart_gets_one_more_relaunch() {
        let rollback = request("rollback", Some(86));
        assert_eq!(
            decide_after_exit(Some(86), Some(&rollback), 1),
            ExitAction::Restart {
                reason: "rollback".into()
            }
        );
        assert!(matches!(
            decide_after_exit(Some(86), Some(&rollback), 2),
            ExitAction::GiveUp { .. }
        ));
    }

    #[test]
    fn other_exits_are_crashes_or_a_clean_stop() {
        let req = request("update", Some(86));
        assert_eq!(decide_after_exit(Some(0), None, 0), ExitAction::Stopped);
        assert_eq!(
            decide_after_exit(Some(0), Some(&req), 0),
            ExitAction::Stopped
        );
        assert_eq!(
            decide_after_exit(Some(1), None, 0),
            ExitAction::Crashed { code: Some(1) }
        );
        // A stale request next to a crash is still a crash.
        assert_eq!(
            decide_after_exit(Some(1), Some(&req), 0),
            ExitAction::Crashed { code: Some(1) }
        );
        assert_eq!(
            decide_after_exit(None, Some(&req), 0),
            ExitAction::Crashed { code: None }
        );
        // The restart code without a request file is a crash (ADR 0029: "every other exit").
        assert_eq!(
            decide_after_exit(Some(86), None, 0),
            ExitAction::Crashed { code: Some(86) }
        );
    }

    #[test]
    fn request_file_round_trip_and_removal() {
        let dir = std::env::temp_dir().join(format!("fr-restart-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert_eq!(read_restart_request(&dir), None);
        std::fs::write(
            restart_request_path(&dir),
            r#"{"schema":1,"reason":"update","targetVersion":"0.2.0","exitCode":86}"#,
        )
        .expect("write");
        assert_eq!(
            read_restart_request(&dir).map(|r| r.target_version),
            Some("0.2.0".into())
        );
        remove_restart_request(&dir);
        assert_eq!(read_restart_request(&dir), None);
        remove_restart_request(&dir); // idempotent
        let _ = std::fs::remove_dir_all(&dir);
    }
}
