import {
  type Clock,
  isAbsolute,
  type RunOptions,
  type RunResult,
  resolve,
  run as runProcess,
  systemClock,
} from "@forerunner/platform";
import { fingerprintOf } from "./fingerprint.ts";
import { applyVerdictRules } from "./rules.ts";
import type { CheckResultEvidence, ReviewEvidence, ReviewFinding, ReviewOutput } from "./types.ts";

/**
 * Tier 0 (H.2): automated checks only, no model call. The grade is the share of items that
 * passed (every check plus "acceptance criteria are present"); accept needs every required
 * check to pass and criteria to exist. With no checks at all there is nothing to verify, so
 * confidence is low and the verdict rules turn accept into escalate: a task at tier 0 must
 * bring checks.
 */
export const TIER0_MODEL = "none";
/** Confidence with at least one executed check (deterministic) and with none. */
export const TIER0_CONFIDENCE_WITH_CHECKS = 1;
export const TIER0_CONFIDENCE_WITHOUT_CHECKS = 0.5;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;

export interface CheckCommand {
  name: string;
  /** argv array, never a shell string. */
  argv: readonly string[];
  /** Working directory relative to the review's cwd, or absolute. */
  cwd?: string;
  timeoutMs?: number;
  /** Default true. */
  required?: boolean;
}

export interface CheckRunner {
  run(
    cmd: CheckCommand,
    opts: { cwd?: string; signal?: AbortSignal },
  ): Promise<CheckResultEvidence>;
}

export type ProcessRunner = (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;

/**
 * Where a check runs: the command's own cwd when absolute, else that cwd under the review's
 * cwd (the worktree), else the review's cwd. Never the process cwd when a worktree is given.
 */
export function checkCwd(cmd: Pick<CheckCommand, "cwd">, reviewCwd?: string): string | undefined {
  if (!cmd.cwd) return reviewCwd;
  if (isAbsolute(cmd.cwd)) return cmd.cwd;
  return reviewCwd ? resolve(reviewCwd, cmd.cwd) : resolve(cmd.cwd);
}

/** Executes check commands in the worktree through platform.run with a timeout. */
export class ProcessCheckRunner implements CheckRunner {
  constructor(private readonly exec: ProcessRunner = runProcess) {}

  async run(
    cmd: CheckCommand,
    opts: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<CheckResultEvidence> {
    const r = await this.exec(cmd.argv, {
      cwd: checkCwd(cmd, opts.cwd),
      timeoutMs: cmd.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      allowFailure: true,
      signal: opts.signal,
    });
    const passed = r.code === 0 && !r.timedOut;
    const body = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
    const tail = body.length > OUTPUT_TAIL ? `...${body.slice(-OUTPUT_TAIL)}` : body;
    const head = `${cmd.argv.join(" ")} -> ${r.timedOut ? "timeout" : `exit ${r.code}`} in ${r.durationMs} ms`;
    return {
      name: cmd.name,
      passed,
      output: tail ? `${head}\n${tail}` : head,
      required: cmd.required ?? true,
    };
  }
}

export interface Tier0Options {
  evidence: ReviewEvidence;
  /** Commands to run in `cwd` in addition to `evidence.checkResults`. */
  checks?: CheckCommand[];
  cwd?: string;
  runner?: CheckRunner;
  clock?: Clock;
  signal?: AbortSignal;
}

export function criteriaPresent(criteria: readonly string[]): boolean {
  return criteria.length > 0 && criteria.every((c) => c.trim().length > 0);
}

/**
 * The finding a failed check produces at every tier (B.4: a task cannot close with failed
 * required checks). A required check is high (blocks accept); an optional one is low.
 */
export function findingForFailedCheck(r: CheckResultEvidence): ReviewFinding {
  const required = r.required ?? true;
  const description = `Check failed: ${r.name}`;
  return {
    severity: required ? "high" : "low",
    description,
    requiredAction: `Make the check "${r.name}" pass${required ? "" : " or mark it optional in the task"}`,
    fingerprint: fingerprintOf(description),
    where: firstLine(r.output),
  };
}

export interface RunChecksOptions {
  cwd?: string;
  runner?: CheckRunner;
  signal?: AbortSignal;
}

/**
 * Runs check commands in order through the runner (default: real processes in `cwd`) and
 * returns their results as evidence. Shared by tier 0 and the model tiers that run tests (2+).
 */
export async function runChecks(
  checks: readonly CheckCommand[],
  opts: RunChecksOptions = {},
): Promise<CheckResultEvidence[]> {
  if (checks.length === 0) return [];
  const runner = opts.runner ?? new ProcessCheckRunner();
  const results: CheckResultEvidence[] = [];
  for (const cmd of checks) {
    results.push(await runner.run(cmd, { cwd: opts.cwd, signal: opts.signal }));
  }
  return results;
}

/** One evidence line per executed check: name, pass or fail, the first output line. */
export function ranCheckLine(r: CheckResultEvidence): string {
  const head = firstLine(r.output);
  return `ran: ${r.name} -> ${r.passed ? "pass" : "fail"}${head ? ` (${head})` : ""}`;
}

export async function reviewTier0(opts: Tier0Options): Promise<ReviewOutput> {
  const clock = opts.clock ?? systemClock;
  const t0 = clock.monotonic();
  const results: CheckResultEvidence[] = [
    ...(opts.evidence.checkResults ?? []),
    ...(await runChecks(opts.checks ?? [], {
      cwd: opts.cwd,
      runner: opts.runner,
      signal: opts.signal,
    })),
  ];
  const hasCriteria = criteriaPresent(opts.evidence.acceptanceCriteria);
  const items = results.length + 1;
  const passedItems = results.filter((r) => r.passed).length + (hasCriteria ? 1 : 0);
  const findings: ReviewFinding[] = [];
  const evidence: string[] = [];
  for (const r of results) {
    const required = r.required ?? true;
    evidence.push(
      `[${r.passed ? "pass" : "fail"}]${required ? "" : " (optional)"} ${r.name}${r.output ? `: ${firstLine(r.output)}` : ""}`,
    );
    if (!r.passed) findings.push(findingForFailedCheck(r));
  }
  if (!hasCriteria) {
    const description = "No acceptance criteria were given for the task";
    findings.push({
      severity: "medium",
      description,
      requiredAction: "Add checkable acceptance criteria to the task before it is reviewed again",
      fingerprint: fingerprintOf(description),
    });
    evidence.push("[fail] acceptance criteria present");
  } else {
    evidence.push(
      `[pass] acceptance criteria present (${opts.evidence.acceptanceCriteria.length})`,
    );
  }
  const requiredFailed = results.filter((r) => !r.passed && (r.required ?? true)).length;
  const grade = Math.round((100 * passedItems) / items);
  const confidence =
    results.length > 0 ? TIER0_CONFIDENCE_WITH_CHECKS : TIER0_CONFIDENCE_WITHOUT_CHECKS;
  const verdict = requiredFailed === 0 && hasCriteria ? "accept" : "revise";
  const ruled = applyVerdictRules({ grade, confidence, verdict, findings }, 0);
  const summary =
    results.length === 0
      ? `Tier 0: no automated checks were available; ${hasCriteria ? "criteria present" : "criteria missing"}.`
      : `Tier 0: ${results.length - requiredFailed - results.filter((r) => !r.passed && r.required === false).length}/${results.length} checks passed` +
        `${requiredFailed ? `, ${requiredFailed} required check(s) failed` : ""}; criteria ${hasCriteria ? "present" : "missing"}.`;
  return {
    grade: ruled.grade,
    confidence: ruled.confidence,
    verdict: ruled.verdict,
    findings,
    evidence,
    summary,
    model: TIER0_MODEL,
    tier: 0,
    durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
    costUsdMicro: 0,
    outcome: "completed",
    adjustments: ruled.adjustments,
    patterns: [],
    lessonProposals: [],
  };
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
