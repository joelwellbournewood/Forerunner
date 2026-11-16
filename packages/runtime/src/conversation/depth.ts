import type { ModelTier } from "../provider/types.ts";

/**
 * Chat thinks longer when it helps (d1109-chat-depth, ADR 0114; the owner's words of 2026-11-09:
 * "Chat should also be able to use more effort or a better model, selectively and transparently,
 * in order to be more useful, knowing that this will take more time to reply", and answer 2: "as
 * much as needed, but if it will switch models and do an expensive task, it should warn/ask
 * first. Model: whatever is appropriate."). This module holds the decisions that are words or
 * small rules: what the person's phrases ask for (`depthWords`), which rung a need takes
 * (`rungOfWhy`), the money and time words, every sentence the person reads about a longer answer,
 * and every text the model receives about it. The agent (agent.ts) decides with them; code
 * decides every rung, model, effort and amount, never the model or a record.
 */

/** The three ways chat answers above the quick one: the same model thinking longer, a stronger model, the strongest. */
export type Rung = "longer" | "stronger" | "best";

/** What a turn's depth was: the quick answer, or one of the rungs. */
export type Depth = "quick" | Rung;

/** Why the fast model hands a question over (`answer_thoroughly`'s enum: nothing it writes is kept). */
export const WHY_VALUES = [
  "many_records",
  "failure",
  "plan",
  "comparison",
  "review",
  "asked",
] as const;
export type Why = (typeof WHY_VALUES)[number];

/**
 * The rung a need takes (the owner's answer 2: "Model: whatever is appropriate"): many records
 * and the person's plain ask think longer on the same model; a failure, a plan, a comparison or a
 * review takes the stronger model. The best rung is only ever the person's ask or their yes under
 * a stronger answer that ran out of room (a deliberate limit: no classifier tells a question that
 * needs Opus from one Sonnet answers well).
 */
export function rungOfWhy(why: Why): Exclude<Rung, "best"> {
  return why === "many_records" || why === "asked" ? "longer" : "stronger";
}

/** What the person's words ask for: a rung, a quick answer, or nothing. */
export interface DepthAsk {
  ask: Rung | "quick" | null;
  /** The line is the phrase alone ("think harder"): it re-asks the person's previous line. */
  bare: boolean;
}

const LONGER_PHRASES = [
  "think it through",
  "think this through",
  "think that through",
  "think harder",
  "think longer",
  "think carefully",
  "take your time",
  "be thorough",
  "look into it properly",
  "look into this properly",
  "in depth",
  "in detail",
  "denk gründlich nach",
  "denk gruendlich nach",
  "nimm dir zeit",
];
const STRONGER_PHRASES = [
  "use a stronger model",
  "use a better model",
  "use a smarter model",
  "use sonnet",
  "with a stronger model",
  "with sonnet",
];
const BEST_PHRASES = [
  "use the best model",
  "use the strongest model",
  "use your best model",
  "use opus",
  "with the best model",
  "with opus",
];
const QUICK_PHRASES = ["quick", "quickly", "briefly", "in one line", "in short", "kurz"];

/** The line with quoted text taken out: a phrase in quotes is a title, never an ask. */
function outsideQuotes(line: string): string {
  return line.replace(/"[^"]*"|“[^”]*”|'[^']*'(?=\W|$)/g, " ");
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Which phrase of `list` the line starts or ends with (outside quotes), if any: "think it through:
 * why …", "… be thorough". A phrase in the middle of a sentence ("add a task: be thorough with the
 * tests" is a command the parser takes first) or inside quotes ("why did \"Think harder\" fail?")
 * asks for nothing.
 */
function edgePhrase(
  line: string,
  list: readonly string[],
): { phrase: string; rest: string } | null {
  const said = norm(outsideQuotes(line));
  for (const p of [...list].sort((a, b) => b.length - a.length)) {
    if (said === p) return { phrase: p, rest: "" };
    if (said.startsWith(`${p} `)) return { phrase: p, rest: said.slice(p.length).trim() };
    if (said.endsWith(` ${p}`)) return { phrase: p, rest: said.slice(0, -p.length).trim() };
  }
  return null;
}

/**
 * What the person's line asks of the answer's depth (d1109-chat-depth): words at the start or end
 * of the line, outside quotes. "think it through", "take your time", "be thorough", "denk gründlich
 * nach" ask the longer rung; "use a stronger model", "use Sonnet" the stronger; "use the best
 * model", "use Opus" the best; "quick", "briefly", "in one line", "kurz" keep the quick answer. A
 * line that is the phrase alone is `bare`: it re-asks the person's previous line.
 */
export function depthWords(line: string): DepthAsk {
  for (const [list, ask] of [
    [BEST_PHRASES, "best"],
    [STRONGER_PHRASES, "stronger"],
    [LONGER_PHRASES, "longer"],
  ] as const) {
    const hit = edgePhrase(line, list);
    if (hit) return { ask, bare: hit.rest === "" || /^(please|bitte)$/.test(hit.rest) };
  }
  const quick = edgePhrase(line, QUICK_PHRASES);
  if (quick?.rest) return { ask: "quick", bare: false };
  return { ask: null, bare: false };
}

/** A model's name as the person reads it: "Sonnet", never "claude-sonnet-5-5" or a tier word. */
export function modelName(tier: ModelTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** Whole centimes of a USD micro amount at the day's rate, rounded up (an "at most" never rounds down). */
export function centimesUp(usdMicro: number, chfPerUsd: number): number {
  const chfMicro = Math.max(0, usdMicro) * chfPerUsd;
  return Math.ceil(chfMicro / 10_000 - 1e-9);
}

/** "CHF 0.15" for an amount, rounded up to the centime (CHF only, design §5 rule 7). */
export function chfUp(usdMicro: number, chfPerUsd: number): string {
  return `CHF ${(centimesUp(usdMicro, chfPerUsd) / 100).toFixed(2)}`;
}

/** A spent amount in a footer: "CHF 0.06", or "under CHF 0.01" below a centime (w15-words). */
export function chfSpent(usdMicro: number, chfPerUsd: number): string {
  const chfMicro = Math.max(0, usdMicro) * chfPerUsd;
  if (chfMicro < 10_000) return "under CHF 0.01";
  return `CHF ${(Math.round(chfMicro / 10_000) / 100).toFixed(2)}`;
}

/** USD micro of a CHF amount at the day's rate. */
export function chfToUsdMicroAt(chf: number, chfPerUsd: number): number {
  return Math.round((Math.max(0, chf) * 1_000_000) / (chfPerUsd > 0 ? chfPerUsd : 1));
}

/** The "at most" a yes covers: twice the estimate, rounded up to the centime, never below `floor`. */
export function atMostOf(
  estimateUsdMicro: number,
  floorUsdMicro: number,
  chfPerUsd: number,
): number {
  const twice = chfToUsdMicroAt(centimesUp(2 * estimateUsdMicro, chfPerUsd) / 100, chfPerUsd);
  return Math.max(twice, floorUsdMicro);
}

/** A longer answer's time when none was measured yet (the five-call estimate's partner). */
export const DEFAULT_THOROUGH_SECONDS = 30;

/**
 * How long a longer answer takes in words: rounded up to 10 seconds ("about 30 seconds"), "a
 * minute" from 55 seconds on (design §5 rule 1: read at a glance).
 */
export function secondsWords(seconds: number): string {
  if (seconds >= 55) return "a minute";
  return `${Math.max(10, Math.ceil(seconds / 10) * 10)} seconds`;
}

/** Whether the credential a pass runs on is the person's Claude plan (words name the plan). */
export interface CredentialWords {
  /** The credential chat would use now. */
  kind: "subscription" | "api_key" | "plan_credits" | "other";
  /** It is not the person's first choice: the first rests or was refused. */
  notFirst?: { firstKind: CredentialWords["kind"] } | null;
}

const credentialName = (k: CredentialWords["kind"]): string =>
  k === "subscription"
    ? "your Claude subscription"
    : k === "api_key"
      ? "your API key"
      : k === "plan_credits"
        ? "your plan credits"
        : "your other Claude credential";

/** The figures an ask line, a hand-over step or a footer names. */
export interface PassFigures {
  rung: Rung;
  /** The model the pass uses. */
  tier: ModelTier;
  /** The pass's model is the fast pass's (thinking longer on the same model). */
  sameModel: boolean;
  estimateUsdMicro: number;
  atMostUsdMicro: number;
  seconds: number;
  chfPerUsd: number;
  credential?: CredentialWords | null;
}

/**
 * The line that asks before a pass (the ask rule, the owner's answer 2): a switch of model, an
 * estimate above the person's amount, or a credential that is not their first. One line with the
 * cost and the time; Go ahead under it. On a Claude plan the time and the amount at API prices.
 */
export function askLine(f: PassFigures): string {
  const what = f.sameModel
    ? "a closer look"
    : f.rung === "best"
      ? "the strongest model"
      : "a stronger model";
  const time = secondsWords(f.seconds);
  if (f.credential?.kind === "subscription" && !f.credential.notFirst)
    return `This needs ${what}: about ${time} on your Claude plan (about ${chfUp(f.estimateUsdMicro, f.chfPerUsd)} at API prices). Go ahead?`;
  const on = f.credential?.notFirst
    ? ` on ${credentialName(f.credential.kind)} while ${credentialName(f.credential.notFirst.firstKind)} rests`
    : "";
  return `This needs ${what}${on}: about ${chfUp(f.estimateUsdMicro, f.chfPerUsd)} (at most ${chfUp(f.atMostUsdMicro, f.chfPerUsd)}) and ${time}. Go ahead?`;
}

/** The step when the pass starts: with which model, about how long, at most what (its budget). */
export function handOverStep(f: PassFigures & { budgetUsdMicro: number }): string {
  const who = f.sameModel ? "more carefully" : `with ${modelName(f.tier)}`;
  const time = secondsWords(f.seconds);
  if (f.credential?.kind === "subscription")
    return `Thinking it through ${who} on your Claude plan: about ${time}.`;
  return `Thinking it through ${who}: about ${time}, at most ${chfUp(f.budgetUsdMicro, f.chfPerUsd)}.`;
}

/** The step when the pass hears the wrap-up. */
export const WRAP_UP_STEP = "Answering with what I found…";
/** The step when the person pressed Stop and the run is ending. */
export const STOPPING_STEP = "Stopping…";

/** The muted line under a longer answer: its model, its time, its cost (design §3.9). */
export function footerWords(o: {
  tier: ModelTier;
  sameModel: boolean;
  durationMs: number;
  costUsdMicro: number;
  chfPerUsd: number;
  subscription?: boolean;
}): string {
  const who = o.sameModel ? "more carefully" : `with ${modelName(o.tier)}`;
  const secs = Math.max(1, Math.round(o.durationMs / 1000));
  const money = o.subscription ? "on your Claude plan" : chfSpent(o.costUsdMicro, o.chfPerUsd);
  return `Thought it through ${who} · ${secs} s · ${money}`;
}

/** The line under an answer the person stopped. */
export function stoppedWords(costUsdMicro: number, chfPerUsd: number): string {
  return `You stopped this answer: ${chfSpent(costUsdMicro, chfPerUsd)} spent.`;
}

/** Under a quick answer whose hand-over was refused: what a closer look would take, with Think it through. */
export function closerLookWords(
  f: Pick<PassFigures, "seconds" | "estimateUsdMicro" | "chfPerUsd">,
): string {
  return `This needs a closer look: about ${secondsWords(f.seconds)}, about ${chfUp(f.estimateUsdMicro, f.chfPerUsd)}.`;
}

/** Which outer cap leaves too little for a closer look. */
export type CapLevel = "month" | "project" | "plan";

/** The cap line under a quick answer (the room checks of the gate). */
export function capWords(level: CapLevel): string {
  switch (level) {
    case "month":
      return "A closer look would pass this month's cap, so this is the quick answer.";
    case "project":
      return "A closer look would pass this project's budget, so this is the quick answer.";
    case "plan":
      return "A closer look would pass the share of your Claude plan Forerunner may use, so this is the quick answer.";
  }
}

/**
 * Think it through's consequence line (design §3: one line per action): about how long and the
 * "at most" the press allows (the press is the person's yes for it).
 */
export function thinkItThroughExplain(
  f: Pick<PassFigures, "seconds" | "atMostUsdMicro" | "chfPerUsd" | "credential">,
): string {
  const time = secondsWords(f.seconds);
  if (f.credential?.kind === "subscription" && !f.credential.notFirst)
    return `Thinks longer on this model: about ${time} on your Claude plan, at most ${chfUp(f.atMostUsdMicro, f.chfPerUsd)} at API prices.`;
  return `Thinks longer on this model: about ${time}, at most ${chfUp(f.atMostUsdMicro, f.chfPerUsd)}.`;
}

/** A person's line Forerunner closed on before answering (a restart): with Ask again. */
export const CLOSED_WORDS = "Forerunner closed before answering this.";
/** A person's line whose answer failed while Forerunner ran: with Ask again. */
export const FAILED_WORDS = "I could not answer this.";
/** A spoken ask to think longer: a longer answer is the chat's, typed. */
export const VOICE_THOROUGH_NOTICE = "I can think that through in the chat: type it there.";
/** "think harder" with no question before it in this conversation. */
export const THINK_THROUGH_WHAT = "Think through what? Ask your question first.";
/** Stop's consequence line (the button's title). */
export const STOP_EXPLAIN = "Stops this answer. Changes it already made stay, each with Undo.";
/** A chat answer its time limit cut off (L3-left-11: was "I could not answer (run timeout).") */
export const TIMEOUT_REPLY =
  "I ran out of time before I could answer. Ask again, or ask for a shorter answer.";

// ---------------------------------------------------------------------------------------------
// What the model receives (code, asserted verbatim on the requests).

/** answer_thoroughly's definition: the fast model's one way to ask for a longer answer. */
export const ANSWER_THOROUGHLY_DESCRIPTION =
  "Hand this question to a stronger model that thinks it through and can look up more. It is slower (often half a minute) and costs more, within limits the app sets. Use it only when a good answer needs reasoning across many records (several sessions, tasks or days), working out why something keeps failing and what to change, a plan, a comparison, a review or a recommendation, or when the person asks you to think harder. Never for what is running, what is left, one record, a greeting or a change. Call it first, before any lookup, and write nothing before it. The app decides: it hands the question over, asks the person first, or tells you to answer from what you have. The facts' thinking_longer line says whether it is available now.";

/** The tool's name (in the fast pass's list after the recall tools; never in the thorough pass's). */
export const ANSWER_THOROUGHLY_TOOL = "answer_thoroughly";

/** What the fast model hears when the person is asked first. */
export const ASK_RESULT =
  "Not yet: the person is asked first. Answer in one or two sentences from what you have; the app adds the question under your answer.";

/** What the fast model hears when the gate refuses (the reason in words). */
export function notNowResult(reason: string): string {
  return `Not now: ${reason}. Answer as well as you can from what you have; the app offers a closer look under your answer.`;
}

/** The gate's reasons, as the model hears them. */
export const NOT_NOW = {
  spoken: "this is a spoken turn",
  quick: "the person asked for a quick answer",
  records: "this turn already read records",
  room: "the caps leave too little for a closer look",
  rung: "no stronger model or effort is available here",
} as const;

/** The hand-over's own result (the fast run ends with it; no later call reads it). */
export const HANDED_OVER_RESULT = "Handed over: the closer look answers this question.";

/** The thorough pass's own rules, after the fast pass's in its system part. */
export const CHAT_THOROUGH_RULES = `# Thinking it through
This question was handed to you to think through; the person waits and sees what you look up. Look up what the answer rests on with recall, recall_open and the read tools, a few lookups at most. Then answer in at most six short sentences, or a short list whose lines start with "- ". Say what the answer rests on (sessions, tasks, cards, decisions or documents, by name and date), keep what the records say apart from what you conclude, and say what you could not check. When you suggest a next step, name one the app can do; make a change only when the person asked for it. When the app says to wrap up, answer from what you have.`;

/** The wrap-up a thorough pass hears once, through the loop's wrapUp option (ADR 0112's mechanism). */
export const CHAT_WRAP_UP =
  "Wrap up now: make no more lookups. Answer from what you have, and say in one sentence what you could not check.";

/** The facts' thinking_longer line: whether a closer look is available now, in the model's words. */
export function thinkingLongerFact(
  o:
    | { state: "goes_ahead"; amountUsdMicro: number; chfPerUsd: number }
    | { state: "asks" | "spoken" | "room" | "none" },
): string {
  switch (o.state) {
    case "goes_ahead":
      return `goes ahead up to ${chfUp(o.amountUsdMicro, o.chfPerUsd)} on this model`;
    case "asks":
      return "asks the person first";
    case "spoken":
      return "not on a spoken turn";
    case "room":
      return "not now (the caps leave too little)";
    case "none":
      return "not available here";
  }
}

/** The person's amount by default: CHF 0.10 (the session lead's reading of "expensive"). */
export const DEFAULT_ASK_ABOVE_CHF = 0.1;

/** The setting's value in words. */
export function askAboveWords(chf: number): string {
  return chf <= 0 ? "asks before every longer answer" : `asks first above CHF ${chf.toFixed(2)}`;
}
