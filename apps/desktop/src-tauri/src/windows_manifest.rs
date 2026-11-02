//! The Windows application manifest every binary of the shell embeds (tests only). `build.rs`
//! embeds it, by the plan in `build_support/windows_manifest.rs`, which these tests hold on
//! every OS: a test binary without the manifest does not start on Windows (exit 0xc0000139,
//! STATUS_ENTRYPOINT_NOT_FOUND, Desktop app run 41465526965), which no Linux run can see.
//! `build.rs` itself fails the build when the file is no longer tauri-build's default. On
//! Windows the test binary also reads the manifest the linker embedded into it.

use std::collections::BTreeMap;
use std::path::Path;

#[path = "../build_support/windows_manifest.rs"]
mod plan;

fn package_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// The elements of an XML text in order, each with its attributes (no closing tags,
/// declarations or comments).
fn elements(xml: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find('<') {
        let tail = &rest[i + 1..];
        let end = tail.find('>').expect("every tag ends with >");
        let tag = tail[..end].trim_end_matches('/');
        rest = &tail[end + 1..];
        if tag.starts_with(['/', '?', '!']) {
            continue;
        }
        let name = tag.split_whitespace().next().unwrap_or("").to_string();
        let mut attrs = BTreeMap::new();
        let mut a = tag[name.len()..].trim();
        while !a.is_empty() {
            let (key, value) = a.split_once('=').expect("an attribute is key=\"value\"");
            let value = value.trim_start();
            let quote = value.chars().next().expect("a quoted value");
            let body = &value[quote.len_utf8()..];
            let close = body.find(quote).expect("the value's closing quote");
            attrs.insert(key.trim().to_string(), body[..close].to_string());
            a = body[close + quote.len_utf8()..].trim_start();
        }
        out.push((name, attrs));
    }
    out
}

fn attrs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// `xml` (`what`) asks for Common Controls 6.0.0.0 (comctl32.dll v6, which exports the
/// `TaskDialogIndirect` that tauri-plugin-dialog's rfd imports) and nothing else: no
/// `trustInfo`, DPI or long-path settings, which tauri-build's default does not have either.
fn assert_common_controls_6_only(xml: &str, what: &str) {
    let found = elements(xml);
    let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        [
            "assembly",
            "dependency",
            "dependentAssembly",
            "assemblyIdentity"
        ],
        "{what} declares one dependency and nothing else:\n{xml}"
    );
    assert_eq!(
        found[0].1,
        attrs(&[
            ("xmlns", "urn:schemas-microsoft-com:asm.v1"),
            ("manifestVersion", "1.0"),
        ]),
        "{what}:\n{xml}"
    );
    assert_eq!(
        found[3].1,
        attrs(&[
            ("type", "win32"),
            ("name", "Microsoft.Windows.Common-Controls"),
            ("version", "6.0.0.0"),
            ("processorArchitecture", "*"),
            ("publicKeyToken", "6595b64144ccf1df"),
            ("language", "*"),
        ]),
        "{what}: without Common Controls 6 a binary that links the dialog plugin does not start \
         on Windows"
    );
}

#[test]
fn the_manifest_asks_for_common_controls_6_and_nothing_else() {
    let xml = std::fs::read_to_string(package_dir().join(plan::FILE)).expect("the manifest");
    assert_common_controls_6_only(&xml, plan::FILE);
}

/// What the linker embedded into this test binary (resource 1 of type RT_MANIFEST, the one
/// Windows reads when it starts an executable) is that manifest. The app gets the same linker
/// arguments. Before, the library's test binary had no manifest at all. MSVC only, like the
/// plan.
#[cfg(all(windows, target_env = "msvc"))]
#[test]
fn this_test_binary_embeds_the_manifest() {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn FindResourceW(module: *mut c_void, name: *const u16, kind: *const u16) -> *mut c_void;
        fn SizeofResource(module: *mut c_void, info: *mut c_void) -> u32;
        fn LoadResource(module: *mut c_void, info: *mut c_void) -> *mut c_void;
        fn LockResource(data: *mut c_void) -> *const c_void;
    }
    const CREATEPROCESS_MANIFEST_RESOURCE_ID: usize = 1;
    const RT_MANIFEST: usize = 24;
    // SAFETY: a null name is this executable's module, which lives as long as the process; the
    // resource functions take integer ids as pointers (MAKEINTRESOURCEW); a found resource's
    // data stays mapped with the module and is `SizeofResource` bytes long.
    let embedded = unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        assert!(!module.is_null(), "GetModuleHandleW(NULL)");
        let info = FindResourceW(
            module,
            std::ptr::without_provenance(CREATEPROCESS_MANIFEST_RESOURCE_ID),
            std::ptr::without_provenance(RT_MANIFEST),
        );
        assert!(
            !info.is_null(),
            "this test binary has no application manifest (resource 1, RT_MANIFEST): \
             build.rs's link arguments did not reach it"
        );
        let size = SizeofResource(module, info) as usize;
        let data = LockResource(LoadResource(module, info)).cast::<u8>();
        assert!(
            !data.is_null() && size > 0,
            "the manifest resource is empty"
        );
        String::from_utf8_lossy(std::slice::from_raw_parts(data, size)).into_owned()
    };
    assert_common_controls_6_only(&embedded, "the manifest embedded in this test binary");
}

/// On the MSVC target the linker embeds the manifest into everything it links, the unit-test
/// binary included, and tauri-build embeds none (a second manifest resource in the app would
/// not link).
#[test]
fn every_binary_on_windows_msvc_embeds_the_manifest() {
    let manifest = package_dir().join(plan::FILE);
    let p = plan::plan("windows", "msvc", &manifest);
    assert!(!p.tauri_embeds, "tauri-build would embed a second manifest");
    for line in &p.instructions {
        assert!(
            line.starts_with("cargo:rustc-link-arg=/"),
            "{line}: only cargo:rustc-link-arg reaches the library's unit-test binary (the \
             -bins and -tests forms do not)"
        );
    }
    assert_eq!(
        p.instructions,
        [
            "cargo:rustc-link-arg=/MANIFEST:EMBED".to_string(),
            format!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display()),
            // No trustInfo section from the linker: the app's manifest stays tauri-build's.
            "cargo:rustc-link-arg=/MANIFESTUAC:NO".to_string(),
        ]
    );
}

/// Every other target keeps tauri-build's own handling (no manifest off Windows; the GNU
/// target's binaries get tauri-build's resource, its test binaries none).
#[test]
fn other_targets_keep_tauri_builds_own_manifest() {
    let manifest = package_dir().join(plan::FILE);
    for (os, env) in [
        ("linux", "gnu"),
        ("macos", ""),
        ("android", ""),
        ("windows", "gnu"),
    ] {
        let p = plan::plan(os, env, &manifest);
        assert!(p.tauri_embeds, "{os}/{env}");
        assert!(
            p.instructions.is_empty(),
            "{os}/{env}: {:?}",
            p.instructions
        );
    }
}

/// `build.rs` applies the plan for the target cargo builds (not the host's `cfg(windows)`,
/// which a cross build from Linux would get wrong), and checks the file against tauri-build's
/// default on every target.
#[test]
fn build_rs_applies_the_plan_for_the_target() {
    let build =
        std::fs::read_to_string(package_dir().join("build.rs")).expect("build.rs is readable");
    for needed in [
        "#[path = \"build_support/windows_manifest.rs\"]",
        "std::env::var(\"CARGO_CFG_TARGET_OS\")",
        "std::env::var(\"CARGO_CFG_TARGET_ENV\")",
        "windows_manifest::plan(&target_os, &target_env, &manifest)",
        "for line in &plan.instructions",
        "tauri_build::WindowsAttributes::new_without_app_manifest()",
        ".windows_attributes(windows)",
        "format!(\"{:?}\", tauri_build::WindowsAttributes::new())",
    ] {
        assert!(build.contains(needed), "build.rs no longer has {needed}");
    }
    assert!(
        !build.contains("cfg(windows)") && !build.contains("cfg!(windows)"),
        "build.rs decides by the host's OS"
    );
}

#[test]
fn elements_are_read_with_their_attributes() {
    let xml = "<?xml version=\"1.0\"?>\n<!-- c --><a x=\"1\"\n  y='two words'><b/></a>";
    assert_eq!(
        elements(xml),
        [
            ("a".to_string(), attrs(&[("x", "1"), ("y", "two words")])),
            ("b".to_string(), BTreeMap::new()),
        ]
    );
}
