import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  escapeProperty,
  PROPERTIES_FILE,
  propertiesText,
  resolveKeytool,
  setupKeystore,
  // @ts-expect-error plain JS module
} from "./android-keystore.mjs";

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-keystore-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const keytoolPresent = (() => {
  const r = spawnSync(resolveKeytool(process.env), ["-help"], { encoding: "utf8" });
  return !r.error;
})();

describe("android-keystore helpers", () => {
  it("resolves keytool from JAVA_HOME when it exists there, else from PATH", () => {
    const exists = (p: string) => p.includes("jdk-here");
    expect(resolveKeytool({ JAVA_HOME: join("x", "jdk-here") }, "linux", exists)).toBe(
      join("x", "jdk-here", "bin", "keytool"),
    );
    expect(resolveKeytool({ JAVA_HOME: join("x", "jdk-here") }, "win32", exists)).toBe(
      join("x", "jdk-here", "bin", "keytool.exe"),
    );
    expect(resolveKeytool({ JAVA_HOME: join("x", "missing") }, "linux", exists)).toBe("keytool");
    expect(resolveKeytool({}, "win32", exists)).toBe("keytool.exe");
  });

  it("escapes Java properties specials", () => {
    expect(escapeProperty("a=b:c#d!e\\f")).toBe("a=b:c#d!e\\\\f");
    expect(escapeProperty(" lead")).toBe("\\ lead");
  });

  it("writes the properties Tauri's gradle expects with forward slashes", () => {
    const text = propertiesText({
      storeFile: ["C:", "x", "keystore.jks"].join("\\"),
      password: "p=w",
      alias: "forerunner",
    });
    expect(text).toContain("storeFile=C:/x/keystore.jks");
    expect(text).toContain("keyAlias=forerunner");
    expect(text).toContain("password=p=w");
    expect(text).toContain("storePassword=p=w");
    expect(text).toContain("keyPassword=p=w");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("android-keystore from a secret", () => {
  it("decodes ANDROID_KEYSTORE_BASE64 and writes keystore.properties without printing the password", () => {
    const dir = tempDir();
    const bytes = randomBytes(300);
    const password = ["dev", "pass", randomBytes(6).toString("hex")].join("-"); // not-a-secret
    const lines: string[] = [];
    const res = setupKeystore({
      androidDir: dir,
      env: {
        ANDROID_KEYSTORE_BASE64: bytes.toString("base64"),
        ANDROID_KEYSTORE_PASSWORD: password,
      },
      log: (l: string) => lines.push(l),
    });
    expect(res.mode).toBe("secret");
    expect(readFileSync(join(dir, "keystore.jks")).equals(bytes)).toBe(true);
    const props = readFileSync(join(dir, "keystore.properties"), "utf8");
    expect(props).toContain(`password=${password}`);
    expect(props).toContain("keyAlias=forerunner");
    expect(lines.join("\n")).not.toContain(password);
    expect(lines.join("\n")).not.toContain(bytes.toString("base64").slice(0, 20));
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "keystore.properties")).mode & 0o077).toBe(0);
    }
  });

  it("honours ANDROID_KEYSTORE_ALIAS", () => {
    const dir = tempDir();
    const res = setupKeystore({
      androidDir: dir,
      env: {
        ANDROID_KEYSTORE_BASE64: randomBytes(64).toString("base64"),
        ANDROID_KEYSTORE_PASSWORD: "x".repeat(12),
        ANDROID_KEYSTORE_ALIAS: "upload",
      },
      log: () => {},
    });
    expect(res.alias).toBe("upload");
    expect(readFileSync(join(dir, "keystore.properties"), "utf8")).toContain("keyAlias=upload");
  });

  it("fails without ANDROID_KEYSTORE_PASSWORD and never echoes the secret", () => {
    const dir = tempDir();
    const b64 = randomBytes(64).toString("base64");
    expect(() =>
      setupKeystore({ androidDir: dir, env: { ANDROID_KEYSTORE_BASE64: b64 }, log: () => {} }),
    ).toThrow(/ANDROID_KEYSTORE_PASSWORD is required/);
    try {
      setupKeystore({ androidDir: dir, env: { ANDROID_KEYSTORE_BASE64: b64 }, log: () => {} });
    } catch (e) {
      expect(String(e)).not.toContain(b64.slice(0, 16));
    }
    expect(existsSync(join(dir, "keystore.jks"))).toBe(false);
  });
});

describe("android-keystore generated development key", () => {
  it.skipIf(!keytoolPresent)(
    "generates a keystore with keytool, keeps the password out of stdout, and is idempotent",
    () => {
      const dir = tempDir();
      const lines: string[] = [];
      const first = setupKeystore({
        androidDir: dir,
        env: { JAVA_HOME: process.env.JAVA_HOME ?? "" },
        log: (l: string) => lines.push(l),
      });
      expect(first.mode).toBe("generated");
      expect(existsSync(join(dir, "keystore.jks"))).toBe(true);
      const props = readFileSync(join(dir, "keystore.properties"), "utf8");
      const password = /^password=(.+)$/m.exec(props)?.[1];
      expect(password).toBeTruthy();
      expect(password?.length).toBeGreaterThan(20);
      expect(lines.join("\n")).not.toContain(password as string);
      expect(lines.join("\n")).toContain("NOTE");
      expect(lines.join("\n")).toContain("not for distribution");
      const firstBytes = readFileSync(join(dir, "keystore.jks"));
      const second = setupKeystore({ androidDir: dir, env: {}, log: () => {} });
      expect(second.mode).toBe("existing");
      expect(readFileSync(join(dir, "keystore.jks")).equals(firstBytes)).toBe(true);
    },
  );

  it("redacts the password from a keytool failure and reports a missing keytool clearly", () => {
    const dir = tempDir();
    const leaky = (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => ({
      status: 1,
      stdout: "",
      stderr: `boom ${opts.env.FORERUNNER_KEYSTORE_PASSWORD_TMP}`,
      error: undefined,
    });
    let message = "";
    try {
      setupKeystore({ androidDir: dir, env: {}, log: () => {}, spawn: leaky });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("keytool exited with 1");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toMatch(/boom [A-Za-z0-9_-]{20,}/);

    const missing = () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") });
    expect(() =>
      setupKeystore({ androidDir: dir, env: {}, log: () => {}, spawn: missing }),
    ).toThrow(/keytool could not be started/);
  });
});

describe("the Android project's release signing config (build.gradle.kts)", () => {
  // Tauri keeps gen/android/app/build.gradle.kts after `android init` (only tauri.build.gradle.kts
  // and tauri.properties are regenerated, see gen/android/.gitignore), so the signing config
  // lives in the committed file and must read what scripts/android-keystore.mjs writes.
  const gradle = read("apps", "mobile", "src-tauri", "gen", "android", "app", "build.gradle.kts");
  const releaseBlock = gradle.slice(gradle.indexOf('getByName("release")'));

  it("loads keystore.properties from the Android project root only when it exists", () => {
    expect(gradle).toContain(`rootProject.file("${PROPERTIES_FILE}")`);
    expect(gradle).toMatch(/keystorePropertiesFile\.exists\(\)/);
    // the properties are loaded the way tauri.properties is, with the stream closed
    expect(gradle).toMatch(/keystorePropertiesFile\.inputStream\(\)\.use \{ load\(it\) \}/);
  });

  it("declares a release signing config from the keys the keystore script writes", () => {
    expect(gradle).toMatch(/signingConfigs\s*\{[\s\S]*?create\("release"\)/);
    const written = propertiesText({ storeFile: "k.jks", password: "p", alias: "a" });
    for (const key of ["storeFile", "keyAlias", "storePassword", "keyPassword"]) {
      expect(written).toMatch(new RegExp(`^${key}=`, "m"));
      expect(gradle).toContain(`keystoreProperty("${key}")`);
    }
    // the store file is resolved against the Android project root, where the script writes it
    expect(gradle).toMatch(/storeFile = rootProject\.file\(keystoreProperty\("storeFile"\)\)/);
    // a half-written properties file fails the build with the key named, never silently
    expect(gradle).toMatch(/fun keystoreProperty\(name: String\): String/);
    expect(gradle).toMatch(/getProperty\(name\)\s*\?:\s*error\(/);
  });

  it("signs the release build type with it and says so when the file is missing", () => {
    expect(releaseBlock).toMatch(
      /signingConfig\s*=\s*[^\n]*signingConfigs\.getByName\("release"\)/,
    );
    expect(releaseBlock).toMatch(/logger\.warn\(/);
    expect(releaseBlock).toContain("scripts/android-keystore.mjs");
  });

  it("keeps the Tauri-generated content intact", () => {
    expect(gradle).toContain('id("rust")');
    expect(gradle).toContain('file("tauri.properties")');
    expect(gradle).toContain('apply(from = file("tauri.build.gradle.kts"))');
    expect(gradle).toContain('rootDirRel = "../../../"');
    expect(gradle).toContain('namespace = "app.forerunner.mobile"');
    // the debug build type stays as generated (debug key, debuggable, JNI symbols kept)
    const debugBlock = gradle.slice(
      gradle.indexOf('getByName("debug")'),
      gradle.indexOf('getByName("release")'),
    );
    expect(debugBlock).toContain("isDebuggable = true");
    expect(debugBlock).not.toContain("signingConfig");
  });

  it("never carries a password or a store path itself", () => {
    expect(gradle).not.toMatch(/(?:storePassword|keyPassword)\s*=\s*"/);
    expect(gradle).not.toMatch(/\.jks/);
  });
});

describe("the workflows verify the release APK signature", () => {
  for (const workflow of ["android.yml", "release.yml"]) {
    it(`${workflow}: keystore, then the build, then apksigner through scripts/android-apk-verify.mjs`, () => {
      const text = read(".github", "workflows", workflow);
      const keystore = text.indexOf("node scripts/android-keystore.mjs");
      const build = text.indexOf("tauri android build --apk");
      const verify = text.indexOf("node scripts/android-apk-verify.mjs");
      expect(keystore).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(keystore);
      expect(verify).toBeGreaterThan(build);
      // the verify step is a plain run step (no `continue-on-error`, no `if:` that could skip it)
      const step = text.slice(
        text.lastIndexOf("\n      - ", verify),
        text.indexOf("\n      - ", verify),
      );
      expect(step).not.toMatch(/continue-on-error|\bif:/);
      // the artefact upload comes after the verification, so an unsigned APK is never uploaded
      expect(text.indexOf("upload-artifact", verify)).toBeGreaterThan(verify);
      // build-tools (apksigner) are installed by the job
      expect(text).toContain("build-tools;34.0.0");
    });
  }
});
