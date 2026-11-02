//! Open a project's folder in the system's file manager (design §3.4 "Your files", §3.10).
//!
//! The UI's **Open folder** calls `invoke("open_folder", { path })` with the folder the daemon
//! names on the project card. The command opens only an absolute path to an existing folder:
//! a file, a relative path or a missing one is refused, so the webview can ask the file manager
//! to show a folder and never to run or open a file.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// The folder `open_folder` may open, or why not, in words the UI shows.
pub fn folder_to_open(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if path.trim().is_empty() || !p.is_absolute() {
        return Err("that is not a full path to a folder".to_string());
    }
    match std::fs::metadata(p) {
        Ok(meta) if meta.is_dir() => Ok(p.to_path_buf()),
        Ok(_) => Err("that is a file, not a folder".to_string()),
        Err(_) => Err("that folder does not exist (yet)".to_string()),
    }
}

/// `invoke("open_folder", { path })`: the folder in the system's file manager.
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    let folder = folder_to_open(&path)?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            log::warn!("could not open folder {}: {e}", folder.display());
            "the file manager did not open it".to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fr-folder-test-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the test folder");
        dir
    }

    #[test]
    fn opens_an_existing_folder_with_spaces_and_non_ascii_letters() {
        let dir = temp("ok").join("Projekt Zürich");
        std::fs::create_dir_all(&dir).expect("create");
        assert_eq!(folder_to_open(dir.to_str().expect("utf8")), Ok(dir.clone()));
        let _ = std::fs::remove_dir_all(dir.parent().expect("parent"));
    }

    #[test]
    fn refuses_a_file_a_relative_path_an_empty_one_and_a_missing_folder() {
        let dir = temp("refuse");
        let file = dir.join("index.html");
        std::fs::write(&file, "<h1>x</h1>").expect("write");
        assert_eq!(
            folder_to_open(file.to_str().expect("utf8")),
            Err("that is a file, not a folder".to_string())
        );
        assert!(folder_to_open("workspace").is_err());
        assert!(folder_to_open("").is_err());
        assert_eq!(
            folder_to_open(dir.join("gone").to_str().expect("utf8")),
            Err("that folder does not exist (yet)".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
