import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { seedWorld } from "./context-helpers.ts";

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

/**
 * U-013: the Tasks tab offered Claim to people. It moved a task to `claimed` with no holder
 * and no expiry, so no session planned it ("Nothing to plan: no task is ready") and nothing
 * returned it to ready. A session now puts such tasks, and lapsed claims, back to ready before
 * it plans.
 */
describe("session start: claims nobody holds", () => {
  it("a task a person claimed is put back to ready and worked on", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store, {}, { session: false });
    const stuck = await store.task.insert({
      project_id: w.project,
      title: "Clicked Claim on this",
      outcome: "done",
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "claimed",
      est_cost_usd_micro: 300_000,
      reason: "Claimed in the app",
    });
    const ran: string[] = [];
    const executor: TaskExecutor = {
      async execute({ task }) {
        ran.push(task.id);
        return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
      },
    };
    const runner = new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
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
    expect(ran).toEqual([stuck.id]);
    expect(result.completed).toEqual([stuck.id]);
    expect(events.find((e) => e.type === "task.claims_released")?.payload).toMatchObject({
      count: 1,
      tasks: [{ id: stuck.id, reason: "claimed by no agent: back to ready" }],
    });
    await store.close();
  });
});
