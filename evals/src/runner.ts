import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import {
  basename,
  type Clock,
  dirname,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isForerunnerError,
  isInside,
  join,
  log,
  resolve,
  systemClock,
  toPosix,
} from "@forerunner/platform";
import type { DelegationBrief } from "@forerunner/runtime";
import { type CheckContext, type CheckRunner, runCheck } from "./checks.ts";
import {
  type CheckResult,
  type EvalSetResult,
  type EvalSummary,
  type EvalTask,
  type EvalTaskResult,
  EvalTaskSchema,
  type EvalVariant,
} from "./types.ts";

const logger = log("evals");

export const TASK_FILE_RE = /^(\d{3})-([a-z0-9-]+)\.json$/;

export interface EvalSetIssue {
  file: string;
  field: string;
  message: string;
}

/** Parse and validate one task file. Throws `validation` naming the file and field. */
export function loadEvalTask(file: string): EvalTask {
  const name = basename(file);
  const m = name.match(TASK_FILE_RE);
  if (!m) {
    throw new ForerunnerError("validation", `${name}: task files are named NNN-<slug>.json`, {
      details: { file, issues: [{ file: name, field: "-", message: "bad file name" }] },
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ForerunnerError("validation", `${name}: not valid JSON: ${errorMessage(e)}`, {
      details: { file, issues: [{ file: name, field: "-", message: errorMessage(e) }] },
    });
  }
  const parsed = EvalTaskSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: EvalSetIssue[] = parsed.error.issues.map((i) => ({
      file: name,
      field: i.path.map(String).join(".") || "-",
      message: i.message,
    }));
    throw new ForerunnerError(
      "validation",
      `${name}: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      { details: { file, issues } },
    );
  }
  const task = parsed.data;
  const issues: EvalSetIssue[] = [];
  if (!task.id.endsWith(`-${m[1]}`)) {
    issues.push({
      file: name,
      field: "id",
      message: `id "${task.id}" must end with the file number ${m[1]}`,
    });
  }
  const dir = basename(dirname(resolve(file)));
  if (task.specialist !== dir) {
    issues.push({
      file: name,
      field: "specialist",
      message: `"${task.specialist}" must match the directory "${dir}"`,
    });
  }
  if (
    task.seeded_defect &&
    !task.seeded_defect.files &&
    task.seeded_defect.final_text === undefined
  ) {
    issues.push({
      file: name,
      field: "seeded_defect",
      message: "needs files or final_text to produce the defective variant",
    });
  }
  if (issues.length) {
    throw new ForerunnerError(
      "validation",
      `${name}: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      { details: { file, issues } },
    );
  }
  return task;
}

/** Load every task of an eval set directory, sorted by file name. Ids must be unique. */
export function loadEvalSet(dir: string): EvalTask[] {
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new ForerunnerError("not_found", `eval set directory not found: ${root}`, {
      details: { dir: root },
    });
  }
  const files = readdirSync(root)
    .filter((f) => TASK_FILE_RE.test(f))
    .sort();
  const tasks: EvalTask[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const t = loadEvalTask(join(root, f));
    if (seen.has(t.id)) {
      throw new ForerunnerError("validation", `${f}: duplicate task id "${t.id}"`, {
        details: { file: f, issues: [{ file: f, field: "id", message: "duplicate" }] },
      });
    }
    seen.add(t.id);
    tasks.push(t);
  }
  return tasks;
}

/** The brief a driver hands to the specialist (spec C: the enforced template). */
export function toDelegationBrief(task: EvalTask): DelegationBrief {
  return { ...task.brief, specialist: task.specialist, taskId: task.id };
}

export interface EvalDriverInput {
  task: EvalTask;
  /** Prepared directory with setup.files written; the specialist works here. */
  workDir: string;
  variant: EvalVariant;
  brief: DelegationBrief;
  signal?: AbortSignal;
}

export interface EvalDriverOutput {
  /** Where the checks look; normally workDir. */
  outputDir: string;
  finalText: string;
  cost: { usdMicro: number; tokensIn?: number; tokensOut?: number; model?: string };
  /** Extra evidence lines the driver wants in the report (commands it ran, run id). */
  notes?: string[];
}

/** Runs one task: a real specialist through the runtime, or a fake in tests. */
export type EvalDriver = (input: EvalDriverInput) => Promise<EvalDriverOutput>;

export interface RunEvalSetOptions {
  specialist: string;
  tasks: EvalTask[];
  driver: EvalDriver;
  checksRunner?: CheckRunner;
  variant?: EvalVariant;
  /** Parent of the per-task work directories. Default: a fresh temp directory. */
  workRoot?: string;
  keepWorkDirs?: boolean;
  clock?: Clock;
  promptVersion?: string;
  signal?: AbortSignal;
  onTask?: (result: EvalTaskResult) => void;
}

/** Write a map of relative files under `dir`, creating directories; refuses escapes. */
export function writeFiles(dir: string, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, fromPosix(rel));
    if (!isInside(dir, abs)) {
      throw new ForerunnerError(
        "path_not_allowed",
        `fixture path escapes the task directory: ${rel}`,
        {
          details: { path: rel },
        },
      );
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return written;
}

/** Create the task directory and write the fixture files. */
export function prepareWorkDir(task: EvalTask, workRoot: string, suffix = "clean"): string {
  const dir = join(workRoot, `${task.id}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, task.setup.files);
  return dir;
}

/**
 * A driver that writes the reference solution (or the seeded-defect variant) instead of calling
 * a model. It makes the runner, the checks and the task files testable with no provider, and it
 * is what the critic calibration gate runs: the critic must accept the clean variant and catch
 * the seeded defect.
 */
export function expectedOutputDriver(opts: { costUsdMicro?: number } = {}): EvalDriver {
  return async ({ task, workDir, variant }) => {
    const files = { ...(task.expected_files ?? {}) };
    let finalText = task.expected_final_text ?? task.expected_clean_output ?? "";
    if (variant === "seeded_defect") {
      if (!task.seeded_defect) {
        throw new ForerunnerError("not_found", `${task.id} has no seeded_defect variant`, {
          details: { taskId: task.id },
        });
      }
      Object.assign(files, task.seeded_defect.files ?? {});
      if (task.seeded_defect.final_text !== undefined) finalText = task.seeded_defect.final_text;
    }
    const written = writeFiles(workDir, files);
    return {
      outputDir: workDir,
      finalText,
      cost: { usdMicro: opts.costUsdMicro ?? 0 },
      notes: [`expected-output driver (${variant}) wrote ${written.length} file(s)`],
    };
  };
}

export function taskStatusOf(checks: CheckResult[]): EvalTaskResult["status"] {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "needs_model")) return "needs_model";
  return "pass";
}

export function summarize(results: EvalTaskResult[], durationMs = 0): EvalSummary {
  const passed = results.filter((r) => r.status === "pass").length;
  const errors = results.filter((r) => r.status === "error").length;
  const failed = results.filter((r) => r.status === "fail").length + errors;
  const needsModel = results.filter((r) => r.status === "needs_model").length;
  const decided = passed + failed;
  return {
    total: results.length,
    passed,
    failed,
    needsModel,
    errors,
    passRate: decided === 0 ? 0 : passed / decided,
    costUsdMicro: results.reduce((s, r) => s + r.costUsdMicro, 0),
    durationMs,
  };
}

/**
 * Run every task of a set through the driver and the checks. Mechanical checks decide pass or
 * fail; rubric checks leave the task at `needs_model` for the critic. Nothing here calls a
 * model: the driver does, when it is a real one.
 */
export async function runEvalSet(opts: RunEvalSetOptions): Promise<EvalSetResult> {
  const clock = opts.clock ?? systemClock;
  const variant = opts.variant ?? "clean";
  const checksRunner = opts.checksRunner ?? runCheck;
  const startedAt = clock.nowIso();
  const t0 = clock.monotonic();
  const ownRoot = opts.workRoot === undefined;
  const workRoot = opts.workRoot ?? mkdtempSync(join(os.tmpdir(), "fr-eval-"));
  mkdirSync(workRoot, { recursive: true });
  const results: EvalTaskResult[] = [];

  for (const task of opts.tasks) {
    if (opts.signal?.aborted) break;
    if (task.specialist !== opts.specialist) {
      throw new ForerunnerError(
        "validation",
        `task ${task.id} is for "${task.specialist}", not "${opts.specialist}"`,
        {
          details: { taskId: task.id },
        },
      );
    }
    const taskT0 = clock.monotonic();
    const evidence: string[] = [];
    let workDir: string | undefined;
    let result: EvalTaskResult;
    try {
      workDir = prepareWorkDir(task, workRoot, `${variant}-${results.length}`);
      evidence.push(
        `fixture: ${Object.keys(task.setup.files).length} file(s) in ${toPosix(basename(workDir))}`,
      );
      const out = await opts.driver({
        task,
        workDir,
        variant,
        brief: toDelegationBrief(task),
        signal: opts.signal,
      });
      for (const n of out.notes ?? []) evidence.push(n);
      if (task.grader_files) {
        const g = writeFiles(out.outputDir, task.grader_files);
        evidence.push(`grader files: ${g.join(", ")}`);
      }
      const ctx: CheckContext = { outputDir: out.outputDir, finalText: out.finalText, clock };
      const checks: CheckResult[] = [];
      for (const check of task.checks) {
        const r = await checksRunner(check, ctx);
        checks.push(r);
        evidence.push(`[${r.status}] ${r.label}: ${r.evidence}`);
      }
      result = {
        taskId: task.id,
        title: task.title,
        variant,
        status: taskStatusOf(checks),
        checks,
        evidence,
        finalText: out.finalText,
        costUsdMicro: out.cost.usdMicro,
        durationMs: Math.max(0, Math.round(clock.monotonic() - taskT0)),
      };
    } catch (e) {
      const code = isForerunnerError(e) ? e.code : "internal";
      evidence.push(`[error] ${code}: ${errorMessage(e)}`);
      result = {
        taskId: task.id,
        title: task.title,
        variant,
        status: "error",
        checks: [],
        evidence,
        finalText: "",
        costUsdMicro: 0,
        durationMs: Math.max(0, Math.round(clock.monotonic() - taskT0)),
        error: { code, message: errorMessage(e) },
      };
    }
    if (opts.keepWorkDirs && workDir) result.workDir = workDir;
    else if (workDir) rmSync(workDir, { recursive: true, force: true });
    results.push(result);
    logger.debug("eval task finished", { taskId: task.id, status: result.status, variant });
    opts.onTask?.(result);
  }

  if (ownRoot && !opts.keepWorkDirs) rmSync(workRoot, { recursive: true, force: true });
  const summary = summarize(results, Math.max(0, Math.round(clock.monotonic() - t0)));
  logger.info("eval set finished", { specialist: opts.specialist, variant, ...summary });
  return {
    specialist: opts.specialist,
    variant,
    ...(opts.promptVersion !== undefined ? { promptVersion: opts.promptVersion } : {}),
    startedAt,
    results,
    summary,
  };
}

/** One-line-per-task text report for logs and progress reports. */
export function formatEvalReport(r: EvalSetResult): string {
  const lines = [
    `eval ${r.specialist} (${r.variant}${r.promptVersion ? `, ${r.promptVersion}` : ""}): ${r.summary.passed} passed, ${r.summary.failed} failed, ${r.summary.needsModel} need the critic, pass rate ${(r.summary.passRate * 100).toFixed(0)}%, cost USD ${(r.summary.costUsdMicro / 1_000_000).toFixed(4)}`,
  ];
  for (const t of r.results) {
    lines.push(`  ${t.status.padEnd(11)} ${t.taskId}  ${t.title}`);
    if (t.status !== "pass")
      for (const ev of t.evidence.filter((e) => !e.startsWith("[pass]"))) lines.push(`      ${ev}`);
  }
  return lines.join("\n");
}
