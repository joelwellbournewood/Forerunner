import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { AutoApprove } from "../src/enforcement/ports.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { approvedPlanIdOf, planIdOf } from "../src/session/plan-approval.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { budget, harness, issue, writeTool } from "./helpers.ts";

/**
 * Release close-out for J.7 (docs/requirements.md): "Level 1 Assisted: acts after approval of
 * each plan." Two layers, both in code: the session runner files the plan as a blocking
 * approval request and runs nothing until it is approved; the enforcement hooks hold even a
 * routine reversible tool call behind approval while the plan is not approved.
 *
 * This is the "does not act before approval" half. The "acts after approval of each plan"
 * half (ADR 0053): the plan request's card carries the plan's identity (`plan_id`,
 * `plan:<session>#<sha256 of the task ids in order>`), the filing session ends `stopped`
 * with `plan_awaiting_approval` so it never blocks the follow-up, and a start carrying that
 * identity as `planApproved` runs the plan only while it is the plan the human saw; a plan
 * that changed since is asked again and never run. The last describe block covers that half;
 * the daemon and cloud paths that produce such a start are `plan-approval.test.ts`,
 * `plan-approval-daemon.test.ts` and the cloud runner's `inbox-trigger.test.ts`.
 */
interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
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
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  await store.project.patch(project, { settings: { members: [alice] } as never });
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
    async execute({ task, budget: b }) {
      executed.push(task.id);
      b.record(`run-${task.id}`, 1);
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

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("J.7 Assisted (autonomy 1): the session runner acts only after the plan is approved", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("without an approved plan: the plan is filed as a blocking approval request and nothing runs", async () => {
    await addTask(w, "T1");
    const exec = fakeExecutor();
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      grant,
    });
    // The filing session is closed, not left `paused` (which `session.active` counts as
    // active and would refuse every later start of the agent with claim_conflict).
    expect(res.status).toBe("stopped");
    expect(exec.executed).toEqual([]);
    const reqs = await w.store.humanRequest.open({ humanId: w.human });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      kind: "approval",
      blocking: true,
      options: ["approve", "reject"],
      project_id: w.project,
      session_id: res.sessionId,
    });
    expect(reqs[0]?.why).toMatch(/^Assisted mode: approve this session plan before work starts/);
    expect(reqs[0]?.steps[0]).toContain("T1 (coder");
    expect((reqs[0]?.change_card as { key?: string } | null)?.key).toBe(`plan:${res.sessionId}`);
    // The card names the plan the human is approving: the session and the task ids in order.
    expect(approvedPlanIdOf(reqs[0] as never)).toBe(planIdOf(res.sessionId, res.plan?.items ?? []));
    expect(res.stopReason).toBe("plan_awaiting_approval");
    const session = await w.store.session.mustGet(res.sessionId);
    expect(session.status).toBe("stopped");
    expect(session.ended_at).not.toBeNull();
    expect((session.handoff as { stop_reason?: string }).stop_reason).toBe(
      "plan_awaiting_approval",
    );
    expect(session.summary).toContain("awaits your approval");
    expect(await w.store.session.active(w.alice)).toEqual([]);
  });

  it("with the plan approved: the same session runs its tasks and files no request", async () => {
    await addTask(w, "T1");
    const exec = fakeExecutor();
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: true,
      grant,
    });
    expect(res.status).not.toBe("paused");
    expect(exec.executed).toHaveLength(1);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
  });

  it("the project's own level is the default: a project at autonomy 1 pauses for approval when the call names no level", async () => {
    await addTask(w, "T1");
    const exec = fakeExecutor();
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    expect(res.status).toBe("stopped");
    expect(res.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toEqual([]);
  });
});

describe("J.7 Assisted (autonomy 1): the enforcement hooks hold tools until the plan is approved", () => {
  function ctx(h: ReturnType<typeof harness>, token: ReturnType<typeof issue>): RunContext {
    return {
      token,
      budget: budget("sess-1", 5_000_000, h.clock),
      signal: new AbortController().signal,
      runDeadlineMs: h.clock.now() + 60_000,
      phase: "work",
      model: "fake-haiku",
      provider: "fake",
      billingSourceId: "bs-1",
      approvals: new Set(),
    };
  }

  it("a routine reversible tool call is held behind approval while the plan is not approved, and runs free once it is", async () => {
    const root = join(process.cwd(), "wt");
    const pendingPort = new AutoApprove("pending");
    const pending = harness({ approvals: pendingPort });
    const held = await pending.hooks.beforeToolCall(
      ctx(
        pending,
        issue(pending, {
          allowedTools: ["write_file"],
          allowedPaths: [root],
          autonomy: 1,
          planApproved: false,
        }),
      ),
      writeTool,
      { path: join(root, "a"), text: "x" },
    );
    expect(held.allowed).toBe(false);
    expect(pendingPort.requests).toHaveLength(1);
    expect(pendingPort.requests[0]).toMatchObject({
      tool: "write_file",
      actionClass: "routine_reversible",
    });
    expect(pending.audit.entries.at(-1)?.allowed).toBe(false);
    expect(pending.audit.entries.at(-1)?.deniedReason).toContain("approval_required");

    const approvedPort = new AutoApprove("pending");
    const approvedPlan = harness({ approvals: approvedPort });
    const free = await approvedPlan.hooks.beforeToolCall(
      ctx(
        approvedPlan,
        issue(approvedPlan, {
          allowedTools: ["write_file"],
          allowedPaths: [root],
          autonomy: 1,
          planApproved: true,
        }),
      ),
      writeTool,
      { path: join(root, "a"), text: "x" },
    );
    expect(free.allowed).toBe(true);
    expect(approvedPort.requests).toHaveLength(0);
  });
});

describe("J.7 Assisted (autonomy 1): acting after the approval of each plan (ADR 0053)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  /** Files the plan request of a session at the level and answers it "approve" in the inbox. */
  async function fileAndApprovePlan(exec: ReturnType<typeof fakeExecutor>, autonomy: 0 | 1 = 1) {
    const first = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      autonomy,
      grant,
    });
    expect(first.status).toBe("stopped");
    expect(first.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toEqual([]);
    const [req] = await w.store.humanRequest.open({ humanId: w.human });
    if (!req) throw new Error("the plan request was not filed");
    expect((req.change_card as { key?: string } | null)?.key).toBe(`plan:${first.sessionId}`);
    const planId = approvedPlanIdOf(req);
    if (!planId) throw new Error("the plan request carries no plan id");
    const answered = await w.store.humanRequest.answer(req.id, req.version, "approve", w.human);
    expect(answered.status).toBe("answered");
    return { first, req, planId };
  }

  it("once the plan is approved in the inbox, a start carrying the approved plan's id runs it", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { first, planId } = await fileAndApprovePlan(exec);
    // What the daemon's `syncPlanApprovals` and the cloud runner's inbox trigger do with the
    // "approve" answer: a "message" start bound to the plan the human saw.
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: planId,
      grant,
    });
    expect(second.status).toBe("completed");
    expect(second.stopReason).toBe("completed");
    expect(exec.executed).toEqual([t1.id]);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
    // The session that filed the plan was closed when it filed, never left `paused`.
    const filed = await w.store.session.mustGet(first.sessionId);
    expect(filed.status).toBe("stopped");
    const events = await w.store.event.list(second.sessionId);
    expect(events.map((e) => e.type)).toContain("session.plan_approved");
    const approved = events.find((e) => e.type === "session.plan_approved");
    expect(approved?.payload).toMatchObject({ planId, approvedSessionId: first.sessionId });
  });

  it("planApproved is bound to the approved plan: a task added after the approval is asked again, not run on it", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { first, planId } = await fileAndApprovePlan(exec);
    const t2 = await addTask(w, "T2");
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: planId,
      grant,
    });
    // The plan the session computes now (T1, T2) is not the one the human approved (T1):
    // nothing runs, not even the approved task, and the changed plan goes back to the inbox.
    expect(second.status).toBe("stopped");
    expect(second.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toEqual([]);
    const reasked = await w.store.humanRequest.open({ humanId: w.human });
    expect(reasked).toHaveLength(1);
    expect(reasked[0]?.session_id).toBe(second.sessionId);
    expect(reasked[0]?.why).toContain("changed since the plan you approved");
    expect(reasked[0]?.steps.join("\n")).toContain("T1 (coder");
    expect(reasked[0]?.steps.join("\n")).toContain("T2 (coder");
    const newPlanId = approvedPlanIdOf(reasked[0] as never);
    expect(newPlanId).toBe(planIdOf(second.sessionId, second.plan?.items ?? []));
    expect(newPlanId).not.toBe(planId);
    expect(newPlanId).not.toContain(first.sessionId);
    const events = await w.store.event.list(second.sessionId);
    expect(events.find((e) => e.type === "session.plan_filed")?.payload).toMatchObject({
      changed: true,
      approvedPlanId: planId,
    });
    // Approving the new plan runs both.
    const [req] = reasked;
    if (!req) throw new Error("no request");
    await w.store.humanRequest.answer(req.id, req.version, "approve", w.human);
    const third = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: newPlanId ?? undefined,
      grant,
    });
    expect(third.status).toBe("completed");
    expect(exec.executed).toEqual([t1.id, t2.id]);
  });

  it("a removed task changes the plan too, and a forged or stale id (another hash) approves nothing", async () => {
    await addTask(w, "T1");
    const t2 = await addTask(w, "T2");
    const exec = fakeExecutor();
    const { planId } = await fileAndApprovePlan(exec);
    // The human cancelled T2 after approving [T1, T2]: the plan now is [T1], not the approved one.
    await w.store.task.transition(t2.id, t2.version, "cancelled", "not needed", {
      humanId: w.human,
    });
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: planId,
      grant,
    });
    expect(second.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toEqual([]);
    // A forged or stale id (a hash of no plan the human saw) approves nothing either. The
    // session part is not checked: the hash names the approved task ids (plan-approval.test.ts).
    const forged = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: `plan:other#${"0".repeat(64)}`,
      grant,
    });
    expect(forged.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toEqual([]);
  });

  it("a start bound to an approved plan whose tasks were done meanwhile files no request and runs nothing", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { planId } = await fileAndApprovePlan(exec);
    const first = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: planId,
      grant,
    });
    expect(first.status).toBe("completed");
    expect(exec.executed).toEqual([t1.id]);
    // A second start bound to the same plan (another runner, an overlapping sync): T1 is done,
    // the plan is empty, and there is nothing for the human to approve.
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: planId,
      grant,
    });
    expect(second.status).toBe("completed");
    expect(second.stopReason).toBe("completed");
    expect(second.summary).toContain("Nothing to plan");
    expect(exec.executed).toEqual([t1.id]);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
    const types = (await w.store.event.list(second.sessionId)).map((e) => e.type);
    expect(types).toContain("session.planned");
    expect(types).not.toContain("session.plan_filed");
  });

  it("an unapproved level 1 session with no ready task files no empty plan request", async () => {
    const exec = fakeExecutor();
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "schedule",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      grant,
    });
    expect(res.status).toBe("completed");
    expect(res.stopReason).toBe("completed");
    expect(exec.executed).toEqual([]);
    expect(await w.store.humanRequest.list({ session_id: res.sessionId })).toEqual([]);
  });

  it("J.6 Advisor (autonomy 0): the plan is a proposal, and an approved proposal runs as the follow-up session", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { req, planId } = await fileAndApprovePlan(exec, 0);
    expect(req.why).toMatch(/^Advisor mode: the plan is a proposal; approve to run it/);
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 0,
      planApproved: planId,
      grant,
    });
    expect(second.status).toBe("completed");
    expect(exec.executed).toEqual([t1.id]);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
  });
});
