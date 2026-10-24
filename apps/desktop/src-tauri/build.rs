fn main() {
    // The app's own commands (the global hotkey, ADR 0064) are listed so each needs an explicit
    // permission in `capabilities/`: only the main window gets them.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["hotkey_status", "hotkey_set"]),
        ),
    )
    .expect("failed to run tauri-build");
}
