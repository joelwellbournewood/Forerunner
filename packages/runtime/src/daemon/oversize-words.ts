/**
 * Every sentence about a task larger than one session (d1109-oversize-start; the owner's D4 of
 * 2026-11-09: "it should get a warning, but it should get done anyway"), written from the facts
 * the Start check and the runner hold, so the Start dialog, the plan card, the chat's read-back,
 * the session's log and its result say it the same way (design §5: one sentence, CHF only,
 * "about" for estimates, task titles in quotes, no ids). The runner takes such a task in its turn
 * in the plan's order (priority, then the plan's order; d1109-oversize-pause, the owner's answer 5
 * of 2026-11-09: "it should work on tasks even when it cannot complete them, and be able to wrap
 * up and continue next time"), with what is left of the session's work budget (`cutPlanToBudget`,
 * `OVERSIZED_MIN_ROOM_SHARE`); the tasks after it get only what it leaves. It pauses at that
 * budget with its work kept and one card whose Continue goes on from it (ADR 0112 amended), and
 * the next Start takes it in its turn, which is what "keeps its work, and asks you to continue"
 * promises.
 *
 * No Node-only import: the UI's Start dialog takes `oversizedPlanClause` from here, and the
 * fake daemon every sentence. Amounts come formatted by the caller (billing's `formatChf`).
 */
import { aboutWords, moneyWords } from "../session/money-words.ts";

/** An amount as the sentences say it: CHF micro-units and their text ("CHF 4.00"). */
export interface ChfAmount {
  chfMicro: number;
  text: string;
}

const about = (a: ChfAmount) => aboutWords(a.text, a.chfMicro);
const plain = (a: ChfAmount) => moneyWords(a.text, a.chfMicro);
/** A task's title in quotes, on one line. */
const quoted = (title: string) => `"${title.replace(/\s+/g, " ").trim()}"`;

/**
 * Titles in quotes, at most `max` named, then "and N more": '"A"', '"A" and "B"', '"A", "B" and
 * "C"', '"A", "B", "C" and 2 more' (max 3); '"B" and 1 more' (max 1).
 */
function namedUpTo(titles: readonly string[], max: number): string {
  const q = titles.map(quoted);
  if (q.length > max) return `${q.slice(0, max).join(", ")} and ${q.length - max} more`;
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** What the sentences about the larger task the session takes are written from. */
export interface OversizedFacts {
  title: string;
  /** What it needs: its estimate, or what is left of it after its kept work (`spent`). */
  estimate: ChfAmount;
  /** The session's work budget (its cap less the fifth kept for reviews). */
  workBudget: ChfAmount;
  /**
   * What it works with after the tasks before it in the plan's order; null when nothing runs
   * before it (it then works until the work budget is used).
   */
  room: ChfAmount | null;
  /**
   * d1109-oversize-pause (OP-0): the tasks before it in the plan's order, by title; the sentence
   * names up to three ('after "A" it works with ...'). Without them it reads as first in order.
   */
  before?: readonly string[];
  /** What its kept work cost, when it resumes from it (OS-1). */
  spent?: ChfAmount | null;
}

/**
 * The warning before Start (the Start dialog's amber note, the Start check's `oversized`):
 * '"Build the shop" needs about CHF 6.00, more than this session's work budget of CHF 4.00: it
 * works until that budget is used, keeps its work, and asks you to continue.'; with tasks before
 * it in the plan's order (d1109-oversize-pause, OP-0): '...: after "A" it works with about CHF
 * 2.80, keeps its work, and asks you to continue.' (before: "after the other tasks", when it was
 * held until the work that fits was done).
 */
export function oversizedSentence(f: OversizedFacts): string {
  const needs = f.spent
    ? `${about(f.estimate)} more (${plain(f.spent)} spent so far)`
    : about(f.estimate);
  const before = f.before ?? [];
  const how =
    f.room && before.length > 0
      ? `after ${namedUpTo(before, 3)} it works with ${about(f.room)}, keeps its work, and asks you to continue`
      : "it works until that budget is used, keeps its work, and asks you to continue";
  return `${quoted(f.title)} needs ${needs}, more than this session's work budget of ${plain(f.workBudget)}: ${how}.`;
}

/**
 * Why a task is left out of a session for its budget (the runner's `LeftOutReason`): `after_large`
 * (d1109-oversize-pause, OP-0), it comes after a task larger than the work budget in the plan's
 * order and runs only if that task leaves budget; `no_room`, a task larger than the work budget
 * the tasks before it leave too little for; `after_others`, it fits the work budget but not after
 * the tasks before it.
 */
export type LeftOutWhy = "after_others" | "after_large" | "no_room";

/** What a left-out task's sentence is written from. */
export interface LeftOutFacts {
  title: string;
  estimate: ChfAmount;
  workBudget: ChfAmount;
  /** `after_others`: what the tasks that run first take of the work budget. */
  ahead?: ChfAmount | null;
  /** `after_large`: the title of the larger task it comes after. */
  after?: string | null;
}

/**
 * Why a task waits for the next session, one sentence (the Start dialog's lines, the Start
 * check's `overBudget[].sentence`, the session result's "Left for next time"):
 * - `no_room`: '"Build the shop" needs about CHF 6.00, more than this session's work budget:
 *   the tasks before it leave too little to start it, so it waits for the next session.'
 * - `after_large` (OP-0): '"B" comes after it: it runs if "Build the shop" leaves budget, else in
 *   your next session.' (`comesAfterSentence` for one task)
 * - `after_others` (the Start dialog's line of W15-38, now the daemon's): '"About page" (about
 *   CHF 2.40) may be left for next time: the tasks that run first take about CHF 2.40 of this
 *   session's work budget of CHF 4.00 (the budget less a fifth kept for reviews). Give the
 *   session a larger budget to be sure it runs.'
 *
 * Before (d1109-oversize-start): `one_large`, '"Big two" needs about CHF 9.00, more than this
 * session's work budget: one task that large runs a session, so it waits for the next one.'; a
 * second larger task now comes after the first (`after_large`).
 */
export function leftOutSentence(why: LeftOutWhy, f: LeftOutFacts): string {
  const t = quoted(f.title);
  if (why === "no_room")
    return `${t} needs ${about(f.estimate)}, more than this session's work budget: the tasks before it leave too little to start it, so it waits for the next session.`;
  if (why === "after_large" && f.after) return comesAfterSentence([f.title], f.after) as string;
  return `${t} (${about(f.estimate)}) may be left for next time: the tasks that run first take ${about(
    f.ahead ?? { chfMicro: 0, text: "CHF 0.00" },
  )} of this session's work budget of ${plain(f.workBudget)} (the budget less a fifth kept for reviews). Give the session a larger budget to be sure it runs.`;
}

/**
 * The tasks after the larger one in the plan's order, before the run (OP-0; the Start dialog's
 * amber note and chat's read-back after the warning), named once: '"B" comes after it: it runs if
 * "Build the shop" leaves budget, else in your next session.'; more: '"B" and 1 more come after
 * it: they run if "Build the shop" leaves budget, else in your next session.'. Null for none.
 */
export function comesAfterSentence(titles: readonly string[], larger: string): string | null {
  if (titles.length === 0) return null;
  const one = titles.length === 1;
  return `${namedUpTo(titles, 1)} ${one ? "comes" : "come"} after it: ${one ? "it runs" : "they run"} if ${quoted(larger)} leaves budget, else in your next session.`;
}

/**
 * The tasks after the larger one that did not run (OP-0; the result's "Left for next time"): '"B"
 * waits for your next session: "Build the shop" used the rest of this one.'; more: '"B" and 1
 * more wait for your next session: "Build the shop" used the rest of this one.'.
 */
export function waitsForNextSessionSentence(
  titles: readonly string[],
  larger: string,
  /**
   * l4-money-pause, run L4 (L4-money-102): what the larger task left of the session's work budget
   * and, for one task, its estimate: '"B" (about CHF 0.06) waits for your next session: "Compare
   * ..." left CHF 0.03 of this one.' (live check 4: "used the rest of this one" at CHF 0.23 of a
   * CHF 0.32 work budget). "used the rest" only when it left less than a centime.
   */
  room?: { left: ChfAmount; estimate?: ChfAmount },
): string {
  const one = titles.length === 1;
  const left = room && room.left.chfMicro >= 5_000 ? room.left : null;
  const est = one && left && room?.estimate ? ` (${about(room.estimate)})` : "";
  return `${namedUpTo(titles, 1)}${est} ${one ? "waits" : "wait"} for your next session: ${quoted(larger)} ${
    left ? `left ${plain(left)} of this one` : "used the rest of this one"
  }.`;
}

/**
 * The plan card's note under a task whose figure alone is more than the project's session work
 * budget (OS-5, within 100 characters for a work budget under CHF 10): 'More than a session's work
 * budget (CHF 4.00): it pauses with its work kept and asks you to continue.'
 */
export function oversizedPlanNote(workBudget: ChfAmount): string {
  return `More than a session's work budget (${plain(workBudget)}): it pauses with its work kept and asks you to continue.`;
}

/**
 * The Start dialog's plan sentence about the larger task (OS-4): first in the plan's order, the
 * whole sentence 'This session works on "Build the shop" until its work budget is used.', with the
 * tasks after it (OP-0) 'This session works on "Build the shop" until its work budget is used;
 * "B" runs after it only if budget is left.'; after other tasks, the clause the sentence ends
 * with, 'then works on "Build the shop" with what is left' (the caller adds ", " before it and
 * the full stop).
 */
export function oversizedPlanClause(
  title: string,
  alone: boolean,
  after: readonly string[] = [],
): string {
  if (!alone) return `then works on ${quoted(title)} with what is left`;
  const head = `This session works on ${quoted(title)} until its work budget is used`;
  if (after.length === 0) return `${head}.`;
  const one = after.length === 1;
  return `${head}; ${namedUpTo(after, 1)} ${one ? "runs" : "run"} after it only if budget is left.`;
}

/**
 * The chat's read-back warning after "Start a session on Shop (up to CHF 5.00)?" (OS-6):
 * '"Build the shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and
 * asks you to continue.'
 */
export function oversizedAsk(title: string, workBudget: ChfAmount): string {
  return `${quoted(title)} needs more than its work budget of ${plain(workBudget)}: it pauses with its work kept and asks you to continue.`;
}

/**
 * The session log's line when a task paused at its specialist's limit per run goes on in the same
 * session (d1109-oversize-pause, OP-5): 'The coder goes on with "Build the shop" from where it
 * stopped.'; `who` is the specialist in words (the caller's `saidByName`, never its registry key).
 */
export function continuesLine(who: string, title: string): string {
  return `The ${who} goes on with ${quoted(title)} from where it stopped.`;
}

/**
 * The session log's line when the session takes the larger task (OS-7), once: 'Took "Build the
 * shop", larger than this session's work budget, with about CHF 2.80 left.'
 */
export function takenLine(title: string, room: ChfAmount): string {
  return `Took ${quoted(title)}, larger than this session's work budget, with ${about(room)} left.`;
}

/**
 * C4b-left-5 (d1109-cred-screens, BA-12; the owner's answer of 2026-11-16: a task's budget counts
 * "critics reviews, and fixes"): the Start dialog's line for a task whose own budget may leave too
 * little for its review: '"Add a footer line with the club's name to index.html": its budget of
 * CHF 0.10 may leave too little for its review, which then waits for Continue.' (the review then
 * waits with one card whose Continue adds to its budget, BA-3).
 */
export function reviewMayWaitLine(title: string, budget: ChfAmount): string {
  return `${quoted(title)}: its budget of ${plain(budget)} may leave too little for its review, which then waits for Continue.`;
}
