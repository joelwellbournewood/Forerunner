#!/usr/bin/env node
// Firebase configuration for the Android app's FCM push (apps/mobile; ADR 0085 point 9).
//
// google-services.json is a build secret: it is never committed (gitignored) and CI writes it
// from the Actions secret GOOGLE_SERVICES_JSON_BASE64, the way scripts/android-keystore.mjs
// writes the signing key. Two modes, decided by the environment:
//   GOOGLE_SERVICES_JSON_BASE64 set -> decode it, check that it is a Firebase Android config
//                                      (project_info.project_id, a client for the app's package
//                                      app.forerunner.mobile) and write it to
//                                      gen/android/app/google-services.json (mode 0600). A wrong
//                                      secret fails here, in a second, not inside Gradle.
//   otherwise                       -> write nothing and say that push stays the polling
//                                      stand-in. A file a maintainer placed by hand is kept.
// app/build.gradle.kts adds firebase-messaging, the FCM sources and the Google services plugin
// only when the file exists, so both modes build.
//
// Pure Node, no shell, paths through node:path. Nothing from the file is printed except the
// project id and the package name (neither is a secret; the API key and app id are never shown).
//
// Usage: node scripts/android-google-services.mjs [--android-dir <dir>]
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FILE_NAME = "google-services.json";
export const SECRET_ENV = "GOOGLE_SERVICES_JSON_BASE64";
/** The applicationId in gen/android/app/build.gradle.kts (and tauri.conf.json's identifier). */
export const DEFAULT_PACKAGE = "app.forerunner.mobile";

/** gen/android inside the mobile app, relative to the repository root. */
export function defaultAndroidDir(repoRoot) {
  return path.join(repoRoot, "apps", "mobile", "src-tauri", "gen", "android");
}

/**
 * Parse and check the decoded file. Returns { projectId, packageName }; throws an Error that
 * names what is wrong and never quotes the content.
 */
export function checkGoogleServices(text, packageName = DEFAULT_PACKAGE) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${SECRET_ENV} does not decode to JSON (expected the google-services.json the Firebase console downloads)`,
    );
  }
  const projectId = parsed?.project_info?.project_id;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error(
      `${SECRET_ENV}: project_info.project_id is missing (not a google-services.json)`,
    );
  }
  const clients = Array.isArray(parsed.client) ? parsed.client : [];
  const packages = clients
    .map((c) => c?.client_info?.android_client_info?.package_name)
    .filter((p) => typeof p === "string");
  if (!packages.includes(packageName)) {
    throw new Error(
      `${SECRET_ENV}: the Firebase project ${projectId} has no Android app with the package ${packageName} (found: ${packages.join(", ") || "none"}); register the app in the Firebase console and download its google-services.json again`,
    );
  }
  return { projectId, packageName };
}

function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // best effort; no-op on Windows
  } catch {
    // ignore
  }
}

/**
 * Write google-services.json from the environment. Returns { mode, file, projectId? }.
 * mode: "secret" (written), "existing" (no secret, a file is already there), "absent".
 */
export function setupGoogleServices(options = {}) {
  const env = options.env ?? process.env;
  const androidDir =
    options.androidDir ?? defaultAndroidDir(options.repoRoot ?? repoRootFromScript());
  const log = options.log ?? ((line) => console.log(line));
  const packageName = options.packageName ?? DEFAULT_PACKAGE;
  const appDir = path.join(androidDir, "app");
  const file = path.join(appDir, FILE_NAME);
  const encoded = (env[SECRET_ENV] ?? "").replace(/\s+/g, "");

  if (!encoded) {
    if (existsSync(file)) {
      log(
        `android-google-services: ${SECRET_ENV} is not set; keeping the existing ${file} (FCM push is built in)`,
      );
      return { mode: "existing", file };
    }
    log(
      `android-google-services: ${SECRET_ENV} is not set; no ${FILE_NAME}, so push stays the polling stand-in (docs/maintainers/apps.md, "Android push")`,
    );
    return { mode: "absent", file };
  }

  const text = Buffer.from(encoded, "base64").toString("utf8");
  const { projectId } = checkGoogleServices(text, packageName);
  mkdirSync(appDir, { recursive: true });
  writePrivate(file, text);
  log(
    `android-google-services: ${FILE_NAME} written to ${file} (Firebase project ${projectId}, package ${packageName}); FCM push is built in`,
  );
  return { mode: "secret", file, projectId };
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
    setupGoogleServices({ androidDir });
  } catch (e) {
    console.error(`android-google-services: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
