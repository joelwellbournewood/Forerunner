import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { GitOps, gitConfigEnv } from "@forerunner/capabilities/githost/git";
import {
  isInside,
  join,
  Logger,
  type LogRecord,
  relative,
  SimulatedClock,
  toPosix,
} from "@forerunner/platform";
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

/** Every path under `root` (lstat, symlinks never followed), relative with forward slashes, sorted. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      out.push(toPosix(relative(root, p)));
      if (lstatSync(p).isDirectory()) stack.push(p);
    }
  }
  return out.sort();
}

/** A blob in a bare repository. */
function blob(bareDir: string, text: string): Promise<string> {
  return git(["hash-object", "-w", "--stdin"], { cwd: bareDir, input: text });
}

/**
 * A raw tree object written without validation: what `git mktree` and fsck would refuse (`..`
 * and `.git` entries), the shape a hostile remote can serve.
 */
function rawTree(
  bareDir: string,
  entries: { mode: string; name: string; sha: string }[],
): Promise<string> {
  const key = (e: { mode: string; name: string }) => (e.mode === "40000" ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const body = Buffer.concat(
    sorted.map((e) =>
      Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), Buffer.from(e.sha, "hex")]),
    ),
  );
  return git(["hash-object", "-w", "-t", "tree", "--stdin", "--literally"], {
    cwd: bareDir,
    input: body,
  });
}

/** Point `main` of a bare repository at a commit of `tree`. */
async function setMain(bareDir: string, tree: string): Promise<string> {
  const sha = await git(
    ["-c", "user.name=Hostile", "-c", "user.email=h@example.test", "commit-tree", tree, "-m", "x"],
    { cwd: bareDir },
  );
  await git(["update-ref", "refs/heads/main", sha], { cwd: bareDir });
  return sha;
}

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

      // That checkout belongs to the other origin now: the same slug from the host's own origin
      // into the same project is refused before any fetch, and the checkout is left as it was.
      const seen = host.requests().length;
      await expect(
        withDefault.importGitHubRepo({ repo: FULL }, h.projectId, { actor: human }),
      ).rejects.toMatchObject({
        code: "validation",
        message: expect.stringMatching(/belongs to .*localhost/),
      });
      expect(host.requests().length).toBe(seen);
      expect(await new GitOps({ cwd: named.destination as string }).remoteUrl()).toBe(foreign);
      expect((await h.store.project.mustGet(h.projectId)).repos).toEqual([
        "acme/public-tool",
        FULL,
      ]);
    },
  );

  it.skipIf(skipReason())(
    "a hostile repository cannot write outside its checkout, symlinks are never followed, and an empty repository or a clone that never answers leaves nothing behind",
    async () => {
      const base = new DataImporter({
        assets: h.assets,
        store: h.store,
        clock: h.clock,
        vault,
        gitRemoteBase: host.baseUrl,
      });
      const reposDir = join(h.projectsRoot, h.projectId, "repos");
      const chain = new Set([
        "projects",
        `projects/${h.projectId}`,
        `projects/${h.projectId}/repos`,
        `projects/${h.projectId}/repos/acme`,
      ]);
      const checkout = `projects/${h.projectId}/repos/acme/links`;
      // Everything under the harness dir except the directory chain to the checkouts and the one
      // checkout that is meant to exist: what a hostile repository must never add to.
      const outside = () =>
        listTree(h.dir).filter(
          (rel) => !chain.has(rel) && rel !== checkout && !rel.startsWith(`${checkout}/`),
        );
      const before = outside();

      // A tree with `..` and `.git` entries: git refuses the checkout, the import fails, the
      // half clone is removed and nothing appears anywhere under the install's dir.
      const traversal = await host.createRepo({ owner: "acme", name: "traversal", private: false });
      const payload = await blob(traversal.dir, "escaped\n");
      const escapeTree = await rawTree(traversal.dir, [
        { mode: "100644", name: "escape.txt", sha: payload },
      ]);
      const dotGit = await rawTree(traversal.dir, [
        { mode: "100644", name: "config", sha: payload },
      ]);
      await setMain(
        traversal.dir,
        await rawTree(traversal.dir, [
          { mode: "40000", name: "..", sha: escapeTree },
          { mode: "40000", name: ".git", sha: dotGit },
          { mode: "100644", name: "ok.txt", sha: payload },
        ]),
      );
      await expect(
        base.importGitHubRepo({ repo: "acme/traversal" }, h.projectId, { actor: human }),
      ).rejects.toMatchObject({ code: "provider_error" });
      expect(existsSync(join(reposDir, "acme", "traversal"))).toBe(false);
      expect(outside()).toEqual(before);

      // Symlinks pointing outside: written as links by git where the OS allows, never followed
      // by the walk, the asset or the sample; no file lands outside the checkout either way.
      const links = await host.createRepo({ owner: "acme", name: "links", private: false });
      const fine = await blob(links.dir, "fine\n");
      await setMain(
        links.dir,
        await rawTree(links.dir, [
          { mode: "100644", name: "ok.txt", sha: fine },
          { mode: "120000", name: "outside", sha: await blob(links.dir, "../../../../escaped") },
          { mode: "120000", name: "passwd", sha: await blob(links.dir, "/etc/passwd") },
        ]),
      );
      const result = await base.importGitHubRepo({ repo: "acme/links" }, h.projectId, {
        actor: human,
      });
      const dest = result.destination as string;
      expect(dest).toBe(join(reposDir, "acme", "links"));
      const asLinks = lstatSync(join(dest, "outside")).isSymbolicLink();
      if (asLinks) {
        expect(result.imported.map((f) => f.rel)).toEqual(["ok.txt"]);
        expect(result.skipped).toEqual([
          { rel: "outside", reason: "symlink" },
          { rel: "passwd", reason: "symlink" },
        ]);
      } else {
        // git had no symlink support here (Windows without the privilege): plain files holding
        // the link text, which point nowhere.
        expect(result.imported.map((f) => f.rel)).toEqual(["ok.txt", "outside", "passwd"]);
      }
      expect(outside()).toEqual(before);
      const [view] = await h.assets.list(h.projectId);
      expect(view?.metadata?.entries).toBe(asLinks ? 1 : 3);
      const sample = await h.assets.sample(view?.id ?? "");
      expect(sample.kind).toBe("entries");
      expect(sample.entries?.some((e) => /escaped|passwd:/.test(e))).toBe(false);

      // An empty repository: cloned, refused at the default branch, and the clone removed.
      await host.createRepo({ owner: "acme", name: "empty", private: false });
      await expect(
        base.importGitHubRepo({ repo: "acme/empty" }, h.projectId, { actor: human }),
      ).rejects.toMatchObject({
        code: "validation",
        message: expect.stringMatching(/default branch/),
      });
      expect(existsSync(join(reposDir, "acme", "empty"))).toBe(false);

      // A server that accepts the connection and never answers: the clone is killed at the
      // importer's git limit and reported as a timeout, the half clone removed.
      const sockets: Socket[] = [];
      const server = createServer((s) => {
        sockets.push(s);
        // The killed git client drops the connection; on Windows the server side reads it as
        // ECONNRESET, which would be an unhandled error on the socket (CI run 139).
        s.on("error", () => {});
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      const slow = new DataImporter({
        assets: h.assets,
        store: h.store,
        clock: h.clock,
        vault,
        gitTimeoutMs: 1500,
      });
      try {
        await expect(
          slow.importGitHubRepo(
            { repo: `http://127.0.0.1:${port}/acme/slow.git`, tokenRef: "secret:github_token" },
            h.projectId,
            { actor: human },
          ),
        ).rejects.toMatchObject({
          code: "timeout",
          message: expect.stringMatching(/clone timed out after 1500 ms/),
        });
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      }
      expect(existsSync(join(reposDir, "acme", "slow"))).toBe(false);
      expect(outside()).toEqual(before);

      // Only the links import was recorded.
      expect(await h.store.auditLog.count({ tool: "data.import" })).toBe(1);
      expect((await h.store.project.mustGet(h.projectId)).repos).toEqual(["acme/links"]);
      expect(await h.assets.list(h.projectId)).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(token.token);
    },
  );

  it.skipIf(skipReason())(
    "a url.*.insteadOf rewrite in the user's git config cannot carry the token to another origin",
    async () => {
      // The user's git config (here: the process environment git reads) rewrites the host's
      // origin to the same server under another name. The header is scoped to the origin the
      // token belongs to, so the rewritten request carries no Authorization and the private
      // repository refuses it; nothing is left behind.
      const localBase = host.baseUrl.replace("127.0.0.1", "localhost");
      const added = gitConfigEnv(process.env, `url.${localBase}/.insteadOf`, `${host.baseUrl}/`);
      const previous = Object.fromEntries(Object.keys(added).map((k) => [k, process.env[k]]));
      Object.assign(process.env, added);
      const dir = join(h.projectsRoot, h.projectId, "repos", "acme", "service");
      try {
        const seen = host.requests().length;
        await expect(
          importer.importGitHubRepo(
            { repo: host.cloneUrl(FULL), tokenRef: "secret:github_token" },
            h.projectId,
            { actor: human },
          ),
        ).rejects.toMatchObject({ code: "provider_error" });
        const reached = host
          .requests()
          .slice(seen)
          .filter((r) => r.path.startsWith(`/${FULL}.git`));
        expect(reached.length).toBeGreaterThan(0);
        expect(reached.every((r) => r.auth === null)).toBe(true);
        expect(existsSync(dir)).toBe(false);
        expect(await h.assets.list(h.projectId)).toEqual([]);
      } finally {
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      // Without the rewrite the same request reaches the origin the token belongs to.
      const ok = await importer.importGitHubRepo(
        { repo: host.cloneUrl(FULL), tokenRef: "secret:github_token" },
        h.projectId,
        { actor: human },
      );
      expect(ok.repository?.slug).toBe(FULL);
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(token.token);
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
