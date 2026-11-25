import { formatChf } from "@forerunner/billing";
import type { StateStore, TaskRow, WaitingTask } from "@forerunner/state";
import { leftOutSentence, waitsForNextSessionSentence } from "../daemon/oversize-words.ts";
import { plainReason } from "../daemon/task-words.ts";
import { aboutWords, moneyWords, moneyWordsFirst } from "./money-words.ts";
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
  /**
   * Tasks that wait on another one that is not done, with what they wait on; `waitsOnIds` the
   * ids of those tasks (fixup-l4-selftasks-chat: the result names which wait on a decision; an
   * outcome kept before it has none and is matched by title).
   */
  waiting: (NamedTask & { waitsOn: string[]; waitsOnIds?: string[] })[];
  /** Full-review tasks waiting for the Docker sandbox. */
  waitingForDocker: NamedTask[];
  stopReason: string;
  /**
   * The amount of the outer limit a pause ended the session at (`budget_month`,
   * `budget_project`, ADR 0112), in CHF: the result's "Ended before this month's cap of CHF 0.23 ran out."
   */
  stopCapChfMicro?: number;
  /**
   * The work waits for a Claude credential (U-078): the sentence, as the session ended on it
   * ("Waits until 15:40 (your subscription's limit) and starts by itself.", "Waits for a new
   * API key: save one in Settings.").
   */
  credentialWait?: string;
  /**
   * Tasks paused at a budget (budget-resume, ADR 0112 amended), each with the limit in words
   * ("its budget of CHF 0.40"): their card offers Continue or Cancel. `waits`: a limit no
   * Continue lifts (the project's budget, this month's cap, the subscription's share), whose card
   * offers only Cancel and where the task goes on by itself once the limit is raised or resets.
   * Not in `needsYou`.
   */
  paused?: PausedTask[];
  /**
   * Tasks the person cancelled while the session ran or reviewed them (W15-59): a session whose
   * only task they cancelled said only its cost ("CHF 0.01.").
   */
  cancelled?: NamedTask[];
  /**
   * l4-starts-sessions (L4-money-214): tasks the person paused (the Tasks tab's Pause or Stop)
   * while the session ran them, still paused by them at its end: no card, needing nobody (design
   * §2 "Paused by you"), so not in `needsYou`. A session whose only task they paused said only its
   * cost ("CHF 0.01."), as W15-59's cancel did.
   */
  pausedByYou?: NamedTask[];
  spentChfMicro: number;
}

/** What the result is computed from: the session's lists and the project as it stands now. */
export interface ResultFacts {
  outcome: LastSessionOutcome;
  inReview: NamedTask[];
  /**
   * Ready tasks left out because they did not fit the work budget, with their estimate and why
   * (D4: `after_large`, it came after a task larger than the session, `after` its title, which
   * used the rest of it (d1109-oversize-pause, OP-0); `no_room`, too little was left for a task
   * larger than the session; `after_others` or absent, it did not fit after the others).
   */
  leftOutForBudget: (NamedTask & {
    estimateChfMicro: number;
    reason?: "after_others" | "after_large" | "no_room";
    after?: string;
  })[];
  /**
   * d1109-starts-engine (S-7): work made ready while the session ran that asked to join and did
   * not fit what the session promised (option C), still ready at its end: "Left for your next
   * Start: "D" (about CHF 0.50)."
   */
  leftForNextStart?: (NamedTask & {
    estimateChfMicro: number;
    /**
     * d1109-selftasks-run (D7): the step it waits for, when a step the agent added before it did
     * not fit and took it out of the promise ("and "Publish", which waits for it").
     */
    waitsFor?: string;
  })[];
  /**
   * d1109-selftasks-run (ADR 0119): what the agent changed in its own task list during the
   * session, in order ("split", "added", "dropped", "reworded", "reordered"), by title.
   */
  tasksChanged?: TaskChangeFact[];
  /** The session's cap, in CHF (the "this session's CHF 0.90 was used" line). */
  sessionCapChfMicro: number;
  /**
   * What the session's tasks could spend (its cap less the review reserve), in CHF, when the plan
   * left tasks out for it (W6-23: "more than this session's work budget of CHF 0.32").
   */
  workBudgetChfMicro?: number;
  /**
   * l4-money-pause, run L4 (L4-money-102): what was left of that work budget when the session
   * ended, as its budget counts it ('"B" (about CHF 0.06) waits for your next session: "X" left CHF
   * 0.03 of this one.'); absent, the work budget less the session's spend.
   */
  workLeftChfMicro?: number;
  /** Open tasks of the project after the session (not done, not cancelled). */
  openTasks: number;
  /** Reviewed pull requests the session merged, and those it left open for the person. */
  mergedPrs?: number;
  openPrs?: number;
  /**
   * Reviewed pull requests that merge by themselves later (merge-in-app), apart (W15-70): those
   * whose checks still run (`checks_pending`), and those GitHub did not answer about
   * (`unreachable`, tried again). One line named both before.
   */
  checksPendingPrs?: number;
  unansweredPrs?: number;
}

/** One change the agent made to its own task list in a session (ADR 0119). */
export interface TaskChangeFact {
  kind: "split" | "added" | "dropped" | "reworded" | "reordered";
  title: string;
}

/**
 * S-7's "Left for your next Start" (d1109-starts-engine), with D7's case (d1109-selftasks-run): a
 * promised task that waits for a step the agent added, which did not fit, is named after that
 * step as the task "which waits for it", without an estimate of its own: 'Left for your next
 * Start: "Check the links" (about CHF 0.20) and "Publish", which waits for it.'
 */
export function leftForNextStartLine(
  next: readonly (NamedTask & { estimateChfMicro: number; waitsFor?: string })[],
): string {
  const steps = next.filter((t) => !t.waitsFor || !next.some((s) => s.title === t.waitsFor));
  const parts = steps.slice(0, 3).map((t) => {
    const after = next.filter((w) => w.waitsFor === t.title);
    const est = `"${t.title}" (${aboutWords(formatChf(t.estimateChfMicro), t.estimateChfMicro)})`;
    if (!after.length) return est;
    const names = namesOf(after.map((w) => w.title));
    return `${est} and ${names}, which ${after.length === 1 ? "waits" : "wait"} for it`;
  });
  const more = steps.length > 3 ? ` and ${steps.length - 3} more` : "";
  return `Left for your next Start: ${parts.join(", ")}${more}.`;
}

/** A change's words in the result line: 'split "Style the page"', 'added "Check the links"'. */
function changeWords(c: TaskChangeFact): string {
  // An edit can change only the priority or what done looks like, so it reads 'edited', never
  // 'reworded' (review of d1109-selftasks-chat). The stored kind stays 'reworded'.
  return `${c.kind === "reworded" ? "edited" : c.kind} "${c.title}"`;
}

/**
 * The session result's line when the agent changed its own tasks (ADR 0119, design §3.7):
 * 'Changed 2 tasks: split "Style the page"; added "Check the links".', three named at most, then
 * 'and N more'.
 */
export function tasksChangedLine(changes: readonly TaskChangeFact[]): string | null {
  if (!changes.length) return null;
  const named = changes.slice(0, 3).map(changeWords).join("; ");
  const more = changes.length > 3 ? ` and ${changes.length - 3} more` : "";
  return `Changed ${changes.length} ${plural(changes.length, "task", "tasks")}: ${named}${more}.`;
}

/** How a check ended, for its Details line. */
export type TaskCheckEnd =
  /** `noted`: l4-selftasks-103, the first line the check left out, as a clause (`quotedPhrase`). */
  | { kind: "no_change"; noted?: string }
  | { kind: "changed"; count: number }
  | { kind: "suggested"; count: number }
  | { kind: "unreadable" }
  | { kind: "failed" };

/**
 * The Details line of one check (ADR 0119 point 3): 'Checked the task list after "Create the
 * page": no change (CHF 0.03).'; 'Checked the task list: …' when it ran at the session's first
 * boundary on notes kept from before.
 */
export function taskCheckedLine(
  after: string | null,
  end: TaskCheckEnd,
  costChfMicro: number,
): string {
  const what =
    end.kind === "no_change"
      ? end.noted
        ? `no change; ${end.noted}`
        : "no change"
      : end.kind === "changed"
        ? `changed ${end.count} ${plural(end.count, "task", "tasks")}`
        : end.kind === "suggested"
          ? `suggested ${end.count} ${plural(end.count, "change", "changes")} in the Inbox`
          : end.kind === "unreadable"
            ? "its reply could not be read, so nothing changed"
            : "the call did not answer, so nothing changed";
  const money = moneyWords(formatChf(costChfMicro), costChfMicro);
  return `Checked the task list${after ? ` after "${after}"` : ""}: ${what} (${money}).`;
}

/**
 * l4-selftasks-104: what a check's fence and the commands refused, as one Details line ('Left
 * out (and 1 more): adding "Write thanks.html": "Write book.html" was not added.'), the
 * words chat's `fixLeftOut` says; null when nothing was refused. Before, the refusals were only
 * in the event's payload and the person never read them.
 */
export function taskCheckLeftOutLine(
  refused: readonly { what: string; reason: string }[],
): string | null {
  const [one] = refused;
  if (!one) return null;
  const more = refused.length > 1 ? ` (and ${refused.length - 1} more)` : "";
  return `Left out${more}: ${one.what.replace(/[.\s]+$/, "")}: ${one.reason.replace(/[.\s]+$/, "")}.`;
}

/** Merge outcomes that merge by themselves later (merge-in-app): not left for the person. */
export const MERGE_WAITS: ReadonlySet<string> = new Set(["checks_pending", "unreachable"]);

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
    // w8-l4-leftovers (L4i-left-28): the session ended before the limit ran out (a limit is
    // never passed); before, "Stopped at the project's budget of CHF 0.06. CHF 0.04." read as
    // all of it spent while part of it was left.
    case MONTH_CAP_STOP:
    case PROJECT_BUDGET_STOP:
      return `Ended before ${stopLimitWords(stopReason, capChfMicro)} ran out.`;
    case PLAN_SHARE_STOP:
      return "Ended before the share of your Claude subscription that Forerunner may use ran out.";
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
  /**
   * l4-cred-engine L4-creds-3: the person has an open card for the credential stop the session's
   * wait names (Anthropic refused it, or the ask card of that stop), which was notified when it
   * was filed and tells the wait: the result's credential line is no news of its own.
   */
  credential?: boolean;
}

/**
 * One sentence builder of the result (`RESULT_LINE_BUILDERS`): the sentences it adds to line 1
 * (what needs the person or waits), line 2 (what happened) or line 3 (what is next, how it
 * ended, the money). `f` is the facts; `o` the outcome as this reader sees it (with `told`, what
 * an open card already says is left out).
 */
export interface ResultLineBuilder {
  /** A name for tests and the maintainer doc. */
  name: string;
  line: 1 | 2 | 3;
  build(f: ResultFacts, o: LastSessionOutcome, told: ToldByCards | undefined): string[];
}

/**
 * The result's sentences in order (U-078 made it a list so each area adds its own builder and
 * changes no other's; later areas append theirs where the order says): what waits for a reset, a
 * key or the person first; then what happened (what was merged and what waits to merge); then
 * how it ended, what is left, and the cost last.
 */
export const RESULT_LINE_BUILDERS: ResultLineBuilder[] = [
  {
    // U-078: the work waits for a Claude credential, and says when it starts by itself.
    name: "credential wait",
    line: 1,
    // L4-creds-3: an open card of the stop tells it (the session page keeps the whole result).
    build: (_f, o, told) => (o.credentialWait && !told?.credential ? [o.credentialWait] : []),
  },
  {
    name: "plan approval",
    line: 1,
    build: (_f, o, told) =>
      o.stopReason === "plan_awaiting_approval" && !told?.plan
        ? ["The plan waits for your approval in the Inbox; nothing ran."]
        : [],
  },
  {
    name: "needs you",
    line: 1,
    build: (_f, o) => (o.needsYou.length ? [needsYouSentence(titlesOf(o.needsYou))] : []),
  },
  {
    name: "failed",
    line: 1,
    build: (_f, o) => {
      if (o.failed.length === 1 && o.failed[0]) {
        const f0 = o.failed[0];
        // The stored reason may carry a run id or "(s)" (writing rules §5: neither is shown).
        // L-18 (polish-words): plain (no markdown) and cut at a word, as the Tasks row reads it.
        const reason = plainReason(f0.reason, 160).replace(/\s*\(\s*\)/g, "");
        const said = lowerFirst(noDot(reason)) || "no reason given";
        // W15-52: a reason cut at a word ends in its "…", never "….".
        return [`"${f0.title}" failed: ${said}${said.endsWith("…") ? "" : "."}`];
      }
      return o.failed.length > 1 ? [`${namesOf(titlesOf(o.failed))} failed.`] : [];
    },
  },
  {
    // fixup-l4-selftasks-chat (L4-selftasks-130, live check 4): what waits on a task that needs
    // the person or failed is said right after it ('"B" waits on it.'), never three sentences
    // later as "1 task waits on it."; with two such tasks it names the one it waits on.
    name: "waits on what needs you",
    line: 1,
    build: (_f, o) => waitsOnBlockerSentences(o),
  },
  {
    name: "waiting for Docker",
    line: 1,
    build: (_f, o) =>
      o.waitingForDocker.length
        ? [`Waiting for Docker: ${namesOf(titlesOf(o.waitingForDocker))}.`]
        : [],
  },
  {
    name: "done",
    line: 2,
    build: (_f, o) =>
      o.done.length
        ? [
            `Did ${o.done.length} ${plural(o.done.length, "task", "tasks")}: ${namesOf(titlesOf(o.done))}.`,
          ]
        : [],
  },
  {
    // d1109-selftasks-run (ADR 0119): what the agent changed in its own task list.
    name: "tasks changed",
    line: 2,
    build: (f) => {
      const line = tasksChangedLine(f.tasksChanged ?? []);
      return line ? [line] : [];
    },
  },
  {
    // W15-59: a session whose only work the person cancelled says so, not only its cost;
    // l4-starts-sessions (L4-money-214): the same for what they paused while it ran, in one
    // sentence with a cancel ('You cancelled "A" and paused "B"; nothing else ran.').
    name: "cancelled by you",
    line: 2,
    build: (f, o) => {
      const gone = o.cancelled ?? [];
      const paused = o.pausedByYou ?? [];
      const did =
        o.done.length ||
        o.failed.length ||
        o.needsYou.length ||
        (o.paused?.length ?? 0) ||
        f.inReview.length ||
        f.mergedPrs;
      if (did || (!gone.length && !paused.length)) return [];
      const what = [
        gone.length ? `cancelled ${namesOf(titlesOf(gone))}` : null,
        paused.length ? `paused ${namesOf(titlesOf(paused))}` : null,
      ].filter(Boolean);
      return [`You ${what.join(" and ")}; nothing else ran.`];
    },
  },
  {
    name: "in review",
    line: 2,
    build: (f) =>
      f.inReview.length
        ? [
            `${namesOf(titlesOf(f.inReview))} ${plural(f.inReview.length, "waits", "wait")} for review.`,
          ]
        : [],
  },
  {
    name: "merged",
    line: 2,
    build: (f) =>
      f.mergedPrs
        ? [`Merged ${f.mergedPrs} ${plural(f.mergedPrs, "pull request", "pull requests")}.`]
        : [],
  },
  {
    // A wait for Docker is the reason nothing ran, whether or not its card already said so.
    name: "nothing could run",
    line: 2,
    build: (f, o) => {
      const did = o.done.length || f.inReview.length || f.mergedPrs;
      if (did || o.stopReason !== "nothing_runnable" || f.outcome.waitingForDocker.length)
        return [];
      // D4 (d1109-oversize-start): a task whose estimate alone is more than the session's work
      // budget is no reason nothing ran any more: the session takes it with what is left (its
      // log says "Took ..."). Before (W6-23): 'Nothing could run: "X" needs about CHF 1.20, more
      // than this session's work budget of CHF 0.32. Start a session with a larger budget.'
      const w = o.waiting[0];
      return [
        w
          ? `Nothing could run: "${w.title}" waits on ${w.waitsOn.join(" and ")}.`
          : "Nothing could run: no task is ready.",
      ];
    },
  },
  {
    name: "how it ended",
    line: 3,
    build: (_f, o) => {
      const stop = stopWords(o.stopReason, o.stopCapChfMicro);
      return stop ? [stop] : [];
    },
  },
  {
    name: "left for next time",
    line: 3,
    build: (f, o) => {
      // D4: a task larger than the session's work budget that waits for the next session says
      // why in its own sentence (too little left after the tasks before it).
      const larger = f.leftOutForBudget.filter((t) => t.reason === "no_room");
      const work = f.workBudgetChfMicro ?? 0;
      const why = larger.slice(0, 3).map((t) =>
        leftOutSentence("no_room", {
          title: t.title,
          estimate: { chfMicro: t.estimateChfMicro, text: formatChf(t.estimateChfMicro) },
          workBudget: { chfMicro: work, text: formatChf(work) },
        }),
      );
      // d1109-oversize-pause (OP-0): the tasks that came after a larger task that used the rest
      // of the session, named once per larger task: '"B" waits for your next session: "Build
      // the shop" used the rest of this one.'
      // l4-money-pause, run L4 (L4-money-102): with what the larger task left of the work budget
      // and the one task's estimate, never "used the rest" while the spend is under it.
      const behind = new Map<string, (typeof f.leftOutForBudget)[number][]>();
      for (const t of f.leftOutForBudget)
        if (t.reason === "after_large" && t.after)
          behind.set(t.after, [...(behind.get(t.after) ?? []), t]);
      const leftChf = Math.max(0, f.workLeftChfMicro ?? work - o.spentChfMicro);
      const chf = (n: number) => ({ chfMicro: n, text: formatChf(n) });
      const after = [...behind].map(([big, tasks]) =>
        waitsForNextSessionSentence(
          tasks.map((t) => t.title),
          big,
          work > 0
            ? {
                left: chf(leftChf),
                ...(tasks[0] ? { estimate: chf(tasks[0].estimateChfMicro) } : {}),
              }
            : undefined,
        ),
      );
      why.push(...after);
      // S-7: work that asked to join and did not fit the session's promise.
      const next = f.leftForNextStart ?? [];
      if (next.length) why.push(leftForNextStartLine(next));
      const fitting = f.leftOutForBudget.filter(
        (t) => !larger.includes(t) && !(t.reason === "after_large" && t.after),
      );
      // A session that ran nothing used no budget: "Nothing could run" says why (W6-23).
      if (fitting.length && o.stopReason !== "nothing_runnable") {
        const named = fitting
          .slice(0, 3)
          .map(
            (t) =>
              `"${t.title}" (${aboutWords(formatChf(t.estimateChfMicro), t.estimateChfMicro)})`,
          )
          .join(", ");
        const more = fitting.length > 3 ? ` and ${fitting.length - 3} more` : "";
        // w8-l4-leftovers (L4i-left-30, the 'budget used' sibling of L4-money-102): "was used"
        // only when the session's own budget ended it or its work budget has less than a centime
        // left; a larger task's pause (or an outer limit) that ended it with room left says why
        // the task was left out when the session was planned.
        const used =
          o.stopReason === "budget_exceeded" ||
          o.stopReason === "budget_finish_current" ||
          (work > 0 && leftChf < 5_000);
        const one = fitting.length === 1 && !more;
        return [
          used
            ? `Left for next time: ${named}${more}; this session's ${moneyWords(formatChf(f.sessionCapChfMicro), f.sessionCapChfMicro)} was used.`
            : `Left for next time: ${named}${more}; ${one ? "it" : "they"} did not fit this session's work budget after the tasks before ${one ? "it" : "them"}.`,
          ...why,
        ];
      }
      if (why.length) return why;
      // Ready tasks that wait for a credential are said by the wait's sentence, not as ready
      // to continue (U-078: they start by themselves).
      if (o.leftOver.length && !o.credentialWait)
        return [
          `${namesOf(titlesOf(o.leftOver))} ${plural(o.leftOver.length, "is", "are")} ready to continue.`,
        ];
      return [];
    },
  },
  {
    // The session's own reviewed PRs left open, said as what this session did: the Overview's
    // "Waiting for you to merge" lists every PR that waits now (earlier sessions', Forerunner's
    // docs), and "1 reviewed pull request waits" stood next to a list of 3 there and stayed
    // after a merge on GitHub (review, 2026-11-02).
    name: "left to merge",
    line: 3,
    build: (f) =>
      f.openPrs
        ? [
            `Left ${f.openPrs} reviewed ${plural(f.openPrs, "pull request", "pull requests")} for you to merge.`,
          ]
        : [],
  },
  {
    // merge-in-app: what merges by itself once its checks pass is not left for the person
    // (before: "Left 1 reviewed pull request for you to merge" for one the retry then merged).
    // W15-70: the checks that still run and a GitHub that did not answer are said apart (P7-5
    // named both in one line, "once its checks pass or GitHub answers").
    name: "merges by itself later",
    line: 3,
    build: (f) => [
      ...(f.checksPendingPrs
        ? [
            f.checksPendingPrs === 1
              ? "1 reviewed pull request merges by itself once its checks pass."
              : `${f.checksPendingPrs} reviewed pull requests merge by themselves once their checks pass.`,
          ]
        : []),
      ...(f.unansweredPrs
        ? [
            f.unansweredPrs === 1
              ? "1 reviewed pull request merges once GitHub answers; Forerunner tries again."
              : `${f.unansweredPrs} reviewed pull requests merge once GitHub answers; Forerunner tries again.`,
          ]
        : []),
    ],
  },
  {
    name: "waiting on other tasks",
    line: 3,
    // L4-selftasks-130: only what waits on no task line 1 names (a task waiting on a ready one
    // left for next time is no task waiting on the decision).
    build: (_f, o) => {
      const blockers = blockersOf(o);
      const blocked = o.waiting.filter((w) => !blockers.some((b) => waitsOnTask(w, b))).length;
      return blocked
        ? [`${blocked} ${plural(blocked, "task waits", "tasks wait")} on other tasks.`]
        : [];
    },
  },
  {
    name: "nothing left",
    line: 3,
    build: (f, o) => (f.openTasks === 0 && o.done.length ? ["Nothing left."] : []),
  },
  {
    name: "cost",
    line: 3,
    // W14-6: a spend under a centime reads "Less than CHF 0.01.", never "CHF 0.00."
    // l4-cred-screens (L4-creds-26, C6L-8): a session that ended to wait and spent nothing says
    // no money (design §5 rule 5: before, "Waits until 15:40 (...). CHF 0.00.").
    build: (_f, o) =>
      o.credentialWait && o.spentChfMicro <= 0
        ? []
        : [`${moneyWordsFirst(formatChf(o.spentChfMicro), o.spentChfMicro)}.`],
  },
  {
    // budget-resume: a task paused at a budget, by the limit its card names; its card is the
    // one place for the decision (an Update leaves it out, `told`).
    name: "paused",
    line: 1,
    build: (_f, o, told) => pausedSentences(o.paused ?? [], told),
  },
];

/**
 * How a task paused at a limit no Continue lifts goes on (W14-6, polish-words): a project's
 * budget never resets, so only raising it lets the task go on; a month's cap or the
 * subscription's share also reset.
 */
function goesOnByItself(limit: string): string {
  // d1109-starts-engine (S-3, S-12; ADR 0118 amending 0112): a raised or reset limit makes it
  // ready again; it runs at the next Start (nothing starts by itself).
  return /^the project's budget\b/.test(limit)
    ? "it is ready again once you raise that budget, for your next Start."
    : "it is ready again once that limit is raised or resets, for your next Start.";
}

/**
 * A task paused at a budget, as the result names it (`LastSessionOutcome.paused`); `before`: its
 * run heard the wrap-up and paused before the limit ran out (L3-research-2), as its log line says.
 */
export type PausedTask = NamedTask & {
  limit: string;
  waits?: boolean;
  before?: boolean;
  /**
   * d1109-oversize-pause (OP-7, from its card's `kept_checks`): the names of the project's checks
   * that fail on its kept work; absent when none ran or all passed.
   */
  checksFail?: string[];
  /** OP-7 (its card's `no_progress`): it paused again without getting further. */
  noProgress?: boolean;
  /** L4-money-111 (its card's `review_waits`): the work is done; only its review waits. */
  reviewWaits?: boolean;
};

/** "test", "test and lint", "test, lint and 1 more": at most two check names. */
function checkNames(names: readonly string[]): string {
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
    : names.join(" and ");
}

/**
 * '"Write the guide" paused at its budget of CHF 0.40: continue or cancel it in the Inbox.'; two
 * or more: '"A" and "B" paused at a budget: continue or cancel them in the Inbox.'. At a limit no
 * Continue lifts (`waits`) it says how the task goes on, as its card does: '"X" paused at the
 * project's budget of CHF 0.01: it goes on by itself once that limit is raised or resets.' (the
 * fixup's bench walk: it said "continue" to a card that offers only Cancel); a mix points to
 * the cards.
 */
export function pausedSentences(paused: readonly PausedTask[], told?: ToldByCards): string[] {
  const shown = paused.filter((t) => !told?.tasks?.has(t.id));
  const one = shown[0];
  if (!one) return [];
  const waiting = shown.filter((t) => t.waits).length;
  // L3-research-2: a run that heard the wrap-up paused before its limit ran out, as the log's
  // line for it says ("paused before its budget of CHF 0.15 ran out: it spent CHF 0.09"); "paused
  // at its budget of CHF 0.15" beside it read as all of it spent.
  // L4-money-111: a task whose review waits for room is done, not paused at its budget.
  const how = one.reviewWaits
    ? `is done; its review waits for room in ${one.limit}`
    : one.before
      ? `paused before ${one.limit} ran out`
      : `paused at ${one.limit}`;
  if (shown.length === 1) {
    // d1109-oversize-pause (OP-7): a pause that got no further asks; never "goes on by itself".
    if (one.noProgress)
      return [`"${one.title}" paused again without getting further: answer its card in the Inbox.`];
    // OP-7: the project's check that fails on its kept work is said with the pause.
    const fails = one.checksFail?.length
      ? `, and the project's ${checkNames(one.checksFail)} ${one.checksFail.length === 1 ? "fails" : "fail"} on its work`
      : "";
    return [
      one.waits
        ? `"${one.title}" ${how}${fails}: ${goesOnByItself(one.limit)}`
        : `"${one.title}" ${how}${fails}: continue or cancel it in the Inbox.`,
    ];
  }
  const names = namesOf(titlesOf(shown));
  if (waiting === shown.length)
    return [`${names} paused at a limit: they are ready again once it is raised or resets.`];
  if (waiting > 0) return [`${names} paused at a budget: see their cards in the Inbox.`];
  return [`${names} paused at a budget: continue or cancel them in the Inbox.`];
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
  const byLine: Record<1 | 2 | 3, string[]> = { 1: [], 2: [], 3: [] };
  for (const b of RESULT_LINE_BUILDERS) byLine[b.line].push(...b.build(f, o, told));
  return [byLine[1], byLine[2], byLine[3]]
    .filter((sentences) => sentences.length > 0)
    .map((sentences) => sentences.join(" "))
    .slice(0, 3);
}

/** The tasks a result names as needing the person or failed: what other tasks may wait on. */
function blockersOf(o: LastSessionOutcome): NamedTask[] {
  return [...o.needsYou, ...o.failed];
}

/** Whether a waiting task waits on `t` (by id; an outcome kept before `waitsOnIds`, by title). */
function waitsOnTask(w: LastSessionOutcome["waiting"][number], t: NamedTask): boolean {
  if (w.waitsOnIds) return w.waitsOnIds.includes(t.id);
  const named = `"${t.title}"`;
  return w.waitsOn.some((s) => s === named || s.startsWith(`${named},`));
}

/**
 * L4-selftasks-130: the sentences for the tasks that wait on one the result says needs the person
 * or failed, right after it on line 1: '"Write styles.css" waits on it.' when one task blocks;
 * with two or more, each group names the ones it waits on ('"C" waits on "A".'), never "it".
 */
export function waitsOnBlockerSentences(o: LastSessionOutcome): string[] {
  const blockers = blockersOf(o);
  if (!blockers.length) return [];
  const groups = new Map<string, { on: string[]; waiters: string[] }>();
  for (const w of o.waiting) {
    const on = blockers.filter((b) => waitsOnTask(w, b));
    if (!on.length) continue;
    const key = on.map((b) => b.id).join("\u0000");
    const g = groups.get(key) ?? { on: titlesOf(on), waiters: [] };
    g.waiters.push(w.title);
    groups.set(key, g);
  }
  return [...groups.values()].map(
    (g) =>
      `${namesOf(g.waiters)} ${plural(g.waiters.length, "waits", "wait")} on ${
        blockers.length === 1 ? "it" : namesOf(g.on)
      }.`,
  );
}

/**
 * The result's sentence for the tasks that wait on the person's decision: '"Style the page in
 * styles.css" needs your decision (Inbox).' A card in the Needs you list says the same (design
 * §5.10: one place per fact), so the Update removes this exact sentence.
 */
export function needsYouSentence(titles: readonly string[]): string {
  return `${namesOf(titles)} ${plural(titles.length, "needs", "need")} your decision (Inbox).`;
}

/**
 * Money, how the session ended and what waits: not news on their own in an Update. A spend
 * under a centime reads "Less than CHF 0.01." (`moneyWordsFirst`, W14-6): money too (the review
 * of polish-words: the Update read "Guides: Less than CHF 0.01." and nothing else).
 */
const NOT_NEWS =
  /^(?:(?:(?:Less than )?CHF \d+\.\d{2}\.|Stopped by you\.|Stopped: [^.]+\.|Stopped after the task, as asked\.|\d+ tasks? waits? on (?:it|other tasks)\.|You (?:cancelled|paused) .+?; nothing else ran\.)\s*)+$/;

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
  /**
   * d1109-selftasks-run (ADR 0119, design §3.8 "one line per session"): the agent's changes to
   * its own tasks, counted in the one Update ('Quote page: did 3 tasks; changed 2 tasks.').
   */
  changed: readonly TaskChangeFact[] = [],
): string | null {
  const card = needsYou.length ? needsYouSentence(needsYou) : null;
  const changedLine = tasksChangedLine(changed);
  // L4-selftasks-130: the clause that follows the card's sentence ('"B" waits on it.') goes with it.
  const cardWithClause = card
    ? new RegExp(
        `${escapeRegExp(card)}(?:\\s+(?:(?:"[^"]*"|\\d+ more)(?:, | and )?)+ waits? on it\\.)?`,
        "g",
      )
    : null;
  const withoutCard = (l: string) =>
    (cardWithClause ? l.replace(cardWithClause, " ") : l)
      .split(changedLine ?? "\u0000")
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
  const head = lines.map(withoutCard).find(isNewsLine);
  const count = changed.length
    ? `changed ${changed.length} ${plural(changed.length, "task", "tasks")}`
    : null;
  if (!head) return count && projectName ? `${projectName}: ${count}.` : count ? `${count}.` : null;
  let gist = cutGist(head, UPDATE_GIST_MAX);
  if (count) {
    const did = /^Did (\d+) (tasks?)(?::[\s\S]*)?\.$/.exec(head.split(/(?<=\.)\s/)[0] ?? "");
    gist = did
      ? `Did ${did[1]} ${did[2]}; ${count}.`
      : `${cutGist(head, UPDATE_GIST_MAX - 30)} ${count.charAt(0).toUpperCase()}${count.slice(1)}.`;
  }
  return projectName ? `${projectName}: ${lowerFirstIfDid(gist)}` : gist;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
export function waitingOf(w: WaitingTask): NamedTask & { waitsOn: string[]; waitsOnIds: string[] } {
  return {
    id: w.task.id,
    title: w.task.title,
    waitsOnIds: w.waitsOn.map((d) => d.id),
    waitsOn: w.waitsOn.map((d) =>
      d.title === null ? "a task that does not exist" : `"${d.title}", ${stateWords(d.status)}`,
    ),
  };
}
