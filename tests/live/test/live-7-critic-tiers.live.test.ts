import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type CriticModelPick, evidenceFor, type ReviewOutput } from "@forerunner/critic";
import { closingReply, gateWorld, submitReview } from "@forerunner/e2e";
import { type EvalTask, expectedOutputDriver, loadEvalSet, runEvalSet } from "@forerunner/evals";
import { join, SimulatedClock, systemClock } from "@forerunner/platform";
import {
  effortForTask,
  MODE_DEFAULTS,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  modelIdFor,
  pricingFor,
  type StreamEvent,
} from "@forerunner/runtime";
import { REVIEW_VERDICTS } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { DRY_RUN_PRICING, dryRunCredentials } from "../src/dry-run.ts";
import { estimateSpend, preflight } from "../src/estimate.ts";
import { type LiveProvider, liveProvider, RM_TREE, repositoryRegistryDir } from "../src/harness.ts";
import { liveEnabled, reportDir, SKIP_REASON, usd, writeReport } from "../src/report.ts";

/**
 * D.15 on the live model (spec: "Critic tier 2 and 3: default Opus 5.5, effort high or max,
 * time set by task budget"): the real critic service (the phase 3 calibration world,
 * `gateWorld`, with the metered provider as the critic's provider) reviews one task of the
 * coder eval set the phase 3 half calibrates on (`coder-001`), once with its clean result and
 * once with its seeded defect, at tier 2 and at tier 3: four reviews. The evidence is built the
 * way `calibrate()` builds it (`evidenceFor`: the eval runner's checks, the produced files as
 * a diff, nothing that names the variant). The model and effort come from the tier table
 * (`pickCriticModel`: tier 2 Opus at high, tier 3 Opus at max); every request the critic sends
 * is recorded so the effort actually sent is checked, not assumed. The review budget is the
 * eval task's own budget (USD 0.50), the time limit the tier's deep-review timeout.
 *
 * Measured per review: wall time of the review call (the calibration world runs on a
 * `SimulatedClock`, so the critic's own `durationMs` reads 0 and the harness times it), the
 * first call's time to first token, the model calls and their durations, USD, the verdict, the
 * model's verdict before the rules, grade and confidence. Asserted: every review completed with
 * a verdict, on the table's model and effort, inside its time limit and its budget; tier 3 ends
 * `human` (rule 4 of the verdict rules, spec H.2). The calibration's own per-variant reading
 * (seeded caught = not accept, clean passed = accept, `calibrate()`) is recorded and logged as
 * a soft check: the spec's gate is a rate over the eval set (H.7: 80% and 90%), which one
 * review per variant cannot fail or pass, so a miss is reported, not failed.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);
const TASK_ID = "coder-001";
const TIERS = [2, 3] as const;
const VARIANTS = ["clean", "seeded_defect"] as const;
type DeepTier = (typeof TIERS)[number];
type Variant = (typeof VARIANTS)[number];

function calibrationTask(): EvalTask {
  const set = loadEvalSet(join(repositoryRegistryDir(), "evals", "coder"));
  const task = set.find((t) => t.id === TASK_ID);
  if (!task?.seeded_defect) throw new Error(`${TASK_ID} with a seeded defect not found`);
  return task;
}

/** Passes every call through and records what was asked for (the model and the effort sent). */
class RequestLog implements ModelProvider {
  readonly name: string;
  readonly requests: { model: string; effort: string | null; maxTokens: number }[] = [];
  constructor(private readonly inner: ModelProvider) {
    this.name = inner.name;
  }
  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
  private note(req: ModelRequest): void {
    this.requests.push({ model: req.model, effort: req.effort ?? null, maxTokens: req.max_tokens });
  }
  stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.note(req);
    return this.inner.stream(req);
  }
  complete(req: ModelRequest): Promise<ModelResponse> {
    this.note(req);
    return this.inner.complete(req);
  }
}

export interface TierReviewEvidence {
  tier: DeepTier;
  variant: Variant;
  taskId: string;
  pick: Pick<CriticModelPick, "model" | "effort" | "timeoutMs" | "targetMs">;
  budgetUsd: number;
  requests: { model: string; effort: string | null; maxTokens: number }[];
  /** The eval runner's preparation and checks before the review (not part of the review). */
  prepMs: number;
  wallMs: number;
  firstTokenMs: number | null;
  modelCalls: number;
  callMs: number[];
  callStatus: string[];
  usd: number;
  tokensIn: number;
  tokensOut: number;
  outcome: ReviewOutput["outcome"];
  verdict: ReviewOutput["verdict"];
  /** What the model returned before the verdict rules (the first adjustment's `from`). */
  modelVerdict: string;
  grade: number;
  confidence: number;
  findings: number;
  adjustments: string[];
  /** `calibrate()`'s reading of this variant: seeded caught = not accept, clean passed = accept. */
  calibration: { defectCaught: boolean | null; cleanPassed: boolean | null };
}

interface TierRunOptions {
  lp: LiveProvider;
  log: RequestLog;
  task: EvalTask;
  pricing: (model: string) => ReturnType<typeof pricingFor>;
  sessionBudgetUsdMicro: number;
  onReview?: (e: TierReviewEvidence) => void;
}

/** Four reviews (two tiers x two variants) of one eval task; everything measured, nothing asserted. */
async function tierReviews(o: TierRunOptions): Promise<TierReviewEvidence[]> {
  const w = await gateWorld({
    replies: [],
    memory: false,
    critic: { provider: o.log, pricing: o.pricing },
  });
  const out: TierReviewEvidence[] = [];
  const workRoot = mkdtempSync(join(tmpdir(), "fr-live-tiers-"));
  try {
    const project = await w.addProject({
      name: "Critic tiers",
      goal: "Deep reviews of one eval task at tiers 2 and 3 on the live model",
      members: [w.alice],
    });
    const budgetUsdMicro = o.task.brief.budgetUsdMicro;
    const base = await w.reviewContext(project, o.sessionBudgetUsdMicro);
    const projectSettings = (await w.store.project.mustGet(project)).settings;
    for (const tier of TIERS) {
      for (const variant of VARIANTS) {
        const ctx = { ...base, budgetUsdMicro, persist: false };
        // The pick the review makes: the tier table under the project's settings (the review
        // reads the same project row through the session token).
        const pick = w.critic.service.modelFor(tier, { projectSettings });
        const p0 = performance.now();
        const set = await runEvalSet({
          specialist: o.task.specialist,
          tasks: [o.task],
          driver: expectedOutputDriver(),
          variant,
          workRoot,
          keepWorkDirs: true,
          clock: systemClock,
        });
        const result = set.results[0];
        if (!result) throw new Error(`eval runner returned no result for ${o.task.id}`);
        const prepMs = Math.round(performance.now() - p0);
        const callMark = o.lp.provider.calls.length;
        const reqMark = o.log.requests.length;
        const t0 = performance.now();
        let review: ReviewOutput;
        try {
          review = await w.critic.service.review(
            {
              subject: { kind: "task", taskId: o.task.id },
              tier,
              evidence: evidenceFor(o.task, variant, result, result.workDir),
            },
            ctx,
          );
        } finally {
          if (result.workDir) rmSync(result.workDir, RM_TREE);
        }
        const wallMs = Math.round(performance.now() - t0);
        const calls = o.lp.provider.calls.slice(callMark);
        const accepted = review.verdict === "accept";
        const e: TierReviewEvidence = {
          tier,
          variant,
          taskId: o.task.id,
          pick: {
            model: pick.model,
            effort: pick.effort,
            timeoutMs: pick.timeoutMs,
            targetMs: pick.targetMs,
          },
          budgetUsd: budgetUsdMicro / 1e6,
          requests: o.log.requests.slice(reqMark),
          prepMs,
          wallMs,
          firstTokenMs: calls[0]?.ttftMs ?? null,
          modelCalls: calls.length,
          callMs: calls.map((c) => c.durationMs),
          callStatus: calls.map((c) => c.status),
          usd: Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
          tokensIn: calls.reduce((s, c) => s + c.tokensIn + c.cacheRead + c.cacheWrite, 0),
          tokensOut: calls.reduce((s, c) => s + c.tokensOut, 0),
          outcome: review.outcome,
          verdict: review.verdict,
          modelVerdict: review.adjustments[0]?.from ?? review.verdict,
          grade: review.grade,
          confidence: review.confidence,
          findings: review.findings.length,
          adjustments: review.adjustments.map((a) => `${a.rule}: ${a.from} -> ${a.to}`),
          calibration: {
            defectCaught: variant === "seeded_defect" ? !accepted : null,
            cleanPassed: variant === "clean" ? accepted : null,
          },
        };
        out.push(e);
        o.onReview?.(e);
      }
    }
    // Calibration never persists: the world's store holds no review or finding from it.
    expect(await w.store.review.count()).toBe(0);
    return out;
  } finally {
    rmSync(workRoot, RM_TREE);
    await w.close();
  }
}

/** One line per review for gates.md's D.15 row. */
export function tierReviewLine(e: TierReviewEvidence): string {
  const soft =
    e.tier === 2
      ? e.variant === "seeded_defect"
        ? e.calibration.defectCaught
          ? ", defect caught"
          : ", defect MISSED (soft)"
        : e.calibration.cleanPassed
          ? ", clean accepted"
          : ", clean not accepted (soft)"
      : `, model said ${e.modelVerdict} before the sign-off rule`;
  return (
    `D.15 critic tier ${e.tier} (${e.pick.model}, effort ${e.pick.effort}) ${e.taskId} ${e.variant}: ` +
    `${e.verdict} ${e.grade} (confidence ${e.confidence.toFixed(2)})${soft}; ` +
    `review ${(e.wallMs / 1000).toFixed(1)} s, first token ${e.firstTokenMs === null ? "n/a" : `${e.firstTokenMs} ms`}, ` +
    `${e.modelCalls} model calls, ${e.tokensIn} in / ${e.tokensOut} out tokens, ${usd(e.usd)} ` +
    `(limit ${e.pick.timeoutMs / 60_000} min, ${usd(e.budgetUsd)})`
  );
}

/** What D.15, the tier table and the verdict rules say must hold; the same for both modes. */
function assertTierReview(e: TierReviewEvidence, providerName: string, lp: LiveProvider): void {
  const label = `tier ${e.tier} ${e.variant}`;
  // The tier table: Opus, high at tier 2 and max at tier 3, as sent on every request.
  expect(e.pick.model, label).toBe(modelIdFor(MODE_DEFAULTS.critic_t23.tier, providerName));
  expect(e.pick.effort, label).toBe(effortForTask("critic_t23", e.tier));
  expect(e.pick.effort, label).toBe(e.tier === 2 ? "high" : "max");
  expect(e.requests.length, label).toBeGreaterThanOrEqual(1);
  for (const r of e.requests) {
    expect(r.model, label).toBe(e.pick.model);
    expect(r.effort, label).toBe(e.pick.effort);
  }
  // Completed with a verdict, inside the tier's time limit and the review's budget.
  expect(e.outcome, `${label}: ${e.adjustments.join("; ")}`).toBe("completed");
  expect(REVIEW_VERDICTS as readonly string[]).toContain(e.verdict);
  expect(e.modelCalls, label).toBe(e.requests.length);
  expect(
    e.callStatus.every((s) => s === "ok"),
    label,
  ).toBe(true);
  expect(e.wallMs, label).toBeLessThanOrEqual(e.pick.timeoutMs);
  expect(e.usd, label).toBeGreaterThan(0);
  expect(e.usd, label).toBeLessThanOrEqual(e.budgetUsd);
  // Tier 3 is a deep review plus a human sign-off (spec H.2; rule 4 in packages/critic rules.ts).
  if (e.tier === 3) expect(e.verdict, label).toBe("human");
  expect(lp.budget.refusals).toEqual([]);
}

function softChecks(reviews: readonly TierReviewEvidence[]): string[] {
  const misses: string[] = [];
  for (const e of reviews) {
    if (e.tier !== 2) continue;
    if (e.calibration.defectCaught === false) misses.push(`tier 2 seeded accepted (${e.grade})`);
    if (e.calibration.cleanPassed === false) misses.push(`tier 2 clean ${e.verdict} (${e.grade})`);
  }
  return misses;
}

describe("D.15 critic tiers 2 and 3, dry run (scripted provider, no network)", () => {
  let lp: LiveProvider;
  let ledgerDir = "";
  const clock = new SimulatedClock("2026-10-25T09:00:00Z");
  const revise = (grade: number) =>
    submitReview(
      {
        grade,
        verdict: "revise",
        summary: "The change does not meet the brief.",
        findings: [{ severity: "major", what: "the seeded defect", required_action: "fix it" }],
      },
      { times: 1 },
    );

  beforeAll(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-dry-tiers-"));
    lp = liveProvider({
      env: { FORERUNNER_LIVE_RUN: "dry-run-tiers" },
      clock,
      inner: new FakeProvider({
        mode: "script",
        clock,
        latency: "none",
        onNoMatch: "throw",
        // In review order: tier 2 clean, tier 2 seeded, tier 3 clean, tier 3 seeded.
        replies: [
          submitReview({}, { times: 1 }),
          revise(40),
          submitReview({}, { times: 1 }),
          revise(35),
          closingReply(),
        ],
      }),
      credentials: dryRunCredentials(),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd: 15, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
    });
  });
  afterAll(() => {
    if (ledgerDir) rmSync(ledgerDir, RM_TREE);
  });

  it("four reviews on the tier table's model and effort, measured and asserted like the live run", async () => {
    const log = new RequestLog(lp.provider);
    const reviews = await tierReviews({
      lp,
      log,
      task: calibrationTask(),
      pricing: (m) => pricingFor(m, DRY_RUN_PRICING),
      sessionBudgetUsdMicro: 2_000_000,
    });
    for (const e of reviews) console.log(tierReviewLine(e));
    expect(reviews.map((e) => `${e.tier}:${e.variant}`)).toEqual([
      "2:clean",
      "2:seeded_defect",
      "3:clean",
      "3:seeded_defect",
    ]);
    for (const e of reviews) assertTierReview(e, "fake", lp);
    expect(reviews.map((e) => e.verdict)).toEqual(["accept", "revise", "human", "human"]);
    expect(reviews.map((e) => e.modelVerdict)).toEqual(["accept", "revise", "accept", "revise"]);
    expect(softChecks(reviews)).toEqual([]);
    expect(lp.ledger.rows().every((r) => r.model === "fake-opus")).toBe(true);
    expect(lp.ledger.rows()).toHaveLength(lp.provider.calls.length);
  });
});

describe(`D.15 critic tiers 2 and 3, live${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let lp: LiveProvider;
  let dir = "";
  const evidence: Record<string, unknown> = {};
  let ceilingUsd = 0;

  beforeAll(() => {
    if (!LIVE) return;
    dir = reportDir();
    lp = liveProvider();
    const task = calibrationTask();
    const opus = modelIdFor(MODE_DEFAULTS.critic_t23.tier, "anthropic");
    // Input: the critic prompt plus the task (brief, files, checks) as the evidence carries it,
    // and the request scaffolding; output: a review with its findings and thinking at high/max.
    const critic = readFileSync(join(repositoryRegistryDir(), "critic", "critic.md"), "utf8");
    const inputTokens = lp.provider.countTokens(critic + JSON.stringify(task)) + 1_500;
    const reviews = TIERS.length * VARIANTS.length;
    ceilingUsd = (reviews * task.brief.budgetUsdMicro) / 1e6;
    const estimate = estimateSpend(
      "live-7-critic-tiers",
      [
        { label: "tier 2 reviews", model: opus, calls: 4, inputTokens, outputTokens: 2_500 },
        { label: "tier 3 reviews", model: opus, calls: 4, inputTokens, outputTokens: 4_000 },
      ],
      ceilingUsd,
    );
    evidence.estimate = estimate;
    try {
      const pf = preflight(lp.budget, estimate);
      console.log(`live run ${lp.run}; reports in ${dir}; ${pf.line}`);
    } catch (e) {
      console.log(`live run ${lp.run}: ${(e as Error).message}`);
      throw e;
    }
  });
  afterAll(() => {
    if (!lp) return;
    const file = writeReport(dir, "critic-tiers-live", {
      run: lp.run,
      ...evidence,
      budget: lp.budget.snapshot(),
      totals: lp.provider.totals(),
      calls: lp.provider.calls,
    });
    console.log(`critic tiers live report: ${file}\n${budgetLine(lp.budget)}`);
  });

  live(
    `${TASK_ID} clean and seeded at tier 2 and tier 3 on the tier table's Opus and effort, each inside its limits`,
    async () => {
      const log = new RequestLog(lp.provider);
      const reviews = await tierReviews({
        lp,
        log,
        task: calibrationTask(),
        pricing: (m) => pricingFor(m),
        // The hooks' cap for all four reviews: their budgets together, never above what the run has left.
        sessionBudgetUsdMicro: Math.round(
          Math.min(ceilingUsd, lp.budget.snapshot().remainingRunUsd) * 1e6,
        ),
        onReview: (e) => console.log(tierReviewLine(e)),
      });
      const misses = softChecks(reviews);
      evidence.reviews = reviews;
      evidence.summaryLines = reviews.map(tierReviewLine);
      evidence.softMisses = misses;
      console.log(JSON.stringify(reviews, null, 2));
      if (misses.length > 0) {
        console.warn(`soft check (calibration reading, not a gate): ${misses.join("; ")}`);
      }
      for (const e of reviews) assertTierReview(e, "anthropic", lp);
    },
  );
});
