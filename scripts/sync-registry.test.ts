import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  diffTrees,
  fileHash,
  listFiles,
  readSyncState,
  resolveRegistryDir,
  syncRegistry,
  treeHash,
} from "./sync-registry.ts";

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-registry-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function write(dir: string, rel: string, text: string): void {
  const file = join(dir, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

function fixtureMirror(): string {
  const mirror = tempDir();
  write(mirror, "specialists/coder/specialist.md", "# coder\n");
  write(mirror, "evals/coder/001-task.json", '{"id":"coder-001"}\n');
  write(mirror, "critic/critic.md", "# critic\n");
  write(mirror, "node_modules/ignored.js", "x");
  write(mirror, ".git/HEAD", "ref");
  return mirror;
}

describe("sync-registry hashing", () => {
  it("lists files as sorted posix paths and ignores git, node_modules and the state file", () => {
    const mirror = fixtureMirror();
    write(mirror, ".sync.json", "{}");
    expect(listFiles(mirror)).toEqual([
      "critic/critic.md",
      "evals/coder/001-task.json",
      "specialists/coder/specialist.md",
    ]);
    expect(listFiles(join(mirror, "does-not-exist"))).toEqual([]);
  });

  it("hashes text with normalised line endings so Windows and Linux agree", () => {
    const dir = tempDir();
    write(dir, "lf.md", "a\nb\n");
    write(dir, "crlf.md", "a\r\nb\r\n");
    expect(fileHash(join(dir, "lf.md"))).toBe(fileHash(join(dir, "crlf.md")));
    write(dir, "other.md", "a\nc\n");
    expect(fileHash(join(dir, "lf.md"))).not.toBe(fileHash(join(dir, "other.md")));
  });

  it("tree hash changes when any file changes", () => {
    const mirror = fixtureMirror();
    const before = treeHash(mirror);
    write(mirror, "critic/critic.md", "# critic v2\n");
    expect(treeHash(mirror)).not.toBe(before);
  });
});

describe("sync-registry diff and copy", () => {
  it("dry run reports added, changed and target-only files without copying", () => {
    const mirror = fixtureMirror();
    const registry = tempDir();
    write(registry, "critic/critic.md", "# old critic\n");
    write(registry, "extra/only-here.md", "x\n");
    const lines: string[] = [];
    const res = syncRegistry({ mirror, registry, dryRun: true, log: (l) => lines.push(l) });
    expect(res.applied).toBe(false);
    expect(res.diff.added).toEqual([
      "evals/coder/001-task.json",
      "specialists/coder/specialist.md",
    ]);
    expect(res.diff.changed).toEqual(["critic/critic.md"]);
    expect(res.diff.removed).toEqual(["extra/only-here.md"]);
    expect(existsSync(join(registry, "specialists", "coder", "specialist.md"))).toBe(false);
    expect(readFileSync(join(registry, "critic", "critic.md"), "utf8")).toBe("# old critic\n");
    expect(lines.join("\n")).toContain("(dry run)");
    expect(lines.join("\n")).toContain("2 added, 1 changed, 1 only in target, 0 unchanged");
  });

  it("push copies into an empty registry, records .sync.json, and is idempotent", () => {
    const mirror = fixtureMirror();
    const registry = tempDir();
    const clock = new SimulatedClock("2026-10-20T10:00:00.000Z");
    const first = syncRegistry({ mirror, registry, clock, log: () => {} });
    expect(first.applied).toBe(true);
    expect(listFiles(registry)).toEqual(listFiles(mirror));
    expect(readFileSync(join(registry, "critic", "critic.md"), "utf8")).toBe("# critic\n");
    const state = readSyncState(mirror);
    expect(state?.lastSyncedHash).toBe(treeHash(registry));
    expect(state?.syncedAt).toBe("2026-10-20T10:00:00.000Z");
    const second = syncRegistry({ mirror, registry, clock, log: () => {} });
    expect(second.applied).toBe(true);
    expect(second.diff).toMatchObject({ added: [], changed: [], removed: [] });
    expect(second.diff.unchanged).toHaveLength(3);
  });

  it("refuses to overwrite a registry edited since the last sync unless forced", () => {
    const mirror = fixtureMirror();
    const registry = tempDir();
    syncRegistry({ mirror, registry, log: () => {} });
    write(registry, "critic/critic.md", "# edited in the registry\n");
    write(mirror, "critic/critic.md", "# edited in the mirror\n");
    const refused = syncRegistry({ mirror, registry, log: () => {} });
    expect(refused.applied).toBe(false);
    expect(refused.refused).toContain("changed since the last sync");
    expect(readFileSync(join(registry, "critic", "critic.md"), "utf8")).toBe(
      "# edited in the registry\n",
    );
    const forced = syncRegistry({ mirror, registry, force: true, log: () => {} });
    expect(forced.applied).toBe(true);
    expect(readFileSync(join(registry, "critic", "critic.md"), "utf8")).toBe(
      "# edited in the mirror\n",
    );
  });

  it("refuses a first push over a differing registry with no sync record", () => {
    const mirror = fixtureMirror();
    const registry = tempDir();
    write(registry, "critic/critic.md", "# someone else's critic\n");
    const res = syncRegistry({ mirror, registry, log: () => {} });
    expect(res.applied).toBe(false);
    expect(res.refused).toContain("no .sync.json");
  });

  it("pull copies the registry into the mirror, prune removes target-only files", () => {
    const mirror = fixtureMirror();
    const registry = tempDir();
    write(registry, "critic/critic.md", "# registry critic\n");
    write(registry, "specialists/new/specialist.md", "# new\n");
    const pulled = syncRegistry({ mirror, registry, pull: true, log: () => {} });
    expect(pulled.direction).toBe("pull");
    expect(pulled.applied).toBe(true);
    expect(readFileSync(join(mirror, "critic", "critic.md"), "utf8")).toBe("# registry critic\n");
    expect(existsSync(join(mirror, "specialists", "new", "specialist.md"))).toBe(true);
    // files only in the mirror survive a pull without --prune
    expect(existsSync(join(mirror, "evals", "coder", "001-task.json"))).toBe(true);
    const pruned = syncRegistry({ mirror, registry, pull: true, prune: true, log: () => {} });
    expect(pruned.applied).toBe(true);
    expect(existsSync(join(mirror, "evals", "coder", "001-task.json"))).toBe(false);
    expect(diffTrees(registry, mirror)).toMatchObject({ added: [], changed: [], removed: [] });
  });
});

describe("sync-registry target resolution", () => {
  it("prefers FORERUNNER_REGISTRY_DIR, then a sibling checkout, else none", () => {
    const root = tempDir();
    const repo = join(root, "forerunner");
    mkdirSync(repo);
    const explicit = join(root, "elsewhere");
    expect(resolveRegistryDir({ FORERUNNER_REGISTRY_DIR: explicit }, repo)).toEqual({
      dir: explicit,
      source: "env",
    });
    expect(resolveRegistryDir({}, repo).source).toBe("none");
    mkdirSync(join(root, "forerunner-registry"));
    expect(resolveRegistryDir({}, repo)).toEqual({
      dir: join(root, "forerunner-registry"),
      source: "sibling",
    });
  });
});
