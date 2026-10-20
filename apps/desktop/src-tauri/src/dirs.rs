//! Application directories: a line-for-line mirror of `appDirs()` in
//! `packages/platform/src/paths.ts` (ADR 0026 requires the shells to resolve the same
//! directories as the runtime). `FORERUNNER_HOME` overrides everything; Windows uses the known
//! folders `APPDATA` / `LOCALAPPDATA`; Linux (and anything else) follows the XDG base directory
//! spec. The fixture table in the tests matches `packages/platform/test/paths.test.ts`.
//!
//! Rules that must stay identical on both sides:
//! - an environment variable that is set but empty counts as set (Node's `??` semantics);
//! - the home directory is `HOME`, else `USERPROFILE`, else the OS home directory;
//! - `FORERUNNER_HOME` is resolved against the current directory like `path.resolve`.

use std::path::{Component, Path, PathBuf};

use crate::env::Env;

pub const APP_NAME: &str = "forerunner";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    Macos,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Linux
        }
    }

    /// The value the shell injects as `platform` (ADR 0025).
    pub fn label(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Linux => "linux",
            Platform::Macos => "macos",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
    /// Config: settings, device identity, pairing, `install-id`, `install.json`.
    pub config: PathBuf,
    /// Data: SQLite state, memory, docs cache, audit log, staged versions.
    pub data: PathBuf,
    /// Cache: compressed context, model lists, downloads.
    pub cache: PathBuf,
    /// Logs (`daemon-shell.log`, `desktop-shell.log`).
    pub logs: PathBuf,
    /// Working trees for sandboxed tasks.
    pub worktrees: PathBuf,
    /// Runtime sockets / pid files: `daemon.json`, `restart.json`.
    pub runtime: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct AppDirsOptions {
    pub app_name: Option<String>,
    pub home: Option<PathBuf>,
    pub platform: Option<Platform>,
    /// Base for a relative `FORERUNNER_HOME` (`path.resolve` uses the current directory).
    pub cwd: Option<PathBuf>,
}

fn env_path(env: &impl Env, key: &str) -> Option<PathBuf> {
    env.var(key).map(PathBuf::from)
}

/// Home directory as `paths.ts` picks it: `opts.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir()`.
pub fn home_dir(env: &impl Env, explicit: Option<&Path>) -> PathBuf {
    if let Some(h) = explicit {
        return h.to_path_buf();
    }
    if let Some(h) = env_path(env, "HOME") {
        return h;
    }
    if let Some(h) = env_path(env, "USERPROFILE") {
        return h;
    }
    os_home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn os_home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

/// Lexical `path.resolve`: make absolute against `cwd` and collapse `.` and `..` without
/// touching the file system. A `..` that would climb above the root is dropped, as Node does
/// (`path.resolve("/../x") === "/x"`); only a relative result keeps a leading `..`.
pub fn resolve_path(p: &Path, cwd: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop` refuses to remove the root (and a Windows prefix): at the root a
                // `..` has nowhere to go and is dropped.
                let popped = out.pop();
                if !popped && !out.has_root() {
                    out.push(c.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Per-OS application directories, exactly as `appDirs()` computes them.
pub fn app_dirs(env: &impl Env, opts: &AppDirsOptions) -> AppDirs {
    let app_name = opts
        .app_name
        .clone()
        .unwrap_or_else(|| APP_NAME.to_string());
    let app = app_name.as_str();
    let home = home_dir(env, opts.home.as_deref());
    let platform = opts.platform.unwrap_or_else(Platform::current);

    if let Some(over) = env.var("FORERUNNER_HOME")
        && !over.is_empty()
    {
        let cwd = opts
            .cwd
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let root = resolve_path(Path::new(&over), &cwd);
        return AppDirs {
            config: root.join("config"),
            data: root.join("data"),
            cache: root.join("cache"),
            logs: root.join("logs"),
            worktrees: root.join("worktrees"),
            runtime: root.join("runtime"),
        };
    }

    match platform {
        Platform::Windows => {
            let app_data =
                env_path(env, "APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
            let local_app_data =
                env_path(env, "LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
            AppDirs {
                config: app_data.join(app).join("config"),
                data: local_app_data.join(app).join("data"),
                cache: local_app_data.join(app).join("cache"),
                logs: local_app_data.join(app).join("logs"),
                worktrees: local_app_data.join(app).join("worktrees"),
                runtime: local_app_data.join(app).join("runtime"),
            }
        }
        Platform::Macos => {
            let lib = home.join("Library");
            let support = lib.join("Application Support").join(app);
            AppDirs {
                config: support.join("config"),
                data: support.join("data"),
                cache: lib.join("Caches").join(app),
                logs: lib.join("Logs").join(app),
                worktrees: support.join("worktrees"),
                runtime: support.join("runtime"),
            }
        }
        Platform::Linux => {
            let xdg_config =
                env_path(env, "XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
            let xdg_data =
                env_path(env, "XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share"));
            let xdg_cache = env_path(env, "XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache"));
            let xdg_state = env_path(env, "XDG_STATE_HOME")
                .unwrap_or_else(|| home.join(".local").join("state"));
            let xdg_runtime = env_path(env, "XDG_RUNTIME_DIR")
                .unwrap_or_else(|| xdg_cache.join(app).join("runtime"));
            AppDirs {
                config: xdg_config.join(app),
                data: xdg_data.join(app),
                cache: xdg_cache.join(app),
                logs: xdg_state.join(app).join("logs"),
                worktrees: xdg_data.join(app).join("worktrees"),
                runtime: xdg_runtime.join(app),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::MapEnv;

    /// `toPosix` from paths.ts: forward slashes for comparisons, whatever the OS.
    fn posix(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    fn opts(platform: Platform, home: &str) -> AppDirsOptions {
        AppDirsOptions {
            platform: Some(platform),
            home: Some(PathBuf::from(home)),
            cwd: Some(PathBuf::from("/cwd")),
            ..Default::default()
        }
    }

    // Mirrors "uses FORERUNNER_HOME as an override on every platform".
    #[test]
    fn forerunner_home_overrides_on_every_platform() {
        for platform in [Platform::Windows, Platform::Linux, Platform::Macos] {
            let env = MapEnv::new(&[("FORERUNNER_HOME", "/tmp/fr")]);
            let d = app_dirs(&env, &opts(platform, "/home/j"));
            assert!(
                posix(&d.config).ends_with("fr/config"),
                "{platform:?}: {:?}",
                d.config
            );
            assert!(posix(&d.data).ends_with("fr/data"), "{platform:?}");
            assert!(posix(&d.cache).ends_with("fr/cache"));
            assert!(posix(&d.logs).ends_with("fr/logs"));
            assert!(posix(&d.worktrees).ends_with("fr/worktrees"));
            assert!(posix(&d.runtime).ends_with("fr/runtime"));
        }
    }

    #[test]
    fn relative_forerunner_home_resolves_against_cwd_like_path_resolve() {
        let env = MapEnv::new(&[("FORERUNNER_HOME", "../fr/./x/..")]);
        let d = app_dirs(&env, &opts(Platform::Linux, "/home/j"));
        assert_eq!(posix(&d.config), "/fr/config");
    }

    /// Node's `path.resolve` drops `..` segments that would climb above the root
    /// (`path.resolve("/../x") === "/x"`); a relative base has no root to stop at.
    #[test]
    fn parent_segments_above_the_root_are_dropped_like_path_resolve() {
        assert_eq!(
            posix(&resolve_path(Path::new("/../x"), Path::new("/cwd"))),
            "/x"
        );
        assert_eq!(
            posix(&resolve_path(Path::new("../../../x"), Path::new("/a/b"))),
            "/x"
        );
        let env = MapEnv::new(&[("FORERUNNER_HOME", "../../fr")]);
        let d = app_dirs(
            &env,
            &AppDirsOptions {
                cwd: Some(PathBuf::from("/a")),
                ..opts(Platform::Linux, "/home/j")
            },
        );
        assert_eq!(posix(&d.config), "/fr/config");
        assert_eq!(
            posix(&resolve_path(Path::new("../x"), Path::new("."))),
            "../x"
        );
    }

    #[test]
    fn empty_forerunner_home_is_ignored() {
        // Node: `if (override)` — an empty string is falsy, so the OS layout applies.
        let env = MapEnv::new(&[("FORERUNNER_HOME", ""), ("XDG_CONFIG_HOME", "/x/cfg")]);
        let d = app_dirs(&env, &opts(Platform::Linux, "/home/j"));
        assert_eq!(posix(&d.config), "/x/cfg/forerunner");
    }

    // Mirrors "follows known folders on Windows and XDG on Linux".
    #[test]
    fn follows_known_folders_on_windows_and_xdg_on_linux() {
        let win = app_dirs(
            &MapEnv::new(&[
                ("APPDATA", "C:\\Users\\j\\AppData\\Roaming"),
                ("LOCALAPPDATA", "C:\\Users\\j\\AppData\\Local"),
            ]),
            &opts(Platform::Windows, "C:\\Users\\j"),
        );
        assert!(posix(&win.config).contains("AppData/Roaming/forerunner/config"));
        assert!(posix(&win.data).contains("AppData/Local/forerunner/data"));
        assert!(posix(&win.cache).contains("AppData/Local/forerunner/cache"));
        assert!(posix(&win.logs).contains("AppData/Local/forerunner/logs"));
        assert!(posix(&win.worktrees).contains("AppData/Local/forerunner/worktrees"));
        assert!(posix(&win.runtime).contains("AppData/Local/forerunner/runtime"));

        let lin = app_dirs(
            &MapEnv::new(&[("XDG_CONFIG_HOME", "/x/cfg")]),
            &opts(Platform::Linux, "/home/j"),
        );
        assert_eq!(posix(&lin.config), "/x/cfg/forerunner");
        assert_eq!(posix(&lin.data), "/home/j/.local/share/forerunner");
    }

    /// The full fixture table: every directory on each platform with and without the
    /// environment, so a drift from paths.ts is caught per field.
    #[test]
    fn fixture_table() {
        struct Case {
            name: &'static str,
            platform: Platform,
            home: &'static str,
            env: &'static [(&'static str, &'static str)],
            expect: [&'static str; 6], // config, data, cache, logs, worktrees, runtime
        }
        let cases = [
            Case {
                name: "windows without known-folder variables",
                platform: Platform::Windows,
                home: "C:\\Users\\j",
                env: &[],
                expect: [
                    "C:/Users/j/AppData/Roaming/forerunner/config",
                    "C:/Users/j/AppData/Local/forerunner/data",
                    "C:/Users/j/AppData/Local/forerunner/cache",
                    "C:/Users/j/AppData/Local/forerunner/logs",
                    "C:/Users/j/AppData/Local/forerunner/worktrees",
                    "C:/Users/j/AppData/Local/forerunner/runtime",
                ],
            },
            Case {
                name: "windows with known folders",
                platform: Platform::Windows,
                home: "C:\\Users\\j",
                env: &[("APPDATA", "D:\\Roaming"), ("LOCALAPPDATA", "D:\\Local")],
                expect: [
                    "D:/Roaming/forerunner/config",
                    "D:/Local/forerunner/data",
                    "D:/Local/forerunner/cache",
                    "D:/Local/forerunner/logs",
                    "D:/Local/forerunner/worktrees",
                    "D:/Local/forerunner/runtime",
                ],
            },
            Case {
                name: "linux defaults (no XDG variables)",
                platform: Platform::Linux,
                home: "/home/j",
                env: &[],
                expect: [
                    "/home/j/.config/forerunner",
                    "/home/j/.local/share/forerunner",
                    "/home/j/.cache/forerunner",
                    "/home/j/.local/state/forerunner/logs",
                    "/home/j/.local/share/forerunner/worktrees",
                    "/home/j/.cache/forerunner/runtime/forerunner",
                ],
            },
            Case {
                name: "linux with every XDG variable",
                platform: Platform::Linux,
                home: "/home/j",
                env: &[
                    ("XDG_CONFIG_HOME", "/x/cfg"),
                    ("XDG_DATA_HOME", "/x/data"),
                    ("XDG_CACHE_HOME", "/x/cache"),
                    ("XDG_STATE_HOME", "/x/state"),
                    ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ],
                expect: [
                    "/x/cfg/forerunner",
                    "/x/data/forerunner",
                    "/x/cache/forerunner",
                    "/x/state/forerunner/logs",
                    "/x/data/forerunner/worktrees",
                    "/run/user/1000/forerunner",
                ],
            },
            Case {
                name: "macos",
                platform: Platform::Macos,
                home: "/Users/j",
                env: &[],
                expect: [
                    "/Users/j/Library/Application Support/forerunner/config",
                    "/Users/j/Library/Application Support/forerunner/data",
                    "/Users/j/Library/Caches/forerunner",
                    "/Users/j/Library/Logs/forerunner",
                    "/Users/j/Library/Application Support/forerunner/worktrees",
                    "/Users/j/Library/Application Support/forerunner/runtime",
                ],
            },
        ];
        for case in cases {
            let d = app_dirs(&MapEnv::new(case.env), &opts(case.platform, case.home));
            let got = [
                posix(&d.config),
                posix(&d.data),
                posix(&d.cache),
                posix(&d.logs),
                posix(&d.worktrees),
                posix(&d.runtime),
            ];
            for (i, (g, e)) in got.iter().zip(case.expect.iter()).enumerate() {
                assert_eq!(g, e, "{}: field {i}", case.name);
            }
        }
    }

    #[test]
    fn home_falls_back_from_home_to_userprofile() {
        let env = MapEnv::new(&[("USERPROFILE", "C:\\Users\\k")]);
        assert_eq!(posix(&home_dir(&env, None)), "C:/Users/k");
        let env = MapEnv::new(&[("HOME", "/home/k"), ("USERPROFILE", "C:\\Users\\k")]);
        assert_eq!(posix(&home_dir(&env, None)), "/home/k");
        assert_eq!(
            posix(&home_dir(&env, Some(Path::new("/explicit")))),
            "/explicit"
        );
    }

    #[test]
    fn app_name_option_is_honoured() {
        let env = MapEnv::new(&[("XDG_CONFIG_HOME", "/x/cfg")]);
        let d = app_dirs(
            &env,
            &AppDirsOptions {
                app_name: Some("fr-test".into()),
                ..opts(Platform::Linux, "/home/j")
            },
        );
        assert_eq!(posix(&d.config), "/x/cfg/fr-test");
    }
}
