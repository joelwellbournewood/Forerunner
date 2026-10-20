import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandDef } from "../types.ts";
import { asObject, authorOf, quote, resolveProject } from "./shared.ts";

/** note.add (spec J next-session queue): a note, idea or correction for the next session. */
const params = z.object({
  text: z.string().min(1).max(4000),
  kind: z.enum(["note", "idea", "correction"]).default("note"),
  priority: z.number().int().min(0).max(5).default(3),
  project: z.string().optional(),
});
export type NoteAddParams = z.infer<typeof params>;

function sentenceOf(p: NoteAddParams, projectName: string): string {
  return `Noted for the next session on ${projectName}: ${quote(p.text)}. Undo.`;
}

export const noteAdd: CommandDef<NoteAddParams> = {
  name: "note.add",
  description: "Add a note, idea or correction to the next-session queue of a project.",
  params,
  risk: "low",
  scope: "project",
  reversible: true,
  undoStrategy: "dismiss the queued item",
  async plan(p, ctx) {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    // The human's own queued items: a co-worker's notes on the project are not theirs (ADR 0044).
    const pending = await ctx.store.queue.pending(project.id, { humanId: ctx.humanId });
    return buildCard({
      command: "note.add",
      what: `the next-session queue of ${project.name}`,
      oldValue: `${pending.length} item${pending.length === 1 ? "" : "s"}`,
      newValue: `+ ${p.kind} ${quote(p.text)}`,
      scope: "project",
      risk: "low",
      sentence: sentenceOf(p, project.name),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
    });
  },
  async run(p, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    const item = await ctx.store.queue.enqueue({
      project_id: project.id,
      human_id: ctx.humanId,
      kind: p.kind,
      text: p.text,
      priority: p.priority,
      transcript: ctx.source === "voice" ? ctx.wordsUsed : null,
      ...authorOf(ctx),
    });
    return {
      before: { queue_item_id: null },
      after: { queue_item_id: item.id, project_id: project.id },
      sentence: sentenceOf(p, project.name),
      projectId: project.id,
    };
  },
  async undo(_p, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.queue_item_id !== "string") return;
    const item = await ctx.store.queue.get(a.queue_item_id);
    if (item?.status === "queued") await ctx.store.queue.dismiss(item.id, item.version);
  },
};
