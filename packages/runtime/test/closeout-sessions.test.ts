import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSummary } from "../src/daemon/views.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { pauseMessageBody, sessionPausePorts } from "../src/wiring/session-ports.ts";

/**
 * Requirements close-out for the session runner (spec A.6, C.1, C.6, C.7, D.17, E.4, F.7): the
 * clauses the existing suites exercise only in passing, asserted one by one against the real
 * `SessionRunner` on an in-memory store with a fake executor and the simulated clock.
 */

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  bob: string;
  project: string;
}

const CHF_PER_USD = 0.8;
const COST_PER_TASK = 300_000;

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
  const principal = (name: string) =>
    store.agent.insert({
      name,
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
  const alice = (await principal("Alice")).id;
  const bob = (await principal("Bob")).id;
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
      settings: { members: [alice, bob] },
      small_project_mode: false,
      active: true,
    })
  ).id;
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

interface Seen {
  title: string;
  specialist: string;
  depth: number;
  maxDepth: number;
}

/**
 * An executor that answers per task title (default `done`), records the cost of every task in
 * the ledger, and runs an optional hook before answering (to send a message mid-task).
 */
function executorByTitle(
  w: World,
  outcomes: Record<string, Partial<TaskExecutionResult>> = {},
  before: (title: string) => Promise<void> = async () => undefined,
): TaskExecutor & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    async execute({ task, session, budget, item, token }) {
      seen.push({
        title: task.title,
        specialist: item.specialist,
        depth: token.claims.depth,
        maxDepth: token.claims.maxDepth,
      });
      await before(task.title);
      budget.record(`run-${task.id}`, COST_PER_TASK);
      await w.store.costLedger.record({
        human_id: w.human,
        agent_id: session.agent_id,
        project_id: w.project,
        session_id: session.id,
        task_id: task.id,
        run_id: `run-${task.id}`,
        billing_source_id: null,
        kind: "api",
        usd_micro: COST_PER_TASK,
        chf_micro: Math.round(COST_PER_TASK * CHF_PER_USD),
        rate_chf_per_usd: CHF_PER_USD,
        model: "fake-sonnet",
        tokens_in: 100,
        tokens_out: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: w.clock.nowIso(),
      });
      const over = outcomes[task.title] ?? {};
      const outcome = over.outcome ?? "done";
      return {
        outcome,
        summary: over.summary ?? `${task.title}: ${outcome}`,
        costUsdMicro: COST_PER_TASK,
        checksPassed: outcome === "done",
        ...over,
      };
    },
  };
}

function runnerFor(w: World, executor: TaskExecutor): SessionRunner {
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

function stopFrom(w: World) {
  return w.store.message.send({
    from_agent_id: w.bob,
    to_agent_id: w.alice,
    type: "request",
    body: "stop please, I need the branch",
    requires_ack: false,
    author_agent: w.bob,
  });
}

/**
 * Seven tasks in priority order: one closes (tier 0), one goes to review (tier 1), one needs
 * the human and sends a "stop" while it runs, so the last four are never started.
 */
async function mixedSession(w: World) {
  const done = await addTask(w, "Done", { priority: 9 });
  const review = await addTask(w, "Review", { priority: 8, risk_tier: 1 });
  const ask = await addTask(w, "Ask", { priority: 7 });
  const rest = [];
  for (const [i, title] of ["Four", "Five", "Six", "Seven"].entries()) {
    rest.push(await addTask(w, title, { priority: 6 - i }));
  }
  const exec = executorByTitle(w, { Ask: { outcome: "needs_human" } }, async (title) => {
    if (title === "Ask") await stopFrom(w);
  });
  const res = await runnerFor(w, exec).start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 20_000_000,
    grant,
  });
  return { done, review, ask, rest, res };
}

describe("closeout: the project summary is refreshed at session end and readable aloud (A.6)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("session end writes goal, stage, last session, the next three steps, open questions and spend; the summary view speaks every field", async () => {
    const { done, review, ask, rest, res } = await mixedSession(w);
    expect(res.stopReason).toBe("stopped_by_message");
    expect(res.completed).toEqual([done.id]);
    expect(res.inReview).toEqual([review.id]);
    expect(res.needsHuman).toEqual([ask.id]);
    expect(res.skipped).toEqual(rest.map((t) => t.id));

    const cache = (await w.store.project.mustGet(w.project)).summary_cache as {
      goal: string;
      stage: string;
      last_session: { id: string; ended_at: string; summary: string; stop_reason: string };
      next_steps: string[];
      open_questions: number;
      spend_usd_micro: number;
    };
    expect(cache).toMatchObject({
      goal: "Ship a sample service",
      stage: "build",
      next_steps: rest.slice(0, 3).map((t) => t.id),
      open_questions: 1,
      spend_usd_micro: 3 * COST_PER_TASK,
    });
    expect(cache.last_session).toMatchObject({
      id: res.sessionId,
      ended_at: w.clock.nowIso(),
      stop_reason: "stopped_by_message",
    });
    expect(cache.last_session.summary).toContain("Done: 1");

    const view = await projectSummary(w.store, w.project, CHF_PER_USD);
    expect(view).toMatchObject({
      goal: "Ship a sample service",
      stage: "build",
      nextSteps: rest.slice(0, 3).map((t) => t.id),
      openQuestions: 1,
      spend: { usdMicro: 3 * COST_PER_TASK, chfMicro: Math.round(3 * COST_PER_TASK * CHF_PER_USD) },
    });
    expect(view.lastSession).toMatchObject({ id: res.sessionId, stopReason: "stopped_by_message" });
    expect(view.nextSteps).toHaveLength(3);
    // Readable aloud: one string, every field of the screen in it, nothing else to look up.
    expect(view.spoken).toContain("Sample.");
    expect(view.spoken).toContain("Goal: Ship a sample service.");
    expect(view.spoken).toContain("Stage: build.");
    expect(view.spoken).toContain("Last session: Session ended (stopped_by_message).");
    expect(view.spoken).toContain(
      `Next: ${rest
        .slice(0, 3)
        .map((t) => t.id)
        .join("; ")}.`,
    );
    expect(view.spoken).toContain("1 open question.");
    expect(view.spoken).toContain("Spent 0.72 francs.");
  });
});

describe("closeout: the handoff note at session end (F.7)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("carries done, in flight, blocked and next, and reaches the peer as a handoff that needs an ack", async () => {
    const { done, review, ask, rest, res } = await mixedSession(w);
    const session = await w.store.session.mustGet(res.sessionId);
    expect(session.handoff).toMatchObject({
      done: [done.id],
      in_flight: [review.id],
      blocked: [ask.id],
      next: rest.map((t) => t.id),
      stop_reason: "stopped_by_message",
    });
    expect(res.handoff).toEqual(session.handoff);
    const handoffs = await w.store.message.list({ to_agent_id: w.bob, type: "handoff" } as never);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.requires_ack).toBe(true);
    expect(handoffs[0]?.body).toContain("Done: 1.");
    expect(handoffs[0]?.body).toContain("In review: 1.");
    expect(handoffs[0]?.body).toContain("Needs you: 1.");
    expect(handoffs[0]?.body).toContain("Not started: 4 of 7 planned.");
  });
});

describe("closeout: solo and paired mode (C.7)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("solo: a project whose only member is the agent hands off to nobody and still notifies the human", async () => {
    await w.store.project.patch(w.project, { settings: { members: [w.alice] } as never });
    await addTask(w, "Only");
    const res = await runnerFor(w, executorByTitle(w)).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(res.status).toBe("completed");
    expect(await w.store.message.list({ type: "handoff" } as never)).toEqual([]);
    const toHuman = await w.store.message.list({ to_human_id: w.human } as never);
    expect(toHuman).toHaveLength(1);
    expect(toHuman[0]?.from_agent_id).toBe(w.alice);
  });

  it("paired: every other member of the project gets the handoff", async () => {
    const carol = (
      await w.store.agent.insert({
        name: "Carol",
        owner_human_id: w.human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind: "principal",
      })
    ).id;
    await w.store.project.patch(w.project, {
      settings: { members: [w.alice, w.bob, carol] } as never,
    });
    await addTask(w, "Shared");
    await runnerFor(w, executorByTitle(w)).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    const handoffs = await w.store.message.list({ type: "handoff" } as never);
    expect(handoffs.map((m) => m.to_agent_id).sort()).toEqual([w.bob, carol].sort());
    expect(handoffs.every((m) => m.from_agent_id === w.alice && m.requires_ack)).toBe(true);
  });
});

describe("closeout: the PM in code picks the specialist and caps the depth (C.1, C.6)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("plan items carry each task's specialist (coder by default) and the principal's token starts at depth 0 with max depth 2", async () => {
    const tests = await addTask(w, "Write tests", { priority: 9, specialist: "tester" });
    const fix = await addTask(w, "Fix bug", { priority: 5 });
    const exec = executorByTitle(w);
    const started: Record<string, unknown>[] = [];
    const res = await runnerFor(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (type, payload) => {
        if (type === "task.started") started.push(payload);
      },
    });
    expect(res.plan?.items.map((i) => [i.taskId, i.specialist])).toEqual([
      [tests.id, "tester"],
      [fix.id, "coder"],
    ]);
    expect(exec.seen).toEqual([
      { title: "Write tests", specialist: "tester", depth: 0, maxDepth: 2 },
      { title: "Fix bug", specialist: "coder", depth: 0, maxDepth: 2 },
    ]);
    expect(started.map((p) => p.specialist)).toEqual(["tester", "coder"]);
    // The plan the agent acted on is the one on the session row, with its author and reason (B.5).
    const session = await w.store.session.mustGet(res.sessionId);
    expect(
      (session.plan as { items: { specialist: string }[] }).items.map((i) => i.specialist),
    ).toEqual(["tester", "coder"]);
    expect(session.author_agent).toBe(w.alice);
    expect(session.reason).toBe("2 ready task(s) in priority order");
  });
});

describe("closeout: a run that times out (D.17)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("leaves the task failed with the partial summary as the reason, lists it as blocked in the handoff, and the session goes on", async () => {
    const slow = await addTask(w, "Slow", { priority: 9 });
    const quick = await addTask(w, "Quick", { priority: 5 });
    const partial = "partial: wrote half of the test file before the deadline";
    const exec = executorByTitle(w, { Slow: { outcome: "timeout", summary: partial } });
    const res = await runnerFor(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(res.status).toBe("completed");
    expect(res.failed).toEqual([slow.id]);
    expect(res.completed).toEqual([quick.id]);
    const task = await w.store.task.mustGet(slow.id);
    expect(task.status).toBe("failed");
    expect(task.reason).toBe(partial);
    expect(task.claimed_by).toBeNull();
    expect(res.handoff.blocked).toEqual([slow.id]);
    expect(res.summary).toContain("Failed: 1.");
    // The retry policy (D.2) takes it from here: a failed task goes back to ready as the next attempt.
    const retried = await w.store.task.transition(task.id, task.version, "ready", "retry", {
      agentId: w.alice,
    });
    expect(retried.attempt).toBe(1);
  });
});

/**
 * E.4 has two clauses. The first (re-checked between every task) is asserted here. The second
 * (before any write to shared state) holds for the claim of the next task, asserted here at the
 * moment of the claim, and for the session-end writes (summary cache, handoffs, the note to the
 * human), asserted in the next block with messages that land during the last task.
 */
describe("closeout: the inbox is re-checked between tasks (E.4)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return w.store.close();
  });

  it("a message that arrives during a task is delivered and read before the next task is claimed", async () => {
    const a = await addTask(w, "A", { priority: 9 });
    const b = await addTask(w, "B", { priority: 5 });
    let noteId = "";
    // What the inbox looked like at the moment of each claim (the next task's first write to
    // shared state): `read_at` of the note, or `undefined` when the note did not exist yet.
    const noteAtClaim = new Map<string, string | null | undefined>();
    const realClaim = w.store.task.claim.bind(w.store.task);
    vi.spyOn(w.store.task, "claim").mockImplementation(async (...args) => {
      const note = noteId ? await w.store.message.get(noteId) : undefined;
      noteAtClaim.set(args[0], note?.read_at);
      return realClaim(...args);
    });
    const exec = executorByTitle(w, {}, async (title) => {
      if (title !== "A") return;
      noteId = (
        await w.store.message.send({
          from_agent_id: w.bob,
          to_agent_id: w.alice,
          type: "info",
          body: "fyi: I renamed the config module",
          requires_ack: false,
          author_agent: w.bob,
        })
      ).id;
      await w.clock.advance(1_000);
    });
    const res = await runnerFor(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(res.completed).toEqual([a.id, b.id]);
    const log = await w.store.event.list(res.sessionId);
    const seqOf = (pred: (e: (typeof log)[number]) => boolean) => log.find(pred)?.seq ?? -1;
    const startedA = seqOf((e) => e.type === "task.started" && payloadTaskId(e.payload) === a.id);
    const startedB = seqOf((e) => e.type === "task.started" && payloadTaskId(e.payload) === b.id);
    const read = seqOf((e) => e.type === "inbox.message" && payloadId(e.payload) === noteId);
    expect(startedA).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(startedA);
    expect(startedB).toBeGreaterThan(read);
    const note = await w.store.message.mustGet(noteId);
    expect(note.delivered_at).not.toBeNull();
    expect(note.read_at).not.toBeNull();
    // B's claim (its first write to shared state) came after the read: at the moment the claim
    // ran, the note was already marked read. (A was claimed before the note existed.)
    expect(noteAtClaim.get(a.id)).toBeUndefined();
    expect(noteAtClaim.get(b.id)).toBe(note.read_at);
    expect(noteAtClaim.get(b.id)).not.toBeNull();
    expect(w.store.task.claim).toHaveBeenCalledTimes(2);
  });
});

describe("closeout: the inbox is re-checked before the session-end writes (E.4)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return w.store.close();
  });

  /**
   * Records `read_at` of the message `watched()` names at the moment of each session-end write:
   * the summary cache patch and every handoff or note the runner sends after the last task.
   */
  function watchEndWrites(watched: () => string) {
    const at: { cache?: string | null; handoff?: string | null; human?: string | null } = {};
    const readAt = async () => (await w.store.message.get(watched()))?.read_at ?? null;
    const realPatch = w.store.project.patch.bind(w.store.project);
    vi.spyOn(w.store.project, "patch").mockImplementation(async (...args) => {
      if ("summary_cache" in (args[1] as object)) at.cache = await readAt();
      return realPatch(...args);
    });
    const realSend = w.store.message.send.bind(w.store.message);
    vi.spyOn(w.store.message, "send").mockImplementation(async (...args) => {
      const m = args[0];
      if (m.from_agent_id === w.alice && m.type === "handoff") at.handoff = await readAt();
      if (m.from_agent_id === w.alice && m.to_human_id === w.human) at.human = await readAt();
      return realSend(...args);
    });
    return at;
  }

  async function run(exec: TaskExecutor) {
    return runnerFor(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
  }

  it("a requires_ack stop sent during the last task is read before the summary cache and the handoff are written, and the session ends stopped on it", async () => {
    const a = await addTask(w, "A", { priority: 9 });
    const b = await addTask(w, "B", { priority: 5 });
    let stopId = "";
    const at = watchEndWrites(() => stopId);
    const exec = executorByTitle(w, {}, async (title) => {
      if (title !== "B") return;
      stopId = (
        await w.store.message.send({
          from_agent_id: w.bob,
          to_agent_id: w.alice,
          type: "request",
          body: "stop: I need the branch for a hotfix",
          requires_ack: true,
          author_agent: w.bob,
        })
      ).id;
      await w.clock.advance(1_000);
    });
    const res = await run(exec);
    // Both tasks ran and their states stand as written; nothing was left to skip.
    expect(res.completed).toEqual([a.id, b.id]);
    expect(res.skipped).toEqual([]);
    for (const t of [a, b]) {
      const row = await w.store.task.mustGet(t.id);
      expect(row.status).toBe("done");
      expect(row.claimed_by).toBeNull();
    }
    // The stop was read (and, being obeyed, acted on) before any session-end write.
    const stop = await w.store.message.mustGet(stopId);
    expect(stop.delivered_at).not.toBeNull();
    expect(stop.read_at).not.toBeNull();
    expect(stop.acted_at).not.toBeNull();
    expect(at.cache).toBe(stop.read_at);
    expect(at.handoff).toBe(stop.read_at);
    expect(at.human).toBe(stop.read_at);
    // The session ends stopped on it, and every record names it.
    expect(res.stopReason).toBe("stopped_by_message");
    expect(res.status).toBe("stopped");
    expect((await w.store.session.mustGet(res.sessionId)).status).toBe("stopped");
    const entry = { id: stopId, type: "request", from: w.bob, kind: "stop" };
    expect(res.handoff).toMatchObject({
      done: [a.id, b.id],
      next: [],
      stop_reason: "stopped_by_message",
      end_inbox: { read: [entry], stopped_by: entry },
    });
    expect(JSON.stringify(res.handoff)).not.toContain("hotfix");
    expect((await w.store.session.mustGet(res.sessionId)).handoff).toEqual(res.handoff);
    expect(res.summary).toContain("Session ended (stopped_by_message).");
    expect(res.summary).toContain(
      `Read before the session-end writes: 1 message. A stop (message ${stopId}) ended the session: the task states above were written as each task ended, and nothing further was started.`,
    );
    const cache = (await w.store.project.mustGet(w.project)).summary_cache as {
      last_session: { stop_reason: string; summary: string };
    };
    expect(cache.last_session.stop_reason).toBe("stopped_by_message");
    expect(cache.last_session.summary).toBe(res.summary);
    const handoffs = await w.store.message.list({ to_agent_id: w.bob, type: "handoff" } as never);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.body).toContain(`A stop (message ${stopId}) ended the session`);
    const log = await w.store.event.list(res.sessionId);
    const end = log.find((e) => e.type === "session.end_inbox");
    expect(end?.payload).toMatchObject({
      read: [stopId],
      interrupt: { id: stopId, kind: "stop" },
      stopped: true,
    });
  });

  it("an ordinary message sent during the last task is read before the writes and named in the handoff; the session still completes", async () => {
    const only = await addTask(w, "Only");
    let noteId = "";
    const at = watchEndWrites(() => noteId);
    const exec = executorByTitle(w, {}, async () => {
      noteId = (
        await w.store.message.send({
          from_agent_id: w.bob,
          to_agent_id: w.alice,
          type: "info",
          body: "fyi: I renamed the config module",
          requires_ack: true,
          author_agent: w.bob,
        })
      ).id;
      await w.clock.advance(1_000);
    });
    const res = await run(exec);
    expect(res.completed).toEqual([only.id]);
    expect(res.status).toBe("completed");
    expect(res.stopReason).toBe("completed");
    const note = await w.store.message.mustGet(noteId);
    expect(note.read_at).not.toBeNull();
    // An ack-required info message is acted on by reading it, as between tasks.
    expect(note.acted_at).not.toBeNull();
    expect(at.cache).toBe(note.read_at);
    expect(at.handoff).toBe(note.read_at);
    expect(res.handoff).toMatchObject({
      done: [only.id],
      end_inbox: {
        read: [{ id: noteId, type: "info", from: w.bob, kind: "message" }],
        stopped_by: null,
      },
    });
    expect(res.summary).toContain("Session completed.");
    expect(res.summary).toContain("Read before the session-end writes: 1 message.");
    expect(res.summary).not.toContain("ended the session");
  });

  it("a pause from the pause port during the last task is acknowledged and the row ends stopped, not left paused", async () => {
    const only = await addTask(w, "Only");
    const ports = sessionPausePorts({
      store: w.store,
      kill: { activeCount: () => 1 },
      agentId: w.alice,
      humanId: w.human,
    });
    const exec = executorByTitle(w, {}, async () => {
      const [running] = await w.store.session.active(w.alice);
      if (!running) throw new Error("no running session");
      await ports.pauseSession?.(running.id, "lunch");
      expect((await w.store.session.mustGet(running.id)).status).toBe("paused");
    });
    const res = await run(exec);
    expect(res.completed).toEqual([only.id]);
    expect(res.skipped).toEqual([]);
    const [pause] = (await w.store.message.inbox({ agentId: w.alice })).filter(
      (m) => m.body === pauseMessageBody(res.sessionId, "lunch"),
    );
    expect(pause?.read_at).not.toBeNull();
    expect(pause?.acted_at).toBeNull(); // the port sends it without requires_ack
    expect(res.stopReason).toBe("stopped_by_message");
    expect((await w.store.session.mustGet(res.sessionId)).status).toBe("stopped");
    expect(res.handoff).toMatchObject({
      next: [],
      end_inbox: { stopped_by: { id: pause?.id, from: w.alice, kind: "pause" } },
    });
    expect(res.summary).toContain(
      `A pause (message ${pause?.id}) ended the session; no task was left to defer.`,
    );
  });

  it("a session already stopped for another reason keeps its reason; the stop read at the end is named but not its cause", async () => {
    await addTask(w, "Spend", { priority: 9 });
    await addTask(w, "Later", { priority: 5 });
    let stopId = "";
    const exec = executorByTitle(w, { Spend: { outcome: "budget_exceeded" } }, async (title) => {
      if (title !== "Spend") return;
      stopId = (await stopFrom(w)).id;
    });
    const res = await run(exec);
    expect(res.stopReason).toBe("budget_exceeded");
    expect((await w.store.message.mustGet(stopId)).read_at).not.toBeNull();
    expect(res.handoff).toMatchObject({
      stop_reason: "budget_exceeded",
      end_inbox: { read: [{ id: stopId, kind: "stop" }], stopped_by: null },
    });
    expect(res.summary).toContain("Read before the session-end writes: 1 message.");
    expect(res.summary).not.toContain("ended the session");
  });

  it("nothing waiting at the end: no event, no handoff field, no summary line", async () => {
    await addTask(w, "Quiet");
    const res = await run(executorByTitle(w));
    expect(res.handoff).not.toHaveProperty("end_inbox");
    expect(res.summary).not.toContain("Read before the session-end writes");
    const log = await w.store.event.list(res.sessionId);
    expect(log.some((e) => e.type === "session.end_inbox")).toBe(false);
  });
});

function payloadTaskId(payload: unknown): string | undefined {
  return (payload as { taskId?: string } | null)?.taskId;
}

function payloadId(payload: unknown): string | undefined {
  return (payload as { id?: string } | null)?.id;
}
