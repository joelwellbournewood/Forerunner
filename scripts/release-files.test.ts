import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  checksums,
  publishReleaseFiles,
  releaseFiles,
  SUMS_FILE,
  // @ts-expect-error plain JS module
} from "./release-files.mjs";

// rc.3's publish job uploaded every file under artifacts/ (the Linux bundle tree: hundreds of
// .so files, icons, `copyright`) and hit GitHub's secondary rate limit before the APK was
// uploaded (run 40248159390). The release publishes the installers, the APK, the signed manifest
// and the sums, nothing else.

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string[], body: string): void {
  const file = join(root, ...rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/** The downloaded layout of a release run, with the bundle debris rc.3 carried. */
function artifactsTree(opts: { manifest?: boolean; junk?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-release-files-"));
  temps.push(dir);
  put(dir, ["desktop-windows-latest", "Forerunner_1.0.0_x64_en-US.msi"], "msi");
  put(dir, ["desktop-ubuntu-22.04", "appimage", "Forerunner_1.0.0_amd64.AppImage"], "appimage");
  put(dir, ["desktop-ubuntu-22.04", "deb", "Forerunner_1.0.0_amd64.deb"], "deb");
  put(dir, ["android", "app-universal-release.apk"], "apk");
  if (opts.manifest !== false) put(dir, ["forerunner-release.json"], "{}");
  if (opts.junk !== false) {
    const appDir = ["desktop-ubuntu-22.04", "appimage", "Forerunner.AppDir"];
    put(dir, [...appDir, "usr", "lib", "libwebkit2gtk-4.1.so.0"], "so");
    put(dir, [...appDir, "usr", "share", "icons", "hicolor", "128x128", "apps", "f.png"], "png");
    put(dir, ["desktop-ubuntu-22.04", "deb", "Forerunner_1.0.0_amd64", "data", "copyright"], "c");
    put(dir, ["desktop-ubuntu-22.04", "deb", "Forerunner_1.0.0_amd64", "control.tar.gz"], "t");
    put(dir, ["desktop-ubuntu-22.04", "appimage", "build_appimage.sh"], "sh");
    put(dir, [SUMS_FILE], "stale  SHA256SUMS.txt\n");
  }
  return dir;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("release-files", () => {
  it("picks the three installers, the APK and the signed manifest, nothing from the bundle tree", () => {
    expect(releaseFiles(artifactsTree())).toEqual([
      "android/app-universal-release.apk",
      "desktop-ubuntu-22.04/appimage/Forerunner_1.0.0_amd64.AppImage",
      "desktop-ubuntu-22.04/deb/Forerunner_1.0.0_amd64.deb",
      "desktop-windows-latest/Forerunner_1.0.0_x64_en-US.msi",
      "forerunner-release.json",
    ]);
  });

  it("publishes without the manifest when there is no signing key (the step is skipped)", () => {
    expect(releaseFiles(artifactsTree({ manifest: false }))).not.toContain(
      "forerunner-release.json",
    );
  });

  it("refuses a release missing an installer or the APK", () => {
    for (const missing of [".msi", ".AppImage", ".deb", ".apk"]) {
      const dir = artifactsTree();
      const victim = releaseFiles(dir).find((f: string) => f.endsWith(missing));
      rmSync(join(dir, ...victim.split("/")));
      expect(() => releaseFiles(dir), missing).toThrow(new RegExp(`no \\*\\${missing} file`));
    }
  });

  it("refuses two files with the same name (GitHub release assets are flat)", () => {
    const dir = artifactsTree();
    put(dir, ["android", "other", "app-universal-release.apk"], "apk2");
    expect(() => releaseFiles(dir)).toThrow(/app-universal-release\.apk/);
  });

  it("sums every published file by the name it is published under, never the sums file", () => {
    const dir = artifactsTree();
    const text = checksums(dir, releaseFiles(dir));
    expect(text.trimEnd().split("\n")).toEqual([
      `${sha("appimage")}  Forerunner_1.0.0_amd64.AppImage`,
      `${sha("deb")}  Forerunner_1.0.0_amd64.deb`,
      `${sha("msi")}  Forerunner_1.0.0_x64_en-US.msi`,
      `${sha("apk")}  app-universal-release.apk`,
      `${sha("{}")}  forerunner-release.json`,
    ]);
    expect(text).not.toContain(SUMS_FILE);
  });

  it("writes the sums and hands the workflow exactly those files plus the sums", () => {
    const dir = artifactsTree();
    const outDir = mkdtempSync(join(tmpdir(), "fr-release-out-"));
    temps.push(outDir);
    const output = join(outDir, "github-output");
    writeFileSync(output, "earlier=1\n");
    const list = publishReleaseFiles("artifacts", { GITHUB_OUTPUT: output }, dir);
    expect(list).toEqual([
      "artifacts/android/app-universal-release.apk",
      "artifacts/desktop-ubuntu-22.04/appimage/Forerunner_1.0.0_amd64.AppImage",
      "artifacts/desktop-ubuntu-22.04/deb/Forerunner_1.0.0_amd64.deb",
      "artifacts/desktop-windows-latest/Forerunner_1.0.0_x64_en-US.msi",
      "artifacts/forerunner-release.json",
      "artifacts/SHA256SUMS.txt",
    ]);
    const sums = readFileSync(join(dir, SUMS_FILE), "utf8");
    expect(sums).not.toContain("stale");
    expect(sums.trimEnd().split("\n")).toHaveLength(5);
    const written = readFileSync(output, "utf8");
    expect(written.startsWith("earlier=1\n")).toBe(true);
    const m = written.match(/files<<(\S+)\n([\s\S]*?)\n\1\n$/);
    expect(m, written).not.toBeNull();
    expect(m?.[2]?.split("\n")).toEqual(list);
  });
});
