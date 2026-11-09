import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
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

/**
 * The history after making `targetId` the active project: the project left (`currentId`) is the
 * last one, so "go back" returns to it, also when it was in the history before (it was kept at
 * its old place, and "go back" went to an older project); the target is not in it. Shared by
 * `project.switch` and `project.create` with `switch` (W15-36: the New project dialog's
 * creation kept no history, so "go back" found "no previous project").
 */
function historyAfterSwitch(
  history: string[],
  currentId: string | null,
  targetId: string,
): string[] {
  const next = history.filter((id) => id !== targetId && id !== currentId);
  if (currentId && currentId !== targetId) next.push(currentId);
  return next.slice(-HISTORY_MAX);
}

/**
 * The name a removed project keeps (W15-36): the Undo of its creation archives it and frees its
 * name for a new project, renaming it "<name> (removed)" (or "(removed 2)", … when that is
 * taken too); the name it had is kept in its settings for the words that say it was removed.
 */
const REMOVED_NAME_KEY = "removed_name";

/** The name a project had before its creation was undone, or null for a project still there. */
export function removedProjectName(project: ProjectRow): string | null {
  if (project.status !== "archived") return null;
  const kept = project.settings[REMOVED_NAME_KEY];
  return typeof kept === "string" && kept ? kept : project.name;
}

async function freedName(store: StateStore, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (removed)` : `${name} (removed ${n})`;
    if (!(await store.project.byName(candidate))) return candidate;
  }
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
    // The latest project left that is still there: never a removed one (W15-36).
    for (const id of [...history].reverse()) {
      if (id === currentId) continue;
      const previous = await ctx.store.project.get(id);
      if (previous && previous.status !== "archived") return { target: previous, current, history };
    }
    throw new ForerunnerError("validation", "there is no previous project to go back to");
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
    const trimmed = historyAfterSwitch(history, current?.id ?? null, target.id);
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
  /** Never back to a removed project (W15-36: its creation was undone since). */
  async undoBlocked(_params, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.active_project !== "string") return null;
    const previous = await ctx.store.project.get(b.active_project);
    const removed = previous ? removedProjectName(previous) : null;
    return removed === null ? null : `the project ${removed} was removed`;
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

/** A name another project has, as the dashboard's create says it (one sentence, what to do). */
function duplicateProjectWords(name: string): string {
  return `There is already a project called "${name}". Pick another name.`;
}

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
      throw new ForerunnerError("validation", duplicateProjectWords(existing.name), {
        details: { cause: "duplicate_name", projectId: existing.id },
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
      throw new ForerunnerError("validation", duplicateProjectWords(existing.name), {
        details: { cause: "duplicate_name", projectId: existing.id },
      });
    }
    const human = await ctx.store.human.mustGet(ctx.humanId);
    // W15-36: the New project dialog's creation is the daemon's own (`ports.createProject`: the
    // brief, the plan from it or the doc set), so one click is this one command and one row.
    const project = ctx.ports.createProject
      ? await ctx.ports.createProject({
          name: params.name,
          goal: params.goal,
          repos: params.repos,
        })
      : await ctx.store.project.insert({
          name: params.name,
          goal: params.goal,
          repos: params.repos,
          autonomy_level: human.default_autonomy,
          ...authorOf(ctx),
        });
    // The standard doc set (spec G.5): the daemon's port scaffolds it as the dashboard's
    // create does; a port that fails never fails the creation (the daemon records the gap).
    try {
      if (!ctx.ports.createProject) await ctx.ports.projectCreated?.(project.id);
    } catch (e) {
      log("commands").warn("project docs hook failed", {
        projectId: project.id,
        error: errorMessage(e),
      });
    }
    const previousActive =
      (human.notify_prefs[ACTIVE_PROJECT_KEY] as string | undefined) ?? ctx.activeProjectId ?? null;
    // Made active, the project left goes on the history as with project.switch, so "go back"
    // returns to it (requirements Q.3; W15-36: the New project dialog's creation kept none).
    const history = historyOf(human.notify_prefs);
    const nextHistory = params.switch
      ? historyAfterSwitch(history, previousActive, project.id)
      : history;
    if (params.switch) {
      await patchHumanPrefs(ctx.store, ctx.humanId, {
        [ACTIVE_PROJECT_KEY]: project.id,
        [PROJECT_HISTORY_KEY]: nextHistory,
      });
    }
    return {
      before: { project_id: null, active_project: previousActive, project_history: history },
      after: {
        project_id: project.id,
        active_project: params.switch ? project.id : previousActive,
        project_history: nextHistory,
      },
      sentence: createSentence(params),
      projectId: project.id,
      activeProjectId: params.switch ? project.id : undefined,
    };
  },
  /**
   * W15-36: the project goes. It is archived (its tasks, cards and changes keep their rows) and
   * its name is freed for a new project: it becomes "<name> (removed)", the words Changes shows
   * for its rows. Its open cards leave the Inbox (nothing can be done for a removed project).
   * The project you were on before is active again when the removed one was the active one;
   * "go back" never returns to it. Everything is read from the row and the store, so the same
   * after a restart.
   */
  async undo(_params, before, after, ctx) {
    const a = asObject(after);
    const b = asObject(before);
    const createdId = typeof a.project_id === "string" ? a.project_id : null;
    if (createdId) {
      const row = await ctx.store.project.get(createdId);
      if (row && row.status !== "archived") {
        await ctx.store.project.update(row.id, row.version, {
          status: "archived",
          active: false,
          name: await freedName(ctx.store, row.name),
          settings: { ...row.settings, [REMOVED_NAME_KEY]: row.name },
          ...authorOf(ctx),
        });
      }
      for (const card of await ctx.store.humanRequest.list({
        project_id: createdId,
        status: "open",
      })) {
        await ctx.store.humanRequest.withdraw(card.id, card.version);
      }
    }
    const human = await ctx.store.human.mustGet(ctx.humanId);
    const activeNow = human.notify_prefs[ACTIVE_PROJECT_KEY];
    const patch: Record<string, JsonValue> = {
      [PROJECT_HISTORY_KEY]: historyOf(human.notify_prefs).filter((id) => id !== createdId),
    };
    // Another project made active since stays active: the undo takes back the creation.
    if (activeNow === undefined || activeNow === null || activeNow === createdId) {
      const previous =
        typeof b.active_project === "string" ? await ctx.store.project.get(b.active_project) : null;
      patch[ACTIVE_PROJECT_KEY] = previous && previous.status !== "archived" ? previous.id : null;
    }
    await patchHumanPrefs(ctx.store, ctx.humanId, patch);
  },
};
