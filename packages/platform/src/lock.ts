import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { ForerunnerError } from "./errors.ts";
import { currentPlatform, type Platform } from "./os.ts";

/**
 * An exclusive lock one process holds for as long as it runs (U-065: one daemon per data
 * folder). The operating system releases it when the process ends, a crash or a kill included,
 * so a lock is never left behind and nothing has to guess whether a recorded pid still runs.
 *
 * - Windows: `<dir>/<name>` held open with an exclusive share mode (libuv's `UV_FS_O_EXLOCK`):
 *   while it is open no other open of the file succeeds, in this process or another
 *   (`EBUSY`, the sharing violation).
 * - Linux: a listening Unix socket in the abstract namespace, named after the real path of
 *   `<dir>/<name>` and a random key only this user can read (`<dir>/<name>.key`, 0600; see
 *   `lockKey`). A second bind is `EADDRINUSE`; the name disappears with the process and the
 *   socket is not inherited by children. `<dir>/<name>` is written with the holder's pid for
 *   people; it is not the lock.
 * - Elsewhere (macOS, best effort): `<dir>/<name>` created exclusively with the holder's pid; a
 *   file whose pid no longer runs is stale and replaced.
 *
 * A held lock is refused with ForerunnerError("unavailable", details.reason "locked").
 */
export interface HeldLock {
  /** The lock file in the folder (on Linux the record of the holder, not the lock itself). */
  readonly path: string;
  release(): Promise<void>;
}

/** libuv's exclusive share mode on Windows (`include/uv/win.h`); Node passes it through. */
export const UV_FS_O_EXLOCK = 0x1000_0000;

function held(file: string, cause: unknown): ForerunnerError {
  return new ForerunnerError("unavailable", `${file} is locked by another process`, {
    details: { reason: "locked", path: file },
    retryable: true,
    cause,
  });
}

function record(): string {
  return `${JSON.stringify({ pid: process.pid })}\n`;
}

export async function acquireExclusiveLock(
  dir: string,
  name: string,
  opts: { platform?: Platform } = {},
): Promise<HeldLock> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const platform = opts.platform ?? currentPlatform();
  if (platform === "windows") return exclusiveFile(file);
  if (platform === "linux" || platform === "android") return abstractSocket(file);
  return pidFile(file);
}

function exclusiveFile(file: string): HeldLock {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EBUSY") throw held(file, e);
    throw e;
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, record(), 0);
  } catch {
    // The record is for people; the open handle is the lock.
  }
  let open = true;
  return {
    path: file,
    async release() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

const KEY = /^[0-9a-f]{32}$/;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The random key of a lock, kept in `<file>.key` (mode 0600). An abstract socket has no
 * permissions, so a name another local user could work out from the path alone could be taken
 * by them first and keep this user's daemon from starting; a name that depends on a key only
 * this user can read cannot. Created once, exclusively, so two processes starting together
 * read the same key.
 */
export function lockKey(file: string): string {
  const keyFile = `${file}.key`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const key = randomBytes(16).toString("hex");
      writeFileSync(keyFile, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let text = "";
    try {
      text = readFileSync(keyFile, "utf8").trim();
    } catch {
      continue; // removed meanwhile: create it again
    }
    if (KEY.test(text)) return text;
    // Another process is between creating and writing it; a damaged one is replaced.
    if (attempt >= 20) rmSync(keyFile, { force: true });
    else pause(25);
  }
  throw new ForerunnerError("unavailable", `could not read or create ${keyFile}`, {
    details: { reason: "lock_key", path: keyFile },
  });
}

/** The abstract socket name for a lock file: the same file and key always give the same name. */
export function abstractLockName(file: string, key: string): string {
  let real = file;
  try {
    real = path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    // The folder was just created; the given path is as good.
  }
  const digest = createHash("sha256").update(`${key}\0${real}`).digest("hex").slice(0, 40);
  return `\0forerunner-lock-${digest}`;
}

async function abstractSocket(file: string): Promise<HeldLock> {
  const name = abstractLockName(file, lockKey(file));
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? held(file, e) : e),
    );
    server.listen({ path: name }, () => resolve());
  });
  // The lock never keeps the process alive by itself.
  server.unref();
  try {
    writeFileSync(file, record());
  } catch {
    // The record is for people; the socket is the lock.
  }
  let open = true;
  return {
    path: file,
    async release() {
      if (!open) return;
      open = false;
      removeOwnRecord(file);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function recordedPid(file: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

function removeOwnRecord(file: string): void {
  if (recordedPid(file) === process.pid) rmSync(file, { force: true });
}

function pidFile(file: string): HeldLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, record(), { flag: "wx" });
      let open = true;
      return {
        path: file,
        async release() {
          if (!open) return;
          open = false;
          removeOwnRecord(file);
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = recordedPid(file);
      if (pid !== null && (pid === process.pid || pidAlive(pid))) throw held(file, e);
      rmSync(file, { force: true });
    }
  }
  throw held(file, null);
}
