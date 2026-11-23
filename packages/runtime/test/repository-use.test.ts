import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path"; // path-ok: path.win32 builds the Windows form the identity compares
import { type GitHost, MemoryGitHost } from "@forerunner/capabilities";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type IdentityFs,
  identityOf,
  type LinkIdentity,
  projectIdsOf,
  RepositoryIndex,
  type RepositoryRead,
  RepositoryUse,
  sameLink,
  verdictOf,
} from "../src/sources/repository-use.ts";

silenceSqliteExperimentalWarning();

// No git process ever runs for a link's identity (the folder is the person's): every way of
// starting one is counted here, and the cases below assert none was.
const spawned: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const count =
    (name: string) =>
    (...args: unknown[]) => {
      spawned.push(`${name} ${String(args[0])}`);
      return (real as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args);
    };
  return {
    ...real,
    spawn: count("spawn"),
    spawnSync: count("spawnSync"),
    exec: count("exec"),
    execSync: count("execSync"),
    execFile: count("execFile"),
    execFileSync: count("execFileSync"),
    fork: count("fork"),
  };
});

function identity(entry: string, opts: Parameters<typeof identityOf>[1] = {}): LinkIdentity {
  const r = identityOf(entry, opts);
  if (r.kind !== "identity") throw new Error(`no identity for ${entry}: ${r.kind}`);
  return r.identity;
}

/**
 * A reader over a map of files and folders, in Windows paths (the cases of validation rule 5
 * run on any computer): a key ending in "\" is a folder, any other key a file with its text.
 */
function windowsFs(entries: Record<string, string>): IdentityFs {
  const norm = (p: string) => nodePath.win32.resolve(p).toLowerCase();
  const dirs = new Set(
    Object.keys(entries)
      .filter((k) => k.endsWith("\\"))
      .map((k) => norm(k)),
  );
  const files = new Map(
    Object.entries(entries)
      .filter(([k]) => !k.endsWith("\\"))
      .map(([k, v]) => [norm(k), v]),
  );
  return {
    isDirectory: (p) => dirs.has(norm(p)),
    isFile: (p) => files.has(norm(p)),
    readText: (p) => files.get(norm(p)) ?? null,
    realPath: () => null,
  };
}

describe("d1109-onerepo-link, run C: one identity for a link (OR-01)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fr-repo-use-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("every spelling of a GitHub repository is one identity", () => {
    const spellings = [
      "o/n",
      "o/n.git",
      "O/N",
      "github.com/o/n",
      "www.github.com/o/n/tree/main",
      "https://github.com/o/n.git",
      "git@github.com:o/n.git",
      "ssh://git@github.com/o/n.git",
    ];
    const first = identity(spellings[0] as string);
    expect(first.keys).toEqual(["github:o/n"]);
    for (const s of spellings) {
      const id = identity(s);
      expect(id.kind, s).toBe("repo");
      expect(sameLink(first, id), s).toBe(true);
    }
    expect(sameLink(first, identity("o/other"))).toBe(false);
  });

  it("a URL on another git host is refused, not read as GitHub's repository of that name", () => {
    expect(identityOf("https://gitlab.com/o/n")).toEqual({
      kind: "other_host",
      host: "gitlab.com",
      entry: "https://gitlab.com/o/n",
    });
    expect(identityOf("git@gitlab.com:o/n.git")).toMatchObject({ kind: "other_host" });
  });

  it("a folder and a subfolder of it, a clone (origin in .git/config) and a worktree are one link", () => {
    spawned.length = 0;
    // The linked repository's folder, with spaces and non-ASCII letters in its path.
    const site = join(root, "Mes projets", "Café site");
    mkdirSync(join(site, ".git"), { recursive: true });
    writeFileSync(
      join(site, ".git", "config"),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/site.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    mkdirSync(join(site, "src", "pages"), { recursive: true });
    // A worktree of it: a `.git` file whose gitdir and commondir lead back to it.
    const wt = join(root, "Mes projets", "site-wt");
    mkdirSync(join(site, ".git", "worktrees", "site-wt"), { recursive: true });
    writeFileSync(join(site, ".git", "worktrees", "site-wt", "commondir"), "../..\n");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(site, ".git", "worktrees", "site-wt")}\n`);
    // Another clone of the same repository somewhere else.
    const clone = join(root, "elsewhere", "site-clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    writeFileSync(
      join(clone, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:O/site.git\n',
    );
    // A folder with nothing to do with it.
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });

    const linked = identity(site);
    expect(linked.kind).toBe("folder");
    expect(linked.repo?.locator).toBe("o/site");
    expect(sameLink(identity(join(site, "src", "pages")), linked)).toBe(true);
    expect(sameLink(identity(`${site}/`), linked)).toBe(true);
    expect(sameLink(identity(wt), linked)).toBe(true);
    expect(sameLink(identity(clone), linked)).toBe(true);
    expect(sameLink(identity("https://github.com/o/site"), linked)).toBe(true);
    expect(sameLink(identity(other), linked)).toBe(false);
    // No git process for any of it: the files only.
    expect(spawned).toEqual([]);
  });

  it("a folder inside a linked one counts only without a git root of its own below it", () => {
    const code = join(root, "Code");
    mkdirSync(join(code, "notes"), { recursive: true });
    mkdirSync(join(code, "shop", ".git"), { recursive: true });
    const linked = identity(code);
    expect(sameLink(identity(join(code, "notes")), linked)).toBe(true);
    expect(sameLink(identity(join(code, "shop")), linked)).toBe(false);
  });

  it("Windows paths compare without case and a trailing separator; Linux paths by case", () => {
    const fs = windowsFs({});
    const a = identity("C:\\Code\\Site", { platform: "windows", fs });
    const b = identity("c:\\code\\site\\", { platform: "windows", fs });
    expect(sameLink(a, b, "windows")).toBe(true);
    // Another drive is another link.
    expect(sameLink(a, identity("D:\\Code\\Site", { platform: "windows", fs }), "windows")).toBe(
      false,
    );
    // On Linux a path's case is part of it.
    const l1 = identity("/srv/Code/Site", { platform: "linux", fs: windowsFs({}) });
    const l2 = identity("/srv/code/site", { platform: "linux", fs: windowsFs({}) });
    expect(sameLink(l1, l2, "linux")).toBe(false);
    // A path longer than 260 characters is compared like any other.
    const long = `C:\\${"deep\\".repeat(60)}project`;
    expect(long.length).toBeGreaterThan(260);
    expect(
      sameLink(
        identity(long, { platform: "windows", fs }),
        identity(long.toUpperCase(), { platform: "windows", fs }),
        "windows",
      ),
    ).toBe(true);
  });

  it("validation rule 5 on Windows: a broad linked folder never swallows the repositories in it", () => {
    const fs = windowsFs({
      "C:\\Code\\": "",
      "C:\\Code\\notes\\": "",
      "C:\\Code\\shop\\": "",
      "C:\\Code\\shop\\.git\\": "",
    });
    const code = identity("C:\\Code", { platform: "windows", fs });
    expect(
      sameLink(identity("C:\\Code\\notes", { platform: "windows", fs }), code, "windows"),
    ).toBe(true);
    expect(sameLink(identity("C:\\Code\\shop", { platform: "windows", fs }), code, "windows")).toBe(
      false,
    );
  });
});

describe("d1109-onerepo-link, run C: the projects that use a link (OR-01)", () => {
  let store: StateStore;
  const clock = new SimulatedClock("2026-11-15T09:00:00.000Z");
  let humanId: string;

  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    humanId = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
  });
  afterAll(async () => {
    await store.close();
  });

  it("a removed project uses nothing; a project joined into another counts as that one", async () => {
    const site = await store.project.insert({
      name: "Site",
      goal: "g",
      repos: ["https://github.com/o/site"],
      author_human: humanId,
    });
    // Removed by the Undo of its creation (W15-36): archived, its old name kept.
    await store.project.insert({
      name: "Shop (removed)",
      goal: "g",
      repos: ["o/shop"],
      status: "archived",
      active: false,
      settings: { removed_name: "Shop" },
      author_human: humanId,
    });
    // "Kite" was joined into "Kite club" (d1109-onerepo-join writes joined_from on the keeper).
    const kite = await store.project.insert({
      name: "Kite",
      goal: "g",
      repos: ["o/kite"],
      author_human: humanId,
    });
    const club = await store.project.insert({
      name: "Kite club",
      goal: "g",
      repos: ["o/kite-club"],
      settings: { joined_from: [kite.id] },
      author_human: humanId,
    });
    const index = await RepositoryIndex.read(store);
    expect(index.projectsUsing(identity("O/Site.git")).map((u) => u.project.name)).toEqual([
      "Site",
    ]);
    expect(index.projectsUsing(identity("o/shop"))).toEqual([]);
    expect(index.projectsUsing(identity("o/kite")).map((u) => u.project.id)).toEqual([club.id]);
    expect(projectIdsOf(club)).toEqual([club.id, kite.id]);
    expect(index.soleUser({ owner: "o", name: "site" })?.id).toBe(site.id);
  });
});

describe("d1109-onerepo-join, run C: a GitHub that does not answer, and an unknown author (C2-left-10)", () => {
  const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
  const clock = new SimulatedClock("2026-03-05T08:00:00.000Z");
  const daysAgo = (n: number) => new Date(clock.now() - n * 24 * 3600_000).toISOString();
  let store: StateStore;
  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
  });
  afterAll(async () => {
    await store.close();
  });

  /** A host whose every call never answers (GitHub that hangs rather than refuses). */
  const hanging = (): GitHost =>
    new Proxy({} as GitHost, {
      // Not a thenable itself (`then` is no method), so the host can be awaited.
      get: (_t, key) => (key === "then" ? undefined : () => new Promise<never>(() => undefined)),
    });

  it("a read that never answers counts as one that failed: creation goes on without it, Work together and Take it over are refused in words, each within the wait", async () => {
    const use = new RepositoryUse({ store, clock, host: async () => hanging(), readWaitMs: 50 });
    const started = Date.now();
    expect(await use.check(["o/kite"])).toEqual({ repository: { owner: "o", name: "kite" } });
    await expect(use.check(["o/kite"], { together: { project: KITE } })).rejects.toThrow(
      "GitHub did not answer, so the project cannot be checked. Try again.",
    );
    const project = await store.project.insert({ name: "Kite here", repos: ["o/kite"] });
    await expect(use.takeOverFacts(project.id)).rejects.toThrow(
      "GitHub did not answer, so the repository cannot be checked. Try again.",
    );
    expect(await use.takeOverUndoBlocked(project.id, "", null)).toBe(
      "GitHub did not answer, so the repository cannot be checked. Try again",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a pull request whose author GitHub does not name counts as another account's: no Take it over within the 14 days", async () => {
    const host = new MemoryGitHost("alice");
    host.now = () => clock.nowIso();
    const repo = { owner: "o", name: "unknown-author" };
    await host.createRepo({ ...repo, private: true });
    await host.putFile(repo, {
      path: ".forerunner/project.json",
      content: JSON.stringify({ schema: 1, project: KITE, name: "Kite club" }),
      message: "marker",
      branch: "main",
    });
    const pr = await host.openPullRequestAs(repo, "bob", {
      title: "Work",
      body: `Work.\n\n<!-- forerunner:pr project=${KITE} task=t1 -->`,
      head: "fr/work",
      updatedAt: daysAgo(3),
    });
    // GitHub gave no author (a deleted account, an app): unknown is never "nobody".
    const list = host.listPullRequests.bind(host);
    host.listPullRequests = async (...args) =>
      (await list(...args)).map((p) => (p.number === pr.number ? { ...p, authorLogin: null } : p));
    const use = new RepositoryUse({ store, clock, host: async () => host });
    const refused = await use.check(["o/unknown-author"]).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      details: { cause: "repository_used_elsewhere", canWorkTogether: true, canTakeOver: false },
    });
  });
});

describe("l4-github-link, run L4", () => {
  const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
  const clock = new SimulatedClock("2026-03-05T08:00:00.000Z");
  let store: StateStore;
  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
  });
  afterAll(async () => {
    await store.close();
  });

  const read = (marker: string | null): RepositoryRead => ({
    marker: marker ? { project: marker, name: "Kite club" } : null,
    markerUnreadable: false,
    marked: [],
    login: "alice",
  });

  it("L4-github-101: a removed project's take-over no longer makes an id known, so the repository's project is elsewhere again (ADR 0117 point 2); a kept project's take-over and a joined project's still count", async () => {
    // The project made with Take it over, its creation then undone (W15-36): archived with its
    // old name kept, `took_over` left on the row.
    const removed = await store.project.insert({
      name: "Kite flyers (removed)",
      goal: "g",
      repos: ["o/kite"],
      status: "archived",
      active: false,
      settings: {
        removed_name: "Kite flyers",
        took_over: { projects: [KITE], name: "Kite club", at: clock.nowIso() },
      },
    });
    let index = await RepositoryIndex.read(store);
    expect(index.knows(KITE)).toBe(false);
    const verdict = verdictOf(read(KITE), index, clock.now());
    expect(verdict).toMatchObject({
      kind: "elsewhere",
      elsewhere: { ids: [KITE], name: "Kite club", canWorkTogether: true, canTakeOver: true },
    });
    // The check every entry point runs answers the offer again, never "free".
    const host = new MemoryGitHost("alice");
    await host.createRepo({ owner: "o", name: "kite", private: true });
    await host.putFile(
      { owner: "o", name: "kite" },
      {
        path: ".forerunner/project.json",
        content: JSON.stringify({ schema: 1, project: KITE, name: "Kite club" }),
        message: "marker",
        branch: "main",
      },
    );
    const use = new RepositoryUse({ store, clock, host: async () => host });
    await expect(use.check(["o/kite"])).rejects.toMatchObject({
      details: {
        cause: "repository_used_elsewhere",
        projects: [KITE],
        canWorkTogether: true,
        canTakeOver: true,
      },
    });
    // The removed project's own id still frees the repository (run C decision 14).
    expect(verdictOf(read(removed.id), index, clock.now())).toEqual({
      kind: "removed",
      projectId: removed.id,
    });
    // A project here that took it over (not removed) still makes the id known.
    const kept = await store.project.insert({
      name: "Kites",
      goal: "g",
      repos: ["o/other-kite"],
      settings: { took_over: { projects: [KITE], name: "Kite club", at: clock.nowIso() } },
    });
    index = await RepositoryIndex.read(store);
    expect(index.knows(KITE)).toBe(true);
    expect(verdictOf(read(KITE), index, clock.now())).toEqual({ kind: "free" });
    // A joined project (archived with joined_into) still counts through its keeper.
    await store.project.update(kept.id, kept.version, { settings: {} });
    const joined = await store.project.insert({
      name: "Kite old",
      goal: "g",
      repos: [],
      status: "archived",
      active: false,
      settings: { joined_into: { project: kept.id, name: "Kites", at: clock.nowIso() } },
    });
    await store.project.insert({
      name: "Keeper",
      goal: "g",
      repos: ["o/keeper"],
      settings: { joined_from: [joined.id] },
    });
    index = await RepositoryIndex.read(store);
    expect(index.knows(joined.id)).toBe(true);
    expect(index.knows(KITE)).toBe(false);
  });
});
