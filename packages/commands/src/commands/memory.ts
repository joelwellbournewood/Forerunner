import { ForerunnerError } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, MemoryCommandPort } from "../types.ts";
import { asObject, quote, resolveProject } from "./shared.ts";

/**
 * memory.record (spec O.2 "writes to the same memory and logs", ADR 0061): a lesson the human
 * states in chat or voice ("remember that ...", "lesson: ...", or the model's `memory_record`
 * tool call) goes into the private memory of the human's principal agent, for the named or
 * active project (no project: every project of that agent), with the chat as its source. Low
 * risk: it changes no limit and nothing outside the human's own memory, so it acts at once,
 * reads the stored text back and is undone by retiring the lesson.
 */
const params = z.object({
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(8).optional(),
  project: z.string().optional(),
});
export type MemoryRecordParams = z.infer<typeof params>;

/** The sentence reads the lesson back whole up to this length. */
const READBACK_MAX = 300;

function memoryPort(ctx: CommandContext): MemoryCommandPort {
  if (!ctx.ports.memory)
    throw new ForerunnerError("unavailable", "lesson memory is not connected here");
  return ctx.ports.memory;
}

async function target(
  p: MemoryRecordParams,
  ctx: CommandContext,
): Promise<{
  project: ProjectRow | null;
  usedActive: boolean;
  agentName: string;
  agentId: string;
}> {
  if (!ctx.agentId) throw new ForerunnerError("validation", "no principal agent for this human");
  const agent = await ctx.store.agent.mustGet(ctx.agentId);
  if (agent.owner_human_id !== ctx.humanId)
    throw new ForerunnerError(
      "autonomy_insufficient",
      "a lesson goes only into the memory of the human's own agent",
      { details: { agentId: agent.id } },
    );
  // A named project, else the active one, else none: a lesson for every project.
  const resolved =
    p.project?.trim() || ctx.activeProjectId ? await resolveProject(ctx, p.project) : null;
  return {
    project: resolved?.project ?? null,
    usedActive: resolved?.usedActive ?? false,
    agentName: agent.name,
    agentId: agent.id,
  };
}

function sentenceOf(agentName: string, project: ProjectRow | null, text: string): string {
  return `Recorded a lesson in ${agentName}'s memory for ${project ? project.name : "every project"}: ${quote(text, READBACK_MAX)}. Undo.`;
}

/** `human:<id>;<source>:<conversation session>`: who said it, and in which chat. */
function sourceOf(ctx: CommandContext): string {
  const parts = [`human:${ctx.humanId}`];
  if (ctx.sessionId) parts.push(`${ctx.source}:${ctx.sessionId}`);
  return parts.join(";");
}

export const memoryRecord: CommandDef<MemoryRecordParams> = {
  name: "memory.record",
  description:
    "Record a lesson the human states (a fact or rule to remember for later sessions) in the private memory of the human's principal agent, for the active or named project.",
  params,
  risk: "low",
  scope: "project",
  reversible: true,
  undoStrategy: "retire the recorded lesson (a merged one restores the lesson it replaced)",
  async plan(p, ctx) {
    const t = await target(p, ctx);
    return buildCard({
      command: "memory.record",
      what: `the memory of ${t.agentName}${t.project ? ` for ${t.project.name}` : ""}`,
      oldValue: "not recorded",
      newValue: `lesson ${quote(p.text)}`,
      scope: "project",
      risk: "low",
      sentence: sentenceOf(t.agentName, t.project, p.text),
      reversible: true,
      projectId: t.project?.id ?? null,
      projectName: t.project?.name ?? null,
      usesActiveProject: t.usedActive,
    });
  },
  async run(p, ctx) {
    const port = memoryPort(ctx);
    const t = await target(p, ctx);
    const r = await port.recordLesson({
      agentId: t.agentId,
      humanId: ctx.humanId,
      projectId: t.project?.id ?? null,
      text: p.text,
      tags: p.tags ?? [],
      source: sourceOf(ctx),
    });
    return {
      before: { lesson_id: null },
      after: {
        lesson_id: r.lessonId,
        superseded_id: r.supersededId ?? null,
        project_id: t.project?.id ?? null,
        action: r.action,
      },
      sentence: sentenceOf(t.agentName, t.project, r.text),
      projectId: t.project?.id ?? null,
    };
  },
  async undo(_p, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.lesson_id !== "string") return;
    await memoryPort(ctx).forgetLesson({
      lessonId: a.lesson_id,
      restoreId: typeof a.superseded_id === "string" ? a.superseded_id : null,
      humanId: ctx.humanId,
    });
  },
};
