import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GitHubHost } from "@forerunner/capabilities";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AddSourceInput,
  folderKey,
  keysOfProject,
  parseRepoLocator,
  repoKey,
  type SourceActor,
  SourceDiscovery,
} from "../src/sources/index.ts";

silenceSqliteExperimentalWarning();

/**
 * Source discovery (spec A.4): the human connects GitHub orgs, accounts, chosen repositories
 * and local folders; a scan lists what is there through the git host port (paged) or the
 * file system, proposes one project per repository or folder, detects an existing Forerunner
 * install, never proposes what a project already covers twice, and a rescan is idempotent.
 * Sources can be added, rescanned and removed; removing one never touches a project.
 * Against the fake git host and a temp folder; nothing names a real org, host or path.
 */
const START = "2026-10-23T09:00:00.000Z";
const ada: SourceActor = { humanId: "" };
const bob: SourceActor = { humanId: "" };

describe("source discovery", () => {
  let root: string;
  let host: FakeGitHost;
  let token: string;
  let store: StateStore;
  let discovery: SourceDiscovery;
  let installDir: string;
  let folderRoot: string;
  let alphaProjectId: string;
  const clock = new SimulatedClock(START);
  const created: { name: string; repos: string[]; goal: string }[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-sources-"));
    host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
    host.createUser({ login: "someone", name: "Someone", email: "someone@example.test" });
    host.createOrg({ login: "acme", members: ["someone"] });
    token = host.createToken({ owner: "someone", kind: "classic", scopes: ["repo"] }).token;
    for (const name of ["alpha", "beta"]) {
      await host.createRepo({ owner: "acme", name, initialFiles: { "README.md": `# ${name}\n` } });
    }
    await host.createRepo({
      owner: "acme",
      name: "gamma",
      private: true,
      initialFiles: {
        "README.md": "# gamma\n",
        ".forerunner/project.json": '{ "name": "gamma", "schema": 1 }\n',
      },
    });
    await host.createRepo({ owner: "someone", name: "notes", initialFiles: { "a.md": "a\n" } });

    store = await openStore({ url: "sqlite::memory:", clock });
    ada.humanId = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
    bob.humanId = (await store.human.insert({ name: "Bob", email: "bob@example.test" })).id;
    // An existing project links alpha by URL: the scan must recognise it as the same repo.
    alphaProjectId = (
      await store.project.insert({
        name: "Alpha",
        goal: "already here",
        repos: ["https://github.com/acme/alpha"],
        author_human: ada.humanId,
      })
    ).id;

    installDir = join(root, "checkout");
    mkdirSync(installDir, { recursive: true });
    folderRoot = join(root, "projects");
    mkdirSync(join(folderRoot, "one", ".git"), { recursive: true });
    mkdirSync(join(folderRoot, "two"), { recursive: true });
    mkdirSync(join(folderRoot, ".hidden"), { recursive: true });
    writeFileSync(join(folderRoot, "a-file.txt"), "not a folder\n");

    discovery = new SourceDiscovery({
      store,
      clock,
      // The host for every GitHub source: the token comes from the vault by reference in the
      // daemon; here the fake host's token straight in. Two per page proves pagination.
      hostFor: () => new GitHubHost({ token, baseUrl: host.baseUrl, clock, pageSize: 2 }),
      createProject: async (input, actor) => {
        created.push({ name: input.name, repos: input.repos, goal: input.goal });
        const p = await store.project.insert({
          name: input.name,
          goal: input.goal,
          repos: input.repos,
          stage: "planning",
          author_human: actor.humanId,
        });
        return { id: p.id, name: p.name };
      },
      installRecord: () => ({ schema: 1, installDir }),
    });
  }, 60_000);

  afterAll(async () => {
    await host?.stop();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("normalises repository and folder locators to one duplicate key", () => {
    const forms = [
      "acme/alpha",
      "acme/alpha.git",
      "ACME/Alpha",
      "github.com/acme/alpha",
      "https://github.com/acme/alpha",
      "https://github.com/acme/alpha.git",
      "https://github.com/acme/alpha/",
      "https://github.com/acme/alpha/tree/main",
      "git@github.com:acme/alpha.git",
      "ssh://git@github.com/acme/alpha.git",
    ];
    for (const f of forms) {
      const r = parseRepoLocator(f);
      expect(r?.key, f).toBe("github:acme/alpha");
      expect(r?.locator, f).toBe(`${r?.owner}/${r?.name}`);
    }
    expect(parseRepoLocator("acme")).toBeNull();
    expect(parseRepoLocator("a/b/c")).toBeNull();
    expect(parseRepoLocator("https://example.test/")).toBeNull();
    expect(parseRepoLocator("")).toBeNull();
    expect(repoKey("Acme", "Alpha")).toBe("github:acme/alpha");
    expect(folderKey(join(folderRoot, "one"))).toBe(folderKey(`${join(folderRoot, "one")}/`));
    expect(keysOfProject(["https://github.com/acme/alpha", join(folderRoot, "one"), "x"])).toEqual([
      "github:acme/alpha",
      folderKey(join(folderRoot, "one")),
    ]);
  });

  it("validates a source before storing it: a token value is never stored, bad logins, missing folders, other hosts, the same source twice", async () => {
    const refuse = (input: AddSourceInput, code: string, text: RegExp) =>
      expect(discovery.add(input, ada)).rejects.toMatchObject({
        code,
        message: expect.stringMatching(text),
      });
    const tokenValue = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""); // not-a-secret
    await refuse(
      { kind: "github_org", locator: "acme", credentialRef: tokenValue },
      "validation",
      /never stored|secret:<name>/,
    );
    expect(await store.source.list()).toEqual([]);
    await refuse(
      { kind: "github_org", locator: "acme", credentialRef: "github_token" },
      "validation",
      /secret:<name>/,
    );
    await refuse({ kind: "github_org", locator: "not a login" }, "validation", /login/);
    await refuse({ kind: "github_user", locator: "-dash" }, "validation", /login/);
    await refuse({ kind: "github_repo", locator: "acme" }, "validation", /owner\/name/);
    await refuse({ kind: "gitlab", locator: "x" }, "not_supported", /later/);
    await refuse({ kind: "git_remote", locator: "x" }, "not_supported", /later/);
    await refuse({ kind: "local_folder", locator: "relative/path" }, "validation", /absolute/);
    await refuse({ kind: "local_folder", locator: join(root, "missing") }, "not_found", /folder/);
    await refuse(
      { kind: "local_folder", locator: join(folderRoot, "a-file.txt") },
      "validation",
      /not a folder/,
    );
    await refuse(
      { kind: "local_folder", locator: folderRoot, credentialRef: "secret:x" },
      "validation",
      /credential/,
    );
    const org = await discovery.add({ kind: "github_org", locator: "acme" }, ada);
    expect(org).toMatchObject({
      kind: "github_org",
      locator: "acme",
      displayName: "acme",
      credentialRef: "secret:github_token",
      status: "connected",
      lastScanAt: null,
      candidates: { total: 0, proposed: 0 },
    });
    await refuse({ kind: "github_org", locator: "ACME" }, "validation", /already connected/);
    const audit = await store.auditLog.list({ tool: "source.add" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.input_summary).toContain("secret:github_token");
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("scans an org through the host with pagination: one proposal per repo, the linked one a duplicate, the marked one an existing install", async () => {
    const [org] = await discovery.list(ada);
    if (!org) throw new Error("no source");
    const result = await discovery.scan(org.id, ada);
    expect(result.candidates.map((c) => [c.name, c.status, c.existingInstall])).toEqual([
      ["alpha", "duplicate", false],
      ["beta", "proposed", false],
      ["gamma", "proposed", true],
    ]);
    const alpha = result.candidates[0];
    const gamma = result.candidates[2];
    expect(alpha?.projectId).toBe(alphaProjectId);
    expect(alpha?.locator).toBe("acme/alpha");
    expect(alpha?.key).toBe("github:acme/alpha");
    expect(gamma?.installMarker).toBe(".forerunner/project.json");
    expect(gamma?.details).toMatchObject({ private: true, default_branch: "main" });
    expect(gamma?.proposedName).toBe("gamma");
    expect(result.summary).toEqual({
      total: 3,
      proposed: 2,
      accepted: 0,
      duplicate: 1,
      gone: 0,
      installs: 1,
    });
    expect(result.source).toMatchObject({
      lastScanAt: clock.nowIso(),
      status: "connected",
      scanSummary: result.summary,
      candidates: { total: 3, proposed: 2, duplicate: 1 },
    });
    // The listing was paged (two per page): the host saw two pages of the org's repos.
    const pages = host
      .requests()
      .filter((r) => r.path === "/orgs/acme/repos")
      .map((r) => r.query);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("page=2");
    expect((await store.auditLog.list({ tool: "source.scan" }))[0]?.result_summary).toContain(
      "2 proposed",
    );
  });

  it("accepts a proposal: the project is created with the repo and no brief, the candidate is accepted; accepted, duplicate and gone candidates are refused", async () => {
    const [org] = await discovery.list(ada);
    if (!org) throw new Error("no source");
    const before = await discovery.candidates(org.id, ada);
    const beta = before.find((c) => c.name === "beta");
    const alpha = before.find((c) => c.name === "alpha");
    if (!beta || !alpha) throw new Error("candidates");
    await expect(discovery.accept(alpha.id, {}, ada)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/duplicate/),
      details: { conflict: true, projectId: alphaProjectId },
    });
    const accepted = await discovery.accept(beta.id, {}, ada);
    expect(accepted.candidate).toMatchObject({ id: beta.id, status: "accepted" });
    expect(accepted.project.name).toBe("beta");
    expect(created).toEqual([
      { name: "beta", repos: ["acme/beta"], goal: expect.stringContaining("acme/beta") },
    ]);
    const project = await store.project.mustGet(accepted.project.id);
    expect(project.repos).toEqual(["acme/beta"]);
    expect(project.summary_cache).toEqual({});
    expect(accepted.candidate.projectId).toBe(project.id);
    await expect(discovery.accept(beta.id, {}, ada)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/already accepted/),
      details: { conflict: true, projectId: project.id },
    });
    // A name that is taken is refused before anything is created; another name works.
    const gamma = before.find((c) => c.name === "gamma");
    if (!gamma) throw new Error("gamma");
    await expect(discovery.accept(gamma.id, { name: "Alpha" }, ada)).rejects.toMatchObject({
      code: "validation",
      details: { conflict: true, name: "Alpha" },
    });
    expect(created).toHaveLength(1);
    expect((await store.auditLog.list({ tool: "source.accept" }))[0]?.result_summary).toContain(
      project.id,
    );
  });

  it("rescans idempotently: a new repo appears, accepted and duplicate ones stay, a user source lists the user's repos, a chosen repo is one candidate", async () => {
    const [org] = await discovery.list(ada);
    if (!org) throw new Error("no source");
    await host.createRepo({ owner: "acme", name: "delta", initialFiles: { "x.md": "x\n" } });
    await clock.advance(60_000);
    const again = await discovery.scan(org.id, ada);
    expect(again.candidates.map((c) => [c.name, c.status])).toEqual([
      ["alpha", "duplicate"],
      ["beta", "accepted"],
      ["delta", "proposed"],
      ["gamma", "proposed"],
    ]);
    const ids = (await discovery.candidates(org.id, ada)).map((c) => c.id).sort();
    expect(new Set(ids).size).toBe(4);
    // A third scan changes nothing but last_seen_at.
    const third = await discovery.scan(org.id, ada);
    expect(third.candidates.map((c) => c.id).sort()).toEqual(ids);
    expect(third.summary).toEqual({
      total: 4,
      proposed: 2,
      accepted: 1,
      duplicate: 1,
      gone: 0,
      installs: 1,
    });

    // The account's own repositories (the token's login) and another user's public ones.
    const me = await discovery.add({ kind: "github_user", locator: "someone" }, ada);
    const mine = await discovery.scan(me.id, ada);
    expect(mine.candidates.map((c) => [c.locator, c.status])).toEqual([
      ["someone/notes", "proposed"],
    ]);

    // A chosen repository already covered by a project is one duplicate candidate; the URL
    // form is stored as owner/name.
    const chosen = await discovery.add(
      { kind: "github_repo", locator: "https://github.com/acme/alpha.git" },
      ada,
    );
    expect(chosen).toMatchObject({ locator: "acme/alpha", displayName: "acme/alpha" });
    const one = await discovery.scan(chosen.id, ada);
    expect(one.candidates.map((c) => [c.locator, c.status, c.projectId])).toEqual([
      ["acme/alpha", "duplicate", alphaProjectId],
    ]);
    // A chosen repository another source already proposes is a duplicate of that proposal,
    // so one repo is never proposed twice across sources.
    const chosenGamma = await discovery.add({ kind: "github_repo", locator: "acme/gamma" }, ada);
    const dup = await discovery.scan(chosenGamma.id, ada);
    const orgGamma = (await discovery.candidates(org.id, ada)).find((c) => c.name === "gamma");
    expect(dup.candidates[0]).toMatchObject({
      status: "duplicate",
      existingInstall: true,
      details: expect.objectContaining({ duplicate_of: orgGamma?.id }),
    });
  });

  it("scans a local folder: immediate subfolders, git marked, the Forerunner checkout and a marker detected, gone and back on rescan", async () => {
    const folder = await discovery.add(
      { kind: "local_folder", locator: `${folderRoot}/`, displayName: "Projects" },
      ada,
    );
    expect(folder).toMatchObject({ locator: folderRoot, displayName: "Projects" });
    const first = await discovery.scan(folder.id, ada);
    expect(first.candidates.map((c) => [c.name, c.status, c.isGit, c.kind])).toEqual([
      ["one", "proposed", true, "folder"],
      ["two", "proposed", false, "folder"],
    ]);
    expect(first.candidates[0]?.locator).toBe(join(folderRoot, "one"));
    expect(first.candidates[0]?.key).toBe(folderKey(join(folderRoot, "one")));

    // A subfolder with the marker, and one that is this install's own checkout.
    mkdirSync(join(folderRoot, "three", ".forerunner"), { recursive: true });
    writeFileSync(join(folderRoot, "three", ".forerunner", "project.json"), "{}\n");
    rmSync(join(folderRoot, "two"), { recursive: true });
    const second = await discovery.scan(folder.id, ada);
    expect(
      second.candidates.map((c) => [c.name, c.status, c.existingInstall, c.installMarker]),
    ).toEqual([
      ["one", "proposed", false, null],
      ["three", "proposed", true, ".forerunner/project.json"],
      ["two", "gone", false, null],
    ]);
    mkdirSync(join(folderRoot, "two"), { recursive: true });
    const third = await discovery.scan(folder.id, ada);
    expect(third.candidates.find((c) => c.name === "two")?.status).toBe("proposed");
    expect(third.summary.gone).toBe(0);

    // The install record's checkout, connected directly, is one candidate that is Forerunner
    // itself (its subfolders are never proposed), with or without a .git.
    const own = await discovery.add({ kind: "local_folder", locator: installDir }, ada);
    mkdirSync(join(installDir, "packages"), { recursive: true });
    const ownScan = await discovery.scan(own.id, ada);
    expect(
      ownScan.candidates.map((c) => [c.locator, c.existingInstall, c.installMarker, c.isGit]),
    ).toEqual([[installDir, true, "install_record", false]]);
    mkdirSync(join(installDir, ".git"), { recursive: true });
    const ownRepo = await discovery.scan(own.id, ada);
    expect(
      ownRepo.candidates.map((c) => [c.locator, c.existingInstall, c.installMarker, c.isGit]),
    ).toEqual([[installDir, true, "install_record", true]]);

    // Accepting a folder proposal links the path.
    const one = third.candidates.find((c) => c.name === "one");
    if (!one) throw new Error("one");
    const accepted = await discovery.accept(one.id, { goal: "Keep one going" }, ada);
    expect(created.at(-1)).toEqual({
      name: "one",
      repos: [join(folderRoot, "one")],
      goal: "Keep one going",
    });
    expect(accepted.candidate.status).toBe("accepted");
    // A gone candidate cannot be accepted.
    rmSync(join(folderRoot, "two"), { recursive: true });
    const fourth = await discovery.scan(folder.id, ada);
    const two = fourth.candidates.find((c) => c.name === "two");
    if (!two) throw new Error("two");
    await expect(discovery.accept(two.id, {}, ada)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/no longer/),
    });
  });

  it("records a failed scan on the source and rethrows; the source stays connected for a retry", async () => {
    const bad = new SourceDiscovery({
      store,
      clock,
      hostFor: () => new GitHubHost({ token: "wrong", baseUrl: host.baseUrl, clock }),
      createProject: async () => {
        throw new Error("never");
      },
    });
    const src = await discovery.add({ kind: "github_org", locator: "nobody" }, ada);
    await expect(bad.scan(src.id, ada)).rejects.toMatchObject({ code: "provider_auth" });
    const row = await store.source.mustGet(src.id);
    expect(row.status).toBe("error");
    expect(row.last_scan).toBe(clock.nowIso());
    expect(JSON.stringify(row.scan_result)).not.toContain("wrong");
    const view = (await discovery.list(ada)).find((s) => s.id === src.id);
    expect(view?.error).toMatch(/401|auth/i);
    const audit = (await store.auditLog.list({ tool: "source.scan" })).find((r) => !r.allowed);
    expect(audit?.denied_reason).toMatch(/provider_auth/);
    await discovery.remove(src.id, ada);
  });

  it("removes a source with its candidates and never the projects; another human's source is hidden and refused", async () => {
    const mine = await discovery.list(ada);
    const org = mine.find((s) => s.kind === "github_org");
    if (!org) throw new Error("org");
    expect(mine.map((s) => s.kind).sort()).toEqual(
      [
        "github_org",
        "github_repo",
        "github_repo",
        "github_user",
        "local_folder",
        "local_folder",
      ].sort(),
    );
    const projectsBefore = (await store.project.list()).length;
    const removed = await discovery.remove(org.id, ada);
    expect(removed).toEqual({ ok: true, id: org.id, candidatesRemoved: 4 });
    expect((await store.project.list()).length).toBe(projectsBefore);
    expect(await store.sourceCandidate.forSource(org.id)).toEqual([]);
    await expect(discovery.get(org.id, ada)).rejects.toMatchObject({ code: "not_found" });
    await expect(discovery.remove(org.id, ada)).rejects.toMatchObject({ code: "not_found" });

    const bobs = await discovery.add({ kind: "github_user", locator: "someone-else" }, bob);
    expect((await discovery.list(ada)).map((s) => s.id)).not.toContain(bobs.id);
    expect((await discovery.list(bob)).map((s) => s.id)).toEqual([bobs.id]);
    for (const op of [
      () => discovery.get(bobs.id, ada),
      () => discovery.scan(bobs.id, ada),
      () => discovery.candidates(bobs.id, ada),
      () => discovery.remove(bobs.id, ada),
    ]) {
      await expect(op()).rejects.toMatchObject({
        code: "tool_not_allowed",
        details: { forbidden: true },
      });
    }
    expect(await store.source.get(bobs.id)).toBeDefined();
  });
});
