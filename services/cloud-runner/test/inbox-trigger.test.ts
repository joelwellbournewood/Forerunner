import { SimulatedClock } from "@forerunner/platform";
import { markPlanAnswer, planIdOf, syncPlanApprovals } from "@forerunner/runtime";
import { type AgentRow, openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InboxStartRequest, InboxTrigger } from "../src/inbox-trigger.ts";
import { flush, type Seed, seedWorld } from "./helpers.ts";

/**
 * Inbox triggers on an in-memory store: a peer's message or the human's answer to a session's
 * question asks the scheduler for one "message" session, each item at most once; the agent's
 * own notes, read messages, items from before the runner started, the runner's own unlock
 * challenges and rejected plans never do; an approved plan binds the start to the plan the
 * human saw (`planApproved` = the card's `plan_id`, ADR 0053); nothing is checked while a
 * session runs; a PC that is online keeps the items (ADR 0033) until it is gone.
 */
let store: StateStore;
let clock: SimulatedClock;
let seed: Seed;
let peer: AgentRow;
let requests: InboxStartRequest[];
let active: boolean;
let pcOnline: boolean;
let deferAsked: number;

beforeEach(async () => {
  clock = new SimulatedClock("2026-03-02T22:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  seed = await seedWorld(store);
  peer = await store.agent.insert({
    name: "Bob",
    owner_human_id: seed.human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  requests = [];
  active = false;
  pcOnline = false;
  deferAsked = 0;
});
afterEach(async () => {
  await store.close();
});

function trigger(opts: Partial<ConstructorParameters<typeof InboxTrigger>[0]> = {}) {
  return new InboxTrigger({
    store,
    clock,
    agentId: seed.agent.id,
    isActive: () => active,
    shouldDefer: async () => {
      deferAsked++;
      return pcOnline;
    },
    request: async (req) => {
      requests.push(req);
      return "started";
    },
    pollMs: 30_000,
    deferMs: 180_000,
    ...opts,
  });
}

function send(over: Record<string, unknown> = {}) {
  return store.message.send({
    from_agent_id: peer.id,
    to_agent_id: seed.agent.id,
    project_id: seed.project.id,
    type: "handoff",
    body: "Picked up the API task; the UI half is yours.",
    requires_ack: false,
    ...over,
  });
}

async function sessionRequest(over: Record<string, unknown> = {}) {
  const session = await store.session.insert({
    agent_id: seed.agent.id,
    project_id: seed.project.id,
    trigger: "schedule",
    runner: "cloud",
  });
  return store.humanRequest.insert({
    human_id: seed.human.id,
    project_id: seed.project.id,
    session_id: session.id,
    kind: "decision",
    why: "Which database?",
    steps: [],
    options: ["sqlite", "postgres"],
    blocking: true,
    risk: "low",
    author_agent: seed.agent.id,
    ...over,
  });
}

async function answer(id: string, body: unknown) {
  const row = await store.humanRequest.mustGet(id);
  await store.humanRequest.answer(id, row.version, body as never, seed.human.id);
}

describe("inbox triggers", () => {
  it("a peer's message asks for one message session for its project and is never re-triggered", async () => {
    const t = trigger();
    // Before the runner started: left to the next session.
    const old = await send({ body: "from before" });
    await clock.advance(1_000);
    expect(await t.check()).toBeNull();
    await store.message.markRead(old.id);

    await send();
    // The agent's own note to itself and a message already read never count.
    await send({ from_agent_id: seed.agent.id, body: "note to self" });
    const read = await send({ body: "seen already" });
    await store.message.markRead(read.id);

    expect(await t.check()).toMatchObject({
      agentId: seed.agent.id,
      projectId: seed.project.id,
      trigger: "message",
      reason: "1 new message",
    });
    expect(requests).toHaveLength(1);
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(1);
    expect(t.stats).toMatchObject({ checks: 3, triggered: 1, deferred: 0 });

    // Messages for two projects: no single project on the request.
    const other = await store.project.insert({
      name: "Other",
      goal: "x",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    });
    await clock.advance(1_000);
    await send({ body: "two" });
    await send({ body: "three", project_id: other.id });
    const req = await t.check();
    expect(req).toMatchObject({ trigger: "message", reason: "2 new messages" });
    expect(req?.projectId).toBeUndefined();
  });

  it("waits while a session runs; afterwards only what the session did not read triggers", async () => {
    const t = trigger();
    await clock.advance(1_000);
    const first = await send({ body: "first" });
    active = true;
    expect(await t.check()).toBeNull();
    expect(t.stats).toMatchObject({ checks: 1, triggered: 0 });
    // The session read the first message between tasks; a second arrived after it ended.
    await store.message.markRead(first.id);
    active = false;
    await clock.advance(1_000);
    await send({ body: "second" });
    expect(await t.check()).toMatchObject({ reason: "1 new message" });
    expect(requests).toHaveLength(1);
  });

  it("an answered session question triggers; an approved plan carries its plan id as planApproved; a rejected plan and the runner's unlock challenge do not", async () => {
    const t = trigger();
    await clock.advance(1_000);
    const question = await sessionRequest();
    await answer(question.id, "postgres");
    expect(await t.check()).toMatchObject({
      trigger: "message",
      projectId: seed.project.id,
      reason: "1 answered request",
    });
    expect(requests[0]?.planApproved).toBeUndefined();
    expect(await t.check()).toBeNull();

    const planId = planIdOf("s1", [{ taskId: "t1" }, { taskId: "t2" }]);
    const plan = await sessionRequest({
      kind: "approval",
      why: "Assisted mode: approve this session plan before work starts.",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planId, plan: { items: [] } },
    });
    await answer(plan.id, "approve");
    // Bound to the plan the human saw, never a bare "approved": the runner runs it only while
    // the plan is still that plan.
    expect(await t.check()).toMatchObject({
      planApproved: planId,
      trigger: "message",
      reason: "1 answered request",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.planApproved).toBe(planId);

    const rejected = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s2", plan_id: planIdOf("s2", []), plan: { items: [] } },
    });
    await answer(rejected.id, "reject");
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(2);

    // A plan card without the plan's id (an earlier build's request) starts a plain session:
    // the runner proposes the plan again rather than running it as approved.
    const unbound = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s3", plan: [] },
    });
    await answer(unbound.id, { option: "approve" });
    const plain = await t.check();
    expect(plain).toMatchObject({ trigger: "message", reason: "1 answered request" });
    expect(plain?.planApproved).toBeUndefined();
    expect(requests).toHaveLength(3);

    // The runner's own unlock challenge (no session) and an answer to an open question of
    // another agent never start a session here.
    const unlock = await store.humanRequest.insert({
      human_id: seed.human.id,
      kind: "credential",
      why: "vault key",
      steps: [],
      options: ["unlock", "deny"],
      blocking: true,
      risk: "high",
      change_card: { kind: "runner_vault_unlock" },
      author_agent: seed.agent.id,
    });
    await answer(unlock.id, { challengeId: "x" });
    const peersQuestion = await sessionRequest({ author_agent: peer.id });
    await answer(peersQuestion.id, "sqlite");
    expect(await t.check()).toBeNull();
    expect(t.stats.triggered).toBe(3);
  });

  it("two approved plans in one check: the newest binds the start, the older is superseded", async () => {
    const t = trigger();
    await clock.advance(1_000);
    const older = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planIdOf("s1", [{ taskId: "a" }]), plan: {} },
    });
    await answer(older.id, "approve");
    await clock.advance(1_000);
    const newer = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: {
        key: "plan:s2",
        plan_id: planIdOf("s2", [{ taskId: "a" }, { taskId: "b" }]),
        plan: {},
      },
    });
    await answer(newer.id, "approve");
    expect(await t.check()).toMatchObject({
      planApproved: planIdOf("s2", [{ taskId: "a" }, { taskId: "b" }]),
      reason: "2 answered requests",
    });
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("an approved plan the PC's daemon already acted on is not triggered on", async () => {
    const t = trigger();
    await clock.advance(1_000);
    const plan = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planIdOf("s1", [{ taskId: "a" }]), plan: {} },
    });
    await answer(plan.id, "approve");
    // The daemon's syncPlanApprovals marked it (the PC was online, then went offline).
    const answered = await store.humanRequest.mustGet(plan.id);
    expect(await markPlanAnswer(store, clock, answered, "started")).not.toBeNull();
    expect(await t.check()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("a triggered plan is claimed and marked: a fresh trigger (a runner restart) and the daemon start nothing again", async () => {
    const since = clock.now();
    await clock.advance(1_000);
    const older = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s0", plan_id: planIdOf("s0", [{ taskId: "a" }]), plan: {} },
    });
    await answer(older.id, "approve");
    await clock.advance(1_000);
    const plan = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planIdOf("s1", [{ taskId: "a" }]), plan: {} },
    });
    const filing = await store.session.mustGet(plan.session_id ?? "");
    await store.session.patch(filing.id, { budget_cap_usd_micro: 3_000_000 });
    await answer(plan.id, "approve");
    expect(await trigger({ since }).check()).toMatchObject({
      planApproved: planIdOf("s1", [{ taskId: "a" }]),
      // The cap of the session that filed the plan: the plan is cut as the human saw it.
      budgetUsdMicro: 3_000_000,
    });
    expect((await store.humanRequest.mustGet(plan.id)).change_card).toMatchObject({
      outcome: "started",
      applied_at: clock.nowIso(),
    });
    expect((await store.humanRequest.mustGet(older.id)).change_card).toMatchObject({
      outcome: "superseded",
      superseded_by: plan.id,
    });
    expect(await trigger({ since }).check()).toBeNull();
    expect(requests).toHaveLength(1);
    // The daemon's sync, at its next boot, finds both acted on.
    const started: unknown[] = [];
    expect(
      await syncPlanApprovals({
        store,
        clock,
        humanId: seed.human.id,
        agentId: seed.agent.id,
        start: async (req) => {
          started.push(req);
          return { id: "x", result: "started" };
        },
      }),
    ).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(started).toEqual([]);
  });

  it("a plan the daemon claims between the check's read and its claim starts nothing here", async () => {
    const t = trigger();
    await clock.advance(1_000);
    const plan = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planIdOf("s1", [{ taskId: "a" }]), plan: {} },
    });
    await answer(plan.id, "approve");
    const list = store.humanRequest.list.bind(store.humanRequest);
    store.humanRequest.list = (async (...args: Parameters<typeof list>) => {
      const rows = await list(...args);
      // The PC's daemon claims the answer right after this read.
      const row = await store.humanRequest.mustGet(plan.id);
      await markPlanAnswer(store, clock, row, "starting");
      return rows;
    }) as typeof list;
    expect(await t.check()).toBeNull();
    expect(requests).toEqual([]);
    expect((await store.humanRequest.mustGet(plan.id)).change_card).toMatchObject({
      outcome: "starting",
    });
  });

  it("a plan claimed for a start the scheduler skipped (a PC came online) is released for the PC", async () => {
    await clock.advance(1_000);
    const plan = await sessionRequest({
      kind: "approval",
      options: ["approve", "reject"],
      change_card: { key: "plan:s1", plan_id: planIdOf("s1", [{ taskId: "a" }]), plan: {} },
    });
    await answer(plan.id, "approve");
    const t = trigger({ request: async () => "skipped" });
    expect(await t.check()).toBeNull();
    expect((await store.humanRequest.mustGet(plan.id)).change_card).not.toHaveProperty(
      "applied_at",
    );
  });

  it("leaves the items to a PC that is online, backs off, and takes over once the PC is gone", async () => {
    const t = trigger();
    pcOnline = true;
    await clock.advance(1_000);
    await send();
    expect(await t.check()).toBeNull();
    expect(t.stats).toMatchObject({ deferred: 1, triggered: 0 });
    expect(deferAsked).toBe(1);
    // Inside the back-off nothing is re-asked.
    await clock.advance(30_000);
    expect(await t.check()).toBeNull();
    expect(deferAsked).toBe(1);
    pcOnline = false;
    await clock.advance(180_000);
    expect(await t.check()).toMatchObject({ trigger: "message", reason: "1 new message" });
    expect(t.stats).toMatchObject({ deferred: 1, triggered: 1 });
  });

  it("an item the scheduler skipped for a PC that came online is not marked seen and triggers again later", async () => {
    // The PC rule is checked twice: by shouldDefer before the request and by the scheduler's
    // start. A PC that appears between the two makes the start report "skipped"; the items
    // must stay available for the next check after the back-off, not be lost.
    let outcome: "started" | "skipped" = "skipped";
    const t = trigger({
      request: async (req) => {
        requests.push(req);
        return outcome;
      },
    });
    await clock.advance(1_000);
    const handoff = await send();
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(1);
    expect(t.stats).toMatchObject({ triggered: 0, deferred: 1 });
    expect((await store.message.mustGet(handoff.id)).read_at).toBeNull();
    // Inside the back-off nothing is re-asked.
    await clock.advance(30_000);
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(1);
    outcome = "started";
    await clock.advance(180_000);
    expect(await t.check()).toMatchObject({ trigger: "message", reason: "1 new message" });
    expect(requests).toHaveLength(2);
    expect(t.stats).toMatchObject({ triggered: 1, deferred: 1 });
    expect(await t.check()).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("polls on the clock once started and stops cleanly", async () => {
    const t = trigger();
    t.start();
    await clock.advance(1_000);
    await send();
    await clock.advance(30_000);
    await flush();
    expect(requests).toHaveLength(1);
    t.stop();
    await clock.advance(1_000);
    await send({ body: "after stop" });
    await clock.advance(60_000);
    await flush();
    expect(requests).toHaveLength(1);
  });
});
