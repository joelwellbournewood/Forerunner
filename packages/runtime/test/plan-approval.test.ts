import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { type HumanRequestRow, openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  approvedPlanIdOf,
  markPlanAnswer,
  PLAN_APPROVAL_AUDIT_TOOL,
  parsePlanId,
  planAnswer,
  planApprovalOf,
  planHash,
  planIdOf,
  planKeyOf,
  reportingPlanStartFailures,
  reportPlanStartFailure,
  syncPlanApprovals,
} from "../src/session/plan-approval.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { Scheduler, type StartRequest } from "../src/session/triggers.ts";

/**
 * The daemon's half of J.7 "acts after approval of each plan" (ADR 0053): `syncPlanApprovals`,
 * run from `RuntimeApp.syncApprovals` (the answer route and the approvals poll), turns an
 * answered plan request into one start bound to the approved plan's id, records it on the
 * request's card and in the audit log, and does nothing twice. A rejected plan starts
 * nothing and the tasks stay; a card without a plan id, an answer outside the options and a
 * start the scheduler refuses are recorded as such.
 */
interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-10-23T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 1,
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
      name: "Assisted",
      goal: "Ship a sample service under assisted autonomy",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 1,
      summary_cache: {},
      data_assets: [],
      settings: { members: [alice] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { store, clock, human, alice, project };
}

async function addTask(w: World, title: string) {
  return w.store.task.insert({
    project_id: w.project,
    title,
    outcome: `${title} done`,
    acceptance_criteria: ["works"],
    risk_tier: 0,
    status: "ready",
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

function fakeExecutor(): TaskExecutor & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    async execute({ task, budget }) {
      executed.push(task.id);
      budget.record(`run-${task.id}`, 1);
      const result: TaskExecutionResult = {
        outcome: "done",
        summary: `${task.title}: done`,
        costUsdMicro: 1,
        checksPassed: true,
      };
      return result;
    },
  };
}

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

function runner(w: World, executor: TaskExecutor) {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor,
  });
}

/** A fake scheduler port: records the requests, answers "started" with a fresh id. */
function startPort(answer: "started" | "queued" | "deferred" = "started") {
  const requests: StartRequest[] = [];
  let n = 0;
  return {
    requests,
    start: async (req: StartRequest) => {
      requests.push(req);
      n++;
      return { id: `start-${n}`, result: answer };
    },
  };
}

/** Runs a level 1 session that files its plan; returns the open plan request. */
async function filePlan(
  w: World,
  exec = fakeExecutor(),
  budgetCapUsdMicro = 1_000_000,
): Promise<HumanRequestRow> {
  const res = await runner(w, exec).start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro,
    grant,
  });
  expect(res.stopReason).toBe("plan_awaiting_approval");
  const [req] = await w.store.humanRequest.list({ session_id: res.sessionId });
  if (!req) throw new Error("no plan request");
  return req;
}

async function answer(w: World, req: HumanRequestRow, text: unknown) {
  const current = await w.store.humanRequest.mustGet(req.id);
  return w.store.humanRequest.answer(current.id, current.version, text as never, w.human);
}

function card(r: HumanRequestRow): Record<string, unknown> {
  return (r.change_card ?? {}) as Record<string, unknown>;
}

async function auditRows(w: World) {
  return (await w.store.auditLog.list()).filter((r) => r.tool === PLAN_APPROVAL_AUDIT_TOOL);
}

async function settle(until: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the plan's identity", () => {
  it("is the session plus the hash of the task ids in order; the card and the start carry it", () => {
    const items = [{ taskId: "t1" }, { taskId: "t2" }];
    const id = planIdOf("s1", items);
    expect(id).toBe(`plan:s1#${planHash(items)}`);
    expect(planKeyOf("s1")).toBe("plan:s1");
    expect(parsePlanId(id)).toEqual({ sessionId: "s1", hash: planHash(items) });
    expect(parsePlanId("plan:s1")).toBeNull();
    expect(parsePlanId("plan:s1#nothex")).toBeNull();
    // Order and membership both count; the specialist and the estimate do not.
    expect(planHash([{ taskId: "t2" }, { taskId: "t1" }])).not.toBe(planHash(items));
    expect(planHash([{ taskId: "t1" }])).not.toBe(planHash(items));
    expect(planHash([{ taskId: "t1", specialist: "x", estimateUsdMicro: 9 } as never])).toBe(
      planHash([{ taskId: "t1" }]),
    );
    expect(planApprovalOf(id, items)).toBe("approved");
    expect(planApprovalOf(id, [{ taskId: "t1" }])).toBe("changed");
    expect(planApprovalOf(planIdOf("other", items), items)).toBe("approved");
    expect(planApprovalOf("garbage", items)).toBe("changed");
    expect(planApprovalOf(true, [])).toBe("approved");
    expect(planApprovalOf(false, items)).toBe("none");
    expect(planApprovalOf(undefined, items)).toBe("none");
  });

  it("reads the card and the answer shapes the inbox, the phone and the web send", () => {
    const row = { change_card: { key: "plan:s1", plan_id: planIdOf("s1", []) } };
    expect(approvedPlanIdOf(row)).toBe(planIdOf("s1", []));
    expect(approvedPlanIdOf({ change_card: { key: "plan:s1" } })).toBeNull();
    expect(approvedPlanIdOf({ change_card: { key: "findings:blocked", plan_id: "x" } })).toBeNull();
    expect(approvedPlanIdOf({ change_card: null })).toBeNull();
    expect(planAnswer("approve")).toBe("approve");
    expect(planAnswer(" Approved ")).toBe("approve");
    expect(planAnswer({ option: "approve" })).toBe("approve");
    expect(planAnswer({ choice: "reject" })).toBe("reject");
    expect(planAnswer({ answer: "no" })).toBe("reject");
    expect(planAnswer("maybe later")).toBeNull();
    expect(planAnswer(null)).toBeNull();
    expect(planAnswer(["approve"])).toBeNull();
  });
});

describe("syncPlanApprovals", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("an approved plan becomes one start bound to its id, recorded on the card and audited; a second sync starts nothing", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    const planId = approvedPlanIdOf(req);
    expect(planId).toBe(planIdOf(req.session_id ?? "", (card(req).plan as { items: [] }).items));
    await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    expect(port.requests).toEqual([
      {
        agentId: w.alice,
        projectId: w.project,
        trigger: "message",
        reason: `plan approved (request ${req.id})`,
        planApproved: planId,
        // The cap of the session that filed the plan: the follow-up cuts it as the human saw.
        budgetUsdMicro: 1_000_000,
      },
    ]);
    const applied = await w.store.humanRequest.mustGet(req.id);
    expect(card(applied)).toMatchObject({
      key: `plan:${req.session_id}`,
      plan_id: planId,
      outcome: "started",
      start_id: "start-1",
      applied_at: w.clock.nowIso(),
    });
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: req.session_id,
      agent_id: w.alice,
      human_id: w.human,
      allowed: true,
    });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toEqual({
      requestId: req.id,
      planId,
      answer: "approve",
    });
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toEqual({
      outcome: "started",
      startId: "start-1",
    });
    // Idempotent: the poll, the route and a restart all find the request acted on.
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(port.requests).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("a queued or deferred start counts as handed over, with the scheduler's answer on the card", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "approve");
    const port = startPort("queued");
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "queued",
      start_id: "start-1",
    });
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(port.requests).toHaveLength(1);
  });

  it("a rejected plan starts nothing; the tasks stay ready for the next session to propose again", async () => {
    const t1 = await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "reject");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 1, skipped: 0 });
    expect(port.requests).toEqual([]);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({ outcome: "rejected" });
    expect((await w.store.task.mustGet(t1.id)).status).toBe("ready");
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.allowed).toBe(false);
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(await auditRows(w)).toHaveLength(1);
    // The next session proposes the plan again rather than running it.
    const exec = fakeExecutor();
    const again = await filePlan(w, exec);
    expect(exec.executed).toEqual([]);
    expect(again.id).not.toBe(req.id);
  });

  it("an answer outside the options is recorded and starts nothing", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "later, maybe");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 1 });
    expect(port.requests).toEqual([]);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "unrecognized_answer",
    });
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
  });

  it("a plan request without the plan's id (an earlier build's card) is never run as approved", async () => {
    await addTask(w, "T1");
    const session = await w.store.session.insert({
      agent_id: w.alice,
      project_id: w.project,
      trigger: "manual",
      status: "stopped",
    });
    const req = await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.project,
      session_id: session.id,
      kind: "approval",
      why: "Assisted mode: approve this session plan before work starts.",
      steps: ["T1 (coder, ~$0.40)"],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      change_card: { key: `plan:${session.id}`, plan: { items: [] } },
      author_agent: w.alice,
    });
    await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 1 });
    expect(port.requests).toEqual([]);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "unbound_plan",
    });
    expect((await auditRows(w))[0]?.allowed).toBe(false);
  });

  it("a start the scheduler refuses is recorded once, the human is warned, and the request is not retried", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "approve");
    let calls = 0;
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: async () => {
        calls++;
        throw new Error("scheduler down");
      },
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 1 });
    expect(calls).toBe(1);
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "start_failed",
      error: "scheduler down",
    });
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.allowed).toBe(false);
    const warnings = (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
      (m) => m.type === "warning" && m.body.includes(req.id),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("could not be started: scheduler down");
    // At most one start per answered request, even when that start failed.
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(calls).toBe(1);
  });

  it("a start that fails in the background (claim_conflict) marks the card start_failed and warns the human once", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "approve");
    const report = { store: w.store, clock: w.clock, humanId: w.human, agentId: w.alice };
    // The real scheduler: `requestStart` answers "started" and the rejection lands in its log.
    const scheduler = new Scheduler({
      clock: w.clock,
      start: reportingPlanStartFailures(report, async () => {
        throw new ForerunnerError("claim_conflict", "a cloud session of the agent is active");
      }),
    });
    const deps = { ...report, start: (r: StartRequest) => scheduler.requestStart(r) };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    await settle(async () => scheduler.log.some((e) => e.result === "error"));
    await settle(
      async () => card(await w.store.humanRequest.mustGet(req.id)).outcome === "start_failed",
    );
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "start_failed",
      error: "a cloud session of the agent is active",
    });
    const warnings = (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
      (m) => m.type === "warning" && m.body.includes(req.id),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("could not be started");
    expect((await auditRows(w)).map((r) => r.allowed)).toEqual([true, false]);
    // Not retried, and a second report of the same start warns no further.
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    await reportPlanStartFailure(report, approvedPlanIdOf(req) ?? "", new Error("again"));
    expect(
      (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
        (m) => m.type === "warning",
      ),
    ).toHaveLength(1);
  });

  // w5-review-findings review: the cloud runner's inbox trigger writes `start_failed` itself
  // when its scheduler answers "failed"; the background report that follows must still warn.
  it("a card a producer already marked start_failed without a warning is still reported once", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    const answered = await answer(w, req, "approve");
    const claimed = await markPlanAnswer(w.store, w.clock, answered, "starting");
    if (!claimed) throw new Error("not claimed");
    expect(await markPlanAnswer(w.store, w.clock, claimed, "start_failed")).not.toBeNull();
    const report = { store: w.store, clock: w.clock, humanId: w.human, agentId: w.alice };
    const planId = approvedPlanIdOf(req) ?? "";
    await reportPlanStartFailure(report, planId, new Error("presence check failed"));
    await reportPlanStartFailure(report, planId, new Error("again"));
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "start_failed",
      error: "presence check failed",
    });
    const warnings = (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
      (m) => m.type === "warning" && m.body.includes(req.id),
    );
    expect(warnings).toHaveLength(1);
  });

  it("two approved plans of the same tasks in one sync: the newest starts, the older is superseded", async () => {
    await addTask(w, "T1");
    const older = await filePlan(w);
    w.clock.advance(60_000);
    const newer = await filePlan(w);
    expect(newer.id).not.toBe(older.id);
    await answer(w, older, "approve");
    await answer(w, newer, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 1 });
    expect(port.requests.map((r) => r.planApproved)).toEqual([approvedPlanIdOf(newer)]);
    expect(card(await w.store.humanRequest.mustGet(newer.id))).toMatchObject({
      outcome: "started",
    });
    expect(card(await w.store.humanRequest.mustGet(older.id))).toMatchObject({
      outcome: "superseded",
      superseded_by: newer.id,
    });
    const audit = await auditRows(w);
    expect(audit.map((r) => JSON.parse(r.result_summary ?? "{}").outcome).sort()).toEqual([
      "started",
      "superseded",
    ]);
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
  });

  it("two overlapping syncs of one approved plan make one start", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    const [a, b] = await Promise.all([syncPlanApprovals(deps), syncPlanApprovals(deps)]);
    expect((a?.started ?? 0) + (b?.started ?? 0)).toBe(1);
    expect(port.requests).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("a card another producer marked (the cloud runner's inbox trigger) is left alone", async () => {
    await addTask(w, "T1");
    const req = await filePlan(w);
    const answered = await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    // The cloud runner claimed the answer after this sync read it: the claim wins.
    const stale = answered;
    expect(await markPlanAnswer(w.store, w.clock, answered, "started")).not.toBeNull();
    expect(await markPlanAnswer(w.store, w.clock, stale, "starting")).toBeNull();
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(port.requests).toEqual([]);
    expect(card(await w.store.humanRequest.mustGet(req.id)).outcome).toBe("started");
  });

  it("a row that fails is logged and left for the next sync; the other rows still act", async () => {
    await addTask(w, "T1");
    const first = await filePlan(w);
    w.clock.advance(60_000);
    const second = await filePlan(w);
    await answer(w, first, "reject");
    await answer(w, second, "approve");
    const port = startPort();
    const update = w.store.humanRequest.update.bind(w.store.humanRequest);
    let failed = 0;
    w.store.humanRequest.update = (async (...args: Parameters<typeof update>) => {
      if (args[0] === second.id && failed === 0) {
        failed++;
        throw new Error("database is locked");
      }
      return update(...args);
    }) as typeof update;
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 1, skipped: 0 });
    expect(card(await w.store.humanRequest.mustGet(second.id)).applied_at).toBeUndefined();
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    expect(port.requests.map((r) => r.planApproved)).toEqual([approvedPlanIdOf(second)]);
  });

  it("the follow-up plans under the cap the human saw: a plan cut to one task runs that task and files nothing", async () => {
    const t1 = await addTask(w, "T1");
    const t2 = await addTask(w, "T2");
    const exec = fakeExecutor();
    // 600k cap, 20 % reserve: 480k of work fits one 400k task; the project's 1M fits both.
    const req = await filePlan(w, exec, 600_000);
    expect((card(req).plan as { items: unknown[] }).items).toHaveLength(1);
    await answer(w, req, "approve");
    const sessions = runner(w, exec);
    const scheduler = new Scheduler({
      clock: w.clock,
      start: (r) =>
        sessions.start({
          agentId: r.agentId,
          projectId: r.projectId,
          trigger: r.trigger,
          // What the daemon's start does: the request's cap, else the project's.
          budgetCapUsdMicro: r.budgetUsdMicro ?? 1_000_000,
          ...(r.planApproved ? { planApproved: r.planApproved } : {}),
          grant,
        }),
    });
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: (r: StartRequest) => scheduler.requestStart(r),
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    await settle(async () => (await w.store.task.mustGet(t1.id)).status === "done");
    await settle(async () => !scheduler.isActive(w.alice));
    expect(exec.executed).toEqual([t1.id]);
    expect((await w.store.task.mustGet(t2.id)).status).toBe("ready");
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
  });

  it("another agent's plan request on a shared store is left to its own daemon", async () => {
    await addTask(w, "T1");
    const bob = await w.store.agent.insert({
      name: "Bob",
      owner_human_id: w.human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    const session = await w.store.session.insert({
      agent_id: bob.id,
      project_id: w.project,
      trigger: "manual",
      status: "stopped",
    });
    const req = await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.project,
      session_id: session.id,
      kind: "approval",
      why: "Assisted mode: approve this session plan before work starts.",
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      change_card: { key: `plan:${session.id}`, plan_id: planIdOf(session.id, []), plan: {} },
      author_agent: bob.id,
    });
    await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(port.requests).toEqual([]);
    expect(card(await w.store.humanRequest.mustGet(req.id)).applied_at).toBeUndefined();
  });

  it("a filing session an earlier build left `paused` is closed before the start, so the start is not refused", async () => {
    await addTask(w, "T1");
    let session = await w.store.session.insert({
      agent_id: w.alice,
      project_id: w.project,
      trigger: "manual",
    });
    session = await w.store.session.start(session.id, session.version);
    session = await w.store.session.setStatus(session.id, session.version, "paused", {
      handoff: { stop_reason: "plan_awaiting_approval" },
    });
    expect(await w.store.session.active(w.alice)).toHaveLength(1);
    const req = await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.project,
      session_id: session.id,
      kind: "approval",
      why: "Assisted mode: approve this session plan before work starts.",
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      change_card: {
        key: `plan:${session.id}`,
        plan_id: planIdOf(session.id, [{ taskId: "t" }]),
        plan: {},
      },
      author_agent: w.alice,
    });
    await answer(w, req, "approve");
    const port = startPort();
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: port.start,
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    expect((await w.store.session.mustGet(session.id)).status).toBe("stopped");
    expect(await w.store.session.active(w.alice)).toEqual([]);
    expect(port.requests).toHaveLength(1);
  });

  it("through the real scheduler and runner: the approved plan runs once, with the plan approved in the token, and two syncs make one session", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const req = await filePlan(w, exec);
    const planId = approvedPlanIdOf(req);
    await answer(w, req, "approve");
    const sessions = runner(w, exec);
    const scheduler = new Scheduler({
      clock: w.clock,
      start: (r) =>
        sessions.start({
          agentId: r.agentId,
          projectId: r.projectId,
          trigger: r.trigger,
          budgetCapUsdMicro: 1_000_000,
          ...(r.planApproved ? { planApproved: r.planApproved } : {}),
          grant,
        }),
    });
    const deps = {
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      agentId: w.alice,
      start: (r: StartRequest) => scheduler.requestStart(r),
    };
    expect(await syncPlanApprovals(deps)).toEqual({ started: 1, rejected: 0, skipped: 0 });
    expect(await syncPlanApprovals(deps)).toEqual({ started: 0, rejected: 0, skipped: 0 });
    await settle(async () => (await w.store.task.mustGet(t1.id)).status === "done");
    await settle(async () => !scheduler.isActive(w.alice));
    expect(exec.executed).toEqual([t1.id]);
    const rows = await w.store.session.list({ agent_id: w.alice }, { orderBy: "created_at" });
    expect(rows.map((s) => [s.trigger, s.status])).toEqual([
      ["manual", "stopped"],
      ["message", "completed"],
    ]);
    const follow = rows[1];
    const events = await w.store.event.list(follow?.id ?? "");
    expect(events.find((e) => e.type === "session.plan_approved")?.payload).toMatchObject({
      planId,
      approvedSessionId: req.session_id,
      items: 1,
    });
    expect(card(await w.store.humanRequest.mustGet(req.id))).toMatchObject({
      outcome: "started",
      start_id: scheduler.log[0]?.id,
    });
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
  });
});
