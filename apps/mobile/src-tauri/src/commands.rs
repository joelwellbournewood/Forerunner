//! The shell commands the UI calls (`apps/ui/src/mobile/shell-bridge.ts`, ADR 0032): the
//! device key (public key, sign, forget), the secure store for the session token, the
//! biometric prompt, the push status and what the shell knows about itself. Errors cross
//! the bridge as plain strings that never carry key material (`KeystoreError` only names
//! what went wrong); nothing here logs a key, a signature or a token. The biometric flag
//! is bound here, not by convention: `device_key_sign` signs a `biometric=1` string only
//! against the one-time ticket the last successful `assert_biometric` issued (ADR 0032
//! item 3).

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::biometric::{self, BiometricOutcome, TicketBook, needs_biometric_ticket};
use crate::config::{Recovery, ShellConfig, parse_pairing_link, recover};
use crate::dirs::{self, Platform};
use crate::keystore::{FileWrapper, KeystoreError, SESSION_TOKEN_KEY, SecureFiles, Wrapper};
use crate::push::{self, PushPort, PushStatus};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
  pub platform: String,
  pub version: String,
  pub device_name: String,
  pub state_url: Option<String>,
  /// "keystore" (Android Keystore wraps the files) or "file" (mode 0600 only).
  pub secure_store: &'static str,
  /// Whether a platform biometric prompt can be shown.
  pub biometric: bool,
  pub install_id: String,
  /// A device key and a session token exist: the UI can go straight to Home.
  pub paired: bool,
}

/// Managed state: the wrapped files, what the UI may know and the outstanding biometric ticket.
pub struct Shell {
  files: Mutex<SecureFiles>,
  config: Mutex<(PathBuf, ShellConfig)>,
  info: Mutex<ShellInfo>,
  push: Box<dyn PushPort>,
  tickets: Mutex<TicketBook>,
}

impl Shell {
  pub fn new(
    files: SecureFiles,
    config_dir: PathBuf,
    config: ShellConfig,
    info: ShellInfo,
    push: Box<dyn PushPort>,
  ) -> Shell {
    Shell {
      files: Mutex::new(files),
      config: Mutex::new((config_dir, config)),
      info: Mutex::new(info),
      push,
      tickets: Mutex::new(TicketBook::new()),
    }
  }

  /// A fresh one-time ticket after a successful prompt (replaces an unused one).
  pub fn issue_biometric_ticket(&self) -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let mut book = match self.tickets.lock() {
      Ok(book) => book,
      Err(poisoned) => poisoned.into_inner(),
    };
    book.issue(bytes, Instant::now())
  }

  /// Sign `message` with the device key. A canonical string ending in `biometric=1` is
  /// signed only when `ticket` is the fresh, unused ticket of the last successful prompt,
  /// which this call consumes; any other message ignores `ticket`.
  pub fn sign(&self, message: &[u8], ticket: Option<&str>) -> Result<String, String> {
    if needs_biometric_ticket(message) {
      let mut book = self
        .tickets
        .lock()
        .map_err(|_| "shell state poisoned".to_string())?;
      book
        .redeem(ticket, Instant::now())
        .map_err(|e| e.to_string())?;
    }
    let files = self.files()?;
    let key = files.load_or_create_key().map_err(keystore_err)?;
    Ok(key.sign_b64(message))
  }

  /// What survived a restart (an app the system killed, a reboot): a key and a token.
  pub fn recovery(&self) -> Recovery {
    match self.files() {
      Ok(files) => recover(
        files.load_key().ok().flatten().is_some(),
        files.get(SESSION_TOKEN_KEY).ok().flatten().is_some(),
      ),
      Err(_) => recover(false, false),
    }
  }

  fn files(&self) -> Result<MutexGuard<'_, SecureFiles>, String> {
    self
      .files
      .lock()
      .map_err(|_| "shell state poisoned".to_string())
  }

  pub fn info(&self) -> ShellInfo {
    match self.info.lock() {
      Ok(info) => info.clone(),
      Err(poisoned) => poisoned.into_inner().clone(),
    }
  }

  /// Remember the service URL a pairing link carried, for the next launch's injection.
  pub fn remember_state_url(&self, url: &str) {
    if let Ok(mut guard) = self.config.lock() {
      let (dir, cfg) = &mut *guard;
      cfg.state_url = Some(url.trim_end_matches('/').to_string());
      if let Err(e) = cfg.save(dir) {
        log::warn!("could not save the shell config: {e}");
      }
    }
    if let Ok(mut info) = self.info.lock() {
      info.state_url = Some(url.trim_end_matches('/').to_string());
    }
  }

  /// `window.__FORERUNNER__` for the UI (ADR 0025 shape plus the Android fields).
  pub fn injection_script(&self) -> String {
    let info = self.info();
    let injection = serde_json::json!({
      "platform": info.platform,
      "shellVersion": info.version,
      "installId": info.install_id,
      "stateUrl": info.state_url,
      "deviceName": info.device_name,
    });
    format!("window.__FORERUNNER__ = {injection};")
  }
}

fn keystore_err(e: KeystoreError) -> String {
  e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyOut {
  pub public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureOut {
  pub signature: String,
}

#[derive(Serialize)]
pub struct ValueOut {
  pub value: Option<String>,
}

#[tauri::command]
pub fn shell_info(shell: State<'_, Shell>) -> ShellInfo {
  let mut info = shell.info();
  info.paired = shell.recovery().paired;
  info
}

#[tauri::command]
pub fn device_key_public(shell: State<'_, Shell>) -> Result<PublicKeyOut, String> {
  let files = shell.files()?;
  let key = files.load_or_create_key().map_err(keystore_err)?;
  Ok(PublicKeyOut {
    public_key: key.public_key_b64(),
  })
}

/// `message` is base64 of the bytes to sign (the canonical request string or the pairing
/// proof); `ticket` is the one `assert_biometric` returned, required and consumed when the
/// message ends with `biometric=1`.
#[tauri::command]
pub fn device_key_sign(
  shell: State<'_, Shell>,
  message: String,
  ticket: Option<String>,
) -> Result<SignatureOut, String> {
  let bytes = B64
    .decode(message.trim())
    .map_err(|_| "message must be base64".to_string())?;
  Ok(SignatureOut {
    signature: shell.sign(&bytes, ticket.as_deref())?,
  })
}

#[tauri::command]
pub fn device_key_forget(shell: State<'_, Shell>) -> Result<(), String> {
  shell.files()?.forget_key().map_err(keystore_err)
}

#[tauri::command]
pub fn secure_store_get(shell: State<'_, Shell>, key: String) -> Result<ValueOut, String> {
  let value = shell.files()?.get(&key).map_err(keystore_err)?;
  Ok(ValueOut { value })
}

#[tauri::command]
pub fn secure_store_set(shell: State<'_, Shell>, key: String, value: String) -> Result<(), String> {
  shell.files()?.set(&key, &value).map_err(keystore_err)
}

#[tauri::command]
pub fn secure_store_delete(shell: State<'_, Shell>, key: String) -> Result<(), String> {
  shell.files()?.delete(&key).map_err(keystore_err)
}

#[tauri::command]
pub fn push_status(shell: State<'_, Shell>) -> PushStatus {
  shell.push.status()
}

/// The platform prompt. Only a success returns `asserted: true`, and only a success carries
/// the ticket `device_key_sign` needs for the one `biometric=1` signature that follows.
#[tauri::command]
pub async fn assert_biometric<R: Runtime>(
  app: AppHandle<R>,
  shell: State<'_, Shell>,
  reason: String,
) -> Result<BiometricOutcome, String> {
  let reason: String = reason.chars().take(200).collect();
  let mut outcome = prompt(&app, &reason).await;
  if outcome.asserted {
    outcome.ticket = Some(shell.issue_biometric_ticket());
  } else {
    outcome.ticket = None;
  }
  Ok(outcome)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn prompt<R: Runtime>(app: &AppHandle<R>, reason: &str) -> BiometricOutcome {
  use tauri_plugin_biometric::{AuthOptions, BiometricExt};
  let status = match app.biometric().status() {
    Ok(status) => status,
    Err(e) => return biometric::unavailable(&format!("biometric status failed: {e}")),
  };
  if !status.is_available {
    return biometric::unavailable(
      status
        .error
        .as_deref()
        .unwrap_or("no biometrics enrolled on this phone"),
    );
  }
  let options = AuthOptions {
    allow_device_credential: false,
    cancel_title: None,
    fallback_title: None,
    title: Some("Forerunner".to_string()),
    subtitle: Some("Confirm a high-risk change".to_string()),
    confirmation_required: Some(true),
  };
  match app.biometric().authenticate(reason.to_string(), options) {
    Ok(()) => biometric::asserted(),
    Err(e) => biometric::unavailable(&format!("not confirmed: {e}")),
  }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn prompt<R: Runtime>(_app: &AppHandle<R>, _reason: &str) -> BiometricOutcome {
  biometric::unavailable("no biometric prompt on this platform; the UI shows its simulated dialog")
}

/// Android: the Kotlin `KeystorePlugin` wraps bytes with an AES-GCM key in the Android Keystore.
#[cfg(target_os = "android")]
pub mod android {
  use super::*;
  use serde::Deserialize;
  use tauri::plugin::{PluginApi, PluginHandle, TauriPlugin};

  pub struct KeystoreHandle<R: Runtime>(pub PluginHandle<R>);

  pub struct KeystoreWrapper<R: Runtime> {
    handle: PluginHandle<R>,
  }

  #[derive(Serialize)]
  struct WrapArgs {
    data: String,
  }

  #[derive(Deserialize)]
  struct WrapOut {
    data: String,
  }

  #[derive(Deserialize, Default)]
  #[serde(rename_all = "camelCase")]
  pub struct DeviceInfoOut {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub strong_box: bool,
    #[serde(default)]
    pub biometric: bool,
    /// The FCM registration token; absent until a Firebase project is configured.
    #[serde(default)]
    pub fcm_token: Option<String>,
  }

  impl<R: Runtime> KeystoreWrapper<R> {
    pub fn new(handle: PluginHandle<R>) -> Self {
      KeystoreWrapper { handle }
    }
  }

  impl<R: Runtime> Wrapper for KeystoreWrapper<R> {
    fn wrap(&self, plain: &[u8]) -> Result<Vec<u8>, KeystoreError> {
      let out: WrapOut = self
        .handle
        .run_mobile_plugin(
          "wrap",
          WrapArgs {
            data: B64.encode(plain),
          },
        )
        .map_err(|e| KeystoreError::Wrap(e.to_string()))?;
      B64
        .decode(out.data)
        .map_err(|_| KeystoreError::Corrupt("wrapped bytes"))
    }

    fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, KeystoreError> {
      let out: WrapOut = self
        .handle
        .run_mobile_plugin(
          "unwrap",
          WrapArgs {
            data: B64.encode(wrapped),
          },
        )
        .map_err(|e| KeystoreError::Wrap(e.to_string()))?;
      B64
        .decode(out.data)
        .map_err(|_| KeystoreError::Corrupt("unwrapped bytes"))
    }

    fn name(&self) -> &'static str {
      "keystore"
    }
  }

  pub fn device_info<R: Runtime>(handle: &PluginHandle<R>) -> DeviceInfoOut {
    handle
      .run_mobile_plugin::<DeviceInfoOut>("info", ())
      .unwrap_or_default()
  }

  /// Registers the Kotlin side (`app.forerunner.mobile.KeystorePlugin`).
  pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("forerunner-keystore")
      .setup(|app, api: PluginApi<R, ()>| {
        let handle = api.register_android_plugin("app.forerunner.mobile", "KeystorePlugin")?;
        app.manage(KeystoreHandle(handle));
        Ok(())
      })
      .build()
  }
}

/// Resolve directories, the wrapper and the config for this launch and build the state.
pub fn build_shell<R: Runtime>(app: &AppHandle<R>) -> Result<Shell, Box<dyn std::error::Error>> {
  let platform = Platform::current();
  let home = app
    .path()
    .home_dir()
    .or_else(|_| app.path().app_data_dir())?;
  let app_dirs = if platform == Platform::Android {
    dirs::app_dirs(&dirs::ProcessEnv, &app.path().app_data_dir()?, platform)
  } else {
    dirs::app_dirs(&dirs::ProcessEnv, &home, platform)
  };
  let mut config = ShellConfig::load(&app_dirs.config);
  let install_id = config
    .ensure_install_id(|| {
      let mut bytes = [0u8; 16];
      rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
      bytes
    })
    .to_string();
  if let Err(e) = config.save(&app_dirs.config) {
    log::warn!("could not save the shell config: {e}");
  }

  let bits = platform_bits(app);
  let files = SecureFiles::new(app_dirs.config.clone(), bits.wrapper);
  let info = ShellInfo {
    platform: platform.name().to_string(),
    version: app.package_info().version.to_string(),
    device_name: config.device_name.clone().unwrap_or(bits.device_name),
    state_url: config.state_url.clone(),
    secure_store: files.wrapper_name(),
    biometric: bits.biometric,
    install_id,
    paired: false,
  };
  log::info!(
    "shell ready: platform={} secure_store={} config_dir={}",
    info.platform,
    info.secure_store,
    files.dir().display()
  );
  let push = push::configured(bits.push_token);
  Ok(Shell::new(files, app_dirs.config, config, info, push))
}

/// What the platform provides: the wrapper for the secure files, the device's name, whether
/// a biometric prompt exists and the push registration token (none without FCM).
struct PlatformBits {
  wrapper: Box<dyn Wrapper>,
  device_name: String,
  biometric: bool,
  push_token: Option<String>,
}

#[cfg(target_os = "android")]
fn platform_bits<R: Runtime>(app: &AppHandle<R>) -> PlatformBits {
  match app.try_state::<android::KeystoreHandle<R>>() {
    Some(handle) => {
      let info = android::device_info(&handle.0);
      let device_name = if info.model.is_empty() {
        "Android phone".to_string()
      } else {
        info.model
      };
      PlatformBits {
        wrapper: Box::new(android::KeystoreWrapper::new(handle.0.clone())),
        device_name,
        biometric: info.biometric,
        push_token: info.fcm_token,
      }
    }
    None => {
      log::warn!("KeystorePlugin not registered; falling back to file-mode protection");
      PlatformBits {
        wrapper: Box::new(FileWrapper),
        device_name: "Android phone".to_string(),
        biometric: false,
        push_token: None,
      }
    }
  }
}

#[cfg(not(target_os = "android"))]
fn platform_bits<R: Runtime>(_app: &AppHandle<R>) -> PlatformBits {
  PlatformBits {
    wrapper: Box::new(FileWrapper),
    device_name: "Desktop (dev build)".to_string(),
    biometric: false,
    push_token: None,
  }
}

/// A pairing deep link at launch or later: remember its service URL for the next launch.
pub fn note_pairing_link(shell: &Shell, link: &str) {
  if let Some(parsed) = parse_pairing_link(link)
    && let Some(url) = parsed.state_url
  {
    shell.remember_state_url(&url);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn shell_for_test() -> (Shell, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
      "fr-mobile-shell-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    let files = SecureFiles::new(dir.clone(), Box::new(FileWrapper));
    let info = ShellInfo {
      platform: "linux".into(),
      version: "0.1.0".into(),
      device_name: "Test".into(),
      state_url: None,
      secure_store: "file",
      biometric: false,
      install_id: "abc".into(),
      paired: false,
    };
    let shell = Shell::new(
      files,
      dir.clone(),
      ShellConfig::default(),
      info,
      push::configured(None),
    );
    (shell, dir)
  }

  #[test]
  fn injection_script_carries_the_android_fields_and_never_a_secret() {
    let (shell, dir) = shell_for_test();
    shell
      .files()
      .expect("files")
      .set("session-token", "token-value-for-test") // not-a-secret
      .expect("set");
    shell.remember_state_url("https://state.example.test/");
    let script = shell.injection_script();
    assert!(script.starts_with("window.__FORERUNNER__ = {"));
    assert!(script.contains("\"platform\":\"linux\""));
    assert!(script.contains("\"stateUrl\":\"https://state.example.test\""));
    assert!(script.contains("\"installId\":\"abc\""));
    assert!(!script.contains("token-value-for-test"));
    assert_eq!(
      ShellConfig::load(&dir).state_url.as_deref(),
      Some("https://state.example.test")
    );
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn a_pairing_link_updates_the_remembered_service_url() {
    let (shell, dir) = shell_for_test();
    note_pairing_link(
      &shell,
      "fr://pair?u=http%3A%2F%2F10.0.2.2%3A8788&c=ABCD2345",
    );
    assert_eq!(
      shell.info().state_url.as_deref(),
      Some("http://10.0.2.2:8788")
    );
    note_pairing_link(&shell, "fr://pair?c=ABCD2345");
    assert_eq!(
      shell.info().state_url.as_deref(),
      Some("http://10.0.2.2:8788")
    );
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn shell_info_reports_paired_only_with_both_key_and_token() {
    let (shell, dir) = shell_for_test();
    assert!(!shell.recovery().paired);
    shell
      .files()
      .expect("files")
      .load_or_create_key()
      .expect("key");
    assert!(shell.recovery().has_key);
    assert!(!shell.recovery().paired);
    shell
      .files()
      .expect("files")
      .set(SESSION_TOKEN_KEY, "token-value-for-test") // not-a-secret
      .expect("set");
    assert!(shell.recovery().paired);
    assert_eq!(shell.push.status().mode, "polling");
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn a_biometric_signature_needs_the_prompts_ticket_once() {
    let (shell, dir) = shell_for_test();
    let high = b"POST\n/requests/req_cap/answer\nabc\n1760000000000\nbiometric=1";
    // A screen that fabricates an assertion has no ticket: refused before any signing.
    let missing = shell.sign(high, None).expect_err("no ticket");
    assert!(missing.starts_with("biometric ticket missing"), "{missing}");
    let forged = shell
      .sign(high, Some("00".repeat(16).as_str()))
      .expect_err("forged ticket");
    assert!(forged.contains("unknown or already used"), "{forged}");
    assert!(
      shell
        .files()
        .expect("files")
        .load_key()
        .expect("load")
        .is_none(),
      "nothing was signed, so no key was even generated"
    );

    // The prompt's ticket signs exactly one biometric=1 string.
    let ticket = shell.issue_biometric_ticket();
    assert_eq!(ticket.len(), 32);
    let signature = shell.sign(high, Some(&ticket)).expect("signed");
    let public = shell
      .files()
      .expect("files")
      .load_or_create_key()
      .expect("key")
      .public_key_b64();
    assert!(crate::keystore::verify_b64(&public, &signature, high));
    let reused = shell
      .sign(high, Some(&ticket))
      .expect_err("ticket consumed");
    assert!(reused.contains("already used"), "{reused}");

    // biometric=0 strings and the pairing proof never need or consume a ticket.
    let plain = b"POST\n/messages/m/receipt\nabc\n1760000000000\nbiometric=0";
    let spare = shell.issue_biometric_ticket();
    shell.sign(plain, None).expect("plain without ticket");
    shell
      .sign(plain, Some("whatever"))
      .expect("plain ignores the ticket");
    shell.sign(b"pair:ABCD2345", None).expect("pairing proof");
    shell
      .sign(high, Some(&spare))
      .expect("the spare ticket is still fresh");
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn keystore_errors_cross_the_bridge_without_key_material() {
    let message = keystore_err(KeystoreError::Corrupt("device key length"));
    assert_eq!(message, "keystore file is corrupt: device key length");
    assert_eq!(
      keystore_err(KeystoreError::InvalidKeyName),
      "secure store key names use [A-Za-z0-9_-] only"
    );
  }
}
