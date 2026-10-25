import { errorMessage, log } from "@forerunner/platform";
import type { ProjectRow, StateStore } from "@forerunner/state";
import type { z } from "zod";
import type { ProjectDocsPort } from "../loop/ports.ts";
import type { CreateProjectBody } from "./api-types.ts";

const logger = log("create-project");

/**
 * The one way a project comes into being from the dashboard: `POST /projects` (spec A.1)
 * and an accepted source proposal (spec A.4) both go through here, so a project created from
 * a scan carries the same defaults, membership, events and standard doc set as one typed in.
 * The brief, when there is one, is kept whole in the summary cache and queued as a note for
 * the first session (the intake into docs, milestones and tasks is spec A.2). The doc set
 * (spec G.5, ADR 0058) is scaffolded here, right after the row exists, unless the body asks
 * for the intake, which drafts the set on the human's approval and scaffolds the templates on
 * a rejection; `project.create` by chat, voice or the palette reaches the same scaffold
 * through the command port (`scaffoldProjectDocs`).
 */
export interface CreateProjectDeps {
  store: Pick<StateStore, "project" | "queue">;
  human: { id: string };
  agent: { id: string };
  events: { emit(event: string, payload: unknown): unknown };
  conversation?: { setActiveProject(humanId: string, projectId: string | null): void } | null;
  /**
   * The standard doc set's writer (`ProjectDocs`, runtime.md "Project docs"): a pull request
   * on the linked repository or the project's workspace. Absent, nothing is scaffolded.
   */
  docs?: Pick<ProjectDocsPort, "scaffoldProject">;
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
  // The standard doc set (spec G.5): a pull request on the linked repository, or the
  // project's workspace. A creation that asks for the intake (spec A.2) leaves the set to the
  // intake's approval, which drafts the docs from the brief and scaffolds what the draft left
  // out; a rejection scaffolds the templates.
  if (body.intake === true) {
    logger.info("project docs deferred to the intake", { projectId: p.id });
  } else {
    await scaffoldProjectDocs(deps, p);
  }
  return p;
}

/**
 * The G.5 scaffold for a project that exists, never failing the caller: the port records the
 * outcome, or the error (`error`, `failed_at`), on the row's `summary_cache.docs`, and the
 * critic's drift check reports the missing docs at the first review. The create path awaits
 * it, so the card names the pull request; the chat's `project.create` runs it in the
 * background.
 */
export async function scaffoldProjectDocs(
  deps: Pick<CreateProjectDeps, "docs">,
  project: ProjectRow,
): Promise<void> {
  if (!deps.docs) return;
  try {
    await deps.docs.scaffoldProject(project);
  } catch (e) {
    logger.warn("project docs not scaffolded", { projectId: project.id, error: errorMessage(e) });
  }
}
