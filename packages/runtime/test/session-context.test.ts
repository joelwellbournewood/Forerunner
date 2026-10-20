import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/manager.ts";
import { contextSettingsFrom } from "../src/context/pipeline.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { FakeHeadroom, seedWorld } from "./context-helpers.ts";

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

async function world(policy: "native" | "headroom", headroom: FakeHeadroom) {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
  const store: StateStore = await openStore({ url: "sqlite::memory:", clock });
  const w = await seedWorld(store, { context: { compression: policy } }, { session: false });
  await store.task.insert({
    project_id: w.project,
    title: "First",
    outcome: "First done",
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
  });
  const executor: TaskExecutor = {
    async execute({ task, session, budget }) {
      budget.record(`run-${task.id}`, 300_000);
      await store.costLedger.record({
        human_id: w.human,
        agent_id: session.agent_id,
        project_id: w.project,
        session_id: session.id,
        task_id: task.id,
        run_id: `run-${task.id}`,
        billing_source_id: null,
        kind: "api",
        usd_micro: 300_000,
        chf_micro: 240_000,
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
        tokens_in: 100,
        tokens_out: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: clock.nowIso(),
      });
      // The proxy's counter moves while the session works.
      headroom.saved[w.project] = (headroom.saved[w.project] ?? 0) + 250;
      return { outcome: "done", summary: "done", costUsdMicro: 300_000, checksPassed: true };
    },
  };
  const context = new ContextManager({
    clock,
    headroom,
    settingsFor: async (projectId) =>
      contextSettingsFrom(projectId ? (await store.project.get(projectId))?.settings : undefined),
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens: new TokenIssuer({ now: () => clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor,
    context,
  });
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const result = await runner.start({
    agentId: w.agent,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 5_000_000,
    grant,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { store, w, context, events, result };
}

describe("session runner: context layer", () => {
  it("records the Headroom /stats delta on the session and in the ended event when the proxy was used", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { store, context, events, result } = await world("headroom", headroom);
    expect(result.status).toBe("completed");
    expect(result.completed).toHaveLength(1);
    const session = await store.session.mustGet(result.sessionId);
    expect(session.headroom_saved_tokens).toBe(250);
    expect(events.some((e) => e.type === "context.headroom_unavailable")).toBe(false);
    const ended = events.find((e) => e.type === "session.ended");
    expect(ended?.payload).toMatchObject({
      headroomSavedTokens: 250,
      headroomUsed: true,
      compressionSavedTokens: 0,
    });
    expect(context.get(result.sessionId)).toBeUndefined();
    expect(headroom.probes).toBe(1);
    await store.close();
  });

  it("says once that Headroom is not running and records zero saved when the policy asked for it", async () => {
    const headroom = new FakeHeadroom("not_running", {});
    const { store, events, result } = await world("headroom", headroom);
    expect(result.status).toBe("completed");
    const notices = events.filter((e) => e.type === "context.headroom_unavailable");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      status: "not_running",
      policy: "headroom",
      mode: "native",
    });
    expect(String(notices[0]?.payload.warning)).toContain("not running");
    const stored = await store.event.list(result.sessionId);
    expect(stored.some((e) => e.type === "context.headroom_unavailable")).toBe(true);
    const session = await store.session.mustGet(result.sessionId);
    expect(session.headroom_saved_tokens).toBe(0);
    expect(events.find((e) => e.type === "session.ended")?.payload).toMatchObject({
      headroomSavedTokens: 0,
      headroomUsed: false,
    });
    await store.close();
  });

  it("does not probe for the native policy and still ends the session cleanly", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { store, events, result } = await world("native", headroom);
    expect(headroom.probes).toBe(0);
    expect((await store.session.mustGet(result.sessionId)).headroom_saved_tokens).toBe(0);
    expect(events.some((e) => e.type === "context.headroom_unavailable")).toBe(false);
    await store.close();
  });
});
