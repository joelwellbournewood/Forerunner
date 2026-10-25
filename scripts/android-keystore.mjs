#!/usr/bin/env node
// Android signing keystore for the Tauri Android build (apps/mobile).
//
// Two modes, decided by the environment:
//   ANDROID_KEYSTORE_BASE64 set  -> decode it to gen/android/keystore.jks, check with `keytool -list`
//                                   that it opens with ANDROID_KEYSTORE_PASSWORD (required) and holds
//                                   the alias ANDROID_KEYSTORE_ALIAS (default "forerunner"), then write
//                                   keystore.properties. This is the release key. A wrong secret,
//                                   password or alias fails here, in a second, not inside Gradle at
//                                   the end of the build.
//   otherwise                    -> generate a development keystore with keytool (JAVA_HOME/bin or PATH),
//                                   a random password that is written only to keystore.properties, and
//                                   print a NOTE that the APK is signed for sideloading, not distribution.
//                                   With --require-secret (release.yml) this mode is refused: a tagged
//                                   release never ships the build-generated key.
//
// Pure Node, no shell, paths through node:path, nothing secret on stdout. Idempotent: an existing
// generated keystore with its properties file is kept. Both files are gitignored. The properties
// file is written the way java.util.Properties.store does (ISO-8859-1 with \uXXXX escapes), because
// Gradle loads it with Properties.load(InputStream), which does not read UTF-8.
//
// Usage: node scripts/android-keystore.mjs [--android-dir <dir>] [--require-secret]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ALIAS = "forerunner";
export const KEYSTORE_FILE = "keystore.jks";
export const PROPERTIES_FILE = "keystore.properties";
/** The CN of the generated development key; scripts/android-apk-verify.mjs refuses it on a release. */
export const DEVELOPMENT_CERT_CN = "CN=Forerunner development key";
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
 * Escape a value for a Java .properties file the way Properties.store does: backslashes, a leading
 * space, the control characters \t \n \r \f, and every UTF-16 unit outside printable ASCII as
 * \uXXXX, because Properties.load(InputStream) reads ISO-8859-1 and would turn a UTF-8 "ä" into two
 * characters ("=", ":", "#" and "!" are literal inside a value, they only matter in keys).
 */
export function escapeProperty(value) {
  const text = String(value);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\f") out += "\\f";
    else if (ch === " " && i === 0) out += "\\ ";
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
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

/** keytool with an argv array and the password in the child's environment, never on its command line. */
function runKeytool(spawn, keytool, args, env, password) {
  return spawn(keytool, args, {
    env: { ...env, [PASSWORD_ENV]: password },
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

/**
 * Prepare the keystore. Returns { mode, keystorePath, propertiesPath, alias }.
 * mode: "secret" (decoded from the environment), "generated" (new dev key), "existing" (kept).
 * options.requireSecret refuses the two development modes (a release build).
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

  if (!env.ANDROID_KEYSTORE_BASE64 && options.requireSecret) {
    throw new Error(
      'ANDROID_KEYSTORE_BASE64 is not set and --require-secret was given: a release build needs the release keystore (ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PASSWORD; docs/maintainers/release.md, "Provide or rotate the Android release key"). A build-generated development key never ships on a release.',
    );
  }
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
    // Gradle would find a wrong password, alias or file only at the end of the build, after the
    // Rust compile; keytool answers in a second and prints the alias and a fingerprint, no secret.
    const check = runKeytool(
      spawn,
      resolveKeytool(env),
      ["-list", "-keystore", keystorePath, "-alias", alias, "-storepass:env", PASSWORD_ENV],
      env,
      password,
    );
    if (check.error || check.status !== 0) {
      rmSync(keystorePath, { force: true });
      rmSync(propertiesPath, { force: true });
      if (check.error) {
        throw new Error(
          `keytool could not be started (${check.error.message}); it is needed to check the keystore from ANDROID_KEYSTORE_BASE64. Install a JDK (Temurin 17) or set JAVA_HOME.`,
        );
      }
      const detail = redact(`${check.stdout ?? ""}\n${check.stderr ?? ""}`, password).trim();
      throw new Error(
        `the keystore from ANDROID_KEYSTORE_BASE64 does not open with ANDROID_KEYSTORE_PASSWORD and alias ${alias} (keytool -list exited with ${check.status}): ${detail.slice(-800)}`,
      );
    }
    writePrivate(propertiesPath, propertiesText({ storeFile: keystorePath, password, alias }));
    log(
      `android-keystore: release keystore written to ${keystorePath} (${bytes.length} bytes; keytool -list confirmed alias ${alias})`,
    );
    log(`android-keystore: properties written to ${propertiesPath} (alias ${alias})`);
    return { mode: "secret", keystorePath, propertiesPath, alias };
  }

  if (existsSync(keystorePath) && existsSync(propertiesPath)) {
    log(
      `android-keystore: keeping the existing keystore at ${keystorePath} (a generated development key, or the release key of an earlier run with the secret; delete both files to regenerate)`,
    );
    log(
      "android-keystore: NOTE: without ANDROID_KEYSTORE_BASE64 this build signs with the kept key; a build-generated development key can be sideloaded but is not for distribution. Provide ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PASSWORD for a release build.",
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
    `${DEVELOPMENT_CERT_CN}, O=Forerunner, C=CH`,
  ];
  const result = runKeytool(spawn, keytool, args, env, password);
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
    setupKeystore({ androidDir, requireSecret: process.argv.includes("--require-secret") });
  } catch (e) {
    console.error(`android-keystore: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
