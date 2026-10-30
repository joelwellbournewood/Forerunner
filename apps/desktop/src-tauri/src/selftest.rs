//! `forerunner-desktop --self-test [--report <file>]` (ADR 0092, amendment of 2026-10-30): start
//! the runtime this installation carries exactly the way a normal launch does, without a window
//! and without touching a daemon that is already running, and say whether it came up. Tauri's
//! own `resource_dir()` finds the runtime (the call that returned the verbatim `\\?\D:\...`
//! path 1.0.1 died on), `install::locate_fr` builds the command, `supervisor::spawn_daemon` starts
//! it and `wait_for_daemon` waits for `/health`; then `/me`, `/setup` and `/voice/install` must
//! answer (the last reports where dependencies go, U-011) and the daemon is stopped again. The
//! result is one JSON object, printed and, with `--report`, written to a file (a release build
//! on Windows has no console). Exit code 0 when it passed, 1 when not.
//! CI installs the real MSI, `.deb` and AppImage into awkward places and runs this
//! (`scripts/installed-check.*`), so an installer that cannot start is never published.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{Value, json};

use crate::daemon::{DaemonClient, daemon_file_path, read_daemon_file};
use crate::dirs::{AppDirsOptions, Platform, app_dirs};
use crate::env::ProcessEnv;
use crate::install::{self, FrSource, RealFs, locate_fr};
use crate::supervisor::{daemon_log_path, spawn_daemon, stop_process, wait_for_daemon};

pub const FLAG: &str = "--self-test";
pub const REPORT_FLAG: &str = "--report";
/// Lines of `daemon-shell.log` a failed report carries.
const LOG_TAIL_LINES: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfTestArgs {
    pub report: Option<PathBuf>,
}

/// `Some` when the command line asks for the self-test.
pub fn parse_args(args: &[String]) -> Option<SelfTestArgs> {
    if !args.iter().any(|a| a == FLAG) {
        return None;
    }
    let report = args
        .iter()
        .position(|a| a == REPORT_FLAG)
        .and_then(|i| args.get(i + 1))
        .filter(|p| !p.starts_with("--"))
        .map(PathBuf::from);
    Some(SelfTestArgs { report })
}

fn log_tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines[start..].join("\n")
}

/// Run the check; returns the process exit code.
pub fn run(package_info: &tauri::PackageInfo, args: &SelfTestArgs) -> i32 {
    let started = Instant::now();
    let mut report = tauri::async_runtime::block_on(check(package_info));
    let ok = report.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if let Some(obj) = report.as_object_mut() {
        obj.insert("seconds".into(), json!(started.elapsed().as_secs_f64()));
    }
    let text = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into());
    println!("{text}");
    if let Some(path) = &args.report
        && let Err(e) = std::fs::write(path, format!("{text}\n"))
    {
        eprintln!("could not write {}: {e}", path.display());
        return 1;
    }
    if ok { 0 } else { 1 }
}

async fn check(package_info: &tauri::PackageInfo) -> Value {
    let dirs = app_dirs(&ProcessEnv, &AppDirsOptions::default());
    for d in [&dirs.config, &dirs.data, &dirs.logs, &dirs.runtime] {
        let _ = std::fs::create_dir_all(d);
    }
    let log_path = daemon_log_path(&dirs.logs);
    let fail = |stage: &str, error: String, extra: Value| {
        let mut v = json!({
            "ok": false,
            "stage": stage,
            "error": error,
            "platform": Platform::current().label(),
            "home": { "config": dirs.config, "data": dirs.data, "logs": dirs.logs },
            "daemonLogTail": log_tail(&log_path),
        });
        if let (Some(obj), Some(more)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in more {
                obj.insert(k.clone(), val.clone());
            }
        }
        v
    };

    // The same call the shell makes through `app.path().resource_dir()`.
    let resource_dir =
        match tauri::utils::platform::resource_dir(package_info, &tauri::utils::Env::default()) {
            Ok(d) => d,
            Err(e) => return fail("resource_dir", e.to_string(), json!({})),
        };
    let Some(bundled) = install::bundled_runtime(&resource_dir) else {
        return fail(
            "bundled_runtime",
            "no runtime.json under the resource directory".into(),
            json!({ "resourceDir": resource_dir }),
        );
    };
    let cmd = match locate_fr(
        &ProcessEnv,
        &RealFs,
        &dirs.config,
        &dirs.data,
        Platform::current(),
        Some(&bundled),
    ) {
        Ok(c) => c,
        Err(e) => {
            return fail(
                "locate",
                e.to_string(),
                json!({ "resourceDir": resource_dir }),
            );
        }
    };
    let base = json!({
        "resourceDir": resource_dir,
        "runtimeDir": bundled.dir,
        "bundledVersion": bundled.version,
        "command": cmd.describe(),
    });
    if cmd.source != FrSource::Bundled {
        return fail(
            "locate",
            format!(
                "a normal start would run {:?}, not the bundled runtime",
                cmd.source
            ),
            base,
        );
    }

    let before = read_daemon_file(&daemon_file_path(&dirs.runtime)).ok();
    let mut spawned = match spawn_daemon(&cmd, &dirs.logs) {
        Ok(s) => s,
        Err(e) => return fail("spawn", e, base),
    };
    let waited = wait_for_daemon(
        &dirs.runtime,
        &mut spawned.child,
        spawned.pid,
        before.as_ref(),
    )
    .await;
    let (file, health, client) = match waited {
        Ok(t) => t,
        Err(e) => {
            let _ = spawned.child.kill();
            return fail("start", e, base);
        }
    };

    let outcome = answers(&client, &bundled.version, &health.version).await;
    // Leave nothing running: the daemon (and the tsx process that started it).
    if let Some(pid) = file.pid {
        let _ = stop_process(pid, &client).await;
    }
    let _ = spawned.child.kill();
    match outcome {
        Ok(details) => {
            let mut v = base;
            if let Some(obj) = v.as_object_mut() {
                obj.insert("ok".into(), json!(true));
                obj.insert("daemonVersion".into(), json!(health.version));
                obj.insert("checks".into(), details);
            }
            v
        }
        Err(e) => fail("answers", e, base),
    }
}

async fn answers(client: &DaemonClient, bundled: &str, running: &str) -> Result<Value, String> {
    if running != bundled {
        return Err(format!(
            "/health reports {running}, the bundled runtime is {bundled}"
        ));
    }
    let (status, me) = client.get_json("/me").await?;
    if status != 200 || !me.get("desktopDeviceId").is_some_and(Value::is_string) {
        return Err(format!("/me answered {status} without desktopDeviceId"));
    }
    let (status, setup) = client.get_json("/setup").await?;
    if status != 200 || !setup.get("showAssistant").is_some_and(Value::is_boolean) {
        return Err(format!("/setup answered {status} without showAssistant"));
    }
    // Where downloaded dependencies go (U-011): the install folder's `dependencies` subfolder
    // when it can be written, else the data folder with the reason. Reported for
    // `scripts/installed-check.*`, which knows which of the two each place should give.
    let (status, voice) = client.get_json("/voice/install").await?;
    let Some(folder) = voice.get("folder").and_then(Value::as_str) else {
        return Err(format!("/voice/install answered {status} without folder"));
    };
    Ok(json!({
        "health": true,
        "me": true,
        "setup": true,
        "voiceFolder": folder,
        "voiceFolderNote": voice.get("folderNote").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_flag_and_the_report_path_are_read_from_the_command_line() {
        assert_eq!(parse_args(&argv(&["forerunner-desktop"])), None);
        assert_eq!(
            parse_args(&argv(&["forerunner-desktop", "fr://open"])),
            None
        );
        assert_eq!(
            parse_args(&argv(&["forerunner-desktop", "--self-test"])),
            Some(SelfTestArgs { report: None })
        );
        assert_eq!(
            parse_args(&argv(&[
                "x",
                "--self-test",
                "--report",
                r"D:\My Apps\report.json"
            ])),
            Some(SelfTestArgs {
                report: Some(PathBuf::from(r"D:\My Apps\report.json"))
            })
        );
        // A missing report path is no report, never the next flag.
        assert_eq!(
            parse_args(&argv(&["x", "--report", "--self-test"])),
            Some(SelfTestArgs { report: None })
        );
    }

    #[test]
    fn a_failed_report_carries_the_end_of_the_daemon_log() {
        let dir = std::env::temp_dir().join(format!("fr-selftest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let log = dir.join("daemon-shell.log");
        let lines: Vec<String> = (0..100).map(|i| format!("line {i}")).collect();
        std::fs::write(&log, lines.join("\n")).expect("write");
        let tail = log_tail(&log);
        assert!(tail.starts_with("line 40"));
        assert!(tail.ends_with("line 99"));
        assert_eq!(log_tail(&dir.join("missing.log")), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
