import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The one-click release (publish-release.sh / .cmd): it tags the branch head with the version
 * the branch carries and pushes the tag, after checking the changelog and that the tag is new.
 * Run against a local bare repository standing in for GitHub.
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "publish-release.sh");
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare "origin" whose `main` carries `version` and, when `changelog`, its section. */
function origin(version: string, changelog: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "fr-publish-"));
  temps.push(root);
  const bare = join(root, "origin.git");
  const src = join(root, "src");
  git(root, "init", "--quiet", "--bare", bare);
  git(root, "init", "--quiet", "-b", "main", src);
  writeFileSync(join(src, "package.json"), `{\n  "name": "x",\n  "version": "${version}",\n}\n`);
  writeFileSync(
    join(src, "CHANGELOG.md"),
    changelog ? `# Changelog\n\n## [${version}] - 2026-10-30\n` : "# Changelog\n",
  );
  git(src, "add", ".");
  git(src, "-c", "user.name=t", "-c", "user.email=t@x.test", "commit", "--quiet", "-m", "release");
  git(src, "push", "--quiet", bare, "main");
  return bare;
}

function publish(repo: string) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORERUNNER_REPO: repo,
      FORERUNNER_BRANCH: "main",
      FORERUNNER_YES: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "t",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "t@x.test",
    },
  });
}

describe.skipIf(process.platform === "win32")("publish-release", () => {
  it("pushes v<version> on the branch head, once", () => {
    const repo = origin("9.9.9", true);
    const first = publish(repo);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Pushed v9.9.9");
    expect(git(repo, "rev-parse", "v9.9.9^{commit}")).toBe(git(repo, "rev-parse", "main"));
    const again = publish(repo);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain("v9.9.9 already exists");
  });

  it("refuses a branch whose changelog has no section for the version", () => {
    const repo = origin("9.9.8", false);
    const r = publish(repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("CHANGELOG.md has no [9.9.8] section");
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", "v9.9.8"], { cwd: repo }).status,
    ).toBe(1);
  });

  it("the Windows script makes the same checks", () => {
    const cmd = readFileSync(join(here, "publish-release.cmd"), "utf8");
    for (const step of [
      "CHANGELOG.md has no",
      "already exists",
      "git push --quiet origin",
      "claude/forerunner-1-0-build-o53s04",
    ])
      expect(cmd).toContain(step);
  });
});
