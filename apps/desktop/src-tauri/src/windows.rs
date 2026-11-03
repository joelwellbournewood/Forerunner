//! The main window (the shared UI with the injection script), the splash shown while the
//! daemon starts (served by the shell's own `frshell://` protocol), window-state persistence
//! and deep-link navigation. Closing the main window hides it; the tray brings it back, and the
//! first close says so in a notification (U-018, ADR 0094). Every window is built by
//! `new_window`, with the same WebView2 arguments (`devtools.rs`).

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::actions::shared;
use crate::deeplink::{
    SPLASH_SCHEME, navigate_script, navigation_allowed, on_app_origin, route_for_deep_link,
};
use crate::devtools::WebviewArgs;
use crate::inject::{Injection, app_origins, initialization_script};
use crate::state::{OpenAction, defer_launch_during_quit, lock, open_action};
use crate::window_state::{self, DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, Rect};

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

/// Every window of the app starts here, so each gets the same WebView2 arguments: WebView2
/// refuses a second environment on one data folder with other options. They are wry's own
/// default unless `FORERUNNER_WEBVIEW_DEVTOOLS_PORT` turned the DevTools port on
/// (`devtools::resolve`, read once at start into the managed `WebviewArgs`).
fn new_window<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let builder = WebviewWindowBuilder::new(app, label, url);
    let args = app
        .try_state::<WebviewArgs>()
        .and_then(|s| s.additional.clone());
    match args {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    }
}

fn build_main(app: &AppHandle, injection: &Injection) -> tauri::Result<()> {
    let origins = app_origins(app.config().build.dev_url.as_ref(), tauri::is_dev());
    let script = initialization_script(injection, &origins);
    let nav_app = app.clone();
    let nav_origins = origins.clone();
    let new_window_app = app.clone();
    let new_window_origins = origins.clone();
    let media_origins = origins.clone();
    let page = crate::media::CurrentPage::default();
    let loaded = page.clone();
    let window = new_window(app, MAIN, WebviewUrl::default())
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
            leave(&nav_app, url, leave_action(url), Via::Link);
            false
        })
        // A new-window request: a `target="_blank"` link or `window.open`, and in WebView2 a
        // link clicked with Ctrl or Shift. A web page opens in the system browser; one of the
        // app's own pages is shown in this one window, as a plain click on its link does (Q7,
        // the owner's decision of 2026-11-02: a Ctrl+click on Inbox was refused and did
        // nothing). Those clicks on web pages used to do nothing too (the Tasks tab's PR link,
        // `target="_blank"` then, was one) because tauri-plugin-opener's page script
        // cancelled them before the webview asked for a window and called
        // `plugin:opener|open_url`, which the ACL refuses (Desktop app run 41442343517). The
        // shell builds that plugin without its script (`lib.rs`, `opener_plugin`). No second
        // window is ever created.
        .on_new_window(move |url, _features| {
            leave(
                &new_window_app,
                &url,
                new_window_action(&url, &new_window_origins),
                Via::NewWindow,
            );
            tauri::webview::NewWindowResponse::Deny
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

/// What the main window does with a link that leaves the page it shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaveAction {
    /// An http(s) page: the system browser opens it.
    OpenInBrowser,
    /// One of the app's own pages asked for in a new window (a Ctrl- or Shift-click on an
    /// in-app link, `target="_blank"`, `window.open`): this window moves to that route, as a
    /// plain click on the link does (the owner's decision of 2026-11-02, Q7). The route is the
    /// page's path, query and fragment (`app_route`).
    ShowHere(String),
    /// Anything else (`file:`, `javascript:`, `data:`, `about:blank` or the splash in a new
    /// window): nothing opens, and the log says why.
    Refuse,
}

/// A navigation the app origins do not cover: a web page goes to the system browser.
pub fn leave_action(url: &url::Url) -> LeaveAction {
    if url.scheme() == "http" || url.scheme() == "https" {
        LeaveAction::OpenInBrowser
    } else {
        LeaveAction::Refuse
    }
}

/// A new-window request (`target="_blank"`, `window.open`, and in WebView2 a link clicked with
/// Ctrl or Shift): a web page goes to the system browser as a navigation does. One of the
/// app's own pages is shown in this window, as a plain click on the link does (the owner's
/// decision of 2026-11-02, Q7); it is never opened a second time, because a second window would
/// have no daemon token and the system browser cannot show the app's page. `about:blank` and
/// the splash are refused.
pub fn new_window_action(url: &url::Url, app_origins: &[String]) -> LeaveAction {
    if on_app_origin(url, app_origins) {
        return app_route(url).map_or(LeaveAction::Refuse, LeaveAction::ShowHere);
    }
    if navigation_allowed(url, app_origins) {
        return LeaveAction::Refuse;
    }
    leave_action(url)
}

/// How a link asked to leave the window: it navigated in place (an `ExternalLink`, the
/// Tasks tab's PR link) or asked for a new window (`target="_blank"`, `window.open`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Link,
    NewWindow,
}

impl Via {
    fn words(self) -> &'static str {
        match self {
            Via::Link => "link",
            Via::NewWindow => "new window",
        }
    }
}

/// The UI route of one of the app's own pages: its path, query and fragment, for
/// `navigate_script`. A path that starts with `//` or `/\` would read as another host, so it
/// has none (`history.pushState` would refuse it anyway: it only moves within the page's
/// origin).
pub fn app_route(url: &url::Url) -> Option<String> {
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    if !path.starts_with('/') || path[1..].starts_with(['/', '\\']) {
        return None;
    }
    let mut route = path.to_string();
    if let Some(query) = url.query() {
        route.push('?');
        route.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        route.push('#');
        route.push_str(fragment);
    }
    Some(route)
}

/// Start of the shell log line written each time the window hands a web page to the system
/// browser; the CI window check (`scripts/desktop-window-check.mjs`) asserts on it.
pub const HANDED_TO_BROWSER: &str = "handed to the system browser";

/// Start of the shell log line written each time the window moves to one of its own pages that
/// was asked for in a new window (`LeaveAction::ShowHere`); the CI window check asserts on it.
pub const SHOWN_IN_WINDOW: &str = "shown in this window";

/// A link as the shell log names it: scheme, host, port and path. The query and the fragment
/// (where a token could ride) and any user name or password are left out.
pub fn loggable_url(url: &url::Url) -> String {
    let mut out = format!("{}{}", url.origin().ascii_serialization(), url.path());
    if url.query().is_some() || url.fragment().is_some() {
        out.push_str(" (query not logged)");
    }
    out
}

/// The shell log line for a page handed to the system browser.
pub fn handed_to_browser_line(url: &url::Url, via: Via) -> String {
    format!(
        "{HANDED_TO_BROWSER} ({}): {}",
        via.words(),
        loggable_url(url)
    )
}

/// The shell log line for one of the app's own pages shown in this window.
pub fn shown_in_window_line(url: &url::Url, via: Via) -> String {
    format!("{SHOWN_IN_WINDOW} ({}): {}", via.words(), loggable_url(url))
}

/// Move the main window's UI to `route` in place (`navigate_script`: `history.pushState` and a
/// `popstate`, which React Router follows, as for a deep link), so the page keeps its daemon
/// token and what the person had typed. It runs off the webview's own new-window handler:
/// the script reaches the window through the event loop once the request has been answered.
fn show_here(app: &AppHandle, url: &url::Url, route: String, via: Via) {
    let app = app.clone();
    let line = shown_in_window_line(url, via);
    let shown = loggable_url(url);
    tauri::async_runtime::spawn(async move {
        let Some(window) = app.get_webview_window(MAIN) else {
            log::warn!("could not show {shown} in the window: there is no window");
            return;
        };
        match window.eval(navigate_script(&route)) {
            Ok(()) => log::info!("{line}"),
            Err(e) => log::warn!("could not show {shown} in the window: {e}"),
        }
    });
}

fn leave(app: &AppHandle, url: &url::Url, action: LeaveAction, via: Via) {
    match action {
        LeaveAction::OpenInBrowser => match app.opener().open_url(url.as_str(), None::<&str>) {
            Ok(()) => log::info!("{}", handed_to_browser_line(url, via)),
            Err(e) => log::warn!("could not open {} in the browser: {e}", loggable_url(url)),
        },
        LeaveAction::ShowHere(route) => show_here(app, url, route, via),
        LeaveAction::Refuse => log::warn!(
            "opening {} from the window refused ({})",
            url.scheme(),
            via.words()
        ),
    }
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

/// The first-close notice, shown while it is due (no marker under `config_dir` yet) through
/// `show`; the marker is written only once `show` succeeded, so a notice the operating system
/// refused is tried again at the next close (U-077; it was written before showing, and a
/// refused notice was never shown again). A marker that cannot be written means the notice may
/// show again, which is better than never. Returns whether it was shown.
pub fn first_close_hint(
    config_dir: &std::path::Path,
    show: impl FnOnce() -> Result<(), String>,
) -> bool {
    let marker = config_dir.join(TRAY_HINT_FILE);
    if marker.exists() {
        return false;
    }
    if let Err(e) = show() {
        log::warn!(
            "the first-close notice was not shown ({e}); it is tried again at the next close"
        );
        return false;
    }
    if let Err(e) =
        std::fs::create_dir_all(config_dir).and_then(|()| std::fs::write(&marker, "1\n"))
    {
        log::warn!("tray notice marker not written: {e}");
    }
    true
}

pub const FIRST_CLOSE_TITLE: &str = "Forerunner is still running";
pub const FIRST_CLOSE_BODY: &str = "It keeps working in the tray. To stop it completely, right-click the tray icon and choose Quit Forerunner.";

/// The window was closed: it is hidden and Forerunner keeps running in the tray. The first
/// time, a notification says so and how to stop it (U-018). It waits for the operating
/// system's answer (`actions::show_notification_now`) off the event loop.
pub fn closed_to_tray(app: &AppHandle) {
    let config = lock(&shared(app)).dirs.config.clone();
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        first_close_hint(&config, || {
            crate::actions::show_notification_now(&identifier, FIRST_CLOSE_TITLE, FIRST_CLOSE_BODY)
        });
    });
}

/// Capture the main window's geometry into `<config>/window-state.json`; a minimised window
/// keeps what was saved last (`window_state::capture`, U-077).
pub fn save_main_state(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(maximized), Ok(minimized)) = (
        w.outer_position(),
        w.outer_size(),
        w.is_maximized(),
        w.is_minimized(),
    ) else {
        return;
    };
    let Some(ws) = window_state::capture(
        (pos.x, pos.y),
        (size.width, size.height),
        maximized,
        minimized,
    ) else {
        return;
    };
    let state = shared(app);
    let path = {
        let mut s = lock(&state);
        s.window_saved_at = Some(Instant::now());
        s.dirs.config.join(window_state::FILE)
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
    match new_window(app, SPLASH, WebviewUrl::CustomProtocol(url))
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

    /// U-077: the marker was written before the notice was shown, so a notice the operating
    /// system refused was never shown again. Now it is written only after a shown notice.
    #[test]
    fn the_first_close_notice_is_marked_only_once_it_was_shown() {
        let dir = std::env::temp_dir().join(format!("fr-tray-hint-{}", uuid::Uuid::new_v4()));
        let mut shown = 0;
        assert!(!first_close_hint(&dir, || {
            shown += 1;
            Err("no notification service".into())
        }));
        assert!(!dir.join(TRAY_HINT_FILE).exists());
        // The next close tries again, and this time it is shown and marked.
        assert!(first_close_hint(&dir, || {
            shown += 1;
            Ok(())
        }));
        assert!(dir.join(TRAY_HINT_FILE).exists());
        // Never again after that.
        assert!(!first_close_hint(&dir, || {
            shown += 1;
            Ok(())
        }));
        assert_eq!(shown, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_close_notice_says_how_to_stop_forerunner() {
        assert!(FIRST_CLOSE_BODY.contains("Quit Forerunner"));
        assert!(FIRST_CLOSE_TITLE.contains("still running"));
    }

    /// The Tasks tab's PR link (`target="_blank"` before) did nothing in the window: the opener
    /// plugin's page script cancelled the click and the ACL refused its `open_url` (`lib.rs`,
    /// `opener_plugin`). A web page opens in the system browser, from a navigation and from a
    /// new-window request alike; nothing else leaves the app.
    #[test]
    fn links_that_leave_the_app_open_web_pages_in_the_browser_only() {
        let origins = vec![
            "http://localhost:1420".to_string(),
            "tauri://localhost".to_string(),
        ];
        let url = |s: &str| url::Url::parse(s).unwrap();
        let pr = url("https://github.com/example/hand-tasks/pull/1");
        assert_eq!(leave_action(&pr), LeaveAction::OpenInBrowser);
        assert_eq!(new_window_action(&pr, &origins), LeaveAction::OpenInBrowser);
        assert_eq!(
            new_window_action(&url("http://example.org/docs"), &origins),
            LeaveAction::OpenInBrowser
        );
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "fr://inbox",
        ] {
            assert_eq!(
                leave_action(&url(refused)),
                LeaveAction::Refuse,
                "{refused}"
            );
            assert_eq!(
                new_window_action(&url(refused), &origins),
                LeaveAction::Refuse,
                "{refused}"
            );
        }
        // The app's own pages never leave the window: see the next test.
    }

    /// Q7, the owner's decision of 2026-11-02: a Ctrl- or Shift-click on one of the app's own
    /// links (the sidebar's Inbox) did nothing in the window. The webview asks for a new window
    /// for it ("opening http from the window refused (new window)", Desktop app run
    /// 41495902701), and the shell refused that, because a second window would have no daemon
    /// token and the system browser cannot show the app's page. Now this window moves to the
    /// page, as a plain click on the link does.
    #[test]
    fn an_app_page_asked_for_in_a_new_window_is_shown_in_this_window() {
        let dev = url::Url::parse("http://localhost:1420/").unwrap();
        let origins = app_origins(Some(&dev), true);
        let url = |s: &str| url::Url::parse(s).unwrap();
        let here = |s: &str| new_window_action(&url(s), &origins);
        let show = |route: &str| LeaveAction::ShowHere(route.to_string());
        // WebView2 asks for http://tauri.localhost/<route>, WebKitGTK for tauri://localhost/...
        assert_eq!(here("http://tauri.localhost/inbox"), show("/inbox"));
        assert_eq!(
            here("https://tauri.localhost/projects/p1/tasks"),
            show("/projects/p1/tasks")
        );
        assert_eq!(here("tauri://localhost/settings"), show("/settings"));
        assert_eq!(here("tauri://localhost"), show("/"));
        assert_eq!(here("http://tauri.localhost/"), show("/"));
        // Every route the UI has, not only the deep-link roots; the dev server in a dev build.
        assert_eq!(here("http://localhost:1420/changes"), show("/changes"));
        assert_eq!(
            here("http://tauri.localhost/settings/capabilities/email"),
            show("/settings/capabilities/email")
        );
        // The page the link names, query and fragment included.
        assert_eq!(
            here("http://tauri.localhost/projects/p1/tasks?task=t1#notes"),
            show("/projects/p1/tasks?task=t1#notes")
        );
        // A path that would read as another host is no route: nothing opens.
        assert_eq!(
            here("http://tauri.localhost//evil.example/x"),
            LeaveAction::Refuse
        );
        // Not one of the app's pages: `window.open()` with no address, the splash.
        for refused in [
            "about:blank",
            "frshell://localhost/splash",
            "http://frshell.localhost/splash",
        ] {
            assert_eq!(here(refused), LeaveAction::Refuse, "{refused}");
        }
        // Look-alikes of the app's origins are web pages, for the browser.
        assert_eq!(
            here("http://tauri.localhost.evil.example/inbox"),
            LeaveAction::OpenInBrowser
        );
        assert_eq!(
            here("http://localhost:14200/inbox"),
            LeaveAction::OpenInBrowser
        );
        // A release build never takes the dev server for the app.
        assert_eq!(
            new_window_action(
                &url("http://localhost:1420/inbox"),
                &app_origins(Some(&dev), false)
            ),
            LeaveAction::OpenInBrowser
        );
    }

    #[test]
    fn an_app_route_is_the_pages_path_query_and_fragment() {
        let route = |s: &str| app_route(&url::Url::parse(s).unwrap());
        assert_eq!(
            route("http://tauri.localhost/inbox").as_deref(),
            Some("/inbox")
        );
        assert_eq!(route("tauri://localhost").as_deref(), Some("/"));
        assert_eq!(
            route("http://tauri.localhost/a%20b?x=1&y=%22#f").as_deref(),
            Some("/a%20b?x=1&y=%22#f")
        );
        assert_eq!(route("http://tauri.localhost//evil.example/x"), None);
        assert_eq!(route("tauri://localhost//evil.example/x"), None);
        assert_eq!(route("tauri://localhost/\\evil.example/x"), None);
        // The route goes into the page as a JSON string, never as code.
        let script = navigate_script(&route("http://tauri.localhost/x?q=\");alert(1)//").unwrap());
        assert!(
            script.contains(r#"var p = "/x?q=%22);alert(1)//";"#),
            "{script}"
        );
    }

    /// The CI window check reads this line for a Ctrl- or Shift-click on an in-app link.
    #[test]
    fn an_app_page_shown_in_this_window_is_logged_without_its_query() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(
            shown_in_window_line(&url("http://tauri.localhost/inbox"), Via::NewWindow),
            "shown in this window (new window): http://tauri.localhost/inbox"
        );
        assert_eq!(
            shown_in_window_line(
                &url("http://tauri.localhost/projects/p1/tasks?task=t1#x"),
                Via::NewWindow
            ),
            "shown in this window (new window): http://tauri.localhost/projects/p1/tasks (query not logged)"
        );
    }

    /// The CI window check asserts on this line (`scripts/desktop-window-check.mjs`): it names
    /// how the link left and where it went, never a query, a fragment or credentials.
    #[test]
    fn a_hand_off_to_the_browser_is_logged_without_query_or_credentials() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(
            handed_to_browser_line(&url("http://127.0.0.1:4100/acme/site/pull/1"), Via::Link),
            "handed to the system browser (link): http://127.0.0.1:4100/acme/site/pull/1"
        );
        assert_eq!(
            handed_to_browser_line(
                &url("https://user:secret@example.org/a b?token=abc#frag"),
                Via::NewWindow
            ),
            "handed to the system browser (new window): https://example.org/a%20b (query not logged)"
        );
        let line = handed_to_browser_line(&url("https://example.org/x#only-a-fragment"), Via::Link);
        assert!(line.ends_with("(query not logged)"), "{line}");
        assert!(!line.contains("only-a-fragment"), "{line}");
    }

    #[test]
    fn splash_is_self_contained() {
        let html = splash_html();
        assert!(html.contains("<!doctype html>"));
        assert!(html.contains(r#"id="s""#));
        assert!(!html.contains("<script"));
        assert!(!html.contains("http"));
    }
}
