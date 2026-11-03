import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { SimulatedClock, SystemClock } from "@forerunner/platform/clock";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  toPosix,
} from "@forerunner/platform/paths";
import { afterAll, describe, expect, it } from "vitest";
import {
  ENV_BASE,
  ENV_OWNER,
  ENV_RUN,
  keptTempDir,
  parseRunFolderName,
  RUN_MARKER,
  RUN_NAME_LENGTH,
  RUN_PREFIX,
  removeFolder,
  runFolderName,
  STALE_AFTER_MS,
  startTestTmp,
  sweepStaleRunFolders,
  TEMP_VARS,
  WINDOWS_CI_TEMP,
  windowsCiTempStandIn,
} from "../src/test-tmp.ts";

/**
 * Test runs leave nothing in the temp folder (testing.md, "Where test temp files go";
 * testenv/src/test-tmp.ts). By 2026-11-03 one machine's temp folder held about 101,000 entries
 * from test runs (15 GB): tests make folders with mkdtemp and many never remove them.
 */

const REPO = resolve(import.meta.dirname, "..", "..");
const FIXTURE = join(import.meta.dirname, "fixtures", "test-tmp");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const DAY = STALE_AFTER_MS;
const clock = new SystemClock();

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * A run folder as `startTestTmp` leaves it (or, with `name`, as a run named it before the name was
 * shortened), with its marker last touched `markerAgeMs` ago.
 */
function plantRun(
  base: string,
  pid: number,
  startedMs: number,
  markerAgeMs: number,
  name = runFolderName(startedMs),
): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "fr-email-abc123"), { recursive: true });
  writeFileSync(join(dir, "fr-email-abc123", "left.txt"), "x");
  const marker = join(dir, RUN_MARKER);
  writeFileSync(marker, `planted by test-tmp.test.ts\npid: ${pid}\n`);
  const at = new Date(clock.now() - markerAgeMs);
  utimesSync(marker, at, at);
  return dir;
}

function aged(path: string, ageMs: number): string {
  const at = new Date(clock.now() - ageMs);
  utimesSync(path, at, at);
  return path;
}

describe("one temp folder per test run", () => {
  it("this test runs in its run's own folder: TMPDIR, TMP and TEMP point at it (the root config's global setup)", () => {
    const run = process.env[ENV_RUN];
    expect(
      run,
      "the root vitest.config.ts names testenv/src/test-tmp-global-setup.ts",
    ).toBeTruthy();
    expect(tmpdir()).toBe(run);
    for (const k of TEMP_VARS) expect(process.env[k], k).toBe(run);
    expect(parseRunFolderName(basename(run as string))).toBeDefined();
    expect(dirname(run as string)).toBe(process.env[ENV_BASE]);
    expect(existsSync(join(run as string, RUN_MARKER))).toBe(true);
  });

  it("a vitest run leaves nothing in the temp folder it started with, whatever its tests and their processes left; it removes a crashed run's folder and nothing else", async () => {
    // The child's "system temp folder", and a folder outside it where the child reports.
    const sys = tempDir("fr-tmpguard-sys-");
    const out = tempDir("fr-tmpguard-out-");
    const now = clock.now();

    // What a temp folder holds: a crashed run's folder (removed), and what must stay: another
    // run's live folder, a run of days that still touches its marker, a run-shaped folder
    // without the marker, other tools' folders, names that are close but not exact, a file.
    // (Two days ago, a second apart: a name carries the start, not the pid.)
    const twoDays = (s: number) => now - 2 * DAY - s * 1000;
    const crashed = plantRun(sys, 101, twoDays(0), 2 * DAY);
    const kept = [
      plantRun(sys, 102, now - 60_000, 60_000),
      plantRun(sys, 103, now - 3 * DAY, 5 * 60_000),
      aged(
        (() => {
          const d = join(sys, runFolderName(twoDays(1)));
          mkdirSync(d);
          return d;
        })(),
        2 * DAY,
      ),
      aged(
        (() => {
          const d = join(sys, "fr-email-old123");
          mkdirSync(d);
          writeFileSync(join(d, RUN_MARKER), "");
          aged(join(d, RUN_MARKER), 3 * DAY);
          return d;
        })(),
        3 * DAY,
      ),
      (() => {
        const near = join(sys, `${runFolderName(twoDays(2))}-x`);
        mkdirSync(near);
        writeFileSync(join(near, RUN_MARKER), "");
        aged(join(near, RUN_MARKER), 2 * DAY);
        return near;
      })(),
      (() => {
        const f = join(sys, runFolderName(twoDays(3)));
        writeFileSync(f, "a file, not a folder");
        return aged(f, 2 * DAY);
      })(),
    ];
    // A link named like a crashed run's folder, to a folder that looks like one: neither goes.
    // (Making a link on Windows needs a right a standard user does not have.)
    let target: string | undefined;
    if (process.platform !== "win32") {
      target = plantRun(out, 107, twoDays(4), 2 * DAY);
      const link = join(sys, runFolderName(twoDays(5)));
      symlinkSync(target, link, "dir");
      kept.push(link);
    }
    const keptNames = kept.map((k) => basename(k)).sort();

    const env: NodeJS.ProcessEnv = { ...process.env, FR_TMP_GUARD_OUT: out };
    for (const k of TEMP_VARS) env[k] = sys;
    const child = execFile(
      process.execPath,
      [VITEST, "run", "--root", FIXTURE, "--config", join(FIXTURE, "vitest.config.ts")],
      { cwd: FIXTURE, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    let output = "";
    child.stdout?.on("data", (d) => {
      output += String(d);
    });
    child.stderr?.on("data", (d) => {
      output += String(d);
    });
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(code, output).toBe(0);

    // In the run: the tests, and the process a test started, wrote into the run's folder.
    const seen = JSON.parse(readFileSync(join(out, "seen.json"), "utf8"));
    const runDir: string = seen.tmp;
    expect(dirname(runDir)).toBe(sys);
    expect(parseRunFolderName(basename(runDir))).toBeDefined();
    expect(seen.owner).toBe(String(child.pid));
    expect(seen.marker).toContain(`pid: ${child.pid}`);
    expect(seen.env).toEqual({ TMPDIR: runDir, TMP: runDir, TEMP: runDir });
    expect(dirname(seen.dir)).toBe(runDir);
    expect(seen.child.tmp).toBe(runDir);
    expect(dirname(seen.child.dir)).toBe(runDir);

    // After the run: its folder and all in it are gone, the crashed run's folder too, and
    // everything else is where it was.
    expect(existsSync(runDir), output).toBe(false);
    expect(existsSync(crashed)).toBe(false);
    expect(readdirSync(sys).sort()).toEqual(keptNames);
    expect(output).toContain("removed 1 temporary folder(s)");
    expect(output).toContain(basename(crashed));
    if (target) expect(existsSync(join(target, RUN_MARKER))).toBe(true);

    // A test that pointed TMPDIR, TMP and TEMP elsewhere itself got that folder, and so did the
    // process it started; the run did not touch it.
    const own = JSON.parse(readFileSync(join(out, "own.json"), "utf8"));
    expect(dirname(own.dir)).toBe(join(out, "own temp"));
    expect(own.child.tmp).toBe(join(out, "own temp"));
    expect(existsSync(own.dir)).toBe(true);
    expect(existsSync(own.child.dir)).toBe(true);
  }, 240_000);

  it("a run folder is only removed by a later run when both its name and its marker are over a day old", () => {
    const base = tempDir("fr-tmpguard-sweep-");
    const now = clock.now();
    const at = new SimulatedClock(new Date(now).toISOString());
    const young = plantRun(base, 201, now - DAY + 60_000, DAY + 60_000);
    const touched = plantRun(base, 202, now - 2 * DAY, DAY - 60_000);
    const old = plantRun(base, 203, now - DAY - 60_000, DAY + 60_000);
    // Named as runs named their folder until 2026-11-03, by a run that crashed before then.
    const legacy = plantRun(
      base,
      204,
      now - 2 * DAY,
      2 * DAY,
      `fr-test-run-204-${Math.floor((now - 2 * DAY) / 1000).toString(36)}`,
    );
    const lines: string[] = [];
    const removed = sweepStaleRunFolders(base, { clock: at, log: (l) => lines.push(l) });
    expect(removed.sort()).toEqual([basename(old), basename(legacy)].sort());
    expect(existsSync(young)).toBe(true);
    expect(existsSync(touched)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(lines).toEqual([
      `Forerunner tests: removed 2 temporary folder(s) that a test run more than a day ago left in ${base}: ${removed.join(", ")}.`,
    ]);
    // Nothing to remove: nothing said.
    expect(sweepStaleRunFolders(base, { clock: at, log: (l) => lines.push(l) })).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("a run's name is short and carries its start, and only that exact shape is a run folder", () => {
    const start = Date.parse("2026-11-03T02:43:00.123Z");
    const name = runFolderName(start);
    expect(name).toBe(`frt-${Math.floor(start / 1000).toString(36)}`);
    // Short, for Windows' path limits: the run folder adds its name and a separator to every
    // path a test makes. `fr-test-run-<pid>-<start>`, 23 characters on CI's Windows runner, put
    // 22 voice install tests over espeak-ng's 159 there (packages/runtime/test/
    // voice-test-paths.test.ts). The same length whatever the pid, until 2038.
    expect(RUN_NAME_LENGTH).toBe(10);
    expect(name).toHaveLength(RUN_NAME_LENGTH);
    expect(runFolderName(Date.parse("2038-01-01T00:00:00Z"))).toHaveLength(RUN_NAME_LENGTH);
    expect(parseRunFolderName(name)).toEqual({ startedMs: Date.parse("2026-11-03T02:43:00.000Z") });
    // A folder a run named the old way and left (a crash before the name was shortened) is
    // still recognised, so a later run removes it.
    expect(parseRunFolderName(`fr-test-run-4321-${name.slice(RUN_PREFIX.length)}`)).toEqual({
      startedMs: Date.parse("2026-11-03T02:43:00.000Z"),
    });
    for (const other of [
      "frt-",
      "frt-ABC123",
      "frt-12-abc",
      "frt_abc123",
      `${name}-x`,
      `x${name}`,
      "fr-test-run-",
      "fr-test-run-12",
      "fr-test-run-x-abc",
      "fr-test-run-12-ABC",
      "fr-email-abc123",
    ])
      expect(parseRunFolderName(other), other).toBeUndefined();
  });

  it("the run folder leaves room on Windows: 47 characters from CI's Windows temp folder, and the deepest path the unit tests are known to leave in it stays below 260", () => {
    // One `pnpm test` with the run folder kept (2026-11-03; testing.md, "The path budget"): the
    // deepest path left was a continuity test's git ref, 163 characters below the run folder.
    // The voice install tests' tighter limit (espeak-ng's 159) is voice-test-paths.test.ts's.
    const DEEPEST_KNOWN = 163;
    const WINDOWS_MAX_PATH = 260;
    expect(WINDOWS_CI_TEMP).toHaveLength(36);
    const standIn = windowsCiTempStandIn();
    expect(standIn).toHaveLength(WINDOWS_CI_TEMP.length);
    expect(isAbsolute(standIn)).toBe(true);
    expect(windowsCiTempStandIn("win32")).toBe(WINDOWS_CI_TEMP);
    const ci = join(standIn, runFolderName(clock.now()));
    expect(ci).toHaveLength(47);
    for (const run of [ci, tmpdir()])
      expect(run.length + 1 + DEEPEST_KNOWN, run).toBeLessThan(WINDOWS_MAX_PATH);
  });

  it("two runs that start in the same second get a folder each", () => {
    const base = tempDir("fr-tmpguard-same-");
    const at = new SimulatedClock("2026-11-03T10:00:00.250Z");
    const first = startTestTmp({ env: {}, base, clock: at, log: () => {}, pid: 11 });
    const second = startTestTmp({ env: {}, base, clock: at, log: () => {}, pid: 12 });
    expect(second.dir).not.toBe(first.dir);
    expect(parseRunFolderName(basename(second.dir))?.startedMs).toBe(
      Date.parse("2026-11-03T10:00:01.000Z"),
    );
    expect(readFileSync(join(first.dir, RUN_MARKER), "utf8")).toContain("pid: 11");
    expect(readFileSync(join(second.dir, RUN_MARKER), "utf8")).toContain("pid: 12");
    expect(second.stop()).toBe(true);
    expect(first.stop()).toBe(true);
  });

  it("start and stop: the variables point at the run folder and are restored after; the folder goes", () => {
    const base = tempDir("fr-tmpguard-start-");
    const env: NodeJS.ProcessEnv = { TMPDIR: "/before", TMP: "C:\\before" };
    const run = startTestTmp({ env, base, log: () => {}, pid: 77 });
    expect(dirname(run.dir)).toBe(base);
    expect(parseRunFolderName(basename(run.dir))).toBeDefined();
    expect(env).toEqual({
      TMPDIR: run.dir,
      TMP: run.dir,
      TEMP: run.dir,
      [ENV_RUN]: run.dir,
      [ENV_BASE]: base,
      [ENV_OWNER]: "77",
    });
    expect(readFileSync(join(run.dir, RUN_MARKER), "utf8")).toContain("pid: 77");
    writeFileSync(join(run.dir, "left.txt"), "x");
    expect(run.stop()).toBe(true);
    expect(existsSync(run.dir)).toBe(false);
    expect(env).toEqual({ TMPDIR: "/before", TMP: "C:\\before" });
    expect(readdirSync(base)).toEqual([]);

    // A run inside another run (a vitest a test starts) gives its parent's values back.
    const parent = {
      TMPDIR: "/parent-run",
      TMP: "/parent-run",
      TEMP: "/parent-run",
      [ENV_RUN]: "/parent-run",
      [ENV_BASE]: "/",
      [ENV_OWNER]: "1",
    };
    const nested: NodeJS.ProcessEnv = { ...parent };
    const inner = startTestTmp({ env: nested, base, log: () => {}, pid: 78 });
    expect(nested[ENV_RUN]).toBe(inner.dir);
    expect(nested[ENV_OWNER]).toBe("78");
    expect(inner.stop()).toBe(true);
    expect(nested).toEqual(parent);
  });

  it("stop while a file in the folder is still open: retried, then left in place with a message that says so, and tried again at exit", () => {
    const base = tempDir("fr-tmpguard-busy-");
    let held = true;
    const calls: unknown[] = [];
    const rm = ((path: string, opts: Parameters<typeof rmSync>[1]) => {
      calls.push(opts);
      if (held)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), {
          code: "EBUSY",
          path,
        });
      rmSync(path, opts);
    }) as typeof rmSync;
    const lines: string[] = [];
    let lastTry: (() => void) | undefined;
    const env: NodeJS.ProcessEnv = {};
    const run = startTestTmp({
      env,
      base,
      rm,
      log: (l) => lines.push(l),
      onExit: (fn) => {
        lastTry = fn;
      },
    });
    expect(run.stop()).toBe(false);
    expect(existsSync(run.dir)).toBe(true);
    expect(calls[0]).toMatchObject({ recursive: true, force: true });
    expect((calls[0] as { maxRetries: number }).maxRetries).toBeGreaterThanOrEqual(5);
    expect(lines).toEqual([
      `Forerunner tests: could not remove the temporary folder ${run.dir} (EBUSY on ${run.dir}: a file in it is still open, most likely by a process a test started).`,
      "Forerunner tests: it is tried again when this process exits; if a file is still open then, a later test run removes it once it is a day old.",
    ]);
    // The variables are restored whether or not the folder went.
    expect(env).toEqual({});
    // At exit the file is closed: the last try removes it.
    held = false;
    expect(lastTry).toBeDefined();
    lastTry?.();
    expect(existsSync(run.dir)).toBe(false);

    // Called from an exit handler (Playwright's runner), it says it is left, with no last try.
    const again = startTestTmp({ env, base, log: (l) => lines.push(l), rm: busy() });
    expect(again.stop({ lastTry: false })).toBe(false);
    expect(lines.at(-1)).toBe(
      "Forerunner tests: the folder is left in place; a later test run removes it once it is a day old.",
    );
    rmSync(again.dir, { recursive: true, force: true });
  });

  it("a file this user may not remove is named as that, not as a file still open", () => {
    const lines: string[] = [];
    const rm = ((path: string) => {
      throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
        code: "EACCES",
        path: `${path}-file`,
      });
    }) as typeof rmSync;
    expect(removeFolder("/held", { rm, log: (l) => lines.push(l) })).toBe(false);
    expect(lines).toEqual([
      "Forerunner tests: could not remove the temporary folder /held (EACCES on /held-file: this user may not remove a file in it, for example one a container wrote as another user).",
    ]);
  });

  it("a folder a running process still works in: on Windows it stays and the message says why; once the process ends it goes", async () => {
    const dir = tempDir("fr-tmpguard-held-");
    const cwd = join(dir, "busy");
    mkdirSync(cwd);
    writeFileSync(join(dir, "left.txt"), "x");
    // The child says where it runs, and only then is the folder removed. Node's "spawn" event
    // comes as soon as CreateProcess returns, before the child has run any of its own start-up,
    // and it is that start-up which opens the working folder whose handle keeps it on Windows.
    // Waiting for "spawn" alone, Windows CI on 2de0a25 removed the folder at the first try, 27 ms
    // after the start: no process worked in it yet.
    const child = spawn(
      process.execPath,
      ["-e", "console.log(process.cwd()); setInterval(() => {}, 1000)"],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = new Promise((done) => child.on("exit", done));
    const ranIn = await new Promise<string>((done, fail) => {
      let said = "";
      child.stdout?.on("data", (d) => {
        said += String(d);
        if (said.includes("\n")) done(said.trim());
      });
      child.on("error", fail);
      child.on("exit", (code) => fail(new Error(`the child ended (${code}) first: "${said}"`)));
    });
    expect(realpathSync.native(ranIn)).toBe(realpathSync.native(cwd));
    const lines: string[] = [];
    try {
      const removed = removeFolder(dir, {
        log: (l) => lines.push(l),
        retries: 2,
        retryDelayMs: 50,
      });
      // Windows refuses to remove a process's working folder; Linux and macOS do not.
      expect(removed).toBe(process.platform !== "win32");
      expect(existsSync(dir)).toBe(!removed);
      if (!removed) expect(lines[0]).toContain(`could not remove the temporary folder ${dir} (`);
    } finally {
      child.kill();
      await exited;
    }
    expect(removeFolder(dir, { log: (l) => lines.push(l) })).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("evidence a person reads after the run goes beside the run folder, so it outlives the run", () => {
    const base = tempDir("fr-tmpguard-kept-");
    const kept = keptTempDir("fr-live-report-", { [ENV_BASE]: base });
    expect(dirname(kept)).toBe(base);
    // In this run: in the temp folder the run started with, not in the run's own.
    const real = keptTempDir("fr-tmpguard-kept-");
    temps.push(real);
    expect(dirname(real)).toBe(process.env[ENV_BASE]);
    expect(dirname(real)).not.toBe(tmpdir());
  });

  it("every vitest config and the Playwright config make the run folder, and the root config's projects use the root's", async () => {
    const found: string[] = [];
    const SKIP = new Set(["node_modules", ".git", ".claude", "dist", "target", "gen", "coverage"]);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name) || e.name.startsWith("test-results")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^(vitest|playwright)\.config\.[cm]?[jt]s$/.test(e.name))
          found.push(toPosix(relative(REPO, p)));
      }
    };
    walk(REPO);
    expect(found.sort()).toEqual([
      "apps/approvals-web/vitest.config.ts",
      "apps/ui/playwright.config.ts",
      "apps/ui/vitest.config.ts",
      "testenv/test/fixtures/test-tmp/vitest.config.ts",
      "tests/live/vitest.config.ts",
      "vitest.config.ts",
    ]);
    for (const f of found) {
      const text = readFileSync(join(REPO, f), "utf8");
      if (f.endsWith("playwright.config.ts")) expect(text, f).toMatch(/startTestTmp\(\)/);
      else expect(text, f).toMatch(/globalSetup: \[[^\]]*test-tmp-global-setup\.ts"/);
    }
    // vitest runs the root's global setup whatever `--project` picks; a project with its own
    // would still share the folder, but none needs one, and none may point TMPDIR elsewhere.
    const root = (await import("../../vitest.config.ts")).default as {
      test: { globalSetup: string[]; projects: { test: Record<string, unknown> }[] };
    };
    expect(root.test.globalSetup).toEqual(["testenv/src/test-tmp-global-setup.ts"]);
    expect(root.test.projects.map((p) => p.test.name)).toEqual(["unit", "integration", "e2e"]);
    for (const p of root.test.projects) {
      expect(p.test.globalSetup, String(p.test.name)).toBeUndefined();
      expect(p.test.env, String(p.test.name)).toBeUndefined();
    }
  });
});

function busy(): typeof rmSync {
  return ((path: string) => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), {
      code: "EBUSY",
      path,
    });
  }) as typeof rmSync;
}
