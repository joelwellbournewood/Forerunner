import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { planTries, TRY_FOLDER } from "../src/loop/try-plan.ts";
import { COMMAND_KEEPS_RUNNING_MS, runTries } from "../src/loop/try-run.ts";
import { FakeSandbox } from "../src/sandbox/fake.ts";
import { ProcessSandbox } from "../src/sandbox/process.ts";

/**
 * What a try leaves running once it is stopped (validation rule 4): a server try started the
 * task's server, and Stop, a session's end or the try's own time limit must take it down with
 * everything it started. Before, the driver started the server in a process group of its own,
 * the sandbox's kill reached only the driver, and the server kept listening on the person's
 * computer (the review of fix/verification, probe-abort).
 */
const folders: string[] = [];
const pids: number[] = [];
afterAll(() => {
  // A failed case leaves nothing behind for the next one either.
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  folders.push(d);
  return d;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(cond: () => boolean, ms: number, what: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(what());
}

/**
 * A server whose routes answer after 4 s (inside the 5 s a call gets) and that starts a child of
 * its own, as a dev server's watcher does. It writes both process ids outside the task's folder
 * once it listens.
 */
function slowServer(pidFile: string): string {
  return [
    'const { spawn } = require("child_process");',
    'const http = require("http");',
    'const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "http.createServer((req, res) => {",
    '  setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, 4000);',
    "}).listen(process.env.PORT || 3000, () => {",
    `  require("fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, helper.pid]));`,
    "});",
    "",
  ].join("\n");
}

function serverPlan(root: string) {
  return planTries({
    changedFiles: ["slow.js"],
    root,
    brief: {
      title: "Write slow.js",
      outcome: "A tiny HTTP API in slow.js",
      criteria: ["GET /a answers 200", "GET /b answers 200", "GET /c answers 200"],
    },
  });
}

function startedPids(pidFile: string): number[] {
  const list = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
  pids.push(...list);
  return list;
}

describe("a try in the task's sandbox: what it leaves running, how it ends, what is no problem", () => {
  it("stopped while its routes are called (Stop, a session's end): the server and its child are gone, and the stop is a stop, not a failed try", async () => {
    const root = dir("fr try stop ");
    const pidFile = join(dir("fr try pids "), "pids.json");
    writeFileSync(join(root, "slow.js"), slowServer(pidFile));
    const sandbox = await ProcessSandbox.create({
      worktree: root,
      limits: { timeoutMs: 120_000 },
      network: { mode: "none" },
    });
    const stop = new AbortController();
    const ran = runTries(serverPlan(root), {
      sandbox,
      root,
      node: process.execPath,
      signal: stop.signal,
    });
    let settled = false;
    ran.then(
      () => (settled = true),
      () => (settled = true),
    );
    await waitFor(
      () => existsSync(pidFile) || settled,
      20_000,
      () => "the server did not listen within 20 s",
    );
    expect(settled).toBe(false);
    const started = startedPids(pidFile);
    // It is being called now (its first route answers after 4 s): the person stops.
    await new Promise((r) => setTimeout(r, 300));
    stop.abort(new Error("session stopped"));
    await expect(ran).rejects.toThrow(/stopped/);
    await sandbox.destroy();
    await waitFor(
      () => started.every((pid) => !alive(pid)),
      10_000,
      () => `still running 10 s after the stop: ${started.filter(alive).join(", ")}`,
    );
    expect(existsSync(join(root, TRY_FOLDER))).toBe(false);
  }, 60_000);

  it("a command stopped while it runs is a stop, not a command that 'exited with code null'", async () => {
    const root = dir("fr try stop cmd ");
    writeFileSync(join(root, "wait.js"), "setTimeout(() => console.log('done'), 30000);\n");
    const sandbox = await ProcessSandbox.create({
      worktree: root,
      limits: { timeoutMs: 120_000 },
      network: { mode: "none" },
    });
    const plan = planTries({
      changedFiles: ["wait.js"],
      root,
      brief: { title: "Write wait.js", outcome: "", criteria: ["`node wait.js` prints done"] },
    });
    expect(plan.commands.map((c) => c.target)).toEqual(["node wait.js"]);
    const stop = new AbortController();
    const ran = runTries(plan, { sandbox, root, node: process.execPath, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 500));
    stop.abort(new Error("session stopped"));
    await expect(ran).rejects.toThrow(/stopped/);
    await sandbox.destroy();
  }, 60_000);

  it("a server whose program is not installed is not tried, and the review says so (the guard passes the reason on)", async () => {
    const root = dir("fr try missing ");
    writeFileSync(join(root, "app.py"), "print('hi')\n");
    const sandbox = await ProcessSandbox.create({
      worktree: root,
      limits: { timeoutMs: 120_000 },
      network: { mode: "none" },
    });
    const out = await runTries(
      {
        commands: [],
        servers: [
          {
            kind: "server",
            target: "python9 app.py",
            argv: ["python9", "app.py"],
            file: "app.py",
            ports: [],
            routes: [{ path: "/", documented: false }],
            skippedRoutes: [],
            source: "the brief",
            expected: true,
          },
        ],
        notTried: [],
      },
      { sandbox, root, node: process.execPath },
    );
    await sandbox.destroy();
    expect(out).toEqual({
      tried: [],
      notTried: ["python9 app.py was not tried: python9 is not installed where the work is tried"],
    });
  }, 60_000);

  it("a command the brief says keeps running (a watcher) is stopped after a few seconds, and that is no problem", async () => {
    const root = dir("fr try watch ");
    writeFileSync(
      join(root, "watch.js"),
      "console.log('watching ' + process.argv[2]);\nsetInterval(() => {}, 1000);\n",
    );
    const sandbox = await ProcessSandbox.create({
      worktree: root,
      limits: { timeoutMs: 120_000 },
      network: { mode: "none" },
    });
    const plan = planTries({
      changedFiles: ["watch.js"],
      root,
      brief: {
        title: "Write watch.js",
        outcome: "",
        criteria: [
          "`node watch.js <dir>` watches the folder and prints each change until you stop it",
        ],
      },
    });
    expect(plan.commands.map((c) => [c.target, c.keepsRunning])).toEqual([
      ["node watch.js <dir>", true],
    ]);
    const out = await runTries(plan, { sandbox, root, node: process.execPath });
    expect(out.notTried).toEqual([]);
    expect(out.tried[0]).toMatchObject({ ok: true, blocking: false });
    expect(out.tried[0]?.output).toContain(
      `it kept running, as the brief says; it was stopped after ${COMMAND_KEEPS_RUNNING_MS / 1000} s`,
    );
    expect(out.tried[0]?.output).toContain("watching .forerunner-try/sample-folder");
    await sandbox.destroy();
  }, 60_000);

  it("on Windows, a python3 that is only the Microsoft Store's alias (exit 9009) is 'not installed', not a failed command", async () => {
    const root = dir("fr try alias ");
    writeFileSync(join(root, "cli.py"), "import sys\nprint('Hello, ' + sys.argv[1])\n");
    const sandbox = new FakeSandbox({
      worktree: root,
      defaultResult: {
        code: 9009,
        stderr:
          "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.\r\n",
      },
    });
    const plan = planTries({
      changedFiles: ["cli.py"],
      root,
      brief: { title: "Write cli.py", outcome: "", criteria: ["`python3 cli.py <name>` greets"] },
    });
    const out = await runTries(plan, { sandbox, root, node: "node" });
    expect(out).toEqual({
      tried: [],
      notTried: [
        "python3 cli.py <name> was not tried: python3 is not installed where the work is tried",
      ],
    });
  });

  it("out of time (the sandbox's limit): the server and its child are gone, and the review says the try did not finish", async () => {
    const root = dir("fr try limit ");
    const pidFile = join(dir("fr try pids "), "pids.json");
    writeFileSync(join(root, "slow.js"), slowServer(pidFile));
    // A lease whose time limit ends while the server is being called.
    const sandbox = await ProcessSandbox.create({
      worktree: root,
      limits: { timeoutMs: 3_000 },
      network: { mode: "none" },
    });
    const out = await runTries(serverPlan(root), { sandbox, root, node: process.execPath });
    await sandbox.destroy();
    expect(out.tried).toEqual([]);
    expect(out.notTried).toEqual([
      "node slow.js was not tried: the try did not finish (it ran out of time)",
    ]);
    // The driver was killed after the server listened, or before: either way nothing stays.
    if (existsSync(pidFile)) {
      const started = startedPids(pidFile);
      await waitFor(
        () => started.every((pid) => !alive(pid)),
        10_000,
        () =>
          `still running 10 s after the try ran out of time: ${started.filter(alive).join(", ")}`,
      );
    }
    expect(existsSync(join(root, TRY_FOLDER))).toBe(false);
  }, 60_000);
});
