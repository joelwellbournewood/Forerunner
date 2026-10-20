//! The daemon token and anything else that must never reach a log line. A `Secret` prints as
//! `[redacted]` through both `Debug` and `Display`, so a value cannot leak through a derived
//! `Debug` on a struct that carries it, and `redact()` scrubs free text (error messages from
//! the HTTP client, dialog text) before it is logged or shown.

use std::fmt;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

pub const REDACTED: &str = "[redacted]";

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The raw value. Only the injection script and the `Authorization` header use it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

/// Replace every occurrence of every secret in `text` with `[redacted]`. Empty secrets are
/// skipped (replacing "" would be an infinite expansion).
pub fn redact(text: &str, secrets: &[&Secret]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.is_empty() {
            continue;
        }
        out = out.replace(s.expose(), REDACTED);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Built by concatenation so the secret scan does not flag a credential shape.
    fn token() -> String {
        let mut t = String::from("tok"); // not-a-secret
        t.push_str("en_abcdefghijklmnopqrstuvwxyz0123456789"); // not-a-secret
        t
    }

    #[test]
    fn debug_and_display_never_print_the_value() {
        let s = Secret::new(token());
        assert_eq!(format!("{s:?}"), REDACTED);
        assert_eq!(format!("{s}"), REDACTED);
        #[derive(Debug)]
        #[allow(dead_code)]
        struct Carrier {
            url: String,
            token: Secret,
        }
        let c = Carrier {
            url: "http://127.0.0.1:1".into(),
            token: Secret::new(token()),
        };
        let printed = format!("{c:?}");
        assert!(!printed.contains(&token()));
        assert!(printed.contains(REDACTED));
    }

    #[test]
    fn redact_scrubs_every_occurrence_and_skips_empty_secrets() {
        let s = Secret::new(token());
        let empty = Secret::new("");
        let text = format!("bearer {} failed; retry with {}", token(), token());
        let out = redact(&text, &[&s, &empty]);
        assert!(!out.contains(&token()));
        assert_eq!(out.matches(REDACTED).count(), 2);
        assert_eq!(redact("nothing here", &[&empty]), "nothing here");
    }
}
