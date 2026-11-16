//! The tray icon and its menu (spec K.8, S.8, S.28, S.32, M; ADR 0026, ADR 0031, ADR 0067):
//! what runs now (d1109-run-visible: the first item, the tooltip's first line, the window title
//! and the icon's dot), Open, the desktop-control state and "Stop desktop control", Stop all
//! sessions and Allow sessions again,
//! Pause/Resume email, Update and restart, Quit. Items are enabled from `state::tray_view`,
//! never optimistically; the icon's title and tooltip name desktop control while it is
//! active; Quit stops the daemon and everything it started, then ends the shell (U-018,
//! ADR 0094).

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::actions::{self, shared};
use crate::state::{icon_dot, lock, tray_view, window_title};
use crate::windows;

pub const TRAY_ID: &str = "forerunner";

const OPEN: &str = "open";
const DESKTOP: &str = "desktop";
const DESKTOP_STOP: &str = "desktop_stop";
const RUNNING: &str = "running";
const KILL: &str = "kill";
const RESUME: &str = "resume";
const EMAIL: &str = "email";
const UPDATE: &str = "update";
const QUIT: &str = "quit";

pub struct TrayHandles {
    tray: tauri::tray::TrayIcon<Wry>,
    running: MenuItem<Wry>,
    /// The app's icon as installed, and with the running dot (V-8), drawn once.
    icon: Option<Image<'static>>,
    icon_dot: Option<Image<'static>>,
    desktop: MenuItem<Wry>,
    desktop_stop: MenuItem<Wry>,
    kill: MenuItem<Wry>,
    resume: MenuItem<Wry>,
    email: MenuItem<Wry>,
    update: MenuItem<Wry>,
}

pub type SharedTray = Mutex<Option<TrayHandles>>;

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // d1109-run-visible (V-7): what runs now, the first item, never clickable.
    let running = MenuItem::with_id(app, RUNNING, "No session runs", false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN, "Open Forerunner", true, None::<&str>)?;
    let desktop = MenuItem::with_id(app, DESKTOP, "Desktop control: off", false, None::<&str>)?;
    let desktop_stop = MenuItem::with_id(
        app,
        DESKTOP_STOP,
        "Stop desktop control (not active)",
        false,
        None::<&str>,
    )?;
    let kill = MenuItem::with_id(app, KILL, "Stop all sessions", false, None::<&str>)?;
    let resume = MenuItem::with_id(app, RESUME, "Allow sessions again", false, None::<&str>)?;
    let email = MenuItem::with_id(app, EMAIL, "Pause email", false, None::<&str>)?;
    let update = MenuItem::with_id(app, UPDATE, "Updates…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit Forerunner", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &running,
            &PredefinedMenuItem::separator(app)?,
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
    let icon = app.default_window_icon().cloned().map(|i| i.to_owned());
    if let Some(icon) = icon.clone() {
        builder = builder.icon(icon);
    }
    let icon_dot = icon.as_ref().map(|i| {
        Image::new_owned(
            with_running_dot(i.rgba(), i.width(), i.height()),
            i.width(),
            i.height(),
        )
    });
    let tray = builder.build(app)?;
    app.manage::<SharedTray>(Mutex::new(Some(TrayHandles {
        tray,
        running,
        icon,
        icon_dot,
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
    // d1109-run-visible (V-7, V-8): the main window's title and the icon's dot say a session runs.
    let (title, dot) = {
        let state = shared(app);
        let s = lock(&state);
        (window_title(&s.status), icon_dot(&s.status))
    };
    windows::set_main_title(app, &title);
    let icon = if dot {
        h.icon_dot.clone()
    } else {
        h.icon.clone()
    };
    if let Some(icon) = icon
        && let Err(e) = h.tray.set_icon(Some(icon))
    {
        log::warn!("tray icon update failed: {e}");
    }
    let results = [
        h.running.set_text(&view.running_text),
        h.running.set_enabled(false),
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

/// The running dot's colour (the app's blue, `bg-blue-600`) and its white ring.
const DOT: [u8; 4] = [37, 99, 235, 255];
const RING: [u8; 4] = [255, 255, 255, 255];

/// d1109-run-visible (V-8): the app's icon with a blue dot at its lower right, drawn over the
/// icon's own pixels (no new asset): the one signal visible without hovering, on Windows and
/// Linux. `rgba` is width*height*4 bytes; anything else comes back unchanged.
pub fn with_running_dot(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let (w, h) = (width as i64, height as i64);
    if out.len() as i64 != w * h * 4 || w < 4 || h < 4 {
        return out;
    }
    let r = (w.min(h) as f64) * 0.22;
    let ring = r + (w.min(h) as f64 * 0.06).max(1.0);
    let (cx, cy) = (w as f64 - ring - 0.5, h as f64 - ring - 0.5);
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f64 + 0.5 - cx - 0.5, y as f64 + 0.5 - cy - 0.5);
            let d = (dx * dx + dy * dy).sqrt();
            let px = if d <= r {
                DOT
            } else if d <= ring {
                RING
            } else {
                continue;
            };
            let i = ((y * w + x) * 4) as usize;
            out[i..i + 4].copy_from_slice(&px);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// V-8: the drawn icon has the dot while a session runs, and is the app's icon otherwise
    /// (the caller picks between the two; only the dot's pixels change).
    #[test]
    fn the_running_dot_is_drawn_at_the_lower_right_over_the_icon() {
        let (w, h) = (32u32, 32u32);
        let icon: Vec<u8> = (0..w * h).flat_map(|_| [10u8, 20, 30, 255]).collect();
        let dotted = with_running_dot(&icon, w, h);
        assert_eq!(dotted.len(), icon.len());
        let px = |buf: &[u8], x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
        };
        // The dot's centre is the app's blue; the far corner and the middle are the icon's own.
        assert_eq!(px(&dotted, 24, 24), DOT);
        assert_eq!(px(&dotted, 1, 1), [10, 20, 30, 255]);
        assert_eq!(px(&dotted, 12, 12), [10, 20, 30, 255]);
        // Only the dot and its ring changed.
        let changed = (0..w * h)
            .filter(|i| {
                dotted[(*i * 4) as usize..(*i * 4 + 4) as usize]
                    != icon[(*i * 4) as usize..(*i * 4 + 4) as usize]
            })
            .count();
        assert!(
            changed > 20 && changed < (w * h / 3) as usize,
            "{changed} pixels changed"
        );
        // A buffer that is not width*height*4 comes back as it was.
        assert_eq!(with_running_dot(&[1, 2, 3], 2, 2), vec![1, 2, 3]);
    }
}
