import { errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, StateStore } from "@forerunner/state";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import type { PreparePort, PrepareRequest, PrepareResult } from "./prepared-work.ts";
import type { StartRequest } from "./triggers.ts";

/**
 * Answering prepares work (d1109-starts-engine S-2, ADR 0118; before: "answering resumes
 * work", design §3.8). An Inbox answer that makes a task runnable no longer starts a session: it
 * prepares the work (`prepareWork`, `prepared-work.ts`), which joins the running session if it
 * fits, else waits for the person's next Start. Only the person's own starts use the scheduler
 * here: Approve and start on the plan from a brief, Continue on a budget card (`startForPerson`).
 * A one-shot (the CLI, the cloud runner) passes no port and nothing happens.
 */
export type StartPort = (req: StartRequest) => Promise<unknown>;

/**
 * What became of a person's start an answer asked for (`change_card.start`, the "Done" line):
 * the old start outcomes, kept for the cards answered before run C too.
 */
export type ResumeOutcome = "started" | "queued" | "deferred" | "failed" | "nothing_to_run";

/**
 * The person's own start from an answer (Approve and start, Continue): a session of the project
 * starts (or waits behind the one that runs), by the person (S-1), when one of its tasks can
 * run now. Nothing runnable: no start, so no empty session is made. Never throws: a start that
 * fails is logged and reported as `failed`.
 */
export async function startForPerson(
  store: StateStore,
  start: StartPort | undefined,
  req: {
    agentId: string;
    projectId: string | null;
    reason: string;
    /** The session's budget when the answer named one (C-36); else the project's applies. */
    budgetUsdMicro?: number;
  },
): Promise<ResumeOutcome | null> {
  if (!start || !req.projectId) return null;
  // A task planned for the person is no work for a session: its questions are filed in the
  // Inbox by the sync, and a session started for it only made an empty run (live L-11: the
  // bakery plan's "Give the real menu, hours and address" after Approve and start).
  const runnable = (await store.task.readyTasks(req.projectId)).filter(
    (t) => !t.specialist || canonicalSpecialistName(t.specialist) !== "person",
  );
  if (runnable.length === 0) return "nothing_to_run";
  try {
    const entry = await start({
      agentId: req.agentId,
      projectId: req.projectId,
      trigger: "message",
      by: "person",
      reason: req.reason,
      ...(req.budgetUsdMicro && req.budgetUsdMicro > 0
        ? { budgetUsdMicro: req.budgetUsdMicro }
        : {}),
    });
    const result = (entry as { result?: unknown } | null)?.result;
    return result === "queued" || result === "deferred" ? result : "started";
  } catch (e) {
    log("resume-work").warn("the session you asked for did not start", {
      projectId: req.projectId,
      error: errorMessage(e),
    });
    return "failed";
  }
}

/**
 * Prepare the work an answer made runnable (S-2) through the daemon's port; null without one
 * (a one-shot) or without a project.
 */
export async function prepareAnswer(
  prepare: PreparePort | undefined,
  req: PrepareRequest,
): Promise<PrepareResult | null> {
  if (!prepare || !req.projectId) return null;
  return prepare(req);
}

/**
 * A note queued for one task's next brief: it names the task, so `notesForTask` routes it to
 * that brief only (the same text as the commands' `taskNoteText`, which this module cannot
 * import without a package cycle).
 */
export function noteAboutTask(task: { id: string; title: string }, note: string): string {
  const t = task.title.replace(/\s+/g, " ").trim();
  const named =
    t.length >= 4 ? `"${t.length > 200 ? `${t.slice(0, 199)}…` : t}"` : `task ${task.id}`;
  return `About ${named}: ${note.trim()}`;
}

/**
 * Record what became of the work an answer made runnable on the answered card
 * (`change_card.start`, and `start_by` when the hands-off setting started a session): a person's
 * start's outcome, or prepared work's (S-2), for its "Done" line.
 */
export async function recordStart(
  store: StateStore,
  requestId: string,
  outcome: ResumeOutcome | PrepareResult | null,
): Promise<void> {
  if (!outcome) return;
  const row: HumanRequestRow | undefined = await store.humanRequest.get(requestId);
  if (!row) return;
  const start = typeof outcome === "string" ? outcome : outcome.outcome;
  const by = typeof outcome === "string" ? undefined : outcome.startedBy;
  await store.humanRequest.patch(row.id, {
    change_card: {
      ...((row.change_card ?? {}) as JsonObject),
      start,
      ...(by ? { start_by: by } : {}),
    },
  });
}
