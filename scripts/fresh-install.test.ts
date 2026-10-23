import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const scriptsDir = join(repoRoot, "scripts");
const isWindows = process.platform === "win32";
const hasBash = !isWindows && spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
const hasPwsh =
  spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
  }).status === 0;

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-install-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function bash(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("bash", args, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("fresh-install.sh", () => {
  it.skipIf(!hasBash)("passes bash -n and prints usage with --help", () => {
    expect(bash(["-n", join(scriptsDir, "fresh-install.sh")]).status).toBe(0);
    const r = bash([join(scriptsDir, "fresh-install.sh"), "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--non-interactive");
    expect(r.stdout).toContain("--dry-run");
    expect(r.stdout).not.toContain("set -Eeuo");
  });

  it.skipIf(!hasBash)(
    "dry run from the checkout lists every step, runs nothing and exits 0",
    () => {
      const r = bash([join(scriptsDir, "fresh-install.sh"), "--non-interactive", "--dry-run"]);
      expect(r.status, r.stderr).toBe(0);
      for (let n = 1; n <= 8; n++) expect(r.stdout).toContain(`[${n}/8]`);
      expect(r.stdout).toContain("would run: pnpm install --frozen-lockfile");
      expect(r.stdout).toContain("would run: pnpm typecheck");
      expect(r.stdout).toContain("would run: pnpm test:unit");
      expect(r.stdout).toContain(
        "would run: pnpm fr setup --non-interactive --profile install-check",
      );
      expect(r.stdout).toContain("using the checkout this script lives in");
      expect(r.stdout).toContain("fresh install summary");
      expect(r.stdout).toContain("budget 900s");
      expect(r.stdout).toContain("dry run complete");
      // each step reports elapsed seconds
      expect(r.stdout).toMatch(/ok in \d+s \(total \d+s\)/);
    },
  );

  it.skipIf(!hasBash)("Linux Tauri libraries are only installed with --with-desktop", () => {
    const without = bash([join(scriptsDir, "fresh-install.sh"), "--non-interactive", "--dry-run"]);
    expect(without.stdout).toContain("skipped (pass --with-desktop");
    const withDesktop = bash([
      join(scriptsDir, "fresh-install.sh"),
      "--non-interactive",
      "--dry-run",
      "--with-desktop",
    ]);
    expect(withDesktop.status, withDesktop.stderr).toBe(0);
    expect(withDesktop.stdout).toContain("libwebkit2gtk-4.1-dev");
  });

  it.skipIf(!hasBash)(
    "outside a checkout without FORERUNNER_REPO_URL it explains how and exits 2",
    () => {
      const dir = tempDir();
      const home = join(dir, "home");
      mkdirSync(home);
      copyFileSync(join(scriptsDir, "fresh-install.sh"), join(dir, "fresh-install.sh"));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.FORERUNNER_REPO_URL;
      delete env.FORERUNNER_INSTALL_DIR;
      const r = bash(["./fresh-install.sh", "--non-interactive", "--dry-run"], { cwd: dir, env });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("FORERUNNER_REPO_URL=");
      expect(r.stderr).not.toMatch(/github\.com\/[A-Za-z0-9-]+\//); // nothing hardcoded to an org
    },
  );

  it.skipIf(!hasBash)(
    "outside a checkout with FORERUNNER_REPO_URL it would clone into FORERUNNER_INSTALL_DIR",
    () => {
      const dir = tempDir();
      const home = join(dir, "home");
      mkdirSync(home);
      copyFileSync(join(scriptsDir, "fresh-install.sh"), join(dir, "fresh-install.sh"));
      const target = join(dir, "clone-here");
      const r = bash(["./fresh-install.sh", "--non-interactive", "--dry-run"], {
        cwd: dir,
        env: {
          ...process.env,
          HOME: home,
          FORERUNNER_REPO_URL: "https://example.invalid/someone/forerunner.git",
          FORERUNNER_INSTALL_DIR: target,
        },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `would run: git clone --depth 1 https://example.invalid/someone/forerunner.git ${target}`,
      );
      expect(r.stdout).toContain("would run: corepack prepare pnpm@");
    },
  );

  it.skipIf(!hasBash)("rejects unknown options with exit 2", () => {
    expect(bash([join(scriptsDir, "fresh-install.sh"), "--bogus"]).status).toBe(2);
  });
});

describe("dev-postgres.sh", () => {
  it.skipIf(!hasBash)("passes bash -n and prints usage with --help", () => {
    expect(bash(["-n", join(scriptsDir, "dev-postgres.sh")]).status).toBe(0);
    const r = bash([join(scriptsDir, "dev-postgres.sh"), "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FORERUNNER_TEST_PG");
  });

  it.skipIf(!hasBash)(
    "--status on a port where nothing listens exits 1 without starting anything",
    () => {
      const r = bash([join(scriptsDir, "dev-postgres.sh"), "--status"], {
        env: { ...process.env, FORERUNNER_PG_PORT: "1" },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("nothing listens on port 1");
    },
  );
});

describe("PowerShell scripts", () => {
  const reason = "pwsh is not installed; the .ps1 parse check runs where it is (Windows CI)";
  it.skipIf(!hasPwsh)(
    `parse without errors (${reason})`,
    () => {
      for (const name of ["fresh-install.ps1", "dev-postgres.ps1"]) {
        const file = join(scriptsDir, name).replace(/'/g, "''");
        const r = spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-Command",
            `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 } else { exit 0 }`,
          ],
          { encoding: "utf8", timeout: 60_000 },
        );
        expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(0);
      }
    },
    120_000,
  );

  it.skipIf(!hasPwsh)(
    `fresh-install.ps1 -DryRun -NonInteractive lists every step and exits 0 (${reason})`,
    () => {
      const r = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          join(scriptsDir, "fresh-install.ps1"),
          "-NonInteractive",
          "-DryRun",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      for (let n = 1; n <= 8; n++) expect(r.stdout).toContain(`[${n}/8]`);
      expect(r.stdout).toContain("would run: pnpm install --frozen-lockfile");
      expect(r.stdout).toContain("dry run complete");
    },
    // A cold Windows runner takes well over the 20 s default to start pwsh and run the dry run
    // (CI run 95 timed out at 20 s); the spawn itself is bounded at 120 s above.
    180_000,
  );
});
