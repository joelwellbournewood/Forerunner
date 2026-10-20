import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { AutoApprove } from "../src/enforcement/ports.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
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
 * half is open (BLOCKERS.md, row "J.6 / J.7 plan approval starts nothing"): the last describe
 * block reproduces the gap and is marked `it.fails`, the repository's convention for a finding
 * on the current code (see `security-*.test.ts`). When the runtime starts the approved plan
 * from the inbox answer those tests turn red ("expected test to fail"), which is the signal to
 * drop the marker and close J.7.
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
    expect(res.status).toBe("paused");
    expect(exec.executed).toEqual([]);
    const reqs = await w.store.humanRequest.open({ humanId: w.human });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      kind: "approval",
      blocking: true,
      options: ["approve", "reject"],
      project_id: w.project,
    });
    expect(reqs[0]?.why).toMatch(/^Assisted mode: approve this session plan before work starts/);
    expect(reqs[0]?.steps[0]).toContain("T1 (coder");
    expect((reqs[0]?.change_card as { key?: string } | null)?.key).toMatch(/^plan:/);
    expect(res.stopReason).toBe("plan_awaiting_approval");
    const session = await w.store.session.mustGet(res.sessionId);
    expect((session.handoff as { stop_reason?: string }).stop_reason).toBe(
      "plan_awaiting_approval",
    );
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
    expect(res.status).toBe("paused");
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

describe("J.7 Assisted (autonomy 1): acting after the approval, the open half (`it.fails` = finding)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  /** Files the plan request of an autonomy-1 session and answers it "approve" in the inbox. */
  async function fileAndApprovePlan(exec: ReturnType<typeof fakeExecutor>) {
    const first = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      grant,
    });
    expect(first.status).toBe("paused");
    expect(exec.executed).toEqual([]);
    const [req] = await w.store.humanRequest.open({ humanId: w.human });
    if (!req) throw new Error("the plan request was not filed");
    expect((req.change_card as { key?: string } | null)?.key).toBe(`plan:${first.sessionId}`);
    const answered = await w.store.humanRequest.answer(req.id, req.version, "approve", w.human);
    expect(answered.status).toBe("answered");
    return { first, req };
  }

  it.fails("finding: once the plan is approved in the inbox, a start carrying planApproved runs it (today the paused session blocks every later start with claim_conflict)", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { first } = await fileAndApprovePlan(exec);
    // What the cloud runner's inbox trigger does with the "approve" answer
    // (services/cloud-runner/src/inbox-trigger.ts); the desktop daemon has no such path at all.
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: true,
      grant,
    });
    expect(second.status).toBe("completed");
    expect(exec.executed).toEqual([t1.id]);
    // The session that filed the plan is closed, not left `paused` (which `session.active`
    // counts as active) for a human to kill.
    const filed = await w.store.session.mustGet(first.sessionId);
    expect(["stopped", "completed"]).toContain(filed.status);
  });

  it.fails("finding: planApproved is bound to the approved plan; a task added after the approval is asked again, not run on it (today it runs)", async () => {
    const t1 = await addTask(w, "T1");
    const exec = fakeExecutor();
    const { first } = await fileAndApprovePlan(exec);
    // The only way out today: the human closes the paused session by hand.
    const filed = await w.store.session.mustGet(first.sessionId);
    await w.store.session.setStatus(filed.id, filed.version, "stopped");
    const t2 = await addTask(w, "T2");
    const second = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "message",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 1,
      planApproved: true,
      grant,
    });
    expect(second.status).not.toBe("failed");
    expect(exec.executed).toContain(t1.id);
    // Either the unapproved task did not run, or the changed plan went back to the inbox.
    const reasked = await w.store.humanRequest.open({ humanId: w.human });
    const ranUnapproved = exec.executed.includes(t2.id) && reasked.length === 0;
    expect(ranUnapproved).toBe(false);
  });
});
