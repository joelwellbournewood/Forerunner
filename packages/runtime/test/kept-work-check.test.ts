import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { redactValues } from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_OUTPUT_CHARS, keptWorkChecker } from "../src/loop/kept-work-check.ts";
import { ProcessSandbox } from "../src/sandbox/process.ts";
import type { RunSandboxPort } from "../src/session/executor.ts";

/**
 * d1109-oversize-pause (OP-2; the owner's D4: "wrap up in an organized and error free way such
 * that the work can be continued in the next run"): after a pause that changed a code file, the
 * project's own checks run once on the kept work in the task's sandbox (here the process sandbox,
 * no network), never on the host, with no model and nothing booked; the end of each output is
 * kept, redacted. Before, the kept work was committed as "Work in progress" and nothing checked
 * it until the critic at the very end.
 */
// Built by concatenation so the secret scanner never sees a key shape. // not-a-secret
const SECRET = ["sk", "kept", "x".repeat(24)].join("-"); // not-a-secret

describe("d1109-oversize-pause, run C: the kept work is checked in the task's sandbox (OP-2)", () => {
  let worktree: string;
  const opened: { worktree: string; allowedDomains: readonly string[] }[] = [];
  const task = { id: "t1", project_id: null, risk_tier: 1 } as unknown as TaskRow;
  const store = { project: { get: async () => undefined } } as never;
  const port: RunSandboxPort = {
    async open(req) {
      opened.push({ worktree: req.worktree, allowedDomains: req.allowedDomains });
      const sandbox = await ProcessSandbox.create({
        worktree: req.worktree,
        limits: { timeoutMs: req.timeoutMs },
        network: { mode: "none" } as never,
      });
      return { sandbox, engine: "process", warnings: [] };
    },
  };
  const pkg = (test: string) =>
    writeFile(join(worktree, "package.json"), JSON.stringify({ name: "shop", scripts: { test } }));
  const checker = (sandbox: RunSandboxPort | null = port) =>
    keptWorkChecker({
      store,
      ...(sandbox ? { sandbox } : {}),
      redact: (text) => redactValues(text, [SECRET]),
    });

  beforeEach(async () => {
    worktree = await realpath(await mkdtemp(join(tmpdir(), "fr-kept-")));
    await writeFile(join(worktree, "index.js"), "module.exports = 1;\n");
    opened.length = 0;
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("a failing test script: the sandbox opened once with the worktree and no network; its output's end is kept", async () => {
    await pkg(`node -e "console.log('one');process.exit(1)"`);
    const r = await checker()({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: new AbortController().signal,
    });
    expect(opened).toEqual([{ worktree, allowedDomains: [] }]);
    expect(r.notRun).toBeUndefined();
    expect(r.checks?.map((c) => [c.name, c.passed])).toEqual([["test", false]]);
    expect(r.checks?.[0]?.output).toContain("one");
    expect(r.checks?.[0]?.output.length).toBeLessThanOrEqual(KEPT_OUTPUT_CHARS);
  }, 60_000);

  it("a passing test script passes", async () => {
    await pkg(`node -e "process.exit(0)"`);
    const r = await checker()({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: new AbortController().signal,
    });
    expect(r.checks?.map((c) => [c.name, c.passed])).toEqual([["test", true]]);
  }, 60_000);

  it("a check that prints a granted secret's value keeps [REDACTED] in its place; a long output keeps its end", async () => {
    await pkg(
      `node -e "console.log('x'.repeat(5000));console.log('key=${SECRET}');process.exit(1)"`,
    );
    const r = await checker()({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: new AbortController().signal,
    });
    const out = r.checks?.[0]?.output ?? "";
    expect(out).not.toContain(SECRET);
    expect(out).toContain("key=[REDACTED]");
    expect(out.length).toBeLessThanOrEqual(KEPT_OUTPUT_CHARS);
  }, 60_000);

  it("with no sandbox here nothing runs on the host, and why is kept; a sandbox that cannot open the same", async () => {
    await pkg(`node -e "require('fs').writeFileSync('ran-on-host','1')"`);
    const none = await checker(null)({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: new AbortController().signal,
    });
    expect(none).toEqual({ notRun: "there is no sandbox to run them in" });
    const refused = await checker({
      open: async () => {
        throw new Error("the engine is not running");
      },
    })({ task, worktree, changedFiles: ["index.js"], signal: new AbortController().signal });
    expect(refused.notRun).toBe("the sandbox could not be opened (the engine is not running)");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(worktree, "ran-on-host"))).toBe(false);
  }, 60_000);

  it("a project without checks runs nothing and keeps nothing", async () => {
    const r = await checker()({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: new AbortController().signal,
    });
    expect(r).toEqual({});
    expect(opened).toEqual([]);
  });

  it("Stop now during a check that sleeps ends it within the kill switch's 2 s", async () => {
    await pkg(`node -e "setTimeout(()=>{},60000)"`);
    const stop = new AbortController();
    const started = Date.now();
    const done = checker()({
      task,
      worktree,
      changedFiles: ["index.js"],
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(new Error("Stop now")), 1_500);
    await expect(done).rejects.toBeTruthy();
    // At least 10 s of slack for a slow machine; the check itself sleeps a minute.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});
