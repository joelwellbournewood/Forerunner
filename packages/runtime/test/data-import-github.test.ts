import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps } from "@forerunner/capabilities/githost/git";
import { isInside, join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost, git, type IssuedToken, locateHttpBackend } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DataImporter,
  type GitHubImportInput,
  MIGRATION_BRANCH_PREFIX,
  migrationBranchName,
  parseRepositorySource,
} from "../src/data/import.ts";
import { ImportResultView } from "../src/data/types.ts";
import { type DataHarness, dataHarness, human } from "./data-helpers.ts";

/**
 * Import of an existing GitHub repository (spec A.3: "Import from ZIP, local folder or existing
 * GitHub repo. The original is preserved untouched; migration runs on a branch.") against the
 * fake git host over git smart HTTP. The clone lands under the project's repos dir inside the
 * install's data dir, the migration branch is opened from the default branch, the default
 * branch is never written (not on the remote, not locally), the token reaches git only through
 * the process environment by a vault reference and never a log line, a row or the result, and
 * a re-import of the same repository reuses the worktree, the branch and the asset row.
 */
// Resolved at module load so skipIf() can see it when the suite is collected.
const backend = await locateHttpBackend();
const skipReason = () => (backend ? false : "git http-backend not found next to git --exec-path");

const FULL = "acme/service";

// Dozens of git subprocesses behind an HTTP CGI: well over the 20 s default under load.
describe("data import: github repository", { timeout: 120_000 }, () => {
  let root: string;
  let host: FakeGitHost;
  let token: IssuedToken;
  let repoDir: string;
  let h: DataHarness;
  let vault: MemoryVault;
  let importer: DataImporter;
  let logs: LogRecord[];
  let stopLogs: () => void;

  const remoteSha = (ref: string) => git(["rev-parse", ref], { cwd: repoDir });
  const remoteBranches = async () =>
    (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repoDir }))
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fr-import-gh-"));
    host = await FakeGitHost.start({
      rootDir: root,
      clock: new SimulatedClock("2026-03-01T09:00:00.000Z"),
    });
    host.createUser({ login: "alice", name: "Alice", email: "alice@example.test" });
    host.createOrg({ login: "acme", members: ["alice"] });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] });
    const repo = await host.createRepo({
      owner: "acme",
      name: "service",
      private: true,
      initialFiles: { "README.md": "# service\n", "src/app.ts": "export const x = 1;\n" },
    });
    repoDir = repo.dir;
    await host.createRepo({
      owner: "acme",
      name: "public-tool",
      private: false,
      initialFiles: { "tool.sh": "#!/bin/sh\n" },
    });
  });

  afterAll(async () => {
    await host?.stop();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h = await dataHarness();
    vault = new MemoryVault({ github_token: token.token });
    importer = new DataImporter({ assets: h.assets, store: h.store, clock: h.clock, vault });
    logs = [];
    stopLogs = Logger.addSink((r) => logs.push(r));
  });

  afterEach(async () => {
    stopLogs?.();
    await h?.close();
  });

  it.skipIf(skipReason())(
    "clones under the project's repos dir, opens the migration branch, never writes the default branch, keeps the token out of every surface, and re-imports idempotently",
    async () => {
      const mainBefore = await remoteSha("refs/heads/main");
      expect(await remoteBranches()).toEqual(["main"]);

      const result = await importer.importGitHubRepo(
        { repo: host.cloneUrl(FULL), tokenRef: "secret:github_token" },
        h.projectId,
        { actor: human },
      );
      ImportResultView.parse(result);
      expect(result.source).toBe("github");
      expect(result.note).toBeNull();
      expect(result.gitignore).toBeNull();
      const dest = result.destination as string;
      expect(dest).not.toBeNull();
      expect(isInside(join(h.projectsRoot, h.projectId, "repos"), dest)).toBe(true);
      expect(isInside(h.assets.projectDataDir(h.projectId), dest)).toBe(false);
      expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("# service\n");
      expect(result.imported.map((f) => f.rel)).toEqual(["README.md", "src/app.ts"]);
      expect(result.totalBytes).toBe(10 + 20);
      expect(result.skipped).toEqual([]);
      const branch = `${MIGRATION_BRANCH_PREFIX}2026-03-02`;
      expect(result.repository).toMatchObject({
        slug: FULL,
        url: `${host.baseUrl}/${FULL}.git`,
        worktree: dest,
        branch,
        defaultBranch: "main",
        headSha: mainBefore,
        reused: false,
      });
      expect(typeof result.repository?.assetId).toBe("string");

      // The checkout sits on the migration branch, which starts at the default branch's head.
      const wt = new GitOps({ cwd: dest });
      expect(await wt.currentBranch()).toBe(branch);
      expect(await wt.headSha()).toBe(mainBefore);
      // The original is untouched: the remote has its one branch at the same commit, nothing
      // was pushed, and the local default branch still equals the remote's.
      expect(await remoteBranches()).toEqual(["main"]);
      expect(await remoteSha("refs/heads/main")).toBe(mainBefore);
      expect(await git(["rev-parse", "refs/heads/main"], { cwd: dest })).toBe(mainBefore);
      expect(await git(["rev-parse", "refs/remotes/origin/main"], { cwd: dest })).toBe(mainBefore);

      // One folder asset stands for the checkout; the project links the repository once.
      const views = await h.assets.list(h.projectId);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        id: result.repository?.assetId,
        kind: "folder",
        storage: "linked",
        locator: dest,
        name: FULL,
        projectIds: [h.projectId],
        registeredBy: "h-1",
      });
      expect(views[0]?.metadata?.entries).toBe(2);
      const project = await h.store.project.mustGet(h.projectId);
      expect(project.repos).toEqual([FULL]);
      expect(project.data_assets).toEqual([result.repository?.assetId]);
      const audit = await h.store.auditLog.list({ tool: "data.import" });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.input_summary).toMatch(
        /github acme\/service -> forerunner\/migration-2026-03-02/,
      );
      expect(audit[0]?.human_id).toBe("h-1");
      expect(await h.store.auditLog.count({ tool: "data.register" })).toBe(0);

      // The token value is nowhere: not in a log line, a row, the result, or the clone's config.
      const surfaces = JSON.stringify({
        logs,
        result,
        views,
        project,
        audit,
        assets: await h.store.dataAsset.list({} as never, { limit: 50 }),
      });
      expect(surfaces).not.toContain(token.token);
      expect(surfaces).toContain("github_token");
      expect(readFileSync(join(dest, ".git", "config"), "utf8")).not.toContain(token.token);
      expect(logs.some((r) => r.scope === "data:import" && /github/.test(r.msg))).toBe(true);

      // Work on the migration branch leaves the default branch alone, locally and remotely.
      writeFileSync(join(dest, "MIGRATION.md"), "# migration notes\n");
      const commit = await new GitOps({
        cwd: dest,
        identity: { name: "T", email: "t@example.test" },
      }).commitAll("migration: notes");
      expect(commit.committed).toBe(true);
      expect(commit.sha).not.toBe(mainBefore);
      expect(await git(["rev-parse", "refs/heads/main"], { cwd: dest })).toBe(mainBefore);
      expect(await remoteSha("refs/heads/main")).toBe(mainBefore);
      expect(await remoteBranches()).toEqual(["main"]);

      // Re-import: same worktree, the branch and its commit kept, no second row or link.
      h.clock.advance(3 * 24 * 3_600_000);
      const again = await importer.importGitHubRepo(
        { repo: host.cloneUrl(FULL), tokenRef: "secret:github_token" },
        h.projectId,
        { actor: human },
      );
      expect(again.destination).toBe(dest);
      expect(again.repository).toMatchObject({
        slug: FULL,
        worktree: dest,
        branch,
        defaultBranch: "main",
        headSha: commit.sha,
        assetId: result.repository?.assetId,
        reused: true,
      });
      expect(again.imported.map((f) => f.rel)).toEqual(["MIGRATION.md", "README.md", "src/app.ts"]);
      expect(await wt.currentBranch()).toBe(branch);
      expect(await wt.headSha()).toBe(commit.sha);
      expect(readFileSync(join(dest, "MIGRATION.md"), "utf8")).toBe("# migration notes\n");
      expect(await h.assets.list(h.projectId)).toHaveLength(1);
      expect((await h.store.project.mustGet(h.projectId)).repos).toEqual([FULL]);
      expect(await h.store.auditLog.count({ tool: "data.import" })).toBe(2);
      expect(await remoteSha("refs/heads/main")).toBe(mainBefore);
      expect(await remoteBranches()).toEqual(["main"]);
      expect(JSON.stringify({ logs, again })).not.toContain(token.token);
    },
  );

  it.skipIf(skipReason())(
    "resolves owner/name against the git base, clones a public repository without a token, and sends the install's default reference only to that git host",
    async () => {
      const base = new DataImporter({
        assets: h.assets,
        store: h.store,
        clock: h.clock,
        vault,
        gitRemoteBase: host.baseUrl,
      });
      const pub = await base.importGitHubRepo({ repo: "acme/public-tool" }, h.projectId, {
        actor: human,
      });
      expect(pub.repository?.url).toBe(`${host.baseUrl}/acme/public-tool.git`);
      expect(pub.imported.map((f) => f.rel)).toEqual(["tool.sh"]);
      expect((await h.store.project.mustGet(h.projectId)).repos).toEqual(["acme/public-tool"]);
      // Without register the row is skipped but the link and the clone still happen.
      const quiet = await base.importGitHubRepo({ repo: "acme/public-tool" }, h.otherProjectId, {
        actor: human,
        register: false,
      });
      expect(quiet.repository?.assetId).toBeNull();
      expect(await h.assets.list(h.otherProjectId)).toEqual([]);
      expect((await h.store.project.mustGet(h.otherProjectId)).repos).toEqual(["acme/public-tool"]);

      // A private repository without a token fails at the clone, the half worktree is removed and
      // nothing is recorded; with the install's default reference it works.
      await expect(
        base.importGitHubRepo({ repo: FULL }, h.otherProjectId, { actor: human }),
      ).rejects.toMatchObject({ code: "provider_error" });
      const dir = join(h.projectsRoot, h.otherProjectId, "repos", "acme", "service");
      expect(existsSync(dir)).toBe(false);
      expect(await h.assets.list(h.otherProjectId)).toEqual([]);
      expect((await h.store.project.mustGet(h.otherProjectId)).repos).toEqual(["acme/public-tool"]);
      const withDefault = new DataImporter({
        assets: h.assets,
        store: h.store,
        clock: h.clock,
        vault,
        gitRemoteBase: host.baseUrl,
        defaultTokenRef: "secret:github_token",
      });
      const priv = await withDefault.importGitHubRepo({ repo: FULL }, h.otherProjectId, {
        actor: human,
      });
      expect(priv.repository?.slug).toBe(FULL);
      expect(existsSync(join(dir, "README.md"))).toBe(true);

      // The install's token goes to the git host it belongs to and nowhere else: the same
      // server under another origin gets an anonymous clone (and a private repository fails),
      // while a reference the caller names explicitly is used for any host.
      const foreign = `${host.baseUrl.replace("127.0.0.1", "localhost")}/${FULL}.git`;
      expect(new URL(foreign).origin).not.toBe(new URL(host.baseUrl).origin);
      await expect(
        withDefault.importGitHubRepo({ repo: foreign }, h.projectId, { actor: human }),
      ).rejects.toMatchObject({ code: "provider_error" });
      expect(existsSync(join(h.projectsRoot, h.projectId, "repos", "acme", "service"))).toBe(false);
      const named = await withDefault.importGitHubRepo(
        { repo: foreign, tokenRef: "secret:github_token" },
        h.projectId,
        { actor: human },
      );
      expect(named.repository?.url).toBe(foreign);
      expect(JSON.stringify({ logs, priv, pub, quiet, named })).not.toContain(token.token);
    },
  );

  it.skipIf(skipReason())(
    "refuses credentials in the URL, an unknown secret reference, a non-http remote and a missing project before touching the disk or the network",
    async () => {
      const requests = host.requests().length;
      const cases: [GitHubImportInput, string, RegExp][] = [
        [{ repo: host.cloneUrl(FULL, token.token) }, "validation", /credentials/],
        [{ repo: `${host.baseUrl}/${FULL}.git`, tokenRef: "ghp_notaref" }, "validation", /secret/],
        [{ repo: `${host.baseUrl}/${FULL}.git`, tokenRef: "secret:nope" }, "not_found", /nope/],
        [{ repo: "git@github.com:acme/service.git" }, "validation", /http/],
        [{ repo: "ssh://git@host/acme/service.git" }, "validation", /http/],
        [{ repo: `${host.baseUrl}/service.git` }, "validation", /owner\/name/],
        [{ repo: "" }, "validation", /repository/],
      ];
      for (const [input, code, re] of cases) {
        await expect(importer.importGitHubRepo(input, h.projectId)).rejects.toMatchObject({
          code,
          message: expect.stringMatching(re),
        });
      }
      await expect(
        importer.importGitHubRepo({ repo: host.cloneUrl(FULL) }, "no-such-project"),
      ).rejects.toMatchObject({ code: "not_found" });
      const noVault = new DataImporter({ assets: h.assets, store: h.store, clock: h.clock });
      await expect(
        noVault.importGitHubRepo(
          { repo: host.cloneUrl(FULL), tokenRef: "secret:github_token" },
          h.projectId,
        ),
      ).rejects.toMatchObject({ code: "not_supported" });
      expect(existsSync(join(h.projectsRoot, h.projectId, "repos"))).toBe(false);
      expect(await h.assets.list(h.projectId)).toEqual([]);
      expect((await h.store.project.mustGet(h.projectId)).repos).toEqual([]);
      expect(host.requests().length).toBe(requests);
      expect(JSON.stringify(logs)).not.toContain(token.token);
    },
  );

  it("names the migration branch from the clock and parses repository sources without credentials", () => {
    expect(migrationBranchName(new SimulatedClock("2026-10-23T23:59:59Z"))).toBe(
      "forerunner/migration-2026-10-23",
    );
    expect(parseRepositorySource("acme/service", "https://github.com")).toEqual({
      owner: "acme",
      name: "service",
      slug: "acme/service",
      url: "https://github.com/acme/service.git",
    });
    expect(parseRepositorySource("https://github.com/acme/service", "https://github.com")).toEqual({
      owner: "acme",
      name: "service",
      slug: "acme/service",
      url: "https://github.com/acme/service.git",
    });
    expect(
      parseRepositorySource("https://ghe.example.test/org/sub/Repo.git/", "https://github.com"),
    ).toEqual({
      owner: "sub",
      name: "Repo",
      slug: "sub/Repo",
      url: "https://ghe.example.test/org/sub/Repo.git",
    });
    expect(
      parseRepositorySource("http://127.0.0.1:8080/a/b.git?x=1#frag", "https://github.com").url,
    ).toBe("http://127.0.0.1:8080/a/b.git");
    expect(() =>
      parseRepositorySource("https://user:pw@github.com/a/b", "https://github.com"),
    ).toThrow(/credentials/);
    expect(() => parseRepositorySource("acme/../service", "https://github.com")).toThrow(
      /repository/,
    );
    expect(() => parseRepositorySource("acme", "https://github.com")).toThrow(/repository/);
  });
});
