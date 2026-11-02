import type { HumanRequestRow, JsonObject } from "@forerunner/state";
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

/** The first sentence of a text (the title of a card with no title of its own). */
function firstSentence(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?:])(\s|$)/.exec(t);
  return cutWords((m?.[1] ?? t).replace(/[.:]$/, ""), max);
}

/** The rest of a text after its first sentence (the body of a card titled by that sentence). */
function afterFirstSentence(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?:])(\s|$)/.exec(t);
  if (!m) return null;
  const rest = t.slice(m[0].length).trim();
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
  const context = str(card.context)
    ?.replace(/^[\s:;,.\-–—*]+/, "")
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
          : `Writes ${n} and starts working on them now.`,
        tone: "primary",
        confirm: null,
        input: null,
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
    return `Plan approved: ${n === null ? "its tasks" : n === 1 ? "1 task" : `${n} tasks`} written${
      started === "a session started"
        ? "; working on them"
        : started
          ? `; ${started}`
          : // Nothing could run because the work waits on the person's answers (live L-11): Start
            // would run nothing either.
            card.start === "nothing_to_run" && plansPersonTask(card)
            ? "; the work starts once you answer its questions in the Inbox"
            : "; press Start on the project to work on them"
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
  return `CHF ${(cents / 100).toFixed(2)}`;
}

/**
 * A task stopped at its own budget (live walk 2, B2; `session/budget-card.ts`): Raise the
 * budget (to the amount the card names, and a session tries again) or Cancel task.
 */
function budgetCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  ctx: RequestWordsContext,
): RequestWords {
  const task = ctx.taskTitle ?? str(card.task_title) ?? "the task";
  const waiting = ctx.waiting ?? [];
  const spent = chfAt(card.spent_usd_micro, card.chf_per_usd);
  const raiseTo = chfAt(card.raise_to_usd_micro, card.chf_per_usd);
  if (card.source === "session_budget") return sessionBudgetCard(r, card, task, waiting);
  // The hooks stop a run before a call that would go over the cap, so it may have spent less
  // than the budget: then the next step is what did not fit (the bench read "stopped at its
  // budget of CHF 0.01. So far it spent CHF 0.00.").
  const under =
    typeof card.spent_usd_micro === "number" &&
    typeof card.cap_usd_micro === "number" &&
    card.spent_usd_micro < card.cap_usd_micro;
  const body =
    [
      spent
        ? under
          ? `So far it spent ${spent}; its next step would have gone over the budget.`
          : `So far it spent ${spent}.`
        : null,
      waitingSentence(waiting),
    ]
      .filter(Boolean)
      .join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = budgetStopAnswer(option);
    if (what === "raise")
      choices.push({
        label: option,
        explain: raiseTo
          ? `Sets its budget to ${raiseTo} and starts a session that tries again.`
          : "Raises its budget and starts a session that tries again.",
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
    body,
    choices,
    links: [],
    reply: "none",
    details: [],
    outcome: null,
  };
}

/**
 * A task a session's own budget stopped twice (C-36, `session/budget-card.ts`): raise the
 * project's budget per session, give the task one bigger session, or cancel it.
 */
function sessionBudgetCard(
  r: Pick<HumanRequestRow, "why" | "options">,
  card: JsonObject,
  task: string,
  waiting: readonly string[],
): RequestWords {
  const sessionCap = chfAt(card.session_cap_usd_micro, card.chf_per_usd);
  const projectCap = chfAt(card.project_cap_usd_micro, card.chf_per_usd);
  const spent = chfAt(card.spent_usd_micro, card.chf_per_usd);
  const raiseTo = chfAt(card.raise_to_usd_micro, card.chf_per_usd);
  const body =
    [
      sessionCap
        ? `Two sessions of ${sessionCap} stopped while it ran${spent ? `; it spent ${spent} so far` : ""}.`
        : null,
      waitingSentence(waiting),
    ]
      .filter(Boolean)
      .join(" ") || null;
  const choices: RequestChoiceWords[] = [];
  for (const option of r.options.map(optionLabel)) {
    const what = budgetStopAnswer(option);
    if (what === "raise_session")
      choices.push({
        label: option,
        explain: raiseTo
          ? `Sets this project's budget per session to ${raiseTo} and starts a session that tries again.`
          : "Raises this project's budget per session and starts a session that tries again.",
        tone: "primary",
        confirm: null,
        input: null,
      });
    else if (what === "raise")
      choices.push({
        label: option,
        explain: raiseTo
          ? `Starts one session of ${raiseTo} for it now${projectCap ? `; later sessions keep ${projectCap}` : ""}.`
          : "Starts one bigger session for it now.",
        tone: "secondary",
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
    body,
    choices,
    links: [],
    reply: "none",
    details: [],
    outcome: null,
  };
}

function budgetOutcome(card: JsonObject, ctx: RequestWordsContext): string | null {
  const task = q(ctx.taskTitle ?? str(card.task_title) ?? "the task");
  const started = startWords(card.start);
  switch (card.outcome) {
    case "raise_session": {
      const to = chfAt(card.session_cap_usd_micro_set ?? card.raise_to_usd_micro, card.chf_per_usd);
      return `Raised this project's budget per session${to ? ` to ${to}` : ""}${started ? `: ${started}` : ": the next session tries again"}.`;
    }
    case "raise": {
      if (card.source === "session_budget") {
        const one = chfAt(card.raise_to_usd_micro, card.chf_per_usd);
        return `Gave ${task} one session${one ? ` of ${one}` : ""}${started ? `: ${started}` : ": the next session tries again"}.`;
      }
      const to = chfAt(card.budget_usd_micro ?? card.raise_to_usd_micro, card.chf_per_usd);
      return `Raised the budget of ${task}${to ? ` to ${to}` : ""}${started ? `: ${started}` : ": the next session tries again"}.`;
    }
    case "cancel":
      return `${task} was cancelled.`;
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
  // yes/no answer reads either case (`isYes`, `acceptsAnswer`).
  if (
    ask &&
    labels.length === 2 &&
    /^yes$/i.test(labels[0] ?? "") &&
    /^no$/i.test(labels[1] ?? "")
  ) {
    const consequence = afterFirstSentence(ask);
    choices.splice(
      0,
      2,
      {
        label: "Yes",
        explain: consequence ? cutWords(consequence, 100) : "Makes the change now.",
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
  } else if (key === ANSWER_CARD_KEYS.cannotRun) {
    words = cannotRunCard(r, card, ctx);
    outcome = cannotRunOutcome(card, ctx);
  } else if (key?.startsWith(ANSWER_CARD_KEYS.personQuestionsPrefix)) {
    words = questionsCard(card, ctx);
    outcome = questionsOutcome(card, ctx);
  } else if (key?.startsWith(ANSWER_CARD_KEYS.intakePrefix)) {
    words = intakeCard(r, card, ctx);
    outcome = intakeOutcome(card);
  } else if (key === "sandbox.not_ready") {
    words = dockerCard(r, card, ctx);
    if (card.outcome === "cancel")
      outcome = `${ctx.taskTitle ? q(ctx.taskTitle) : "The task"} was cancelled.`;
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
