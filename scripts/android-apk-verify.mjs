#!/usr/bin/env node
// Verify that the release APK(s) the Tauri Android build produced are signed, and with which key.
//
// Runs `apksigner verify --verbose --print-certs <apk>` on every APK under a `release` directory of
// gen/android/app/build/outputs/apk (the debug APKs of the emulator smoke are left alone) and fails
//   - when no release APK exists (the build did not run or wrote elsewhere),
//   - when apksigner cannot verify one (an unsigned `-unsigned.apk`, a broken signature),
//   - when apksigner names no signer certificate at all,
//   - when the signer is the Android debug certificate (CN=Android Debug): a release artefact must
//     carry the key from keystore.properties (scripts/android-keystore.mjs), never the SDK's debug key.
// apksigner comes from the newest build-tools under ANDROID_HOME or ANDROID_SDK_ROOT, else from PATH.
// The output holds only the certificate's DN and digests, nothing secret.
//
// Pure Node, no shell, paths through node:path. Both workflows run it right after the build and
// before the artefact upload, so an unsigned APK is never uploaded.
//
// Usage: node scripts/android-apk-verify.mjs [--apk-root <dir>] [--apksigner <path>] [--allow-debug]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEBUG_CERT_CN = "CN=Android Debug";

/** gen/android/app/build/outputs/apk inside the mobile app, relative to the repository root. */
export function defaultApkRoot(repoRoot) {
  return path.join(
    repoRoot,
    "apps",
    "mobile",
    "src-tauri",
    "gen",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
  );
}

/** Numeric order of build-tools directory names ("34.0.0", "34.0.0-rc4" sorts before "34.0.0"). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(v) ?? [];
    return { parts: (m[1] ?? "0").split(".").map(Number), pre: m[2] ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  const n = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // a release sorts above its candidates
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** The newest apksigner under ANDROID_HOME, then ANDROID_SDK_ROOT; otherwise the bare name (PATH). */
export function resolveApksigner(env = process.env, platform = process.platform) {
  const exe = platform === "win32" ? "apksigner.bat" : "apksigner";
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const sdk = env[key];
    if (!sdk) continue;
    const buildTools = path.join(sdk, "build-tools");
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools)
      .filter((v) => existsSync(path.join(buildTools, v, exe)))
      .sort(compareVersions);
    const newest = versions[versions.length - 1];
    if (newest) return path.join(buildTools, newest, exe);
  }
  return exe;
}

/** Every *.apk below `root` whose path has a `release` directory segment, sorted. */
export function findReleaseApks(root) {
  const found = [];
  const walk = (dir, underRelease) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      const isRelease = underRelease || entry.toLowerCase() === "release";
      if (statSync(p).isDirectory()) walk(p, isRelease);
      else if (isRelease && /\.apk$/i.test(entry)) found.push(p);
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root, false);
  return found.sort();
}

/** The signers and signature schemes out of `apksigner verify --verbose --print-certs` output. */
export function parseVerifyOutput(text) {
  const schemes = {};
  const signers = [];
  for (const line of String(text).split(/\r?\n/)) {
    const scheme = /^Verified using (v\d) scheme[^:]*:\s*(true|false)/.exec(line);
    if (scheme) schemes[scheme[1]] = scheme[2] === "true";
    const dn = /^Signer #(\d+) certificate DN:\s*(.+)$/.exec(line);
    if (dn) signers[Number(dn[1]) - 1] = { dn: dn[2].trim(), sha256: "" };
    const sha = /^Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(line);
    if (sha?.[2] && signers[Number(sha[1]) - 1]) signers[Number(sha[1]) - 1].sha256 = sha[2];
  }
  return {
    verifies: /^Verifies\s*$/m.test(String(text)),
    schemes,
    signers: signers.filter(Boolean),
  };
}

/**
 * Verify every release APK. Returns [{ apk, signers, schemes }] or throws with the reason.
 * options: apkRoot, apksigner, env, platform, spawn, log, allowDebug.
 */
export function verifyReleaseApks(options = {}) {
  const env = options.env ?? process.env;
  const apkRoot = options.apkRoot ?? defaultApkRoot(repoRootFromScript());
  const spawn = options.spawn ?? spawnSync;
  const log = options.log ?? ((line) => console.log(line));
  const apksigner = options.apksigner ?? resolveApksigner(env, options.platform);
  const apks = findReleaseApks(apkRoot);
  if (apks.length === 0) {
    throw new Error(`no release APK under ${apkRoot}; run the Tauri Android build first`);
  }
  const results = [];
  for (const apk of apks) {
    const result = spawn(apksigner, ["verify", "--verbose", "--print-certs", apk], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `apksigner could not be started (${result.error.message}). Install the Android build-tools and set ANDROID_HOME, or pass --apksigner <path>.`,
      );
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status !== 0) {
      throw new Error(
        `${apk} is not a signed APK that apksigner can verify (exit ${result.status}):\n${output.slice(-800)}`,
      );
    }
    const parsed = parseVerifyOutput(output);
    if (parsed.signers.length === 0) {
      throw new Error(`apksigner printed no signer certificate for ${apk}:\n${output.slice(-800)}`);
    }
    const debug = parsed.signers.find((s) => s.dn.includes(DEBUG_CERT_CN));
    if (debug && !options.allowDebug) {
      throw new Error(
        `${apk} is signed with the Android debug key (${debug.dn}); a release APK must use the key from keystore.properties (node scripts/android-keystore.mjs before the build)`,
      );
    }
    const schemes = Object.entries(parsed.schemes)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(", ");
    log(`android-apk-verify: ${apk} verified (schemes ${schemes || "unreported"})`);
    for (const [i, signer] of parsed.signers.entries()) {
      log(`android-apk-verify:   signer #${i + 1} ${signer.dn}`);
      if (signer.sha256) log(`android-apk-verify:   signer #${i + 1} SHA-256 ${signer.sha256}`);
    }
    results.push({ apk, signers: parsed.signers, schemes: parsed.schemes });
  }
  return results;
}

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const apkRootArg = arg("--apk-root");
  const apksignerArg = arg("--apksigner");
  try {
    verifyReleaseApks({
      apkRoot: apkRootArg ? path.resolve(apkRootArg) : undefined,
      apksigner: apksignerArg ? path.resolve(apksignerArg) : undefined,
      allowDebug: process.argv.includes("--allow-debug"),
    });
  } catch (e) {
    console.error(`android-apk-verify: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
