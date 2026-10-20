import { writeFileSync } from "node:fs";
import {
  CALIBRATION_THRESHOLDS,
  type CalibrationReport,
  calibrate,
  formatCalibrationReport,
} from "@forerunner/critic";
import { gateWorld } from "@forerunner/e2e";
import { type EvalTask, expectedOutputDriver, loadEvalSet, runEvalSet } from "@forerunner/evals";
import { join, systemClock } from "@forerunner/platform";
import { MODE_DEFAULTS, pricingFor } from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { type LiveProvider, liveProvider, repositoryRegistryDir } from "../src/harness.ts";
import { liveEnabled, reportDir, SKIP_REASON, usd, writeReport } from "../src/report.ts";
import { summarize } from "../src/stats.ts";

/**
 * Phase 3 gate on a live model (spec: "critic catches at least 80% of seeded defects and
 * passes at least 90% of clean work"): `calibrate()` over a 10-task subset of the coder eval
 * set (10 clean + 10 seeded reviews) with the real critic at tier 1 (Sonnet, ADR 0028), then
 * the full 40-task run (coder and researcher, 80 reviews) only when the ledger allows it under
 * the per-run cap. The escalation-ceiling half of the gate stays on the fake provider
 * (tests/e2e). Every review runs under the e2e world's hooks with a session budget the hooks
 * enforce, behind the metered provider's own gate.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);
const SUBSET = 10;
/** Enough for a Sonnet review of a small diff with its rationale; the 30 s target is reported, not enforced. */
const REVIEW_TIMEOUT_MS = 120_000;
const FULL_RUN_SAFETY = 1.5;

interface CalibrationEvidence {
  label: string;
  tasks: number;
  reviews: number;
  catchRate: number;
  passRate: number;
  counts: CalibrationReport["counts"];
  gate: CalibrationReport["gate"];
  model: string;
  promptVersion: string | undefined;
  costUsd: number;
  durationMs: number;
  /** Wall time per task (its clean and seeded review plus the eval runner's checks), measured here. */
  taskPairWallMs: ReturnType<typeof summarize>;
  /** Wall time of every critic model call in this calibration, from the metered provider. */
  modelCallMs: ReturnType<typeof summarize>;
  modelCalls: number;
  overTargetTaskPairs: number;
  missed: string[];
  falseRevises: string[];
  file: string | null;
}

function summarizeReport(
  label: string,
  r: CalibrationReport,
  timing: { pairWallMs: number[]; callMs: number[] },
): CalibrationEvidence {
  return {
    label,
    tasks: r.counts.tasks,
    reviews: r.cost.reviews,
    catchRate: r.catchRate,
    passRate: r.passRate,
    counts: r.counts,
    gate: r.gate,
    model: r.model,
    promptVersion: r.promptVersion,
    costUsd: r.cost.usdMicro / 1e6,
    durationMs: r.cost.durationMs,
    taskPairWallMs: summarize(timing.pairWallMs),
    modelCallMs: summarize(timing.callMs),
    modelCalls: timing.callMs.length,
    // A task pair holds two reviews: over target when the pair took longer than two targets.
    overTargetTaskPairs: timing.pairWallMs.filter((d) => d > 2 * MODE_DEFAULTS.critic_t1.targetMs)
      .length,
    missed: r.tasks.filter((t) => t.seeded && !t.defectCaught).map((t) => t.taskId),
    falseRevises: r.tasks
      .filter((t) => !t.cleanPassed)
      .map((t) => `${t.taskId}:${t.clean.verdict}`),
    file: r.file,
  };
}

describe(`phase 3 gate, critic calibration on the live model${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let lp: LiveProvider;
  let dir = "";
  const evidence: Record<string, unknown> = {};

  beforeAll(() => {
    if (!LIVE) return;
    dir = reportDir();
    lp = liveProvider();
  });
  afterAll(() => {
    if (!lp) return;
    const file = writeReport(dir, "phase3-live", {
      run: lp.run,
      ...evidence,
      budget: lp.budget.snapshot(),
      totals: lp.provider.totals(),
      calls: lp.provider.calls,
    });
    console.log(`phase 3 live report: ${file}\n${budgetLine(lp.budget)}`);
  });

  async function runCalibration(
    label: string,
    tasks: EvalTask[],
  ): Promise<{ report: CalibrationReport; timing: { pairWallMs: number[]; callMs: number[] } }> {
    const pairWallMs: number[] = [];
    const callMark = lp.provider.calls.length;
    let lastAt = performance.now();
    const w = await gateWorld({
      replies: [],
      memory: false,
      critic: { provider: lp.provider, pricing: (m) => pricingFor(m) },
    });
    try {
      const project = await w.addProject({
        name: `Calibration (${label})`,
        goal: "Critic calibration against the golden eval set on the live model",
        members: [w.alice],
      });
      // The hooks' hard cap for this calibration: what the run may still spend.
      const remaining = lp.budget.snapshot().remainingRunUsd;
      expect(remaining).toBeGreaterThan(0);
      const ctx = {
        ...(await w.reviewContext(project, Math.round(remaining * 1e6))),
        timeoutMs: REVIEW_TIMEOUT_MS,
      };
      const report = await calibrate({
        evalSet: tasks,
        tier: 1,
        critic: w.critic.service,
        ctx,
        evals: { runEvalSet, expectedOutputDriver },
        clock: systemClock,
        outDir: dir,
        onTask: (row) => {
          const now = performance.now();
          pairWallMs.push(Math.round(now - lastAt));
          lastAt = now;
          console.log(
            `${row.taskId}: clean ${row.clean.verdict} ${row.clean.grade} (${row.clean.durationMs} ms), ` +
              `seeded ${row.seeded?.verdict ?? "-"} ${row.seeded?.grade ?? "-"} (${row.seeded?.durationMs ?? "-"} ms) ` +
              `${row.defectCaught ? "caught" : "MISSED"}`,
          );
        },
      });
      const text = formatCalibrationReport(report);
      console.log(text);
      writeFileSync(join(dir, `phase3-calibration-live-${label}.txt`), `${text}\n`, "utf8");
      // Calibration never persists: the world's store holds no review or finding from it.
      expect(await w.store.review.count()).toBe(0);
      expect(await w.store.finding.count()).toBe(0);
      const callMs = lp.provider.calls
        .slice(callMark)
        .filter((c) => c.status === "ok")
        .map((c) => c.durationMs);
      return { report, timing: { pairWallMs, callMs } };
    } finally {
      await w.close();
    }
  }

  live(
    `calibrate() over ${SUBSET} coder tasks (${SUBSET} clean + ${SUBSET} seeded reviews) on the real tier 1 critic`,
    async () => {
      const coder = loadEvalSet(join(repositoryRegistryDir(), "evals", "coder"));
      expect(coder).toHaveLength(20);
      const subset = coder.slice(0, SUBSET);
      const { report, timing } = await runCalibration("subset", subset);
      const summary = summarizeReport("coder subset", report, timing);
      evidence.subset = summary;
      console.log(JSON.stringify(summary, null, 2));
      expect(report.counts).toMatchObject({
        tasks: SUBSET,
        cleanReviewed: SUBSET,
        seededReviewed: SUBSET,
      });
      expect(report.cost.reviews).toBe(2 * SUBSET);
      expect(report.model).toBe(
        MODE_DEFAULTS.critic_t1.tier === "sonnet" ? "claude-sonnet-5-5" : report.model,
      );
      expect(lp.budget.refusals).toEqual([]);
      // The gate itself.
      expect(
        report.catchRate,
        `catch rate ${report.catchRate} (missed: ${summary.missed.join(", ") || "none"})`,
      ).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.catchRate);
      expect(
        report.passRate,
        `pass rate ${report.passRate} (sent back: ${summary.falseRevises.join(", ") || "none"})`,
      ).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.passRate);
      expect(report.gate.ok).toBe(true);
    },
  );

  live(
    "the full 40-task run (coder and researcher, 80 reviews) only when the ledger allows it under the per-run cap",
    async () => {
      const subset = evidence.subset as CalibrationEvidence | undefined;
      expect(subset, "the subset ran first").toBeDefined();
      if (!subset) return;
      const perReview = subset.costUsd / subset.reviews;
      const estimateUsd = Math.round(perReview * 80 * FULL_RUN_SAFETY * 1e6) / 1e6;
      const remaining = lp.budget.snapshot().remainingRunUsd;
      const decision = {
        perReviewUsd: Math.round(perReview * 1e6) / 1e6,
        estimateUsd,
        safetyFactor: FULL_RUN_SAFETY,
        remainingRunUsd: remaining,
        runCapUsd: lp.budget.config.runCapUsd,
        allowed: remaining >= estimateUsd,
      };
      evidence.fullDecision = decision;
      console.log(`full run decision: ${JSON.stringify(decision)}`);
      if (!decision.allowed) {
        console.log(
          `full 40-task run skipped: estimated ${usd(estimateUsd)} exceeds the remaining per-run allowance of ${usd(remaining)}`,
        );
        evidence.full = null;
        return;
      }
      const tasks: EvalTask[] = [
        ...loadEvalSet(join(repositoryRegistryDir(), "evals", "coder")),
        ...loadEvalSet(join(repositoryRegistryDir(), "evals", "researcher")),
      ];
      expect(tasks).toHaveLength(40);
      const { report, timing } = await runCalibration("full", tasks);
      const summary = summarizeReport("full set", report, timing);
      evidence.full = summary;
      console.log(JSON.stringify(summary, null, 2));
      expect(report.counts).toMatchObject({ tasks: 40, cleanReviewed: 40, seededReviewed: 40 });
      expect(lp.budget.refusals).toEqual([]);
      expect(
        report.catchRate,
        `catch rate ${report.catchRate} (missed: ${summary.missed.join(", ") || "none"})`,
      ).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.catchRate);
      expect(
        report.passRate,
        `pass rate ${report.passRate} (sent back: ${summary.falseRevises.join(", ") || "none"})`,
      ).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.passRate);
      expect(report.gate.ok).toBe(true);
    },
  );
});
