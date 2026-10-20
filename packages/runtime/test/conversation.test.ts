import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ConversationAgent } from "../src/conversation/agent.ts";
import { flatPricing, harness, ScriptedProvider } from "./helpers.ts";

async function setup(replies: ConstructorParameters<typeof ScriptedProvider>[0]) {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
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
      stage: "alpha",
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
  const pharma = (
    await store.project.insert({
      name: "PharmaWatch",
      goal: "Watch pharma news",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 1,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const provider = new ScriptedProvider(replies, h.clock);
  const started: unknown[] = [];
  const agent = new ConversationAgent({
    store,
    clock: h.clock,
    tokens: h.tokens,
    kill: h.kill,
    provider,
    pricing: flatPricing,
    billingSourceId: "bs",
    hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    startSession: async (req) => {
      started.push(req);
    },
    modelId: "fake-haiku",
  });
  return { h, store, human, alice, game, pharma, provider, agent, started };
}

describe("conversation agent", () => {
  it("answers with context, streams tokens and logs the transcript", async () => {
    const w = await setup([{ text: "Next step on Game: polish the menu.", ttftMs: 120 }]);
    const tokens: string[] = [];
    const p = w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      projectId: w.game,
      text: "what's next on the game?",
      onToken: (t) => tokens.push(t),
    });
    await new Promise((r) => setTimeout(r, 5));
    await w.h.clock.advance(200);
    const res = await p;
    expect(res.reply).toBe("Next step on Game: polish the menu.");
    expect(tokens.join("")).toBe(res.reply);
    expect(res.ttftMs).toBe(120);
    expect(res.pendingConfirmation).toBeNull();
    const sys = w.provider.calls[0]?.system ?? "";
    expect(sys).toContain("Game (active)");
    expect(sys).toContain("PharmaWatch");
    expect(sys).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // volatile facts never in the cached system prompt
    expect(String(w.provider.calls[0]?.messages[0]?.content)).toContain("active_project");
    const sessions = await w.store.session.list({ agent_id: w.alice } as never);
    const log = await w.store.event.list(sessions[0]!.id);
    expect(log.map((e) => e.type)).toEqual(["chat.human", "chat.reply"]);
    await w.store.close();
  });

  it("takes notes and creates draft tasks in the active project", async () => {
    const w = await setup([
      {
        tools: [
          { name: "take_note", input: { text: "try the new renderer", kind: "idea" } },
          {
            name: "create_draft_task",
            input: { title: "Fix menu flicker", outcome: "Menu does not flicker" },
          },
        ],
      },
      { text: "Noted and drafted." },
    ]);
    const res = await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      projectId: w.game,
      text: "note: try the new renderer; and make fixing the menu flicker a task",
    });
    expect(res.actions.map((a) => a.kind)).toEqual(["note", "draft_task"]);
    expect((await w.store.queue.pending(w.game))[0]?.text).toBe("try the new renderer");
    const drafts = await w.store.task.list({ project_id: w.game, status: "draft" } as never);
    expect(drafts[0]?.title).toBe("Fix menu flicker");
    await w.store.close();
  });

  it("reads back a costly session start and waits for yes; no means nothing happens", async () => {
    const w = await setup([
      {
        tools: [
          { name: "switch_project", input: { project_name: "pharmawatch" } },
          { name: "start_session", input: { budget_usd: 20 } },
        ],
      },
      { text: "Switching and starting." },
      { tools: [{ name: "start_session", input: { budget_usd: 1 } }] },
      { text: "Started a small session." },
    ]);
    const r1 = await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      projectId: w.game,
      text: "work on pharmawatch now and give it 20 dollars",
    });
    expect(r1.activeProjectId).toBe(w.game);
    expect(w.agent.getActiveProject(w.human)).toBe(w.pharma);
    expect(r1.pendingConfirmation?.estimateUsdMicro).toBe(20_000_000);
    expect(r1.reply).toContain("budget of $20.00");
    expect(r1.reply).toContain("Say yes to confirm");
    expect(w.started).toHaveLength(0);
    const r2 = await w.agent.chat({ humanId: w.human, agentId: w.alice, text: "no" });
    expect(r2.reply).toContain("Cancelled");
    expect(w.started).toHaveLength(0);
    // Under the threshold: starts at once.
    const r3 = await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      text: "start a one dollar session",
    });
    expect(r3.actions[0]?.kind).toBe("session_start");
    expect(w.started).toHaveLength(1);
    expect(w.started[0]).toMatchObject({ projectId: w.pharma, budgetUsdMicro: 1_000_000 });
    await w.store.close();
  });

  it("yes confirms the pending action and the words are logged with the action", async () => {
    const w = await setup([
      { tools: [{ name: "start_session", input: { budget_usd: 15 } }] },
      { text: "" },
    ]);
    await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      projectId: w.game,
      text: "give it 15 francs tonight",
      source: "voice",
    });
    const r = await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      text: "yes",
      source: "voice",
    });
    expect(r.actions[0]?.kind).toBe("session_start");
    expect(w.started).toHaveLength(1);
    const sessions = await w.store.session.list({ agent_id: w.alice } as never);
    const log = await w.store.event.list(sessions[0]!.id);
    const confirmed = log.find((e) => e.type === "chat.confirmed");
    expect(confirmed?.payload).toMatchObject({ words: "yes", action: "session_start" });
    await w.store.close();
  });

  it("stops sessions immediately and hands real work to the principal", async () => {
    const w = await setup([
      {
        tools: [
          { name: "stop_sessions", input: {} },
          { name: "handoff_to_principal", input: { request: "benchmark the two renderers" } },
        ],
      },
      { text: "Stopped. I asked Alice to benchmark." },
    ]);
    const c = new AbortController();
    w.h.kill.register({ agentId: w.alice, sessionId: "s", controller: c, label: "x" });
    const res = await w.agent.chat({
      humanId: w.human,
      agentId: w.alice,
      projectId: w.game,
      text: "stop everything and benchmark the renderers",
    });
    expect(c.signal.aborted).toBe(true);
    expect(res.actions.map((a) => a.kind)).toEqual(["session_stop", "handoff"]);
    const inbox = await w.store.message.inbox({ agentId: w.alice }, { unreadOnly: true });
    expect(inbox[0]?.body).toContain("benchmark the two renderers");
    expect(inbox[0]?.requires_ack).toBe(true);
    await w.store.close();
  });

  it("refuses to act without an active project and says so", async () => {
    const w = await setup([
      { tools: [{ name: "take_note", input: { text: "x" } }] },
      { text: "Which project?" },
    ]);
    const res = await w.agent.chat({ humanId: w.human, agentId: w.alice, text: "note x" });
    expect(res.actions).toHaveLength(0);
    expect(JSON.stringify(w.provider.calls[1]?.messages.at(-1))).toContain("no active project");
    await w.store.close();
  });
});
