import { formatChf } from "@forerunner/billing";
import type { StateStore, TaskRow, WaitingTask } from "@forerunner/state";
import { plainPlurals, withoutIds } from "../daemon/task-words.ts";
import { namesOf } from "./recovery.ts";
import {
  MONTH_CAP_STOP,
  PLAN_SHARE_STOP,
  PROJECT_BUDGET_STOP,
  stopLimitWords,
} from "./stop-words.ts";

/**
 * A session's result in the person's words (core-experience design §5, "Session result"):
 * at most three lines, what needs the person first, then what happened, then what is next and
 * the money, task names in quotes, CHF, no zero counts, computed at the end from the tasks as
 * they stand then. Before, it was one paragraph of about fifteen templates that opened with a
 * waiting list captured before the work ran (tasks done minutes earlier read "(ready)"), ended
 * with six zero counts and gave the budget in USD; the same paragraph went to the session page,
 * the Overview, an Inbox message and the notification.
 */

/** One task as the result names it. */
export interface NamedTask {
  id: string;
  title: string;
}

/**
 * What the last session did, for the Overview and Chat (`summary_cache.last_session.outcome`):
 * the lists behind the result's lines, so a screen can link each task instead of parsing text.
 */
export interface LastSessionOutcome {
  done: NamedTask[];
  failed: (NamedTask & { reason: string })[];
  needsYou: NamedTask[];
  /** Ready tasks the session did not get to (the budget, a stop), or that became ready late. */
  leftOver: NamedTask[];
  /** Tasks that wait on another one that is not done, with what they wait on. */
  waiting: (NamedTask & { waitsOn: string[] })[];
  /** Full-review tasks waiting for the Docker sandbox. */
  waitingForDocker: NamedTask[];
  stopReason: string;
  /**
   * The amount of the outer limit a pause ended the session at (`budget_month`,
   * `budget_project`, ADR 0112), in CHF: the result's "Stopped at this month's cap of CHF 0.23."
   */
  stopCapChfMicro?: number;
  spentChfMicro: number;
}

/** What the result is computed from: the session's lists and the project as it stands now. */
export interface ResultFacts {
  outcome: LastSessionOutcome;
  inReview: NamedTask[];
  /** Ready tasks left out because they did not fit the work budget, with their estimate. */
  leftOutForBudget: (NamedTask & { estimateChfMicro: number })[];
  /** The session's cap, in CHF (the "this session's CHF 0.90 was used" line). */
  sessionCapChfMicro: number;
  /** Open tasks of the project after the session (not done, not cancelled). */
  openTasks: number;
  /** Reviewed pull requests the session merged, and those it left open for the person. */
  mergedPrs?: number;
  openPrs?: number;
}

/** The status words a waiting task's dependency is named with. */
function stateWords(status: string | null): string {
  switch (status) {
    case null:
      return "which does not exist";
    case "failed":
      return "which failed";
    case "cancelled":
      return "which was cancelled";
    case "needs_human":
      return "which needs you";
    default:
      return "which is not done yet";
  }
}

/** Names a reason can start with; they keep their capital ("failed: Claude did not answer"). */
const NAME_FIRST = /^(Claude|Forerunner|Docker|GitHub|Git|Node|Anthropic|Cloudflare)\b/;
/**
 * The sentence with its first letter lowercased, to follow a colon; a name ("Claude") or an
 * abbreviation ("HTTP 500") keeps its capital.
 */
const lowerFirst = (s: string) =>
  !s || NAME_FIRST.test(s) || /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
const noDot = (s: string) => s.trim().replace(/[.\s]+$/, "");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const titlesOf = (l: readonly NamedTask[]) => l.map((t) => t.title);

/**
 * How the session ended, in words, or "" when it simply ran out of work. A pause at an outer
 * limit names it, with its amount when known (`capChfMicro`, ADR 0112).
 */
export function stopWords(stopReason: string, capChfMicro?: number): string {
  switch (stopReason) {
    case MONTH_CAP_STOP:
    case PROJECT_BUDGET_STOP:
      return `Stopped at ${stopLimitWords(stopReason, capChfMicro)}.`;
    case PLAN_SHARE_STOP:
      return "Stopped at the share of your Claude subscription that Forerunner may use.";
    case "you":
      return "Stopped by you.";
    case "quit":
      return "Stopped: Forerunner was closed.";
    case "stop_all":
      return "Stopped: Stop all.";
    case "stopped_by_message":
    case "stopped_after_task":
      return "Stopped after the task, as asked.";
    case "budget_exceeded":
    case "budget_finish_current":
      return "The session's budget is used.";
    case "timeout":
      return "The session's time limit was reached.";
    default:
      return "";
  }
}

/**
 * What an open Inbox card already says (design §4.3, §5.10: the person hears once): the tasks
 * a card holds, whether the project's Docker card is open, and whether the plan waits on its
 * card. Each card was notified when it was filed.
 */
export interface ToldByCards {
  /** Ids of the tasks an open card is about (`holdsTask`). */
  tasks?: ReadonlySet<string>;
  /** The project's Docker card ("sandbox.not_ready") is open. */
  docker?: boolean;
  /** The plan waits for approval on its own card. */
  plan?: boolean;
}

/**
 * The result's lines (at most three). With `told`, what an open card already says is left out:
 * the news the session-end notification and the Inbox Update carry (the session page and the
 * Overview keep the whole result).
 */
export function sessionResultLines(f: ResultFacts, told?: ToldByCards): string[] {
  const o: LastSessionOutcome = told
    ? {
        ...f.outcome,
        needsYou: f.outcome.needsYou.filter((t) => !told.tasks?.has(t.id)),
        failed: f.outcome.failed.filter((t) => !told.tasks?.has(t.id)),
        waitingForDocker: told.docker ? [] : f.outcome.waitingForDocker,
      }
    : f.outcome;
  const lines: string[] = [];
  // 1. What needs the person.
  const asks: string[] = [];
  if (o.stopReason === "plan_awaiting_approval" && !told?.plan)
    asks.push("The plan waits for your approval in the Inbox; nothing ran.");
  if (o.needsYou.length) asks.push(needsYouSentence(titlesOf(o.needsYou)));
  if (o.failed.length === 1 && o.failed[0]) {
    const f0 = o.failed[0];
    // The stored reason may carry a run id or "(s)" (writing rules §5: neither is shown).
    const reason = plainPlurals(withoutIds(f0.reason)).replace(/\s*\(\s*\)/g, "");
    asks.push(`"${f0.title}" failed: ${lowerFirst(noDot(reason)) || "no reason given"}.`);
  } else if (o.failed.length > 1) asks.push(`${namesOf(titlesOf(o.failed))} failed.`);
  if (o.waitingForDocker.length)
    asks.push(`Waiting for Docker: ${namesOf(titlesOf(o.waitingForDocker))}.`);
  if (asks.length) lines.push(asks.join(" "));
  // 2. What happened.
  const did: string[] = [];
  if (o.done.length)
    did.push(
      `Did ${o.done.length} ${plural(o.done.length, "task", "tasks")}: ${namesOf(titlesOf(o.done))}.`,
    );
  if (f.inReview.length)
    did.push(
      `${namesOf(titlesOf(f.inReview))} ${plural(f.inReview.length, "waits", "wait")} for review.`,
    );
  if (f.mergedPrs)
    did.push(`Merged ${f.mergedPrs} ${plural(f.mergedPrs, "pull request", "pull requests")}.`);
  // A wait for Docker is the reason nothing ran, whether or not its card already said so.
  if (!did.length && o.stopReason === "nothing_runnable" && !f.outcome.waitingForDocker.length) {
    const w = o.waiting[0];
    did.push(
      w
        ? `Nothing could run: "${w.title}" waits on ${w.waitsOn.join(" and ")}.`
        : "Nothing could run: no task is ready.",
    );
  }
  if (did.length) lines.push(did.join(" "));
  // 3. What is next, how it ended, the money.
  const next: string[] = [];
  const stop = stopWords(o.stopReason, o.stopCapChfMicro);
  if (stop) next.push(stop);
  if (f.leftOutForBudget.length) {
    const named = f.leftOutForBudget
      .slice(0, 3)
      .map((t) => `"${t.title}" (about ${formatChf(t.estimateChfMicro)})`)
      .join(", ");
    const more = f.leftOutForBudget.length > 3 ? ` and ${f.leftOutForBudget.length - 3} more` : "";
    next.push(
      `Left for next time: ${named}${more}; this session's ${formatChf(f.sessionCapChfMicro)} was used.`,
    );
  } else if (o.leftOver.length) {
    next.push(
      `${namesOf(titlesOf(o.leftOver))} ${plural(o.leftOver.length, "is", "are")} ready to continue.`,
    );
  }
  // The session's own reviewed PRs left open, said as what this session did: the Overview's
  // "Waiting for you to merge" lists every PR that waits now (earlier sessions', Forerunner's
  // docs), and "1 reviewed pull request waits" stood next to a list of 3 there and stayed after
  // a merge on GitHub (review, 2026-11-02).
  if (f.openPrs)
    next.push(
      `Left ${f.openPrs} reviewed ${plural(f.openPrs, "pull request", "pull requests")} for you to merge.`,
    );
  const blocked = o.waiting.length;
  if (blocked && (o.failed.length || o.needsYou.length))
    next.push(`${blocked} ${plural(blocked, "task waits", "tasks wait")} on it.`);
  else if (blocked)
    next.push(`${blocked} ${plural(blocked, "task waits", "tasks wait")} on other tasks.`);
  if (f.openTasks === 0 && o.done.length) next.push("Nothing left.");
  next.push(`${formatChf(o.spentChfMicro)}.`);
  lines.push(next.join(" "));
  return lines.slice(0, 3);
}

/**
 * The result's sentence for the tasks that wait on the person's decision: '"Style the page in
 * styles.css" needs your decision (Inbox).' A card in the Needs you list says the same (design
 * §5.10: one place per fact), so the Update removes this exact sentence.
 */
export function needsYouSentence(titles: readonly string[]): string {
  return `${namesOf(titles)} ${plural(titles.length, "needs", "need")} your decision (Inbox).`;
}

/** Money, how the session ended and what waits: not news on their own in an Update. */
const NOT_NEWS =
  /^(?:(?:CHF \d+\.\d{2}\.|Stopped by you\.|Stopped: [^.]+\.|Stopped after the task, as asked\.|\d+ tasks? waits? on (?:it|other tasks)\.)\s*)+$/;

/**
 * Whether a result line is news on its own (design §3.8, §5.10): more than money, how the
 * session ended and what waits. The Update and the session-end notification go only for news.
 */
export function isNewsLine(line: string): boolean {
  const l = line.trim();
  return l.length > 0 && !NOT_NEWS.test(l);
}

/** The longest gist an Update carries before it is cut at a word. */
const UPDATE_GIST_MAX = 160;

/**
 * A gist longer than `max` cut at a word with "…"; a cut inside a quoted name closes the quote
 * ('… and "Style the page in…"'), so the line never reads as a broken fragment.
 */
function cutGist(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text
    .slice(0, max - 2)
    .replace(/\s+\S*$/, "")
    .replace(/[\s,;:.]+$/, "");
  const open = (cut.match(/"/g) ?? []).length % 2 === 1;
  return open ? `${cut}…"` : `${cut}…`;
}

/**
 * The one-line Update the Inbox gets for a session (design §3.8): the project and the gist, or
 * null when there is no news. A decision that waits is the card's to say, not the Update's
 * (`needsYou`: the titles of the tasks the result says need the person, whose sentence is
 * removed as written, so a title with a dot or a quote in it is never cut; the runner passes
 * the lines without what any open card says, `sessionResultLines(f, told)`), and a session
 * that did nothing but what a card or the person's own stop says posts nothing: the card is
 * the one place for its news (design §4.3, §5.10). Before: "<Project>: CHF 0.00." after the
 * person stopped its only task (wave 1), and "<Project>: the session ended without finishing a
 * task." right under the card it did not name (phase E, C-32).
 */
export function sessionUpdateLine(
  projectName: string | null,
  lines: readonly string[],
  needsYou: readonly string[],
): string | null {
  const card = needsYou.length ? needsYouSentence(needsYou) : null;
  const withoutCard = (l: string) =>
    (card ? l.split(card).join(" ") : l).replace(/\s{2,}/g, " ").trim();
  const head = lines.map(withoutCard).find(isNewsLine);
  if (!head) return null;
  const gist = cutGist(head, UPDATE_GIST_MAX);
  return projectName ? `${projectName}: ${lowerFirstIfDid(gist)}` : gist;
}

function lowerFirstIfDid(s: string): string {
  return /^(Did|Nothing) /.test(s) ? lowerFirst(s) : s;
}

/**
 * The end state of a session's project, read now (writing rules §5.4: true now): the rows of
 * the tasks the session touched, the ready tasks left and the ones that wait on another.
 */
export async function collectEndState(
  store: StateStore,
  projectId: string | null,
  ids: Iterable<string>,
): Promise<{
  rows: Map<string, TaskRow>;
  readyNow: TaskRow[];
  waitingNow: WaitingTask[];
  openTasks: number;
  all: TaskRow[];
}> {
  const rows = new Map<string, TaskRow>();
  for (const id of new Set(ids)) {
    const r = await store.task.get(id);
    if (r) rows.set(id, r);
  }
  if (!projectId) return { rows, readyNow: [], waitingNow: [], openTasks: 0, all: [] };
  const all = await store.task.forProject(projectId, {}, { limit: 10_000 });
  return {
    rows,
    readyNow: await store.task.readyTasks(projectId, { limit: 100 }),
    waitingNow: await store.task.waitingTasks(projectId),
    openTasks: all.filter((t) => t.status !== "done" && t.status !== "cancelled").length,
    all,
  };
}

/**
 * Done means done (design §4.13): a milestone whose tasks are all done or cancelled (one done
 * at least) is closed, and the project's stage follows its tasks: "done" when every task is done
 * or cancelled, "build" once work was done on a project still at "planning" or "idea". Before,
 * nothing in the runtime moved a milestone or the stage, so a finished project read "planning"
 * for ever. Returns the stage now.
 */
export async function closeFinishedWork(
  store: StateStore,
  project: { id: string; stage: string },
  all: readonly TaskRow[],
  agentId: string,
): Promise<string> {
  const finished = (ts: readonly TaskRow[]) =>
    ts.length > 0 &&
    ts.every((t) => t.status === "done" || t.status === "cancelled") &&
    ts.some((t) => t.status === "done");
  for (const m of await store.milestone.forProject(project.id)) {
    if (m.status === "done" || m.status === "cancelled") continue;
    if (!finished(all.filter((t) => t.milestone_id === m.id))) continue;
    await store.milestone.change(m.id, m.version, { status: "done" }, "all its tasks are done", {
      agentId,
    });
  }
  const stage = finished(all)
    ? "done"
    : ["idea", "planning"].includes(project.stage) && all.some((t) => t.status === "done")
      ? "build"
      : project.stage;
  return stage;
}

/** A waiting task as the outcome names it: its dependencies in words. */
export function waitingOf(w: WaitingTask): NamedTask & { waitsOn: string[] } {
  return {
    id: w.task.id,
    title: w.task.title,
    waitsOn: w.waitsOn.map((d) =>
      d.title === null ? "a task that does not exist" : `"${d.title}", ${stateWords(d.status)}`,
    ),
  };
}
