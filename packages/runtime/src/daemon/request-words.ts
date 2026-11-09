import type { HumanRequestRow, JsonObject } from "@forerunner/state";
import { moneyWords } from "../session/money-words.ts";
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
import { TAKE_OUT_NOTICE_PREFIX, takeOutConflictBody } from "./take-out-words.ts";

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
  /** Once answered or withdrawn: what happened and what is next, in one line; null while open. */
  outcome: string | null;
  /**
   * What the person can do next about an answered card, where there is something: answers that
   * came after their task had finished offer "Redo with these answers" (the task's Redo, Reopen or
   * Try again; its next brief carries the answers). Null otherwise.
   */
  followUp?: { label: string; explain: string; action: "redo" | "reopen" | "try_again" } | null;
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
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A title as a line names it: whole when short, else cut at a word. */
export function cutWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const q = (title: string) => `"${cutWords(title, 50)}"`;

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
  return step
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

/** "a session started" / "it runs after the current session" for a recorded start. */
function startWords(start: unknown): string | null {
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
      ? `The ${saidBy} said: "${said.replace(/"/g, "'")}"`
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
        explain: verdict
          ? "Starts a session that reworks it with the critic's findings."
          : "Starts a session that tries again; add a note if you know what to change.",
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

function retryOutcome(card: JsonObject, ctx: RequestWordsContext, verdict: boolean): string | null {
  const task = q(ctx.taskTitle ?? "the task");
  const started = startWords(card.start);
  switch (card.outcome) {
    case "revise":
    case "rework":
      return `Trying ${task} again${started ? `: ${started}` : ": the next session runs it"}.`;
    case "accept":
      return verdict
        ? `${task} is done.${started ? ` What comes after it runs now: ${started}.` : ""}`
        : `${task} is done: accepted without review.${started ? ` What comes after it runs now: ${started}.` : ""}`;
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
  const context = str(card.context)
    ?.replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g, "$1")
    .replace(/^[\s:;,.\-–—*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
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
  if (!planned && card.go_ahead !== false)
    choices.push({
      label: "Go ahead without",
      explain: "The specialist decides and says what it assumed.",
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
  };
}

function questionsOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start);
  const outcome = str(card.outcome);
  if (outcome === "cancelled") return `${task} was cancelled.`;
  if (outcome === "task_moved_on")
    return `Your answers came after ${task} had finished. They are kept in the decision record.`;
  if (outcome === "without")
    return ctx.taskStatus === "done"
      ? `${task} is done without your answers${started ? `; ${started}` : ""}.`
      : `${task} goes on without your answers${started ? `: ${started}` : ""}.`;
  if (outcome === "answered") {
    if (ctx.taskStatus === "done")
      return `Answers saved in the decision record; ${task} is done${started ? `; ${started}` : ""}.`;
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
        // says what it is doing meanwhile instead of greying its buttons in silence.
        working: ctx.projectRepository
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
  const started = startWords(card.start);
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
 */
function budgetCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const waiting = ctx.waiting ?? [];
  const more = chfAt(card.continue_usd_micro ?? card.raise_to_usd_micro, card.chf_per_usd);
  const session = card.source === "session" || card.source === "session_budget";
  const goesOn = goesOnWords(card);
  const body =
    [pausedWorkSentence(card, ctx.heldWork), goesOn ?? waitingSentence(waiting)]
      .filter(Boolean)
      .join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = budgetStopAnswer(option);
    if (what === "continue")
      choices.push({
        label: option,
        explain: !more
          ? "Gives it more and starts a session that goes on from where it stopped."
          : session
            ? `Starts a session of ${more} now; it goes on from where it stopped.`
            : `Adds ${more} to its budget and starts a session that goes on from where it stopped.`,
        tone: "primary",
        confirm: null,
        input: null,
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
  return {
    title: str(card.title) ?? firstSentence(r.why),
    body,
    choices,
    links: goesOn
      ? [
          {
            label: "Open Settings",
            // P7-19: the project's budget is under Other settings, not Basics (as the
            // Overview's Change links it).
            to: card.source === "project" ? "/settings#other-settings" : "/settings",
            explain: card.source === "plan" ? null : "Raise it there; the task goes on by itself.",
          },
        ]
      : [],
    reply: "none",
    details: [],
    outcome: null,
  };
}

/**
 * What the paused run did and left, in one sentence from its own note (data): "Done: guide.md
 * has 3 parts; left: write the rest, check it." A run that wrote no note (a tiny budget, a hard
 * stop): its work so far is kept, or, when it wrote nothing (`heldWork` false, W15-56), that it
 * stopped before it wrote anything.
 */
function pausedWorkSentence(card: JsonObject, heldWork?: boolean): string | null {
  // TR-14: the specialist finished and only its review waits (a review a limit refused): the
  // run-pause words ("It stopped before it could say where it stood") were not true of it.
  if (card.review_waits === true)
    return "The work is done; its review waits for room in the budget.";
  const done = str(card.done);
  const left = Array.isArray(card.left)
    ? card.left.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const items = left.slice(0, 3).map((t) => noFinalDot(t));
  const leftWords = items.length
    ? `${items.join(", ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""}`
    : null;
  if (done && leftWords) return `Done: ${noFinalDot(done)}; left: ${leftWords}.`;
  if (done) return `Done: ${noFinalDot(done)}.`;
  if (leftWords) return `Left: ${leftWords}.`;
  // A card of before budget-resume has neither: its title says it all.
  if (!("done" in card)) return null;
  if (heldWork === false) return "It stopped before it wrote anything.";
  return "It stopped before it could say where it stood; its work so far is kept.";
}

const noFinalDot = (s: string) => s.trim().replace(/[.\s]+$/, "");

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
 * How a task paused at a limit no bigger budget lifts goes on (budget-resume): by itself once
 * the person raised the limit in Settings or it reset (`wakeBudgetWaits`; room alone never wakes
 * it). Null for a limit Continue lifts.
 */
function goesOnWords(card: JsonObject): string | null {
  const day = resetDay(card.resets_at);
  switch (card.source) {
    case "month":
      return `It goes on by itself once you raise the monthly cap in Settings${day ? `, or on ${day}` : ""}.`;
    case "project":
      return "It goes on by itself once you raise the project's budget in Settings.";
    case "plan":
      return `It goes on by itself when your subscription's share resets${day ? ` on ${day}` : ""}, or once you raise the share in Settings.`;
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
      return `Drops it; "${cutWords(waiting[0] as string, 50)}" will be stuck.`;
    return `Drops it; the ${waiting.length} tasks after it will be stuck.`;
  }
  if (waiting.length === 0)
    return "Drops it; its work is set aside unless a later task built on it.";
  // Tasks that wait on it have not built on it: within 100 characters (design §5.1).
  const base = "Drops it; its work is set aside";
  if (waiting.length === 1)
    return `${base}; "${cutWords(waiting[0] as string, 35)}" will be stuck.`;
  return `${base}; the ${waiting.length} tasks after it will be stuck.`;
}

function budgetOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start);
  switch (card.outcome) {
    case "continue": {
      const more = chfAt(card.continued_usd_micro, card.chf_per_usd);
      return `Gave ${task}${more ? ` ${more}` : ""} more${started ? `: ${started}` : ": the next session continues it"}.`;
    }
    case "went_on":
      return `${task} goes on: its limit has room again.`;
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
        explain:
          "Starts a session that tries again; first fix what stopped it (Edit changes who does it).",
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
  const started = startWords(card.start);
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
      : /^leave/i.test(label)
        ? "Closes this card; the pull request stays open on GitHub."
        : // A rebuild's card (R-rebuildcard): the pull request is open; polish owns these words.
          /^merge$/i.test(label)
          ? `Merges ${prOfCard(card).replace(/^pull request /, "")} as it is now, as Merge on the Overview does.`
          : /^redo$/i.test(label)
            ? "The task is done again from main; a session starts for it."
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
  // A rebuild's card (R-rebuildcard): what the Merge came to, or the Redo.
  const pr = prOfCard(card).replace(/^pull request /, "");
  if (card.outcome === "merging")
    return card.merge_result === "merged"
      ? `Merged ${pr}.`
      : typeof card.merge_result === "string" && card.merge_result
        ? card.merge_result
        : `Merging ${pr}.`;
  if (card.outcome === "redone") return "Redone: the task is ready again and a session runs it.";
  return null;
}

/** The refused-credential card's key (`session/credential-wait.ts`, U-078). */
const CREDENTIAL_REFUSED_KEY = "credential:refused";

/**
 * Anthropic refused a Claude credential (U-078, ADR 0100 amended): one card per credential, no
 * task, no answer to give; the link opens the setup assistant where a new key or sign-in is
 * pasted, which closes the card and starts the work that waited for it.
 */
function refusedCredentialCard(card: JsonObject, ctx: RequestWordsContext = {}): RequestWords {
  const subscription = card.credential_kind === "subscription";
  // U-078 (the session lead's default of 2026-11-03): under 'Wait' the task work waits for a
  // new one; under "use the other one" it goes on with the other credential, and the card says
  // so, with the money when that is the API key.
  const goesOn = ctx.credentialGoesOn;
  const body =
    goesOn === "api_key" || goesOn === "plan_credits"
      ? `Save a new one in Settings. Until then your tasks go on with ${goesOn === "api_key" ? "your API key" : "your plan credits"}, which costs money.`
      : goesOn === "subscription"
        ? "Save a new one in Settings. Until then your tasks go on with your Claude subscription."
        : "Save a new one in Settings. The work that needs it waits and starts by itself then.";
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
          ? `A session checks your resolution and ${pr ? `updates ${pr}` : "opens the pull request"}.`
          : what === "drop"
            ? `The task is done again from ${base}; a session starts for it.`
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
  const started = startWords(card.start) ?? "the next session runs it";
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
    // "Closed: it no longer needs you."
    if (r.status !== "open" && card.outcome === "went_on" && outcome) {
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
  } else if (key === "sandbox.not_ready") {
    words = dockerCard(r, card, ctx);
    if (card.outcome === "cancel")
      outcome = `${ctx.taskTitle ? q(ctx.taskTitle) : "The task"} was cancelled.`;
  } else if (key?.startsWith(ANSWER_CARD_KEYS.repoCreatePrefix)) {
    words = repoOfferCard(r, ctx);
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
      words.outcome = "A new one is saved; the work that waited for it goes on.";
      return words;
    }
  } else {
    words = genericCard(r);
    outcome = changeCardOutcome(card, r.answer);
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
