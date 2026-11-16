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
  /\bautonomy\b/i,
  /\b(change|raise|lower|set|skip|turn (?:on|off)|switch)\b[^.\n]{0,30}\b(review levels?|reviews?|settings?|permissions?)\b/i,
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
 * A critic's finding that is a note, not an order (L-4, as the brief reads it): marked `info`,
 * or a problem the runtime measured that the task's files cannot have caused.
 */
export function isCriticNote(f: { severity: string; description: string }): boolean {
  return f.severity === "info" || f.description.endsWith(NOT_CAUSED_BY_TASK);
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
