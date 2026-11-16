import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { afterAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { LoopAgentDriver, type RunRequest, type RunResult } from "../src/agent/loop.ts";
import {
  CHAT_THOROUGH_TIMEOUT_MS,
  ConversationAgent,
  type ConversationDeps,
  THOROUGH_MAX_MODEL_CALLS,
} from "../src/conversation/agent.ts";
import {
  ANSWER_THOROUGHLY_DESCRIPTION,
  ANSWER_THOROUGHLY_TOOL,
  ASK_RESULT,
  CHAT_THOROUGH_RULES,
  CHAT_WRAP_UP,
  capWords,
  FAILED_WORDS,
  NOT_NOW,
  notNowResult,
  THINK_THROUGH_WHAT,
  TIMEOUT_REPLY,
  VOICE_THOROUGH_NOTICE,
} from "../src/conversation/depth.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import type { ModelProvider, ModelRequest } from "../src/provider/types.ts";
import { loadRegistry } from "../src/registry/loader.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * d1109-chat-depth (run C, ADR 0114; the owner's words of 2026-11-09: "Chat should also be able to
 * use more effort or a better model, selectively and transparently, in order to be more useful,
 * knowing that this will take more time to reply. There should be something indicating what the
 * chat is doing when waiting", and answer 2: "as much as needed, but if it will switch models and
 * do an expensive task, it should warn/ask first"). Composed as chat-guard.test.ts composes the
 * chat: the real LoopAgentDriver and EnforcementHooks, the real command loop, a scripted provider
 * (or the bench's role-player). What the model is SENT, what the person reads and what the store
 * and the ledger hold are asserted.
 */

const QUESTION = 'why does "Style the page" keep failing and what should I change?';

/** The fast pass's tools, system and history: the bytes the prompt cache keys on. */
const fastPrefix = (r: ModelRequest | undefined) =>
  JSON.stringify({ tools: r?.tools, system: r?.system, model: r?.model, effort: r?.effort });

const isThorough = (r: ModelRequest) => (r.system ?? "").includes("# Thinking it through");

interface World {
  store: StateStore;
  human: string;
  alice: string;
  project: string;
  provider: ModelProvider & { calls?: { request: Omit<ModelRequest, "signal"> }[] };
  agent: ConversationAgent;
  ledger: ReturnType<typeof harness>["ledger"];
  /** Every run the agent asked for (the request as the driver received it) and how it ended. */
  runs: { req: RunRequest; result: RunResult | null }[];
  chat: (
    text: string,
    extra?: Partial<Parameters<ConversationAgent["chat"]>[0]>,
  ) => ReturnType<ConversationAgent["chat"]>;
  /** The newest chat.reply row's payload. */
  lastRow: () => Promise<Record<string, unknown>>;
  requests: () => Omit<ModelRequest, "signal">[];
  restart: () => void;
}

const stores: StateStore[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => undefined);
});

async function world(
  opts: {
    replies?: ScriptedReply[];
    provider?: ModelProvider;
    deps?: Partial<ConversationDeps>;
    prefs?: Record<string, unknown>;
    projectSettings?: Record<string, unknown>;
    commands?: boolean;
  } = {},
): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const human = (
    await store.human.insert({
      name: "Robin",
      email: "robin@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: opts.prefs ?? {},
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
      name: "Quote Page",
      goal: "A page that shows a random quote",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: opts.projectSettings ?? {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const provider =
    opts.provider ??
    new FakeProvider({ replies: opts.replies ?? [], clock: h.clock, latency: "none" });
  const runs: World["runs"] = [];
  const inner = new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock });
  const driver = {
    run: async (req: RunRequest) => {
      const at = runs.push({ req, result: null }) - 1;
      const result = await inner.run(req);
      (runs[at] as { result: RunResult | null }).result = result;
      return result;
    },
  } as unknown as LoopAgentDriver;
  const build = () => {
    const commands =
      opts.commands === false
        ? undefined
        : new CommandLoop({
            store,
            clock: h.clock,
            ports: { chfPerUsd: async () => 0.8 },
          });
    return new ConversationAgent({
      store,
      clock: h.clock,
      tokens: h.tokens,
      kill: h.kill,
      provider,
      pricing: flatPricing,
      billingSourceId: "bs",
      hooksDriver: driver,
      modelId: "fake-haiku",
      chfPerUsd: () => 0.8,
      ...(commands ? { commands } : {}),
      ...opts.deps,
    });
  };
  const w: World = {
    store,
    human,
    alice,
    project,
    provider: provider as World["provider"],
    agent: build(),
    ledger: h.ledger,
    runs,
    chat: (text, extra = {}) =>
      w.agent.chat({
        humanId: human,
        agentId: alice,
        projectId: project,
        projectTab: true,
        text,
        source: "text",
        ...extra,
      }),
    lastRow: async () => {
      const sessionId = await w.agent.conversationSessionId(alice, project);
      const rows = await store.event.ofTypes(sessionId, ["chat.reply"], { limit: 1 });
      return (rows[0]?.payload ?? {}) as Record<string, unknown>;
    },
    requests: () =>
      ((provider as { calls?: { request: Omit<ModelRequest, "signal"> }[] }).calls ?? []).map(
        (c) => c.request,
      ),
    restart: () => {
      w.agent = build();
    },
  };
  return w;
}

describe("d1109-chat-depth, run C: the signal and Stop (D3-12)", () => {
  it("Stop while the stand-in holds a call ends the run as killed within a second, makes no further call, and the reply row says stopped with the call's booked cost", async () => {
    // The bench's stand-in holds the chat call (FORERUNNER_BENCH_CHAT_HOLD_MS) after it reported
    // the call's input, as the real API bills a call cut off mid-way.
    const player = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0", FORERUNNER_BENCH_CHAT_HOLD_MS: "600000" },
        new ModelCallLog({
          file: join(mkdtempSync(join(tmpdir(), "fr-chat-depth-")), "calls.jsonl"),
        }),
      ),
    );
    const w = await world({ provider: player });
    let turnId = "";
    const pending = w.chat("what is left?", { onTurn: (t) => (turnId = t.turnId) });
    // The call is held on the simulated clock: the turn is in flight.
    for (let i = 0; i < 50 && !turnId; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50 && w.runs.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(turnId).not.toBe("");
    expect(w.agent.turnsOf().get(turnId)?.step ?? null).toBeNull();
    const started = Date.now();
    expect(w.agent.turnsOf().stop(turnId)).toBe(true);
    const reply = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]?.result?.outcome).toBe("killed");
    expect(reply.footer).toMatch(/^You stopped this answer: (?:under )?CHF \d+\.\d{2} spent\.$/);
    const row = await w.lastRow();
    expect(row.outcome).toBe("stopped");
    expect(row.stopped).toBe(true);
    // The cut-off call is booked (l3-money-engine): the turn's cost is its ledger rows, and the
    // stand-in reported the call's input before it held it, so it is no zero.
    const booked = w.ledger.entries
      .filter((e) => e.runId === turnId)
      .reduce((sum, e) => sum + e.usdMicro, 0);
    expect(booked).toBeGreaterThan(0);
    expect(row.costUsdMicro).toBe(booked);
    expect(reply.costUsdMicro).toBe(booked);
    // The turn is no longer in flight; a second Stop answers false.
    expect(w.agent.turnsOf().stop(turnId)).toBe(false);
  });

  it("the request's own signal (voice's barge-in) now reaches the run: aborted mid-call, the run ends as killed", async () => {
    // A scripted fake that waits on its own (simulated) clock until the signal ends it.
    const slow = new FakeProvider({
      replies: [textReply("A long spoken answer.", { ttftMs: 600_000 })],
      latency: "simulated",
    });
    const v = await world({ provider: slow });
    const controller = new AbortController();
    const pending = v.chat("what is left?", { source: "voice", signal: controller.signal });
    for (let i = 0; i < 50 && v.runs.length === 0; i++) await new Promise((r) => setImmediate(r));
    controller.abort(new Error("barge-in"));
    await pending;
    expect(v.runs[0]?.result?.outcome).toBe("killed");
    expect(slow.calls).toHaveLength(1);
  });
});

describe("d1109-chat-depth, run C: the person's ask and the explicit pass", () => {
  it("'think it through: …' makes no fast call and runs the longer rung at once: fake-haiku at medium, thinking not off, 4096 tokens, CHAT_THOROUGH_RULES, no answer_thoroughly", async () => {
    const w = await world({
      replies: [textReply("The last two sessions wrote the page and its check.")],
    });
    const steps: { line: string; reset?: boolean }[] = [];
    const r = await w.chat("think it through: what did the last two sessions do?", {
      onStep: (line, o) => steps.push({ line, ...(o?.reset ? { reset: true } : {}) }),
    });
    expect(w.requests()).toHaveLength(1);
    const req = w.requests()[0];
    expect(req?.model).toBe("fake-haiku");
    expect(req?.effort).toBe("medium");
    expect(req?.thinking).toBeUndefined();
    expect(req?.max_tokens).toBe(4096);
    expect(req?.system).toContain(CHAT_THOROUGH_RULES);
    expect((req?.tools ?? []).map((t) => t.name)).not.toContain(ANSWER_THOROUGHLY_TOOL);
    expect(steps[0]).toEqual({
      line: "Thinking it through more carefully: about 30 seconds, at most CHF 0.10.",
      reset: true,
    });
    expect(r.depth).toBe("longer");
    expect(r.footer).toMatch(
      /^Thought it through more carefully · \d+ s · (?:under )?CHF \d+\.\d{2}$/,
    );
    const run = w.runs[0];
    expect(run?.req.maxTurns).toBe(THOROUGH_MAX_MODEL_CALLS);
    expect(run?.req.timeoutMs).toBe(CHAT_THOROUGH_TIMEOUT_MS);
    expect(run?.req.wrapUp).toBe(CHAT_WRAP_UP);
    // The pass that went ahead without asking is budgeted at the person's amount (CHF 0.10).
    expect(run?.req.budget.limits.budgetUsdMicro).toBe(125_000);
    const row = await w.lastRow();
    expect(row.depth).toBe("longer");
    expect(row.passes).toEqual([
      expect.objectContaining({ depth: "longer", model: "fake-haiku", effort: "medium" }),
    ]);
  });

  it("'use a stronger model: …' makes no model call before the yes: the reply is the ask line with Go ahead; Go ahead runs fake-sonnet once on the same question", async () => {
    const w = await world({
      replies: [textReply("It fails because the stylesheet is not linked. Link it in index.html.")],
    });
    const r = await w.chat(`use a stronger model: ${QUESTION}`);
    expect(w.requests()).toHaveLength(0);
    expect(r.reply).toMatch(
      /^This needs a stronger model: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
    expect(r.offer).toEqual({ line: r.reply, action: "go_ahead" });
    const go = await w.chat("Go ahead.", { offer: r.transcriptId });
    expect(w.requests()).toHaveLength(1);
    expect(w.requests()[0]?.model).toBe("fake-sonnet");
    expect(w.requests()[0]?.effort).toBe("medium");
    expect(String(w.requests()[0]?.messages.at(-1)?.content)).toContain(
      `use a stronger model: ${QUESTION}`,
    );
    expect(go.footer).toMatch(/^Thought it through with Sonnet · \d+ s · /);
    // Pressed again on an answer that is no longer the newest: nothing runs.
    await w.chat("Go ahead.", { offer: r.transcriptId });
    expect(w.requests()).toHaveLength(1);
  });

  it("a bare 'think harder' re-asks the previous line; with none it asks what to think through", async () => {
    const w = await world({ replies: [textReply("Two tasks."), textReply("Thought about it.")] });
    const none = await w.chat("think harder");
    expect(none.reply).toBe(THINK_THROUGH_WHAT);
    expect(w.requests()).toHaveLength(0);
    await w.chat("what is left?");
    await w.chat("think harder");
    expect(w.requests()).toHaveLength(2);
    expect(isThorough(w.requests()[1] as ModelRequest)).toBe(true);
    expect(String(w.requests()[1]?.messages.at(-1)?.content).startsWith("what is left?")).toBe(
      true,
    );
  });

  it("a spoken 'think harder' is told to type it, with no model call", async () => {
    const w = await world({ replies: [textReply("x")] });
    const r = await w.chat("think harder", { source: "voice" });
    expect(r.reply).toBe(VOICE_THOROUGH_NOTICE);
    expect(w.requests()).toHaveLength(0);
  });

  it("with the person's amount at 0 the explicit longer pass asks first; Think it through's press runs it within its 'at most'", async () => {
    const w = await world({
      prefs: { chat_ask_above: 0 },
      replies: [textReply("Two tasks are left."), textReply("Thought it through.")],
    });
    const asked = await w.chat("think it through: what is left?");
    expect(asked.reply).toMatch(
      /^This needs a closer look: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
    expect(w.requests()).toHaveLength(0);
    const quick = await w.chat("what is left?");
    expect(quick.offer).toBeNull();
    const row = await w.lastRow();
    const closer = row.closer as { atMostUsdMicro: number };
    expect(closer.atMostUsdMicro).toBeGreaterThan(0);
    await w.chat("Think it through.", { depth: "longer", offer: quick.transcriptId });
    expect(w.requests()).toHaveLength(2);
    expect(isThorough(w.requests()[1] as ModelRequest)).toBe(true);
    expect(w.runs.at(-1)?.req.budget.limits.budgetUsdMicro).toBe(closer.atMostUsdMicro);
  });
});

describe("d1109-chat-depth, run C: answer_thoroughly, the gate and the ask", () => {
  it("the fast request carries answer_thoroughly with exactly its definition; many_records hands over at once (no ask) after one call", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "many_records" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("Across the sessions the page was built, then checked.", { when: isThorough }),
      ],
    });
    const steps: { line: string; reset?: boolean }[] = [];
    const r = await w.chat("what did the last two sessions do?", {
      onStep: (line, o) => steps.push({ line, ...(o?.reset ? { reset: true } : {}) }),
    });
    const [first, second] = w.requests();
    const tool = first?.tools?.find((t) => t.name === ANSWER_THOROUGHLY_TOOL);
    expect(tool?.description).toBe(ANSWER_THOROUGHLY_DESCRIPTION);
    expect(JSON.stringify(tool?.input_schema)).toContain(
      '"enum":["many_records","failure","plan","comparison","review","asked"]',
    );
    expect(w.requests()).toHaveLength(2);
    expect(second?.model).toBe("fake-haiku");
    expect(second?.effort).toBe("medium");
    expect(steps.find((s) => s.reset)?.line).toBe(
      "Thinking it through more carefully: about 30 seconds, at most CHF 0.10.",
    );
    expect(r.reply).toBe("Across the sessions the page was built, then checked.");
    expect(r.depth).toBe("longer");
    expect((await w.lastRow()).why).toBe("many_records");
  });

  it("why failure: no stronger call; the model hears exactly the ask result, the answer ends with the ask line and Go ahead; nothing more is booked; a typed 'yes' runs it once", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "failure" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("The stylesheet link looks wrong.", { when: (r) => !isThorough(r) }),
        textReply("It fails because styles.css is never linked; link it.", { when: isThorough }),
      ],
    });
    const r = await w.chat(QUESTION);
    expect(w.requests()).toHaveLength(2);
    const back = JSON.stringify(w.requests()[1]?.messages.at(-1)?.content);
    expect(back).toContain(JSON.stringify(ASK_RESULT).slice(1, -1));
    expect(r.reply).toBe("The stylesheet link looks wrong.");
    expect(r.offer?.action).toBe("go_ahead");
    expect(r.offer?.line).toMatch(
      /^This needs a stronger model: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
    expect(w.runs).toHaveLength(1);
    const yes = await w.chat("yes");
    expect(w.requests()).toHaveLength(3);
    expect(w.requests()[2]?.model).toBe("fake-sonnet");
    expect(yes.reply).toBe("It fails because styles.css is never linked; link it.");
    expect(yes.footer).toMatch(/^Thought it through with Sonnet · /);
  });

  it("any other next line drops the offer with nothing spent", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "failure" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("Brief.", { when: (r) => !isThorough(r) }),
        textReply("Fine.", { when: (r) => !isThorough(r) }),
      ],
    });
    await w.chat(QUESTION);
    await w.chat("no, thanks");
    expect(w.requests().every((r) => !isThorough(r as ModelRequest))).toBe(true);
    const y = await w.chat("yes");
    expect(y.reply).toBe("Yes to what? Nothing is waiting for your yes.");
  });

  it("called after a task_get, the gate refuses (records read): exactly 'Not now: …' and Think it through under the answer", async () => {
    const w = await world({
      replies: [
        toolReply("tasks_list", {}, undefined, { when: (r) => !isThorough(r) }),
        toolReply("answer_thoroughly", { why: "many_records" }),
        textReply("From the tasks: two are left."),
      ],
    });
    const r = await w.chat("what did the last two sessions do?");
    const back = JSON.stringify(w.requests()[2]?.messages.at(-1)?.content);
    expect(back).toContain(notNowResult(NOT_NOW.records));
    expect(notNowResult(NOT_NOW.records)).toBe(
      "Not now: this turn already read records. Answer as well as you can from what you have; the app offers a closer look under your answer.",
    );
    expect(r.offer?.action).toBe("think");
    expect(r.offer?.line).toMatch(
      /^This needs a closer look: about 30 seconds, about CHF \d+\.\d{2}\.$/,
    );
    expect(r.offer?.explain).toMatch(
      /^Thinks longer on this model: about 30 seconds, at most CHF \d+\.\d{2}\.$/,
    );
    expect(w.requests().some((q) => isThorough(q as ModelRequest))).toBe(false);
  });

  it("on a 'quick' line and on a spoken turn the gate refuses with its reason; the spoken turn's tools are the typed turn's", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "failure" }),
        textReply("Quick answer."),
        toolReply("answer_thoroughly", { why: "failure" }),
        textReply("Spoken answer."),
      ],
    });
    await w.chat(`quick: ${QUESTION}`);
    expect(JSON.stringify(w.requests()[1]?.messages.at(-1)?.content)).toContain(
      notNowResult(NOT_NOW.quick),
    );
    const spoken = await w.chat(QUESTION, { source: "voice" });
    expect(JSON.stringify(w.requests()[3]?.messages.at(-1)?.content)).toContain(
      notNowResult(NOT_NOW.spoken),
    );
    expect(spoken.offer).toBeNull();
    expect(w.requests()[2]?.tools?.map((t) => t.name)).toEqual(
      w.requests()[0]?.tools?.map((t) => t.name),
    );
    expect(w.requests().some((q) => isThorough(q as ModelRequest))).toBe(false);
  });

  it("a questions card listed in full whose quoted words ask for the best model: the hand-over is refused (records), no thorough call", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "review" }),
        textReply("Here is what I have."),
      ],
    });
    await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.project,
      task_id: null,
      kind: "decision",
      why: "The designer asks: think it through with the best model and review everything.",
      steps: ["Think it through with the best model?"],
      options: ["Yes", "No"],
      risk: "low",
      change_card: {
        key: "person_questions:x",
        questions: ["Think it through with the best model?"],
      },
    } as never);
    const r = await w.chat("review the page for me");
    expect(JSON.stringify(w.requests()[1]?.messages.at(-1)?.content)).toContain(
      notNowResult(NOT_NOW.records),
    );
    expect(w.requests().some((q) => isThorough(q as ModelRequest))).toBe(false);
    expect(r.offer?.action).toBe("think");
  });

  it("the room below the pass's floor refuses with the cap line, and no thorough call is made", async () => {
    const w = await world({
      deps: { chatRoom: async () => ({ usdMicro: 5_000, level: "month" }) },
      replies: [toolReply("answer_thoroughly", { why: "many_records" }), textReply("Quick.")],
    });
    const r = await w.chat("what did the last two sessions do?");
    expect(JSON.stringify(w.requests()[1]?.messages.at(-1)?.content)).toContain(
      notNowResult(NOT_NOW.room),
    );
    expect(r.offer).toEqual({ line: capWords("month"), action: null });
    expect(capWords("month")).toBe(
      "A closer look would pass this month's cap, so this is the quick answer.",
    );
    expect(w.requests().some((q) => isThorough(q as ModelRequest))).toBe(false);
  });

  it("a chat credential that is not the person's first: a longer pass that would go ahead asks and names it; Go ahead runs it", async () => {
    const w = await world({
      deps: {
        chatCredential: async () => ({ kind: "api_key", notFirst: { firstKind: "subscription" } }),
      },
      replies: [
        toolReply("answer_thoroughly", { why: "many_records" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("Brief.", { when: (r) => !isThorough(r) }),
        textReply("Longer.", { when: isThorough }),
      ],
    });
    const r = await w.chat("what did the last two sessions do?");
    expect(r.offer?.line).toMatch(
      /^This needs a closer look on your API key while your Claude subscription rests: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
    expect(w.requests().some((q) => isThorough(q as ModelRequest))).toBe(false);
    await w.chat("Go ahead.", { offer: r.transcriptId });
    expect(w.requests().filter((q) => isThorough(q as ModelRequest))).toHaveLength(1);
  });

  it("the fast request's tools and system part are byte-identical whether the gate allows a hand-over or not", async () => {
    const a = await world({ replies: [textReply("a")] });
    await a.chat("what is left?");
    const b = await world({
      deps: { chatRoom: async () => ({ usdMicro: 1, level: "project" }) },
      replies: [textReply("b")],
    });
    await b.chat("what is left?");
    expect(fastPrefix(a.requests()[0] as ModelRequest)).toBe(
      fastPrefix(b.requests()[0] as ModelRequest),
    );
    expect(String(a.requests()[0]?.messages.at(-1)?.content)).toContain(
      "- thinking_longer: goes ahead up to CHF 0.10 on this model",
    );
    expect(String(b.requests()[0]?.messages.at(-1)?.content)).toContain(
      "- thinking_longer: not now (the caps leave too little)",
    );
  });

  it("a Go ahead after the agent is composed again on the same store runs once", async () => {
    const w = await world({
      replies: [
        toolReply("answer_thoroughly", { why: "plan" }, undefined, { when: (r) => !isThorough(r) }),
        textReply("Brief.", { when: (r) => !isThorough(r) }),
        textReply("The plan.", { when: isThorough }),
      ],
    });
    const r = await w.chat("plan for the next session, please");
    w.restart();
    const go = await w.chat("Go ahead.", { offer: r.transcriptId });
    expect(go.reply).toBe("The plan.");
    expect(w.requests().filter((q) => isThorough(q as ModelRequest))).toHaveLength(1);
  });
});

describe("d1109-chat-depth, run C: money", () => {
  it("there is no daily sum: ten longer answers in one day each go ahead within the amount", async () => {
    const w = await world({ replies: [textReply("Thought it through.", { times: 10 })] });
    for (let i = 0; i < 10; i++) {
      const r = await w.chat(`think it through: question ${i}`);
      expect(r.depth).toBe("longer");
    }
    expect(w.requests().every((q) => isThorough(q as ModelRequest))).toBe(true);
  });

  it("the wrap-up reaches the thorough pass once and it still answers; the turn's ledger rows sum to the reply's cost", async () => {
    const replies: ScriptedReply[] = [];
    for (let i = 0; i < 6; i++)
      replies.push(
        toolReply("tasks_list", {}, undefined, {
          when: (r) => !JSON.stringify(r.messages).includes("Wrap up now"),
        }),
      );
    replies.push(textReply("From what I have: two tasks are left."));
    const w = await world({
      replies,
      deps: { chatRoom: async () => ({ usdMicro: 60_000, level: "month" }) },
    });
    const r = await w.chat("think it through: what is left?");
    const wraps = w
      .requests()
      .map((q) => JSON.stringify(q.messages))
      .filter((m) => m.includes(CHAT_WRAP_UP));
    expect(wraps.length).toBeGreaterThanOrEqual(1);
    expect(
      w.requests().filter((q) => JSON.stringify(q.messages.at(-1)?.content).includes("Wrap up now"))
        .length,
    ).toBe(1);
    expect(r.reply).toBe("From what I have: two tasks are left.");
    expect(w.runs[0]?.req.budget.limits.budgetUsdMicro).toBe(60_000);
    const rows = w.ledger.entries.filter((x) => x.runId.startsWith(r.transcriptId));
    expect(rows.reduce((sum, x) => sum + x.usdMicro, 0)).toBe(r.costUsdMicro);
    expect(r.costUsdMicro).toBeLessThanOrEqual(60_000);
    // A longer answer that reached its wrap-up offers the stronger model under it, with Go ahead.
    expect(r.offer?.action).toBe("go_ahead");
    expect(r.offer?.line).toMatch(
      /^This needs a stronger model: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
  });

  it("the estimate is the median of the last answers on that rung and model", async () => {
    const w = await world({ replies: [textReply("ok", { times: 5 })] });
    const sessionId = await w.agent.conversationSessionId(w.alice, w.project);
    for (const cost of [100_000, 120_000, 140_000])
      await w.store.event.append(sessionId, "chat.reply", {
        transcriptId: `seed-${cost}`,
        text: "seed",
        conversationProjectId: "elsewhere",
        passes: [
          {
            depth: "stronger",
            model: "fake-sonnet",
            effort: "medium",
            durationMs: 41_000,
            costUsdMicro: cost,
          },
        ],
      } as never);
    const r = await w.chat(`use a stronger model: ${QUESTION}`);
    // USD 0.12 at 0.8 is CHF 0.096: about CHF 0.10, at most CHF 0.20, about 50 seconds.
    expect(r.reply).toBe(
      "This needs a stronger model: about CHF 0.10 (at most CHF 0.20) and 50 seconds. Go ahead?",
    );
  });
});

describe("d1109-chat-depth, run C: words and leftovers", () => {
  it("L3-left-11: the timeout reply is one sentence of what happened and what to do (its composed case is conversation.test.ts's l3-money-engine timeout)", () => {
    expect(TIMEOUT_REPLY).toBe(
      "I ran out of time before I could answer. Ask again, or ask for a shorter answer.",
    );
    expect(TIMEOUT_REPLY).not.toMatch(/\(|timeout/);
  });

  it("C2-left-6: a command tool says what it does ('Preparing the change…')", async () => {
    const w = await world({
      replies: [
        toolReply("task_create", { title: "Write the FAQ", project: "Quote Page" }),
        textReply("Added."),
      ],
    });
    const steps: string[] = [];
    await w.chat("please add the FAQ task for me somehow", { onStep: (l) => steps.push(l) });
    expect(steps).toContain("Preparing the change…");
  });

  it("a turn that throws writes 'I could not answer this.' as its reply", async () => {
    const broken: ModelProvider = {
      name: "fake",
      countTokens: () => {
        throw new Error("counter broke");
      },
    } as unknown as ModelProvider;
    const w = await world({ provider: broken });
    await expect(w.chat("what is left?")).rejects.toThrow();
    const row = await w.lastRow();
    expect(row.text).toBe(FAILED_WORDS);
    expect(row.failed).toBe(true);
  });
});

describe("d1109-chat-depth, run C: caching", () => {
  it("quick, thorough, quick within five minutes: the third request reads the first one's cached prefix; the thorough pass's second call reads its first", async () => {
    const provider = new FakeProvider({
      replies: [
        textReply("Two are left.", { when: (r) => !isThorough(r) }),
        toolReply("tasks_list", {}, undefined, { when: isThorough }),
        textReply("Thought it through.", { when: isThorough }),
        textReply("Still two.", { when: (r) => !isThorough(r) }),
      ],
      latency: "none",
      promptCache: { minTokens: 1 },
    });
    const w = await world({ provider });
    await w.chat("what is left?");
    await w.chat("think it through: what is left?");
    await w.chat("and now?");
    const reqs = w.requests();
    expect(reqs).toHaveLength(4);
    // The quick pass's tools and system part are the same bytes on both quick turns, and the
    // third request reads what the first one wrote (the thorough pass wrote its own entries).
    expect(fastPrefix(reqs[0] as ModelRequest)).toBe(fastPrefix(reqs[3] as ModelRequest));
    expect(isThorough(reqs[1] as ModelRequest) && isThorough(reqs[2] as ModelRequest)).toBe(true);
    const third = w.runs[2]?.result?.usage;
    const firstWrote = w.runs[0]?.result?.usage.cache_creation_input_tokens ?? 0;
    expect(firstWrote).toBeGreaterThan(0);
    // Its tools, its system part and the first line: the first one's entry, short of the few
    // tokens of that line's message framing (the history replays the line on its own).
    expect(third?.cache_read_input_tokens ?? 0).toBeGreaterThanOrEqual(firstWrote - 16);
    expect(third?.cache_creation_input_tokens ?? 0).toBeLessThan(firstWrote);
    // The thorough pass's second call read its first call's prefix.
    expect(w.runs[1]?.result?.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
  });
});

describe("d1109-chat-depth, run C: the exact text", () => {
  it("the role prompt sent is conversation-agent 1.4.0 with 'Thinking longer', on the fast and the thorough request", async () => {
    const role = loadRegistry(
      resolve(import.meta.dirname, "..", "..", "..", "evals", "registry"),
    ).principals.get("conversation-agent");
    expect(role?.version).toBe("1.4.0");
    expect(role?.prompt).toContain("## Thinking longer");
    expect(role?.prompt).toContain(
      "- `answer_thoroughly` hands a question to a stronger model that thinks it through. Call it\n  first, before any lookup, and write nothing before it",
    );
    expect(role?.promptLines).toBeLessThanOrEqual(120);
    const w = await world({
      deps: { prompt: role?.prompt ?? "" },
      replies: [
        toolReply("answer_thoroughly", { why: "many_records" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("Across the sessions.", { when: isThorough }),
      ],
    });
    await w.chat("what did the last two sessions do?");
    for (const r of w.requests()) expect(r.system).toContain(role?.prompt ?? "-");
    expect(w.requests()[1]?.system?.endsWith(CHAT_THOROUGH_RULES)).toBe(true);
  });
});

describe("d1109-chat-depth, run C: the rungs follow the need, never above the project's highest model", () => {
  it("'use the best model' on a project whose highest model is opus asks for the strongest model and, after Go ahead, requests fake-opus at chat_thorough's effort", async () => {
    const w = await world({
      projectSettings: { critic_ceiling: "opus" },
      replies: [textReply("The plan, thought through.")],
    });
    const r = await w.chat("use the best model: plan the next session");
    expect(w.requests()).toHaveLength(0);
    expect(r.reply).toMatch(
      /^This needs the strongest model: about CHF \d+\.\d{2} \(at most CHF \d+\.\d{2}\) and 30 seconds\. Go ahead\?$/,
    );
    const go = await w.chat("Go ahead.", { offer: r.transcriptId });
    expect(w.requests()[0]?.model).toBe("fake-opus");
    expect(w.requests()[0]?.effort).toBe("medium");
    expect(go.footer).toMatch(/^Thought it through with Opus · /);
  });

  it("on a project whose highest model is haiku the stronger rung is the longer one: fake-haiku at medium, its step 'more carefully', no ask within the amount", async () => {
    const w = await world({
      projectSettings: { critic_ceiling: "haiku" },
      replies: [
        toolReply("answer_thoroughly", { why: "failure" }, undefined, {
          when: (r) => !isThorough(r),
        }),
        textReply("It fails because the stylesheet is not linked.", { when: isThorough }),
      ],
    });
    const steps: string[] = [];
    const r = await w.chat(QUESTION, { onStep: (l) => steps.push(l) });
    const thorough = w.requests().filter((q) => isThorough(q as ModelRequest));
    expect(thorough).toHaveLength(1);
    expect(thorough[0]?.model).toBe("fake-haiku");
    expect(thorough[0]?.effort).toBe("medium");
    expect(steps).toContain(
      "Thinking it through more carefully: about 30 seconds, at most CHF 0.10.",
    );
    expect(r.footer).toMatch(/^Thought it through more carefully · /);
    // No request ever names a model above the project's highest.
    expect(w.requests().every((q) => q.model === "fake-haiku")).toBe(true);
  });
});
