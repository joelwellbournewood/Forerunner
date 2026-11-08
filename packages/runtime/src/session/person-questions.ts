import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { GitOps } from "@forerunner/capabilities/githost/git";
import { type Clock, errorMessage, join, log, relative, toPosix } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  StateStore,
  TaskRow,
  TaskStatus,
} from "@forerunner/state";
import { z } from "zod";
import type { ToolSpec } from "../agent/tools.ts";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import {
  ANSWER_CARD_KEYS,
  CANCEL_TASK_OPTION,
  type PersonAnswerItem,
  personQuestionsAnswer,
  personQuestionsAnswerFor,
} from "../wiring/request-answers.ts";
import { answerApplied, markAnswer } from "./answer-mark.ts";
import { recordStart, resumeWork } from "./resume-work.ts";
import type { StartRequest } from "./triggers.ts";

/**
 * What the person chose when they went on without answering (the commands' `WITHOUT_ANSWERS_NOTE`,
 * the Tasks tab's Go ahead without, the Inbox card's): the task's next brief says it, read from
 * the card or the change when the run starts (`answersBlockFor`).
 */
export const WITHOUT_ANSWERS_NOTE =
  "The person chose to go ahead without answering the questions asked about this task: decide yourself and say in the report what you assumed.";

/**
 * Questions only the person can answer (U-022, ADR 0095). A task whose acceptance criteria need
 * the person's answers (a choice of stack, hosting, repository, domain, an account) used to be
 * given to a specialist, which has no way to ask: the run ended with nothing done, the critic
 * graded it "human", the retry ladder ran it four times at a cost, and the Inbox then showed a
 * critic sign-off without the questions. Three ways in, one card:
 *
 * 1. **Planned.** A task planned for the person (`specialist: "person"`, which the intake writes
 *    for a decision the brief does not settle; or, for plans from before, a title such as
 *    "Confirm stack, hosting and repository with the human") is never given to a specialist.
 *    `syncPersonQuestions` (run by `syncApprovals`: at start, after every answer and plan
 *    approval) files its questions at once and moves it `ready -> needs_human`; the executor
 *    does the same for one that reaches a session anyway. Nothing runs, nothing is spent. The
 *    answers are written to the project's decision doc and the task is done.
 * 2. **Asked by a specialist.** `ask_person` (`askPersonTool`), offered to every specialist on
 *    the loop driver, files the questions and ends the run at once (`ToolResult.endRun`): it
 *    never waits in the model loop. The executor sees the card the run filed and ends the task
 *    `needs_human`. Once answered, the task goes back to `ready`, a session of the project is
 *    asked for, and the next run's brief carries the answers (`answersBlockFor`).
 * 3. **Reported to the critic.** A run whose report says it needs the person's answers
 *    (`reportedQuestions`: a "Questions for the person:" list, or a sentence such as "this
 *    needs the human's decision") and that the critic does not accept files the questions,
 *    not a sign-off, and stops the retry ladder at that first verdict (`loop/critic.ts`).
 *
 * The card is a blocking `decision` (`change_card.key` `person_questions:<task id>`) whose
 * steps are the questions and whose one option is "Cancel the task"; the Inbox shows one
 * answer field per question. Its reader (`personQuestionsAnswer`, `wiring/request-answers.ts`)
 * takes the form's `{ answers: [{ question, answer }] }`, one text from anywhere else, or the
 * option. Every answer is applied once (`markAnswer`), with one audit row.
 */
export const PERSON_SPECIALIST = "person";
export const PERSON_QUESTIONS_KEY_PREFIX = ANSWER_CARD_KEYS.personQuestionsPrefix;
export const PERSON_QUESTIONS_OPTIONS = [CANCEL_TASK_OPTION] as const;
export const ASK_PERSON_TOOL = "ask_person";
export const PERSON_ANSWERS_AUDIT_TOOL = "person.answers";
/** Where the answers go, relative to the project's workspace (the intake's first decision). */
export const DECISION_DOC_DIR = "docs/decisions";
/** The decision doc written when the workspace has no `0001-*.md` yet. */
export const DEFAULT_DECISION_DOC = "0001-project-decisions.md";
export const MAX_PERSON_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 500;

export { CANCEL_TASK_OPTION };

/** Where the questions came from (`change_card.source`). */
export type PersonQuestionsSource = "planned" | "specialist" | "critic";

export function personQuestionsKey(taskId: string): string {
  return `${PERSON_QUESTIONS_KEY_PREFIX}${taskId}`;
}

function keyOf(row: Pick<HumanRequestRow, "change_card">): string | undefined {
  const key = (row.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

export function isPersonQuestionsRequest(row: Pick<HumanRequestRow, "change_card">): boolean {
  return keyOf(row)?.startsWith(PERSON_QUESTIONS_KEY_PREFIX) === true;
}

// ---------------------------------------------------------------------------------------
// Which task is the person's

// "me": a title the person wrote for themself ("Confirm the hosting choice with me", "Ask me …").
const PERSON = String.raw`(?:(?:the\s+)?(?:human|person|owner|project\s+owner)|me)`;
/** 1.0.3 plans: "Confirm stack, hosting and repository with the human". */
const LEGACY_TITLE = new RegExp(
  String.raw`\b(?:confirm|decide|agree|clarify|choose|settle|discuss|check|align|ask)\b[^.?!]{0,120}?\b(?:with|by|from)\s+${PERSON}\b`,
  "i",
);
const ASK_TITLE = new RegExp(String.raw`\bask\s+${PERSON}\b`, "i");
const PERSONS_ANSWER =
  /\b(?:human|person|owner)'s\s+(?:answers?|decisions?|choices?|confirmation)\b/i;
/**
 * R-personsanswers: the person's answer as something already made and written down ("Follow the
 * owner's decision in docs/decisions/0001", "per the person's choice", "the owner's choice in
 * docs/hosting.md"), which a task follows; no question for the person.
 */
const RECORDED_ANSWER =
  /\b(?:follow(?:s|ed|ing)?|appl(?:y|ies|ied|ying)|implement(?:s|ed|ing)?|per|according\s+to|respect(?:s|ed|ing)?|keep(?:s|ing)?\s+to)\s+(?:the\s+)?(?:human|person|owner)'s\s+(?:answers?|decisions?|choices?|confirmation)\b|\b(?:human|person|owner)'s\s+(?:answers?|decisions?|choices?|confirmation)\s+(?:(?:recorded|written|documented|kept)\s+)?(?:in|from|at)\s+\S*[/.]\S*/i;

/**
 * Whether a task is the person's to do: planned for "person" (the explicit field on the row,
 * or `planned`, the plan item's specialist), or, for rows from plans made
 * before the field existed, a title that asks the person ("… with the human", "ask the owner",
 * "the human's decision"). "user" is left out: in a product it is the product's user.
 */
export function isPersonTask(
  task: Pick<TaskRow, "title" | "specialist">,
  planned?: string | null,
): boolean {
  for (const named of [planned, task.specialist])
    if (named && canonicalSpecialistName(named) === PERSON_SPECIALIST) return true;
  return (
    LEGACY_TITLE.test(task.title) || ASK_TITLE.test(task.title) || PERSONS_ANSWER.test(task.title)
  );
}

/**
 * A question or an item as the card shows it: one line of at most `MAX_QUESTION_CHARS`. A longer
 * one is cut at the last word that fits, with "…", and keeps its "?" (ADR 0103): cut hard, it
 * lost the question mark mid-word and was no longer asked at all.
 */
const clean = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_QUESTION_CHARS) return t;
  const asked = t.endsWith("?");
  const room = MAX_QUESTION_CHARS - (asked ? 2 : 1);
  const head = t.slice(0, room + 1);
  const space = head.lastIndexOf(" ");
  const words = space >= room / 2 ? head.slice(0, space) : t.slice(0, room);
  return `${words.replace(/[\s,;:(–—-]+$/, "")}…${asked ? "?" : ""}`;
};
const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Confirm stack, hosting and repository with the human" -> stack, hosting, repository. */
function titleItems(title: string): string[] {
  const m = new RegExp(
    String.raw`^\s*(?:confirm|decide(?:\s+on)?|agree(?:\s+on)?|clarify|choose|settle|discuss|check|align\s+on|ask\s+about)\s+(.+?)\s+(?:with|by|from)\s+${PERSON}\b`,
    "i",
  ).exec(title);
  if (!m?.[1]) return [];
  return m[1]
    .split(/\s*,\s*|\s+and\s+|\s*&\s*|\s*\/\s*/)
    .map((s) =>
      s
        .replace(/^(?:the|a|an|our|which)\s+/i, "")
        .replace(/[.:;]+$/, "")
        .trim(),
    )
    .filter((s) => s.length >= 2 && s.length <= 60);
}

/**
 * The questions a planned person task asks: its acceptance criteria that are questions (the
 * intake writes them so), else one per thing its title names ("Stack: what do you choose?"),
 * else its criteria as written, else its title.
 */
export function questionsForTask(
  task: Pick<TaskRow, "title" | "acceptance_criteria" | "outcome">,
): string[] {
  const criteria = task.acceptance_criteria.map(clean).filter((c) => c.length > 0);
  const asked = criteria.filter((c) => c.endsWith("?"));
  if (asked.length) return asked.slice(0, MAX_PERSON_QUESTIONS);
  const items = titleItems(task.title);
  if (items.length)
    return items.slice(0, MAX_PERSON_QUESTIONS).map((i) => `${capital(i)}: what do you choose?`);
  if (criteria.length) return criteria.slice(0, MAX_PERSON_QUESTIONS);
  return [clean(task.title)];
}

// ---------------------------------------------------------------------------------------
// What a run reports

const HEAD_WORDS = String.raw`(?:open\s+)?(?:questions?\s+for\s+(?:the\s+)?(?:person|human|owner|you)|i\s+need\s+(?:the\s+(?:person|human|owner)'s|your)\s+answers?(?:\s+to(?:\s+these)?)?(?:\s+questions)?)`;
const HEADING = new RegExp(
  String.raw`^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*${HEAD_WORDS}\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$`,
  "i",
);
/** "Questions for the person: Which host should it use?": the heading with its one question. */
const HEADING_INLINE = new RegExp(
  String.raw`^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*${HEAD_WORDS}\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(\S.*?)\s*$`,
  "i",
);
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
/** A list that asks nothing: "None", "- n/a", "No questions." */
const NOTHING_ASKED =
  /^(?:none|n\/?a|nothing|no(?:\s+(?:open|further|more|other))?\s+questions?)\b[\s.!]*(?:for\s+now)?[\s.!]*$/i;
/** A line that ends a list: the report's lesson line. */
const LESSON_LINE = /^\s*lesson\s*:/i;
/** A request a plain line makes ("Please add data/members.csv"), which a question list may hold. */
const REQUEST_LINE = /^please\b/i;
/** A sentence that says the work waits for the person ("needs the human's decision"). */
const NEEDS_PERSON =
  /\b(?:need|needs|needed|require|requires|required|waiting\s+(?:on|for)|cannot\s+(?:proceed|continue|finish|decide|be\s+done)\s+without)\b[^.\n]{0,60}?\b(?:(?:the\s+)?(?:person|human|owner)(?:'s)?|your)\s+(?:answers?|decisions?|confirmation|choices?|input)\b/i;

const unbold = (s: string) => s.replace(/^\*\*\s*|\s*\*\*$/g, "").trim();

/**
 * Whether a task's own words say its work needs the person's answers ("needs the owner's
 * decision on hosting", "uses the person's choice of domain"): the credential chooser's hard
 * need "ask the person while it works" (U-078), met only where `ask_person` is offered (the
 * loop driver). A task planned for the person never reaches a specialist (`isPersonTask`).
 */
export function needsPersonsAnswers(task: {
  title: string;
  outcome: string;
  acceptance_criteria: readonly string[];
}): boolean {
  // R-personsanswers: "the owner's decision" anywhere was a hard need, so "Follow the owner's
  // decision in docs/decisions/0001" moved the task onto the API key (money); a decision already
  // recorded, which the task follows, is not one.
  return [task.title, task.outcome, ...task.acceptance_criteria].some(
    (t) => NEEDS_PERSON.test(t) || (PERSONS_ANSWER.test(t) && !RECORDED_ANSWER.test(t)),
  );
}

/**
 * One entry of a question list: a bulleted or numbered item as it is, or a plain line that asks
 * (ends with "?") or requests ("Please add …"); null for anything else, which ends the list.
 */
function listEntry(line: string): string | null {
  const item = ITEM.exec(line)?.[1];
  if (item) return unbold(item) || null;
  const plain = unbold(line.trim());
  if (!plain || LESSON_LINE.test(plain)) return null;
  return plain.endsWith("?") || REQUEST_LINE.test(plain) ? plain : null;
}

/** Where a report's question list starts: its heading's line, and a question on that line. */
function headingAt(line: string): { inline: string | null } | null {
  if (HEADING.test(line)) return { inline: null };
  const m = HEADING_INLINE.exec(line);
  return m?.[1] ? { inline: unbold(m[1]) } : null;
}

/**
 * The questions under a report's "Questions for the person:" heading (the form the brief asks
 * for: "one question per line"), at most `MAX_PERSON_QUESTIONS`; none when it has no such list.
 * Any list style reads (live L-2, 2026-11-02: the garden club's "Home page" wrote its two
 * questions as plain lines, only "-", "*", "•" and "1." items were read, and the person got a
 * sign-off with no questions): bulleted or numbered items, plain lines that ask ("…?") or
 * request ("Please …"), blank lines between them, bold lines, a question on the heading's own
 * line. The list ends at a line that is none of those (the lesson line, prose, a heading); after
 * a blank line only a question goes on with it. A list that says it asks nothing ("None",
 * "- n/a") asks nothing. Only this explicit list counts when the critic accepted the work (ADR
 * 0104): an accepted report that mentions the person in passing is not a question.
 */
export function listedQuestions(report: string | null | undefined): string[] {
  if (!report) return [];
  const lines = report.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = headingAt(lines[i] ?? "");
    if (!head) continue;
    const questions: string[] = [];
    if (head.inline?.endsWith("?")) questions.push(clean(head.inline));
    let gap = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (!line.trim()) {
        gap = questions.length > 0;
        continue;
      }
      const entry = listEntry(line);
      if (entry === null || NOTHING_ASKED.test(entry)) break;
      if (gap && !entry.endsWith("?")) break;
      questions.push(clean(entry));
      gap = false;
    }
    if (questions.length) return questions.slice(0, MAX_PERSON_QUESTIONS);
  }
  return [];
}

// Words that say nothing about what a question asks.
const COMMON_WORDS = new Set(
  (
    "what which where when who whom whose why how that this these those there their them they " +
    "with from into onto about your yours have has had does doing done will would should could " +
    "shall must might want need needs like some any more most other than then also just only " +
    "very each every both such here page task work file files please give tell know make sure " +
    "used uses using correct right real-time"
  ).split(" "),
);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .split(/[^a-z0-9@.\-/]+/)
      .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ""))
      .filter((w) => w.length >= 4 && !COMMON_WORDS.has(w)),
  );
}

/** Words of a sentence that say why something is asked: it is missing, a placeholder, assumed. */
const REASON_WORDS =
  /\b(?:because|placeholder|missing|not\s+given|(?:does\s*n[o']t|did\s*n[o']t|does\s+not|did\s+not)\s+(?:give|say|name|include)|gave\s+no|no\s+real|unknown|not\s+known|assum\w*|guess\w*|invent\w*|unclear|not\s+sure|has\s+no|have\s+no)\b/i;
/** A report section about what is open ("Not done / risks", "Assumptions", "Open points"). */
const OPEN_SECTION = /not\s+done|risks?|open|blocked|caveats?|assum|limitation|gaps?|unknown/i;
/** A markdown label at the start of a line: "**Summary**:", "## Risks", "Files changed:". */
const LABEL = /^\s*(?:#{1,6}\s*)?\*\*([^*]+)\*\*\s*:?\s*/;

/** A report's sentences with the section each is in, without the question list and lessons. */
function reportSentences(report: string): { text: string; open: boolean }[] {
  const out: { text: string; open: boolean }[] = [];
  let open = false;
  let inQuestions = false;
  for (const raw of report.split(/\r?\n/)) {
    if (headingAt(raw)) {
      inQuestions = true;
      continue;
    }
    if (!raw.trim()) continue;
    if (inQuestions && listEntry(raw) !== null) continue;
    inQuestions = false;
    if (LESSON_LINE.test(raw)) continue;
    let line = raw;
    const label = LABEL.exec(line);
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (label?.[1]) {
      open = OPEN_SECTION.test(label[1]);
      line = line.slice(label[0].length);
    } else if (heading?.[1]) {
      open = OPEN_SECTION.test(heading[1]);
      continue;
    }
    const text = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/[`*]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // A dot inside a word (a file name, an address) does not end a sentence.
    for (const s of text.match(/(?:[^.!?]|[.!?](?=\S))+[.!?]+(?=\s|$)|(?:[^.!?]|[.!?](?=\S))+$/g) ??
      [])
      if (s.trim() && !s.trim().endsWith("?")) out.push({ text: s.trim(), open });
  }
  return out;
}

/**
 * Why the specialist asks, as its questions card quotes it (design §3.8: "in the specialist's
 * own words"): the report's sentence that says most about what the first question asks (the
 * words they share), a sentence under "Not done / risks" or one that says something is missing,
 * a placeholder or assumed weighing more; the next question's when the first shares no word
 * with any sentence; null when none does. Live (L-12, 2026-11-02) the "Contact page" card
 * quoted the report's first words, ': I made no edits this run…', not that the email address
 * was a placeholder.
 */
export function questionsReason(
  report: string | null | undefined,
  questions: readonly string[],
): string | null {
  if (!report) return null;
  const sentences = reportSentences(report);
  for (const q of questions) {
    const asked = contentWords(q);
    let best: { text: string; score: number } | null = null;
    for (const s of sentences) {
      const words = contentWords(s.text);
      const shared = [...asked].filter((w) => words.has(w)).length;
      if (shared === 0) continue;
      const score = shared + (s.open ? 1 : 0) + (REASON_WORDS.test(s.text) ? 1 : 0);
      if (!best || score > best.score) best = { text: s.text, score };
    }
    if (best) return clean(best.text).slice(0, MAX_QUESTION_CHARS);
  }
  return null;
}

/**
 * Whether a run's report says it needs the person's answers, and the questions it asks: the
 * items under a "Questions for the person:" heading (the form the brief asks for where the
 * `ask_person` tool is not offered), else, when a sentence says the work needs the person's
 * answers or decision, the report's lines that end with a question mark (possibly none: the
 * caller then asks the task's own questions). Null when the report says nothing of the kind.
 */
export function reportedQuestions(
  report: string | null | undefined,
): { questions: string[] } | null {
  if (!report) return null;
  const listed = listedQuestions(report);
  if (listed.length) return { questions: listed };
  const lines = report.split(/\r?\n/);
  if (!NEEDS_PERSON.test(report)) return null;
  const asked = lines
    .map((l) => ITEM.exec(l)?.[1] ?? l)
    .map(clean)
    .filter((l) => l.endsWith("?") && l.length >= 6);
  return { questions: [...new Set(asked)].slice(0, MAX_PERSON_QUESTIONS) };
}

// ---------------------------------------------------------------------------------------
// The card

export interface PersonQuestionsCard {
  key: string;
  task_id: string;
  task_title: string;
  questions: string[];
  source: PersonQuestionsSource;
  /** What an answer does to the task: a planned task is done, a paused one goes on. */
  on_answer: "done" | "ready";
  run_id: string | null;
  /** The specialist's or the report's own words about why it asks; quoted, never acted on. */
  context: string | null;
  /**
   * False when the person went ahead without answering on this task before (live L-3): the
   * card does not offer Go ahead without again, which only ran the same ask once more.
   */
  go_ahead: boolean;
  decision_doc: string;
  applied_at: string | null;
}

/** The card a row carries, read defensively (a card that does not fit is null). */
export function personQuestionsCardOf(
  row: Pick<HumanRequestRow, "change_card">,
): PersonQuestionsCard | null {
  if (!isPersonQuestionsRequest(row)) return null;
  const c = (row.change_card ?? {}) as JsonObject;
  if (typeof c.task_id !== "string") return null;
  const questions = Array.isArray(c.questions)
    ? c.questions.filter((q): q is string => typeof q === "string")
    : [];
  return {
    key: String(c.key),
    task_id: c.task_id,
    task_title: typeof c.task_title === "string" ? c.task_title : "",
    questions,
    source: c.source === "specialist" || c.source === "critic" ? c.source : "planned",
    on_answer: c.on_answer === "ready" ? "ready" : "done",
    run_id: typeof c.run_id === "string" ? c.run_id : null,
    context: typeof c.context === "string" ? c.context : null,
    go_ahead: c.go_ahead !== false,
    decision_doc: typeof c.decision_doc === "string" ? c.decision_doc : DECISION_DOC_DIR,
    applied_at: typeof c.applied_at === "string" ? c.applied_at : null,
  };
}

function whyFor(source: PersonQuestionsSource, title: string): string {
  const where = `Your answers are written to the project's decision record (${DECISION_DOC_DIR}/0001-…).`;
  switch (source) {
    case "planned":
      return `"${title}" needs your answers. No specialist works on it: answer the questions below. ${where} The task is then done.`;
    case "specialist":
      return `The specialist working on "${title}" needs your answers before it can go on. ${where} The task then continues, and its next run gets your answers.`;
    case "critic":
      return `"${title}" stopped because the work needs your answers; it was not retried. ${where} The task then continues, and its next run gets your answers.`;
  }
}

export interface FilePersonQuestionsInput {
  task: TaskRow;
  humanId: string;
  /** The principal agent the card is filed for (author). */
  agentId: string | null;
  sessionId?: string | null;
  runId?: string | null;
  source: PersonQuestionsSource;
  /** Empty: the task's own questions (`questionsForTask`). */
  questions?: readonly string[];
  context?: string | null;
  /** False: the card offers no Go ahead without (the person went ahead without before). */
  goAhead?: boolean;
}

/** The task's person-questions cards that are open, or answered and not applied yet. */
export async function pendingPersonQuestions(
  store: Pick<StateStore, "humanRequest">,
  taskId: string,
): Promise<HumanRequestRow[]> {
  const rows = await store.humanRequest.list({ task_id: taskId } as never, { limit: 200 });
  return rows.filter(
    (r) =>
      keyOf(r) === personQuestionsKey(taskId) &&
      (r.status === "open" || (r.status === "answered" && !answerApplied(r))),
  );
}

/**
 * File the person's questions for a task, or return the card already open or waiting to be
 * applied for it (one card per task at a time).
 */
export async function filePersonQuestions(
  store: Pick<StateStore, "humanRequest">,
  input: FilePersonQuestionsInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { task } = input;
  const existing = (await pendingPersonQuestions(store, task.id))[0];
  if (existing) return { request: existing, reused: true };
  const asked = (input.questions ?? []).map(clean).filter((q) => q.length > 0);
  const questions = (asked.length ? asked : questionsForTask(task)).slice(0, MAX_PERSON_QUESTIONS);
  const card: PersonQuestionsCard = {
    key: personQuestionsKey(task.id),
    task_id: task.id,
    task_title: task.title,
    questions,
    source: input.source,
    on_answer: input.source === "planned" ? "done" : "ready",
    run_id: input.runId ?? null,
    context: input.context ? input.context.slice(0, 2000) : null,
    go_ahead: input.goAhead !== false,
    decision_doc: DECISION_DOC_DIR,
    applied_at: null,
  };
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.sessionId ?? null,
    kind: "decision",
    why: whyFor(input.source, task.title).slice(0, 4000),
    steps: questions,
    options: [...PERSON_QUESTIONS_OPTIONS],
    blocking: true,
    risk: "low",
    change_card: card as unknown as JsonObject,
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

/** The open card a run filed through `ask_person`, if any. */
export async function questionsAskedByRun(
  store: Pick<StateStore, "humanRequest">,
  taskId: string,
  runId: string,
): Promise<HumanRequestRow | null> {
  const rows = await pendingPersonQuestions(store, taskId);
  return rows.find((r) => personQuestionsCardOf(r)?.run_id === runId) ?? null;
}

// ---------------------------------------------------------------------------------------
// The specialist's tool

export interface AskPersonToolDeps {
  store: StateStore;
}

/**
 * `ask_person`: the specialist files its questions in the person's Inbox and its run ends at
 * once (`endRun`); the tool never waits for the answer, so no model loop is held open. The
 * action class is `read` (free at every autonomy level): asking a question changes nothing
 * the person has not seen, and an approval to ask would be a question about a question.
 */
export function askPersonTool(
  deps: AskPersonToolDeps,
): ToolSpec<{ questions: string[]; why?: string }> {
  return {
    name: ASK_PERSON_TOOL,
    description:
      "Ask the person you work for questions only they can answer (a choice of stack, hosting, repository, domain, an account, a preference). The questions go to their Inbox and this run ends at once; the task waits until they answer, and the next run of the task gets the answers. Use it only when the acceptance criteria cannot be met without those answers, never for something you can decide or find out yourself. Write each question so it can be answered on its own.",
    schema: z.object({
      questions: z
        .array(z.string().trim().min(3).max(MAX_QUESTION_CHARS))
        .min(1)
        .max(MAX_PERSON_QUESTIONS),
      why: z.string().max(2000).optional(),
    }),
    actionClass: "read",
    risk: "low",
    async execute(input, ctx) {
      if (!ctx.taskId)
        return { content: "ask_person works only inside a task's run.", isError: true };
      const task = await deps.store.task.get(ctx.taskId);
      if (!task) return { content: `task ${ctx.taskId} not found`, isError: true };
      // Go ahead without (design §3.8: "the specialist decides and says what it assumed"): the
      // person said not to be asked on this task. Live (L-3) the next run asked the same
      // question again and the Inbox showed a second card, at a run's cost each time.
      if (await wentAheadWithout(deps.store, task.id))
        return { content: ASK_REFUSED_AFTER_WITHOUT, isError: true };
      const { request, reused } = await filePersonQuestions(deps.store, {
        task,
        humanId: ctx.humanId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        source: "specialist",
        questions: input.questions,
        context: input.why ?? null,
      });
      const n = request.steps.length;
      return {
        content: reused
          ? `The person already has open questions for this task (request ${request.id}). Stop here: the task waits for their answers.`
          : `${n} question(s) are in the person's Inbox (request ${request.id}). Stop here: this run ends, the task waits for the answers, and the next run gets them.`,
        endRun: true,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The answers in the next run's brief

/** What `ask_person` says on a task the person went ahead on without answering. */
export const ASK_REFUSED_AFTER_WITHOUT =
  "Not asked: the person chose to go ahead without answering the questions asked about this task, so no question is put to them again. Decide yourself and say in your report what you assumed; if the work cannot be done at all without an answer (an input that is missing), say so in your report.";

/** The store a task's "Go ahead without" is read from: its cards, and the Tasks tab's moves. */
type WithoutStore = Pick<StateStore, "humanRequest"> &
  Partial<Pick<StateStore, "task" | "changeLog">>;

/**
 * The questions the person went ahead without answering on this task, oldest first, or null
 * when they never did: a questions card answered "Go ahead without" in the Inbox, or the Tasks
 * tab's Go ahead without (`task.resume` with the answers left out: its change records the note
 * it queued, `without_answers_note_id`), unless undone. Read from the store when a run starts,
 * so a session that was already running when the person chose sees it (live L-3: the note the
 * answer queued was not in the queue that session had read at its start).
 */
export async function withoutAnswersOn(
  store: WithoutStore,
  taskId: string,
): Promise<{ questions: string[] } | null> {
  const rows = (await store.humanRequest.list({ task_id: taskId } as never, { limit: 200 }))
    .filter((r) => keyOf(r) === personQuestionsKey(taskId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  let found = false;
  const questions: string[] = [];
  const add = (qs: readonly string[]) => {
    for (const q of qs) if (!questions.includes(q)) questions.push(q);
  };
  for (const row of rows) {
    if (row.status !== "answered" || personQuestionsAnswer(row.answer)?.kind !== "without")
      continue;
    found = true;
    add(personQuestionsCardOf(row)?.questions ?? row.steps);
  }
  const task = store.task ? await store.task.get(taskId) : undefined;
  if (store.changeLog && task?.project_id) {
    for (const change of await store.changeLog.forProject(task.project_id, { limit: 200 })) {
      if (change.undo_state === "undone") continue;
      const after = change.after as JsonObject | null;
      if (after?.task_id !== taskId || typeof after.without_answers_note_id !== "string") continue;
      found = true;
      // The questions it went without: the cards the move withdrew.
      const withdrawn = Array.isArray(after.withdrawn_requests) ? after.withdrawn_requests : [];
      for (const row of rows) if (withdrawn.includes(row.id)) add(row.steps);
    }
  }
  return found ? { questions: questions.slice(0, MAX_PERSON_QUESTIONS) } : null;
}

/**
 * Whether the person already answered what `task`'s words ask of them (its questions answered
 * in the Inbox, or "Go ahead without" pressed), so its runs no longer need a credential that
 * can ask (`needsOf`'s `answered`). False for a task whose words ask nothing. The run's pick and
 * the Start check read it here, so they agree (leftovers7-tailrun TR-3).
 */
export async function personAnswered(
  store: WithoutStore,
  task: Parameters<typeof needsPersonsAnswers>[0] & { id: string },
): Promise<boolean> {
  if (!needsPersonsAnswers(task)) return false;
  return (
    (await wentAheadWithout(store, task.id).catch(() => false)) ||
    (await answersBlockFor(store, task.id).catch(() => "")) !== ""
  );
}

/** Whether the person went ahead without answering on this task (`withoutAnswersOn`). */
export async function wentAheadWithout(store: WithoutStore, taskId: string): Promise<boolean> {
  return (await withoutAnswersOn(store, taskId)) !== null;
}

/**
 * What the person said to the questions a specialist or the critic asked on this task, as a
 * block for the next run's first message (design §4.6: "answers the person gave or 'the person
 * chose to go ahead without answering'"); empty when there is nothing. The answers of applied
 * cards, oldest first, quoted as they were given; then, when the person went ahead without
 * answering (`withoutAnswersOn`), that choice, the questions it covers and that they are not
 * asked again.
 */
export async function answersBlockFor(store: WithoutStore, taskId: string): Promise<string> {
  const rows = (await store.humanRequest.list({ task_id: taskId } as never, { limit: 200 }))
    .filter((r) => keyOf(r) === personQuestionsKey(taskId) && r.status === "answered")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const parts: string[] = [];
  for (const row of rows) {
    const read = personQuestionsAnswer(row.answer);
    if (read?.kind !== "answers") continue;
    const card = personQuestionsCardOf(row);
    parts.push(...renderPairs(card?.questions ?? row.steps, read.answers));
  }
  const without = await withoutAnswersOn(store, taskId);
  if (!parts.length && !without) return "";
  return [
    "## Answers from the person",
    "",
    ...(parts.length
      ? [
          "The person answered the questions asked on this task. Use these answers to meet the acceptance criteria; do not ask them again.",
          "",
          ...parts,
        ]
      : []),
    ...(without
      ? [
          WITHOUT_ANSWERS_NOTE,
          "",
          ...(without.questions.length
            ? ["The questions they left open:", ...without.questions.map((q) => `- ${q}`), ""]
            : []),
          "Do not ask the person again: ask_person is refused for this task. If the work cannot be done at all without an answer (an input that is missing), say so in your report.",
          "",
        ]
      : []),
  ]
    .join("\n")
    .trimEnd();
}

/** What the person said on a task another task waited on (`personAnswersOn`). */
export interface PersonAnswersOn {
  /** The question and answer lines of every answered card, oldest first; empty when none. */
  pairs: string[];
  /** The person went ahead without answering (Go ahead without). */
  without: boolean;
  /** Where the answers are recorded in the project's folder (`docs/decisions/0001-….md`). */
  doc: string | null;
}

/**
 * The person's answers to the questions asked on a task (its planned questions, or a
 * specialist's), for the brief of a task that waited on it (live walk 2, phase C). Before, that
 * brief said only what the plan had promised the person's task would do ("the answers are
 * recorded in docs/data.md"): the coder of the next task asked the same seven questions again.
 */
export async function personAnswersOn(
  store: Pick<StateStore, "humanRequest">,
  taskId: string,
): Promise<PersonAnswersOn> {
  const rows = (await store.humanRequest.list({ task_id: taskId } as never, { limit: 200 }))
    .filter((r) => keyOf(r) === personQuestionsKey(taskId) && r.status === "answered")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: PersonAnswersOn = { pairs: [], without: false, doc: null };
  for (const row of rows) {
    const read = personQuestionsAnswer(row.answer);
    if (read?.kind === "without") out.without = true;
    if (read?.kind !== "answers") continue;
    const card = personQuestionsCardOf(row);
    out.pairs.push(...renderPairs(card?.questions ?? row.steps, read.answers));
    const doc = (row.change_card as JsonObject | null)?.doc;
    if (typeof doc === "string" && doc.trim()) {
      const name = doc.split(/[\\/]/).pop();
      if (name) out.doc = `${DECISION_DOC_DIR}/${name}`;
    }
  }
  return out;
}

function renderPairs(questions: readonly string[], answers: readonly PersonAnswerItem[]): string[] {
  const out: string[] = [];
  if (answers.length === 1 && answers[0]?.question === null) {
    if (questions.length) {
      out.push("Questions:", "", ...questions.map((q) => `- ${q}`), "");
    }
    out.push("Answer:", "", answers[0].answer, "");
    return out;
  }
  for (const a of answers) {
    out.push(`**${a.question ?? "Answer"}**`, "", a.answer, "");
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The decision doc

/** The first decision doc in the workspace (`docs/decisions/0001-*.md`), or the default name. */
async function decisionDocPath(workspace: string): Promise<string> {
  const dir = join(workspace, ...DECISION_DOC_DIR.split("/"));
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const first = names.filter((n) => /^0001-.+\.md$/i.test(n)).sort()[0];
  return join(dir, first ?? DEFAULT_DECISION_DOC);
}

const marker = (requestId: string) => `<!-- forerunner:answers ${requestId} -->`;

/**
 * Appends the answers to the project's decision doc in its workspace (created with a title
 * when there is none). Idempotent per request: a section already carrying the request's marker
 * is not written again. Returns the doc's path.
 */
export async function writeAnswersToDecisionDoc(input: {
  workspace: string;
  request: HumanRequestRow;
  card: PersonQuestionsCard;
  answers: readonly PersonAnswerItem[];
  answeredBy: string;
  date: string;
}): Promise<string> {
  const path = await decisionDocPath(input.workspace);
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }
  if (current.includes(marker(input.request.id))) return path;
  const asked =
    input.card.source === "planned"
      ? "Asked by the project plan."
      : input.card.source === "specialist"
        ? "Asked by the specialist working on the task."
        : "Asked when the work stopped for your answers.";
  const section = [
    `## Answers for "${input.card.task_title || input.request.task_id}" (${input.date.slice(0, 10)})`,
    "",
    marker(input.request.id),
    `${asked} Answered by ${input.answeredBy} in the Inbox.`,
    "",
    ...renderPairs(
      input.card.questions.length ? input.card.questions : input.request.steps,
      input.answers,
    ),
  ].join("\n");
  await mkdir(join(input.workspace, ...DECISION_DOC_DIR.split("/")), { recursive: true });
  await writeFile(path, withSection(current, section), "utf8");
  await answersIntoBaseline(input.workspace, path, input.request.id, section);
  return path;
}

/** The decision doc `current` with `section` appended (a title first when it is empty). */
function withSection(current: string, section: string): string {
  const head = current.trim()
    ? `${current.replace(/\s*$/, "")}\n\n`
    : "# 0001: Project decisions\n\nDecisions about this project, with the answers you gave in the Inbox.\n\n";
  return `${head}${section.replace(/\s*$/, "")}\n`;
}

/** Who commits the answers into a workspace (as the executor's own baseline commits). */
const WORKSPACE_GIT_IDENTITY = { name: "Forerunner", email: "forerunner@localhost" } as const;

/**
 * The answers join the workspace's baseline as they are written (phase C review). A run going
 * on in the same folder is measured against HEAD (its "Workspace before ..." commit): the
 * critic reads `git diff HEAD` as the run's work, and a cancel of the run takes everything
 * since HEAD out of the folder (ADR 0105). Left uncommitted, answers given while another task
 * ran were taken out with that run when the person cancelled it, while the person task stayed
 * done with "the answers are in the decision record". So they are committed on top of HEAD as
 * the file HEAD holds plus this section, with the files in the folder untouched: the run's own
 * edits stay its change. A folder that is no git repository yet (no run worked there) is left
 * as it is: the first run's baseline takes the answers in. A failure is logged; the answers
 * are in the file either way.
 */
async function answersIntoBaseline(
  workspace: string,
  path: string,
  requestId: string,
  section: string,
): Promise<void> {
  if (!existsSync(join(workspace, ".git"))) return;
  try {
    const git = new GitOps({ cwd: workspace, identity: WORKSPACE_GIT_IDENTITY });
    if (!(await git.hasCommits())) return;
    const rel = toPosix(relative(workspace, path));
    const before = (await git.fileAt("HEAD", rel)) ?? "";
    if (before.includes(marker(requestId))) return;
    await git.commitFile(
      rel,
      withSection(before, section),
      `Answers recorded in ${rel} (request ${requestId})`,
    );
  } catch (e) {
    log("person-questions").warn("the answers were not committed into the workspace", {
      requestId,
      error: errorMessage(e),
    });
  }
}

// ---------------------------------------------------------------------------------------
// The sync: file what is due, apply what was answered

export interface PersonQuestionsSyncDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The principal agent: files the cards and moves the tasks. */
  agentId: string;
  /** `<projects>/<id>/workspace`: where the decision doc is written. */
  workspaceDir: (projectId: string) => string;
  /**
   * Asks for a session of the project once questions asked during work are answered, so the
   * task's next run gets them (the daemon's scheduler; absent in a one-shot).
   */
  start?: (req: StartRequest) => Promise<unknown>;
}

export interface PersonQuestionsSyncResult {
  /** Planned person tasks whose questions were filed by this sync. */
  filed: number;
  /** Answers applied: written to the decision doc, the task done or back at ready. */
  answered: number;
  cancelled: number;
  /** Answers recorded without acting (`task_moved_on`, `unrecognized_answer`, `doc_failed`). */
  skipped: number;
}

/** Statuses a planned person task is filed from: waiting to run, or stuck with a sign-off. */
const FILE_FROM: readonly TaskStatus[] = ["ready", "needs_human"];
/** needs_human -> done is no edge: the task closes along the graph's own edges. */
const CLOSE_PATH: readonly TaskStatus[] = ["ready", "claimed", "in_progress", "in_review", "done"];

export async function syncPersonQuestions(
  deps: PersonQuestionsSyncDeps,
): Promise<PersonQuestionsSyncResult> {
  const out: PersonQuestionsSyncResult = { filed: 0, answered: 0, cancelled: 0, skipped: 0 };
  out.filed = await fileDueQuestions(deps);
  await applyAnswers(deps, out);
  return out;
}

/**
 * Planned person tasks of this agent's projects that wait (`ready`) or are stuck in
 * `needs_human` without their questions (a 1.0.3 plan's task that a specialist failed, with a
 * critic sign-off that has nothing to answer): their questions are filed, a `ready` one moves
 * to `needs_human`, and the stale sign-off is withdrawn.
 */
async function fileDueQuestions(deps: PersonQuestionsSyncDeps): Promise<number> {
  const { store } = deps;
  const logger = log("person-questions");
  let filed = 0;
  const tasks = await store.task.list({ status: [...FILE_FROM] } as never, { limit: 2000 });
  const projects = new Map<string, boolean>();
  for (const task of tasks) {
    if (!isPersonTask(task)) continue;
    const mine =
      task.owner_agent_id === deps.agentId ||
      (task.owner_agent_id === null &&
        (task.author_agent === deps.agentId || task.author_human === deps.humanId));
    if (!mine) continue;
    if (!projects.has(task.project_id)) {
      const p = await store.project.get(task.project_id);
      projects.set(task.project_id, !!p && p.status === "active");
    }
    if (!projects.get(task.project_id)) continue;
    if ((await pendingPersonQuestions(store, task.id)).length) continue;
    try {
      await store.transaction(async (tx) => {
        const { request } = await filePersonQuestions(tx, {
          task,
          humanId: deps.humanId,
          agentId: deps.agentId,
          source: "planned",
        });
        if (task.status === "ready")
          await tx.task.transition(
            task.id,
            task.version,
            "needs_human",
            `waiting for your answers in the Inbox (request ${request.id})`,
            { agentId: deps.agentId },
          );
        for (const r of await tx.humanRequest.list({ task_id: task.id, status: "open" } as never, {
          limit: 50,
        })) {
          if (keyOf(r) === "critic:signoff") await tx.humanRequest.withdraw(r.id, r.version);
        }
      });
      filed++;
    } catch (e) {
      logger.warn("person questions not filed", { taskId: task.id, error: errorMessage(e) });
    }
  }
  return filed;
}

async function applyAnswers(
  deps: PersonQuestionsSyncDeps,
  out: PersonQuestionsSyncResult,
): Promise<void> {
  const { store, clock } = deps;
  const logger = log("person-questions");
  const rows = (
    await store.humanRequest.list(
      { kind: "decision", human_id: deps.humanId, status: "answered" } as never,
      { limit: 500, orderBy: [{ column: "created_at" }, { column: "id" }] },
    )
  ).filter((r) => isPersonQuestionsRequest(r) && !answerApplied(r));
  for (const row of rows) {
    const card = personQuestionsCardOf(row);
    const audit = (tx: Pick<StateStore, "auditLog">, outcome: string, status: string | null) =>
      tx.auditLog.append({
        session_id: row.session_id,
        run_id: card?.run_id ?? null,
        agent_id: deps.agentId,
        human_id: deps.humanId,
        tool: PERSON_ANSWERS_AUDIT_TOOL,
        input_summary: JSON.stringify({
          requestId: row.id,
          taskId: row.task_id,
          source: card?.source ?? null,
        }),
        result_summary: JSON.stringify({ outcome, status }),
        allowed: true,
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
      });
    // Read against the card: "go ahead" on the person's own card is no answer (phase E). The
    // routes refuse it; one stored anyway (an older daemon) is recorded unrecognized, and the
    // task, still waiting, gets its questions filed again by the next sync.
    const answer = personQuestionsAnswerFor(row.change_card, row.answer);
    const task = card ? await store.task.get(card.task_id) : undefined;
    if (!card || !answer) {
      if (await markAnswer(store, clock, row, "unrecognized_answer")) out.skipped++;
      continue;
    }
    try {
      if (answer.kind === "without") {
        // Design §3.8 "Go ahead without": the specialist decides and says what it assumed. The
        // task goes back to ready and work resumes; its next brief says the person chose to go
        // ahead without answering, read from this card when the run starts (`answersBlockFor`),
        // and `ask_person` is refused on it. No note is queued for it: a session already running
        // reads the queue only at its start, so the next run missed it (live L-3).
        let follow = false;
        await store.transaction(async (tx) => {
          const claimed = await markAnswer(tx, clock, row, "without");
          if (!claimed) return;
          const current = task ? await tx.task.get(task.id) : undefined;
          let status: string | null = current?.status ?? null;
          const actor = { agentId: deps.agentId, humanId: deps.humanId };
          const reason = "you chose to go ahead without answering its questions";
          // Only a specialist's card offers it (`personQuestionsAnswerFor`): the task goes back
          // to its specialist, never closed on no answers.
          if (current && current.status === "needs_human") {
            const t = await tx.task.transition(current.id, current.version, "ready", reason, actor);
            status = t.status;
            follow = true;
          }
          await audit(tx, "without", status);
          out.answered++;
        });
        if (follow && task)
          await recordStart(
            store,
            row.id,
            await resumeWork(store, deps.start, {
              agentId: deps.agentId,
              projectId: task.project_id,
              reason: `you chose to go ahead without answering "${task.title}"`,
            }),
          );
        continue;
      }
      if (answer.kind === "cancel") {
        await store.transaction(async (tx) => {
          const claimed = await markAnswer(tx, clock, row, "cancelled");
          if (!claimed) return;
          let status: string | null = task?.status ?? null;
          if (task && task.status !== "done" && task.status !== "cancelled") {
            const fresh = await tx.task.mustGet(task.id);
            status = (
              await tx.task.transition(
                fresh.id,
                fresh.version,
                "cancelled",
                `you cancelled it in the Inbox instead of answering (request ${row.id})`,
                { agentId: deps.agentId, humanId: deps.humanId },
              )
            ).status;
          }
          await audit(tx, "cancelled", status);
          out.cancelled++;
        });
        continue;
      }
      // The answers are the person's decisions whatever became of the task: the doc first. A
      // doc that cannot be written does not hold the task back; the answers stay on the
      // request and in the decision log, and the card names the error.
      let doc: JsonObject = {};
      if (row.project_id) {
        try {
          const human = await store.human.get(deps.humanId);
          doc = {
            doc: await writeAnswersToDecisionDoc({
              workspace: deps.workspaceDir(row.project_id),
              request: row,
              card,
              answers: answer.answers,
              answeredBy: human?.name ?? "you",
              date: row.answered_at ?? clock.nowIso(),
            }),
          };
        } catch (e) {
          logger.warn("answers not written to the decision doc", {
            requestId: row.id,
            error: errorMessage(e),
          });
          doc = { doc_error: errorMessage(e).slice(0, 500) };
        }
      }
      let follow = false;
      await store.transaction(async (tx) => {
        const current = task ? await tx.task.get(task.id) : undefined;
        const movedOn =
          !current ||
          current.status === "done" ||
          current.status === "cancelled" ||
          current.status === "failed";
        const claimed = await markAnswer(
          tx,
          clock,
          row,
          movedOn ? "task_moved_on" : "answered",
          doc,
        );
        if (!claimed) return;
        if (movedOn || !current) {
          await audit(tx, "task_moved_on", current?.status ?? null);
          out.skipped++;
          return;
        }
        const actor = { agentId: deps.agentId, humanId: deps.humanId };
        const reason = `you answered its questions in the Inbox (request ${row.id})`;
        let t = current;
        if (card.on_answer === "done") {
          // The findings of failed attempts at the person's task asked for these answers.
          for (const f of await tx.finding.openFor(t.id))
            await tx.finding.resolve(f.id, f.version, null);
          const from = CLOSE_PATH.indexOf(t.status);
          const path =
            t.status === "needs_human" ? CLOSE_PATH : from >= 0 ? CLOSE_PATH.slice(from + 1) : [];
          for (const to of path) t = await tx.task.transition(t.id, t.version, to, reason, actor);
          // The person's task is done: the tasks that wait on it may run now.
          follow = t.status === "done";
        } else if (t.status === "needs_human") {
          t = await tx.task.transition(t.id, t.version, "ready", reason, actor);
          follow = true;
        } else if (t.status === "ready") {
          follow = true;
        }
        await audit(tx, "answered", t.status);
        out.answered++;
      });
      // Answering resumes work (design §3.8): the task goes on in a session of its project, or,
      // the person's own task now done, what waits on it does. resumeWork starts only when a
      // task of the project can run; the card records what became of the start for its "Done"
      // line.
      if (follow && task)
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: `your answers to "${task.title}"`,
          }),
        );
    } catch (e) {
      logger.warn("person answers not applied", { requestId: row.id, error: errorMessage(e) });
    }
  }
}
