import { describe, expect, it } from "vitest";
import {
  estimateCallUsdMicro,
  LOCAL_BUDGET_SOURCE,
  SessionBudget,
} from "../src/enforcement/budget.ts";

const mk = (cap = 1_000_000) =>
  new SessionBudget({
    sessionId: "s",
    budgetUsdMicro: cap,
    stepCap: 3,
    deadlineMs: 10_000,
    reserveShare: 0.2,
  });

describe("session budget", () => {
  it("blocks a call that would exceed the run cap", () => {
    const b = mk();
    b.record("r1", 900);
    expect(() => b.precheck("r1", 1000, 200, "work")).toThrow(/run budget would be exceeded/);
    expect(b.precheck("r1", 1000, 100, "work").decision).toBe("allow");
  });

  it("blocks at 100% of the session cap and flags finish-current at 80%", () => {
    const b = mk(1000);
    expect(b.precheck("r1", 10_000, 700, "work").decision).toBe("allow");
    b.record("r1", 700);
    expect(b.noNewWork).toBe(false);
    // 700 + 100 = 800 = 80% -> finish current
    expect(b.precheck("r1", 10_000, 100, "review").decision).toBe("finish_current");
    expect(b.noNewWork).toBe(true);
    b.record("r1", 299);
    expect(() => b.precheck("r1", 10_000, 2, "review")).toThrow(/session budget would be exceeded/);
  });

  it("marks its own refusals with LOCAL_BUDGET_SOURCE, so an outer cap's can be told apart", () => {
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as { code?: string; details?: Record<string, unknown> };
      }
      return null;
    };
    const run = mk();
    run.record("r1", 900);
    expect(refusal(() => run.precheck("r1", 1000, 200, "work"))).toMatchObject({
      code: "budget_exceeded",
      details: { level: "run", source: LOCAL_BUDGET_SOURCE },
    });
    const session = mk(1000);
    session.record("r1", 999);
    expect(refusal(() => session.precheck("r1", 10_000, 2, "review"))).toMatchObject({
      code: "budget_exceeded",
      details: { level: "session", source: LOCAL_BUDGET_SOURCE },
    });
  });

  it("keeps the review reserve: work cannot use the last 20%", () => {
    const b = mk(1000);
    b.record("r1", 700);
    // 700 + 150 = 850 > 800 work ceiling -> finish_current for work
    expect(b.precheck("r1", 10_000, 150, "work").decision).toBe("finish_current");
    // review may use it
    const b2 = mk(1000);
    b2.record("r1", 700);
    expect(b2.precheck("r1", 10_000, 50, "review").decision).toBe("allow");
  });

  it("enforces the step cap and the wall clock", () => {
    const b = mk();
    b.step();
    b.step();
    b.step();
    expect(() => b.step()).toThrow(/step cap 3 reached/);
    expect(() => b.checkWallClock(9_999)).not.toThrow();
    expect(() => b.checkWallClock(10_000)).toThrow(/wall-clock/);
  });

  it("quiet room: the largest estimate precheck admits without setting no-new-work", () => {
    const b = mk(5_000_000);
    b.record("r0", 3_600_000);
    const room = b.quietRoomUsdMicro("r1", 5_000_000, "review");
    expect(room).toBe(399_999);
    // One more micro-USD reaches the 80% line; the room itself leaves the session as it was.
    const at = mk(5_000_000);
    at.record("r0", 3_600_000);
    expect(at.precheck("r1", 5_000_000, room + 1, "review").decision).toBe("finish_current");
    expect(at.noNewWork).toBe(true);
    expect(b.precheck("r1", 5_000_000, room, "review").decision).toBe("allow");
    expect(b.noNewWork).toBe(false);
    // The run cap bounds it too.
    expect(b.quietRoomUsdMicro("r1", 100_000, "review")).toBe(100_000);
  });

  it("quiet room for work stops at the review reserve", () => {
    const b = new SessionBudget({
      sessionId: "s",
      budgetUsdMicro: 1_000_000,
      stepCap: 3,
      deadlineMs: 10_000,
      reserveShare: 0.25,
    });
    b.record("r0", 500_000);
    expect(b.quietRoomUsdMicro("r1", 1_000_000, "work")).toBe(250_000);
    expect(b.precheck("r1", 1_000_000, 250_000, "work").decision).toBe("allow");
    expect(b.quietRoomUsdMicro("r1", 1_000_000, "review")).toBe(299_999);
  });

  it("quiet room once no-new-work is set: only the caps bound it", () => {
    const b = mk(1_000_000);
    b.record("r0", 850_000);
    expect(b.noNewWork).toBe(true);
    expect(b.quietRoomUsdMicro("r1", 1_000_000, "review")).toBe(150_000);
    b.record("r0", 200_000);
    expect(b.quietRoomUsdMicro("r1", 1_000_000, "review")).toBe(0);
  });

  // ADR 0112 (budget-stop): each run has one wrap-up line, its cap less a reserve (the larger of
  // a fifth of the cap and the worst case of two calls, the run's first call's estimate twice).
  // Before, the only 80% line was the session's, and the run was never told.
  it("a run gets one wrap-up line at its cap less the reserve, and the wrap-up once", () => {
    const b = mk(10_000_000);
    const first = b.precheck("r1", 1_000_000, 100_000, "work");
    expect(first).toEqual({
      decision: "allow",
      line: {
        capUsdMicro: 1_000_000,
        reserveUsdMicro: 200_000,
        lineUsdMicro: 800_000,
        firstCallUsdMicro: 100_000,
        saveOnly: false,
      },
    });
    b.record("r1", 650_000);
    // 650 000 + 100 000 stays at the line: nothing yet, and the line is told only once.
    expect(b.precheck("r1", 1_000_000, 100_000, "work")).toEqual({ decision: "allow" });
    b.record("r1", 100_000);
    // 750 000 + 100 000 would go past it: this call brings the wrap-up, once.
    expect(b.precheck("r1", 1_000_000, 100_000, "work").decision).toBe("wrap_up");
    b.record("r1", 100_000);
    expect(b.precheck("r1", 1_000_000, 100_000, "work").decision).toBe("allow");
    // Another run has its own line.
    expect(b.precheck("r2", 1_000_000, 100_000, "work").line?.lineUsdMicro).toBe(800_000);
  });

  it("the reserve is two calls when they cost more than a fifth of the cap", () => {
    const b = mk(10_000_000);
    expect(b.precheck("r1", 1_000_000, 300_000, "work").line).toEqual({
      capUsdMicro: 1_000_000,
      reserveUsdMicro: 600_000,
      lineUsdMicro: 400_000,
      firstCallUsdMicro: 300_000,
      saveOnly: false,
    });
  });

  it("a tiny budget has no room to wrap up: save only, and never a wrap-up", () => {
    const b = mk(10_000_000);
    // CHF 0.01 against a first call of about USD 0.0066: two calls are more than the cap.
    const first = b.precheck("r1", 12_500, 6_600, "work");
    expect(first.line).toEqual({
      capUsdMicro: 12_500,
      reserveUsdMicro: 13_200,
      lineUsdMicro: 0,
      firstCallUsdMicro: 6_600,
      saveOnly: true,
    });
    b.record("r1", 3_000);
    expect(b.precheck("r1", 12_500, 6_600, "work").decision).toBe("allow");
    b.record("r1", 3_000);
    // The run cap still stops it: the run pauses at its budget.
    expect(() => b.precheck("r1", 12_500, 6_600, "work")).toThrow(/run budget would be exceeded/);
  });

  it("a line that leaves no room for the first call is save only too", () => {
    const b = mk(10_000_000);
    // Reserve 2 x 4 000 = 8 000; the line at 12 000 - 8 000 = 4 000 holds one call exactly.
    expect(b.precheck("r1", 12_000, 4_000, "work").line?.saveOnly).toBe(true);
    expect(b.precheck("r2", 12_001, 4_000, "work").line?.saveOnly).toBe(false);
  });

  // Review of budget-stop: a budget below its first call's worst case (live check 3's CHF 0.02
  // on the coder's Sonnet: 4 096 output tokens alone cost USD 0.041) was refused before the line
  // was fixed, so the run said no budget line at all, not even "save only".
  it("a first call refused at the run's cap still carries the run's save-only line", () => {
    const b = mk(10_000_000);
    let refused: unknown;
    try {
      b.precheck("r1", 25_000, 41_000, "work");
    } catch (e) {
      refused = e;
    }
    expect(refused).toMatchObject({
      code: "budget_exceeded",
      details: {
        level: "run",
        line: {
          capUsdMicro: 25_000,
          reserveUsdMicro: 82_000,
          lineUsdMicro: 0,
          firstCallUsdMicro: 41_000,
          saveOnly: true,
        },
      },
    });
    // Only the run's first call carries it: a later refusal says nothing new.
    const c = mk(10_000_000);
    c.precheck("r1", 25_000, 10_000, "work");
    c.record("r1", 20_000);
    let later: unknown;
    try {
      c.precheck("r1", 25_000, 10_000, "work");
    } catch (e) {
      later = e;
    }
    expect(later).toMatchObject({ code: "budget_exceeded" });
    expect((later as { details: Record<string, unknown> }).details.line).toBeUndefined();
  });

  it("a review run has no wrap-up line", () => {
    const b = mk(10_000_000);
    expect(b.precheck("r1", 1_000_000, 900_000, "review")).toEqual({ decision: "allow" });
    expect(b.lineFor("r1", 1_000_000, 100_000, "review")).toBeUndefined();
  });

  // Review of 'web-search': a call that may search carries ten searches' worst case (USD 0.60),
  // which fixed the line (reserve 2 x 0.66 of a USD 1.00 cap: save only) and decided the wrap-up.
  // The line estimate is the call's tokens alone; the caps still get the whole estimate.
  it("the line and the wrap-up follow the call's estimate without its searches; the caps the whole of it", () => {
    const b = mk(10_000_000);
    // Before the first call, lineFor says the line that call fixes, and fixes nothing.
    expect(b.lineFor("r1", 1_000_000, 60_000, "work")?.lineUsdMicro).toBe(800_000);
    expect(b.wrapUpLineOf("r1")).toBeUndefined();
    expect(b.precheck("r1", 1_000_000, 660_000, "work", 60_000).line).toEqual({
      capUsdMicro: 1_000_000,
      reserveUsdMicro: 200_000,
      lineUsdMicro: 800_000,
      firstCallUsdMicro: 60_000,
      saveOnly: false,
    });
    expect(b.lineFor("r1", 1_000_000, 999_000, "work")?.lineUsdMicro).toBe(800_000);
    b.record("r1", 600_000);
    // 600 000 + 60 000 stays below the line, though 600 000 + 360 000 would not: no wrap-up.
    expect(b.precheck("r1", 1_000_000, 360_000, "work", 60_000).decision).toBe("allow");
    b.record("r1", 200_000);
    expect(b.precheck("r1", 1_000_000, 60_000, "work", 60_000).decision).toBe("wrap_up");
    // The run's cap is checked on the whole estimate.
    expect(() => b.precheck("r1", 1_000_000, 260_000, "work", 60_000)).toThrow(
      /run budget would be exceeded/,
    );
    // A run first seen with spend booked has no line to read either.
    b.record("r9", 1);
    expect(b.lineFor("r9", 1_000_000, 60_000, "work")).toBeUndefined();
  });

  it("estimates conservatively from input tokens and max output", () => {
    expect(
      estimateCallUsdMicro(1_000_000, 1_000, { inputPerMtokUsd: 3, outputPerMtokUsd: 15 }),
    ).toBe(3_015_000);
  });
});
