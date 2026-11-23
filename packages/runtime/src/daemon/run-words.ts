import type { RunningView } from "./api-types.ts";
import { shortTitle } from "./task-words.ts";

/**
 * The run indicator's words and its fold of a session's log (d1109-run-visible, ADR 0118 point
 * 12), with nothing that needs the store: `run-indicator.ts` reads the store and re-exports these,
 * and the UI's fake daemon says the same sentences from here.
 */

/**
 * The daemon's event bus name the run indicator's list goes out on (`/events` sends it as the
 * `run.changed` frame); "run" is the task runs' own bus name.
 */
export const RUN_CHANGED_EVENT = "run.changed";

/** A sentence of the indicator at most this long (design §5 rule 1, a status sentence). */
export const RUN_TEXT_MAX = 80;
/** The name the critic's monthly check stands under: it belongs to no project. */
export const CALIBRATION_NAME = "Forerunner";
/** The critic's monthly check on known examples (the owner's answer 6 of 2026-11-09). */
export const CALIBRATION_WHAT = "the critic's monthly check on known examples";

export type RunState = RunningView["state"];
export type StopChoice = RunningView["stop"][number];

/** Why a person's session waits to go on, in the words the sentence needs. */
export type RunWait =
  /** Until the credential's reset, as the person reads the time ("15:40"). */
  | { kind: "limit"; at: string }
  /** The person's quiet hours end later than the reset: their end ("07:00"). */
  | { kind: "quiet"; at: string }
  /** Anthropic refused the credential: what is saved to go on ("a new API key"). */
  | { kind: "refused"; what: string }
  /**
   * d1109-cred-screens (CS-7): the share of the subscription Forerunner may use is used, until
   * the month's start in the person's time zone ("Tue 1 Dec, 01:00"), or the end of their quiet
   * hours when later.
   */
  | { kind: "share"; at: string }
  /** d1109-cred-screens (CS-7): an API key at the monthly cap the person gave it, until `at`. */
  | { kind: "key_month"; at: string }
  /** Any other wait. */
  | { kind: "other" };

export interface RunWords {
  state: RunState;
  taskTitle?: string | null;
  /** The specialist that works on the task, as the registry names it ("coder"). */
  specialist?: string | null;
  wait?: RunWait;
  /**
   * d1109-cred-screens (CS-7): the credential kind the running task's run went on with when the
   * person's first choice stopped (the session log's `billing.switch`): ' on your API key'.
   */
  on?: string | null;
  /** d1109-cred-screens (CS-7): tasks of the session that wait for the person's answer on the ask card. */
  asking?: number;
}

/** "your API key", "your subscription": a credential kind as the indicator names it. */
function credentialName(kind: string): string {
  if (kind === "subscription") return "your subscription";
  if (kind === "plan_credits") return "your plan credits";
  return "your API key";
}

/**
 * "the coder", "the writer": the specialist as a sentence names it. `specialist` is already in a
 * person's words (`saidByName` in run-indicator.ts maps the registry's key: writer-marketing is
 * "writer"), so these words also run in the browser (the UI's tests and the fake daemon).
 */
function specialistWords(specialist: string | null | undefined): string {
  return `the ${specialist?.trim() || "specialist"}`;
}

/** What the session does now, after the project's name, with the title as given. */
export function runWhat(w: RunWords, titleMax = 200): string {
  // CS-7: a task of the session waits for the person's answer on the one ask card.
  const n = w.asking ?? 0;
  const asking =
    n > 0 && w.state !== "waiting" && w.state !== "calibrating"
      ? ` · ${n} ${n === 1 ? "task waits" : "tasks wait"} for your answer`
      : "";
  return `${runDoes(w, titleMax)}${asking}`;
}

function runDoes(w: RunWords, titleMax: number): string {
  const title = w.taskTitle ? `"${shortTitle(w.taskTitle, titleMax)}"` : null;
  // CS-7: the running task went on with the credential the person's choice puts second.
  const on = w.on ? ` on ${credentialName(w.on)}` : "";
  switch (w.state) {
    case "planning":
      return "plans the session";
    case "working":
      return title
        ? `${specialistWords(w.specialist)} works on ${title}${on}`
        : "picks the next task";
    case "reviewing":
      return title ? `the critic checks ${title}` : "the critic checks the work";
    case "between":
      return "picks the next task";
    case "wrapping":
      return title ? `wraps up ${title} at its budget` : "wraps up at its budget";
    case "stopping":
      return title ? `stops after ${title}` : "stops after this task";
    case "calibrating":
      return CALIBRATION_WHAT;
    case "waiting": {
      const wait = w.wait ?? { kind: "other" };
      switch (wait.kind) {
        case "limit":
          return `waiting until ${wait.at}, then it goes on`;
        case "quiet":
          return `waiting until ${wait.at} (after your quiet hours), then it goes on`;
        case "refused":
          return `waiting for ${wait.what}, then it goes on`;
        // CS-7: the share's time alone (Change the allowance beside it); a key's cap named.
        case "share":
          return `waiting until ${wait.at}, then it goes on`;
        case "key_month":
          return `waiting until ${wait.at} (your API key's monthly cap), then it goes on`;
        default:
          return "waiting for Claude, then it goes on";
      }
    }
  }
}

/** The words fitted to `RUN_TEXT_MAX`: the title shortened at a word, then the names. */
export function runFit(w: RunWords & { projectName: string; nextProject?: string | null }): {
  what: string;
  text: string;
} {
  const build = (v: RunWords, titleMax: number, nameMax: number) => {
    const what = runWhat(v, titleMax);
    const then = w.nextProject ? ` · then ${shortTitle(w.nextProject, nameMax)}` : "";
    return { what, text: `${shortTitle(w.projectName, nameMax)} · ${what}${then}` };
  };
  // CS-7: with both the credential fragment and the question, the question (it needs the
  // person, design §5 rule 2) keeps its place; ' on your API key' goes before the title is cut
  // short (the switch is still on the session page and in its log).
  if (w.on && (w.asking ?? 0) > 0) {
    for (const titleMax of [60, 40, 30, 22]) {
      const out = build(w, titleMax, 60);
      if (out.text.length <= RUN_TEXT_MAX) return out;
    }
    w = { ...w, on: null };
  }
  for (const nameMax of [60, 40, 30, 24, 18])
    for (const titleMax of [60, 40, 30, 22, 16, 12]) {
      const out = build(w, titleMax, nameMax);
      if (out.text.length <= RUN_TEXT_MAX) return out;
    }
  return build(w, 10, 12);
}

/** The indicator's sentence: '<project> · <what>', with ' · then <project>' for a waiting start. */
export function runText(
  w: RunWords & { projectName: string; nextProject?: string | null },
): string {
  return runFit(w).text;
}

/**
 * What Stop offers for a state (design §3.7 and §3.1): Stop after this task while a task can
 * still finish, Stop now and Stop all; a session that already stops after its task, and the
 * critic's monthly check (it has no tasks), Stop now and Stop all; a waiting session none (it
 * offers Cancel).
 */
export function stopChoices(state: RunState): StopChoice[] {
  switch (state) {
    case "waiting":
      return [];
    case "stopping":
    case "calibrating":
      return ["now", "all"];
    default:
      return ["after", "now", "all"];
  }
}

/**
 * The open form's sentence of what the critic's monthly check does (the owner's answer 6 of
 * 2026-11-09: "please explain what function this serves"), in the form of the credential its
 * running call uses: its own monthly budget on the API key, the Claude plan at API prices on the
 * subscription (design §5 rule 6: plain words, no "verdict"; CHF only).
 */
export function calibrationExplain(opts: { budgetChfMicro: number; onPlan: boolean }): string {
  const chf = `CHF ${(Math.max(0, opts.budgetChfMicro) / 1_000_000).toFixed(2)}`;
  const head =
    "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes";
  return opts.onPlan
    ? `${head}; it runs on your Claude plan, within ${chf} a month at API prices.`
    : `${head}; it spends at most ${chf} a month of its own budget.`;
}

// --- The fold: what a session does now, from its log ---------------------------------------------

export interface RunFold {
  phase: "planning" | "working" | "reviewing" | "between" | "wrapping";
  taskId: string | null;
  taskTitle: string | null;
  specialist: string | null;
  /** Titles of the tasks the session began, by task id (a review names its task by id). */
  titles: Record<string, string>;
  /**
   * d1109-cred-screens (CS-7): the credential kind the running task's run went on with after the
   * person's first choice stopped (`billing.switch` of that task), null on the first choice.
   */
  on: string | null;
  /** The last event folded (`event.seq`): the next read starts after it. */
  afterSeq: number;
}

export function emptyRunFold(): RunFold {
  return {
    phase: "planning",
    taskId: null,
    taskTitle: null,
    specialist: null,
    titles: {},
    on: null,
    afterSeq: 0,
  };
}

/** The log line the executor writes when a run hears its wrap-up (`wrapUpSentWords`). */
const WRAP_UP_LINE = /^Told the .+ to wrap up\b/;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Fold a session's events (in order, after `fold.afterSeq`) into what it does now: planning until
 * its plan is made, a task's run, its review, between tasks. Pure; events already folded are
 * skipped, so a read that starts again changes nothing.
 */
export function foldRunEvents(
  fold: RunFold,
  events: readonly { seq: number; type: string; payload: unknown }[],
): RunFold {
  let f: RunFold = { ...fold, titles: { ...fold.titles } };
  for (const e of events) {
    if (e.seq <= f.afterSeq) continue;
    f.afterSeq = e.seq;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const taskId = str(p.taskId);
    const titleOf = () => str(p.title) ?? (taskId ? (f.titles[taskId] ?? null) : null);
    switch (e.type) {
      case "session.started":
        f = { ...f, phase: "planning", taskId: null, taskTitle: null, specialist: null };
        break;
      case "session.planned":
      case "session.promised":
      case "session.replanned":
      case "task.retrying":
      case "critic.verdict":
      case "critic.review_failed":
      case "critic.review_paused":
        f = { ...f, phase: "between", taskId: null, taskTitle: null, specialist: null };
        break;
      case "task.started": {
        const title = str(p.title);
        if (taskId && title) f.titles[taskId] = title;
        f = {
          ...f,
          phase: "working",
          taskId,
          taskTitle: title,
          specialist: str(p.specialist),
          on: null,
        };
        break;
      }
      // CS-7: the running task's run went on with another credential; the back line ends it.
      case "billing.switch":
        if (taskId && taskId === f.taskId) f = { ...f, on: str(p.to) };
        break;
      case "billing.back":
        f = { ...f, on: null };
        break;
      case "task.step":
        if (typeof p.text === "string" && WRAP_UP_LINE.test(p.text) && f.phase === "working")
          f = { ...f, phase: "wrapping" };
        break;
      case "task.finished":
        f =
          p.review === true
            ? { ...f, phase: "reviewing", taskId, taskTitle: titleOf() }
            : { ...f, phase: "between", taskId: null, taskTitle: null, specialist: null };
        break;
      case "critic.review_started":
      case "critic.review_resumed":
        f = { ...f, phase: "reviewing", taskId, taskTitle: titleOf() };
        break;
      default:
        break;
    }
  }
  return f;
}

/** The event types the fold reads (the rest of a session's log says nothing of its phase). */
export const RUN_EVENT_TYPES = [
  "session.started",
  "session.planned",
  "session.promised",
  "session.replanned",
  "task.retrying",
  "task.started",
  "task.step",
  "task.finished",
  "critic.review_started",
  "critic.review_resumed",
  "critic.verdict",
  "critic.review_failed",
  "critic.review_paused",
  "billing.switch",
  "billing.back",
] as const;

// Cancel's sentence lives in a file the browser build can read (no imports).
export { CANCEL_WAIT_EXPLAIN } from "./run-wait-words.ts";

/**
 * The prepared outcomes (`change_card.start`, d1109-starts-engine S-2) after which the answered
 * work waits for the person's next Start: no session of the project took it, none starts for it
 * by itself. "stopped_all" is not one (Start is refused until sessions are allowed again).
 */
// l4-starts-sessions (L4-money-203): a task too large for the session runs at the next Start.
const START_OFFER_OUTCOMES: ReadonlySet<string> = new Set([
  "waits_start",
  "stopping",
  "too_large",
  "failed",
]);

/**
 * d1109-run-visible (V-6): whether an answered card's Done line offers Start (the person's start
 * is one click from where they answered). True when its answer readied work that runs at the
 * person's next Start and the card names its project; the Inbox then hides it while a session
 * of that project runs (the run indicator's list). Never for an open card, a session the
 * hands-off setting starts, or an answer that started a session or readied nothing.
 */
export function startOfferOf(card: unknown, status: string, projectId: string | null): boolean {
  if (status === "open" || !projectId) return false;
  if (!card || typeof card !== "object" || Array.isArray(card)) return false;
  const c = card as { start?: unknown; start_by?: unknown };
  return (
    typeof c.start === "string" && START_OFFER_OUTCOMES.has(c.start) && c.start_by !== "hands_off"
  );
}

/**
 * C3-left-8: an ended session's stored result promises "...; then your session goes on." while
 * its continuation is kept; once nothing is kept (Cancel, Stop all), the words follow what is true
 * now: "...; then it runs at your next Start." (the wait sentences' own two forms).
 */
export function summaryAfterWait(summary: string): string {
  return summary.replace("; then your session goes on.", "; then it runs at your next Start.");
}
