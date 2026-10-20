//! What the shell injects before the UI loads (ADR 0025, ADR 0026): an initialization script
//! that sets `window.__FORERUNNER__ = { daemonUrl, daemonToken, installId, platform,
//! shellVersion }` (`ShellInjection` in `apps/ui/src/api/config.ts`). Tauri runs
//! initialization scripts on every document the window loads, so the script checks the page
//! origin first: only the app's own origin (`tauri://localhost`, `http://tauri.localhost`, the
//! dev server) gets the token; a page from anywhere else sees nothing. The object is frozen and
//! non-configurable so page code cannot swap the daemon address under the client.

use std::fmt;

use crate::secret::Secret;

#[derive(Clone)]
pub struct Injection {
    pub daemon_url: String,
    pub daemon_token: Secret,
    pub install_id: String,
    pub platform: String,
    pub shell_version: String,
}

impl fmt::Debug for Injection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Injection")
            .field("daemon_url", &self.daemon_url)
            .field("daemon_token", &self.daemon_token)
            .field("install_id", &self.install_id)
            .field("platform", &self.platform)
            .field("shell_version", &self.shell_version)
            .finish()
    }
}

/// Origins the UI bundle is served from: Tauri's app protocol on Linux (`tauri://localhost`)
/// and Windows (`http://tauri.localhost`, `https://` when `useHttpsScheme` is on) plus, in a
/// dev build only (`dev_build` is `tauri::is_dev()`), the Vite dev server of `tauri dev`. The
/// dev URL is compiled into release builds as well; a release never grants it the token.
pub fn app_origins(dev_url: Option<&url::Url>, dev_build: bool) -> Vec<String> {
    let mut out = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if let (Some(u), true) = (dev_url, dev_build) {
        let origin = u.origin().ascii_serialization();
        if origin != "null" && !out.contains(&origin) {
            out.push(origin);
        }
    }
    out
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

pub fn initialization_script(inj: &Injection, allowed_origins: &[String]) -> String {
    let origins = serde_json::to_string(allowed_origins).unwrap_or_else(|_| "[]".to_string());
    format!(
        r#"(function () {{
  try {{
    var allowed = {origins};
    var origin = String(window.location.origin || "");
    var href = String(window.location.href || "");
    var ok = false;
    for (var i = 0; i < allowed.length; i++) {{
      if (allowed[i] === origin || href === allowed[i] || href.indexOf(allowed[i] + "/") === 0) {{ ok = true; }}
    }}
    if (!ok) {{ return; }}
    Object.defineProperty(window, "__FORERUNNER__", {{
      value: Object.freeze({{
        daemonUrl: {url},
        daemonToken: {token},
        installId: {install_id},
        platform: {platform},
        shellVersion: {shell_version}
      }}),
      writable: false,
      configurable: false,
      enumerable: false
    }});
  }} catch (e) {{}}
}})();
"#,
        origins = origins,
        url = js_string(&inj.daemon_url),
        token = js_string(inj.daemon_token.expose()),
        install_id = js_string(&inj.install_id),
        platform = js_string(&inj.platform),
        shell_version = js_string(&inj.shell_version),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        let mut t = String::from("inj"); // not-a-secret
        t.push_str("ect_0123456789abcdefghijklmnopqrstuvwxyz"); // not-a-secret
        t
    }

    fn injection(url: &str) -> Injection {
        Injection {
            daemon_url: url.into(),
            daemon_token: Secret::new(token()),
            install_id: "9d1c0e7a-6c4f-4f9b-9a46-2f3f9c2a1b11".into(),
            platform: "linux".into(),
            shell_version: "0.1.0".into(),
        }
    }

    #[test]
    fn script_sets_the_frozen_global_with_every_field() {
        let s = initialization_script(
            &injection("http://127.0.0.1:43211"),
            &app_origins(None, false),
        );
        assert!(s.contains(r#"daemonUrl: "http://127.0.0.1:43211""#));
        assert!(s.contains(&format!(r#"daemonToken: "{}""#, token())));
        assert!(s.contains(r#"installId: "9d1c0e7a-6c4f-4f9b-9a46-2f3f9c2a1b11""#));
        assert!(s.contains(r#"platform: "linux""#));
        assert!(s.contains(r#"shellVersion: "0.1.0""#));
        assert!(s.contains("Object.freeze"));
        assert!(s.contains("configurable: false"));
        assert!(s.contains(r#"var allowed = ["tauri://localhost","http://tauri.localhost","https://tauri.localhost"]"#));
        assert!(s.contains("if (!ok) { return; }"));
    }

    #[test]
    fn hostile_values_are_json_escaped() {
        let s = initialization_script(
            &injection("http://127.0.0.1:1\"; alert(1); //"),
            &app_origins(None, false),
        );
        assert!(s.contains(r#"daemonUrl: "http://127.0.0.1:1\"; alert(1); //""#));
        assert!(!s.contains("\"; alert(1); //\n"));
    }

    #[test]
    fn dev_server_origin_is_added_once_and_only_in_dev_builds() {
        let dev = url::Url::parse("http://localhost:1420/").unwrap();
        let origins = app_origins(Some(&dev), true);
        assert_eq!(origins.len(), 4);
        assert_eq!(origins[3], "http://localhost:1420");
        let again = app_origins(Some(&url::Url::parse("tauri://localhost").unwrap()), true);
        assert_eq!(again.len(), 3, "opaque origins are not added: {again:?}");
        // The dev URL is compiled into release builds too; a release never trusts it.
        let release = app_origins(Some(&dev), false);
        assert_eq!(release.len(), 3, "{release:?}");
        assert!(!release.iter().any(|o| o.contains("1420")));
    }

    #[test]
    fn debug_output_never_contains_the_token() {
        let printed = format!("{:?}", injection("http://127.0.0.1:1"));
        assert!(!printed.contains(&token()));
        assert!(printed.contains("[redacted]"));
    }
}
