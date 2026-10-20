import { ForerunnerError } from "@forerunner/platform";
import type { JsonValue, ProjectRow, StateStore } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf, patchHumanPrefs, resolveProject } from "./shared.ts";

/**
 * Context (spec Q.3): there is always an active project. It is stored per human in
 * human.notify_prefs under "active_project", with the last ten under "project_history" so
 * "go back" works. Commands without a named project apply to the active one.
 */
export const ACTIVE_PROJECT_KEY = "active_project";
export const PROJECT_HISTORY_KEY = "project_history";
const HISTORY_MAX = 10;

export async function activeProjectOf(store: StateStore, humanId: string): Promise<string | null> {
  const human = await store.human.get(humanId);
  const id = human?.notify_prefs[ACTIVE_PROJECT_KEY];
  return typeof id === "string" && id ? id : null;
}

function historyOf(prefs: Record<string, JsonValue>): string[] {
  const h = prefs[PROJECT_HISTORY_KEY];
  return Array.isArray(h) ? h.filter((x): x is string => typeof x === "string") : [];
}

const switchParams = z
  .object({
    /** Project name or id. */
    project: z.string().min(1).optional(),
    /** Go back to the previous active project. */
    back: z.boolean().optional(),
  })
  .refine((p) => !!p.project || p.back === true, { message: "name a project or say back" });
export type ProjectSwitchParams = z.infer<typeof switchParams>;

async function targetOf(
  params: ProjectSwitchParams,
  ctx: CommandContext,
): Promise<{ target: ProjectRow; current: ProjectRow | null; history: string[] }> {
  const human = await ctx.store.human.mustGet(ctx.humanId);
  const currentId =
    (human.notify_prefs[ACTIVE_PROJECT_KEY] as string | undefined) ?? ctx.activeProjectId ?? null;
  const current = currentId ? ((await ctx.store.project.get(currentId)) ?? null) : null;
  const history = historyOf(human.notify_prefs);
  if (params.back) {
    const previousId = [...history].reverse().find((id) => id !== currentId);
    const previous = previousId ? await ctx.store.project.get(previousId) : undefined;
    if (!previous) {
      throw new ForerunnerError("validation", "there is no previous project to go back to");
    }
    return { target: previous, current, history };
  }
  const { project } = await resolveProject(ctx, params.project);
  return { target: project, current, history };
}

function switchSentence(params: ProjectSwitchParams, target: ProjectRow): string {
  return params.back
    ? `Switched back to ${target.name}. Undo.`
    : `Switched the active project to ${target.name}. Undo.`;
}

export const projectSwitch: CommandDef<ProjectSwitchParams> = {
  name: "project.switch",
  description:
    "Make another project the active one by name, or go back to the previous active project.",
  params: switchParams,
  risk: "low",
  scope: "global",
  reversible: true,
  undoStrategy: "restore the previous active project from the change log",
  async plan(params, ctx) {
    const { target, current } = await targetOf(params, ctx);
    return buildCard({
      command: "project.switch",
      what: "the active project",
      oldValue: current?.name ?? "none",
      newValue: target.name,
      scope: "global",
      risk: "low",
      sentence: switchSentence(params, target),
      reversible: true,
      projectId: target.id,
      projectName: target.name,
    });
  },
  async run(params, ctx) {
    const { target, current, history } = await targetOf(params, ctx);
    const next = [...history.filter((id) => id !== target.id)];
    if (current && current.id !== target.id) next.push(current.id);
    const trimmed = [...new Set(next)].slice(-HISTORY_MAX);
    await patchHumanPrefs(ctx.store, ctx.humanId, {
      [ACTIVE_PROJECT_KEY]: target.id,
      [PROJECT_HISTORY_KEY]: trimmed,
    });
    return {
      before: { active_project: current?.id ?? null, project_history: history },
      after: { active_project: target.id, project_history: trimmed },
      sentence: switchSentence(params, target),
      projectId: target.id,
      activeProjectId: target.id,
    };
  },
  async undo(_params, before, _after, ctx) {
    const b = asObject(before);
    await patchHumanPrefs(ctx.store, ctx.humanId, {
      [ACTIVE_PROJECT_KEY]: typeof b.active_project === "string" ? b.active_project : null,
      [PROJECT_HISTORY_KEY]: Array.isArray(b.project_history) ? b.project_history : [],
    });
  },
};

const createParams = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().default(""),
  repos: z.array(z.string()).default([]),
  /** Make it the active project. Default true. */
  switch: z.boolean().default(true),
});
export type ProjectCreateParams = z.infer<typeof createParams>;

function createSentence(p: ProjectCreateParams): string {
  return `Created the project ${p.name}${p.switch ? " and made it the active project" : ""}. Undo.`;
}

export const projectCreate: CommandDef<ProjectCreateParams> = {
  name: "project.create",
  description: "Create a project with a name, a goal and optional repositories.",
  params: createParams,
  risk: "low",
  scope: "global",
  reversible: true,
  undoStrategy: "archive the created project and restore the previous active project",
  async plan(params, ctx) {
    const existing = await ctx.store.project.byName(params.name);
    if (existing) {
      throw new ForerunnerError("validation", `a project named ${params.name} already exists`, {
        details: { projectId: existing.id },
      });
    }
    return buildCard({
      command: "project.create",
      what: "the list of projects",
      oldValue: "without it",
      newValue: params.name,
      scope: "global",
      risk: "low",
      sentence: createSentence(params),
      reversible: true,
      projectName: params.name,
    });
  },
  async run(params, ctx) {
    const existing = await ctx.store.project.byName(params.name);
    if (existing) {
      throw new ForerunnerError("validation", `a project named ${params.name} already exists`, {
        details: { projectId: existing.id },
      });
    }
    const human = await ctx.store.human.mustGet(ctx.humanId);
    const project = await ctx.store.project.insert({
      name: params.name,
      goal: params.goal,
      repos: params.repos,
      autonomy_level: human.default_autonomy,
      ...authorOf(ctx),
    });
    const previousActive =
      (human.notify_prefs[ACTIVE_PROJECT_KEY] as string | undefined) ?? ctx.activeProjectId ?? null;
    if (params.switch) {
      await patchHumanPrefs(ctx.store, ctx.humanId, { [ACTIVE_PROJECT_KEY]: project.id });
    }
    return {
      before: { project_id: null, active_project: previousActive },
      after: {
        project_id: project.id,
        active_project: params.switch ? project.id : previousActive,
      },
      sentence: createSentence(params),
      projectId: project.id,
      activeProjectId: params.switch ? project.id : undefined,
    };
  },
  async undo(_params, before, after, ctx) {
    const a = asObject(after);
    const b = asObject(before);
    if (typeof a.project_id === "string") {
      const row = await ctx.store.project.get(a.project_id);
      if (row) {
        await ctx.store.project.update(row.id, row.version, {
          status: "archived",
          active: false,
          ...authorOf(ctx),
        });
      }
    }
    await patchHumanPrefs(ctx.store, ctx.humanId, {
      [ACTIVE_PROJECT_KEY]: typeof b.active_project === "string" ? b.active_project : null,
    });
  },
};
