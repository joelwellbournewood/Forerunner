import { errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, StateStore } from "@forerunner/state";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import type { StartRequest } from "./triggers.ts";

/**
 * Answering resumes work (design §3.8): every Inbox answer that makes a task of a project
 * runnable starts a session of that project, or queues one behind the session that runs, the
 * same way for every card. The daemon's scheduler is the `start`; a one-shot (the CLI, the
 * cloud runner) passes none and nothing starts.
 */
export type StartPort = (req: StartRequest) => Promise<unknown>;

/** What became of the start an answer asked for (`change_card.start`), for the "Done" line. */
export type ResumeOutcome = "started" | "queued" | "deferred" | "failed" | "nothing_to_run";

/**
 * Start (or queue) a session of the project when one of its tasks can run now (ready, with
 * every task it waits for done). Nothing runnable: no start, so no empty session is made.
 * Never throws: a start that fails is logged and reported as `failed`.
 */
export async function resumeWork(
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
      reason: req.reason,
      ...(req.budgetUsdMicro && req.budgetUsdMicro > 0
        ? { budgetUsdMicro: req.budgetUsdMicro }
        : {}),
    });
    const result = (entry as { result?: unknown } | null)?.result;
    return result === "queued" || result === "deferred" ? result : "started";
  } catch (e) {
    log("resume-work").warn("session after an answer not started", {
      projectId: req.projectId,
      error: errorMessage(e),
    });
    return "failed";
  }
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

/** Record what became of the start on the answered card (`change_card.start`). */
export async function recordStart(
  store: StateStore,
  requestId: string,
  outcome: ResumeOutcome | null,
): Promise<void> {
  if (!outcome) return;
  const row: HumanRequestRow | undefined = await store.humanRequest.get(requestId);
  if (!row) return;
  await store.humanRequest.patch(row.id, {
    change_card: { ...((row.change_card ?? {}) as JsonObject), start: outcome },
  });
}
