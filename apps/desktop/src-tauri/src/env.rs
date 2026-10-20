//! Environment access behind a trait so every decision in the shell (directories, install
//! discovery) is testable with a fixture table instead of the process environment. Edition 2024
//! makes `std::env::set_var` unsafe for good reason; tests never touch the real environment.

#[cfg(test)]
use std::collections::HashMap;

pub trait Env {
    /// The variable's value, `None` when it is unset. An empty value is `Some("")`, exactly as
    /// Node's `process.env` reports it (so `appDirs()` and the Rust mirror agree).
    fn var(&self, key: &str) -> Option<String>;
}

/// The real process environment.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// A fixture environment for tests and for the fixture tables in `dirs.rs`.
#[cfg(test)]
#[derive(Debug, Default, Clone)]
pub struct MapEnv(pub HashMap<String, String>);

#[cfg(test)]
impl MapEnv {
    pub fn new(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        )
    }
}

#[cfg(test)]
impl Env for MapEnv {
    fn var(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_env_distinguishes_unset_from_empty() {
        let env = MapEnv::new(&[("EMPTY", ""), ("SET", "x")]);
        assert_eq!(env.var("EMPTY"), Some(String::new()));
        assert_eq!(env.var("SET"), Some("x".to_string()));
        assert_eq!(env.var("MISSING"), None);
    }
}
