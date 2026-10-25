import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { APP_VERSION } from "../packages/runtime/src/cli/main.ts";
import {
  CARGO_FILES,
  coreVersion,
  JSON_FILES,
  readVersions,
  readWixVersion,
  setVersion,
  // @ts-expect-error plain JS module
} from "./release-version.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "release-version.mjs");
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A copy of just the version-carrying files of this repository. */
function copyOfVersionFiles(): string {
  const root = mkdtempSync(join(tmpdir(), "fr-release-version-"));
  temps.push(root);
  for (const f of [...JSON_FILES, ...CARGO_FILES]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(repoRoot, f), join(root, f));
  }
  return root;
}

describe("release-version: one app version, equal to the tag", () => {
  it("the repository's version files agree, and the daemon and fr report that version", () => {
    const versions = readVersions(repoRoot);
    const distinct = new Set(versions.map((v: { version: string | null }) => v.version));
    expect(distinct.size, JSON.stringify(versions)).toBe(1);
    const [only] = [...distinct];
    expect(APP_VERSION).toBe(only);
    expect(readWixVersion(repoRoot)).toBe(coreVersion(String(only)));
  });

  it("the core version strips a pre-release and build suffix; anything else is refused", () => {
    expect(coreVersion("v1.0.0")).toBe("1.0.0");
    expect(coreVersion("v1.0.0-rc.2")).toBe("1.0.0");
    expect(coreVersion("2.3.4+build.5")).toBe("2.3.4");
    expect(() => coreVersion("release-1")).toThrow(/not a version/);
    expect(() => coreVersion("v1.0")).toThrow(/not a version/);
  });

  it("--set writes every file, leaves dependency versions and formatting alone, and --check passes", () => {
    const root = copyOfVersionFiles();
    const cargoBefore = readFileSync(join(root, CARGO_FILES[0] as string), "utf8");
    setVersion(root, "7.8.9");
    expect(new Set(readVersions(root).map((v: { version: string | null }) => v.version))).toEqual(
      new Set(["7.8.9"]),
    );
    expect(readWixVersion(root)).toBe("7.8.9");
    const cargoAfter = readFileSync(join(root, CARGO_FILES[0] as string), "utf8");
    // Only the [package] version line changed.
    const changed = cargoAfter.split("\n").filter((l, i) => l !== cargoBefore.split("\n")[i]);
    expect(changed).toEqual(['version = "7.8.9"']);
    const pkg = readFileSync(join(root, "package.json"), "utf8");
    expect(pkg).toContain('"version": "7.8.9"');
    const r = spawnSync(process.execPath, [script, "--check", "--root", root], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("7.8.9 everywhere");
  });

  it("--check fails when one file disagrees; --set from a pre-release tag writes it everywhere and the core into the MSI", () => {
    const root = copyOfVersionFiles();
    const conf = join(root, "apps", "mobile", "src-tauri", "tauri.conf.json");
    const j = JSON.parse(readFileSync(conf, "utf8"));
    j.version = "0.0.1";
    writeFileSync(conf, JSON.stringify(j, null, 2));
    const bad = spawnSync(process.execPath, [script, "--check", "--root", root], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/disagree/);
    const set = spawnSync(process.execPath, [script, "--set", "v3.0.0-rc.1", "--root", root], {
      encoding: "utf8",
    });
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain("3.0.0-rc.1 everywhere");
    expect(readWixVersion(root)).toBe("3.0.0");
    const junk = spawnSync(process.execPath, [script, "--set", "release-7", "--root", root], {
      encoding: "utf8",
    });
    expect(junk.status).toBe(1);
  });

  it("--check --expect <tag> fails unless the committed version is the tag's", () => {
    const root = copyOfVersionFiles();
    setVersion(root, "1.0.0-rc.2");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, "--check", "--root", root, ...args], {
        encoding: "utf8",
      });
    expect(run("--expect", "v1.0.0-rc.2").status).toBe(0);
    const wrong = run("--expect", "v1.0.0");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/1\.0\.0-rc\.2.*v1\.0\.0|tag v1\.0\.0/);
    expect(run("--expect", "").status).toBe(1);
  });

  it("release.yml refuses a tag the committed version does not match, in bash, before both builds", () => {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    for (const build of [
      "pnpm --filter @forerunner/desktop tauri build",
      "pnpm --filter @forerunner/mobile tauri android build",
    ]) {
      const at = wf.indexOf(build);
      expect(at, build).toBeGreaterThan(-1);
      const jobStart = wf.lastIndexOf("\n  ", wf.lastIndexOf("runs-on:", at));
      const step = wf.indexOf(
        'node scripts/release-version.mjs --check --expect "$GITHUB_REF_NAME"',
        jobStart,
      );
      expect(step, `check before: ${build}`).toBeGreaterThan(-1);
      expect(step).toBeLessThan(at);
      // $GITHUB_REF_NAME is a bash expansion: the Windows runner's default shell is pwsh, where
      // it would be an empty PowerShell variable (review of d36c154).
      const block = wf.slice(wf.lastIndexOf("\n      - ", step), step);
      expect(block, `shell of the check before ${build}`).toMatch(/\n {8}shell: bash\n/);
    }
    // The runner image is tagged with the version too: it is checked before it is built.
    const image = wf.indexOf("docker/build-push-action");
    const imageCheck = wf.indexOf(
      'node scripts/release-version.mjs --check --expect "$GITHUB_REF_NAME"',
      wf.lastIndexOf("runner-image:", image),
    );
    expect(imageCheck).toBeGreaterThan(-1);
    expect(imageCheck).toBeLessThan(image);
  });
});
