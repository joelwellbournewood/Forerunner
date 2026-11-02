import { ForerunnerError, redact } from "@forerunner/platform";
import type { MilestoneRow, ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import { SIGNOFF_SPECIALISTS } from "../loop/verification.ts";
import { DEFAULT_TASK_PRIORITY, PRIORITY_VALUES, TaskPrioritySchema } from "../priority.ts";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import { FULL_REVIEW_TIER } from "./sandbox-gate.ts";

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
/**
 * Tier of a new task that names none in small-project mode (spec B.6). Since ADR 0104 the
 * critic reviews it as the light review: no task closes on automatic checks alone.
 */
export const SMALL_PROJECT_RISK_TIER = 0;

/** A brief shorter than this, on at most two lines and with no list, asks for a small plan. */
export const SHORT_BRIEF_CHARS = 200;
/** Most tasks a small plan has (design §3.3: one to three), in one milestone. */
export const SMALL_PLAN_MAX_TASKS = 3;

/**
 * Whether a project's brief asks for a small plan (design §3.3: "a one-line brief gets a small
 * plan"): under `SHORT_BRIEF_CHARS` characters, at most two lines, no bulleted or numbered
 * list. The intake then asks for one milestone of one to three tasks ("Plan size: small",
 * `intakePlanSize`, ADR 0103); a one-line brief had got six tasks over three milestones (live
 * check of 2026-11-01). It does not turn small-project mode on: the mode's tier 0 would take the
 * critic off the code tasks (the owner's decision of 2026-11-01). No brief at all is not short.
 */
export function isShortBrief(brief: string | null | undefined): boolean {
  const t = (brief ?? "").trim();
  if (!t || t.length >= SHORT_BRIEF_CHARS) return false;
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  return lines.length <= 2 && !lines.some((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
}

/** The one place a new task's tier is chosen when the task names none. */
export function defaultRiskTier(project: Pick<ProjectRow, "small_project_mode">): 0 | 1 {
  return project.small_project_mode ? SMALL_PROJECT_RISK_TIER : DEFAULT_RISK_TIER;
}

/**
 * The tier a task is stored at for the specialist that does it (phase C leftover C-2, ADR 0104
 * decision 4): a deploy or a data migration (`SIGNOFF_SPECIALISTS`) is stored at least at the
 * full review, whatever the plan, New task, the chat or an edit asked for. Before, such a task
 * was stored at the light review: its row read "Light review", and its run used the process
 * sandbox on the host while only the critic applied the registry's floor. Every path that
 * writes a task's tier or its specialist calls this (`task.create`, `task.update`, the plan's
 * tasks).
 */
export function riskTierFor(specialist: string | null | undefined, tier: number): number {
  const name = specialist ? canonicalSpecialistName(specialist) : null;
  return name && SIGNOFF_SPECIALISTS.has(name) ? Math.max(tier, FULL_REVIEW_TIER) : tier;
}

/** Caps on one plan, enforced before anything is written. */
export const MAX_PLAN_MILESTONES = 20;
export const MAX_PLAN_TASKS = 200;

/** Milestone target dates are calendar dates, the way the Plan tab's timeline reads them. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const PlanKey = z.string().min(1).max(80);

/** Longest plan reason, task title and milestone name a plan keeps (longer ones are shortened). */
export const MAX_PROJECT_PLAN_REASON_CHARS = 500;
export const MAX_PLAN_TITLE_CHARS = 200;
export const MAX_MILESTONE_NAME_CHARS = 200;

/**
 * Prose a plan carries, cut to `max` characters at the last whole sentence that fits (followed
 * by " …"), else at the last word (followed by "…"), else hard. Live, the planning model wrote a
 * 754-character `plan.reason` against a 500-character limit and the person lost the whole plan
 * (live check of 2026-11-01): a long explanation is shortened, never a reason to refuse the plan.
 * Identifiers (keys, specialist names) and counts are never shortened: they are refused.
 */
export function shortenProse(text: string, max: number): string {
  if (text.length <= max) return text;
  const t = text.trim();
  if (t.length <= max) return t;
  // Whole sentences: the last sentence end (".", "!" or "?" before white space) that leaves
  // room for " …", if it keeps at least half the room.
  const room = max - 2;
  let end = -1;
  for (const m of t.slice(0, room + 1).matchAll(/[.!?](?=\s)/g))
    if (m.index + 1 <= room) end = m.index + 1;
  if (end >= room / 2) return `${t.slice(0, end)} …`;
  const head = dropHalfSurrogate(t.slice(0, max - 1));
  const space = head.search(/\s\S*$/);
  const words = space >= (max - 1) / 2 ? head.slice(0, space) : head;
  return `${words.replace(/[\s,;:(–—-]+$/, "")}…`;
}

/** A cut never ends inside a character written as two UTF-16 units (an emoji, a rare letter). */
function dropHalfSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** A prose field of a plan: at least `min` characters, shortened to `max` (`shortenProse`). */
export const planProse = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .transform((s) => shortenProse(s, max));

export const PlanTask = z.object({
  /** Name other plan tasks use in `dependsOn`; unique within the plan. */
  key: PlanKey.optional(),
  title: planProse(MAX_PLAN_TITLE_CHARS, 3),
  outcome: z.string().min(3),
  acceptanceCriteria: z.array(z.string().min(1)).max(50).default([]),
  /** Left out, the project's default applies (`defaultRiskTier`). */
  riskTier: z.number().int().min(0).max(3).optional(),
  /** Low, medium or high (U-041); a model's old number is read as its level. */
  priority: TaskPrioritySchema.default(DEFAULT_TASK_PRIORITY),
  /** Keys of plan tasks, or ids of the project's existing tasks. */
  dependsOn: z.array(z.string().min(1)).max(50).default([]),
  budgetUsdMicro: z.number().int().nonnegative().default(0),
  specialist: z.string().min(1).max(80).optional(),
  status: z.enum(["draft", "ready"]).default("ready"),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanMilestone = z.object({
  name: planProse(MAX_MILESTONE_NAME_CHARS),
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
    /**
     * Recorded as the reason on every task row the plan writes (spec B.5). A longer one is
     * shortened at a sentence or a word (`shortenProse`), never refused.
     */
    reason: planProse(MAX_PROJECT_PLAN_REASON_CHARS).default("planned from the brief"),
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
 * task list is flat. A task's tier is its own or the project's default. A dependency cycle
 * among the plan's tasks is refused here with `validation` as well: a plan that shapes is one
 * `applyProjectPlan` can write, so a caller that shapes a plan to show it (the intake,
 * ADR 0055) never puts an unwritable plan to the human.
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
  const shaped = shapeRows(plan, project);
  orderByDependencies(placedOf(shaped));
  return shaped;
}

/** Every shaped task with the milestone it sits under, in plan order. */
function placedOf(shaped: ShapedPlan): Placed[] {
  return [
    ...shaped.milestones.flatMap((m) => m.tasks.map((task) => ({ task, milestone: m }))),
    ...shaped.unassigned.map((task) => ({ task, milestone: null })),
  ];
}

function shapeRows(
  plan: ProjectPlan,
  project: Pick<ProjectRow, "name" | "small_project_mode">,
): ShapedPlan {
  const tier = defaultRiskTier(project);
  const shape = (t: PlanTask): ShapedTask => ({
    key: t.key ?? null,
    title: t.title,
    outcome: t.outcome,
    acceptanceCriteria: t.acceptanceCriteria,
    riskTier: riskTierFor(t.specialist, t.riskTier ?? tier),
    priority: PRIORITY_VALUES[t.priority],
    dependsOn: t.dependsOn,
    budgetUsdMicro: t.budgetUsdMicro,
    // Stored as the registry names it: the PM's "ops" is `ops-deploy` (U-014).
    specialist: t.specialist ? canonicalSpecialistName(t.specialist) : null,
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

/** `tool` of the audit row the daemon writes for each milestone change made from the app (B.5). */
export const MILESTONE_AUDIT_TOOL = "milestone.change";

/**
 * The history of a milestone change (spec B.5), as the audit row's `input_summary`: the row's
 * version step and each field that moved, before -> after. The reason goes in the row's
 * `result_summary`, as on the plan writer's join row.
 */
export function describeMilestoneChange(before: MilestoneRow, after: MilestoneRow): string {
  const parts: string[] = [];
  if (after.name !== before.name) {
    parts.push(`name ${JSON.stringify(before.name)} -> ${JSON.stringify(after.name)}`);
  }
  const added = after.success_criteria.filter((c) => !before.success_criteria.includes(c));
  const removed = before.success_criteria.filter((c) => !after.success_criteria.includes(c));
  const quote = (list: string[]) => list.map((c) => JSON.stringify(c)).join(", ");
  if (added.length > 0) parts.push(`success criteria added: ${quote(added)}`);
  if (removed.length > 0) parts.push(`success criteria removed: ${quote(removed)}`);
  if (after.target_date !== before.target_date) {
    parts.push(`target date ${before.target_date ?? "none"} -> ${after.target_date ?? "none"}`);
  }
  if (after.status !== before.status) parts.push(`status ${before.status} -> ${after.status}`);
  const text = `milestone ${JSON.stringify(before.name)} (${before.id}) v${before.version} -> v${after.version}: ${parts.length > 0 ? parts.join("; ") : "no field changed"}`;
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
 * (`shapeProjectPlan`). New milestones follow the project's existing ones (`order_index`),
 * whatever the mode. In small-project mode the tasks join the project's open milestone
 * (`planned` or `active`, first by order) when it has one, so a small project keeps exactly
 * one; otherwise the one milestone is created, after any milestone on file from before the
 * mode (a done or cancelled one keeps its order). The joined milestone keeps its name and
 * takes what the plan adds (`milestoneMerge`: new success criteria, a later target date) as a
 * versioned change with the plan's author and reason on the row (spec B.5, like every task
 * row the plan writes); what was added and the plan's reason also go to the audit log as one
 * `project.plan` row. `dependsOn` entries are
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
  const placed = placedOf(shaped);
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
      reason: plan.reason,
      ...authorColumns,
    });

  return store.transaction(async (tx) => {
    const existing = await tx.milestone.forProject(project.id);
    const created: MilestoneRow[] = [];
    let reused: MilestoneRow | null = null;
    let merged: MilestoneMerge | null = null;
    const idOf = new Map<ShapedMilestone, string>();
    // A new milestone goes after every milestone on file, in the mode too: a small project
    // with closed milestones from before the mode never gets a second row at their index.
    let order = existing.reduce((n, m) => Math.max(n, m.order_index + 1), 0);
    if (shaped.smallProject) {
      const only = shaped.milestones[0] as ShapedMilestone;
      const open = existing.find((m) => m.status === "planned" || m.status === "active");
      if (open) {
        merged = milestoneMerge(open, only);
        reused = open;
        if (merged) {
          reused = await tx.milestone.change(
            open.id,
            open.version,
            {
              success_criteria: [...open.success_criteria, ...merged.successCriteria],
              ...(merged.targetDate === null ? {} : { target_date: merged.targetDate }),
            },
            plan.reason,
            author,
          );
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
        const row = await insertMilestone(tx, only, order);
        created.push(row);
        idOf.set(only, row.id);
      }
    } else {
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
