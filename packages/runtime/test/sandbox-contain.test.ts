import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isForerunnerError, join, resolve } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containPath,
  containPathReal,
  readWorktreeFile,
  worktreeFileExists,
  writeWorktreeFile,
} from "../src/sandbox/contain.ts";

const WT = resolve(join("tmp", "wt"));

async function refused(fn: () => Promise<unknown> | unknown, label: string): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(isForerunnerError(err, "path_not_allowed"), `expected refusal for ${label}`).toBe(true);
}

describe("sandbox path containment (lexical)", () => {
  it("accepts relative paths that stay inside the worktree", () => {
    expect(containPath(WT, "a.txt")).toEqual({ host: join(WT, "a.txt"), rel: "a.txt" });
    expect(containPath(WT, "sub/../ok.txt").rel).toBe("ok.txt");
    expect(containPath(WT, "sub/deeper/x").rel).toBe("sub/deeper/x");
    expect(containPath(WT, "").rel).toBe("");
    expect(containPath(WT, ".").rel).toBe("");
  });

  it('refuses ".." escapes, absolute paths, drive letters and UNC prefixes', async () => {
    for (const bad of [
      "../x",
      "a/../../b",
      "/etc/passwd",
      "C:\\win",
      "C:/win",
      "\\\\srv\\share",
      "a\0b",
    ]) {
      await refused(() => containPath(WT, bad), bad);
    }
  });
});

/**
 * Symlink fixture:
 *   <base>/outside/secret.txt            host file that must stay unreachable
 *   <base>/wt/                           the worktree (real path)
 *   <base>/wt/inner/real.txt
 *   <base>/wt/escape      -> <base>/outside        (directory link leaving the worktree)
 *   <base>/wt/stay        -> <base>/wt/inner       (directory link staying inside)
 *   <base>/wt/dangling    -> <base>/outside/new    (dangling link leaving the worktree)
 *   <base>/wt/loop        -> <base>/wt/loop        (self-referential link)
 * Directory links are junctions on Windows, which need no privilege.
 */
describe("sandbox path containment (symlink-aware)", () => {
  let base: string;
  let wt: string;
  let outside: string;
  let linksOk = true;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "fr-contain-")));
    wt = join(base, "wt");
    outside = join(base, "outside");
    await mkdir(join(wt, "inner"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "HOST SECRET");
    await writeFile(join(wt, "inner", "real.txt"), "inside");
    const dirType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(outside, join(wt, "escape"), dirType);
      await symlink(join(wt, "inner"), join(wt, "stay"), dirType);
      await symlink(join(outside, "new"), join(wt, "dangling"), dirType);
      await symlink(join(wt, "loop"), join(wt, "loop"), dirType);
    } catch {
      linksOk = false;
    }
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it("refuses reads, writes and exists checks through a link that leaves the worktree", async () => {
    if (!linksOk) return;
    await refused(() => readWorktreeFile(wt, "escape/secret.txt"), "read escape/secret.txt");
    await refused(() => writeWorktreeFile(wt, "escape/pwned.txt", "x"), "write escape/pwned.txt");
    await refused(() => worktreeFileExists(wt, "escape/secret.txt"), "exists escape/secret.txt");
    await refused(() => containPathReal(wt, "escape"), "the link itself");
    await refused(() => writeWorktreeFile(wt, "dangling", "x"), "write through dangling link");
    await refused(() => containPathReal(wt, "dangling/deeper.txt"), "below a dangling link");
    await refused(() => containPathReal(wt, "loop/x"), "self-referential link");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("HOST SECRET");
    expect(await rm(join(outside, "pwned.txt"), { force: true })).toBeUndefined();
  });

  it("allows links that stay inside and returns the real path", async () => {
    if (!linksOk) return;
    expect(await readWorktreeFile(wt, "stay/real.txt")).toBe("inside");
    expect(await worktreeFileExists(wt, "stay/real.txt")).toBe(true);
    expect(await worktreeFileExists(wt, "stay/missing.txt")).toBe(false);
    await writeWorktreeFile(wt, "stay/new.txt", "a\r\nb");
    expect(await readFile(join(wt, "inner", "new.txt"), "utf8")).toBe("a\nb");
    const c = await containPathReal(wt, "stay/new.txt");
    expect(c.host).toBe(join(wt, "inner", "new.txt"));
    expect(c.rel).toBe("stay/new.txt");
    // Paths that do not exist yet are fine; parents are created on write.
    const fresh = await containPathReal(wt, "brand/new/dir/file.txt");
    expect(fresh.host).toBe(join(wt, "brand", "new", "dir", "file.txt"));
    await writeWorktreeFile(wt, "brand/new/dir/file.txt", "ok");
    expect(await readWorktreeFile(wt, "brand/new/dir/file.txt")).toBe("ok");
  });

  it("reports a missing worktree as not_found", async () => {
    await expect(containPathReal(join(base, "nope"), "a")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
