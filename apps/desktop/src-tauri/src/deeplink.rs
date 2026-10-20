//! `fr://` deep links and the webview navigation policy (ADR 0031).
//!
//! Scheme: `fr://<route>` maps to the UI route `/<route>`, limited to the routes the UI has:
//! `fr://open` or `fr://` → `/`, `fr://inbox`, `fr://projects/<id>[/<tab>]`,
//! `fr://sessions/<id>`, `fr://settings`, `fr://memory`, `fr://extensions`. Query strings and
//! fragments are dropped; segments may only contain `A-Z a-z 0-9 . _ ~ -`. Anything else is
//! ignored (the window is still brought to the front). The UI is navigated in place with
//! `history.pushState` + a `popstate` event, which React Router's `BrowserRouter` follows, so
//! the UI needs no shell-specific code.
//!
//! Navigation policy: the main window may only load the app's own origins (and the shell's
//! splash protocol); `http(s)` targets are opened in the OS browser instead, so the
//! initialization script's token can never be served to a remote page.

pub const SCHEME: &str = "fr";
pub const SPLASH_SCHEME: &str = "frshell";

/// Route roots the UI serves, with the minimum and maximum number of extra segments.
const ROOTS: &[(&str, usize, usize)] = &[
    ("inbox", 0, 0),
    ("projects", 1, 2),
    ("sessions", 1, 1),
    ("settings", 0, 0),
    ("memory", 0, 0),
    ("extensions", 0, 0),
];

fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
}

/// True for a UI route the shell will navigate to: `/` or `/<root>[/<segment>…]` within the
/// per-root segment budget.
pub fn is_safe_route(route: &str) -> bool {
    if route == "/" {
        return true;
    }
    let Some(rest) = route.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let Some((root, tail)) = segments.split_first() else {
        return false;
    };
    let Some((_, min_extra, max_extra)) = ROOTS.iter().find(|(r, _, _)| r == root) else {
        return false;
    };
    (*min_extra..=*max_extra).contains(&tail.len()) && tail.iter().all(|s| safe_segment(s))
}

/// The UI route for a deep link, `None` when the link is not one the shell accepts.
pub fn route_for_deep_link(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if url.scheme() != SCHEME {
        return None;
    }
    // Only the authority form `fr://<route>` is a deep link; `fr:inbox` has no host.
    if url.host_str().is_none() && !url.path().is_empty() {
        return None;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let mut segments: Vec<String> = Vec::new();
    if !host.is_empty() && host != "open" {
        segments.push(host);
    }
    for s in url.path().split('/').filter(|s| !s.is_empty()) {
        segments.push(s.to_string());
    }
    let route = if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    };
    is_safe_route(&route).then_some(route)
}

/// Script that moves the UI to `route` in place. The route is JSON-encoded; callers pass only
/// routes `is_safe_route` accepted.
pub fn navigate_script(route: &str) -> String {
    let encoded = serde_json::to_string(route).unwrap_or_else(|_| "\"/\"".to_string());
    format!(
        "(function () {{ try {{ var p = {encoded}; if (window.location.pathname !== p) {{ window.history.pushState({{}}, \"\", p); }} window.dispatchEvent(new PopStateEvent(\"popstate\", {{ state: {{}} }})); }} catch (e) {{}} }})();"
    )
}

/// Whether the main window may navigate to `url`: the app origins, the splash protocol and
/// `about:blank` only.
pub fn navigation_allowed(url: &url::Url, app_origins: &[String]) -> bool {
    let s = url.as_str();
    if s == "about:blank" || url.scheme() == SPLASH_SCHEME {
        return true;
    }
    if url.scheme() == "http" && url.host_str() == Some(&format!("{SPLASH_SCHEME}.localhost")) {
        return true;
    }
    app_origins
        .iter()
        .any(|o| s == o || s.starts_with(&format!("{o}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_documented_links_to_routes() {
        assert_eq!(route_for_deep_link("fr://inbox").as_deref(), Some("/inbox"));
        assert_eq!(route_for_deep_link("fr://open").as_deref(), Some("/"));
        assert_eq!(
            route_for_deep_link("fr://Inbox/").as_deref(),
            Some("/inbox")
        );
        assert_eq!(
            route_for_deep_link("fr://projects/p-1/tasks").as_deref(),
            Some("/projects/p-1/tasks")
        );
        assert_eq!(
            route_for_deep_link("fr://projects/p-1").as_deref(),
            Some("/projects/p-1")
        );
        assert_eq!(
            route_for_deep_link("fr://sessions/s_9").as_deref(),
            Some("/sessions/s_9")
        );
        assert_eq!(
            route_for_deep_link("fr://settings?x=1#y").as_deref(),
            Some("/settings")
        );
        assert_eq!(
            route_for_deep_link("fr://memory").as_deref(),
            Some("/memory")
        );
        assert_eq!(
            route_for_deep_link("fr://extensions").as_deref(),
            Some("/extensions")
        );
    }

    #[test]
    fn rejects_unknown_routes_schemes_and_hostile_segments() {
        assert_eq!(route_for_deep_link("fr://admin"), None);
        assert_eq!(route_for_deep_link("fr://projects/a/b/c"), None);
        assert_eq!(route_for_deep_link("fr://sessions"), None);
        assert_eq!(route_for_deep_link("fr://projects"), None);
        // The URL parser removes dot segments before the route check sees them; a literal
        // ".." can only arrive percent-encoded, and that is refused.
        assert_eq!(
            route_for_deep_link("fr://projects/../x").as_deref(),
            Some("/projects/x")
        );
        assert_eq!(route_for_deep_link("fr://projects/a%2F..%2Fb"), None);
        assert_eq!(
            route_for_deep_link("fr://projects/%2E%2E/x").as_deref(),
            Some("/projects/x")
        );
        assert!(!is_safe_route("/projects/../x"));
        assert_eq!(route_for_deep_link("https://inbox"), None);
        assert_eq!(route_for_deep_link("fr:inbox"), None);
        assert_eq!(route_for_deep_link("javascript:alert(1)"), None);
        assert_eq!(route_for_deep_link(""), None);
    }

    #[test]
    fn safe_routes() {
        assert!(is_safe_route("/"));
        assert!(is_safe_route("/inbox"));
        assert!(is_safe_route("/projects/abc/costs"));
        assert!(!is_safe_route("/inbox/extra"));
        assert!(!is_safe_route("inbox"));
        assert!(!is_safe_route("//inbox"));
        assert!(!is_safe_route("/projects/a b"));
        assert!(!is_safe_route("/projects/<script>"));
        assert!(!is_safe_route("https://evil.example/"));
    }

    #[test]
    fn navigate_script_encodes_the_route() {
        let s = navigate_script("/projects/p-1/tasks");
        assert!(s.contains(r#"var p = "/projects/p-1/tasks";"#));
        assert!(s.contains("pushState"));
        assert!(s.contains("popstate"));
    }

    #[test]
    fn navigation_policy_allows_only_the_app_and_the_splash() {
        let origins = vec![
            "tauri://localhost".to_string(),
            "http://tauri.localhost".to_string(),
            "http://localhost:1420".to_string(),
        ];
        let ok = |u: &str| navigation_allowed(&url::Url::parse(u).unwrap(), &origins);
        assert!(ok("tauri://localhost/inbox"));
        assert!(ok("tauri://localhost"));
        assert!(ok("http://tauri.localhost/projects/x"));
        assert!(ok("http://localhost:1420/"));
        assert!(ok("frshell://localhost/splash"));
        assert!(ok("http://frshell.localhost/splash"));
        assert!(ok("about:blank"));
        assert!(!ok("https://github.com/x/y/pull/1"));
        assert!(!ok("http://localhost:14200/"));
        assert!(!ok("http://tauri.localhost.evil.example/"));
        assert!(!ok("http://127.0.0.1:8787/events"));
    }
}
