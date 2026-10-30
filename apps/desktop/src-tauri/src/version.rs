//! Comparing release versions (ADR 0092): which of a staged update and the runtime the
//! installer carries is newer, and whether a running daemon is older than that runtime. The
//! rule is the runtime's `compareSemver` (`packages/runtime/src/update/semver.ts`): numeric
//! major, minor and patch; a pre-release sorts below its release; pre-release identifiers
//! compare numerically when both are numbers, else as text; build metadata is ignored.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Parsed {
    core: [u64; 3],
    pre: Vec<String>,
}

fn parse(v: &str) -> Option<Parsed> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next().unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let mut parts = core.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        Some("") => return None,
        Some(p) => p.split('.').map(str::to_string).collect(),
        None => Vec::new(),
    };
    Some(Parsed { core: out, pre })
}

fn compare_pre(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for (x, y) in a.iter().zip(b.iter()) {
        let o = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(n), Ok(m)) => n.cmp(&m),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

/// `a` against `b`; `None` when either is not a version.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (parse(a)?, parse(b)?);
    Some(
        a.core
            .cmp(&b.core)
            .then_with(|| compare_pre(&a.pre, &b.pre)),
    )
}

/// True when `version` is a version and strictly older than `than`.
pub fn is_older(version: &str, than: &str) -> bool {
    compare(version, than) == Some(Ordering::Less)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_releases_and_pre_releases() {
        assert_eq!(compare("1.0.0", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(compare("v1.0.0", "1.0.0+build.7"), Some(Ordering::Equal));
        assert_eq!(compare("0.1.0", "1.0.0"), Some(Ordering::Less));
        assert_eq!(compare("1.0.1", "1.0.0"), Some(Ordering::Greater));
        assert_eq!(compare("1.10.0", "1.9.9"), Some(Ordering::Greater));
        assert_eq!(compare("1.0.0-rc.4", "1.0.0"), Some(Ordering::Less));
        assert_eq!(
            compare("1.0.0-rc.10", "1.0.0-rc.4"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare("1.0.0-rc.1", "1.0.0-beta.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(compare("1.0.0-rc", "1.0.0-rc.1"), Some(Ordering::Less));
        assert_eq!(compare("1.0.0-1", "1.0.0-alpha"), Some(Ordering::Less));
    }

    #[test]
    fn anything_else_is_not_a_version() {
        for bad in ["", "1", "1.0", "1.0.0.0", "a.b.c", "1.0.0-", "latest"] {
            assert_eq!(compare(bad, "1.0.0"), None, "{bad:?}");
            assert!(!is_older(bad, "1.0.0"), "{bad:?}");
        }
    }

    #[test]
    fn older_is_strict() {
        assert!(is_older("0.1.0", "1.0.0"));
        assert!(is_older("1.0.0-rc.4", "1.0.0"));
        assert!(!is_older("1.0.0", "1.0.0"));
        assert!(!is_older("1.0.1", "1.0.0"));
    }
}
