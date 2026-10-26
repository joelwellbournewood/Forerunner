import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CapChecker,
  type CapScope,
  type Caps,
  DEFAULT_RESERVE_SHARE,
  FINISH_CURRENT_AT,
  normalizeCaps,
  STOP_AT,
} from "../src/caps.ts";
import { InMemoryLedger } from "../src/sink.ts";

const caps: Caps = {
  monthUsdMicro: 100_000_000,
  projectUsdMicro: 10_000_000,
  sessionUsdMicro: 1_000_000,
  taskUsdMicro: 500_000,
  runUsdMicro: 200_000,
};

const full: CapScope = {
  humanId: "alice",
  projectId: "p1",
  sessionId: "s1",
  taskId: "t1",
  runId: "r1",
};

describe("CapChecker", () => {
  let clock: SimulatedClock;
  let mem: InMemoryLedger;
  let checker: CapChecker;

  const spend = (usd: number, scope: Partial<CapScope> = {}, occurredAt?: string) =>
    mem.record({
      human_id: scope.humanId ?? "alice",
      project_id: scope.projectId ?? null,
      session_id: scope.sessionId ?? null,
      task_id: scope.taskId ?? null,
      run_id: scope.runId ?? null,
      billing_source_id: "alice-api",
      kind: "api",
      usd_micro: usd,
      chf_micro: Math.round(usd * 0.8),
      rate_chf_per_usd: 0.8,
      model: "claude-haiku-4-5",
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      occurred_at: occurredAt ?? clock.nowIso(),
    });

  beforeEach(() => {
    clock = new SimulatedClock("2026-10-20T10:00:00.000Z");
    mem = new InMemoryLedger(clock);
    checker = new CapChecker({ query: mem, clock, caps });
  });

  it("allows below 80% (79.9% boundary) for both phases", async () => {
    const scope = { humanId: "alice", sessionId: "s1" };
    for (const phase of ["work", "review"] as const) {
      const c = await checker.check(scope, 799_000, { phase });
      expect(c.decision).toBe("allow");
      expect(c.level).toBe("session");
      expect(c.ratio).toBeCloseTo(0.799, 6);
      expect(c.message).toContain("within caps");
    }
  });

  it("finishes the current task at exactly 80%", async () => {
    const c = await checker.check({ humanId: "alice", sessionId: "s1" }, 800_000, {
      phase: "review",
    });
    expect(c.decision).toBe("finish_current");
    expect(c.level).toBe("session");
    expect(c.spent).toBe(0);
    expect(c.cap).toBe(1_000_000);
    expect(c.remaining).toBe(1_000_000);
    expect(c.message).toBe(
      "session cap USD 0.80 of USD 1.00 after this run (80%): finish the current task, start no new work",
    );
  });

  it("stops at 100% and beyond, counting spend already in the ledger", async () => {
    const exact = await checker.check({ humanId: "alice", sessionId: "s1" }, 1_000_000, {
      phase: "review",
    });
    expect(exact.decision).toBe("stop");
    expect(exact.message).toContain("stop and ask");

    await spend(900_000, { sessionId: "s1" });
    const over = await checker.check({ humanId: "alice", sessionId: "s1" }, 200_000, {
      phase: "review",
    });
    expect(over).toMatchObject({
      decision: "stop",
      level: "session",
      spent: 900_000,
      remaining: 100_000,
    });
    expect(over.ratio).toBeCloseTo(1.1, 6);
    const just = await checker.check({ humanId: "alice", sessionId: "s1" }, 99_999, {
      phase: "review",
    });
    // 999_999 of 1_000_000 is 99.9%: over 80% but not yet at the cap
    expect(just.decision).toBe("finish_current");
    expect(just.level).toBe("session");
    expect(just.ratio).toBeLessThan(1);
    const atCap = await checker.check({ humanId: "alice", sessionId: "s1" }, 100_000, {
      phase: "review",
    });
    expect(atCap.decision).toBe("stop");
  });

  it("applies the 80/100 rule at every level: month, project, task and run", async () => {
    await spend(80_000_000, { projectId: "p-old", sessionId: "s-old" });
    const month = await checker.check({ humanId: "alice", sessionId: "s1" }, 0, { phase: "work" });
    expect(month).toMatchObject({ decision: "finish_current", level: "month", spent: 80_000_000 });

    mem.entries.length = 0;
    await spend(10_000_000, { projectId: "p1", sessionId: "s-old" });
    const project = await checker.check(full, 0, { phase: "work" });
    expect(project).toMatchObject({ decision: "stop", level: "project" });

    mem.entries.length = 0;
    await spend(400_000, { projectId: "p1", sessionId: "s-old", taskId: "t1" });
    const task = await checker.check(full, 0, { phase: "work" });
    expect(task).toMatchObject({
      decision: "finish_current",
      level: "task",
      spent: 400_000,
      cap: 500_000,
    });

    mem.entries.length = 0;
    await spend(150_000, { sessionId: "s1", taskId: "t1", runId: "r1" });
    const run = await checker.check(full, 50_000, { phase: "work" });
    expect(run).toMatchObject({ decision: "stop", level: "run", spent: 150_000, cap: 200_000 });
  });

  it("keeps the review reserve of the session cap out of reach of the work phase", async () => {
    const reserved = new CapChecker({ query: mem, clock, caps: { ...caps, reserveShare: 0.25 } });
    const scope = { humanId: "alice", sessionId: "s1" };
    const work = await reserved.check(scope, 760_000, { phase: "work" });
    expect(work.decision).toBe("finish_current");
    expect(work.level).toBe("session");
    expect(work.message).toContain("review reserve 25%");
    const review = await reserved.check(scope, 760_000, { phase: "review" });
    expect(review.decision).toBe("allow");
    const boundary = await reserved.check(scope, 750_000, { phase: "work" });
    expect(boundary.decision).toBe("allow");
    expect(DEFAULT_RESERVE_SHARE).toBe(0.2);
  });

  it("stops subscription work at the plan share cap and warns at 80% of it", async () => {
    const scope = { humanId: "alice", sessionId: "s1" };
    const stop = await checker.check(scope, 0, {
      phase: "work",
      planUsageShare: 0.95,
      sourceKind: "subscription",
    });
    expect(stop).toMatchObject({ decision: "stop", level: "plan", spent: 0.95, cap: 0.95 });
    expect(stop.message).toBe("plan usage 95% of the 95% cap: stop and ask");
    const warn = await checker.check(scope, 0, { phase: "work", planUsageShare: 0.76 });
    expect(warn).toMatchObject({ decision: "finish_current", level: "plan" });
    const fine = await checker.check(scope, 0, { phase: "work", planUsageShare: 0.5 });
    expect(fine.decision).toBe("allow");
    const api = await checker.check(scope, 0, {
      phase: "work",
      planUsageShare: 0.99,
      sourceKind: "api_key",
    });
    expect(api.decision).toBe("allow");
    expect(api.levels.map((l) => l.level)).toEqual(["month", "session"]);
    const custom = new CapChecker({ query: mem, clock, caps: { ...caps, planShareCap: 0.5 } });
    expect((await custom.check(scope, 0, { phase: "work", planUsageShare: 0.5 })).decision).toBe(
      "stop",
    );
  });

  it("only measures the levels the scope names, in a fixed order", async () => {
    const bare = await checker.check({ humanId: "alice" }, 10, { phase: "work" });
    expect(bare.levels.map((l) => l.level)).toEqual(["month"]);
    expect(bare.level).toBe("month");
    const all = await checker.check(full, 10, { phase: "work", planUsageShare: 0.1 });
    expect(all.levels.map((l) => l.level)).toEqual([
      "month",
      "project",
      "session",
      "task",
      "run",
      "plan",
    ]);
  });

  it("names the tightest level among those with the worst decision", async () => {
    await spend(850_000, { sessionId: "s1", taskId: "t-other" });
    await spend(450_000, { sessionId: "s-other", taskId: "t1" });
    const c = await checker.check({ humanId: "alice", sessionId: "s1", taskId: "t1" }, 0, {
      phase: "review",
    });
    expect(c.decision).toBe("finish_current");
    expect(c.level).toBe("task");
    expect(c.levels.map((l) => [l.level, l.decision])).toEqual([
      ["month", "allow"],
      ["session", "finish_current"],
      ["task", "finish_current"],
    ]);
  });

  it("ignores last month's spend for the month cap", async () => {
    await spend(99_000_000, {}, "2026-09-30T23:59:59.000Z");
    await spend(1_000, {}, "2026-10-01T00:00:00.000Z");
    const c = await checker.check({ humanId: "alice" }, 0, { phase: "work" });
    expect(c).toMatchObject({ decision: "allow", level: "month", spent: 1_000 });
  });

  it("is deterministic and accepts per-call caps", async () => {
    await spend(500_000, { sessionId: "s1" });
    const a = await checker.check(full, 100_000, { phase: "work" });
    const b = await checker.check(full, 100_000, { phase: "work" });
    expect(a).toEqual(b);
    const tight = await checker.check(full, 100_000, {
      phase: "work",
      caps: { ...caps, sessionUsdMicro: 600_000 },
    });
    expect(tight).toMatchObject({ decision: "stop", level: "session", cap: 600_000 });
  });

  it("validates caps, thresholds and estimates", () => {
    expect(() => normalizeCaps({ ...caps, reserveShare: 0.1 })).toThrow(ForerunnerError);
    expect(() => normalizeCaps({ ...caps, reserveShare: 0.3 })).toThrow(/reserveShare/);
    expect(() => normalizeCaps({ ...caps, sessionUsdMicro: 0 })).toThrow(/positive/);
    expect(() => normalizeCaps({ ...caps, monthUsdMicro: 1.5 })).toThrow(ForerunnerError);
    expect(() => normalizeCaps({ ...caps, planShareCap: 1.5 })).toThrow(/planShareCap/);
    expect(normalizeCaps(caps)).toMatchObject({ reserveShare: 0.2, planShareCap: 0.95 });
    expect(
      () => new CapChecker({ query: mem, clock, caps, thresholds: { finishCurrentAt: 1.2 } }),
    ).toThrow(ForerunnerError);
    expect(FINISH_CURRENT_AT).toBe(0.8);
    expect(STOP_AT).toBe(1);
  });

  describe("room: the largest estimate check still allows", () => {
    const project: CapScope = { humanId: "alice", projectId: "p1" };

    it("below a level's 80% line, the room stops under that line", async () => {
      await spend(7_500_000, { projectId: "p1" });
      const room = await checker.room(project, { phase: "review" });
      expect(room).toBe(499_999);
      expect((await checker.check(project, room ?? 0, { phase: "review" })).decision).toBe("allow");
      expect((await checker.check(project, (room ?? 0) + 1, { phase: "review" })).decision).toBe(
        "finish_current",
      );
    });

    it("past a level's 80% line, only its stop line bounds the room", async () => {
      await spend(8_500_000, { projectId: "p1" });
      const room = await checker.room(project, { phase: "review" });
      expect(room).toBe(1_499_999);
      expect((await checker.check(project, room ?? 0, { phase: "review" })).decision).toBe(
        "finish_current",
      );
      expect((await checker.check(project, (room ?? 0) + 1, { phase: "review" })).decision).toBe(
        "stop",
      );
    });

    it("uses the checker's own thresholds, not 80% and 100%", async () => {
      const early = new CapChecker({
        query: mem,
        clock,
        caps,
        thresholds: { finishCurrentAt: 0.8, stopAt: 0.9 },
      });
      await spend(8_500_000, { projectId: "p1" });
      const room = await early.room(project, { phase: "review" });
      expect(room).toBe(499_999);
      expect((await early.check(project, (room ?? 0) + 1, { phase: "review" })).decision).toBe(
        "stop",
      );
    });

    it("for work, keeps the session's review reserve; the plan share is not a money level", async () => {
      const reserved = new CapChecker({ query: mem, clock, caps: { ...caps, reserveShare: 0.25 } });
      const session: CapScope = { humanId: "alice", sessionId: "s1" };
      await spend(600_000, { sessionId: "s1" });
      const opts = { planUsageShare: 0.5, sourceKind: "subscription" as const };
      expect(await reserved.room(session, { phase: "work", ...opts })).toBe(150_000);
      expect((await reserved.check(session, 150_000, { phase: "work", ...opts })).decision).toBe(
        "allow",
      );
      expect(await reserved.room(session, { phase: "review", ...opts })).toBe(199_999);
    });

    it("is never negative", async () => {
      await spend(12_000_000, { projectId: "p1" });
      expect(await checker.room(project, { phase: "review" })).toBe(0);
    });
  });

  it("rejects negative or fractional estimates", async () => {
    await expect(checker.check(full, -1, { phase: "work" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(checker.check(full, 0.5, { phase: "work" })).rejects.toMatchObject({
      code: "validation",
    });
  });
});
