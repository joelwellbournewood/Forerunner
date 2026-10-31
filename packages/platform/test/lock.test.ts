import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ForerunnerError } from "../src/errors.ts";
import { abstractLockName, acquireExclusiveLock, lockKey } from "../src/lock.ts";
import { join } from "../src/paths.ts";
import { killTree } from "../src/shell.ts";

const LOCK_TS = join(process.cwd(), "packages", "platform", "src", "lock.ts");
const TSX_LOADER = join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");

async function refusal(p: Promise<unknown>): Promise<ForerunnerError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ForerunnerError);
  return e as ForerunnerError;
}

/** A separate process that takes the lock (through this module) and keeps running. */
async function holder(dir: string): Promise<ChildProcess> {
  const scripts = mkdtempSync(join(tmpdir(), "fr-lock-holder-"));
  const script = join(scripts, "hold.mts");
  writeFileSync(
    script,
    [
      `import { acquireExclusiveLock } from ${JSON.stringify(pathToFileURL(LOCK_TS).href)};`,
      `await acquireExclusiveLock(process.argv[2] ?? "", "daemon.lock");`,
      `process.stdout.write("held\\n");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const child = spawn(process.execPath, ["--import", pathToFileURL(TSX_LOADER).href, script, dir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`no lock after 60 s: ${err}`)), 60_000);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.includes("held")) {
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
 * U-065: one daemon per data folder needs a lock the operating system releases when the
 * holder ends, a crash included; a pid written to a file can name a process that is gone or,
 * worse, a new one that reused the number.
 */
describe("acquireExclusiveLock (U-065)", { timeout: 120_000 }, () => {
  it("refuses a second holder, in the same process too, until the first releases it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-lock-"));
    const first = await acquireExclusiveLock(dir, "daemon.lock");
    expect(first.path).toBe(join(dir, "daemon.lock"));
    const e = await refusal(acquireExclusiveLock(dir, "daemon.lock"));
    expect(e.code).toBe("unavailable");
    expect(e.details).toMatchObject({ reason: "locked", path: join(dir, "daemon.lock") });
    await first.release();
    const again = await acquireExclusiveLock(dir, "daemon.lock");
    await again.release();
    await again.release();
  });

  it("locks per folder and per name", async () => {
    const a = mkdtempSync(join(tmpdir(), "fr-lock-a-"));
    const b = mkdtempSync(join(tmpdir(), "fr-lock-b-"));
    const held = [
      await acquireExclusiveLock(a, "daemon.lock"),
      await acquireExclusiveLock(b, "daemon.lock"),
      await acquireExclusiveLock(a, "other.lock"),
    ];
    for (const h of held) await h.release();
  });

  it("is held across processes and free again once the holder is killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-lock-cross-"));
    const child = await holder(dir);
    try {
      const e = await refusal(acquireExclusiveLock(dir, "daemon.lock"));
      expect(e.details.reason).toBe("locked");
    } finally {
      // A crash, not a clean release: the operating system frees the lock.
      killTree(child);
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    let lock = null;
    for (let i = 0; i < 50 && !lock; i++) {
      lock = await acquireExclusiveLock(dir, "daemon.lock").catch(() => null);
      if (!lock) await new Promise((r) => setTimeout(r, 100));
    }
    expect(lock, "the killed holder left the lock behind").not.toBeNull();
    await lock?.release();
  });

  it.runIf(process.platform === "linux")(
    "on Linux the lock is an abstract socket named after the real path; the file only records the holder",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "fr-lock-name-"));
      const file = join(dir, "daemon.lock");
      const key = lockKey(file);
      // One key per lock file, kept: every holder of this file derives the same name.
      expect(lockKey(file)).toBe(key);
      expect((statSync(`${file}.key`).mode & 0o777).toString(8)).toBe("600");
      const name = abstractLockName(file, key);
      expect(name.startsWith("\0forerunner-lock-")).toBe(true);
      expect(name).toBe(abstractLockName(join(dir, ".", "daemon.lock"), key));
      expect(name).not.toBe(abstractLockName(join(dir, "other.lock"), key));
      // Without the key (another user cannot read it) the path alone gives another name, so
      // nobody else can take this lock's name first.
      expect(name).not.toBe(abstractLockName(file, "0".repeat(32)));
      const held = await acquireExclusiveLock(dir, "daemon.lock");
      expect(JSON.parse(readFileSync(held.path, "utf8"))).toEqual({ pid: process.pid });
      await held.release();
      // A damaged key is replaced rather than blocking the lock for good.
      writeFileSync(`${file}.key`, "garbage");
      expect(lockKey(file)).toMatch(/^[0-9a-f]{32}$/);
    },
  );
});
