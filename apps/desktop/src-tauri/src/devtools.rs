//! The windows' WebView2 DevTools port, for the CI window check and development only
//! (`FORERUNNER_WEBVIEW_DEVTOOLS_PORT`; `docs/maintainers/apps.md`, "The windows' DevTools
//! port"). The window check (`scripts/desktop-window-check.mjs`) drives the installed app's
//! own window over DevTools; WebView2's `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` did not open a
//! port on the first Windows run, so the shell can also name the switch in the arguments it
//! gives WebView2 itself.
//!
//! The variable is read once, from the process environment only (like
//! `FORERUNNER_DAEMON_PROVIDER` in `supervisor.rs`). Only a decimal port from 1024 to 65535 is
//! accepted; anything else is refused with a warning and never reaches WebView2. Accepted on
//! Windows, every window gets `--remote-debugging-port=<port>` with the whole of wry's own
//! default, its `--disable-features` list and its autoplay policy (naming arguments replaces
//! wry's default, so it is repeated here); off Windows nothing changes (WebKitGTK has no such
//! port).

use crate::env::Env;

pub const DEVTOOLS_PORT_ENV: &str = "FORERUNNER_WEBVIEW_DEVTOOLS_PORT";

/// The wry whose default arguments `WRY_DISABLED_FEATURES` and `WRY_AUTOPLAY_POLICY` repeat; a
/// test fails when Cargo.lock names another, until they are read again.
#[cfg(test)]
const WRY_DEFAULTS_READ_FROM: &str = "0.57.0";

/// The features wry turns off when the app names no browser arguments (wry 0.57,
/// `src/webview2/mod.rs`, `create_environment`: the "mini menu", the PDF "mini menu" and
/// SmartScreen).
pub const WRY_DISABLED_FEATURES: [&str; 3] = ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];

/// The rest of wry's default when the app names no browser arguments: `create_environment`
/// adds it because `WebViewAttributes::autoplay` defaults to true (wry 0.57, `src/lib.rs`) and
/// Tauri never turns it off. Without it a page's audio waits for a click, so a spoken alert
/// (`speak.started` on /events, ADR 0063) stays silent in a window the CI check drives while
/// the shipped app's speaks.
pub const WRY_AUTOPLAY_POLICY: &str = "--autoplay-policy=no-user-gesture-required";

/// Also off while the DevTools port is on: a window driven over DevTools must keep painting
/// while another window covers it (the CI check clicks a link that opens the system browser
/// over it, and its clicks wait for animation frames). Never set without the port.
pub const DRIVEN_WINDOW_DISABLED_FEATURES: [&str; 1] = ["CalculateNativeWinOcclusion"];

/// Start of the shell log line that says the port is on; the window check reads it.
pub const DEVTOOLS_ON: &str = "WebView2 DevTools on port";

/// What every window's WebView2 gets: `None` leaves wry's own default arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebviewArgs {
    pub additional: Option<String>,
}

/// The port `DEVTOOLS_PORT_ENV` names: `Ok(None)` when it is unset or empty, `Err(why)` for
/// anything but a decimal port from 1024 to 65535 (no sign, no leading zero, surrounding
/// spaces ignored). The refused value is quoted escaped and cut short in the reason.
pub fn devtools_port(env: &impl Env) -> Result<Option<u16>, String> {
    let Some(raw) = env.var(DEVTOOLS_PORT_ENV) else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let digits =
        value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit()) && !value.starts_with('0');
    match value.parse::<u16>() {
        Ok(port) if digits && port >= 1024 => Ok(Some(port)),
        _ => {
            let mut shown: String = value.chars().take(32).collect();
            if value.chars().count() > 32 {
                shown.push('…');
            }
            Err(format!(
                "{DEVTOOLS_PORT_ENV}={shown:?} ignored: it may only name a port from 1024 to 65535; the windows open without DevTools"
            ))
        }
    }
}

/// The additional browser arguments with the DevTools port on: wry's whole default (its
/// features, with occlusion tracking off too, and its autoplay policy), then the port.
pub fn browser_args(port: u16) -> String {
    let features: Vec<&str> = WRY_DISABLED_FEATURES
        .iter()
        .chain(DRIVEN_WINDOW_DISABLED_FEATURES.iter())
        .copied()
        .collect();
    format!(
        "--disable-features={} {WRY_AUTOPLAY_POLICY} --remote-debugging-port={port}",
        features.join(",")
    )
}

/// What the windows get (`windows` is whether the shell runs on Windows) and the line for the
/// shell log, a warning whenever the variable is set: on, refused, or ignored off Windows.
pub fn resolve(env: &impl Env, windows: bool) -> (WebviewArgs, Option<String>) {
    match devtools_port(env) {
        Ok(None) => (WebviewArgs::default(), None),
        Err(why) => (WebviewArgs::default(), Some(why)),
        Ok(Some(port)) if !windows => (
            WebviewArgs::default(),
            Some(format!(
                "{DEVTOOLS_PORT_ENV}={port} ignored: only WebView2 (Windows) has a DevTools port"
            )),
        ),
        Ok(Some(port)) => {
            let args = browser_args(port);
            let line = format!(
                "{DEVTOOLS_ON} {port} for every window ({DEVTOOLS_PORT_ENV}, development and CI only): {args}"
            );
            (
                WebviewArgs {
                    additional: Some(args),
                },
                Some(line),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::MapEnv;

    fn with(v: &str) -> Result<Option<u16>, String> {
        devtools_port(&MapEnv::new(&[(DEVTOOLS_PORT_ENV, v)]))
    }

    /// Only a decimal port from 1024 to 65535 is accepted; nothing else ever reaches WebView2's
    /// command line, and without the variable nothing changes.
    #[test]
    fn the_devtools_port_switch_accepts_only_a_decimal_port_above_1023() {
        assert_eq!(devtools_port(&MapEnv::default()), Ok(None));
        assert_eq!(with(""), Ok(None));
        assert_eq!(with("   "), Ok(None));
        assert_eq!(with("9333"), Ok(Some(9333)));
        assert_eq!(with(" 9333 "), Ok(Some(9333)));
        assert_eq!(with("1024"), Ok(Some(1024)));
        assert_eq!(with("65535"), Ok(Some(65535)));
        for refused in [
            "0",
            "80",
            "1023",
            "65536",
            "99999",
            "123456",
            "09333",
            "+9333",
            "-1",
            "9333 --remote-allow-origins=*",
            "9333;calc",
            "0x2475",
            "9,333",
            "9333.0",
            "٩٣٣٣",
            "abc",
        ] {
            let why = with(refused).expect_err(refused);
            assert!(why.starts_with(DEVTOOLS_PORT_ENV), "{why}");
            assert!(why.contains("ignored"), "{why}");
            assert!(why.contains("1024 to 65535"), "{why}");
        }
        // A long value is cut short and quoted escaped (no line break reaches the log).
        let why = with(&format!("1\n{}", "x".repeat(100))).unwrap_err();
        assert!(why.contains("\\n"), "{why}");
        assert!(why.contains('…'), "{why}");
        assert!(!why.contains(&"x".repeat(40)), "{why}");
    }

    /// The arguments keep the whole of wry's own default (naming arguments replaces it): its
    /// feature list and its autoplay policy, so a window driven over DevTools plays a spoken
    /// alert without a click as the shipped app does. Then the port; on Windows only, and the
    /// log line names the variable.
    #[test]
    fn every_window_gets_wrys_default_and_the_port_on_windows_only() {
        assert_eq!(
            browser_args(9333),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --remote-debugging-port=9333"
        );
        let env = MapEnv::new(&[(DEVTOOLS_PORT_ENV, "9333")]);
        let (args, line) = resolve(&env, true);
        assert_eq!(
            args.additional.as_deref(),
            Some(browser_args(9333).as_str())
        );
        let line = line.expect("a log line");
        assert!(
            line.starts_with("WebView2 DevTools on port 9333 for every window (FORERUNNER_WEBVIEW_DEVTOOLS_PORT, development and CI only): --disable-features="),
            "{line}"
        );
        // Off Windows: nothing changes, and the log says the variable was ignored.
        let (args, line) = resolve(&env, false);
        assert_eq!(args, WebviewArgs::default());
        assert!(line.expect("a log line").contains("ignored"));
        // Unset: wry's default and no log line, on every OS.
        for windows in [true, false] {
            assert_eq!(
                resolve(&MapEnv::default(), windows),
                (WebviewArgs::default(), None)
            );
        }
        // Refused: wry's default, and the warning says why.
        let (args, line) = resolve(&MapEnv::new(&[(DEVTOOLS_PORT_ENV, "80")]), true);
        assert_eq!(args, WebviewArgs::default());
        assert!(line.expect("a log line").contains("ignored"));
    }

    /// What `browser_args` repeats was read from wry 0.57.0's `create_environment`
    /// (`src/webview2/mod.rs`): `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`,
    /// then ` --autoplay-policy=no-user-gesture-required` because `WebViewAttributes::autoplay`
    /// defaults to true (`src/lib.rs`), then a proxy switch only when a proxy is set (the shell
    /// sets none). Another wry may give another default: this fails when Cargo.lock names
    /// another wry, until its default is read again and `WRY_DEFAULTS_READ_FROM` follows.
    #[test]
    fn the_repeated_wry_default_is_from_the_wry_in_cargo_lock() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lock = std::fs::read_to_string(root.join("Cargo.lock")).expect("Cargo.lock");
        let versions: Vec<&str> = lock
            .split("[[package]]")
            .filter(|p| p.lines().any(|l| l.trim() == "name = \"wry\""))
            .filter_map(|p| {
                p.lines()
                    .find_map(|l| l.trim().strip_prefix("version = \""))
                    .and_then(|v| v.strip_suffix('"'))
            })
            .collect();
        assert_eq!(
            versions,
            [WRY_DEFAULTS_READ_FROM],
            "Cargo.lock's wry is not the one whose default devtools.rs repeats: read its \
             create_environment (src/webview2/mod.rs) and WebViewAttributes' defaults \
             (src/lib.rs), make WRY_DISABLED_FEATURES and WRY_AUTOPLAY_POLICY match, then \
             update WRY_DEFAULTS_READ_FROM"
        );
        // No window is given a proxy, so wry's proxy switch is not part of its default here.
        let windows =
            std::fs::read_to_string(root.join("src").join("windows.rs")).expect("windows");
        assert!(
            !windows.contains(".proxy_url("),
            "a window with a proxy: browser_args must repeat wry's --proxy-server too"
        );
    }

    /// WebView2 refuses a second environment on the same data folder with other options, so
    /// every window is built by `windows::new_window`, which gives each the same arguments:
    /// no other place builds a window.
    #[test]
    fn every_window_is_built_in_one_place() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut builders = Vec::new();
        for entry in std::fs::read_dir(&src).expect("src") {
            let path = entry.expect("entry").path();
            // This file names the builders only in the strings below.
            if path.extension().and_then(|e| e.to_str()) != Some("rs")
                || path.file_name().and_then(|n| n.to_str()) == Some("devtools.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read");
            for (i, line) in text.lines().enumerate() {
                if line.contains("WebviewWindowBuilder::new(")
                    || line.contains("WebviewBuilder::new(")
                {
                    builders.push(format!(
                        "{}:{}",
                        path.file_name().unwrap().to_string_lossy(),
                        i + 1
                    ));
                }
            }
        }
        assert_eq!(builders.len(), 1, "{builders:?}");
        assert!(builders[0].starts_with("windows.rs:"), "{builders:?}");
        let windows = std::fs::read_to_string(src.join("windows.rs")).expect("windows.rs");
        let helper = windows.find("fn new_window<").expect("windows::new_window");
        let builder = windows.find("WebviewWindowBuilder::new(").expect("builder");
        let next_fn = windows[helper + 1..]
            .find("\nfn ")
            .or_else(|| windows[helper + 1..].find("\npub fn "))
            .map(|i| helper + 1 + i)
            .unwrap_or(windows.len());
        assert!(
            helper < builder && builder < next_fn,
            "the builder is inside new_window"
        );
        assert!(windows[helper..next_fn].contains(".additional_browser_args("));
    }
}
