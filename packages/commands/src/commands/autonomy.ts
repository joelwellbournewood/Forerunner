import { AUTONOMY_NAMES, type AutonomyLevel } from "@forerunner/runtime";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandDef, Risk } from "../types.ts";
import { asObject, authorOf, resolveProject } from "./shared.ts";

/**
 * autonomy.set (spec J, Q): the per-project autonomy level 0-4. One step is medium risk, more
 * than one step high; an agent changing its own autonomy always needs the human (limit).
 */
const params = z.object({
  level: z.number().int().min(0).max(4),
  project: z.string().optional(),
});
export type AutonomySetParams = z.infer<typeof params>;

function label(level: number): string {
  return `${level} (${AUTONOMY_NAMES[level as AutonomyLevel] ?? "?"})`;
}

function riskOf(from: number, to: number): Risk {
  const delta = Math.abs(to - from);
  return delta === 0 ? "low" : delta === 1 ? "medium" : "high";
}

export const autonomySet: CommandDef<AutonomySetParams> = {
  name: "autonomy.set",
  description:
    "Set the autonomy level of a project: 0 Advisor, 1 Assisted, 2 Standard, 3 Trusted, 4 Autopilot.",
  params,
  risk: async (p, ctx) => {
    const { project } = await resolveProject(ctx, p.project);
    return riskOf(project.autonomy_level, p.level);
  },
  maxRisk: "high",
  scope: "project",
  reversible: true,
  undoStrategy: "restore the previous level from the change log",
  actionClass: "permission_change",
  limit: true,
  async plan(p, ctx) {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    return buildCard({
      command: "autonomy.set",
      what: `the autonomy of ${project.name}`,
      oldValue: label(project.autonomy_level),
      newValue: label(p.level),
      scope: "project",
      risk: riskOf(project.autonomy_level, p.level),
      sentence: `Set the autonomy of ${project.name} from ${label(project.autonomy_level)} to ${label(p.level)}. Undo.`,
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
    });
  },
  async run(p, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    await ctx.store.project.update(project.id, project.version, {
      autonomy_level: p.level,
      ...authorOf(ctx),
    });
    return {
      before: { project_id: project.id, autonomy_level: project.autonomy_level },
      after: { project_id: project.id, autonomy_level: p.level },
      sentence: `Set the autonomy of ${project.name} from ${label(project.autonomy_level)} to ${label(p.level)}. Undo.`,
      projectId: project.id,
    };
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.project_id !== "string" || typeof b.autonomy_level !== "number") return;
    const project = await ctx.store.project.mustGet(b.project_id);
    await ctx.store.project.update(project.id, project.version, {
      autonomy_level: b.autonomy_level,
      ...authorOf(ctx),
    });
  },
};
