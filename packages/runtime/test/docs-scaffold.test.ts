import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { docFile, parseDocFrontmatter, STANDARD_DOCS, scaffoldDocs } from "@forerunner/memory";
import { appDirs, fromPosix, join, run, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  DOCS_SCAFFOLD_BRANCH,
  docsPrMarker,
  gitAuthFor,
  parseRepoRef,
  STATUS_BRANCH,
  WORKSPACE_DIR,
} from "../src/loop/docs.ts";
import { INSTALL_MARKER_FILE, parseInstallMarker } from "../src/sources/marker.ts";
import { tookOverLine } from "../src/sources/repository-use.ts";
import { removeHomes, ScriptedProvider } from "./helpers.ts";

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

  it("files already on the branch (an earlier scaffold, a human's edits on the open PR) are kept and no second pull request is opened", async () => {
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
    const branchBefore = await run(["git", "--git-dir", bare, "rev-parse", DOCS_SCAFFOLD_BRANCH]);
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Delta", goal: "Keep drafts", repos: ["o/delta"] }),
    });
    expect(res.status).toBe(201);
    const row0 = await rt.store.project.mustGet(String((await json(res)).id));
    // w8-repo-guide (L4i-left-2, ADR 0121): the open pull request names no project and its
    // branch carries no marker of Delta's, so it is nobody's: Delta's scaffold writes nothing to
    // it and comments nothing on it, though Delta is the only project here on o/delta (before,
    // that made it Delta's, and another Forerunner's pull request was written onto).
    expect((await run(["git", "--git-dir", bare, "rev-parse", DOCS_SCAFFOLD_BRANCH])).stdout).toBe(
      branchBefore.stdout,
    );
    expect(
      await host.listPullRequestComments({ owner: "o", name: "delta" }, existingPr.number),
    ).toEqual([]);
    expect(row0.summary_cache.docs).toMatchObject({ location: "repo", pr_url: null, created: [] });
    // Once the pull request names Delta (this install's mark), it is Delta's: the files
    // already on its branch are kept and no second pull request is opened.
    await host.updatePullRequest({ owner: "o", name: "delta" }, existingPr.number, {
      body: `The intake's docs.\n\n${docsPrMarker(row0)}`,
    });
    await rt.docs.scaffoldProject(row0);
    const prs = await host.listPullRequests({ owner: "o", name: "delta" }, { state: "open" });
    expect(prs.map((p) => p.number)).toEqual([existingPr.number]);
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "docs/overview.md")).toBe(
      "# Drafted by the intake\n",
    );
    // W8-guide-1, -2: the guide joins the branch, and no docs/status.md.
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "docs/status.md")).toBeNull();
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(await show(bare, DOCS_SCAFFOLD_BRANCH, "AGENTS.md")).toContain(
      'This repository is the Forerunner project "Delta".',
    );
    expect(await tree(bare, "main")).toEqual(["README.md"]);
    const row = await rt.store.project.mustGet(row0.id);
    expect(row.summary_cache.docs).toMatchObject({
      location: "repo",
      pr_url: existingPr.htmlUrl,
      existing: ["README.md", "docs/overview.md"],
    });
    expect(row.summary_cache.docs).toMatchObject({ marker: { status: "created" } });
    // A second creation against the same repository writes nothing: the open scaffold PR names
    // Delta, so it is never another project's to write into (W15-01); the first project's
    // marker is never overwritten.
    // d1109-onerepo-link (OR-13): POST /projects refuses a second project on the repository now;
    // the pair is one made before that rule (through the store), scaffolded as creation did.
    const again = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Delta 2", goal: "Same repo", repos: ["o/delta"] }),
    });
    expect(again.status).toBe(409);
    const pair = await rt.store.project.insert({
      name: "Delta 2",
      goal: "Same repo",
      repos: ["o/delta"],
    });
    await rt.docs.scaffoldProject(pair);
    const row2 = await rt.store.project.mustGet(pair.id);
    expect(row2.summary_cache.docs).toMatchObject({ location: "repo", created: [] });
    expect((row2.summary_cache.docs as { pr_url?: unknown }).pr_url).toBeNull();
    expect(
      (await host.listPullRequestComments({ owner: "o", name: "delta" }, existingPr.number)).length,
    ).toBe(1);
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

  it("a project created by the chat's project.create command gets the doc set too, in the background (review finding 2)", async () => {
    const res = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          { name: "project.create", params: { name: "Kappa", goal: "By chat", switch: false } },
        ],
        wordsUsed: "create the project Kappa",
      }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("done");
    const row = await rt.store.project.byName("Kappa");
    if (!row) throw new Error("Kappa was not created");
    const dir = join(projectsRoot, row.id, WORKSPACE_DIR);
    // The reply did not wait for the scaffold; the row records it once it lands.
    await vi.waitFor(
      async () => {
        const fresh = await rt.store.project.mustGet(row.id);
        expect(fresh.summary_cache.docs).toMatchObject({
          location: "data_dir",
          dir,
          marker: { status: "created" },
        });
      },
      { timeout: 10_000 },
    );
    for (const doc of STANDARD_DOCS)
      expect(existsSync(join(dir, fromPosix(docFile(doc))))).toBe(true);
    expect(await readFile(join(dir, "README.md"), "utf8")).toContain("# Kappa");
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
      // The turn's own message (the facts, the retrieved docs and the line) comes last, after
      // the conversation's earlier turns (design §3.9).
      .map((c) => String(c.messages.at(-1)?.content))
      .join("\n");
    expect(sent).toContain("[docs/runbook.md > Runbook > Calibrate]");
    expect(sent).toContain("star-hop routine");
    const r = await chat("remember that the mount drifts while the dome heater is on");
    expect(r.reply).toBe(
      'Recorded a lesson in Alice\'s memory for Theta: "the mount drifts while the dome heater is on". It changes no setting. Undo.',
    );
    const lessons = await rt.memory.list({
      scope: "agent_private",
      ownerAgentId: rt.agent.id,
      projectId: id,
    });
    expect(lessons.map((l) => l.text)).toEqual(["the mount drifts while the dome heater is on"]);
  });

  it("a session through the composed runner writes its status update on a pull request of the project's repository, once the person turned the status pull request on", async () => {
    // C-57: off by default (the status stays in the app); Settings turns it on with the same
    // command the Other settings row sends.
    const on = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            name: "settings.set",
            params: { key: "status_pull_request", value: true, project: gammaId },
          },
        ],
        wordsUsed: "Settings: project.status_pull_request to true",
        source: "ui",
        projectId: gammaId,
      }),
    });
    const onBody = (await on.json()) as { status: string; sentence: string };
    expect(onBody.status).toBe("done");
    expect(onBody.sentence).toContain(
      "each session's status goes to the repository as one pull request",
    );
    expect((await rt.store.project.mustGet(gammaId)).settings.status_pull_request).toBe(true);
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
    const branch = STATUS_BRANCH;
    expect(events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "repo",
      branch,
      path: "docs/status.md",
      created: true,
    });
    const status = await show(gammaBare, branch, "docs/status.md");
    // Named by when the session started, never by its id (l3-small, run L3, L3-github-6).
    const started = (await rt.store.session.mustGet(result.sessionId)).started_at ?? "";
    expect(status).toContain(
      `### Session started ${started.slice(0, 10)} ${started.slice(11, 16)} UTC\n`,
    );
    expect(status).not.toContain(result.sessionId);
    expect(status).toContain("Add a clamp");
    expect(await show(gammaBare, "main", "docs/status.md")).toBeNull();
    const prs = await host.listPullRequests({ owner: "o", name: "gamma" }, { state: "open" });
    expect(prs.map((p) => p.head.ref).sort()).toEqual([DOCS_SCAFFOLD_BRANCH, branch].sort());
    // W15-08: the session by when it started, never its id; the project in the hidden mark.
    const statusBody = prs.find((p) => p.head.ref === branch)?.body ?? "";
    expect(statusBody).toContain("Status update of the session started 2026-03-05");
    expect(statusBody).not.toContain(result.sessionId);
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

  it("an empty repository whose host refuses the first commit: the creation goes on, and the task fails with one sentence and what to do (review, 2026-11-02)", async () => {
    // Before: the task's reason and its failed-task card carried git's multi-line output
    // ("git push main failed: fatal: ... remote: Permission ... ! [remote rejected] ...").
    const bare = join(root, "locked.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    writeFileSync(
      join(bare, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'Permission to o/locked denied to the token.' >&2\nexit 1\n",
    );
    chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
    await host.createRepo({ owner: "o", name: "locked", private: true, cloneUrl: bare });
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Locked", goal: "A page", repos: ["o/locked"] }),
    });
    expect(res.status).toBe(201);
    const projectId = String((await json(res)).id);
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Create index.html",
      outcome: "index.html exists",
      acceptance_criteria: ["it opens"],
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
    const result = await rt.runner.start({
      agentId: rt.agent.id,
      projectId,
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
    const words =
      'o/locked is empty and GitHub refused Forerunner\'s first commit: "Permission to o/locked denied to the token". Check the token in Settings, then press Try again.';
    expect(result.failed).toEqual([task.id]);
    const failed = await rt.store.task.mustGet(task.id);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(words);
    // A refusal is not tried again at once: it would be refused again.
    expect(events.filter((e) => e.type === "task.retrying")).toEqual([]);
    const card = (
      await rt.store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
        limit: 10,
      })
    )[0];
    expect(card?.why).toBe(`"Create index.html" failed: ${words}`);
    const session = await rt.store.session.mustGet(result.sessionId);
    expect(session.summary).toContain(`"Create index.html" failed: o/locked is empty`);
    // The session result has its lines; the reason and the card are one paragraph.
    for (const text of [failed.reason, card?.why ?? "", session.summary])
      for (const raw of ["git push", "fatal:", "remote:", "[remote rejected]"])
        expect(text, raw).not.toContain(raw);
    expect(`${failed.reason}${card?.why}`).not.toContain("\n");
  });
});

describe("d1109-onerepo-link, run C: a take-over's docs pull request replaces exactly the marker it took over and says so; a together project writes nothing (OR-06, OR-15)", () => {
  const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
  const marker = JSON.stringify({ schema: 1, project: KITE, name: "Kite club" }, null, 2);
  // A second Forerunner's project on another repository (an id this computer never took over).
  const OTHER = "01a1a000-0000-7000-8000-00000000d2cd";
  const otherMarker = JSON.stringify({ schema: 1, project: OTHER, name: "Shared club" }, null, 2);

  it("Take it over: the scaffold's pull request carries this project's marker in place of exactly the taken-over one and the line; Work together: no branch, no pull request, no marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "fr-docs-takeover-"));
    const host = new MemoryGitHost("alice");
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const seeded = async (name: string, files: Record<string, string>) => {
      const bare = join(root, `${name}.git`);
      await run(["git", "init", "--bare", "-b", "main", bare]);
      const seed = new GitOps({ cwd: join(root, `${name}-seed`), identity });
      await seed.clone(bare);
      for (const [path, text] of Object.entries(files)) {
        await mkdir(
          join(root, `${name}-seed`, fromPosix(path.slice(0, path.lastIndexOf("/") + 1) || ".")),
          {
            recursive: true,
          },
        );
        writeFileSync(join(root, `${name}-seed`, fromPosix(path)), text);
      }
      await seed.commitAll("seed");
      await seed.push("main");
      await host.createRepo({ owner: "o", name, private: true, cloneUrl: bare });
      for (const [path, text] of Object.entries(files))
        await host.putFile(
          { owner: "o", name },
          { path, content: text, message: "seed", branch: "main" },
        );
      return bare;
    };
    const kiteBare = await seeded("kite", {
      "README.md": "# kite\n",
      [INSTALL_MARKER_FILE]: marker,
    });
    const sharedBare = await seeded("shared", {
      "README.md": "# shared\n",
      [INSTALL_MARKER_FILE]: otherMarker,
    });
    const home = join(root, "home");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      gitHost: host,
      data: { projectsRoot: join(root, "projects") },
      startServices: false,
    });
    const { app, token } = createDaemonApp(rt);
    const req = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    try {
      // Refused first, with the offer; then taken over with the ids the refusal named.
      const offer = await req("/projects", { name: "Kites", goal: "g", repos: ["o/kite"] });
      expect(offer.status).toBe(409);
      expect((await json(offer)).details).toMatchObject({ projects: [KITE], canTakeOver: true });
      const made = await req("/projects", {
        name: "Kites",
        goal: "g",
        repos: ["o/kite"],
        takeOver: { projects: [KITE] },
      });
      expect(made.status).toBe(201);
      const id = String((await json(made)).id);
      const [pr] = await host.listPullRequests(
        { owner: "o", name: "kite" },
        { head: DOCS_SCAFFOLD_BRANCH },
      );
      expect(pr?.body).toContain(
        'This repository was the Forerunner project "Kite club"; it is now the project "Kites".',
      );
      expect(
        parseInstallMarker((await show(kiteBare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? "")
          ?.project,
      ).toBe(id);
      expect(
        parseInstallMarker((await show(kiteBare, "main", INSTALL_MARKER_FILE)) ?? "")?.project,
      ).toBe(KITE);
      // Any other project's marker is never overwritten: a project here without the take-over
      // (a pair made before the rule) leaves it as it is.
      const pair = await rt.store.project.insert({
        name: "Shared",
        goal: "g",
        repos: ["o/shared"],
      });
      await rt.docs.scaffoldProject(pair);
      expect(
        parseInstallMarker(
          (await show(sharedBare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? "",
        )?.project ?? OTHER,
      ).toBe(OTHER);
      // Work together on o/shared's project (D9): nothing is written to the repository.
      const branchesBefore = (await run(["git", "--git-dir", sharedBare, "branch", "--list"]))
        .stdout;
      const prsBefore = (
        await host.listPullRequests({ owner: "o", name: "shared" }, { state: "all" })
      ).length;
      await rt.store.project.update(pair.id, (await rt.store.project.mustGet(pair.id)).version, {
        status: "archived",
        active: false,
        author_human: rt.human.id,
      });
      const together = await req("/projects", {
        name: "Mine",
        goal: "g",
        repos: ["o/shared"],
        together: { project: OTHER },
      });
      expect(together.status, JSON.stringify(await together.clone().json())).toBe(201);
      expect(String((await json(together)).id)).toBe(OTHER);
      expect((await run(["git", "--git-dir", sharedBare, "branch", "--list"])).stdout).toBe(
        branchesBefore,
      );
      expect(
        (await host.listPullRequests({ owner: "o", name: "shared" }, { state: "all" })).length,
      ).toBe(prsBefore);
      const row = await rt.store.project.mustGet(OTHER);
      expect(row.summary_cache.docs).toMatchObject({ together: true, created: [] });
    } finally {
      await rt.close();
    }
  }, 60_000);
});

describe("l4-github-link, run L4: the scaffold's branch starts from the default branch and is never another's (L4-github-102, D-L4-24)", () => {
  const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
  const OTHER = "01a1a000-0000-7000-8000-00000000d2cd";
  const mk = (id: string, name: string) =>
    `${JSON.stringify({ schema: 1, project: id, name }, null, 2)}\n`;
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));

  /** A composed daemon over a memory git host whose repositories are real bare ones. */
  async function world() {
    const root = mkdtempSync(join(tmpdir(), "fr-docs-l4-link-"));
    homes.push(root);
    const host = new MemoryGitHost("alice");
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const home = join(root, "home");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      gitHost: host,
      data: { projectsRoot: join(root, "projects") },
      startServices: false,
    });
    const { app, token } = createDaemonApp(rt);
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    /** o/<name>: a bare repository with a seed clone; files written through `commit`. */
    const repo = async (name: string) => {
      const bare = join(root, `${name}.git`);
      await run(["git", "init", "--bare", "-b", "main", bare]);
      const seedDir = join(root, `${name}-seed`);
      const seed = new GitOps({ cwd: seedDir, identity });
      await seed.clone(bare);
      await host.createRepo({ owner: "o", name, private: true, cloneUrl: bare });
      const commit = async (branch: string, files: Record<string, string>, message: string) => {
        for (const [path, text] of Object.entries(files)) {
          await mkdir(join(seedDir, fromPosix(path.slice(0, path.lastIndexOf("/") + 1) || ".")), {
            recursive: true,
          });
          writeFileSync(join(seedDir, fromPosix(path)), text);
          if (branch === "main")
            await host
              .putFile({ owner: "o", name }, { path, content: text, message, branch })
              .catch(() => undefined);
        }
        await seed.commitAll(message);
        await seed.push(branch, { defaultBranch: "main" });
      };
      return { bare, seedDir, seed, commit };
    };
    return { root, host, rt, post, repo };
  }
  const head = async (bare: string, ref: string) =>
    (await run(["git", "--git-dir", bare, "rev-parse", ref], { allowFailure: true })).stdout.trim();
  const isAncestor = async (bare: string, a: string, b: string) =>
    (
      await run(["git", "--git-dir", bare, "merge-base", "--is-ancestor", a, b], {
        allowFailure: true,
      })
    ).code === 0;
  const diffNames = async (bare: string, a: string, b: string) =>
    (await run(["git", "--git-dir", bare, "diff", "--name-only", a, b])).stdout
      .split(/\r?\n/)
      .filter(Boolean);

  it("Take it over on a repository whose old fr/docs-scaffold (a closed pull request's branch) names a third project: one docs pull request on fr/docs-scaffold-<project> from main, whose only change is the marker, with the take-over line; the old branch is untouched", async () => {
    const w = await world();
    try {
      const kite = await w.repo("kite");
      await kite.commit("main", { "README.md": "# kite\n" }, "first");
      // An earlier project's scaffold (another Forerunner's): its pull request closed unmerged,
      // its branch kept on GitHub, not in main.
      await run(["git", "-C", kite.seedDir, "checkout", "-q", "-b", DOCS_SCAFFOLD_BRANCH]);
      await scaffoldDocs(kite.seedDir, { name: "Sandbox hello", goal: "g", repos: ["o/kite"] });
      await kite.commit(
        DOCS_SCAFFOLD_BRANCH,
        { [INSTALL_MARKER_FILE]: mk(OTHER, "Sandbox hello") },
        "docs: scaffold the standard doc set",
      );
      const old = await w.host.createPullRequest(
        { owner: "o", name: "kite" },
        { title: "docs: scaffold", body: "old", head: DOCS_SCAFFOLD_BRANCH, base: "main" },
      );
      await w.host.updatePullRequest({ owner: "o", name: "kite" }, old.number, {
        state: "closed",
      });
      await run(["git", "-C", kite.seedDir, "checkout", "-q", "main"]);
      // main: Kite club's doc set and marker.
      await scaffoldDocs(kite.seedDir, { name: "Kite club", goal: "g", repos: ["o/kite"] });
      await kite.commit("main", { [INSTALL_MARKER_FILE]: mk(KITE, "Kite club") }, "Kite club");
      const oldHead = await head(kite.bare, DOCS_SCAFFOLD_BRANCH);
      const body = { name: "Kite flyers", goal: "g", repos: ["o/kite"] };
      expect((await w.post("/projects", body)).status).toBe(409);
      const made = await w.post("/projects", { ...body, takeOver: { projects: [KITE] } });
      expect(made.status).toBe(201);
      const id = String((await json(made)).id);
      const open = await w.host.listPullRequests({ owner: "o", name: "kite" }, { state: "open" });
      expect(open.map((p) => p.head.ref)).toEqual(["fr/docs-scaffold-kite-flyers"]);
      expect(open[0]?.body).toContain(
        'This repository was the Forerunner project "Kite club"; it is now the project "Kite flyers".',
      );
      // L4-github-108: no possessive after a quoted name.
      expect(open[0]?.body).not.toMatch(/"'s/);
      const branch = "fr/docs-scaffold-kite-flyers";
      expect(
        parseInstallMarker((await show(kite.bare, branch, INSTALL_MARKER_FILE)) ?? "")?.project,
      ).toBe(id);
      expect(await isAncestor(kite.bare, "main", branch)).toBe(true);
      // The marker, and the guide (W8-guide-1): main had the doc set but no guide.
      expect(await diffNames(kite.bare, "main", branch)).toEqual([
        INSTALL_MARKER_FILE,
        "AGENTS.md",
        "CLAUDE.md",
      ]);
      // The old branch and its closed pull request are left as they are (never force-pushed).
      expect(await head(kite.bare, DOCS_SCAFFOLD_BRANCH)).toBe(oldHead);
      expect(
        await w.host.listPullRequestComments({ owner: "o", name: "kite" }, old.number),
      ).toEqual([]);
      expect((await w.rt.store.project.mustGet(id)).summary_cache.docs).toMatchObject({
        pr_url: open[0]?.htmlUrl,
        marker: { status: "replaced" },
      });
      // This project's own scaffold branch, its pull request closed: the next scaffold starts it
      // again from main and replaces it with a lease (as fr/status), in the same branch.
      await w.host.updatePullRequest({ owner: "o", name: "kite" }, open[0]?.number ?? 0, {
        state: "closed",
      });
      await kite.commit("main", { "CONTRIBUTING.md": "Be kind.\n" }, "contributing");
      await w.rt.docs.scaffoldProject(await w.rt.store.project.mustGet(id));
      const again = await w.host.listPullRequests({ owner: "o", name: "kite" }, { state: "open" });
      expect(again.map((p) => p.head.ref)).toEqual([branch]);
      expect(await isAncestor(kite.bare, "main", branch)).toBe(true);
      // The marker, and the guide (W8-guide-1): main had the doc set but no guide.
      expect(await diffNames(kite.bare, "main", branch)).toEqual([
        INSTALL_MARKER_FILE,
        "AGENTS.md",
        "CLAUDE.md",
      ]);
      expect(await head(kite.bare, DOCS_SCAFFOLD_BRANCH)).toBe(oldHead);
    } finally {
      await w.rt.close();
    }
  }, 90_000);

  it("C4L-2: a take-over while this project's own scaffold pull request is open rebuilds that branch on main (a person's edit on it kept) with the replaced marker and comments the take-over line on it", async () => {
    const w = await world();
    try {
      const kite = await w.repo("kite2");
      await kite.commit(
        "main",
        { "README.md": "# kite\n", [INSTALL_MARKER_FILE]: mk(KITE, "Kite club") },
        "Kite club",
      );
      // Made before the rule (or while GitHub could not be read): its scaffold pull request
      // carries the docs and leaves Kite club's marker as it is.
      const project = await w.rt.store.project.insert({
        name: "Kites",
        goal: "g",
        repos: ["o/kite2"],
        author_human: w.rt.human.id,
      });
      const first = await w.rt.docs.scaffoldProject(project);
      expect(first.marker).toMatchObject({ status: "other_project", project: KITE });
      const [pr] = await w.host.listPullRequests({ owner: "o", name: "kite2" }, { state: "open" });
      expect(pr?.head.ref).toBe(DOCS_SCAFFOLD_BRANCH);
      // A person edits a doc on the pull request; main moves on meanwhile.
      await kite.seed.fetch();
      await run([
        "git",
        "-C",
        kite.seedDir,
        "checkout",
        "-q",
        "-B",
        DOCS_SCAFFOLD_BRANCH,
        `origin/${DOCS_SCAFFOLD_BRANCH}`,
      ]);
      await kite.commit(
        DOCS_SCAFFOLD_BRANCH,
        { "docs/overview.md": "# Overview\n\nOurs.\n" },
        "edit",
      );
      await run(["git", "-C", kite.seedDir, "checkout", "-q", "main"]);
      await run(["git", "-C", kite.seedDir, "reset", "-q", "--hard", "origin/main"]);
      await kite.commit("main", { "CONTRIBUTING.md": "Be kind.\n" }, "contributing");
      const taken = await w.post("/commands/execute", {
        commands: [{ name: "repo.take_over", params: { project: project.id } }],
        wordsUsed: "Take it over (Overview)",
        source: "ui",
        projectId: project.id,
        confirm: "tap",
      });
      const out = await json(taken);
      expect(out.status).toBe("done");
      expect(out.sentence).toBe('Took over o/kite2 from "Kite club".');
      const open = await w.host.listPullRequests({ owner: "o", name: "kite2" }, { state: "open" });
      expect(open.map((p) => p.number)).toEqual([pr?.number]);
      expect(await isAncestor(kite.bare, "main", DOCS_SCAFFOLD_BRANCH)).toBe(true);
      expect(
        parseInstallMarker((await show(kite.bare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? "")
          ?.project,
      ).toBe(project.id);
      expect(await show(kite.bare, DOCS_SCAFFOLD_BRANCH, "docs/overview.md")).toBe(
        "# Overview\n\nOurs.\n",
      );
      expect(await diffNames(kite.bare, "main", DOCS_SCAFFOLD_BRANCH)).toContain(
        INSTALL_MARKER_FILE,
      );
      const comments = await w.host.listPullRequestComments(
        { owner: "o", name: "kite2" },
        pr?.number ?? 0,
      );
      expect(comments.map((c) => c.body).join("\n")).toContain(tookOverLine("Kite club", "Kites"));
    } finally {
      await w.rt.close();
    }
  }, 90_000);

  it("L4i-left-14: the take-over's rebuild keeps the default branch's newer version of a file main changed after the scaffold branch left it (another Forerunner's merged docs), and carries over only what the branch alone changed", async () => {
    const w = await world();
    try {
      const kite = await w.repo("kite3");
      await kite.commit(
        "main",
        { "README.md": "# kite\n", [INSTALL_MARKER_FILE]: mk(KITE, "Kite club") },
        "Kite club",
      );
      const project = await w.rt.store.project.insert({
        name: "Kites",
        goal: "g",
        repos: ["o/kite3"],
        author_human: w.rt.human.id,
      });
      await w.rt.docs.scaffoldProject(project);
      const [pr] = await w.host.listPullRequests({ owner: "o", name: "kite3" }, { state: "open" });
      expect(pr?.head.ref).toBe(DOCS_SCAFFOLD_BRANCH);
      // Main moves under the branch: another Forerunner's docs pull request merged its own
      // docs/overview.md; the scaffold branch still has the template's.
      await kite.seed.fetch();
      await run(["git", "-C", kite.seedDir, "reset", "-q", "--hard", "origin/main"]);
      await kite.commit(
        "main",
        { "docs/overview.md": "# Overview\n\nWritten by the team.\n" },
        "docs: the team's overview",
      );
      const taken = await w.post("/commands/execute", {
        commands: [{ name: "repo.take_over", params: { project: project.id } }],
        wordsUsed: "Take it over (Overview)",
        source: "ui",
        projectId: project.id,
        confirm: "tap",
      });
      expect((await json(taken)).status).toBe("done");
      // Before: the branch's template replaced the team's overview in the rebuilt branch.
      expect(await show(kite.bare, DOCS_SCAFFOLD_BRANCH, "docs/overview.md")).toBe(
        "# Overview\n\nWritten by the team.\n",
      );
      expect(await diffNames(kite.bare, "main", DOCS_SCAFFOLD_BRANCH)).not.toContain(
        "docs/overview.md",
      );
      // What the branch alone added is still on it, with the replaced marker.
      expect(await show(kite.bare, DOCS_SCAFFOLD_BRANCH, "docs/runbook.md")).not.toBeNull();
      expect(
        parseInstallMarker((await show(kite.bare, DOCS_SCAFFOLD_BRANCH, INSTALL_MARKER_FILE)) ?? "")
          ?.project,
      ).toBe(project.id);
    } finally {
      await w.rt.close();
    }
  }, 90_000);
});
