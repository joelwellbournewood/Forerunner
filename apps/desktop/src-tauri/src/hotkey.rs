//! The global hotkey (spec O.1, ADR 0064): stub for the failing-test run.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const DEFAULT_CHORD: &str = "CommandOrControl+Shift+Space";
pub const FILE: &str = "hotkey.json";
pub const PRESS_EVENT: &str = "forerunner://hotkey";
pub const CHANGED_EVENT: &str = "forerunner://hotkey-changed";
pub const NAMED_KEYS: &[(&str, &[&str])] = &[];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Modifier {
    CommandOrControl,
    Control,
    Alt,
    Shift,
    Super,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

impl Chord {
    pub fn canonical(&self) -> String {
        todo!()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordError {
    Empty,
    EmptyToken,
    UnknownToken(String),
    NoKey,
    KeyNotLast(String),
    TooManyKeys(String),
    RepeatedModifier(String),
    ConflictingModifiers,
    NeedsModifier,
}

impl ChordError {
    pub fn kind(&self) -> &'static str {
        todo!()
    }
}

impl fmt::Display for ChordError {
    fn fmt(&self, _f: &mut fmt::Formatter<'_>) -> fmt::Result {
        todo!()
    }
}

pub fn parse_chord(_text: &str) -> Result<Chord, ChordError> {
    todo!()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotkeyFile {
    pub chord: String,
}

pub fn load(_path: &Path) -> Option<String> {
    todo!()
}

pub fn save(_path: &Path, _chord: &str) -> std::io::Result<()> {
    todo!()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    pub chord: String,
    pub id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyState {
    pub chord: String,
    pub registered: Option<Registered>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangePlan {
    NoChange,
    Register {
        chord: String,
        then_unregister: Option<Registered>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub chord: String,
    pub default_chord: String,
    pub registered: bool,
    pub error: Option<String>,
}

impl HotkeyState {
    pub fn new(_chord: &str) -> Self {
        todo!()
    }
    pub fn status(&self) -> HotkeyStatus {
        todo!()
    }
    pub fn registered(&mut self, _id: u32) {
        todo!()
    }
    pub fn failed(&mut self, _reason: String) {
        todo!()
    }
    pub fn plan_change(&self, _next: &Chord) -> ChangePlan {
        todo!()
    }
    pub fn changed(&mut self, _chord: &str, _id: u32) {
        todo!()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyEvent {
    pub chord: String,
    pub state: &'static str,
}

pub fn event_payload(_chord: &str, _pressed: bool) -> HotkeyEvent {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// The grammar cases shared with the UI (`apps/ui/test/hotkey-chords.json`).
    fn cases() -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/test/hotkey-chords.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).expect("hotkey-chords.json")
    }

    #[test]
    fn the_default_chord_is_the_shared_one_and_parses_to_itself() {
        assert_eq!(cases()["default"], DEFAULT_CHORD);
        let chord = parse_chord(DEFAULT_CHORD).expect("default parses");
        assert_eq!(chord.canonical(), DEFAULT_CHORD);
        assert_eq!(chord.modifiers, vec![Modifier::CommandOrControl, Modifier::Shift]);
        assert_eq!(chord.key, "Space");
    }

    #[test]
    fn accepts_every_shared_case_with_the_same_canonical_form() {
        for case in cases()["accepted"].as_array().expect("accepted") {
            let input = case["input"].as_str().unwrap();
            let canonical = case["canonical"].as_str().unwrap();
            let chord = parse_chord(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
            assert_eq!(chord.canonical(), canonical, "{input:?}");
            // Canonical forms are fixed points.
            assert_eq!(parse_chord(canonical).unwrap().canonical(), canonical);
        }
    }

    #[test]
    fn refuses_every_shared_case_for_the_same_reason() {
        for case in cases()["refused"].as_array().expect("refused") {
            let input = case["input"].as_str().unwrap();
            let reason = case["reason"].as_str().unwrap();
            let err = parse_chord(input).err().unwrap_or_else(|| panic!("{input:?} accepted"));
            assert_eq!(err.kind(), reason, "{input:?}: {err}");
            assert!(!err.to_string().is_empty());
        }
    }

    #[test]
    fn error_messages_name_the_token() {
        assert_eq!(
            parse_chord("Ctrl+Fn").unwrap_err().to_string(),
            "\"Fn\" is not a key or modifier this shell knows"
        );
        assert!(parse_chord("Space").unwrap_err().to_string().contains("needs a modifier"));
        assert!(parse_chord("Ctrl+Ctrl+A").unwrap_err().to_string().contains("Ctrl"));
    }

    /// Everything the validator accepts, the plugin parses: `hotkey_set` can only fail at the
    /// OS, never on the string it hands over.
    #[test]
    fn every_canonical_chord_is_accepted_by_the_plugin_parser() {
        use tauri_plugin_global_shortcut::Shortcut;
        let mut keys: Vec<String> = ('A'..='Z').map(|c| c.to_string()).collect();
        keys.extend(('0'..='9').map(|c| c.to_string()));
        keys.extend((1..=24).map(|n| format!("F{n}")));
        keys.extend((0..=9).map(|n| format!("Numpad{n}")));
        keys.extend(super::NAMED_KEYS.iter().map(|(name, _)| name.to_string()));
        for key in keys {
            for mods in ["CommandOrControl", "Control+Alt", "Shift+Super", "Alt"] {
                let chord = format!("{mods}+{key}");
                let parsed = parse_chord(&chord).unwrap_or_else(|e| panic!("{chord}: {e}"));
                assert!(
                    Shortcut::from_str(&parsed.canonical()).is_ok(),
                    "the plugin refuses {}",
                    parsed.canonical()
                );
            }
        }
        for case in cases()["accepted"].as_array().unwrap() {
            let canonical = case["canonical"].as_str().unwrap();
            assert!(Shortcut::from_str(canonical).is_ok(), "{canonical}");
        }
    }

    #[test]
    fn registration_state_reports_success_failure_and_plans_a_change() {
        let mut s = HotkeyState::new(DEFAULT_CHORD);
        assert_eq!(
            s.status(),
            HotkeyStatus {
                chord: DEFAULT_CHORD.into(),
                default_chord: DEFAULT_CHORD.into(),
                registered: false,
                error: None,
            }
        );
        // Startup: the chord was taken by another application.
        s.failed("HotKey already registered".into());
        assert!(!s.status().registered);
        assert_eq!(s.status().error.as_deref(), Some("HotKey already registered"));
        // A retry of the same chord registers again; nothing to unregister.
        let same = parse_chord(DEFAULT_CHORD).unwrap();
        assert_eq!(
            s.plan_change(&same),
            ChangePlan::Register {
                chord: DEFAULT_CHORD.into(),
                then_unregister: None
            }
        );
        s.registered(7);
        assert_eq!(
            s.status(),
            HotkeyStatus {
                chord: DEFAULT_CHORD.into(),
                default_chord: DEFAULT_CHORD.into(),
                registered: true,
                error: None,
            }
        );
        // The same chord again is a no-op.
        assert_eq!(s.plan_change(&same), ChangePlan::NoChange);
        // Another chord: register it first, then let the old one go, so a chord the OS refuses
        // leaves the working one in place.
        let other = parse_chord("ctrl+alt+t").unwrap();
        assert_eq!(
            s.plan_change(&other),
            ChangePlan::Register {
                chord: "Control+Alt+T".into(),
                then_unregister: Some(Registered {
                    chord: DEFAULT_CHORD.into(),
                    id: 7
                })
            }
        );
        s.changed("Control+Alt+T", 9);
        assert_eq!(
            s.registered,
            Some(Registered {
                chord: "Control+Alt+T".into(),
                id: 9
            })
        );
        assert_eq!(s.chord, "Control+Alt+T");
        assert!(s.status().registered);
        assert_eq!(s.status().error, None);
    }

    #[test]
    fn the_preference_file_round_trips_and_garbage_reads_as_absent() {
        let dir = std::env::temp_dir().join(format!("fr-hotkey-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE);
        assert_eq!(load(&path), None);
        save(&path, "Control+Alt+T").expect("save");
        assert_eq!(load(&path).as_deref(), Some("Control+Alt+T"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"chord\": \"Control+Alt+T\""));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), None);
        std::fs::write(&path, "{\"chord\": 5}").unwrap();
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_event_and_status_payloads_are_the_documented_json() {
        let pressed = serde_json::to_string(&event_payload(DEFAULT_CHORD, true)).unwrap();
        assert_eq!(
            pressed,
            r#"{"chord":"CommandOrControl+Shift+Space","state":"pressed"}"#
        );
        let released = serde_json::to_value(event_payload("F9", false)).unwrap();
        assert_eq!(released["state"], "released");
        let mut s = HotkeyState::new(DEFAULT_CHORD);
        s.failed("taken".into());
        let status = serde_json::to_value(s.status()).unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "chord": DEFAULT_CHORD,
                "defaultChord": DEFAULT_CHORD,
                "registered": false,
                "error": "taken"
            })
        );
        assert_eq!(PRESS_EVENT, "forerunner://hotkey");
        assert_eq!(CHANGED_EVENT, "forerunner://hotkey-changed");
    }
}
