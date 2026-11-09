/**
 * Every sentence about a task larger than one session (d1109-oversize-start; the owner's D4 of
 * 2026-11-09: "it should get a warning, but it should get done anyway"), written from the facts
 * the Start check and the runner hold, so the Start dialog, the plan card, the chat's read-back,
 * the session's log and its result say it the same way (design §5: one sentence, CHF only,
 * "about" for estimates, task titles in quotes, no ids). The runner takes such a task after the
 * work that fits, with what is left of the session's work budget (`cutPlanToBudget`,
 * `OVERSIZED_MIN_ROOM_SHARE`); it pauses at that budget with its work kept and one card whose
 * Continue goes on from it (ADR 0112 amended), which is what "keeps its work, and asks you to
 * continue" promises.
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

/** What the sentences about the larger task the session takes are written from. */
export interface OversizedFacts {
  title: string;
  /** What it needs: its estimate, or what is left of it after its kept work (`spent`). */
  estimate: ChfAmount;
  /** The session's work budget (its cap less the fifth kept for reviews). */
  workBudget: ChfAmount;
  /**
   * What it works with after the other tasks of the session; null when nothing runs before it
   * (it then works until the work budget is used).
   */
  room: ChfAmount | null;
  /** What its kept work cost, when it resumes from it (OS-1). */
  spent?: ChfAmount | null;
}

/**
 * The warning before Start (the Start dialog's amber note, the Start check's `oversized`):
 * '"Build the shop" needs about CHF 6.00, more than this session's work budget of CHF 4.00: it
 * works until that budget is used, keeps its work, and asks you to continue.'
 */
export function oversizedSentence(f: OversizedFacts): string {
  const needs = f.spent
    ? `${about(f.estimate)} more (${plain(f.spent)} spent so far)`
    : about(f.estimate);
  const how = f.room
    ? `after the other tasks it works with ${about(f.room)}, keeps its work, and asks you to continue`
    : "it works until that budget is used, keeps its work, and asks you to continue";
  return `${quoted(f.title)} needs ${needs}, more than this session's work budget of ${plain(f.workBudget)}: ${how}.`;
}

/** Why a task is left out of a session for its budget (the runner's `LeftOutReason`). */
export type LeftOutWhy = "after_others" | "one_large" | "no_room";

/** What a left-out task's sentence is written from. */
export interface LeftOutFacts {
  title: string;
  estimate: ChfAmount;
  workBudget: ChfAmount;
  /** `after_others`: what the tasks that run first take of the work budget. */
  ahead?: ChfAmount | null;
}

/**
 * Why a task waits for the next session, one sentence (the Start dialog's lines, the Start
 * check's `overBudget[].sentence`, the session result's "Left for next time"):
 * - `no_room`: '"Build the shop" needs about CHF 6.00, more than this session's work budget:
 *   the tasks before it leave too little to start it, so it waits for the next session.'
 * - `one_large`: '"Big two" needs about CHF 9.00, more than this session's work budget: one task
 *   that large runs a session, so it waits for the next one.'
 * - `after_others` (the Start dialog's line of W15-38, now the daemon's): '"About page" (about
 *   CHF 2.40) may be left for next time: the tasks that run first take about CHF 2.40 of this
 *   session's work budget of CHF 4.00 (the budget less a fifth kept for reviews). Give the
 *   session a larger budget to be sure it runs.'
 */
export function leftOutSentence(why: LeftOutWhy, f: LeftOutFacts): string {
  const t = quoted(f.title);
  if (why === "no_room")
    return `${t} needs ${about(f.estimate)}, more than this session's work budget: the tasks before it leave too little to start it, so it waits for the next session.`;
  if (why === "one_large")
    return `${t} needs ${about(f.estimate)}, more than this session's work budget: one task that large runs a session, so it waits for the next one.`;
  return `${t} (${about(f.estimate)}) may be left for next time: the tasks that run first take ${about(
    f.ahead ?? { chfMicro: 0, text: "CHF 0.00" },
  )} of this session's work budget of ${plain(f.workBudget)} (the budget less a fifth kept for reviews). Give the session a larger budget to be sure it runs.`;
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
 * The Start dialog's plan sentence about the larger task (OS-4): alone, the whole sentence
 * 'This session works on "Build the shop" until its work budget is used.'; after other tasks,
 * the clause the sentence ends with, 'then works on "Build the shop" with what is left' (the
 * caller adds ", " before it and the full stop).
 */
export function oversizedPlanClause(title: string, alone: boolean): string {
  return alone
    ? `This session works on ${quoted(title)} until its work budget is used.`
    : `then works on ${quoted(title)} with what is left`;
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
 * The session log's line when the session takes the larger task (OS-7), once: 'Took "Build the
 * shop", larger than this session's work budget, with about CHF 2.80 left.'
 */
export function takenLine(title: string, room: ChfAmount): string {
  return `Took ${quoted(title)}, larger than this session's work budget, with ${about(room)} left.`;
}
