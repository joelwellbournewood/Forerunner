/**
 * Phase 7 gate helpers, model watch half (spec D.6, D.21; ADR 0019, ADR 0046): the weekly
 * model watch of an install on the scenario world, with the production `ModelWatch`, the
 * production approval port (a `decision` request in the human's inbox), the production
 * `FileModelSettingsStore` under the install's config directory (so an adopt writes the same
 * `models.json` and `pricing.json` the daemon reads), the session `Scheduler` with the weekly
 * `scheduleModelWatch` trigger routed to `ModelWatch.run()` exactly as the daemon routes it
 * (`isModelWatchRequest`), and the world's fake provider behind a listing that adds one new
 * model (`CANDIDATE_MODEL`) to the ladder's models.
 *
 * The eval runner port: the daemon's `LoopEvalRunner` grades `command_exit0` checks inside a
 * sandbox lease and the world has no sandbox, so the port is backed by `@forerunner/evals`'
 * `runEvalSet` (the orchestrator may inject an evals-backed runner through
 * `ComposeOptions.evalRunner`) with a driver that asks the fake provider once per task and
 * effort (`model-watch eval <task> at <effort>`) and writes the task's reference solution when
 * the provider answers PASS. The checks then run for real (node on the files written), so a
 * pass rate is measured by the grader, and the cost is the provider's reported usage at the
 * watch's pricing: a lower effort answers with fewer output tokens, the candidate is priced
 * from the price list. The built-in pricing table has no row for the fake models, so
 * `WATCH_PRICING` adds them (the same rows the model watch unit tests use).
 *
 * The driver accepts only PASS or FAIL and the runner rejects when any task errored: a bare
 * `FakeProvider` echoes an unscripted prompt (its default `onNoMatch`, the world's provider
 * throws) and `runEvalSet` counts a throwing driver as a failed task, so without this guard a
 * model listed without a script would show up as a quality delta, not as a scripting gap.
 */
import { mkdirSync } from "node:fs";
import {
  type EvalDriver,
  type EvalTask,
  loadEvalSet,
  runEvalSet,
  writeFiles,
} from "@forerunner/evals";
import { join, safeSegment } from "@forerunner/platform";
import {
  type EvalRunnerPort,
  FixturePriceListSource,
  isModelWatchRequest,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  ModelWatch,
  type ModelWatchAdoptedEvent,
  type ModelWatchRunResult,
  modelSettings,
  type PriceList,
  ProviderRegistry,
  resolveRegistryDir,
  type Schedule,
  Scheduler,
  type StartRequest,
  StateModelWatchApprovals,
  type StreamEvent,
  scheduleModelWatch,
  type WatchThresholds,
} from "@forerunner/runtime";
import { FAKE_MODELS, type ScriptedReply, textReply } from "@forerunner/testenv";
// `@forerunner/billing` is not declared in tests/e2e/package.json (see scenario-commands.ts);
// the relative path reaches the sources the daemon composes.
import {
  BUILTIN_PRICING,
  costOf,
  mergePricing,
  type PricingTable,
} from "../../../packages/billing/src/index.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

// ---------------------------------------------------------------------------------------
// Models and prices

/** The new sonnet-rung model the provider lists this week. */
export const CANDIDATE_MODEL = "fake-sonnet-6";

/** The fake models priced (the built-in table has no row for them). */
export const WATCH_PRICING: PricingTable = mergePricing(BUILTIN_PRICING, {
  "fake-haiku": {
    input_per_mtok_usd: 1,
    output_per_mtok_usd: 5,
    cache_read_per_mtok_usd: 0.1,
    cache_write_per_mtok_usd: 1.25,
    as_of: "2026-10-01",
  },
  "fake-sonnet": {
    input_per_mtok_usd: 3,
    output_per_mtok_usd: 15,
    cache_read_per_mtok_usd: 0.3,
    cache_write_per_mtok_usd: 3.75,
    as_of: "2026-10-01",
  },
  "fake-opus": {
    input_per_mtok_usd: 15,
    output_per_mtok_usd: 75,
    cache_read_per_mtok_usd: 1.5,
    cache_write_per_mtok_usd: 18.75,
    as_of: "2026-10-01",
  },
  "fake-fable": {
    input_per_mtok_usd: 30,
    output_per_mtok_usd: 150,
    cache_read_per_mtok_usd: 3,
    cache_write_per_mtok_usd: 37.5,
    as_of: "2026-10-01",
  },
});

/** The provider's price list this week: the candidate at half the sonnet rung's price. */
export const CANDIDATE_PRICE_LIST: PriceList = {
  as_of: "2026-11-02",
  source: "fixture",
  models: {
    [CANDIDATE_MODEL]: { input_per_mtok_usd: 1.5, output_per_mtok_usd: 7.5 },
  },
};

/** The provider's listing this week: the ladder's four models plus the candidate. */
export const LISTED_THIS_WEEK: ModelRef[] = [
  ...FAKE_MODELS,
  { provider: "fake", id: CANDIDATE_MODEL, tier: "sonnet" },
];

/** A provider that lists what the scenario says and answers from the world's fake provider. */
export class ListingProvider implements ModelProvider {
  readonly name: string;
  constructor(
    private readonly inner: ModelProvider,
    private readonly models: ModelRef[],
  ) {
    this.name = inner.name;
  }
  async listModels(): Promise<ModelRef[]> {
    return this.models.map((m) => ({ ...m }));
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
  stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
  complete(req: ModelRequest): Promise<ModelResponse> {
    return this.inner.complete(req);
  }
}

// ---------------------------------------------------------------------------------------
// The eval probe: one model call per task and effort

export const EVAL_PROBE_PREFIX = "model-watch eval ";

/** Output tokens per effort: a lower effort answers shorter, so it costs less. */
export const PROBE_USAGE: Record<string, { input_tokens: number; output_tokens: number }> = {
  low: { input_tokens: 1000, output_tokens: 250 },
  medium: { input_tokens: 1000, output_tokens: 500 },
  high: { input_tokens: 1000, output_tokens: 1000 },
};

function probeText(req: ModelRequest): string | null {
  const first = req.messages[0];
  if (first?.role !== "user" || typeof first.content !== "string") return null;
  return first.content.startsWith(EVAL_PROBE_PREFIX) ? first.content : null;
}

/** The probe for `taskId` at `effort`, as the driver phrases it. */
export function probeFor(taskId: string, effort: string): string {
  return `${EVAL_PROBE_PREFIX}${taskId} at ${effort}`;
}

export interface EvalProbeScript {
  /** Models that answer the probes. */
  models: string[];
  /** Probes a model fails at every effort. */
  fails?: Array<{ model: string; taskId: string }>;
}

/**
 * Scripted replies for the eval probes: FAIL for the named (model, task) pairs at every effort
 * (pushed first, so they win), PASS for everything else, with the effort's usage.
 */
export function evalProbeReplies(script: EvalProbeScript): ScriptedReply[] {
  const out: ScriptedReply[] = [];
  for (const [effort, usage] of Object.entries(PROBE_USAGE)) {
    for (const f of script.fails ?? []) {
      out.push(
        textReply("FAIL", {
          when: (req) => req.model === f.model && probeText(req) === probeFor(f.taskId, effort),
          times: Number.POSITIVE_INFINITY,
          usage,
        }),
      );
    }
  }
  for (const [effort, usage] of Object.entries(PROBE_USAGE)) {
    for (const model of script.models) {
      out.push(
        textReply("PASS", {
          when: (req) =>
            req.model === model && (probeText(req)?.endsWith(` at ${effort}`) ?? false),
          times: Number.POSITIVE_INFINITY,
          usage,
        }),
      );
    }
  }
  return out;
}

/** The first `count` tasks of the registry's coder eval set. */
export function coderEvalTasks(count: number): EvalTask[] {
  return loadEvalSet(join(resolveRegistryDir().dir, "evals", "coder")).slice(0, count);
}

/**
 * The eval runner port over `runEvalSet`: the provider is asked once per task, the reference
 * solution is written on PASS, the real checks grade the files, the cost is the usage at the
 * watch's pricing.
 */
export function evalRunnerOnWorld(
  world: ScenarioWorld,
  providers: ProviderRegistry,
  tasks: EvalTask[],
  workRoot: string,
): EvalRunnerPort {
  return {
    async run(input) {
      const provider = providers.get(input.provider);
      const driver: EvalDriver = async ({ task, workDir }) => {
        const res = await provider.complete({
          model: input.model,
          effort: input.effort,
          max_tokens: 64,
          messages: [{ role: "user", content: probeFor(task.id, input.effort) }],
          compression: "off",
        });
        const text = res.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text !== "PASS" && text !== "FAIL") {
          throw new Error(
            `eval probe ${task.id} on ${input.model} at ${input.effort}: the provider answered neither PASS nor FAIL (${JSON.stringify(text)}); no scripted reply?`,
          );
        }
        const passed = text === "PASS";
        const written = passed ? writeFiles(workDir, task.expected_files ?? {}) : [];
        const usdMicro = costOf(
          { tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens },
          input.model,
          input.pricing,
        );
        return {
          outputDir: workDir,
          finalText: passed ? (task.expected_final_text ?? text) : text,
          cost: {
            usdMicro,
            tokensIn: res.usage.input_tokens,
            tokensOut: res.usage.output_tokens,
            model: input.model,
          },
          notes: [
            `fake provider answered ${text} on ${input.model} at ${input.effort}; ${written.length} file(s) written`,
          ],
        };
      };
      const root = join(
        workRoot,
        safeSegment(`${input.specialist}-${input.model}-${input.effort}`),
      );
      mkdirSync(root, { recursive: true });
      const r = await runEvalSet({
        specialist: input.specialist,
        tasks,
        driver,
        clock: world.clock,
        workRoot: root,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (r.summary.errors > 0) {
        // An errored task is counted as failed by the grader; the harness wants it loud.
        const errored = r.results
          .filter((t) => t.error !== undefined)
          .map((t) => `${t.taskId}: ${t.error?.message ?? t.status}`);
        throw new Error(
          `eval set ${input.specialist} on ${input.model} at ${input.effort}: ${r.summary.errors} task(s) errored and were not graded: ${errored.join("; ")}`,
        );
      }
      return {
        total: r.summary.total,
        passed: r.summary.passed,
        failed: r.summary.failed,
        needsModel: r.summary.needsModel,
        passRate: r.summary.passRate,
        costUsdMicro: r.summary.costUsdMicro,
        durationMs: r.summary.durationMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The watch of an install, on the weekly schedule

export interface WatchRun {
  request: StartRequest;
  /** Simulated time the scheduler fired it. */
  at: string;
  result: Promise<ModelWatchRunResult>;
}

export interface ScenarioModelWatch {
  watch: ModelWatch;
  scheduler: Scheduler;
  schedule: Schedule;
  settings: modelSettings.FileModelSettingsStore;
  providers: ProviderRegistry;
  tasks: EvalTask[];
  /** Every run the scheduler started, in order. */
  runs: WatchRun[];
  /** Every adopt the watch handed to the runtime. */
  adopted: ModelWatchAdoptedEvent[];
  /** One scheduler tick, as the daemon's minute tick; resolves when any run it started ended. */
  tick(): Promise<void>;
}

export interface ScenarioModelWatchOptions {
  /** The install's config directory: where models.json and pricing.json are written. */
  configDir: string;
  /** Parent of the eval work directories. */
  workRoot: string;
  listed?: ModelRef[];
  priceList?: PriceList;
  tasks?: EvalTask[];
  thresholds?: Partial<WatchThresholds>;
}

export function scenarioModelWatch(
  world: ScenarioWorld,
  install: Install,
  opts: ScenarioModelWatchOptions,
): ScenarioModelWatch {
  const tasks = opts.tasks ?? coderEvalTasks(4);
  const providers = new ProviderRegistry().register(
    new ListingProvider(world.gated, opts.listed ?? LISTED_THIS_WEEK),
  );
  const settings = new modelSettings.FileModelSettingsStore({
    configDir: opts.configDir,
    nowIso: () => world.clock.nowIso(),
  });
  const adopted: ModelWatchAdoptedEvent[] = [];
  const watch = new ModelWatch({
    clock: world.clock,
    store: world.store,
    providers,
    priceList: new FixturePriceListSource(opts.priceList ?? CANDIDATE_PRICE_LIST),
    evals: evalRunnerOnWorld(world, providers, tasks, opts.workRoot),
    approvals: new StateModelWatchApprovals(world.store, { agentId: install.agent.id }),
    settings,
    humanId: install.human.id,
    agentId: install.agent.id,
    pricing: WATCH_PRICING,
    evalTargets: [{ specialist: "coder", mode: "coder" }],
    evalProvider: world.gated.name,
    // Alice's install has opted in to the weekly paid evals (`model_watch.run_evals`, ADR
    // 0089); without it the scheduled run is the free check and the gate's clause has no data.
    autoEvals: () => true,
    ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
    onAdopted: (ev) => {
      adopted.push(ev);
    },
  });
  const runs: WatchRun[] = [];
  // The daemon's start callback: a model watch request runs the watch, never a session.
  const scheduler = new Scheduler(
    {
      clock: world.clock,
      start: (req) => {
        if (!isModelWatchRequest(req)) {
          return Promise.reject(new Error(`not a model watch request: ${req.agentId}`));
        }
        const result = watch.run();
        runs.push({ request: req, at: world.clock.nowIso(), result });
        return result;
      },
    },
    60_000,
  );
  const schedule = scheduleModelWatch(scheduler, { timezone: install.human.timezone });
  return {
    watch,
    scheduler,
    schedule,
    settings,
    providers,
    tasks,
    runs,
    adopted,
    tick: async () => {
      const before = runs.length;
      await scheduler.tick();
      await Promise.all(runs.slice(before).map((r) => r.result));
    },
  };
}
