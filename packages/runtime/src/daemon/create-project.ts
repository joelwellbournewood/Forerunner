import type { ProjectRow, StateStore } from "@forerunner/state";
import type { z } from "zod";
import type { CreateProjectBody } from "./api-types.ts";

/**
 * The one way a project comes into being from the dashboard: `POST /projects` (spec A.1)
 * and an accepted source proposal (spec A.4) both go through here, so a project created from
 * a scan carries the same defaults, membership and events as one typed in. The brief, when
 * there is one, is kept whole in the summary cache and queued as a note for the first
 * session (the intake into docs, milestones and tasks is spec A.2).
 */
export interface CreateProjectDeps {
  store: Pick<StateStore, "project" | "queue">;
  human: { id: string };
  agent: { id: string };
  events: { emit(event: string, payload: unknown): unknown };
  conversation?: { setActiveProject(humanId: string, projectId: string | null): void } | null;
}

export async function createProjectRecord(
  deps: CreateProjectDeps,
  body: z.infer<typeof CreateProjectBody>,
): Promise<ProjectRow> {
  const p = await deps.store.project.insert({
    name: body.name,
    goal: body.goal,
    repos: body.repos ?? [],
    stage: "planning",
    status: "active",
    budget_usd_micro: body.budgetUsdMicro ?? 0,
    autonomy_level: body.autonomyLevel ?? 2,
    summary_cache: body.brief ? { brief: body.brief } : {},
    data_assets: [],
    settings: { members: [deps.agent.id] },
    small_project_mode: false,
    active: true,
    author_human: deps.human.id,
  });
  if (body.brief) {
    await deps.store.queue.enqueue({
      project_id: p.id,
      human_id: deps.human.id,
      kind: "note",
      text: `Project brief:\n${body.brief}`,
      priority: 5,
      status: "queued",
      author_human: deps.human.id,
    });
  }
  deps.events.emit("project", { id: p.id });
  deps.conversation?.setActiveProject(deps.human.id, p.id);
  return p;
}
