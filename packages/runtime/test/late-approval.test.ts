import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import {
  type HumanRequestRow,
  openStore,
  type StateStore,
  type TaskRow,
  type TaskStatus,
} from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolSpec } from "../src/agent/tools.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { EnforcementHooks, type RunContext } from "../src/enforcement/hooks.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { AllowAllCaps, MemoryAudit, MemoryLedger, NoSecrets } from "../src/enforcement/ports.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { answerApplied, markAnswer } from "../src/session/answer-mark.ts";
import {
  isToolApprovalRequest,
  LATE_APPROVAL_AUDIT_TOOL,
  type LateStartPort,
  reportLateStartFailure,
  syncLateApprovals,
} from "../src/session/late-approval.ts";
import { reportingPlanStartFailures } from "../src/session/plan-approval.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { Scheduler, type StartRequest } from "../src/session/triggers.ts";
import { StateApprovals } from "../src/wiring/state-ports.ts";
import { deleteRepoTool } from "./helpers.ts";

/**
 * The follow-up half of ADR 0088: `syncLateApprovals`, run from `RuntimeApp.syncApprovals`
 * (the answer route, the commands, the poll, a session's end), turns a hooks approval
 * answered after its session ended into one `message` start for the task's project, with the
 * task back at `ready`; the follow-up's one matching call consumes the answer through
 * `StateApprovals` (the task-and-key lookup) and the task finishes without the human being
 * asked again. The card records the claim before the start (`markAnswer`, shared with the
 * cloud runner's inbox trigger) and the scheduler's answer after; a refused late answer runs
 * nothing, is consumed and the task records the refusal; an answer the session used itself,
 * a row whose session still runs, a task another session has in hand, another agent's row
 * and a row without a task are left alone; a task that moved on is recorded as such; a start
 * that fails is reported once.
 */
interface World {
  store: StateStore;
  clock: SimulatedClock;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  audit: MemoryAudit;
  human: string;
  alice: string;
  project: string;
}

/** Approval needed at level 2, free at level 3: not an always-human class. */
const mergeTool: ToolSpec<{ pr: number }> = {
  name: "merge_pr",
  description: "merge a reviewed pull request",
  schema: z.object({ pr: z.number().int() }),
  actionClass: "merge_pr",
  risk: "medium",
  async execute(input) {
    return { content: `merged #${input.pr}` };
  },
};

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-10-25T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill,
    clock,
    ledger: new MemoryLedger(),
    audit,
    approvals: new StateApprovals(store),
  });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const alice = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "Cleanup",
      goal: "Retire the old repositories",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [alice] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { store, clock, tokens, kill, hooks, audit, human, alice, project };
}

async function addTask(w: World, title: string, status: TaskStatus = "ready"): Promise<TaskRow> {
  return w.store.task.insert({
    project_id: w.project,
    title,
    outcome: `${title} done`,
    acceptance_criteria: ["works"],
    risk_tier: 0,
    status,
    priority: 5,
    depends_on: [],
    budget_usd_micro: 1_000_000,
    est_cost_usd_micro: 400_000,
    actual_cost_usd_micro: 0,
    attempt: 0,
    reason: "seed",
    author_agent: w.alice,
  });
}

const INPUT = { repo: "org/old-repo" };

/**
 * A task executor that makes one always-human call through the real hooks and the durable
 * port, as the loop driver does: pending ends the task `needs_human`, an admission runs it,
 * a denial fails it.
 */
function hooksExecutor(
  w: World,
  tool: ToolSpec = deleteRepoTool,
  input: unknown = INPUT,
): TaskExecutor & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    async execute({ task, token, budget }) {
      const runId = `run-${runs.length + 1}`;
      runs.push(runId);
      const child = w.tokens.derive(token, {
        runId,
        taskId: task.id,
        allowedTools: [tool.name],
        expiresAt: new Date(w.clock.now() + 600_000).toISOString(),
      });
      const ctx: RunContext = {
        token: child,
        budget,
        signal: new AbortController().signal,
        runDeadlineMs: w.clock.now() + 600_000,
        phase: "work",
        model: "fake-haiku",
        provider: "fake",
        billingSourceId: "bs",
        approvals: new Set(),
      };
      budget.record(runId, 1);
      let result: TaskExecutionResult;
      try {
        const decision = await w.hooks.beforeToolCall(ctx, tool, input);
        if (!decision.allowed) {
          result = { outcome: "needs_human", summary: decision.reason, costUsdMicro: 1 };
        } else {
          await w.hooks.afterToolCall(ctx, tool, input, { content: "done" });
          result = { outcome: "done", summary: "done", costUsdMicro: 1, checksPassed: true };
        }
      } catch (e) {
        if (!(e instanceof ForerunnerError && e.code === "approval_required")) throw e;
        result = { outcome: "failed", summary: `denied: ${e.message}`, costUsdMicro: 1 };
      }
      return result;
    },
  };
}

const grant = {
  allowedTools: ["delete_repo", "merge_pr"],
  allowedPaths: [],
  allowedDomains: [],
  grantedSecrets: [],
};

function runner(w: World, executor: TaskExecutor) {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: w.tokens,
    kill: w.kill,
    planner: new StaticPlanner(),
    executor,
  });
}

/** Runs a session of the project that pauses its one task on the call; returns the request. */
async function pauseOnCall(
  w: World,
  exec: TaskExecutor,
  task: TaskRow,
): Promise<{ sessionId: string; req: HumanRequestRow }> {
  const res = await runner(w, exec).start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 1_000_000,
    grant,
  });
  expect(res.needsHuman).toEqual([task.id]);
  expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
  const [req] = await w.store.humanRequest.open({ humanId: w.human });
  if (!req) throw new Error("the call filed no request");
  expect(req).toMatchObject({ session_id: res.sessionId, task_id: task.id, kind: "approval" });
  expect(isToolApprovalRequest(req)).toBe(true);
  // The session ended; the human answers afterwards.
  expect((await w.store.session.mustGet(res.sessionId)).ended_at).not.toBeNull();
  await w.clock.advance(60_000);
  return { sessionId: res.sessionId, req };
}

async function answer(w: World, req: HumanRequestRow, text: unknown): Promise<HumanRequestRow> {
  const current = await w.store.humanRequest.mustGet(req.id);
  const row = await w.store.humanRequest.answer(
    current.id,
    current.version,
    text as never,
    w.human,
  );
  await w.clock.advance(1_000);
  return row;
}

/** A start port that runs the follow-up through the real runner, like the daemon's scheduler. */
function runnerPort(w: World, exec: TaskExecutor) {
  const requests: StartRequest[] = [];
  const seen: Array<{ status: string; reason: string }> = [];
  let n = 0;
  return {
    requests,
    seen,
    start: async (req: StartRequest) => {
      requests.push(req);
      n++;
      // What the follow-up finds: the task back at `ready`, with the answer as its reason.
      const task = (await w.store.task.list({ project_id: w.project }))[0];
      if (task) seen.push({ status: task.status, reason: task.reason });
      await runner(w, exec).start({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: req.trigger,
        budgetCapUsdMicro: 1_000_000,
        grant,
      });
      return { id: `start-${n}`, result: "started" as const };
    },
  };
}

function card(r: HumanRequestRow): Record<string, unknown> {
  return (r.change_card ?? {}) as Record<string, unknown>;
}

async function auditRows(w: World) {
  return (await w.store.auditLog.list()).filter((r) => r.tool === LATE_APPROVAL_AUDIT_TOOL);
}

async function warnings(w: World, requestId: string) {
  return (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
    (m) => m.type === "warning" && m.body.includes(requestId),
  );
}

/** A run context of a session for a task, straight through the hooks (no runner). */
function ctxFor(w: World, runId: string, sessionId: string, taskId: string, tool = "delete_repo") {
  const ctx: RunContext = {
    token: w.tokens.issue({
      runId,
      sessionId,
      agentId: w.alice,
      ownerHumanId: w.human,
      projectId: w.project,
      taskId,
      allowedTools: [tool],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 2,
      planApproved: true,
      expiresAt: new Date(w.clock.now() + 3_600_000).toISOString(),
    }),
    budget: new SessionBudget({
      sessionId,
      budgetUsdMicro: 5_000_000,
      stepCap: 200,
      deadlineMs: w.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    signal: new AbortController().signal,
    runDeadlineMs: w.clock.now() + 600_000,
    phase: "work",
    model: "fake-haiku",
    provider: "fake",
    billingSourceId: "bs",
    approvals: new Set(),
  };
  return ctx;
}

async function runningSession(w: World): Promise<string> {
  const row = await w.store.session.insert({
    agent_id: w.alice,
    project_id: w.project,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 1,
    step_cap: 10,
    spent_usd_micro: 0,
    steps: 0,
    status: "planned",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  await w.store.session.start(row.id, row.version);
  return row.id;
}

async function endSession(w: World, id: string): Promise<void> {
  const row = await w.store.session.mustGet(id);
  await w.store.session.setStatus(row.id, row.version, "completed");
  await w.clock.advance(1_000);
}

describe("syncLateApprovals: a hooks approval answered after its session ended", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  function deps(start: LateStartPort) {
    return { store: w.store, clock: w.clock, humanId: w.human, agentId: w.alice, start };
  }

  it("a late yes becomes one message start; the task is ready again, the follow-up consumes the answer once and finishes it; a second sync starts nothing", async () => {
    const task = await addTask(w, "Delete the old repo");
    const exec = hooksExecutor(w);
    const { sessionId, req } = await pauseOnCall(w, exec, task);
    await answer(w, req, "yes");
    const port = runnerPort(w, exec);
    expect(await syncLateApprovals(deps(port.start))).toEqual({
      started: 1,
      refused: 0,
      skipped: 0,
    });
    expect(port.requests).toEqual([
      {
        agentId: w.alice,
        projectId: w.project,
        trigger: "message",
        reason: `approval answered (request ${req.id})`,
        approvalRequestId: req.id,
      },
    ]);
    // The follow-up found the task `ready`, with the answer as the reason of the move.
    expect(port.seen).toEqual([
      { status: "ready", reason: `approval answered (request ${req.id}): delete_repo` },
    ]);
    // ...and its re-made call took the answer: one execution, the task done, no new question.
    expect(exec.runs).toEqual(["run-1", "run-2"]);
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
    const executed = w.audit.entries.filter((e) => e.tool === "delete_repo" && e.allowed);
    expect(executed.map((e) => e.runId)).toEqual(["run-2"]);
    const applied = await w.store.humanRequest.mustGet(req.id);
    expect(card(applied)).toMatchObject({
      outcome: "started",
      start_id: "start-1",
      consumedByRun: "run-2",
    });
    expect(typeof card(applied).applied_at).toBe("string");
    expect(typeof card(applied).consumedAt).toBe("string");
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: sessionId,
      agent_id: w.alice,
      human_id: w.human,
      allowed: true,
    });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toEqual({
      requestId: req.id,
      taskId: task.id,
      tool: "delete_repo",
      actionClass: "destructive",
      answer: "yes",
    });
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toEqual({
      outcome: "started",
      startId: "start-1",
    });
    // Idempotent: the route, the poll and a restart find the answer acted on.
    expect(await syncLateApprovals(deps(port.start))).toEqual({
      started: 0,
      refused: 0,
      skipped: 0,
    });
    expect(port.requests).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("a refused late answer runs nothing and is consumed: the card says refused, the task stays needs_human and records it, and the task's next session is denied without a new question", async () => {
    const task = await addTask(w, "Delete the old repo");
    const exec = hooksExecutor(w);
    const { req } = await pauseOnCall(w, exec, task);
    await answer(w, req, "no");
    const port = runnerPort(w, exec);
    expect(await syncLateApprovals(deps(port.start))).toEqual({
      started: 0,
      refused: 1,
      skipped: 0,
    });
    expect(port.requests).toEqual([]);
    const refused = await w.store.task.mustGet(task.id);
    expect(refused.status).toBe("needs_human");
    expect(refused.reason).toBe(`human refused delete_repo (request ${req.id})`);
    expect(refused.author_human).toBe(w.human);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({ outcome: "refused" });
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.allowed).toBe(false);
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toEqual({
      outcome: "refused",
      taskStatus: "needs_human",
    });
    expect(await syncLateApprovals(deps(port.start))).toEqual({
      started: 0,
      refused: 0,
      skipped: 0,
    });
    // The human puts the task back; the next session's call is denied for the task.
    await w.store.task.transition(task.id, refused.version, "ready", "try again", {
      humanId: w.human,
    });
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    expect(res.failed).toEqual([task.id]);
    expect(await w.store.humanRequest.list({ kind: "approval" })).toHaveLength(1);
  });

  it("an answer the session used itself is not acted on; a row whose session still runs waits for it to end", async () => {
    const t1 = await addTask(w, "T1", "needs_human");
    const t2 = await addTask(w, "T2", "needs_human");
    // Session 1 pauses, the human answers while it runs, and it re-makes the call: used.
    const s1 = await runningSession(w);
    expect(
      (await w.hooks.beforeToolCall(ctxFor(w, "r1", s1, t1.id), deleteRepoTool, INPUT)).allowed,
    ).toBe(false);
    const [q1] = await w.store.humanRequest.open({ humanId: w.human });
    if (!q1) throw new Error("no question");
    await answer(w, q1, "yes");
    expect(
      (await w.hooks.beforeToolCall(ctxFor(w, "r1", s1, t1.id), deleteRepoTool, INPUT)).allowed,
    ).toBe(true);
    await endSession(w, s1);
    // Session 2 pauses on its call and is still running when the human answers.
    const s2 = await runningSession(w);
    expect(
      (await w.hooks.beforeToolCall(ctxFor(w, "r2", s2, t2.id), deleteRepoTool, INPUT)).allowed,
    ).toBe(false);
    const [q2] = await w.store.humanRequest.open({ humanId: w.human });
    if (!q2) throw new Error("no question");
    await answer(w, q2, "yes");
    const requests: StartRequest[] = [];
    const d = deps(async (req) => {
      requests.push(req);
      return { id: "start", result: "started" };
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(requests).toEqual([]);
    expect(answerApplied(await w.store.humanRequest.mustGet(q1.id))).toBe(false);
    expect(answerApplied(await w.store.humanRequest.mustGet(q2.id))).toBe(false);
    // Session 2 ends without re-making the call: the answer is late now.
    await endSession(w, s2);
    expect(await syncLateApprovals(d)).toEqual({ started: 1, refused: 0, skipped: 0 });
    expect(requests.map((r) => r.approvalRequestId)).toEqual([q2.id]);
    expect((await w.store.task.mustGet(t2.id)).status).toBe("ready");
    expect(answerApplied(await w.store.humanRequest.mustGet(q1.id))).toBe(false);
  });

  it("a yes to a class that is not always-human is late only when it came after the session ended", async () => {
    const t1 = await addTask(w, "T1", "needs_human");
    const t2 = await addTask(w, "T2", "needs_human");
    // Answered while session 1 ran (and used by it): the session's own business.
    const s1 = await runningSession(w);
    const c1 = ctxFor(w, "r1", s1, t1.id, "merge_pr");
    expect((await w.hooks.beforeToolCall(c1, mergeTool, { pr: 7 })).allowed).toBe(false);
    const [q1] = await w.store.humanRequest.open({ humanId: w.human });
    if (!q1) throw new Error("no question");
    await answer(w, q1, "yes");
    expect((await w.hooks.beforeToolCall(c1, mergeTool, { pr: 7 })).allowed).toBe(true);
    await endSession(w, s1);
    // Answered after session 2 ended: late.
    const s2 = await runningSession(w);
    expect(
      (await w.hooks.beforeToolCall(ctxFor(w, "r2", s2, t2.id, "merge_pr"), mergeTool, { pr: 8 }))
        .allowed,
    ).toBe(false);
    await endSession(w, s2);
    const [q2] = await w.store.humanRequest.open({ humanId: w.human });
    if (!q2) throw new Error("no question");
    await answer(w, q2, "yes");
    const requests: StartRequest[] = [];
    const d = deps(async (req) => {
      requests.push(req);
      return { id: "start", result: "started" };
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 1, refused: 0, skipped: 0 });
    expect(requests.map((r) => r.approvalRequestId)).toEqual([q2.id]);
    expect(answerApplied(await w.store.humanRequest.mustGet(q1.id))).toBe(false);
    expect(card(await w.store.humanRequest.mustGet(q2.id))).toMatchObject({ outcome: "started" });
  });

  it("a task that moved on is recorded task_moved_on; a task another session has in hand waits; another agent's row and a row without a task are left alone", async () => {
    const exec = hooksExecutor(w);
    const gone = await addTask(w, "Gone");
    const { req: goneReq } = await pauseOnCall(w, exec, gone);
    const current = await w.store.task.mustGet(gone.id);
    await w.store.task.transition(current.id, current.version, "cancelled", "dropped", {
      humanId: w.human,
    });
    await answer(w, goneReq, "yes");
    const requests: StartRequest[] = [];
    const d = deps(async (req) => {
      requests.push(req);
      return { id: "start", result: "started" };
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 1 });
    expect(card(await w.store.humanRequest.mustGet(goneReq.id))).toMatchObject({
      outcome: "task_moved_on",
    });
    expect((await auditRows(w)).map((r) => JSON.parse(r.result_summary ?? "{}"))).toEqual([
      { outcome: "task_moved_on", taskStatus: "cancelled" },
    ]);
    // In hand: `claimed` then `in_progress` by a later session; the port consumes the answer
    // there if the call is re-made, so nothing starts and nothing is marked.
    const busy = await addTask(w, "Busy", "needs_human");
    const s = await runningSession(w);
    expect(
      (await w.hooks.beforeToolCall(ctxFor(w, "r1", s, busy.id), deleteRepoTool, INPUT)).allowed,
    ).toBe(false);
    await endSession(w, s);
    const [busyReq] = await w.store.humanRequest.open({ humanId: w.human });
    if (!busyReq) throw new Error("no question");
    await answer(w, busyReq, "yes");
    let b = await w.store.task.mustGet(busy.id);
    b = await w.store.task.transition(b.id, b.version, "ready", "again", { humanId: w.human });
    b = await w.store.task.transition(b.id, b.version, "claimed", "taken", { agentId: w.alice });
    b = await w.store.task.transition(b.id, b.version, "in_progress", "running", {
      agentId: w.alice,
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(answerApplied(await w.store.humanRequest.mustGet(busyReq.id))).toBe(false);
    b = await w.store.task.transition(b.id, b.version, "needs_human", "paused again", {
      agentId: w.alice,
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 1, refused: 0, skipped: 0 });
    expect(requests.map((r) => r.approvalRequestId)).toEqual([busyReq.id]);
    // Another agent's row (a shared store) and a row that names no task.
    const bob = (
      await w.store.agent.insert({
        name: "Bob",
        owner_human_id: w.human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind: "principal",
      })
    ).id;
    const ended = await runningSession(w);
    await endSession(w, ended);
    const key = `delete_repo:${"0".repeat(64)}`;
    for (const over of [{ author_agent: bob, task_id: busy.id }, { author_agent: w.alice }]) {
      const row = await w.store.humanRequest.insert({
        human_id: w.human,
        project_id: w.project,
        session_id: ended,
        kind: "approval",
        why: "autonomy level 2 requires approval for destructive",
        steps: ["Tool: delete_repo", "Action class: destructive"],
        options: ["yes", "no"],
        blocking: true,
        risk: "high",
        change_card: { key, tool: "delete_repo", actionClass: "destructive", input: INPUT },
        ...over,
      });
      await answer(w, row, "yes");
    }
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(requests).toHaveLength(1);
    const untouched = (await w.store.humanRequest.list({ kind: "approval" })).filter(
      (r) => card(r).key === key,
    );
    expect(untouched.map((r) => answerApplied(r))).toEqual([false, false]);
  });

  it("a start the port throws on is start_failed with one warning; one that fails after the scheduler took it is reported once through reportingPlanStartFailures", async () => {
    const exec = hooksExecutor(w);
    const task = await addTask(w, "Delete the old repo");
    const { req } = await pauseOnCall(w, exec, task);
    await answer(w, req, "yes");
    let calls = 0;
    const d = deps(async () => {
      calls++;
      throw new Error("scheduler down");
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 1 });
    expect(calls).toBe(1);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "start_failed",
      error: "scheduler down",
    });
    expect(await warnings(w, req.id)).toHaveLength(1);
    expect((await warnings(w, req.id))[0]?.body).toContain("could not be started: scheduler down");
    // Not retried.
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(calls).toBe(1);
    // The task stays `ready` for the next session, which consumes the answer when it re-makes
    // the call.
    const left = await w.store.task.mustGet(task.id);
    expect(left.status).toBe("ready");
    await w.store.task.transition(left.id, left.version, "cancelled", "dropped", {
      humanId: w.human,
    });

    // A second task: the real scheduler takes the start and the session rejects behind it.
    const other = await addTask(w, "Delete another");
    const otherInput = { repo: "org/another" };
    const { req: req2 } = await pauseOnCall(w, hooksExecutor(w, deleteRepoTool, otherInput), other);
    await answer(w, req2, "yes");
    const report = { store: w.store, clock: w.clock, humanId: w.human, agentId: w.alice };
    const scheduler = new Scheduler({
      clock: w.clock,
      start: reportingPlanStartFailures(report, async () => {
        throw new ForerunnerError("claim_conflict", "a cloud session of the agent is active");
      }),
    });
    const d2 = deps((r) => scheduler.requestStart(r));
    expect(await syncLateApprovals(d2)).toEqual({ started: 1, refused: 0, skipped: 0 });
    const deadline = Date.now() + 5_000;
    while (card(await w.store.humanRequest.mustGet(req2.id)).outcome !== "start_failed") {
      if (Date.now() > deadline) throw new Error("start failure not reported");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(card(await w.store.humanRequest.mustGet(req2.id))).toMatchObject({
      outcome: "start_failed",
      error: "a cloud session of the agent is active",
    });
    expect(await warnings(w, req2.id)).toHaveLength(1);
    // A second report of the same start warns no further; the sync does not retry it.
    await reportLateStartFailure(report, req2.id, new Error("again"));
    expect(await warnings(w, req2.id)).toHaveLength(1);
    expect(await syncLateApprovals(d2)).toEqual({ started: 0, refused: 0, skipped: 0 });
    // The sync's "started" row and the background report's "start_failed" row land in either
    // order; both are there, once each, beside the first start's failure.
    expect(
      (await auditRows(w))
        .map((r) => `${r.allowed}:${JSON.parse(r.result_summary ?? "{}").outcome}`)
        .sort(),
    ).toEqual(["false:start_failed", "false:start_failed", "true:started"]);
  });

  it("the shared mark: a row the cloud runner's trigger claimed first starts nothing here", async () => {
    const exec = hooksExecutor(w);
    const task = await addTask(w, "Delete the old repo");
    const { req } = await pauseOnCall(w, exec, task);
    const answered = await answer(w, req, "yes");
    // The trigger's claim (the same conditional write), made between this sync's read and act.
    const claimed = await markAnswer(w.store, w.clock, answered, "starting");
    expect(claimed).not.toBeNull();
    const requests: StartRequest[] = [];
    const d = deps(async (r) => {
      requests.push(r);
      return { id: "start", result: "started" };
    });
    expect(await syncLateApprovals(d)).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(requests).toEqual([]);
    // And the other way round: a stale row the daemon claimed cannot be claimed again.
    expect(await markAnswer(w.store, w.clock, answered, "starting")).toBeNull();
  });
});
