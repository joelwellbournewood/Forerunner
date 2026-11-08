import type { RunWrapUpLine } from "../enforcement/budget.ts";

/**
 * A budget stop is a clean pause (ADR 0112, the owner's decision of 2026-11-02). A task's run is
 * paused when it stopped at a budget of any level, or when it heard the wrap-up in this run and
 * its report's "Left to do:" list has at least one item. A paused run gets no critic and no
 * failed try; its report is kept and its two headings are parsed into the run's artifacts as
 * `{ handoff }` (data only: it may carry web text, so whoever reads it back quotes it). A run
 * that ends normally without a wrap-up, or after one with nothing left, is reviewed as usual.
 */

/** Which limit stopped a run: its task's budget, the specialist's limit, or an outer cap. */
export type BudgetStopSource =
  | "task_budget"
  | "specialist_limit"
  | "session"
  | "project"
  | "month"
  | "plan";

/** What a paused run left for the run that continues its task (`{ handoff }` artifact). */
export interface RunHandoff {
  /** Its "Where I stopped:" text, or "" when it wrote none (a hard stop, a tiny budget). */
  stopped: string;
  /** Its "Left to do:" items; empty for "nothing" or none written. */
  leftToDo: string[];
  /** `wrap_up`: it heard the wrap-up and listed work left; `budget`: a budget refused a call. */
  stoppedBy: "wrap_up" | "budget";
}

/**
 * The brief's line for the two headings (ADR 0112): what they are for, so a run that hears the
 * wrap-up ends its report with them.
 */
export const WRAP_UP_BRIEF_LINE =
  "If Forerunner tells you that about a fifth of this task's budget is left, start nothing new and end your report with 'Where I stopped:' (what is done and where the work stands) and 'Left to do:' (a list of what is still to do, or 'nothing'): the run that continues this task starts from them.";

const MAX_STOPPED_CHARS = 600;
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 200;

/** "nothing", "none", "nothing left", "n/a": an empty list. */
const NOTHING = /^(?:nothing|none|no(?:thing)? (?:more|left)|n\/a|-)\b[\s.!]*$/i;
const ITEM = /^\s*(?:[-*•+]|\d+[.)])\s+(.*\S)\s*$/;

/** A heading line of the two ("Where I stopped:", "**Left to do:**", "## Left to do"), or null. */
function headingOf(line: string): { name: "stopped" | "left"; rest: string } | null {
  const plain = line
    .replace(/^\s*(?:#{1,6}\s*|>\s*)?/, "")
    .replace(/\*\*|__/g, "")
    .trim();
  const m = /^(where i stopped|left to do)\s*:?\s*(.*)$/i.exec(plain);
  if (!m) return null;
  return {
    name: (m[1] ?? "").toLowerCase() === "where i stopped" ? "stopped" : "left",
    rest: (m[2] ?? "").trim(),
  };
}

/** A line that starts another part of a report (a markdown heading or a bold "Label:"). */
const isOtherHeading = (line: string) =>
  /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line);

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The two headings of a report (ADR 0112): the text under its last "Where I stopped:" and the
 * list under its last "Left to do:". Tolerant of markdown (bold, headings, numbered or bulleted
 * lists, the text on the heading's own line). Cut to bounded sizes; never throws.
 */
export function parseHandoff(report: string): Pick<RunHandoff, "stopped" | "leftToDo"> {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  let stopped = "";
  let leftToDo: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i] ?? "");
    if (!h) continue;
    if (h.name === "stopped") {
      const parts = h.rest ? [h.rest] : [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (!l.trim()) {
          if (parts.length) break;
          continue;
        }
        if (headingOf(l) || isOtherHeading(l)) break;
        parts.push(l.trim());
      }
      stopped = parts.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    const items: string[] = [];
    if (h.rest && !NOTHING.test(h.rest)) items.push(h.rest);
    if (!h.rest || !NOTHING.test(h.rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (!l.trim()) {
          if (items.length) break;
          continue;
        }
        const item = ITEM.exec(l);
        if (item) {
          const text = (item[1] ?? "").replace(/\*\*|__/g, "").trim();
          if (text && !NOTHING.test(text)) items.push(text);
          continue;
        }
        if (!items.length && NOTHING.test(l.trim())) break;
        break;
      }
    }
    leftToDo = items;
  }
  return {
    stopped: cut(stopped, MAX_STOPPED_CHARS),
    leftToDo: leftToDo.slice(0, MAX_ITEMS).map((t) => cut(t, MAX_ITEM_CHARS)),
  };
}

/**
 * Which limit a budget stop names (ADR 0112): the refusal's level (`details.level` of the
 * hooks' `budget_exceeded`), a run-level one by where the run's cap came from. Before, every
 * stop below the session's remainder was "the task's budget", whatever refused it.
 */
export function stopSourceOf(
  error: { code?: string; level?: string } | undefined,
  runCapSource: "task_budget" | "specialist_limit" | "session",
): BudgetStopSource {
  if (error?.code !== "budget_exceeded") return runCapSource;
  switch (error.level) {
    case "session":
      return "session";
    case "task":
      return "task_budget";
    case "project":
      return "project";
    case "month":
      return "month";
    case "plan":
      return "plan";
    default:
      return runCapSource;
  }
}

/** The stops that end the session: nothing else of it can run under that limit. */
export function stopEndsSession(source: BudgetStopSource): boolean {
  return source === "session" || source === "project" || source === "month" || source === "plan";
}

/** The limit in words, in CHF: "its budget of CHF 0.40", "this month's cap of CHF 150.00". */
export function limitWords(
  source: BudgetStopSource,
  capUsdMicro: number,
  chf: (usdMicro: number) => string,
  specialist: string,
): string {
  switch (source) {
    case "task_budget":
      return `its budget of ${chf(capUsdMicro)}`;
    case "specialist_limit":
      return `the ${specialist}'s limit of ${chf(capUsdMicro)} per run (it has no budget of its own)`;
    case "session":
      return `this session's budget of ${chf(capUsdMicro)}`;
    case "project":
      return `the project's budget of ${chf(capUsdMicro)}`;
    case "month":
      return `this month's cap of ${chf(capUsdMicro)}`;
    case "plan":
      return "the share of your Claude subscription that Forerunner may use";
  }
}

/**
 * The session log's event when a limit refused a task's review before its verdict (ADR 0112,
 * the leftovers of wave 7): the task is paused at that limit like a run, with its card; `text`
 * is the line (`reviewPausedWords`).
 */
export const REVIEW_PAUSED_EVENT = "critic.review_paused";

/**
 * The line of a review a limit refused: '"X" paused before its review: the project's budget of
 * CHF 0.01 has no room for it.' (one line, the limit named as the card names it).
 */
export function reviewPausedWords(
  title: string,
  stop: { source: BudgetStopSource; capUsdMicro: number; specialist: string },
  chf: (usdMicro: number) => string,
): string {
  const name = `"${title.replace(/\s+/g, " ").trim()}"`;
  const what = limitWords(stop.source, stop.capUsdMicro, chf, stop.specialist).replace(
    /^its budget/,
    "its own budget",
  );
  return `${name} paused before its review: ${what} has no room for it.`;
}

/** The run's sentence for a pause (the session log's line and the task's reason). */
export function pauseSentence(
  handoff: RunHandoff,
  what: string,
  spentUsdMicro: number,
  capUsdMicro: number,
  chf: (usdMicro: number) => string,
): string {
  if (handoff.stoppedBy === "wrap_up") {
    const n = handoff.leftToDo.length;
    return `The run paused before ${what} ran out: it spent ${chf(spentUsdMicro)} and listed ${
      n === 1 ? "one thing" : `${n} things`
    } left to do.`;
  }
  // The hooks stop a run before a call that would go over its cap: "after spending CHF 0.00"
  // read as a contradiction on the bench (the stop came before anything was spent).
  return spentUsdMicro < capUsdMicro
    ? `The run stopped at ${what}: it spent ${chf(spentUsdMicro)}, and its next step would have gone over.`
    : `The run stopped at ${what}, after spending ${chf(spentUsdMicro)}.`;
}

/**
 * The run's budget line at its first call, for the session log (ADR 0112). A budget below even
 * its first step's worst case is refused before that step and says so (review of budget-stop:
 * it said no line at all); "a reserve of CHF 0.01 is two calls" read oddly, so the save-only
 * line names what two steps may cost.
 */
export function budgetLineWords(line: RunWrapUpLine, chf: (usdMicro: number) => string): string {
  if (line.saveOnly && line.firstCallUsdMicro > line.capUsdMicro)
    return `This run may spend ${chf(line.capUsdMicro)}, less than its first step may cost (${chf(line.firstCallUsdMicro)}): save only, it pauses at its budget before that step.`;
  return line.saveOnly
    ? `This run may spend ${chf(line.capUsdMicro)}, too little to wrap up (two steps may cost ${chf(line.reserveUsdMicro)}): save only, it pauses at its budget with its work kept.`
    : `This run may spend ${chf(line.capUsdMicro)}: at ${chf(line.lineUsdMicro)} it is told to wrap up, keeping a reserve of ${chf(line.reserveUsdMicro)} to finish.`;
}

/**
 * The session log's line when the run is told to wrap up (ADR 0112): what it spent of what it
 * may spend, and the reserve kept to finish. The call that would pass the line brings the
 * wrap-up, so more than a fifth is usually left: "about a fifth ... is left (it spent CHF 0.02
 * of CHF 0.04)" was not true (review of budget-stop).
 */
export function wrapUpSentWords(
  specialist: string,
  spentUsdMicro: number,
  capUsdMicro: number,
  line: RunWrapUpLine | undefined,
  chf: (usdMicro: number) => string,
): string {
  return line
    ? `Told the ${specialist} to wrap up: it spent ${chf(spentUsdMicro)} of ${chf(capUsdMicro)}, and the last ${chf(line.reserveUsdMicro)} is kept to finish.`
    : `Told the ${specialist} to wrap up: it spent ${chf(spentUsdMicro)} of ${chf(capUsdMicro)}.`;
}

/** A handoff as the run's artifact stores it: data only, already redacted and cut. */
export function handoffArtifact(handoff: RunHandoff): {
  handoff: { stopped: string; leftToDo: string[]; stoppedBy: string };
} {
  return {
    handoff: {
      stopped: handoff.stopped,
      leftToDo: [...handoff.leftToDo],
      stoppedBy: handoff.stoppedBy,
    },
  };
}

/** The `{ handoff }` artifact of a run's artifacts, or null (budget-resume's brief reads it). */
export function handoffOf(artifacts: unknown): RunHandoff | null {
  if (!Array.isArray(artifacts)) return null;
  for (const a of artifacts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const h = (a as { handoff?: unknown }).handoff;
    if (!h || typeof h !== "object" || Array.isArray(h)) continue;
    const o = h as Record<string, unknown>;
    const stoppedBy = o.stoppedBy === "wrap_up" ? "wrap_up" : "budget";
    return {
      stopped: typeof o.stopped === "string" ? o.stopped : "",
      leftToDo: Array.isArray(o.leftToDo)
        ? o.leftToDo.filter((t): t is string => typeof t === "string")
        : [],
      stoppedBy,
    };
  }
  return null;
}
