import { REVIEW_REFUSED, type RunResult } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import { credentialRunOutcome, refusedReviewError } from "../src/critic.ts";

/**
 * A review a limit or a credential refused before its verdict (ADR 0112 point 5, ADR 0100
 * point 9; leftovers of wave 7) is no verdict and no failed try: the critic throws a
 * `ForerunnerError` marked `REVIEW_REFUSED` that keeps the refusal's code and details, and the
 * Run row reads "Stopped at the usage limit" or "refused", never "Failed". The composed runtime
 * tests (budget-pause, credential-wait-session) run these through a session; this pins the two
 * mappings themselves (the review of leftovers7-session: they had no unit test).
 */
// The fields the two mappings read, and enough of the rest to read as a run's result.
const run = (over: Partial<RunResult>): RunResult =>
  ({
    runId: "run-1",
    outcome: "completed",
    finalText: "",
    messages: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    costUsdMicro: 1_234,
    modelCalls: 1,
    toolCalls: 0,
    ttftMs: [],
    durationMs: 10,
    injectionReports: [],
    finishCurrent: false,
    wrapUpSent: false,
    ...over,
  }) as RunResult;

describe("refusedReviewError: a refused review is no verdict", () => {
  it("a budget's refusal keeps its level, cap, spend and run, marked as a refused review", () => {
    const e = refusedReviewError(
      run({
        outcome: "budget_exceeded",
        error: {
          code: "budget_exceeded",
          message: "the project's budget has no room",
          level: "project",
          capUsdMicro: 12_500,
          source: "project",
        },
      }),
    );
    expect(e?.code).toBe("budget_exceeded");
    expect(e?.message).toBe("the project's budget has no room");
    expect(e?.details).toEqual({
      review: REVIEW_REFUSED,
      runId: "run-1",
      spentUsdMicro: 1_234,
      level: "project",
      source: "project",
      capUsdMicro: 12_500,
    });
  });

  it("a budget's refusal with no error still is one, with a plain message", () => {
    const e = refusedReviewError(run({ outcome: "budget_exceeded" }));
    expect(e?.code).toBe("budget_exceeded");
    expect(e?.message).toBe("the review's call was refused");
    expect(e?.details).toEqual({ review: REVIEW_REFUSED, runId: "run-1", spentUsdMicro: 1_234 });
  });

  it.each([
    ["provider_usage_limit", { resetAt: "2026-11-08T19:07:00Z", sourceId: "src-sub" }],
    ["provider_auth", { sourceId: "src-key" }],
    ["unavailable", {}],
  ])("a credential's refusal (%s) keeps its code, its reset and its source", (code, extra) => {
    const e = refusedReviewError(
      run({ outcome: "error", error: { code, message: `refused: ${code}`, ...extra } }),
    );
    expect(e?.code).toBe(code);
    expect(e?.details).toEqual({
      review: REVIEW_REFUSED,
      runId: "run-1",
      spentUsdMicro: 1_234,
      ...extra,
    });
  });

  it("any other end of the run is not a refusal: it still names the review", () => {
    expect(refusedReviewError(run({ outcome: "completed" }))).toBeNull();
    expect(
      refusedReviewError(run({ outcome: "error", error: { code: "internal", message: "boom" } })),
    ).toBeNull();
    expect(refusedReviewError(run({ outcome: "error" }))).toBeNull();
    expect(refusedReviewError(run({ outcome: "timeout" }))).toBeNull();
    expect(refusedReviewError(run({ outcome: "step_cap_exceeded" }))).toBeNull();
  });
});

describe("credentialRunOutcome: the Run row of a refused run never reads Failed", () => {
  it("a usage limit, or no credential that may serve, is usage_limit", () => {
    expect(
      credentialRunOutcome({
        outcome: "error",
        error: { code: "provider_usage_limit", message: "limit" },
      }),
    ).toBe("usage_limit");
    expect(
      credentialRunOutcome({ outcome: "error", error: { code: "unavailable", message: "none" } }),
    ).toBe("usage_limit");
  });

  it("a credential Anthropic refused is credential_refused", () => {
    expect(
      credentialRunOutcome({ outcome: "error", error: { code: "provider_auth", message: "401" } }),
    ).toBe("credential_refused");
  });

  it("a budget's refusal stays budget_exceeded, and any other error stays error", () => {
    expect(credentialRunOutcome({ outcome: "budget_exceeded" })).toBe("budget_exceeded");
    expect(credentialRunOutcome({ outcome: "completed" })).toBe("completed");
    expect(
      credentialRunOutcome({ outcome: "error", error: { code: "internal", message: "x" } }),
    ).toBe("error");
    expect(credentialRunOutcome({ outcome: "error" })).toBe("error");
  });
});
