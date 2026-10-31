//! The main window (the shared UI with the injection script), the splash shown while the
//! daemon starts (served by the shell's own `frshell://` protocol), window-state persistence
//! and deep-link navigation. Closing the main window hides it; the tray brings it back, and the
//! first close says so in a notification (U-018, ADR 0094).

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::actions::shared;
use crate::deeplink::{SPLASH_SCHEME, navigate_script, navigation_allowed, route_for_deep_link};
use crate::inject::{Injection, app_origins, initialization_script};
use crate::state::{OpenAction, defer_launch_during_quit, lock, open_action};
use crate::window_state::{
    self, DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, Rect, WindowState,
};

pub const MAIN: &str = "main";
/// Marker under `<config>`: the "still running in the tray" notice was shown once.
pub const TRAY_HINT_FILE: &str = "tray-hint-shown";
pub const SPLASH: &str = "splash";
const SAVE_THROTTLE: Duration = Duration::from_secs(2);
/// `destroy()` is asynchronous: the label is free once the event loop has handled the
/// window's `Destroyed` event. A rebuild waits at most this long for it.
const DESTROY_WAIT: Duration = Duration::from_secs(5);

/// Build the main window, or rebuild it when the daemon address or token changed (a restarted
/// daemon has a new token and the injection script is fixed per window). The old window is
/// destroyed first and the rebuild waits until its label is released, because Tauri refuses
/// a second window with a label that is still registered.
pub async fn ensure_main(app: &AppHandle, injection: &Injection) {
    let state = shared(app);
    let same = {
        let s = lock(&state);
        s.injected
            .as_ref()
            .map(|(url, token)| url == &injection.daemon_url && token == &injection.daemon_token)
            .unwrap_or(false)
    };
    if let Some(existing) = app.get_webview_window(MAIN) {
        if same {
            show_main(app);
            return;
        }
        save_main_state(app);
        if let Err(e) = existing.destroy() {
            log::warn!("could not close the old main window: {e}");
        }
        if !wait_until_closed(app, MAIN, DESTROY_WAIT).await {
            log::error!(
                "the old main window did not close within {} s; keeping it (its daemon token is stale: Quit and reopen)",
                DESTROY_WAIT.as_secs()
            );
            show_main(app);
            return;
        }
    }
    match build_main(app, injection) {
        Ok(()) => {
            let mut s = lock(&state);
            s.injected = Some((injection.daemon_url.clone(), injection.daemon_token.clone()));
        }
        Err(e) => log::error!("could not build the main window: {e}"),
    }
}

/// Poll until no window carries `label` or `budget` passes.
async fn wait_until_closed(app: &AppHandle, label: &str, budget: Duration) -> bool {
    let started = Instant::now();
    while app.get_webview_window(label).is_some() {
        if started.elapsed() > budget {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

fn build_main(app: &AppHandle, injection: &Injection) -> tauri::Result<()> {
    let origins = app_origins(app.config().build.dev_url.as_ref(), tauri::is_dev());
    let script = initialization_script(injection, &origins);
    let nav_app = app.clone();
    let nav_origins = origins.clone();
    let media_origins = origins.clone();
    let page = crate::media::CurrentPage::default();
    let loaded = page.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("Forerunner")
        .inner_size(f64::from(DEFAULT_WIDTH), f64::from(DEFAULT_HEIGHT))
        .min_inner_size(f64::from(MIN_WIDTH), f64::from(MIN_HEIGHT))
        .resizable(true)
        .visible(false)
        .initialization_script(script.as_str())
        // The conversation panel's microphone (ADR 0064): allowed for the shell's own pages,
        // denied elsewhere; WebKitGTK would deny it and WebView2 would prompt on every press.
        .on_page_load(move |_, payload| loaded.set(payload.url()))
        .on_permission_request(move |_, kind| {
            let answer =
                crate::media::permission_decision(kind, page.get().as_ref(), &media_origins);
            log::info!("webview permission {kind}: {answer}");
            answer
        })
        .on_navigation(move |url| {
            if navigation_allowed(url, &nav_origins) {
                return true;
            }
            if url.scheme() == "http" || url.scheme() == "https" {
                if let Err(e) = nav_app.opener().open_url(url.as_str(), None::<&str>) {
                    log::warn!("could not open {} in the browser: {e}", url);
                }
            } else {
                log::warn!("navigation to {} refused", url.scheme());
            }
            false
        })
        .build()?;

    let state = shared(app);
    let path = lock(&state).dirs.config.join(window_state::FILE);
    if let Some(saved) = window_state::load(&path) {
        let monitors: Vec<Rect> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| Rect {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
            })
            .collect();
        let p = window_state::placement(&saved, &monitors);
        let _ = window.set_size(PhysicalSize::new(p.size.0, p.size.1));
        if let Some((x, y)) = p.position {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        if p.maximized {
            let _ = window.maximize();
        }
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Show, un-minimise and focus the main window. Without one (not attached yet, or halted)
/// this attaches to or starts the daemon. During Quit it does neither (U-062).
pub fn show_main(app: &AppHandle) {
    let window = app.get_webview_window(MAIN);
    let action = open_action(&lock(&shared(app)), window.is_some());
    match (action, window) {
        (OpenAction::Show, Some(w)) => {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        (OpenAction::Bootstrap, _) => {
            tauri::async_runtime::spawn(crate::actions::bootstrap(app.clone(), true));
        }
        (OpenAction::Quitting, _) => {
            log::info!("not opening the window: Quit is stopping Forerunner");
        }
        _ => {}
    }
}

/// Forerunner was launched again (the single-instance plugin forwards it, a deep link
/// included). During Quit the launch is remembered and the app starts again once the daemon
/// has stopped (U-062); otherwise the window comes up.
pub fn second_launch(app: &AppHandle) {
    if defer_launch_during_quit(&mut lock(&shared(app))) {
        log::info!("Forerunner was opened again during Quit; it starts again once Quit is done");
        return;
    }
    show_main(app);
}

/// Hide every window (Quit, while the daemon is being stopped).
pub fn hide_all(app: &AppHandle) {
    close_splash(app);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
}

/// True the first time it is called for a config directory, false after: the marker file is
/// written on the first call. A marker that cannot be written means the notice may show again,
/// which is better than never.
pub fn take_first_close_hint(config_dir: &std::path::Path) -> bool {
    let marker = config_dir.join(TRAY_HINT_FILE);
    if marker.exists() {
        return false;
    }
    if let Err(e) =
        std::fs::create_dir_all(config_dir).and_then(|()| std::fs::write(&marker, "1\n"))
    {
        log::warn!("tray notice marker not written: {e}");
    }
    true
}

/// The window was closed: it is hidden and Forerunner keeps running in the tray. The first
/// time, a notification says so and how to stop it (U-018).
pub fn closed_to_tray(app: &AppHandle) {
    let config = lock(&shared(app)).dirs.config.clone();
    if take_first_close_hint(&config) {
        crate::actions::notify(
            app,
            "Forerunner is still running",
            "It keeps working in the tray. To stop it completely, right-click the tray icon and choose Quit Forerunner.",
        );
    }
}

/// Capture the main window's geometry into `<config>/window-state.json`.
pub fn save_main_state(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(maximized)) = (w.outer_position(), w.outer_size(), w.is_maximized())
    else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let state = shared(app);
    let path = {
        let mut s = lock(&state);
        s.window_saved_at = Some(Instant::now());
        s.dirs.config.join(window_state::FILE)
    };
    let ws = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    };
    if let Err(e) = window_state::save(&path, &ws) {
        log::warn!("window state not saved: {e}");
    }
}

/// Save at most every `SAVE_THROTTLE` while the window moves or resizes.
pub fn save_main_state_throttled(app: &AppHandle) {
    let due = {
        let state = shared(app);
        let s = lock(&state);
        s.window_saved_at
            .map(|t| t.elapsed() >= SAVE_THROTTLE)
            .unwrap_or(true)
    };
    if due {
        save_main_state(app);
    }
}

/// The splash page: inline, no external resources, no scripts.
pub fn splash_html() -> String {
    r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Forerunner</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: Canvas; color: CanvasText; }
  main { text-align: center; max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style></head>
<body><main><h1>Forerunner</h1><p id="s">Starting…</p></main></body></html>
"#
    .to_string()
}

pub fn show_splash(app: &AppHandle, message: &str) {
    if app.get_webview_window(SPLASH).is_some() {
        set_splash(app, message);
        return;
    }
    let url = match url::Url::parse(&format!("{SPLASH_SCHEME}://localhost/splash")) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("splash url: {e}");
            return;
        }
    };
    match WebviewWindowBuilder::new(app, SPLASH, WebviewUrl::CustomProtocol(url))
        .title("Forerunner")
        .inner_size(480.0, 240.0)
        .resizable(false)
        .center()
        .build()
    {
        Ok(_) => set_splash(app, message),
        Err(e) => log::warn!("could not show the splash window: {e}"),
    }
}

pub fn set_splash(app: &AppHandle, message: &str) {
    if let Some(w) = app.get_webview_window(SPLASH) {
        let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(format!(
            "(function(){{var e=document.getElementById('s');if(e){{e.textContent={encoded};}}}})();"
        ));
    }
}

pub fn close_splash(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SPLASH) {
        let _ = w.destroy();
    }
}

/// Bring the window up on a UI route the shell knows (the tray's "Updates…").
pub fn show_route(app: &AppHandle, route: &str) {
    show_main(app);
    if let Some(w) = app.get_webview_window(MAIN)
        && let Err(e) = w.eval(navigate_script(route))
    {
        log::warn!("could not navigate the UI: {e}");
    }
}

/// Bring the window up and move the UI to the route a deep link names (ADR 0031).
pub fn handle_deep_link(app: &AppHandle, raw: &str) {
    match route_for_deep_link(raw) {
        Some(route) => {
            log::info!("deep link to {route}");
            show_route(app, &route);
        }
        None => {
            log::warn!("deep link ignored (not a known route)");
            show_main(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splash_is_self_contained() {
        let html = splash_html();
        assert!(html.contains("<!doctype html>"));
        assert!(html.contains(r#"id="s""#));
        assert!(!html.contains("<script"));
        assert!(!html.contains("http"));
    }
}
