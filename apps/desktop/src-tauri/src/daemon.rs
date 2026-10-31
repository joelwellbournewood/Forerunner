//! Attach to the local daemon (ADR 0011, ADR 0026): read `<runtime>/daemon.json`, check
//! `GET /health` with a short timeout, decide whether the recorded daemon is usable, and talk
//! to it over plain HTTP on the loopback interface with the bearer token from the file. The
//! pure decisions (`parse_daemon_file`, `precheck`, `decide`, `is_fresh`) are unit-tested; the
//! HTTP client is a thin wrapper that redacts the token from every error it returns.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::secret::{Secret, redact};

pub const DAEMON_FILE: &str = "daemon.json";
/// `GET /health` must answer within this on a local socket; anything slower is "not there".
pub const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
/// `/events` sends a heartbeat every 15 s; a stream silent for this long is dead.
pub const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct DaemonFile {
    pub url: String,
    pub token: Secret,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonFileError {
    Missing,
    Unreadable(String),
    BadJson(String),
    BadShape(String),
}

impl std::fmt::Display for DaemonFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonFileError::Missing => write!(f, "daemon.json not found"),
            DaemonFileError::Unreadable(e) => write!(f, "daemon.json unreadable: {e}"),
            DaemonFileError::BadJson(e) => write!(f, "daemon.json is not valid JSON: {e}"),
            DaemonFileError::BadShape(e) => write!(f, "daemon.json has the wrong shape: {e}"),
        }
    }
}

pub fn daemon_file_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(DAEMON_FILE)
}

/// True for the loopback addresses the daemon may bind (it only ever binds 127.0.0.1). A file
/// pointing anywhere else is refused: the token must never be sent off the machine.
pub fn is_loopback_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "http" {
        return false;
    }
    matches!(
        u.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    )
}

pub fn parse_daemon_file(text: &str) -> Result<DaemonFile, DaemonFileError> {
    let v: Value =
        serde_json::from_str(text).map_err(|e| DaemonFileError::BadJson(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| DaemonFileError::BadShape("not an object".into()))?;
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| DaemonFileError::BadShape("url missing".into()))?;
    if !is_loopback_url(&url) {
        return Err(DaemonFileError::BadShape(
            "url is not a loopback http address".into(),
        ));
    }
    let token = obj
        .get("token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(Secret::new)
        .ok_or_else(|| DaemonFileError::BadShape("token missing".into()))?;
    let pid = obj
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|p| u32::try_from(p).ok());
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let started_at = obj
        .get("startedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(DaemonFile {
        url,
        token,
        pid,
        version,
        started_at,
    })
}

pub fn read_daemon_file(path: &Path) -> Result<DaemonFile, DaemonFileError> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_daemon_file(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(DaemonFileError::Missing),
        Err(e) => Err(DaemonFileError::Unreadable(e.to_string())),
    }
}

/// Whether a process id is alive, when the OS makes that cheap to know. Linux reads `/proc`
/// (a zombie, ended but not yet reaped by its parent, counts as ended); elsewhere the health
/// probe is the only signal and this returns `None`.
pub fn pid_alive(pid: u32) -> Option<bool> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let dir = Path::new("/proc").join(pid.to_string());
    if !dir.exists() {
        return Some(false);
    }
    match std::fs::read_to_string(dir.join("stat")) {
        Ok(stat) => Some(!stat_says_ended(&stat)),
        Err(_) => Some(true),
    }
}

/// `/proc/<pid>/stat` gives the state right after the command name, which is in parentheses
/// and may itself contain ") ": `Z` (zombie) and `X` (dead) mean the process has ended.
pub fn stat_says_ended(stat: &str) -> bool {
    stat.rfind(')')
        .and_then(|i| stat[i + 1..].split_whitespace().next())
        .is_some_and(|state| state == "Z" || state == "X")
}

/// `GET /health` as the shell reads it (`HealthView`, ADR 0011): the fields the tray needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    pub platform: String,
    pub kill_active: bool,
    pub active_sessions: u64,
}

pub fn parse_health(text: &str) -> Result<Health, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("health is not JSON: {e}"))?;
    let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        return Err("health.ok is not true".into());
    }
    Ok(Health {
        ok,
        version: v
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        platform: v
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        kill_active: v
            .get("killActive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        active_sessions: v.get("activeSessions").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Before probing: a missing or broken file, or a recorded pid that is known to be dead,
/// means "start a daemon" without waiting on a socket. `Err` carries the reason.
pub fn precheck(
    file: Result<DaemonFile, DaemonFileError>,
    pid_alive: Option<bool>,
) -> Result<DaemonFile, String> {
    let file = file.map_err(|e| e.to_string())?;
    if let (Some(pid), Some(false)) = (file.pid, pid_alive) {
        return Err(format!(
            "daemon.json names pid {pid}, which is not running (stale file)"
        ));
    }
    Ok(file)
}

#[derive(Debug, Clone)]
pub enum AttachDecision {
    Attach(DaemonFile, Health),
    Start { reason: String },
}

/// After probing: a healthy answer attaches; anything else starts a daemon.
pub fn decide(file: DaemonFile, health: Result<Health, String>) -> AttachDecision {
    match health {
        Ok(h) if h.ok => AttachDecision::Attach(file, h),
        Ok(_) => AttachDecision::Start {
            reason: "the daemon answered /health without ok: true".into(),
        },
        Err(e) => AttachDecision::Start {
            reason: format!("the daemon at {} did not answer /health: {}", file.url, e),
        },
    }
}

/// Why a healthy daemon must be replaced by the bundled runtime, or `None` to attach (ADR
/// 0091): it reports a version older than the one the installer carries, or no version at all.
/// 1.0.0's shell attached to whatever answered `/health`, so a daemon left running from an old
/// checkout (0.1.0) served the 1.0.0 UI a `/me` without `desktopDeviceId`. A newer daemon (a
/// staged update, a developer's checkout) is kept; without a bundle nothing is replaced.
pub fn outdated_reason(daemon_version: &str, bundled_version: Option<&str>) -> Option<String> {
    let bundled = bundled_version?;
    let running = daemon_version.trim();
    if running.is_empty() {
        return Some(format!(
            "the running daemon reports no version; this app carries {bundled}"
        ));
    }
    if crate::version::compare(running, bundled).is_none() {
        return Some(format!(
            "the running daemon reports version {running:?}, which is not a release version; this app carries {bundled}"
        ));
    }
    crate::version::is_older(running, bundled).then(|| {
        format!(
            "the running daemon is version {running}, older than the {bundled} this app carries"
        )
    })
}

/// A daemon.json is "fresh" when it is not the file that was there before: a different pid
/// or start time than `before` (the file read before the spawn or the last one attached to),
/// or any file at all when there was none. The pid the shell spawned is accepted as well,
/// but never required: an install directory runs through `node …/tsx/dist/cli.mjs`, which
/// runs the CLI in a child node process, and `fr.cmd` on Windows runs under `cmd.exe`, so
/// the pid the daemon records is a grandchild of the shell's, not `child_pid`. Freshness is
/// only the first gate; the caller still requires `/health` to answer.
pub fn is_fresh(file: &DaemonFile, child_pid: Option<u32>, before: Option<&DaemonFile>) -> bool {
    if let (Some(p), Some(f)) = (child_pid, file.pid)
        && p == f
    {
        return true;
    }
    match before {
        None => true,
        Some(prev) => prev.pid != file.pid || prev.started_at != file.started_at,
    }
}

/// HTTP client for one daemon. Every error string is redacted before it leaves this type.
#[derive(Clone)]
pub struct DaemonClient {
    base: String,
    token: Secret,
    http: reqwest::Client,
    stream_http: reqwest::Client,
}

impl std::fmt::Debug for DaemonClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonClient")
            .field("base", &self.base)
            .field("token", &self.token)
            .finish()
    }
}

impl DaemonClient {
    pub fn new(url: &str, token: Secret) -> Result<Self, String> {
        if !is_loopback_url(url) {
            return Err("refusing a daemon URL that is not loopback http".into());
        }
        let http = reqwest::Client::builder()
            .timeout(HEALTH_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let stream_http = reqwest::Client::builder()
            .read_timeout(STREAM_READ_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base: url.trim_end_matches('/').to_string(),
            token,
            http,
            stream_http,
        })
    }

    pub fn from_file(file: &DaemonFile) -> Result<Self, String> {
        Self::new(&file.url, file.token.clone())
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn token(&self) -> &Secret {
        &self.token
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn scrub(&self, e: impl std::fmt::Display) -> String {
        redact(&e.to_string(), &[&self.token])
    }

    pub async fn health(&self) -> Result<Health, String> {
        let res = self
            .http
            .get(self.url("/health"))
            .bearer_auth(self.token.expose())
            .send()
            .await
            .map_err(|e| self.scrub(e))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| self.scrub(e))?;
        if !status.is_success() {
            return Err(format!("/health answered {status}"));
        }
        parse_health(&text)
    }

    /// POST a JSON body (or `{}`); returns the status and the parsed body (`null` when empty).
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<(u16, Value), String> {
        let res = self
            .http
            .post(self.url(path))
            .bearer_auth(self.token.expose())
            .json(body)
            .send()
            .await
            .map_err(|e| self.scrub(e))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| self.scrub(e))?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    pub async fn get_json(&self, path: &str) -> Result<(u16, Value), String> {
        let res = self
            .http
            .get(self.url(path))
            .bearer_auth(self.token.expose())
            .send()
            .await
            .map_err(|e| self.scrub(e))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| self.scrub(e))?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// Open `GET /events` as a stream. The token travels in the `Authorization` header, never
    /// in the URL (ADR 0025 allows `?token=` for browsers only).
    pub async fn open_events(&self) -> Result<reqwest::Response, String> {
        let res = self
            .stream_http
            .get(self.url("/events"))
            .bearer_auth(self.token.expose())
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| self.scrub(e))?;
        if !res.status().is_success() {
            return Err(format!("/events answered {}", res.status()));
        }
        Ok(res)
    }
}

/// The daemon's error body, when it sent one (`ErrorBody { code, message }`).
pub fn error_message(status: u16, body: &Value) -> String {
    let code = body.get("code").and_then(Value::as_str);
    let message = body.get("message").and_then(Value::as_str);
    match (code, message) {
        (Some(c), Some(m)) => format!("{m} ({c}, HTTP {status})"),
        (None, Some(m)) => format!("{m} (HTTP {status})"),
        _ => format!("HTTP {status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        let mut t = String::from("day"); // not-a-secret
        t.push_str("mon_0123456789abcdefghijklmnopqrstuv"); // not-a-secret
        t
    }

    fn good_file() -> String {
        format!(
            r#"{{"url":"http://127.0.0.1:43211","token":"{}","pid":4242,"version":"0.1.0","startedAt":"2026-10-20T10:00:00.000Z"}}"#,
            token()
        )
    }

    #[test]
    fn parses_the_file_start_daemon_writes() {
        let f = parse_daemon_file(&good_file()).expect("parses");
        assert_eq!(f.url, "http://127.0.0.1:43211");
        assert_eq!(f.token.expose(), token());
        assert_eq!(f.pid, Some(4242));
        assert_eq!(f.version.as_deref(), Some("0.1.0"));
        assert_eq!(f.started_at.as_deref(), Some("2026-10-20T10:00:00.000Z"));
        // The derived Debug never shows the token.
        assert!(!format!("{f:?}").contains(&token()));
    }

    #[test]
    fn missing_file_bad_json_and_bad_shape_are_distinct_errors() {
        let missing = read_daemon_file(Path::new("/nonexistent-dir-for-test/daemon.json"));
        assert_eq!(missing.unwrap_err(), DaemonFileError::Missing);
        assert!(matches!(
            parse_daemon_file("{not json"),
            Err(DaemonFileError::BadJson(_))
        ));
        assert!(matches!(
            parse_daemon_file("[]"),
            Err(DaemonFileError::BadShape(_))
        ));
        assert!(matches!(
            parse_daemon_file(r#"{"url":"http://127.0.0.1:1"}"#),
            Err(DaemonFileError::BadShape(m)) if m.contains("token")
        ));
        assert!(matches!(
            parse_daemon_file(&format!(r#"{{"token":"{}"}}"#, token())),
            Err(DaemonFileError::BadShape(m)) if m.contains("url")
        ));
    }

    #[test]
    fn refuses_a_file_that_points_off_the_machine() {
        let text = format!(
            r#"{{"url":"http://evil.example:80","token":"{}"}}"#,
            token()
        );
        assert!(matches!(
            parse_daemon_file(&text),
            Err(DaemonFileError::BadShape(_))
        ));
        let https = format!(r#"{{"url":"https://127.0.0.1:1","token":"{}"}}"#, token());
        assert!(matches!(
            parse_daemon_file(&https),
            Err(DaemonFileError::BadShape(_))
        ));
        assert!(DaemonClient::new("http://10.0.0.5:1", Secret::new(token())).is_err());
        assert!(is_loopback_url("http://localhost:8787"));
        assert!(is_loopback_url("http://[::1]:8787"));
    }

    #[test]
    fn pid_without_a_process_is_a_stale_file() {
        let f = parse_daemon_file(&good_file()).expect("parses");
        let err = precheck(Ok(f.clone()), Some(false)).unwrap_err();
        assert!(err.contains("stale"));
        assert!(err.contains("4242"));
        assert!(precheck(Ok(f.clone()), Some(true)).is_ok());
        assert!(precheck(Ok(f), None).is_ok());
        assert_eq!(
            precheck(Err(DaemonFileError::Missing), None).unwrap_err(),
            "daemon.json not found"
        );
    }

    #[test]
    fn a_zombie_counts_as_ended() {
        assert!(stat_says_ended("8663 (sleep) Z 1 8661 8648 0 -1"));
        assert!(stat_says_ended("8663 (sleep) X 1"));
        assert!(!stat_says_ended("8663 (sleep) S 1 8661"));
        // A command name with a parenthesis and a space in it.
        assert!(!stat_says_ended("15436 (node (fr) Z) R 1 2"));
        assert!(stat_says_ended("15436 (node (fr) R) Z 1 2"));
        assert!(!stat_says_ended("garbage"));
        if cfg!(target_os = "linux") {
            assert_eq!(pid_alive(std::process::id()), Some(true));
        } else {
            assert_eq!(pid_alive(std::process::id()), None);
        }
    }

    #[test]
    fn health_decides_between_attach_and_start() {
        let f = parse_daemon_file(&good_file()).expect("parses");
        let healthy = parse_health(
            r#"{"ok":true,"version":"0.1.0","platform":"linux","killActive":true,"activeSessions":2}"#,
        )
        .expect("health parses");
        assert!(healthy.kill_active);
        assert_eq!(healthy.active_sessions, 2);
        assert!(matches!(
            decide(f.clone(), Ok(healthy)),
            AttachDecision::Attach(_, _)
        ));
        match decide(f, Err("connection refused".into())) {
            AttachDecision::Start { reason } => {
                assert!(reason.contains("connection refused"));
                assert!(!reason.contains(&token()));
            }
            other => panic!("expected Start, got {other:?}"),
        }
        assert!(parse_health(r#"{"ok":false}"#).is_err());
        assert!(parse_health("nope").is_err());
    }

    #[test]
    fn an_older_daemon_is_replaced_and_a_newer_one_kept() {
        let reason = outdated_reason("0.1.0", Some("1.0.1")).expect("replaced");
        assert!(
            reason.contains("0.1.0") && reason.contains("1.0.1"),
            "{reason}"
        );
        assert!(outdated_reason("1.0.0-rc.4", Some("1.0.0")).is_some());
        assert!(outdated_reason("", Some("1.0.0")).is_some());
        assert!(outdated_reason("0.0.0-dev+local", Some("1.0.0")).is_some());
        assert!(outdated_reason("garbage", Some("1.0.0")).is_some());
        assert_eq!(outdated_reason("1.0.0", Some("1.0.0")), None);
        assert_eq!(outdated_reason("1.0.2", Some("1.0.1")), None);
        // A development build (no bundle) attaches to whatever answers, as before.
        assert_eq!(outdated_reason("0.1.0", None), None);
    }

    #[test]
    fn freshness_is_a_changed_file_not_the_spawned_pid() {
        let a = parse_daemon_file(&good_file()).expect("parses");
        let mut b = a.clone();
        b.pid = Some(4343);
        // The direct child wrote it: fresh even against an identical earlier file.
        assert!(is_fresh(&b, Some(4343), Some(&b)));
        // The file that was there before the spawn, untouched, is never fresh.
        assert!(!is_fresh(&a, Some(4343), Some(&a)));
        assert!(!is_fresh(&a, None, Some(&a)));
        // Nothing was there before: the first file that answers /health is the daemon.
        assert!(is_fresh(&a, Some(4343), None));
        assert!(is_fresh(&a, None, None));
        // Someone else's daemon with a new pid or a new start time.
        assert!(is_fresh(&b, None, Some(&a)));
        let mut restarted = a.clone();
        restarted.started_at = Some("2026-10-20T11:00:00.000Z".into());
        assert!(is_fresh(&restarted, None, Some(&a)));
    }

    /// `node …/tsx/dist/cli.mjs main.ts daemon` runs the daemon in a child node process (and
    /// `fr.cmd` under cmd.exe), so the pid in daemon.json is the shell's grandchild. The
    /// shell spawned 15422; the daemon wrote 15436; the file must still attach.
    #[test]
    fn a_grandchild_pid_written_after_the_spawn_attaches() {
        let before = parse_daemon_file(&good_file()).expect("parses");
        let mut written = before.clone();
        written.pid = Some(15436);
        written.started_at = Some("2026-10-20T12:00:00.000Z".into());
        assert!(is_fresh(&written, Some(15422), Some(&before)));
        // Same grandchild pid, no file before the spawn (first run).
        assert!(is_fresh(&written, Some(15422), None));
        // A stale file (dead pid) that the new daemon has not replaced yet is not fresh.
        assert!(!is_fresh(&before, Some(15422), Some(&before)));
    }

    #[test]
    fn error_messages_use_the_daemon_body() {
        let body: Value =
            serde_json::from_str(r#"{"code":"not_found","message":"no update staged"}"#).unwrap();
        assert_eq!(
            error_message(404, &body),
            "no update staged (not_found, HTTP 404)"
        );
        assert_eq!(error_message(500, &Value::Null), "HTTP 500");
    }

    #[test]
    fn client_debug_hides_the_token() {
        let c = DaemonClient::new("http://127.0.0.1:1/", Secret::new(token())).expect("client");
        assert_eq!(c.base_url(), "http://127.0.0.1:1");
        assert!(!format!("{c:?}").contains(&token()));
        assert_eq!(c.scrub(format!("boom {}", token())), "boom [redacted]");
    }
}
