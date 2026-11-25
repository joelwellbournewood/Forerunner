import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { STATUS_DOC } from "@forerunner/memory";
import { fromPosix, join, run } from "@forerunner/platform";
import type { ProjectRow, SessionRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  docsPrListing,
  isProjectDocsPr,
  ownsUnmarkedDocs,
  ProjectDocs,
  WORKSPACE_DIR,
} from "../src/loop/docs.ts";
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
 * done, blocked and next, named by when the session started. With a repository the status is
 * the app's (w8-status-write, ADR 0122: GitHub's copy is the status issue, the status pull
 * request on fr/status went); the default branch is never pushed, except for the first commit
 * of an empty repository. Without a repository it lands in the project's folder, committed with
 * the session's work. A failure never fails the session.
 */
const identity = { name: "Forerunner", email: "agent@example.test" };
/**
 * The status branch an earlier version kept docs/status.md on (w8-status-write: the status pull
 * request went with the status issue; nothing writes this branch any more).
 */
const OLD_STATUS_BRANCH = "fr/status";
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

/**
 * The heading of a session's entry in docs/status.md: named by when it started, never by its id
 * (W15-08; l3-small, run L3, L3-github-6).
 */
async function startedHeading(w: LoopWorld, sessionId: string): Promise<string> {
  const at = (await w.store.session.mustGet(sessionId)).started_at ?? "";
  return `### Session started ${at.slice(0, 10)} ${at.slice(11, 16)} UTC\n`;
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
  it("w8-status-write (amendment 2): a repository project's status is the app's, also with an earlier version's status pull request setting on: no status pull request, no fr/status branch, nothing on the task's reviewed one, main untouched; the note stays the app's", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, {
      repos: ["o/sample"],
      // The setting an earlier version stored: it changes nothing now.
      settings: { status_pull_request: true },
    });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const task = await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(
      w.runner(prExecutor(w, root, bare, host, "fr/add-clamp"), { docs }),
    );
    expect(result.completed).toEqual([task.id]);
    // The task's PR holds only its work (ADR 0106); the guide's docs pull request opens (W8-guide-1).
    const prs = await host.listPullRequests(REPO, { state: "open" });
    expect(prs.map((p) => p.head.ref)).toEqual(["fr/add-clamp", "fr/docs-scaffold"]);
    expect(await show(bare, "fr/add-clamp", STATUS_DOC)).toBeNull();
    expect(await show(bare, OLD_STATUS_BRANCH, STATUS_DOC)).toBeNull();
    expect(await show(bare, "fr/docs-scaffold", STATUS_DOC)).toBeNull();
    expect(await show(bare, "fr/add-clamp", "src/x.ts")).toBe("export const x = 1;\n");
    expect(await show(bare, "main", STATUS_DOC)).toBeNull();
    expect(await show(bare, "main", "README.md")).toBe("# sample\n");
    const project = await w.store.project.mustGet(w.project);
    const status = await readFile(
      join(docs.statusDocRoot(project) ?? "", fromPosix(STATUS_DOC)),
      "utf8",
    );
    expect(status).toContain("maintained-by: forerunner");
    expect(status).toContain(await startedHeading(w, result.sessionId));
    expect(status).not.toContain(result.sessionId);
    expect(status).toMatch(/## Done\n\n- Add clamp\n/);
    // The spend is the person's own record, in the app only (R11: never on GitHub).
    expect(status).toContain("- Note: Done. Spent CHF 0.24.");
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "app",
      path: STATUS_DOC,
      created: true,
    });
    const session = await w.store.session.mustGet(result.sessionId);
    expect((session.handoff as { docs: unknown }).docs).toMatchObject({ location: "app" });
    await w.close();
  });

  it("a session that opened no pull request keeps its status in the app, listing blocked work and the project's open tasks; the next session adds its entry there; no status pull request (w8-status-write)", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const task = await w.addTask("Deploy to staging", { risk_tier: 1 });
    const later = await w.addTask("Write the runbook", { status: "draft" });
    const result = await w.start(w.runner(doneExecutor(w, { outcome: "needs_human" }), { docs }));
    expect(result.needsHuman).toEqual([task.id]);
    // W8-guide-1: the one docs pull request that brings the guide, and no status pull request.
    const prs = await host.listPullRequests(REPO, { state: "open" });
    expect(prs.map((p) => p.head.ref)).toEqual(["fr/docs-scaffold"]);
    const file = () =>
      readFile(join(docs.statusInAppDir(w.project), fromPosix(STATUS_DOC)), "utf8");
    const status = await file();
    expect(status).toContain(await startedHeading(w, result.sessionId));
    expect(status).toContain("- Blocked: Deploy to staging");
    expect(status).toContain("- Note: Ended: 1 task needs you. Spent CHF");
    expect(status).toMatch(/## Blocked\n\n- Deploy to staging\n/);
    // The top sections are the project's state, so a task this session never ran is listed.
    expect(status).toMatch(/## Next\n\n- Write the runbook\n/);
    expect(later.status).toBe("draft");
    expect(await show(bare, "main", STATUS_DOC)).toBeNull();
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "app",
    });
    const second = await w.addTask("Add retries", { risk_tier: 0 });
    const again = await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    expect(again.completed).toEqual([second.id]);
    const twice = await file();
    expect(twice).toContain(await startedHeading(w, again.sessionId));
    expect(twice).toContain(await startedHeading(w, result.sessionId));
    expect(twice.match(/^### Session started /gm)).toHaveLength(2);
    expect(twice).not.toContain(again.sessionId);
    expect(twice).toMatch(/## Done\n\n- Add retries\n/);
    // Nothing in the guide's facts changed: no second docs pull request, no status one.
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      "fr/docs-scaffold",
    ]);
    expect(await show(bare, OLD_STATUS_BRANCH, STATUS_DOC)).toBeNull();
    await w.close();
  });

  it("a repository project's status stays in the app: no status pull request, the Docs tab reads it (C-57, w8-status-write)", async () => {
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
    // W8-guide-1: the guide's docs pull request, and no status pull request.
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      "fr/add-clamp",
      "fr/docs-scaffold",
    ]);
    expect(await show(bare, OLD_STATUS_BRANCH, STATUS_DOC)).toBeNull();
    const dir = docs.statusDocRoot(await w.store.project.mustGet(w.project));
    expect(dir).toBe(docs.statusInAppDir(project.id));
    const text = await readFile(join(dir ?? "", fromPosix(STATUS_DOC)), "utf8");
    expect(text).toContain(await startedHeading(w, result.sessionId));
    expect(text).toContain("- Done: Add clamp");
    expect(w.events.find((e) => e.type === "docs.status_written")?.payload).toMatchObject({
      location: "app",
      path: STATUS_DOC,
    });
    // w8-status-write: the setting an earlier version stored changes nothing: still the app's.
    await w.store.project.patch(w.project, { settings: { status_pull_request: true } });
    expect(docs.statusDocRoot(await w.store.project.mustGet(w.project))).toBe(dir);
    await w.addTask("Add retries", { risk_tier: 0 });
    await w.start(w.runner(doneExecutor(w, { checksPassed: true }), { docs }));
    expect((await host.listPullRequests(REPO, { state: "open" })).map((p) => p.head.ref)).toEqual([
      "fr/add-clamp",
      "fr/docs-scaffold",
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
    expect(await show(bare, OLD_STATUS_BRANCH, STATUS_DOC)).toBeNull();
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
    expect(status).toContain(await startedHeading(w, result.sessionId));
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

  it("an empty repository gets the doc set as its first commit on main, with no pull request; the session's end opens none either (GitHub walk, 2026-11-02; w8-status-write)", async () => {
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
    expect(await host.listPullRequests(REPO, { state: "open" })).toEqual([]);
    expect(
      await readFile(join(docs.statusInAppDir(w.project), fromPosix(STATUS_DOC)), "utf8"),
    ).toContain(await startedHeading(w, result.sessionId));
    // Main is unchanged. W8-guide-1, -2: the first commit brought the guide and no
    // docs/status.md, so the session's end opens no docs pull request.
    expect(await show(bare, "main", STATUS_DOC)).toBeNull();
    expect(await show(bare, "main", "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(await show(bare, "main", "AGENTS.md")).toContain(
      `This repository is the Forerunner project "${project.name}".`,
    );
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
    // W8-guide-1, -2: the set brings the guide and no docs/status.md.
    expect(existsSync(join(workspace, "docs", "overview.md"))).toBe(true);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, "docs", "status.md"))).toBe(false);
    expect(docs.docsDirsFor(project)).toEqual([folder, workspace]);
    await w.close();
  });
});

describe("this computer's copy: one lock per copy, and its Local only folder (merged-copy, ADR 0113)", () => {
  it("the watcher's refresh while a docs write has the copy on its branch waits for it; both finish and the copy ends on the default branch", async () => {
    // Before: the refresh ran git in the same clone at once (fetch, checkout main) while a docs
    // write had it on its branch between its commit and its pull request. (w8-status-write: the
    // docs write here is the scaffold's; the status write, which pushed nothing since, went.)
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
    const write = docs.scaffoldProject(project).then((r) => {
      order.push("write");
      return r;
    });
    await atGate;
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe("fr/docs-scaffold");
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
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe("fr/docs-scaffold");
    release();
    const [written, refreshed] = await Promise.all([write, refresh]);
    expect(order).toEqual(["write", "refresh"]);
    expect(written.prUrl).not.toBeNull();
    expect(refreshed).toEqual({ refreshed: true });
    expect(await show(bare, "fr/docs-scaffold", "AGENTS.md")).toContain(project.name);
    const git = new GitOps({ cwd: clone, identity });
    expect(await git.currentBranch()).toBe("main");
    expect(await readFile(join(clone, "notes.md"), "utf8")).toBe("# notes\n");
    expect(docs.copyView(project)?.updatedAt).toBe(w.clock.nowIso());
    await w.close();
  });

  it("the copy has a Local only folder git never sees, which a refresh and a docs write keep; the Files tab gets its line", async () => {
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
    // A docs write (the scaffold's commit on fr/docs-scaffold, push, pull request) and a refresh
    // keep it, and the write's commit does not carry it.
    await docs.scaffoldProject(project);
    await docs.refreshCopy(project);
    expect(await readFile(join(local, "notes.txt"), "utf8")).toBe("mine\n");
    const onBranch = await run([
      "git",
      "--git-dir",
      bare,
      "ls-tree",
      "-r",
      "--name-only",
      "fr/docs-scaffold",
    ]);
    expect(onBranch.stdout).not.toContain("Local only");
    expect(onBranch.stdout).toContain("AGENTS.md");
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
    // Across a restart (a new ProjectDocs over the same folders): the copy still says it
    // stopped and why, also after the first refresh of the new daemon (the review's rule 4).
    const { docs: restarted } = await docsFor(w, root, bare);
    expect(restarted.copyView(project)?.stopped).toEqual(changed?.stopped);
    await restarted.refreshCopy(project, { head: await seed.headSha(), base: "main" });
    expect(restarted.copyView(project)).toMatchObject({
      updatedAt: first?.updatedAt,
      stopped: changed?.stopped,
    });
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

  it("the copy's own git config says core.autocrlf=false after a refresh, also a copy cloned before it did; the person's own git with Git for Windows' default then puts a file back as ours reads it, and the copy follows again (R-copystuck, Windows)", async () => {
    // Desktop app run 42525106539 (Windows): the person put README.md back with their own git,
    // which Git for Windows sets up with core.autocrlf=true (its system config), so it wrote the
    // file with CRLF; our git (`-c core.autocrlf=false`) read that as still changed, and the copy
    // never followed a merge again. The person's git here is set up the same way, through a
    // global config (a `-c` would beat the folder's own config, which the fix relies on).
    const w = await loopWorld();
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    await docs.refreshCopy(project);
    const clone = join(root, "worktrees", w.project);
    const configFile = join(clone, ".git", "config");
    const setting = async () =>
      (
        await run(["git", "-C", clone, "config", "--local", "--get", "core.autocrlf"], {
          allowFailure: true,
        })
      ).stdout.trim();
    expect(await setting()).toBe("false");
    // A copy cloned before the fix: its config does not say so.
    await run(["git", "-C", clone, "config", "--local", "--unset", "core.autocrlf"]);
    expect(await setting()).toBe("");
    const windowsGit = join(root, "git-for-windows.gitconfig");
    writeFileSync(windowsGit, "[core]\n\tautocrlf = true\n");
    const persons = (args: string[]) =>
      run(["git", "-C", clone, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: windowsGit },
      });
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    const merge = async (file: string, text: string) => {
      writeFileSync(join(root, "seed", file), text);
      await seed.commitAll(`merged ${file}`);
      await seed.push("main");
      await w.clock.advance(60_000);
      return docs.refreshCopy(project, { head: await seed.headSha(), base: "main" });
    };
    // The person's editor saves README.md with CRLF and nothing else changed; a merge changes
    // README.md. A difference in line endings alone is still the person's change (as before):
    // the copy never overwrites it, says so, and now the person's own git says so too.
    writeFileSync(join(clone, "README.md"), "# sample\r\n");
    await merge("README.md", "# sample, merged\n");
    const stuck = docs.copyView(project)?.stopped;
    expect(stuck).toEqual({
      reason: "changed",
      files: ["README.md"],
      line: "You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.",
    });
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# sample\r\n");
    // That refresh wrote the setting into the copy cloned before the fix.
    expect(await setting()).toBe("false");
    expect((await persons(["status", "--porcelain"])).stdout).toBe(" M README.md\n");
    // The person moves the change away with their own git: the file as committed, LF.
    await persons(["checkout", "--", "README.md"]);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# sample\n");
    // The next refresh brings the copy to what is merged.
    expect(await docs.refreshCopy(project, { head: await seed.headSha(), base: "main" })).toEqual({
      refreshed: true,
    });
    expect(docs.copyView(project)?.stopped ?? null).toBeNull();
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# sample, merged\n");
    // Across a restart (a new ProjectDocs over the same folders): the watcher's read of the head
    // the copy has (every poll) leaves the config file as it is, not written again; a full
    // refresh keeps the setting once (its `checkout -B` rewrites the branch's tracking lines, so
    // only the content is compared there).
    const config = await readFile(configFile, "utf8");
    expect(config.match(/autocrlf/g)).toHaveLength(1);
    const written = statSync(configFile).mtimeMs;
    const { docs: restarted } = await docsFor(w, root, bare);
    expect(
      await restarted.refreshCopy(project, { head: await seed.headSha(), base: "main" }),
    ).toEqual({ refreshed: false });
    expect(statSync(configFile).mtimeMs).toBe(written);
    expect(await readFile(configFile, "utf8")).toBe(config);
    await restarted.refreshCopy(project);
    expect(await readFile(configFile, "utf8")).toBe(config);
    expect(await setting()).toBe("false");
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
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
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
    // No refresh in between: the scaffold's own checkout of its branch meets it first.
    await docs.scaffoldProject(project);
    expect(await show(bare, "fr/docs-scaffold", "AGENTS.md")).toContain(project.name);
    expect(await show(bare, "fr/docs-scaffold", "Local only/notes.txt")).toBe(
      "the team's shared note\n",
    );
    expect(await show(bare, "fr/docs-scaffold", "Local only/notes (yours).txt")).toBeNull();
    expect(await new GitOps({ cwd: clone, identity }).currentBranch()).toBe("main");
    expect(await readFile(join(local, "notes.txt"), "utf8")).toBe("the team's shared note\n");
    expect(await readFile(join(local, "notes (yours).txt"), "utf8")).toBe("mine\n");
    await w.close();
  });
});

describe("leftovers7-tailmerge, wave 13", () => {
  /** A language git's messages are translated into here, or null when none is installed. */
  async function translatedLanguage(): Promise<Record<string, string> | null> {
    const dir = mkdtempSync(join(tmpdir(), "fr-lang-"));
    const said = async (env: Record<string, string>) =>
      (
        await run(["git", "-C", dir, "rev-parse", "--verify", "no-such-ref"], {
          allowFailure: true,
          env: { ...process.env, ...env },
        })
      ).stderr;
    await run(["git", "init", "-q", dir]);
    try {
      const english = await said({ LC_ALL: "C", LANGUAGE: "" });
      for (const lang of ["de_DE.UTF-8", "fr_FR.UTF-8", "es_ES.UTF-8"]) {
        const env = { LANGUAGE: lang.slice(0, 2), LC_ALL: lang, LANG: lang };
        if ((await said(env)) !== english) return env;
      }
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a copy that stops following says which file, also when the person's git speaks another language (TM-6)", async (ctx) => {
    const language = await translatedLanguage();
    if (!language) {
      // GitOps' own env is tested in capabilities' git.test.ts ('untranslated'); here git would
      // print English whatever the language asked, so the case proves nothing.
      ctx.skip("git's translations (or the de, fr, es locales) are not installed on this machine");
      return;
    }
    const was = Object.fromEntries(Object.keys(language).map((k) => [k, process.env[k]]));
    Object.assign(process.env, language);
    const w = await loopWorld();
    try {
      const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
      const { root, bare } = await bareRepo();
      const { docs } = await docsFor(w, root, bare);
      await docs.refreshCopy(project);
      const clone = join(root, "worktrees", w.project);
      const seed = new GitOps({ cwd: join(root, "seed"), identity });
      writeFileSync(join(clone, "README.md"), "# my own notes\n");
      writeFileSync(join(root, "seed", "README.md"), "# sample, merged\n");
      await seed.commitAll("merged README.md");
      await seed.push("main");
      await w.clock.advance(60_000);
      await docs.refreshCopy(project, { head: await seed.headSha(), base: "main" });
      // Before: git's message came in the person's language, `copyStoppedOf` read "other" and
      // the Files line said "Git could not bring it to what is merged" with no file.
      expect(docs.copyView(project)?.stopped).toMatchObject({
        reason: "changed",
        files: ["README.md"],
      });
    } finally {
      for (const [k, v] of Object.entries(was))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      await w.close();
    }
  });
});

describe("w15-merge, wave 15", () => {
  const update = (sessionId: string): SessionStatusUpdate => ({
    sessionId,
    endedAt: "2026-11-09T04:49:57.000Z",
    done: ["Add clamp"],
    inFlight: [],
    blocked: [],
    next: [],
  });
  // A later session starts later: since run L3 (L3-github-6) a session's entry in docs/status.md
  // is named by its start, so two sessions are told apart by it, not by their ids.
  const session = (id: string, startedAt = "2026-11-09T04:12:00.000Z"): SessionRow =>
    ({ id, started_at: startedAt }) as SessionRow;
  const LATER = "2026-11-09T05:20:00.000Z";
  const headOf = async (bare: string, ref: string) =>
    (await run(["git", "--git-dir", bare, "rev-parse", ref])).stdout.trim();

  /** A second project of this install linked to the same repository. */
  async function secondProject(w: LoopWorld, name = "Second"): Promise<ProjectRow> {
    return w.store.project.insert({
      name,
      goal: "More work in the same repository",
      repos: ["o/sample"],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    });
  }

  it("w8-status-write (W8-write-5): an open status pull request on fr/status, another project's or an unmarked one an earlier version opened, is never written to, commented on or listed; every project's status stays in the app", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const a = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const b = await secondProject(w);
    // Two earlier versions' status pull requests, one at a time on fr/status: A's (marked), then
    // an unmarked one.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.createBranch(OLD_STATUS_BRANCH, "origin/main");
    await mkdir(join(root, "seed", "docs"), { recursive: true });
    writeFileSync(join(root, "seed", "docs", "status.md"), "# Status\n\nold\n");
    await seed.commitAll("docs: status after session s-0");
    await seed.push(OLD_STATUS_BRANCH, { defaultBranch: "main" });
    for (const body of [
      `Status update.\n\n<!-- forerunner:pr project=${a.id} -->`,
      "Status update of session s-0 (2026-11-01):\n\nOpened by Forerunner.",
    ]) {
      const pr = await host.createPullRequest(REPO, {
        title: "docs: project status",
        body,
        head: OLD_STATUS_BRANCH,
        base: "main",
      });
      const head0 = await headOf(bare, OLD_STATUS_BRANCH);
      for (const p of [a, b]) {
        const out = await docs.writeSessionStatus({
          project: p,
          session: session(`s-${p.name}`),
          update: update(`s-${p.name}`),
        });
        expect(out.location, p.name).toBe("app");
        expect(existsSync(join(docs.statusInAppDir(p.id), fromPosix(STATUS_DOC)))).toBe(true);
        expect(await docs.docsInPullRequests(p)).toEqual([]);
      }
      expect(await headOf(bare, OLD_STATUS_BRANCH)).toBe(head0);
      expect(await host.listPullRequestComments(REPO, pr.number)).toEqual([]);
      await host.updatePullRequest(REPO, pr.number, { state: "closed" });
    }
    await w.close();
  });

  it("the scaffold follows the same rule: a second project's scaffold never pushes to or comments on the first one's open scaffold pull request (W15-01)", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    const a = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const first = await docs.scaffoldProject(a);
    const [pr] = await host.listPullRequests(REPO, { state: "open", head: "fr/docs-scaffold" });
    expect(first.prUrl).toBe(pr?.htmlUrl);
    expect(pr?.body).toContain(`<!-- forerunner:pr project=${a.id} -->`);
    // No id in the text a person reads (W15-08).
    expect(pr?.body.replace(/<!--[\s\S]*?-->/g, "")).not.toContain(a.id);
    // The first project's scaffold PR lacks a doc the second one would add.
    const scaffold = new GitOps({ cwd: join(root, "scaffold"), identity });
    await scaffold.clone(bare);
    await scaffold.createBranch("fr/docs-scaffold", "origin/fr/docs-scaffold");
    await run(["git", "-C", join(root, "scaffold"), "rm", "-q", "docs/overview.md"]);
    await scaffold.commitAll("drop overview");
    await scaffold.push("fr/docs-scaffold", { defaultBranch: "main" });
    const head0 = await headOf(bare, "fr/docs-scaffold");
    const b = await secondProject(w);
    const second = await docs.scaffoldProject(b);
    expect(second.prUrl).toBeNull();
    expect(await headOf(bare, "fr/docs-scaffold")).toBe(head0);
    expect(await host.listPullRequestComments(REPO, pr?.number ?? 0)).toEqual([]);
    expect(await host.listPullRequests(REPO, { state: "open" })).toHaveLength(1);
    expect(await docs.docsInPullRequests(b)).toEqual([]);
    await w.close();
  }, 60_000);

  it("the app's status names the session by when it started, never by an id (W15-08)", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const a = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const id = "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e5f";
    const next = "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e60";
    await docs.writeSessionStatus({ project: a, session: session(id), update: update(id) });
    await docs.writeSessionStatus({
      project: a,
      session: session(next, LATER),
      update: update(next),
    });
    const text = await readFile(join(docs.statusInAppDir(a.id), fromPosix(STATUS_DOC)), "utf8");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).toContain("### Session started 2026-11-09 04:12 UTC\n");
    expect(text).toContain("### Session started 2026-11-09 05:20 UTC\n");
    await w.close();
  }, 60_000);

  it("the Docs tab reads every repository project's docs/status.md from the app, after a restart too (W15-01 fix-up, w8-status-write)", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const a = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const b = await secondProject(w);
    await docs.writeSessionStatus({ project: a, session: session("s-a"), update: update("s-a") });
    const fromB = await docs.writeSessionStatus({
      project: b,
      session: session("s-b"),
      update: { ...update("s-b"), done: ["Write B's notes"] },
    });
    expect(fromB.location).toBe("app");
    const appDir = docs.statusInAppDir(b.id);
    expect(docs.statusDocRoot(b)).toBe(appDir);
    expect(docs.statusDocRoot(a)).toBe(docs.statusInAppDir(a.id));
    expect(await readFile(join(appDir, fromPosix(STATUS_DOC)), "utf8")).toContain(
      "Write B's notes",
    );
    // The daemon starts again: what was kept is read the same way.
    const { docs: again } = await docsFor(w, root, bare);
    expect(again.statusDocRoot(b)).toBe(appDir);
    await w.close();
  });

  it("a project folder made before the line-endings pin gets core.autocrlf=false at its next session-end commit (W15-11)", async () => {
    const w = await loopWorld();
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const workspace = join(root, "projects", w.project, WORKSPACE_DIR);
    await mkdir(workspace, { recursive: true });
    // A folder an earlier version made: a plain init, the machine's line endings in force.
    await run(["git", "init", "-q", "-b", "main", workspace]);
    await run(["git", "-C", workspace, "config", "--local", "core.autocrlf", "true"]);
    const project = await w.store.project.mustGet(w.project);
    const out = await docs.writeSessionStatus({
      project,
      session: session("s-folder"),
      update: update("s-folder"),
    });
    expect(out.location).toBe("data_dir");
    const autocrlf = await run(["git", "-C", workspace, "config", "--local", "core.autocrlf"]);
    expect(autocrlf.stdout.trim()).toBe("false");
    await w.close();
  });
});

/**
 * l3-small, run L3 (live check 3, L3-github-6; W15-08): the status pull request's file still read
 * '### 2026-11-15 session 01a1ddbe-2b5e-7624-a194-e62a9e74accd' and '- Note: stop reason completed;
 * spent CHF 0.09' on GitHub, and the Docs tab showed the same. The session is named by when it
 * started, and how it ended is said in the words the Sessions list uses.
 */
describe("l3-small, run L3: the status file names the session by its start, in words (L3-github-6)", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

  it("the app's docs/status.md has no id: 'Session started <when> UTC' and 'Done. Spent CHF 0.24.'", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const { root, bare } = await bareRepo();
    const { host, docs } = await docsFor(w, root, bare);
    await w.addTask("Add clamp", { risk_tier: 1 });
    const result = await w.start(
      w.runner(prExecutor(w, root, bare, host, "fr/add-clamp"), { docs }),
    );
    const started = (await w.store.session.mustGet(result.sessionId)).started_at ?? "";
    const when = `${started.slice(0, 10)} ${started.slice(11, 16)} UTC`;
    const status = await readFile(
      join(docs.statusInAppDir(w.project), fromPosix(STATUS_DOC)),
      "utf8",
    );
    expect(status).toContain(`## Sessions\n\n### Session started ${when}\n`);
    expect(status).toContain("- Note: Done. Spent CHF 0.24.\n");
    expect(status).not.toContain(result.sessionId);
    expect(status).not.toMatch(UUID);
    expect(status).not.toContain("stop reason");
    // R11: the spend is never on GitHub.
    expect(await show(bare, OLD_STATUS_BRANCH, STATUS_DOC)).toBeNull();
    await w.close();
  }, 60_000);

  it("the copy the Docs tab reads says the same, and a session stopped by the person says so", async () => {
    const w = await loopWorld();
    const { root, bare } = await bareRepo();
    const { docs } = await docsFor(w, root, bare);
    const project = await w.store.project.patch(w.project, { repos: ["o/sample"] });
    const id = "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e5f";
    await docs.writeSessionStatus({
      project,
      session: { id, started_at: "2026-11-15T05:46:30.000Z" } as SessionRow,
      update: {
        sessionId: id,
        endedAt: "2026-11-15T05:59:00.000Z",
        done: ["Write the kite guide"],
        inFlight: [],
        blocked: [],
        next: [],
        note: "Stopped by you. Spent CHF 0.09.",
      },
    });
    const text = await readFile(
      join(docs.statusInAppDir(project.id), fromPosix(STATUS_DOC)),
      "utf8",
    );
    expect(text).toContain("### Session started 2026-11-15 05:46 UTC\n");
    expect(text).toContain("- Note: Stopped by you. Spent CHF 0.09.\n");
    expect(text).not.toMatch(UUID);
    await w.close();
  });
});

/**
 * l3-small fix-up, run L3 (L3-run-11, review): the commit Forerunner makes at the end of a
 * session in a project's folder (no repository) read 'Session 01a1df1c-82d0-..., 2026-11-15T12:09:
 * 15.298Z. Committed by Forerunner at the end of the session.' in its body: plain `git log` showed
 * an id and a raw instant on every session (bench review-l3-small, live check 3's rs3 home). The
 * session is named by when it started, as the status file and the status pull request name it.
 */
describe("l3-small, run L3: the session-end commit in the folder names the session by its start (L3-run-11)", () => {
  it("plain git log in the project's folder has no id and no raw instant after a session", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const folder = join(root, "projects", w.project, WORKSPACE_DIR);
    await docs.scaffoldProject(await w.store.project.mustGet(w.project));
    await w.addTask("Write 404.html", { risk_tier: 1 });
    const result = await w.start(w.runner(doneExecutor(w), { docs }));
    expect(result.completed).toHaveLength(1);
    const started = (await w.store.session.mustGet(result.sessionId)).started_at ?? "";
    const when = `${started.slice(0, 10)} ${started.slice(11, 16)} UTC`;
    const last = (await run(["git", "-C", folder, "log", "-n", "1", "--format=%B"])).stdout;
    expect(last.trim()).toBe(
      `Did "Write 404.html"\n\nCommitted by Forerunner at the end of the session started ${when}.`,
    );
    const all = (await run(["git", "-C", folder, "log", "--format=%B"])).stdout;
    expect(all).not.toContain(result.sessionId);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await w.close();
  });

  it("a session whose start is not known is 'a session', never its id", async () => {
    const w = await loopWorld();
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const folder = join(root, "projects", w.project, WORKSPACE_DIR);
    const project = await w.store.project.mustGet(w.project);
    const id = "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e5f";
    await docs.writeSessionStatus({
      project,
      session: { id, started_at: null, created_at: null } as unknown as SessionRow,
      update: {
        sessionId: id,
        endedAt: "2026-11-15T05:59:00.000Z",
        done: [],
        inFlight: [],
        blocked: [],
        next: [],
        note: "Done. Spent CHF 0.01.",
      },
    });
    const last = (await run(["git", "-C", folder, "log", "-n", "1", "--format=%B"])).stdout;
    expect(last.trim()).toBe(
      "Work of the session\n\nCommitted by Forerunner at the end of a session.",
    );
    expect(last).not.toContain(id);
    expect(last).not.toContain("2026-11-15T05:59");
    await w.close();
  });
});

describe("d1109-onerepo-link, run C: W15-01's ownership through the one index; a together project owns none of its id's docs pull requests (OR-10, OR-15)", () => {
  const A = "01a1a000-0000-7000-8000-0000000000a1";
  const B = "01a1a000-0000-7000-8000-0000000000b2";
  const marker = (id: string) => `<!-- forerunner:pr project=${id} -->`;
  const project = (over: Partial<ProjectRow> = {}): ProjectRow =>
    ({
      id: A,
      name: "Kite club",
      settings: {},
      summary_cache: {},
      repos: ["o/kite"],
      status: "active",
      ...over,
    }) as ProjectRow;

  it("a together project takes no docs pull request that names its id: the intake branch, the hidden mark, the L-16 line, an unmarked one", () => {
    const together = project({
      settings: { together: { name: "Kite club", at: "x" } },
    });
    const cases = [
      { head: { ref: `fr/intake-${A}-docs` }, body: "" },
      { head: { ref: "fr/docs-scaffold" }, body: `docs\n\n${marker(A)}` },
      { head: { ref: "fr/docs-scaffold" }, body: `docs\n\nForerunner project ${A}.` },
      { head: { ref: "fr/status" }, body: `status\n\n${marker(A)}` },
      { head: { ref: "fr/status" }, body: "an unmarked status pull request" },
    ];
    for (const pr of cases) {
      expect(isProjectDocsPr(together, pr), pr.head.ref).toBe(false);
      expect(docsPrListing(together, pr, { soleLinked: true }), pr.head.ref).toBeNull();
    }
    // w8-repo-guide (L4i-left-2): for any other project, what names it is its own.
    // w8-status-write (W8-write-5): a status pull request on fr/status is no project's docs pull
    // request any more, marked or not, and is never listed (the status board closes this
    // install's own; nothing is written to one).
    for (const pr of cases.slice(0, 3))
      expect(isProjectDocsPr(project(), pr), pr.head.ref).toBe(true);
    for (const pr of cases.slice(3)) {
      expect(isProjectDocsPr(project(), pr), pr.body).toBe(false);
      expect(docsPrListing(project(), pr, { soleLinked: true }), pr.body).toBeNull();
    }
  });

  it("w8-repo-guide (L4i-left-2): an unmarked scaffold pull request is this project's only by its record or its branch's own marker naming the project itself; a taken-over id does not count; with only `soleLinked` it is listed without being its own", () => {
    const unmarked = { head: { ref: "fr/docs-scaffold" }, body: "Notes by hand." };
    expect(isProjectDocsPr(project(), unmarked)).toBe(false);
    expect(isProjectDocsPr(project(), unmarked, { branchMarker: A })).toBe(true);
    expect(isProjectDocsPr(project(), unmarked, { branchMarker: A.toUpperCase() })).toBe(true);
    expect(isProjectDocsPr(project(), unmarked, { branchMarker: B })).toBe(false);
    const took = project({
      settings: { took_over: { projects: [B], name: "Kite club", at: "x" } },
    });
    expect(isProjectDocsPr(took, unmarked, { branchMarker: B })).toBe(false);
    const recorded = project({ summary_cache: { docs: { pr_url: "https://x/pull/3" } } as never });
    expect(isProjectDocsPr(recorded, { ...unmarked, htmlUrl: "https://x/pull/3" })).toBe(true);
    expect(docsPrListing(project(), unmarked, { soleLinked: true })).toBe("listed");
    expect(docsPrListing(project(), unmarked, { soleLinked: false })).toBeNull();
    // One that names another project is never listed, whatever `soleLinked` says.
    const other = { head: { ref: "fr/docs-scaffold" }, body: `docs\n\n${marker(B)}` };
    expect(docsPrListing(project(), other, { soleLinked: true })).toBeNull();
  });

  it("a project joined into another (joined_from) counts as the kept one: its marks and intake branch are the kept project's", () => {
    const kept = project({ settings: { joined_from: [B] } });
    expect(isProjectDocsPr(kept, { head: { ref: `fr/intake-${B}-docs` }, body: "" })).toBe(true);
    expect(
      isProjectDocsPr(kept, { head: { ref: "fr/docs-scaffold" }, body: `docs\n\n${marker(B)}` }),
    ).toBe(true);
    expect(
      isProjectDocsPr(project(), {
        head: { ref: "fr/docs-scaffold" },
        body: `docs\n\n${marker(B)}`,
      }),
    ).toBe(false);
  });

  it("an unmarked docs pull request is a project's only when it is the one project here using the repository and this computer's copy names no other project; a pair is neither's; a together project is never sole", async () => {
    const w = await loopWorld();
    try {
      const humanId = w.human;
      const one = await w.store.project.insert({
        name: "One",
        goal: "g",
        repos: ["https://github.com/O/Kite.git"],
        author_human: humanId,
      });
      const ref = { owner: "o", name: "kite" };
      expect(await ownsUnmarkedDocs(w.store, one, ref)).toBe(true);
      // This computer's copy's marker names a project that is not on this computer: neither's.
      const other = JSON.stringify({ schema: 1, project: B, name: "Kite club" });
      expect(await ownsUnmarkedDocs(w.store, one, ref, other)).toBe(false);
      // Its own marker, or one it took the repository over from, keeps it its own.
      expect(
        await ownsUnmarkedDocs(
          w.store,
          one,
          ref,
          JSON.stringify({ schema: 1, project: one.id, name: "One" }),
        ),
      ).toBe(true);
      const took = await w.store.project.update(one.id, one.version, {
        settings: { took_over: { projects: [B], name: "Kite club", at: "x" } },
        author_human: humanId,
      });
      expect(await ownsUnmarkedDocs(w.store, took, ref, other)).toBe(true);
      // A pair made before the rule: neither's (fails closed as before).
      const two = await w.store.project.insert({
        name: "Two",
        goal: "g",
        repos: ["o/kite"],
        author_human: humanId,
      });
      expect(await ownsUnmarkedDocs(w.store, took, ref)).toBe(false);
      expect(await ownsUnmarkedDocs(w.store, two, ref)).toBe(false);
      // A together project is never the one owner, alone or not.
      const alone = await w.store.project.insert({
        name: "Together",
        goal: "g",
        repos: ["o/alone"],
        settings: { together: { name: "Alone", at: "x" } },
        author_human: humanId,
      });
      expect(await ownsUnmarkedDocs(w.store, alone, { owner: "o", name: "alone" })).toBe(false);
    } finally {
      await w.close();
    }
  });
});

describe("l4-starts-carried, run L4", () => {
  // L4g-left-3 (fixup-l4-starts-sessions' bench walk B): the folder's docs/status.md said
  // "Spent CHF 0.00." for a session whose result said "Less than CHF 0.01." (W14-6: an amount
  // above zero never reads CHF 0.00; one money wording everywhere).
  it("L4g-left-3: the status note of a session that spent under a centime says 'less than CHF 0.01', never 'CHF 0.00'", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 91 }), closingReply()] });
    const { root } = await bareRepo();
    const { docs } = await docsFor(w, root, null);
    const task = await w.addTask("Add clamp", { risk_tier: 1 });
    // USD 0.003 is CHF 0.0024: under a centime, above zero.
    const result = await w.start(w.runner(doneExecutor(w, { costPerTask: 3_000 }), { docs }));
    expect(result.completed).toEqual([task.id]);
    const file = join(root, "projects", w.project, WORKSPACE_DIR, fromPosix(STATUS_DOC));
    const status = await readFile(file, "utf8");
    expect(status).toContain("- Note: Done. Spent less than CHF 0.01.\n");
    expect(status).not.toContain("CHF 0.00");
    await w.close();
  });
});
