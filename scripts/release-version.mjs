#!/usr/bin/env node
// The app's version in every file that carries it, kept equal to the release tag.
//
// The version lives in the root package.json (the daemon and `fr` read it: APP_VERSION in
// packages/runtime/src/cli/main.ts), apps/desktop, apps/mobile and apps/ui package.json, the two
// tauri.conf.json files (the MSI, AppImage, .deb and APK metadata) and the [package] version of
// the two shells' Cargo.toml. release.yml runs `--set "$GITHUB_REF_NAME"` in every build job
// before the build, so an artefact always reports the version its tag names; `--check` (CI and
// the release steps) fails when the files disagree.
//
// The full version of the tag goes everywhere (v1.0.0-rc.2 -> 1.0.0-rc.2), so the daemon reports
// what the update manifest names and one release candidate can update to the next. The Windows
// installer (WiX) takes numbers only, so the desktop tauri.conf.json's
// bundle.windows.wix.version gets the core version (1.0.0).
//
// Pure Node, no shell, paths through node:path.
//
// Usage: node scripts/release-version.mjs --check [--root <dir>]
//        node scripts/release-version.mjs --set <tag-or-version> [--root <dir>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const JSON_FILES = [
  "package.json",
  path.join("apps", "desktop", "package.json"),
  path.join("apps", "mobile", "package.json"),
  path.join("apps", "ui", "package.json"),
  path.join("apps", "desktop", "src-tauri", "tauri.conf.json"),
  path.join("apps", "mobile", "src-tauri", "tauri.conf.json"),
];
export const CARGO_FILES = [
  path.join("apps", "desktop", "src-tauri", "Cargo.toml"),
  path.join("apps", "mobile", "src-tauri", "Cargo.toml"),
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.0.0-rc.2" -> "1.0.0"; throws on anything that is not a version. */
export function coreVersion(tagOrVersion) {
  const v = String(tagOrVersion).trim().replace(/^v/, "");
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a version: ${tagOrVersion}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** The [package] section's version line of a Cargo.toml (dependency versions are left alone). */
function cargoPackageVersion(text) {
  const start = text.search(/^\[package\]\s*$/m);
  if (start < 0) return null;
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\[/m);
  const section = next >= 0 ? rest.slice(0, next + 1) : rest;
  const m = /^version\s*=\s*"([^"]*)"/m.exec(section);
  return m ? { value: m[1], start, section } : null;
}

export function readVersions(root) {
  const out = [];
  for (const f of JSON_FILES) {
    const j = JSON.parse(readFileSync(path.join(root, f), "utf8"));
    out.push({ file: f, version: j.version ?? null });
  }
  for (const f of CARGO_FILES) {
    out.push({
      file: f,
      version: cargoPackageVersion(readFileSync(path.join(root, f), "utf8"))?.value ?? null,
    });
  }
  return out;
}

/** The desktop config, whose bundle.windows.wix.version carries the numeric core version. */
export const WIX_FILE = path.join("apps", "desktop", "src-tauri", "tauri.conf.json");

export function readWixVersion(root) {
  const j = JSON.parse(readFileSync(path.join(root, WIX_FILE), "utf8"));
  return j.bundle?.windows?.wix?.version ?? null;
}

export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  const core = coreVersion(version);
  {
    const p = path.join(root, WIX_FILE);
    const text = readFileSync(p, "utf8");
    const updated = text.replace(/("wix"\s*:\s*\{[^{}]*"version"\s*:\s*")[^"]*(")/, `$1${core}$2`);
    if (JSON.parse(updated).bundle?.windows?.wix?.version !== core)
      throw new Error(`${WIX_FILE}: no bundle.windows.wix.version to set`);
    writeFileSync(p, updated);
  }
  for (const f of JSON_FILES) {
    const p = path.join(root, f);
    const text = readFileSync(p, "utf8");
    // Replace the top-level "version" value in place so the file's formatting stays as it is.
    const j = JSON.parse(text);
    if (typeof j.version !== "string") throw new Error(`${f}: no top-level "version"`);
    const re = new RegExp(
      `("version"\\s*:\\s*")${j.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`,
    );
    const updated = text.replace(re, `$1${version}$2`);
    if (JSON.parse(updated).version !== version) throw new Error(`${f}: version not updated`);
    writeFileSync(p, updated);
  }
  for (const f of CARGO_FILES) {
    const p = path.join(root, f);
    const text = readFileSync(p, "utf8");
    const pkg = cargoPackageVersion(text);
    if (!pkg) throw new Error(`${f}: no [package] version`);
    const section = pkg.section.replace(/^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
    writeFileSync(
      p,
      text.slice(0, pkg.start) + section + text.slice(pkg.start + pkg.section.length),
    );
  }
}

function main(argv) {
  const rootAt = argv.indexOf("--root");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = rootAt >= 0 ? path.resolve(argv[rootAt + 1] ?? ".") : path.resolve(here, "..");
  const setAt = argv.indexOf("--set");
  if (setAt >= 0) {
    const version = String(argv[setAt + 1] ?? "")
      .trim()
      .replace(/^v/, "");
    setVersion(root, version);
    console.log(
      `release-version: set ${version} in ${JSON_FILES.length + CARGO_FILES.length} files`,
    );
  }
  const versions = readVersions(root);
  const distinct = [...new Set(versions.map((v) => v.version))];
  for (const v of versions) console.log(`${v.file}: ${v.version}`);
  if (distinct.length !== 1 || distinct[0] === null) {
    console.error(`release-version: the files disagree (${distinct.join(", ")})`);
    return 1;
  }
  const wix = readWixVersion(root);
  console.log(`${WIX_FILE} bundle.windows.wix.version: ${wix}`);
  if (wix !== coreVersion(distinct[0])) {
    console.error(`release-version: the MSI version ${wix} is not ${coreVersion(distinct[0])}`);
    return 1;
  }
  console.log(`release-version: ${distinct[0]} everywhere`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-version: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
