import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";

interface World {
  store: StateStore;
  clock: SimulatedClock;
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
  const mk = async (name: string) =>
    (
      await store.agent.insert({
        name,
        owner_human_id: human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind: "principal",
      })
    ).id;
  const alice = await mk("Alice");
  const bob = await mk("Bob");
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
  return { store, clock, alice, bob, project };
}

const noop: TaskExecutor = {
  async execute({ task }) {
    return { outcome: "done", summary: task.title, costUsdMicro: 0, checksPassed: true };
  },
};

function runner(w: World) {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor: noop,
  });
}

const grant = { allowedTools: [], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("message receipts (spec F)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("a handoff is delivered, read and acted on by the next session of the recipient; a question waits for a reply", async () => {
    const handoff = await w.store.message.send({
      from_agent_id: w.bob,
      to_agent_id: w.alice,
      project_id: w.project,
      type: "handoff",
      body: "Done: 2. In flight: 1.",
      requires_ack: true,
      author_agent: w.bob,
    });
    const question = await w.store.message.send({
      from_agent_id: w.bob,
      to_agent_id: w.alice,
      project_id: w.project,
      type: "question",
      body: "Which database should the sample use?",
      requires_ack: true,
      author_agent: w.bob,
    });
    expect((await w.store.message.unacknowledged(w.bob)).map((m) => m.id).sort()).toEqual(
      [handoff.id, question.id].sort(),
    );
    const events: string[] = [];
    await runner(w).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
      onEvent: (t) => events.push(t),
    });
    const h = await w.store.message.mustGet(handoff.id);
    expect(h.delivered_at).toBeTruthy();
    expect(h.read_at).toBeTruthy();
    expect(h.acted_at).toBeTruthy();
    const q = await w.store.message.mustGet(question.id);
    expect(q.read_at).toBeTruthy();
    expect(q.acted_at).toBeNull();
    expect(events).toContain("inbox.acted");
    // Bob's next session sees the unanswered question resurface.
    const bobEvents: { type: string; payload: Record<string, unknown> }[] = [];
    await runner(w).start({
      agentId: w.bob,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
      onEvent: (type, payload) => bobEvents.push({ type, payload }),
    });
    const resurfaced = bobEvents.find((e) => e.type === "inbox.unacknowledged");
    expect(resurfaced?.payload.count).toBe(1);
    // Alice replies; her next session marks the question acted on.
    await w.store.message.send({
      from_agent_id: w.alice,
      to_agent_id: w.bob,
      project_id: w.project,
      type: "info",
      body: "Postgres.",
      requires_ack: false,
      reply_to: question.id,
      author_agent: w.alice,
    });
    await runner(w).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant,
    });
    expect((await w.store.message.mustGet(question.id)).acted_at).toBeTruthy();
    expect(await w.store.message.unacknowledged(w.bob)).toHaveLength(0);
  });
});
