import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { ANSWER_CARD_KEYS, cannotRunAnswer } from "../wiring/request-answers.ts";
import { unappliedAnswers } from "./findings.ts";
import { recordStart, resumeWork, type StartPort } from "./resume-work.ts";

/**
 * Every task a run leaves waiting for the person has one card (live walk 4, problem 1; design
 * §1 "Nothing is stuck silently", §3.8). Before, a run that could not go on and asked nothing
 * (the researcher refused at once on an API key: no web tools there; a specialist name the
 * registry does not know; no other specialist after two failed attempts) moved its task to
 * `needs_human` with the first 200 characters of its summary and no card: the Inbox said
 * "Nothing needs you" and Home "Waiting on you 0" while the session's result said '"X" needs
 * your decision (Inbox).', the badge read "Paused" with "Press Resume", and Resume only started
 * the same refusal again.
 *
 * Now the runner files this card when the task waits and no open card holds it already (the
 * person's questions, an approval, a budget stop or a rebase conflict file their own):
 * '"X" could not run' with the reason in at most two sentences (no tool names), **Try again**
 * ("Starts a session that tries again; first fix what stopped it (Edit changes who does it).")
 * and **Cancel task**. `syncCannotRunAnswers` (run by `RuntimeApp.syncApprovals`) applies the
 * answer once. The Tasks tab reads "Needs your decision: it could not run" with Answer, Edit and
 * Cancel; Resume is not offered, so nothing repeats the refusal unchanged.
 */
export const CANNOT_RUN_KEY = ANSWER_CARD_KEYS.cannotRun;
/** The card's options as its buttons say them; `cannotRunAnswer` reads them. */
export const CANNOT_RUN_OPTIONS = ["Try again", "Cancel task"] as const;

/** A sentence ends at ". ", "! " or "? " (a dot inside "docs/data.md" or "0.40" does not). */
const SENTENCE_END = /[.!?](?=\s|$)/g;

/**
 * A run's summary as a person reads it on a card or a task's reason (design §5 rules 1, 6): no
 * list of tool names ("(cc:WebFetch, cc:WebSearch)"), no "set the task back to ready" where
 * the card's Try again does that, whole sentences up to `maxSentences` and `max` characters.
 * A first sentence longer than `max` is cut at a word, with "…".
 */
export function plainStopReason(summary: string, max = 300, maxSentences = 2): string {
  const text = summary
    .replace(/\s*\([^()]*\bcc:[^()]*\)/g, "")
    .replace(/\b(?:and )?set (?:the task|it) back to ready\b/gi, (m) =>
      m.toLowerCase().startsWith("and") ? "and try again" : "try again",
    )
    .replace(/\s+/g, " ")
    .trim();
  const ends = [...text.matchAll(SENTENCE_END)].map((m) => (m.index ?? 0) + 1);
  let out = "";
  for (const end of ends.slice(0, maxSentences)) {
    const candidate = text.slice(0, end).trim();
    if (candidate.length > max) break;
    out = candidate;
  }
  if (out) return out;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** '"X" could not run' (the card's title). */
export function cannotRunTitle(task: Pick<TaskRow, "title">): string {
  return `"${task.title.replace(/\s+/g, " ").trim()}" could not run`;
}

function keyOf(r: Pick<HumanRequestRow, "change_card">): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

/**
 * Whether an open card asks the person about the task already. The Docker wait card names its
 * task only for Cancel task and asks nothing about it (`daemon/task-words.ts`, `holdsTask`).
 */
async function openCardFor(store: StateStore, taskId: string): Promise<HumanRequestRow | null> {
  const open = await store.humanRequest.list({ task_id: taskId, status: "open" } as never, {
    limit: 50,
  });
  return open.find((r) => keyOf(r) !== "sandbox.not_ready") ?? null;
}

export interface CannotRunCardInput {
  store: StateStore;
  /** The task, now `needs_human`. */
  task: TaskRow;
  session: Pick<SessionRow, "id"> | null;
  humanId: string;
  /** The principal agent that ran the task (author of the card). */
  agentId: string;
  runId: string | null;
  /** The run's summary: why it could not go on. */
  reason: string;
}

/**
 * Files the card of a task the run left waiting, unless an open card holds the task already
 * (then nothing is filed and that card is returned with `reused`).
 */
export async function fileCannotRunCard(
  input: CannotRunCardInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task } = input;
  const open = await openCardFor(store, task.id);
  if (open) return { request: open, reused: true };
  const reason = plainStopReason(input.reason);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.session?.id ?? null,
    kind: "approval",
    // Design §3.8, §5: the title names the task; the body says why in its own words.
    why: `${cannotRunTitle(task)}. ${reason}`.slice(0, 4000),
    steps: [],
    options: [...CANNOT_RUN_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: {
      key: CANNOT_RUN_KEY,
      task_id: task.id,
      task_title: task.title,
      title: cannotRunTitle(task),
      reason,
      run_id: input.runId,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

export interface CannotRunSyncResult {
  retried: number;
  cancelled: number;
  /** Answered cards whose task had moved on, or whose answer was not one of the options. */
  skipped: number;
}

/**
 * Applies every answered card of the person not applied yet. The task must still wait
 * (`needs_human`); otherwise the answer is recorded as `task_moved_on` and nothing changes.
 * Try again puts it back to ready (no retry is counted: nothing ran) and asks for a session of
 * its project; Cancel task cancels it. Each outcome is written on the card, so it is applied
 * once.
 */
export async function syncCannotRunAnswers(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** Answering resumes work (design §3.8): the daemon's scheduler; absent in a one-shot. */
  start?: StartPort;
}): Promise<CannotRunSyncResult> {
  const logger = log("cannot-run-card");
  const { store, clock } = deps;
  const out: CannotRunSyncResult = { retried: 0, cancelled: 0, skipped: 0 };
  for (const row of await unappliedAnswers(store, deps.humanId, CANNOT_RUN_KEY)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const finish = (outcome: string) =>
      store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome },
      });
    const answer = cannotRunAnswer(row.answer);
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    if (!answer || !task || task.status !== "needs_human") {
      out.skipped++;
      await finish(!answer ? "unrecognized_answer" : "task_moved_on");
      continue;
    }
    const actor = { agentId: deps.agentId, humanId: deps.humanId };
    try {
      if (answer === "retry") {
        await store.task.transition(
          task.id,
          task.version,
          "ready",
          "you asked to try again in the Inbox",
          actor,
        );
        await finish("retry");
        out.retried++;
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: `you asked to try "${task.title}" again`,
          }),
        );
      } else {
        await store.task.transition(
          task.id,
          task.version,
          "cancelled",
          `you cancelled it in the Inbox when it could not run (request ${row.id})`,
          actor,
        );
        await finish("cancel");
        out.cancelled++;
      }
    } catch (e) {
      logger.warn("could-not-run card answer not applied", {
        requestId: row.id,
        error: errorMessage(e),
      });
    }
  }
  return out;
}
