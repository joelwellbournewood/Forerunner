//! Which binaries get the Windows application manifest, and how. Shared by `build.rs`, which
//! applies it, and the shell's tests (`src/windows_manifest.rs`), which hold it on every OS.
//!
//! tauri-build embeds its default manifest (one dependency, Common Controls 6.0.0.0) in a
//! resource that it links into the package's binaries only (`cargo:rustc-link-arg-bins`).
//! Test binaries run without it, and Windows then loads comctl32.dll 5.82, which does not
//! export `TaskDialogIndirect`. tauri-plugin-dialog 2.8.0 always builds rfd with its
//! `common-controls-v6` feature, whose message dialog imports that function; the unit-test
//! binary links the dialog plugin's commands since `webview_acl.rs` builds every plugin
//! `run()` registers. So the test binary did not start on Windows (exit 0xc0000139,
//! STATUS_ENTRYPOINT_NOT_FOUND; Desktop app run 41465526965). On the MSVC target tauri-build
//! therefore embeds no manifest, and the linker embeds `FILE`, a copy of tauri-build's
//! default, into everything it links: the app, the unit-test binary and the cdylib.

use std::path::Path;

/// The manifest, next to `Cargo.toml`: tauri-build's default app manifest, byte for byte
/// (`build.rs` fails the build when they differ).
pub const FILE: &str = "windows-app-manifest.xml";

/// What `build.rs` does for one target.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// tauri-build embeds its own manifest (into the binaries only).
    pub tauri_embeds: bool,
    /// The `cargo:` lines `build.rs` prints.
    pub instructions: Vec<String>,
}

/// The plan for a target, from the `CARGO_CFG_TARGET_OS` and `CARGO_CFG_TARGET_ENV` cargo
/// gives the build script (a build script's own `cfg(windows)` is the host's).
/// `cargo:rustc-link-arg` reaches every target the package links: the `-bins` and `-tests`
/// forms do not reach the library's unit-test binary. `/MANIFESTUAC:NO` keeps the linker
/// from adding a `trustInfo` section, so the app's manifest stays what tauri-build embedded.
/// The GNU target keeps tauri-build's own manifest (its test binaries go without; Forerunner
/// builds Windows with MSVC only).
pub fn plan(target_os: &str, target_env: &str, manifest: &Path) -> Plan {
    if target_os != "windows" || target_env != "msvc" {
        return Plan {
            tauri_embeds: true,
            instructions: Vec::new(),
        };
    }
    Plan {
        tauri_embeds: false,
        instructions: vec![
            "cargo:rustc-link-arg=/MANIFEST:EMBED".to_string(),
            format!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display()),
            "cargo:rustc-link-arg=/MANIFESTUAC:NO".to_string(),
        ],
    }
}
