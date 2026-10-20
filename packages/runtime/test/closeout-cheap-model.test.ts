import { openStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ConversationAgent } from "../src/conversation/agent.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import {
  DEFAULT_LADDER,
  MODE_DEFAULTS,
  type Mode,
  modelIdFor,
  tierIndex,
} from "../src/models/ladder.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * Release close-out for N.5 (docs/requirements.md): "Cheap model for summaries, routing and
 * quick chat." The mode table puts quick chat and routing on the cheapest rung; the quick chat
 * agent, left to its defaults, calls the provider with that rung's model; the session summary
 * is produced in code by a runner that has no model provider at all.
 *
 * Routing makes no model call today: `MODE_DEFAULTS.routing` is read only as a settings key
 * (`src/models/settings.ts`); specialists are picked by `StaticPlanner` in code and command
 * intents by patterns in `@forerunner/commands`. So for the "routing" half of N.5 the rung
 * assertion below is the only thing there is to hold; the quick chat and summary halves are
 * behavioural.
 */
describe("N.5: the cheap rung for quick chat and routing", () => {
  const cheapest = DEFAULT_LADDER[0]?.tier;

  it("text_chat, voice_chat and routing default to the cheapest rung of the ladder", () => {
    expect(cheapest).toBe("haiku");
    for (const mode of ["text_chat", "voice_chat", "routing"] as const) {
      expect(MODE_DEFAULTS[mode].tier, mode).toBe(cheapest);
      expect(MODE_DEFAULTS[mode].effort, mode).toBe("low");
    }
  });

  it("every working mode (planning, specialists, critic) sits above the chat and routing rung", () => {
    const work: Mode[] = ["planning", "coder", "researcher", "critic_t1", "critic_t23"];
    for (const mode of work) {
      expect(tierIndex(MODE_DEFAULTS[mode].tier), mode).toBeGreaterThan(
        tierIndex(MODE_DEFAULTS.text_chat.tier),
      );
      expect(tierIndex(MODE_DEFAULTS[mode].tier), mode).toBeGreaterThan(
        tierIndex(MODE_DEFAULTS.routing.tier),
      );
    }
  });
});

describe("N.5: the quick chat agent calls the cheap model when nothing else is configured", () => {
  it("a free sentence (no command pattern) goes to the provider as the ladder's haiku model", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const human = (
      await store.human.insert({
        name: "J",
        email: "j@x.test",
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
        memory_location: "l",
        status: "active",
        kind: "principal",
      })
    ).id;
    const game = (
      await store.project.insert({
        name: "Game",
        goal: "Ship the game",
        repos: [],
        stage: "build",
        status: "active",
        budget_usd_micro: 1,
        autonomy_level: 2,
        summary_cache: { next_steps: ["polish menu"] },
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      })
    ).id;
    const provider = new FakeProvider({
      replies: [textReply("Next step on Game: polish the menu.", { ttftMs: 0 })],
      clock: h.clock,
      latency: "none",
    });
    const commands = new CommandLoop({
      store,
      clock: h.clock,
      ports: {
        chfPerUsd: async () => 0.8,
        startSession: async () => ({ sessionId: "s-1" }),
        kill: async () => ({ stoppedRuns: 0, killedProcesses: 0 }),
      },
    });
    await commands.start();
    // No `modelId`, no `modelConfig`: the agent must fall back to the mode table and the ladder.
    const agent = new ConversationAgent({
      store,
      clock: h.clock,
      tokens: h.tokens,
      kill: h.kill,
      provider,
      pricing: flatPricing,
      billingSourceId: "bs",
      hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      commands,
    });
    const res = await agent.chat({
      humanId: human,
      agentId: alice,
      projectId: game,
      text: "what's next on the game?",
    });
    expect(res.reply).toBe("Next step on Game: polish the menu.");
    expect(provider.calls).toHaveLength(1);
    const expected = modelIdFor(MODE_DEFAULTS.text_chat.tier, provider.name);
    expect(expected).toBe("fake-haiku");
    expect(provider.calls[0]?.request.model).toBe(expected);
    await store.close();
  });
});

describe("N.5: the session summary costs no model call", () => {
  it("a runner with no model provider still writes the session summary from the outcomes", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
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
    await store.project.patch(project, { settings: { members: [alice] } as never });
    for (const title of ["A", "B"]) {
      await store.task.insert({
        project_id: project,
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
        author_agent: alice,
      });
    }
    const executor: TaskExecutor = {
      async execute({ task, budget }) {
        budget.record(`run-${task.id}`, 1);
        return {
          outcome: "done",
          summary: `${task.title}: done`,
          costUsdMicro: 1,
          checksPassed: true,
        };
      },
    };
    // The runner's dependencies name no provider and no model: the summary is code's work.
    const runner = new SessionRunner({
      store,
      clock: h.clock,
      tokens: new TokenIssuer({ now: () => h.clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    });
    const res = await runner.start({
      agentId: alice,
      projectId: project,
      trigger: "manual",
      budgetCapUsdMicro: 1_000_000,
      grant: { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] },
    });
    expect(res.status).toBe("completed");
    const session = await store.session.mustGet(res.sessionId);
    expect(session.summary).toContain("Done: 2");
    const cached = (await store.project.mustGet(project)).summary_cache as {
      last_session?: { summary?: string };
    };
    expect(cached.last_session?.summary).toBe(session.summary);
    // Nothing but the executor's own run rows reached the ledger: no summary model call.
    const rows = await store.costLedger.list({ session_id: res.sessionId } as never);
    expect(rows.every((r) => String(r.run_id ?? "").startsWith("run-"))).toBe(true);
    await store.close();
  });
});
