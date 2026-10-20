#!/usr/bin/env node
// Android signing keystore for the Tauri Android build (apps/mobile).
//
// Two modes, decided by the environment:
//   ANDROID_KEYSTORE_BASE64 set  -> decode it to gen/android/keystore.jks and write keystore.properties
//                                   with ANDROID_KEYSTORE_PASSWORD (required) and the alias
//                                   ANDROID_KEYSTORE_ALIAS (default "forerunner"). This is the release key.
//   otherwise                    -> generate a development keystore with keytool (JAVA_HOME/bin or PATH),
//                                   a random password that is written only to keystore.properties, and
//                                   print a NOTE that the APK is signed for sideloading, not distribution.
//
// Pure Node, no shell, paths through node:path, nothing secret on stdout. Idempotent: an existing
// generated keystore with its properties file is kept. Both files are gitignored.
//
// Usage: node scripts/android-keystore.mjs [--android-dir <dir>]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ALIAS = "forerunner";
export const KEYSTORE_FILE = "keystore.jks";
export const PROPERTIES_FILE = "keystore.properties";
const PASSWORD_ENV = "FORERUNNER_KEYSTORE_PASSWORD_TMP";

/** gen/android inside the mobile app, relative to the repository root. */
export function defaultAndroidDir(repoRoot) {
  return path.join(repoRoot, "apps", "mobile", "src-tauri", "gen", "android");
}

/** keytool from JAVA_HOME/bin when present, otherwise the name alone (resolved on PATH by spawn). */
export function resolveKeytool(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  const exe = platform === "win32" ? "keytool.exe" : "keytool";
  if (env.JAVA_HOME) {
    const candidate = path.join(env.JAVA_HOME, "bin", exe);
    if (exists(candidate)) return candidate;
  }
  return exe;
}

/**
 * Escape a value for a Java .properties file: backslashes and leading whitespace only
 * ("=", ":", "#" and "!" are literal inside a value, they only matter in keys).
 */
export function escapeProperty(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/^(\s)/, "\\$1");
}

/** The keystore.properties content Tauri's Android project reads (storeFile, keyAlias, password). */
export function propertiesText({ storeFile, password, alias }) {
  // Forward slashes work for java.io.File on Windows too and need no escaping.
  const file = storeFile.split(path.sep).join("/").replace(/\\/g, "/");
  return [
    "# Written by scripts/android-keystore.mjs. Gitignored: never commit this file.",
    `storeFile=${escapeProperty(file)}`,
    `keyAlias=${escapeProperty(alias)}`,
    `password=${escapeProperty(password)}`,
    `storePassword=${escapeProperty(password)}`,
    `keyPassword=${escapeProperty(password)}`,
    "",
  ].join("\n");
}

function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // best effort; no-op on Windows
  } catch {
    // ignore
  }
}

function redact(text, secret) {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

/**
 * Prepare the keystore. Returns { mode, keystorePath, propertiesPath, alias }.
 * mode: "secret" (decoded from the environment), "generated" (new dev key), "existing" (kept).
 */
export function setupKeystore(options = {}) {
  const env = options.env ?? process.env;
  const androidDir =
    options.androidDir ?? defaultAndroidDir(options.repoRoot ?? repoRootFromScript());
  const log = options.log ?? ((line) => console.log(line));
  const spawn = options.spawn ?? spawnSync;
  const keystorePath = path.join(androidDir, KEYSTORE_FILE);
  const propertiesPath = path.join(androidDir, PROPERTIES_FILE);
  const alias = env.ANDROID_KEYSTORE_ALIAS || DEFAULT_ALIAS;
  mkdirSync(androidDir, { recursive: true });

  if (env.ANDROID_KEYSTORE_BASE64) {
    const password = env.ANDROID_KEYSTORE_PASSWORD;
    if (!password) {
      throw new Error(
        "ANDROID_KEYSTORE_PASSWORD is required when ANDROID_KEYSTORE_BASE64 is set (the value is never printed)",
      );
    }
    const bytes = Buffer.from(env.ANDROID_KEYSTORE_BASE64.replace(/\s+/g, ""), "base64");
    if (bytes.length < 32) {
      throw new Error("ANDROID_KEYSTORE_BASE64 does not decode to a keystore (too short)");
    }
    writePrivate(keystorePath, bytes);
    writePrivate(propertiesPath, propertiesText({ storeFile: keystorePath, password, alias }));
    log(`android-keystore: release keystore written to ${keystorePath} (${bytes.length} bytes)`);
    log(`android-keystore: properties written to ${propertiesPath} (alias ${alias})`);
    return { mode: "secret", keystorePath, propertiesPath, alias };
  }

  if (existsSync(keystorePath) && existsSync(propertiesPath)) {
    log(`android-keystore: keeping the existing development keystore at ${keystorePath}`);
    log(
      "android-keystore: NOTE: this APK is signed with a build-generated development key; it can be sideloaded but is not for distribution. Provide ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PASSWORD for a release build.",
    );
    return { mode: "existing", keystorePath, propertiesPath, alias };
  }
  if (existsSync(keystorePath)) {
    log(
      `android-keystore: ${KEYSTORE_FILE} exists without ${PROPERTIES_FILE} (password unknown); regenerating the development key`,
    );
    rmSync(keystorePath);
  }

  const password = randomBytes(24).toString("base64url");
  const keytool = resolveKeytool(env);
  const args = [
    "-genkeypair",
    "-keystore",
    keystorePath,
    "-alias",
    alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-storetype",
    "PKCS12",
    "-storepass:env",
    PASSWORD_ENV,
    "-keypass:env",
    PASSWORD_ENV,
    "-dname",
    "CN=Forerunner development key, O=Forerunner, C=CH",
  ];
  const result = spawn(keytool, args, {
    env: { ...env, [PASSWORD_ENV]: password },
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    throw new Error(
      `keytool could not be started (${result.error.message}). Install a JDK (Temurin 17) or set JAVA_HOME.`,
    );
  }
  if (result.status !== 0) {
    const detail = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, password).trim();
    throw new Error(`keytool exited with ${result.status}: ${detail.slice(-800)}`);
  }
  writePrivate(propertiesPath, propertiesText({ storeFile: keystorePath, password, alias }));
  try {
    chmodSync(keystorePath, 0o600);
  } catch {
    // best effort
  }
  log(`android-keystore: development keystore generated at ${keystorePath} (alias ${alias})`);
  log(
    `android-keystore: properties written to ${propertiesPath} (gitignored; password only there)`,
  );
  log(
    "android-keystore: NOTE: this APK is signed with a build-generated development key; it can be sideloaded but is not for distribution. Provide ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PASSWORD for a release build.",
  );
  return { mode: "generated", keystorePath, propertiesPath, alias };
}

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const i = process.argv.indexOf("--android-dir");
  const androidDir = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : undefined;
  try {
    setupKeystore({ androidDir });
  } catch (e) {
    console.error(`android-keystore: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
