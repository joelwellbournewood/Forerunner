import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  type Stats,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { type Clock, SystemClock } from "@forerunner/platform/clock";
import { basename, join } from "@forerunner/platform/paths";

/**
 * One temporary folder per test run (docs/maintainers/testing.md, "Where test temp files go").
 *
 * Tests make folders with `mkdtemp(join(tmpdir(), "fr-…"))`, and many never remove them; the
 * daemons, git and browsers a test starts write to the temp folder too. By 2026-11-03 one
 * machine's temp folder held about 101,000 such entries (15 GB), and every full run added about
 * 1,500. Instead of asking every test to clean up, a run gets its own folder,
 * `<temp>/frt-<start>` (the start in seconds, base 36), and TMPDIR, TMP and TEMP point at it
 * before any worker starts: `os.tmpdir()` reads TMPDIR on POSIX and TEMP, then TMP, on Windows,
 * and every worker and every process a test starts inherits them. The run removes the folder at
 * its end. The name is short because every path a test makes is that much longer.
 *
 * Only folders this module made are ever removed: the exact name `frt-<base36 time>` (or
 * `fr-test-run-<pid>-<base36 time>`, the name runs gave it until 2026-11-03), a real directory
 * (not a link) holding the marker file this module writes. A folder whose run ended without
 * removing it (a crash, a kill) is removed by a later run once its marker has not been touched
 * for a day (a live run touches it every 10 minutes, so a watch-mode session that lasts days
 * keeps its folder). Nothing else in the temp folder is touched, not even other `fr-*` folders:
 * they may belong to another run or another tool.
 *
 * Imports only `node:fs`, `node:os` and two leaf modules of `@forerunner/platform`: it runs in
 * vitest's main process (`test-tmp-global-setup.ts`) and in Playwright's config loader.
 */

/** The exact prefix of a run folder; nothing else in the temp folder is ever removed. */
export const RUN_PREFIX = "frt-";
/** The file in a run folder that says what it is; the sweep removes no folder without it. */
export const RUN_MARKER = ".fr-test-run";
/** A run folder whose marker is older than this was left by a run that ended uncleanly. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** How often a live run touches its marker. */
export const HEARTBEAT_MS = 10 * 60 * 1000;

/** The run folder, the temp folder it is in, and the pid of the process that owns it. */
export const ENV_RUN = "FORERUNNER_TEST_TMP_RUN";
export const ENV_BASE = "FORERUNNER_TEST_TMP_BASE";
export const ENV_OWNER = "FORERUNNER_TEST_TMP_OWNER";
/** The variables `os.tmpdir()` reads: TMPDIR on POSIX, TEMP then TMP on Windows. */
export const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

const RUN_NAME_RE = /^frt-([0-9a-z]+)$/;
/** Runs until 2026-11-03 named their folder `fr-test-run-<pid>-<start>`; a crashed one's goes too. */
const LEGACY_RUN_NAME_RE = /^fr-test-run-\d+-([0-9a-z]+)$/;
/**
 * A run folder's name is this long (until 2038, when the seconds since 1970 take a seventh base 36
 * digit): every path a test makes is this plus one separator longer than without the run folder.
 */
export const RUN_NAME_LENGTH = 10;

/**
 * The temp folder of CI's Windows runner (windows-latest; the job log of run 41585526128): 36
 * characters. Windows gives TEMP the 8.3 short form of a user name of more than 8 letters, so a
 * person's is usually no longer. The longest temp folder the tests are known to run in: the
 * path budgets (test-tmp.test.ts, packages/runtime/test/voice-test-paths.test.ts) are checked
 * from it on every OS.
 */
export const WINDOWS_CI_TEMP = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";

/**
 * A folder path as long as `WINDOWS_CI_TEMP` that this OS takes as absolute: that folder on
 * Windows, `/` and as many characters elsewhere. Only its length counts; it is never made.
 */
export function windowsCiTempStandIn(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? WINDOWS_CI_TEMP : `/${"x".repeat(WINDOWS_CI_TEMP.length - 1)}`;
}

/** Why a removal failed, in words, for the codes it fails with. */
function whyNotRemoved(code: string, message: string): string {
  const open = "a file in it is still open, most likely by a process a test started";
  if (code === "EBUSY" || code === "ENOTEMPTY") return open;
  // Windows answers EPERM for a file another process holds open; POSIX for a permission.
  if (code === "EPERM" && process.platform === "win32") return open;
  if (code === "EPERM" || code === "EACCES")
    return "this user may not remove a file in it, for example one a container wrote as another user";
  if (code === "EMFILE" || code === "ENFILE") return "too many files are open";
  return message;
}

export type Log = (line: string) => void;
const stderrLog: Log = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * `frt-<start in seconds, base 36>`: `RUN_NAME_LENGTH` characters. Short because every path a
 * test makes is that much longer, and the voice install tests' paths must fit espeak-ng's 159
 * characters from CI's Windows temp folder (24 characters of `fr-test-run-<pid>-<start>` made
 * 22 of them fail there; packages/runtime/test/voice-test-paths.test.ts). Two runs that start in
 * the same second get the next free second (`startTestTmp`); the pid is in the marker.
 */
export function runFolderName(startedMs: number): string {
  return `${RUN_PREFIX}${Math.floor(startedMs / 1000).toString(36)}`;
}

/** The start a run folder's name carries, or undefined for any other name. */
export function parseRunFolderName(name: string): { startedMs: number } | undefined {
  const m = RUN_NAME_RE.exec(name) ?? LEGACY_RUN_NAME_RE.exec(name);
  if (!m) return undefined;
  const seconds = Number.parseInt(m[1] as string, 36);
  if (!Number.isFinite(seconds)) return undefined;
  return { startedMs: seconds * 1000 };
}

/** Whether `dir` is a run folder this module made: the exact name, with the marker in it. */
export function isRunFolder(dir: string): boolean {
  if (!parseRunFolderName(basename(dir))) return false;
  try {
    return lstatSync(join(dir, RUN_MARKER)).isFile();
  } catch {
    return false;
  }
}

export interface RemoveOptions {
  log?: Log;
  /** Injected in tests; `rmSync` otherwise. */
  rm?: typeof rmSync;
  /** Retries for errors that can clear on their own (rmSync waits retryDelayMs × attempt). */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Remove a folder, retrying while a file in it is still open, and say so when it cannot.
 * Returns whether the folder is gone.
 */
export function removeFolder(dir: string, opts: RemoveOptions = {}): boolean {
  const rm = opts.rm ?? rmSync;
  try {
    rm(dir, {
      recursive: true,
      force: true,
      maxRetries: opts.retries ?? 10,
      retryDelay: opts.retryDelayMs ?? 100,
    });
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    const where = (e as NodeJS.ErrnoException).path ?? dir;
    const why = whyNotRemoved(code, (e as Error).message);
    (opts.log ?? stderrLog)(
      `Forerunner tests: could not remove the temporary folder ${dir} (${code} on ${where}: ${why}).`,
    );
    return false;
  }
}

export interface SweepOptions {
  clock?: Clock;
  log?: Log;
  rm?: typeof rmSync;
}

/**
 * Remove the run folders in `base` that a run left behind more than a day ago: exact name, a
 * real directory, with this module's marker, marker and name both older than STALE_AFTER_MS.
 * Returns the names removed. Anything else in `base` is left alone.
 */
export function sweepStaleRunFolders(base: string, opts: SweepOptions = {}): string[] {
  const now = (opts.clock ?? new SystemClock()).now();
  const log = opts.log ?? stderrLog;
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const parsed = parseRunFolderName(entry.name);
    if (!parsed || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (now - parsed.startedMs < STALE_AFTER_MS) continue;
    const dir = join(base, entry.name);
    let marker: Stats;
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      marker = lstatSync(join(dir, RUN_MARKER));
    } catch {
      continue; // no marker: not ours, or another run is making it right now
    }
    if (!marker.isFile() || now - marker.mtimeMs < STALE_AFTER_MS) continue;
    if (removeFolder(dir, { log, rm: opts.rm, retries: 2, retryDelayMs: 100 }))
      removed.push(entry.name);
  }
  if (removed.length > 0)
    log(
      `Forerunner tests: removed ${removed.length} temporary folder(s) that a test run more than a day ago left in ${base}: ${removed.join(", ")}.`,
    );
  return removed;
}

/**
 * A folder for evidence a person reads after the run (a report whose path a live run prints):
 * in the temp folder the run started with, beside the run folder, so it outlives the run. Outside
 * a test run it is an ordinary folder in `os.tmpdir()`.
 */
export function keptTempDir(prefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env[ENV_BASE]?.trim();
  return mkdtempSync(join(base ? base : tmpdir(), prefix));
}

export interface TestTmpRun {
  /** This run's folder; TMPDIR, TMP and TEMP point here while the run lasts. */
  dir: string;
  /** The temp folder the run folder is in (the system's, or what TMPDIR/TEMP said before). */
  base: string;
  /**
   * Restore TMPDIR, TMP and TEMP and remove the folder; returns whether it is gone. When a file
   * in it is still open, it is tried again when the process exits (`lastTry: false` when the
   * caller already is the exit handler).
   */
  stop(opts?: { lastTry?: boolean }): boolean;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  log?: Log;
  pid?: number;
  /** Where the run folder goes; `os.tmpdir()` (read from the current environment) otherwise. */
  base?: string;
  rm?: typeof rmSync;
  /** Called with a last try when the folder could not be removed at stop; `process.once("exit")` otherwise. */
  onExit?: (fn: () => void) => void;
}

/**
 * Make this run's temp folder in the current temp folder, point TMPDIR, TMP and TEMP at it and
 * remove run folders a crashed run left more than a day ago. Call it in the process that starts
 * the workers (vitest's main process, Playwright's runner), before any starts.
 */
export function startTestTmp(opts: StartOptions = {}): TestTmpRun {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? new SystemClock();
  const log = opts.log ?? stderrLog;
  const pid = opts.pid ?? process.pid;
  const base = opts.base ?? tmpdir();
  sweepStaleRunFolders(base, { clock, log, rm: opts.rm });

  let started = clock.now();
  let dir = join(base, runFolderName(started));
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      started += 1000;
      dir = join(base, runFolderName(started));
    }
  }
  const marker = join(dir, RUN_MARKER);
  writeFileSync(
    marker,
    [
      "The temporary folder of one Forerunner test run (docs/maintainers/testing.md,",
      '"Where test temp files go"). The run removes it when it ends; a later run removes it',
      "once this file has not been touched for a day.",
      `pid: ${pid}`,
      `started: ${new Date(started).toISOString()}`,
      "",
    ].join("\n"),
  );

  // A run inside another (a vitest a test starts) restores its parent's values at its end.
  const vars = [...TEMP_VARS, ENV_RUN, ENV_BASE, ENV_OWNER];
  const previous = Object.fromEntries(vars.map((k) => [k, env[k]]));
  for (const k of TEMP_VARS) env[k] = dir;
  env[ENV_RUN] = dir;
  env[ENV_BASE] = base;
  env[ENV_OWNER] = String(pid);

  const heartbeat = setInterval(() => {
    const at = new Date(clock.now());
    try {
      utimesSync(marker, at, at);
    } catch {
      // the folder is gone or being removed; nothing to keep alive
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let stopped = false;
  return {
    dir,
    base,
    stop(stopOpts = {}) {
      if (stopped) return !existsSync(dir);
      stopped = true;
      clearInterval(heartbeat);
      for (const k of vars) {
        const v = previous[k];
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      if (removeFolder(dir, { log, rm: opts.rm })) return true;
      if (stopOpts.lastTry === false) {
        log(
          "Forerunner tests: the folder is left in place; a later test run removes it once it is a day old.",
        );
        return false;
      }
      log(
        "Forerunner tests: it is tried again when this process exits; if a file is still open then, a later test run removes it once it is a day old.",
      );
      const lastTry = () => {
        removeFolder(dir, { log: () => {}, rm: opts.rm, retries: 3, retryDelayMs: 100 });
      };
      if (opts.onExit) opts.onExit(lastTry);
      else process.once("exit", lastTry);
      return false;
    },
  };
}
