//! The main window's microphone (spec O.1 and O.3, ADR 0064). The conversation panel the global
//! hotkey opens captures the microphone with `getUserMedia({ audio })`. Without a permission
//! handler WebKitGTK (Linux) denies that request outright, so a hotkey press could only ever
//! fall back to typing, and WebView2 (Windows) puts its own prompt on top of the press. The
//! shell therefore answers the webview's permission requests itself: the microphone is allowed
//! for the shell's own pages (the bundled UI on the app origins) and denied for anything else;
//! the camera, which the UI never asks for, is denied; every other kind keeps the webview's
//! default. The UI only opens the microphone on a hotkey press or a Talk click and stops it at
//! the end of the turn or when the panel closes.

use std::sync::{Arc, Mutex};

use tauri::webview::{PermissionKind, PermissionResponse};

/// The page the main window shows, recorded from its page-load events. The permission handler
/// reads it from here instead of asking the webview, because the request arrives inside the
/// webview's own callback. `None` until the first load starts.
#[derive(Debug, Clone, Default)]
pub struct CurrentPage(Arc<Mutex<Option<url::Url>>>);

impl CurrentPage {
    pub fn set(&self, page: &url::Url) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(page.clone());
    }

    pub fn get(&self) -> Option<url::Url> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// Whether `page` is one of the shell's own pages: exactly an app origin or a path under it.
/// Stricter than the navigation policy, which also lets the splash and `about:blank` load.
pub fn is_app_page(page: &url::Url, app_origins: &[String]) -> bool {
    let s = page.as_str();
    app_origins
        .iter()
        .any(|o| s == o || s.starts_with(&format!("{o}/")))
}

/// The answer to a permission request of the main window showing `page` (`None` when the shell
/// could not read the page's address: denied, never guessed).
pub fn permission_decision(
    kind: PermissionKind,
    page: Option<&url::Url>,
    app_origins: &[String],
) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone => match page {
            Some(p) if is_app_page(p, app_origins) => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        },
        PermissionKind::Camera => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inject::app_origins;

    fn url(s: &str) -> url::Url {
        url::Url::parse(s).expect("url")
    }

    #[test]
    fn the_microphone_is_allowed_for_the_shells_own_pages_only() {
        let origins = app_origins(None, false);
        for page in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/settings",
            "http://tauri.localhost/inbox?x=1",
            "https://tauri.localhost/",
        ] {
            assert_eq!(
                permission_decision(PermissionKind::Microphone, Some(&url(page)), &origins),
                PermissionResponse::Allow,
                "{page}"
            );
        }
        for page in [
            "https://example.com/",
            "http://127.0.0.1:7171/",
            "http://tauri.localhost.example.com/",
            "tauri://localhostevil/",
            "about:blank",
            "frshell://localhost/splash",
        ] {
            assert_eq!(
                permission_decision(PermissionKind::Microphone, Some(&url(page)), &origins),
                PermissionResponse::Deny,
                "{page}"
            );
        }
        assert_eq!(
            permission_decision(PermissionKind::Microphone, None, &origins),
            PermissionResponse::Deny,
            "an unreadable page address is denied"
        );
    }

    #[test]
    fn the_decision_follows_the_page_the_window_loaded_last() {
        let origins = app_origins(None, false);
        let page = CurrentPage::default();
        let shared = page.clone();
        let decide =
            || permission_decision(PermissionKind::Microphone, page.get().as_ref(), &origins);
        assert_eq!(decide(), PermissionResponse::Deny, "nothing loaded yet");
        shared.set(&url("tauri://localhost/"));
        assert_eq!(decide(), PermissionResponse::Allow);
        shared.set(&url("https://example.com/"));
        assert_eq!(decide(), PermissionResponse::Deny);
    }

    #[test]
    fn the_dev_server_counts_only_in_a_dev_build() {
        let dev = url("http://localhost:1420");
        let page = url("http://localhost:1420/settings");
        assert_eq!(
            permission_decision(
                PermissionKind::Microphone,
                Some(&page),
                &app_origins(Some(&dev), true)
            ),
            PermissionResponse::Allow
        );
        assert_eq!(
            permission_decision(
                PermissionKind::Microphone,
                Some(&page),
                &app_origins(Some(&dev), false)
            ),
            PermissionResponse::Deny
        );
    }

    #[test]
    fn the_camera_is_denied_and_other_kinds_keep_the_webview_default() {
        let origins = app_origins(None, false);
        let page = url("tauri://localhost/");
        assert_eq!(
            permission_decision(PermissionKind::Camera, Some(&page), &origins),
            PermissionResponse::Deny
        );
        for kind in [
            PermissionKind::Notifications,
            PermissionKind::Geolocation,
            PermissionKind::DisplayCapture,
            PermissionKind::ClipboardRead,
            PermissionKind::Other,
        ] {
            assert_eq!(
                permission_decision(kind, Some(&page), &origins),
                PermissionResponse::Default,
                "{kind}"
            );
        }
    }
}
