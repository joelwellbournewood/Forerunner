import { ForerunnerError } from "@forerunner/platform";
import { defaultRiskTier } from "@forerunner/runtime";
// The module itself, not the package index: the index loads this package (a cycle), and the
// schema is needed when this module is evaluated.
import {
  DEFAULT_TASK_PRIORITY,
  PRIORITY_VALUES,
  TaskPrioritySchema,
} from "@forerunner/runtime/priority";
import {
  canTransition,
  type JsonValue,
  reopenTarget,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskRow,
  type TaskStatus,
} from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf, quote, resolveProject } from "./shared.ts";

const createParams = z.object({
  title: z.string().min(3).max(200),
  outcome: z.string().default(""),
  acceptance_criteria: z.array(z.string()).default([]),
  /**
   * Low, medium or high (U-041), medium when not said, as the New task dialog; an old number
   * is read as its level. Stored as the level's number (higher runs first).
   */
  priority: TaskPrioritySchema.default(DEFAULT_TASK_PRIORITY),
  /** Left out, the project's default applies: tier 0 in small-project mode, else 1 (B.6). */
  risk_tier: z.number().int().min(0).max(3).optional(),
  status: z.enum(["draft", "ready"]).default("draft"),
  project: z.string().optional(),
});
export type TaskCreateParams = z.infer<typeof createParams>;

function createSentence(p: TaskCreateParams, projectName: string): string {
  const priority = p.priority === DEFAULT_TASK_PRIORITY ? "" : `, ${p.priority} priority`;
  return `Created the ${p.status} task ${quote(p.title)} in ${projectName}${priority}. Undo.`;
}

export const taskCreate: CommandDef<TaskCreateParams> = {
  name: "task.create",
  description:
    "Create a task (draft by default) in a project: title, outcome, acceptance criteria, priority (low, medium or high; medium when not said).",
  params: createParams,
  risk: "low",
  scope: "project",
  reversible: true,
  undoStrategy: "cancel the created task",
  async plan(params, ctx) {
    const { project, usedActive } = await resolveProject(ctx, params.project);
    const count = await ctx.store.task.count({ project_id: project.id });
    return buildCard({
      command: "task.create",
      what: `the tasks of ${project.name}`,
      oldValue: `${count} task${count === 1 ? "" : "s"}`,
      newValue: `+ ${params.status} ${quote(params.title)}`,
      scope: "project",
      risk: "low",
      sentence: createSentence(params, project.name),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
    });
  },
  async run(params, ctx) {
    const { project } = await resolveProject(ctx, params.project);
    const task = await ctx.store.task.insert({
      project_id: project.id,
      title: params.title,
      outcome: params.outcome,
      acceptance_criteria: params.acceptance_criteria,
      risk_tier: params.risk_tier ?? defaultRiskTier(project),
      status: params.status,
      priority: PRIORITY_VALUES[params.priority],
      reason: `created by ${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`,
      ...authorOf(ctx),
    });
    return {
      before: { task_id: null, project_id: project.id },
      after: { task_id: task.id, project_id: project.id, status: task.status },
      sentence: createSentence(params, project.name),
      projectId: project.id,
    };
  },
  // U-061: the undo cancels the task, which only works while it can still be cancelled.
  async undoBlocked(params, _before, after, ctx) {
    const task = await createdTask(after, ctx);
    if (!task) return `the task ${quote(params.title)} no longer exists`;
    if (task.status === "cancelled") return `the task ${quote(task.title)} is already cancelled`;
    if (!canTransition(TASK_TRANSITIONS, task.status, "cancelled")) {
      return `the task ${quote(task.title)} is ${task.status}; a ${task.status} task cannot be cancelled, so its creation cannot be undone`;
    }
    return null;
  },
  undoSentence: (params) => `Undone: cancelled the task ${quote(params.title)} you created.`,
  async undo(params, _before, after, ctx) {
    const task = await createdTask(after, ctx);
    if (!task || !canTransition(TASK_TRANSITIONS, task.status, "cancelled")) {
      // Never "Undone" when nothing changed (U-061); `undoBlocked` says why in words first.
      throw new ForerunnerError(
        "validation",
        `the task ${quote(params.title)} cannot be cancelled any more, so its creation cannot be undone`,
      );
    }
    await ctx.store.task.transition(task.id, task.version, "cancelled", "undo of task.create", {
      humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
      agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
  },
};

async function createdTask(after: JsonValue, ctx: CommandContext): Promise<TaskRow | undefined> {
  const a = asObject(after);
  return typeof a.task_id === "string" ? ctx.store.task.get(a.task_id) : undefined;
}

const transitionParams = z.object({
  /** Task id, or a title (prefix or part) within the project. */
  task: z.string().min(1),
  to: z.enum(TASK_STATUSES),
  reason: z.string().default(""),
  project: z.string().optional(),
});
export type TaskTransitionParams = z.infer<typeof transitionParams>;

async function findTask(params: TaskTransitionParams, ctx: CommandContext): Promise<TaskRow> {
  const direct = await ctx.store.task.get(params.task);
  if (direct) return direct;
  const { project } = await resolveProject(ctx, params.project);
  const tasks = await ctx.store.task.forProject(project.id);
  const needle = params.task.trim().toLowerCase();
  const matches = tasks.filter((t) => t.title.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as TaskRow;
  if (matches.length > 1) {
    throw new ForerunnerError("validation", `several tasks match ${quote(params.task)}`, {
      details: { candidates: matches.map((m) => m.title) },
    });
  }
  throw new ForerunnerError(
    "not_found",
    `no task matches ${quote(params.task)} in ${project.name}`,
  );
}

function transitionSentence(task: TaskRow, to: TaskStatus, reversible: boolean): string {
  return `Moved the task ${quote(task.title)} from ${task.status} to ${to}.${reversible ? " Undo." : ""}`;
}

/**
 * Whether a move can be taken back (U-061): the graph's way back, or a cancel, which the undo
 * reopens (`TaskRepo.reopen`). A task marked done stays done.
 */
export function transitionUndoable(from: TaskStatus, to: TaskStatus): boolean {
  return to === "cancelled" ? from !== "cancelled" : canTransition(TASK_TRANSITIONS, to, from);
}

export const taskTransition: CommandDef<TaskTransitionParams> = {
  name: "task.transition",
  description:
    "Move a task along its workflow (ready, in_progress, needs_human, done, cancelled...).",
  params: transitionParams,
  risk: (params) => (params.to === "cancelled" || params.to === "done" ? "medium" : "low"),
  maxRisk: "medium",
  scope: "project",
  reversible: true,
  undoStrategy: "move the task back when the workflow graph allows it",
  async plan(params, ctx) {
    const task = await findTask(params, ctx);
    if (!canTransition(TASK_TRANSITIONS, task.status, params.to)) {
      throw new ForerunnerError(
        "validation",
        `task: illegal transition ${task.status} -> ${params.to}`,
        {
          details: { allowed: [...TASK_TRANSITIONS[task.status]] },
        },
      );
    }
    const project = await ctx.store.project.mustGet(task.project_id);
    const reversible = transitionUndoable(task.status, params.to);
    return buildCard({
      command: "task.transition",
      what: `the task ${quote(task.title)}`,
      oldValue: task.status,
      newValue: params.to,
      scope: "project",
      risk: params.to === "cancelled" || params.to === "done" ? "medium" : "low",
      sentence: transitionSentence(task, params.to, reversible),
      reversible,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: !params.project && !(await ctx.store.task.get(params.task)),
    });
  },
  async run(params, ctx) {
    const task = await findTask(params, ctx);
    const reversible = transitionUndoable(task.status, params.to);
    const updated = await ctx.store.task.transition(
      task.id,
      task.version,
      params.to,
      params.reason || `${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`,
      {
        humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
        agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
      },
    );
    return {
      before: { task_id: task.id, status: task.status, title: task.title },
      after: { task_id: task.id, status: updated.status, title: task.title },
      sentence: transitionSentence(task, params.to, reversible),
      projectId: task.project_id,
      reversible,
    };
  },
  // U-061: Undo works while the task is where the move left it; after a later move (a session
  // took it, someone moved it again) the undo says so instead of moving it somewhere new.
  async undoBlocked(_params, before, after, ctx) {
    const b = asObject(before);
    const a = asObject(after);
    if (typeof a.task_id !== "string" || typeof b.status !== "string") {
      return "this change does not name the task it moved";
    }
    const task = await ctx.store.task.get(a.task_id);
    if (!task) {
      return `${typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task"} no longer exists`;
    }
    if (task.status !== a.status) {
      return `the task ${quote(task.title)} moved on to ${task.status} since; undo would not put it back where it was`;
    }
    if (!transitionUndoable(b.status as TaskStatus, task.status)) {
      return `a ${task.status} task cannot go back to ${b.status}`;
    }
    return null;
  },
  undoSentence(_params, before, after) {
    const b = asObject(before);
    const a = asObject(after);
    const title = typeof a.title === "string" ? `the task ${quote(a.title)}` : "the task";
    const previous = String(b.status) as TaskStatus;
    if (a.status === "cancelled") {
      const to = reopenTarget(previous);
      return to === previous
        ? `Undone: reopened ${title}; it is ${to} again.`
        : `Undone: reopened ${title} as ${to} (it was ${previous}; a session picks it up again).`;
    }
    return `Undone: ${title} is back to ${previous}.`;
  },
  async undo(_params, before, after, ctx) {
    const b = asObject(before);
    const a = asObject(after);
    if (typeof a.task_id !== "string" || typeof b.status !== "string") {
      throw new ForerunnerError("validation", "this change does not name the task it moved");
    }
    const task = await ctx.store.task.mustGet(a.task_id);
    const actor = {
      humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
      agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    };
    // A cancel is taken back by reopening the task (the graph keeps cancelled final otherwise).
    if (task.status === "cancelled" && a.status === "cancelled") {
      await ctx.store.task.reopen(task.id, task.version, b.status as TaskStatus, "undo", actor);
      return;
    }
    await ctx.store.task.transition(task.id, task.version, b.status as TaskStatus, "undo", actor);
  },
};
