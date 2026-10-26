import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { BUILTIN_PRICING } from "@forerunner/billing";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import {
  type EvalRunInput,
  type EvalRunnerPort,
  type EvalRunOutcome,
  MODEL_WATCH_BASELINE_CHANNEL,
  MODEL_WATCH_CHANNEL,
} from "../src/models/watch.ts";
import type { ModelRef } from "../src/provider/types.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Lists the rungs and, once `released` is set, a new sonnet-tier model beside them, so a run
 * after the first (the baseline, ADR 0089) has a candidate to test.
 */
class CandidateProvider extends ScriptedProvider {
  released = false;
  override async listModels(): Promise<ModelRef[]> {
    return [
      { provider: "fake", id: "fake-haiku", tier: "haiku" },
      { provider: "fake", id: "fake-sonnet", tier: "sonnet" },
      ...(this.released
        ? [{ provider: "fake", id: "fake-sonnet-6", tier: "sonnet" as const }]
        : []),
    ];
  }
}

/** Lists ten models beyond the rungs, each one the install's own price table already knows. */
class IncidentProvider extends ScriptedProvider {
  override async listModels(): Promise<ModelRef[]> {
    return [
      { provider: "fake", id: "fake-haiku", tier: "haiku" },
      { provider: "fake", id: "fake-sonnet", tier: "sonnet" },
      ...Object.keys(BUILTIN_PRICING)
        .filter((id) => !id.endsWith("-fast"))
        .slice(0, 10)
        .map((id) => ({ provider: "fake", id, tier: "sonnet" as const })),
    ];
  }
}

/** Prices for the fake rungs and the candidate, so the candidate is priced from the table. */
function writePricing(home: string): void {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  mkdirSync(dirs.config, { recursive: true });
  const row = (i: number, o: number) => ({
    input_per_mtok_usd: i,
    output_per_mtok_usd: o,
    cache_read_per_mtok_usd: i / 10,
    cache_write_per_mtok_usd: i * 1.25,
    as_of: "2026-10-01",
    source: "override",
  });
  writeFileSync(
    join(dirs.config, "pricing.json"),
    JSON.stringify({
      "fake-haiku": row(1, 5),
      "fake-sonnet": row(3, 15),
      "fake-sonnet-6": row(1.5, 7.5),
    }),
  );
}

/**
 * The 2026-10-26 incident on a fresh install: `fr setup` then `fr daemon` ran the weekly model
 * watch at the first scheduler tick, evals included, and again after a restart. These tests
 * compose the daemon on a fresh FORERUNNER_HOME and drive its own scheduler.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

class RecordingEvals implements EvalRunnerPort {
  readonly calls: EvalRunInput[] = [];
  private waiters: (() => void)[] = [];
  constructor(private readonly hang = false) {}
  async run(input: EvalRunInput): Promise<EvalRunOutcome> {
    this.calls.push(input);
    for (const w of this.waiters.splice(0)) w();
    if (this.hang) {
      await new Promise<void>((_, reject) => {
        const signal = input.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return {
      total: 3,
      passed: 3,
      failed: 0,
      needsModel: 0,
      passRate: 1,
      costUsdMicro: 10,
      durationMs: 1,
    };
  }
  called(): Promise<void> {
    if (this.calls.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const homes: string[] = [];
const open: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of open.splice(0)) await rt.close().catch(() => undefined);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fr-watch-boot-"));
  homes.push(home);
  return home;
}

async function boot(
  home: string,
  clock: SimulatedClock,
  evals: EvalRunnerPort,
  provider: ScriptedProvider = new ScriptedProvider([{ text: "hello" }], clock),
) {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    vault: new MemoryVault({}),
    provider,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "1.0.0",
    evalRunner: evals,
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
  });
  open.push(rt);
  return rt;
}

const reports = async (rt: RuntimeApp) =>
  rt.store.release.list({ channel: MODEL_WATCH_CHANNEL }, { limit: 50 });

describe("model watch on a fresh install", () => {
  it("the first tick and a restart run no paid eval; the free check runs once per week, not once per boot", async () => {
    const home = freshHome();
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals();
    const first = await boot(home, clock, evals);
    await first.scheduler.tick();
    await first.modelWatch.settled();
    expect(evals.calls).toHaveLength(0);
    const one = await reports(first);
    expect(one).toHaveLength(1);
    await first.close();
    open.splice(open.indexOf(first), 1);

    await clock.advance(80 * 60_000);
    const second = await boot(home, clock, evals);
    await second.scheduler.tick();
    await second.modelWatch.settled();
    expect(evals.calls).toHaveLength(0);
    expect(await reports(second)).toHaveLength(1);
    await second.close();
    open.splice(open.indexOf(second), 1);

    // Once per week: a boot a week after the first run runs the free check again, once.
    await clock.advance(7 * 24 * 60 * 60_000);
    const third = await boot(home, clock, evals);
    await third.scheduler.tick();
    await third.scheduler.tick();
    await third.modelWatch.settled();
    expect(evals.calls).toHaveLength(0);
    expect(await reports(third)).toHaveLength(2);
  });

  it("the human's opt-in setting turns the scheduled evals on; 'evaluate' on a report runs them once", async () => {
    const home = freshHome();
    writePricing(home);
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals();
    const provider = new CandidateProvider([{ text: "hi" }], clock);
    const rt = await boot(home, clock, evals, provider);
    // The fresh install's first run records the baseline and asks nothing.
    const baseline = await rt.modelWatch.run();
    expect(baseline.decision).toBe("nothing_to_decide");
    expect(baseline.report.baseline_providers).toEqual(["fake"]);
    provider.released = true;
    const first = await rt.modelWatch.run();
    expect(first.decision).toBe("pending");
    expect(first.report.evals_deferred?.planned.some((p) => p.model === "fake-sonnet-6")).toBe(
      true,
    );
    expect(evals.calls).toHaveLength(0);
    await rt.modelWatch.resolve(first.report.id, { decision: "evaluate", by: rt.human.id });
    await rt.modelWatch.settled();
    expect(evals.calls.length).toBeGreaterThan(0);
    // One paid run for the answer: a second "evaluate" is refused and starts nothing.
    const once = evals.calls.length;
    await expect(
      rt.modelWatch.resolve(first.report.id, { decision: "evaluate", by: rt.human.id }),
    ).rejects.toMatchObject({ code: "validation" });
    await rt.modelWatch.settled();
    expect(evals.calls.length).toBe(once);

    const n = evals.calls.length;
    const human = await rt.store.human.mustGet(rt.human.id);
    await rt.store.human.patch(human.id, {
      notify_prefs: { ...(human.notify_prefs ?? {}), model_watch: { run_evals: true } },
    });
    await rt.scheduler.tick();
    await rt.modelWatch.settled();
    expect(evals.calls.length).toBeGreaterThan(n);
  });

  it("an install upgraded with a pending report: 'evaluate' runs that report's candidate, not a baseline run", async () => {
    const home = freshHome();
    writePricing(home);
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals();
    const provider = new CandidateProvider([{ text: "hi" }], clock);
    const rt = await boot(home, clock, evals, provider);
    await rt.modelWatch.run();
    provider.released = true;
    const old = await rt.modelWatch.run();
    expect(old.decision).toBe("pending");
    // Before the baseline rule there were reports and no baseline row.
    for (const row of await rt.store.release.list({ channel: MODEL_WATCH_BASELINE_CHANNEL }))
      await rt.store.release.delete(row.id);
    await rt.modelWatch.resolve(old.report.id, { decision: "evaluate", by: rt.human.id });
    await rt.modelWatch.settled();
    expect(evals.calls.some((c) => c.model === "fake-sonnet-6")).toBe(true);
  });

  it("the first boot's free check over ten table-known models opens no request in the human's inbox", async () => {
    const home = freshHome();
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals();
    const rt = await boot(home, clock, evals, new IncidentProvider([{ text: "hi" }], clock));
    await rt.scheduler.tick();
    await rt.modelWatch.settled();
    const [row] = await reports(rt);
    expect(row).toBeDefined();
    expect(row?.changelog).toMatch(/baseline recorded/);
    expect(await rt.store.humanRequest.open({ humanId: rt.human.id })).toHaveLength(0);
    expect(evals.calls).toHaveLength(0);
  });

  it("closing the daemon while evals are underway aborts them and close() returns", async () => {
    const home = freshHome();
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals(true);
    const rt = await boot(home, clock, evals);
    // The first run is the baseline and runs no eval (ADR 0089); the paid run comes after it.
    await rt.modelWatch.run();
    expect(evals.calls).toHaveLength(0);
    const run = rt.modelWatch.run({ evals: true });
    const outcome = run.then(
      () => "resolved",
      (e: unknown) => (e as { code?: string }).code ?? "rejected",
    );
    await evals.called();
    await rt.close();
    open.splice(open.indexOf(rt), 1);
    expect(evals.calls[0]?.signal?.aborted).toBe(true);
    expect(await outcome).toBe("killed");
    expect(evals.calls).toHaveLength(1);
  });
});
