import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { STATUS_DOC } from "@forerunner/memory";
import { fromPosix, join, run } from "@forerunner/platform";
import type { ProjectRow, SessionRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDocs, STATUS_BRANCH, WORKSPACE_DIR } from "../src/loop/docs.ts";
import type { SessionStatusUpdate } from "../src/loop/ports.ts";
import type { TaskExecutor } from "../src/session/runner.ts";
import {
  closingReply,
  doneExecutor,
  type LoopWorld,
  loopWorld,
  submitReply,
} from "./loop-helpers.ts";

/**
 * The PM keeps `docs/status.md` current (spec G.5): at session end the runner writes what was
 * done, blocked and next with the session id and the date from the Clock. With a repository
 * the update goes on Forerunner's own status branch and its one pull request, never on a
 * task's reviewed pull request (ADR 0106); the default branch is never pushed, except for the
 * first commit of an empty repository. Without a repository it lands in the project's folder,
 * committed with the session's work. A failure never fails the session.
 */
const identity = { name: "Forerunner", email: "agent@example.test" };
const REPO = { owner: "o", name: "sample" };
const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function bareRepo(): Promise<{ root: string; bare: string }> {
  const root = mkdtempSync(join(tmpdir(), "fr-loop-docs-"));
  roots.push(root);
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  return { root, bare };
}

async function show(bare: string, ref: string, path: string): Promise<string | null> {
  const r = await run(["git", "--git-dir", bare, "show", `${ref}:${path}`], {
    allowFailure: true,
  });
  return r.code === 0 ? r.stdout : null;
}

async function docsFor(w: LoopWorld, root: string, bare: string | null) {
  const host = new MemoryGitHost("alice");
  if (bare) await host.createRepo({ ...REPO, private: true, cloneUrl: bare });
  return {
    host,
    docs: new ProjectDocs({
      store: w.store,
      clock: w.clock,
      host,
      repoFor: async (p: ProjectRow) =>
        p.repos[0] && bare ? { clone: bare, repo: REPO, base: "main" } : null,
      worktreeRoot: join(root, "worktrees"),
      projectsRoot: join(root, "projects"),
      identity,
    }),
  };
}

/** An executor that does the task on a branch and opens its pull request, like the PR executor. */
function prExecutor(
  w: LoopWorld,
  root: string,
  bare: string,
  host: MemoryGitHost,
  branch: string,
): TaskExecutor {
  const inner = doneExecutor(w);
  return {
    async execute(ctx) {
      const result = await inner.execute(ctx);
      const git = new GitOps({ cwd: join(root, "task-wt"), identity });
      await git.clone(bare);
      await git.createBranch(branch, "origin/main");
      await mkdir(join(root, "task-wt", "src"), { recursive: true });
      writeFileSync(join(root, "task-wt", "src", "x.ts"), "export const x = 1;\n");
      await git.commitAll(ctx.task.title);
      await git.push(branch, { defaultBranch: "main" });
      const pr = await host.createPullRequest(REPO, {
        title: ctx.task.title,
        body: "work",
        head: branch,
        base: "main",
      });
      return { ...result, prUrl: pr.htmlUrl, branch };
    },
  };
}

describe("project docs at session end (spec G.5)", () => {
  it("the status update goes on Forerunner's status branch and pull request, never on the task's reviewed one: scaffolded first, with the task done, the session id and the date; main untouched (GitHub walk, 2026-11-02)", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      // C-57: the status pull request is off unless the person turns it on.
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const task = await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(
      w.runner(prExecutor(w, root, bare, host, "fr/add-clamp"), { docs }),
    );
    expect(result.completed).toEqual([task.id]);
    // Before: the status commit was pushed onto fr/add-clamp after the critic accepted it, so
    // the reviewed PR held a file the critic never saw. Now: the task's PR holds only its work.
    const prs = await host.listPullRequests(REPO, { state: "open" });
    expect(prs.map((p) => p.head.ref)).toEqual(["fr/add-clamp", STATUS_BRANCH]);
    expect(await show(bare, "fr/add-clamp", STATUS_DOC)).toBeNull();
    const status = await show(bare, STATUS_BRANCH, STATUS_DOC);
    expect(status).not.toBeNull();
    expect(status).toContain("maintained-by: forerunner");
    expect(status).toContain(`### 2026-10-20 session ${result.sessionId}`);
    expect(status).toContain("- Done: Add clamp");
    expect(status).toMatch(/## Done\n\n- Add clamp\n/);
    // The ledger's CHF for USD 0.30 (U-074).
    expect(status).toContain("- Note: stop reason completed; spent CHF 0.24");
    expect(await show(bare, "fr/add-clamp", "src/x.ts")).toBe("export const x = 1;\n");
    expect(await show(bare, STATUS_BRANCH, "src/x.ts")).toBeNull();
    expect(await show(bare, "main", STATUS_DOC)).toBeNull();
    expect(await show(bare, "main", "README.md")).toBe("# sample\n");
    const ev = w.events.find((e) => e.type === "docs.status_written");
    expect(ev?.payload).toMatchObject({
      location: "repo",
      branch: STATUS_BRANCH,
      path: STATUS_DOC,
      created: true,
      prUrl: prs[1]?.htmlUrl,
    });
    const session = await w.store.session.mustGet(result.sessionId);
    expect((session.handoff as { docs: unknown }).docs).toMatchObject({
      location: "repo",
      branch: STATUS_BRANCH,
    });
    await w.close();
  });

  it("a session that opened no pull request files the status PR, listing blocked work and the project's open tasks; the next session adds to the same PR", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const task = await w.addTask("Deploy to staging", { risk_tier: 1 });
    const later = await w.addTask("Write the runbook", { status: "draft" });
    const result = await w.start(w.runner(doneExecutor(w, { outcome: "needs_human" }), { docs }));
    expect(result.needsHuman).toEqual([task.id]);
    const branch = STATUS_BRANCH;
    const prs = await host.listPullRequests(REPO, { state: "open" });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ head: { ref: branch }, base: { ref: "main" } });
    expect(prs[0]?.title).toBe("docs: project status");
    expect(prs[0]?.body).toContain(result.sessionId);
    const status = await show(bare, branch, STATUS_DOC);
    expect(status).toContain(`session ${result.sessionId}`);
    expect(status).toContain("- Blocked: Deploy to staging");
    expect(status).toMatch(/## Blocked\n\n- Deploy to staging\n/);
    // The top sections are the project's state, so a task this session never ran is listed.
    expect(status).toMatch(/## Next\n\n- Write the runbook\n/);
    expect(later.status).toBe("draft");
    expect(await show(bare, "main", STATUS_DOC)).toBeNull();
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "repo",
      branch,
      prUrl: prs[0]?.htmlUrl,
    });
    // A second session adds its entry to the same branch and pull request (one status PR at
    // a time, not one per session for the person to merge).
    const second = await w.addTask("Add retries", { risk_tier: 0 });
    const again = await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    expect(again.completed).toEqual([second.id]);
    const twice = await show(bare, STATUS_BRANCH, STATUS_DOC);
    expect(twice).toContain(`session ${again.sessionId}`);
    expect(twice).toContain(`session ${result.sessionId}`);
    expect(twice).toMatch(/## Done\n\n- Add retries\n/);
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      branch,
    ]);
    expect(
      (await host.listPullRequestComments(REPO, prs[0]?.number ?? 0)).map((c) => c.body).join("\n"),
    ).toContain(again.sessionId);
    await w.close();
  });

  it("by default a repository project's status stays in the app: no status pull request, the Docs tab reads it (C-57)", async () => {
    // Before: every session of a repository project left a status PR for the person to merge,
    // even for a one-task project.
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(
      w.runner(prExecutor(w, root, bare, host, "fr/add-clamp"), { docs }),
    );
    expect(result.completed).toHaveLength(1);
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      "fr/add-clamp",
    ]);
    expect(await show(bare, STATUS_BRANCH, STATUS_DOC)).toBeNull();
    const dir = docs.statusDocRoot(await w.store.project.mustGet(w.project));
    expect(dir).toBe(docs.statusInAppDir(project.id));
    const text = await readFile(join(dir ?? "", fromPosix(STATUS_DOC)), "utf8");
    expect(text).toContain(`### 2026-10-20 session ${result.sessionId}`);
    expect(text).toContain("- Done: Add clamp");
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "app",
      path: STATUS_DOC,
    });
    // Turned on, the next session opens the status pull request.
    await w.store.project.patch(w.project, { settings: { status_pull_request: true } });
    expect(docs.statusDocRoot(await w.store.project.mustGet(w.project))).toBeNull();
    await w.addTask("Add retries", { risk_tier: 0 });
    await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      "fr/add-clamp",
      STATUS_BRANCH,
    ]);
    await w.close();
  });

  it("with the status in the app, the session's end still clones and refreshes this computer's copy of the repository (C-57 review)", async () => {
    // Review of fix/decisions: the in-app path returned before the docs clone was made or
    // fetched, so the Docs and Files tabs and the chat's docs search read nothing (no clone)
    // or the main of the last scaffold (a merge on the host never showed).
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const project = await w.store.project.mustGet(w.project);
    expect(docs.docsDirsFor(project)).toEqual([]);
    await w.addTask("Add clamp", { risk_tier: 0 });
    await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    const clone = join(root, "worktrees", w.project);
    expect(docs.docsDirsFor(project)).toEqual([clone]);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# sample\n");
    // The person merges something on the host; the next session's end brings it in, on main.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    writeFileSync(join(root, "seed", "notes.md"), "# notes\n");
    await seed.commitAll("notes");
    await seed.push("main");
    await w.addTask("Add retries", { risk_tier: 0 });
    await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    expect(await readFile(join(clone, "notes.md"), "utf8")).toBe("# notes\n");
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe("main");
    // Nothing went to the host: no status branch.
    expect(await show(bare, STATUS_BRANCH, STATUS_DOC)).toBeNull();
    await w.close();
  });

  it("without a repository the update lands under the project's data directory", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const task = await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(w.runner(doneExecutor(w), { docs }));
    expect(result.completed).toEqual([task.id]);
    const file = join(root, "projects", w.project, WORKSPACE_DIR, fromPosix(STATUS_DOC));
    expect(existsSync(file)).toBe(true);
    const status = await readFile(file, "utf8");
    expect(status).toContain(`### 2026-10-20 session ${result.sessionId}`);
    expect(status).toContain("- Done: Add clamp");
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "data_dir",
      path: STATUS_DOC,
      created: true,
    });
    await w.close();
  });

  it("a session that touched no task writes nothing, and a failing write never fails the session", async () => {
    // The task is reviewed before it is done (ADR 0104: tier 0 is the light review).
    const w = await loopWorld({ replies: [submitReply(), closingReply()] });
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const idle = await w.start(w.runner(doneExecutor(w), { docs }));
    expect(idle.status).toBe("completed");
    expect(w.events.map((e) => e.type)).toContain("docs.status_skipped");
    expect(w.events.find((e) => e.type === "docs.status_written")).toBeUndefined();
    expect(existsSync(join(root, "projects", w.project, WORKSPACE_DIR))).toBe(false);

    await w.addTask("Add clamp", { risk_tier: 0 });
    const broken = {
      scaffoldProject: docs.scaffoldProject.bind(docs),
      writeSessionStatus: async () => {
        throw new Error("git host down");
      },
    };
    const result = await w.start(
      w.runner(doneExecutor(w, { checksPassed: true }), { docs: broken }),
    );
    expect(result.status).toBe("completed");
    expect(result.completed).toHaveLength(1);
    const failed = w.events.find((e) => e.type === "docs.status_failed");
    expect(failed?.payload.warning).toContain("git host down");
    await w.close();
  });

  it("a session that only filed its plan (assisted mode) writes no status update", async () => {
    const w = await loopWorld();
    const root = mkdtempSync(join(tmpdir(), "fr-loop-docs-"));
    roots.push(root);
    const { docs } = await docsFor(w, root, null);
    await w.store.project.patch(w.project, { autonomy_level: 1 });
    await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(w.runner(doneExecutor(w), { docs }));
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("plan_awaiting_approval");
    const types = w.events.map((e) => e.type);
    expect(types).toContain("session.plan_filed");
    expect(types.filter((t) => t.startsWith("docs."))).toEqual([]);
    expect(existsSync(join(root, "projects", w.project, WORKSPACE_DIR))).toBe(false);
    await w.close();
  });

  it("docsDirsFor lists where G.5 keeps the doc set: a linked folder, the docs clone, the workspace", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const project = await w.store.project.mustGet(w.project);
    // Nothing written yet: no dir, and nothing is cloned to find out.
    expect(docs.docsDirsFor(project)).toEqual([]);
    expect(existsSync(join(root, "worktrees"))).toBe(false);
    // A project without a repository: its data-dir workspace once scaffolded.
    const workspace = join(root, "projects", w.project, WORKSPACE_DIR);
    await docs.scaffoldProject(project);
    expect(docs.docsDirsFor(project)).toEqual([workspace]);
    // With a repository: the docs clone the scaffold made comes first.
    const withRepo = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    await docs.scaffoldProject(withRepo);
    expect(docs.docsDirsFor(withRepo)).toEqual([join(root, "worktrees", w.project), workspace]);
    // A linked local folder (spec A.4) wins: the human's own checkout.
    const folder = join(root, "seed");
    const linked = await w.store.project.patch(w.project, { repos: [folder] });
    expect(docs.docsDirsFor(linked)[0]).toBe(folder);
    await w.close();
  });

  it("an empty repository gets the doc set as its first commit on main, with no pull request; the status PR then starts from it (GitHub walk, 2026-11-02)", async () => {
    // Before: the scaffold failed at project creation ("'origin/main' is not a commit"), only
    // in the daemon log, and the status update failed the same way at every session end.
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const root = mkdtempSync(join(tmpdir(), "fr-loop-docs-"));
    roots.push(root);
    const bare = join(root, "sample.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const { host, docs } = await docsFor(w, root, bare);
    const project = await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      settings: { status_pull_request: true },
    });
    const out = await docs.scaffoldProject(project);
    expect(out).toMatchObject({ location: "repo", branch: "main", prUrl: null, firstCommit: true });
    expect(out.created).toContain("README.md");
    expect(out.created).toContain("docs/overview.md");
    expect(await show(bare, "main", "README.md")).toContain(project.name);
    expect(await show(bare, "main", "docs/overview.md")).not.toBeNull();
    expect(await show(bare, "main", ".forerunner/project.json")).toContain(project.id);
    expect(await host.listPullRequests(REPO, { state: "open" })).toEqual([]);
    expect((await w.store.project.mustGet(w.project)).summary_cache.docs).toMatchObject({
      location: "repo",
      first_commit: true,
    });
    // The docs clone is on main, so the Docs tab reads the set from it.
    const clone = join(root, "worktrees", w.project);
    expect(existsSync(join(clone, "docs", "overview.md"))).toBe(true);

    await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(w.runner(doneExecutor(w), { docs }));
    expect(result.completed).toHaveLength(1);
    const prs = await host.listPullRequests(REPO, { state: "open" });
    expect(prs.map((p) => p.head.ref)).toEqual([STATUS_BRANCH]);
    expect(await show(bare, STATUS_BRANCH, STATUS_DOC)).toContain(`session ${result.sessionId}`);
    // Back on main after the write: the status waits in its PR, main is unchanged.
    expect(await show(bare, "main", STATUS_DOC)).toContain("maintained-by: forerunner");
    await w.close();
  });

  it("the docs waiting in a docs pull request are named with its number and link (the Docs tab)", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    // Nothing cloned yet: nothing to name, and no network to find out.
    expect(await docs.docsInPullRequests(project)).toEqual([]);
    const out = await docs.scaffoldProject(project);
    expect(out.prUrl).toContain("/pull/1");
    const waiting = await docs.docsInPullRequests(project);
    expect(waiting.find((d) => d.path === "docs/overview.md")).toEqual({
      path: "docs/overview.md",
      number: 1,
      url: out.prUrl,
    });
    // README.md is on main already (the seed): it does not wait anywhere.
    expect(waiting.some((d) => d.path === "README.md")).toBe(false);
    // The clone is back on main: the docs that wait are not read as present.
    expect(existsSync(join(root, "worktrees", w.project, "docs", "overview.md"))).toBe(false);
    await w.close();
  });

  it("in a project's folder the session's work and the status update are committed at the end: git status is clean (live, 2026-11-02)", async () => {
    // Before: only "Workspace before <task>" baselines were committed, so the last task's
    // files and docs/status.md stayed staged or modified after the project was done, and a
    // Python run's __pycache__ was staged into the project.
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const folder = join(root, "projects", w.project, WORKSPACE_DIR);
    await docs.scaffoldProject(await w.store.project.mustGet(w.project));
    await w.addTask("Write 404.html", { risk_tier: 1 });
    const inner = doneExecutor(w);
    const writing: TaskExecutor = {
      async execute(ctx) {
        // The last task's work, left in the folder as the PR executor leaves it (staged).
        writeFileSync(join(folder, "404.html"), "<h1>Not found</h1>\n");
        await mkdir(join(folder, "__pycache__"), { recursive: true });
        writeFileSync(join(folder, "__pycache__", "x.cpython-312.pyc"), "x");
        return inner.execute(ctx);
      },
    };
    const result = await w.start(w.runner(writing, { docs }));
    expect(result.completed).toHaveLength(1);
    const status = await run(["git", "-C", folder, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
    const log = await run(["git", "-C", folder, "log", "-n", "1", "--name-only", "--format=%s"]);
    expect(log.stdout).toContain('Did "Write 404.html"');
    expect(log.stdout).toContain("404.html");
    expect(log.stdout).toContain("docs/status.md");
    expect(log.stdout).not.toContain("__pycache__");
    const ignore = await readFile(join(folder, ".gitignore"), "utf8");
    expect(ignore).toContain("__pycache__/");
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "data_dir",
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    await w.close();
  });

  it("a project linked to a local folder keeps its G.5 doc set in the workspace, and docsDirsFor lists both", async () => {
    // Review w2-chat-memory finding 4: the daemon's repoFor is null for a local path
    // (`parseRepoRef`), so the scaffold and the status updates write the workspace; the chat
    // must search it beside the folder's own docs.
    const w = await loopWorld();
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const folder = join(root, "seed");
    const project = await w.store.project.patch(w.project, { repos: [folder] });
    const out = await docs.scaffoldProject(project);
    expect(out.location).toBe("data_dir");
    const workspace = join(root, "projects", w.project, WORKSPACE_DIR);
    expect(existsSync(join(workspace, "docs", "status.md"))).toBe(true);
    expect(docs.docsDirsFor(project)).toEqual([folder, workspace]);
    await w.close();
  });
});

describe("this computer's copy: one lock per copy, and its Local only folder (merged-copy, ADR 0113)", () => {
  const update = (sessionId: string): SessionStatusUpdate => ({
    sessionId,
    endedAt: "2026-11-03T09:00:00.000Z",
    done: ["Add clamp"],
    inFlight: [],
    blocked: [],
    next: [],
  });

  it("the watcher's refresh while a docs write has the copy on its branch waits for it; both finish and the copy ends on the default branch", async () => {
    // Before: the refresh ran git in the same clone at once (fetch, checkout main) while the
    // status write had it on fr/status between its commit and its pull request.
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const clone = join(root, "worktrees", w.project);
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((r) => {
      reached = r;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create = host.createPullRequest.bind(host);
    host.createPullRequest = async (...args) => {
      reached();
      await gate;
      return create(...args);
    };
    const order: string[] = [];
    const write = docs
      .writeSessionStatus({ project, session: { id: "s-1" } as SessionRow, update: update("s-1") })
      .then((r) => {
        order.push("write");
        return r;
      });
    await atGate;
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe(STATUS_BRANCH);
    // The person merges something on the host meanwhile; the watcher's refresh comes.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    writeFileSync(join(root, "seed", "notes.md"), "# notes\n");
    await seed.commitAll("notes");
    await seed.push("main");
    const refresh = docs.refreshCopy(project).then((r) => {
      order.push("refresh");
      return r;
    });
    // While the write holds the copy, the refresh has not run (with the lock, for as long as
    // the write takes; the wait below only gives a refresh without it time to finish).
    const early = await Promise.race([
      refresh.then(() => "refreshed while the write held the copy"),
      new Promise<string>((r) => setTimeout(() => r("waiting"), 1500)),
    ]);
    expect(early).toBe("waiting");
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe(STATUS_BRANCH);
    release();
    const [written, refreshed] = await Promise.all([write, refresh]);
    expect(order).toEqual(["write", "refresh"]);
    expect(written).toMatchObject({ location: "repo", branch: STATUS_BRANCH });
    expect(refreshed).toEqual({ refreshed: true });
    expect(await show(bare, STATUS_BRANCH, STATUS_DOC)).toContain("session s-1");
    const git = new GitOps({ cwd: clone, identity });
    expect(await git.currentBranch()).toBe("main");
    expect(await readFile(join(clone, "notes.md"), "utf8")).toBe("# notes\n");
    expect(docs.copyView(project)?.updatedAt).toBe(w.clock.nowIso());
    await w.close();
  });

  it("the copy has a Local only folder git never sees, which a refresh and a docs write keep; the Files tab gets its line", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    expect(docs.copyView(project)).toEqual({ updatedAt: null, localOnly: null });
    await docs.refreshCopy(project);
    const clone = join(root, "worktrees", w.project);
    const local = join(clone, "Local only");
    expect(docs.localOnlyFolder(project)).toBe(local);
    expect(docs.copyView(project)?.localOnly).toEqual({
      folder: local,
      line: "Never uploaded. Agents can read and change it.",
    });
    writeFileSync(join(local, "notes.txt"), "mine\n");
    const git = new GitOps({ cwd: clone, identity });
    expect((await git.status()).files).toEqual([]);
    // A docs write (commit on fr/status, push, pull request) and a refresh keep it, and the
    // write's commit does not carry it.
    await docs.writeSessionStatus({
      project,
      session: { id: "s-2" } as SessionRow,
      update: update("s-2"),
    });
    await docs.refreshCopy(project);
    expect(await readFile(join(local, "notes.txt"), "utf8")).toBe("mine\n");
    const onStatus = await run([
      "git",
      "--git-dir",
      bare,
      "ls-tree",
      "-r",
      "--name-only",
      STATUS_BRANCH,
    ]);
    expect(onStatus.stdout).not.toContain("Local only");
    expect(onStatus.stdout).toContain(STATUS_DOC);
    await w.close();
  });

  it("the watcher's read of a head the copy already has asks the host nothing; a new head brings the copy to it", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    let asked = 0;
    const docs = new ProjectDocs({
      store: w.store,
      clock: w.clock,
      host: new MemoryGitHost("alice"),
      repoFor: async () => {
        asked++;
        return { clone: bare, repo: REPO, base: "main" };
      },
      worktreeRoot: join(root, "worktrees"),
      projectsRoot: join(root, "projects"),
      identity,
    });
    expect(await docs.refreshCopy(project)).toEqual({ refreshed: true });
    const clone = join(root, "worktrees", w.project);
    const head = await new GitOps({ cwd: clone, identity }).headSha();
    asked = 0;
    expect(await docs.refreshCopy(project, { head, base: "main" })).toEqual({ refreshed: false });
    expect(asked).toBe(0);
    // Someone merges on the host: the next read names a new head, and the copy follows.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    writeFileSync(join(root, "seed", "merged.md"), "# merged\n");
    await seed.commitAll("merged");
    await seed.push("main");
    const moved = await seed.headSha();
    expect(await docs.refreshCopy(project, { head: moved, base: "main" })).toEqual({
      refreshed: true,
    });
    expect(await readFile(join(clone, "merged.md"), "utf8")).toBe("# merged\n");
    expect(await new GitOps({ cwd: clone, identity }).headSha()).toBe(moved);
    await w.close();
  });

  it("a copy that cannot follow a merge says why, with the files: a file the person changed that the merge changes too, or one of theirs in the way; once moved away, the next merge brings it up to date (R-copystuck)", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    await docs.refreshCopy(project);
    const clone = join(root, "worktrees", w.project);
    const first = docs.copyView(project);
    expect(first?.updatedAt).toBe(w.clock.nowIso());
    expect(first?.stopped ?? null).toBeNull();
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    const merge = async (file: string, text: string) => {
      writeFileSync(join(root, "seed", file), text);
      await seed.commitAll(`merged ${file}`);
      await seed.push("main");
      await w.clock.advance(60_000);
      return docs.refreshCopy(project, { head: await seed.headSha(), base: "main" });
    };
    // The person edits README.md in the copy; a merge then changes README.md too.
    writeFileSync(join(clone, "README.md"), "# my own notes\n");
    await merge("README.md", "# sample, merged\n");
    const changed = docs.copyView(project);
    expect(changed?.updatedAt).toBe(first?.updatedAt);
    expect(changed?.stopped).toEqual({
      reason: "changed",
      files: ["README.md"],
      line: "You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.",
    });
    // Their file is kept as they left it.
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# my own notes\n");
    // The person puts README.md back; a file of theirs is now in the way of the next merge.
    writeFileSync(join(clone, "README.md"), "# sample\n");
    writeFileSync(join(clone, "notes.md"), "my notes\n");
    await merge("notes.md", "# notes, merged\n");
    expect(docs.copyView(project)?.stopped).toEqual({
      reason: "in_the_way",
      files: ["notes.md"],
      line: "notes.md in this copy is in the way of a merged file: move it and the copy follows again.",
    });
    // Moved away: the next refresh brings the copy to what is merged and says nothing more.
    rmSync(join(clone, "notes.md"));
    await w.clock.advance(60_000);
    expect(await docs.refreshCopy(project, { head: await seed.headSha(), base: "main" })).toEqual({
      refreshed: true,
    });
    const after = docs.copyView(project);
    expect(after?.stopped ?? null).toBeNull();
    expect(after?.updatedAt).toBe(w.clock.nowIso());
    expect(await readFile(join(clone, "notes.md"), "utf8")).toBe("# notes, merged\n");
    await w.close();
  });

  it("a repository that already tracks a folder named Local only gets none, with one sentence", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await mkdir(join(root, "seed", "Local only"), { recursive: true });
    writeFileSync(join(root, "seed", "Local only", "readme.md"), "the repository's own\n");
    await seed.commitAll("a folder of that name");
    await seed.push("main");
    const { docs } = await docsFor(w, root, bare);
    await docs.refreshCopy(project);
    expect(docs.localOnlyFolder(project)).toBeNull();
    expect(docs.copyView(project)?.localOnly).toEqual({
      folder: null,
      line: "No Local only folder here: this repository already has a folder of that name.",
    });
    await w.close();
  });

  it("a repository that starts tracking files in Local only after the copy made the folder: the refresh loses none of the person's files, keeps the ones in the way as '(yours)', and Files says so (review of merged-copy)", async () => {
    // Before: the refresh's `checkout -B main origin/main` overwrote the person's ignored
    // `Local only/notes.txt` with the repository's without a word (git's default for ignored
    // files), and Files said only that the repository has a folder of that name.
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    await docs.refreshCopy(project);
    const clone = join(root, "worktrees", w.project);
    const local = join(clone, "Local only");
    expect(docs.localOnlyFolder(project)).toBe(local);
    // The person's files: one at a path the repository will take, one in a folder's way, a
    // folder where the repository puts a file, one the repository has the same, one of its own.
    writeFileSync(join(local, "notes.txt"), "mine\n");
    writeFileSync(join(local, "data"), "my data file\n");
    await mkdir(join(local, "sub"), { recursive: true });
    writeFileSync(join(local, "sub", "inner.txt"), "my inner\n");
    writeFileSync(join(local, "same.txt"), "shared\n");
    writeFileSync(join(local, "other.txt"), "only mine\n");
    // A collaborator commits files under "Local only/" on the default branch.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    const theirs = join(root, "seed", "Local only");
    await mkdir(join(theirs, "data"), { recursive: true });
    writeFileSync(join(theirs, "notes.txt"), "the team's shared note\n");
    writeFileSync(join(theirs, "data", "y.csv"), "a,b\n");
    writeFileSync(join(theirs, "sub"), "the team's sub\n");
    writeFileSync(join(theirs, "same.txt"), "shared\n");
    await seed.commitAll("the team's Local only");
    await seed.push("main");
    const head = await seed.headSha();
    expect(await docs.refreshCopy(project, { head, base: "main" })).toEqual({ refreshed: true });
    const git = new GitOps({ cwd: clone, identity });
    expect(await git.headSha()).toBe(head);
    expect(await readFile(join(local, "notes.txt"), "utf8")).toBe("the team's shared note\n");
    expect(await readFile(join(local, "notes (yours).txt"), "utf8")).toBe("mine\n");
    expect(await readFile(join(local, "data", "y.csv"), "utf8")).toBe("a,b\n");
    expect(await readFile(join(local, "data (yours)"), "utf8")).toBe("my data file\n");
    expect(await readFile(join(local, "sub"), "utf8")).toBe("the team's sub\n");
    expect(await readFile(join(local, "sub (yours)", "inner.txt"), "utf8")).toBe("my inner\n");
    expect(await readFile(join(local, "same.txt"), "utf8")).toBe("shared\n");
    expect(existsSync(join(local, "same (yours).txt"))).toBe(false);
    expect(await readFile(join(local, "other.txt"), "utf8")).toBe("only mine\n");
    // The person's files stay out of git: nothing for a docs commit to stage.
    expect((await git.status()).files).toEqual([]);
    expect(docs.localOnlyFolder(project)).toBeNull();
    const line =
      'No Local only folder here any more: this repository now has a folder of that name. Your files in it stay on this computer; the ones named like the repository\'s are now "data (yours)", "notes (yours).txt" and "sub (yours)".';
    expect(docs.copyView(project)?.localOnly).toEqual({ folder: null, line });
    // The next poll moves nothing again, and the line is still true; across a restart too.
    expect(await docs.refreshCopy(project, { head, base: "main" })).toEqual({ refreshed: false });
    const { docs: again } = await docsFor(w, root, bare);
    expect(again.copyView(project)?.localOnly).toEqual({ folder: null, line });
    expect(await readFile(join(local, "notes (yours).txt"), "utf8")).toBe("mine\n");
    await w.close();
  });

  it("a docs write whose branch starts from a default branch that now tracks the person's Local only file keeps it (review of merged-copy)", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    await docs.refreshCopy(project);
    const clone = join(root, "worktrees", w.project);
    const local = join(clone, "Local only");
    writeFileSync(join(local, "notes.txt"), "mine\n");
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await mkdir(join(root, "seed", "Local only"), { recursive: true });
    writeFileSync(join(root, "seed", "Local only", "notes.txt"), "the team's shared note\n");
    await seed.commitAll("the team's Local only");
    await seed.push("main");
    // No refresh in between: the status write's own checkout of fr/status meets it first.
    await docs.writeSessionStatus({
      project,
      session: { id: "s-3" } as SessionRow,
      update: update("s-3"),
    });
    expect(await show(bare, STATUS_BRANCH, STATUS_DOC)).toContain("session s-3");
    expect(await show(bare, STATUS_BRANCH, "Local only/notes.txt")).toBe(
      "the team's shared note\n",
    );
    expect(await show(bare, STATUS_BRANCH, "Local only/notes (yours).txt")).toBeNull();
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe("main");
    expect(await readFile(join(local, "notes.txt"), "utf8")).toBe("the team's shared note\n");
    expect(await readFile(join(local, "notes (yours).txt"), "utf8")).toBe("mine\n");
    await w.close();
  });
});
