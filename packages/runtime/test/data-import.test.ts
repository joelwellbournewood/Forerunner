import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isInside, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkZipEntryName,
  ensureDataDirIgnored,
  isSymlinkEntry,
  WORKTREE_DATA_DIR,
} from "../src/data/import.ts";
import { walkFolder } from "../src/data/walk.ts";
import { type DataHarness, dataHarness, human, makeZip, writeFixture } from "./data-helpers.ts";

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false; // no symlink privilege on this machine (Windows without developer mode)
  }
}

describe("data import: zip", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("extracts under the project data dir, registers each file and lists what was imported", async () => {
    h = await dataHarness();
    const zip = makeZip(join(h.src, "bundle.zip"), [
      { name: "readme.md", data: "# hi\n" },
      { name: "data/", dir: true },
      { name: "data/items.csv", data: "a,b\n1,2\n3,4\n" },
      { name: "data/nested/deep.jsonl", data: '{"x":1}\n' },
    ]);
    const result = await h.importer.importZip(zip, h.projectId, { actor: human });
    expect(result.source).toBe("zip");
    expect(result.entryCount).toBe(4);
    expect(result.imported.map((f) => f.rel)).toEqual([
      "data/items.csv",
      "data/nested/deep.jsonl",
      "readme.md",
    ]);
    expect(result.totalBytes).toBe(5 + 12 + 8);
    expect(result.skipped).toEqual([]);
    expect(result.destination).not.toBeNull();
    const dest = result.destination as string;
    expect(isInside(join(h.assets.projectDataDir(h.projectId), "imports"), dest)).toBe(true);
    expect(readFileSync(join(dest, "data", "items.csv"), "utf8")).toBe("a,b\n1,2\n3,4\n");
    expect(result.imported.every((f) => typeof f.assetId === "string")).toBe(true);
    const views = await h.assets.list(h.projectId);
    expect(views).toHaveLength(3);
    const csv = views.find((v) => v.name === "items.csv");
    expect(csv?.storage).toBe("copied");
    expect(csv?.metadata?.rowCount).toBe(2);
    const audit = await h.store.auditLog.list({ tool: "data.import" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.input_summary).toMatch(/zip bundle\.zip -> 3 files/);
    expect(await h.store.auditLog.count({ tool: "data.register" })).toBe(0);
    expect(result.gitignore).toBeNull();
    // Without registration nothing is written to the store.
    const quiet = await h.importer.importZip(zip, h.projectId, { register: false });
    expect(quiet.imported.every((f) => f.assetId === null)).toBe(true);
  });

  it("rejects zip-slip and absolute entries before writing anything", async () => {
    h = await dataHarness();
    const cases: [string, RegExp][] = [
      ["../evil.txt", /traversal/],
      ["ok/../../evil.txt", /traversal/],
      ["ok\\..\\evil.txt", /traversal/],
      ["/etc/passwd", /absolute/],
      ["C:\\Windows\\win.ini", /absolute/],
      ["\\\\server\\share\\x", /absolute/],
    ];
    for (const [name, re] of cases) {
      const zip = makeZip(join(h.src, `${name.replace(/[^a-z]/gi, "_")}.zip`), [
        { name: "fine.txt", data: "ok" },
        { name, data: "evil" },
      ]);
      await expect(h.importer.importZip(zip, h.projectId)).rejects.toMatchObject({
        code: "validation",
        message: expect.stringMatching(re),
      });
    }
    expect(existsSync(join(h.assets.projectDataDir(h.projectId), "imports"))).toBe(false);
    expect(await h.assets.list(h.projectId)).toEqual([]);
    expect(checkZipEntryName("a/b/../c", 32)).toMatchObject({
      ok: false,
      reject: expect.stringMatching(/traversal/),
    });
    expect(checkZipEntryName("./a/./b.txt", 32)).toEqual({ ok: true, segments: ["a", "b.txt"] });
    expect(checkZipEntryName("dir/CON.txt", 32)).toEqual({
      ok: true,
      segments: ["dir", "_CON.txt"],
    });
    expect(checkZipEntryName("we:ird|name?.txt", 32)).toEqual({
      ok: true,
      segments: ["we_ird_name_.txt"],
    });
    expect(checkZipEntryName("a/b/c/d.txt", 2)).toMatchObject({
      ok: false,
      skip: expect.stringMatching(/depth/),
    });
    expect(checkZipEntryName("__MACOSX/._x", 32)).toMatchObject({
      ok: false,
      skip: expect.stringMatching(/macOS/),
    });
    expect(checkZipEntryName("bad\0name", 32)).toMatchObject({
      ok: false,
      reject: expect.stringMatching(/NUL/),
    });
  });

  it("skips symlink entries and resource forks, lists them, imports the rest", async () => {
    h = await dataHarness();
    const zip = makeZip(join(h.src, "links.zip"), [
      { name: "real.txt", data: "real" },
      { name: "link-to-etc", data: "/etc", symlink: true },
      { name: "__MACOSX/._real.txt", data: "junk" },
    ]);
    const result = await h.importer.importZip(zip, h.projectId);
    expect(result.imported.map((f) => f.rel)).toEqual(["real.txt"]);
    expect(result.skipped).toEqual([
      { rel: "__MACOSX/._real.txt", reason: "macOS resource fork" },
      { rel: "link-to-etc", reason: "symlink" },
    ]);
    const dest = result.destination as string;
    expect(readdirSync(dest)).toEqual(["real.txt"]);
    const AdmZip = (await import("adm-zip")).default;
    const entries = new AdmZip(zip).getEntries();
    expect(entries.filter(isSymlinkEntry).map((e) => e.entryName)).toEqual(["link-to-etc"]);
  });

  it("enforces the entry count and total size limits and cleans up", async () => {
    h = await dataHarness({ maxEntries: 3, maxTotalBytes: 100 });
    const many = makeZip(
      join(h.src, "many.zip"),
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: "x" })),
    );
    await expect(h.importer.importZip(many, h.projectId)).rejects.toMatchObject({
      code: "validation",
      details: { entries: 5, maxEntries: 3 },
    });
    const fat = makeZip(join(h.src, "fat.zip"), [
      { name: "a.txt", data: "a".repeat(60) },
      { name: "b.txt", data: "b".repeat(60) },
    ]);
    await expect(h.importer.importZip(fat, h.projectId)).rejects.toMatchObject({
      code: "validation",
      details: { maxTotalBytes: 100 },
    });
    expect(existsSync(join(h.assets.projectDataDir(h.projectId), "imports"))).toBe(false);
    expect(await h.assets.list(h.projectId)).toEqual([]);
    const notZip = writeFixture(join(h.src, "not.zip"), "this is not an archive");
    await expect(h.importer.importZip(notZip, h.projectId)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(h.importer.importZip("relative.zip", h.projectId)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      h.importer.importZip(join(h.src, "missing.zip"), h.projectId),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(h.importer.importZip(fat, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("data import: folder", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("walks with limits, skips symlinks and VCS dirs, registers each file linked in place", async () => {
    h = await dataHarness();
    const root = join(h.src, "proj");
    writeFixture(join(root, "a.csv"), "x\n1\n");
    writeFixture(join(root, "docs", "b.md"), "# b\n");
    writeFixture(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFixture(join(root, "node_modules", "m", "index.js"), "x");
    const linked = trySymlink(join(root, "a.csv"), join(root, "alias.csv"));
    const result = await h.importer.importFolder(root, h.projectId, { actor: human });
    expect(result.source).toBe("folder");
    expect(result.destination).toBeNull();
    expect(result.imported.map((f) => f.rel)).toEqual(["a.csv", "docs/b.md"]);
    const reasons = result.skipped.map((s) => s.reason);
    expect(reasons).toContain("ignored directory");
    if (linked) expect(result.skipped).toContainEqual({ rel: "alias.csv", reason: "symlink" });
    const views = await h.assets.list(h.projectId);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.storage === "linked")).toBe(true);
    expect(views.find((v) => v.name === "a.csv")?.locator).toBe(join(root, "a.csv"));
    expect(await h.store.auditLog.count({ tool: "data.import" })).toBe(1);
    const walk = walkFolder(root, { maxEntries: 1000, maxTotalBytes: 1e9, maxDepth: 1 });
    expect(walk.truncated).toBe(true);
    expect(walk.limit).toBe("depth");
  });

  it("copy mode copies small folders into the data dir; large ones stay linked with a note", async () => {
    h = await dataHarness({ copyThresholdBytes: 50 });
    const small = join(h.src, "small");
    writeFixture(join(small, "x.txt"), "small");
    writeFixture(join(small, "sub", "y.txt"), "tiny");
    const copied = await h.importer.importFolder(small, h.projectId, { copy: true });
    expect(copied.destination).not.toBeNull();
    expect(readFileSync(join(copied.destination as string, "sub", "y.txt"), "utf8")).toBe("tiny");
    expect(copied.note).toBeNull();
    const views = await h.assets.list(h.projectId);
    expect(views.every((v) => v.storage === "copied")).toBe(true);
    const large = join(h.src, "large");
    writeFixture(join(large, "big.bin"), new Uint8Array(500));
    const linked = await h.importer.importFolder(large, h.projectId, { copy: true });
    expect(linked.destination).toBeNull();
    expect(linked.note).toMatch(/above the copy threshold/);
    expect(linked.imported[0]?.rel).toBe("big.bin");
  });

  it("refuses folders beyond the limits and non-folders", async () => {
    h = await dataHarness({ maxEntries: 2 });
    const root = join(h.src, "wide");
    for (let i = 0; i < 4; i++) writeFixture(join(root, `f${i}.txt`), "x");
    await expect(h.importer.importFolder(root, h.projectId)).rejects.toMatchObject({
      code: "validation",
      details: { limit: "entries" },
    });
    expect(await h.assets.list(h.projectId)).toEqual([]);
    const file = writeFixture(join(h.src, "file.txt"), "x");
    await expect(h.importer.importFolder(file, h.projectId)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      h.importer.importFolder(join(h.src, "missing"), h.projectId),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("data import: gitignore guard", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("creates or appends the ignore lines once, including the data dir when it lies inside the worktree", () => {
    const wt = join(mkTemp(), "wt");
    mkdirSync(wt, { recursive: true });
    const outside = join(wt, "..", "elsewhere", "data");
    const first = ensureDataDirIgnored(wt, outside);
    expect(first.path).toBe(join(wt, ".gitignore"));
    expect(first.added).toEqual([`/${WORKTREE_DATA_DIR}/`]);
    const text = readFileSync(first.path, "utf8");
    expect(text).toMatch(/# Forerunner: project data never goes into git/);
    expect(text.endsWith(`/${WORKTREE_DATA_DIR}/\n`)).toBe(true);
    expect(ensureDataDirIgnored(wt, outside).added).toEqual([]);
    const inside = join(wt, "assets", "data");
    const second = ensureDataDirIgnored(wt, inside);
    expect(second.added).toEqual(["/assets/data/"]);
    expect(
      readFileSync(first.path, "utf8")
        .split("\n")
        .filter((l) => l === `/${WORKTREE_DATA_DIR}/`),
    ).toHaveLength(1);
    // Existing equivalent spellings count as present.
    writeFileSync(first.path, "node_modules\n.forerunner-data/\nassets/data\n");
    expect(ensureDataDirIgnored(wt, inside).added).toEqual([]);
    expect(readFileSync(first.path, "utf8")).toBe("node_modules\n.forerunner-data/\nassets/data\n");
    // A file without a trailing newline gets one before the block.
    writeFileSync(first.path, "dist");
    ensureDataDirIgnored(wt, outside);
    expect(readFileSync(first.path, "utf8").startsWith("dist\n# Forerunner")).toBe(true);
    expect(() => ensureDataDirIgnored(join(wt, "missing"), outside)).toThrow(/not a directory/);
  });

  it("imports run the guard when the worktree is known", async () => {
    h = await dataHarness();
    const wt = join(h.src, "worktree");
    mkdirSync(wt, { recursive: true });
    const zip = makeZip(join(h.src, "z.zip"), [{ name: "a.txt", data: "a" }]);
    const result = await h.importer.importZip(zip, h.projectId, { worktreePath: wt });
    expect(result.gitignore?.added).toEqual([`/${WORKTREE_DATA_DIR}/`]);
    expect(existsSync(join(wt, ".gitignore"))).toBe(true);
    const folder = join(h.src, "folder");
    writeFixture(join(folder, "b.txt"), "b");
    const second = await h.importer.importFolder(folder, h.projectId, { worktreePath: wt });
    expect(second.gitignore?.added).toEqual([]);
  });
});

function mkTemp(): string {
  return mkdtempSync(join(tmpdir(), "fr-gitignore-"));
}
