import type { HumanRequestRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
import type { ProjectCard, TaskDisplay } from "./api-types.ts";
import { holdsTask, shortTitle } from "./task-words.ts";

/**
 * A project's state in one sentence (design §2, "Project status"), the line the project header,
 * its Overview and its row on Home show instead of the stage, health, status and autonomy
 * badges. Computed when shown, from the tasks as they are now (§5 rule 4), first match wins:
 *
 * 1. "Waiting for you: approve the plan" / "Waiting for you: 2 questions"
 * 2. "Working on "Style the page" (3 of 7 done)"
 * 3. "Stuck: "Style the page" failed; 4 tasks wait on it" / "Waiting for Docker: 1 task"
 * 4. "Ready to continue: 3 tasks ready"
 * 5. "Drafting the plan…" / "Planning failed: <short reason>" [Try again] / "You rejected the
 *    plan. Nothing was written." [Draft a new plan]; without Claude the button is Connect Claude
 * 6. "Done: all 7 tasks. Your files: <path>"
 *
 * The pure part (`projectStatusLine`) takes what was read; `projectFacts` reads it.
 */

export type ProjectStatusLine = NonNullable<ProjectCard["statusLine"]>;
export type ProjectWorking = NonNullable<ProjectCard["working"]>;

/** The plan from the brief, as the intake says (`IntakeService.status`). */
export type PlanState =
  | "none"
  | "drafting"
  | "pending"
  | "approved"
  | "rejected"
  | "failed"
  | "skipped"
  | null;

export interface ProjectStatusInput {
  projectId: string;
  /** Every task of the project. */
  tasks: readonly Pick<TaskRow, "id" | "title" | "status" | "depends_on">[];
  /** Each task's status in words (design §2), by task id. */
  displays: ReadonlyMap<string, TaskDisplay>;
  /** The project's open Inbox cards for the person, oldest first. */
  cards: readonly Pick<HumanRequestRow, "id" | "task_id" | "change_card">[];
  /** The plan from the brief; `pending` waits for approval in the Inbox. */
  plan: PlanState;
  /** Why planning failed, in words (`summary_cache.intake.error`). */
  planError?: string | null;
  /**
   * Whether a Claude credential is in force now (the intake can call the model); null when not
   * known. Without one, Try again cannot work, so the button is Connect Claude.
   */
  hasModel?: boolean | null;
  /** The session working on the project now, if one runs. */
  working: ProjectWorking | null;
  /** The project's folder (its workspace, or the linked folder or repository checkout). */
  folder: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Status sentence length (design §5 rule 1). */
const STATUS_MAX = 80;
const PLAN_FAILED = "Planning failed";
/** Connect Claude: the setup assistant, as the header's no-key bar opens it (design §3.1). */
const CONNECT_CLAUDE = { kind: "link", label: "Connect Claude", to: "/setup" } as const;

/**
 * The intake's reasons (`intakeFailureWords`, `INTAKE_NEEDS_A_MODEL`, the lost "Change the
 * plan" draft) as a few words after "Planning failed: " (design §2 item 5, §5.1: the sentence
 * stays within 80 characters; the project page's plan banner keeps the reason in full).
 * `noModel` marks the reasons that are a missing Claude credential.
 */
const PLAN_FAILURE_SHORT: readonly { match: RegExp; short: string; noModel?: true }[] = [
  {
    match: /needs a Claude key or subscription|No Claude key or subscription|No Claude credential/i,
    short: "Claude is not connected",
    noModel: true,
  },
  { match: /^Claude did not answer/i, short: "Claude did not answer" },
  { match: /^Claude was busy/i, short: "Claude was busy" },
  { match: /^Claude could not be reached/i, short: "Claude could not be reached" },
  { match: /took longer than its time limit/i, short: "it took too long" },
  { match: /used up the budget/i, short: "it used up its budget" },
  { match: /used all the steps/i, short: "it ran out of steps" },
  { match: /was stopped before it finished/i, short: "it was stopped" },
  { match: /not the JSON plan/i, short: "Claude's answer was not a plan" },
  { match: /plan was missing parts/i, short: "Claude's plan was incomplete" },
  { match: /Forerunner closed before it was done/i, short: "Forerunner closed before it was done" },
];

/**
 * "Planning failed: <a few words>" with the button that unblocks it: Connect Claude while no
 * credential is in force (the retry route refuses then), otherwise Try again (the intake's
 * retry, `POST /projects/:id/intake/retry`). A reason nobody worded is its first sentence, cut
 * at a word.
 */
function planFailedLine(
  error: string | null | undefined,
  hasModel: boolean | null | undefined,
): ProjectStatusLine {
  // "The run failed: " is how a task run's reason starts; here "Planning failed" says it.
  const said = (error ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^The run failed:\s*/i, "");
  const known = said ? PLAN_FAILURE_SHORT.find((r) => r.match.test(said)) : undefined;
  let reason: string;
  if (known?.noModel) reason = hasModel === true ? "Claude was not connected" : known.short;
  else if (known) reason = known.short;
  else if (hasModel === false) reason = "Claude is not connected";
  else {
    const first = (said.split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?…]+$/, "");
    const room = STATUS_MAX - PLAN_FAILED.length - 2;
    reason = first.length > room ? `${first.slice(0, room - 1).replace(/\s+\S*$/, "")}…` : first;
  }
  return {
    kind: "planning_failed",
    text: reason ? `${PLAN_FAILED}: ${reason}` : PLAN_FAILED,
    action:
      hasModel === false ? { ...CONNECT_CLAUDE } : { kind: "retry", label: "Try again", to: null },
  };
}

/** "3 of 7 done": tasks not cancelled, and the ones done. */
export function progressOf(tasks: readonly Pick<TaskRow, "status">[]): {
  done: number;
  total: number;
} {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  return { done: counted.filter((t) => t.status === "done").length, total: counted.length };
}

export function projectStatusLine(input: ProjectStatusInput): ProjectStatusLine {
  const tasksTab = `/projects/${encodeURIComponent(input.projectId)}/tasks`;
  const { done, total } = progressOf(input.tasks);
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const keyOf = (t: { id: string }) => input.displays.get(t.id)?.key;

  // 1. What needs the person first (design §5 rule 2). The Docker card asks nothing of a task:
  // it is "Waiting for Docker" below.
  if (input.plan === "pending")
    return {
      kind: "waiting",
      text: "Waiting for you: approve the plan",
      action: { kind: "link", label: "Open", to: "/inbox" },
    };
  const asking = input.cards.filter((c) => holdsTask(c));
  if (asking.length > 0) {
    const only = asking.length === 1 ? asking[0] : undefined;
    const task = only?.task_id ? byId.get(only.task_id) : undefined;
    return {
      kind: "waiting",
      text: task
        ? `Waiting for you: "${shortTitle(task.title)}"`
        : `Waiting for you: ${plural(asking.length, "question")}`,
      action: { kind: "link", label: "Answer", to: "/inbox" },
    };
  }

  // 2. A session works on it now.
  if (input.working) {
    const progress = total > 0 ? ` (${done} of ${total} done)` : "";
    return {
      kind: "working",
      text: input.working.taskTitle
        ? `Working on "${shortTitle(input.working.taskTitle)}"${progress}`
        : `Working${progress}`,
      action: {
        kind: "link",
        label: "Open running session",
        to: `/sessions/${encodeURIComponent(input.working.sessionId)}`,
      },
    };
  }

  // 3. Stuck: a task that failed or was cancelled holds others back; or Docker is not ready.
  const stuck = input.tasks.filter((t) => keyOf(t) === "stuck");
  if (stuck.length > 0) {
    const holderId = input.displays.get(stuck[0]?.id ?? "")?.blocker?.taskId ?? null;
    const holder = holderId ? byId.get(holderId) : undefined;
    const behind = holderId
      ? stuck.filter((t) => t.depends_on.includes(holderId)).length
      : stuck.length;
    const what = holder
      ? `"${shortTitle(holder.title)}" ${holder.status === "cancelled" ? "was cancelled" : "failed"}`
      : "a task it waits for is gone";
    return {
      kind: "stuck",
      text: `Stuck: ${what}; ${plural(behind, "task waits", "tasks wait")} on it`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  }
  const docker = input.tasks.filter((t) => keyOf(t) === "docker");
  if (docker.length > 0)
    return {
      kind: "docker",
      text: `Waiting for Docker: ${plural(docker.length, "task")}`,
      action: { kind: "link", label: "Set up Docker", to: "/settings#sandbox" },
    };

  // 4. Work that can run now.
  const ready = input.tasks.filter((t) => keyOf(t) === "ready");
  if (ready.length > 0)
    return {
      kind: "ready",
      text: `Ready to continue: ${plural(ready.length, "task")} ready`,
      action: { kind: "start", label: "Continue", to: null },
    };

  // 5. The plan from the brief.
  if (input.plan === "drafting" && total === 0)
    return { kind: "planning", text: "Drafting the plan…", action: null };
  if (input.plan === "failed" && total === 0)
    return planFailedLine(input.planError, input.hasModel);
  // Design §3.3: "You rejected the plan. Nothing was written. [Draft a new plan]".
  if (input.plan === "rejected" && total === 0)
    return {
      kind: "planning_failed",
      text: "You rejected the plan. Nothing was written.",
      action:
        input.hasModel === false
          ? { ...CONNECT_CLAUDE }
          : { kind: "retry", label: "Draft a new plan", to: null },
    };

  // 6. Done.
  if (total > 0 && done === total)
    return {
      kind: "done",
      text: `Done: all ${plural(total, "task")}.${input.folder ? ` Your files: ${input.folder}` : ""}`,
      action: input.folder
        ? { kind: "link", label: "Open Files", to: `/projects/${input.projectId}/files` }
        : null,
    };

  if (total === 0)
    return {
      kind: "empty",
      text: "No tasks yet",
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  // What is left cannot run by itself: drafts, tasks paused, or tasks waiting on those.
  const paused = input.tasks.filter((t) => keyOf(t) === "paused");
  if (paused[0])
    return {
      kind: "paused",
      text: `Paused: "${shortTitle(paused[0].title)}"${paused.length > 1 ? ` and ${paused.length - 1} more` : ""}`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  const drafts = input.tasks.filter((t) => keyOf(t) === "draft").length;
  if (drafts > 0)
    return {
      kind: "paused",
      text: `${done} of ${total} done; ${plural(drafts, "draft")} to make ready`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  return {
    kind: "paused",
    text: `${done} of ${total} done`,
    action: { kind: "link", label: "Open Tasks", to: tasksTab },
  };
}

/** How many lines the Overview's "Next" shows (design §3.4: max 3 lines). */
export const NEXT_LINES = 3;
const NEXT_RANK: Record<TaskDisplay["key"], number> = {
  running: 0,
  review: 1,
  ready: 2,
  answer: 3,
  waiting: 4,
  stuck: 5,
  docker: 6,
  paused: 7,
  failed: 8,
  draft: 9,
  done: 10,
  cancelled: 11,
};

/**
 * Design §3.4 "Next", computed when shown (§5 rule 4): the open tasks (given in run order) with
 * their status in words, what runs now first, then what can run, then what waits; at most three
 * lines, then "and N more".
 */
export function overviewNext(
  items: readonly { task: Pick<TaskRow, "title" | "status">; display: TaskDisplay }[],
): string[] {
  const open = items
    .filter(({ task }) => task.status !== "done" && task.status !== "cancelled")
    .sort((a, b) => NEXT_RANK[a.display.key] - NEXT_RANK[b.display.key]);
  const lines = open
    .slice(0, NEXT_LINES)
    .map(({ task, display }) => `"${shortTitle(task.title, 60)}": ${display.label}`);
  if (open.length > NEXT_LINES) lines.push(`and ${open.length - NEXT_LINES} more`);
  return lines;
}

/** The session row the intake drafts a plan in (`session/intake.ts`: `plan.intake`). */
export function isIntakeSession(s: Pick<SessionRow, "plan">): boolean {
  const plan = s.plan as unknown;
  return !!plan && typeof plan === "object" && !Array.isArray(plan) && "intake" in plan;
}

/** Session states in which a session is working (or about to). */
export const WORKING_SESSION = new Set(["planned", "running", "paused"]);

/**
 * The session working on the project now: its id, its agent, the task in flight (from its
 * last `task.started` without a `task.finished` after it) and when it began. Null when none.
 */
export async function workingOn(
  store: StateStore,
  projectId: string,
): Promise<ProjectWorking | null> {
  const rows: SessionRow[] = [];
  for (const status of WORKING_SESSION)
    rows.push(
      ...(await store.session.list({ project_id: projectId, status } as never, {
        orderBy: [{ column: "created_at", direction: "desc" }],
        limit: 5,
      })),
    );
  // The plan from the brief is drafted in a session row of its own (`plan.intake`): that is
  // "Drafting the plan…", not work on the project's tasks (bench walk: the header said "Alice is
  // working on Quote page" with Stop all while the plan was being drafted).
  const s = rows
    .filter((r) => r.summary !== "conversation" && !isIntakeSession(r))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!s) return null;
  const agentName = (await store.agent.get(s.agent_id))?.name ?? null;
  const last = (await store.event.list(s.id, 0, 10_000))
    .filter((e) => e.type === "task.started" || e.type === "task.finished")
    .at(-1);
  const payload = (last?.payload ?? {}) as { title?: unknown; taskId?: unknown };
  const running = last?.type === "task.started";
  return {
    sessionId: s.id,
    agentName,
    taskId: running && typeof payload.taskId === "string" ? payload.taskId : null,
    taskTitle: running && typeof payload.title === "string" ? payload.title : null,
    since: s.started_at ?? s.created_at,
  };
}
