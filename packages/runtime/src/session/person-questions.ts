import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { type Clock, errorMessage, join, log } from "@forerunner/platform";
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
} from "../wiring/request-answers.ts";
import { answerApplied, markAnswer } from "./answer-mark.ts";
import type { StartRequest } from "./triggers.ts";

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
const MAX_QUESTION_CHARS = 500;

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

const PERSON = String.raw`(?:the\s+)?(?:human|person|owner|project\s+owner)`;
/** 1.0.3 plans: "Confirm stack, hosting and repository with the human". */
const LEGACY_TITLE = new RegExp(
  String.raw`\b(?:confirm|decide|agree|clarify|choose|settle|discuss|check|align|ask)\b[^.?!]{0,120}?\b(?:with|by|from)\s+${PERSON}\b`,
  "i",
);
const ASK_TITLE = new RegExp(String.raw`\bask\s+${PERSON}\b`, "i");
const PERSONS_ANSWER =
  /\b(?:human|person|owner)'s\s+(?:answers?|decisions?|choices?|confirmation)\b/i;

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

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
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

const HEADING =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:open\s+)?(?:questions?\s+for\s+(?:the\s+)?(?:person|human|owner|you)|i\s+need\s+(?:the\s+(?:person|human|owner)'s|your)\s+answers?(?:\s+to(?:\s+these)?)?(?:\s+questions)?)\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
/** A sentence that says the work waits for the person ("needs the human's decision"). */
const NEEDS_PERSON =
  /\b(?:need|needs|needed|require|requires|required|waiting\s+(?:on|for)|cannot\s+(?:proceed|continue|finish|decide|be\s+done)\s+without)\b[^.\n]{0,60}?\b(?:(?:the\s+)?(?:person|human|owner)(?:'s)?|your)\s+(?:answers?|decisions?|confirmation|choices?|input)\b/i;

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
  const lines = report.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING.test(lines[i] ?? "")) continue;
    const questions: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      const item = ITEM.exec(line);
      if (item?.[1]) {
        questions.push(clean(item[1].replace(/^\*\*|\*\*$/g, "")));
        continue;
      }
      if (!line.trim() && questions.length === 0) continue;
      break;
    }
    if (questions.length) return { questions: questions.slice(0, MAX_PERSON_QUESTIONS) };
  }
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

/**
 * The answers the person gave to the questions a specialist or the critic asked on this task
 * (applied cards, oldest first), as a block for the next run's first message; empty when there
 * are none. The person's words are quoted as they were given.
 */
export async function answersBlockFor(
  store: Pick<StateStore, "humanRequest">,
  taskId: string,
): Promise<string> {
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
  if (!parts.length) return "";
  return [
    "## Answers from the person",
    "",
    "The person answered the questions asked on this task. Use these answers to meet the acceptance criteria; do not ask them again.",
    "",
    ...parts,
  ].join("\n");
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
  const head = current.trim()
    ? `${current.replace(/\s*$/, "")}\n\n`
    : "# 0001: Project decisions\n\nDecisions about this project, with the answers you gave in the Inbox.\n\n";
  await mkdir(join(input.workspace, ...DECISION_DOC_DIR.split("/")), { recursive: true });
  await writeFile(path, `${head}${section.replace(/\s*$/, "")}\n`, "utf8");
  return path;
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
    const answer = personQuestionsAnswer(row.answer);
    const task = card ? await store.task.get(card.task_id) : undefined;
    if (!card || !answer) {
      if (await markAnswer(store, clock, row, "unrecognized_answer")) out.skipped++;
      continue;
    }
    try {
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
        } else if (t.status === "needs_human") {
          t = await tx.task.transition(t.id, t.version, "ready", reason, actor);
          follow = true;
        } else if (t.status === "ready") {
          follow = true;
        }
        await audit(tx, "answered", t.status);
        out.answered++;
      });
      if (follow && deps.start && task) {
        await deps
          .start({
            agentId: deps.agentId,
            projectId: task.project_id,
            trigger: "message",
            reason: `your answers to "${task.title}" (request ${row.id})`,
          })
          .catch((e: unknown) =>
            logger.warn("session after the answers not started", {
              requestId: row.id,
              error: errorMessage(e),
            }),
          );
      }
    } catch (e) {
      logger.warn("person answers not applied", { requestId: row.id, error: errorMessage(e) });
    }
  }
}
