import { formatChf } from "@forerunner/billing";
import type { StateStore, TaskRow, WaitingTask } from "@forerunner/state";
import { plainPlurals, withoutIds } from "../daemon/task-words.ts";
import { namesOf } from "./recovery.ts";

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

/** How the session ended, in words, or "" when it simply ran out of work. */
export function stopWords(stopReason: string): string {
  switch (stopReason) {
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

/** The result's lines (at most three). */
export function sessionResultLines(f: ResultFacts): string[] {
  const o = f.outcome;
  const lines: string[] = [];
  // 1. What needs the person.
  const asks: string[] = [];
  if (o.stopReason === "plan_awaiting_approval")
    asks.push("The plan waits for your approval in the Inbox; nothing ran.");
  if (o.needsYou.length)
    asks.push(
      `${namesOf(titlesOf(o.needsYou))} ${plural(o.needsYou.length, "needs", "need")} your decision (Inbox).`,
    );
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
  if (!did.length && o.stopReason === "nothing_runnable" && !o.waitingForDocker.length) {
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
  const stop = stopWords(o.stopReason);
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
  if (f.openPrs)
    next.push(
      `${f.openPrs} reviewed ${plural(f.openPrs, "pull request waits", "pull requests wait")} for you to merge.`,
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

/** The one-line Update the Inbox gets for a session (design §3.8): the project and the gist. */
export function sessionUpdateLine(projectName: string | null, lines: readonly string[]): string {
  const head = lines[0] ?? "";
  const gist = head.length > 160 ? `${head.slice(0, 157).replace(/\s+\S*$/, "")}…` : head;
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
