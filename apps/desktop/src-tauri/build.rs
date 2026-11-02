#[path = "build_support/windows_manifest.rs"]
mod windows_manifest;

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

    // The Windows application manifest goes into every binary on the MSVC target, the test
    // binaries too (build_support/windows_manifest.rs says why). It must stay tauri-build's
    // default: checked here on every OS and target, so a change shows on Linux as well.
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"),
    );
    let manifest = manifest_dir.join(windows_manifest::FILE);
    println!("cargo:rerun-if-changed={}", windows_manifest::FILE);
    let ours = std::fs::read_to_string(&manifest)
        .expect("read windows-app-manifest.xml")
        .replace("\r\n", "\n");
    // tauri-build keeps its default private; its Debug output shows it, so two attribute
    // sets that print the same carry the same manifest.
    let tauri_default = format!("{:?}", tauri_build::WindowsAttributes::new());
    let with_ours = format!(
        "{:?}",
        tauri_build::WindowsAttributes::new_without_app_manifest().app_manifest(&ours)
    );
    assert_eq!(
        with_ours,
        tauri_default,
        "{} is not tauri-build's default app manifest (tauri-build's src/windows-app-manifest.xml): \
         copy that file over it, so the app's manifest stays what tauri-build embeds, and check \
         that it still declares Microsoft.Windows.Common-Controls 6.0.0.0",
        windows_manifest::FILE
    );
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let plan = windows_manifest::plan(&target_os, &target_env, &manifest);
    for line in &plan.instructions {
        println!("{line}");
    }
    let windows = if plan.tauri_embeds {
        tauri_build::WindowsAttributes::new()
    } else {
        tauri_build::WindowsAttributes::new_without_app_manifest()
    };

    // The app's own commands (the global hotkey, ADR 0064) are listed so each needs an explicit
    // permission in `capabilities/`: only the main window gets them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(windows)
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "hotkey_status",
                "hotkey_set",
                "open_folder",
            ])),
    )
    .expect("failed to run tauri-build");
}
