import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isInside, join, normalize } from "@forerunner/platform";
import type { JsonObject, JsonValue, RunRow, StateStore } from "@forerunner/state";
import type { SearchSeen, TaskExecutionResult } from "./runner.ts";
import { keptSourcesOf } from "./web-sources.ts";

/**
 * The review-only pass (W15-27, TR-15 of ADR 0112): when a limit refused a task's review after
 * its specialist finished, the run's result is kept on that run's Run row (`artifacts`, a
 * `reviewPending` entry; no migration) with what its work looked like (`workHash`, the files it
 * changed as they were). Once the task goes on, the next session reviews that result without
 * running the specialist again, as long as the attempt is the same and the work is unchanged;
 * anything else falls back to today's rerun. The entry is cleared when the pass takes it, whatever
 * the verdict (a review refused again keeps a new one).
 *
 * The pages the run read are already kept on the row (`reviewSources`, W15-26); the entry keeps
 * the rest of what the review reads. Its report is the specialist's own words (data for the
 * critic), capped.
 */
export const REVIEW_PENDING_KEY = "reviewPending";
/** Characters of the run's final report kept for the review (the critic caps it at 24 000). */
export const MAX_KEPT_REPORT_CHARS = 24_000;

export interface ReviewPending {
  attempt: number;
  specialist: string;
  summary: string;
  finalReport: string;
  changedFiles: string[];
  workHash: string;
  prUrl?: string;
  branch?: string;
  webRule?: string;
  searchSeen?: SearchSeen[];
}

/**
 * What the work looks like now: a hash over each changed file's path and bytes (a file that is
 * gone counts as gone). Any change to them (the person's edit, a rebuild, another task) is a
 * different work, and the specialist runs again.
 */
export function workHash(root: string | undefined, files: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of [...new Set(files)].sort()) {
    h.update(`${f}\0`);
    const abs = root ? normalize(join(root, ...f.split("/"))) : null;
    try {
      if (!abs || !root || !isInside(root, abs)) throw new Error("outside");
      h.update(readFileSync(abs));
    } catch {
      h.update("\0gone\0");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

/** The entry for a run whose review a limit refused (`result` is what the runner reviewed). */
export function reviewPendingOf(
  result: TaskExecutionResult,
  attempt: number,
  specialist: string,
): ReviewPending {
  const changedFiles = result.changedFiles ?? [];
  return {
    attempt,
    specialist,
    summary: result.summary.slice(0, 2_000),
    finalReport: (result.finalReport ?? result.summary).slice(0, MAX_KEPT_REPORT_CHARS),
    changedFiles,
    workHash: workHash(result.worktree, changedFiles),
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
    ...(result.branch ? { branch: result.branch } : {}),
    ...(result.webRule ? { webRule: result.webRule } : {}),
    ...(result.searchSeen?.length ? { searchSeen: result.searchSeen } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The entry a Run row keeps, or null (none, or not readable as one). */
export function pendingOfRun(run: Pick<RunRow, "artifacts">): ReviewPending | null {
  for (const a of run.artifacts ?? []) {
    if (!isObject(a)) continue;
    const p = a[REVIEW_PENDING_KEY];
    if (!isObject(p)) continue;
    if (typeof p.attempt !== "number" || typeof p.workHash !== "string") return null;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      attempt: p.attempt,
      specialist: typeof p.specialist === "string" ? p.specialist : "",
      summary: typeof p.summary === "string" ? p.summary : "",
      finalReport: typeof p.finalReport === "string" ? p.finalReport : "",
      changedFiles: strings(p.changedFiles),
      workHash: p.workHash,
      ...(typeof p.prUrl === "string" ? { prUrl: p.prUrl } : {}),
      ...(typeof p.branch === "string" ? { branch: p.branch } : {}),
      ...(typeof p.webRule === "string" ? { webRule: p.webRule } : {}),
      ...(Array.isArray(p.searchSeen)
        ? {
            searchSeen: (p.searchSeen as unknown[])
              .filter(isObject)
              .filter((s) => typeof s.url === "string")
              .map((s) => ({
                url: String(s.url),
                title: typeof s.title === "string" ? s.title : "",
                ...(Array.isArray(s.flagged) ? { flagged: strings(s.flagged) } : {}),
              })),
          }
        : {}),
    };
  }
  return null;
}

/** The task's latest work run (not a review, not a subagent's), from any session. */
export async function latestWorkRun(store: StateStore, taskId: string): Promise<RunRow | null> {
  const runs = (await store.run.forTask(taskId)).filter(
    (r) => r.specialist !== "critic" && !r.parent_run_id,
  );
  runs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return runs.at(-1) ?? null;
}

/** Keeps `pending` on the run's row (replacing an earlier one). */
export async function keepPending(
  store: StateStore,
  runId: string,
  pending: ReviewPending,
): Promise<void> {
  const run = await store.run.get(runId);
  if (!run) return;
  await store.run.patch(runId, {
    artifacts: [
      ...withoutPending(run.artifacts),
      { [REVIEW_PENDING_KEY]: pending as unknown as JsonObject },
    ],
  });
}

/** Clears the run's entry (the pass took it, or it no longer applies). */
export async function clearPending(store: StateStore, run: RunRow): Promise<void> {
  if (!pendingOfRun(run)) return;
  await store.run.patch(run.id, { artifacts: withoutPending(run.artifacts) });
}

function withoutPending(artifacts: readonly JsonValue[] | null | undefined): JsonValue[] {
  return (artifacts ?? []).filter((a) => !(isObject(a) && REVIEW_PENDING_KEY in a));
}

/** The result the review-only pass reviews: the kept one, with the pages the run read. */
export function keptResult(
  run: RunRow,
  pending: ReviewPending,
  worktree: string | undefined,
): TaskExecutionResult {
  const webSources = keptSourcesOf(run.artifacts);
  return {
    outcome: "done",
    specialist: pending.specialist || run.specialist,
    summary: pending.summary,
    costUsdMicro: 0,
    runId: run.id,
    ...(worktree ? { worktree } : {}),
    finalReport: pending.finalReport,
    ...(pending.changedFiles.length ? { changedFiles: pending.changedFiles } : {}),
    ...(pending.prUrl ? { prUrl: pending.prUrl } : {}),
    ...(pending.branch ? { branch: pending.branch } : {}),
    ...(pending.webRule ? { webRule: pending.webRule } : {}),
    ...(pending.searchSeen?.length ? { searchSeen: pending.searchSeen } : {}),
    ...(webSources.length ? { webSources } : {}),
    reviewOnly: true,
  };
}
