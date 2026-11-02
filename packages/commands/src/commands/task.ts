import { ForerunnerError } from "@forerunner/platform";
import { defaultRiskTier, riskTierFor } from "@forerunner/runtime";
// The module itself, not the package index: the index loads this package (a cycle), and the
// schema is needed when this module is evaluated.
import {
  DEFAULT_TASK_PRIORITY,
  PRIORITY_LABELS,
  PRIORITY_VALUES,
  priorityLevel,
  TaskPrioritySchema,
} from "@forerunner/runtime/priority";
import {
  canTransition,
  type JsonValue,
  type QueueItemRow,
  reopenTarget,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskRow,
  type TaskStatus,
} from "@forerunner/state";
import { z } from "zod";
import { buildCard, formatChfShort } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf, quote, resolveProject } from "./shared.ts";

/*
 * The person's task commands (design §3.5, core-experience.md; ADR 0102): create, the moves of
 * the Tasks tab (make ready, pause and stop, resume and go ahead without answers, try again,
 * cancel, reopen and redo), edit and what a task waits for. Each is logged with a plain
 * sentence (no "Undo." in it: the Undo is a button next to it) and each can be undone right
 * after: the undo puts back the status, the fields or the dependencies the task had. A note
 * for the agent goes into the task's next brief as a queued note that names the task
 * (`notesForTask` in the runtime's next-session module routes it to that task's brief only).
 */

// --- Words -----------------------------------------------------------------------------------

/** A stored status in the words of design §2, for sentences ("is ready again"). */
export function statusWords(status: TaskStatus): string {
  switch (status) {
    case "draft":
      return "a draft";
    case "ready":
      return "ready";
    case "claimed":
    case "in_progress":
      return "running";
    case "in_review":
      return "being reviewed";
    case "needs_human":
      return "paused";
    case "failed":
      return "failed";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * The review levels as New task and Edit name them (ADR 0102 point 5). Every task is reviewed
 * (ADR 0104): a stored tier 0 is the light review, never "checks only".
 */
export function reviewLevelWords(tier: number): string {
  if (tier <= 1) return "Light review";
  if (tier === 2) return "Full review";
  return "Full review and your sign-off";
}

/** "Who does it" in words: the agent's choice, the person, or a specialist. */
export function whoWords(specialist: string | null | undefined): string {
  if (!specialist) return "the agent's choice";
  if (specialist === PERSON_SPECIALIST) return "you";
  return specialist;
}

/** The specialist name New task's "Me: ask me in the Inbox" sets: a task for the person. */
export const PERSON_SPECIALIST = "person";

/** Statuses a session may be working on: a person's move stops that run (U-039). */
const RUNNING: readonly TaskStatus[] = ["claimed", "in_progress"];
/** Statuses a person's move out of withdraws the task's open Inbox cards. */
const WAITS_ON_CARDS: readonly TaskStatus[] = ["needs_human", "failed", "in_review"];

// --- Shared steps ----------------------------------------------------------------------------

const taskRef = {
  /** Task id, or a title (prefix or part) within the project. */
  task: z.string().min(1),
  project: z.string().optional(),
};
/** A person's note for the agent: it goes into the task's next brief. */
const noteParam = z.string().trim().max(2000).optional();

async function findTask(
  params: { task: string; project?: string | undefined },
  ctx: CommandContext,
): Promise<TaskRow> {
  const direct = await ctx.store.task.get(params.task);
  if (direct) return direct;
  const { project } = await resolveProject(ctx, params.project);
  const tasks = await ctx.store.task.forProject(project.id);
  const needle = params.task.trim().toLowerCase();
  const matches = tasks.filter((t) => t.title.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as TaskRow;
  if (matches.length > 1) {
    // Design §5 rule 8: what went wrong and what to do. The matches by name, up to three, and
    // the words that pick one (wave 2: 'several tasks match "style"' said neither).
    const named = matches.slice(0, 3).map((m) => quote(m.title));
    const more = matches.length > 3 ? ` and ${matches.length - 3} more` : "";
    const list =
      named.length === 2 && !more ? `${named[0]} and ${named[1]}` : `${named.join(", ")}${more}`;
    throw new ForerunnerError(
      "validation",
      `${matches.length} tasks match ${quote(params.task)}: ${list}. Say more of the title, for example ${named[0]}`,
      { details: { candidates: matches.map((m) => m.title) } },
    );
  }
  throw new ForerunnerError(
    "not_found",
    `no task matches ${quote(params.task)} in ${project.name}`,
  );
}

function actorOf(ctx: CommandContext): { humanId: string | null; agentId: string | null } {
  return {
    humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
    agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
  };
}

/** The text of a note queued for a task: it names the task, so it reaches that brief only. */
export function taskNoteText(task: Pick<TaskRow, "id" | "title">, note: string): string {
  // `notesForTask` matches a title of four characters or more; a shorter one is named by id.
  const named = task.title.trim().length >= 4 ? quote(task.title, 200) : `task ${task.id}`;
  return `About ${named}: ${note.trim()}`;
}

/** What the person chose when they moved a task on without answering its questions. */
export const WITHOUT_ANSWERS_NOTE =
  "The person chose to go ahead without answering the questions asked about this task: decide yourself and say in the report what you assumed.";

/**
 * Queue the person's note for the task's next brief (`kind: "note"`), returning its id for the
 * undo; nothing for an empty note.
 */
async function queueNote(
  ctx: CommandContext,
  task: TaskRow,
  note: string | undefined,
): Promise<string | null> {
  const text = note?.trim();
  if (!text) return null;
  const row: QueueItemRow = await ctx.store.queue.enqueue({
    project_id: task.project_id,
    human_id: ctx.humanId,
    kind: "note",
    text: taskNoteText(task, text),
    priority: 0,
    status: "queued",
    author_human: ctx.actor.kind === "human" ? ctx.actor.id : ctx.humanId,
  });
  return row.id;
}

/** The undo of a move takes back its note while no session has read it yet. */
async function dismissNotes(ctx: CommandContext, after: JsonValue): Promise<void> {
  const a = asObject(after);
  const ids = [a.note_id, a.without_answers_note_id].filter(
    (id): id is string => typeof id === "string",
  );
  for (const id of ids) {
    const row = await ctx.store.queue.get(id);
    if (row?.status === "queued") await ctx.store.queue.dismiss(row.id, row.version);
  }
}

/**
 * Close the task's open Inbox cards (questions, a sign-off, a retry card) when a person moves
 * the task on: design §3.8, "a card whose task has moved on is closed with a line saying so;
 * it never lingers as blocking". Returns the ids it withdrew.
 */
async function withdrawCards(ctx: CommandContext, taskId: string): Promise<string[]> {
  const open = await ctx.store.humanRequest.list({ task_id: taskId, status: "open" } as never, {
    limit: 100,
  });
  const out: string[] = [];
  for (const r of open) {
    await ctx.store.humanRequest.withdraw(r.id, r.version);
    out.push(r.id);
  }
  return out;
}

/** The open tasks of the project that wait on this one: Cancel names them (design §3.5). */
export async function waitingOn(
  ctx: Pick<CommandContext, "store">,
  task: Pick<TaskRow, "id" | "project_id">,
): Promise<TaskRow[]> {
  const all = await ctx.store.task.forProject(task.project_id, {}, { limit: 10_000 });
  return all.filter(
    (t) => t.depends_on.includes(task.id) && t.status !== "done" && t.status !== "cancelled",
  );
}

function namesList(titles: readonly string[]): string {
  const shown = titles.slice(0, 3).map((t) => quote(t, 60));
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  if (shown.length <= 1) return `${shown.join("")}${more}`;
  return more
    ? `${shown.join(", ")}${more}`
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A move as one question for the chat's read-back (design §3.9, §5 "Move dialog": 'Pause
 * "Create notes/todo.md"? No session runs it until you press Resume.'), with the button's
 * one-line consequence (design §3.5).
 */
export function moveAsk(
  task: Pick<TaskRow, "title">,
  from: TaskStatus,
  to: TaskStatus,
  stuck = 0,
): string {
  const t = quote(task.title);
  if (to === "cancelled") {
    // C-38: what Yes does to a task at work (ADR 0105, the Tasks tab's `cancelWorkLine`): its
    // run stops and what it changed is taken out of the folder.
    const what =
      RUNNING.includes(from) || from === "in_review"
        ? "Its run stops now and what it changed is removed"
        : "It is dropped";
    return `Cancel ${t}? ${what}${stuck ? `; ${stuck === 1 ? "1 task" : `${stuck} tasks`} waiting on it will be stuck` : ""}.`;
  }
  if (to === "needs_human")
    return RUNNING.includes(from)
      ? `Stop ${t}? Its run stops now and it is paused; the session goes on with the rest.`
      : `Pause ${t}? No session runs it until you press Resume.`;
  if (to === "ready" && from === "draft") return `Make ${t} ready? A session will pick it up.`;
  if (to === "ready" && from === "failed") return `Try ${t} again? It is ready again.`;
  if (to === "ready" && from === "cancelled") return `Reopen ${t}? It is ready again.`;
  if (to === "ready" && from === "done") return `Redo ${t}? The next session works on it again.`;
  if (to === "ready") return `Resume ${t}? It is ready again; the next session can run it.`;
  return `Mark ${t} ${statusWords(to)}?`;
}

/** What a person's move did, in one line (design §5): the task by name, no raw state. */
export function moveSentence(
  task: Pick<TaskRow, "title">,
  from: TaskStatus,
  to: TaskStatus,
  extra: {
    withdrawn?: number;
    noted?: boolean;
    stuck?: readonly string[];
    redo?: boolean;
    /**
     * What happens to the work of a task cancelled while it ran or was reviewed (phase C, live
     * walk 2 C1): `removed`, what it changed is taken out of the folder it ran in (Undo brings
     * it back); `pull_request`, its pull request stays open.
     */
    work?: "removed" | "pull_request";
  } = {},
): string {
  const t = quote(task.title);
  let s: string;
  if (to === "cancelled" && extra.work) {
    const what = from === "in_review" ? "its review" : "its run";
    s =
      extra.work === "removed"
        ? `Cancelled ${t}: ${what} stopped and what it changed is removed; Undo brings it back.`
        : `Cancelled ${t}: ${what} stopped; its pull request stays open.`;
  } else if (to === "cancelled") s = `Cancelled ${t}.`;
  else if (to === "needs_human")
    s = RUNNING.includes(from)
      ? `Stopped ${t}: its run ended and it is paused until you press Resume.`
      : `Paused ${t}: no session runs it until you press Resume.`;
  else if (to === "ready" && from === "draft") s = `${t} is ready: a session will pick it up.`;
  else if (to === "ready" && from === "failed") s = `${t} is ready to try again.`;
  else if (to === "ready" && from === "cancelled") s = `Reopened ${t}: it is ready again.`;
  else if (to === "ready" && (from === "done" || extra.redo))
    s = `Reopened ${t} to redo it: the next session works on it again.`;
  else if (to === "ready") s = `${t} is ready again.`;
  else s = `${t} is ${statusWords(to)} now.`;
  if (extra.withdrawn)
    s += ` Its ${extra.withdrawn === 1 ? "card" : `${extra.withdrawn} cards`} in the Inbox ${
      extra.withdrawn === 1 ? "was" : "were"
    } withdrawn.`;
  if (extra.stuck?.length)
    s += ` ${namesList(extra.stuck)} ${extra.stuck.length === 1 ? "waits" : "wait"} on it and ${
      extra.stuck.length === 1 ? "is" : "are"
    } stuck now.`;
  // A cancelled task has a next brief only once it is reopened (design §5 rule 9).
  if (extra.noted)
    s +=
      to === "cancelled"
        ? " Your note goes into its brief if you reopen it."
        : " Your note goes into its next brief.";
  return s;
}

/**
 * A person's move of a task (`task.transition`, `task.pause`, `task.resume`, `task.reopen`):
 * the move, the cards it closes, the note it queues, and the change log's before and after.
 * `reopen` takes a cancelled or done task back to ready (the graph keeps those final).
 */
async function personMove(
  ctx: CommandContext,
  task: TaskRow,
  to: TaskStatus,
  opts: {
    reason: string;
    note?: string | undefined;
    reopen?: boolean;
    withoutAnswers?: boolean;
    /** Recorded as the person's own move even when the chat's agent carries it out (a pause). */
    asPerson?: boolean;
  },
) {
  const from = task.status;
  const actor = opts.asPerson ? { humanId: ctx.humanId, agentId: null } : actorOf(ctx);
  const moved = opts.reopen
    ? await ctx.store.task.reopen(task.id, task.version, "ready", opts.reason, actor)
    : await ctx.store.task.transition(task.id, task.version, to, opts.reason, actor);
  const withdrawn =
    WAITS_ON_CARDS.includes(from) || to === "cancelled" ? await withdrawCards(ctx, task.id) : [];
  // Moved on without the answers its cards asked for: the specialist is told so (design §4.6).
  const withoutAnswersNoteId =
    opts.withoutAnswers ||
    (from === "needs_human" && withdrawn.length > 0 && moved.status === "ready")
      ? await queueNote(ctx, task, WITHOUT_ANSWERS_NOTE)
      : null;
  const noteId = await queueNote(ctx, task, opts.note);
  // A task that is running stops now (U-039), and one being reviewed too (a cancelled task is
  // never reviewed, phase C); the session goes on with the rest.
  const stopped =
    RUNNING.includes(from) || from === "in_review"
      ? await ctx.ports.stopTask?.(task.id, `${statusWords(to)} by you`)
      : undefined;
  const stuck = to === "cancelled" ? (await waitingOn(ctx, task)).map((t) => t.title) : [];
  // What happens to the work of a task cancelled while it ran or was reviewed: the session's
  // runner takes it out of the folder it ran in once the run stops (phase C); a pull request
  // already opened stays open. Said only when a live run or review was stopped: a task in
  // review that no session reviews (its card waits, or Forerunner closed during its review)
  // has nothing taken out, and its line says only that it is cancelled.
  const work =
    to === "cancelled" && stopped === true
      ? task.pr_url
        ? ("pull_request" as const)
        : ("removed" as const)
      : undefined;
  return {
    // The row as it was, so the undo puts it back whole: its reason and who set the status
    // (an agent's pause reads "Needs your answer" or "Paused", a person's "Paused by you"), and
    // the retry count a Try again raises.
    before: {
      task_id: task.id,
      status: from,
      title: task.title,
      reason: task.reason,
      author_human: task.author_human,
      author_agent: task.author_agent,
      attempt: task.attempt,
    },
    after: {
      task_id: task.id,
      status: moved.status,
      title: task.title,
      ...(noteId ? { note_id: noteId } : {}),
      ...(withoutAnswersNoteId ? { without_answers_note_id: withoutAnswersNoteId } : {}),
      ...(withdrawn.length ? { withdrawn_requests: withdrawn } : {}),
    },
    sentence: moveSentence(task, from, moved.status, {
      withdrawn: withdrawn.length,
      noted: noteId !== null,
      stuck,
      redo: from === "done",
      ...(work ? { work } : {}),
    }),
    projectId: task.project_id,
    reversible: true,
  };
}

/**
 * Why the undo of a move cannot be done now (U-061): the task moved on since (a session took
 * it, someone moved it again), or it is gone. Null when it can.
 */
async function moveUndoBlocked(before: JsonValue, after: JsonValue, ctx: CommandContext) {
  const b = asObject(before);
  const a = asObject(after);
  if (typeof a.task_id !== "string" || typeof b.status !== "string") {
    return "this change does not name the task it moved";
  }
  const task = await ctx.store.task.get(a.task_id);
  if (!task) {
    return `${typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task"} no longer exists`;
  }
  if (task.status !== a.status) {
    return `the task ${quote(task.title)} is ${statusWords(task.status)} now; undo would not put it back where it was`;
  }
  // Back to done (the undo of a Redo) is a close: refused while the critic still asks for
  // changes, said in words here rather than as the store's refusal.
  if (b.status === "done" && (await ctx.store.finding.openFor(task.id)).length > 0) {
    return `the critic still asks for changes to ${quote(task.title)}, so it cannot be done again`;
  }
  return null;
}

/** The cards a move withdrew (`after.withdrawn_requests`). */
function withdrawnIds(after: JsonValue): string[] {
  const ids = asObject(after).withdrawn_requests;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The undo of a person's move: the task as it was (its status, its reason and who set it, the
 * retry count), the Inbox cards the move withdrew open again, the note taken back. Before
 * these were recorded (an older change) the undo writes its own reason and author.
 */
async function undoMove(before: JsonValue, after: JsonValue, ctx: CommandContext) {
  const b = asObject(before);
  const a = asObject(after);
  if (typeof a.task_id !== "string" || typeof b.status !== "string") {
    throw new ForerunnerError("validation", "this change does not name the task it moved");
  }
  const task = await ctx.store.task.mustGet(a.task_id);
  // The reason and author come back with the status they explain; a running or reviewed task
  // comes back as ready, which its old reason ("claimed by …") does not describe.
  const recorded =
    typeof b.reason === "string" && !["claimed", "in_progress", "in_review"].includes(b.status);
  const id = (v: JsonValue | undefined) => (typeof v === "string" ? v : null);
  await ctx.store.task.restoreStatus(
    task.id,
    task.version,
    b.status as TaskStatus,
    recorded ? String(b.reason) : "undo",
    recorded ? { humanId: id(b.author_human), agentId: id(b.author_agent) } : actorOf(ctx),
    typeof b.attempt === "number" ? { attempt: b.attempt } : {},
  );
  for (const requestId of withdrawnIds(after)) {
    const card = await ctx.store.humanRequest.get(requestId);
    if (card?.status === "withdrawn")
      await ctx.store.humanRequest.reopenWithdrawn(card.id, card.version);
  }
  await dismissNotes(ctx, after);
  // The cancel of a task that ran took what it changed out of the folder (phase C): the undo
  // puts it back, on top of the folder as it is now.
  if (
    a.status === "cancelled" &&
    (RUNNING.includes(b.status as TaskStatus) || b.status === "in_review") &&
    ctx.ports.bringBackWork
  ) {
    const back = await ctx.ports.bringBackWork(task.id);
    if (back === "restored") return "What it changed is back in the folder.";
    if (back === "conflict")
      return "What it changed could not be put back: the folder changed in the same places since.";
  }
  return undefined;
}

/** How the task reads again after an undo, for its sentence ("needs your answer again"). */
function againWords(status: TaskStatus, cards: number): string {
  if (status === "needs_human" && cards > 0) return "needs your answer again";
  if (status === "failed") return "is marked failed again";
  return `is ${statusWords(status)} again`;
}

function undoMoveSentence(before: JsonValue, after: JsonValue): string {
  const b = asObject(before);
  const a = asObject(after);
  const title = typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task";
  const previous = String(b.status) as TaskStatus;
  const cards = withdrawnIds(after).length;
  const cardsBack =
    cards === 0
      ? ""
      : cards === 1
        ? "its card is back in the Inbox"
        : `its ${cards} cards are back in the Inbox`;
  if (a.status === "cancelled") {
    const to = reopenTarget(previous);
    if (to !== previous)
      return `Undone: reopened ${title}; it is ready again and a session picks it up.`;
    return `Undone: reopened ${title}; it ${againWords(to, cards)}${cardsBack ? ` and ${cardsBack}` : ""}.`;
  }
  const back: TaskStatus = ["claimed", "in_progress", "in_review"].includes(previous)
    ? "ready"
    : previous;
  return `Undone: ${title} ${againWords(back, cards)}${cardsBack ? `; ${cardsBack}` : ""}.`;
}

// --- task.create -----------------------------------------------------------------------------

const createParams = z.object({
  title: z.string().min(3).max(200),
  outcome: z.string().default(""),
  acceptance_criteria: z.array(z.string()).default([]),
  /**
   * Low, medium or high (U-041), medium when not said, as the New task dialog; an old number
   * is read as its level. Stored as the level's number (higher runs first).
   */
  priority: TaskPrioritySchema.default(DEFAULT_TASK_PRIORITY),
  /** Left out, the project's default applies: tier 0 in small-project mode, else 1 (B.6). */
  risk_tier: z.number().int().min(0).max(3).optional(),
  /**
   * Ready unless a draft is asked for (design §3.9: "add a task (ready)"): a draft is planned
   * by no session, so a task made by chat or the app would wait silently.
   */
  status: z.enum(["draft", "ready"]).default("ready"),
  /** The tasks it waits for: ids or titles of tasks of the same project. */
  depends_on: z.array(z.string()).default([]),
  /** Its own budget in micro-USD; 0: none (each run stops at its specialist's limit). */
  budget_usd_micro: z.number().int().nonnegative().default(0),
  /** Who does it: a specialist, `person` (the person, by Inbox questions), or the agent's choice. */
  specialist: z.string().trim().min(1).max(80).nullable().optional(),
  milestone_id: z.string().optional(),
  project: z.string().optional(),
});
export type TaskCreateParams = z.infer<typeof createParams>;

function createSentence(p: TaskCreateParams, projectName: string): string {
  const parts: string[] = [];
  if (p.priority !== DEFAULT_TASK_PRIORITY) parts.push(`${p.priority} priority`);
  if (p.specialist === PERSON_SPECIALIST) parts.push("it asks you in the Inbox");
  else if (p.specialist) parts.push(`for the ${p.specialist}`);
  const draft = p.status === "draft" ? " as a draft (no session picks it up)" : "";
  return `Added ${quote(p.title)} to ${projectName}${draft}${parts.length ? `, ${parts.join(", ")}` : ""}.`;
}

/** Dependencies named by id or by title, as ids of the project's tasks (unknown ones kept). */
async function resolveDependencies(
  ctx: CommandContext,
  projectId: string,
  named: readonly string[],
): Promise<string[]> {
  if (!named.length) return [];
  const tasks = await ctx.store.task.forProject(projectId, {}, { limit: 10_000 });
  return named.map((n) => {
    const id = n.trim();
    if (tasks.some((t) => t.id === id)) return id;
    const needle = id.toLowerCase();
    const matches = tasks.filter((t) => t.title.toLowerCase().includes(needle));
    return matches.length === 1 ? (matches[0] as TaskRow).id : id;
  });
}

export const taskCreate: CommandDef<TaskCreateParams> = {
  name: "task.create",
  description:
    "Add a task to a project, ready for the next session unless a draft is asked for: title, outcome, acceptance criteria, priority (low, medium or high; medium when not said), the tasks it waits for (titles), its review level (1 light review, the default; 2 full review: needs Docker; 3 full review and the person's sign-off) and who does it (a specialist, or 'person' for a question only the person can answer).",
  params: createParams,
  risk: "low",
  scope: "project",
  reversible: true,
  undoStrategy: "cancel the created task",
  async plan(params, ctx) {
    const { project, usedActive } = await resolveProject(ctx, params.project);
    const count = await ctx.store.task.count({ project_id: project.id });
    return buildCard({
      command: "task.create",
      what: `the tasks of ${project.name}`,
      oldValue: `${count} task${count === 1 ? "" : "s"}`,
      newValue: `+ ${quote(params.title)}`,
      scope: "project",
      risk: "low",
      sentence: createSentence(params, project.name),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
    });
  },
  async run(params, ctx) {
    const { project } = await resolveProject(ctx, params.project);
    // U-040: a dependency that is no task of the project (a typo) or a cancelled one would
    // keep the task from ever running; it is refused with the names, nothing is written.
    const dependsOn = await ctx.store.task.checkDependencies(
      project.id,
      null,
      await resolveDependencies(ctx, project.id, params.depends_on),
    );
    const task = await ctx.store.task.insert({
      project_id: project.id,
      milestone_id: params.milestone_id ?? null,
      title: params.title,
      outcome: params.outcome,
      acceptance_criteria: params.acceptance_criteria,
      // C-2: a deploy or a migration is stored at the full review at least (`riskTierFor`).
      risk_tier: riskTierFor(params.specialist, params.risk_tier ?? defaultRiskTier(project)),
      status: params.status,
      priority: PRIORITY_VALUES[params.priority],
      depends_on: dependsOn,
      budget_usd_micro: params.budget_usd_micro,
      specialist: params.specialist ?? null,
      // Who made it, on the row (spec B.5): the person, or which agent through which channel.
      reason:
        ctx.actor.kind === "human"
          ? "Added by you"
          : `created by ${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`,
      ...authorOf(ctx),
    });
    return {
      before: { task_id: null, project_id: project.id },
      after: { task_id: task.id, project_id: project.id, status: task.status, title: task.title },
      sentence: createSentence(params, project.name),
      projectId: project.id,
    };
  },
  // U-061: the undo cancels the task, which only works while it can still be cancelled.
  async undoBlocked(params, _before, after, ctx) {
    const task = await createdTask(after, ctx);
    if (!task) return `the task ${quote(params.title)} no longer exists`;
    if (task.status === "cancelled") return `the task ${quote(task.title)} is already cancelled`;
    if (!canTransition(TASK_TRANSITIONS, task.status, "cancelled")) {
      return `the task ${quote(task.title)} is ${task.status}; a ${task.status} task cannot be cancelled, so its creation cannot be undone`;
    }
    return null;
  },
  undoSentence: (params) => `Undone: cancelled the task ${quote(params.title)} you created.`,
  async undo(params, _before, after, ctx) {
    const task = await createdTask(after, ctx);
    if (!task || !canTransition(TASK_TRANSITIONS, task.status, "cancelled")) {
      // Never "Undone" when nothing changed (U-061); `undoBlocked` says why in words first.
      throw new ForerunnerError(
        "validation",
        `the task ${quote(params.title)} cannot be cancelled any more, so its creation cannot be undone`,
      );
    }
    await ctx.store.task.transition(
      task.id,
      task.version,
      "cancelled",
      "undo of task.create",
      actorOf(ctx),
    );
  },
};

async function createdTask(after: JsonValue, ctx: CommandContext): Promise<TaskRow | undefined> {
  const a = asObject(after);
  return typeof a.task_id === "string" ? ctx.store.task.get(a.task_id) : undefined;
}

// --- task.transition -------------------------------------------------------------------------

const transitionParams = z.object({
  ...taskRef,
  to: z.enum(TASK_STATUSES),
  reason: z.string().default(""),
  note: noteParam,
});
export type TaskTransitionParams = z.infer<typeof transitionParams>;

/** The reason a person's move leaves on the row when none was given. */
function movedByYou(from: TaskStatus, to: TaskStatus): string {
  if (to === "needs_human") return RUNNING.includes(from) ? "Stopped by you" : "Paused by you";
  if (to === "cancelled") return "Cancelled by you";
  if (to === "ready" && from === "failed") return "Try again: asked by you";
  if (to === "ready" && from === "draft") return "Made ready by you";
  if (to === "ready") return "Resumed by you";
  return `Marked ${statusWords(to)} by you`;
}

/**
 * Every move can be undone (design §3.5): the undo restores the status the task had. Kept for
 * the callers that asked; it is true for every move from a status other than the target.
 */
export function transitionUndoable(from: TaskStatus, to: TaskStatus): boolean {
  return from !== to;
}

export const taskTransition: CommandDef<TaskTransitionParams> = {
  name: "task.transition",
  description:
    "Move a task along its workflow: ready (make ready, try again), needs_human (pause), cancelled; agents also use in_progress, in_review, done and failed. Prefer task.pause, task.resume and task.reopen for those moves.",
  params: transitionParams,
  risk: (params) => (params.to === "cancelled" || params.to === "done" ? "medium" : "low"),
  maxRisk: "medium",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the task back to the status it had",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertMove(task, params.to);
    const project = await ctx.store.project.mustGet(task.project_id);
    return buildCard({
      command: "task.transition",
      what: `the task ${quote(task.title)}`,
      oldValue: statusWords(task.status),
      newValue: statusWords(params.to),
      scope: "project",
      risk: params.to === "cancelled" || params.to === "done" ? "medium" : "low",
      sentence: moveSentence(task, task.status, params.to),
      reversible: transitionUndoable(task.status, params.to),
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
      ask: moveAsk(
        task,
        task.status,
        params.to,
        params.to === "cancelled" ? (await waitingOn(ctx, task)).length : 0,
      ),
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    // The task may have moved on between the read-back and the yes (C-38).
    assertMove(task, params.to);
    return personMove(ctx, task, params.to, {
      reason:
        params.reason ||
        params.note?.trim() ||
        (ctx.actor.kind === "human"
          ? movedByYou(task.status, params.to)
          : `${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`),
      note: params.note,
    });
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => undoMoveSentence(before, after),
  undo: (_params, before, after, ctx) => undoMove(before, after, ctx),
};

// --- task.pause, task.resume -----------------------------------------------------------------

const pauseParams = z.object({ ...taskRef, note: noteParam });
export type TaskPauseParams = z.infer<typeof pauseParams>;

export const taskPause: CommandDef<TaskPauseParams> = {
  name: "task.pause",
  description:
    "Pause a task: no session runs it until the person resumes it. A running task's run stops now (Stop); the session goes on with the other tasks.",
  params: pauseParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the task back to ready",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertCan(task, "needs_human", "paused");
    return moveCard(ctx, "task.pause", task, "needs_human", params);
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    assertCan(task, "needs_human", "paused");
    return personMove(ctx, task, "needs_human", {
      reason: RUNNING.includes(task.status) ? "Stopped by you" : "Paused by you",
      note: params.note,
      asPerson: true,
    });
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => undoMoveSentence(before, after),
  undo: (_params, before, after, ctx) => undoMove(before, after, ctx),
};

const resumeParams = z.object({
  ...taskRef,
  note: noteParam,
  /** The task waits for answers (an Inbox card): go ahead without them (design §3.8). */
  without_answers: z.boolean().default(false),
});
export type TaskResumeParams = z.infer<typeof resumeParams>;

export const taskResume: CommandDef<TaskResumeParams> = {
  name: "task.resume",
  description:
    "Resume a paused task, or let a task that waits for the person's answers go ahead without them: it is ready again and the next session can run it. Its open Inbox cards are withdrawn.",
  params: resumeParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "pause the task again",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertFrom(task, ["needs_human"], "paused or waiting for your answers");
    assertSomeoneElse(task, params.without_answers);
    return moveCard(ctx, "task.resume", task, "ready", params);
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    assertFrom(task, ["needs_human"], "paused or waiting for your answers");
    assertSomeoneElse(task, params.without_answers);
    return personMove(ctx, task, "ready", {
      reason: params.without_answers
        ? "Go ahead without the answers: asked by you"
        : "Resumed by you",
      note: params.note,
      withoutAnswers: params.without_answers,
    });
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => undoMoveSentence(before, after),
  undo: (_params, before, after, ctx) => undoMove(before, after, ctx),
};

// --- task.reopen -----------------------------------------------------------------------------

const reopenParams = z.object({ ...taskRef, note: noteParam });
export type TaskReopenParams = z.infer<typeof reopenParams>;

export const taskReopen: CommandDef<TaskReopenParams> = {
  name: "task.reopen",
  description:
    "Reopen a cancelled task (Reopen), or a done task to redo it (Redo): it is ready again and the next session runs it; the person's note says what to fix and goes into its brief.",
  params: reopenParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the task back to cancelled or done",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertFrom(task, ["cancelled", "done"], "cancelled or done");
    return moveCard(ctx, "task.reopen", task, "ready", params);
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    assertFrom(task, ["cancelled", "done"], "cancelled or done");
    return personMove(ctx, task, "ready", {
      reason:
        task.status === "done"
          ? `Redo asked by you${params.note?.trim() ? `: ${params.note.trim()}` : ""}`
          : "Reopened by you",
      note: params.note,
      reopen: true,
    });
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => {
    const b = asObject(before);
    const a = asObject(after);
    const title = typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task";
    return `Undone: ${title} is ${statusWords(String(b.status) as TaskStatus)} again.`;
  },
  undo: (_params, before, after, ctx) => undoMove(before, after, ctx),
};

/**
 * A move the task's status no longer allows, in words (phase C leftover C-38: before, "task:
 * illegal transition done -> cancelled", which the chat said as "Not done: task: illegal
 * transition ..."): a task already where the move would take it, or finished, says so and that
 * nothing changed; any other says what it is now.
 */
function assertMove(task: TaskRow, to: TaskStatus): void {
  if (canTransition(TASK_TRANSITIONS, task.status, to)) return;
  const now = statusWords(task.status);
  const settled = task.status === to || task.status === "done" || task.status === "cancelled";
  throw new ForerunnerError(
    "validation",
    settled
      ? `${quote(task.title)} is already ${now}; nothing changed.`
      : `${quote(task.title)} is ${now} now, so it cannot be ${statusWords(to)}; nothing changed.`,
    {
      details: {
        taskId: task.id,
        status: task.status,
        reason: "not_offered",
        allowed: [...TASK_TRANSITIONS[task.status]],
      },
    },
  );
}

function assertCan(task: TaskRow, to: TaskStatus, word: string): void {
  if (!canTransition(TASK_TRANSITIONS, task.status, to)) {
    throw new ForerunnerError(
      "validation",
      `${quote(task.title)} is ${statusWords(task.status)}; a ${statusWords(task.status)} task cannot be ${word}.`,
      { details: { taskId: task.id, status: task.status, reason: "not_offered" } },
    );
  }
}

/**
 * A task only the person can do (`specialist: person`) has nobody to go ahead without its
 * answers: the next session would ask the same questions again.
 */
function assertSomeoneElse(task: TaskRow, withoutAnswers: boolean): void {
  if (withoutAnswers && task.specialist === PERSON_SPECIALIST) {
    throw new ForerunnerError(
      "validation",
      `${quote(task.title)} is a task only you can do: answer its card in the Inbox, or cancel it.`,
      { details: { taskId: task.id, status: task.status, reason: "not_offered" } },
    );
  }
}

function assertFrom(task: TaskRow, from: readonly TaskStatus[], words: string): void {
  if (!from.includes(task.status)) {
    throw new ForerunnerError(
      "validation",
      `${quote(task.title)} is ${statusWords(task.status)}, not ${words}.`,
      { details: { taskId: task.id, status: task.status, reason: "not_offered" } },
    );
  }
}

async function moveCard(
  ctx: CommandContext,
  command: string,
  task: TaskRow,
  to: TaskStatus,
  params: { project?: string | undefined; task: string; note?: string | undefined },
) {
  const project = await ctx.store.project.mustGet(task.project_id);
  return buildCard({
    command,
    what: `the task ${quote(task.title)}`,
    oldValue: statusWords(task.status),
    newValue: statusWords(to),
    scope: "project",
    risk: "low",
    sentence: moveSentence(task, task.status, to, { noted: !!params.note?.trim() }),
    reversible: true,
    projectId: project.id,
    projectName: project.name,
    usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
    ask: moveAsk(task, task.status, to),
  });
}

// --- task.update -----------------------------------------------------------------------------

const updateParams = z.object({
  ...taskRef,
  title: z.string().trim().min(3).max(200).optional(),
  outcome: z.string().trim().min(3).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  priority: TaskPrioritySchema.optional(),
  /** 1 light review (0 is reviewed as light too, ADR 0104), 2 full review (needs Docker), 3 full and your sign-off. */
  risk_tier: z.number().int().min(0).max(3).optional(),
  budget_usd_micro: z.number().int().nonnegative().optional(),
  /** A specialist's name, `person`, or null for the agent's choice. */
  specialist: z.string().trim().min(1).max(80).nullable().optional(),
  note: noteParam,
});
export type TaskUpdateParams = z.infer<typeof updateParams>;

/** The fields Edit changes, as stored. */
const EDIT_FIELDS = [
  "title",
  "outcome",
  "acceptance_criteria",
  "priority",
  "risk_tier",
  "budget_usd_micro",
  "specialist",
] as const;
type EditField = (typeof EDIT_FIELDS)[number];
type EditPatch = Partial<Pick<TaskRow, EditField>>;

function editPatch(params: TaskUpdateParams, task: TaskRow): EditPatch {
  const patch: EditPatch = {};
  if (params.title !== undefined && params.title !== task.title) patch.title = params.title;
  if (params.outcome !== undefined && params.outcome !== task.outcome)
    patch.outcome = params.outcome;
  if (params.acceptance_criteria !== undefined) {
    const next = params.acceptance_criteria.map((c) => c.trim()).filter(Boolean);
    if (JSON.stringify(next) !== JSON.stringify(task.acceptance_criteria))
      patch.acceptance_criteria = next;
  }
  if (params.priority !== undefined && PRIORITY_VALUES[params.priority] !== task.priority)
    patch.priority = PRIORITY_VALUES[params.priority];
  if (params.risk_tier !== undefined && params.risk_tier !== task.risk_tier)
    patch.risk_tier = params.risk_tier;
  if (params.budget_usd_micro !== undefined && params.budget_usd_micro !== task.budget_usd_micro)
    patch.budget_usd_micro = params.budget_usd_micro;
  if (params.specialist !== undefined && (params.specialist ?? null) !== task.specialist)
    patch.specialist = params.specialist ?? null;
  // C-2: a task handed to a deploy or a migration, or one lowered below the full review while it
  // stays theirs, is stored at the full review at least (`riskTierFor`).
  const specialist = patch.specialist !== undefined ? patch.specialist : task.specialist;
  const tier = patch.risk_tier ?? task.risk_tier;
  const floored = riskTierFor(specialist, tier);
  if (floored !== tier) {
    if (floored === task.risk_tier) delete patch.risk_tier;
    else patch.risk_tier = floored;
  }
  return patch;
}

function fieldsOf(task: TaskRow, fields: readonly string[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const f of fields) out[f] = task[f as EditField] as JsonValue;
  return out;
}

/** What an edit changed, in words: "review level to Light review, priority to High". */
async function editWords(ctx: CommandContext, patch: EditPatch): Promise<string> {
  const parts: string[] = [];
  if (patch.title !== undefined) parts.push(`the title to ${quote(patch.title)}`);
  if (patch.outcome !== undefined) parts.push("what done looks like");
  if (patch.acceptance_criteria !== undefined) parts.push("the criteria");
  if (patch.priority !== undefined)
    parts.push(`priority to ${PRIORITY_LABELS[priorityLevel(patch.priority)]}`);
  if (patch.risk_tier !== undefined)
    parts.push(`review level to ${reviewLevelWords(patch.risk_tier)}`);
  if (patch.budget_usd_micro !== undefined) {
    if (patch.budget_usd_micro <= 0) parts.push("no budget of its own");
    else {
      const rate = await ctx.ports.chfPerUsd(ctx.clock.nowIso());
      parts.push(`budget to ${formatChfShort(Math.round(patch.budget_usd_micro * rate))}`);
    }
  }
  if (patch.specialist !== undefined) parts.push(`who does it to ${whoWords(patch.specialist)}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const taskUpdate: CommandDef<TaskUpdateParams> = {
  name: "task.update",
  description:
    "Edit a task that is not running, done or cancelled: its title, outcome, acceptance criteria, priority, review level (1 light review; 2 full review: needs Docker; 3 full review and sign-off), budget or specialist ('person' for the person).",
  params: updateParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the fields back as they were",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    const patch = editPatch(params, task);
    const project = await ctx.store.project.mustGet(task.project_id);
    return buildCard({
      command: "task.update",
      what: `the task ${quote(task.title)}`,
      oldValue: "as it is",
      newValue: (await editWords(ctx, patch)) || "unchanged",
      scope: "project",
      risk: "low",
      sentence: `Changed ${quote(task.title)}: ${(await editWords(ctx, patch)) || "nothing"}.`,
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
      ask: `Change ${quote(task.title)}: ${(await editWords(ctx, patch)) || "nothing"}?`,
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    const patch = editPatch(params, task);
    const fields = Object.keys(patch);
    if (fields.length === 0 && !params.note?.trim()) {
      throw new ForerunnerError("validation", `Nothing to change on ${quote(task.title)}.`, {
        details: { taskId: task.id, reason: "unchanged" },
      });
    }
    const words = await editWords(ctx, patch);
    const updated = fields.length
      ? await ctx.store.task.edit(
          task.id,
          task.version,
          patch,
          params.note?.trim() || `Changed by you: ${words}`,
          actorOf(ctx),
        )
      : task;
    const noteId = await queueNote(ctx, task, params.note);
    return {
      before: { task_id: task.id, title: task.title, fields: fieldsOf(task, fields) },
      after: {
        task_id: task.id,
        title: updated.title,
        fields: fieldsOf(updated, fields),
        ...(noteId ? { note_id: noteId } : {}),
      },
      sentence: `${fields.length ? `Changed ${quote(task.title)}: ${words}.` : `Noted for ${quote(task.title)}.`}${
        noteId ? " Your note goes into its next brief." : ""
      }`,
      projectId: task.project_id,
      reversible: true,
    };
  },
  async undoBlocked(_params, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.task_id !== "string") return "this change does not name the task it changed";
    const task = await ctx.store.task.get(a.task_id);
    if (!task) return "the task no longer exists";
    const now = fieldsOf(task, Object.keys(asObject(a.fields)));
    if (JSON.stringify(now) !== JSON.stringify(asObject(a.fields)))
      return `${quote(task.title)} was changed again since; undo would not put it back as it was`;
    return null;
  },
  undoSentence(_params, before) {
    const b = asObject(before);
    return `Undone: ${typeof b.title === "string" ? quote(b.title) : "the task"} is as it was.`;
  },
  async undo(_params, before, after, ctx) {
    const a = asObject(after);
    const task = await ctx.store.task.mustGet(String(a.task_id));
    const fields = asObject(asObject(before).fields) as EditPatch;
    if (Object.keys(fields).length)
      await ctx.store.task.edit(task.id, task.version, fields, "undo", actorOf(ctx));
    await dismissNotes(ctx, after);
  },
};

// --- task.dependencies -----------------------------------------------------------------------

const dependenciesParams = z
  .object({
    ...taskRef,
    /** Every task it waits for (ids or titles); an empty list: it waits for nothing. */
    depends_on: z.array(z.string()).optional(),
    /**
     * Tasks (ids or titles) it should wait for besides what it waits for now ("make the FAQ
     * wait for the README", design §3.9); used when `depends_on` is not given.
     */
    add: z.array(z.string()).optional(),
    reason: z.string().default(""),
    note: noteParam,
  })
  .refine((p) => p.depends_on !== undefined || (p.add?.length ?? 0) > 0, {
    message: "name the tasks it waits for (depends_on) or the ones to add (add)",
  });
export type TaskDependenciesParams = z.infer<typeof dependenciesParams>;

async function titlesOf(ctx: CommandContext, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) out.push((await ctx.store.task.get(id))?.title ?? "a task that is gone");
  return out;
}

function dependenciesSentence(title: string, titles: readonly string[]): string {
  return titles.length
    ? `${quote(title)} now waits for ${namesList(titles)}.`
    : `${quote(title)} waits for no other task now.`;
}

/**
 * The read-back of a change to what a task waits for (design §3.9): 'Make "Write the FAQ" wait
 * for "Write the README"?', or with tasks added to some it waits for already, 'Make "X" also
 * wait for "Y"?' (only the new ones named).
 */
async function dependenciesAsk(
  ctx: CommandContext,
  task: TaskRow,
  params: Pick<TaskDependenciesParams, "depends_on" | "add">,
  titles: readonly string[],
): Promise<string> {
  if (!params.depends_on && task.depends_on.length && params.add?.length) {
    const added = (await resolveDependencies(ctx, task.project_id, params.add)).filter(
      (id) => !task.depends_on.includes(id),
    );
    if (added.length)
      return `Make ${quote(task.title)} also wait for ${namesList(await titlesOf(ctx, added))}?`;
  }
  return titles.length
    ? `Make ${quote(task.title)} wait for ${namesList(titles)}?`
    : `Let ${quote(task.title)} run without waiting for another task?`;
}

/** What the task should wait for: the whole list given, or what it waits for now plus `add`. */
async function wantedDependencies(
  ctx: CommandContext,
  task: TaskRow,
  params: Pick<TaskDependenciesParams, "depends_on" | "add">,
): Promise<string[]> {
  if (params.depends_on) return resolveDependencies(ctx, task.project_id, params.depends_on);
  const added = await resolveDependencies(ctx, task.project_id, params.add ?? []);
  return [...new Set([...task.depends_on, ...added])];
}

export const taskDependencies: CommandDef<TaskDependenciesParams> = {
  name: "task.dependencies",
  description:
    "Change what a task waits for: the tasks (by title) that must be done before it runs (depends_on: the whole list; an empty list lets it run on its own), or add: tasks to wait for besides what it waits for now. Refused for a cancelled task, the task itself or a cycle.",
  params: dependenciesParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put back what it waited for",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    const ids = await ctx.store.task.checkDependencies(
      task.project_id,
      task.id,
      await wantedDependencies(ctx, task, params),
    );
    const project = await ctx.store.project.mustGet(task.project_id);
    const titles = await titlesOf(ctx, ids);
    return buildCard({
      command: "task.dependencies",
      what: `what ${quote(task.title)} waits for`,
      oldValue: namesList(await titlesOf(ctx, task.depends_on)) || "nothing",
      newValue: namesList(titles) || "nothing",
      scope: "project",
      risk: "low",
      sentence: dependenciesSentence(task.title, titles),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
      ask: await dependenciesAsk(ctx, task, params, titles),
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    const ids = await wantedDependencies(ctx, task, params);
    const updated = await ctx.store.task.setDependencies(
      task.id,
      task.version,
      ids,
      params.reason || params.note?.trim() || "What it waits for changed by you",
      actorOf(ctx),
    );
    const noteId = await queueNote(ctx, task, params.note);
    return {
      before: { task_id: task.id, title: task.title, depends_on: task.depends_on },
      after: {
        task_id: task.id,
        title: task.title,
        depends_on: updated.depends_on,
        ...(noteId ? { note_id: noteId } : {}),
      },
      sentence: `${dependenciesSentence(task.title, await titlesOf(ctx, updated.depends_on))}${
        noteId ? " Your note goes into its next brief." : ""
      }`,
      projectId: task.project_id,
      reversible: true,
    };
  },
  async undoBlocked(_params, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.task_id !== "string") return "this change does not name the task it changed";
    const task = await ctx.store.task.get(a.task_id);
    if (!task) return "the task no longer exists";
    if (JSON.stringify(task.depends_on) !== JSON.stringify(a.depends_on))
      return `what ${quote(task.title)} waits for changed again since; undo would not put it back as it was`;
    return null;
  },
  undoSentence(_params, before) {
    const b = asObject(before);
    return `Undone: ${typeof b.title === "string" ? quote(b.title) : "the task"} waits for what it waited for before.`;
  },
  async undo(_params, before, after, ctx) {
    const b = asObject(before);
    const task = await ctx.store.task.mustGet(String(asObject(after).task_id));
    const previous = Array.isArray(b.depends_on)
      ? b.depends_on.filter((d): d is string => typeof d === "string")
      : [];
    await ctx.store.task.setDependencies(task.id, task.version, previous, "undo", actorOf(ctx));
    await dismissNotes(ctx, after);
  },
};
