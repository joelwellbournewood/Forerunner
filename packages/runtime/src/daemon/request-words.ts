import type { HumanRequestRow, JsonObject } from "@forerunner/state";
import { chfText } from "../money-words.ts";
import {
  askCardWords,
  askClosedLine,
  refusedBody,
  refusedClosedLine,
} from "../session/credential-words.ts";
import { moneyWords } from "../session/money-words.ts";
import {
  isPreparedOutcome,
  type PreparedContext,
  preparedClause,
  preparedExplain,
} from "../session/prepared-work.ts";
import {
  ANSWER_CARD_KEYS,
  blockedFindingsAnswer,
  budgetStopAnswer,
  cannotRunAnswer,
  normalAnswer,
  offersGoAheadWithout,
  optionLabel,
  signoffAnswer,
} from "../wiring/request-answers.ts";
import { balancedCut } from "./quoted-title.ts";
import { TAKE_OUT_NOTICE_PREFIX, takeOutConflictBody } from "./take-out-words.ts";
import {
  proposalOutcome,
  TASK_PROPOSAL_KEY,
  TASK_PROPOSAL_OPTIONS,
} from "./task-proposal-words.ts";
import { withoutNoActionGiven } from "./task-words.ts";

/*
 * What an Inbox card says and offers (design §3.8, core-experience.md), with no store and
 * nothing that needs Node: the daemon's `requestView`, the UI's stand-in daemon
 * (`apps/ui/test/fake-daemon.ts`) and the screens read the same words. A card has a title naming
 * its task, one or two sentences of what and why, its options as buttons each with a
 * consequence line (the safe or likely one primary, a destructive one secondary and confirmed),
 * a text box only where free text is accepted, and, once answered, one line of what happens
 * next. No change-card JSON, no risk or kind badges.
 */

/** One button of a card: the words it shows and sends, what it does, how it looks. */
export interface RequestChoiceWords {
  /** What the button says; a click sends exactly this as the answer (`choice`). */
  label: string;
  /** One line of what happens (design §5: at most 100 characters), or null. */
  explain: string | null;
  tone: "primary" | "secondary" | "danger";
  /** Asked once before the answer is sent, for a destructive or surprising choice. */
  confirm: string | null;
  /**
   * A text the choice carries: `note`, an optional note for the next attempt sent with it
   * (`{ choice, note }`); `text`, words the choice needs (the plan's change); null, none.
   */
  input: "note" | "text" | null;
  /**
   * One line the card shows while this choice's answer is being sent, where that takes a while
   * ("Writing the plan and its docs pull request…", L-20); absent: nothing is said.
   */
  working?: string | null;
}

/** A link a card offers that is not an answer (Set up Docker opens Settings). */
export interface RequestLinkWords {
  label: string;
  to: string;
  explain: string | null;
}

export interface RequestWords {
  /** The card's title, naming the task (or what it is about). */
  title: string;
  /**
   * d1109-selftasks-chat (SC-9): the details are what the card asks about (the agent's
   * suggested changes), so they show open, never under a collapsed Details.
   */
  openDetails?: boolean;
  /** One or two sentences: what and why, in the specialist's own words where there are any. */
  body: string | null;
  choices: RequestChoiceWords[];
  links: RequestLinkWords[];
  /**
   * `text`: the card takes an answer in the person's own words; `form`: the questions form;
   * `none`: only its buttons.
   */
  reply: "none" | "text" | "form";
  /** Longer detail, shown under Details (the critic's findings, the steps). */
  details: string[];
  /**
   * Items the card lists whole under its body, each list with its label (a paused run's "Where it
   * stopped" and "Left to do", L3-research-2: run together into one sentence they were cut in
   * mid-phrase). Absent on cards that list nothing.
   */
  lists?: RequestListWords[];
  /** Once answered or withdrawn: what happened and what is next, in one line; null while open. */
  outcome: string | null;
  /**
   * What the person can do next about an answered card, where there is something: answers that
   * came after their task had finished offer "Redo with these answers" (the task's Redo, Reopen or
   * Try again; its next brief carries the answers). Null otherwise.
   */
  followUp?: { label: string; explain: string; action: "redo" | "reopen" | "try_again" } | null;
  /**
   * l4-starts-sessions (L4-money-202): the form's own button (`reply: 'form'`) with its
   * one-line consequence, read when the card is shown like every option that prepares work
   * (S-9): "Send answers" / "The task goes on with your answers; it runs at your next Start.".
   * Absent on cards without a form.
   */
  submit?: { label: string; explain: string } | null;
}

/** A list a card shows under its body: its label ("Left to do") and its items, each whole. */
export interface RequestListWords {
  label: string;
  items: string[];
}

/** What the card needs beyond its row, read when it is shown (true now, design §5 rule 4). */
export interface RequestWordsContext {
  projectName?: string | null;
  taskTitle?: string | null;
  /** The task's status now (an answered card's line says what became of it). */
  taskStatus?: string | null;
  /** Titles of the tasks not done that wait on the card's task. */
  waiting?: readonly string[];
  /** The person made the task's last change (a withdrawn card says "you moved the task"). */
  movedByYou?: boolean;
  /**
   * A refused credential's card (U-078): the credential its task work goes on with now, when
   * the person chose "When my first choice runs out mid-session: use the other one" and another
   * one can serve; null or absent under 'Wait', where the work waits for a new one.
   */
  credentialGoesOn?: string | null;
  /**
   * d1109-cred-engine CE-8 (ADR 0120): a refused credential's card, read when it is shown: the
   * refusal's category (never the provider's words), the person's rule at a stop, the credential
   * that can take the work (null: none), and under 'ask' what the waiting work's next calls cost
   * on the API key. The card says what the work does until a new one is saved.
   */
  /**
   * CE-7: an ask card's facts read when it is shown: the person's clock, whether their session
   * waits for this stop (it goes on by itself after a Wait), and when it goes on when their quiet
   * hours end later than the stop.
   */
  credentialAsk?: {
    timezone?: string;
    nowMs: number;
    sessionWaits: boolean;
    goesOnAt?: string;
  } | null;
  credentialRefused?: {
    category: "signed_out" | "invalid_key" | "not_allowed" | "other" | null;
    rule: "wait" | "next" | "ask";
    other: string | null;
    estimateChf?: string;
  } | null;
  /**
   * The card's project works on a repository (its approved plan's docs go in as a pull
   * request): the plan card's line while Approve and start works says so (L-20).
   */
  projectRepository?: boolean;
  /**
   * A budget card's task holds work its Cancel sets aside (W15-56, `taskHeldWork`, read when the
   * card is shown): false when its run wrote nothing, so the card promises no set-aside and keeps
   * nothing; absent when not read (worded as before).
   */
  heldWork?: boolean;
  /**
   * d1109-starts-engine (S-9): a session runs now, of the card's project or of another one, read
   * when the card is shown; an option that prepares work says what happens next by it.
   */
  running?: PreparedContext["running"];
  /** The card's project starts a session by itself when work is ready (S-5). */
  startsByItself?: boolean;
  /** The person's own session waits to go on for this project (S-10). */
  continuationWaits?: boolean;
  /** Stop all is on: the hands-off setting starts nothing (S-5). */
  stopped?: boolean;
  /** The person's quiet hours hold a start they did not press now (S-1). */
  quiet?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * A model's words without their markdown (W15-61, W15-57; design §5 rule 6): backticks, emphasis
 * and list marks dropped, a leading colon or dash too, on one line. Data stays data: only marks go.
 */
export function withoutMarkdown(text: string): string {
  return text
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g, "$1")
    .replace(/^[\s:;,.\-–—*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A findings list's severity tag at the start of a quoted sentence ("blocker:", "**major**:",
 * "Critical -"), which the reviewers' reports put before each item.
 */
const FINDING_TAG =
  /^(?:blocker|blocking|critical|major|minor|high|medium|low|nit(?:pick)?|info|warning|error|issue|gap|risk)s?\s*(?::|-|–|—)\s+/i;

/**
 * Why a specialist asks or failed, as a card quotes it (l3-small, run L3; live check 3,
 * L3-research-3: 'The specialist said: "blocker: notes/plan.md is missing."'): its words
 * without markdown and without a findings tag before them. Where a tag was taken off, the
 * sentence it left starts with a capital ("blocker: missing ..." reads "Missing ..."), never a
 * file name ("notes/plan.md is missing.") or a word that was in code marks ("`npm test` fails"
 * reads "npm test fails"); a reason with no tag keeps its own case ("git push was refused").
 */
export function specialistReason(text: string): string {
  const plain = withoutMarkdown(text);
  const t = plain.replace(FINDING_TAG, "").trim();
  if (t === plain.trim()) return t;
  const word = /^[a-z]+\b(?![./\\])/.exec(t)?.[0];
  if (!word || text.includes(`\`${word}`)) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * W15-57: an item of a paused run's note as the budget card quotes it: plain words, a list's
 * heading colon dropped, and cut at a word well under what the card kept (`cardHandoff` cut it at
 * 80 or 160 characters, mid-word: "rounds(players…"), so a stored cut never shows.
 */
function cardItem(text: string, max: number): string {
  let t = withoutMarkdown(text);
  // A stored cut: the word it fell in is dropped ("... using upd…" -> "... using…").
  const stored = /…$/.test(t);
  if (stored)
    t = t
      .replace(/…$/, "")
      .replace(/\s*\S*$/, "")
      .replace(/[\s,;:]+$/, "");
  t = t.replace(/[\s:]+$/, "");
  if (t.length > max) return cutWords(t, max);
  return stored ? `${t}…` : t;
}

/** A title as a line names it: whole when short, else cut at a word. */
export function cutWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A task title in quotes, cut at a word, never inside a quote of its own (L3-github-9). */
const q = (title: string) => `"${balancedCut(title, 50, cutWords)}"`;

/** '"A" waits on it.' / '3 tasks wait on it: "A", "B" and 1 more.' (design §5 rule 5). */
export function waitingSentence(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length === 1) return `${q(titles[0] as string)} waits on it.`;
  const named = titles.slice(0, 2).map(q);
  const more = titles.length - named.length;
  return `${titles.length} tasks wait on it: ${named.join(", ")}${more ? ` and ${more} more` : ""}.`;
}

/** What Cancel does to what waits (design §3.5, §3.8): "Drops it; the 2 tasks after it will be stuck." */
function cancelExplain(waiting: readonly string[]): string {
  if (waiting.length === 0) return "Drops it. Nothing waits on it.";
  if (waiting.length === 1) return `Drops it; ${q(waiting[0] as string)} after it will be stuck.`;
  return `Drops it; the ${waiting.length} tasks after it will be stuck.`;
}

/** 'Cancel "X"? "A" waits on it and will be stuck.' asked once before a Cancel task. */
function cancelConfirm(task: string, waiting: readonly string[]): string {
  const stuck =
    waiting.length === 0
      ? ""
      : waiting.length === 1
        ? ` ${q(waiting[0] as string)} waits on it and will be stuck.`
        : ` The ${waiting.length} tasks after it will be stuck.`;
  return `Cancel ${q(task)}?${stuck}`;
}

/** What "Mark done" does to what waits. */
function afterDone(waiting: readonly string[]): string {
  if (waiting.length === 0) return "";
  if (waiting.length === 1) return ` ${q(waiting[0] as string)} after it will run.`;
  return ` The ${waiting.length} tasks after it will run.`;
}

/**
 * Where a text's first sentence ends: after the first ".", "!", "?" or ":" followed by a space
 * or the end, outside double quotes (P7-26: a quoted task title with ": " in it, 'Change "Write
 * the README: how to open it"', was cut inside the quotes). -1 when there is none. A colon after
 * a single word ends no sentence (W15-77: "undo: web pages research may read …" was titled
 * "undo"): the word is a label of what follows.
 */
function firstSentenceEnd(t: string): number {
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (c === '"') quoted = !quoted;
    else if (!quoted && ".!?:".includes(c) && i > 0 && (i + 1 === t.length || t[i + 1] === " ")) {
      if (c === ":" && !/\s/.test(t.slice(0, i).trim())) continue;
      return i;
    }
  }
  return -1;
}

/** The first sentence of a text (the title of a card with no title of its own). */
function firstSentence(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  const end = firstSentenceEnd(t);
  return cutWords((end >= 0 ? t.slice(0, end + 1) : t).replace(/[.:]$/, ""), max);
}

/** The rest of a text after its first sentence (the body of a card titled by that sentence). */
function afterFirstSentence(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  const end = firstSentenceEnd(t);
  if (end < 0) return null;
  const rest = t.slice(end + 1).trim();
  return rest || null;
}

/** A finding line as a person reads it: no "[high]" tag, no "Required:" machine words. */
function plainFinding(step: string): string {
  // A finding the critic named no fix for reads as what it found (L3-research-3).
  return withoutNoActionGiven(step)
    .replace(/^\[(?:critical|high|medium|low|info)\]\s*/i, "")
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/\s*(?:->|:)\s*/, ": ")
    .trim();
}

function keyOf(card: unknown): string | null {
  return isRecord(card) ? str(card.key) : null;
}

/**
 * Withdrawn, expired: the line an Answered entry shows. A card is withdrawn when its task moved
 * on (the person's move, which the task's last change says) or when it no longer applies.
 */
function closedLine(r: Pick<HumanRequestRow, "status">, ctx: RequestWordsContext): string | null {
  if (r.status === "withdrawn")
    return ctx.movedByYou
      ? "Withdrawn: you moved the task, so this card was closed."
      : "Closed: it no longer needs you.";
  if (r.status === "expired") return "Expired: nobody answered it in time.";
  return null;
}

/**
 * What became of a change waiting for its yes (the commands executor's card: a Settings
 * confirmation, a chat read-back), once answered (phase C leftover C-29: every one read
 * "Answered.", whether the change was made or the preview was closed with No). A yes says the
 * change in its own done sentence ("Raised the monthly cap from CHF 100 to CHF 200."); a no
 * says nothing changed; a yes the registry refused says why.
 */
function changeCardOutcome(card: JsonObject, answer: unknown): string | null {
  if (typeof card.command !== "string") return null;
  if (card.decision !== "needs_yes" && card.decision !== "needs_device") return null;
  const verdict = isRecord(answer) ? str(answer.verdict) : null;
  if (verdict === "declined") return "You said no; nothing changed.";
  if (verdict === "refused") {
    const reason = isRecord(answer) ? str(answer.reason) : null;
    return `Not changed: ${reason ? cutWords(reason.replace(/[.\s]+$/, ""), 100) : "it could not be made"}.`;
  }
  if (verdict === "confirmed") {
    const sentence = str(card.sentence);
    return sentence ? cutWords(sentence, 160) : "Changed as you confirmed.";
  }
  return null;
}

/**
 * A hooks approval answered after its session ended (ADR 0088 amended by 0118): its yes made the
 * task ready, prepared like every answer (S-2): "Allowed: it runs at your next Start.".
 */
function lateApprovalOutcome(card: JsonObject): string | null {
  if (!/^.+:[0-9a-f]{64}$/.test(str(card.key) ?? "")) return null;
  if (!isPreparedOutcome(card.start) && card.start_by !== "hands_off") return null;
  const next = preparedClause(card.start, card.start_by);
  return next ? `Allowed: ${next}.` : null;
}

/** The answer as the person gave it: the option's words, never JSON. */
export function answerWords(answer: unknown): string | null {
  if (typeof answer === "string") return answer.trim() || null;
  if (isRecord(answer)) {
    for (const k of ["choice", "option", "answer", "decision", "text"]) {
      const v = str(answer[k]);
      if (v) return v;
    }
    if (Array.isArray(answer.answers)) return "your answers";
  }
  return null;
}

/**
 * What became of the work an answer made runnable, as the clause its Done line ends with
 * (d1109-starts-engine S-2, S-12): prepared work ("it runs at your next Start", "it joins the
 * session that is running"), a session the hands-off setting started (`start_by`), or, for the
 * person's own start (Approve and start, Continue) and the cards answered before run C, the
 * start's outcome ("a session started").
 */
function startWords(start: unknown, by?: unknown): string | null {
  if (isPreparedOutcome(start) || by === "hands_off") return preparedClause(start, by);
  if (start === "started") return "a session started";
  if (start === "queued") return "it runs after the current session";
  if (start === "deferred") return "it runs after quiet hours";
  if (start === "failed") return "the session did not start: press Start on the project";
  return null;
}

// ---------------------------------------------------------------------------------------
// The cards

/** A failed task, the retry ladder's last card and the critic's cards whose work did not pass. */
function retryCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options" | "change_card" | "status" | "answer">,
  card: JsonObject,
  ctx: RequestWordsContext,
  read: (label: string) => "accept" | "revise" | "cancel" | null,
): RequestWords {
  const task = ctx.taskTitle ?? "the task";
  const waiting = ctx.waiting ?? [];
  const verdict = card.reason === "verdict";
  const title = str(card.title) ?? firstSentence(r.why);
  const said = str(card.said);
  const saidBy = str(card.said_by);
  const first = said
    ? saidBy
      ? `The ${saidBy} said: "${specialistReason(said).replace(/"/g, "'")}"`
      : card.reason === "failed"
        ? `What failed: ${said}`
        : said
    : (afterFirstSentence(r.why) ?? null);
  const body = [first, waitingSentence(waiting)].filter(Boolean).join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = read(option);
    if (what === "revise")
      choices.push({
        label: verdict ? "Send it back" : "Try again",
        // S-9 (ADR 0118): an answer prepares the work; it says what happens next, true now.
        explain: verdict
          ? `Reworks it with the critic's findings; ${preparedExplain(ctx)}.`
          : `Tries again with your note, if any; ${preparedExplain(ctx)}.`,
        tone: "primary",
        confirm: null,
        input: "note",
      });
    else if (what === "accept")
      choices.push({
        label: verdict ? "Accept the work" : "Mark done anyway",
        explain: verdict
          ? `Closes it as done.${afterDone(waiting)}`
          : `Closes it although nothing passed review.${afterDone(waiting)}`,
        tone: verdict ? "primary" : "secondary",
        confirm: verdict ? null : `Mark ${q(task)} done although nothing passed review?`,
        input: null,
      });
    else if (what === "cancel")
      choices.push({
        label: "Cancel task",
        explain: cancelExplain(waiting),
        tone: "danger",
        confirm: cancelConfirm(task, waiting),
        input: null,
      });
  }
  // The sign-off's answer first ("Accept the work"), a retry card's "Try again" first.
  choices.sort((a, b) => toneRank(a.tone) - toneRank(b.tone));
  return {
    title,
    body,
    choices,
    links: [],
    reply: "none",
    details: r.steps.map(plainFinding).filter(Boolean),
    outcome: null,
  };
}

const toneRank = (t: RequestChoiceWords["tone"]) =>
  t === "primary" ? 0 : t === "secondary" ? 1 : 2;

/**
 * l4-starts-sessions (L4-money-205): what a Done or Answered line says after "is done" about the
 * work its answer prepared (the one helper for every such line), true when the line is read: of
 * `subject` ("what waits on it", "what comes after it"), never of the done task itself; nothing
 * once nothing waits on the task (live check 4 read "what waits on it joins the session that is
 * running." with nothing waiting and nothing running); a join only while a session of the project
 * runs, else the person's next Start; the hands-off setting's start as it happened, after the
 * task's end ("a session started for what comes after it (...)", never "what comes after it a
 * session started for it"). Null for a card answered before run C (its caller keeps its words).
 */
function afterDoneWords(
  card: JsonObject,
  ctx: RequestWordsContext,
  subject: string,
): string | null {
  const handsOff = card.start_by === "hands_off";
  if (!isPreparedOutcome(card.start) && !handsOff) return null;
  const started = startWords(card.start, card.start_by);
  if (!started) return null;
  if (ctx.waiting && ctx.waiting.length === 0) return null;
  if (handsOff) return started.replace(/\bfor it\b/, `for ${subject}`);
  if (card.start === "joined" && ctx.running !== undefined && ctx.running !== "this_project")
    return `${subject} runs at your next Start`;
  return started.replace(/^it /, `${subject} `);
}

function retryOutcome(card: JsonObject, ctx: RequestWordsContext, verdict: boolean): string | null {
  const task = q(ctx.taskTitle ?? "the task");
  const started = startWords(card.start, card.start_by);
  switch (card.outcome) {
    case "revise":
    case "rework":
      return `Trying ${task} again${started ? `: ${started}` : ": the next session runs it"}.`;
    case "accept": {
      // S-2: what comes after it is prepared, not started ("; what comes after it runs at your
      // next Start"); a card answered before run C kept its start's words. L4-money-205: said
      // only while something comes after it, true when read (`afterDoneWords`).
      const prepared = isPreparedOutcome(card.start) || card.start_by === "hands_off";
      const words = prepared ? afterDoneWords(card, ctx, "what comes after it") : null;
      const after = words
        ? `; ${words}.`
        : started && !prepared
          ? `. What comes after it runs now: ${started}.`
          : ".";
      return verdict
        ? `${task} is done${after}`
        : `${task} is done: accepted without review${after}`;
    }
    case "cancel":
      return `${task} was cancelled.`;
    case "task_moved_on":
    case "stale":
      return `${task} had moved on already, so nothing changed.`;
    case "findings_open":
      return `${task} could not be closed: a newer review found problems.`;
    default:
      return null;
  }
}

/** The questions only the person can answer (U-022): the form, Go ahead without, Cancel task. */
function questionsCard(card: JsonObject, ctx: RequestWordsContext): RequestWords {
  const task = ctx.taskTitle ?? str(card.task_title) ?? "the task";
  const waiting = ctx.waiting ?? [];
  // The person's own task: no specialist decides in their place, so no Go ahead without.
  const planned = !offersGoAheadWithout(card);
  // Why it asks, in its own words (L-12). A card filed before 2026-11-02 may hold the report's
  // first words with the heading's colon (': I made no edits…'): the quote starts at a word.
  // W15-61 (design §5 rule 6): the specialist's words without their markdown (live: "a bare
  // `node wc.js`", "**Summary**"), backticks, emphasis and list marks dropped.
  const raw = str(card.context);
  const context = raw ? specialistReason(raw) : undefined;
  const body =
    [
      planned
        ? "No specialist works on it: your answers are written to the project's decision record and the task is done."
        : context
          ? `The specialist said: "${cutWords(context.replace(/"/g, "'"), 160)}"`
          : "The specialist needs your answers before it can go on.",
      waitingSentence(waiting),
    ]
      .filter(Boolean)
      .join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  // Not offered again once the person went ahead without on the task (live L-3): the work then
  // needs what it asks for (a missing input), and going ahead again only ran the same ask.
  // L4-money-202 (S-9 extended): Go ahead without and Send answers prepare the work, so each
  // says what pressing it does now ("...; it joins the running session if it fits.").
  const next = preparedExplain(ctx);
  if (!planned && card.go_ahead !== false)
    choices.push({
      label: "Go ahead without",
      explain: `The specialist decides and says what it assumed; ${next}.`,
      tone: "secondary",
      confirm: null,
      input: null,
    });
  choices.push({
    label: "Cancel task",
    explain: cancelExplain(waiting),
    tone: "danger",
    confirm: cancelConfirm(task, waiting),
    input: null,
  });
  return {
    title: planned ? `${q(task)} needs your answers` : `${q(task)}: the specialist asks you`,
    body,
    choices,
    links: [],
    reply: "form",
    details: [],
    outcome: null,
    submit: {
      label: "Send answers",
      // The person's own task is done by the answers (the body says so); a specialist's goes on.
      explain: planned
        ? "Saves your answers in the decision record and closes the task."
        : `The task goes on with your answers; ${next}.`,
    },
  };
}

function questionsOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start, card.start_by);
  const outcome = str(card.outcome);
  if (outcome === "cancelled") return `${task} was cancelled.`;
  if (outcome === "task_moved_on")
    return `Your answers came after ${task} had finished. They are kept in the decision record.`;
  // S-2: a done task's prepared work is what waits on it ("what waits on it runs at your next
  // Start"), never the done task itself. L4-money-205: a specialist's card prepared the task
  // itself, so once it is done the line says only that; the person's own card says what waits
  // on it only while something does, true when read (`afterDoneWords`).
  const own = !offersGoAheadWithout(card);
  const afterWords = own ? afterDoneWords(card, ctx, "what waits on it") : null;
  const after =
    ctx.taskStatus === "done"
      ? isPreparedOutcome(card.start) || card.start_by === "hands_off" || !own
        ? afterWords
        : started
      : started;
  if (outcome === "without")
    return ctx.taskStatus === "done"
      ? `${task} is done without your answers${after ? `; ${after}` : ""}.`
      : `${task} goes on without your answers${started ? `: ${started}` : ""}.`;
  if (outcome === "answered") {
    if (ctx.taskStatus === "done")
      return `Answers saved in the decision record; ${task} is done${after ? `; ${after}` : ""}.`;
    return `Answers sent: ${task} goes on with them${started ? `; ${started}` : ""}.`;
  }
  return null;
}

/** The plan from the brief (design §3.3). */
function intakeCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const proposal = isRecord(card.proposal) ? card.proposal : {};
  const plan = isRecord(proposal.plan) ? proposal.plan : {};
  const tasks =
    (Array.isArray(plan.tasks) ? plan.tasks.length : 0) +
    (Array.isArray(plan.milestones)
      ? plan.milestones.reduce(
          (n: number, m: unknown) =>
            n + (isRecord(m) && Array.isArray(m.tasks) ? m.tasks.length : 0),
          0,
        )
      : 0);
  const n = tasks === 1 ? "this task" : `these ${tasks} tasks`;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const w = normalAnswer(option);
    if (/^(approve and start|approve|approved|yes)$/.test(w))
      choices.push({
        label: option === "approve" ? "Approve and start" : option,
        explain: workWaitsOnPerson(card)
          ? `Writes ${n}; the work starts once you answer its questions in the Inbox.`
          : `Writes ${n} and starts working on ${tasks === 1 ? "it" : "them"} now.`,
        tone: "primary",
        confirm: null,
        input: null,
        // L-20: on a repository the docs go in as a pull request first (about 7 s); the card
        // says what it is doing meanwhile instead of greying its buttons in silence. A plan-only
        // card (d1109-onerepo-link, OR-08) writes no document, so no docs pull request is named.
        working:
          ctx.projectRepository && card.plan_only !== true
            ? "Writing the plan and its docs pull request…"
            : "Writing the plan…",
      });
    else if (/^(change the plan|change)$/.test(w))
      choices.push({
        label: "Change the plan",
        explain: "Tell the agent what to change; it drafts a new plan for you to approve.",
        tone: "secondary",
        confirm: null,
        input: "text",
      });
    else if (/^(reject|rejected|no)$/.test(w))
      choices.push({
        label: "Reject",
        explain: "Nothing is written. You can draft a new plan later from the project page.",
        tone: "secondary",
        confirm: null,
        input: null,
      });
  }
  // A card filed before "Change the plan" existed still gets it: its reader takes the words.
  if (!choices.some((c) => c.input === "text"))
    choices.splice(1, 0, {
      label: "Change the plan",
      explain: "Tell the agent what to change; it drafts a new plan for you to approve.",
      tone: "secondary",
      confirm: null,
      input: "text",
    });
  return {
    title: `Plan for ${ctx.projectName ? `"${ctx.projectName}"` : "the project"}: ${
      tasks === 1 ? "1 task" : `${tasks} tasks`
    }`,
    body: "Nothing is written until you approve it.",
    choices,
    links: [],
    reply: "none",
    details: [],
    outcome: null,
  };
}

/** The tasks of an intake card's plan, milestones first. */
function planTasks(card: JsonObject): Record<string, unknown>[] {
  const proposal = isRecord(card.proposal) ? card.proposal : {};
  const plan = isRecord(proposal.plan) ? proposal.plan : {};
  return [
    ...(Array.isArray(plan.milestones)
      ? plan.milestones.flatMap((m: unknown) =>
          isRecord(m) && Array.isArray(m.tasks) ? m.tasks : [],
        )
      : []),
    ...(Array.isArray(plan.tasks) ? plan.tasks : []),
  ].filter(isRecord);
}

const isPersonTask = (t: Record<string, unknown>) =>
  typeof t.specialist === "string" && /^person$/i.test(t.specialist);

/** Whether an approved plan holds a task for the person ("specialist": "person"). */
function plansPersonTask(card: JsonObject): boolean {
  return planTasks(card).some(isPersonTask);
}

/**
 * Whether all of a plan's work waits on the person's answers: it has a task for the person and
 * every other task waits on another one (the plan has no cycle, so each chain ends at the
 * person's). Approve and start then starts nothing (live L-11, the bakery's content step).
 */
function workWaitsOnPerson(card: JsonObject): boolean {
  const tasks = planTasks(card);
  const work = tasks.filter((t) => !isPersonTask(t));
  return (
    tasks.some(isPersonTask) &&
    work.length > 0 &&
    work.every((t) => Array.isArray(t.dependsOn) && t.dependsOn.length > 0)
  );
}

function intakeOutcome(card: JsonObject): string | null {
  const started = startWords(card.start, card.start_by);
  if (card.outcome === "approved") {
    const n = Array.isArray(card.task_ids) ? card.task_ids.length : null;
    // W15-61: one task is "it" ("1 task written; working on it"; live: "working on them").
    const them = n === 1 ? "it" : "them";
    return `Plan approved: ${n === null ? "its tasks" : n === 1 ? "1 task" : `${n} tasks`} written${
      started === "a session started"
        ? `; working on ${them}`
        : started
          ? `; ${started}`
          : // Nothing could run because the work waits on the person's answers (live L-11): Start
            // would run nothing either.
            card.start === "nothing_to_run" && plansPersonTask(card)
            ? "; the work starts once you answer its questions in the Inbox"
            : `; press Start on the project to work on ${them}`
    }.`;
  }
  if (card.outcome === "rejected")
    return "You rejected the plan. Nothing was written; you can draft a new plan from the project page.";
  // True whenever it is read (design §5 rule 4): the new plan arrives as a card of its own.
  if (card.outcome === "changed")
    return `You asked for changes${str(card.change) ? ` ("${cutWords(str(card.change) as string, 80)}")` : ""}: a new plan is drafted and comes as its own card.`;
  if (card.outcome === "apply_failed")
    return "The plan could not be written; the project page says why.";
  return null;
}

/** An amount in micro-USD as "CHF 0.40" at the card's rate (design §5 rule 7). */
function chfAt(usdMicro: unknown, rate: unknown): string | null {
  if (typeof usdMicro !== "number" || !Number.isFinite(usdMicro)) return null;
  const r = typeof rate === "number" && rate > 0 ? rate : 0.8;
  const cents = Math.round(Math.round(Math.max(0, usdMicro) * r) / 10_000);
  // W15-74: an amount above zero under a centime is "less than CHF 0.01", never "CHF 0.00".
  return moneyWords(`CHF ${(cents / 100).toFixed(2)}`, usdMicro);
}

/**
 * A paused task's card (budget-resume, ADR 0112 amended; `session/budget-card.ts`): the title
 * names the real limit ('"X" paused at its budget of CHF 0.40'), the body what the run did and
 * left (its own words, as data) and, for a limit no bigger budget lifts, how it goes on; then
 * Continue (CHF N more) and Cancel task. Cards filed before budget-resume keep their options
 * ("Raise the budget"), each still doing what it said.
 *
 * d1109-oversize-pause (OP-2, OP-4, OP-7): the body's first sentence says whether the project's
 * checks pass on the kept work ('...; the project's test fails on its work.', at most two check
 * names, never their output); after a pause that got no further the title asks plainly ('"X"
 * paused again without getting further'), the second sentence says why and Continue takes a note;
 * a spend past the estimate is the second sentence when nothing else takes it. A card filed
 * before (none of these fields) reads as before.
 */
function budgetCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const waiting = ctx.waiting ?? [];
  const more = chfAt(card.continue_usd_micro ?? card.raise_to_usd_micro, card.chf_per_usd);
  const session = card.source === "session" || card.source === "session_budget";
  const stuck = card.no_progress === true;
  // A pause that got no further never goes on by itself (OP-4): no "goes on by itself" line.
  const goesOn = stuck ? null : goesOnWords(card);
  const outer = card.source === "project" || card.source === "month" || card.source === "plan";
  const lists = pausedWorkLists(card);
  const spend = pausedSpendSentence(card);
  const past = pastEstimate(card);
  // A first sentence that already says what it spent says the estimate in it (one sentence).
  const spendPast =
    spend && past && spend.startsWith("It spent ")
      ? spend.replace(/\.$/, `, more than its estimate of ${past.estimate}.`)
      : spend;
  // d1116-budget-all (BA-4): what the run kept of its task's budget for its review, the one
  // clause the first sentence gains, after its estimate when it passed it ('It spent CHF 0.56 of
  // its budget of CHF 0.80, keeping CHF 0.10 for its review.').
  const room =
    spendPast && card.source === "task_budget"
      ? chfAt(card.room_usd_micro, card.chf_per_usd)
      : null;
  const spendKept =
    spendPast && room ? spendPast.replace(/\.$/, `, keeping ${room} for its review.`) : spendPast;
  const first = withChecksClause(
    spendKept ?? (lists.length ? null : pausedWorkSentence(card, ctx.heldWork)),
    card,
  );
  const second = stuck
    ? outer && card.question !== true
      ? "Its last run changed no file and left the same list, so it waits for you."
      : "Its last run changed no file and left the same list: continue with a note on what to do differently, or cancel it."
    : (goesOn ??
      waitingSentence(waiting) ??
      (past && spendPast === spend
        ? `It has spent ${past.spent}, more than its estimate of ${past.estimate}.`
        : null));
  const body = [first, second].filter(Boolean).join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = budgetStopAnswer(option);
    if (what === "continue")
      choices.push({
        label: option,
        explain: stuck
          ? more
            ? `Starts a session of ${more}; your note goes into its next brief.`
            : "Starts a session that goes on from where it stopped; your note goes into its next brief."
          : // C4b-left-6 (d1109-cred-screens): the work is done and only its review waits: the
            // next session runs only the review (before: "goes on from where it stopped").
            card.review_waits === true && !session
            ? more
              ? `Adds ${more} to its budget and starts a session that runs only its review.`
              : "Gives it more and starts a session that runs only its review."
            : !more
              ? "Gives it more and starts a session that goes on from where it stopped."
              : session
                ? // d1109-oversize-pause (OP-0): the next Start takes it in its turn without Continue.
                  `Starts a session now with ${more}; without it, your next Start takes it in its turn.`
                : `Adds ${more} to its budget and starts a session that goes on from where it stopped.`,
        tone: "primary",
        confirm: null,
        // OP-4: after a pause that got no further, Continue asks what to do differently.
        input: stuck ? "note" : null,
      });
    else if (what === "cancel")
      choices.push({
        label: option,
        explain: cancelPausedExplain(waiting, ctx.heldWork),
        tone: goesOn ? "secondary" : "danger",
        confirm: cancelConfirm(ctx.taskTitle ?? str(card.task_title) ?? "the task", waiting),
        input: null,
      });
  }
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  return {
    title: stuck
      ? `${task} paused again without getting further`
      : (str(card.title) ?? firstSentence(r.why)),
    body,
    choices,
    links:
      goesOn || (stuck && outer && card.question !== true)
        ? [
            {
              label: "Open Settings",
              // P7-19: the project's budget is under Other settings, not Basics (as the
              // Overview's Change links it).
              to: card.source === "project" ? "/settings#other-settings" : "/settings",
              explain: stuck
                ? "Raise it there; this card then asks how to go on."
                : card.source === "plan"
                  ? null
                  : "Raise it there; the task is ready again then.",
            },
          ]
        : [],
    reply: "none",
    details: [],
    ...(lists.length ? { lists } : {}),
    outcome: null,
  };
}

/**
 * OP-2: the kept work's checks as a clause of the card's first sentence: '...; the project's
 * checks pass on its work.', '...; the project's test fails on its work.', '...; the project's
 * test and lint fail on its work.', '...; the project's test, lint and 1 more fail on its work.'
 * (at most two names). Nothing when no check ran; a first sentence of its own when the card has
 * none.
 */
function withChecksClause(sentence: string | null, card: JsonObject): string | null {
  const k = card.kept_checks;
  if (!isRecord(k)) return sentence;
  const names = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const passed = names(k.passed);
  const failed = names(k.failed);
  if (!passed.length && !failed.length) return sentence;
  const shown =
    failed.length > 2
      ? `${failed.slice(0, 2).join(", ")} and ${failed.length - 2} more`
      : failed.join(" and ");
  const clause = failed.length
    ? `the project's ${shown} ${failed.length === 1 ? "fails" : "fail"} on its work`
    : "the project's checks pass on its work";
  if (!sentence) return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
  return `${sentence.replace(/[.\s]+$/, "")}; ${clause}.`;
}

/**
 * OP-7: a spend past the estimate (the card's `spent_usd_micro`, the task's in all, against its
 * `estimate_usd_micro`), for 'It has spent CHF 6.10, more than its estimate of CHF 6.00.' when the
 * card has room for it. Null when within the estimate or not known (a card filed before OP-8).
 */
function pastEstimate(card: JsonObject): { spent: string; estimate: string } | null {
  const spent = card.spent_usd_micro;
  const estimate = card.estimate_usd_micro;
  if (typeof spent !== "number" || typeof estimate !== "number" || !(estimate > 0)) return null;
  if (spent <= estimate) return null;
  const s = chfAt(spent, card.chf_per_usd);
  const e = chfAt(estimate, card.chf_per_usd);
  return s && e && s !== e ? { spent: s, estimate: e } : null;
}

/**
 * What a run that heard the wrap-up spent, as the session's line says it ("paused before its
 * budget of CHF 0.15 ran out: it spent CHF 0.09"; L3-research-2): the card's first sentence, so
 * its title can say "paused before its budget ran out" whole. Null for a hard stop (its title
 * names the limit it stopped at) and for a review that waits.
 */
function pausedSpendSentence(card: JsonObject): string | null {
  if (card.stopped_by !== "wrap_up" || card.review_waits === true) return null;
  const cap = chfAt(card.cap_usd_micro, card.chf_per_usd);
  if (!cap) return null;
  const spent = chfAt(card.spent_usd_micro, card.chf_per_usd);
  const spentOk =
    spent &&
    typeof card.spent_usd_micro === "number" &&
    typeof card.cap_usd_micro === "number" &&
    card.spent_usd_micro <= card.cap_usd_micro;
  switch (card.source) {
    case "task_budget":
      return spentOk ? `It spent ${spent} of its budget of ${cap}.` : null;
    case "specialist_limit": {
      // The title names whose limit it is ("the writer's limit per run"). L3-left-2
      // (d1109-oversize-pause): what this run spent of it, when the card kept it.
      const run = chfAt(card.run_spent_usd_micro, card.chf_per_usd);
      return run
        ? `It has no budget of its own: this run spent ${run} of the ${cap} it may spend per run.`
        : `It has no budget of its own: it may spend ${cap} per run.`;
    }
    case "session":
    case "session_budget":
      return `This session's budget was ${cap}.`;
    default:
      return null;
  }
}

/** A list's items as the card shows them: up to three, then "and N more" (design §5 rule 5). */
function shownItems(items: readonly string[]): string[] {
  return [...items.slice(0, 3), ...(items.length > 3 ? [`and ${items.length - 3} more`] : [])];
}

/**
 * The first sentence of a run's note, whole (L3-research-2: the note was cut at 140 characters,
 * mid-phrase, "Two pages define hint:…"): a sentence ends at ".", "!" or "?" before a space and a
 * capital or a digit (so "HTMLElement.popover" and "e.g. this" stay inside one); a first sentence
 * under 60 characters takes the next one too, up to 220; one longer than 220 is cut at a word.
 */
function firstSentences(text: string): string {
  const t = withoutMarkdown(text);
  const parts = t
    .split(/(?<=[.!?])\s+(?=["'([]?[A-Z0-9])/)
    .map((x) => x.trim())
    .filter(Boolean);
  let out = "";
  for (const part of parts) {
    if (out && (out.length >= 60 || `${out} ${part}`.length > 220)) break;
    out = out ? `${out} ${part}` : part;
  }
  return cardItem(out || t, 220);
}

/**
 * What the paused run did and left, from its own note (data), as lists whose items are whole
 * (L3-research-2): "Where it stopped" (the note's first sentence) and "Left to do" (each item,
 * up to three, then "and N more"). A stored item a card of before cut ("… using upd…") ends at
 * a word (`cardItem`, W15-57). Empty for a review that waits and for a run that wrote no note.
 */
function pausedWorkLists(card: JsonObject): RequestListWords[] {
  if (card.review_waits === true) return [];
  const doneSaid = str(card.done);
  const left = Array.isArray(card.left)
    ? card.left.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const out: RequestListWords[] = [];
  if (doneSaid) out.push({ label: "Where it stopped", items: [firstSentences(doneSaid)] });
  const items = left.map((t) => cardItem(t, 220)).filter(Boolean);
  if (items.length) out.push({ label: "Left to do", items: shownItems(items) });
  return out;
}

/**
 * What a paused run left when it wrote no note (a tiny budget, a hard stop): its work so far is
 * kept, or, when it wrote nothing (`heldWork` false, W15-56), that it stopped before it wrote
 * anything. A review that waits says the work is done (TR-14).
 */
function pausedWorkSentence(card: JsonObject, heldWork?: boolean): string | null {
  // TR-14: the specialist finished and only its review waits (a review a limit refused): the
  // run-pause words ("It stopped before it could say where it stood") were not true of it.
  if (card.review_waits === true)
    return "The work is done; its review waits for room in the budget.";
  // A card of before budget-resume has neither: its title says it all.
  if (!("done" in card)) return null;
  if (heldWork === false) return "It stopped before it wrote anything.";
  return "It stopped before it could say where it stood; its work so far is kept.";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "1 December": when a month's cap or share resets. */
function resetDay(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * How a task paused at a limit no bigger budget lifts goes on (budget-resume, amended by
 * d1109-starts-engine S-3, ADR 0118): it is ready again once the person raised the limit in
 * Settings or it reset (`wakeBudgetWaits`; room alone never wakes it), and runs at the next Start
 * (a raised or reset limit starts nothing by itself). Null for a limit Continue lifts.
 */
function goesOnWords(card: JsonObject): string | null {
  const day = resetDay(card.resets_at);
  switch (card.source) {
    case "month":
      return `Ready again once you raise the monthly cap in Settings${day ? `, or on ${day}` : ""}; it runs at your next Start.`;
    case "project":
      return "Ready again once you raise the project's budget in Settings; it runs at your next Start.";
    case "plan":
      return `Ready again when your subscription's share resets${day ? ` on ${day}` : ""}, or once you raise the share.`;
    default:
      return null;
  }
}

/**
 * What Cancel does to a paused task: its work goes aside unless a later task built on it (in a
 * project's folder it then stays; P7-18: "until you reopen it" was promised there too), what
 * waits is stuck (design §3.5). A task whose run wrote nothing (`heldWork` false, W15-56) is
 * only dropped: nothing is set aside.
 */
function cancelPausedExplain(waiting: readonly string[], heldWork?: boolean): string {
  if (heldWork === false) {
    if (waiting.length === 0) return "Drops it.";
    if (waiting.length === 1)
      return `Drops it; "${balancedCut(waiting[0] as string, 50, cutWords, 0)}" will be stuck.`;
    return `Drops it; the ${waiting.length} tasks after it will be stuck.`;
  }
  if (waiting.length === 0)
    return "Drops it; its work is set aside unless a later task built on it.";
  // Tasks that wait on it have not built on it: within 100 characters (design §5.1).
  const base = "Drops it; its work is set aside";
  if (waiting.length === 1)
    return `${base}; "${balancedCut(waiting[0] as string, 35, cutWords, 0)}" will be stuck.`;
  return `${base}; the ${waiting.length} tasks after it will be stuck.`;
}

function budgetOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start, card.start_by);
  switch (card.outcome) {
    case "continue": {
      // d1109-oversize-pause (OP-4): Continue on the question at an outer limit adds no money
      // (the fixup's walk: before, 'Gave "X" CHF 0.00 more: a session started.').
      if (card.question === true || card.continued_usd_micro === 0)
        return `Went on with ${task}${started ? `: ${started}` : ": the next session continues it"}.`;
      const more = chfAt(card.continued_usd_micro, card.chf_per_usd);
      return `Gave ${task}${more ? ` ${more}` : ""} more${started ? `: ${started}` : ": the next session continues it"}.`;
    }
    // S-3 (ADR 0118 amending 0112): a raised or reset limit makes it ready; it starts nothing.
    case "went_on":
      return `${task} is ready again: its limit has room; ${started ?? "it runs at your next Start"}.`;
    // d1109-oversize-pause (OP-4): the question for the same pause replaced it once its outer
    // limit had room (the fixup's walk: before, "Closed: it no longer needs you." beside the card
    // that asks).
    case "asked_again":
      return "Its new card asks how to go on.";
    // d1109-oversize-pause (OP-0): the next session's start took it in its turn.
    case "went_on_at_start": {
      const at = str(card.started_session_time);
      return at ? `Your session of ${at} went on with it.` : "Your next session went on with it.";
    }
    // Cards answered before budget-resume.
    case "raise_session": {
      const to = chfAt(card.session_cap_usd_micro_set ?? card.raise_to_usd_micro, card.chf_per_usd);
      return `Raised this project's budget per session${to ? ` to ${to}` : ""}${started ? `: ${started}` : ": the next session tries again"}.`;
    }
    case "raise": {
      const to = chfAt(card.budget_usd_micro ?? card.raise_to_usd_micro, card.chf_per_usd);
      return `Raised the budget of ${task}${to ? ` to ${to}` : ""}${started ? `: ${started}` : ": the next session tries again"}.`;
    }
    case "cancel": {
      // P7-18: the Done line names what is stuck now, as the Cancel's explain said it would be.
      const waiting = ctx.waiting ?? [];
      const stuck =
        waiting.length === 0
          ? ""
          : waiting.length === 1
            ? ` ${q(waiting[0] as string)} is stuck.`
            : ` ${waiting.length} tasks after it are stuck.`;
      const kept = str(card.kept);
      if (kept) return `${task} was cancelled; its files stay in the folder: ${kept}.${stuck}`;
      return typeof card.set_aside === "number" && card.set_aside > 0
        ? `${task} was cancelled; its work is set aside until you reopen it.${stuck}`
        : `${task} was cancelled.${stuck}`;
    }
    case "task_moved_on":
      return `${task} had moved on already, so nothing changed.`;
    default:
      return null;
  }
}

/**
 * A task a run left waiting without asking anything (live walk 4; `session/cannot-run-card.ts`):
 * why, in at most two sentences, then Try again or Cancel task.
 */
function cannotRunCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const task = ctx.taskTitle ?? str(card.task_title) ?? "the task";
  const waiting = ctx.waiting ?? [];
  const reason = str(card.reason) ?? afterFirstSentence(r.why);
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = cannotRunAnswer(option);
    if (what === "retry")
      choices.push({
        label: option,
        explain: `Tries again; fix what stopped it first, with Edit; ${preparedExplain(ctx)}.`,
        tone: "primary",
        confirm: null,
        input: null,
      });
    else if (what === "cancel")
      choices.push({
        label: option,
        explain: cancelExplain(waiting),
        tone: "danger",
        confirm: cancelConfirm(task, waiting),
        input: null,
      });
  }
  return {
    title: str(card.title) ?? firstSentence(r.why),
    // Design §5 rule 1: a card body is at most two sentences, so what waits on it is said
    // only when the reason is one sentence.
    body:
      [reason, reason && /[.!?]\s+\S/.test(reason) ? null : waitingSentence(waiting)]
        .filter(Boolean)
        .join(" ") || null,
    choices,
    links: [],
    reply: "none",
    details: [],
    outcome: null,
  };
}

function cannotRunOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start, card.start_by);
  switch (card.outcome) {
    case "retry":
      return `Trying ${task} again${started ? `: ${started}` : ": the next session runs it"}.`;
    case "cancel":
      return `${task} was cancelled.`;
    case "task_moved_on":
      return `${task} had moved on already, so nothing changed.`;
    default:
      return null;
  }
}

/** The Docker wait (design §3.8, ADR 0101/0102): per project, Set up Docker, Cancel task. */
function dockerCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const tasks = Array.isArray(card.task_titles)
    ? card.task_titles.filter((t): t is string => typeof t === "string")
    : Array.isArray(card.tasks)
      ? card.tasks.filter((t): t is string => typeof t === "string")
      : [];
  const one = tasks.length === 1 ? (tasks[0] as string) : null;
  const headline = str(card.headline);
  const choices: RequestChoiceWords[] = r.options.map(optionLabel).map((label) => ({
    label,
    explain: cancelExplain(ctx.waiting ?? []),
    tone: "danger" as const,
    confirm: one ? cancelConfirm(one, ctx.waiting ?? []) : null,
    input: null,
  }));
  return {
    title: one
      ? `${q(one)} waits for Docker`
      : tasks.length > 1
        ? `${tasks.length} tasks wait for Docker`
        : "Full-review tasks wait for Docker",
    body: `${headline ? `${headline.replace(/\.$/, "")}. ` : ""}A full review runs the work in Docker, isolated from your computer; the rest of the plan goes on.`,
    choices,
    links: [
      {
        label: "Set up Docker",
        to: "/settings#sandbox",
        explain: "Settings shows the steps for this computer.",
      },
    ],
    reply: "none",
    details: r.steps,
    outcome: null,
  };
}

/** "pull request #4" for the card's PR URL, "its pull request" when it names none. */
function prOfCard(card: JsonObject): string {
  const n = /\/pulls?\/(\d+)/.exec(str(card.pr_url) ?? "")?.[1];
  return n ? `pull request #${n}` : "its pull request";
}

/**
 * The title of a left-open card a dependent branch's rebuild filed (ADR 0111,
 * dependent-branches): the task and the pull requests it was rebuilt without, '"Add footer"
 * was rebuilt without pull request #4' or '"Fix the page" could not be rebuilt without pull
 * request #4'. Null for any other left-open card.
 */
function rebuildTitle(card: JsonObject, taskTitle: string): string | null {
  const rebuild = str(card.rebuild);
  if (!rebuild) return null;
  const numbers = Array.isArray(card.without)
    ? card.without.filter((n): n is number => typeof n === "number")
    : [];
  const prs =
    numbers.length === 0
      ? "what it built on"
      : `pull request${numbers.length === 1 ? "" : "s"} ${numbers
          .map((n) => `#${n}`)
          .join(numbers.length === 2 ? " and " : ", ")}`;
  if (rebuild === "conflict") return `${q(taskTitle)} could not be rebuilt without ${prs}`;
  if (rebuild === "rebuilt_changed") return `${q(taskTitle)} was rebuilt onto main`;
  return `${q(taskTitle)} was rebuilt without ${prs}`;
}

/**
 * The Update when a Yes on a change card from Chat, Talk or the phone was not applied (W14-4,
 * polish-words): it names the card by the question the Inbox showed (its title, `ChangeCard.ask`),
 * never by a kind name a person never saw ('the change card "a GitHub repository for X"').
 */
export function changeNotAppliedWords(card: Record<string, unknown>, reason: string): string {
  // W15-75 (design §5 rule 1: an Update is one line): one sentence of at most
  // `NOT_APPLIED_MAX` characters, the card named by its question when that fits, else by what it
  // changes, else not at all when the reason names it already; the reason's first clause. Before,
  // about 250 characters with "Nothing changed; ask again if you still want it." after it.
  const ask = typeof card.ask === "string" ? firstSentence(card.ask.trim(), 120) : "";
  const what = typeof card.what === "string" ? card.what.trim() : "";
  const why =
    (reason.replace(/\s+/g, " ").trim().split(/;\s/)[0] ?? "").replace(/[.\s]+$/, "") ||
    "it was refused";
  const named = what && why.toLowerCase().includes(what.toLowerCase());
  const abouts = [
    ask ? `Your Yes to "${ask.replace(/"/g, "'")}"` : null,
    what && !named ? `Your Yes about ${what}` : null,
    "Your Yes",
  ].filter((a): a is string => a !== null);
  for (const about of abouts) {
    const line = `${about} was not applied: ${why}.`;
    if (line.length <= NOT_APPLIED_MAX) return line;
  }
  const lead = "Your Yes was not applied: ";
  return `${lead}${cutWords(why, NOT_APPLIED_MAX - lead.length - 1).replace(/[.\s]+$/, "")}.`;
}

/** An Update's one line (design §5 rule 1), as long as a notification's body. */
const NOT_APPLIED_MAX = 140;

/**
 * A left-open card's title (`merge:left_open`), what it is about now: the conflict notice
 * ('"X" conflicts with main', R-conflict), a rebuild ('"X" was rebuilt without pull request
 * #4'), else the pull request not merged. The Overview's Decisions line reads it too (W14-3:
 * after Redo it read the card's filing words, '... #4 was not merged. Redo.').
 */
export function leftOpenCardTitle(card: JsonObject, taskTitle: string): string {
  // L4-github-112: its pull request was closed, but its change reached main through another.
  if (card.merged_through === true)
    return typeof card.through === "number"
      ? `${q(taskTitle)} reached main through pull request #${card.through}`
      : `${q(taskTitle)} reached main`;
  if (card.notice === "conflict")
    return `${q(taskTitle)} conflicts with ${str(card.base) ?? "main"}`;
  const rebuilt = rebuildTitle(card, taskTitle);
  if (rebuilt) return rebuilt;
  // W15B-11: what happened (before: 'The critic accepted "X", but pull request #3 was not
  // merged', the old reason, over a sentence about new commits).
  if (card.status === "head_moved") return `${q(taskTitle)} changed after the review`;
  return `The critic accepted ${q(taskTitle)}, but ${prOfCard(card)} was not merged`;
}

/**
 * A reviewed pull request the merge step left to the person (U-028, ADR 0111,
 * `fileLeftOpenRequest` in `loop/merge.ts`): titled by its task, the merge record's sentence
 * as the body (what happened and what to do, no commit ids), each answer with what it does.
 * A card filed before the sentence was kept reads its own words after the first sentence.
 */
function mergeLeftOpenCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const choices: RequestChoiceWords[] = r.options.map(optionLabel).map((label, i) => ({
    label,
    explain: /^i merged/i.test(label)
      ? "Closes this card and notes on the task that you merged it."
      : // L4-github-112: a closed pull request whose change reached main through another.
        /^take this work out$/i.test(label)
        ? `Opens a pull request that takes only the change of ${prOfCard(card).replace(/^pull request /, "")} out of main; nothing changes until you merge it.`
        : /^keep it$/i.test(label)
          ? `Closes this card; main keeps the change of ${prOfCard(card).replace(/^pull request /, "")}.`
          : /^leave/i.test(label)
            ? "Closes this card; the pull request stays open on GitHub."
            : // A rebuild's card (R-rebuildcard): the pull request is open; polish owns these words.
              /^merge$/i.test(label)
              ? `Merges ${prOfCard(card).replace(/^pull request /, "")} as it is now, as Merge on the Overview does.`
              : /^redo$/i.test(label)
                ? `The task is done again from main; ${preparedExplain(ctx)}.`
                : null,
    tone: i === 0 ? "primary" : "secondary",
    confirm: null,
    input: null,
  }));
  return {
    title: ctx.taskTitle ? leftOpenCardTitle(card, ctx.taskTitle) : firstSentence(r.why),
    body: str(card.sentence) ?? afterFirstSentence(r.why),
    choices,
    links: [],
    reply: "none",
    details: r.steps,
    outcome: null,
  };
}

/** What became of a left-open card once answered (`syncPrAnswers` records its outcome). */
function mergeLeftOpenOutcome(card: JsonObject): string | null {
  if (card.outcome === "merged") return `Noted: you merged ${prOfCard(card)}.`;
  if (card.outcome === "left_open") return `Left open: ${prOfCard(card)} stays open on GitHub.`;
  // L4-github-112: the merged-through card's answers.
  if (card.outcome === "kept")
    return `Kept: the change of ${prOfCard(card).replace(/^pull request /, "")} stays on main.`;
  if (card.outcome === "taken_out")
    return typeof card.take_out_result === "string" && card.take_out_result
      ? card.take_out_result
      : "Taking the work out: the answer comes in a moment.";
  // A rebuild's card (R-rebuildcard): what the Merge came to, or the Redo.
  const pr = prOfCard(card).replace(/^pull request /, "");
  if (card.outcome === "merging")
    return card.merge_result === "merged"
      ? `Merged ${pr}.`
      : typeof card.merge_result === "string" && card.merge_result
        ? card.merge_result
        : `Merging ${pr}.`;
  // S-2: the Redo prepared the task; its card says what became of it, and a card answered
  // before run C (no `start`) only that the task is ready again.
  if (card.outcome === "redone") {
    const next = startWords(card.start, card.start_by);
    return next ? `Redone: the task is ready again; ${next}.` : "Redone: the task is ready again.";
  }
  return null;
}

/** The refused-credential card's key (`session/credential-wait.ts`, U-078). */
const CREDENTIAL_REFUSED_KEY = "credential:refused";

/**
 * Anthropic refused a Claude credential (U-078, ADR 0100 amended): one card per credential, no
 * task, no answer to give; the link opens the setup assistant where a new key or sign-in is
 * pasted, which closes the card and starts the work that waited for it.
 */
const CREDENTIAL_ASK_KEY = "credential:ask";

/** When the card was filed (its `filed_at`), in epoch ms; undefined when it names none. */
function filedAtMs(card: JsonObject): number | undefined {
  const t = typeof card.filed_at === "string" ? Date.parse(card.filed_at) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * CE-7's ask card: "Use your API key until 15:40?", what the waiting work costs on the key, and
 * its two options with what each does; once answered or closed, its Done or Closed line.
 */
function askCard(
  r: Pick<HumanRequestRow, "status">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const ask = ctx.credentialAsk;
  const answeredGoesOn = card.session_goes_on === true;
  const w = askCardWords({
    wait: {
      reason: (str(card.reason) ?? "limit") as "limit",
      kind: (str(card.credential_kind) ?? "subscription") as "subscription",
      until: str(card.until),
    },
    ...(ask?.timezone ? { timezone: ask.timezone } : {}),
    // L4-creds-3: the card's time is said as of when it was filed (its day decides whether the
    // date is named), never from the clock of whoever reads it.
    nowMs: ask?.nowMs ?? filedAtMs(card) ?? 0,
    // d1109-cred-screens (CS-8): under a centime "less than CHF 0.01" (never "CHF 0.00").
    estimateChf: moneyWords(
      chfText(
        typeof card.estimate_usd_micro === "number" ? card.estimate_usd_micro : 0,
        typeof card.chf_per_usd === "number" ? card.chf_per_usd : undefined,
      ),
      typeof card.estimate_usd_micro === "number" ? card.estimate_usd_micro : 0,
    ),
    sessionWaits: r.status === "open" ? (ask?.sessionWaits ?? false) : answeredGoesOn,
    ...(ask?.goesOnAt ? { goesOnAt: ask.goesOnAt } : {}),
  });
  const outcome =
    r.status === "open"
      ? null
      : card.outcome === "granted"
        ? w.done.use
        : card.outcome === "waited"
          ? w.done.wait
          : card.closed_why === "policy_changed" || card.closed_why === "other_cannot"
            ? askClosedLine(card.closed_why, str(card.credential_kind) ?? "subscription")
            : w.closed;
  return {
    title: w.title,
    body: w.body,
    choices: w.options.map((o, i) => ({
      label: o.label,
      explain: o.explain,
      tone: i === 0 ? "primary" : "secondary",
      confirm: null,
      input: null,
    })),
    links: [],
    reply: "none",
    details: w.details,
    outcome,
  };
}

function refusedCredentialCard(card: JsonObject, ctx: RequestWordsContext = {}): RequestWords {
  const subscription = card.credential_kind === "subscription";
  // CE-8 (the owner's 7c: "follow the frameowrk for a) or b) as if it has run out, but also give
  // the user some kind of notification or information"): why it was refused (its category),
  // then what the work does under the person's rule until a new one is saved. Under 'ask' the
  // refusal is a stop asked about on its own ask card ("Use your API key until a new sign-in is
  // saved?"); this card stays the notification with its link, and names the choice while that
  // card is open. It never carries options of its own (its row has none to answer).
  const refused = ctx.credentialRefused ?? {
    category: null,
    rule: ctx.credentialGoesOn ? ("next" as const) : ("wait" as const),
    other: ctx.credentialGoesOn ?? null,
  };
  const body = refusedBody({
    category: refused.category,
    rule: refused.rule,
    other: refused.other,
    ...(refused.estimateChf ? { estimateChf: refused.estimateChf } : {}),
  });
  return {
    title:
      str(card.title) ??
      (subscription ? "Anthropic refused your Claude sign-in" : "Anthropic refused your API key"),
    body,
    choices: [],
    links: [
      {
        label: subscription ? "Save a new sign-in" : "Save a new key",
        to: "/setup",
        explain: "The setup assistant checks it with Anthropic and saves it.",
      },
    ],
    reply: "none",
    details: [],
    outcome: null,
  };
}

/**
 * The repository offer's question (`RepoProposals`, merged-actions): its title, the project
 * named in quotes. `repo-create.ts` files `${repoOfferQuestion(name)} ${REPO_OFFER_BODY}` as the
 * card's text for readers that show one line.
 */
export function repoOfferQuestion(projectName: string | null): string {
  return projectName
    ? `Create a repository for "${projectName.replace(/\s+/g, " ").trim()}"?`
    : "Create a repository for this project?";
}

/** The repository offer's one sentence of why (design §5: what and why, no list of what is not). */
export const REPO_OFFER_BODY =
  "Code work is planned for it, and it has none: its tasks run in the project's folder on this computer.";

/**
 * The repository offer (U-037, `RepoProposals`, key `repo:create:<project>`): titled by its
 * question with the project's name read now, its why as the body, each answer with what it
 * does. Before (review of merged-actions), the title was the text's first sentence, cut at the
 * first ": ", ". " or "? ", so "Birds: a counter" read 'Create a repository for "Birds'.
 */
function repoOfferCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options">,
  ctx: RequestWordsContext,
): RequestWords {
  const choices: RequestChoiceWords[] = r.options.map(optionLabel).map((label, i) => ({
    label,
    explain: /^create/i.test(label)
      ? "Makes it on GitHub, private, with the project's folder as its first commit."
      : /^not now/i.test(label)
        ? "Tasks keep running in the project's folder; the agent does not ask again."
        : null,
    tone: i === 0 ? "primary" : "secondary",
    confirm: null,
    input: null,
  }));
  return {
    title: repoOfferQuestion(ctx.projectName ?? null),
    body: REPO_OFFER_BODY,
    choices,
    links: [],
    reply: "none",
    details: r.steps,
    outcome: null,
  };
}

/**
 * d1109-selftasks-run (ADR 0119 point 7): the agent's suggested changes to its own task list, one
 * card per project (`task-proposal.ts`). Titled by the project and the count ('Quote page: the
 * agent suggests 3 changes to the tasks'), its body what showed it and that nothing changes until
 * the person says yes, the changes as its lines (open), and two answers with what each does.
 */
function taskProposalCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const changes = Array.isArray(card.changes) ? card.changes.length : r.steps.length;
  const choices: RequestChoiceWords[] = r.options.map(optionLabel).map((label, i) => ({
    label,
    explain:
      label === TASK_PROPOSAL_OPTIONS[0]
        ? "Changes the tasks as listed; one Undo takes them back."
        : label === TASK_PROPOSAL_OPTIONS[1]
          ? "Nothing changes."
          : null,
    tone: i === 0 ? "primary" : "secondary",
    confirm: null,
    input: null,
  }));
  const project = ctx.projectName?.replace(/\s+/g, " ").trim();
  return {
    title: `${project ? `${project}: the` : "The"} agent suggests ${changes} ${changes === 1 ? "change" : "changes"} to the tasks`,
    body: r.why,
    choices,
    links: [],
    reply: "none",
    details: r.steps,
    // SC-9: the person approves what they can read: the changes show open.
    openDetails: true,
    outcome: proposalOutcome(card),
  };
}

/**
 * A "Take this work out" that conflicted with later work (merged-actions, `TaskTakeOut.notice`,
 * key `take_out:conflict:<task>`): a notice titled by its task, the files and what to do as
 * the body, closed with Got it. Before (review of merged-actions), the title was the text's
 * first sentence, cut at the first ": " inside the quoted title: '"Write the README' with the
 * rest of the title in the body.
 */
function takeOutNoticeCard(
  r: Pick<HumanRequestRow, "why" | "steps">,
  card: JsonObject,
): RequestWords {
  const task = str(card.task_title) ?? str(card.title);
  const files = Array.isArray(card.files)
    ? card.files.filter((f): f is string => typeof f === "string")
    : [];
  return {
    title: task ? `${q(task)} could not be taken out` : firstSentence(r.why),
    body: files.length ? takeOutConflictBody(files) : task ? null : afterFirstSentence(r.why),
    choices: [
      {
        label: "Got it",
        explain: "Closes this card; its work stays in main.",
        tone: "secondary",
        confirm: null,
        input: null,
      },
    ],
    links: [],
    reply: "none",
    details: r.steps,
    outcome: null,
  };
}

/** What a closed take-out notice says: nothing changed, the work stays. */
function takeOutNoticeOutcome(card: JsonObject): string {
  const task = str(card.task_title) ?? str(card.title);
  return `Nothing changed: ${task ? q(task) : "its work"} stays in main.`;
}

/** Any other card: its own words, its options with the reject-like ones secondary. */
function genericCard(
  r: Pick<HumanRequestRow, "kind" | "why" | "steps" | "options" | "change_card">,
): RequestWords {
  const labels = r.options.map(optionLabel);
  const choices: RequestChoiceWords[] = labels.map((label, i) => ({
    label,
    explain: null,
    tone: /^(reject|rejected|deny|denied|no|not now|later|decline|cancel|dismiss|ignore)\b/i.test(
      label,
    )
      ? "secondary"
      : i === 0
        ? "primary"
        : "secondary",
    confirm: null,
    input: null,
  }));
  // A notice with nothing to choose closes with one button; nothing to answer in words.
  if (labels.length === 0 && r.kind === "info")
    choices.push({
      label: "Got it",
      explain: "Closes this card.",
      tone: "secondary",
      confirm: null,
      input: null,
    });
  // Free text only where the card takes it: a question without options, or a decision whose
  // answer may be the person's own words (`acceptsAnswer`, U-034).
  const key = keyOf(r.change_card);
  const optionOnly =
    key !== null && (ANSWER_CARD_KEYS.optionOnly as readonly string[]).includes(key);
  const reply: RequestWords["reply"] =
    r.kind === "credential" || r.kind === "info" || r.kind === "approval" || optionOnly
      ? "none"
      : "text";
  // A change asked for in Chat or Talk waits as the one-line question the chat read back
  // ('Pause "X"? No session runs it until you press Resume.', `ChangeCard.ask`), not as the
  // change card's object ('the task "X"').
  const ask = isRecord(r.change_card) ? str(r.change_card.ask) : null;
  const said = ask ?? r.why;
  // Its Yes and No as buttons say them, each with what it does (wave 2: the stored "yes" and
  // "no" showed in lower case with no line). A click sends "Yes" or "No"; every reader of a
  // yes/no answer reads either case (`isYes`, `acceptsAnswer`). Yes says what Yes does: the
  // card's body, the question's second sentence, already says what the change means (W15-76:
  // before, Yes repeated that body cut with "…").
  if (
    ask &&
    labels.length === 2 &&
    /^yes$/i.test(labels[0] ?? "") &&
    /^no$/i.test(labels[1] ?? "")
  ) {
    choices.splice(
      0,
      2,
      {
        label: "Yes",
        explain: "Makes the change now.",
        tone: "primary",
        confirm: null,
        input: null,
      },
      {
        label: "No",
        explain: "Nothing changes.",
        tone: "secondary",
        confirm: null,
        input: null,
      },
    );
  }
  return {
    title: firstSentence(said),
    body: afterFirstSentence(said),
    choices,
    links: [],
    reply,
    details: r.steps,
    outcome: null,
  };
}

/**
 * The key of a rebase-conflict card (`REBASE_CONFLICT_KEY` in `@forerunner/capabilities`'s
 * `pr-executor.ts`), spelled here: this module imports no package that runs git.
 */
export const REBASE_CONFLICT_CARD_KEY = "githost:rebase_conflict";

/**
 * W15-06 (w15-merge): the card of a conflict the agent could not resolve while it worked
 * (`PrTaskExecutor.conflict`). Before, it had no words of its own: its title was the first
 * sentence of its why cut at 80 characters ("…conflicts with main in index.html; the agent
 * could not reso…"), its buttons no one-line explanation, and its Done line the bare echo.
 */
function rebaseConflictCard(
  r: Pick<HumanRequestRow, "why" | "steps" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "The task");
  const base = str(card.base) ?? "main";
  const files = Array.isArray(card.conflicts)
    ? card.conflicts.filter((f): f is string => typeof f === "string")
    : [];
  const where = files.length ? ` in ${fileWords(files)}` : "";
  const pr = typeof card.pr_number === "number" ? `#${card.pr_number}` : null;
  const choices: RequestChoiceWords[] = r.options.map(optionLabel).map((label) => {
    const what = /^i resolved/i.test(label)
      ? "resolved"
      : /^drop/i.test(label)
        ? "drop"
        : /^cancel/i.test(label)
          ? "cancel"
          : null;
    return {
      label,
      explain:
        what === "resolved"
          ? `Checks your resolution and ${pr ? `updates ${pr}` : "opens the pull request"}; ${preparedExplain(ctx)}.`
          : what === "drop"
            ? `The task is done again from ${base}; ${preparedExplain(ctx)}.`
            : what === "cancel"
              ? "Cancels the task; nothing more runs for it."
              : null,
      tone: what === "resolved" ? "primary" : what === "cancel" ? "danger" : "secondary",
      confirm:
        what === "cancel"
          ? cancelConfirm(ctx.taskTitle ?? str(card.task_title) ?? "the task", ctx.waiting ?? [])
          : null,
      input: null,
    };
  });
  return {
    title: `${task} ${card.again === true ? "still conflicts" : "conflicts"} with ${base}`,
    body: `Its branch conflicts with ${base}${where}, and the agent could not resolve it.`,
    choices,
    links: [],
    reply: "none",
    details: [...r.steps],
    outcome: null,
  };
}

/** What came of a rebase-conflict card's answer, with the session it started (W15-06). */
function rebaseConflictOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "The task");
  const base = str(card.base) ?? "main";
  const started = startWords(card.start, card.start_by) ?? "the next session runs it";
  if (card.outcome === "resolved") return `${task} goes on with your resolution: ${started}.`;
  if (card.outcome === "dropped") return `${task} is done again from ${base}: ${started}.`;
  if (card.outcome === "cancelled") return `${task} was cancelled.`;
  return null;
}

/** "index.html", "a.md and b.md", "a.md, b.md, c.md and 2 more". */
function fileWords(files: readonly string[]): string {
  const shown = files.slice(0, 3);
  const more = files.length - shown.length;
  const list =
    shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${list} and ${more} more` : list;
}

/**
 * The words of a card as the Inbox shows it (design §3.8). Every answer is still sent as the
 * option's words, and every reader reads them (`wiring/request-answers.ts`).
 */
export function requestWords(
  r: Pick<
    HumanRequestRow,
    "kind" | "why" | "steps" | "options" | "change_card" | "status" | "answer"
  >,
  ctx: RequestWordsContext = {},
): RequestWords {
  const card = isRecord(r.change_card) ? (r.change_card as JsonObject) : {};
  const key = keyOf(card);
  let words: RequestWords;
  let outcome: string | null = null;
  if (key === ANSWER_CARD_KEYS.signoff) {
    words = retryCard(r, card, ctx, (o) => signoffAnswer(o));
    outcome = retryOutcome(card, ctx, card.reason === "verdict");
  } else if (key === ANSWER_CARD_KEYS.blockedFindings || key === ANSWER_CARD_KEYS.reviewFailed) {
    words = retryCard(r, card, ctx, (o) => {
      const a = blockedFindingsAnswer(o);
      return a === "rework" ? "revise" : a;
    });
    outcome = retryOutcome(card, ctx, false);
  } else if (key === ANSWER_CARD_KEYS.budgetStop) {
    words = budgetCard(r, card, ctx);
    outcome = budgetOutcome(card, ctx);
    // budget-resume: a card the app closed because its limit has room again says so, not
    // "Closed: it no longer needs you." (d1109-oversize-pause: also one its question replaced).
    if (
      r.status !== "open" &&
      (card.outcome === "went_on" ||
        card.outcome === "went_on_at_start" ||
        card.outcome === "asked_again") &&
      outcome
    ) {
      words.outcome = outcome;
      return words;
    }
  } else if (key === ANSWER_CARD_KEYS.cannotRun) {
    words = cannotRunCard(r, card, ctx);
    outcome = cannotRunOutcome(card, ctx);
  } else if (key?.startsWith(ANSWER_CARD_KEYS.personQuestionsPrefix)) {
    words = questionsCard(card, ctx);
    outcome = questionsOutcome(card, ctx);
  } else if (key?.startsWith(ANSWER_CARD_KEYS.intakePrefix)) {
    words = intakeCard(r, card, ctx);
    outcome = intakeOutcome(card);
  } else if (key === ANSWER_CARD_KEYS.mergeLeftOpen) {
    words = mergeLeftOpenCard(r, card, ctx);
    outcome = mergeLeftOpenOutcome(card);
    // L3-github-2: closed because its pull request was merged (by Forerunner or on GitHub);
    // L4-github-117: closed on GitHub without a merge; L4-github-112: its change reached main
    // through another pull request (that card says the rest).
    const closedPr = prOfCard(card).replace(/^pull request /, "");
    if (r.status === "withdrawn" && card.closed === "merged") {
      words.outcome = `Closed: ${closedPr} was merged.`;
      return words;
    }
    if (r.status === "withdrawn" && card.closed === "closed") {
      words.outcome = `Closed: ${closedPr} was closed on GitHub.`;
      return words;
    }
    if (r.status === "withdrawn" && card.closed === "merged_through") {
      words.outcome = `Closed: the change of ${closedPr} reached main.`;
      return words;
    }
  } else if (key === "sandbox.not_ready") {
    words = dockerCard(r, card, ctx);
    if (card.outcome === "cancel")
      outcome = `${ctx.taskTitle ? q(ctx.taskTitle) : "The task"} was cancelled.`;
  } else if (key?.startsWith(ANSWER_CARD_KEYS.repoCreatePrefix)) {
    words = repoOfferCard(r, ctx);
  } else if (key === TASK_PROPOSAL_KEY) {
    // d1109-selftasks-run: the agent's suggested task changes; a replaced one says so.
    words = taskProposalCard(r, card, ctx);
    outcome = proposalOutcome(card);
    if (r.status === "withdrawn" && card.replaced === true) {
      words.outcome = outcome;
      return words;
    }
  } else if (key?.startsWith(TAKE_OUT_NOTICE_PREFIX)) {
    words = takeOutNoticeCard(r, card);
    outcome = takeOutNoticeOutcome(card);
  } else if (key === REBASE_CONFLICT_CARD_KEY) {
    words = rebaseConflictCard(r, card, ctx);
    outcome = rebaseConflictOutcome(card, ctx);
  } else if (key === CREDENTIAL_REFUSED_KEY) {
    words = refusedCredentialCard(card, ctx);
    // Closed when a new credential was saved (`closeRefusedCards`).
    if (r.status === "withdrawn") {
      // C5-left-5: what became of waiting work only when work waited.
      words.outcome = refusedClosedLine(
        str(card.credential_kind) ?? "api_key",
        card.closed_why === "taken" ? "taken" : "saved",
        card.work_waited !== false,
      );
      return words;
    }
  } else if (key === CREDENTIAL_ASK_KEY) {
    // d1109-cred-engine CE-7: the one card per stop, its words computed when it is shown.
    words = askCard(r, card, ctx);
    if (r.status !== "open") return words;
  } else {
    words = genericCard(r);
    outcome = changeCardOutcome(card, r.answer) ?? lateApprovalOutcome(card);
  }
  if (r.status !== "open") {
    const given = answerWords(r.answer);
    words.outcome =
      closedLine(r, ctx) ??
      outcome ??
      (given ? `You answered "${cutWords(given, 80)}".` : "Answered.");
    // Answers that came after the task had moved on (design §3.8): they can still be used.
    if (
      key?.startsWith(ANSWER_CARD_KEYS.personQuestionsPrefix) &&
      card.outcome === "task_moved_on"
    ) {
      const action =
        ctx.taskStatus === "done"
          ? "redo"
          : ctx.taskStatus === "cancelled"
            ? "reopen"
            : ctx.taskStatus === "failed"
              ? "try_again"
              : null;
      words.followUp = action
        ? {
            label: "Redo with these answers",
            explain: "Opens the task again; its next attempt reads your answers.",
            action,
          }
        : null;
    }
  }
  return words;
}
