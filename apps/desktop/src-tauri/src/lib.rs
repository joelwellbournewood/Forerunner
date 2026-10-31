//! Forerunner desktop shell (Tauri 2, Windows and Linux). It attaches the shared UI to the
//! local daemon per ADR 0026: resolve the app directories exactly as `appDirs()` does, read
//! `daemon.json`, check `/health`, start `fr daemon` when needed, inject the daemon address
//! and token into the webview before the UI loads, and keep a tray with the kill switch,
//! "pause email", "Update and restart" and Quit, and register the global hotkey that brings up
//! the conversation (ADR 0064). Shell decisions are in ADR 0031.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod daemon;
mod deeplink;
mod dirs;
mod env;
mod events;
mod hotkey;
mod hotkey_shell;
mod inject;
mod install;
mod media;
mod restart;
mod secret;
mod selftest;
mod sse;
mod state;
mod supervisor;
mod tray;
mod version;
mod window_state;
mod windows;

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_log::{Target, TargetKind};

use crate::dirs::{AppDirs, AppDirsOptions, app_dirs};
use crate::env::ProcessEnv;
use crate::state::{SharedState, ShellState};

pub const INSTALL_ID_FILE: &str = "install-id";

/// The install id: a UUID under `<config>/install-id`, generated on first run. It namespaces
/// the UI's per-install browser storage (ADR 0025) and never identifies a person.
pub fn read_or_create_install_id(config_dir: &Path) -> String {
    let path = config_dir.join(INSTALL_ID_FILE);
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(id) = uuid::Uuid::parse_str(text.trim())
    {
        return id.to_string();
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = std::fs::create_dir_all(config_dir) {
        log::warn!("could not create {}: {e}", config_dir.display());
    }
    let written = write_private(&path, &format!("{id}\n"));
    if let Err(e) = written {
        log::warn!("install id not persisted: {e}");
    }
    id
}

fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(text.as_bytes())
}

fn log_plugin(dirs: &AppDirs) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let mut targets = vec![Target::new(TargetKind::Folder {
        path: dirs.logs.clone(),
        file_name: Some("desktop-shell".into()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .targets(targets)
        .max_file_size(2_000_000)
        .build()
}

fn splash_response(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    _req: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let html = windows::splash_html().into_bytes();
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        )
        .body(html)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // `--self-test` (ADR 0092): start the bundled runtime the way a launch does, report, exit.
    let args: Vec<String> = std::env::args().collect();
    if let Some(test) = selftest::parse_args(&args) {
        std::process::exit(selftest::run(context.package_info(), &test));
    }
    let dirs = app_dirs(&ProcessEnv, &AppDirsOptions::default());
    for d in [&dirs.config, &dirs.logs, &dirs.runtime] {
        let _ = std::fs::create_dir_all(d);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (or a deep link while running) brings the window up; the
            // deep-link plugin receives the URL through the plugin's "deep-link" feature.
            windows::show_main(app);
        }))
        .plugin(log_plugin(&dirs))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(hotkey_shell::plugin())
        .invoke_handler(tauri::generate_handler![
            hotkey_shell::hotkey_status,
            hotkey_shell::hotkey_set
        ])
        .register_uri_scheme_protocol(deeplink::SPLASH_SCHEME, splash_response)
        .setup(move |app| {
            let install_id = read_or_create_install_id(&dirs.config);
            let shell_version = app.package_info().version.to_string();
            log::info!(
                "Forerunner desktop shell {shell_version} on {}; config {}, runtime {}, logs {}",
                dirs::Platform::current().label(),
                dirs.config.display(),
                dirs.runtime.display(),
                dirs.logs.display()
            );
            let state: SharedState = Arc::new(Mutex::new(ShellState::new(
                dirs.clone(),
                install_id,
                shell_version,
            )));
            app.manage(state);

            let handle = app.handle().clone();
            tray::install(&handle)?;
            // The global hotkey (ADR 0064): never fails the start; Settings shows a refusal.
            hotkey_shell::install(&handle, &dirs.config);

            #[cfg(any(windows, target_os = "linux"))]
            if let Err(e) = app.deep_link().register_all() {
                log::warn!("fr:// scheme not registered for this user: {e}");
            }
            let link_app = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    windows::handle_deep_link(&link_app, url.as_str());
                }
            });
            let initial_links = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .unwrap_or_default();

            let boot_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                actions::bootstrap(boot_app.clone(), true).await;
                for url in initial_links {
                    windows::handle_deep_link(&boot_app, url.as_str());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != windows::MAIN {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // Close hides to the tray; the daemon and the shell keep running, and the
                    // first close says so. Quit in the tray stops both (U-018, ADR 0094).
                    api.prevent_close();
                    windows::save_main_state(window.app_handle());
                    let _ = window.hide();
                    windows::closed_to_tray(window.app_handle());
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    windows::save_main_state_throttled(window.app_handle());
                }
                _ => {}
            }
        })
        .build(context);

    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("error while building the Forerunner shell: {e}");
            std::process::exit(1);
        }
    };

    app.run(|_app, event| {
        // With every window hidden or closed the shell lives on in the tray; only Quit
        // (app.exit, which carries a code) ends it.
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_id_is_a_uuid_persisted_once() {
        let dir = std::env::temp_dir().join(format!("fr-install-id-test-{}", uuid::Uuid::new_v4()));
        let first = read_or_create_install_id(&dir);
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        let second = read_or_create_install_id(&dir);
        assert_eq!(first, second);
        std::fs::write(dir.join(INSTALL_ID_FILE), "not a uuid\n").expect("write");
        let third = read_or_create_install_id(&dir);
        assert_ne!(third, "not a uuid");
        assert!(uuid::Uuid::parse_str(&third).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(INSTALL_ID_FILE))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
