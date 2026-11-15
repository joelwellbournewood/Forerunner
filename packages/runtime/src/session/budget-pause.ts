import { saidByName } from "@forerunner/critic";
import type { RunWrapUpLine } from "../enforcement/budget.ts";
import { moneyWords } from "./money-words.ts";

/** A specialist as a sentence names it ("writer" for writer-marketing; `saidByName`). */
const specialistWords = (specialist: string) => saidByName(specialist) ?? "specialist";

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
  /**
   * Its "Left to do:" items that the task's criteria still need; empty for "nothing" (also
   * "Nothing for the acceptance criteria.") or none written. Only these pause a run (W15-14).
   */
  leftToDo: string[];
  /**
   * Its optional extras ("Optionally, ...", "Nice to have: ..."): kept as notes for the run that
   * continues or the critic, never a reason to pause.
   */
  optional?: string[];
  /** `wrap_up`: it heard the wrap-up and listed work left; `budget`: a budget refused a call. */
  stoppedBy: "wrap_up" | "budget";
}

/**
 * The brief's line for the two headings (ADR 0112): what they are for, so a run that hears the
 * wrap-up ends its report with them.
 */
export const WRAP_UP_BRIEF_LINE =
  "If Forerunner tells you to wrap up, start nothing new and end your report with 'Where I stopped:' (what is done and where the work stands) and 'Left to do:' (only what the task's criteria still need, as a list, or 'nothing'; no optional extras): the run that continues this task starts from them.";

const MAX_STOPPED_CHARS = 600;
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 200;

/**
 * "nothing", "none", "nothing left", "n/a": an empty list; also with what it is about ("Nothing
 * for the acceptance criteria.", "None required by the criteria", "Nothing left: all criteria
 * are met"), as the live researcher wrote it (W15-14). "Nothing works yet" and "None of the
 * tests pass" are items: a qualifier counts only when it is about the criteria or says done.
 * What it is about ends the line ("Nothing in the task works yet" is an item), or a reason
 * follows it after punctuation ("Nothing is needed for the two criteria: each listed page gives
 * its address and was opened.", live check 3, L3-research-1: before, a line could have what it
 * is about or a reason, not both); a criterion may be named by its number ("Nothing for
 * criterion 1."). The words that say done are whole words ("incomplete" says nothing is done;
 * review of W15-14). `NOT_NOTHING` still reads the whole line, so a reason that names work
 * ("Nothing for the criteria: but the tests still fail") keeps the line an item.
 */
const ABOUT = String.raw`\s+(?:for|in|by|under|within)\s[^.;:]*?\b(?:criteri(?:a|on)|brief|task|scope|requirements?|deliverables?)(?:\s*(?:#?\d+|\([a-z0-9]\))(?:\s*(?:,|and|&)\s*(?:#?\d+|\([a-z0-9]\)))*)?`;
const REASON = String.raw`\s*[:;,(\u2013\u2014-]\s*[\s\S]*`;
const NOTHING = new RegExp(
  String.raw`^(?:nothing|none|no(?:thing)? (?:more|left|else|further)|n\/a|-)(?:\s+(?:(?:is|are)\s+)?(?:left|else|more|further|remaining|outstanding|required|needed|to do))*(?:${ABOUT}(?:${REASON})?|\s*[:;,(\u2013\u2014-]\s*[\s\S]*?\b(?:criteri(?:a|on)|complete[ds]?|done|finished|met)\b[\s\S]*)?[\s.!)]*$`,
  "i",
);
/**
 * A "nothing" that goes on to name work ("Nothing - but the README is incomplete", "Nothing:
 * the criteria are not met yet", "... except the tests still fail") is work left (review of
 * W15-14): read as nothing, unfinished work went to review instead of a pause.
 */
const NOT_NOTHING =
  /\b(?:but|except|however|yet|not|never|still|missing|incomplete|unfinished|fail(?:s|ed|ing)?|broken)\b|n't\b/i;
const isNothing = (text: string) => NOTHING.test(text) && !NOT_NOTHING.test(text);
/**
 * A criterion named on its own ("criterion 2", "criteria 1 and 3", "the first criterion"): a
 * "nothing" about it says nothing of the rest, and an item that names it is work.
 */
const ONE_CRITERION =
  /\bcriteri(?:on|a)\s*(?:#?\d+|\([a-z0-9]\))|\b(?:first|second|third|fourth|fifth|last|other)\s+criterion\b/i;
/**
 * A "nothing" about the task's whole set of criteria ("Nothing is needed for the two criteria:
 * ...", "None required by the brief", "Nothing left: all criteria are met", "None; every
 * criterion is met"; L3-research-1). The model said the criteria need nothing more, so the other
 * items of that list that name no criterion are notes for the critic or the run that continues
 * (`optional`), never work left: live check 3's "The list isn't exhaustive. Pages I didn't open
 * ... may also mention hint." beside it paused finished research at its budget. A bare
 * "nothing", or one about a single criterion ("Nothing for criterion 1."), moves nothing.
 */
const WHOLE_SET =
  /\b(?:criteria|brief|task|scope|requirements|deliverables)\b|\b(?:every|each|all|both)\s+(?:of\s+the\s+)?criteri(?:on|a)\b/i;
const aboutWholeSet = (text: string) =>
  isNothing(text) && WHOLE_SET.test(text) && !ONE_CRITERION.test(text);
/** An item that names a criterion ("criterion 2 still needs its test"): work, whatever else says. */
const NAMES_CRITERION = /\bcriteri(?:on|a)\b/i;
/**
 * An optional extra ("Optionally, ...", "(optional) ...", "Nice to have: ..."): never work left.
 * A hedge alone ("Maybe fix the failing build", "Perhaps the most important: finish the
 * parser") is work left (review of W15-14).
 */
const OPTIONAL =
  /^(?:\(?optional(?:ly)?\)?\b|nice[- ]to[- ]have\b|if (?:you|the person) (?:want|wish|like)s?\b|could also\b)|\(optional\)[\s.]*$/i;
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
export function parseHandoff(
  report: string,
): Pick<RunHandoff, "stopped" | "leftToDo" | "optional"> {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  let stopped = "";
  let leftToDo: string[] = [];
  let optional: string[] = [];
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
    // Each item in its order, with whether it is an optional extra; a "nothing" about the whole
    // set of criteria makes the others that name no criterion notes too (L3-research-1).
    const listed: { text: string; extra: boolean }[] = [];
    let wholeSetDone = false;
    const add = (text: string) => {
      if (!text) return;
      if (isNothing(text)) {
        if (aboutWholeSet(text)) wholeSetDone = true;
        return;
      }
      listed.push({ text, extra: OPTIONAL.test(text) });
    };
    if (h.rest && !isNothing(h.rest)) add(h.rest);
    if (!h.rest || !isNothing(h.rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (!l.trim()) {
          if (listed.length || wholeSetDone) break;
          continue;
        }
        const item = ITEM.exec(l);
        if (item) {
          add((item[1] ?? "").replace(/\*\*|__/g, "").trim());
          continue;
        }
        break;
      }
    }
    const work = (i: { text: string; extra: boolean }) =>
      !i.extra && (!wholeSetDone || NAMES_CRITERION.test(i.text));
    leftToDo = listed.filter(work).map((i) => i.text);
    optional = listed.filter((i) => !work(i)).map((i) => i.text);
  }
  return {
    stopped: cut(stopped, MAX_STOPPED_CHARS),
    leftToDo: leftToDo.slice(0, MAX_ITEMS).map((t) => cut(t, MAX_ITEM_CHARS)),
    ...(optional.length
      ? { optional: optional.slice(0, MAX_ITEMS).map((t) => cut(t, MAX_ITEM_CHARS)) }
      : {}),
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
  chfOf: (usdMicro: number) => string,
  specialist: string,
): string {
  // W15-16: a limit under a centime reads "less than CHF 0.01", never "CHF 0.00".
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
  switch (source) {
    case "task_budget":
      return `its budget of ${chf(capUsdMicro)}`;
    case "specialist_limit":
      // W15-43 (W15B-78): the specialist in words ("the writer"), never its registry key.
      return `the ${specialistWords(specialist)}'s limit of ${chf(capUsdMicro)} per run (it has no budget of its own)`;
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
  chfOf: (usdMicro: number) => string,
): string {
  // W14-6: a spend under a centime reads "less than CHF 0.01".
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
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
export function budgetLineWords(line: RunWrapUpLine, chfOf: (usdMicro: number) => string): string {
  // P7-1, W14-6 (polish-words): no "save only" (a word of the code, not the person's), and an
  // amount under a centime reads "less than CHF 0.01", never "CHF 0.00".
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
  if (line.saveOnly && line.firstCallUsdMicro > line.capUsdMicro)
    return chf(line.firstCallUsdMicro) === "less than CHF 0.01"
      ? "This run may spend less than its first step may cost (both are under CHF 0.01): it pauses at its budget before that step."
      : `This run may spend ${chf(line.capUsdMicro)}, less than its first step may cost (${chf(line.firstCallUsdMicro)}): it pauses at its budget before that step.`;
  return line.saveOnly
    ? `This run may spend ${chf(line.capUsdMicro)}, too little to wrap up (two steps may cost ${chf(line.reserveUsdMicro)}): it pauses at its budget and keeps its work.`
    : `This run may spend ${chf(line.capUsdMicro)}: before a step that could take it past ${chf(line.lineUsdMicro)} it is told to wrap up, keeping a reserve of ${chf(line.reserveUsdMicro)} to finish.`;
}

/**
 * The session log's line when the run is told to wrap up (ADR 0112): what it spent of what it
 * may spend, and why now, as the start line names it (W15-16): the step it was about to take
 * could pass the line, so it may hear it well before its spend reaches the line ("at CHF 0.07 it
 * is told to wrap up" was followed by "it spent CHF 0.02": live check 2, F4).
 */
export function wrapUpSentWords(
  specialist: string,
  spentUsdMicro: number,
  capUsdMicro: number,
  line: RunWrapUpLine | undefined,
  chfOf: (usdMicro: number) => string,
): string {
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
  // W15-43 (W15B-78): the specialist in words ("the writer"), never its registry key.
  const who = specialistWords(specialist);
  // W15-74 (W15B-77): amounts under a centime are said once, not "less than CHF 0.01 of less
  // than CHF 0.01, ... past less than CHF 0.01": what it may spend, and why now.
  const amounts = [spentUsdMicro, capUsdMicro, ...(line ? [line.lineUsdMicro] : [])];
  if (amounts.filter((usd) => chf(usd) === "less than CHF 0.01").length >= 2)
    return line
      ? `Told the ${who} to wrap up: it may spend ${chf(capUsdMicro)}, and its next step could leave too little to finish.`
      : `Told the ${who} to wrap up: it may spend ${chf(capUsdMicro)}.`;
  return line
    ? `Told the ${who} to wrap up: it spent ${chf(spentUsdMicro)} of ${chf(capUsdMicro)}, and its next step could take it past ${chf(line.lineUsdMicro)}.`
    : `Told the ${who} to wrap up: it spent ${chf(spentUsdMicro)} of ${chf(capUsdMicro)}.`;
}

/** A handoff as the run's artifact stores it: data only, already redacted and cut. */
export function handoffArtifact(handoff: RunHandoff): {
  handoff: { stopped: string; leftToDo: string[]; optional?: string[]; stoppedBy: string };
} {
  return {
    handoff: {
      stopped: handoff.stopped,
      leftToDo: [...handoff.leftToDo],
      ...(handoff.optional?.length ? { optional: [...handoff.optional] } : {}),
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
      ...(Array.isArray(o.optional)
        ? { optional: o.optional.filter((t): t is string => typeof t === "string") }
        : {}),
      stoppedBy,
    };
  }
  return null;
}
