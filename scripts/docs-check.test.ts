import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform/paths";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { evaluate } from "./docs-check.mjs";

describe("docs-check", () => {
  it("passes when the module doc is touched", () => {
    const r = evaluate(["packages/runtime/src/hooks.ts", "docs/maintainers/runtime.md"], "");
    expect(r.ok).toBe(true);
  });
  it("fails when a module changes without its doc", () => {
    const r = evaluate(["packages/billing/src/router.ts"], "");
    expect(r.ok).toBe(false);
    expect(r.missing[0].docs).toContain("docs/maintainers/billing.md");
  });
  it("ignores test-only changes", () => {
    expect(evaluate(["packages/billing/test/router.test.ts"], "").ok).toBe(true);
  });
  it("accepts an explicit waiver with a reason", () => {
    expect(evaluate(["packages/billing/src/router.ts"], "docs: none needed: comment typo").ok).toBe(
      true,
    );
    expect(evaluate(["packages/billing/src/router.ts"], "docs: none needed").ok).toBe(false);
  });

  it("is not waived by the pull request template left as it is", () => {
    const template = readFileSync(
      join(process.cwd(), ".github", "pull_request_template.md"),
      "utf8",
    );
    expect(evaluate(["packages/billing/src/router.ts"], template).ok).toBe(false);
  });

  // l4-selftasks-carried (L4-selftasks-125's rest, L4f-left-7): in a worktree or a clone without
  // origin/main the check printed git's "fatal: ambiguous argument" and a multi-line error, then
  // "nothing to check", and passed. It says now that nothing was checked and what it needs.
  it("says what it needs when origin/main is not there, and checks with --base", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-docs-check-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "work");
    git(
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    );
    git("branch", "start");
    writeFileSync(join(dir, "x.md"), "x\n");
    git("add", "x.md");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "x");
    const script = join(process.cwd(), "scripts", "docs-check.mjs");
    const { DOCS_CHECK_BASE: _unset, ...env } = process.env;
    const bare = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env });
    expect(bare.status).toBe(0);
    expect(bare.stderr).toBe("");
    expect(bare.stdout.trim()).toBe(
      "docs-check: nothing was checked: origin/main is not in this checkout (a worktree, or a clone without that branch). Name the branch this work started from: pnpm docs:check --base <branch>, or set DOCS_CHECK_BASE.",
    );
    const based = spawnSync(process.execPath, [script, "--base", "start"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(based.status).toBe(0);
    expect(based.stdout.trim()).toBe("docs-check: ok (1 file).");
  });
});
