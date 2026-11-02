import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { afterAll, describe, expect, it } from "vitest";
import { GitDiffPort } from "../src/loop/critic.ts";
import { ProcessSandbox } from "../src/sandbox/process.ts";

/**
 * What the critic and the person read of a command is plain text (CI on c8c16fb: a tried
 * command's `console.log(9)` reached the evidence as "\x1b[33m9\x1b[39m" because ci.yml sets
 * FORCE_COLOR=1). These are the siblings at the runtime's own edges: the process sandbox every
 * tried command, check and specialist command runs in, and the diff the critic reads.
 */
const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});
const folder = (prefix: string) => {
  const f = mkdtempSync(join(tmpdir(), prefix));
  folders.push(f);
  return f;
};

describe("plain output: the process sandbox", () => {
  it("a command gets neither the host's forced colour nor its NO_COLOR choice, but NO_COLOR=1; a run that sets a colour variable itself keeps it", async () => {
    const sandbox = await ProcessSandbox.create({
      worktree: folder("fr plain sandbox "),
      limits: { timeoutMs: 30_000 },
      network: { mode: "none" },
      baseEnv: { ...process.env, FORCE_COLOR: "1", CLICOLOR_FORCE: "1", PY_COLORS: "1" },
    });
    try {
      const env = sandbox.envFor();
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.CLICOLOR_FORCE).toBeUndefined();
      expect(env.PY_COLORS).toBeUndefined();
      expect(env.NO_COLOR).toBe("1");
      expect(env.PATH ?? env.Path).toBeTruthy();
      expect(sandbox.envFor({ FORCE_COLOR: "3" }).FORCE_COLOR).toBe("3");
      const r = await sandbox.run([process.execPath, "-e", "console.log(9)"]);
      expect(r.stdout).toBe("9\n");
    } finally {
      await sandbox.destroy();
    }
  });
});

describe("plain output: the diff the critic reads", () => {
  it("a person whose git colours everything (color.ui=always) still gives the critic a plain diff", async () => {
    const dir = folder("fr-plain-diff-");
    const git = (...args: string[]) =>
      run(["git", "-c", "user.name=t", "-c", "user.email=t@x.test", ...args], { cwd: dir });
    await git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "clamp.js"), "export const clamp = (x) => x;\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "before the task");
    // The repository's config stands in for the person's own (global) one.
    await git("config", "color.ui", "always");
    await git("config", "color.diff", "always");
    writeFileSync(
      join(dir, "clamp.js"),
      "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n",
    );
    const diff = await new GitDiffPort(run).diffFor({ id: "t1" } as TaskRow, dir);
    expect(diff?.changedFiles).toEqual(["clamp.js"]);
    expect(diff?.diff).toContain(
      "+export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));",
    );
    expect(diff?.diff).not.toContain("\u001b");
  });
});
