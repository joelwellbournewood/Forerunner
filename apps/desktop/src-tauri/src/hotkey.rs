//! The global hotkey (spec O.1, ADR 0064): the chord grammar, the registration state machine,
//! the per-install preference file and the payloads the shell sends to the UI. Everything here
//! is plain Rust without a Tauri handle so it is unit-tested; `hotkey_shell.rs` wires it to
//! tauri-plugin-global-shortcut, the main window and the UI's `invoke` calls.
//!
//! The grammar is shared with the UI (`apps/ui/src/shell/hotkey.ts`) through the case file
//! `apps/ui/test/hotkey-chords.json`: both sides run every case, so they cannot drift.
//!
//! A chord is `Modifier+...+Key`, case-insensitive, tokens trimmed. Modifiers:
//! `CommandOrControl` (`CmdOrCtrl`, `Mod`; Control on Windows and Linux), `Control` (`Ctrl`),
//! `Alt` (`Option`), `Shift`, `Super` (`Command`, `Cmd`, `Meta`, `Win`). Keys: `A`-`Z`
//! (`KeyA`), `0`-`9` (`Digit0`), `F1`-`F24`, `Numpad0`-`Numpad9` and the names in
//! `NAMED_KEYS`. Exactly one key, last. A chord needs a modifier other than Shift unless its
//! key is a function key: a bare letter or Shift+letter would swallow ordinary typing in every
//! other application.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The default chord (ADR 0064): Ctrl+Shift+Space on Windows and Linux.
pub const DEFAULT_CHORD: &str = "CommandOrControl+Shift+Space";
/// The preference file under `<config>`.
pub const FILE: &str = "hotkey.json";
/// Emitted to the main window when the chord is pressed (payload `HotkeyEvent`).
pub const PRESS_EVENT: &str = "forerunner://hotkey";
/// Emitted to the main window when the registration changed or failed (payload `HotkeyStatus`).
pub const CHANGED_EVENT: &str = "forerunner://hotkey-changed";

/// Named keys: the canonical name (the one tauri-plugin-global-shortcut parses) and the
/// lower-case spellings accepted for it.
pub const NAMED_KEYS: &[(&str, &[&str])] = &[
    ("Space", &["space"]),
    ("Enter", &["enter", "return"]),
    ("Tab", &["tab"]),
    ("Escape", &["escape", "esc"]),
    ("Backspace", &["backspace"]),
    ("Delete", &["delete", "del"]),
    ("Insert", &["insert", "ins"]),
    ("Home", &["home"]),
    ("End", &["end"]),
    ("PageUp", &["pageup"]),
    ("PageDown", &["pagedown"]),
    ("ArrowUp", &["arrowup", "up"]),
    ("ArrowDown", &["arrowdown", "down"]),
    ("ArrowLeft", &["arrowleft", "left"]),
    ("ArrowRight", &["arrowright", "right"]),
    ("Minus", &["minus"]),
    ("Equal", &["equal"]),
    ("BracketLeft", &["bracketleft"]),
    ("BracketRight", &["bracketright"]),
    ("Backslash", &["backslash"]),
    ("Semicolon", &["semicolon"]),
    ("Quote", &["quote"]),
    ("Comma", &["comma"]),
    ("Period", &["period"]),
    ("Slash", &["slash"]),
    ("Backquote", &["backquote"]),
    ("PrintScreen", &["printscreen"]),
    ("Pause", &["pause"]),
    ("ScrollLock", &["scrolllock"]),
];

/// Modifiers in canonical order (the derive order is the order `canonical()` writes them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Modifier {
    CommandOrControl,
    Control,
    Alt,
    Shift,
    Super,
}

impl Modifier {
    pub fn name(self) -> &'static str {
        match self {
            Modifier::CommandOrControl => "CommandOrControl",
            Modifier::Control => "Control",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
            Modifier::Super => "Super",
        }
    }

    fn parse(lower: &str) -> Option<Modifier> {
        match lower {
            "commandorcontrol" | "commandorctrl" | "cmdorctrl" | "cmdorcontrol" | "mod" => {
                Some(Modifier::CommandOrControl)
            }
            "control" | "ctrl" => Some(Modifier::Control),
            "alt" | "option" => Some(Modifier::Alt),
            "shift" => Some(Modifier::Shift),
            "super" | "command" | "cmd" | "meta" | "win" => Some(Modifier::Super),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    /// Sorted, without repeats.
    pub modifiers: Vec<Modifier>,
    /// The canonical key name.
    pub key: String,
}

impl Chord {
    /// The one spelling the shell registers, stores and reports.
    pub fn canonical(&self) -> String {
        let mut parts: Vec<&str> = self.modifiers.iter().map(|m| m.name()).collect();
        parts.push(&self.key);
        parts.join("+")
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
    /// The stable reason code the UI's validator reports for the same input.
    pub fn kind(&self) -> &'static str {
        match self {
            ChordError::Empty => "empty",
            ChordError::EmptyToken => "empty-token",
            ChordError::UnknownToken(_) => "unknown-token",
            ChordError::NoKey => "no-key",
            ChordError::KeyNotLast(_) => "key-not-last",
            ChordError::TooManyKeys(_) => "too-many-keys",
            ChordError::RepeatedModifier(_) => "repeated-modifier",
            ChordError::ConflictingModifiers => "conflicting-modifiers",
            ChordError::NeedsModifier => "needs-modifier",
        }
    }
}

impl fmt::Display for ChordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChordError::Empty => write!(f, "the shortcut is empty"),
            ChordError::EmptyToken => write!(
                f,
                "the shortcut has an empty part (\"++\" or a + at an end)"
            ),
            ChordError::UnknownToken(t) => {
                write!(f, "\"{t}\" is not a key or modifier this shell knows")
            }
            ChordError::NoKey => write!(f, "the shortcut has modifiers but no key"),
            ChordError::KeyNotLast(t) => write!(f, "the key must come last; \"{t}\" follows it"),
            ChordError::TooManyKeys(t) => {
                write!(f, "only one key is allowed; \"{t}\" is a second one")
            }
            ChordError::RepeatedModifier(t) => write!(f, "the modifier \"{t}\" appears twice"),
            ChordError::ConflictingModifiers => write!(
                f,
                "CommandOrControl already means Control (Windows, Linux) or Command (macOS); do not combine it with Control or Super"
            ),
            ChordError::NeedsModifier => write!(
                f,
                "the shortcut needs a modifier other than Shift (Ctrl, Alt or Super), or a function key"
            ),
        }
    }
}

fn parse_key(lower: &str) -> Option<String> {
    let bytes = lower.as_bytes();
    if bytes.len() == 1 && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return Some(lower.to_ascii_uppercase());
    }
    if let Some(rest) = lower.strip_prefix("key")
        && rest.len() == 1
        && rest.as_bytes()[0].is_ascii_lowercase()
    {
        return Some(rest.to_ascii_uppercase());
    }
    if let Some(rest) = lower.strip_prefix("digit")
        && rest.len() == 1
        && rest.as_bytes()[0].is_ascii_digit()
    {
        return Some(rest.to_string());
    }
    if let Some(rest) = lower.strip_prefix("numpad")
        && rest.len() == 1
        && rest.as_bytes()[0].is_ascii_digit()
    {
        return Some(format!("Numpad{rest}"));
    }
    if let Some(n) = function_key_number(lower) {
        return Some(format!("F{n}"));
    }
    NAMED_KEYS
        .iter()
        .find(|(_, aliases)| aliases.contains(&lower))
        .map(|(name, _)| (*name).to_string())
}

/// `f1`..`f24` (no leading zero).
fn function_key_number(lower: &str) -> Option<u8> {
    let rest = lower.strip_prefix('f')?;
    if rest.is_empty() || rest.starts_with('0') || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u8 = rest.parse().ok()?;
    (1..=24).contains(&n).then_some(n)
}

fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .is_some_and(|rest| function_key_number(&format!("f{rest}")).is_some())
}

/// Parse and validate a chord. Errors are reported in input order (the first bad token wins).
pub fn parse_chord(text: &str) -> Result<Chord, ChordError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ChordError::Empty);
    }
    let mut modifiers: Vec<Modifier> = Vec::new();
    let mut key: Option<String> = None;
    for raw in text.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(ChordError::EmptyToken);
        }
        let lower = token.to_ascii_lowercase();
        if let Some(m) = Modifier::parse(&lower) {
            if key.is_some() {
                return Err(ChordError::KeyNotLast(token.to_string()));
            }
            if modifiers.contains(&m) {
                return Err(ChordError::RepeatedModifier(token.to_string()));
            }
            modifiers.push(m);
        } else if let Some(k) = parse_key(&lower) {
            if key.is_some() {
                return Err(ChordError::TooManyKeys(token.to_string()));
            }
            key = Some(k);
        } else {
            return Err(ChordError::UnknownToken(token.to_string()));
        }
    }
    let Some(key) = key else {
        return Err(ChordError::NoKey);
    };
    if modifiers.contains(&Modifier::CommandOrControl)
        && (modifiers.contains(&Modifier::Control) || modifiers.contains(&Modifier::Super))
    {
        return Err(ChordError::ConflictingModifiers);
    }
    let strong = modifiers.iter().any(|m| *m != Modifier::Shift);
    if !strong && !is_function_key(&key) {
        return Err(ChordError::NeedsModifier);
    }
    modifiers.sort();
    Ok(Chord { modifiers, key })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotkeyFile {
    pub chord: String,
}

/// The saved chord, or `None` when the file is missing or not `{ "chord": "<string>" }`.
pub fn load(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<HotkeyFile>(&text)
        .ok()
        .map(|f| f.chord)
}

pub fn save(path: &Path, chord: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(&HotkeyFile {
        chord: chord.to_string(),
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(path, format!("{text}\n"))
}

/// The chord to register at start: the saved one when it still parses, else the default with
/// a note for the UI (a hand-edited file never stops the shell).
pub fn startup_chord(saved: Option<&str>) -> (String, Option<String>) {
    match saved {
        None => (DEFAULT_CHORD.to_string(), None),
        Some(text) => match parse_chord(text) {
            Ok(chord) => (chord.canonical(), None),
            Err(e) => (
                DEFAULT_CHORD.to_string(),
                Some(format!("the saved shortcut \"{text}\" was ignored: {e}")),
            ),
        },
    }
}

/// Linux only: global shortcuts go through X11 (XWayland on a Wayland desktop). Without a
/// display the plugin's register call "succeeds" while nothing ever fires, so the shell does
/// not register and says why instead of reporting a shortcut that cannot work.
pub fn linux_display_missing(display: Option<&str>) -> Option<String> {
    match display.map(str::trim) {
        Some(d) if !d.is_empty() => None,
        _ => Some(
            "no X display (DISPLAY is unset): global shortcuts need X11 or XWayland on Linux"
                .to_string(),
        ),
    }
}

/// What the OS holds for us: the canonical chord and the plugin's id for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    pub chord: String,
    pub id: u32,
}

/// The registration state machine. `chord` is the configured chord (registered or not);
/// `registered` what the OS holds; `error` the last failure, shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyState {
    pub chord: String,
    pub registered: Option<Registered>,
    pub error: Option<String>,
}

/// What `hotkey_set` must do for a requested chord.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangePlan {
    /// The chord is already registered.
    NoChange,
    /// Another spelling of the hotkey the OS already holds for us (on Windows and Linux
    /// `CommandOrControl+Shift+Space` and `Control+Shift+Space` are one hotkey with one plugin
    /// id): keep the registration, adopt and save the new spelling.
    Respell { chord: String },
    /// Register `chord`; once that succeeded, unregister the old one (if any). A chord the OS
    /// refuses therefore leaves the working one in place.
    Register {
        chord: String,
        then_unregister: Option<Registered>,
    },
}

/// What the UI reads (`hotkey_status`, `hotkey_set`, the `CHANGED_EVENT` payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub chord: String,
    pub default_chord: String,
    pub registered: bool,
    pub error: Option<String>,
}

impl HotkeyState {
    pub fn new(chord: &str) -> Self {
        Self {
            chord: chord.to_string(),
            registered: None,
            error: None,
        }
    }

    pub fn status(&self) -> HotkeyStatus {
        HotkeyStatus {
            chord: self.chord.clone(),
            default_chord: DEFAULT_CHORD.to_string(),
            registered: self.registered.is_some(),
            error: self.error.clone(),
        }
    }

    /// The configured chord was registered with `id`.
    pub fn registered(&mut self, id: u32) {
        self.registered = Some(Registered {
            chord: self.chord.clone(),
            id,
        });
        self.error = None;
    }

    /// Registering the configured chord failed (taken by another application, no X server):
    /// nothing is registered; the reason goes to the UI.
    pub fn failed(&mut self, reason: String) {
        self.registered = None;
        self.error = Some(reason);
    }

    /// A note that does not change the registration (e.g. a saved chord that was ignored).
    pub fn note(&mut self, reason: String) {
        self.error = Some(reason);
    }

    /// `next_id` is the plugin's id for `next` (`Shortcut::id()`): two spellings with the same
    /// id are the same OS hotkey, which the plugin refuses to register twice.
    pub fn plan_change(&self, next: &Chord, next_id: u32) -> ChangePlan {
        let chord = next.canonical();
        match &self.registered {
            Some(r) if r.chord == chord => ChangePlan::NoChange,
            Some(r) if r.id == next_id => ChangePlan::Respell { chord },
            other => ChangePlan::Register {
                chord,
                then_unregister: other.clone(),
            },
        }
    }

    /// The requested chord is registered with `id` (the old one, if any, released).
    pub fn changed(&mut self, chord: &str, id: u32) {
        self.chord = chord.to_string();
        self.registered = Some(Registered {
            chord: chord.to_string(),
            id,
        });
        self.error = None;
    }

    /// The OS refused the requested chord: the configured chord and its registration stay.
    pub fn refused(&mut self, chord: &str, reason: &str) {
        self.error = Some(format!("{chord} could not be registered: {reason}"));
    }

    /// Whether a press with this plugin id is ours.
    pub fn is_ours(&self, id: u32) -> bool {
        self.registered.as_ref().is_some_and(|r| r.id == id)
    }
}

/// The `PRESS_EVENT` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyEvent {
    pub chord: String,
    pub state: &'static str,
}

pub fn event_payload(chord: &str, pressed: bool) -> HotkeyEvent {
    HotkeyEvent {
        chord: chord.to_string(),
        state: if pressed { "pressed" } else { "released" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// The grammar cases shared with the UI (`apps/ui/test/hotkey-chords.json`).
    fn cases() -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/test/hotkey-chords.json");
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).expect("hotkey-chords.json")
    }

    #[test]
    fn the_default_chord_is_the_shared_one_and_parses_to_itself() {
        assert_eq!(cases()["default"], DEFAULT_CHORD);
        let chord = parse_chord(DEFAULT_CHORD).expect("default parses");
        assert_eq!(chord.canonical(), DEFAULT_CHORD);
        assert_eq!(
            chord.modifiers,
            vec![Modifier::CommandOrControl, Modifier::Shift]
        );
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
            let err = parse_chord(input)
                .err()
                .unwrap_or_else(|| panic!("{input:?} accepted"));
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
        assert!(
            parse_chord("Space")
                .unwrap_err()
                .to_string()
                .contains("needs a modifier")
        );
        assert!(
            parse_chord("Ctrl+Ctrl+A")
                .unwrap_err()
                .to_string()
                .contains("Ctrl")
        );
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
        assert_eq!(
            s.status().error.as_deref(),
            Some("HotKey already registered")
        );
        // A retry of the same chord registers again; nothing to unregister.
        let same = parse_chord(DEFAULT_CHORD).unwrap();
        assert_eq!(
            s.plan_change(&same, 7),
            ChangePlan::Register {
                chord: DEFAULT_CHORD.into(),
                then_unregister: None
            }
        );
        s.registered(7);
        assert!(s.is_ours(7));
        assert!(!s.is_ours(8));
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
        assert_eq!(s.plan_change(&same, 7), ChangePlan::NoChange);
        // Another chord: register it first, then let the old one go, so a chord the OS refuses
        // leaves the working one in place.
        let other = parse_chord("ctrl+alt+t").unwrap();
        assert_eq!(
            s.plan_change(&other, 9),
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
        assert!(!s.is_ours(7), "the old chord is no longer ours");
    }

    /// Typing "Ctrl+Shift+Space" while the default is active must not ask the plugin for a
    /// second registration of the hotkey it already holds (it refuses: already registered).
    #[test]
    fn another_spelling_of_the_held_hotkey_is_adopted_without_registering() {
        use tauri_plugin_global_shortcut::Shortcut;
        let id = |c: &str| Shortcut::from_str(c).expect(c).id();
        let mut s = HotkeyState::new(DEFAULT_CHORD);
        s.registered(id(DEFAULT_CHORD));
        let respelt = parse_chord("ctrl+shift+space").unwrap();
        let plan = s.plan_change(&respelt, id(&respelt.canonical()));
        if cfg!(target_os = "macos") {
            // CommandOrControl is Command there: a different hotkey.
            assert!(matches!(plan, ChangePlan::Register { .. }), "{plan:?}");
            return;
        }
        assert_eq!(
            plan,
            ChangePlan::Respell {
                chord: "Control+Shift+Space".into()
            }
        );
        s.changed("Control+Shift+Space", id("Control+Shift+Space"));
        assert!(
            s.is_ours(id(DEFAULT_CHORD)),
            "the same OS hotkey stays ours"
        );
        assert_eq!(s.status().chord, "Control+Shift+Space");
        assert!(s.status().registered);
        // And back: the default spelling is again the same hotkey.
        let default = parse_chord(DEFAULT_CHORD).unwrap();
        assert_eq!(
            s.plan_change(&default, id(DEFAULT_CHORD)),
            ChangePlan::Respell {
                chord: DEFAULT_CHORD.into()
            }
        );
    }

    #[test]
    fn a_refused_change_keeps_the_working_chord() {
        let mut s = HotkeyState::new(DEFAULT_CHORD);
        s.registered(3);
        s.refused("Control+Alt+Delete", "HotKey already registered");
        let status = s.status();
        assert_eq!(status.chord, DEFAULT_CHORD);
        assert!(status.registered);
        assert_eq!(
            status.error.as_deref(),
            Some("Control+Alt+Delete could not be registered: HotKey already registered")
        );
        assert!(s.is_ours(3));
        // With nothing registered (startup failed) a refused change still keeps the chord.
        let mut t = HotkeyState::new(DEFAULT_CHORD);
        t.failed("taken".into());
        t.refused("Alt+F4", "taken too");
        assert_eq!(t.chord, DEFAULT_CHORD);
        assert!(!t.status().registered);
    }

    #[test]
    fn the_startup_chord_falls_back_to_the_default_with_a_note() {
        assert_eq!(startup_chord(None), (DEFAULT_CHORD.to_string(), None));
        assert_eq!(
            startup_chord(Some("ctrl+alt+t")),
            ("Control+Alt+T".to_string(), None)
        );
        let (chord, note) = startup_chord(Some("Shift+A"));
        assert_eq!(chord, DEFAULT_CHORD);
        let note = note.expect("a note");
        assert!(note.contains("Shift+A"), "{note}");
        assert!(note.contains("needs a modifier"), "{note}");
        let mut s = HotkeyState::new(&chord);
        s.note(note.clone());
        s.registered(1);
        assert_eq!(
            s.status().error,
            None,
            "a successful registration clears the note"
        );
    }

    #[test]
    fn linux_without_a_display_is_reported_not_registered() {
        assert_eq!(linux_display_missing(Some(":0")), None);
        assert_eq!(linux_display_missing(Some(":1.0")), None);
        assert!(linux_display_missing(None).unwrap().contains("DISPLAY"));
        assert!(linux_display_missing(Some("")).is_some());
        assert!(linux_display_missing(Some("  ")).is_some());
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
