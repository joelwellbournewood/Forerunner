//! Window size and position, remembered per install in `<config>/window-state.json` (a small
//! JSON of our own rather than tauri-plugin-window-state, whose file lives in Tauri's own app
//! directory and would be shared by two installs with different `FORERUNNER_HOME`s). The saved
//! position is applied only when it still lands on a connected monitor.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE: &str = "window-state.json";
/// The UI's minimum, as `tauri.conf.json` had it; a saved size below it is lifted.
pub const MIN_WIDTH: u32 = 900;
pub const MIN_HEIGHT: u32 = 600;
pub const DEFAULT_WIDTH: u32 = 1200;
pub const DEFAULT_HEIGHT: u32 = 800;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's physical rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn contains(&self, px: i64, py: i64) -> bool {
        px >= i64::from(self.x)
            && py >= i64::from(self.y)
            && px < i64::from(self.x) + i64::from(self.width)
            && py < i64::from(self.y) + i64::from(self.height)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// `None` when the saved position is off every monitor: let the OS place the window.
    pub position: Option<(i32, i32)>,
    pub size: (u32, u32),
    pub maximized: bool,
}

pub fn load(path: &Path) -> Option<WindowState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(path: &Path, state: &WindowState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    std::fs::write(path, format!("{text}\n"))
}

/// How to place the window given what was saved and the monitors connected now. With no
/// monitor information the position is trusted.
pub fn placement(state: &WindowState, monitors: &[Rect]) -> Placement {
    let size = (state.width.max(MIN_WIDTH), state.height.max(MIN_HEIGHT));
    // A point inside the title bar must be visible, or the window could not be grabbed.
    let (px, py) = (i64::from(state.x) + 100, i64::from(state.y) + 10);
    let on_screen = monitors.is_empty() || monitors.iter().any(|m| m.contains(px, py));
    Placement {
        position: on_screen.then_some((state.x, state.y)),
        size,
        maximized: state.maximized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(x: i32, y: i32) -> WindowState {
        WindowState {
            x,
            y,
            width: 1000,
            height: 700,
            maximized: false,
        }
    }

    #[test]
    fn position_is_kept_only_on_a_connected_monitor() {
        let monitors = [
            Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            Rect {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
        ];
        assert_eq!(
            placement(&state(100, 50), &monitors).position,
            Some((100, 50))
        );
        assert_eq!(
            placement(&state(2000, 50), &monitors).position,
            Some((2000, 50))
        );
        assert_eq!(placement(&state(4000, 50), &monitors).position, None);
        assert_eq!(placement(&state(-2000, 50), &monitors).position, None);
        assert_eq!(placement(&state(100, 1200), &monitors).position, None);
        assert_eq!(placement(&state(4000, 50), &[]).position, Some((4000, 50)));
    }

    #[test]
    fn size_is_lifted_to_the_minimum_and_maximized_survives() {
        let s = WindowState {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            maximized: true,
        };
        let p = placement(&s, &[]);
        assert_eq!(p.size, (MIN_WIDTH, MIN_HEIGHT));
        assert!(p.maximized);
    }

    #[test]
    fn round_trips_through_the_file_and_ignores_garbage() {
        let dir = std::env::temp_dir().join(format!("fr-window-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE);
        assert_eq!(load(&path), None);
        let s = state(10, 20);
        save(&path, &s).expect("save");
        assert_eq!(load(&path), Some(s));
        std::fs::write(&path, "{broken").expect("write");
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
