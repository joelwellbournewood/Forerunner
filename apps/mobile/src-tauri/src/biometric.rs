//! The biometric prompt behind `assert_biometric` (spec R.7, ADR 0009, ADR 0032 item 3).
//! The flag the UI puts inside the signed request string comes only from here, and only
//! after the platform prompt succeeded: on Android `tauri-plugin-biometric` shows
//! `BiometricPrompt`; on every other target the command answers `asserted: false` with a
//! reason, never a fake success. A success also issues a one-time **ticket** that the shell
//! keeps (`TicketBook`); `device_key_sign` signs a canonical string whose last line is
//! `biometric=1` only against a fresh, unused ticket, so UI code that fabricates an
//! assertion object cannot get a `biometric=1` signature without the prompt having run.

use serde::Serialize;
use std::fmt;
use std::time::{Duration, Instant};

/// How long a ticket from a successful prompt stays valid; it is good for one signature.
pub const TICKET_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BiometricOutcome {
  /// True only when the platform prompt succeeded for this request.
  pub asserted: bool,
  /// ISO-8601 UTC instant of the decision.
  pub at: String,
  /// "android-biometric" or "unavailable".
  pub method: &'static str,
  /// Why it was not asserted, for the UI's message; never sensitive.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
  /// The one-time ticket `device_key_sign` needs for a `biometric=1` string (success only).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ticket: Option<String>,
}

pub fn now_iso() -> String {
  let secs = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  iso_from_unix(secs)
}

/// Civil-time conversion without a date crate (days since the epoch to y-m-d).
pub fn iso_from_unix(secs: u64) -> String {
  let days = secs / 86_400;
  let rem = secs % 86_400;
  let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
  // Howard Hinnant's algorithm.
  let z = days as i64 + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = if month <= 2 { y + 1 } else { y };
  format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

pub fn unavailable(reason: &str) -> BiometricOutcome {
  BiometricOutcome {
    asserted: false,
    at: now_iso(),
    method: "unavailable",
    reason: Some(reason.to_string()),
    ticket: None,
  }
}

/// Only the mobile prompt (`commands::prompt`) produces this; desktop builds never do. The
/// command that returns it to the UI attaches the ticket.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn asserted() -> BiometricOutcome {
  BiometricOutcome {
    asserted: true,
    at: now_iso(),
    method: "android-biometric",
    reason: None,
    ticket: None,
  }
}

/// How long `assert_biometric` waits for the platform (status, then the prompt) before it
/// answers `asserted: false`. Shorter than the UI's own bound (60 s,
/// `apps/ui/src/mobile/store.tsx` `BIOMETRIC_TIMEOUT_MS`), so the phone shows the shell's
/// reason rather than its own; long enough to read the prompt and touch the sensor.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub const PROMPT_LIMIT: Duration = Duration::from_secs(45);

/// The refusal for a `status` the plugin reported as not available, or `None` when a prompt
/// can be shown. The reason is the plugin's text ("Biometrics not enrolled."), else its code
/// ("biometryNotEnrolled"), else a generic line: never empty, so the UI can always say why.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn refusal_from_status(
  is_available: bool,
  error: Option<&str>,
  error_code: Option<&str>,
) -> Option<BiometricOutcome> {
  if is_available {
    return None;
  }
  let text = error.map(str::trim).filter(|e| !e.is_empty());
  let code = error_code.map(str::trim).filter(|c| !c.is_empty());
  let reason = match (text, code) {
    (Some(text), _) => text.to_string(),
    (None, Some(code)) => format!("biometrics not available ({code})"),
    (None, None) => "no biometrics enrolled on this phone".to_string(),
  };
  Some(unavailable(&reason))
}

/// The outcome of the plugin's `authenticate`: success asserts, any error is "not confirmed"
/// with the plugin's words (cancelled, not recognised, no biometrics).
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn outcome_from_auth(result: Result<(), String>) -> BiometricOutcome {
  match result {
    Ok(()) => asserted(),
    Err(e) => {
      let e = e.trim();
      unavailable(&format!(
        "not confirmed: {}",
        if e.is_empty() { "the prompt failed" } else { e }
      ))
    }
  }
}

/// Runs the blocking platform calls on their own thread and waits at most `limit`: a call
/// that never answers (the plugin's response lost, a prompt that cannot be shown) or a thread
/// that panicked becomes `asserted: false` with a reason instead of an invoke that never
/// settles in the UI. A late result is dropped with its channel, and with it any success:
/// the ticket is issued by the caller only for an outcome that arrived in time.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn wait_bounded<F>(platform: F, limit: Duration) -> BiometricOutcome
where
  F: FnOnce() -> BiometricOutcome + Send + 'static,
{
  let (tx, rx) = std::sync::mpsc::channel();
  let spawned = std::thread::Builder::new()
    .name("forerunner-biometric".into())
    .spawn(move || {
      let _ = tx.send(platform());
    });
  if let Err(e) = spawned {
    return unavailable(&format!("the biometric prompt could not start: {e}"));
  }
  match rx.recv_timeout(limit) {
    Ok(outcome) => outcome,
    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => unavailable(&format!(
      "the biometric prompt did not answer within {}",
      if limit.as_secs() == 0 {
        format!("{} ms", limit.as_millis())
      } else {
        format!("{} s", limit.as_secs())
      }
    )),
    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
      unavailable("the biometric prompt failed without an answer")
    }
  }
}

/// True when `message` is a canonical request string whose last line is `biometric=1`
/// (`METHOD\npath\nsha256\ntimestamp\nbiometric=0|1`, the service's `canonicalRequest`).
/// A pairing proof (`pair:<code>`) and a `biometric=0` string never need a ticket.
pub fn needs_biometric_ticket(message: &[u8]) -> bool {
  message.rsplit(|b| *b == b'\n').next() == Some(b"biometric=1".as_slice())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketError {
  Missing,
  Unknown,
  Expired,
}

impl fmt::Display for TicketError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      TicketError::Missing => write!(
        f,
        "biometric ticket missing: a biometric=1 signature needs a successful prompt first"
      ),
      TicketError::Unknown => write!(f, "biometric ticket unknown or already used"),
      TicketError::Expired => write!(f, "biometric ticket expired; prompt again"),
    }
  }
}

/// The one outstanding ticket: issued by a successful prompt, redeemed by exactly one
/// signature inside `TICKET_TTL`. A new prompt replaces an unused ticket.
#[derive(Debug, Default)]
pub struct TicketBook {
  current: Option<(String, Instant)>,
}

impl TicketBook {
  pub const fn new() -> TicketBook {
    TicketBook { current: None }
  }

  /// Issue a ticket from 16 random bytes (hex); the caller supplies the randomness.
  pub fn issue(&mut self, random: [u8; 16], now: Instant) -> String {
    let ticket: String = random.iter().map(|b| format!("{b:02x}")).collect();
    self.current = Some((ticket.clone(), now));
    ticket
  }

  /// Consume the ticket when it is the outstanding one and still fresh.
  pub fn redeem(&mut self, presented: Option<&str>, now: Instant) -> Result<(), TicketError> {
    let presented = presented
      .map(str::trim)
      .filter(|t| !t.is_empty())
      .ok_or(TicketError::Missing)?;
    let Some((ticket, issued)) = self.current.take() else {
      return Err(TicketError::Unknown);
    };
    if ticket != presented {
      // A wrong ticket does not burn the real one: a confused screen can still retry.
      self.current = Some((ticket, issued));
      return Err(TicketError::Unknown);
    }
    if now.duration_since(issued) > TICKET_TTL {
      return Err(TicketError::Expired);
    }
    Ok(())
  }

  #[cfg(test)]
  pub fn outstanding(&self) -> bool {
    self.current.is_some()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn iso_conversion_matches_known_instants() {
    assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_unix(1_792_490_400), "2026-10-20T10:00:00.000Z");
    assert_eq!(iso_from_unix(1_792_540_800), "2026-10-21T00:00:00.000Z");
    assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00.000Z");
  }

  #[test]
  fn outcomes_serialise_for_the_ui() {
    let no = unavailable("no biometrics on this build");
    assert!(!no.asserted);
    let json = serde_json::to_string(&no).expect("json");
    assert!(json.contains("\"asserted\":false"));
    assert!(json.contains("\"method\":\"unavailable\""));
    assert!(json.contains("\"reason\":\"no biometrics on this build\""));
    assert!(!json.contains("ticket"));
    let mut yes = asserted();
    assert!(yes.asserted);
    assert_eq!(yes.method, "android-biometric");
    assert_eq!(yes.ticket, None);
    yes.ticket = Some("abc".into());
    let json = serde_json::to_string(&yes).expect("json");
    assert!(!json.contains("reason"));
    assert!(json.contains("\"ticket\":\"abc\""));
  }

  #[test]
  fn a_status_without_biometrics_is_a_refusal_that_says_why() {
    // The plugin's answer on an emulator without an enrolled fingerprint (API 30):
    // `{ isAvailable: false, biometryType: 1, error: "Biometrics not enrolled.",
    // errorCode: "biometryNotEnrolled" }`.
    let no = refusal_from_status(
      false,
      Some("Biometrics not enrolled."),
      Some("biometryNotEnrolled"),
    )
    .expect("refused");
    assert!(!no.asserted);
    assert_eq!(no.method, "unavailable");
    assert_eq!(no.reason.as_deref(), Some("Biometrics not enrolled."));
    assert_eq!(no.ticket, None);
    // A result code the plugin has no text for leaves `error` empty: the code says it.
    let coded =
      refusal_from_status(false, Some(""), Some("biometryNotAvailable")).expect("refused");
    assert_eq!(
      coded.reason.as_deref(),
      Some("biometrics not available (biometryNotAvailable)")
    );
    let bare = refusal_from_status(false, None, Some("  ")).expect("refused");
    assert_eq!(
      bare.reason.as_deref(),
      Some("no biometrics enrolled on this phone")
    );
    assert_eq!(refusal_from_status(true, None, None), None);
  }

  #[test]
  fn an_authentication_error_is_not_confirmed_with_the_plugins_words() {
    assert!(outcome_from_auth(Ok(())).asserted);
    let cancelled = outcome_from_auth(Err("Cancel button was pressed".into()));
    assert!(!cancelled.asserted);
    assert_eq!(
      cancelled.reason.as_deref(),
      Some("not confirmed: Cancel button was pressed")
    );
    let empty = outcome_from_auth(Err(" ".into()));
    assert_eq!(
      empty.reason.as_deref(),
      Some("not confirmed: the prompt failed")
    );
  }

  #[test]
  fn a_platform_call_that_never_answers_or_panics_is_refused_in_bounded_time() {
    let t0 = Instant::now();
    let hung = wait_bounded(
      || {
        std::thread::sleep(Duration::from_secs(30));
        asserted()
      },
      Duration::from_millis(100),
    );
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert!(!hung.asserted, "a late success is dropped");
    assert_eq!(
      hung.reason.as_deref(),
      Some("the biometric prompt did not answer within 100 ms")
    );
    let panicked = wait_bounded(|| panic!("plugin state missing"), Duration::from_secs(5));
    assert!(!panicked.asserted);
    assert_eq!(
      panicked.reason.as_deref(),
      Some("the biometric prompt failed without an answer")
    );
    let fine = wait_bounded(asserted, Duration::from_secs(5));
    assert!(fine.asserted);
    let refused = wait_bounded(
      || unavailable("Biometrics not enrolled."),
      Duration::from_secs(5),
    );
    assert_eq!(refused.reason.as_deref(), Some("Biometrics not enrolled."));
    assert!(
      PROMPT_LIMIT < Duration::from_secs(60),
      "inside the UI's bound"
    );
  }

  #[test]
  fn the_plugin_is_registered_and_permitted_for_the_main_window_on_mobile() {
    // Candidate 5 of android.yml run 39952987240: a plugin that is not registered or not
    // permitted. The shell's own calls (`app.biometric()`) need the registration; the
    // capability keeps both commands allowed for the window the shell builds.
    let capability: serde_json::Value =
      serde_json::from_str(include_str!("../capabilities/mobile.json")).expect("json");
    let list = |key: &str| -> Vec<String> {
      capability[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"))
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
    };
    let permissions = list("permissions");
    for needed in ["biometric:allow-status", "biometric:allow-authenticate"] {
      assert!(
        permissions.iter().any(|p| p == needed),
        "{needed} in {permissions:?}"
      );
    }
    assert!(list("platforms").iter().any(|p| p == "android"));
    assert_eq!(list("windows"), vec!["main".to_string()]);
    let lib = include_str!("lib.rs");
    assert!(lib.contains("app.handle().plugin(tauri_plugin_biometric::init())?;"));
    assert!(lib.contains(r#"tauri::WebviewWindowBuilder::new(app, "main""#));
    assert!(lib.contains("commands::assert_biometric,"));
  }

  #[test]
  fn only_a_biometric_1_last_line_needs_a_ticket() {
    assert!(needs_biometric_ticket(
      b"POST\n/requests/req_1/answer\nabc\n1760000000000\nbiometric=1"
    ));
    assert!(!needs_biometric_ticket(
      b"POST\n/requests/req_1/answer\nabc\n1760000000000\nbiometric=0"
    ));
    assert!(!needs_biometric_ticket(b"pair:ABCD2345"));
    assert!(!needs_biometric_ticket(b""));
    // The flag line counts only as the last line; a body hash cannot smuggle it in.
    assert!(!needs_biometric_ticket(
      b"POST\n/x\nbiometric=1\n1\nbiometric=0"
    ));
    assert!(needs_biometric_ticket(b"biometric=1"));
  }

  #[test]
  fn a_ticket_is_redeemed_once_inside_its_ttl() {
    let mut book = TicketBook::new();
    let t0 = Instant::now();
    assert_eq!(book.redeem(None, t0), Err(TicketError::Missing));
    assert_eq!(book.redeem(Some("  "), t0), Err(TicketError::Missing));
    assert_eq!(book.redeem(Some("forged"), t0), Err(TicketError::Unknown));
    let ticket = book.issue([7u8; 16], t0);
    assert_eq!(ticket, "07".repeat(16));
    assert!(book.outstanding());
    assert_eq!(book.redeem(Some("forged"), t0), Err(TicketError::Unknown));
    assert!(
      book.outstanding(),
      "a wrong ticket does not burn the real one"
    );
    assert_eq!(
      book.redeem(Some(&ticket), t0 + Duration::from_secs(5)),
      Ok(())
    );
    assert!(!book.outstanding());
    assert_eq!(
      book.redeem(Some(&ticket), t0 + Duration::from_secs(6)),
      Err(TicketError::Unknown)
    );
    let stale = book.issue([1u8; 16], t0);
    assert_eq!(
      book.redeem(Some(&stale), t0 + TICKET_TTL + Duration::from_secs(1)),
      Err(TicketError::Expired)
    );
    assert!(!book.outstanding(), "an expired ticket is gone too");
    // A new prompt replaces an unused ticket.
    let first = book.issue([2u8; 16], t0);
    let second = book.issue([3u8; 16], t0);
    assert_eq!(book.redeem(Some(&first), t0), Err(TicketError::Unknown));
    assert_eq!(book.redeem(Some(&second), t0), Ok(()));
  }

  #[test]
  fn ticket_errors_read_as_plain_strings_without_the_ticket() {
    for e in [
      TicketError::Missing,
      TicketError::Unknown,
      TicketError::Expired,
    ] {
      let text = e.to_string();
      assert!(text.starts_with("biometric ticket"), "{text}");
    }
  }
}
