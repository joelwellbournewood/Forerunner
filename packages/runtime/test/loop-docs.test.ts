import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { STATUS_DOC } from "@forerunner/memory";
import { fromPosix, join, run } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDocs, STATUS_BRANCH, WORKSPACE_DIR } from "../src/loop/docs.ts";
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
 * task's reviewed pull request (ADR 0104); the default branch is never pushed, except for the
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
    await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
    await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
    const w = await loopWorld();
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
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
