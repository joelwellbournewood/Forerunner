import { ForerunnerError, isAbsolute } from "@forerunner/platform";
import { defaultRiskTier, riskTierFor } from "@forerunner/runtime";
// The module itself (a pure module of words), as the priority one below.
import {
  type CancelWorkKind,
  cancelledWorkWords,
  cancelWorkKind,
  cancelWorkLine,
  prNumberOf as prNumberOfUrl,
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
import { fileTheWordsWrite, writesNoFileLine } from "@forerunner/runtime/registry/tools";
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
import { buildCard, type CardSubject, formatChfShort } from "../change-card.ts";
import { taskSubject } from "../readback-check.ts";
import type { CommandContext, CommandDef, CommandOutcome } from "../types.ts";
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
/**
 * A note for the specialist: it goes into the task's next brief. l4-selftasks-chat
 * (L4-selftasks-120; live check 4, L4-chat-20: the chat model wrote "Put on hold by the person."
 * on a pause the person never noted): its description tells the chat model to pass only the
 * person's own words, and a note the model passes is read back before it is made.
 */
export const NOTE_PARAM_DESCRIPTION =
  "Only words the person gave for the specialist, quoted as they said them; leave it out when they gave none. Never a summary of the move.";
const noteParam = z.string().trim().max(2000).optional().describe(NOTE_PARAM_DESCRIPTION);

/**
 * L4-selftasks-120: a note is the person's only when the person wrote it: their own command (the
 * Tasks tab, the drawer, chat's patterns), never one the chat's model passed, also after their
 * yes (the executor runs that yes as them and marks it `onPersonsWords`).
 */
function personsNote(ctx: CommandContext): boolean {
  return ctx.actor.kind === "human" && ctx.onPersonsWords !== true;
}

/**
 * l4-selftasks-carried (L4-selftasks-120): a note the person wrote themselves (`personsNote`), as
 * the redirect guards of task.transition and task.resume judge it: before, any note kept a move
 * off the card whose answer it is, the chat model's own included.
 */
function ownNote(ctx: CommandContext, note: string | undefined): boolean {
  return !!note?.trim() && personsNote(ctx);
}

/** The note a read-back shows when the model passed it ('Note for its next brief: "…"'). */
function noteClause(ctx: CommandContext, note: string | undefined): string {
  const text = note?.trim();
  // fixup-l4-selftasks-chat: a note that ends its own sentence gets no second period after
  // the quote (before: 'Note for its next brief: "Put on hold by the person.".').
  const end = text && /[.!?]$/.test(text) ? "" : ".";
  return text && !personsNote(ctx) ? ` Note for its next brief: ${quote(text)}${end}` : "";
}

/** The note's end of a sentence: the person's own, or one the agent passed. */
function noteGoes(ctx: CommandContext, cancelled = false): string {
  const whose = personsNote(ctx) ? "Your note" : "The note";
  return cancelled
    ? ` ${whose} goes into its brief if you reopen it.`
    : ` ${whose} goes into its next brief.`;
}

/** A title as two tasks are compared by it: trimmed, lower case, one space between words. */
const sameTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/** The pull request number of a task's work, when it has one. */
const prNumberOf = (t: TaskRow): number | null => {
  const m = /\/pull\/(\d+)\b/.exec(t.pr_url ?? "");
  return m ? Number(m[1]) : null;
};

/** Tasks of one title from the oldest: the order their age words follow. */
const oldestFirst = (tasks: readonly TaskRow[]): TaskRow[] =>
  [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

/** A task's state as a same-title tag says it: "done", "paused", "draft". */
const stateTag = (t: TaskRow): string => statusWords(t.status).replace(/^a /, "");

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/** The age word of the `i`th oldest of `n` same-titled tasks, and the words that pick it. */
function ageTag(i: number, n: number): { word: string; says: RegExp } {
  const word = n === 2 ? (i === 0 ? "older" : "newer") : (ORDINALS[i] ?? `number ${i + 1}`);
  const also =
    n === 2
      ? i === 0
        ? "|oldest|first|1st"
        : "|newest|latest|last|second|2nd"
      : i === 0
        ? "|oldest|1st"
        : i === n - 1
          ? "|newest|latest|last"
          : "";
  return { word, says: new RegExp(`^(?:${word}${also})$`) };
}

/**
 * What tells tasks with one title apart (W15-37), as the person reads it in a refusal and says
 * it back: their pull requests ("#17"), else their states ("the done one"), else their age ("the
 * older one", "the first one"); each with the words that pick it. The refusal names one kind;
 * `sameTitlePickers` decides what a word picks.
 */
export function sameTitleTags(
  tasks: readonly TaskRow[],
): { task: TaskRow; tag: string; says: RegExp }[] {
  const byAge = oldestFirst(tasks);
  const prs = byAge.map(prNumberOf);
  if (prs.every((n) => n !== null) && new Set(prs).size === prs.length)
    return byAge.map((task, i) => ({
      task,
      tag: `#${prs[i]}`,
      says: new RegExp(`^#?${prs[i]}$`),
    }));
  const states = byAge.map(stateTag);
  if (new Set(states).size === states.length)
    return byAge.map((task, i) => ({
      task,
      tag: `the ${states[i]} one`,
      says: new RegExp(`^${states[i]}$`),
    }));
  return byAge.map((task, i) => {
    const age = ageTag(i, byAge.length);
    return { task, tag: `the ${age.word} one`, says: age.says };
  });
}

/**
 * The words that pick each of several same-titled tasks (l3-small, run L3; live check 3,
 * L3-run-6): every kind of tag that tells it apart from the others, not only the kind a refusal
 * names now. Its pull request ("#17") when no other task of the group has that number, its
 * state ("paused") when no other is in that state, and its age ("older", "first") always. So a
 * word the app offered keeps picking its task after a pause, a pull request or a state change:
 * before, "Write the guide (the older one)" was refused as soon as the older one was paused,
 * since the tags had become "the paused one" and "the ready one". The kinds' words never
 * overlap (a number, a state, an age), so one word picks at most one task of each kind.
 */
export function sameTitlePickers(tasks: readonly TaskRow[]): { task: TaskRow; says: RegExp[] }[] {
  const byAge = oldestFirst(tasks);
  const prs = byAge.map(prNumberOf);
  const states = byAge.map(stateTag);
  const once = <T>(all: readonly T[], v: T) => all.filter((x) => x === v).length === 1;
  return byAge.map((task, i) => {
    const pr = prs[i] ?? null;
    const state = states[i] as string;
    return {
      task,
      says: [
        ...(pr !== null && once(prs, pr) ? [new RegExp(`^#?${pr}$`)] : []),
        ...(once(states, state) ? [new RegExp(`^${state}$`)] : []),
        ageTag(i, byAge.length).says,
      ],
    };
  });
}

/** The one task of a same-titled group that `word` picks, else undefined (none, or several). */
export function pickSameTitled(tasks: readonly TaskRow[], word: string): TaskRow | undefined {
  const hit = sameTitlePickers(tasks).filter((p) => p.says.some((r) => r.test(word)));
  return hit.length === 1 ? hit[0]?.task : undefined;
}

/** The words that pick one of several same-titled tasks: "#17", "the done one", "older". */
export function pickWord(rest: string): string {
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

/**
 * L4-selftasks-117: the task a change names, as it is now (`CommandDef.subjects`): a read-back
 * keeps it, and its Yes is compared with the task then (`changedSince`).
 */
async function taskSubjects(
  params: { task: string; project?: string | undefined },
  ctx: CommandContext,
): Promise<CardSubject[]> {
  return [taskSubject(await findTask(params, ctx))];
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
  // "Write the guide, the done one"), the words the refusal below gives; any kind of word that
  // tells them apart picks one, so a refusal's word still works once they change (L3-run-6).
  const said = sameTitle(params.task);
  const titled = tasks.filter(
    (t) => said.startsWith(sameTitle(t.title)) && said.length > sameTitle(t.title).length,
  );
  const longest = Math.max(0, ...titled.map((t) => sameTitle(t.title).length));
  const group = titled.filter((t) => sameTitle(t.title).length === longest);
  if (group.length > 1) {
    const picked = pickSameTitled(group, pickWord(said.slice(longest)));
    if (picked) return picked;
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
    // L4-selftasks-120: the person's note is theirs; one the chat's model passed is the agent's.
    ...(personsNote(ctx)
      ? { author_human: ctx.actor.id }
      : { author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : (ctx.agentId ?? null) }),
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
  params: { task: string; project?: string | undefined; note?: string | undefined },
  option: string,
): Promise<{
  name: "request.answer";
  params: { request: string; answer: string; note?: string };
} | null> {
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
    // fixup-l4-selftasks-carried (the review of L4-selftasks-120): the note the move carried
    // goes with an option that takes one (Try again), read back so the Yes covers it, and
    // reaches the task's next brief as the Inbox's Try again with a note does. Before, the
    // redirect dropped it unsaid.
    const note = choice?.input === "note" ? params.note?.trim() : undefined;
    if (choice)
      return {
        name: "request.answer",
        params: { request: r.id, answer: choice.label, ...(note ? { note } : {}) },
      };
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
      // L3-github-10: a pull request that stays open is named, with what to do about it.
      kind ? cancelWorkLine(kind, prNumberOfUrl(task.pr_url)) : null,
      stuck ? `${stuck === 1 ? "1 task" : `${stuck} tasks`} waiting on it will be stuck.` : null,
    ];
    return `Cancel ${t}? ${parts.filter(Boolean).join(" ")}`;
  }
  if (to === "needs_human")
    return RUNNING.includes(from)
      ? `Stop ${t}? Its run stops now and it is paused; the session goes on with the rest.`
      : `Pause ${t}? No session runs it until you press Resume.`;
  if (to === "ready" && from === "draft") return `Make ${t} ready?`;
  if (to === "ready" && from === "failed") return `Try ${t} again? It is ready again.`;
  if (to === "ready" && from === "cancelled") return `Reopen ${t}? It is ready again.`;
  if (to === "ready" && from === "done") return `Redo ${t}?`;
  if (to === "ready") return `Resume ${t}? It is ready again.`;
  return `Mark ${t} ${statusWords(to)}?`;
}

/** What Undo of such a cancel says when the same files changed since (L-6). */
export const UNDO_CONFLICT_WORDS =
  "What it changed could not be put back: the same files changed since. Its next run does the work again.";

/** What a person's move did, in one line (design §5): the task by name, no raw state. */
export function moveSentence(
  task: Pick<TaskRow, "title"> & Partial<Pick<TaskRow, "pr_url">>,
  from: TaskStatus,
  to: TaskStatus,
  extra: {
    withdrawn?: number;
    noted?: boolean;
    /** L4-selftasks-120: whose note it is ("Your note" only for the person's own). */
    notedByAgent?: boolean;
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
    s = `Cancelled ${t}: ${cancelledWorkWords(extra.work, extra.kept, prNumberOfUrl(task.pr_url))}`;
  else if (to === "cancelled") s = `Cancelled ${t}.`;
  else if (to === "needs_human")
    s = RUNNING.includes(from)
      ? `Stopped ${t}: its run ended and it is paused until you press Resume.`
      : `Paused ${t}: no session runs it until you press Resume.`;
  else if (to === "ready" && from === "draft") s = `${t} is ready.`;
  else if (to === "ready" && from === "failed") s = `${t} is ready to try again.`;
  else if (to === "ready" && from === "cancelled") s = `Reopened ${t}: it is ready again.`;
  else if (to === "ready" && (from === "done" || extra.redo))
    s = `Reopened ${t} to redo it${extra.fromMain ? " from main" : ""}.`;
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
  if (extra.noted) {
    const whose = extra.notedByAgent ? "The note" : "Your note";
    s +=
      to === "cancelled"
        ? ` ${whose} goes into its brief if you reopen it.`
        : ` ${whose} goes into its next brief.`;
  }
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
      notedByAgent: !personsNote(ctx),
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
  /**
   * d1109-selftasks-run (ADR 0119): the tasks (ids or titles of this project) that wait for the
   * new one: a step added before them ("Added "Check the links" before "Publish"."). Each of them
   * must be a draft or ready; the new task may not also wait for one of them.
   */
  before: z.array(z.string()).default([]),
  /** The agent's one-sentence why, kept with the change (ADR 0119); never shown as an id. */
  why: z.string().trim().max(300).optional(),
});
export type TaskCreateParams = z.infer<typeof createParams>;

/**
 * l4-selftasks-carried (L4-other-1 D-6; ADR 0109 decision 1 covers New task, Edit and chat): a
 * task for a specialist that writes no file is read back, and told, with the line New task and
 * Edit show ("The reviewer writes no file, so review.md is not written: ..."), naming a file the
 * task's words ask for. Empty for every other specialist, or without the port.
 */
function noFileClause(
  ctx: CommandContext,
  specialist: string | null | undefined,
  words: readonly string[],
): string {
  if (!specialist || specialist === PERSON_SPECIALIST) return "";
  if (ctx.ports.modelSettings?.writesNoFile?.(specialist) !== true) return "";
  return ` ${writesNoFileLine(specialist, fileTheWordsWrite(words))}`;
}

/**
 * l4-selftasks-carried (L4-other-1 D-6): the line for an edit that gives a task to a specialist
 * that writes no file, or changes such a task's words; empty for any other edit (a priority).
 */
function editNoFile(
  ctx: CommandContext,
  patch: { specialist?: string | null; outcome?: string; acceptance_criteria?: string[] },
  task: Pick<TaskRow, "specialist" | "outcome" | "acceptance_criteria">,
): string {
  if (
    patch.specialist === undefined &&
    patch.outcome === undefined &&
    patch.acceptance_criteria === undefined
  )
    return "";
  return noFileClause(ctx, patch.specialist !== undefined ? patch.specialist : task.specialist, [
    patch.outcome ?? task.outcome,
    ...(patch.acceptance_criteria ?? task.acceptance_criteria ?? []),
  ]);
}

function createSentence(
  p: TaskCreateParams,
  projectName: string,
  before?: readonly string[],
): string {
  // d1109-selftasks-run: a step added before other tasks says where it goes.
  if (before?.length) return `Added ${quote(p.title)} before ${namesList(before)}.`;
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
    "Add a task to a project, ready unless a draft is asked for (it joins the running session if it fits, else waits for the person's next Start): title, outcome, acceptance criteria, priority (low, medium or high; medium when not said), the tasks it waits for (titles), its review level (1 light review, the default; 2 full review: needs Docker; 3 full review and the person's sign-off) and who does it (a specialist, or 'person' for a question only the person can answer).",
  params: createParams,
  risk: "low",
  scope: "project",
  reversible: true,
  undoStrategy: "cancel the created task",
  async plan(params, ctx) {
    const { project, usedActive } = await resolveProject(ctx, params.project);
    const count = await ctx.store.task.count({ project_id: project.id });
    const beforeTitles = (await stepBefore(ctx, project, params)).map((t) => t.title);
    const noFile = noFileClause(ctx, params.specialist, [
      params.outcome,
      ...params.acceptance_criteria,
    ]);
    return buildCard({
      command: "task.create",
      what: `the tasks of ${project.name}`,
      oldValue: `${count} task${count === 1 ? "" : "s"}`,
      newValue: `+ ${quote(params.title)}`,
      scope: "project",
      risk: "low",
      sentence: `${createSentence(params, project.name, beforeTitles)}${noFile}`,
      // The one-line read-back when it waits for a yes (d1109-chat-guard: after a record).
      ask: `${
        beforeTitles.length
          ? `Add ${quote(params.title)} before ${namesList(beforeTitles)}?`
          : `Add ${quote(params.title)} to ${project.name}?`
      }${noFile}`,
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
    // d1109-selftasks-run: the tasks it comes before, checked before anything is written.
    const comesBefore = await stepBefore(ctx, project, params, dependsOn);
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
          : // d1109-selftasks-chat (SC-12): who made it, in words; never an id or the channel.
            agentReason("Added", params.why),
      ...authorOf(ctx),
    });
    // Each task it comes before waits for it too (what it waited for before is kept for Undo).
    const waitedBefore: JsonObject[] = [];
    for (const next of comesBefore) {
      await ctx.store.task.setDependencies(
        next.id,
        next.version,
        [...next.depends_on, task.id],
        `waits for ${quote(task.title)}, added before it`,
        actorOf(ctx),
      );
      waitedBefore.push({ task_id: next.id, title: next.title, depends_on: next.depends_on });
    }
    const created: CommandOutcome = {
      before: { task_id: null, project_id: project.id },
      after: {
        task_id: task.id,
        project_id: project.id,
        status: task.status,
        title: task.title,
        ...(waitedBefore.length ? { before_tasks: waitedBefore } : {}),
      },
      // l4-selftasks-carried (L4-other-1 D-6): a task made at once says the line too (the
      // done sentence is this one, not the card's).
      sentence: `${createSentence(
        params,
        project.name,
        comesBefore.map((t) => t.title),
      )}${noFileClause(ctx, params.specialist, [params.outcome, ...params.acceptance_criteria])}`,
      projectId: project.id,
    };
    // S-9: a task made ready (Make this a task too, ADR 0093) is prepared and its line says so.
    return task.status === "ready" ? withNextLine(ctx, created, task) : created;
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
  undoSentence: (params, _before, after) => {
    // d1109-selftasks-run: the step's Undo also says the tasks after it wait as before.
    const next = beforeTasksOf(after).map((t) => t.title);
    return next.length
      ? `Undone: cancelled ${quote(params.title)}; ${namesList(next)} ${next.length === 1 ? "waits" : "wait"} for what ${next.length === 1 ? "it" : "they"} waited for before.`
      : `Undone: cancelled the task ${quote(params.title)} you created.`;
  },
  async undo(params, _before, after, ctx) {
    const task = await createdTask(after, ctx);
    if (!task || !canTransition(TASK_TRANSITIONS, task.status, "cancelled")) {
      // Never "Undone" when nothing changed (U-061); `undoBlocked` says why in words first.
      throw new ForerunnerError(
        "validation",
        `the task ${quote(params.title)} cannot be cancelled any more, so its creation cannot be undone`,
      );
    }
    // d1109-selftasks-run: the tasks it came before stop waiting for it first (a cancelled task
    // is no dependency), keeping whatever else they wait for now.
    for (const next of beforeTasksOf(after)) {
      const row = await ctx.store.task.get(next.task_id);
      if (!row || !row.depends_on.includes(task.id)) continue;
      await ctx.store.task.setDependencies(
        row.id,
        row.version,
        row.depends_on.filter((d) => d !== task.id),
        "undo of a step added before it",
        actorOf(ctx),
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

/** The tasks a created step came before (`after.before_tasks`), as recorded. */
function beforeTasksOf(after: JsonValue): { task_id: string; title: string }[] {
  const list = asObject(after).before_tasks;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => asObject(x))
    .filter((x) => typeof x.task_id === "string")
    .map((x) => ({
      task_id: String(x.task_id),
      title: typeof x.title === "string" ? x.title : "",
    }));
}

/** The tasks a project's task waits for, directly or through others (the cycle check). */
async function waitsOnAll(
  ctx: CommandContext,
  projectId: string,
  start: readonly string[],
): Promise<Set<string>> {
  const all = await ctx.store.task.forProject(projectId, {}, { limit: 10_000 });
  const depsOf = new Map(all.map((t) => [t.id, t.depends_on]));
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(depsOf.get(id) ?? []));
  }
  return seen;
}

/**
 * d1109-selftasks-run (ADR 0119): the tasks a new step comes before (`task.create`'s `before`),
 * each a draft or ready task of the project; refused in words when one is not, or when the new
 * task would also wait for one of them (a cycle). `dependsOn`: what the new task waits for.
 */
async function stepBefore(
  ctx: CommandContext,
  project: { id: string; name: string },
  params: Pick<TaskCreateParams, "before" | "title" | "depends_on">,
  dependsOn?: readonly string[],
): Promise<TaskRow[]> {
  if (!params.before.length) return [];
  const out: TaskRow[] = [];
  for (const named of params.before) {
    const next = await findTask({ task: named, project: project.id }, ctx);
    if (next.project_id !== project.id)
      throw new ForerunnerError(
        "validation",
        `${quote(next.title)} is not a task of ${project.name}. Nothing was added.`,
        { details: { reason: "other_project" } },
      );
    if (next.status !== "draft" && next.status !== "ready")
      throw new ForerunnerError(
        "validation",
        `${quote(next.title)} is ${statusWords(next.status)}, so nothing is added before it.`,
        { details: { taskId: next.id, status: next.status, reason: "not_offered" } },
      );
    if (!out.some((t) => t.id === next.id)) out.push(next);
  }
  const waits = await waitsOnAll(
    ctx,
    project.id,
    dependsOn ?? (await resolveDependencies(ctx, project.id, params.depends_on)),
  );
  const looped = out.find((t) => waits.has(t.id));
  if (looped)
    throw new ForerunnerError(
      "validation",
      `${quote(params.title)} cannot both wait for ${quote(looped.title)} and come before it. Nothing was added.`,
      { details: { reason: "cycle" } },
    );
  return out;
}

// --- task.transition -------------------------------------------------------------------------

const transitionParams = z
  .object({
    ...taskRef,
    to: z.enum(TASK_STATUSES),
    reason: z.string().default(""),
    note: noteParam,
    /**
     * d1109-selftasks-run (ADR 0119): with `to: cancelled`, the task (id or title of this project)
     * this one is the same as: a duplicate dropped. Only a task that never ran is dropped so (low
     * risk); the tasks that waited for it wait for that task instead.
     */
    duplicate_of: z.string().trim().min(1).max(200).optional(),
  })
  .refine((p) => p.duplicate_of === undefined || p.to === "cancelled", {
    message: "duplicate_of drops a task: it goes with to: cancelled",
  });
export type TaskTransitionParams = z.infer<typeof transitionParams>;

/** Whether a task has never run: a draft or ready task with no try and no run (ADR 0119). */
async function neverRan(ctx: CommandContext, task: TaskRow): Promise<boolean> {
  if (task.status !== "draft" && task.status !== "ready") return false;
  if (task.attempt > 0) return false;
  const runs = await ctx.store.run.list({ task_id: task.id } as never, { limit: 1 });
  return runs.length === 0;
}

/**
 * d1109-selftasks-run (ADR 0119): the task a duplicate is dropped for, checked in words: the
 * dropped task never ran, the named one is another task of the same project that is not
 * cancelled.
 */
async function duplicateOf(ctx: CommandContext, task: TaskRow, named: string): Promise<TaskRow> {
  const project = await ctx.store.project.mustGet(task.project_id);
  if (!(await neverRan(ctx, task)))
    throw new ForerunnerError(
      "validation",
      `${quote(task.title)} has run, so it is not dropped as a duplicate.`,
      { details: { taskId: task.id, reason: "ran" } },
    );
  const same = await findTask({ task: named, project: project.id }, ctx);
  const notDropped = `so ${quote(task.title)} is not dropped as the same.`;
  if (same.project_id !== project.id)
    throw new ForerunnerError(
      "validation",
      `${quote(same.title)} is not a task of ${project.name}, ${notDropped}`,
      { details: { reason: "other_project" } },
    );
  if (same.id === task.id)
    throw new ForerunnerError("validation", `A task is not the same as itself; nothing changed.`, {
      details: { reason: "self" },
    });
  if (same.status === "cancelled")
    throw new ForerunnerError("validation", `${quote(same.title)} is cancelled, ${notDropped}`, {
      details: { reason: "cancelled" },
    });
  return same;
}

/** The sentence of a dropped duplicate (ADR 0119). */
export function droppedSentence(title: string, same: string): string {
  return `Dropped ${quote(title)}: same as ${quote(same)}.`;
}

/** The reason a person's move leaves on the row when none was given. */
/**
 * d1109-selftasks-chat (SC-12, ADR 0119): a change the project's agent made says so where it is
 * stored ("Added by the agent: nothing checks the links"); before, "created by agent <id> via
 * session" put an id and a channel in the row's reason.
 */
function agentReason(verb: string, why: string | undefined): string {
  const said = why
    ?.trim()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "");
  if (!said) return `${verb} by the agent`;
  // "Nothing checks …" reads "nothing checks …" after the colon; "README is missing", "CSS …"
  // and "I …" keep their capitals.
  const lower = /^[A-Z][a-z]/.test(said) ? `${said.charAt(0).toLowerCase()}${said.slice(1)}` : said;
  return `${verb} by the agent: ${lower}`;
}

/** A move the agent made, in words (never an id or the channel). */
function movedByAgent(from: TaskStatus, to: TaskStatus): string {
  if (to === "needs_human")
    return RUNNING.includes(from) ? "Stopped by the agent" : "Paused by the agent";
  if (to === "cancelled") return "Cancelled by the agent";
  if (to === "ready" && from === "draft") return "Made ready by the agent";
  if (to === "ready") return "Made ready again by the agent";
  return `Marked ${statusWords(to)} by the agent`;
}

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
  subjects: taskSubjects,
  description:
    "Move a task along its workflow: ready (make ready, try again; it joins the running session if it fits, else waits for the person's next Start), needs_human (pause), cancelled; agents also use in_progress, in_review, done and failed. Prefer task.pause, task.resume and task.reopen for those moves.",
  params: transitionParams,
  async risk(params, ctx) {
    // d1109-selftasks-run: a duplicate that never ran is dropped at low risk (its Undo brings it
    // back as it was); any other cancel or close is medium, as before.
    if (params.duplicate_of) {
      const task = await findTask(params, ctx).catch(() => null);
      return task && (await neverRan(ctx, task)) ? "low" : "medium";
    }
    return params.to === "cancelled" || params.to === "done" ? "medium" : "low";
  },
  maxRisk: "medium",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the task back to the status it had",
  async redirect(params, ctx) {
    // A duplicate dropped is no card's answer: it names the task it is the same as.
    if (params.duplicate_of) return null;
    const option = cardOptionFor(params.to);
    // A person's note goes with the move; a card's answer has no room for it: as said.
    // l4-selftasks-carried (L4-selftasks-120): only the person's own note does; one the chat's
    // model wrote no longer keeps the move off the card.
    return option && !ownNote(ctx, params.note) ? moveAsCardAnswer(ctx, params, option) : null;
  },
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertMove(task, params.to);
    const project = await ctx.store.project.mustGet(task.project_id);
    if (params.duplicate_of) {
      const same = await duplicateOf(ctx, task, params.duplicate_of);
      return buildCard({
        command: "task.transition",
        what: `the task ${quote(task.title)}`,
        oldValue: statusWords(task.status),
        newValue: statusWords("cancelled"),
        scope: "project",
        risk: "low",
        sentence: droppedSentence(task.title, same.title),
        reversible: true,
        projectId: project.id,
        projectName: project.name,
        usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
        ask: `Drop ${quote(task.title)} as the same as ${quote(same.title)}?`,
      });
    }
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
    if (params.duplicate_of) return dropDuplicate(ctx, task, params);
    const moved = await personMove(ctx, task, params.to, {
      reason:
        params.reason ||
        params.note?.trim() ||
        (ctx.actor.kind === "human"
          ? movedByYou(task.status, params.to)
          : movedByAgent(task.status, params.to)),
      note: params.note,
    });
    return params.to === "ready" ? withNextLine(ctx, moved, task) : moved;
  },
  undoBlocked: (_params, before, after, ctx) => moveUndoBlocked(before, after, ctx),
  undoSentence: (_params, before, after) => undoMoveSentence(before, after),
  async undo(_params, before, after, ctx) {
    const said = await undoMove(before, after, ctx);
    // d1109-selftasks-run: the tasks that waited for a dropped duplicate wait for it again (it is
    // back first: a cancelled task is no dependency).
    await restoreRepointed(ctx, after);
    return said;
  },
};

/**
 * d1109-selftasks-run (ADR 0119): drop a duplicate that never ran. It is cancelled with the
 * reason that names the task it is the same as, and every task that waited for it waits for that
 * task instead (what each waited for before is kept for Undo).
 */
async function dropDuplicate(
  ctx: CommandContext,
  task: TaskRow,
  params: TaskTransitionParams,
): Promise<CommandOutcome> {
  const same = await duplicateOf(ctx, task, params.duplicate_of as string);
  const waiting = (await waitingOn(ctx, task)).filter((t) => t.id !== same.id);
  // A task that waits for the dropped one and that the kept one waits for would close a cycle.
  const keptWaits = await waitsOnAll(ctx, task.project_id, [same.id]);
  const looped = waiting.find((t) => keptWaits.has(t.id));
  if (looped)
    throw new ForerunnerError(
      "validation",
      `${quote(looped.title)} waits for ${quote(task.title)} and ${quote(same.title)} waits for it, so ${quote(task.title)} is not dropped as the same.`,
      { details: { reason: "cycle" } },
    );
  const by = ctx.actor.kind === "agent" ? "the agent" : "you";
  const moved = await personMove(ctx, task, "cancelled", {
    reason: `Dropped by ${by}: same as ${quote(same.title)}`,
    note: params.note,
  });
  const repointed: JsonObject[] = [];
  for (const w of waiting) {
    const row = await ctx.store.task.get(w.id);
    if (!row || !row.depends_on.includes(task.id)) continue;
    const next = [...new Set(row.depends_on.map((d) => (d === task.id ? same.id : d)))];
    await ctx.store.task.setDependencies(
      row.id,
      row.version,
      next,
      `waits for ${quote(same.title)}: ${quote(task.title)} was the same`,
      actorOf(ctx),
    );
    repointed.push({ task_id: row.id, depends_on: row.depends_on });
  }
  return {
    ...moved,
    after: {
      ...asObject(moved.after),
      duplicate_of: same.id,
      ...(repointed.length ? { repointed } : {}),
    },
    sentence: droppedSentence(task.title, same.title),
  };
}

/** The undo's half of `dropDuplicate`: what each waiting task waited for before. */
async function restoreRepointed(ctx: CommandContext, after: JsonValue): Promise<void> {
  const list = asObject(after).repointed;
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const r = asObject(item);
    if (typeof r.task_id !== "string" || !Array.isArray(r.depends_on)) continue;
    const row = await ctx.store.task.get(r.task_id);
    if (!row) continue;
    await ctx.store.task.setDependencies(
      row.id,
      row.version,
      r.depends_on.filter((d): d is string => typeof d === "string"),
      "undo of a dropped duplicate",
      actorOf(ctx),
    );
  }
}

// --- task.pause, task.resume -----------------------------------------------------------------

const pauseParams = z.object({ ...taskRef, note: noteParam });
export type TaskPauseParams = z.infer<typeof pauseParams>;

export const taskPause: CommandDef<TaskPauseParams> = {
  name: "task.pause",
  subjects: taskSubjects,
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
  subjects: taskSubjects,
  description:
    "Resume a paused task, or let a task that waits for the person's answers go ahead without them: it is ready again and joins the running session if it fits, else waits for the person's next Start. Its open Inbox cards are withdrawn.",
  params: resumeParams,
  risk: "low",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "pause the task again",
  async redirect(params, ctx) {
    // l4-selftasks-carried (L4-selftasks-120): the person's own note keeps the resume (a card's
    // answer has no room for it); one the chat's model wrote does not.
    if (ownNote(ctx, params.note)) return null;
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
    const moved = await personMove(ctx, task, "ready", {
      reason: params.without_answers
        ? "Go ahead without the answers: asked by you"
        : "Resumed by you",
      note: params.note,
      withoutAnswers: params.without_answers,
    });
    return withNextLine(ctx, moved, task);
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
  subjects: taskSubjects,
  description:
    "Reopen a cancelled task (Reopen), or a done task to redo it (Redo): it is ready again and joins the running session if it fits, else waits for the person's next Start; the person's note says what to fix and goes into its brief.",
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
    return withNextLine(ctx, moved, task);
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
    sentence: moveSentence(task, task.status, to, {
      noted: !!params.note?.trim(),
      notedByAgent: !personsNote(ctx),
    }),
    reversible: true,
    projectId: project.id,
    projectName: project.name,
    usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
    // L4-selftasks-120: a note the model passed is read back, so the yes covers it.
    ask: await withPreview(
      ctx,
      `${moveAsk(task, task.status, to)}${noteClause(ctx, params.note)}`,
      task,
      to,
    ),
  });
}

/**
 * d1109-starts-engine (S-9, ADR 0118 amending 0102 point 2): a move that makes a task ready
 * prepares it (it joins the project's running session if it fits, else it waits for the
 * person's next Start) and its line says so, after the move's own sentence.
 */
async function withNextLine(
  ctx: CommandContext,
  outcome: CommandOutcome,
  task: Pick<TaskRow, "id" | "project_id">,
): Promise<CommandOutcome> {
  if (!ctx.ports.prepareWork) return outcome;
  const line = await ctx.ports
    .prepareWork({
      projectId: task.project_id,
      taskIds: [task.id],
      by: ctx.actor.kind === "agent" ? "agent" : "person",
    })
    .catch(() => null);
  return line ? { ...outcome, sentence: `${outcome.sentence} ${afterMove(line)}` } : outcome;
}

/**
 * The prepared line after a move's own sentence, which already says the task is ready: "It runs
 * at your next Start.", not "... is ready again. Ready: it runs at your next Start.".
 */
function afterMove(line: string): string {
  return line.replace(/^Ready: (\S)/, (_m, c: string) => c.toUpperCase());
}

/** The read-back of such a move with what would happen next, read-only (S-9). */
async function withPreview(
  ctx: CommandContext,
  ask: string,
  task: Pick<TaskRow, "project_id">,
  to: TaskStatus,
): Promise<string> {
  if (to !== "ready" || !ctx.ports.previewWork) return ask;
  const line = await ctx.ports
    .previewWork({
      projectId: task.project_id,
      by: ctx.actor.kind === "agent" ? "agent" : "person",
    })
    .catch(() => null);
  return line ? `${ask} ${afterMove(line)}` : ask;
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
  subjects: taskSubjects,
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
    // l4-selftasks-carried (L4-other-1 D-6): an edit that gives the task to a specialist that
    // writes no file, or changes such a task's words, says what New task and Edit say.
    const noFile = editNoFile(ctx, patch, task);
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
      ask: `Change ${quote(task.title)}: ${(await editWords(ctx, patch)) || "nothing"}?${noFile}${noteClause(ctx, params.note)}`,
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
    // S-8 (ADR 0118): edits apply before a task starts and never during its run (a change mid-run
    // would mix two briefs): the fields stay as they are, and the note it carries is kept for the
    // task's next attempt. Before, the refusal dropped the note.
    if (fields.length > 0 && RUNNING.includes(task.status)) {
      const kept = await queueNote(ctx, task, params.note);
      throw new ForerunnerError(
        "validation",
        `${quote(task.title)} is running now: it is not changed mid-run${kept ? "; your note goes into its next attempt" : ""}.`,
        { details: { taskId: task.id, reason: "running", ...(kept ? { noteId: kept } : {}) } },
      );
    }
    const words = await editWords(ctx, patch);
    const updated = fields.length
      ? await ctx.store.task.edit(
          task.id,
          task.version,
          patch,
          params.note?.trim() ||
            (ctx.actor.kind === "agent"
              ? `Changed by the agent: ${words}`
              : `Changed by you: ${words}`),
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
      sentence: `${fields.length ? `Changed ${quote(task.title)}: ${words}.${editNoFile(ctx, patch, task)}` : `Noted for ${quote(task.title)}.`}${
        noteId ? noteGoes(ctx) : ""
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
 * When a task that still waits runs (l4-chat-depth, L4-chat-207; ADR 0118 point 3: a chat change
 * says what happens next): after the tasks it waits for that are not done, then when, read from
 * the prepared line (read-only). "It runs after it is done, at your next Start." when every task
 * named in the sentence before is undone; else the undone ones by name, at most 100 characters.
 */
function afterDependenciesLine(
  preview: string | null,
  undone: readonly string[],
  named: readonly string[],
): string {
  const when = !preview
    ? "at your next Start"
    : /once you allow them again/.test(preview)
      ? "at your next Start once you allow sessions again"
      : /^Ready: it joins this session/.test(preview)
        ? "in this session if budget is left, else your next Start"
        : /^Ready: it joins your session when it goes on/.test(preview)
          ? "in your session when it goes on, if it fits, else your next Start"
          : /quiet hours/.test(preview)
            ? "once your quiet hours are over"
            : "at your next Start";
  const all = undone.length === named.length;
  const one = undone.length === 1;
  const who = all ? (one ? "it is" : "they are") : `${namesList(undone)} ${one ? "is" : "are"}`;
  const line = `It runs after ${who} done, ${when}.`;
  return line.length <= 100 ? line : `It runs after the tasks it waits for are done, ${when}.`;
}

/**
 * The line after a dependency change (L4-chat-207): a ready task whose every dependency is done
 * is prepared (it joins a running session if it fits, else it waits for the next Start), as any
 * move that makes a task ready; one that still waits says after what and when. Other statuses
 * (a draft, a paused or a done task) run on nothing a dependency says: no line.
 */
async function dependenciesNextLine(
  ctx: CommandContext,
  task: TaskRow,
  outcome: CommandOutcome,
  wasRunnable: boolean,
): Promise<CommandOutcome> {
  if (task.status !== "ready") return outcome;
  const deps = await Promise.all(task.depends_on.map((id) => ctx.store.task.get(id)));
  const undone = deps.filter((d) => d && d.status !== "done").map((d) => d?.title ?? "");
  if (!undone.length) {
    if (!wasRunnable) return withNextLine(ctx, outcome, task);
    const preview = ctx.ports.previewWork
      ? await ctx.ports
          .previewWork({
            projectId: task.project_id,
            by: ctx.actor.kind === "agent" ? "agent" : "person",
          })
          .catch(() => null)
      : null;
    return preview
      ? { ...outcome, sentence: `${outcome.sentence} ${afterMove(preview)}` }
      : outcome;
  }
  const preview = ctx.ports.previewWork
    ? await ctx.ports
        .previewWork({
          projectId: task.project_id,
          by: ctx.actor.kind === "agent" ? "agent" : "person",
        })
        .catch(() => null)
    : null;
  const named = deps.filter(Boolean).map((d) => d?.title ?? "");
  return {
    ...outcome,
    sentence: `${outcome.sentence} ${afterDependenciesLine(preview, undone, named)}`,
  };
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
  subjects: taskSubjects,
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
      ask: `${await dependenciesAsk(ctx, task, params, titles)}${noteClause(ctx, params.note)}`,
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    const ids = await wantedDependencies(ctx, task, params);
    // Whether it could run before the change (L4-chat-207: only a change that makes it runnable
    // prepares it; one that leaves it runnable only says when it runs).
    const wasRunnable = (
      await Promise.all(task.depends_on.map((id) => ctx.store.task.get(id)))
    ).every((d) => !d || d.status === "done");
    const updated = await ctx.store.task.setDependencies(
      task.id,
      task.version,
      ids,
      params.reason ||
        params.note?.trim() ||
        (ctx.actor.kind === "agent"
          ? "What it waits for changed by the agent"
          : "What it waits for changed by you"),
      actorOf(ctx),
    );
    const noteId = await queueNote(ctx, task, params.note);
    // l4-chat-depth (L4-chat-207): the sentence says when the task runs; a change that made it
    // runnable prepares it (it joins a running session if it fits, ADR 0118 point 3).
    const said = await dependenciesNextLine(
      ctx,
      updated,
      {
        before: { task_id: task.id, title: task.title, depends_on: task.depends_on },
        after: {
          task_id: task.id,
          title: task.title,
          depends_on: updated.depends_on,
          ...(noteId ? { note_id: noteId } : {}),
        },
        sentence: dependenciesSentence(task.title, await titlesOf(ctx, updated.depends_on)),
        projectId: task.project_id,
        reversible: true,
      },
      wasRunnable,
    );
    return {
      ...said,
      sentence: `${said.sentence}${noteId ? noteGoes(ctx) : ""}`,
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

// --- task.split (d1109-selftasks-run, ADR 0119) ----------------------------------------------

const splitPart = z.object({
  title: z.string().trim().min(3).max(200),
  /** Absent on the first part: the task keeps its own; absent on a new part: none. */
  outcome: z.string().trim().max(2000).optional(),
  acceptance_criteria: z.array(z.string()).default([]),
  /** Absent: the task's own specialist (the fence asks before a part reaches further). */
  specialist: z.string().trim().min(1).max(80).optional(),
});

const splitParams = z.object({
  ...taskRef,
  /**
   * The parts, two to four: the first is the task itself (its id, folder, branch and earlier
   * work carry on with it), the rest are new tasks. Every acceptance criterion of the task goes
   * word for word into one of them.
   */
  parts: z.array(splitPart).min(1).max(8),
  /** `in_turn`: each part waits for the one before; `side_by_side`: they run apart. */
  order: z.enum(["in_turn", "side_by_side"]).default("in_turn"),
  /** The agent's one-sentence why, kept with the change; never shown as an id. */
  why: z.string().trim().max(300).optional(),
});
export type TaskSplitParams = z.infer<typeof splitParams>;

/** The fields a split changes on the task it keeps as its first part (and its Undo restores). */
const SPLIT_FIELDS = [
  "title",
  "outcome",
  "acceptance_criteria",
  "budget_usd_micro",
  "est_cost_usd_micro",
  "specialist",
] as const;

/** 'Split "Style the page" into "Style the layout" and "Style the colours".' */
export function splitSentence(title: string, parts: readonly string[]): string {
  return `Split ${quote(title)} into ${namesList(parts)}.`;
}

/**
 * Why a task cannot be split as asked, in words (ADR 0119): only a draft or ready task; two to
 * four parts; every criterion of the task word for word in a part.
 */
function assertSplit(task: TaskRow, params: TaskSplitParams): void {
  if (task.status !== "draft" && task.status !== "ready")
    throw new ForerunnerError(
      "validation",
      `${quote(task.title)} is ${statusWords(task.status)}, so it is not split.`,
      { details: { taskId: task.id, status: task.status, reason: "not_offered" } },
    );
  if (params.parts.length < 2 || params.parts.length > 4)
    throw new ForerunnerError(
      "validation",
      `A split makes two to four parts of ${quote(task.title)}; nothing was split.`,
      { details: { taskId: task.id, reason: "parts" } },
    );
  const carried = new Set(params.parts.flatMap((p) => p.acceptance_criteria.map((c) => c.trim())));
  const left = task.acceptance_criteria.filter((c) => !carried.has(c.trim()));
  if (left.length)
    throw new ForerunnerError(
      "validation",
      `The parts leave out ${left.length === 1 ? "a criterion" : "criteria"} of ${quote(task.title)}: ${namesList(left)}. Nothing was split.`,
      { details: { taskId: task.id, reason: "criteria", left } },
    );
}

/**
 * Shares of a whole for the parts, by their criteria (at least one each), the remainder on the
 * first part so they add up exactly: a task's budget and estimate are shared, never raised.
 */
function shares(whole: number, parts: readonly { acceptance_criteria: string[] }[]): number[] {
  const weights = parts.map((p) => Math.max(1, p.acceptance_criteria.length));
  const total = weights.reduce((s, x) => s + x, 0);
  const out = weights.map((w) => Math.floor((whole * w) / total));
  out[0] = (out[0] ?? 0) + (whole - out.reduce((s, x) => s + x, 0));
  return out;
}

export const taskSplit: CommandDef<TaskSplitParams> = {
  name: "task.split",
  subjects: taskSubjects,
  description:
    "Split a draft or ready task that is two or more jobs: the task stays as its first part (its folder, branch and earlier work carry on) and one to three new tasks hold the rest; every acceptance criterion goes word for word into one part; the parts wait for each other in turn or run side by side; the tasks that waited for it wait for all its parts; its own budget is shared, never raised.",
  params: splitParams,
  risk: "low",
  // d1109-selftasks-chat: the person's own split in chat, read back first (askFromChat).
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy: "put the task back as it was and cancel the new parts",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    assertSplit(task, params);
    const project = await ctx.store.project.mustGet(task.project_id);
    const titles = params.parts.map((p) => p.title);
    return buildCard({
      command: "task.split",
      what: `the task ${quote(task.title)}`,
      oldValue: "one task",
      newValue: `${params.parts.length} tasks`,
      scope: "project",
      risk: "low",
      sentence: splitSentence(task.title, titles),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
      ask: `Split ${quote(task.title)} into ${namesList(titles)}?`,
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    assertSplit(task, params);
    const [first, ...rest] = params.parts as [
      TaskSplitParams["parts"][number],
      ...TaskSplitParams["parts"],
    ];
    const by = ctx.actor.kind === "agent" ? "the agent" : "you";
    // The budget left (never raised) and the estimate, shared by the parts' criteria.
    const budgetLeft =
      task.budget_usd_micro > 0
        ? Math.max(0, task.budget_usd_micro - task.actual_cost_usd_micro)
        : 0;
    const budgets = shares(budgetLeft, params.parts);
    const estimates = shares(task.est_cost_usd_micro, params.parts);
    const waiting = await waitingOn(ctx, task);
    const titles = params.parts.map((p) => p.title);
    const reason = `Split into ${namesList(titles)} by ${by}`;
    const beforeFields = fieldsOf(task, SPLIT_FIELDS);
    let kept = await ctx.store.task.edit(
      task.id,
      task.version,
      {
        title: first.title,
        ...(first.outcome !== undefined ? { outcome: first.outcome } : {}),
        acceptance_criteria: first.acceptance_criteria.map((c) => c.trim()).filter(Boolean),
        ...(first.specialist !== undefined ? { specialist: first.specialist } : {}),
        ...(task.budget_usd_micro > 0
          ? { budget_usd_micro: task.actual_cost_usd_micro + (budgets[0] ?? 0) }
          : {}),
      },
      reason,
      actorOf(ctx),
    );
    kept = await ctx.store.task.update(kept.id, kept.version, {
      est_cost_usd_micro: estimates[0] ?? 0,
    });
    const made: TaskRow[] = [];
    for (const [i, part] of rest.entries()) {
      const specialist = part.specialist ?? task.specialist ?? null;
      const previous = made.at(-1)?.id ?? task.id;
      made.push(
        await ctx.store.task.insert({
          project_id: task.project_id,
          milestone_id: task.milestone_id,
          title: part.title,
          outcome: part.outcome ?? "",
          acceptance_criteria: part.acceptance_criteria.map((c) => c.trim()).filter(Boolean),
          // A part is reviewed as the task was, raised for a deploy or a migration (C-2).
          risk_tier: riskTierFor(specialist, task.risk_tier),
          status: task.status,
          priority: task.priority,
          depends_on: params.order === "in_turn" ? [previous] : [...task.depends_on],
          budget_usd_micro: budgets[i + 1] ?? 0,
          est_cost_usd_micro: estimates[i + 1] ?? 0,
          specialist,
          reason: `Split from ${quote(task.title)} by ${by}`,
          ...authorOf(ctx),
        }),
      );
    }
    // The tasks that waited for the task wait for all its parts.
    const waited: JsonObject[] = [];
    for (const w of waiting) {
      const row = await ctx.store.task.mustGet(w.id);
      await ctx.store.task.setDependencies(
        row.id,
        row.version,
        [...new Set([...row.depends_on, ...made.map((m) => m.id)])],
        `waits for every part of ${quote(task.title)}`,
        actorOf(ctx),
      );
      waited.push({ task_id: row.id, depends_on: row.depends_on });
    }
    return {
      before: { task_id: task.id, title: task.title, fields: beforeFields },
      after: {
        task_id: task.id,
        title: kept.title,
        fields: fieldsOf(kept, SPLIT_FIELDS),
        attempt: kept.attempt,
        // What each part waits for as the split made it (C4-left-6: its Undo checks it).
        parts: made.map((m) => ({
          task_id: m.id,
          title: m.title,
          attempt: m.attempt,
          depends_on: m.depends_on,
        })),
        ...(waited.length ? { waited } : {}),
      },
      sentence: splitSentence(task.title, titles),
      projectId: task.project_id,
      reversible: true,
    };
  },
  async undoBlocked(params, _before, after, ctx, change) {
    const a = asObject(after);
    if (typeof a.task_id !== "string") return "this change does not name the task it split";
    const task = await ctx.store.task.get(a.task_id);
    if (!task) return "the task no longer exists";
    for (const part of splitPartsOf(after)) {
      const row = await ctx.store.task.get(part.task_id);
      if (!row) continue;
      const moved = movedSinceSplit(row, part.attempt);
      if (moved) return moved;
    }
    const moved = movedSinceSplit(task, typeof a.attempt === "number" ? a.attempt : 0);
    if (moved) return moved;
    if (JSON.stringify(fieldsOf(task, SPLIT_FIELDS)) !== JSON.stringify(asObject(a.fields)))
      return `${quote(task.title)} was changed again since; undo would not put it back as it was`;
    // l4-chat-carried (C4-left-6, ADR 0030 point 6): the Undo puts back what the tasks after it
    // waited for and cancels the parts, so a wait added or taken away after the split (a step
    // before one of them) would be lost: refused in words, never done in part. The same change's
    // own steps (the task check's set) are no later change.
    return waitsChangedSinceSplit(params, after, ctx, sameChangeTasks(change));
  },
  undoSentence(_params, before) {
    const b = asObject(before);
    return `Undone: ${typeof b.title === "string" ? quote(b.title) : "the task"} is one task again.`;
  },
  async undo(_params, before, after, ctx) {
    const a = asObject(after);
    const parts = splitPartsOf(after).map((p) => p.task_id);
    // What waited for the task waits as before (no part is a dependency once cancelled).
    const waited = Array.isArray(a.waited) ? a.waited : [];
    for (const item of waited) {
      const w = asObject(item);
      if (typeof w.task_id !== "string" || !Array.isArray(w.depends_on)) continue;
      const row = await ctx.store.task.get(w.task_id);
      if (!row) continue;
      await ctx.store.task.setDependencies(
        row.id,
        row.version,
        w.depends_on.filter((d): d is string => typeof d === "string"),
        "undo of a split",
        actorOf(ctx),
      );
    }
    for (const id of parts) {
      const row = await ctx.store.task.get(id);
      if (!row || !canTransition(TASK_TRANSITIONS, row.status, "cancelled")) continue;
      await ctx.store.task.transition(
        row.id,
        row.version,
        "cancelled",
        "undo of a split",
        actorOf(ctx),
      );
    }
    const task = await ctx.store.task.mustGet(String(a.task_id));
    const fields = asObject(asObject(before).fields);
    const { est_cost_usd_micro: est, ...edit } = fields as Record<string, JsonValue>;
    const edited = await ctx.store.task.edit(
      task.id,
      task.version,
      edit as Parameters<typeof ctx.store.task.edit>[2],
      "undo of a split",
      actorOf(ctx),
    );
    if (typeof est === "number")
      await ctx.store.task.update(edited.id, edited.version, { est_cost_usd_micro: est });
  },
};

/** The new parts a split made (`after.parts`), with the try each had then. */
function splitPartsOf(
  after: JsonValue,
): { task_id: string; attempt: number; depends_on: string[] | null }[] {
  const list = asObject(after).parts;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => asObject(x))
    .filter((x) => typeof x.task_id === "string")
    .map((x) => ({
      task_id: String(x.task_id),
      attempt: typeof x.attempt === "number" ? x.attempt : 0,
      // Absent on a split recorded before l4-chat-carried.
      depends_on: Array.isArray(x.depends_on)
        ? x.depends_on.filter((d): d is string => typeof d === "string")
        : null,
    }));
}

/**
 * Why a part (or the task kept as the first part) keeps its split from being undone, in words
 * (L4-selftasks-129): a part a session took or works on is running now; one that ran, failed or
 * waits for the person has run since; a cancelled one was cancelled. Never "has run since" for a
 * part that has not started (before: any status but draft or ready read so).
 */
function movedSinceSplit(row: TaskRow, attempt: number): string | null {
  if ((row.status === "draft" || row.status === "ready") && row.attempt === attempt) return null;
  if (row.status === "claimed" || row.status === "in_progress" || row.status === "in_review")
    return `${quote(row.title)} is running now, so the split cannot be undone`;
  if (row.status === "cancelled")
    return `${quote(row.title)} was cancelled since, so the split cannot be undone`;
  return `${quote(row.title)} has run since, so the split cannot be undone`;
}

/** The tasks the other steps of the same change made (a step added with the split). */
function sameChangeTasks(change?: {
  steps: readonly { name: string; after: JsonValue }[];
}): Set<string> {
  const out = new Set<string>();
  for (const s of change?.steps ?? []) {
    const a = asObject(s.after);
    if (s.name === "task.create" && typeof a.task_id === "string") out.add(a.task_id);
  }
  return out;
}

/**
 * l4-chat-carried (C4-left-6): a wait added or taken away after the split, on a task that waited
 * for it or on one of its parts, in words naming the task and what came after ('"Publish" was made
 * to wait for "Check the links" after the split; undo would drop that'); null when every one
 * waits as the split left it (or as the same change's own steps left it).
 */
async function waitsChangedSinceSplit(
  params: TaskSplitParams,
  after: JsonValue,
  ctx: CommandContext,
  sameChange: ReadonlySet<string>,
): Promise<string | null> {
  const a = asObject(after);
  const parts = splitPartsOf(after);
  const partIds = parts.map((p) => p.task_id);
  const expected: { taskId: string; dependsOn: string[] }[] = [];
  for (const item of Array.isArray(a.waited) ? a.waited : []) {
    const w = asObject(item);
    if (typeof w.task_id !== "string" || !Array.isArray(w.depends_on)) continue;
    const before = w.depends_on.filter((d): d is string => typeof d === "string");
    expected.push({ taskId: w.task_id, dependsOn: [...new Set([...before, ...partIds])] });
  }
  for (const [i, part] of parts.entries()) {
    // A split recorded before the parts' waits were kept: in turn, each waited for the one before.
    const dependsOn =
      part.depends_on ??
      (params.order === "in_turn" ? [i === 0 ? String(a.task_id) : String(partIds[i - 1])] : null);
    if (dependsOn) expected.push({ taskId: part.task_id, dependsOn });
  }
  for (const e of expected) {
    const row = await ctx.store.task.get(e.taskId);
    if (!row || row.status === "cancelled") continue;
    const added = row.depends_on.filter((d) => !e.dependsOn.includes(d) && !sameChange.has(d));
    if (added.length) {
      const titles: string[] = [];
      for (const id of added) titles.push((await ctx.store.task.get(id))?.title ?? "another task");
      return `${quote(row.title)} was made to wait for ${namesList(titles)} after the split; undo would drop that`;
    }
    if (e.dependsOn.some((d) => !row.depends_on.includes(d)))
      return `what ${quote(row.title)} waits for was changed after the split; undo would not put it back as it was`;
  }
  return null;
}
