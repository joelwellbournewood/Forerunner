import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, safeSegment } from "@forerunner/platform";

/**
 * Where a live run leaves its evidence files (the JSON reports the gate rows cite):
 * `FORERUNNER_LIVE_REPORT_DIR` when set, else a fresh temp directory whose path is printed.
 */
export const REPORT_DIR_VAR = "FORERUNNER_LIVE_REPORT_DIR";
export const LIVE_VAR = "FORERUNNER_LIVE";
export const RUN_VAR = "FORERUNNER_LIVE_RUN";

export function liveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_VAR] === "1";
}

/** The reason every live case prints when it is skipped. */
export const SKIP_REASON =
  "skipped: FORERUNNER_LIVE is not set (live model calls are opt-in: pnpm --filter @forerunner/live test:live)";

export function runIdFromEnv(env: NodeJS.ProcessEnv = process.env, fallback: string): string {
  const run = env[RUN_VAR]?.trim();
  return run && run !== "" ? run : fallback;
}

export function reportDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[REPORT_DIR_VAR]?.trim();
  if (configured) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  return mkdtempSync(join(tmpdir(), "fr-live-report-"));
}

export function writeReport(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeSegment(name, "report")}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

export function usd(n: number): string {
  return `USD ${n.toFixed(4)}`;
}

/**
 * The API-key half's evidence file to compare the subscription half against:
 * `FORERUNNER_LIVE_PHASE1_EVIDENCE` (a path), else `phase1-live.json` in the report directory.
 */
export const PHASE1_EVIDENCE_VAR = "FORERUNNER_LIVE_PHASE1_EVIDENCE";
export const PHASE1_EVIDENCE_FILE = "phase1-live.json";

export interface Phase1TaskOutcome {
  title: string;
  /** The task's status after the API-key session (`done`, `in_review`, ...). */
  outcome: string;
  verdict: string | null;
  grade: number | null;
}

export interface Phase1Evidence {
  file: string;
  run: string;
  tasks: Phase1TaskOutcome[];
}

/**
 * Read the per-task outcomes of the API-key half from its evidence file, or null when no file
 * is there (the comparison is then reported as not made, never assumed).
 */
export function readPhase1Evidence(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Phase1Evidence | null {
  const configured = env[PHASE1_EVIDENCE_VAR]?.trim();
  const file = configured ? resolve(configured) : join(dir, PHASE1_EVIDENCE_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { run?: unknown; session?: { tasks?: unknown } };
  const tasks = Array.isArray(o.session?.tasks) ? o.session.tasks : [];
  return {
    file,
    run: typeof o.run === "string" ? o.run : "",
    tasks: tasks
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({
        title: String(t.title ?? ""),
        outcome: String(t.outcome ?? ""),
        verdict: typeof t.verdict === "string" ? t.verdict : null,
        grade: typeof t.grade === "number" ? t.grade : null,
      })),
  };
}

/** Whether a task's status after a session counts as "completed or in review" for the gate. */
export function completedOrInReview(status: string): boolean {
  return status === "done" || status === "in_review";
}

export interface Phase1TaskComparison {
  title: string;
  /** The API-key half's outcome of the task; null when that half did not record it. */
  apiKey: { outcome: string; verdict: string | null } | null;
  subscription: { outcome: string; verdict: string | null };
  /** Both halves "completed or in review", or neither; null without the API-key half's row. */
  same: boolean | null;
}

export interface Phase1Comparison {
  /**
   * True only when the API-key half's evidence file is from this run (the same
   * `FORERUNNER_LIVE_RUN`: one vitest invocation, or the variable set for both). A file from
   * another run is listed and flagged as stale, never compared silently.
   */
  made: boolean;
  /** A file was there but from another run. */
  stale: boolean;
  file: string | null;
  apiKeyRun: string | null;
  /** Why the comparison was not made; null when it was. */
  reason: string | null;
  /** Always filled, so the subscription half's outcomes (and a stale file's) are in the evidence. */
  tasks: Phase1TaskComparison[];
}

/**
 * The per-task comparison of the subscription half with the API-key half of the same run:
 * each task ends "completed or in review" on both billing sources, or on neither.
 */
export function comparePhase1(
  phase1: Phase1Evidence | null,
  currentRun: string,
  tasks: readonly { title: string; outcome: string; verdict: string | null }[],
  dir: string,
): Phase1Comparison {
  const rows: Phase1TaskComparison[] = tasks.map((t) => {
    const other = phase1?.tasks.find((p) => p.title === t.title) ?? null;
    return {
      title: t.title,
      apiKey: other ? { outcome: other.outcome, verdict: other.verdict } : null,
      subscription: { outcome: t.outcome, verdict: t.verdict },
      same: other ? completedOrInReview(other.outcome) === completedOrInReview(t.outcome) : null,
    };
  });
  if (!phase1) {
    return {
      made: false,
      stale: false,
      file: null,
      apiKeyRun: null,
      reason: `no ${PHASE1_EVIDENCE_FILE} in ${dir} and ${PHASE1_EVIDENCE_VAR} not set: the API-key half's outcomes are compared through gates.md, not here`,
      tasks: rows,
    };
  }
  if (phase1.run !== currentRun) {
    return {
      made: false,
      stale: true,
      file: phase1.file,
      apiKeyRun: phase1.run,
      reason: `${phase1.file} is from run ${phase1.run || "(unknown)"}, not this run ${currentRun}: its outcomes are listed under tasks, not compared (run both halves in one vitest invocation, or set ${RUN_VAR} for both)`,
      tasks: rows,
    };
  }
  return {
    made: true,
    stale: false,
    file: phase1.file,
    apiKeyRun: phase1.run,
    reason: null,
    tasks: rows,
  };
}
