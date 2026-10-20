import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { type AppDirs, type Clock, ForerunnerError, join } from "@forerunner/platform";
import { assertInsideVersions, versionsRoot } from "./pointer.ts";

/**
 * One install operation at a time, across processes: the daemon's routes, `fr update` from
 * another terminal and the startup health check all run under `<data>/versions/install.lock`.
 * The file is created exclusively (`wx`), names the holder's pid, operation and start time,
 * and is removed when the operation ends. A second caller is refused at once with
 * ForerunnerError("version_conflict", details.reason "in_progress") rather than queued: the
 * UI and the CLI tell the user what is running. A lock whose process is gone (or that is
 * unreadable and older than STALE_UNREADABLE_MS) is stale and replaced.
 */
export const INSTALL_LOCK_FILE = "install.lock";
const STALE_UNREADABLE_MS = 10_000;

export interface InstallLock {
  pid: number;
  operation: string;
  startedAt: string;
}

export function installLockPath(dirs: AppDirs): string {
  return join(versionsRoot(dirs), INSTALL_LOCK_FILE);
}

/** The lock on disk, or null when there is none or it cannot be read. */
export function readInstallLock(dirs: AppDirs): InstallLock | null {
  const p = installLockPath(dirs);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<InstallLock>;
    if (typeof raw.pid !== "number" || typeof raw.operation !== "string") return null;
    return {
      pid: raw.pid,
      operation: raw.operation,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** Signal 0 probes without killing; EPERM means the process exists but is someone else's. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inProgress(held: InstallLock, requested: string): ForerunnerError {
  return new ForerunnerError(
    "version_conflict",
    `update ${held.operation} is already in progress (pid ${held.pid}${held.startedAt ? `, since ${held.startedAt}` : ""}); try again when it finishes`,
    {
      details: {
        reason: "in_progress",
        operation: held.operation,
        pid: held.pid,
        startedAt: held.startedAt,
        requested,
      },
      retryable: true,
    },
  );
}

function acquire(dirs: AppDirs, operation: string, clock: Clock): string {
  const root = versionsRoot(dirs);
  mkdirSync(root, { recursive: true });
  const p = assertInsideVersions(dirs, installLockPath(dirs));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx");
      try {
        const lock: InstallLock = { pid: process.pid, operation, startedAt: clock.nowIso() };
        writeSync(fd, `${JSON.stringify(lock)}\n`);
      } finally {
        closeSync(fd);
      }
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readInstallLock(dirs);
      if (held) {
        if (isPidAlive(held.pid)) throw inProgress(held, operation);
      } else {
        // Unreadable: another process may be between create and write. Only an old one is stale.
        let ageMs = 0;
        try {
          ageMs = clock.now() - statSync(p).mtimeMs;
        } catch {
          continue; // vanished in the meantime: retry the create
        }
        if (ageMs < STALE_UNREADABLE_MS)
          throw inProgress({ pid: 0, operation: "unknown", startedAt: "" }, operation);
      }
      rmSync(p, { force: true });
    }
  }
  throw inProgress(
    readInstallLock(dirs) ?? { pid: 0, operation: "unknown", startedAt: "" },
    operation,
  );
}

/** Run `fn` holding the install lock; the lock is released however `fn` ends. */
export async function withInstallLock<T>(
  dirs: AppDirs,
  opts: { operation: string; clock: Clock },
  fn: () => Promise<T>,
): Promise<T> {
  const p = acquire(dirs, opts.operation, opts.clock);
  try {
    return await fn();
  } finally {
    rmSync(p, { force: true });
  }
}

/** The same for a synchronous operation (prune). */
export function withInstallLockSync<T>(
  dirs: AppDirs,
  opts: { operation: string; clock: Clock },
  fn: () => T,
): T {
  const p = acquire(dirs, opts.operation, opts.clock);
  try {
    return fn();
  } finally {
    rmSync(p, { force: true });
  }
}
