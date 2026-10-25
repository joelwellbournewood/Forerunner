import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { docFile, parseDocFrontmatter, STANDARD_DOCS } from "@forerunner/memory";
import { appDirs, fromPosix, join, run, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  DOCS_SCAFFOLD_BRANCH,
  gitAuthFor,
  parseRepoRef,
  statusBranchFor,
  WORKSPACE_DIR,
} from "../src/loop/docs.ts";
import { INSTALL_MARKER_FILE, parseInstallMarker } from "../src/sources/marker.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The standard doc set is scaffolded at project creation (spec G.5): with a linked
 * repository the missing docs go on a branch and a pull request on the git host (the default
 * branch is never pushed, existing files are never overwritten, drafted files already on the
 * branch are kept); without one they go under the project's data directory. A git host
 * failure never fails the creation.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const identity = { name: "Forerunner", email: "agent@example.test" };
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

async function show(bare: string, ref: string, path: string): Promise<string | null> {
  const r = await run(["git", "--git-dir", bare, "show", `${ref}:${path}`], {
    allowFailure: true,
  });
  return r.code === 0 ? r.stdout : null;
}

async function tree(bare: string, ref: string): Promise<string[]> {
  const r = await run(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", ref], {
    allowFailure: true,
  });
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).sort() : [];
}

describe("standard doc set at project creation (G.5)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let root: string;
  let projectsRoot: string;
  let gammaBare = "";
  let gammaId = "";
  const host = new MemoryGitHost("alice");
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const provider = new ScriptedProvider([{ text: "Noted." }], clock);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  async function bareRepo(name: string): Promise<string> {
    const bare = join(root, `${name}.git`);
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({ cwd: join(root, `${name}-seed`), identity });
    await seed.clone(bare);
    writeFileSync(join(root, `${name}-seed`, "README.md"), `# ${name}\n`);
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name, private: true, cloneUrl: bare });
    return bare;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-docs-scaffold-"));
    const home = join(root, "home");
    projectsRoot = join(root, "projects");
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      gitHost: host,
      data: { projectsRoot },
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("parses a repository reference as owner/name or as a URL", () => {
    expect(parseRepoRef("o/sample")).toEqual({ owner: "o", name: "sample" });
    expect(parseRepoRef("https://github.com/o/sample.git")).toEqual({ owner: "o", name: "sample" });
    expect(parseRepoRef("https://example.test/org/gamma")).toEqual({ owner: "org", name: "gamma" });
    expect(parseRepoRef("git@github.com:o/sample.git")).toEqual({ owner: "o", name: "sample" });
    expect(parseRepoRef("")).toBeNull();
    expect(parseRepoRef("sample")).toBeNull();
    expect(parseRepoRef("https://example.test/")).toBeNull();
  });

  it("scopes the git token to the repository's http(s) origin and sends none to any other remote (ADR 0069)", () => {
    expect(gitAuthFor("tok", "https://github.com/o/sample.git")).toEqual({
      token: "tok",
      origin: "https://github.com",
    });
    expect(gitAuthFor("tok", "http://127.0.0.1:8123/acme/epsilon.git")).toEqual({
      token: "tok",
      origin: "http://127.0.0.1:8123",
    });
    // A local bare repository or an ssh remote has no http origin to scope the token to.
    expect(gitAuthFor("tok", "/srv/git/sample.git")).toBeUndefined();
    expect(gitAuthFor("tok", "git@github.com:o/sample.git")).toBeUndefined();
    expect(gitAuthFor("tok", "ssh://git@github.com/o/sample.git")).toBeUndefined();
    expect(gitAuthFor(undefined, "https://github.com/o/sample.git")).toBeUndefined();
  });

  it("with a linked repository the missing docs are a branch and a pull request; the original is untouched", async () => {
    const bare = await bareRepo("gamma");
    gammaBare = bare;
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Gamma", goal: "Ship the thing", repos: ["o/gamma"] }),
    });
    expect(res.status).toBe(201);
    const card = await json(res);
    gammaId = String(card.id);
    const prs = await host.listPullRequests({ owner: "o", name: "gamma" }, { state: "open" });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ head: { ref: DOCS_SCAFFOLD_BRANCH }, base: { ref: "main" } });
    expect(prs[0]?.title).toContain("docs");
    expect(prs[0]?.body).toContain("docs/overview.md");
    // The default branch has only the seed; the branch has the seven missing docs and the
    // install marker the A.4 scan reads (ADR 0056), naming this project.
    expect(await tree(bare, "main")).toEqual(["README.md"]);
    const files = await tree(bare, DOCS_SCAFFOLD_BRANCH);
    expect(files).toEqual([...STANDARD_DOCS.map(docFile), INSTALL_MARKER_FILE].sort());
    expect(
      parseInstallMarker((await show(bare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? ""),
    ).toEqual({ schema: 1, project: gammaId, name: "Gamma" });
    expect(prs[0]?.body).toContain(INSTALL_MARKER_FILE);
    // The existing README was never overwritten; the new docs carry the project's data.
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "README.md")).toBe("# gamma\n");
    const overview = (await show(bare, DOCS_SCAFFOLD_BRANCH, "docs/overview.md")) ?? "";
    expect(parseDocFrontmatter(overview)["maintained-by"]).toBe("forerunner");
    expect(overview).toContain("Ship the thing");
    expect(overview).toContain("- o/gamma");
    const row = await rt.store.project.mustGet(String(card.id));
    expect(row.summary_cache.docs).toMatchObject({
      location: "repo",
      branch: DOCS_SCAFFOLD_BRANCH,
      pr_url: prs[0]?.htmlUrl,
      existing: ["README.md"],
      marker: { path: INSTALL_MARKER_FILE, status: "created" },
      scaffolded_at: "2026-03-05T08:00:00.000Z",
    });
    expect((row.summary_cache.docs as { created: string[] }).created).toHaveLength(
      STANDARD_DOCS.length - 1,
    );
    // Nothing under the data directory for a project with a repository.
    expect(existsSync(join(projectsRoot, String(card.id), WORKSPACE_DIR))).toBe(false);
  });

  it("files already drafted on the branch (the intake) are kept and no second pull request is opened", async () => {
    const bare = await bareRepo("delta");
    const drafted = new GitOps({ cwd: join(root, "delta-draft"), identity });
    await drafted.clone(bare);
    await drafted.createBranch(DOCS_SCAFFOLD_BRANCH, "origin/main");
    await mkdir(join(root, "delta-draft", "docs"), { recursive: true });
    writeFileSync(join(root, "delta-draft", "docs", "overview.md"), "# Drafted by the intake\n");
    await drafted.commitAll("docs: drafted overview");
    await drafted.push(DOCS_SCAFFOLD_BRANCH, { defaultBranch: "main" });
    const existingPr = await host.createPullRequest(
      { owner: "o", name: "delta" },
      { title: "docs: intake", body: "", head: DOCS_SCAFFOLD_BRANCH, base: "main" },
    );
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Delta", goal: "Keep drafts", repos: ["o/delta"] }),
    });
    expect(res.status).toBe(201);
    const prs = await host.listPullRequests({ owner: "o", name: "delta" }, { state: "open" });
    expect(prs.map((p) => p.number)).toEqual([existingPr.number]);
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "docs/overview.md")).toBe(
      "# Drafted by the intake\n",
    );
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "docs/status.md")).toContain("# Status");
    expect(await tree(bare, "main")).toEqual(["README.md"]);
    const row = await rt.store.project.mustGet(String((await json(res)).id));
    expect(row.summary_cache.docs).toMatchObject({
      location: "repo",
      pr_url: existingPr.htmlUrl,
      existing: ["README.md", "docs/overview.md"],
    });
    expect(row.summary_cache.docs).toMatchObject({ marker: { status: "created" } });
    // A second creation against the same repository finds nothing to add, and the marker of
    // the first project is reported, never overwritten.
    const again = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Delta 2", goal: "Same repo", repos: ["o/delta"] }),
    });
    expect(again.status).toBe(201);
    const row2 = await rt.store.project.mustGet(String((await json(again)).id));
    expect(row2.summary_cache.docs).toMatchObject({
      location: "repo",
      created: [],
      marker: { path: INSTALL_MARKER_FILE, status: "other_project", project: row.id },
    });
    expect(
      parseInstallMarker((await show(bare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? "")
        ?.project,
    ).toBe(row.id);
    expect(
      await host.listPullRequests({ owner: "o", name: "delta" }, { state: "open" }),
    ).toHaveLength(1);
  });

  it("without a repository the doc set goes under the project's data directory", async () => {
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Epsilon", goal: "No repo yet" }),
    });
    expect(res.status).toBe(201);
    const id = String((await json(res)).id);
    const dir = join(projectsRoot, id, WORKSPACE_DIR);
    for (const doc of STANDARD_DOCS)
      expect(existsSync(join(dir, fromPosix(docFile(doc))))).toBe(true);
    const readme = await readFile(join(dir, "README.md"), "utf8");
    expect(readme).toContain("# Epsilon");
    expect(readme).toContain("No repo yet");
    const row = await rt.store.project.mustGet(id);
    expect(row.summary_cache.docs).toMatchObject({
      location: "data_dir",
      dir,
      existing: [],
      marker: { path: INSTALL_MARKER_FILE, status: "created" },
    });
    expect((row.summary_cache.docs as { created: string[] }).created).toHaveLength(
      STANDARD_DOCS.length,
    );
    // The workspace carries the install marker too, so a folder scan knows whose it is.
    expect(
      parseInstallMarker(await readFile(join(dir, fromPosix(INSTALL_MARKER_FILE)), "utf8")),
    ).toEqual({ schema: 1, project: id, name: "Epsilon" });
  });

  it("the composed chat searches the project's doc set and records a stated lesson in the principal's memory (J.1, O.2)", async () => {
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Theta", goal: "Ship the telescope controller" }),
    });
    expect(res.status).toBe(201);
    const id = String((await json(res)).id);
    writeFileSync(
      join(projectsRoot, id, WORKSPACE_DIR, "docs", "runbook.md"),
      "# Runbook\n\n## Calibrate\n\nCalibrate the telescope mount with the star-hop routine.\n",
    );
    const chat = async (text: string) =>
      json(
        await req("/chat", {
          method: "POST",
          body: JSON.stringify({ humanId: rt.human.id, agentId: rt.agent.id, projectId: id, text }),
        }),
      );
    expect(String((await chat("switch to theta")).reply)).toContain("Theta");
    const before = provider.calls.length;
    await chat("how do we calibrate the telescope mount?");
    const sent = provider.calls
      .slice(before)
      .map((c) => String(c.messages[0]?.content))
      .join("\n");
    expect(sent).toContain("[docs/runbook.md > Runbook > Calibrate]");
    expect(sent).toContain("star-hop routine");
    const r = await chat("remember that the mount drifts while the dome heater is on");
    expect(r.reply).toBe(
      'Recorded a lesson in Alice\'s memory for Theta: "the mount drifts while the dome heater is on". Undo.',
    );
    const lessons = await rt.memory.list({
      scope: "agent_private",
      ownerAgentId: rt.agent.id,
      projectId: id,
    });
    expect(lessons.map((l) => l.text)).toEqual(["the mount drifts while the dome heater is on"]);
  });

  it("a session through the composed runner writes its status update on a pull request of the project's repository", async () => {
    const task = await rt.store.task.insert({
      project_id: gammaId,
      title: "Add a clamp",
      outcome: "clamp exists",
      acceptance_criteria: ["clamp works"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 500_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    // The scripted provider answers with text only, so the composed PR executor finds no
    // change in the worktree and opens no pull request: the status update gets its own.
    const result = await rt.runner.start({
      agentId: rt.agent.id,
      projectId: gammaId,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant: {
        allowedTools: rt.toolsForRun().names(),
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
      },
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(result.status).toBe("completed");
    expect([
      ...result.completed,
      ...result.failed,
      ...result.inReview,
      ...result.needsHuman,
    ]).toEqual([task.id]);
    const branch = statusBranchFor(result.sessionId);
    expect(events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "repo",
      branch,
      path: "docs/status.md",
      created: true,
    });
    const status = await show(gammaBare, branch, "docs/status.md");
    expect(status).toContain(`### 2026-03-05 session ${result.sessionId}`);
    expect(status).toContain("Add a clamp");
    expect(await show(gammaBare, "main", "docs/status.md")).toBeNull();
    const prs = await host.listPullRequests({ owner: "o", name: "gamma" }, { state: "open" });
    expect(prs.map((p) => p.head.ref).sort()).toEqual([DOCS_SCAFFOLD_BRANCH, branch].sort());
    expect(prs.find((p) => p.head.ref === branch)?.body).toContain(result.sessionId);
    const session = await rt.store.session.mustGet(result.sessionId);
    expect((session.handoff as { docs?: { branch?: string } }).docs?.branch).toBe(branch);
  });

  it("a git host that cannot serve the repository never fails the creation", async () => {
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Zeta", goal: "Missing repo", repos: ["o/missing"] }),
    });
    expect(res.status).toBe(201);
    const row = await rt.store.project.mustGet(String((await json(res)).id));
    expect(row.summary_cache.docs).toMatchObject({ error: expect.stringContaining("o/missing") });
    expect(row.repos).toEqual(["o/missing"]);
  });
});
