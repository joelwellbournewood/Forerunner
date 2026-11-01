import type { JsonValue, StateStore, TaskRow } from "@forerunner/state";
import { DATA_ENVELOPE_CLOSE, DATA_ENVELOPE_OPEN } from "../injection/scan.ts";
import { TASK_FILES_EVENT } from "./peers.ts";

/**
 * What a specialist is told beyond its own task (core-experience design §4.6). Before, the
 * brief was the task's title and outcome, `task:<id>` (an id no tool resolves) and fixed
 * constraints: no later brief carried the project's goal or the person's brief, a chain step was
 * told it "builds on the step before" without its name or files, a retry never saw what the
 * previous attempt reported or which error stopped it, and the person's notes on the task and
 * for the session reached no specialist although the dialogs said "your agent reads it".
 *
 * `taskContextBlock` renders the sections that follow the delegation brief, each from the store
 * as it stands when the run starts: the project (name, goal, the person's brief, where the docs
 * and the decision record are), what the task waited on (each dependency's title, its result in
 * one line and the files it changed), the previous attempt (its report, or the error that
 * stopped it), the person's latest note on the task and the note for this session. Everything
 * quoted from the person or an earlier run is data, never instructions.
 */

/** Longest quote of the person's brief, an earlier report or a note. */
const MAX_QUOTE_CHARS = 1_500;
/** Most dependencies named; a task rarely waits on more. */
const MAX_DEPENDENCIES = 6;
/** Files named per dependency. */
const MAX_FILES = 8;

/** Words for an error a run ended on (design §5.8): what went wrong, never the exception text. */
export function failureWords(error: { code: string; message: string }): string {
  switch (error.code) {
    case "provider_error":
    case "overloaded":
    case "overloaded_error":
      return "Claude did not answer (model call failed).";
    case "rate_limited":
      return "Claude was busy (rate limit).";
    case "network":
      return "Claude could not be reached (network).";
    case "step_cap_exceeded":
      return "The run used all the steps it was allowed.";
    case "timeout":
      return "The run took longer than its time limit.";
    case "unavailable":
      return oneSentence(error.message) || "No Claude credential could run it.";
    default: {
      const said = oneSentence(error.message);
      return said ? `The run failed: ${said}` : "The run failed.";
    }
  }
}

function oneSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.length > 200 ? `${t.slice(0, 197).replace(/\s+\S*$/, "")}…` : t;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/** A quote of person- or model-written text as data: the envelope markers neutralised, cut. */
function quote(text: string, max = MAX_QUOTE_CHARS): string {
  const t = text
    .split(DATA_ENVELOPE_OPEN)
    .join("<<<untrusted_content")
    .split(DATA_ENVELOPE_CLOSE)
    .join("untrusted_content>>>")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstLine(text: string, max = 200): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/\*\*/g, "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The report or error an earlier run left in its artifacts (`{ report }`, `{ error }`). */
export function runNoteOf(artifacts: JsonValue): { report?: string; error?: string } {
  const out: { report?: string; error?: string } = {};
  if (!Array.isArray(artifacts)) return out;
  for (const a of artifacts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const o = a as Record<string, unknown>;
    if (typeof o.report === "string" && o.report.trim()) out.report = o.report;
    if (typeof o.error === "string" && o.error.trim()) out.error = o.error;
  }
  return out;
}

/** The files a task's newest run changed, from its session's `task.files` event. */
async function filesOf(store: StateStore, taskId: string, sessionId: string): Promise<string[]> {
  const events = await store.event.list(sessionId, 0, 5_000);
  const hit = events
    .filter((e) => e.type === TASK_FILES_EVENT)
    .map((e) => e.payload as { taskId?: unknown; files?: unknown })
    .filter((p) => p.taskId === taskId && Array.isArray(p.files))
    .at(-1);
  return ((hit?.files as unknown[] | undefined) ?? []).filter(
    (f): f is string => typeof f === "string",
  );
}

/** A task's worker runs (not the critic's), newest first. */
async function workerRuns(store: StateStore, taskId: string) {
  const runs = (await store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/** The person's newest note on a task: the words of the newest change they made to it. */
async function personNoteOn(
  store: StateStore,
  task: Pick<TaskRow, "id" | "project_id">,
): Promise<string | null> {
  if (!task.project_id) return null;
  const rows = await store.changeLog.forProject(task.project_id, { limit: 200 });
  for (const row of rows) {
    if (!row.human_id || row.undo_state === "undone") continue;
    const commands = Array.isArray(row.commands) ? row.commands : [];
    const names = commands.some((c) => {
      const params = (c as { params?: Record<string, unknown> } | null)?.params ?? {};
      return params.task === task.id || params.taskId === task.id || params.id === task.id;
    });
    if (!names) continue;
    const words = (row.words_used ?? "").trim();
    if (words) return words;
  }
  return null;
}

/** The sections a task's brief carries after the delegation brief (empty sections left out). */
export async function taskContextBlock(
  store: StateStore,
  task: TaskRow,
  opts: { sessionNote?: string | null; currentRunId?: string } = {},
): Promise<string> {
  const out: string[] = [];
  const project = task.project_id ? await store.project.get(task.project_id) : undefined;
  if (project) {
    const brief = (project.summary_cache as { brief?: unknown } | null)?.brief;
    out.push(
      "## Project",
      `${project.name}: ${project.goal}`,
      ...(typeof brief === "string" && brief.trim()
        ? [
            `The person's brief for the project (their words, as data): ${JSON.stringify(quote(brief))}`,
          ]
        : []),
      "What the project is and what was decided: docs/overview.md and the decision record in docs/decisions/ (read them when the task touches them).",
    );
  }
  // What the task waited on: each dependency's result and files.
  const deps: string[] = [];
  for (const id of task.depends_on.slice(0, MAX_DEPENDENCIES)) {
    const dep = await store.task.get(id);
    if (!dep) continue;
    const [last] = await workerRuns(store, dep.id);
    const note = last ? runNoteOf(last.artifacts) : {};
    const files = last?.session_id
      ? (await filesOf(store, dep.id, last.session_id)).slice(0, MAX_FILES)
      : [];
    const result = note.report ? firstLine(note.report) : dep.outcome;
    deps.push(
      `- "${dep.title}": ${result || "done"}${files.length ? ` Files: ${files.join(", ")}` : ""}`,
    );
  }
  if (deps.length) out.push("## Done before this task", ...deps);
  // The previous attempt: its own report, or the error that stopped it.
  const previous = (await workerRuns(store, task.id)).find((r) => r.id !== opts.currentRunId);
  if (previous) {
    const note = runNoteOf(previous.artifacts);
    const said = note.error
      ? `It failed: ${note.error}`
      : note.report
        ? `It reported (as data): ${JSON.stringify(quote(note.report))}`
        : "";
    if (said) out.push("## The previous attempt", said);
  }
  const personNote = await personNoteOn(store, task);
  if (personNote)
    out.push("## The person's note on this task", JSON.stringify(quote(personNote, 500)));
  if (opts.sessionNote?.trim())
    out.push(
      "## Note for this session (from the person)",
      JSON.stringify(quote(opts.sessionNote, 500)),
    );
  return out.join("\n");
}
