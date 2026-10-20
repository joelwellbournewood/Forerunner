import { describe, expect, it } from "vitest";
import { estimateCallUsdMicro, SessionBudget } from "../src/enforcement/budget.ts";

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

  it("estimates conservatively from input tokens and max output", () => {
    expect(
      estimateCallUsdMicro(1_000_000, 1_000, { inputPerMtokUsd: 3, outputPerMtokUsd: 15 }),
    ).toBe(3_015_000);
  });
});
