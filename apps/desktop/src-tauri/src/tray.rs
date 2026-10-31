//! The tray icon and its menu (spec K.8, S.8, S.28, S.32, M; ADR 0026, ADR 0031, ADR 0067):
//! Open, the desktop-control state and "Stop desktop control", the kill switch and Resume,
//! Pause/Resume email, Update and restart, Quit. Items are enabled from `state::tray_view`,
//! never optimistically; the icon's title and tooltip name desktop control while it is
//! active; Quit stops the daemon and everything it started, then ends the shell (U-018,
//! ADR 0094).

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::actions::{self, shared};
use crate::state::{lock, tray_view};
use crate::windows;

pub const TRAY_ID: &str = "forerunner";

const OPEN: &str = "open";
const DESKTOP: &str = "desktop";
const DESKTOP_STOP: &str = "desktop_stop";
const KILL: &str = "kill";
const RESUME: &str = "resume";
const EMAIL: &str = "email";
const UPDATE: &str = "update";
const QUIT: &str = "quit";

pub struct TrayHandles {
    tray: tauri::tray::TrayIcon<Wry>,
    desktop: MenuItem<Wry>,
    desktop_stop: MenuItem<Wry>,
    kill: MenuItem<Wry>,
    resume: MenuItem<Wry>,
    email: MenuItem<Wry>,
    update: MenuItem<Wry>,
}

pub type SharedTray = Mutex<Option<TrayHandles>>;

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN, "Open Forerunner", true, None::<&str>)?;
    let desktop = MenuItem::with_id(app, DESKTOP, "Desktop control: off", false, None::<&str>)?;
    let desktop_stop = MenuItem::with_id(
        app,
        DESKTOP_STOP,
        "Stop desktop control (not active)",
        false,
        None::<&str>,
    )?;
    let kill = MenuItem::with_id(
        app,
        KILL,
        "Kill switch: stop everything",
        false,
        None::<&str>,
    )?;
    let resume = MenuItem::with_id(app, RESUME, "Resume", false, None::<&str>)?;
    let email = MenuItem::with_id(app, EMAIL, "Pause email", false, None::<&str>)?;
    let update = MenuItem::with_id(app, UPDATE, "Updates…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit Forerunner", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &desktop,
            &desktop_stop,
            &PredefinedMenuItem::separator(app)?,
            &kill,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &email,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Forerunner")
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                windows::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    app.manage::<SharedTray>(Mutex::new(Some(TrayHandles {
        tray,
        desktop,
        desktop_stop,
        kill,
        resume,
        email,
        update,
    })));
    refresh(app);
    Ok(())
}

/// Re-derive every item from the state. Safe to call from any thread.
pub fn refresh(app: &AppHandle) {
    let view = tray_view(&lock(&shared(app)));
    let Some(handles) = app.try_state::<SharedTray>() else {
        return;
    };
    let guard = handles.lock().unwrap_or_else(|p| p.into_inner());
    let Some(h) = guard.as_ref() else {
        return;
    };
    let results = [
        h.tray.set_tooltip(Some(view.tooltip.as_str())),
        h.tray.set_title(view.title.as_deref()),
        h.desktop.set_text(&view.desktop_text),
        h.desktop.set_enabled(view.desktop_enabled),
        h.desktop_stop.set_text(&view.desktop_stop_text),
        h.desktop_stop.set_enabled(view.desktop_stop_enabled),
        h.kill.set_text(&view.kill_text),
        h.kill.set_enabled(view.kill_enabled),
        h.resume.set_text(&view.resume_text),
        h.resume.set_enabled(view.resume_enabled),
        h.email.set_text(&view.email_text),
        h.email.set_enabled(view.email_enabled),
        h.update.set_text(&view.update_text),
        h.update.set_enabled(view.update_enabled),
    ];
    for r in results {
        if let Err(e) = r {
            log::warn!("tray update failed: {e}");
        }
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        OPEN => windows::show_main(app),
        // The status item opens the window, where the banner names the app and the session.
        DESKTOP => windows::show_main(app),
        DESKTOP_STOP => {
            tauri::async_runtime::spawn(actions::desktop_stop(app.clone()));
        }
        KILL => actions::kill_switch(app.clone()),
        RESUME => {
            tauri::async_runtime::spawn(actions::resume(app.clone()));
        }
        EMAIL => {
            let action = tray_view(&lock(&shared(app))).email_action;
            if let Some(action) = action {
                tauri::async_runtime::spawn(actions::email_toggle(app.clone(), action));
            }
        }
        UPDATE => windows::show_route(app, "/updates"),
        QUIT => actions::quit(app.clone()),
        other => log::warn!("unknown tray item {other}"),
    }
}
