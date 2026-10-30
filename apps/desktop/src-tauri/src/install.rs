//! Where the install's `fr` entry is (ADR 0026, ADR 0092): a staged update that is newer than
//! the bundled runtime, `FORERUNNER_INSTALL_DIR`, the runtime the installer carries
//! (`<resources>/runtime/`, built by `scripts/build-runtime-payload.mjs`), then the install
//! record `fr setup` writes under `<config>/install.json` (a source checkout), then `fr` on
//! `PATH`. The result is an argv array; the shell never builds a shell string. An install
//! directory is run as
//! `node <dir>/node_modules/tsx/dist/cli.mjs <dir>/packages/runtime/src/cli/main.ts <args>`,
//! the same thing `pnpm fr` does, without `pnpm` or a `.cmd` shim in between; the bundled
//! runtime uses its own `node/node[.exe]`.

#[cfg(test)]
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::dirs::Platform;
use crate::env::Env;
use crate::version;

pub const INSTALL_RECORD_FILE: &str = "install.json";
/// The runtime's directory under the app's resource directory (`tauri.conf.json` resources).
pub const BUNDLED_RUNTIME_DIR: &str = "runtime";
/// `{ "schema": 1, "version": "...", ... }`, written last by the payload builder.
pub const BUNDLED_MANIFEST_FILE: &str = "runtime.json";

/// The runtime the installer carries (ADR 0092).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledRuntime {
    pub dir: PathBuf,
    pub version: String,
}

/// The version `runtime.json` names.
pub fn parse_bundled_manifest(text: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("runtime.json: {e}"))?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("runtime.json: schema is not 1".into());
    }
    v.get("version")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "runtime.json: version missing".to_string())
}

/// The runtime under `<resource_dir>/runtime/`, when the build carries one. A development
/// build (`tauri dev`, `cargo test`) has none and finds the checkout through the install record.
pub fn bundled_runtime(resource_dir: &Path) -> Option<BundledRuntime> {
    let dir = without_verbatim_prefix(resource_dir).join(BUNDLED_RUNTIME_DIR);
    let text = std::fs::read_to_string(dir.join(BUNDLED_MANIFEST_FILE)).ok()?;
    match parse_bundled_manifest(&text) {
        Ok(version) => Some(BundledRuntime { dir, version }),
        Err(e) => {
            log::warn!("bundled runtime ignored: {e}");
            None
        }
    }
}

/// The plain form of a Windows extended-length ("verbatim") path: `\\?\D:\x` is `D:\x` and
/// `\\?\UNC\server\share\x` is `\\server\share\x`; anything else is returned as it is. Tauri's
/// `resource_dir()` is canonicalized on Windows and comes back verbatim, and Node cannot run a
/// script named that way: 1.0.1's installed daemon died at once with "EISDIR: illegal
/// operation on a directory, lstat 'D:'" from `realpathSync` on its own entry file.
pub fn without_verbatim_prefix(p: &Path) -> PathBuf {
    // Only a path that is valid Unicode is rewritten: a lossy conversion would change the name.
    let Some(s) = p.to_str() else {
        return p.to_path_buf();
    };
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

pub fn bundled_node(dir: &Path, platform: Platform) -> PathBuf {
    dir.join("node").join(if platform == Platform::Windows {
        "node.exe"
    } else {
        "node"
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRecord {
    pub install_dir: PathBuf,
    /// Node binary to use; `node` on PATH when absent.
    pub node: Option<PathBuf>,
}

/// `{ "schema": 1, "installDir": "...", "node"?: "..." }`.
pub fn parse_install_record(text: &str) -> Result<InstallRecord, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("install.json: {e}"))?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("install.json: schema is not 1".into());
    }
    let install_dir = v
        .get("installDir")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "install.json: installDir missing".to_string())?;
    let node = v
        .get("node")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    Ok(InstallRecord { install_dir, node })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrSource {
    /// `<data>/versions/<current.json current>/` (ADR 0015).
    StagedVersion,
    InstallDirEnv,
    /// `<resources>/runtime/` (ADR 0092).
    Bundled,
    InstallRecord,
    PathLookup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrCommand {
    pub program: PathBuf,
    /// Arguments before the `fr` subcommand (the tsx entry and the CLI file for an install dir).
    pub args: Vec<PathBuf>,
    pub cwd: Option<PathBuf>,
    /// Extra environment for the process (the bundled runtime names its tsconfig, whose
    /// `paths` resolve the workspace packages).
    pub env: Vec<(String, PathBuf)>,
    pub source: FrSource,
}

impl FrCommand {
    /// One readable line for logs and dialogs (no secrets are involved).
    pub fn describe(&self) -> String {
        let mut parts = vec![self.program.to_string_lossy().into_owned()];
        parts.extend(self.args.iter().map(|a| a.to_string_lossy().into_owned()));
        format!("{} ({:?})", parts.join(" "), self.source)
    }
}

/// File-existence checks behind a trait so discovery is testable with a fixture set.
pub trait Fs {
    fn is_file(&self, p: &Path) -> bool;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RealFs;

impl Fs for RealFs {
    fn is_file(&self, p: &Path) -> bool {
        p.is_file()
    }
}

#[cfg(test)]
#[derive(Debug, Default, Clone)]
pub struct FakeFs(pub HashSet<PathBuf>);

#[cfg(test)]
impl Fs for FakeFs {
    fn is_file(&self, p: &Path) -> bool {
        self.0.contains(p)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocateError {
    pub tried: Vec<String>,
}

impl std::fmt::Display for LocateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "no Forerunner runtime found (tried: {}). Reinstall Forerunner from the release page; from a source checkout, run the fresh install (scripts/fresh-install) or set FORERUNNER_INSTALL_DIR.",
            self.tried.join("; ")
        )
    }
}

fn from_install_dir(
    dir: &Path,
    node: Option<&Path>,
    fs: &impl Fs,
    platform: Platform,
    source: FrSource,
) -> Result<FrCommand, String> {
    // Whatever named the directory (Tauri's canonicalized resource dir, a record, the
    // environment), Node gets the plain form.
    let dir = &without_verbatim_prefix(dir);
    let node = node.map(without_verbatim_prefix);
    let node = node.as_deref();
    let tsx = dir
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let cli = dir
        .join("packages")
        .join("runtime")
        .join("src")
        .join("cli")
        .join("main.ts");
    if !fs.is_file(&tsx) {
        return Err(format!(
            "{} has no node_modules/tsx (run pnpm install)",
            dir.display()
        ));
    }
    if !fs.is_file(&cli) {
        return Err(format!(
            "{} has no packages/runtime/src/cli/main.ts",
            dir.display()
        ));
    }
    let program = node.map(Path::to_path_buf).unwrap_or_else(|| {
        PathBuf::from(if platform == Platform::Windows {
            "node.exe"
        } else {
            "node"
        })
    });
    Ok(FrCommand {
        program,
        args: vec![tsx, cli],
        cwd: Some(dir.to_path_buf()),
        env: Vec::new(),
        source,
    })
}

fn from_bundled(
    runtime: &BundledRuntime,
    fs: &impl Fs,
    platform: Platform,
) -> Result<FrCommand, String> {
    let dir = without_verbatim_prefix(&runtime.dir);
    let node = bundled_node(&dir, platform);
    if !fs.is_file(&node) {
        return Err(format!("{} has no Node.js binary", dir.display()));
    }
    let mut cmd = from_install_dir(&dir, Some(&node), fs, platform, FrSource::Bundled)?;
    cmd.env
        .push(("TSX_TSCONFIG_PATH".into(), dir.join("tsconfig.json")));
    Ok(cmd)
}

fn path_entries(env: &impl Env, platform: Platform) -> Vec<PathBuf> {
    let sep = if platform == Platform::Windows {
        ';'
    } else {
        ':'
    };
    env.var("PATH")
        .unwrap_or_default()
        .split(sep)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn fr_names(platform: Platform) -> &'static [&'static str] {
    if platform == Platform::Windows {
        &["fr.exe", "fr.cmd", "fr.bat"]
    } else {
        &["fr"]
    }
}

pub const VERSIONS_DIR: &str = "versions";
pub const POINTER_FILE: &str = "current.json";
/// `safeSegment` in `packages/platform/src/paths.ts` cuts a name at 80 characters.
const SEGMENT_MAX: usize = 80;

/// The rule `versionDir()` in `packages/runtime/src/update/pointer.ts` applies through
/// `safeSegment`: a version is a directory name only when it is made of `A-Z a-z 0-9 _ . -`,
/// neither starts nor ends with `.` or `-`, is at most 80 characters and is not a reserved
/// Windows device name. Anything else (`.`, `...`, `.hidden`, a trailing space, a separator)
/// is not a staged version, so the shell never resolves it against the versions directory.
pub fn is_safe_version_segment(s: &str) -> bool {
    if s.is_empty() || s.len() > SEGMENT_MAX {
        return false;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return false;
    }
    if s.starts_with(['.', '-']) || s.ends_with(['.', '-']) {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.as_bytes()[3].is_ascii_digit()
            && lower.as_bytes()[3] != b'0');
    !reserved
}

/// The version `current.json` names (ADR 0015), when its directory holds a runnable install.
/// `<data>/versions/<version>/` is what "Update and restart" must launch; before the first
/// staged install the pointer is absent or `current` is null and the checkout runs.
pub fn staged_version_dir(data_dir: &Path, fs: &impl Fs) -> Option<PathBuf> {
    let pointer = data_dir.join(VERSIONS_DIR).join(POINTER_FILE);
    if !fs.is_file(&pointer) {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&pointer).ok()?).ok()?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let current = v.get("current").and_then(Value::as_str)?;
    if !is_safe_version_segment(current) {
        return None;
    }
    Some(data_dir.join(VERSIONS_DIR).join(current))
}

/// The Node.js binary a staged version runs on: its own `node/` when it carries one, else the
/// bundled runtime's, else `node` on `PATH`.
fn staged_node(
    dir: &Path,
    bundled: Option<&BundledRuntime>,
    fs: &impl Fs,
    platform: Platform,
) -> Option<PathBuf> {
    let own = bundled_node(dir, platform);
    if fs.is_file(&own) {
        return Some(own);
    }
    bundled
        .map(|b| bundled_node(&b.dir, platform))
        .filter(|n| fs.is_file(n))
}

/// Resolve how to run `fr` (ADR 0026, ADR 0092): the staged version of ADR 0015 unless the
/// bundled runtime is newer (an installer run over an older in-app update),
/// `FORERUNNER_INSTALL_DIR`, the bundled runtime, `<config>/install.json`, `fr` on `PATH`. The
/// bundled runtime comes before the install record so an old checkout named by a source
/// install never runs in place of the version the installer brought.
pub fn locate_fr(
    env: &impl Env,
    fs: &impl Fs,
    config_dir: &Path,
    data_dir: &Path,
    platform: Platform,
    bundled: Option<&BundledRuntime>,
) -> Result<FrCommand, LocateError> {
    let mut tried = Vec::new();

    match staged_version_dir(data_dir, fs) {
        Some(dir) => {
            let staged_version = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match bundled.filter(|b| version::is_older(&staged_version, &b.version)) {
                Some(b) => tried.push(format!(
                    "staged version {staged_version} is older than the bundled {}",
                    b.version
                )),
                None => {
                    let node = staged_node(&dir, bundled, fs, platform);
                    match from_install_dir(
                        &dir,
                        node.as_deref(),
                        fs,
                        platform,
                        FrSource::StagedVersion,
                    ) {
                        Ok(cmd) => return Ok(cmd),
                        Err(e) => tried.push(format!("staged version: {e}")),
                    }
                }
            }
        }
        None => tried.push("no staged version (current.json)".into()),
    }

    match env.var("FORERUNNER_INSTALL_DIR").filter(|s| !s.is_empty()) {
        Some(dir) => {
            match from_install_dir(Path::new(&dir), None, fs, platform, FrSource::InstallDirEnv) {
                Ok(cmd) => return Ok(cmd),
                Err(e) => tried.push(format!("FORERUNNER_INSTALL_DIR: {e}")),
            }
        }
        None => tried.push("FORERUNNER_INSTALL_DIR unset".into()),
    }

    match bundled {
        Some(b) => match from_bundled(b, fs, platform) {
            Ok(cmd) => return Ok(cmd),
            Err(e) => tried.push(format!("bundled runtime: {e}")),
        },
        None => tried.push("no bundled runtime".into()),
    }

    let record_path = config_dir.join(INSTALL_RECORD_FILE);
    if fs.is_file(&record_path) {
        match std::fs::read_to_string(&record_path)
            .map_err(|e| e.to_string())
            .and_then(|t| parse_install_record(&t))
        {
            Ok(rec) => match from_install_dir(
                &rec.install_dir,
                rec.node.as_deref(),
                fs,
                platform,
                FrSource::InstallRecord,
            ) {
                Ok(cmd) => return Ok(cmd),
                Err(e) => tried.push(format!("{}: {e}", record_path.display())),
            },
            Err(e) => tried.push(e),
        }
    } else {
        tried.push(format!("{} absent", record_path.display()));
    }

    for dir in path_entries(env, platform) {
        for name in fr_names(platform) {
            let candidate = dir.join(name);
            if fs.is_file(&candidate) {
                return Ok(FrCommand {
                    program: candidate,
                    args: Vec::new(),
                    cwd: None,
                    env: Vec::new(),
                    source: FrSource::PathLookup,
                });
            }
        }
    }
    tried.push("fr not on PATH".into());
    Err(LocateError { tried })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::MapEnv;

    fn install_fs(dir: &str) -> FakeFs {
        let d = Path::new(dir);
        FakeFs(HashSet::from([
            d.join("node_modules")
                .join("tsx")
                .join("dist")
                .join("cli.mjs"),
            d.join("packages")
                .join("runtime")
                .join("src")
                .join("cli")
                .join("main.ts"),
        ]))
    }

    const NO_DATA: &str = "/no-data-dir";

    #[test]
    fn install_dir_env_wins_and_yields_a_node_argv() {
        let env = MapEnv::new(&[("FORERUNNER_INSTALL_DIR", "/opt/fr"), ("PATH", "/usr/bin")]);
        let cmd = locate_fr(
            &env,
            &install_fs("/opt/fr"),
            Path::new("/cfg"),
            Path::new(NO_DATA),
            Platform::Linux,
            None,
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::InstallDirEnv);
        assert_eq!(cmd.program, PathBuf::from("node"));
        assert_eq!(cmd.args.len(), 2);
        assert!(cmd.args[0].ends_with(Path::new("node_modules/tsx/dist/cli.mjs")));
        assert!(cmd.args[1].ends_with(Path::new("packages/runtime/src/cli/main.ts")));
        assert_eq!(cmd.cwd.as_deref(), Some(Path::new("/opt/fr")));
        assert!(cmd.describe().contains("InstallDirEnv"));
    }

    #[test]
    fn windows_uses_node_exe_and_cmd_shims_on_path() {
        let env = MapEnv::new(&[
            ("FORERUNNER_INSTALL_DIR", "C:\\fr"),
            ("PATH", "C:\\Windows;C:\\tools"),
        ]);
        let cmd = locate_fr(
            &env,
            &install_fs("C:\\fr"),
            Path::new("C:\\cfg"),
            Path::new(NO_DATA),
            Platform::Windows,
            None,
        )
        .expect("found");
        assert_eq!(cmd.program, PathBuf::from("node.exe"));

        let env = MapEnv::new(&[("PATH", "C:\\Windows;C:\\tools")]);
        let fs = FakeFs(HashSet::from([Path::new("C:\\tools").join("fr.cmd")]));
        let cmd = locate_fr(
            &env,
            &fs,
            Path::new("C:\\cfg"),
            Path::new(NO_DATA),
            Platform::Windows,
            None,
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::PathLookup);
        assert_eq!(cmd.program, Path::new("C:\\tools").join("fr.cmd"));
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn install_dir_without_tsx_falls_through_to_path() {
        let env = MapEnv::new(&[("FORERUNNER_INSTALL_DIR", "/opt/fr"), ("PATH", "/a:/b")]);
        let fs = FakeFs(HashSet::from([Path::new("/b").join("fr")]));
        let cmd = locate_fr(
            &env,
            &fs,
            Path::new("/cfg"),
            Path::new(NO_DATA),
            Platform::Linux,
            None,
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::PathLookup);
        assert_eq!(cmd.program, Path::new("/b").join("fr"));
    }

    #[test]
    fn nothing_found_lists_what_was_tried() {
        let env = MapEnv::new(&[("PATH", "/a")]);
        let err = locate_fr(
            &env,
            &FakeFs::default(),
            Path::new("/cfg"),
            Path::new(NO_DATA),
            Platform::Linux,
            None,
        )
        .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("no staged version"));
        assert!(text.contains("FORERUNNER_INSTALL_DIR unset"));
        assert!(text.contains("install.json absent"));
        assert!(text.contains("no bundled runtime"));
        assert!(text.contains("fr not on PATH"));
        assert!(text.contains("Reinstall Forerunner"));
        assert!(text.contains("fresh-install"));
    }

    fn bundled_fs(dir: &str, platform: Platform) -> (BundledRuntime, FakeFs) {
        let runtime = BundledRuntime {
            dir: PathBuf::from(dir),
            version: "1.0.1".into(),
        };
        let mut fs = install_fs(dir);
        fs.0.insert(bundled_node(&runtime.dir, platform));
        (runtime, fs)
    }

    fn record_dir(install: &Path) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fr-record-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join(INSTALL_RECORD_FILE),
            format!(
                r#"{{"schema":1,"installDir":{}}}"#,
                serde_json::to_string(&install.to_string_lossy()).unwrap()
            ),
        )
        .expect("write record");
        dir
    }

    // 1.0.0's installer carried no runtime: the shell started the checkout an older
    // install.json named (a 0.1.0 daemon without `/me.desktopDeviceId`). The bundled runtime
    // now runs ahead of the install record and of PATH, on its own Node.js.
    #[test]
    fn the_bundled_runtime_runs_before_an_old_checkout() {
        let (runtime, mut fs) = bundled_fs("/opt/forerunner/runtime", Platform::Linux);
        let old_checkout = PathBuf::from("/home/me/Forerunner-main");
        let cfg = record_dir(&old_checkout);
        fs.0.extend(install_fs(&old_checkout.to_string_lossy()).0);
        fs.0.insert(cfg.join(INSTALL_RECORD_FILE));
        fs.0.insert(Path::new("/usr/bin").join("fr"));
        let env = MapEnv::new(&[("PATH", "/usr/bin")]);
        let cmd = locate_fr(
            &env,
            &fs,
            &cfg,
            Path::new(NO_DATA),
            Platform::Linux,
            Some(&runtime),
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::Bundled);
        assert_eq!(cmd.program, Path::new("/opt/forerunner/runtime/node/node"));
        assert_eq!(cmd.cwd.as_deref(), Some(runtime.dir.as_path()));
        assert!(cmd.args[1].ends_with(Path::new("packages/runtime/src/cli/main.ts")));
        assert_eq!(
            cmd.env,
            vec![(
                "TSX_TSCONFIG_PATH".to_string(),
                runtime.dir.join("tsconfig.json")
            )]
        );

        // Without the bundle (a development build) the record's checkout runs as before.
        let cmd =
            locate_fr(&env, &fs, &cfg, Path::new(NO_DATA), Platform::Linux, None).expect("found");
        assert_eq!(cmd.source, FrSource::InstallRecord);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn install_dir_env_still_overrides_the_bundle_and_a_broken_bundle_falls_through() {
        let (runtime, mut fs) =
            bundled_fs("C:\\Program Files\\Forerunner\\runtime", Platform::Windows);
        assert!(fs.is_file(&runtime.dir.join("node").join("node.exe")));
        fs.0.extend(install_fs("C:\\dev\\forerunner").0);
        let env = MapEnv::new(&[
            ("FORERUNNER_INSTALL_DIR", "C:\\dev\\forerunner"),
            ("PATH", ""),
        ]);
        let cmd = locate_fr(
            &env,
            &fs,
            Path::new("C:\\cfg"),
            Path::new(NO_DATA),
            Platform::Windows,
            Some(&runtime),
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::InstallDirEnv);

        // A bundle without its node binary is reported and skipped.
        let fs = install_fs("/opt/forerunner/runtime");
        let runtime = BundledRuntime {
            dir: PathBuf::from("/opt/forerunner/runtime"),
            version: "1.0.1".into(),
        };
        let err = locate_fr(
            &MapEnv::new(&[("PATH", "")]),
            &fs,
            Path::new("/cfg"),
            Path::new(NO_DATA),
            Platform::Linux,
            Some(&runtime),
        )
        .unwrap_err();
        assert!(err.to_string().contains("bundled runtime: "));
        assert!(err.to_string().contains("no Node.js binary"));
    }

    #[test]
    fn a_staged_update_runs_only_when_it_is_not_older_than_the_bundle() {
        let data = std::env::temp_dir().join(format!("fr-staged-bundle-{}", uuid::Uuid::new_v4()));
        let versions = data.join(VERSIONS_DIR);
        std::fs::create_dir_all(&versions).expect("temp dir");
        let pointer = versions.join(POINTER_FILE);
        let (runtime, mut fs) = bundled_fs("/opt/forerunner/runtime", Platform::Linux);
        fs.0.insert(pointer.clone());
        for v in ["1.0.0", "1.0.2"] {
            fs.0.extend(install_fs(&versions.join(v).to_string_lossy()).0);
        }
        let env = MapEnv::new(&[("PATH", "")]);

        std::fs::write(
            &pointer,
            r#"{"schema":1,"current":"1.0.0","state":"installed"}"#,
        )
        .expect("write");
        let cmd = locate_fr(
            &env,
            &fs,
            Path::new("/cfg"),
            &data,
            Platform::Linux,
            Some(&runtime),
        )
        .expect("found");
        assert_eq!(
            cmd.source,
            FrSource::Bundled,
            "1.0.0 staged, 1.0.1 installed over it"
        );

        std::fs::write(
            &pointer,
            r#"{"schema":1,"current":"1.0.2","state":"installed"}"#,
        )
        .expect("write");
        let cmd = locate_fr(
            &env,
            &fs,
            Path::new("/cfg"),
            &data,
            Platform::Linux,
            Some(&runtime),
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::StagedVersion);
        assert_eq!(cmd.cwd.as_deref(), Some(versions.join("1.0.2").as_path()));
        // A staged version without its own node runs on the bundled one, not on PATH.
        assert_eq!(cmd.program, bundled_node(&runtime.dir, Platform::Linux));
        let _ = std::fs::remove_dir_all(&data);
    }

    // 1.0.1 on Windows: Tauri's resource_dir() is verbatim (`\\?\D:\AGENT\Forerunner`) and
    // Node died at once on its own entry file ("EISDIR: illegal operation on a directory, lstat
    // 'D:'"). Every install location must reach Node in its plain form.
    #[test]
    fn verbatim_windows_paths_become_plain_ones() {
        for (verbatim, plain) in [
            (r"\\?\D:\AGENT\Forerunner", r"D:\AGENT\Forerunner"),
            (
                r"\\?\C:\Program Files\Forerunner",
                r"C:\Program Files\Forerunner",
            ),
            (r"\\?\d:\My Apps\Forerünner Ä", r"d:\My Apps\Forerünner Ä"),
            (r"\\?\E:\", r"E:\"),
            (
                r"\\?\UNC\server\share\Forerunner",
                r"\\server\share\Forerunner",
            ),
        ] {
            assert_eq!(
                without_verbatim_prefix(Path::new(verbatim)),
                PathBuf::from(plain),
                "{verbatim}"
            );
        }
        // Anything else is left as it is: plain paths, Linux paths, other device forms.
        for same in [
            r"D:\AGENT\Forerunner",
            r"\\server\share\x",
            "/usr/lib/Forerunner",
            "/tmp/.mount_ForeruXYZ/usr/lib/Forerunner",
            r"\\?\Volume{0d3a}\x",
            r"\\.\COM1",
        ] {
            assert_eq!(
                without_verbatim_prefix(Path::new(same)),
                PathBuf::from(same),
                "{same}"
            );
        }
        // The bundle found under a verbatim resource dir hands out plain paths.
        let res = std::env::temp_dir().join(format!("fr-verbatim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(res.join(BUNDLED_RUNTIME_DIR)).expect("dir");
        std::fs::write(
            res.join(BUNDLED_RUNTIME_DIR).join(BUNDLED_MANIFEST_FILE),
            r#"{"schema":1,"version":"1.0.2"}"#,
        )
        .expect("write");
        let found = bundled_runtime(&res).expect("found");
        assert!(!found.dir.to_string_lossy().starts_with(r"\\?\"));
        let _ = std::fs::remove_dir_all(&res);
    }

    #[test]
    fn the_command_node_receives_never_carries_the_verbatim_prefix() {
        let plain = r"D:\AGENT\Forerunner\runtime";
        let (_, fs) = bundled_fs(plain, Platform::Windows);
        let runtime = BundledRuntime {
            dir: PathBuf::from(format!(r"\\?\{plain}")),
            version: "1.0.2".into(),
        };
        let cmd = locate_fr(
            &MapEnv::new(&[("PATH", "")]),
            &fs,
            Path::new("C:\\cfg"),
            Path::new(NO_DATA),
            Platform::Windows,
            Some(&runtime),
        )
        .expect("found");
        assert_eq!(cmd.source, FrSource::Bundled);
        let mut all = vec![cmd.program.clone()];
        all.extend(cmd.args.iter().cloned());
        all.extend(cmd.cwd.iter().cloned());
        all.extend(cmd.env.iter().map(|(_, v)| v.clone()));
        for p in all {
            assert!(!p.to_string_lossy().starts_with(r"\\?\"), "{}", p.display());
        }
    }

    #[test]
    fn the_bundled_manifest_names_the_version() {
        assert_eq!(
            parse_bundled_manifest(r#"{"schema":1,"version":"1.0.1","platform":"win32"}"#),
            Ok("1.0.1".to_string())
        );
        assert!(parse_bundled_manifest(r#"{"schema":2,"version":"1.0.1"}"#).is_err());
        assert!(parse_bundled_manifest(r#"{"schema":1,"version":""}"#).is_err());
        assert!(parse_bundled_manifest("not json").is_err());

        let res = std::env::temp_dir().join(format!("fr-bundle-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(bundled_runtime(&res), None, "no runtime directory");
        std::fs::create_dir_all(res.join(BUNDLED_RUNTIME_DIR)).expect("dir");
        std::fs::write(
            res.join(BUNDLED_RUNTIME_DIR).join(BUNDLED_MANIFEST_FILE),
            r#"{"schema":1,"version":"1.0.1"}"#,
        )
        .expect("write");
        assert_eq!(
            bundled_runtime(&res),
            Some(BundledRuntime {
                dir: res.join(BUNDLED_RUNTIME_DIR),
                version: "1.0.1".into()
            })
        );
        let _ = std::fs::remove_dir_all(&res);
    }

    #[test]
    fn install_record_parses_and_rejects_other_schemas() {
        let rec =
            parse_install_record(r#"{"schema":1,"installDir":"/opt/fr","node":"/usr/bin/node"}"#)
                .expect("parses");
        assert_eq!(rec.install_dir, PathBuf::from("/opt/fr"));
        assert_eq!(rec.node.as_deref(), Some(Path::new("/usr/bin/node")));
        assert!(parse_install_record(r#"{"schema":2,"installDir":"/opt/fr"}"#).is_err());
        assert!(parse_install_record(r#"{"schema":1}"#).is_err());
        assert!(parse_install_record("nope").is_err());
    }

    #[test]
    fn install_record_is_read_from_the_config_dir() {
        let dir = std::env::temp_dir().join(format!("fr-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let install = dir.join("install");
        let record = dir.join(INSTALL_RECORD_FILE);
        std::fs::write(
            &record,
            format!(
                r#"{{"schema":1,"installDir":{},"node":{}}}"#,
                serde_json::to_string(&install.to_string_lossy()).unwrap(),
                serde_json::to_string(&dir.join("node").to_string_lossy()).unwrap()
            ),
        )
        .expect("write record");
        let mut fs = install_fs(&install.to_string_lossy());
        fs.0.insert(record.clone());
        let env = MapEnv::new(&[("PATH", "")]);
        let cmd =
            locate_fr(&env, &fs, &dir, Path::new(NO_DATA), Platform::Linux, None).expect("found");
        assert_eq!(cmd.source, FrSource::InstallRecord);
        assert_eq!(cmd.program, dir.join("node"));
        assert_eq!(cmd.cwd.as_deref(), Some(install.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_version_from_current_json_comes_first() {
        let data = std::env::temp_dir().join(format!("fr-staged-test-{}", uuid::Uuid::new_v4()));
        let versions = data.join(VERSIONS_DIR);
        std::fs::create_dir_all(&versions).expect("temp dir");
        let pointer = versions.join(POINTER_FILE);
        std::fs::write(
            &pointer,
            r#"{"schema":1,"current":"0.2.0","previous":"0.1.0","state":"pending_health_check","updatedAt":"x","lastRollback":null}"#,
        )
        .expect("write pointer");
        let staged = versions.join("0.2.0");
        let mut fs = install_fs(&staged.to_string_lossy());
        fs.0.insert(pointer.clone());
        let env = MapEnv::new(&[("FORERUNNER_INSTALL_DIR", "/opt/fr"), ("PATH", "")]);
        // Even with FORERUNNER_INSTALL_DIR set, the staged version wins when it is complete.
        let cmd =
            locate_fr(&env, &fs, Path::new("/cfg"), &data, Platform::Linux, None).expect("found");
        assert_eq!(cmd.source, FrSource::StagedVersion);
        assert_eq!(cmd.cwd.as_deref(), Some(staged.as_path()));

        // An incomplete staged directory falls through to the next source.
        let fs2 = {
            let mut f = install_fs("/opt/fr");
            f.0.insert(pointer.clone());
            f
        };
        let cmd =
            locate_fr(&env, &fs2, Path::new("/cfg"), &data, Platform::Linux, None).expect("found");
        assert_eq!(cmd.source, FrSource::InstallDirEnv);

        // A null `current` (before the first staged install) is "no staged version".
        std::fs::write(
            &pointer,
            r#"{"schema":1,"current":null,"previous":null,"state":"installed"}"#,
        )
        .expect("write");
        assert_eq!(staged_version_dir(&data, &fs), None);
        // A version name that walks the tree, or is not a single safe segment the way the
        // runtime's `safeSegment` / `versionDir` define it, is refused.
        for bad in [
            "../x", ".", "..", "...", ".hidden", "0.2.0 ", " 0.2.0", "0.2.0/", "a\\b", "v1.0.0.",
            "-1.0", "", "con",
        ] {
            std::fs::write(
                &pointer,
                format!(
                    r#"{{"schema":1,"current":{},"state":"installed"}}"#,
                    serde_json::to_string(bad).unwrap()
                ),
            )
            .expect("write");
            assert_eq!(staged_version_dir(&data, &fs), None, "{bad:?} accepted");
        }
        for good in ["0.2.0", "0.2.0-beta.1", "1.0.0_rc1", "v2"] {
            std::fs::write(
                &pointer,
                format!(
                    r#"{{"schema":1,"current":{},"state":"installed"}}"#,
                    serde_json::to_string(good).unwrap()
                ),
            )
            .expect("write");
            assert_eq!(
                staged_version_dir(&data, &fs),
                Some(versions.join(good)),
                "{good:?} refused"
            );
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn version_segments_mirror_the_runtime_rule() {
        for ok in ["0.2.0", "0.2.0-beta.1", "1.0.0_rc1", "v2", "a"] {
            assert!(is_safe_version_segment(ok), "{ok:?}");
        }
        for bad in [
            "",
            ".",
            "..",
            "...",
            ".hidden",
            "trailing.",
            "-lead",
            "trail-",
            "0.2.0 ",
            "a/b",
            "a\\b",
            "ü",
            "aux",
            "COM1",
            "nul",
        ] {
            assert!(!is_safe_version_segment(bad), "{bad:?}");
        }
        assert!(!is_safe_version_segment(&"x".repeat(81)));
        assert!(is_safe_version_segment(&"x".repeat(80)));
    }
}
