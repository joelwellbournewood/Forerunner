import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import {
  type EvalRunInput,
  type EvalRunnerPort,
  type EvalRunOutcome,
  MODEL_WATCH_CHANNEL,
} from "../src/models/watch.ts";
import { ScriptedProvider } from "./helpers.ts";

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

async function boot(home: string, clock: SimulatedClock, evals: EvalRunnerPort) {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    vault: new MemoryVault({}),
    provider: new ScriptedProvider([{ text: "hello" }], clock),
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
  });

  it("the human's opt-in setting turns the scheduled evals on; 'evaluate' on a report runs them once", async () => {
    const home = freshHome();
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals();
    const rt = await boot(home, clock, evals);
    const report = (await rt.modelWatch.run()).report;
    expect(evals.calls).toHaveLength(0);
    await rt.modelWatch.resolve(report.id, { decision: "evaluate", by: rt.human.id });
    await rt.modelWatch.settled();
    expect(evals.calls.length).toBeGreaterThan(0);

    const n = evals.calls.length;
    const human = await rt.store.human.mustGet(rt.human.id);
    await rt.store.human.patch(human.id, {
      notify_prefs: { ...(human.notify_prefs ?? {}), model_watch: { run_evals: true } },
    });
    await rt.scheduler.tick();
    await rt.modelWatch.settled();
    expect(evals.calls.length).toBeGreaterThan(n);
  });

  it("closing the daemon while evals are underway aborts them and close() returns", async () => {
    const home = freshHome();
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const evals = new RecordingEvals(true);
    const rt = await boot(home, clock, evals);
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
