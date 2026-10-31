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
  async undo(_params, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.task_id !== "string") return;
    const task = await ctx.store.task.get(a.task_id);
    if (!task || !canTransition(TASK_TRANSITIONS, task.status, "cancelled")) return;
    await ctx.store.task.transition(task.id, task.version, "cancelled", "undo of task.create", {
      humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
      agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
  },
};

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
    const reversible = canTransition(TASK_TRANSITIONS, params.to, task.status);
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
    const reversible = canTransition(TASK_TRANSITIONS, params.to, task.status);
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
      before: { task_id: task.id, status: task.status },
      after: { task_id: task.id, status: updated.status },
      sentence: transitionSentence(task, params.to, reversible),
      projectId: task.project_id,
      reversible,
    };
  },
  async undo(_params, before, after, ctx) {
    const b = asObject(before);
    const a = asObject(after);
    if (typeof a.task_id !== "string" || typeof b.status !== "string") return;
    const task = await ctx.store.task.mustGet(a.task_id);
    await ctx.store.task.transition(task.id, task.version, b.status as TaskStatus, "undo", {
      humanId: ctx.actor.kind === "human" ? ctx.actor.id : null,
      agentId: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
  },
};
