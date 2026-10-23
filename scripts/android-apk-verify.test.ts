import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareVersions,
  DEBUG_CERT_CN,
  findReleaseApks,
  parseVerifyOutput,
  resolveApksigner,
  verifyReleaseApks,
  // @ts-expect-error plain JS module
} from "./android-apk-verify.mjs";

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-apk-verify-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A fake SDK with build-tools versions, each holding an apksigner launcher. */
function fakeSdk(versions: string[], exe = "apksigner"): string {
  const sdk = tempDir();
  for (const v of versions) {
    mkdirSync(join(sdk, "build-tools", v), { recursive: true });
    writeFileSync(join(sdk, "build-tools", v, exe), "");
  }
  return sdk;
}

/** A fake apk output tree like gen/android/app/build/outputs/apk. */
function fakeApkRoot(files: string[][]): string {
  const root = tempDir();
  for (const parts of files) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...parts), "PK");
  }
  return root;
}

const SIGNED_OUTPUT = [
  "Verifies",
  "Verified using v1 scheme (JAR signing): true",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): true",
  "Verified using v4 scheme (APK Signature Scheme v4): false",
  "Number of signers: 1",
  "Signer #1 certificate DN: CN=Forerunner development key, O=Forerunner, C=CH",
  "Signer #1 certificate SHA-256 digest: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  "Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567",
  "Signer #1 certificate MD5 digest: 0123456789abcdef0123456789abcdef",
].join("\n");

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };

function fakeSpawn(
  reply: (apk: string) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  },
) {
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const r = reply(args[args.length - 1] ?? "");
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status, error: r.error };
  };
  return { spawn, calls };
}

describe("android-apk-verify helpers", () => {
  it("orders build-tools versions numerically, release candidates below the release", () => {
    const sorted = ["34.0.0", "9.0.0", "33.0.2", "34.0.0-rc4", "35.0.1"].sort(compareVersions);
    expect(sorted).toEqual(["9.0.0", "33.0.2", "34.0.0-rc4", "34.0.0", "35.0.1"]);
  });

  it("picks the newest apksigner under ANDROID_HOME, then ANDROID_SDK_ROOT, else the name on PATH", () => {
    const home = fakeSdk(["33.0.2", "34.0.0", "9.0.0"]);
    expect(resolveApksigner({ ANDROID_HOME: home }, "linux")).toBe(
      join(home, "build-tools", "34.0.0", "apksigner"),
    );
    const sdkRoot = fakeSdk(["35.0.1"]);
    expect(resolveApksigner({ ANDROID_HOME: tempDir(), ANDROID_SDK_ROOT: sdkRoot }, "linux")).toBe(
      join(sdkRoot, "build-tools", "35.0.1", "apksigner"),
    );
    expect(resolveApksigner({}, "linux")).toBe("apksigner");
    expect(resolveApksigner({ ANDROID_HOME: join(tempDir(), "missing") }, "linux")).toBe(
      "apksigner",
    );
    const win = fakeSdk(["34.0.0"], "apksigner.bat");
    expect(resolveApksigner({ ANDROID_HOME: win }, "win32")).toBe(
      join(win, "build-tools", "34.0.0", "apksigner.bat"),
    );
    expect(resolveApksigner({}, "win32")).toBe("apksigner.bat");
  });

  it("finds the release APKs under the output tree and leaves debug ones alone", () => {
    const root = fakeApkRoot([
      ["universal", "release", "app-universal-release.apk"],
      ["universal", "debug", "app-universal-debug.apk"],
      ["x86_64", "release", "app-x86_64-release-unsigned.apk"],
      ["x86_64", "release", "output-metadata.json"],
      ["arm64", "release", "notes.txt"],
    ]);
    expect(findReleaseApks(root)).toEqual([
      join(root, "universal", "release", "app-universal-release.apk"),
      join(root, "x86_64", "release", "app-x86_64-release-unsigned.apk"),
    ]);
    expect(findReleaseApks(join(root, "nowhere"))).toEqual([]);
  });

  it("parses the signers and the schemes out of apksigner's verbose output", () => {
    const parsed = parseVerifyOutput(SIGNED_OUTPUT);
    expect(parsed.verifies).toBe(true);
    expect(parsed.schemes).toEqual({ v1: true, v2: true, v3: true, v4: false });
    expect(parsed.signers).toEqual([
      {
        dn: "CN=Forerunner development key, O=Forerunner, C=CH",
        sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      },
    ]);
    const bad = parseVerifyOutput("DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF");
    expect(bad.verifies).toBe(false);
    expect(bad.signers).toEqual([]);
  });
});

describe("verifyReleaseApks", () => {
  it("runs apksigner verify --print-certs on every release APK with an argv array and reports the signer", () => {
    const root = fakeApkRoot([
      ["universal", "release", "app-universal-release.apk"],
      ["universal", "debug", "app-universal-debug.apk"],
    ]);
    const sdk = fakeSdk(["34.0.0"]);
    const { spawn, calls } = fakeSpawn(() => ({ status: 0, stdout: SIGNED_OUTPUT }));
    const lines: string[] = [];
    const results = verifyReleaseApks({
      apkRoot: root,
      env: { ANDROID_HOME: sdk },
      platform: "linux",
      spawn,
      log: (l: string) => lines.push(l),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(join(sdk, "build-tools", "34.0.0", "apksigner"));
    expect(calls[0]?.args).toEqual([
      "verify",
      "--verbose",
      "--print-certs",
      join(root, "universal", "release", "app-universal-release.apk"),
    ]);
    expect(calls[0]?.opts.shell).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]?.signers[0]?.dn).toBe("CN=Forerunner development key, O=Forerunner, C=CH");
    expect(results[0]?.schemes.v2).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("app-universal-release.apk");
    expect(out).toContain("CN=Forerunner development key");
    expect(out).toContain("0f1e2d3c4b5a6978");
    expect(out).toContain("v2");
  });

  it("fails when there is no release APK at all", () => {
    const root = fakeApkRoot([["universal", "debug", "app-universal-debug.apk"]]);
    const { spawn, calls } = fakeSpawn(() => ({ status: 0, stdout: SIGNED_OUTPUT }));
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /no release APK/,
    );
    expect(calls).toHaveLength(0);
  });

  it("fails on an APK apksigner cannot verify (unsigned), with apksigner's reason", () => {
    const root = fakeApkRoot([["universal", "release", "app-universal-release-unsigned.apk"]]);
    const { spawn } = fakeSpawn(() => ({
      status: 1,
      stdout: "DOES NOT VERIFY",
      stderr: "ERROR: Missing META-INF/MANIFEST.MF",
    }));
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /app-universal-release-unsigned\.apk is not a signed APK[\s\S]*DOES NOT VERIFY[\s\S]*MANIFEST\.MF/,
    );
  });

  it("fails on a release APK carrying the Android debug certificate unless allowed", () => {
    const root = fakeApkRoot([["universal", "release", "app-universal-release.apk"]]);
    const debugOutput = SIGNED_OUTPUT.replace(
      "CN=Forerunner development key, O=Forerunner, C=CH",
      `${DEBUG_CERT_CN}, O=Android, C=US`,
    );
    const { spawn } = fakeSpawn(() => ({ status: 0, stdout: debugOutput }));
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /Android debug key[\s\S]*android-keystore\.mjs/,
    );
    const results = verifyReleaseApks({
      apkRoot: root,
      env: {},
      spawn,
      log: () => {},
      allowDebug: true,
    });
    expect(results[0]?.signers[0]?.dn).toContain(DEBUG_CERT_CN);
  });

  it("fails when apksigner exits 0 without naming a signer (a stub, a wrong tool)", () => {
    const root = fakeApkRoot([["universal", "release", "app-universal-release.apk"]]);
    const { spawn } = fakeSpawn(() => ({ status: 0, stdout: "" }));
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /no signer certificate/,
    );
  });

  it("fails on every release APK, not only the first one", () => {
    const root = fakeApkRoot([
      ["arm64", "release", "app-arm64-release.apk"],
      ["x86_64", "release", "app-x86_64-release-unsigned.apk"],
    ]);
    const { spawn, calls } = fakeSpawn((apk) =>
      apk.includes("unsigned")
        ? { status: 1, stdout: "DOES NOT VERIFY" }
        : { status: 0, stdout: SIGNED_OUTPUT },
    );
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /app-x86_64-release-unsigned\.apk/,
    );
    expect(calls).toHaveLength(2);
  });

  it("explains a missing apksigner", () => {
    const root = fakeApkRoot([["universal", "release", "app-universal-release.apk"]]);
    const { spawn } = fakeSpawn(() => ({
      status: null,
      error: new Error("spawnSync apksigner ENOENT"),
    }));
    expect(() => verifyReleaseApks({ apkRoot: root, env: {}, spawn, log: () => {} })).toThrow(
      /apksigner could not be started[\s\S]*ANDROID_HOME/,
    );
  });
});
