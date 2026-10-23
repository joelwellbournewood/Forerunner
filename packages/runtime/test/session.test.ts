import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { renderStateBrief } from "../src/session/brief.ts";
import { runStartupChecklist } from "../src/session/checklist.ts";
import {
  cutPlanToBudget,
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { localParts, Scheduler } from "../src/session/triggers.ts";
import { isYes, StateApprovals } from "../src/wiring/state-ports.ts";

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  bob: string;
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
  const bob = (
    await store.agent.insert({
      name: "Bob",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  await store.project.patch(project, { settings: { members: [alice, bob] } as never });
  return { store, clock, human, alice, bob, project };
}

async function addTask(w: World, title: string, over: Record<string, unknown> = {}) {
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
    author_agent: w.bob,
    ...over,
  });
}

function fakeExecutor(
  w: World,
  costPerTask = 300_000,
  outcome: TaskExecutionResult["outcome"] = "done",
): TaskExecutor & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    async execute({ task, session, budget }) {
      executed.push(task.id);
      budget.record(`run-${task.id}`, costPerTask);
      await w.store.costLedger.record({
        human_id: w.human,
        agent_id: session.agent_id,
        project_id: w.project,
        session_id: session.id,
        task_id: task.id,
        run_id: `run-${task.id}`,
        billing_source_id: null,
        kind: "api",
        usd_micro: costPerTask,
        chf_micro: Math.round(costPerTask * 0.8),
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
        tokens_in: 100,
        tokens_out: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: w.clock.nowIso(),
      });
      return {
        outcome,
        summary: `${task.title}: ${outcome}`,
        costUsdMicro: costPerTask,
        checksPassed: outcome === "done",
        prUrl: `http://git.test/pr/${task.id.slice(0, 6)}`,
      };
    },
  };
}

function runner(w: World, executor: TaskExecutor, kill = new KillSwitch()) {
  const tokens = new TokenIssuer({ now: () => w.clock.now() });
  return {
    runner: new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens,
      kill,
      planner: new StaticPlanner(),
      executor,
    }),
    kill,
    tokens,
  };
}

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("startup checklist and state brief", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("collects inbox, requests, findings, budget, tasks and peers and stays under 2000 tokens", async () => {
    for (let i = 0; i < 120; i++) {
      await w.store.message.send({
        from_agent_id: w.bob,
        to_agent_id: w.alice,
        project_id: w.project,
        type: i % 3 ? "info" : "question",
        body: `Message ${i} ${"x".repeat(300)}`,
        requires_ack: i % 5 === 0,
        author_agent: w.bob,
      });
    }
    for (let i = 0; i < 30; i++) await addTask(w, `Task ${i}`);
    const held = await addTask(w, "Held by Bob");
    await w.store.task.claim(held.id, w.bob, 60 * 60 * 1000);
    await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.project,
      kind: "decision",
      why: "Pick a database",
      steps: [],
      options: ["postgres", "sqlite"],
      blocking: true,
      risk: "low",
    });
    const review = await w.store.review.insert({
      task_id: held.id,
      critic_model: "fake-opus",
      tier: 2,
      grade: 40,
      confidence: 0.9,
      verdict: "revise",
      evidence: [],
      summary: "needs work",
    });
    await w.store.finding.insert({
      review_id: review.id,
      task_id: held.id,
      severity: "high",
      description: "No tests",
      required_action: "Add tests",
      status: "open",
      fingerprint: "no-tests",
    });
    await w.store.costLedger.record({
      human_id: w.human,
      agent_id: w.alice,
      project_id: w.project,
      kind: "api",
      usd_micro: 12_000_000,
      chf_micro: 9_600_000,
      rate_chf_per_usd: 0.8,
      model: "fake-sonnet",
      tokens_in: 1,
      tokens_out: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      occurred_at: w.clock.nowIso(),
    });

    const brief = await runStartupChecklist({
      store: w.store,
      clock: w.clock,
      agentId: w.alice,
      projectId: w.project,
      appVersion: "0.1.0",
      sessionCapUsdMicro: 5_000_000,
    });
    expect(brief.inbox.unreadCount).toBe(120);
    expect(brief.humanRequests.openCount).toBe(1);
    expect(brief.findings.openCount).toBe(1);
    expect(brief.budget.monthSpentUsdMicro).toBe(12_000_000);
    expect(brief.tasks.readyCount).toBe(30);
    expect(brief.tasks.claimedByOthers).toHaveLength(1);
    expect(brief.peers[0]?.agentName).toBe("Bob");
    const text = renderStateBrief(brief);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(2000);
    expect(text).toContain("BLOCKING decision: Pick a database");
    expect(text).toContain("high on");
    expect(text).toContain("peer");
  });
});

describe("session runner", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("plans ready tasks, claims each, executes, closes tier 0 work, hands off and notifies", async () => {
    const t1 = await addTask(w, "First", { priority: 9 });
    const t2 = await addTask(w, "Second", { priority: 5 });
    const t3 = await addTask(w, "Third", { priority: 1, risk_tier: 1 });
    const exec = fakeExecutor(w);
    const { runner: r } = runner(w, exec);
    const events: string[] = [];
    const res = await r.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (t) => events.push(t),
    });
    expect(res.status).toBe("completed");
    expect(exec.executed).toEqual([t1.id, t2.id, t3.id]);
    expect(res.completed).toEqual([t1.id, t2.id]);
    expect(res.inReview).toEqual([t3.id]);
    expect((await w.store.task.mustGet(t1.id)).status).toBe("done");
    expect((await w.store.task.mustGet(t3.id)).status).toBe("in_review");
    expect((await w.store.task.mustGet(t1.id)).claimed_by).toBeNull();
    expect(res.spentUsdMicro).toBe(900_000);
    const session = await w.store.session.mustGet(res.sessionId);
    expect(session.status).toBe("completed");
    expect(session.summary).toContain("Done: 2");
    const handoffs = await w.store.message.list({ to_agent_id: w.bob, type: "handoff" } as never);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.requires_ack).toBe(true);
    const toHuman = await w.store.message.list({ to_human_id: w.human } as never);
    expect(toHuman).toHaveLength(1);
    expect((await w.store.project.mustGet(w.project)).summary_cache).toMatchObject({
      spend_usd_micro: 900_000,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        "session.started",
        "session.brief",
        "session.planned",
        "task.started",
        "task.finished",
        "session.ended",
      ]),
    );
    const log = await w.store.event.list(res.sessionId);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
  });

  it("skips tasks a peer claims first and messages the holder (collision)", async () => {
    const mine = await addTask(w, "Mine");
    const theirs = await addTask(w, "Theirs", { priority: 9 });
    const exec = fakeExecutor(w);
    const built = runner(w, exec);
    // Bob wins the claim between Alice's planning and her first claim attempt.
    const racing = new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens: built.tokens,
      kill: built.kill,
      executor: exec,
      planner: {
        async plan(ctx) {
          const plan = await new StaticPlanner().plan(ctx);
          await w.store.task.claim(theirs.id, w.bob, 60 * 60 * 1000);
          return plan;
        },
      },
    });
    const res = await racing.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "schedule",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(exec.executed).toEqual([mine.id]);
    expect(res.skipped).toEqual([theirs.id]);
    const msgs = await w.store.message.list({ to_agent_id: w.bob, type: "info" } as never);
    expect(msgs.some((m) => m.body.includes("you hold the claim"))).toBe(true);
  });

  it("cuts the plan to the work budget and stops starting new work at 80%", async () => {
    for (let i = 0; i < 10; i++) await addTask(w, `T${i}`, { est_cost_usd_micro: 400_000 });
    const exec = fakeExecutor(w, 400_000);
    // budget 2.0: work budget 1.6 -> 4 items planned; each costs 0.4 -> after 3 we are at 60%, after 4 at 80% (no new work anyway)
    const res = await runner(w, exec).runner.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant,
    });
    expect(res.plan?.items).toHaveLength(4);
    expect(res.plan?.summary).toContain("cut to fit");
    expect(exec.executed).toHaveLength(4);
    expect(res.status).toBe("completed");
  });

  it("stops cleanly with a handoff when the budget runs out mid-session", async () => {
    for (let i = 0; i < 5; i++) await addTask(w, `T${i}`, { est_cost_usd_micro: 100_000 });
    let n = 0;
    const exec: TaskExecutor = {
      async execute({ task, budget }) {
        n++;
        if (n === 2) return { outcome: "budget_exceeded", summary: "cap hit", costUsdMicro: 0 };
        budget.record(task.id, 100_000);
        return { outcome: "done", summary: "ok", costUsdMicro: 100_000, checksPassed: true };
      },
    };
    const res = await runner(w, exec).runner.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    expect(res.stopReason).toBe("budget_exceeded");
    expect(res.status).toBe("stopped");
    expect(res.completed).toHaveLength(1);
    expect(res.needsHuman).toHaveLength(1);
    expect(res.skipped).toHaveLength(3);
    expect(res.handoff).toMatchObject({ stop_reason: "budget_exceeded" });
    const tasks = await w.store.task.list({ project_id: w.project } as never);
    expect(tasks.every((t) => t.claimed_by === null)).toBe(true);
    expect((await w.store.session.mustGet(res.sessionId)).status).toBe("stopped");
  });

  it("is stopped by the kill switch mid-session and releases claims", async () => {
    for (let i = 0; i < 3; i++) await addTask(w, `T${i}`);
    const kill = new KillSwitch();
    let calls = 0;
    const exec: TaskExecutor = {
      async execute({ signal, task, budget }) {
        calls++;
        if (calls === 1) await kill.stop({ agentId: w.alice }, "test");
        if (signal.aborted) return { outcome: "killed", summary: "killed", costUsdMicro: 0 };
        budget.record(task.id, 1);
        return { outcome: "done", summary: "ok", costUsdMicro: 1, checksPassed: true };
      },
    };
    const res = await runner(w, exec, kill).runner.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    expect(res.status).toBe("killed");
    expect(calls).toBe(1);
    const tasks = await w.store.task.list({ project_id: w.project } as never);
    expect(tasks.every((t) => t.claimed_by === null)).toBe(true);
    // A new session cannot start while the agent is frozen.
    kill.resume();
  });

  it("advisor mode (autonomy 0) proposes the plan as a human request and runs nothing", async () => {
    await addTask(w, "T");
    const exec = fakeExecutor(w);
    const res = await runner(w, exec).runner.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      autonomy: 0,
      grant,
    });
    // The proposal is filed and the session ends (`stopped`, `plan_awaiting_approval`): it is
    // closed rather than left `paused`, so the approval can start the follow-up (ADR 0053).
    expect(res.status).toBe("stopped");
    expect(res.stopReason).toBe("plan_awaiting_approval");
    expect(exec.executed).toHaveLength(0);
    const reqs = await w.store.humanRequest.open({ humanId: w.human });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.steps[0]).toContain("T (coder");
    expect(await w.store.session.active(w.alice)).toEqual([]);
  });

  it("refuses a second concurrent session for the same agent and a 'stop' message ends work", async () => {
    await addTask(w, "A", { priority: 9 });
    await addTask(w, "B", { priority: 1 });
    const gate: { release: (() => void) | null } = { release: null };
    const exec: TaskExecutor = {
      async execute({ task, budget }) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        await w.store.message.send({
          from_agent_id: w.bob,
          to_agent_id: w.alice,
          type: "request",
          body: "stop please",
          requires_ack: false,
          author_agent: w.bob,
        });
        budget.record(task.id, 1);
        return { outcome: "done", summary: "ok", costUsdMicro: 1, checksPassed: true };
      },
    };
    const { runner: r } = runner(w, exec);
    const p = r.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    await new Promise((res) => setTimeout(res, 5));
    await expect(
      r.start({
        agentId: w.alice,
        projectId: w.project,
        trigger: "manual",
        budgetCapUsdMicro: 1,
        grant,
      }),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    gate.release?.();
    const res = await p;
    expect(res.stopReason).toBe("stopped_by_message");
    expect(res.completed).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
  });
});

describe("plan cutting and approvals", () => {
  it("cuts items from the end until the plan fits", () => {
    const plan = {
      items: [1, 2, 3].map((n) => ({
        taskId: `t${n}`,
        title: `t${n}`,
        specialist: "coder",
        estimateUsdMicro: 400_000,
      })),
      estimateUsdMicro: 1_200_000,
      summary: "s",
    };
    const cut = cutPlanToBudget(plan, 900_000);
    expect(cut.items.map((i) => i.taskId)).toEqual(["t1", "t2"]);
    expect(cut.estimateUsdMicro).toBe(800_000);
  });

  it("turns approvals into human requests and honours answers", async () => {
    const w = await world();
    const approvals = new StateApprovals(w.store);
    const sess = await w.store.session.insert({
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
    const req = {
      sessionId: sess.id,
      runId: "r1",
      agentId: w.alice,
      humanId: w.human,
      projectId: w.project,
      tool: "delete_repo",
      actionClass: "destructive",
      risk: "high" as const,
      why: "needs a human",
      input: { repo: "o/r" },
    };
    expect(await approvals.request(req)).toBe("pending");
    expect(await approvals.request(req)).toBe("pending");
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open).toHaveLength(1);
    await w.store.humanRequest.answer(open[0]!.id, open[0]!.version, "yes", w.human);
    expect(await approvals.request(req)).toBe("approved");
    expect(isYes("No")).toBe(false);
    expect(isYes({ choice: "approve" })).toBe(true);
    await w.store.close();
  });
});

describe("scheduler", () => {
  it("fires a daily schedule once per local day and never overlaps sessions per agent", async () => {
    const clock = new SimulatedClock("2026-03-02T04:30:00Z"); // 05:30 Zurich
    const started: string[] = [];
    const run: { resolve: (() => void) | null } = { resolve: null };
    const s = new Scheduler({
      clock,
      start: async (req) => {
        started.push(req.reason);
        await new Promise<void>((r) => {
          run.resolve = r;
        });
      },
    });
    s.add({
      id: "d",
      agentId: "alice",
      kind: "daily",
      time: "06:00",
      timezone: "Europe/Zurich",
      enabled: true,
    });
    await s.tick();
    expect(started).toHaveLength(0);
    await clock.advance(31 * 60_000); // 06:01 local
    await s.tick();
    expect(started).toEqual(["daily at 06:00 Europe/Zurich"]);
    await s.tick();
    expect(started).toHaveLength(1);
    // A message trigger while running is queued, then drained when the session ends.
    expect(await s.request({ agentId: "alice", trigger: "message", reason: "new message" })).toBe(
      "queued",
    );
    run.resolve?.();
    await new Promise((r) => setTimeout(r, 1));
    await s.tick();
    expect(started).toEqual(["daily at 06:00 Europe/Zurich", "new message"]);
    expect(localParts(new Date("2026-03-02T23:30:00Z").getTime(), "Europe/Zurich").hour).toBe(0);
  });

  it("defers non-manual triggers in quiet hours", async () => {
    const clock = new SimulatedClock("2026-03-02T22:00:00Z");
    const s = new Scheduler({ clock, start: async () => undefined, isQuietHours: () => true });
    expect(await s.request({ agentId: "a", trigger: "ci", reason: "ci" })).toBe("deferred");
    expect(await s.request({ agentId: "a", trigger: "manual", reason: "me" })).toBe("started");
  });
});

describe("claim renewal", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("renews the claim every sixth of its TTL for as long as the task runs, then stops", async () => {
    await addTask(w, "long task");
    let begun: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const exec: TaskExecutor = {
      async execute({ task }) {
        begun();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          outcome: "done",
          summary: `${task.title}: done`,
          costUsdMicro: 0,
          checksPassed: true,
        };
      },
    };
    let renewals = 0;
    const original = w.store.task.renewClaim.bind(w.store.task);
    w.store.task.renewClaim = async (...args: Parameters<typeof original>) => {
      renewals++;
      return original(...args);
    };
    const ttl = 6 * 60_000;
    const r = new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens: new TokenIssuer({ now: () => w.clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor: exec,
    });
    const run = r.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant,
      claimTtlMs: ttl,
    });
    await started;
    // Three renew intervals pass while the task is still running: three renewals, not one.
    await w.clock.advance((ttl / 6) * 3 + 1);
    expect(renewals).toBe(3);
    release();
    const res = await run;
    expect(res.status).toBe("completed");
    // Nothing fires once the task is over.
    await w.clock.advance(ttl * 2);
    expect(renewals).toBe(3);
  });
});
