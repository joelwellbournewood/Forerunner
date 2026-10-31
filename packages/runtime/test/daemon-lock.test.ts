import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  appDirs,
  ForerunnerError,
  join,
  killTree,
  run,
  SimulatedClock,
} from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { acquireDaemonLock, DAEMON_LOCK_FILE } from "../src/daemon/instance-lock.ts";
import { DAEMON_FILE, removeOwnDaemonFile, startDaemon } from "../src/daemon/server.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
const CLI = join(process.cwd(), "packages", "runtime", "src", "cli", "main.ts");
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const TSX_LOADER = join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
const LOCK_TS = join(process.cwd(), "packages", "runtime", "src", "daemon", "instance-lock.ts");
const PATHS_TS = join(process.cwd(), "packages", "platform", "src", "paths.ts");

const homeDirs = (home: string) => appDirs({ env: { FORERUNNER_HOME: home } });

async function refused(p: Promise<unknown>): Promise<ForerunnerError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ForerunnerError);
  return e as ForerunnerError;
}

/** Another process holding the daemon lock for `home`, as a running `fr daemon` does. */
async function otherDaemon(home: string): Promise<ChildProcess> {
  const script = join(mkdtempSync(join(tmpdir(), "fr-daemon-lock-holder-")), "hold.mts");
  writeFileSync(
    script,
    [
      `import { acquireDaemonLock } from ${JSON.stringify(pathToFileURL(LOCK_TS).href)};`,
      `import { appDirs } from ${JSON.stringify(pathToFileURL(PATHS_TS).href)};`,
      `await acquireDaemonLock(appDirs({ env: { FORERUNNER_HOME: process.argv[2] ?? "" } }));`,
      `process.stdout.write("held\\n");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(TSX_LOADER).href, script, home],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: process.cwd() },
  );
  await new Promise<void>((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`no lock after 60 s: ${err}`)), 60_000);
    child.stdout?.on("data", (c: Buffer) => {
      if (c.toString("utf8").includes("held")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited with ${code}: ${err}`));
    });
  });
  return child;
}

/**
 * U-065: a daemon slow to answer at start got a second one started beside it on the same data
 * (the shell took the slow answer for "not running"); both wrote one store, and whichever stopped
 * first deleted the other's `daemon.json`. Now `fr daemon` holds an operating-system lock on the
 * runtime and data folders for its lifetime and a second one refuses with a clear message, and a
 * daemon removes `daemon.json` at stop only while the file still names it.
 */
describe("one daemon per data folder (U-065)", { timeout: 180_000 }, () => {
  it("a second holder is refused with what runs, on which data, and what to do", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-daemon-lock-"));
    const dirs = homeDirs(home);
    const lock = await acquireDaemonLock(dirs);
    try {
      expect(existsSync(join(dirs.runtime, DAEMON_LOCK_FILE))).toBe(true);
      expect(existsSync(join(dirs.data, DAEMON_LOCK_FILE))).toBe(true);
      writeFileSync(join(dirs.runtime, DAEMON_FILE), JSON.stringify({ pid: 4242, token: "x" }));
      const e = await refused(acquireDaemonLock(dirs));
      expect(e.code).toBe("unavailable");
      expect(e.details.reason).toBe("daemon_running");
      expect(e.message).toContain("Another Forerunner background service (process 4242)");
      expect(e.message).toContain(dirs.data);
      expect(e.message).toContain("Quit Forerunner from the tray");
    } finally {
      await lock.release();
    }
    // Released: the next start takes it.
    await (await acquireDaemonLock(dirs)).release();
  });

  it("a daemon that crashed leaves no lock behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-daemon-lock-crash-"));
    const child = await otherDaemon(home);
    try {
      expect((await refused(acquireDaemonLock(homeDirs(home)))).details.reason).toBe(
        "daemon_running",
      );
    } finally {
      killTree(child);
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    let lock = null;
    for (let i = 0; i < 50 && !lock; i++) {
      lock = await acquireDaemonLock(homeDirs(home)).catch(() => null);
      if (!lock) await new Promise((r) => setTimeout(r, 100));
    }
    expect(lock, "the crashed daemon's lock is still held").not.toBeNull();
    await lock?.release();
  });

  it("`fr daemon` refuses to start beside a running one, before it composes anything", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-daemon-lock-cli-"));
    const dirs = homeDirs(home);
    const lock = await acquireDaemonLock(dirs);
    try {
      const r = await run([process.execPath, TSX, CLI, "daemon", "--provider", "fake"], {
        env: { ...process.env, FORERUNNER_HOME: home, FORERUNNER_VAULT_BACKEND: "file" },
        timeoutMs: 90_000,
        allowFailure: true,
      });
      expect(r.timedOut, "a second daemon started and kept running").toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Another Forerunner background service is already running");
      expect(r.stderr).toContain(dirs.data);
      // Nothing was composed: no store, no address file.
      expect(existsSync(join(dirs.runtime, DAEMON_FILE))).toBe(false);
    } finally {
      await lock.release();
    }
  });

  describe("daemon.json at stop", () => {
    let rt: RuntimeApp;
    beforeAll(async () => {
      const home = mkdtempSync(join(tmpdir(), "fr-daemon-file-"));
      rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: homeDirs(home),
        config: null,
        clock: new SimulatedClock("2026-10-31T10:00:00Z"),
        stateUrl: "sqlite::memory:",
        vault: new MemoryVault(),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "0.1.0-test",
        startServices: false,
      });
    }, 120_000);
    afterAll(async () => {
      await rt?.close();
    });

    it("is removed while it names this daemon", async () => {
      const daemon = await startDaemon(rt, { port: 0 });
      const file = join(rt.dirs.runtime, DAEMON_FILE);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid });
      await daemon.stop({ timeoutMs: 1_000 });
      expect(existsSync(file)).toBe(false);
    });

    it("is left alone when another daemon wrote its own address there", async () => {
      const daemon = await startDaemon(rt, { port: 0 });
      const file = join(rt.dirs.runtime, DAEMON_FILE);
      const other = {
        url: "http://127.0.0.1:1",
        token: "the-other-daemons-token", // not-a-secret
        pid: 424242,
        startedAt: "2026-10-31T10:05:00.000Z",
      };
      writeFileSync(file, JSON.stringify(other));
      await daemon.stop({ timeoutMs: 1_000 });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(other);
      // Same pid but another daemon's token (two daemons in one process, as tests run them).
      expect(removeOwnDaemonFile(file, { pid: 424242, token: "mine" })).toBe(false);
      expect(removeOwnDaemonFile(file, { pid: 424242, token: other.token })).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(removeOwnDaemonFile(file, { pid: 424242, token: other.token })).toBe(false);
    });
  });
});
