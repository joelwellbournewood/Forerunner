import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkGoogleServices,
  DEFAULT_PACKAGE,
  FILE_NAME,
  SECRET_ENV,
  setupGoogleServices,
  // @ts-expect-error plain JS module
} from "./android-google-services.mjs";

// ADR 0085 point 9: google-services.json is a build secret written from
// GOOGLE_SERVICES_JSON_BASE64; every build without it stays the polling stand-in.

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-gservices-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A config shaped like the console's download; the key is built so the secret scan stays quiet. */
const FAKE_KEY = ["fake", "api", "key", "for", "tests"].join("-"); // not-a-secret
function config(packageName = DEFAULT_PACKAGE, projectId = "example-project") {
  return JSON.stringify({
    project_info: { project_number: "1", project_id: projectId, storage_bucket: "x" },
    client: [
      {
        client_info: {
          mobilesdk_app_id: "1:1:android:abc",
          android_client_info: { package_name: packageName },
        },
        api_key: [{ current_key: FAKE_KEY }],
      },
    ],
    configuration_version: "1",
  });
}
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("android-google-services", () => {
  it("writes google-services.json into the app module from the secret, printing no content", () => {
    const dir = tempDir();
    const lines: string[] = [];
    const r = setupGoogleServices({
      androidDir: dir,
      env: { [SECRET_ENV]: b64(config()) },
      log: (l: string) => lines.push(l),
    });
    expect(r.mode).toBe("secret");
    expect(r.projectId).toBe("example-project");
    const file = join(dir, "app", FILE_NAME);
    expect(r.file).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8")).project_info.project_id).toBe("example-project");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain("example-project");
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(lines.join("\n")).not.toContain("mobilesdk_app_id");
  });

  it("writes nothing without the secret (an empty Actions secret is unset) and says push stays polling", () => {
    const dir = tempDir();
    for (const env of [{}, { [SECRET_ENV]: "" }, { [SECRET_ENV]: "  \n" }]) {
      const lines: string[] = [];
      const r = setupGoogleServices({ androidDir: dir, env, log: (l: string) => lines.push(l) });
      expect(r.mode).toBe("absent");
      expect(existsSync(join(dir, "app", FILE_NAME))).toBe(false);
      expect(lines.join("\n")).toMatch(/polling stand-in/);
    }
  });

  it("keeps a file a maintainer placed by hand when no secret is set", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", FILE_NAME), config());
    const r = setupGoogleServices({ androidDir: dir, env: {}, log: () => {} });
    expect(r.mode).toBe("existing");
    expect(readFileSync(join(dir, "app", FILE_NAME), "utf8")).toBe(config());
  });

  it("fails on a secret that is not a google-services.json for this app, without quoting it", () => {
    const dir = tempDir();
    const cases: [string, RegExp][] = [
      ["not json at all", /does not decode to JSON/],
      [JSON.stringify({ client: [] }), /project_info\.project_id is missing/],
      [config("com.example.other"), /no Android app with the package app\.forerunner\.mobile/],
    ];
    for (const [text, message] of cases) {
      let error: Error | null = null;
      try {
        setupGoogleServices({ androidDir: dir, env: { [SECRET_ENV]: b64(text) }, log: () => {} });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toMatch(message);
      expect(error?.message).not.toContain(FAKE_KEY);
      expect(existsSync(join(dir, "app", FILE_NAME))).toBe(false);
    }
    expect(checkGoogleServices(config())).toEqual({
      projectId: "example-project",
      packageName: DEFAULT_PACKAGE,
    });
  });
});

describe("the Android project wires FCM only when google-services.json is present", () => {
  const appDir = ["apps", "mobile", "src-tauri", "gen", "android", "app"];
  const gradle = read(...appDir, "build.gradle.kts");
  const rootGradle = read(...appDir.slice(0, -1), "build.gradle.kts");

  it("checks for the file in the app module and gates the dependency, sources and plugin on it", () => {
    expect(gradle).toContain('file("google-services.json")');
    expect(gradle).toMatch(/val hasGoogleServices = googleServicesFile\.exists\(\)/);
    expect(gradle).toMatch(
      /if \(withFcmSources\) \{\s*implementation\("com\.google\.firebase:firebase-messaging:[\d.]+"\)/,
    );
    expect(gradle).toMatch(
      /if \(hasGoogleServices\) \{[\s\S]*?apply\(plugin = "com\.google\.gms\.google-services"\)/,
    );
    expect(gradle).toContain('java.srcDir("src/fcm/java")');
    expect(gradle).toContain('manifest.srcFile("src/fcm/AndroidManifest.xml")');
    expect(gradle).toMatch(/buildConfigField\("boolean", "FCM_CONFIGURED", hasGoogleServices/);
    // the plugin is only on the classpath, never applied unconditionally
    expect(rootGradle).toMatch(/classpath\("com\.google\.gms:google-services:[\d.]+"\)/);
    expect(gradle).not.toMatch(/^\s*id\("com\.google\.gms\.google-services"\)/m);
  });

  it("keeps every Firebase class out of the main source set and its manifest", () => {
    const main = [...appDir, "src", "main"];
    const manifest = read(...main, "AndroidManifest.xml");
    expect(manifest).not.toMatch(/firebase|MessagingService|POST_NOTIFICATIONS/i);
    for (const file of [
      "KeystorePlugin.kt",
      "MainActivity.kt",
      "PushLinks.kt",
      "PushTokenStore.kt",
    ]) {
      const text = read(...main, "java", "app", "forerunner", "mobile", file);
      expect(text, file).not.toMatch(/import com\.google\.firebase/);
    }
    const fcmManifest = read(...appDir, "src", "fcm", "AndroidManifest.xml");
    expect(fcmManifest).toContain("com.google.firebase.MESSAGING_EVENT");
    expect(fcmManifest).toContain("ForerunnerMessagingService");
    expect(fcmManifest).toContain('android:exported="false"');
    const service = read(
      ...appDir,
      "src",
      "fcm",
      "java",
      "app",
      "forerunner",
      "mobile",
      "ForerunnerMessagingService.kt",
    );
    expect(service).toMatch(/override fun onNewToken/);
    expect(service).toMatch(/override fun onMessageReceived/);
    expect(service).not.toMatch(/Log\.|println/);
  });

  it("reports fcmToken from KeystorePlugin.info, null without Firebase", () => {
    const plugin = read(
      ...appDir,
      "src",
      "main",
      "java",
      "app",
      "forerunner",
      "mobile",
      "KeystorePlugin.kt",
    );
    expect(plugin).toMatch(
      /BuildConfig\.FCM_CONFIGURED\) PushTokenStore\.read\(activity\) else null/,
    );
    expect(plugin).toContain('out.put("fcmToken", token ?: JSONObject.NULL)');
  });

  it("is never committed: gitignored next to the module and at the root", () => {
    expect(read(...appDir, ".gitignore")).toMatch(/^\/google-services\.json$/m);
    expect(read(".gitignore")).toMatch(/^google-services\.json$/m);
  });
});

describe("the workflows write google-services.json from the secret before the build", () => {
  for (const workflow of ["android.yml", "release.yml"]) {
    it(`${workflow}: the script with GOOGLE_SERVICES_JSON_BASE64, then the build`, () => {
      const text = read(".github", "workflows", workflow);
      const step = text.indexOf("node scripts/android-google-services.mjs");
      expect(step).toBeGreaterThan(-1);
      expect(text.indexOf("tauri android build --apk")).toBeGreaterThan(step);
      expect(text).toMatch(
        /GOOGLE_SERVICES_JSON_BASE64: \$\{\{ secrets\.GOOGLE_SERVICES_JSON_BASE64 \}\}/,
      );
      // optional: no flag that would fail a build without the secret
      expect(text).not.toMatch(/android-google-services\.mjs --require/);
    });
  }

  it("android.yml runs the Kotlin unit tests with the FCM compile check", () => {
    const text = read(".github", "workflows", "android.yml");
    expect(text).toMatch(
      /gradlew[^\n]*:app:testX86_64DebugUnitTest[^\n]*-PforerunnerFcmCompileCheck=true/,
    );
  });
});
