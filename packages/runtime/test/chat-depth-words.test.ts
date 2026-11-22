import { describe, expect, it } from "vitest";
import {
  askLine,
  CHAT_THOROUGH_RULES,
  CHAT_WRAP_UP,
  CLOSED_WORDS,
  capWords,
  chfSpent,
  closerLookWords,
  depthWords,
  FAILED_WORDS,
  failureReply,
  footerWords,
  handOverStep,
  needOfLine,
  offersInWords,
  type PassFigures,
  STOP_EXPLAIN,
  secondsWords,
  stoppedWords,
  TIMEOUT_REPLY,
  thinkItThroughExplain,
  thinkingLongerFact,
  withoutWordsOffer,
} from "../src/conversation/depth.ts";

/**
 * d1109-chat-depth (run C): the person's phrases and every sentence about a longer answer, word
 * for word (design §5: one sentence read at a glance, CHF only, no ids, no raw states).
 */

const f = (over: Partial<PassFigures> = {}): PassFigures => ({
  rung: "stronger",
  tier: "sonnet",
  sameModel: false,
  // USD 0.1875 and 0.375 at 0.8: CHF 0.15 and 0.30.
  estimateUsdMicro: 187_500,
  atMostUsdMicro: 375_000,
  seconds: 20,
  chfPerUsd: 0.8,
  ...over,
});

describe("d1109-chat-depth, run C: the person's phrases", () => {
  it.each([
    ['think it through: why does "Style the page" keep failing?', "longer"],
    ["take your time and compare the two plans", "longer"],
    ["what went wrong, be thorough", "longer"],
    ["denk gründlich nach: was fehlt noch?", "longer"],
    ['use a stronger model: why does "Style the page" keep failing?', "stronger"],
    ["use Sonnet: what failed?", "stronger"],
    ["use the best model: plan the next session", "best"],
    ["quick: what is left?", "quick"],
    ["briefly, what failed?", "quick"],
  ] as const)("%s asks %s", (line, ask) => {
    expect(depthWords(line).ask).toBe(ask);
  });

  it.each([
    "add a task: be thorough with the tests",
    'why did "Think harder" fail?',
    "what is left?",
  ])("%s asks nothing", (line) => {
    expect(depthWords(line).ask).toBeNull();
  });

  it("a phrase alone is bare: it re-asks the previous line", () => {
    expect(depthWords("think harder")).toEqual({ ask: "longer", bare: true });
    expect(depthWords("Think it through.")).toEqual({ ask: "longer", bare: true });
    expect(depthWords("think it through: what failed?")).toEqual({ ask: "longer", bare: false });
  });
});

describe("d1109-chat-depth, run C: the sentences", () => {
  it("the ask lines (a stronger model, the strongest, a closer look, another credential, the Claude plan)", () => {
    expect(askLine(f())).toBe(
      "This needs a stronger model: about CHF 0.15 (at most CHF 0.30) and 20 seconds. Go ahead?",
    );
    expect(askLine(f({ rung: "best", tier: "opus", seconds: 40 }))).toBe(
      "This needs the strongest model: about CHF 0.15 (at most CHF 0.30) and 40 seconds. Go ahead?",
    );
    expect(askLine(f({ rung: "longer", tier: "haiku", sameModel: true, seconds: 40 }))).toBe(
      "This needs a closer look: about CHF 0.15 (at most CHF 0.30) and 40 seconds. Go ahead?",
    );
    expect(
      askLine(
        f({
          rung: "longer",
          sameModel: true,
          estimateUsdMicro: 37_500,
          atMostUsdMicro: 75_000,
          credential: { kind: "api_key", notFirst: { firstKind: "subscription" } },
        }),
      ),
    ).toBe(
      "This needs a closer look on your API key while your Claude subscription rests: about CHF 0.03 (at most CHF 0.06) and 20 seconds. Go ahead?",
    );
    expect(askLine(f({ credential: { kind: "subscription" } }))).toBe(
      "This needs a stronger model: about 20 seconds on your Claude plan (about CHF 0.15 at API prices). Go ahead?",
    );
  });

  it("the hand-over steps, at most 80 characters, no id", () => {
    const a = handOverStep({ ...f(), budgetUsdMicro: 375_000 });
    expect(a).toBe("Thinking it through with Sonnet: about 20 seconds, at most CHF 0.30.");
    const b = handOverStep({ ...f({ sameModel: true, rung: "longer" }), budgetUsdMicro: 125_000 });
    expect(b).toBe("Thinking it through more carefully: about 20 seconds, at most CHF 0.10.");
    const c = handOverStep({ ...f({ credential: { kind: "subscription" } }), budgetUsdMicro: 1 });
    expect(c).toBe("Thinking it through with Sonnet on your Claude plan: about 20 seconds.");
    for (const s of [a, b, c]) expect(s.length).toBeLessThanOrEqual(80);
  });

  it("the footers: model, time and CHF ('under CHF 0.01' below a centime; the plan in place of CHF)", () => {
    expect(
      footerWords({
        tier: "sonnet",
        sameModel: false,
        durationMs: 34_000,
        costUsdMicro: 75_000,
        chfPerUsd: 0.8,
      }),
    ).toBe("Thought it through with Sonnet · 34 s · CHF 0.06");
    expect(
      footerWords({
        tier: "haiku",
        sameModel: true,
        durationMs: 21_000,
        costUsdMicro: 25_000,
        chfPerUsd: 0.8,
      }),
    ).toBe("Thought it through more carefully · 21 s · CHF 0.02");
    expect(
      footerWords({
        tier: "haiku",
        sameModel: true,
        durationMs: 9_000,
        costUsdMicro: 5_000,
        chfPerUsd: 0.8,
      }),
    ).toBe("Thought it through more carefully · 9 s · under CHF 0.01");
    expect(
      footerWords({
        tier: "sonnet",
        sameModel: false,
        durationMs: 34_000,
        costUsdMicro: 75_000,
        chfPerUsd: 0.8,
        subscription: true,
      }),
    ).toBe("Thought it through with Sonnet · 34 s · on your Claude plan");
  });

  it("stopped, closer look, caps, Think it through, closed and failed lines; the facts' line; the setting's words", () => {
    expect(stoppedWords(25_000, 0.8)).toBe("You stopped this answer: CHF 0.02 spent.");
    expect(stoppedWords(1_000, 0.8)).toBe("You stopped this answer: under CHF 0.01 spent.");
    expect(closerLookWords({ seconds: 20, estimateUsdMicro: 25_000, chfPerUsd: 0.8 })).toBe(
      "This needs a closer look: about 20 seconds, about CHF 0.02.",
    );
    expect(capWords("month")).toBe(
      "A closer look would pass this month's cap, so this is the quick answer.",
    );
    expect(capWords("project")).toBe(
      "A closer look would pass this project's budget, so this is the quick answer.",
    );
    expect(capWords("plan")).toBe(
      "A closer look would pass the share of your Claude plan Forerunner may use, so this is the quick answer.",
    );
    expect(thinkItThroughExplain({ seconds: 20, atMostUsdMicro: 50_000, chfPerUsd: 0.8 })).toBe(
      "Thinks longer on this model: about 20 seconds, at most CHF 0.04.",
    );
    expect(
      thinkItThroughExplain({
        seconds: 20,
        atMostUsdMicro: 50_000,
        chfPerUsd: 0.8,
        credential: { kind: "subscription" },
      }),
    ).toBe(
      "Thinks longer on this model: about 20 seconds on your Claude plan, at most CHF 0.04 at API prices.",
    );
    expect(CLOSED_WORDS).toBe("Forerunner closed before answering this.");
    expect(FAILED_WORDS).toBe("I could not answer this.");
    expect(STOP_EXPLAIN).toBe("Stops this answer. Changes it already made stay, each with Undo.");
    expect(
      thinkingLongerFact({ state: "goes_ahead", amountUsdMicro: 125_000, chfPerUsd: 0.8 }),
    ).toBe(
      // l4-chat-depth (L4-chat-202): an available line says who acts.
      "available: call answer_thoroughly; the app goes ahead up to CHF 0.10 on this model",
    );
    expect(thinkingLongerFact({ state: "asks" })).toBe(
      "available: call answer_thoroughly; the app asks the person with the cost (never ask in your own words)",
    );
    expect(thinkingLongerFact({ state: "spoken" })).toBe("not on a spoken turn");
    expect(thinkingLongerFact({ state: "room" })).toBe("not now (the caps leave too little)");
    expect(secondsWords(55)).toBe("a minute");
    expect(secondsWords(21)).toBe("30 seconds");
    expect(chfSpent(0, 0.8)).toBe("under CHF 0.01");
  });

  it("the model-facing texts", () => {
    expect(CHAT_WRAP_UP).toBe(
      "Wrap up now: make no more lookups. Answer from what you have, and say in one sentence what you could not check.",
    );
    // l4-chat-depth (L4-chat-203): the rules start by saying the pass is the closer look itself
    // (the whole text is asserted in chat-depth.test.ts "L4-chat-203").
    expect(
      CHAT_THOROUGH_RULES.startsWith("# Thinking it through\nYou are the closer look: "),
    ).toBe(true);
  });
});

describe("l4-cred-engine, run L4 (L4-creds-4): a chat answer that did not complete", () => {
  // Every code a chat run can end with: one sentence each, never the error's own message.
  const table: [Parameters<typeof failureReply>[0], string, boolean][] = [
    [{ code: "timeout" }, TIMEOUT_REPLY, true],
    [
      { code: "budget_exceeded", level: "month" },
      "This month's cap is reached, so I have not answered.",
      false,
    ],
    [
      { code: "budget_exceeded", level: "project" },
      "This project's budget is reached, so I have not answered.",
      false,
    ],
    [
      { code: "budget_exceeded", source: "plan" },
      "The share of your Claude plan Forerunner may use is reached, so I have not answered.",
      false,
    ],
    [
      { code: "budget_exceeded", level: "run" },
      "This answer would spend more than a chat answer may, so I stopped it; ask a shorter question.",
      false,
    ],
    [
      { code: "provider_rate_limit" },
      "Claude is busy right now, so I have not answered; ask again in a minute.",
      true,
    ],
    [{ code: "provider_error" }, "Claude did not answer this time; ask again in a moment.", true],
    [
      { code: "provider_auth" },
      "Anthropic refused the credential, so I have not answered; check it in Settings.",
      false,
    ],
    [
      { code: "provider_usage_limit" },
      "The credential is at its limit, so I have not answered; ask again after its reset.",
      false,
    ],
    [
      { code: "unavailable" },
      "No credential can answer right now, so I have not answered; check Settings.",
      false,
    ],
    [{ code: "killed" }, "This answer was cut off before it finished; ask again.", true],
    [
      { code: "step_cap_exceeded" },
      "This answer took more steps than one answer may, so I stopped it; ask a narrower question.",
      false,
    ],
    [
      { code: "injection_suspected" },
      "Something I read looked like instructions to me, so I stopped this answer and changed nothing.",
      false,
    ],
    [{ code: "internal" }, "I could not answer this; ask again.", true],
    [{ code: "validation" }, "I could not answer this; ask again.", true],
    [null, "I could not answer this; ask again.", true],
  ];
  it.each(table)("%o reads its own sentence", (error, text, askAgain) => {
    expect(failureReply(error)).toEqual({ text, askAgain });
  });

  it("never quotes the error's message", () => {
    const said = failureReply({
      code: "provider_error",
      message: "Internal server error at /v1/messages (req_123)",
    } as never);
    expect(said.text).not.toMatch(/Internal|req_|v1|\(/);
  });
});

describe("l4-chat-depth, run L4: the lines the app reads itself (L4-chat-202)", () => {
  it("needOfLine finds a failure, a plan, a comparison, a review or many sessions, outside quotes, in English and German", () => {
    expect(
      needOfLine('why does "Write the welcome page" keep failing and what should I change?'),
    ).toBe("failure");
    expect(needOfLine("why did the last session fail?")).toBe("failure");
    expect(needOfLine("warum scheitert die Seite immer?")).toBe("failure");
    expect(needOfLine("make a plan for the next two sessions")).toBe("plan");
    expect(needOfLine("mach einen Plan für morgen")).toBe("plan");
    expect(needOfLine("compare the two ways to style the page")).toBe("comparison");
    expect(needOfLine("review the README for me")).toBe("review");
    expect(needOfLine("what did the last two sessions do?")).toBe("many_records");
    expect(needOfLine("what is left?")).toBeNull();
    expect(needOfLine("what is in review?")).toBeNull();
    expect(needOfLine('what is "Plan for the next two sessions" waiting for?')).toBeNull();
    expect(needOfLine('add a task: "Compare the logos"')).toBeNull();
  });

  it("offersInWords reads a question that offers a stronger model or a hand-over; withoutWordsOffer takes those sentences out", () => {
    const live =
      "This plan needs the stronger model, which costs more and asks you first. Should I go ahead?";
    expect(offersInWords(live)).toBe(true);
    expect(withoutWordsOffer(live)).toBe("");
    expect(offersInWords("Sonnet is a stronger model than Haiku.")).toBe(false);
    expect(offersInWords("Two tasks are left. Which do you want first?")).toBe(false);
    expect(withoutWordsOffer("It fails because the file is missing. Should I go ahead?")).toBe(
      "It fails because the file is missing.",
    );
    expect(
      withoutWordsOffer("It fails.\n\nTo fix it:\n- Add the file.\n\nWant me to think it through?"),
    ).toBe("It fails.\n\nTo fix it:\n- Add the file.");
  });
});
