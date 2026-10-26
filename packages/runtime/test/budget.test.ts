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

  it("estimates conservatively from input tokens and max output", () => {
    expect(
      estimateCallUsdMicro(1_000_000, 1_000, { inputPerMtokUsd: 3, outputPerMtokUsd: 15 }),
    ).toBe(3_015_000);
  });
});
