import type { HumanRequestRow, RunRow, StateStore, TaskRow } from "@forerunner/state";
import { TASK_FILES_EVENT } from "../session/peers.ts";
import type { TaskDetailView, TaskView } from "./api-types.ts";
import { verdictWords } from "./event-lines.ts";
import { plainReason, type TaskDisplayContext } from "./task-words.ts";

export * from "./task-words.ts";

/** As `views.money` (not imported: views reads this module through the project's health). */
function money(usdMicro: number, chfPerUsd: number) {
  return { usdMicro, chfMicro: Math.round(usdMicro * chfPerUsd) };
}

/** Reads what `taskDisplay` needs for the tasks of one project. */
export async function loadTaskDisplayContext(
  store: StateStore,
  projectTasks: readonly TaskRow[],
  sandboxReady: boolean | null,
): Promise<TaskDisplayContext> {
  const tasks = new Map(projectTasks.map((t) => [t.id, t]));
  // A task waits for tasks of its own project; one from elsewhere (an old row) is read too.
  for (const t of projectTasks)
    for (const d of t.depends_on)
      if (!tasks.has(d)) {
        const row = await store.task.get(d);
        if (row) tasks.set(d, row);
      }
  const projectId = projectTasks[0]?.project_id;
  const cards = new Map<string, HumanRequestRow>();
  if (projectId) {
    const open = await store.humanRequest.list({ status: "open", project_id: projectId } as never, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
      limit: 1000,
    });
    for (const r of open) if (r.task_id && !cards.has(r.task_id)) cards.set(r.task_id, r);
  }
  const runs = new Map<string, RunRow>();
  const agentNames = new Map<string, string>();
  for (const t of projectTasks) {
    if (t.status !== "claimed" && t.status !== "in_progress") continue;
    const latest = await store.run.list({ task_id: t.id } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 1,
    });
    if (latest[0]) runs.set(t.id, latest[0]);
    if (t.claimed_by && !agentNames.has(t.claimed_by)) {
      const agent = await store.agent.get(t.claimed_by);
      if (agent) agentNames.set(agent.id, agent.name);
    }
  }
  return { tasks, cards, sandboxReady, runs, agentNames };
}

/** The critic's last verdict on the task, as a sentence for the drawer. */
export function reviewSentence(verdict: string): string {
  switch (verdict) {
    case "accept":
    case "pass":
      return "The critic accepted it.";
    case "revise":
      return "The critic sent it back for changes.";
    case "escalate":
      return "The critic sent it back for another try.";
    case "human":
      return "The critic asked you to decide.";
    default:
      return `The critic's verdict: ${verdictWords(verdict)}.`;
  }
}

/** A run's outcome label in words. */
function runOutcomeWords(outcome: string): string {
  switch (outcome) {
    case "running":
      return "Running";
    case "success":
    case "done":
    case "completed":
      return "Finished";
    case "needs_human":
      return "Asked you";
    case "killed":
    case "stopped":
      return "Stopped";
    case "timeout":
      return "Ran out of time";
    case "usage_limit":
      return "Stopped at the usage limit";
    case "error":
    case "failed":
      return "Failed";
    default:
      return outcome ? outcome.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—";
  }
}

/** A report as the drawer shows it: plain text, at most `lines` lines. */
function reportText(text: string, lines = 6): string | null {
  const t = text
    .replace(/\*\*/g, "")
    .replace(/\[stand-in model\]\s*/gi, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!t.length) return null;
  return t.length > lines ? `${t.slice(0, lines).join("\n")}\n…` : t.join("\n");
}

/**
 * The task drawer (design §3.5, `GET /tasks/:id`): what it asks for, what it waits for and what
 * waits on it, its runs with the report or error and the files each changed, the critic's last
 * review in words and its open Inbox cards. `views` are the project's task views (each with
 * its status in words), for the tasks it waits for.
 */
export async function taskDetail(
  store: StateStore,
  view: TaskView,
  task: TaskRow,
  views: readonly TaskView[],
  chfPerUsd: number,
): Promise<TaskDetailView> {
  const byId = new Map(views.map((v) => [v.id, v]));
  const waitsOn = task.depends_on.map((id) => {
    const dep = byId.get(id);
    return {
      taskId: id,
      title: dep?.title ?? null,
      status: dep ? (dep.display?.label ?? dep.status) : "No longer exists",
      done: dep?.status === "done",
    };
  });
  const waitedOnBy = views
    .filter((v) => v.dependsOn.includes(task.id) && v.status !== "done" && v.status !== "cancelled")
    .map((v) => ({ taskId: v.id, title: v.title }));
  const runRows = await store.run.list({ task_id: task.id } as never, {
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: 20,
  });
  // The report and the files of each run are in its session's log (task.finished, task.files).
  const bySession = new Map<string, { report: string | null; files: string[] }[]>();
  for (const sessionId of new Set(runRows.map((r) => r.session_id))) {
    const events = await store.event.list(sessionId, 0, 5000);
    const mine = events.filter(
      (e) => (e.payload as { taskId?: unknown } | null)?.taskId === task.id,
    );
    const finished = mine
      .filter((e) => e.type === "task.finished")
      .map((e) => {
        const p = e.payload as { summary?: unknown };
        return typeof p.summary === "string" ? reportText(p.summary) : null;
      });
    const files = mine
      .filter((e) => e.type === TASK_FILES_EVENT)
      .map((e) => {
        const f = (e.payload as { files?: unknown }).files;
        return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
      });
    // One run per task per session in the common case; pair them newest first.
    const n = Math.max(finished.length, files.length);
    const pairs: { report: string | null; files: string[] }[] = [];
    for (let i = n - 1; i >= 0; i--)
      pairs.push({ report: finished[i] ?? null, files: files[i] ?? [] });
    bySession.set(sessionId, pairs);
  }
  const used = new Map<string, number>();
  const runs = runRows.map((r) => {
    const i = used.get(r.session_id) ?? 0;
    used.set(r.session_id, i + 1);
    const got = bySession.get(r.session_id)?.[i];
    return {
      id: r.id,
      specialist: r.specialist,
      startedAt: r.created_at,
      durationMs: r.duration_ms,
      cost: money(r.cost_usd_micro, chfPerUsd),
      outcome: runOutcomeWords(r.outcome),
      report: got?.report ?? null,
      files: got?.files ?? [],
    };
  });
  const latest = await store.review.latestForTask(task.id);
  const open = latest ? await store.finding.openFor(task.id) : [];
  const review = latest
    ? {
        id: latest.id,
        verdict: reviewSentence(latest.verdict),
        summary: reportText(latest.summary, 4) ?? "",
        open: open.map((f) => plainReason(f.required_action || f.description, 160)),
      }
    : null;
  const requests = await store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
    limit: 20,
  });
  const cards = requests.map((r) => ({
    requestId: r.id,
    question: plainReason(r.why.split(/\r?\n/)[0] ?? r.why, 160),
  }));
  return { task: view, waitsOn, waitedOnBy, runs, review, cards };
}
