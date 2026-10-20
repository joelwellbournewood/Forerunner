import { SimulatedClock } from "@forerunner/platform";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CostLedger,
  entriesAsRuns,
  monthWindow,
  NO_PROJECT,
  NO_SPECIALIST,
  type SavingsFilter,
  type SavingsRun,
  type TaskOutcome,
} from "../src/ledger.ts";
import { FixedRateSource, type RateQuote, type RateSource, toRateDate } from "../src/rates.ts";
import { InMemoryLedger } from "../src/sink.ts";
import { makeBillingSource } from "../src/sources.ts";

const aliceApi = makeBillingSource({ id: "alice-api", kind: "api_key", humanId: "alice" });
const aliceSub = makeBillingSource({ id: "alice-sub", kind: "subscription", humanId: "alice" });
const bobApi = makeBillingSource({ id: "bob-api", kind: "api_key", humanId: "bob" });

const M = 1_000_000;

describe("CostLedger", () => {
  let clock: SimulatedClock;
  let mem: InMemoryLedger;
  let ledger: CostLedger;

  beforeEach(() => {
    clock = new SimulatedClock("2026-10-20T10:00:00.000Z");
    mem = new InMemoryLedger(clock);
    ledger = new CostLedger({ sink: mem, query: mem, rates: new FixedRateSource(0.8), clock });
  });

  it("records an API charge with USD from the table and CHF at the day's rate", async () => {
    const r = await ledger.record({
      usage: { tokens_in: M, tokens_out: 0 },
      model: "claude-sonnet-4-5",
      source: aliceApi,
      scope: {
        humanId: "alice",
        agentId: "a1",
        projectId: "p1",
        sessionId: "s1",
        taskId: "t1",
        runId: "r1",
      },
      specialist: "coder",
    });
    expect(r.estimated).toBe(false);
    expect(r.rate.origin).toBe("fixed");
    expect(r.entry).toMatchObject({
      human_id: "alice",
      agent_id: "a1",
      project_id: "p1",
      session_id: "s1",
      task_id: "t1",
      run_id: "r1",
      billing_source_id: "alice-api",
      kind: "api",
      usd_micro: 3 * M,
      chf_micro: 2_400_000,
      rate_chf_per_usd: 0.8,
      plan_usage_share: null,
      model: "claude-sonnet-4-5",
      specialist: "coder",
      tokens_in: M,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      occurred_at: "2026-10-20T10:00:00.000Z",
    });
    expect(r.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mem.entries).toHaveLength(1);
  });

  it("labels subscription usage as an estimated API-equivalent with the plan share", async () => {
    const r = await ledger.record({
      usage: { tokens_in: 1000, tokens_out: 500 },
      model: "claude-opus-4-5",
      source: aliceSub,
      scope: { humanId: "alice", sessionId: "s1" },
      planUsageShare: 0.42,
    });
    expect(r.estimated).toBe(true);
    expect(r.entry.kind).toBe("subscription");
    expect(r.entry.usd_micro).toBe(1000 * 5 + 500 * 25);
    expect(r.entry.plan_usage_share).toBe(0.42);
  });

  it("lets a provider-reported charge win over the table and refuses unknown models", async () => {
    const r = await ledger.record({
      usage: { tokens_in: 10, tokens_out: 10 },
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice" },
      usdMicroActual: 12_345,
    });
    expect(r.entry.usd_micro).toBe(12_345);
    await expect(
      ledger.record({
        usage: { tokens_in: 1, tokens_out: 1 },
        model: "mystery-9",
        source: aliceApi,
        scope: { humanId: "alice" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(mem.entries).toHaveLength(1);
  });

  it("refuses to charge one human's source for another human", async () => {
    await expect(
      ledger.record({
        usage: { tokens_in: 1, tokens_out: 1 },
        model: "claude-haiku-4-5",
        source: bobApi,
        scope: { humanId: "alice" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("uses the rate for the day the charge occurred", async () => {
    const byDay: RateSource = {
      async chfPerUsd(d) {
        return (await this.quote(d)).chfPerUsd;
      },
      async quote(d): Promise<RateQuote> {
        const date = toRateDate(d);
        return {
          chfPerUsd: date === "2026-10-19" ? 0.5 : 0.9,
          requestedDate: date,
          rateDate: date,
          origin: "frankfurter",
          fetchedAt: d,
        };
      },
    };
    const l = new CostLedger({ sink: mem, query: mem, rates: byDay, clock });
    const yesterday = await l.record({
      usage: { tokens_in: M, tokens_out: 0 },
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice" },
      occurredAt: "2026-10-19T23:00:00.000Z",
    });
    const today = await l.record({
      usage: { tokens_in: M, tokens_out: 0 },
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice" },
    });
    expect(yesterday.entry.chf_micro).toBe(500_000);
    expect(today.entry.chf_micro).toBe(900_000);
  });

  it("sums per scope, per kind and per calendar month", async () => {
    const base = { model: "claude-haiku-4-5", usage: { tokens_in: M, tokens_out: 0 } };
    await ledger.record({
      ...base,
      source: aliceApi,
      scope: { humanId: "alice", projectId: "p1", sessionId: "s1", taskId: "t1" },
    });
    await ledger.record({
      ...base,
      source: aliceSub,
      scope: { humanId: "alice", projectId: "p1", sessionId: "s1", taskId: "t2" },
      planUsageShare: 0.3,
    });
    await ledger.record({
      ...base,
      source: aliceApi,
      scope: { humanId: "alice", projectId: "p2", sessionId: "s2" },
    });
    await ledger.record({
      ...base,
      source: aliceApi,
      scope: { humanId: "alice", projectId: "p1" },
      occurredAt: "2026-09-30T23:59:59.000Z",
    });
    await ledger.record({ ...base, source: bobApi, scope: { humanId: "bob", projectId: "p1" } });

    const s1 = await ledger.totals({ sessionId: "s1" });
    expect(s1.usd_micro).toBe(2 * M);
    expect(s1.entries).toBe(2);
    expect(s1.plan_usage_share).toBe(0.3);
    expect(s1.byKind.api).toEqual({ usd_micro: M, chf_micro: 800_000, entries: 1 });
    expect(s1.byKind.subscription).toEqual({ usd_micro: M, chf_micro: 800_000, entries: 1 });
    expect(s1.byKind.plan_credits.entries).toBe(0);

    expect((await ledger.totals({ taskId: "t1" })).usd_micro).toBe(M);
    expect((await ledger.totals({ projectId: "p1" })).usd_micro).toBe(4 * M);
    expect((await ledger.totals({ projectId: "p1", humanId: "alice" })).usd_micro).toBe(3 * M);

    const month = await ledger.monthTotals("alice");
    expect(month.usd_micro).toBe(3 * M);
    expect(monthWindow(clock.now())).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(monthWindow(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      from: "2026-12-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
  });

  it("allocates spend by specialist, model and task with success rate and cost per accepted task", async () => {
    const scope = (taskId: string, sessionId = "s1") => ({
      humanId: "alice",
      projectId: "p1",
      sessionId,
      taskId,
    });
    const usage = { tokens_in: M, tokens_out: 0 };
    await ledger.record({
      usage,
      model: "claude-sonnet-4-5",
      source: aliceApi,
      scope: scope("t1"),
      specialist: "coder",
    });
    await ledger.record({
      usage,
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: scope("t1"),
      specialist: "coder",
    });
    await ledger.record({
      usage,
      model: "claude-sonnet-4-5",
      source: aliceApi,
      scope: scope("t2"),
      specialist: "coder",
    });
    await ledger.record({
      usage,
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: scope("t3"),
      specialist: "tester",
    });
    await ledger.record({
      usage,
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice", projectId: "p1", sessionId: "s1" },
    });
    await ledger.record({
      usage,
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice", projectId: "other", taskId: "t9" },
      specialist: "coder",
    });

    const outcomes: Record<string, TaskOutcome> = { t1: "accepted", t2: "rejected" };
    const calls: string[] = [];
    const report = await ledger.allocation({ projectId: "p1" }, (id) => {
      calls.push(id);
      return outcomes[id];
    });

    expect(report.total.usd_micro).toBe(3 * M + 3 * M + M + M + M);
    const coder = report.bySpecialist.find((b) => b.key === "coder");
    expect(coder).toMatchObject({
      usd_micro: 7 * M,
      runs: 3,
      tasks: 2,
      acceptedTasks: 1,
      rejectedTasks: 1,
      openTasks: 0,
      successRate: 0.5,
      costPerAcceptedTaskUsdMicro: 7 * M,
    });
    const tester = report.bySpecialist.find((b) => b.key === "tester");
    expect(tester).toMatchObject({
      tasks: 1,
      openTasks: 1,
      successRate: null,
      costPerAcceptedTaskUsdMicro: null,
    });
    expect(report.bySpecialist.map((b) => b.key)).toEqual(["coder", NO_SPECIALIST, "tester"]);
    expect(report.byModel.map((b) => [b.key, b.usd_micro])).toEqual([
      ["claude-sonnet-4-5", 6 * M],
      ["claude-haiku-4-5", 3 * M],
    ]);
    expect(report.byTask.find((b) => b.key === "t1")?.usd_micro).toBe(4 * M);
    expect(new Set(calls)).toEqual(new Set(["t1", "t2", "t3"]));
    expect(calls).toHaveLength(3);

    const windowed = await ledger.allocation(
      { projectId: "p1", from: "2026-10-21T00:00:00.000Z" },
      () => undefined,
    );
    expect(windowed.total.entries).toBe(0);
  });

  it("reports savings from compression and cache reads separately from spend", async () => {
    await ledger.record({
      usage: { tokens_in: 1000, tokens_out: 0, cache_read_tokens: 10_000 },
      model: "claude-sonnet-4-5",
      source: aliceApi,
      scope: { humanId: "alice", sessionId: "s1" },
      tokensBeforeCompression: 50_000,
      tokensAfterCompression: 20_000,
    });
    await ledger.record({
      usage: { tokens_in: 10, tokens_out: 0 },
      model: "claude-haiku-4-5",
      source: aliceApi,
      scope: { humanId: "alice", sessionId: "s1" },
    });
    await mem.record({
      human_id: "alice",
      session_id: "s1",
      billing_source_id: null,
      kind: "api",
      usd_micro: 0,
      chf_micro: 0,
      rate_chf_per_usd: 0.8,
      model: "mystery-9",
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 5_000,
      cache_write_tokens: 0,
      tokens_before_compression: 100,
      tokens_after_compression: 50,
      occurred_at: clock.nowIso(),
    });

    const s = await ledger.savings("s1");
    expect(s.compression).toEqual({
      runsMeasured: 2,
      tokensBefore: 50_100,
      tokensAfter: 20_050,
      tokensSaved: 30_050,
      usd_micro: 90_000,
      chf_micro: 72_000,
    });
    expect(s.cache).toEqual({
      cacheReadTokens: 15_000,
      usdMicroAtFullPrice: 30_000,
      usdMicroPaid: 3_000,
      usd_micro: 27_000,
      chf_micro: 21_600,
    });
    expect(s.total).toEqual({ usd_micro: 117_000, chf_micro: 93_600 });
    expect(s.unpricedRuns).toBe(1);
    expect(s.filter).toEqual({ sessionId: "s1" });
    expect((await ledger.savings("nope")).total.usd_micro).toBe(0);
  });

  it("prices Run rows at the run's own rate with ADR 0008 rounding and allocates by project, specialist and model", async () => {
    // Ledger entries supply the CHF rate per run (cost_ledger.run_id); the Run rows carry the savings.
    const entryFor = (run_id: string, project_id: string, rate: number, model: string) =>
      mem.record({
        human_id: "alice",
        project_id,
        session_id: "s1",
        run_id,
        billing_source_id: "alice-api",
        kind: "api",
        usd_micro: 1,
        chf_micro: 1,
        rate_chf_per_usd: rate,
        model,
        specialist: "coder",
        tokens_in: 1,
        tokens_out: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: clock.nowIso(),
      });
    await entryFor("r1", "p1", 0.8, "claude-haiku-5-5");
    await entryFor("r2", "p2", 0.9, "claude-haiku-5-5");
    await entryFor("r3", "p1", 0.9, "claude-sonnet-4-5");
    await entryFor("r4", "p1", 0.8, "mystery-9");
    const runs: SavingsRun[] = [
      // 5 tokens x 0.1 USD/MTok = 0.5 micro -> 1 (half-up); 15 cache reads x 0.09 = 1.35 -> 1.
      {
        run_id: "r1",
        session_id: "s1",
        specialist: "coder",
        model: "claude-haiku-5-5",
        tokens_before_compression: 1005,
        tokens_after_compression: 1000,
        cache_read_tokens: 15,
        cache_write_tokens: 7,
        context_transforms: ["logs", "truncate"],
        headroom_used: true,
      },
      // 4 tokens x 0.1 = 0.4 micro -> 0: counted in tokens, worth nothing in money.
      {
        run_id: "r2",
        session_id: "s1",
        specialist: "researcher",
        model: "claude-haiku-5-5",
        tokens_before_compression: 1004,
        tokens_after_compression: 1000,
        cache_read_tokens: 0,
        context_transforms: ["logs"],
      },
      // 60k tokens x 3 USD/MTok = 180_000 micro, CHF at this run's own 0.9 rate = 162_000.
      {
        run_id: "r3",
        session_id: "s1",
        specialist: "coder",
        model: "claude-sonnet-4-5",
        tokens_before_compression: 100_000,
        tokens_after_compression: 40_000,
        cache_read_tokens: 0,
      },
      // Unknown model: tokens counted, money not.
      {
        run_id: "r4",
        session_id: "s1",
        specialist: "coder",
        model: "mystery-9",
        tokens_before_compression: 10,
        tokens_after_compression: 5,
        cache_read_tokens: 100,
      },
      // No ledger entry and no rate: quoted at the day's rate (0.8 here), no project.
      {
        run_id: "r5",
        session_id: "s2",
        specialist: null,
        model: "claude-sonnet-4-5",
        tokens_before_compression: 0,
        tokens_after_compression: 0,
        cache_read_tokens: 1000,
        occurred_at: clock.nowIso(),
      },
    ];
    const seen: SavingsFilter[] = [];
    const withRuns = new CostLedger({
      sink: mem,
      query: mem,
      rates: new FixedRateSource(0.8),
      clock,
      runs: {
        async listRuns(filter) {
          seen.push(filter);
          return runs;
        },
      },
      sessions: {
        async listSessions() {
          return [
            { session_id: "s1", headroom_saved_tokens: 500 },
            { session_id: "s2", headroom_saved_tokens: 250 },
          ];
        },
      },
    });
    // The RunSource honours the filter in production; here it returns every run, and the ledger
    // entries listed for the filter supply each run's rate and project.
    const s = await withRuns.savings({ sessionId: "s1" });
    expect(seen).toEqual([{ sessionId: "s1" }]);
    expect(s.compression).toEqual({
      runsMeasured: 4,
      tokensBefore: 102_019,
      tokensAfter: 42_005,
      tokensSaved: 60_014,
      usd_micro: 180_001,
      chf_micro: 162_001,
    });
    // r1: 15 x 0.1 = 1.5 -> 2 at full price, 15 x 0.01 = 0.15 -> 0 paid; r5: 1000 x 3 = 3000, paid 300.
    expect(s.cache).toEqual({
      cacheReadTokens: 1_115,
      usdMicroAtFullPrice: 3_002,
      usdMicroPaid: 300,
      usd_micro: 2_701,
      chf_micro: 2_161,
    });
    expect(s.cacheWriteTokens).toBe(7);
    expect(s.total).toEqual({ usd_micro: 182_702, chf_micro: 164_162 });
    expect(s.unpricedRuns).toBe(1);
    expect(s.transforms).toEqual({ logs: 2, truncate: 1 });
    expect(s.headroom).toEqual({ runs: 1, sessions: 2, tokensSaved: 750 });
    expect(s.byProject.map((b) => [b.key, b.runs, b.total.usd_micro, b.total.chf_micro])).toEqual([
      ["p1", 3, 180_002, 162_002],
      [NO_PROJECT, 1, 2_700, 2_160],
      ["p2", 1, 0, 0],
    ]);
    expect(s.bySpecialist.map((b) => [b.key, b.compressionTokens, b.cacheReadTokens])).toEqual([
      ["coder", 60_010, 115],
      [NO_SPECIALIST, 0, 1_000],
      ["researcher", 4, 0],
    ]);
    expect(s.byModel.map((b) => [b.key, b.compression.usd_micro, b.cache.usd_micro])).toEqual([
      ["claude-sonnet-4-5", 180_000, 2_700],
      ["claude-haiku-5-5", 1, 1],
      ["mystery-9", 0, 0],
    ]);
  });

  it("entriesAsRuns folds one run's calls together and keeps the first measured compression", () => {
    const base = {
      human_id: "alice",
      billing_source_id: null,
      kind: "api" as const,
      usd_micro: 0,
      chf_micro: 0,
      rate_chf_per_usd: 0.8,
      model: "claude-sonnet-4-5",
      tokens_in: 0,
      tokens_out: 0,
      cache_write_tokens: 1,
      occurred_at: clock.nowIso(),
    };
    const runs = entriesAsRuns([
      { ...base, id: "e1", run_id: "r1", cache_read_tokens: 10 },
      {
        ...base,
        id: "e2",
        run_id: "r1",
        cache_read_tokens: 20,
        tokens_before_compression: 50,
        tokens_after_compression: 20,
      },
      { ...base, id: "e3", cache_read_tokens: 5 },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      run_id: "r1",
      cache_read_tokens: 30,
      cache_write_tokens: 2,
      tokens_before_compression: 50,
      tokens_after_compression: 20,
    });
    expect(runs[1]?.run_id).toBe("e3");
  });
});
