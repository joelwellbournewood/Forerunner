//! The device key and the secure store (spec R.2, R.7; ADR 0009, ADR 0032).
//!
//! The phone's identity is an Ed25519 key. Android's Keystore cannot hold Ed25519 keys before
//! API 33 and the app supports API 29+, so the seed lives in the app's private files
//! **wrapped** by a `Wrapper`: on Android the Kotlin `KeystorePlugin` wraps it with an
//! AES-256-GCM key that the Android Keystore generates and never exports (hardware-backed
//! where the phone has a StrongBox or TEE); on desktop builds and in tests the wrapper is
//! the identity and the file mode is the only protection, which `ShellInfo.secure_store`
//! reports as `file` so the UI can say so. The session token the state service issues goes
//! through the same store. The seed exists in plain form only in process memory while the
//! shell signs; it is never logged (the `Debug` impl redacts) and never leaves the process.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer, SigningKey};
#[cfg(test)]
use ed25519_dalek::{Verifier, VerifyingKey};
use rand_core::OsRng;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const SEED_LEN: usize = 32;
/// The secure-store key under which the UI keeps the state service's session token.
pub const SESSION_TOKEN_KEY: &str = "session-token";
const KEY_FILE: &str = "device-key.wrapped";
const SECURE_PREFIX: &str = "secure-";
const SECURE_SUFFIX: &str = ".wrapped";

#[derive(Debug)]
pub enum KeystoreError {
  Io(String),
  /// The platform wrapper (the Android Keystore plugin) refused; desktop builds never wrap.
  #[cfg_attr(not(target_os = "android"), allow(dead_code))]
  Wrap(String),
  Corrupt(&'static str),
  InvalidKeyName,
}

impl fmt::Display for KeystoreError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      KeystoreError::Io(m) => write!(f, "keystore io: {m}"),
      KeystoreError::Wrap(m) => write!(f, "keystore wrap: {m}"),
      KeystoreError::Corrupt(what) => write!(f, "keystore file is corrupt: {what}"),
      KeystoreError::InvalidKeyName => write!(f, "secure store key names use [A-Za-z0-9_-] only"),
    }
  }
}

impl std::error::Error for KeystoreError {}

impl From<io::Error> for KeystoreError {
  fn from(e: io::Error) -> Self {
    // io::Error messages name paths at most; never key material.
    KeystoreError::Io(e.to_string())
  }
}

/// The Ed25519 device key. `Debug` prints the public key only.
pub struct DeviceKey {
  signing: SigningKey,
}

impl fmt::Debug for DeviceKey {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "DeviceKey(pub={}, seed=<redacted>)",
      self.public_key_b64()
    )
  }
}

impl DeviceKey {
  pub fn generate() -> DeviceKey {
    DeviceKey {
      signing: SigningKey::generate(&mut OsRng),
    }
  }

  pub fn from_seed(seed: &[u8; SEED_LEN]) -> DeviceKey {
    DeviceKey {
      signing: SigningKey::from_bytes(seed),
    }
  }

  /// 32-byte public key, base64 (what the service stores at pairing).
  pub fn public_key_b64(&self) -> String {
    B64.encode(self.signing.verifying_key().as_bytes())
  }

  /// Ed25519 signature over `message`, base64 (the `X-Device-Signature` value).
  pub fn sign_b64(&self, message: &[u8]) -> String {
    B64.encode(self.signing.sign(message).to_bytes())
  }

  fn seed(&self) -> [u8; SEED_LEN] {
    self.signing.to_bytes()
  }
}

/// Verify with a base64 public key and signature: what the service does; used by the tests.
#[cfg(test)]
pub fn verify_b64(public_key_b64: &str, signature_b64: &str, message: &[u8]) -> bool {
  let Ok(pk) = B64.decode(public_key_b64) else {
    return false;
  };
  let Ok(sig) = B64.decode(signature_b64) else {
    return false;
  };
  let Ok(pk_bytes) = <[u8; 32]>::try_from(pk.as_slice()) else {
    return false;
  };
  let Ok(sig_bytes) = <[u8; 64]>::try_from(sig.as_slice()) else {
    return false;
  };
  let Ok(key) = VerifyingKey::from_bytes(&pk_bytes) else {
    return false;
  };
  key
    .verify(message, &ed25519_dalek::Signature::from_bytes(&sig_bytes))
    .is_ok()
}

/// Wraps bytes at rest. The Android implementation lives in `commands.rs` (Keystore AES-GCM
/// through the Kotlin plugin); `FileWrapper` is the identity for desktop builds and tests.
pub trait Wrapper: Send + Sync {
  fn wrap(&self, plain: &[u8]) -> Result<Vec<u8>, KeystoreError>;
  fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, KeystoreError>;
  /// "keystore" (Android Keystore) or "file" (mode 0600 only); shown in the UI.
  fn name(&self) -> &'static str;
}

pub struct FileWrapper;

impl Wrapper for FileWrapper {
  fn wrap(&self, plain: &[u8]) -> Result<Vec<u8>, KeystoreError> {
    Ok(plain.to_vec())
  }
  fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, KeystoreError> {
    Ok(wrapped.to_vec())
  }
  fn name(&self) -> &'static str {
    "file"
  }
}

/// The wrapped files under the config directory: the device key and the secure values.
pub struct SecureFiles {
  dir: PathBuf,
  wrapper: Box<dyn Wrapper>,
}

impl SecureFiles {
  pub fn new(dir: PathBuf, wrapper: Box<dyn Wrapper>) -> SecureFiles {
    SecureFiles { dir, wrapper }
  }

  pub fn wrapper_name(&self) -> &'static str {
    self.wrapper.name()
  }

  pub fn dir(&self) -> &Path {
    &self.dir
  }

  fn key_path(&self) -> PathBuf {
    self.dir.join(KEY_FILE)
  }

  fn secure_path(&self, key: &str) -> Result<PathBuf, KeystoreError> {
    if key.is_empty()
      || !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
      return Err(KeystoreError::InvalidKeyName);
    }
    Ok(
      self
        .dir
        .join(format!("{SECURE_PREFIX}{key}{SECURE_SUFFIX}")),
    )
  }

  fn write_private(&self, path: &Path, bytes: &[u8]) -> Result<(), KeystoreError> {
    fs::create_dir_all(&self.dir)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    restrict(&tmp)?;
    fs::rename(&tmp, path)?;
    Ok(())
  }

  fn read_unwrapped(&self, path: &Path) -> Result<Option<Vec<u8>>, KeystoreError> {
    match fs::read(path) {
      Ok(bytes) => Ok(Some(self.wrapper.unwrap(&bytes)?)),
      Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
      Err(e) => Err(e.into()),
    }
  }

  /// The device key, generated and stored on first use.
  pub fn load_or_create_key(&self) -> Result<DeviceKey, KeystoreError> {
    if let Some(key) = self.load_key()? {
      return Ok(key);
    }
    let key = DeviceKey::generate();
    let wrapped = self.wrapper.wrap(&key.seed())?;
    self.write_private(&self.key_path(), &wrapped)?;
    Ok(key)
  }

  pub fn load_key(&self) -> Result<Option<DeviceKey>, KeystoreError> {
    let Some(seed) = self.read_unwrapped(&self.key_path())? else {
      return Ok(None);
    };
    let seed: [u8; SEED_LEN] = seed
      .as_slice()
      .try_into()
      .map_err(|_| KeystoreError::Corrupt("device key length"))?;
    Ok(Some(DeviceKey::from_seed(&seed)))
  }

  /// Forget the identity: the desktop revokes the device row; this phone starts over.
  pub fn forget_key(&self) -> Result<(), KeystoreError> {
    match fs::remove_file(self.key_path()) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e.into()),
    }
  }

  pub fn get(&self, key: &str) -> Result<Option<String>, KeystoreError> {
    let path = self.secure_path(key)?;
    match self.read_unwrapped(&path)? {
      Some(bytes) => Ok(Some(
        String::from_utf8(bytes).map_err(|_| KeystoreError::Corrupt("secure value utf-8"))?,
      )),
      None => Ok(None),
    }
  }

  pub fn set(&self, key: &str, value: &str) -> Result<(), KeystoreError> {
    let path = self.secure_path(key)?;
    let wrapped = self.wrapper.wrap(value.as_bytes())?;
    self.write_private(&path, &wrapped)
  }

  pub fn delete(&self, key: &str) -> Result<(), KeystoreError> {
    let path = self.secure_path(key)?;
    match fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e.into()),
    }
  }
}

#[cfg(unix)]
fn restrict(path: &Path) -> Result<(), KeystoreError> {
  use std::os::unix::fs::PermissionsExt;
  fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
  Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> Result<(), KeystoreError> {
  // Windows: the profile directory is already private to the user account.
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// RFC 8032 section 7.1 test 1; a public test vector, not a credential.
  const RFC_SEED_HEX: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // not-a-secret
  const RFC_PUBLIC_HEX: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const RFC_SIG_HEX: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

  fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
      .step_by(2)
      .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex fixture"))
      .collect()
  }

  fn tmp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "fr-mobile-keystore-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
  }

  /// A wrapper that is visibly not the identity, so the tests see wrapping at work.
  struct XorWrapper;
  impl Wrapper for XorWrapper {
    fn wrap(&self, plain: &[u8]) -> Result<Vec<u8>, KeystoreError> {
      Ok(plain.iter().map(|b| b ^ 0x5a).collect())
    }
    fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, KeystoreError> {
      Ok(wrapped.iter().map(|b| b ^ 0x5a).collect())
    }
    fn name(&self) -> &'static str {
      "xor-test"
    }
  }

  #[test]
  fn reproduces_the_rfc_8032_vector() {
    let seed: [u8; 32] = hex(RFC_SEED_HEX).as_slice().try_into().expect("32 bytes");
    let key = DeviceKey::from_seed(&seed);
    assert_eq!(
      B64.decode(key.public_key_b64()).expect("b64"),
      hex(RFC_PUBLIC_HEX)
    );
    let sig = key.sign_b64(b"");
    assert_eq!(B64.decode(&sig).expect("b64"), hex(RFC_SIG_HEX));
    assert!(verify_b64(&key.public_key_b64(), &sig, b""));
    assert!(!verify_b64(&key.public_key_b64(), &sig, b"x"));
    assert!(!verify_b64("nope", &sig, b""));
  }

  #[test]
  fn debug_never_prints_the_seed() {
    let seed: [u8; 32] = hex(RFC_SEED_HEX).as_slice().try_into().expect("32 bytes");
    let key = DeviceKey::from_seed(&seed);
    let shown = format!("{key:?}");
    assert!(shown.contains("seed=<redacted>"));
    assert!(!shown.contains(RFC_SEED_HEX));
    assert!(!shown.contains(&B64.encode(seed)));
  }

  #[test]
  fn key_round_trips_through_the_wrapped_file_and_can_be_forgotten() {
    let dir = tmp();
    let files = SecureFiles::new(dir.clone(), Box::new(XorWrapper));
    assert!(files.load_key().expect("load").is_none());
    let first = files.load_or_create_key().expect("create");
    let again = files.load_or_create_key().expect("reload");
    assert_eq!(first.public_key_b64(), again.public_key_b64());
    let on_disk = fs::read(dir.join(KEY_FILE)).expect("file");
    assert_ne!(
      on_disk,
      first.seed().to_vec(),
      "the seed is wrapped at rest"
    );
    assert_eq!(on_disk.len(), SEED_LEN);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = fs::metadata(dir.join(KEY_FILE))
        .expect("meta")
        .permissions()
        .mode()
        & 0o777;
      assert_eq!(mode, 0o600);
    }
    let message = b"POST\n/x\nabc\n1\nbiometric=1";
    assert!(verify_b64(
      &first.public_key_b64(),
      &again.sign_b64(message),
      message
    ));
    files.forget_key().expect("forget");
    assert!(files.load_key().expect("load").is_none());
    files.forget_key().expect("forget twice is fine");
    let fresh = files.load_or_create_key().expect("new key");
    assert_ne!(fresh.public_key_b64(), first.public_key_b64());
    fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn secure_values_are_wrapped_and_names_are_checked() {
    let dir = tmp();
    let files = SecureFiles::new(dir.clone(), Box::new(XorWrapper));
    assert_eq!(files.wrapper_name(), "xor-test");
    assert_eq!(files.get("session-token").expect("get"), None);
    let token = ["not", "a", "real", "token", "value"].join("-"); // not-a-secret
    files.set("session-token", &token).expect("set");
    assert_eq!(
      files.get("session-token").expect("get"),
      Some(token.clone())
    );
    let raw = fs::read(dir.join("secure-session-token.wrapped")).expect("file");
    assert!(
      !String::from_utf8_lossy(&raw).contains(&token),
      "wrapped at rest"
    );
    files.delete("session-token").expect("delete");
    assert_eq!(files.get("session-token").expect("get"), None);
    assert!(matches!(
      files.get("../etc/passwd"),
      Err(KeystoreError::InvalidKeyName)
    ));
    assert!(matches!(
      files.set("", "x"),
      Err(KeystoreError::InvalidKeyName)
    ));
    fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn a_corrupt_key_file_is_reported_not_used() {
    let dir = tmp();
    let files = SecureFiles::new(dir.clone(), Box::new(FileWrapper));
    fs::write(dir.join(KEY_FILE), b"short").expect("write");
    assert!(matches!(files.load_key(), Err(KeystoreError::Corrupt(_))));
    let shown = format!("{}", KeystoreError::Corrupt("device key length"));
    assert!(shown.contains("corrupt"));
    fs::remove_dir_all(dir).ok();
  }
}
