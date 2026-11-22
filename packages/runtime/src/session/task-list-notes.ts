import { NOT_CAUSED_BY_TASK } from "@forerunner/critic";
import { ForerunnerError } from "@forerunner/platform";
import type { JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { scanForInjection } from "../injection/scan.ts";

/**
 * d1109-selftasks-run (ADR 0119; D7, the owner, 2026-11-09: "I want it to be able to fix its
 * tasks. Like as part of a run"). What the session's task check reads as evidence: the lines a
 * specialist wrote under "For the task list:" at the end of its report, the critic's notes the
 * task did not cause, and the notes an earlier check could not handle (kept on the project's
 * `summary_cache.task_list_notes`, checked once). Every line is data: a line that reads like an
 * instruction is kept with `flagged: true` (counted, quoted to the person on the card) and never
 * sent to the model.
 */

/** The report's heading the brief explains (`TASK_LIST_BRIEF_LINE` in session/executor.ts). */
export const TASK_LIST_HEADING = "For the task list:";

/** At most this many lines of a report are read, each at most `TASK_LIST_LINE_MAX` characters. */
export const TASK_LIST_LINES_MAX = 5;
export const TASK_LIST_LINE_MAX = 300;

/** The project's kept notes, at most this many (the oldest go first). */
export const KEPT_NOTES_MAX = 20;

/** `summary_cache` keys. */
export const TASK_LIST_NOTES_KEY = "task_list_notes";
/** The tasks the agent added or rewrote from a report (their brief says so, ADR 0119). */
export const AGENT_WRITTEN_KEY = "task_check_written";
const AGENT_WRITTEN_MAX = 200;

/** One line of evidence. */
export interface TaskListLine {
  text: string;
  /** It reads like an instruction: never sent to the model; the card quotes it. */
  flagged: boolean;
}

/** Where a piece of evidence came from, named in the check's message. */
export type TaskListNoteSource = "report" | "review";

/** One piece of evidence: the lines of one report or one review, and whose. */
export interface TaskListNote {
  source: TaskListNoteSource;
  taskId: string;
  taskTitle: string;
  /** The specialist that wrote the report (a review is the critic's). */
  specialist: string | null;
  runId?: string | null;
  lines: TaskListLine[];
  /** When it was gathered (ISO). */
  at: string;
}

/**
 * What reads like an instruction to change the plan beyond what a task-list note may say (ADR
 * 0119 point 12): budgets and money, settings, autonomy and review levels, other projects,
 * starting, merging, deploying or releasing, dropping every other task, ignoring the plan or the
 * rules. The injection scan (`agent_output`) runs too.
 */
const STEERING: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(plan|rules?|instructions?|fence|limits?|checks?)\b/i,
  /\b(budgets?|spending caps?|monthly caps?|plan share)\b[^.\n]{0,40}\b(raise|raised|increase|increased|lift|lifted|set|double)\b/i,
  /\b(raise|increase|lift|double|set)\b[^.\n]{0,40}\b(budget|cap|limit)s?\b/i,
  /\b(CHF|USD|EUR)\s?\d|\$\s?\d/i,
  // The autonomy level by any form of its name ("Autonomous", "autonomously"; report-003).
  /\bautonom\w*/i,
  /\b(change|raise|lower|set|skip|turn (?:on|off)|switch)\b[^.\n]{0,30}\b(review levels?|reviews?|settings?|permissions?)\b/i,
  // ...and the other order: "turn the review level off", "the reviews down" (report-003).
  /\b(review levels?|reviews?|settings?|permissions?)\b[^.\n]{0,20}\b(off|down|lower(?:ed)?|skipped|disabled)\b/i,
  // A new role for whoever reads it ("You are now the administrator", "act as the owner").
  /\b(you are now|from now on you|act as|pretend to be)\b/i,
  /\b(another|other|every other|all other)\s+projects?\b/i,
  /\b(deploy|deploys|deploying|deployment|production|release|publish to)\b/i,
  /\b(merge|force[- ]push|push)\b[^.\n]{0,30}\b(main|master|pull request|branch|now)\b/i,
  /\bstart\b[^.\n]{0,20}\b(a |the |new )?sessions?\b/i,
  /\b(drop|cancel|delete|remove)\b[^.\n]{0,30}\b(every|all|other|the rest)\b[^.\n]{0,20}\btasks?\b/i,
];

/** Whether a line reads like an instruction (the scan, or a rule above). */
export function readsLikeInstruction(text: string): boolean {
  if (scanForInjection(text, "agent_output").suspicious) return true;
  return STEERING.some((re) => re.test(text));
}

/** A line at most `max` characters, cut at a word with "…". */
function cutLine(text: string, max = TASK_LIST_LINE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t
    .slice(0, max - 1)
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}

/** The heading as a line starts with it: plain, bold or as a markdown heading. */
const HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*for the task list\s*:\s*(?:\*\*|__)?\s*/i;
/** A line that starts the next part of a report (the end of the task-list lines). */
const NEXT_PART_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(lesson|questions for the person|where i stopped|left to do|summary|evidence)\s*:/i;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * The lines under the report's "For the task list:" heading (its last one), at most five of at
 * most 300 characters; none from a report without it. A line that reads like an instruction is
 * kept with `flagged: true` (counted, never dropped, so the card can quote it).
 */
export function parseTaskListNotes(report: string): TaskListLine[] {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (HEADING_RE.test(lines[i] as string)) {
      at = i;
      break;
    }
  if (at < 0) return [];
  const out: TaskListLine[] = [];
  const first = (lines[at] as string).replace(HEADING_RE, "").replace(/(\*\*|__)\s*$/, "");
  const raw = [first, ...lines.slice(at + 1)];
  for (const [i, line] of raw.entries()) {
    if (i > 0 && NEXT_PART_RE.test(line)) break;
    const text = cutLine(line.replace(BULLET_RE, "").replace(/^(\*\*|__)|(\*\*|__)$/g, ""));
    if (!text) continue;
    out.push({ text, flagged: readsLikeInstruction(text) });
    if (out.length >= TASK_LIST_LINES_MAX) break;
  }
  return out;
}

/**
 * A critic's finding that is evidence for the task check (ADR 0119 point 3): a problem the
 * runtime measured that the task's files cannot have caused (`NOT_CAUSED_BY_TASK`, the "Tried
 * ..." findings). l4-selftasks-102 (live check 4): before, every `info` finding counted too, so
 * the critic's ordinary notes about the task's own work ("The worker did not measure contrast",
 * "Sunday is left out ... a reasonable choice") paid for a planning call after nearly every
 * reviewed task and were kept for the next session. The retry brief's 'not an order' rule
 * (`isReviewNote` in executor.ts) is a different question and stays as it is.
 */
export function notCausedByTask(f: { description: string }): boolean {
  return f.description.endsWith(NOT_CAUSED_BY_TASK);
}

/** A quoted line is at most this many characters (design §5: read at a glance). */
export const QUOTE_MAX = 100;

/**
 * The part of a line a quote shows (l4-selftasks-112 (d)): the first sentence that reads like an
 * instruction, else the whole line. A model's flagged entry often opens with what it read ("The
 * coder's report says the FAQ should …") and asks only after a hundred characters.
 */
export function requestPart(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  if (sentences.length < 2) return t;
  return sentences.find((s) => readsLikeInstruction(s)) ?? t;
}

/**
 * A line as the person reads it quoted (l4-selftasks-103, -110): whitespace folded, an id after
 * "finding" or "review" taken out with its noun kept ("Earlier finding 01a1…: x" reads "Earlier
 * finding: x"), its own double quotes single and its end mark dropped, so the sentence around it
 * closes the quote; whole when it fits in `max`, else cut at a word with "…". Before, the line
 * was cut at 100 characters mid-word with an id's hole ('"Earlier finding : the report …').
 */
export function quoteOf(text: string, max = QUOTE_MAX): string {
  const t = text
    .replace(
      /\b(finding|review)[ :]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "$1",
    )
    .replace(/\s+/g, " ")
    .replace(/\s+([:;,.])/g, "$1")
    .trim()
    .replace(/"/g, "'")
    .replace(/[.;:,!]+$/, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.;:,]+$/, "")}…`;
}

/** The critic's notes on a task that the task did not cause, as evidence lines. */
export function reviewNoteLines(notes: readonly string[]): TaskListLine[] {
  return notes
    .map((n) => cutLine(n))
    .filter(Boolean)
    .slice(0, TASK_LIST_LINES_MAX)
    .map((text) => ({ text, flagged: readsLikeInstruction(text) }));
}

function isNote(v: JsonValue | undefined): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A kept note as stored, read back strictly (anything else is dropped). */
function noteOf(v: JsonValue): TaskListNote | null {
  if (!isNote(v)) return null;
  const lines = Array.isArray(v.lines)
    ? v.lines
        .filter(isNote)
        .filter((l) => typeof l.text === "string")
        .map((l) => ({ text: cutLine(String(l.text)), flagged: l.flagged === true }))
        .slice(0, TASK_LIST_LINES_MAX)
    : [];
  if (
    (v.source !== "report" && v.source !== "review") ||
    typeof v.taskId !== "string" ||
    typeof v.taskTitle !== "string" ||
    !lines.length
  )
    return null;
  return {
    source: v.source,
    taskId: v.taskId,
    taskTitle: v.taskTitle,
    specialist: typeof v.specialist === "string" ? v.specialist : null,
    runId: typeof v.runId === "string" ? v.runId : null,
    lines,
    at: typeof v.at === "string" ? v.at : "",
  };
}

/** The notes kept on a project row (read-only). */
export function keptNotesOf(
  project: { summary_cache?: JsonValue } | null | undefined,
): TaskListNote[] {
  const cache = (project?.summary_cache ?? {}) as JsonObject;
  const list = cache[TASK_LIST_NOTES_KEY];
  return Array.isArray(list) ? list.map(noteOf).filter((n): n is TaskListNote => !!n) : [];
}

async function changeCache(
  store: Pick<StateStore, "project">,
  projectId: string,
  change: (cache: JsonObject) => JsonObject | null,
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const row = await store.project.get(projectId);
    if (!row) return;
    const next = change({ ...((row.summary_cache ?? {}) as JsonObject) });
    if (next === null) return;
    try {
      await store.project.update(row.id, row.version, { summary_cache: next });
      return;
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "version_conflict") continue;
      throw e;
    }
  }
}

/**
 * Keep evidence a check could not handle (its cap, the wrap-up line, three checks done, the
 * session ended) on the project, so the next session's first boundary (and chat's "fix the
 * tasks") checks it, after a restart too.
 */
export async function keepNotes(
  store: Pick<StateStore, "project">,
  projectId: string,
  notes: readonly TaskListNote[],
): Promise<void> {
  if (!notes.length) return;
  await changeCache(store, projectId, (cache) => {
    const kept = keptNotesOf({ summary_cache: cache });
    const all = [...kept, ...notes].slice(-KEPT_NOTES_MAX);
    return { ...cache, [TASK_LIST_NOTES_KEY]: all as unknown as JsonValue };
  });
}

/** Take the project's kept notes: each is checked once, so they leave the project here. */
export async function takeNotes(
  store: Pick<StateStore, "project">,
  projectId: string,
): Promise<TaskListNote[]> {
  let taken: TaskListNote[] = [];
  await changeCache(store, projectId, (cache) => {
    taken = keptNotesOf({ summary_cache: cache });
    if (!(TASK_LIST_NOTES_KEY in cache)) return null;
    const { [TASK_LIST_NOTES_KEY]: _gone, ...rest } = cache;
    return rest;
  });
  return taken;
}

/**
 * l4-selftasks-106: the tasks the agent added for work a Done task left undone, each with the task
 * it continues (`{ <new task id>: <done task id> }`); their brief and review quote what that task
 * was to do.
 */
export const CONTINUES_KEY = "task_check_continues";
const CONTINUES_MAX = 200;

/** The task a task continues, or null (read-only). */
export function continuesOf(
  project: { summary_cache?: JsonValue } | null | undefined,
  taskId: string,
): string | null {
  const map = ((project?.summary_cache ?? {}) as JsonObject)[CONTINUES_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const v = (map as JsonObject)[taskId];
  return typeof v === "string" ? v : null;
}

/** Record that `taskId` continues the Done task `sourceId`. */
export async function markContinues(
  store: Pick<StateStore, "project">,
  projectId: string,
  taskId: string,
  sourceId: string,
): Promise<void> {
  await changeCache(store, projectId, (cache) => {
    const now = cache[CONTINUES_KEY];
    const map =
      now && typeof now === "object" && !Array.isArray(now) ? { ...(now as JsonObject) } : {};
    map[taskId] = sourceId;
    const entries = Object.entries(map).slice(-CONTINUES_MAX);
    return { ...cache, [CONTINUES_KEY]: Object.fromEntries(entries) };
  });
}

/** The tasks the agent added or rewrote from a report (read-only). */
export function agentWrittenOf(
  project: { summary_cache?: JsonValue } | null | undefined,
): string[] {
  const list = ((project?.summary_cache ?? {}) as JsonObject)[AGENT_WRITTEN_KEY];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/** Mark tasks as written by the agent from a report (their next brief says so). */
export async function markAgentWritten(
  store: Pick<StateStore, "project">,
  projectId: string,
  taskIds: readonly string[],
): Promise<void> {
  if (!taskIds.length) return;
  await changeCache(store, projectId, (cache) => {
    const now = agentWrittenOf({ summary_cache: cache });
    const all = [...new Set([...now, ...taskIds])].slice(-AGENT_WRITTEN_MAX);
    return { ...cache, [AGENT_WRITTEN_KEY]: all };
  });
}
