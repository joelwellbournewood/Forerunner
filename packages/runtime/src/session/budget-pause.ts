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
 * wrap-up ends its report with them. d1109-oversize-pause (OP-1, the owner's "wrap up in an
 * organized and error free way"): it also says what a good wrap-up leaves, as `wrapUpText` does,
 * and that a caveat goes under "Where I stopped:" (L3-left-4). Before: "If Forerunner tells you to
 * wrap up, start nothing new and end your report with 'Where I stopped:' (what is done and where
 * the work stands) and 'Left to do:' (...)". l4-money-pause, run L4 (L4-money-101): it asks for only
 * the word 'nothing' when the criteria need nothing more (before: "or 'nothing'", and live check
 * 4's researcher wrote "nothing the criteria require.").
 */
export const WRAP_UP_BRIEF_LINE =
  "If Forerunner tells you to wrap up, finish the step you are on, start nothing new, and leave the files so the work can go on (what you changed builds and runs; a change you cannot finish is undone or kept out of use). Then end your report with 'Where I stopped:' (what is done, anything half done with its file, and any caveat or what you did not cover) and 'Left to do:' (only what the task's criteria still need, as a list with the next step first, or only the word 'nothing' when they need nothing more; no optional extras): the run that continues this task starts from them.";

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
 * ("Nothing for the criteria: but the tests still fail") keeps the line an item. Near siblings
 * of the live line (fixup review of l3-handoff-checks): the reason may follow a full stop
 * ("Nothing is needed for the two criteria. Each listed page ... was opened."), what it is about
 * may be "to meet" or "to satisfy" the criteria, and "No further work is required to meet the
 * acceptance criteria." names what there is no more of.
 *
 * l4c-workstate, run L4 (the review of l4-money-pause): only a line that clearly says nothing is
 * left reads as empty; when unsure, a line is work left. So the words between "for", "in" or "to
 * meet" and what the line is about are a closed list (`ABOUT_WORD`: "the", "this", "the task's",
 * "acceptance", "the scope of" ...; before, any words: "Nothing in the code works for the task"
 * read as nothing), and a reason after punctuation counts only when it says the work is done and
 * names none left (`reasonSaysDone`; before, any reason: "Nothing for the criteria: tests and
 * docs remain" read as nothing).
 */
const ABOUT_WORD = String.raw`(?:the|this|that|these|its|their|our|my|your|all|every|each|both|any|whole|full|entire|original|stated|listed|given|agreed|acceptance|first|second|third|fourth|fifth|last|other|remaining|task'?s|brief'?s|project'?s|two|three|four|five|six|\d+|of|scope\s+of)`;
const NOUN = `(?:criteri(?:a|on)|brief|task|scope|requirements?|deliverables?)`;
const ABOUT = String.raw`\s+(?:for|in|by|under|within|to\s+(?:meet|satisfy|fulfil+|cover|pass))\s+(?:${ABOUT_WORD}\s+)*${NOUN}(?:\s*(?:#?\d+|\([a-z0-9]\))(?:\s*(?:,|and|&)\s*(?:#?\d+|\([a-z0-9]\)))*)?`;
/** What starts a reason: punctuation, or a full stop and the next sentence. */
const AFTER = String.raw`\s*(?:[:;,(\u2013\u2014-]|\.\s)`;
const REASON = String.raw`${AFTER}\s*[\s\S]*`;
/** Its two groups: the reason after what it is about, or the reason right after the "nothing". */
const NOTHING = new RegExp(
  String.raw`^(?:nothing|none|no(?:thing)? (?:more|left|else|further)(?:\s+(?:work|changes?|steps?|items?|actions?|tasks?))?|n\/a|-)(?:\s+(?:(?:is|are)\s+)?(?:left|else|more|further|remaining|outstanding|required|needed|to do))*(?:${ABOUT}(${REASON})?|(${AFTER}\s*[\s\S]*?\b(?:criteri(?:a|on)|complete[ds]?|done|finished|met)\b[\s\S]*))?[\s.!)]*$`,
  "i",
);
/**
 * l4c-workstate: a reason that says the work is done ("both are met", "hosts.md covers each of
 * them", "each listed page gives its address and was opened", "the file lists every page it
 * names"). A reason without one of these words (a list of work: "tests and docs"), with work
 * still to come ("the tests remain", "the deploy is pending", "the README is left", "then deploy
 * it", "the tests need to pass"), or one that starts a part with an order ("write the tests
 * until they pass") keeps the line an item. "nothing remains" or "none is left" inside it still
 * says done.
 */
const DONE_WORD =
  /\b(?:met|meets?|covered|covers?|complete[ds]?|done|finished|satisfie[sd]|fulfil+(?:ed|s)?|written|opened|answered|delivered|included|includes|gives|lists|passe[sd]|pass|cited|checked|tested|verified|in\s+place)\b/i;
const STILL_TO_COME =
  /(?<!\b(?:nothing|none)(?:\s+(?:is|are|else|more))?\s+)\b(?:left|remain(?:s|ing)?|pending|outstanding|to[\s-]do|todo|tbd)\b|\b(?:need(?:s|ed)?\s+to|should|must|ha(?:ve|s)\s+to|then|untested|unverified|unchecked|undone)\b/i;
const ORDER =
  /^(?:write|add|fix|test|run|deploy|update|create|finish|complete|check|review|verify|build|implement|commit|push|merge|document|remove|rename|move|wire|install|configure|fetch|read|rewrite|draft|make|redo|retry|try|replace|change|edit|refactor|clean|cite|confirm|ask|send|upload|publish|open|do)\b/i;
function reasonSaysDone(reason: string): boolean {
  const said = reason.replace(/^[\s:;,(\u2013\u2014.-]+/, "").trim();
  if (!said) return true;
  const parts = said.split(/[.;:,]\s*|\s+(?:and|then)\s+/).map((p) => p.trim());
  return (
    DONE_WORD.test(said) &&
    !STILL_TO_COME.test(said) &&
    !NOT_NOTHING.test(said) &&
    !parts.some((p) => ORDER.test(p))
  );
}
function isNothingForm(text: string): boolean {
  const m = NOTHING.exec(text);
  return !!m && !NOT_NOTHING.test(text) && reasonSaysDone(m[1] ?? m[2] ?? "");
}
/**
 * A "nothing" that goes on to name work ("Nothing - but the README is incomplete", "Nothing:
 * the criteria are not met yet", "... except the tests still fail", "..., though the tests need
 * a rewrite") is work left (review of W15-14): read as nothing, unfinished work went to review
 * instead of a pause.
 */
const NOT_NOTHING =
  /\b(?:but|except|however|(?:al)?though|yet|not|never|still|missing|incomplete|unfinished|fail(?:s|ed|ing)?|broken)\b|n't\b/i;
/**
 * l4-money-pause, run L4 (L4-money-101, live check 4's LC-C7: "Left to do: nothing the criteria
 * require."): a "nothing" with a relative clause that names what needs it ("nothing [that] the
 * [acceptance] criteria require", "nothing the brief still needs", "none the brief asks for",
 * "nothing criterion 2 needs"). Its "still" or "yet" before the verb belongs to the clause, so
 * `NOT_NOTHING` reads only what follows it ("nothing the criteria require yet: the tests fail" is
 * work). A reason after it counts only when it says done (`reasonSaysDone`, l4c-workstate:
 * "Nothing the criteria need: tests and docs" is work).
 */
const RELATIVE_HEAD = new RegExp(
  String.raw`^(?:nothing|none)(?:\s+(?:more|left|else|further|remaining))?(?:\s+(?:that|which))?\s+(?:the\s+)?(?:task'?s\s+)?(?:(?:acceptance|two|three|four|five|\d+)\s+)?${NOUN}(?:\s*(?:#?\d+|\([a-z0-9]\)))?(?:\s+(?:still|yet))?\s+(?:requires?|needs?|asks?\s+for|calls?\s+for|demands?|wants?)\b`,
  "i",
);
const RELATIVE_TAIL = new RegExp(String.raw`^(?:${REASON})?[\s.!)]*$`, "i");
function isRelativeNothing(text: string): boolean {
  const head = RELATIVE_HEAD.exec(text);
  if (!head) return false;
  const rest = text.slice(head[0].length);
  return RELATIVE_TAIL.test(rest) && !NOT_NOTHING.test(rest) && reasonSaysDone(rest);
}
/**
 * The general rule (L4-money-101; it ends the patching one live phrasing at a time after W15-14
 * and L3-research-1): a one-clause line that starts with "nothing" or "none", names the task's
 * whole set of criteria (`WHOLE_SET`, never one criterion) and names no work (`NOT_NOTHING`) is
 * an empty list however it combines what it is about and that nothing of it is left (a reason
 * after punctuation is read by the forms above).
 *
 * l4c-workstate, run L4 (the review of l4-money-pause): it is a closed form, no longer anything
 * that names the whole set less a list of work states. Before, `WORK_STATE` knew a few verbs, so
 * "Nothing the task requires has been tested", "Nothing the brief asks for is tested" and
 * "Nothing the criteria require is in the repository" read as nothing, and the task went to
 * review instead of pausing. Now the line is "nothing" or "none", then words that say left
 * (`LEFT`: "else", "more", "is left", "is needed", "to do" ...), then what it is about: a
 * preposition and the whole set ("for", "in", "by", "against", "on", "within", "to meet", "listed
 * in" ... and `ABOUT_WORD`s before the noun) or a relative clause ("[that] the brief lists", "the
 * criteria have asked for"), then at most one more `LEFT` or "remains", and nothing else. Any
 * other word ("tested", "ready", "pending", "in the repository", "untested") makes it work left.
 */
const LEFT = String.raw`\s+(?:(?:is|are)\s+)?(?:left(?:\s+to\s+(?:be\s+)?do(?:ne)?)?|else|more|further|remaining|outstanding|required|needed|to\s+(?:be\s+)?do(?:ne)?)`;
const WHOLE_NOUN = String.raw`${NOUN}(?:'s\s+(?:criteria|requirements|scope|deliverables)|\s+(?:criteria|requirements|scope|deliverables))?`;
const NAMED_BY = String.raw`(?:listed|named|stated|specified|set\s+out|mentioned|given|described|asked\s+for|called\s+for|required|needed|wanted|expected)`;
const ASKS = String.raw`(?:(?:has|have|had|would|will|does|do|did)\s+)?(?:requires?|required|needs?|needed|asks?\s+for|asked\s+for|calls?\s+for|called\s+for|demands?|demanded|wants?|wanted|expects?|expected|lists?|listed|names?|named|specif(?:y|ies|ied)|mentions?|mentioned|sets?\s+out|includes?|included|covers?|describes?|described)`;
const SAYS_ONLY_NOTHING_LEFT = new RegExp(
  String.raw`^(?:nothing|none)(?:${LEFT})*(?:(?:\s+${NAMED_BY})?\s+(?:for|in|by|under|within|against|on|from|to\s+(?:meet|satisfy|fulfil+|cover|pass|complete|finish))\s+(?:${ABOUT_WORD}\s+)*${WHOLE_NOUN}|(?:\s+(?:that|which))?\s+(?:${ABOUT_WORD}\s+)*${WHOLE_NOUN}\s+${ASKS})(?:${LEFT}|\s+remains?(?:\s+to\s+(?:be\s+)?do(?:ne)?)?)?(?:\s+(?:here|now|at\s+all|any\s*more))?[\s.!)]*$`,
  "i",
);
const isWholeSetNothing = (text: string) =>
  SAYS_ONLY_NOTHING_LEFT.test(text) &&
  WHOLE_SET.test(text) &&
  !ONE_CRITERION.test(text) &&
  !NOT_NOTHING.test(text);
const isNothing = (text: string) =>
  isNothingForm(text) || isRelativeNothing(text) || isWholeSetNothing(text);
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
  // L4-money-103: "project" or "month" when what is left of that limit capped the run.
  runCapSource: BudgetStopSource,
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

/**
 * The run's sentence for a pause (the session log's line and the task's reason). L3-left-1
 * (d1109-oversize-pause, OP-7): each figure says what it counts: a run that continued earlier
 * kept work says this run's spend and the task's in all ('...: this run spent CHF 0.12, CHF 0.24
 * in all, and listed 2 things left to do.'), as its card names the task's total; before, the line
 * said "it spent CHF 0.12" beside the card's "It spent CHF 0.24 of its budget of CHF 0.30".
 */
export function pauseSentence(
  handoff: RunHandoff,
  what: string,
  spentUsdMicro: number,
  capUsdMicro: number,
  chfOf: (usdMicro: number) => string,
  totalUsdMicro: number = spentUsdMicro,
  roomUsdMicro = 0,
): string {
  // W14-6: a spend under a centime reads "less than CHF 0.01".
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
  // d1116-budget-all (BA-4): what the run kept of its task's budget for the review that follows
  // it, said only when it kept some.
  const room = roomUsdMicro > 0 ? roomUsdMicro : 0;
  if (handoff.stoppedBy === "wrap_up") {
    const n = handoff.leftToDo.length;
    const spent =
      chf(totalUsdMicro) !== chf(spentUsdMicro) && totalUsdMicro > spentUsdMicro
        ? `this run spent ${chf(spentUsdMicro)}, ${chf(totalUsdMicro)} in all,`
        : `it spent ${chf(spentUsdMicro)}`;
    return `The run paused before ${what} ran out: ${spent} and listed ${
      n === 1 ? "one thing" : `${n} things`
    } left to do${room ? `; ${chf(room)} is kept for its review` : ""}.`;
  }
  const at = room ? `${what}, less the ${chf(room)} kept for its review` : what;
  // The hooks stop a run before a call that would go over its cap: "after spending CHF 0.00"
  // read as a contradiction on the bench (the stop came before anything was spent).
  return spentUsdMicro < capUsdMicro
    ? `The run stopped at ${at}: it spent ${chf(spentUsdMicro)}, and its next step would have gone over.`
    : `The run stopped at ${at}, after spending ${chf(spentUsdMicro)}.`;
}

/**
 * The run's budget line at its first call, for the session log (ADR 0112). A budget below even
 * its first step's worst case is refused before that step and says so (review of budget-stop:
 * it said no line at all); "a reserve of CHF 0.01 is two calls" read oddly, so the save-only
 * line names what two steps may cost.
 */
export function budgetLineWords(
  line: RunWrapUpLine,
  chfOf: (usdMicro: number) => string,
  roomUsdMicro = 0,
  /**
   * l4-money-pause, run L4 (L4-money-103): the outer limit whose remainder capped the run: 'This
   * run may spend CHF 0.06, the rest of the project's budget: it is told to wrap up ...' (live
   * check 4: "This run may spend CHF 1.20" under a project budget of CHF 0.06). Its review's
   * room, when kept, is said as what the rest is after ("... after CHF 0.03 for its review").
   */
  outer?: "project" | "month",
): string {
  // P7-1, W14-6 (polish-words): no "save only" (a word of the code, not the person's), and an
  // amount under a centime reads "less than CHF 0.01", never "CHF 0.00".
  const chf = (usd: number) => moneyWords(chfOf(usd), usd);
  const of = outer === "project" ? "the project's budget" : "this month's cap";
  // L4-money-103: under an outer limit it pauses there, not at a budget of its own.
  const at = outer ? `at ${of}` : "at its budget";
  const firstTooDear = line.saveOnly && line.firstCallUsdMicro > line.capUsdMicro;
  if (firstTooDear && chf(line.firstCallUsdMicro) === "less than CHF 0.01")
    return `This run may spend less than its first step may cost (both are under CHF 0.01): it pauses ${at} before that step.`;
  // Review of L4-money-103: under an outer limit the line has words of its own, short enough
  // to stay whole in the session log (200 characters) with every figure, its review's room
  // included ("what is left of the project's budget less the CHF 0.03 kept for its review: ...
  // keeping a reserve of…" was cut on screen).
  if (outer) {
    const head = `This run may spend ${chf(line.capUsdMicro)}, the rest of ${of}${roomUsdMicro > 0 ? ` after ${chf(roomUsdMicro)} for its review` : ""}`;
    if (firstTooDear)
      return `${head}: less than its first step may cost (${chf(line.firstCallUsdMicro)}), so it pauses before that step.`;
    return line.saveOnly
      ? `${head}: too little to wrap up (two steps may cost ${chf(line.reserveUsdMicro)}), so it pauses and keeps its work.`
      : `${head}: it is told to wrap up before a step that could pass ${chf(line.lineUsdMicro)}, keeping ${chf(line.reserveUsdMicro)} to finish.`;
  }
  // d1116-budget-all (BA-4): what the run keeps of its task's budget for its review, after the
  // amount, only when it keeps some (no clause promises a room the code does not keep).
  const kept =
    roomUsdMicro > 0 ? ` (${chf(roomUsdMicro)} of the task's budget is kept for its review)` : "";
  if (firstTooDear)
    return `This run may spend ${chf(line.capUsdMicro)}${kept}, less than its first step may cost (${chf(line.firstCallUsdMicro)}): it pauses ${at} before that step.`;
  return line.saveOnly
    ? `This run may spend ${chf(line.capUsdMicro)}${kept}, too little to wrap up (two steps may cost ${chf(line.reserveUsdMicro)}): it pauses ${at} and keeps its work.`
    : `This run may spend ${chf(line.capUsdMicro)}${kept}: before a step that could take it past ${chf(line.lineUsdMicro)} it is told to wrap up, keeping a reserve of ${chf(line.reserveUsdMicro)} to finish.`;
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

/**
 * l4-money-pause, run L4 (L4-money-106): the session log's line for a reply cut off at its
 * length limit, with what that call cost (it is paid for whatever came of it, U-085). Live check
 * 4: the writer's one-file reply was cut, CHF 0.05 spent and nothing written, and the log went
 * from "read README.md" to "Told the writer to wrap up" with no line for it.
 */
export function replyCutWords(
  specialist: string,
  cut: { kept: number; costUsdMicro: number; retry: boolean },
  chfOf: (usdMicro: number) => string,
): string {
  const who = specialistWords(specialist);
  const chf = moneyWords(chfOf(cut.costUsdMicro), cut.costUsdMicro);
  if (cut.kept > 0)
    return `The ${who}'s reply was cut off at its length limit (${chf}): the call it was writing did not run, and it was asked to make it again.`;
  return cut.retry
    ? `The ${who}'s reply was cut off at its length limit, so nothing of it could be used (${chf}); it was asked again.`
    : `The ${who}'s reply was cut off at its length limit again, so nothing of it could be used (${chf}).`;
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

/**
 * d1109-oversize-pause (OP-2, OP-4): what a paused run's kept work looked like when it stopped,
 * as its Run row keeps it (`{ kept }` artifact beside `{ handoff }`): the fingerprint of the files
 * it changed (`workHash`), and the project's own checks on it when they ran (data: each check's
 * output is its end, redacted before it is stored). `notRun` says why no check ran on a code
 * change (no sandbox here, it could not open). Named `RunKept` (not the estimates' `KeptWork`,
 * what a task's paused runs cost).
 */
export interface KeptCheck {
  name: string;
  passed: boolean;
  /** The end of its output, at most 1,500 characters, redacted; data, never instructions. */
  output: string;
}

export interface RunKept {
  hash: string;
  checks?: KeptCheck[];
  notRun?: string;
  /** OP-4: this pause got no further than the one before it (the next brief says so). */
  noProgress?: boolean;
}

/** A run's kept work as its artifact stores it. */
export function keptArtifact(kept: RunKept): {
  kept: { hash: string; checks?: KeptCheck[]; notRun?: string; noProgress?: boolean };
} {
  return {
    kept: {
      hash: kept.hash,
      ...(kept.checks ? { checks: kept.checks.map((c) => ({ ...c })) } : {}),
      ...(kept.notRun ? { notRun: kept.notRun } : {}),
      ...(kept.noProgress ? { noProgress: true } : {}),
    },
  };
}

/** The `{ kept }` artifact of a run's artifacts, or null (a run of before OP-2 has none). */
export function keptOf(artifacts: unknown): RunKept | null {
  if (!Array.isArray(artifacts)) return null;
  for (const a of artifacts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const k = (a as { kept?: unknown }).kept;
    if (!k || typeof k !== "object" || Array.isArray(k)) continue;
    const o = k as Record<string, unknown>;
    if (typeof o.hash !== "string") continue;
    const checks = Array.isArray(o.checks)
      ? o.checks
          .filter(
            (c): c is { name: string; passed: boolean; output?: unknown } =>
              !!c &&
              typeof c === "object" &&
              typeof (c as { name?: unknown }).name === "string" &&
              typeof (c as { passed?: unknown }).passed === "boolean",
          )
          .map((c) => ({
            name: c.name,
            passed: c.passed,
            output: typeof c.output === "string" ? c.output : "",
          }))
      : undefined;
    return {
      hash: o.hash,
      ...(checks ? { checks } : {}),
      ...(typeof o.notRun === "string" ? { notRun: o.notRun } : {}),
      ...(o.noProgress === true ? { noProgress: true } : {}),
    };
  }
  return null;
}

/**
 * OP-4 (the owner's "such that the work can be continued in the next run": continued, not
 * repeated): whether a pause got further than the last paused run of its task. It did when the
 * fingerprint of its kept work differs from that run's, or its "Left to do" list is shorter, or
 * (C2-left-3, run C3) what it said changed: its report, its "Where I stopped:" or its "Left to
 * do:" items (`said`, `pauseSaid`): a researcher's work is its report, and a run that wrote no
 * file but more findings got further. A first pause (no earlier paused run with a fingerprint)
 * counts as progress.
 */
export function madeProgress(
  now: { hash: string; leftToDo: number; said?: string },
  before: { hash: string; leftToDo: number; said?: string } | null,
): boolean {
  if (!before) return true;
  if (now.said !== undefined && before.said !== undefined && now.said !== before.said) return true;
  return now.hash !== before.hash || now.leftToDo < before.leftToDo;
}

/**
 * What a paused run said, as one text for `madeProgress` (C2-left-3): its report (the run row's
 * `{ report }` artifact) and its handoff's "Where I stopped:" and "Left to do:" items, trimmed;
 * the words are compared, never shown or given to a model.
 */
export function pauseSaid(artifacts: unknown, handoff: RunHandoff | null): string {
  let report = "";
  if (Array.isArray(artifacts))
    for (const a of artifacts)
      if (a && typeof a === "object" && !Array.isArray(a)) {
        const r = (a as { report?: unknown }).report;
        if (typeof r === "string") report = r.trim();
      }
  return [report, handoff?.stopped.trim() ?? "", ...(handoff?.leftToDo ?? []).map((t) => t.trim())]
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
