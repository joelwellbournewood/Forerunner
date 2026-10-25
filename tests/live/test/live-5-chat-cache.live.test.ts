import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import {
  collectStream,
  MODE_DEFAULTS,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  modelIdFor,
  type StreamEvent,
} from "@forerunner/runtime";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { DRY_RUN_PRICING, dryRunCredentials, PrefixCacheFake } from "../src/dry-run.ts";
import { composeLive, type LiveHarness, RM_TREE } from "../src/harness.ts";
import { liveEnabled, reportDir, SKIP_REASON, writeReport } from "../src/report.ts";
import { ms, type Summary, summarize } from "../src/stats.ts";

/**
 * Text chat first token with a warm prompt cache (requirement D.9). The phase 1 live case
 * measures one composed chat turn per run, so every sample it ever took was a cache *write*:
 * the provider caches the tools and system prefix of a request and only a later request with
 * the same prefix reads it, which is what shortens the time to first token. Here the composed
 * `ConversationAgent` (the daemon's wiring through `composeLive`) answers one warm-up turn and
 * then WARM_TURNS turns on Haiku against the same project in quick succession. Per turn: the
 * first token, and the first model call's cache read and cache write tokens. Asserted: every
 * warm turn reads the cache, and the warm median first token is under the text chat target.
 *
 * The dry run below runs the same measure on a scripted provider wrapped in a prefix-cache
 * stand-in (`PrefixCacheFake`), so an unstable prefix in the composed runtime fails offline.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);
export const WARM_TURNS = 6;

/** Short questions the command parser does not understand, so each goes to the model. */
const QUESTIONS = [
  "In at most ten words: what is this project's goal?",
  "In at most ten words: is anything running right now?",
  "In at most ten words: do I have open requests?",
  "In at most ten words: what stage is this project in?",
  "In at most ten words: any unread messages for me?",
  "In at most ten words: what should I look at next?",
  "In at most ten words: which project is active?",
];

export interface ChatCacheTurn {
  turn: number;
  warm: boolean;
  question: string;
  reply: string;
  ttftMs: number | null;
  /**
   * The turn's first model call (the one whose first token the human waits for): its uncached
   * input tokens, cache read and cache write. Together they tell a miss apart from an unstable
   * prefix: a prefix under the minimum is neither read nor written (all input), an unstable
   * one is written again on every warm turn.
   */
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** The turn's model calls: those labelled `conversation` from the turn's own run. */
  modelCalls: number;
  /** The effort of each of the turn's model calls, in order. */
  efforts: (string | null)[];
  usd: number;
}

/** D.9: the chat answers on Haiku at effort low (the text_chat mode's defaults). */
export const CHAT_EFFORT = "low";

export interface ChatCacheSummary {
  warmTurns: number;
  ttft: Summary;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  warmWithCacheRead: number;
  usd: number;
  targetMs: number;
}

/** One warm-up turn and `warm` measured turns on the composed conversation agent. */
async function measureChatTurns(
  h: LiveHarness,
  warm: number,
  log: (line: string) => void,
  /** Runs before every turn after the first (the dry run moves its clock: time passes). */
  between?: () => Promise<void>,
): Promise<{ turns: ChatCacheTurn[]; summary: ChatCacheSummary }> {
  const conversation = h.app.conversation;
  if (!conversation) throw new Error("the composed runtime has no conversation agent");
  const projectId = await h.addProject({
    name: "Live chat cache",
    goal: "Measure the text chat first token with a warm prompt cache",
    budgetUsdMicro: 1_000_000,
  });
  const turns: ChatCacheTurn[] = [];
  for (let i = 0; i <= warm; i++) {
    if (i > 0) await between?.();
    const question = QUESTIONS[i % QUESTIONS.length] as string;
    const mark = h.provider.calls.length;
    const reply = await conversation.chat({
      humanId: h.app.human.id,
      agentId: h.app.agent.id,
      projectId,
      text: question,
    });
    // The turn's calls are the conversation's calls from this turn's run (the transcript id is
    // the run id), never whatever was recorded first: a background model call (a consolidation,
    // a critic) that lands in between is not measured in the turn's place.
    const calls = h.provider.calls
      .slice(mark)
      .filter((c) => c.label === "conversation" && c.runId === reply.transcriptId);
    const first = calls[0];
    const t: ChatCacheTurn = {
      turn: i,
      warm: i > 0,
      question,
      reply: reply.reply,
      ttftMs: reply.ttftMs,
      inputTokens: first?.tokensIn ?? 0,
      cacheRead: first?.cacheRead ?? 0,
      cacheWrite: first?.cacheWrite ?? 0,
      modelCalls: calls.length,
      efforts: calls.map((c) => c.effort),
      usd: Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
    };
    turns.push(t);
    log(
      `chat turn ${i}${t.warm ? "" : " (warm-up)"}: first token ${t.ttftMs === null ? "n/a" : ms(t.ttftMs)}, ` +
        `first call input ${t.inputTokens}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}, ` +
        `calls ${t.modelCalls}, effort ${t.efforts.join("/") || "n/a"}, USD ${t.usd}`,
    );
  }
  const warmTurns = turns.filter((t) => t.warm);
  const summary: ChatCacheSummary = {
    warmTurns: warmTurns.length,
    ttft: summarize(warmTurns.flatMap((t) => (t.ttftMs === null ? [] : [t.ttftMs]))),
    cacheReadTokens: warmTurns.reduce((s, t) => s + t.cacheRead, 0),
    cacheWriteTokens: turns.reduce((s, t) => s + t.cacheWrite, 0),
    warmWithCacheRead: warmTurns.filter((t) => t.cacheRead > 0).length,
    usd: Math.round(turns.reduce((s, t) => s + t.usd, 0) * 1e6) / 1e6,
    targetMs: MODE_DEFAULTS.text_chat.targetMs,
  };
  log(
    `chat cache summary: warm n=${summary.warmTurns} first token median ${ms(summary.ttft.median)} ` +
      `p90 ${ms(summary.ttft.p90)} (target ${ms(summary.targetMs)}); warm turns with a cache read ` +
      `${summary.warmWithCacheRead} of ${summary.warmTurns}, cache read tokens ${summary.cacheReadTokens}, ` +
      `cache write tokens ${summary.cacheWriteTokens}; USD ${summary.usd}`,
  );
  return { turns, summary };
}

function expectWarmCache(turns: ChatCacheTurn[], summary: ChatCacheSummary): void {
  expect(turns).toHaveLength(WARM_TURNS + 1);
  for (const t of turns) {
    expect(t.reply.trim().length, `turn ${t.turn} answered`).toBeGreaterThan(0);
    expect(t.modelCalls, `turn ${t.turn} went to the model`).toBeGreaterThanOrEqual(1);
    expect(t.ttftMs, `turn ${t.turn} measured a first token`).not.toBeNull();
    // D.9: "Haiku, effort low". The recorded effort is what the request asked for.
    expect(t.efforts, `turn ${t.turn} ran at effort ${CHAT_EFFORT}`).toEqual(
      t.efforts.map(() => CHAT_EFFORT),
    );
  }
  // A warm turn reads the cache only if the prefix reaches Haiku 5.5's minimum cacheable
  // length, 512 tokens; a shorter prefix is processed without caching and no error is
  // returned. Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching,
  // "Cache limitations", the minimum cacheable prompt length per model (Claude API; Bedrock
  // lists its own).
  for (const t of turns.filter((x) => x.warm))
    expect(t.cacheRead, `warm turn ${t.turn} read the prompt cache`).toBeGreaterThan(0);
  expect(summary.ttft.n).toBe(WARM_TURNS);
  // Requirement D.9: "Text chat first token under 1 s median", on warm turns.
  expect(summary.ttft.median).toBeLessThan(MODE_DEFAULTS.text_chat.targetMs);
}

describe(`text chat first token with a warm prompt cache, live (D.9)${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let h: LiveHarness;
  let dir = "";
  let result: { turns: ChatCacheTurn[]; summary: ChatCacheSummary } | null = null;

  beforeAll(async () => {
    if (!LIVE) return;
    dir = reportDir();
    h = await composeLive();
    console.log(`live run ${h.run}; reports in ${dir}; ${budgetLine(h.budget)}`);
  });
  afterAll(async () => {
    if (!h) return;
    const file = writeReport(dir, "chat-cache-live", {
      run: h.run,
      date: h.app.clock.nowIso(),
      model: modelIdFor("haiku", "anthropic", h.app.modelConfig().ladder),
      ...(result ?? {}),
      budget: h.budget.snapshot(),
      totals: h.provider.totals(),
      calls: h.provider.calls,
    });
    console.log(`chat cache report: ${file}\n${budgetLine(h.budget)}`);
    await h.close();
  });

  live(
    `one warm-up and ${WARM_TURNS} composed chat turns on Haiku read the cache and meet the first-token target`,
    async () => {
      result = await measureChatTurns(h, WARM_TURNS, (line) => console.log(line));
      const haiku = modelIdFor("haiku", "anthropic", h.app.modelConfig().ladder);
      expect(h.provider.calls.every((c) => c.model.startsWith(haiku))).toBe(true);
      expect(h.provider.calls.filter((c) => c.status !== "ok")).toEqual([]);
      expect(h.budget.refusals).toEqual([]);
      expectWarmCache(result.turns, result.summary);
    },
  );
});

/** The label of the dry run's injected call: no runtime driver uses it. */
const BACKGROUND_LABEL = "dry-run background call";

/**
 * Wraps the dry run's provider: once armed, the next conversation call first sends one
 * unrelated call through the metered provider (`target`), so that call is recorded after the
 * turn's mark and before the turn's own first call, as a background model call would be. It
 * asks for a short uncached prefix at effort high: measured in the turn's place it would show
 * a warm turn with no cache read and the wrong effort.
 */
class BackgroundCallInjector implements ModelProvider {
  readonly name: string;
  target: ModelProvider | null = null;
  armed = false;
  injected = 0;

  constructor(readonly inner: ModelProvider) {
    this.name = inner.name;
  }

  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.armed && this.target && req.origin?.label === "conversation") {
      this.armed = false;
      this.injected++;
      await this.target.complete({
        model: req.model,
        system: "Summarise the day's notes.",
        messages: [{ role: "user", content: "notes" }],
        max_tokens: 64,
        effort: "high",
        cache: { system: true },
        origin: { label: BACKGROUND_LABEL, sessionId: "background", runId: "background" },
      });
    }
    yield* this.inner.stream(req);
  }

  complete(req: ModelRequest): Promise<ModelResponse> {
    return collectStream(
      this.stream(req),
      () => 0,
      () => 0,
    );
  }
}

describe("text chat cache measure, dry run (scripted provider, prefix-cache stand-in, no network)", () => {
  let h: LiveHarness;
  let ledgerDir = "";
  const clock = new SimulatedClock("2026-10-25T09:00:00Z");
  let injector: BackgroundCallInjector;

  beforeAll(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-chat-cache-"));
    injector = new BackgroundCallInjector(
      new PrefixCacheFake(
        new FakeProvider({
          mode: "script",
          clock,
          latency: "none",
          onNoMatch: "throw",
          replies: [textReply("Ready.", { times: Number.POSITIVE_INFINITY })],
        }),
        clock,
      ),
    );
    h = await composeLive({
      env: { FORERUNNER_LIVE_RUN: "dry-run-chat-cache" },
      clock,
      inner: injector,
      credentials: dryRunCredentials(),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd: 1, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
    });
    injector.target = h.provider;
  });
  afterAll(async () => {
    await h?.close();
    if (ledgerDir) rmSync(ledgerDir, RM_TREE);
  });

  it("the composed chat sends a stable prefix: the warm-up writes the cache, every warm turn reads it", async () => {
    const lines: string[] = [];
    let turn = 0;
    const { turns, summary } = await measureChatTurns(
      h,
      WARM_TURNS,
      (l) => lines.push(l),
      async () => {
        // Seconds pass between real turns; the volatile preamble's clock moves with them.
        await clock.advance(4_000);
        // Before warm turn 3, one unrelated model call lands after the turn's mark.
        if (++turn === 3) injector.armed = true;
      },
    );
    expect(injector.injected).toBe(1);
    const background = h.provider.calls.filter((c) => c.label === BACKGROUND_LABEL);
    expect(background).toHaveLength(1);
    expect(background[0]).toMatchObject({ cacheRead: 0, effort: "high" });
    expect(turns[3]?.modelCalls).toBe(1);
    expect(lines).toHaveLength(WARM_TURNS + 2);
    expect(lines[1]).toMatch(
      /^chat turn 1: first token [^,]+, first call input \d+, cache read [1-9]\d*, cache write 0, calls 1, effort low, USD /,
    );
    expect(lines.at(-1)).toMatch(/^chat cache summary: warm n=6 first token median/);
    expect(turns[0]?.cacheWrite).toBeGreaterThan(0);
    expect(turns[0]?.cacheRead).toBe(0);
    for (const t of turns.slice(1)) expect(t.cacheWrite).toBe(0);
    expect(summary.warmWithCacheRead).toBe(WARM_TURNS);
    expect(h.provider.calls.every((c) => c.model === "fake-haiku")).toBe(true);
    expect(h.budget.refusals).toEqual([]);
    expectWarmCache(turns, summary);
  });
});
