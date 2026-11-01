import { openStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { CHAT_PLAN_RULES, ConversationAgent } from "../src/conversation/agent.ts";
import { planBlock } from "../src/conversation/project-facts.ts";
import type { IntakeState } from "../src/session/intake.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * The chat knows where the plan from the brief stands (design §3.3, §3.9; the live run of
 * 2026-11-01, problem 4). Asked while planning had failed, the real model answered "The Quote
 * page project has no tasks yet… I can add tasks…": the context said "(no tasks yet)" and
 * nothing about the plan, so it could not say that planning failed or that Try again on the
 * project page drafts it again. What the model is SENT is asserted (a scripted model).
 */

describe("the plan from the brief, in the chat's words (planBlock)", () => {
  it("says each state in one line; nothing for a plan that is answered or never asked for", () => {
    expect(planBlock({ state: "drafting", error: null })).toBe(
      "# Plan from the brief\nThe plan from your brief is being drafted.",
    );
    expect(planBlock({ state: "pending", error: null })).toBe(
      "# Plan from the brief\nThe plan from your brief waits for your approval in the Inbox.",
    );
    expect(
      planBlock({
        state: "failed",
        error: "Claude's answer was not the JSON plan Forerunner asks for.",
      }),
    ).toBe(
      "# Plan from the brief\nPlanning failed: Claude's answer was not the JSON plan Forerunner asks for. The person can press Try again on the project page.",
    );
    // A failure without a recorded cause still says what to do.
    expect(planBlock({ state: "failed", error: "" })).toBe(
      "# Plan from the brief\nPlanning failed. The person can press Try again on the project page.",
    );
    expect(planBlock({ state: "rejected", error: null })).toBe(
      "# Plan from the brief\nThe person rejected the plan; nothing was written. They can press Draft a new plan on the project page.",
    );
    for (const state of ["none", "approved", "skipped"] as IntakeState[])
      expect(planBlock({ state, error: null })).toBe("");
  });
});

describe("the chat is told the plan's state on every turn (design §3.9)", () => {
  async function world(state: IntakeState, error: string | null = null) {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const human = (
      await store.human.insert({
        name: "Robin",
        email: "robin@example.test",
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
    const quote = (
      await store.project.insert({
        name: "Quote page",
        goal: "A page that shows a random quote",
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
      })
    ).id;
    const provider = new FakeProvider({
      replies: [textReply("ok", { ttftMs: 0 })],
      clock: h.clock,
      latency: "none",
    });
    const asked: string[] = [];
    const agent = new ConversationAgent({
      store,
      clock: h.clock,
      tokens: h.tokens,
      kill: h.kill,
      provider,
      pricing: flatPricing,
      billingSourceId: "bs",
      hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      modelId: "fake-haiku",
      intakeStatus: async (projectId) => {
        asked.push(projectId);
        return { state, error };
      },
    });
    await agent.chat({
      humanId: human,
      agentId: alice,
      projectId: quote,
      projectTab: true,
      text: "what is left to do?",
      source: "text",
    });
    const req = provider.calls[0]?.request;
    const last = req?.messages.at(-1)?.content;
    const sent = typeof last === "string" ? last : JSON.stringify(last);
    await store.close();
    return { sent, system: String(req?.system ?? ""), asked, quote };
  }

  it("planning failed: the turn carries the cause and Try again, before the empty task list", async () => {
    const w = await world("failed", "Claude's plan was missing parts Forerunner needs.");
    expect(w.asked).toEqual([w.quote]);
    expect(w.sent).toContain(
      "Planning failed: Claude's plan was missing parts Forerunner needs. The person can press Try again on the project page.",
    );
    // The plan's state comes first: the model reads why there are no tasks before the list.
    expect(w.sent.indexOf("# Plan from the brief")).toBeLessThan(
      w.sent.indexOf("# Tasks of Quote page"),
    );
    // The reply rules say what to do with it: no "no tasks yet, I can add tasks".
    expect(w.system).toContain(CHAT_PLAN_RULES);
  });

  it("drafting and waiting are said in words", async () => {
    expect((await world("drafting")).sent).toContain("The plan from your brief is being drafted.");
    expect((await world("pending")).sent).toContain(
      "The plan from your brief waits for your approval in the Inbox.",
    );
  });

  it("an approved plan adds nothing: the tasks speak for themselves", async () => {
    const w = await world("approved");
    expect(w.sent).not.toContain("# Plan from the brief");
  });

  it("the reply rules tell the model to use the plan's state and to write plain sentences", () => {
    expect(CHAT_PLAN_RULES).toMatch(/never say the project has no tasks/i);
    expect(CHAT_PLAN_RULES).toMatch(/Try again/);
    expect(CHAT_PLAN_RULES).toMatch(/plain sentences/i);
  });
});
