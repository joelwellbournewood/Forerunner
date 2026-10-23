//! The global hotkey wired to Tauri (spec O.1, ADR 0064): tauri-plugin-global-shortcut with
//! one handler, the registration at start from `<config>/hotkey.json`, the `hotkey_status` and
//! `hotkey_set` commands the UI's Settings calls, and the press handler that shows and focuses
//! the main window and emits `forerunner://hotkey` to it. The decisions (grammar, state,
//! payloads) live in `hotkey.rs`; nothing here can crash the shell: every failure is logged,
//! kept in the state and reported to the UI.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::hotkey::{
    CHANGED_EVENT, ChangePlan, FILE, HotkeyState, HotkeyStatus, PRESS_EVENT, event_payload,
    parse_chord, startup_chord,
};
use crate::windows;

/// The managed state: the machine plus where the preference is saved.
pub struct HotkeyHolder {
    pub state: Mutex<HotkeyState>,
    pub file: PathBuf,
}

fn holder(app: &AppHandle) -> Option<tauri::State<'_, HotkeyHolder>> {
    app.try_state::<HotkeyHolder>()
}

fn lock(m: &Mutex<HotkeyState>) -> MutexGuard<'_, HotkeyState> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The plugin with the shell's one handler: a press of our chord brings up the conversation.
/// Releases are ignored (ADR 0064: a press toggles the voice turn).
pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                on_press(app, shortcut.id());
            }
        })
        .build()
}

fn on_press(app: &AppHandle, id: u32) {
    let Some(h) = holder(app) else {
        return;
    };
    let chord = {
        let s = lock(&h.state);
        if !s.is_ours(id) {
            return;
        }
        s.chord.clone()
    };
    log::info!("global hotkey {chord} pressed");
    windows::show_main(app);
    // Without a main window (not attached yet) show_main starts the attach; the press is not
    // queued: the window opens and the human presses again or clicks.
    if app.get_webview_window(windows::MAIN).is_some()
        && let Err(e) = app.emit_to(windows::MAIN, PRESS_EVENT, event_payload(&chord, true))
    {
        log::warn!("hotkey event not delivered: {e}");
    }
}

fn notify_changed(app: &AppHandle, status: &HotkeyStatus) {
    if app.get_webview_window(windows::MAIN).is_some()
        && let Err(e) = app.emit_to(windows::MAIN, CHANGED_EVENT, status.clone())
    {
        log::warn!("hotkey status not delivered: {e}");
    }
}

fn register(app: &AppHandle, chord: &str) -> Result<u32, String> {
    #[cfg(target_os = "linux")]
    if let Some(reason) =
        crate::hotkey::linux_display_missing(std::env::var("DISPLAY").ok().as_deref())
    {
        return Err(reason);
    }
    let shortcut = Shortcut::from_str(chord).map_err(|e| e.to_string())?;
    app.global_shortcut()
        .register(shortcut)
        .map(|()| shortcut.id())
        .map_err(|e| e.to_string())
}

/// At start (from `setup`): register the saved chord or the default. A refusal is logged and
/// kept for Settings; the shell carries on without a hotkey.
pub fn install(app: &AppHandle, config_dir: &Path) {
    let file = config_dir.join(FILE);
    let (chord, note) = startup_chord(crate::hotkey::load(&file).as_deref());
    let mut state = HotkeyState::new(&chord);
    if let Some(note) = note {
        log::warn!("{note}");
        state.note(note);
    }
    match register(app, &chord) {
        Ok(id) => {
            log::info!("global hotkey {chord} registered");
            state.registered(id);
        }
        Err(e) => {
            log::warn!("global hotkey {chord} not registered: {e}");
            state.failed(e);
        }
    }
    let status = state.status();
    app.manage(HotkeyHolder {
        state: Mutex::new(state),
        file,
    });
    if !status.registered {
        notify_changed(app, &status);
    }
}

/// `invoke("hotkey_status")`: the chord, the default, whether the OS holds it, the last error.
#[tauri::command]
pub fn hotkey_status(app: AppHandle) -> Result<HotkeyStatus, String> {
    let h = holder(&app).ok_or_else(|| "the hotkey is not set up".to_string())?;
    Ok(lock(&h.state).status())
}

/// `invoke("hotkey_set", { chord })`: validate with the shared grammar, register the new chord,
/// release the old one, save the preference. A chord the grammar refuses or the OS refuses is
/// an error string; the working chord stays registered.
#[tauri::command]
pub fn hotkey_set(app: AppHandle, chord: String) -> Result<HotkeyStatus, String> {
    let h = holder(&app).ok_or_else(|| "the hotkey is not set up".to_string())?;
    let parsed = parse_chord(&chord).map_err(|e| {
        log::info!("hotkey chord refused ({}): {e}", e.kind());
        e.to_string()
    })?;
    let next_id = Shortcut::from_str(&parsed.canonical())
        .map(|s| s.id())
        .map_err(|e| e.to_string())?;
    let plan = lock(&h.state).plan_change(&parsed, next_id);
    let (canonical, then_unregister) = match plan {
        ChangePlan::NoChange => return Ok(lock(&h.state).status()),
        ChangePlan::Respell { chord } => {
            // The OS already holds this hotkey for us: adopt the spelling, keep the registration.
            let status = {
                let mut s = lock(&h.state);
                s.changed(&chord, next_id);
                if let Err(e) = crate::hotkey::save(&h.file, &chord) {
                    s.note(format!("{chord} is active but not saved: {e}"));
                }
                s.status()
            };
            log::info!("global hotkey respelt as {chord}");
            notify_changed(&app, &status);
            return Ok(status);
        }
        ChangePlan::Register {
            chord,
            then_unregister,
        } => (chord, then_unregister),
    };
    match register(&app, &canonical) {
        Ok(id) => {
            if let Some(old) = then_unregister
                && let Ok(old_shortcut) = Shortcut::from_str(&old.chord)
                && let Err(e) = app.global_shortcut().unregister(old_shortcut)
            {
                log::warn!("old hotkey {} not released: {e}", old.chord);
            }
            let status = {
                let mut s = lock(&h.state);
                s.changed(&canonical, id);
                if let Err(e) = crate::hotkey::save(&h.file, &canonical) {
                    s.note(format!("{canonical} is active but not saved: {e}"));
                }
                s.status()
            };
            log::info!("global hotkey changed to {canonical}");
            notify_changed(&app, &status);
            Ok(status)
        }
        Err(e) => {
            log::warn!("global hotkey {canonical} refused: {e}");
            let status = {
                let mut s = lock(&h.state);
                s.refused(&canonical, &e);
                s.status()
            };
            notify_changed(&app, &status);
            Err(status.error.unwrap_or(e))
        }
    }
}
