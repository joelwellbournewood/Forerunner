import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, type RunOptions, type RunResult, run } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { GitOps, gitConfigEnv, redactToken } from "../src/githost/git.ts";

const identity = { name: "Test", email: "test@example.test" };

async function bareRepo(): Promise<{ bare: string; url: string }> {
  const root = mkdtempSync(join(tmpdir(), "fr-git-"));
  const bare = join(root, "remote.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  // Seed main through a scratch clone.
  const seed = join(root, "seed");
  const g = new GitOps({ cwd: seed, identity });
  await g.clone(bare);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  await g.commitAll("seed");
  await g.push("main");
  return { bare, url: bare };
}

// Dozens of git subprocesses: the Windows runner needs well over the 20 s default under load.
describe("GitOps", { timeout: 120_000 }, () => {
  it("clones, branches, commits, rebases and pushes; conflicts are reported and aborted", async () => {
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const a = new GitOps({ cwd: join(root, "a"), identity });
    const b = new GitOps({ cwd: join(root, "b"), identity });
    await a.clone(url);
    await b.clone(url);
    expect(await a.currentBranch()).toBe("main");

    // b changes main.
    writeFileSync(join(root, "b", "README.md"), "# seed\nfrom b\n");
    await b.commitAll("b: edit readme");
    await b.push("main");

    // a works on a branch with a non-conflicting file, rebases before the PR.
    await a.createBranch("feat/x");
    writeFileSync(join(root, "a", "x.txt"), "x\n");
    const c = await a.commitAll("a: add x");
    expect(c.committed).toBe(true);
    await a.fetch();
    const rb = await a.rebaseOnto("origin/main");
    expect(rb.ok).toBe(true);
    expect(await a.changedFiles("origin/main")).toEqual(["x.txt"]);
    await a.push("feat/x");
    expect((await b.log(1))[0]?.subject).toBe("b: edit readme");

    // a conflicting change is reported with the file and the tree is left clean.
    await a.createBranch("feat/y", "origin/main");
    writeFileSync(join(root, "a", "README.md"), "# seed\nfrom a\n");
    await a.commitAll("a: conflicting readme");
    writeFileSync(join(root, "b", "README.md"), "# seed\nfrom b again\n");
    await b.commitAll("b: readme again");
    await b.push("main");
    await a.fetch();
    const conflict = await a.rebaseOnto("origin/main");
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(["README.md"]);
    expect((await a.status()).dirty).toBe(false);
    expect(await a.currentBranch()).toBe("feat/y");
  });

  it("passes the token to git through the environment, never on the command line", async () => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner = async (argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> => {
      calls.push({ argv: [...argv], env: opts.env ?? {} });
      return {
        code: 0,
        signal: null,
        stdout: "main\n",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 1,
      };
    };
    const token = "ghp_testtokenvalueXXXXXXXXXXXXXXXXXXXXXXXX"; // not-a-secret
    const g = new GitOps({ cwd: join(tmpdir(), "nope"), auth: { token }, identity, runner });
    await g.clone("http://127.0.0.1:1/acme/service.git");
    expect(calls).toHaveLength(1);
    const [clone] = calls;
    if (!clone) throw new Error("no git call recorded");
    expect(clone.argv.join(" ")).not.toContain(token);
    expect(clone.argv).not.toContain("http.extraheader");
    const count = Number(clone.env.GIT_CONFIG_COUNT);
    expect(count).toBeGreaterThanOrEqual(1);
    const slot = [...Array(count).keys()].find(
      (i) => clone.env[`GIT_CONFIG_KEY_${i}`] === "http.extraheader",
    );
    expect(slot).toBeDefined();
    expect(clone.env[`GIT_CONFIG_VALUE_${slot}`]).toBe(`AUTHORIZATION: bearer ${token}`);
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe("0");
    // Without a token nothing about http.extraheader reaches git.
    calls.length = 0;
    await new GitOps({ cwd: join(tmpdir(), "nope"), identity, runner }).clone("http://x/y.git");
    const bare = calls[0]?.env ?? {};
    expect(Object.values(bare).some((v) => v === "http.extraheader")).toBe(false);
    expect(Object.values(bare).some((v) => /bearer/i.test(v ?? ""))).toBe(false);
    // A caller's own GIT_CONFIG_* entries are kept; ours is appended after them.
    const env = gitConfigEnv(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" },
      "http.extraheader",
      "AUTHORIZATION: bearer x",
    );
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "http.extraheader",
      GIT_CONFIG_VALUE_1: "AUTHORIZATION: bearer x",
    });
    expect(gitConfigEnv({ GIT_CONFIG_COUNT: "junk" }, "a.b", "c")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
    });
  });

  it("reads the remote default branch and lists local branches by prefix", async () => {
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const g = new GitOps({ cwd: join(root, "c"), identity });
    await g.clone(url);
    expect(await g.remoteDefaultBranch()).toBe("main");
    await g.createBranch("forerunner/migration-2026-01-01", "origin/main");
    await g.createBranch("forerunner/migration-2026-02-01", "origin/main");
    await g.createBranch("other/branch", "origin/main");
    expect(await g.localBranches("forerunner/migration-")).toEqual([
      "forerunner/migration-2026-01-01",
      "forerunner/migration-2026-02-01",
    ]);
    expect(await g.localBranches("nothing/")).toEqual([]);
  });

  it("never force-pushes the default branch and redacts tokens from errors", async () => {
    const g = new GitOps({ cwd: join(tmpdir(), "nope"), auth: { token: "secret-token" } });
    await expect(g.push("main", { force: true, defaultBranch: "main" })).rejects.toMatchObject({
      code: "autonomy_insufficient",
    });
    expect(redactToken("fatal: Authorization: bearer secret-token failed", "secret-token")).toBe(
      "fatal: Authorization: bearer [REDACTED] failed",
    );
    expect(GitOps.worktreePath(join("r"), "task/1:ä")).toBe(join("r", "task-1--"));
  });
});
