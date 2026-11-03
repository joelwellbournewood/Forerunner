import type {
  HumanRequestView,
  TaskAction,
  TaskDetailView,
  TaskReviewEvidence,
  TaskView,
} from "@forerunner/runtime/daemon/api-types";
import {
  ACTION_FROM,
  ACTION_WORDS,
  runOrder,
  taskDisplay,
} from "@forerunner/runtime/daemon/task-words";
import { PRIORITY_VALUES } from "@forerunner/runtime/priority";

/** The daemon's task row and status, as `task-words` reads them (the UI has no state package). */
type TaskRow = Parameters<typeof taskDisplay>[0];
type TaskStatus = TaskRow["status"];

/**
 * The fake daemon's Tasks (design §3.5), worded by the daemon's own `task-words` module so the
 * badge, the filter and the actions the screens show are the real daemon's. What the fake keeps
 * beyond a `TaskView`: who paused a task (the daemon reads the row's author) and the order the
 * tasks were added (the daemon's `created_at`).
 */
export interface FakeTaskMeta {
  /** Tasks a person paused or stopped (the daemon: `author_human` on a `needs_human` row). */
  pausedByPerson: Set<string>;
  /** The order tasks were added, for the run order's "older first". */
  added: Map<string, number>;
  /**
   * Tasks in review whose review does not go on in the app (the daemon asks its kill switch,
   * `display.live`; L-7): a task left in review by a quit, another computer's review. A test
   * adds them; every other task in review has its review going.
   */
  notLive: Set<string>;
  /**
   * Projects whose work waits for a Claude credential (U-078), with the row's words as the
   * daemon's `credentialWaitRow` gives them ("Waits until 16:40, your API key's limit"). A test
   * sets them; the daemon reads them from the billing sources' `limits.waiting`.
   */
  credentialWaits: Map<
    string,
    {
      label: string;
      detail: string;
      /** The status sentence's head ("Waiting for a new API key"; `waitRowWords`). */
      line?: string;
      /** A refusal's link to where a new key is saved; null or absent at a limit. */
      save?: { label: string; to: string } | null;
    }
  >;
}

export function createTaskMeta(tasks: readonly TaskView[]): FakeTaskMeta {
  return {
    pausedByPerson: new Set(),
    added: new Map(tasks.map((t, i) => [t.id, i])),
    notLive: new Set(),
    credentialWaits: new Map(),
  };
}

/** A view as the row `task-words` reads. */
function rowOf(t: TaskView, meta: FakeTaskMeta): TaskRow {
  const added = meta.added.get(t.id) ?? meta.added.size;
  const paused = meta.pausedByPerson.has(t.id);
  return {
    id: t.id,
    project_id: t.projectId,
    milestone_id: t.milestoneId,
    title: t.title,
    outcome: t.outcome,
    acceptance_criteria: t.acceptanceCriteria,
    risk_tier: t.riskTier,
    status: t.status as TaskStatus,
    priority: PRIORITY_VALUES[t.priority],
    claimed_by: t.claimedBy,
    claim_expires: t.claimExpires,
    depends_on: t.dependsOn,
    budget_usd_micro: t.budget.usdMicro,
    est_cost_usd_micro: t.estimate.usdMicro,
    actual_cost_usd_micro: t.actual.usdMicro,
    owner_agent_id: null,
    specialist: t.specialist,
    attempt: t.attempt,
    pr_url: t.prUrl,
    branch: t.branch,
    reason: t.reason,
    created_at: new Date(Date.UTC(2026, 0, 1) + added * 1000).toISOString(),
    updated_at: t.updatedAt,
    author_agent: paused ? null : "agent_alice",
    author_human: paused ? "human_alice" : null,
    version: t.version,
  };
}

/** The project's tasks as `GET /projects/:id/tasks` answers them: run order, with `display`. */
export function projectTaskViews(
  all: readonly TaskView[],
  projectId: string,
  requests: readonly HumanRequestView[],
  sandboxReady: boolean,
  meta: FakeTaskMeta,
): TaskView[] {
  const mine = all.filter((t) => t.projectId === projectId);
  const rows = mine.map((t) => rowOf(t, meta));
  // As the daemon: the card's kind (questions, or a retry decision) comes from its change card.
  const cards = new Map<string, { id: string; change_card: never }>();
  for (const r of requests)
    if (r.status === "open" && r.taskId && !cards.has(r.taskId))
      cards.set(r.taskId, { id: r.id, change_card: (r.changeCard ?? null) as never });
  const ctx = {
    tasks: new Map(all.map((t) => [t.id, rowOf(t, meta)])),
    cards,
    sandboxReady,
    runs: new Map(),
    agentNames: new Map([["agent_alice", "Alice"]]),
    live: (taskId: string) => !meta.notLive.has(taskId),
    credentialWait: meta.credentialWaits.get(projectId) ?? null,
  };
  const byId = new Map(mine.map((t) => [t.id, t]));
  return runOrder(rows).map((row, i) => ({
    ...(byId.get(row.id) as TaskView),
    display: taskDisplay(row, ctx),
    runOrder: i,
  }));
}

/** The status a person's action leads to, or a refusal in the daemon's words. */
export function actionTarget(
  task: TaskView,
  action: TaskAction,
): { to: TaskStatus } | { refused: string } {
  if (!ACTION_FROM[action].includes(task.status as TaskStatus))
    return {
      refused: `"${task.title}" is ${task.display?.label ?? task.status}: ${ACTION_WORDS[action]} is not offered for it.`,
    };
  // As the daemon's task.resume: a task only the person can do has nobody to go ahead.
  if (action === "go_ahead" && task.specialist === "person")
    return {
      refused: `"${task.title}" is a task only you can do: answer its card in the Inbox, or cancel it.`,
    };
  const to: TaskStatus =
    action === "cancel"
      ? "cancelled"
      : action === "pause" || action === "stop"
        ? "needs_human"
        : "ready";
  return { to };
}

/**
 * Whether the fake models a live run or review of the task, which a person's move stops (the
 * daemon asks the kill switch): a running task, or one being reviewed with no card waiting
 * (one whose card waits reads "Needs your decision": no review runs).
 */
export function liveWork(view: TaskView): boolean {
  const key = view.display?.key;
  if (view.display?.live === false) return false;
  return key === "running" || (view.status === "in_review" && key === "review");
}

/** The sentence the daemon's command writes for a person's action (`moveSentence`). */
export function actionSentence(
  task: TaskView,
  from: string,
  to: string,
  extra: { withdrawn?: number; noted?: boolean; stuck?: readonly string[]; live?: boolean } = {},
): string {
  const t = `"${task.title}"`;
  let s: string;
  // A task cancelled while it ran or was reviewed (phase C): what happens to its work. As the
  // daemon, said only when a live run or review was stopped (`liveWork`).
  const ran = extra.live ?? ["claimed", "in_progress", "in_review"].includes(from);
  const what = from === "in_review" ? "its review" : "its run";
  if (to === "cancelled" && ran)
    s = task.prUrl
      ? `Cancelled ${t}: ${what} stopped; its pull request stays open.`
      : `Cancelled ${t}: ${what} stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.`;
  else if (to === "cancelled") s = `Cancelled ${t}.`;
  else if (to === "needs_human")
    s = ["claimed", "in_progress"].includes(from)
      ? `Stopped ${t}: its run ended and it is paused until you press Resume.`
      : `Paused ${t}: no session runs it until you press Resume.`;
  else if (from === "draft") s = `${t} is ready: a session will pick it up.`;
  else if (from === "failed") s = `${t} is ready to try again.`;
  else if (from === "cancelled") s = `Reopened ${t}: it is ready again.`;
  else if (from === "done") s = `Reopened ${t} to redo it: the next session works on it again.`;
  else s = `${t} is ready again.`;
  if (extra.withdrawn)
    s += ` Its ${extra.withdrawn === 1 ? "card" : `${extra.withdrawn} cards`} in the Inbox ${extra.withdrawn === 1 ? "was" : "were"} withdrawn.`;
  if (extra.stuck?.length) {
    const names = extra.stuck.map((x) => `"${x}"`);
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    s += ` ${list} ${names.length === 1 ? "waits" : "wait"} on it and ${names.length === 1 ? "is" : "are"} stuck now.`;
  }
  if (extra.noted)
    s +=
      to === "cancelled"
        ? " Your note goes into its brief if you reopen it."
        : " Your note goes into its next brief.";
  return s;
}

/** `GET /tasks/:id` from the fake's state: the drawer's view. */
export function fakeTaskDetail(
  task: TaskView,
  views: readonly TaskView[],
  requests: readonly HumanRequestView[],
  runs: readonly {
    id: string;
    taskId: string | null;
    specialist: string;
    createdAt: string;
    durationMs: number | null;
    cost: TaskView["actual"];
    outcome: string;
    verdict: string | null;
    reviewId: string | null;
    /** The specialist's report as the daemon serves it (a test may set its own). */
    report?: string;
    /** The whole report when `report` is cut, as the daemon serves it. */
    fullReport?: string;
    sessionId?: string;
    /** The files the run changed (default: index.html), as the daemon reads them from the log. */
    files?: string[];
    /** The pages a research run read (ADR 0107), as the daemon reads them from the Run row. */
    webSources?: { url: string; title: string | null; refused: string | null }[];
    /** Why a review stopped before its verdict, as the daemon words it (`reviewStopWords`). */
    stoppedBecause?: string;
  }[],
  /** What the review ran and tried (ADR 0104), when a test seeded it. */
  evidence?: TaskReviewEvidence,
): TaskDetailView {
  const byId = new Map(views.map((v) => [v.id, v]));
  const mine = runs.filter((r) => r.taskId === task.id);
  const latest = mine[0];
  return {
    task,
    waitsOn: task.dependsOn.map((id) => {
      const dep = byId.get(id);
      return {
        taskId: id,
        title: dep?.title ?? null,
        status: dep ? (dep.display?.label ?? dep.status) : "No longer exists",
        done: dep?.status === "done",
      };
    }),
    waitedOnBy: views
      .filter(
        (v) => v.dependsOn.includes(task.id) && v.status !== "done" && v.status !== "cancelled",
      )
      .map((v) => ({ taskId: v.id, title: v.title })),
    // As the daemon: the critic's runs are the reviews, with no report or files of their own.
    runs: mine.map((r) => {
      const review = r.specialist === "critic";
      // As the daemon (C-41): a review stopped from outside says so and who stopped it.
      const stoppedReview = review && (r.outcome === "killed" || r.outcome === "stopped");
      return {
        id: r.id,
        kind: review ? ("review" as const) : ("work" as const),
        specialist: r.specialist,
        startedAt: r.createdAt,
        durationMs: r.durationMs,
        cost: r.cost,
        outcome: stoppedReview
          ? "Review stopped"
          : r.outcome === "success"
            ? "Finished"
            : r.outcome,
        report: stoppedReview
          ? `The review stopped before the critic decided: ${r.stoppedBecause ?? "it was stopped"}.`
          : review
            ? null
            : (r.report ?? "Wrote the page and checked it loads."),
        ...(r.fullReport && !review ? { fullReport: r.fullReport } : {}),
        files: review ? [] : (r.files ?? ["index.html"]),
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(r.webSources?.length ? { webSources: r.webSources } : {}),
      };
    }),
    review:
      latest?.reviewId && latest.verdict
        ? {
            id: latest.reviewId,
            verdict:
              latest.verdict === "accept"
                ? "The critic accepted it."
                : "The critic sent it back for changes.",
            summary: "The work meets the criteria.",
            open: latest.verdict === "accept" ? [] : ["Add a test for the empty query."],
            // As the daemon (ADR 0104): how a done task was checked, and the evidence.
            check:
              task.status === "done" && !/accepted without review/i.test(task.reason)
                ? (evidence?.tried.length ?? 0) > 0
                  ? { label: "Reviewed and tried" as const, tried: true }
                  : { label: "Reviewed" as const, tried: false }
                : null,
            ...(evidence ? { evidence } : {}),
          }
        : null,
    cards: requests
      .filter((r) => r.status === "open" && r.taskId === task.id)
      .map((r) => ({ requestId: r.id, question: r.why })),
  };
}
