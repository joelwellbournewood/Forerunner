//! Push notifications (spec R.6) behind one port (ADR 0032 item 6, ADR 0085 point 9). An APK
//! built with `google-services.json` in `gen/android/app` carries Firebase Cloud Messaging:
//! `KeystorePlugin.info` reports the registration token (`fcmToken`, kept by
//! `PushTokenStore` from `FirebaseMessaging.getInstance().token` and `onNewToken`), and
//! `configured(token)` returns `FcmPush`; the UI sends the token at pairing (`pushToken`) and
//! after a refresh (`PUT /devices/:id/push-token`). `push_status` re-reads the token on every
//! call. Without the file (every build that lacks the secret, the emulator smoke) `info`
//! reports null and the mode is the visible polling stand-in: the UI's change feed (live SSE,
//! or polling) raises in-app notices, and Settings says so. Nothing here logs the token.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushStatus {
  /// "fcm" or "polling".
  pub mode: &'static str,
  /// Shown in Settings next to the mode.
  pub detail: String,
  /// The registration token to send at pairing; null for the stand-in.
  pub token: Option<String>,
}

pub trait PushPort: Send + Sync {
  fn status(&self) -> PushStatus;
}

/// The stand-in: in-app notices from the change feed.
pub struct PollingPush;

impl PushPort for PollingPush {
  fn status(&self) -> PushStatus {
    PushStatus {
      mode: "polling",
      detail: "FCM not configured; notices come from the change feed (live or polling)".into(),
      token: None,
    }
  }
}

/// The seam for Firebase Cloud Messaging: `token` is what the platform SDK returned.
pub struct FcmPush {
  pub token: String,
}

impl PushPort for FcmPush {
  fn status(&self) -> PushStatus {
    PushStatus {
      mode: "fcm",
      detail: "Firebase Cloud Messaging".into(),
      token: Some(self.token.clone()),
    }
  }
}

/// The port for this launch: FCM when the platform side handed over a registration token
/// (the Kotlin `KeystorePlugin.info` returns one only once a Firebase project is configured),
/// else the visible polling stand-in.
pub fn configured(token: Option<String>) -> Box<dyn PushPort> {
  match token.filter(|t| !t.trim().is_empty()) {
    Some(token) => Box::new(FcmPush { token }),
    None => Box::new(PollingPush),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_stand_in_is_visible_and_tokenless() {
    let status = configured(None).status();
    assert_eq!(status.mode, "polling");
    assert!(status.detail.contains("FCM not configured"));
    assert_eq!(status.token, None);
    let json = serde_json::to_string(&status).expect("json");
    assert!(json.contains("\"mode\":\"polling\""));
    assert!(json.contains("\"token\":null"));
  }

  #[test]
  fn fcm_reports_its_token() {
    let fcm = FcmPush {
      token: "registration".into(),
    };
    assert_eq!(fcm.status().mode, "fcm");
    assert_eq!(fcm.status().token.as_deref(), Some("registration"));
    assert_eq!(configured(Some("registration".into())).status().mode, "fcm");
    assert_eq!(configured(Some("  ".into())).status().mode, "polling");
  }
}
