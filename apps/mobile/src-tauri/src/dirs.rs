//! Application directories, mirroring `packages/platform/src/paths.ts` (`appDirs`) so the
//! shell and the runtime agree on where things live (ADR 0026: "the shells must mirror the
//! app-directory logic in Rust"). `FORERUNNER_HOME` overrides everything; otherwise the
//! Windows known-folder layout, the macOS library layout or the XDG base directories apply.
//! On Android the base is the app's private files directory Tauri reports, and the same
//! six sub-directories hang under it.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
  /// Config: settings, device identity, pairing.
  pub config: PathBuf,
  /// Data: SQLite state, memory, docs cache, audit log.
  pub data: PathBuf,
  /// Cache: compressed context, model lists, downloads.
  pub cache: PathBuf,
  /// Logs.
  pub logs: PathBuf,
  /// Working trees for sandboxed tasks.
  pub worktrees: PathBuf,
  /// Runtime sockets / pid files.
  pub runtime: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
  Windows,
  Macos,
  Linux,
  Android,
}

impl Platform {
  pub fn current() -> Platform {
    if cfg!(target_os = "windows") {
      Platform::Windows
    } else if cfg!(target_os = "macos") {
      Platform::Macos
    } else if cfg!(target_os = "android") {
      Platform::Android
    } else {
      Platform::Linux
    }
  }

  pub fn name(self) -> &'static str {
    match self {
      Platform::Windows => "windows",
      Platform::Macos => "macos",
      Platform::Linux => "linux",
      Platform::Android => "android",
    }
  }
}

pub const APP_NAME: &str = "forerunner";

/// Environment lookup, injectable for tests.
pub trait Env {
  fn get(&self, name: &str) -> Option<String>;
}

pub struct ProcessEnv;

impl Env for ProcessEnv {
  fn get(&self, name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
  }
}

impl<F> Env for F
where
  F: Fn(&str) -> Option<String>,
{
  fn get(&self, name: &str) -> Option<String> {
    self(name)
  }
}

/// The six directories under one root (the `FORERUNNER_HOME` layout and the Android layout).
pub fn under(root: &Path) -> AppDirs {
  AppDirs {
    config: root.join("config"),
    data: root.join("data"),
    cache: root.join("cache"),
    logs: root.join("logs"),
    worktrees: root.join("worktrees"),
    runtime: root.join("runtime"),
  }
}

/// `appDirs()` from the platform package. `home` is the user's home (or the Android base
/// directory); `env` answers `FORERUNNER_HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_*`.
pub fn app_dirs(env: &dyn Env, home: &Path, platform: Platform) -> AppDirs {
  if let Some(override_root) = env.get("FORERUNNER_HOME") {
    return under(Path::new(&override_root));
  }
  match platform {
    Platform::Windows => {
      let app_data = env
        .get("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
      let local = env
        .get("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
      AppDirs {
        config: app_data.join(APP_NAME).join("config"),
        data: local.join(APP_NAME).join("data"),
        cache: local.join(APP_NAME).join("cache"),
        logs: local.join(APP_NAME).join("logs"),
        worktrees: local.join(APP_NAME).join("worktrees"),
        runtime: local.join(APP_NAME).join("runtime"),
      }
    }
    Platform::Macos => {
      let lib = home.join("Library");
      let support = lib.join("Application Support").join(APP_NAME);
      AppDirs {
        config: support.join("config"),
        data: support.join("data"),
        cache: lib.join("Caches").join(APP_NAME),
        logs: lib.join("Logs").join(APP_NAME),
        worktrees: support.join("worktrees"),
        runtime: support.join("runtime"),
      }
    }
    Platform::Android => under(home),
    Platform::Linux => {
      let xdg =
        |name: &str, fallback: PathBuf| env.get(name).map(PathBuf::from).unwrap_or(fallback);
      let config = xdg("XDG_CONFIG_HOME", home.join(".config"));
      let data = xdg("XDG_DATA_HOME", home.join(".local").join("share"));
      let cache = xdg("XDG_CACHE_HOME", home.join(".cache"));
      let state = xdg("XDG_STATE_HOME", home.join(".local").join("state"));
      let runtime = xdg("XDG_RUNTIME_DIR", cache.join(APP_NAME).join("runtime"));
      AppDirs {
        config: config.join(APP_NAME),
        data: data.join(APP_NAME),
        cache: cache.join(APP_NAME),
        logs: state.join(APP_NAME).join("logs"),
        worktrees: data.join(APP_NAME).join("worktrees"),
        runtime: runtime.join(APP_NAME),
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
      .iter()
      .map(|(k, v)| (k.to_string(), v.to_string()))
      .collect()
  }

  fn lookup(map: &HashMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
    move |name| map.get(name).cloned()
  }

  #[test]
  fn forerunner_home_overrides_everything() {
    let map = env(&[
      ("FORERUNNER_HOME", "/tmp/fr-home"),
      ("XDG_CONFIG_HOME", "/elsewhere"),
    ]);
    for platform in [
      Platform::Linux,
      Platform::Windows,
      Platform::Macos,
      Platform::Android,
    ] {
      let dirs = app_dirs(&lookup(&map), Path::new("/home/u"), platform);
      assert_eq!(dirs.config, PathBuf::from("/tmp/fr-home/config"));
      assert_eq!(dirs.runtime, PathBuf::from("/tmp/fr-home/runtime"));
      assert_eq!(dirs.worktrees, PathBuf::from("/tmp/fr-home/worktrees"));
    }
  }

  #[test]
  fn linux_follows_xdg_defaults_and_overrides() {
    let home = Path::new("/home/u");
    let dirs = app_dirs(&lookup(&env(&[])), home, Platform::Linux);
    assert_eq!(dirs.config, PathBuf::from("/home/u/.config/forerunner"));
    assert_eq!(dirs.data, PathBuf::from("/home/u/.local/share/forerunner"));
    assert_eq!(dirs.cache, PathBuf::from("/home/u/.cache/forerunner"));
    assert_eq!(
      dirs.logs,
      PathBuf::from("/home/u/.local/state/forerunner/logs")
    );
    assert_eq!(
      dirs.worktrees,
      PathBuf::from("/home/u/.local/share/forerunner/worktrees")
    );
    assert_eq!(
      dirs.runtime,
      PathBuf::from("/home/u/.cache/forerunner/runtime/forerunner")
    );
    let map = env(&[
      ("XDG_CONFIG_HOME", "/cfg"),
      ("XDG_RUNTIME_DIR", "/run/user/1000"),
    ]);
    let dirs = app_dirs(&lookup(&map), home, Platform::Linux);
    assert_eq!(dirs.config, PathBuf::from("/cfg/forerunner"));
    assert_eq!(dirs.runtime, PathBuf::from("/run/user/1000/forerunner"));
  }

  #[test]
  fn windows_uses_the_known_folders() {
    let map = env(&[
      ("APPDATA", "C:\\Users\\u\\AppData\\Roaming"),
      ("LOCALAPPDATA", "C:\\Users\\u\\AppData\\Local"),
    ]);
    let dirs = app_dirs(&lookup(&map), Path::new("C:\\Users\\u"), Platform::Windows);
    assert_eq!(
      dirs.config,
      Path::new("C:\\Users\\u\\AppData\\Roaming")
        .join("forerunner")
        .join("config")
    );
    assert_eq!(
      dirs.data,
      Path::new("C:\\Users\\u\\AppData\\Local")
        .join("forerunner")
        .join("data")
    );
    let dirs = app_dirs(&lookup(&env(&[])), Path::new("/h"), Platform::Windows);
    assert_eq!(
      dirs.config,
      Path::new("/h")
        .join("AppData")
        .join("Roaming")
        .join("forerunner")
        .join("config")
    );
  }

  #[test]
  fn macos_and_android_layouts() {
    let dirs = app_dirs(&lookup(&env(&[])), Path::new("/Users/u"), Platform::Macos);
    assert_eq!(
      dirs.cache,
      PathBuf::from("/Users/u/Library/Caches/forerunner")
    );
    assert_eq!(dirs.logs, PathBuf::from("/Users/u/Library/Logs/forerunner"));
    let dirs = app_dirs(
      &lookup(&env(&[])),
      Path::new("/data/user/0/app.forerunner.mobile/files"),
      Platform::Android,
    );
    assert_eq!(
      dirs.config,
      PathBuf::from("/data/user/0/app.forerunner.mobile/files/config")
    );
    assert_eq!(
      dirs.data,
      PathBuf::from("/data/user/0/app.forerunner.mobile/files/data")
    );
    assert_eq!(Platform::Android.name(), "android");
  }
}
