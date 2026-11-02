//! What the windows' pages may call in the shell, held against `capabilities/` (tests only).
//!
//! The windows are granted the core IPC and the shell's own commands (`capabilities/`): every
//! plugin is driven from Rust. The one plugin command a page may call is the notification
//! permission read, granted to the main window only (`capabilities/notification.json`), because
//! tauri-plugin-notification's page script makes it at every page load on Linux and macOS. A
//! plugin can still put a script into every page (`Plugin::initialization_script`) that calls
//! the plugin's commands from the page. The ACL refuses each such call ("Command plugin:<name>|<command> not allowed
//! by ACL"), so whatever the script took over from the page does nothing: tauri-plugin-opener's
//! click script made every Ctrl- or Shift-clicked link and every `target="_blank"` link do
//! nothing (the desktop window check, Desktop app run 41442343517). These tests build every
//! plugin the shell registers, read the commands its page script calls, and hold the refused
//! ones to a reviewed list. The UI's own calls (`invoke`, `listen`) are checked against the
//! same capabilities by `apps/ui/test/shell-commands.test.ts`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use tauri::Wry;
use tauri::plugin::Plugin;

use crate::dirs::{AppDirsOptions, app_dirs};
use crate::env::MapEnv;

/// Every command a plugin's page script can call that no window is granted, with what in the
/// page sets the call off. The UI does none of these (`apps/ui/test/shell-commands.test.ts`
/// fails on `alert(`, `confirm(` and the web Notification API). A call the page makes by
/// itself, at load, cannot be here: it would be refused in every page, an uncaught rejection
/// the window check fails on.
const REFUSED_SCRIPT_CALLS: &[(&str, &str)] = &[
    (
        "plugin:dialog|confirm",
        "window.confirm(), which tauri-plugin-dialog's script replaces; the UI never calls it",
    ),
    (
        "plugin:dialog|message",
        "window.alert(), which tauri-plugin-dialog's script replaces; the UI never calls it",
    ),
    (
        "plugin:notification|notify",
        "new Notification(...), the web Notification API the script replaces; the UI never uses it",
    ),
    (
        "plugin:notification|request_permission",
        "Notification.requestPermission(); the UI never uses the web Notification API",
    ),
];

/// What the splash is refused beyond `REFUSED_SCRIPT_CALLS`. The notification permission read
/// is granted to the main window only: the splash has no script of its own and shows
/// "Starting…" until the main window opens, so on Linux and macOS this call is refused in its
/// page, at most one uncaught rejection that no check and no person reads.
const SPLASH_ALSO_REFUSED: &[(&str, &str)] = &[(
    "plugin:notification|is_permission_granted",
    "tauri-plugin-notification's script asks at every page load on Linux and macOS (on Windows \
     it takes the permission as granted without asking); the main window is granted it",
)];

/// The plugin permissions a window is granted, all of them: the main window may read the
/// notification permission, which tauri-plugin-notification's page script asks at every page
/// load on Linux and macOS (refused, every page threw an uncaught rejection); nothing else.
const PLUGIN_PERMISSIONS: &[(&str, &[&str])] = &[
    (
        crate::windows::MAIN,
        &["notification:allow-is-permission-granted"],
    ),
    (crate::windows::SPLASH, &[]),
];

/// The `.plugin(...)` calls of `run()` in `lib.rs`, in order: a plugin added there must be
/// built in `page_scripts` below too, so its page script is audited.
const REGISTERED_PLUGINS: &[&str] = &[
    "tauri_plugin_single_instance::init(",
    "log_plugin(&dirs)",
    "tauri_plugin_notification::init()",
    "tauri_plugin_dialog::init()",
    "tauri_plugin_deep_link::init()",
    "opener_plugin()",
    "hotkey_shell::plugin()",
];

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn script_of(plugin: &dyn Plugin<Wry>) -> (&'static str, Option<String>) {
    (
        plugin.name(),
        plugin.initialization_script_2().map(|s| s.script),
    )
}

/// Each plugin `run()` registers, built the same way, with the script it puts into every page.
fn page_scripts() -> Vec<(&'static str, Option<String>)> {
    let env = MapEnv::new(&[("FORERUNNER_HOME", "/nonexistent/fr-acl-test")]);
    let dirs = app_dirs(&env, &AppDirsOptions::default());
    vec![
        script_of(&tauri_plugin_single_instance::init(
            |_: &tauri::AppHandle<Wry>, _: Vec<String>, _: String| {},
        )),
        script_of(&crate::log_plugin(&dirs)),
        script_of(&tauri_plugin_notification::init::<Wry>()),
        script_of(&tauri_plugin_dialog::init::<Wry>()),
        script_of(&tauri_plugin_deep_link::init::<Wry>()),
        script_of(&crate::opener_plugin::<Wry>()),
        script_of(&crate::hotkey_shell::plugin()),
    ]
}

/// The `plugin:<name>|<command>` strings in a script (the first argument of every IPC call).
fn plugin_calls(script: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = script;
    while let Some(i) = rest.find("plugin:") {
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, ':' | '|' | '_' | '-')))
            .unwrap_or(tail.len());
        let call = &tail[..end];
        if call.contains('|') {
            out.insert(call.to_string());
        }
        rest = &tail["plugin:".len()..];
    }
    out
}

/// The permissions `capabilities/*.json` grant to `window` (by name, or by an object's
/// `identifier`).
fn granted_to(window: &str) -> BTreeSet<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut out = BTreeSet::new();
    for entry in std::fs::read_dir(&dir).expect("capabilities/") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read capability");
        let cap: serde_json::Value = serde_json::from_str(&text).expect("capability JSON");
        let windows: Vec<&str> = cap["windows"]
            .as_array()
            .map(|a| a.iter().filter_map(|w| w.as_str()).collect())
            .unwrap_or_default();
        if !windows.iter().any(|w| *w == window || *w == "*") {
            continue;
        }
        for p in cap["permissions"].as_array().into_iter().flatten() {
            let id = p
                .as_str()
                .or_else(|| p["identifier"].as_str())
                .expect("a permission is a name or has an identifier");
            out.insert(id.to_string());
        }
    }
    out
}

/// Whether `permissions` let the page call `plugin:<name>|<command>`: the command's own
/// `allow-` permission or the plugin's default set (which may or may not hold it; the test
/// below refuses every plugin permission anyway).
fn grants(permissions: &BTreeSet<String>, call: &str) -> bool {
    let Some((plugin, command)) = call.strip_prefix("plugin:").and_then(|c| c.split_once('|'))
    else {
        return false;
    };
    permissions.contains(&format!("{plugin}:allow-{}", command.replace('_', "-")))
        || permissions.contains(&format!("{plugin}:default"))
}

/// Ctrl- and Shift-clicked links and `target="_blank"` links did nothing in the window: the
/// opener plugin's default build (`tauri_plugin_opener::init()`) puts a click script into
/// every page that cancels those clicks and calls `plugin:opener|open_url` from the page,
/// which the ACL refuses. The shell's `on_navigation` / `on_new_window` (`windows.rs`) are the
/// one way out of the window; the plugin must put nothing into the page.
#[test]
fn the_opener_plugin_puts_no_script_into_the_page() {
    let plugin = crate::opener_plugin::<Wry>();
    assert_eq!(plugin.name(), "opener");
    let script = plugin.initialization_script_2().map(|s| s.script);
    assert!(
        script.is_none(),
        "the opener plugin injects a page script again (it calls {:?}); build it with \
         open_js_links_on_click(false)",
        script.as_deref().map(plugin_calls).unwrap_or_default()
    );
    // run() registers this plugin, and nothing builds the opener another way.
    let lib = std::fs::read_to_string(src_dir().join("lib.rs")).expect("lib.rs");
    assert!(
        lib.contains(".plugin(opener_plugin())"),
        "run() registers opener_plugin()"
    );
    for entry in std::fs::read_dir(src_dir()).expect("src") {
        let path = entry.expect("entry").path();
        if path.file_name().and_then(|n| n.to_str()) == Some("webview_acl.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read");
        for other in [
            "tauri_plugin_opener::init(",
            "tauri_plugin_opener::init::<",
            "tauri_plugin_opener::Builder::default(",
        ] {
            assert!(
                !text.contains(other),
                "{} builds the opener plugin with its page script: {other}",
                path.display()
            );
        }
    }
}

/// Every plugin page script's call that the ACL refuses is one the page never makes (or, for
/// the splash's notification permission read, one nobody sees). A call a script makes by
/// itself at page load must be granted to the main window. A plugin added to `run()`, a plugin
/// update whose script calls something new, or a capability change shows up here.
#[test]
fn every_plugin_script_calls_only_what_its_window_may_or_what_the_page_never_does() {
    let lib = std::fs::read_to_string(src_dir().join("lib.rs")).expect("lib.rs");
    let registered: Vec<String> = lib
        .lines()
        .filter_map(|l| l.trim().strip_prefix(".plugin("))
        .map(str::to_string)
        .collect();
    assert_eq!(
        registered.len(),
        REGISTERED_PLUGINS.len(),
        "run() registers {registered:?}: build each in page_scripts() and list it in REGISTERED_PLUGINS"
    );
    for (line, expected) in registered.iter().zip(REGISTERED_PLUGINS) {
        assert!(line.starts_with(expected), "{line} is not {expected}");
    }
    // No plugin is added at run time elsewhere.
    for entry in std::fs::read_dir(src_dir()).expect("src") {
        let path = entry.expect("entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "lib.rs" || name == "webview_acl.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(!text.contains(".plugin("), "{name} registers a plugin");
    }

    let scripts = page_scripts();
    assert_eq!(scripts.len(), REGISTERED_PLUGINS.len());
    let labelled = |calls: &[(&str, &str)]| -> BTreeSet<String> {
        calls
            .iter()
            .map(|(call, _)| {
                let plugin = call
                    .strip_prefix("plugin:")
                    .and_then(|c| c.split_once('|'))
                    .map(|(p, _)| p)
                    .unwrap_or("");
                format!("{call} (from {plugin})")
            })
            .collect()
    };
    let reviewed = labelled(REFUSED_SCRIPT_CALLS);
    let splash_reviewed: BTreeSet<String> = reviewed
        .union(&labelled(SPLASH_ALSO_REFUSED))
        .cloned()
        .collect();
    // Every page gets every plugin's script, the splash's too; each window is held to its
    // own list.
    for (window, reviewed, list) in [
        (crate::windows::MAIN, &reviewed, "REFUSED_SCRIPT_CALLS"),
        (
            crate::windows::SPLASH,
            &splash_reviewed,
            "REFUSED_SCRIPT_CALLS or SPLASH_ALSO_REFUSED",
        ),
    ] {
        let granted = granted_to(window);
        let mut refused = BTreeSet::new();
        for (plugin, script) in &scripts {
            for call in plugin_calls(script.as_deref().unwrap_or("")) {
                if !grants(&granted, &call) {
                    refused.insert(format!("{call} (from {plugin})"));
                }
            }
        }
        let unreviewed: Vec<&String> = refused.difference(reviewed).collect();
        assert!(
            unreviewed.is_empty(),
            "a plugin's page script calls {unreviewed:?}, which the ACL refuses in the {window} \
             window: whatever the script took over from the page does nothing, and a call it \
             makes at page load throws in every page. Build the plugin without its script, grant \
             a call the script makes by itself, or, when the page can never set the call off, \
             add it to {list} with what would"
        );
        let gone: Vec<&String> = reviewed.difference(&refused).collect();
        assert!(
            gone.is_empty(),
            "{list} lists {gone:?}, which no plugin script calls any more (or the {window} \
             window is now granted): take it out"
        );
    }
}

/// The policy of `capabilities/`: the core IPC and the shell's own commands (declared in
/// `build.rs`), and of the plugins' commands only `PLUGIN_PERMISSIONS`: the main window's
/// notification permission read, nothing for the splash.
#[test]
fn the_only_plugin_command_a_window_is_granted_is_the_notification_permission_read() {
    let build = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
        .expect("build.rs");
    let manifest = build
        .split_once(".commands(&[")
        .and_then(|(_, rest)| rest.split_once("])"))
        .map(|(list, _)| list)
        .expect("build.rs declares the app's commands");
    let own: BTreeSet<String> = manifest
        .split(',')
        .map(|c| c.trim().trim_matches('"'))
        .filter(|c| !c.is_empty())
        .map(|c| format!("allow-{}", c.replace('_', "-")))
        .collect();
    assert!(own.contains("allow-open-folder"), "{own:?}");
    for window in [crate::windows::MAIN, crate::windows::SPLASH] {
        let plugin: BTreeSet<String> = granted_to(window)
            .into_iter()
            .filter(|p| !p.starts_with("core:") && !own.contains(p))
            .collect();
        let allowed: BTreeSet<String> = PLUGIN_PERMISSIONS
            .iter()
            .filter(|(w, _)| *w == window)
            .flat_map(|(_, ps)| ps.iter().map(|p| p.to_string()))
            .collect();
        assert_eq!(
            plugin, allowed,
            "the {window} window's plugin permissions: every plugin is driven from Rust, and a \
             page may only read the notification permission (capabilities/notification.json)"
        );
    }
    // No plugin's default set, and nothing that sends, asks or opens.
    let main = granted_to(crate::windows::MAIN);
    for refused in [
        "plugin:notification|notify",
        "plugin:notification|request_permission",
        "plugin:opener|open_url",
        "plugin:dialog|message",
        "plugin:dialog|confirm",
    ] {
        assert!(
            !grants(&main, refused),
            "the main window is granted {refused}"
        );
    }
    assert!(grants(&main, "plugin:notification|is_permission_granted"));
}

#[test]
fn plugin_calls_are_read_from_minified_scripts() {
    let opener = r#"t.target&&(e.preventDefault(),async function(e,t={},n){window.__TAURI_INTERNALS__.invoke(e,t,n)}("plugin:opener|open_url",{url:n}))"#;
    assert_eq!(
        plugin_calls(opener).into_iter().collect::<Vec<_>>(),
        ["plugin:opener|open_url"]
    );
    let two = r#"n("plugin:dialog|message",{});n("plugin:dialog|confirm",{});"plugin:" + x"#;
    assert_eq!(
        plugin_calls(two).into_iter().collect::<Vec<_>>(),
        ["plugin:dialog|confirm", "plugin:dialog|message"]
    );
    let granted: BTreeSet<String> = ["core:default", "dialog:allow-message", "opener:default"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(grants(&granted, "plugin:dialog|message"));
    assert!(!grants(&granted, "plugin:dialog|confirm"));
    assert!(grants(&granted, "plugin:opener|open_url"));
    assert!(!grants(
        &granted,
        "plugin:notification|is_permission_granted"
    ));
}
