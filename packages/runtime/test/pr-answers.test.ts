import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import { appDirs, join, run, SimulatedClock } from "@forerunner/platform";
import type { SessionRow, TaskRow } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type HumanRequestView, InboxView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { fileLeftOpenRequest, MERGE_LEFT_OPEN_KEY } from "../src/loop/merge.ts";
import type { TaskExecutor } from "../src/session/runner.ts";

/**
 * U-028: Inbox cards whose buttons did nothing. A rebase conflict the agent cannot resolve
 * asks "I resolved it" / "Drop the branch and retry from scratch" / "Cancel the task", and a
 * reviewed pull request the merge step left open asks "I merged it" / "Leave it open"; no
 * code read either answer. These tests make the conflict with real git (a local bare
 * repository as the host), open the Inbox, click the option the Inbox shows through the
 * daemon's answer route, and then run what consumes the answer: the task's next run.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const identity = { name: "Forerunner", email: "agent@example.test" };
const REPO = { owner: "o", name: "sample" };

interface World {
  home: string;
  stateUrl: string;
  clock: SimulatedClock;
  bare: string;
  root: string;
  host: MemoryGitHost;
  rt: RuntimeApp;
  req: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  session: SessionRow;
}

const opened: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of opened.splice(0)) await rt.close();
});

async function daemon(w: Pick<World, "home" | "stateUrl" | "clock">) {
  const dirs = appDirs({ env: { FORERUNNER_HOME: w.home } });
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: w.home },
    dirs,
    config: null,
    clock: w.clock,
    stateUrl: w.stateUrl,
    vault: new MemoryVault(),
    provider: new FakeProvider({ replies: [textReply("Noted.")], clock: w.clock, latency: "none" }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    startServices: false,
  });
  opened.push(rt);
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );
  return { rt, req };
}

async function world(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), "fr-u028-"));
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
  const { rt, req } = await daemon({ home, stateUrl, clock });
  const root = join(home, "git");
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  const host = new MemoryGitHost("alice");
  await host.createRepo({ owner: "o", name: "sample", private: true, cloneUrl: bare });
  const project = await rt.store.project.insert({
    name: "Sample",
    goal: "Ship the sample",
    repos: ["o/sample"],
    autonomy_level: 2,
    settings: { members: [rt.agent.id] },
  });
  const session = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: project.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 5_000_000,
    step_cap: 100,
    spent_usd_micro: 0,
    steps: 0,
    status: "running",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  return { home, stateUrl, clock, bare, root, host, rt, req, projectId: project.id, session };
}

/** The PR executor the daemon composes, over this world's store and host. */
function executor(w: World, inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor }) {
  return new PrTaskExecutor({
    store: w.rt.store,
    clock: w.clock,
    host: w.host,
    inner,
    repoFor: async () => ({ clone: w.bare, repo: REPO, base: "main" }),
    worktreeRoot: join(w.home, "worktrees"),
    identity,
  });
}

function ctxFor(w: World, task: TaskRow) {
  const token = w.rt.tokens.issue({
    runId: "r",
    sessionId: w.session.id,
    agentId: w.rt.agent.id,
    ownerHumanId: w.rt.human.id,
    projectId: w.projectId,
    allowedTools: [],
    allowedPaths: [],
    allowedDomains: [],
    grantedSecrets: [],
    budgetUsdMicro: 1_000_000,
    depth: 0,
    maxDepth: 2,
    autonomy: 2,
    planApproved: false,
    expiresAt: new Date(w.clock.now() + 3_600_000).toISOString(),
  });
  return {
    task,
    session: w.session,
    token,
    budget: new SessionBudget({
      sessionId: w.session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: w.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
    signal: new AbortController().signal,
  };
}

/** An inner executor writing README; `calls` counts its runs. */
function writer(content: string, before?: () => Promise<void>) {
  const calls = { n: 0 };
  const inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } = {
    async execute() {
      throw new Error("the inner executor runs in the worktree");
    },
    withWorktree(dir) {
      return {
        async execute() {
          calls.n++;
          await before?.();
          writeFileSync(join(dir, "README.md"), content);
          return { outcome: "done", summary: "edited", costUsdMicro: 1000, checksPassed: true };
        },
      };
    },
  };
  return { inner, calls };
}

/** Someone else changes README on main while the agent works. */
async function otherPush(w: World, content: string): Promise<void> {
  const dir = join(w.root, `other-${Math.random().toString(36).slice(2)}`);
  const other = new GitOps({ cwd: dir, identity });
  await other.clone(w.bare);
  writeFileSync(join(dir, "README.md"), content);
  await other.commitAll("other");
  await other.push("main");
}

/** A task run into a rebase conflict, moved to needs_human as the session runner does. */
async function conflicted(w: World): Promise<{ task: TaskRow; card: HumanRequestView }> {
  const task = await w.rt.store.task.insert({
    project_id: w.projectId,
    title: "Edit readme",
    outcome: "the readme says hello",
    acceptance_criteria: ["hello"],
    risk_tier: 1,
    status: "in_progress",
    budget_usd_micro: 1_000_000,
    reason: "seed",
    owner_agent_id: w.rt.agent.id,
  });
  const { inner } = writer("# sample\nby agent\n", () => otherPush(w, "# sample\nby other\n"));
  const res = await executor(w, inner).execute(ctxFor(w, task));
  expect(res.outcome).toBe("needs_human");
  const t = await w.rt.store.task.mustGet(task.id);
  await w.rt.store.task.transition(t.id, t.version, "needs_human", res.summary, {
    agentId: w.rt.agent.id,
  });
  const card = await shownFor(w, task.id);
  expect(card).toBeDefined();
  return { task: await w.rt.store.task.mustGet(task.id), card: card as HumanRequestView };
}

async function shownFor(w: World, taskId: string): Promise<HumanRequestView | undefined> {
  const inbox = InboxView.parse(await (await w.req("/inbox")).json());
  return inbox.requests.find((r) => r.taskId === taskId && r.status === "open");
}

async function click(w: World, card: HumanRequestView, option: string): Promise<void> {
  const r = await w.req(`/requests/${card.id}/answer`, {
    method: "POST",
    body: JSON.stringify({ version: card.version, answer: option }),
  });
  expect(r.status).toBe(200);
}

/** The session runner's claim of a ready task before its run. */
async function claimed(w: World, taskId: string): Promise<TaskRow> {
  let t = await w.rt.store.task.mustGet(taskId);
  expect(t.status).toBe("ready");
  t = await w.rt.store.task.transition(t.id, t.version, "claimed", "planned", {
    agentId: w.rt.agent.id,
  });
  return w.rt.store.task.transition(t.id, t.version, "in_progress", "started", {
    agentId: w.rt.agent.id,
  });
}

async function branchFile(w: World, branch: string): Promise<string> {
  const dir = join(w.root, `check-${w.clock.now()}-${Math.random().toString(36).slice(2)}`);
  const check = new GitOps({ cwd: dir, identity });
  await check.clone(w.bare, { branch });
  return readFileSync(join(dir, "README.md"), "utf8");
}

// Git subprocesses per test, as in pr-executor.test.ts: give loaded runners room.
describe("rebase conflict card: every option does what it says (U-028)", {
  timeout: 120_000,
}, () => {
  it("shows the three options and pushes the branch, so the person can resolve it", async () => {
    const w = await world();
    const { task, card } = await conflicted(w);
    expect(card.options).toEqual([
      "I resolved it",
      "Drop the branch and retry from scratch",
      "Cancel the task",
    ]);
    expect(card.blocking).toBe(true);
    expect(card.why).toContain("README.md");
    expect(card.steps.join(" ")).toContain(task.branch ?? "?");
    // The person can fetch the branch the steps name.
    expect(await branchFile(w, task.branch ?? "")).toBe("# sample\nby agent\n");
  });

  it('"I resolved it": the task is ready, and after a restart its next run opens the PR from the person\'s branch without redoing the work', async () => {
    const w = await world();
    const { task, card } = await conflicted(w);
    const branch = task.branch ?? "";
    // The person resolves the conflict on the branch the steps name and pushes it.
    const mine = join(w.root, "person");
    const person = new GitOps({ cwd: mine, identity });
    await person.clone(w.bare, { branch });
    // The same conflict the agent hit (git exits non-zero and leaves the markers).
    await expect(
      run(
        ["git", "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`].concat([
          "merge",
          "origin/main",
        ]),
        { cwd: mine },
      ),
    ).rejects.toThrow(/merge origin\/main/);
    writeFileSync(join(mine, "README.md"), "# sample\nby other\nby agent\n");
    await person.commitAll("resolve the readme conflict");
    await person.push(branch);

    await click(w, card, card.options[0] as string);
    const ready = await w.rt.store.task.mustGet(task.id);
    expect(ready.status).toBe("ready");
    expect(ready.reason).toContain("resolved the rebase conflict");
    expect(await shownFor(w, task.id)).toBeUndefined();

    // The answer survives a restart: it lives on the request, not in this process.
    await w.rt.close();
    opened.splice(0);
    const again = await daemon(w);
    w.rt = again.rt;
    w.req = again.req;

    const { inner, calls } = writer("never written");
    const res = await executor(w, inner).execute(ctxFor(w, await claimed(w, task.id)));
    expect(res.outcome).toBe("in_review");
    expect(calls.n).toBe(0);
    expect(res.costUsdMicro).toBe(0);
    expect(res.prUrl).toContain("/pull/1");
    const prs = await w.host.listPullRequests(REPO);
    expect(prs.map((p) => p.head.ref)).toEqual([branch]);
    expect(await branchFile(w, branch)).toBe("# sample\nby other\nby agent\n");

    // Used once: a later run of the task starts normally.
    const row = await w.rt.store.humanRequest.mustGet(card.id);
    expect(row.change_card).toMatchObject({ outcome: "resolved" });
    expect((row.change_card as { consumed_at?: string }).consumed_at).toBeTruthy();
  });

  it('"I resolved it" while the branch still conflicts: the next run checks it and asks again, the work is not redone', async () => {
    const w = await world();
    const { task, card } = await conflicted(w);
    await click(w, card, card.options[0] as string);
    const { inner, calls } = writer("never written");
    const res = await executor(w, inner).execute(ctxFor(w, await claimed(w, task.id)));
    expect(res.outcome).toBe("needs_human");
    expect(calls.n).toBe(0);
    const t = await w.rt.store.task.mustGet(task.id);
    await w.rt.store.task.transition(t.id, t.version, "needs_human", res.summary, {
      agentId: w.rt.agent.id,
    });
    const second = await shownFor(w, task.id);
    expect(second?.id).not.toBe(card.id);
    expect(second?.why).toContain("still conflicts");
    expect(second?.options).toEqual(card.options);
    expect(await w.host.listPullRequests(REPO)).toHaveLength(0);
  });

  it('"Drop the branch and retry from scratch": the task is ready and its next run redoes it from the current base, replacing the branch', async () => {
    const w = await world();
    const { task, card } = await conflicted(w);
    const branch = task.branch ?? "";
    await click(w, card, card.options[1] as string);
    const ready = await w.rt.store.task.mustGet(task.id);
    expect(ready.status).toBe("ready");
    expect(ready.reason).toContain("dropped");

    const { inner, calls } = writer("# sample\nby other\nredone by agent\n");
    const res = await executor(w, inner).execute(ctxFor(w, await claimed(w, task.id)));
    expect(calls.n).toBe(1);
    expect(res.outcome).toBe("in_review");
    expect(await w.host.listPullRequests(REPO)).toHaveLength(1);
    // The old conflicting commit is gone from the branch: it starts at the current main.
    expect(await branchFile(w, branch)).toBe("# sample\nby other\nredone by agent\n");
    const check = new GitOps({ cwd: join(w.root, "log"), identity });
    await check.clone(w.bare, { branch });
    expect((await check.log(5)).map((c) => c.subject)).toEqual(["Edit readme", "other", "seed"]);
  });

  it('"Cancel the task": the task is cancelled and the card leaves the Inbox', async () => {
    const w = await world();
    const { task, card } = await conflicted(w);
    await click(w, card, card.options[2] as string);
    const t = await w.rt.store.task.mustGet(task.id);
    expect(t.status).toBe("cancelled");
    expect(t.reason).toContain("cancelled");
    expect(await shownFor(w, task.id)).toBeUndefined();
  });
});

describe('merge left open: "I merged it" and "Leave it open" (U-028)', () => {
  async function doneTask(w: { rt: RuntimeApp }, projectId: string): Promise<TaskRow> {
    const t = await w.rt.store.task.insert({
      project_id: projectId,
      title: "Add feature",
      outcome: "feature exists",
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      budget_usd_micro: 1_000_000,
      reason: "PR left open for you: check ci/test failed",
      pr_url: "https://github.example/o/sample/pull/7",
      owner_agent_id: w.rt.agent.id,
    });
    return t;
  }

  it('"I merged it" records the merge on the task; "Leave it open" records the choice', async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u028-merge-"));
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const d = await daemon({ home, stateUrl: "sqlite::memory:", clock });
    const project = await d.rt.store.project.insert({ name: "Sample", goal: "g" });
    const w = { rt: d.rt, req: d.req } as unknown as World;
    // The request exactly as the merge step filed it before this fix (no card), so cards
    // already in an Inbox work too.
    for (const [option, expected] of [
      ["I merged it", /^merged by you: https:\/\/github\.example\/o\/sample\/pull\/7/],
      ["Leave it open", /^left open by you: https:\/\/github\.example\/o\/sample\/pull\/7/],
    ] as const) {
      const task = await doneTask(d, project.id);
      await d.rt.store.humanRequest.insert({
        human_id: d.rt.human.id,
        project_id: project.id,
        task_id: task.id,
        session_id: null,
        kind: "decision",
        why: `The critic accepted "Add feature", but its pull request ${task.pr_url} was not merged: check ci/test failed.`,
        steps: ["Open the failed check on the pull request", "Fix it or merge it yourself"],
        options: ["I merged it", "Leave it open"],
        blocking: false,
        risk: "medium",
        author_agent: d.rt.agent.id,
      });
      const card = (await shownFor(w, task.id)) as HumanRequestView;
      const index = card.options.indexOf(option);
      expect(index).toBeGreaterThanOrEqual(0);
      await click(w, card, card.options[index] as string);
      const after = await d.rt.store.task.mustGet(task.id);
      expect(after.status).toBe("done");
      expect(after.reason).toMatch(expected);
      expect(await shownFor(w, task.id)).toBeUndefined();
      // Applied once: another sync leaves it as it is.
      await d.rt.syncApprovals();
      expect((await d.rt.store.task.mustGet(task.id)).version).toBe(after.version);
    }
  });

  it("the card the merge step files now carries its key; its options lead to the same outcomes", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u028-merge-card-"));
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const d = await daemon({ home, stateUrl: "sqlite::memory:", clock });
    const project = await d.rt.store.project.insert({ name: "Sample", goal: "g" });
    const w = { rt: d.rt, req: d.req } as unknown as World;
    const task = await doneTask(d, project.id);
    const filed = await fileLeftOpenRequest(d.rt.store, {
      task,
      sessionId: null,
      humanId: d.rt.human.id,
      agentId: d.rt.agent.id,
      outcome: {
        taskId: task.id,
        prUrl: task.pr_url ?? "",
        status: "checks_failed",
        reason: "PR left open for you: check ci/test failed",
        failedChecks: ["ci/test"],
      },
    });
    expect(filed.change_card).toMatchObject({ key: MERGE_LEFT_OPEN_KEY, task_id: task.id });
    const card = (await shownFor(w, task.id)) as HumanRequestView;
    expect(card.options).toEqual(["I merged it", "Leave it open"]);
    await click(w, card, card.options[0] as string);
    expect((await d.rt.store.task.mustGet(task.id)).reason).toMatch(/^merged by you: /);
    expect((await d.rt.store.humanRequest.mustGet(card.id)).change_card).toMatchObject({
      outcome: "merged",
    });
  });
});
