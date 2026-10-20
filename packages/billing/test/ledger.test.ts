import { SimulatedClock } from "@forerunner/platform";
import { beforeEach, describe, expect, it } from "vitest";
import { CostLedger, monthWindow, NO_SPECIALIST, type TaskOutcome } from "../src/ledger.ts";
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
    expect((await ledger.savings("nope")).total.usd_micro).toBe(0);
  });
});
