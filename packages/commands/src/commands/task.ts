import { ForerunnerError, isAbsolute } from "@forerunner/platform";
import { defaultRiskTier, riskTierFor } from "@forerunner/runtime";
// The module itself (a pure module of words), as the priority one below.
import {
  type CancelWorkKind,
  cancelledWorkWords,
  cancelWorkKind,
  cancelWorkLine,
} from "@forerunner/runtime/daemon/cancel-words";
import { redoWhileTakingOutSentence } from "@forerunner/runtime/daemon/take-out-words";
// The module itself (import-free): a merge card's key and its Redo's mark (W15-04).
import {
  MERGE_CARD_KEY,
  notRedoneMergeCard,
  redoMarkOf,
  redoneMergeCard,
} from "@forerunner/runtime/loop/merge-mode";
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
  type JsonObject,
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

/** A title as two tasks are compared by it: trimmed, lower case, one space between words. */
const sameTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/** The pull request number of a task's work, when it has one. */
const prNumberOf = (t: TaskRow): number | null => {
  const m = /\/pull\/(\d+)\b/.exec(t.pr_url ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * What tells tasks with one title apart (W15-37), as the person reads it and says it back:
 * their pull requests ("#17"), else their states ("the done one"), else their age ("the older
 * one", "the first one"); each with the words that pick it.
 */
function sameTitleTags(tasks: readonly TaskRow[]): { task: TaskRow; tag: string; says: RegExp }[] {
  const byAge = [...tasks].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const prs = byAge.map(prNumberOf);
  if (prs.every((n) => n !== null) && new Set(prs).size === prs.length)
    return byAge.map((task, i) => ({
      task,
      tag: `#${prs[i]}`,
      says: new RegExp(`^#?${prs[i]}$`),
    }));
  const states = byAge.map((t) => statusWords(t.status).replace(/^a /, ""));
  if (new Set(states).size === states.length)
    return byAge.map((task, i) => ({
      task,
      tag: `the ${states[i]} one`,
      says: new RegExp(`^${states[i]}$`),
    }));
  const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  return byAge.map((task, i) => {
    const word =
      byAge.length === 2 ? (i === 0 ? "older" : "newer") : (ORDINALS[i] ?? `number ${i + 1}`);
    const also =
      byAge.length === 2
        ? i === 0
          ? "|oldest|first|1st"
          : "|newest|latest|last|second|2nd"
        : i === 0
          ? "|oldest|1st"
          : i === byAge.length - 1
            ? "|newest|latest|last"
            : "";
    return { task, tag: `the ${word} one`, says: new RegExp(`^(?:${word}${also})$`) };
  });
}

/** The words that pick one of several same-titled tasks: "#17", "the done one", "older". */
function pickWord(rest: string): string {
  return rest
    .toLowerCase()
    .replace(/^[\s,;:.()\-–—]+|[\s,;:.()\-–—]+$/g, "")
    .replace(/^(?:the|die|der|das)\s+/, "")
    .replace(/\s+(?:one|task)$/, "")
    .trim();
}

/** "Two tasks are called "X": #17 and #18. Say which, for example "X #17"." (W15-37). */
function sameTitleRefusal(title: string, tags: readonly { tag: string }[]): ForerunnerError {
  const named = tags.map((t) => t.tag);
  const list =
    named.length === 2
      ? `${named[0]} and ${named[1]}`
      : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  const first = named[0] ?? "";
  // In brackets, not after a comma: chat splits a line at its commas into separate requests,
  // so "X, the older one" never reached this command (review of W15-37, bench).
  const example = first.startsWith("#") ? `${title} ${first}` : `${title} (${first})`;
  const COUNTS = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const count = COUNTS[tags.length - 2] ?? String(tags.length);
  return new ForerunnerError(
    "validation",
    `${count} tasks are called ${quote(title)}: ${list}. Say which, for example ${quote(example)}.`,
    { details: { candidates: named } },
  );
}

async function findTask(
  params: { task: string; project?: string | undefined },
  ctx: CommandContext,
): Promise<TaskRow> {
  const direct = await ctx.store.task.get(params.task);
  if (direct) return direct;
  const { project } = await resolveProject(ctx, params.project);
  const tasks = await ctx.store.task.forProject(project.id);
  const needle = params.task.trim().toLowerCase();
  // W15-37: tasks of one title are told apart by a word after it ("Write the guide #17",
  // "Write the guide, the done one"), the words the refusal below gives.
  const said = sameTitle(params.task);
  const titled = tasks.filter(
    (t) => said.startsWith(sameTitle(t.title)) && said.length > sameTitle(t.title).length,
  );
  const longest = Math.max(0, ...titled.map((t) => sameTitle(t.title).length));
  const group = titled.filter((t) => sameTitle(t.title).length === longest);
  if (group.length > 1) {
    const word = pickWord(said.slice(longest));
    const tags = sameTitleTags(group);
    const hit = tags.filter((t) => t.says.test(word));
    if (hit.length === 1) return (hit[0] as { task: TaskRow }).task;
  }
  const matches = tasks.filter((t) => t.title.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as TaskRow;
  if (matches.length > 1 && new Set(matches.map((m) => sameTitle(m.title))).size === 1)
    throw sameTitleRefusal((matches[0] as TaskRow).title, sameTitleTags(matches));
  if (matches.length === 0 && group.length > 1)
    throw sameTitleRefusal((group[0] as TaskRow).title, sameTitleTags(group));
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

/** The task's open cards about its pull request's merge (`MERGE_LEFT_OPEN_KEY`). */
async function openMergeCards(ctx: CommandContext, taskId: string) {
  return (
    await ctx.store.humanRequest.list({ task_id: taskId, status: "open" } as never, { limit: 100 })
  ).filter((r) => (r.change_card as { key?: unknown } | null)?.key === MERGE_CARD_KEY);
}

/**
 * W15-04: a done task's open merge cards (a conflict notice, a rebuild's card), answered as
 * their own Redo answers them when the Tasks tab's Redo reopens the task: closed "redone" with
 * `REDO_FROM_BASE`, so the next run does the task again from main. Returns the ids withdrawn and
 * what each card held where the mark goes (`redoMarkOf`), for the Undo (fix-up of the review:
 * the Undo left the card withdrawn for good, with the mark).
 */
async function redoMergeCards(
  ctx: CommandContext,
  taskId: string,
): Promise<{ ids: string[]; marks: Record<string, JsonObject> }> {
  const ids: string[] = [];
  const marks: Record<string, JsonObject> = {};
  for (const card of await openMergeCards(ctx, taskId)) {
    const marked = await ctx.store.humanRequest.patch(card.id, {
      change_card: redoneMergeCard(card.change_card, ctx.clock.nowIso()) as JsonObject,
    });
    await ctx.store.humanRequest.withdraw(marked.id, marked.version);
    ids.push(card.id);
    marks[card.id] = redoMarkOf(card.change_card) as JsonObject;
  }
  return { ids, marks };
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

/** Normalised as the answer readers compare words: case, spaces, `_` and `-` do not matter. */
const optionWord = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

/**
 * A move said in chat or voice as the answer of the task's open card that offers it (design
 * §3.8: one card per question; §3.9: an answer to a card is read back once): "try X again" on
 * a task whose failed card offers Try again is that card's Try again, "cancel X" its Cancel
 * task, "mark X done" its Mark done anyway, "go ahead without the answers" its Go ahead without.
 * Before (phase E review), the move was filed as a second card ('Resume "X"?') beside the one
 * about the same task, and a yes there moved the task past what its card does (the session the
 * card's Try again starts, its Done line). The answer then goes the card's way: read back in the
 * card's words when the chat may answer it, or the reply points to the card when it needs this
 * computer's OK. The Tasks tab's buttons (source ui) move the task as before. Null: no card of
 * the task offers it, so the move is planned as said.
 */
export async function moveAsCardAnswer(
  ctx: CommandContext,
  params: { task: string; project?: string | undefined },
  option: string,
): Promise<{ name: "request.answer"; params: { request: string; answer: string } } | null> {
  if (ctx.source !== "chat" && ctx.source !== "voice") return null;
  if (!ctx.ports.cardWords) return null;
  const task = await findTask(params, ctx).catch(() => null);
  if (!task) return null;
  const open = await ctx.store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
    orderBy: [{ column: "created_at" }, { column: "id" }],
    limit: 50,
  });
  for (const r of open) {
    const words = await ctx.ports.cardWords(r).catch(() => null);
    const choice = words?.choices.find((c) => optionWord(c.label) === optionWord(option));
    if (choice) return { name: "request.answer", params: { request: r.id, answer: choice.label } };
  }
  return null;
}

/** The card option a move to `to` is, when a card offers it. */
function cardOptionFor(to: TaskStatus): string | null {
  if (to === "ready") return "Try again";
  if (to === "cancelled") return "Cancel task";
  if (to === "done") return "Mark done anyway";
  return null;
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

/** Whether the task's project is linked to the person's own folder (its repo is a path, C-37). */
async function ownFolderOf(
  ctx: Pick<CommandContext, "store">,
  task: Pick<TaskRow, "project_id">,
): Promise<boolean> {
  const linked = (await ctx.store.project.get(task.project_id))?.repos[0]?.trim();
  return !!linked && isAbsolute(linked);
}

/** What a Cancel of the task does to its work now, for its read-back (`moveAsk`). */
async function cancelWorkFor(
  ctx: CommandContext,
  task: TaskRow,
  live: boolean | undefined,
): Promise<CancelWorkKind | null> {
  const open =
    task.status === "needs_human"
      ? await ctx.store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
          limit: 50,
        })
      : [];
  return cancelWorkKind({
    running: RUNNING.includes(task.status),
    liveReview: task.status === "in_review" && live === true,
    paused: open.some(
      (r) => (r.change_card as { key?: unknown } | null)?.key === "task:budget_stop",
    ),
    pullRequest: !!task.pr_url,
    ownFolder: await ownFolderOf(ctx, task),
  });
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
  task: Pick<TaskRow, "title"> & Partial<Pick<TaskRow, "pr_url">>,
  from: TaskStatus,
  to: TaskStatus,
  stuck = 0,
  /** Whether a run or review of the task goes on now (`CommandPorts.liveWork`); see there. */
  live?: boolean,
  /**
   * What Cancel does to its work (`cancelWorkFor`: a paused task's work set aside, a linked
   * folder that keeps it, C-37); absent: worded from the status, the pull request and `live`.
   */
  work?: CancelWorkKind | null,
): string {
  const t = quote(task.title);
  if (to === "cancelled") {
    // As the row's Cancel dialog (L-10, `cancelWorkLine`) and the line after Yes
    // (`personMove`): what Yes does to a task whose run is going (C-38), whose review goes on
    // here (L-7), or that paused with its work in progress (budget-resume); a task left in
    // review with no review running is only dropped. One line, as the dialog's (W6-7: at most
    // 100 characters after "Drops it.").
    const kind =
      work !== undefined
        ? work
        : cancelWorkKind({
            running: RUNNING.includes(from),
            liveReview: from === "in_review" && live === true,
            paused: false,
            pullRequest: !!task.pr_url,
            ownFolder: false,
          });
    const parts = [
      "Drops it.",
      kind ? cancelWorkLine(kind) : null,
      stuck ? `${stuck === 1 ? "1 task" : `${stuck} tasks`} waiting on it will be stuck.` : null,
    ];
    return `Cancel ${t}? ${parts.filter(Boolean).join(" ")}`;
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

/** What Undo of such a cancel says when the same files changed since (L-6). */
export const UNDO_CONFLICT_WORDS =
  "What it changed could not be put back: the same files changed since. Its next run does the work again.";

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
    /** W15-04: the redo answered the task's merge card, so the next run starts from main. */
    fromMain?: boolean;
    /**
     * What happened to the work of a cancelled task (phase C, live walk 2 C1; budget-resume): a
     * run or review stopped and its changes removed (Undo restores them), its pull request kept,
     * what it wrote kept in the person's own folder (C-37), or a paused task's work set aside.
     */
    work?: CancelWorkKind;
    /** A paused task's work stays: why ('"Y" built on it'). */
    kept?: string | null;
  } = {},
): string {
  const t = quote(task.title);
  let s: string;
  if (to === "cancelled" && extra.work)
    s = `Cancelled ${t}: ${cancelledWorkWords(extra.work, extra.kept)}`;
  else if (to === "cancelled") s = `Cancelled ${t}.`;
  else if (to === "needs_human")
    s = RUNNING.includes(from)
      ? `Stopped ${t}: its run ended and it is paused until you press Resume.`
      : `Paused ${t}: no session runs it until you press Resume.`;
  else if (to === "ready" && from === "draft") s = `${t} is ready: a session will pick it up.`;
  else if (to === "ready" && from === "failed") s = `${t} is ready to try again.`;
  else if (to === "ready" && from === "cancelled") s = `Reopened ${t}: it is ready again.`;
  else if (to === "ready" && (from === "done" || extra.redo))
    s = `Reopened ${t} to redo it${extra.fromMain ? " from main" : ""}: the next session works on it again.`;
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
    /** W15-04: a done task's Redo answers its open merge cards as their own Redo does. */
    redoMergeCards?: boolean;
  },
) {
  const from = task.status;
  const actor = opts.asPerson ? { humanId: ctx.humanId, agentId: null } : actorOf(ctx);
  const moved = opts.reopen
    ? await ctx.store.task.reopen(task.id, task.version, "ready", opts.reason, actor)
    : await ctx.store.task.transition(task.id, task.version, to, opts.reason, actor);
  const withdrawn =
    WAITS_ON_CARDS.includes(from) || to === "cancelled" ? await withdrawCards(ctx, task.id) : [];
  // W15-04: recorded with the move's other cards, so its Undo opens them again (fix-up).
  const redone =
    opts.redoMergeCards && from === "done"
      ? await redoMergeCards(ctx, task.id)
      : { ids: [], marks: {} };
  withdrawn.push(...redone.ids);
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
  // What happens to the work of a cancelled task. A run or review the cancel stopped: the
  // session's runner takes what it changed out of the folder once it stops (phase C), a pull
  // request already opened stays open, and a project linked to the person's own folder keeps
  // what it wrote (C-37). Said only when a live run or review was stopped: a task in review that
  // no session reviews has nothing taken out. A task that does not run (a paused one,
  // budget-resume): its work in progress is set aside now, Undo and Reopen bring it back.
  let work: CancelWorkKind | undefined;
  let kept: string | null = null;
  let setAside = false;
  if (to === "cancelled") {
    const ownFolder = await ownFolderOf(ctx, task);
    if (stopped === true)
      work =
        cancelWorkKind({
          running: RUNNING.includes(from),
          liveReview: from === "in_review",
          paused: false,
          pullRequest: !!task.pr_url,
          ownFolder,
        }) ?? undefined;
    else if (!ownFolder && ctx.ports.setAsideWork) {
      const aside = await ctx.ports.setAsideWork(task.id).catch(() => null);
      if (aside && (aside.files.length > 0 || aside.kept)) {
        work = "paused";
        kept = aside.kept;
        setAside = aside.files.length > 0;
      }
    }
  }
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
      ...(redone.ids.length ? { redone_cards: redone.marks } : {}),
      ...(setAside ? { set_aside: true } : {}),
    },
    sentence: moveSentence(task, from, moved.status, {
      withdrawn: withdrawn.length,
      noted: noteId !== null,
      stuck,
      redo: from === "done",
      fromMain: redone.ids.length > 0,
      ...(work ? { work, kept } : {}),
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
  // W15-04 fix-up: a merge card the Redo answered comes back without the Redo's mark.
  const redone = asObject(asObject(after).redone_cards ?? {});
  for (const requestId of withdrawnIds(after)) {
    let card = await ctx.store.humanRequest.get(requestId);
    if (card?.status !== "withdrawn") continue;
    if (requestId in redone)
      card = await ctx.store.humanRequest.patch(card.id, {
        change_card: notRedoneMergeCard(card.change_card, redone[requestId]) as JsonObject,
      });
    await ctx.store.humanRequest.reopenWithdrawn(card.id, card.version);
  }
  await dismissNotes(ctx, after);
  // The cancel of a task that ran took what it changed out of the folder (phase C), and the
  // cancel of a paused task its work in progress (budget-resume): the undo puts it back, on top
  // of the folder as it is now (a paused task's as work in progress again, which its next run
  // continues from).
  const ran = RUNNING.includes(b.status as TaskStatus) || b.status === "in_review";
  if (a.status === "cancelled" && (ran || a.set_aside === true) && ctx.ports.bringBackWork) {
    const back = await ctx.ports.bringBackWork(task.id);
    if (back === "restored")
      return ran ? "What it changed is back in the folder." : "Its work so far is back.";
    if (back === "conflict") return UNDO_CONFLICT_WORDS;
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
    // C-30: the undo starts no session (before: "... and a session picks it up").
    if (to !== previous) return `Undone: reopened ${title}; it is ready again.`;
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
  async redirect(params, ctx) {
    const option = cardOptionFor(params.to);
    // A person's note goes with the move; a card's answer has no room for it: as said.
    return option && !params.note?.trim() ? moveAsCardAnswer(ctx, params, option) : null;
  },
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
        ctx.ports.liveWork?.(task.id),
        params.to === "cancelled"
          ? await cancelWorkFor(ctx, task, ctx.ports.liveWork?.(task.id))
          : undefined,
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
  async redirect(params, ctx) {
    if (params.note?.trim()) return null;
    return moveAsCardAnswer(ctx, params, params.without_answers ? "Go ahead without" : "Try again");
  },
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

/**
 * Redo of a done task whose work is being taken out (its take-out pull request is open) is
 * refused in words (R-pin, leftovers7-merge): the redo's new pull request would queue the merge
 * record that keeps the take-out, which would then be neither listed nor settled. Once the
 * take-out is merged or closed, Redo is offered again.
 */
async function assertNotTakingOut(task: TaskRow, ctx: CommandContext): Promise<void> {
  if (task.status !== "done") return;
  const record = await ctx.store.mergeRecord.forTask(task.id).catch(() => undefined);
  if (record?.take_out_state === "open" && record.take_out_pr_number)
    throw new ForerunnerError(
      "validation",
      redoWhileTakingOutSentence(task.title, record.take_out_pr_number),
      { details: { taskId: task.id, takeOut: record.take_out_pr_number, reason: "taking_out" } },
    );
}

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
    await assertNotTakingOut(task, ctx);
    return moveCard(ctx, "task.reopen", task, "ready", params);
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    assertFrom(task, ["cancelled", "done"], "cancelled or done");
    await assertNotTakingOut(task, ctx);
    // W15-04: a done task's open merge card (a conflict notice, a rebuild's card) is answered
    // as its own Redo answers it, in the same transaction as the reopen: closed "redone", and
    // the next run does the task again from main. Before (live check 2, F3), the card stayed
    // open beside the run's own rebase-conflict card, and outlived the task's next accept. No
    // session starts here (the Tasks-row owner question stays open). The move's line says the
    // card closed and the redo is from main, and its Undo opens the card again (fix-up).
    const moved = await ctx.store.transaction((tx) =>
      personMove({ ...ctx, store: tx }, task, "ready", {
        reason:
          task.status === "done"
            ? `Redo asked by you${params.note?.trim() ? `: ${params.note.trim()}` : ""}`
            : "Reopened by you",
        note: params.note,
        reopen: true,
        redoMergeCards: true,
      }),
    );
    // budget-resume: what its cancel set aside comes back with it (the Inbox card's Cancel task
    // has no Undo: Reopen is the way back), its work in progress continued by its next run.
    if (task.status === "cancelled" && ctx.ports.bringBackWork) {
      const back = await ctx.ports.bringBackWork(task.id).catch(() => "missing" as const);
      if (back === "restored") moved.sentence += " Its work so far is back.";
      if (back === "conflict") moved.sentence += ` ${UNDO_CONFLICT_WORDS}`;
    }
    return moved;
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => {
    const b = asObject(before);
    const a = asObject(after);
    const title = typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task";
    // W15-04 fix-up: the merge card its Redo closed is open again.
    const cards = withdrawnIds(after).length;
    const back =
      cards === 0
        ? ""
        : cards === 1
          ? "; its card is back in the Inbox"
          : `; its ${cards} cards are back in the Inbox`;
    return `Undone: ${title} is ${statusWords(String(b.status) as TaskStatus)} again${back}.`;
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
