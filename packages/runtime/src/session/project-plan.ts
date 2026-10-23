import { ForerunnerError, redact } from "@forerunner/platform";
import type { MilestoneRow, ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";

/**
 * Small-project mode (spec B.6) and the plan writer.
 *
 * `project.small_project_mode` is read in exactly two places in the runtime: here, when a new
 * task's tier is chosen (`defaultRiskTier`, called by every task creation path) and when a plan
 * becomes milestone and task rows (`shapeProjectPlan`, `applyProjectPlan`); the UI reads it to
 * list the tasks flat. The critic never reads the flag: it reviews at the tier stored on the
 * task (`risk_tier`), so a tier the planner or the human names on a task stands whatever the
 * mode, and flipping the flag leaves existing tasks alone (ADR 0051). In the mode a project
 * keeps one milestone: a later plan joins the open one, which takes the plan's new success
 * criteria and a later target date (`milestoneMerge`) and keeps its name.
 */

/** `tool` of the audit row written when a later plan changes the open milestone it joins. */
export const PLAN_AUDIT_TOOL = "project.plan";
/** Longest audit summary the plan writer records; criteria beyond it are cut, never dropped silently. */
const MAX_AUDIT_SUMMARY_CHARS = 500;

/** Tier of a new task that names none, outside small-project mode. */
export const DEFAULT_RISK_TIER = 1;
/** Tier of a new task that names none in small-project mode: checks only, no critic model. */
export const SMALL_PROJECT_RISK_TIER = 0;

/** The one place a new task's tier is chosen when the task names none. */
export function defaultRiskTier(project: Pick<ProjectRow, "small_project_mode">): 0 | 1 {
  return project.small_project_mode ? SMALL_PROJECT_RISK_TIER : DEFAULT_RISK_TIER;
}

/** Caps on one plan, enforced before anything is written. */
export const MAX_PLAN_MILESTONES = 20;
export const MAX_PLAN_TASKS = 200;

/** Milestone target dates are calendar dates, the way the Plan tab's timeline reads them. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const PlanKey = z.string().min(1).max(80);

export const PlanTask = z.object({
  /** Name other plan tasks use in `dependsOn`; unique within the plan. */
  key: PlanKey.optional(),
  title: z.string().min(3).max(200),
  outcome: z.string().min(3),
  acceptanceCriteria: z.array(z.string().min(1)).max(50).default([]),
  /** Left out, the project's default applies (`defaultRiskTier`). */
  riskTier: z.number().int().min(0).max(3).optional(),
  priority: z.number().int().min(1).max(9).default(5),
  /** Keys of plan tasks, or ids of the project's existing tasks. */
  dependsOn: z.array(z.string().min(1)).max(50).default([]),
  budgetUsdMicro: z.number().int().nonnegative().default(0),
  specialist: z.string().min(1).max(80).optional(),
  status: z.enum(["draft", "ready"]).default("ready"),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanMilestone = z.object({
  name: z.string().min(1).max(200),
  successCriteria: z.array(z.string().min(1)).max(50).default([]),
  targetDate: z.string().regex(DATE_ONLY, "a calendar date, YYYY-MM-DD").nullable().default(null),
  tasks: z.array(PlanTask).default([]),
});
export type PlanMilestone = z.infer<typeof PlanMilestone>;

/** A plan as the PM or the app proposes it: phases with their tasks, plus loose tasks. */
export const ProjectPlanBody = z
  .object({
    milestones: z.array(PlanMilestone).max(MAX_PLAN_MILESTONES).default([]),
    /** Tasks outside any milestone; small-project mode attaches them to the one milestone. */
    tasks: z.array(PlanTask).default([]),
    /** Recorded as the reason on every task row the plan writes (spec B.5). */
    reason: z.string().min(1).max(500).default("planned from the brief"),
  })
  .superRefine((plan, ctx) => {
    const all = [...plan.milestones.flatMap((m) => m.tasks), ...plan.tasks];
    if (all.length > MAX_PLAN_TASKS) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: `a plan holds at most ${MAX_PLAN_TASKS} tasks; got ${all.length}`,
      });
    }
    if (all.length === 0 && plan.milestones.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "the plan names no milestone and no task",
      });
    }
    const seen = new Set<string>();
    for (const t of all) {
      if (t.key === undefined) continue;
      if (seen.has(t.key)) {
        ctx.addIssue({ code: "custom", path: ["tasks"], message: `duplicate task key ${t.key}` });
      }
      seen.add(t.key);
    }
  });
export type ProjectPlan = z.infer<typeof ProjectPlanBody>;
export type ProjectPlanInput = z.input<typeof ProjectPlanBody>;

export interface ShapedTask {
  key: string | null;
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
  /** The task's own tier, or the project's default. */
  riskTier: number;
  priority: number;
  dependsOn: string[];
  budgetUsdMicro: number;
  specialist: string | null;
  status: "draft" | "ready";
}

export interface ShapedMilestone {
  name: string;
  successCriteria: string[];
  targetDate: string | null;
  orderIndex: number;
  tasks: ShapedTask[];
}

export interface ShapedPlan {
  smallProject: boolean;
  /** Exactly one in small-project mode. */
  milestones: ShapedMilestone[];
  /** Tasks under no milestone; always empty in small-project mode. */
  unassigned: ShapedTask[];
}

function parsePlan(input: ProjectPlanInput): ProjectPlan {
  const r = ProjectPlanBody.safeParse(input);
  if (!r.success) {
    throw new ForerunnerError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; "),
      { details: { issues: r.error.issues.length } },
    );
  }
  return r.data;
}

/**
 * The rows a plan becomes, before anything is written (pure). Outside small-project mode a
 * milestone per planned phase in plan order, each with its tasks, and the loose tasks under
 * none. In small-project mode exactly one milestone: the planned one when the plan names a
 * single milestone, else one named after the project with every phase's success criteria
 * (in order, once each) and the latest target date; every task joins it in plan order, so the
 * task list is flat. A task's tier is its own or the project's default.
 */
export function shapeProjectPlan(
  input: ProjectPlanInput,
  project: Pick<ProjectRow, "name" | "small_project_mode">,
): ShapedPlan {
  return shapeParsed(parsePlan(input), project);
}

function shapeParsed(
  plan: ProjectPlan,
  project: Pick<ProjectRow, "name" | "small_project_mode">,
): ShapedPlan {
  const tier = defaultRiskTier(project);
  const shape = (t: PlanTask): ShapedTask => ({
    key: t.key ?? null,
    title: t.title,
    outcome: t.outcome,
    acceptanceCriteria: t.acceptanceCriteria,
    riskTier: t.riskTier ?? tier,
    priority: t.priority,
    dependsOn: t.dependsOn,
    budgetUsdMicro: t.budgetUsdMicro,
    specialist: t.specialist ?? null,
    status: t.status,
  });
  if (!project.small_project_mode) {
    return {
      smallProject: false,
      milestones: plan.milestones.map((m, i) => ({
        name: m.name,
        successCriteria: m.successCriteria,
        targetDate: m.targetDate,
        orderIndex: i,
        tasks: m.tasks.map(shape),
      })),
      unassigned: plan.tasks.map(shape),
    };
  }
  const single = plan.milestones.length === 1 ? plan.milestones[0] : undefined;
  const dates = plan.milestones
    .map((m) => m.targetDate)
    .filter((d): d is string => d !== null)
    .sort();
  return {
    smallProject: true,
    milestones: [
      {
        name: single?.name ?? project.name,
        successCriteria: [...new Set(plan.milestones.flatMap((m) => m.successCriteria))],
        targetDate: dates.at(-1) ?? null,
        orderIndex: 0,
        tasks: [...plan.milestones.flatMap((m) => m.tasks), ...plan.tasks].map(shape),
      },
    ],
    unassigned: [],
  };
}

/** What joining the project's open milestone adds to it (small-project mode). */
export interface MilestoneMerge {
  /** Success criteria the plan names that the milestone did not have, in plan order, once each. */
  successCriteria: string[];
  /** The plan's latest target date when the milestone has none or an earlier one; else null. */
  targetDate: string | null;
}

/**
 * Small-project mode: what a later plan adds to the open milestone its tasks join, or null
 * when nothing is new (pure). Criteria the milestone already names and a target date no later
 * than its own add nothing; the milestone keeps its name whatever the plan calls its own.
 * Dates are calendar dates (`YYYY-MM-DD`), so "later" is the string order.
 */
export function milestoneMerge(
  open: Pick<MilestoneRow, "success_criteria" | "target_date">,
  planned: Pick<ShapedMilestone, "successCriteria" | "targetDate">,
): MilestoneMerge | null {
  const have = new Set(open.success_criteria);
  const successCriteria = [...new Set(planned.successCriteria)].filter((c) => !have.has(c));
  const later =
    planned.targetDate !== null &&
    (open.target_date === null || planned.targetDate > open.target_date);
  const targetDate = later ? planned.targetDate : null;
  if (successCriteria.length === 0 && targetDate === null) return null;
  return { successCriteria, targetDate };
}

/** The audit row's `input_summary` for a join: the milestone and what the plan added to it. */
function describeMerge(open: MilestoneRow, merged: MilestoneMerge): string {
  const parts: string[] = [];
  if (merged.successCriteria.length > 0) {
    const quoted = merged.successCriteria.map((c) => JSON.stringify(c)).join(", ");
    parts.push(`success criteria added: ${quoted}`);
  }
  if (merged.targetDate !== null) {
    parts.push(`target date ${open.target_date ?? "none"} -> ${merged.targetDate}`);
  }
  const text = `plan joined milestone ${JSON.stringify(open.name)} (${open.id}): ${parts.join("; ")}`;
  return text.length > MAX_AUDIT_SUMMARY_CHARS
    ? `${text.slice(0, MAX_AUDIT_SUMMARY_CHARS - 1)}…`
    : text;
}

interface Placed {
  task: ShapedTask;
  milestone: ShapedMilestone | null;
}

const labelOf = (t: ShapedTask): string => t.key ?? t.title;

/**
 * Plan order, except that a task comes after every plan task it depends on (so each row's
 * `depends_on` can hold ids at insert time). A cycle is a planning error and is refused.
 */
function orderByDependencies(placed: Placed[]): Placed[] {
  const byKey = new Map<string, number>();
  placed.forEach((p, i) => {
    if (p.task.key !== null) byKey.set(p.task.key, i);
  });
  const state: (0 | 1 | 2)[] = placed.map(() => 0);
  const out: Placed[] = [];
  const visit = (i: number, trail: string[]) => {
    const here = placed[i] as Placed;
    if (state[i] === 2) return;
    const name = labelOf(here.task);
    if (state[i] === 1) {
      throw new ForerunnerError(
        "validation",
        `plan dependencies form a cycle: ${[...trail, name].join(" -> ")}`,
        { details: { trail: [...trail, name] } },
      );
    }
    state[i] = 1;
    for (const dep of here.task.dependsOn) {
      const j = byKey.get(dep);
      if (j !== undefined) visit(j, [...trail, name]);
    }
    state[i] = 2;
    out.push(here);
  };
  for (let i = 0; i < placed.length; i++) visit(i, []);
  return out;
}

export interface PlanAuthor {
  humanId?: string | null;
  agentId?: string | null;
}

export interface AppliedPlan {
  /** Milestone rows this call wrote, in order. */
  milestones: MilestoneRow[];
  /**
   * Small-project mode: the project's open milestone the tasks joined instead of a new one, as
   * it stands after `merged` was applied.
   */
  reusedMilestone: MilestoneRow | null;
  /** What joining added to `reusedMilestone`; null when nothing was new or a milestone was created. */
  merged: MilestoneMerge | null;
  /** Task rows this call wrote, dependencies before dependants. */
  tasks: TaskRow[];
  /** The id of every written task that named a `key`, by key (the intake's first-session plan reads it). */
  keyed: Record<string, string>;
}

/**
 * Writes a plan as milestone and task rows in one transaction, shaped by the project's mode
 * (`shapeProjectPlan`). Outside small-project mode new milestones follow the project's
 * existing ones (`order_index`). In small-project mode the tasks join the project's open
 * milestone (`planned` or `active`, first by order) when it has one, so a small project keeps
 * exactly one; otherwise the one milestone is created. The joined milestone keeps its name and
 * takes what the plan adds (`milestoneMerge`: new success criteria, a later target date) with
 * the plan's author on the row; milestone rows carry no reason yet (B.5), so the change and
 * the plan's reason go to the audit log as one `project.plan` row. `dependsOn` entries are
 * plan keys or ids of the project's own tasks; anything else, a cycle, a duplicate key, an
 * empty plan or one over the caps is refused with `validation` and nothing is written.
 */
export async function applyProjectPlan(
  store: StateStore,
  project: ProjectRow,
  input: ProjectPlanInput,
  author: PlanAuthor,
): Promise<AppliedPlan> {
  const plan = parsePlan(input);
  const shaped = shapeParsed(plan, project);
  const placed: Placed[] = [
    ...shaped.milestones.flatMap((m) => m.tasks.map((task) => ({ task, milestone: m }))),
    ...shaped.unassigned.map((task) => ({ task, milestone: null })),
  ];
  const keys = new Set(placed.map((p) => p.task.key).filter((k): k is string => k !== null));
  for (const p of placed) {
    for (const dep of p.task.dependsOn) {
      if (keys.has(dep)) continue;
      const row = await store.task.get(dep);
      if (!row) {
        throw new ForerunnerError(
          "validation",
          `${labelOf(p.task)} depends on unknown task ${dep}`,
          { details: { task: labelOf(p.task), dependsOn: dep } },
        );
      }
      if (row.project_id !== project.id) {
        throw new ForerunnerError(
          "validation",
          `${labelOf(p.task)} depends on ${dep}, a task of another project`,
          { details: { task: labelOf(p.task), dependsOn: dep } },
        );
      }
    }
  }
  const ordered = orderByDependencies(placed);
  const authorColumns = {
    author_human: author.humanId ?? null,
    author_agent: author.agentId ?? null,
  };
  const insertMilestone = (tx: StateStore, m: ShapedMilestone, orderIndex: number) =>
    tx.milestone.insert({
      project_id: project.id,
      name: m.name,
      success_criteria: m.successCriteria,
      target_date: m.targetDate,
      order_index: orderIndex,
      ...authorColumns,
    });

  return store.transaction(async (tx) => {
    const existing = await tx.milestone.forProject(project.id);
    const created: MilestoneRow[] = [];
    let reused: MilestoneRow | null = null;
    let merged: MilestoneMerge | null = null;
    const idOf = new Map<ShapedMilestone, string>();
    if (shaped.smallProject) {
      const only = shaped.milestones[0] as ShapedMilestone;
      const open = existing.find((m) => m.status === "planned" || m.status === "active");
      if (open) {
        merged = milestoneMerge(open, only);
        reused = open;
        if (merged) {
          reused = await tx.milestone.update(open.id, open.version, {
            success_criteria: [...open.success_criteria, ...merged.successCriteria],
            ...(merged.targetDate === null ? {} : { target_date: merged.targetDate }),
            ...authorColumns,
          });
          await tx.auditLog.append({
            tool: PLAN_AUDIT_TOOL,
            allowed: true,
            human_id: author.humanId ?? null,
            agent_id: author.agentId ?? null,
            input_summary: redact(describeMerge(open, merged)),
            result_summary: redact(`reason: ${plan.reason}`),
          });
        }
        idOf.set(only, open.id);
      } else {
        const row = await insertMilestone(tx, only, 0);
        created.push(row);
        idOf.set(only, row.id);
      }
    } else {
      let order = existing.reduce((n, m) => Math.max(n, m.order_index + 1), 0);
      for (const m of shaped.milestones) {
        const row = await insertMilestone(tx, m, order++);
        created.push(row);
        idOf.set(m, row.id);
      }
    }
    const ids = new Map<string, string>();
    const tasks: TaskRow[] = [];
    for (const { task, milestone } of ordered) {
      const row = await tx.task.insert({
        project_id: project.id,
        milestone_id: milestone ? (idOf.get(milestone) ?? null) : null,
        title: task.title,
        outcome: task.outcome,
        acceptance_criteria: task.acceptanceCriteria,
        risk_tier: task.riskTier,
        status: task.status,
        priority: task.priority,
        depends_on: task.dependsOn.map((d) => ids.get(d) ?? d),
        budget_usd_micro: task.budgetUsdMicro,
        est_cost_usd_micro: 0,
        actual_cost_usd_micro: 0,
        attempt: 0,
        specialist: task.specialist,
        reason: plan.reason,
        ...authorColumns,
      });
      if (task.key !== null) ids.set(task.key, row.id);
      tasks.push(row);
    }
    return {
      milestones: created,
      reusedMilestone: reused,
      merged,
      tasks,
      keyed: Object.fromEntries(ids),
    };
  });
}
