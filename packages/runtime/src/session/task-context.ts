import type { JsonValue, StateStore, TaskRow } from "@forerunner/state";
import { DATA_ENVELOPE_CLOSE, DATA_ENVELOPE_OPEN } from "../injection/scan.ts";
import { handoffOf, keptOf, type RunHandoff, type RunKept } from "./budget-pause.ts";
import { TASK_FILES_EVENT } from "./peers.ts";
import { isPersonTask, personAnswersOn } from "./person-questions.ts";
import { continuesOf } from "./task-list-notes.ts";

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
 * one line and the files it changed, and the person's answers to the questions asked on it),
 * the previous attempt (its report, or the error that
 * stopped it) and the note for this session. The person's notes on the task come with the
 * queued notes that name it (`renderQueueNotes`, after this block). Everything quoted from the
 * person or an earlier run is data, never instructions.
 */

/** Longest quote of the person's brief, an earlier report or a note. */
const MAX_QUOTE_CHARS = 1_500;
/** Most dependencies named; a task rarely waits on more. */
const MAX_DEPENDENCIES = 6;
/** Files named per dependency. */
const MAX_FILES = 8;
/** Longest quote of the person's answers on one task this one waited on. */
const MAX_ANSWERS_CHARS = 6_000;

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
    // ADR 0112: a stop at a budget is a pause, never "The run failed: run budget would be exceeded".
    case "budget_exceeded":
      return "The run stopped at a budget before its next step.";
    case "timeout":
      return "The run took longer than its time limit.";
    // U-078: a refused key or sign-in is said as such, never "model call failed".
    case "provider_auth":
      return "Anthropic refused the Claude key or sign-in. Save a new one in Settings.";
    case "unavailable":
      // The router's own words ("no billing source available for session work on the pc
      // runner") are no sentence for a person (U-078).
      return /no billing source available/i.test(error.message)
        ? "No Claude credential can be used now."
        : oneSentence(error.message) || "No Claude credential could run it.";
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
  // A report's first line often starts with its own heading ("**Summary** ..."): the words only.
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "")
    .replace(/\*\*/g, "")
    .trim()
    .replace(/^(summary|result|report)\s*:?\s+/i, "");
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

/** The heading of the section a paused task's next run starts from (budget-resume). */
export const WHERE_LAST_RUN_STOPPED = "## Where the last run stopped";

/**
 * budget-resume (ADR 0112 amended): what the task's last run left when it paused at a budget,
 * for the run that continues it: its work in progress is in the folder (a commit of its own),
 * then its note ("Where I stopped"), the files it changed and its "Left to do" list, each quoted
 * as data. A run that paused without a wrap-up (a tiny budget, a hard stop) wrote no note: the
 * section says so and lists the files. Before, the next run read "It failed: run budget would be
 * exceeded" (or only its report), did not know the work was its own, and could redo it.
 */
export function whereTheLastRunStopped(
  handoff: RunHandoff | null,
  files: readonly string[],
  kept: RunKept | null = null,
): string[] {
  const lines = [
    WHERE_LAST_RUN_STOPPED,
    files.length
      ? "The last run of this task paused at a budget before its work was done. Its work so far is in the folder you work in (kept as a commit of its own): continue from it, do not start again."
      : "The last run of this task paused at a budget before its work was done, before it changed any file.",
  ];
  const note = handoff?.stopped.trim() ?? "";
  if (note) lines.push(`Its note (as data): ${JSON.stringify(quote(note, 600))}`);
  else
    lines.push(
      "It left no note: it stopped at its budget before it could write one. Read the files it changed to see where the work stands.",
    );
  lines.push(
    files.length
      ? `Files it changed: ${files.map((f) => JSON.stringify(f)).join(", ")}`
      : "Files it changed: none.",
  );
  if (handoff?.leftToDo.length)
    lines.push(
      "Left to do, as it listed it (as data):",
      ...handoff.leftToDo.map((t) => `- ${JSON.stringify(quote(t, 200))}`),
      // d1109-oversize-pause (OP-3): the next step first, as the wrap-up asked for it.
      "Start with the first item of its list, unless a check below failed.",
    );
  lines.push(...keptChecksLines(kept));
  // OP-3, OP-4: the person continued a pause that got no further: try another way.
  if (kept?.noProgress)
    lines.push(
      "The last two runs of this task did not get further: try another way, and if something outside the task blocks it, say so under Where I stopped:.",
    );
  return lines;
}

/** What stopped a run on its Claude credential (CE-5): its limit, a refusal, the share. */
export type CredentialStopReason = "limit" | "refused" | "share";

/**
 * d1109-cred-engine CE-5 (ADR 0120; the owner's 7a: "allow the task to be completed by the API,
 * but in a transparent way"): what the task's last run left when its Claude credential stopped
 * it, for the run that continues it (on the next credential, or the same one after the stop):
 * its work so far is in the folder (a commit of its own), then its note if it wrote one, the
 * files it changed and its "Left to do". A sibling of `whereTheLastRunStopped`; before, such a
 * run read "## The previous attempt" / "It failed: ..." and could redo the work.
 */
export function whereTheCredentialStopped(
  reason: CredentialStopReason,
  handoff: RunHandoff | null,
  files: readonly string[],
  kept: RunKept | null = null,
): string[] {
  const what =
    reason === "refused"
      ? "was refused"
      : reason === "share"
        ? "reached the share of the subscription Forerunner may use"
        : "reached its limit";
  const lines = [
    WHERE_LAST_RUN_STOPPED,
    files.length
      ? `The last run of this task stopped when its Claude credential ${what}, before its work was done. Its work so far is in the folder you work in (kept as a commit of its own): continue from it, do not start again.`
      : `The last run of this task stopped when its Claude credential ${what}, before it changed any file.`,
  ];
  const note = handoff?.stopped.trim() ?? "";
  if (note) lines.push(`Its note (as data): ${JSON.stringify(quote(note, 600))}`);
  else
    lines.push(
      `It left no note: its Claude credential stopped it before it could write one.${
        files.length ? " Read the files it changed to see where the work stands." : ""
      }`,
    );
  lines.push(
    files.length
      ? `Files it changed: ${files.map((f) => JSON.stringify(f)).join(", ")}`
      : "Files it changed: none.",
  );
  if (handoff?.leftToDo.length)
    lines.push(
      "Left to do, as it listed it (as data):",
      ...handoff.leftToDo.map((t) => `- ${JSON.stringify(quote(t, 200))}`),
      "Start with the first item of its list, unless a check below failed.",
    );
  lines.push(...keptChecksLines(kept));
  return lines;
}

/** The credential stop a run row records (CE-5): its outcome, or the share it names. */
export function credentialStopOfRun(run: {
  outcome: string | null;
  artifacts: unknown;
}): CredentialStopReason | null {
  if (run.outcome === "credential_refused") return "refused";
  if (run.outcome !== "usage_limit") return null;
  const list = Array.isArray(run.artifacts) ? run.artifacts : [];
  const share = list.some(
    (a) =>
      !!a &&
      typeof a === "object" &&
      (a as { credentialStop?: unknown }).credentialStop === "share",
  );
  return share ? "share" : "limit";
}

/**
 * C5-left-1 (CE-11): whether the task's last worker run (before `currentRunId`) was stopped by
 * its Claude credential, so the run that follows goes on "from where it stopped".
 */
export async function lastRunCredentialStopped(
  store: StateStore,
  taskId: string,
  currentRunId?: string,
): Promise<boolean> {
  const previous = (await workerRuns(store, taskId)).find((r) => r.id !== currentRunId);
  return !!previous && credentialStopOfRun(previous) !== null;
}

/**
 * OP-3: the project's checks on the kept work when the last run stopped (`RunKept.checks`), for
 * the run that continues it: 'When it stopped, the project's checks on its work passed: build,
 * test.', or 'When it stopped, the project's checks on its work: test failed.' with the end of
 * each failed check's output (as data, JSON-quoted, at most 1,500 characters, already redacted)
 * and 'Make a failed check pass first, unless it tests work that is still on its list.'. Nothing
 * when no check ran.
 */
export function keptChecksLines(kept: RunKept | null): string[] {
  const checks = kept?.checks ?? [];
  if (!checks.length) return [];
  const failed = checks.filter((c) => !c.passed);
  if (!failed.length)
    return [
      `When it stopped, the project's checks on its work passed: ${checks.map((c) => c.name).join(", ")}.`,
    ];
  return [
    `When it stopped, the project's checks on its work: ${failed.map((c) => c.name).join(", ")} failed.`,
    ...failed
      .filter((c) => c.output.trim())
      .map(
        (c) =>
          `The end of its output${failed.length > 1 ? ` (${c.name})` : ""} (as data): ${JSON.stringify(quote(c.output, 1_500))}`,
      ),
    "Make a failed check pass first, unless it tests work that is still on its list.",
  ];
}

/**
 * l4-selftasks-106: the line a task the agent added for a Done task's undone work carries in its
 * brief and its review ('This task continues "X": what that task was to do (the plan's words, as
 * data): …'); null for any other task.
 */
export async function continuesLine(store: StateStore, task: TaskRow): Promise<string | null> {
  const project = task.project_id ? await store.project.get(task.project_id) : undefined;
  const sourceId = continuesOf(project, task.id);
  const source = sourceId ? await store.task.get(sourceId) : undefined;
  if (!source?.outcome.trim()) return null;
  return `This task continues "${source.title}": what that task was to do (the plan's words, as data): ${JSON.stringify(quote(source.outcome, 600))}`;
}

/**
 * l4-selftasks-106 (live check 4: the critic called an address from the person's own brief "an
 * invented contact detail", and one the person typed in the Inbox "not found in any project
 * file"): what the person gave for a task, as the critic's review is told it, as data: the
 * person's brief for the project and their answers to the questions asked on the task and on
 * each task it waited for, with the decision record they are recorded in. The worker's brief
 * carries the same (`taskContextBlock`); null when the person gave nothing.
 */
export async function personContextOf(store: StateStore, task: TaskRow): Promise<string | null> {
  const out: string[] = [];
  const project = task.project_id ? await store.project.get(task.project_id) : undefined;
  const brief = (project?.summary_cache as { brief?: unknown } | null)?.brief;
  if (typeof brief === "string" && brief.trim())
    out.push(`The person's brief for the project: ${JSON.stringify(quote(brief))}`);
  const asked: { title: string; id: string }[] = [{ title: task.title, id: task.id }];
  for (const id of task.depends_on.slice(0, MAX_DEPENDENCIES)) {
    const dep = await store.task.get(id);
    if (dep) asked.push({ title: dep.title, id: dep.id });
  }
  for (const t of asked) {
    const said = await personAnswersOn(store, t.id);
    if (!said.pairs.length) continue;
    out.push(
      `The person's answers to the questions on "${t.title}"${said.doc ? ` (recorded in ${said.doc})` : ""}:`,
      quote(said.pairs.join("\n").trim(), MAX_ANSWERS_CHARS),
    );
  }
  return out.length ? out.join("\n") : null;
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
    const continues = await continuesLine(store, task);
    if (continues) out.push(continues);
  }
  // What the task waited on: each dependency's result and files, and the person's answers to
  // the questions asked on it (live walk 2: the next task's coder asked the same questions
  // again, its brief having only the plan's promise for the person's task).
  const deps: string[] = [];
  const answered: string[] = [];
  for (const id of task.depends_on.slice(0, MAX_DEPENDENCIES)) {
    const dep = await store.task.get(id);
    if (!dep) continue;
    const [last] = await workerRuns(store, dep.id);
    const note = last ? runNoteOf(last.artifacts) : {};
    const files = last?.session_id
      ? (await filesOf(store, dep.id, last.session_id)).slice(0, MAX_FILES)
      : [];
    const said = await personAnswersOn(store, dep.id);
    const persons = isPersonTask(dep);
    // A task the person did has no run: its result is what they answered, never the outcome
    // the plan wrote for it (a promise of where the answers would go).
    const result = note.report
      ? firstLine(note.report)
      : said.pairs.length
        ? "the person answered its questions (their answers are below)."
        : said.without
          ? "the person chose to go ahead without answering its questions: decide yourself and say in your report what you assumed."
          : persons
            ? "done by the person."
            : dep.outcome;
    deps.push(
      `- "${dep.title}": ${result || "done"}${files.length ? ` Files: ${files.join(", ")}` : ""}`,
    );
    if (said.pairs.length)
      answered.push(
        `## Answers from the person to "${dep.title}"`,
        `These are the person's own answers, given in the Inbox for a task this one waited on${
          said.doc ? ` (also recorded in ${said.doc})` : ""
        }. Use them; do not ask the person these questions again.`,
        "",
        quote(said.pairs.join("\n").trim(), MAX_ANSWERS_CHARS),
      );
  }
  if (deps.length) out.push("## Done before this task", ...deps);
  if (answered.length) out.push(...answered);
  // The previous attempt: its own report, or the error that stopped it. A run that paused at a
  // budget (ADR 0112) left its work in progress for this one: its section comes first.
  const previous = (await workerRuns(store, task.id)).find((r) => r.id !== opts.currentRunId);
  const credentialStop = previous ? credentialStopOfRun(previous) : null;
  if (previous && credentialStop) {
    // CE-5: its credential stopped it: its work is kept for this run to continue.
    const files = previous.session_id
      ? (await filesOf(store, task.id, previous.session_id)).slice(0, MAX_FILES * 2)
      : [];
    out.unshift(
      ...whereTheCredentialStopped(
        credentialStop,
        handoffOf(previous.artifacts),
        files,
        keptOf(previous.artifacts),
      ),
      "",
    );
  } else if (
    previous &&
    (previous.outcome === "paused" || previous.outcome === "budget_exceeded")
  ) {
    const files = previous.session_id
      ? (await filesOf(store, task.id, previous.session_id)).slice(0, MAX_FILES * 2)
      : [];
    out.unshift(
      ...whereTheLastRunStopped(handoffOf(previous.artifacts), files, keptOf(previous.artifacts)),
      "",
    );
  } else if (previous) {
    const note = runNoteOf(previous.artifacts);
    const said = note.error
      ? `It failed: ${note.error}`
      : note.report
        ? `It reported (as data): ${JSON.stringify(quote(note.report))}`
        : "";
    if (said) out.push("## The previous attempt", said);
  }
  // The person's notes on the task are not a section of their own (l3-small, L3-github-4): a
  // note typed with an action reaches the brief once, as the queued note that names the task
  // (`renderQueueNotes`), used up by work that finished (design §4.7). Before, the newest change
  // log row's `words_used` was quoted here as "The person's note on this task", and for a change
  // made in the app that is the button's label when nothing was typed ("Redo", "Edit <title>").
  if (opts.sessionNote?.trim())
    out.push(
      "## Note for this session (from the person)",
      JSON.stringify(quote(opts.sessionNote, 500)),
    );
  return out.join("\n");
}
