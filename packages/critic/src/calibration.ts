import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import type { CheckRunner, EvalDriver, EvalTask, EvalTaskResult } from "@forerunner/evals";
import {
  appDirs,
  type Clock,
  errorMessage,
  fromPosix,
  join,
  log,
  normalizeNewlines,
  systemClock,
} from "@forerunner/platform";
import { renderBrief } from "@forerunner/runtime";
import type { CriticService, ReviewContext } from "./critic.ts";
import type {
  CheckResultEvidence,
  ReviewEvidence,
  ReviewInput,
  ReviewOutput,
  ReviewTier,
  SourceFileEvidence,
  Verdict,
} from "./types.ts";

/**
 * Calibration against the golden eval set (H.7, phase 3 gate): every eval task is reviewed
 * twice, once with its clean expected output and once with its seeded defect, through the
 * same path a real task takes (evidence only, model by tier, rules in code). The report says
 * how many defects the critic flagged (verdict other than accept) and how many clean results it
 * accepted, against the gate thresholds, and is written under the data directory so drift is
 * visible month over month.
 *
 * The evidence per variant (`evidenceFor`) is what a real task's review gets: the brief, the
 * criteria plus the rubric's, the files on disk as a new-file diff, the runner's mechanical
 * check results as required checks, the final text as claims, and the task's fixtures the work
 * did not replace as source files, so a researcher's claims can be checked against the
 * document they cite (ADR 0041).
 *
 * The eval runner lives in @forerunner/evals, which depends on this package, so it is loaded
 * on demand (or injected) instead of imported statically.
 */
export const CALIBRATION_THRESHOLDS = { catchRate: 0.8, passRate: 0.9 } as const;

/** The eval functions calibration needs; the default is a dynamic import of @forerunner/evals. */
export interface EvalsPort {
  runEvalSet: typeof import("@forerunner/evals").runEvalSet;
  expectedOutputDriver: typeof import("@forerunner/evals").expectedOutputDriver;
}

export async function loadEvalsPort(): Promise<EvalsPort> {
  const m = await import("@forerunner/evals");
  return { runEvalSet: m.runEvalSet, expectedOutputDriver: m.expectedOutputDriver };
}

export interface CalibrateOptions {
  evalSet: EvalTask[];
  tier: Exclude<ReviewTier, 0>;
  critic: CriticService;
  /** Token, budget and settings for the review runs; writes are always skipped. */
  ctx: ReviewContext;
  /** Produces the work under review. Default: the expected-output driver (no model). */
  driver?: EvalDriver;
  checksRunner?: CheckRunner;
  evals?: EvalsPort;
  clock?: Clock;
  /** Where the report goes. Default `<data dir>/critic`. */
  outDir?: string;
  /** False returns the report without writing it. Default true. */
  write?: boolean;
  workRoot?: string;
  signal?: AbortSignal;
  onTask?: (row: CalibrationTaskRow) => void;
}

export interface CalibrationVariantResult {
  verdict: Verdict;
  grade: number;
  confidence: number;
  outcome: ReviewOutput["outcome"];
  findings: number;
  costUsdMicro: number;
  durationMs: number;
  /** What the mechanical checks said before the critic looked. */
  mechanical: EvalTaskResult["status"];
  summary: string;
}

export interface CalibrationTaskRow {
  taskId: string;
  title: string;
  specialist: string;
  clean: CalibrationVariantResult;
  /** Null when the task has no seeded defect. */
  seeded: CalibrationVariantResult | null;
  cleanPassed: boolean;
  defectCaught: boolean | null;
  defect?: string;
}

export interface CalibrationReport {
  date: string;
  startedAt: string;
  tier: ReviewTier;
  model: string;
  promptVersion?: string;
  thresholds: { catchRate: number; passRate: number };
  counts: {
    tasks: number;
    cleanReviewed: number;
    cleanAccepted: number;
    seededReviewed: number;
    defectsCaught: number;
  };
  catchRate: number;
  passRate: number;
  gate: { catchOk: boolean; passOk: boolean; ok: boolean };
  cost: { usdMicro: number; reviews: number; durationMs: number };
  tasks: CalibrationTaskRow[];
  file: string | null;
}

/** The report's rates and gate from its rows; exported so the arithmetic is testable alone. */
export function calibrationRates(
  rows: readonly CalibrationTaskRow[],
  thresholds: { catchRate: number; passRate: number } = CALIBRATION_THRESHOLDS,
): Pick<CalibrationReport, "counts" | "catchRate" | "passRate" | "gate"> {
  const cleanReviewed = rows.length;
  const cleanAccepted = rows.filter((r) => r.cleanPassed).length;
  const seeded = rows.filter((r) => r.seeded !== null);
  const defectsCaught = seeded.filter((r) => r.defectCaught === true).length;
  const catchRate = seeded.length === 0 ? 0 : defectsCaught / seeded.length;
  const passRate = cleanReviewed === 0 ? 0 : cleanAccepted / cleanReviewed;
  const catchOk = seeded.length > 0 && catchRate >= thresholds.catchRate;
  const passOk = cleanReviewed > 0 && passRate >= thresholds.passRate;
  return {
    counts: {
      tasks: rows.length,
      cleanReviewed,
      cleanAccepted,
      seededReviewed: seeded.length,
      defectsCaught,
    },
    catchRate,
    passRate,
    gate: { catchOk, passOk, ok: catchOk && passOk },
  };
}

/** A "new file" diff of the files the driver left, so the critic reads the actual content. */
export function renderFilesAsDiff(dir: string, files: readonly string[]): string {
  const parts: string[] = [];
  for (const rel of files) {
    const abs = join(dir, fromPosix(rel));
    if (!existsSync(abs)) continue;
    const body = normalizeNewlines(readFileSync(abs, "utf8")).replace(/\n$/, "");
    const lines = body === "" ? [] : body.split("\n");
    parts.push(
      `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

/**
 * The task's fixtures the work did not replace: the inputs the result is checked against (a
 * researcher's source documents, a coder's existing tests and manifest). A fixture the work
 * overwrote is in the diff as its new version and is not repeated here. The renderer bounds
 * the size (ADR 0041).
 */
export function sourceFilesFor(
  task: EvalTask,
  changedFiles: readonly string[],
): SourceFileEvidence[] {
  const changed = new Set(changedFiles);
  return Object.keys(task.setup.files)
    .filter((p) => !changed.has(p))
    .sort()
    .map((path) => ({ path, content: task.setup.files[path] as string }));
}

function filesOf(task: EvalTask, variant: "clean" | "seeded_defect"): string[] {
  const names = new Set(Object.keys(task.expected_files ?? {}));
  if (variant === "seeded_defect")
    for (const f of Object.keys(task.seeded_defect?.files ?? {})) names.add(f);
  return [...names].sort();
}

export function evidenceFor(
  task: EvalTask,
  variant: "clean" | "seeded_defect",
  result: EvalTaskResult,
  workDir: string | undefined,
): ReviewEvidence {
  const changedFiles = filesOf(task, variant);
  const checkResults: CheckResultEvidence[] = result.checks
    .filter((c) => c.status !== "needs_model")
    .map((c) => ({
      name: c.label,
      passed: c.status === "pass",
      output: [c.evidence, c.detail].filter((s): s is string => !!s).join("\n"),
      required: true,
    }));
  const rubric = task.checks.flatMap((c) => (c.kind === "rubric" ? c.criteria : []));
  const testOutput = result.checks
    .filter((c) => c.kind === "command_exit0")
    .map((c) => `${c.label}\n${c.evidence}${c.detail ? `\n${c.detail}` : ""}`)
    .join("\n\n");
  return {
    brief: renderBrief({ ...task.brief, specialist: task.specialist, taskId: task.id }),
    acceptanceCriteria: [...task.brief.acceptanceCriteria, ...rubric],
    sourceFiles: sourceFilesFor(task, changedFiles),
    changedFiles,
    moduleFilesTouched: [],
    docsTouched: [],
    diff: workDir ? renderFilesAsDiff(workDir, changedFiles) : undefined,
    checkResults,
    testOutput: testOutput || undefined,
    finalReport: result.finalText || undefined,
    artifacts: result.evidence,
  };
}

function variantResult(
  out: ReviewOutput,
  mechanical: EvalTaskResult["status"],
): CalibrationVariantResult {
  return {
    verdict: out.verdict,
    grade: out.grade,
    confidence: out.confidence,
    outcome: out.outcome,
    findings: out.findings.length,
    costUsdMicro: out.costUsdMicro,
    durationMs: out.durationMs,
    mechanical,
    summary: out.summary,
  };
}

export function calibrationFileName(date: string, time?: string): string {
  return time ? `calibration-${date}-${time}.json` : `calibration-${date}.json`;
}

export async function calibrate(opts: CalibrateOptions): Promise<CalibrationReport> {
  const logger = log("critic-calibration");
  const clock = opts.clock ?? systemClock;
  const evals = opts.evals ?? (await loadEvalsPort());
  const driver = opts.driver ?? evals.expectedOutputDriver();
  const startedAt = clock.nowIso();
  const t0 = clock.monotonic();
  const ownRoot = opts.workRoot === undefined;
  const workRoot = opts.workRoot ?? mkdtempSync(join(os.tmpdir(), "fr-critic-cal-"));
  mkdirSync(workRoot, { recursive: true });
  const ctx: ReviewContext = { ...opts.ctx, persist: false };
  const rows: CalibrationTaskRow[] = [];
  let costUsdMicro = 0;
  let reviews = 0;
  let model = "";
  let promptVersion: string | undefined;

  const reviewVariant = async (
    task: EvalTask,
    variant: "clean" | "seeded_defect",
  ): Promise<CalibrationVariantResult> => {
    const set = await evals.runEvalSet({
      specialist: task.specialist,
      tasks: [task],
      driver,
      checksRunner: opts.checksRunner,
      variant,
      workRoot,
      keepWorkDirs: true,
      clock,
      signal: opts.signal,
    });
    const result = set.results[0];
    if (!result) throw new Error(`eval runner returned no result for ${task.id}`);
    try {
      const input: ReviewInput = {
        subject: { kind: "task", taskId: task.id },
        tier: opts.tier,
        evidence: evidenceFor(task, variant, result, result.workDir),
      };
      const out = await opts.critic.review(input, ctx);
      costUsdMicro += out.costUsdMicro;
      reviews++;
      model = out.model;
      promptVersion = out.promptVersion ?? promptVersion;
      return variantResult(out, result.status);
    } finally {
      if (result.workDir) rmSync(result.workDir, { recursive: true, force: true });
    }
  };

  try {
    for (const task of opts.evalSet) {
      if (opts.signal?.aborted) break;
      const clean = await reviewVariant(task, "clean");
      const seeded = task.seeded_defect ? await reviewVariant(task, "seeded_defect") : null;
      const row: CalibrationTaskRow = {
        taskId: task.id,
        title: task.title,
        specialist: task.specialist,
        clean,
        seeded,
        cleanPassed: clean.verdict === "accept",
        defectCaught: seeded ? seeded.verdict !== "accept" : null,
        defect: task.seeded_defect?.description,
      };
      rows.push(row);
      opts.onTask?.(row);
    }
  } finally {
    if (ownRoot) rmSync(workRoot, { recursive: true, force: true });
  }

  const rates = calibrationRates(rows);
  const report: CalibrationReport = {
    date: startedAt.slice(0, 10),
    startedAt,
    tier: opts.tier,
    model,
    ...(promptVersion !== undefined ? { promptVersion } : {}),
    thresholds: { ...CALIBRATION_THRESHOLDS },
    ...rates,
    cost: {
      usdMicro: costUsdMicro,
      reviews,
      durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
    },
    tasks: rows,
    file: null,
  };
  if (opts.write !== false) {
    const outDir = opts.outDir ?? join(appDirs().data, "critic");
    try {
      mkdirSync(outDir, { recursive: true });
      let file = join(outDir, calibrationFileName(report.date));
      if (existsSync(file)) {
        file = join(
          outDir,
          calibrationFileName(report.date, startedAt.slice(11, 19).replace(/:/g, "")),
        );
      }
      writeFileSync(file, `${JSON.stringify({ ...report, file }, null, 2)}\n`, "utf8");
      report.file = file;
    } catch (e) {
      logger.warn("could not write the calibration report", { error: errorMessage(e) });
    }
  }
  logger.info("calibration finished", {
    tier: opts.tier,
    catchRate: report.catchRate,
    passRate: report.passRate,
    ok: report.gate.ok,
  });
  return report;
}

/** One line per task for logs and gate evidence. */
export function formatCalibrationReport(r: CalibrationReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `critic calibration ${r.date} tier ${r.tier} (${r.model}${r.promptVersion ? `, ${r.promptVersion}` : ""}): ` +
      `defects caught ${r.counts.defectsCaught}/${r.counts.seededReviewed} (${pct(r.catchRate)}, gate ${pct(r.thresholds.catchRate)} ${r.gate.catchOk ? "ok" : "FAIL"}), ` +
      `clean accepted ${r.counts.cleanAccepted}/${r.counts.cleanReviewed} (${pct(r.passRate)}, gate ${pct(r.thresholds.passRate)} ${r.gate.passOk ? "ok" : "FAIL"}), ` +
      `cost USD ${(r.cost.usdMicro / 1_000_000).toFixed(4)}`,
  ];
  for (const t of r.tasks) {
    lines.push(
      `  ${t.taskId.padEnd(16)} clean ${t.clean.verdict.padEnd(8)} ${String(t.clean.grade).padStart(3)}  ` +
        (t.seeded
          ? `seeded ${t.seeded.verdict.padEnd(8)} ${String(t.seeded.grade).padStart(3)}  ${t.defectCaught ? "caught" : "MISSED"}`
          : "no seeded defect"),
    );
  }
  return lines.join("\n");
}
