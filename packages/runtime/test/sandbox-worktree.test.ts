import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isForerunnerError, join, run, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/sandbox/worktree.ts";

const GIT_ID = ["-c", "user.name=forerunner-test", "-c", "user.email=test@example.invalid"];

async function makeRepo(dir: string): Promise<void> {
  await run(["git", "init", "-q", "--initial-branch=main", dir]);
  await writeFile(join(dir, "README.md"), "# test\n");
  await run(["git", "-C", dir, "add", "."]);
  await run(["git", "-C", dir, ...GIT_ID, "commit", "-q", "-m", "init"]);
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

describe("WorktreeManager (real temp git repo)", () => {
  let base: string;
  let repo: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "fr-wt-"));
    repo = join(base, "repo");
    root = join(base, "worktrees");
    await makeRepo(repo);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a worktree on a new branch under root/<safe task id>, lists and removes it", async () => {
    const clock = new SimulatedClock("2026-03-01T10:00:00.000Z");
    const wm = new WorktreeManager({ root, clock });
    const info = await wm.create({ repoDir: repo, branch: "task/abc", taskId: "task:abc/1" });
    expect(info.path).toBe(join(root, "task-abc-1"));
    expect(info.branch).toBe("task/abc");
    expect(info.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(await exists(join(info.path, "README.md"))).toBe(true);
    const head = await run(["git", "-C", info.path, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(head.stdout.trim()).toBe("task/abc");

    const listed = await wm.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      path: info.path,
      repoDir: info.repoDir,
      taskId: "task:abc/1",
    });

    await wm.remove(info.path);
    expect(await exists(info.path)).toBe(false);
    expect(await wm.list()).toEqual([]);
    const wl = await run(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    expect(wl.stdout).not.toContain("task-abc-1");
  });

  it("refuses to create twice for the same task and to remove outside the root", async () => {
    const wm = new WorktreeManager({ root });
    await wm.create({ repoDir: repo, branch: "task/x", taskId: "x" });
    await expect(
      wm.create({ repoDir: repo, branch: "task/x2", taskId: "x" }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    for (const outside of [repo, base, join(root, ".."), root, join(root, "..", "repo")]) {
      let err: unknown;
      try {
        await wm.remove(outside, { force: true });
      } catch (e) {
        err = e;
      }
      expect(isForerunnerError(err, "path_not_allowed"), `expected refusal for ${outside}`).toBe(
        true,
      );
    }
    expect(await exists(join(repo, "README.md"))).toBe(true);
  });

  it("remove without force keeps a dirty worktree; force drops it", async () => {
    const wm = new WorktreeManager({ root });
    const info = await wm.create({ repoDir: repo, branch: "task/dirty", taskId: "dirty" });
    await writeFile(join(info.path, "untracked.txt"), "work in progress\n");
    await expect(wm.remove(info.path)).rejects.toMatchObject({ code: "validation" });
    expect(await exists(info.path)).toBe(true);
    await wm.remove(info.path, { force: true });
    expect(await exists(info.path)).toBe(false);
  });

  it("lists worktrees that lost their sidecar by reading the .git file", async () => {
    const wm = new WorktreeManager({ root });
    const info = await wm.create({ repoDir: repo, branch: "task/nosidecar", taskId: "nosidecar" });
    await rm(join(root, "nosidecar.worktree.json"));
    const listed = await wm.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe(info.path);
    expect(await readFile(join(listed[0]?.repoDir ?? "", "README.md"), "utf8")).toBe("# test\n");
    await wm.remove(info.path, { force: true });
    expect(await exists(info.path)).toBe(false);
  });

  it("starts from a given base commit", async () => {
    await writeFile(join(repo, "second.txt"), "2\n");
    await run(["git", "-C", repo, "add", "."]);
    await run(["git", "-C", repo, ...GIT_ID, "commit", "-q", "-m", "second"]);
    const wm = new WorktreeManager({ root });
    const info = await wm.create({
      repoDir: repo,
      branch: "task/old",
      taskId: "old",
      base: "HEAD~1",
    });
    expect(await exists(join(info.path, "second.txt"))).toBe(false);
    expect(await exists(join(info.path, "README.md"))).toBe(true);
  });

  it("refuses a base or branch that would reach git as an option", async () => {
    const argvs: string[][] = [];
    const wm = new WorktreeManager({
      root,
      run: async (argv, opts) => {
        argvs.push([...argv]);
        return run(argv, opts);
      },
    });
    for (const base of ["--detach", "-q", " ", ""]) {
      await expect(
        wm.create({ repoDir: repo, branch: "task/b", taskId: `b-${base.length}`, base }),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(
      wm.create({ repoDir: repo, branch: "--orphan", taskId: "br" }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(argvs).toEqual([]);
    expect(await wm.list()).toEqual([]);
  });

  it("remove reports not_found for a directory under the root that is not a worktree", async () => {
    const wm = new WorktreeManager({ root });
    const junk = join(root, "junk");
    await mkdir(junk, { recursive: true });
    await writeFile(join(junk, "keep.txt"), "x");
    await expect(wm.remove(junk)).rejects.toMatchObject({ code: "not_found" });
    await expect(wm.remove(junk, { force: true })).rejects.toMatchObject({ code: "not_found" });
    expect(await exists(join(junk, "keep.txt"))).toBe(true);
  });
});
