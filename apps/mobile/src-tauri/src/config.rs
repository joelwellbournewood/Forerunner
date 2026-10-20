//! The shell's own small config (`<config>/mobile.json`): the state service address the
//! phone was last given (by a build setting, a deep link or the pairing screen) and the
//! device name, so the shell can inject both into the UI on the next launch. The session
//! token is never here: it lives in the secure store (`keystore.rs`). Parsing is total:
//! a missing or malformed file is an empty config, never a crash at startup.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "mobile.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellConfig {
  /// Absolute base URL of the shared state service, without a trailing slash.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub state_url: Option<String>,
  /// The name this phone pairs as (shown in Settings → Devices on the desktop).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub device_name: Option<String>,
  /// A random id made on first launch; namespaces the UI's per-install browser storage.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub install_id: Option<String>,
}

impl ShellConfig {
  /// Parse JSON leniently: unknown fields are ignored, empty strings read as absent.
  pub fn parse(text: &str) -> ShellConfig {
    let mut cfg: ShellConfig = serde_json::from_str(text).unwrap_or_default();
    cfg.state_url = cfg
      .state_url
      .map(|u| u.trim().trim_end_matches('/').to_string())
      .filter(|u| u.starts_with("http://") || u.starts_with("https://"));
    cfg.device_name = cfg
      .device_name
      .map(|n| n.trim().chars().take(120).collect::<String>())
      .filter(|n| !n.is_empty());
    cfg.install_id = cfg.install_id.filter(|id| {
      !id.is_empty()
        && id.len() <= 64
        && id
          .chars()
          .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    cfg
  }

  /// The install id, made once and kept (hex of 16 random bytes).
  pub fn ensure_install_id(&mut self, random: impl FnOnce() -> [u8; 16]) -> &str {
    if self.install_id.is_none() {
      let bytes = random();
      self.install_id = Some(bytes.iter().map(|b| format!("{b:02x}")).collect());
    }
    self.install_id.as_deref().unwrap_or("local")
  }

  pub fn load(config_dir: &Path) -> ShellConfig {
    match fs::read_to_string(config_dir.join(CONFIG_FILE)) {
      Ok(text) => ShellConfig::parse(&text),
      Err(_) => ShellConfig::default(),
    }
  }

  pub fn save(&self, config_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let path: PathBuf = config_dir.join(CONFIG_FILE);
    let tmp = path.with_extension("tmp");
    let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path)?;
    Ok(())
  }
}

/// What the shell finds when it starts again (an app the system killed, a reboot).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
  /// A device key exists.
  pub has_key: bool,
  /// A session token exists.
  pub has_token: bool,
  /// Both exist: the UI can go straight to Home; otherwise it pairs.
  pub paired: bool,
}

pub fn recover(has_key: bool, has_token: bool) -> Recovery {
  Recovery {
    has_key,
    has_token,
    paired: has_key && has_token,
  }
}

/// A deep link the app was opened with: `fr://pair?u=<service url>&c=<code>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingLink {
  pub state_url: Option<String>,
  pub code: String,
}

/// Parse a pairing link; the UI does the same (`mobile/pairing.ts`), the shell only needs
/// the service URL to remember it for the next launch.
pub fn parse_pairing_link(link: &str) -> Option<PairingLink> {
  let rest = link.strip_prefix("fr://pair")?;
  let query = rest.strip_prefix('?').or_else(|| rest.strip_prefix("/?"))?;
  let mut state_url = None;
  let mut code = None;
  for pair in query.split('&') {
    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
    let value = percent_decode(v);
    match k {
      "u" | "url" => {
        let trimmed = value.trim().trim_end_matches('/').to_string();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
          state_url = Some(trimmed);
        }
      }
      "c" | "code" => {
        let normalized: String = value
          .chars()
          .filter(|c| !c.is_whitespace() && *c != '-')
          .map(|c| c.to_ascii_uppercase())
          .collect();
        if normalized.len() == 8 && normalized.chars().all(|c| c.is_ascii_alphanumeric()) {
          code = Some(normalized);
        }
      }
      _ => {}
    }
  }
  code.map(|code| PairingLink { state_url, code })
}

fn percent_decode(text: &str) -> String {
  let bytes = text.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'%' if i + 2 < bytes.len() => {
        let hex = &text[i + 1..i + 3];
        match u8::from_str_radix(hex, 16) {
          Ok(b) => {
            out.push(b);
            i += 3;
          }
          Err(_) => {
            out.push(b'%');
            i += 1;
          }
        }
      }
      b'+' => {
        out.push(b' ');
        i += 1;
      }
      b => {
        out.push(b);
        i += 1;
      }
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_leniently_and_normalises() {
    let cfg = ShellConfig::parse(
      r#"{"state_url":"https://state.example.test/","device_name":"  Pixel  ","extra":1}"#,
    );
    assert_eq!(cfg.state_url.as_deref(), Some("https://state.example.test"));
    assert_eq!(cfg.device_name.as_deref(), Some("Pixel"));
    assert_eq!(ShellConfig::parse("not json"), ShellConfig::default());
    assert_eq!(
      ShellConfig::parse(r#"{"state_url":"ftp://x","device_name":""}"#),
      ShellConfig::default()
    );
    assert_eq!(ShellConfig::parse("{}"), ShellConfig::default());
  }

  #[test]
  fn saves_and_loads_from_the_config_dir() {
    let dir = std::env::temp_dir().join(format!("fr-mobile-config-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(ShellConfig::load(&dir), ShellConfig::default());
    let cfg = ShellConfig {
      state_url: Some("http://10.0.2.2:8788".into()),
      device_name: Some("Emulator".into()),
      install_id: Some("abc123".into()),
    };
    cfg.save(&dir).expect("save");
    assert_eq!(ShellConfig::load(&dir), cfg);
    fs::write(dir.join(CONFIG_FILE), "{broken").expect("write");
    assert_eq!(ShellConfig::load(&dir), ShellConfig::default());
    fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn install_id_is_made_once_and_validated() {
    let mut cfg = ShellConfig::default();
    let id = cfg.ensure_install_id(|| [0xab; 16]).to_string();
    assert_eq!(id, "ab".repeat(16));
    assert_eq!(cfg.ensure_install_id(|| [0xcd; 16]), id);
    assert_eq!(
      ShellConfig::parse(r#"{"install_id":"../x"}"#).install_id,
      None
    );
    assert_eq!(
      ShellConfig::parse(r#"{"install_id":"ok-1"}"#)
        .install_id
        .as_deref(),
      Some("ok-1")
    );
  }

  #[test]
  fn recovery_needs_both_key_and_token() {
    assert!(recover(true, true).paired);
    assert!(!recover(true, false).paired);
    assert!(!recover(false, true).paired);
    assert_eq!(
      recover(false, false),
      Recovery {
        has_key: false,
        has_token: false,
        paired: false
      }
    );
  }

  #[test]
  fn parses_the_pairing_deep_link() {
    let link =
      parse_pairing_link("fr://pair?u=https%3A%2F%2Fstate.example.test&c=abcd-2345&h=human_j")
        .expect("link");
    assert_eq!(
      link.state_url.as_deref(),
      Some("https://state.example.test")
    );
    assert_eq!(link.code, "ABCD2345");
    assert_eq!(
      parse_pairing_link("fr://pair?c=ABCD2345")
        .expect("code only")
        .state_url,
      None
    );
    assert!(parse_pairing_link("fr://pair?u=https://x.test").is_none());
    assert!(parse_pairing_link("fr://other?c=ABCD2345").is_none());
    assert!(parse_pairing_link("https://x.test/pair?c=ABCD2345").is_none());
    assert_eq!(percent_decode("a%20b+c%zz"), "a b c%zz");
  }
}
