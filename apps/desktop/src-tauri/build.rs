fn main() {
    // The installers carry the runtime under `runtime/` (tauri.conf.json resources, ADR 0092),
    // built by `scripts/build-runtime-payload.mjs` before `tauri build`. A development build
    // (`tauri dev`, `cargo test`, clippy) has none: an empty directory keeps the resource
    // entry valid, and the shell then finds the checkout through the install record.
    let runtime = std::path::Path::new("runtime");
    if !runtime.join("runtime.json").exists() {
        std::fs::create_dir_all(runtime).expect("create runtime/");
        let note = runtime.join("NOT-BUNDLED.txt");
        if !note.exists() {
            std::fs::write(
                &note,
                "This build carries no runtime. Run `pnpm runtime:payload` before `tauri build`.\n",
            )
            .expect("write runtime/NOT-BUNDLED.txt");
        }
    }
    println!("cargo:rerun-if-changed=runtime/runtime.json");
    // The app's own commands (the global hotkey, ADR 0064) are listed so each needs an explicit
    // permission in `capabilities/`: only the main window gets them.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["hotkey_status", "hotkey_set"]),
        ),
    )
    .expect("failed to run tauri-build");
}
