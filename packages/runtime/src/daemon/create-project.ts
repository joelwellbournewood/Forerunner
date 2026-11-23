import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { JsonValue, ProjectRow, StateStore } from "@forerunner/state";
import type { z } from "zod";
import type { ProjectDocsPort } from "../loop/ports.ts";
import type { LinkCheck, RepositoryUse } from "../sources/repository-use.ts";
import { TOGETHER_KEY, TOOK_OVER_KEY, togetherOf } from "../sources/repository-words.ts";
import type { CreateProjectBody } from "./api-types.ts";

/** The settings key project.create's Undo writes on a removed project (W15-36). */
const REMOVED_NAME = "removed_name";

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
  store: Pick<StateStore, "project" | "queue" | "human">;
  /**
   * The daemon's clock (L4-github-105): Work together's `settings.together.at` is the daemon's
   * time, as every other stamp, so a simulated clock or a computer with a wrong wall clock still
   * says the day the press was made.
   */
  clock: Pick<Clock, "nowIso">;
  human: { id: string };
  agent: { id: string };
  events: { emit(event: string, payload: unknown): unknown };
  conversation?: { setActiveProject(humanId: string, projectId: string | null): void } | null;
  /**
   * The standard doc set's writer (`ProjectDocs`, runtime.md "Project docs"): a pull request
   * on the linked repository or the project's workspace. Absent, nothing is scaffolded.
   */
  docs?: Pick<ProjectDocsPort, "scaffoldProject">;
  /**
   * d1109-onerepo-link (ADR 0117): one repository, one project. The link is checked before
   * anything is written: a project on this computer that uses it, or the repository's own
   * Forerunner project (its marker and pull request marks), refuses the creation with the offer
   * (`LinkRefusalDetails`). Absent (tests of other things), nothing is checked.
   */
  repositoryUse?: Pick<RepositoryUse, "check">;
}

/** What `POST /projects` answers for a name another project has (the handoff of wave 1). */
export function duplicateProjectSentence(name: string): string {
  return `There is already a project called "${name}". Pick another name.`;
}

export async function createProjectRecord(
  deps: CreateProjectDeps,
  body: z.infer<typeof CreateProjectBody>,
): Promise<ProjectRow> {
  // d1109-onerepo-link: the link first, before anything is written (no row, no change-log row,
  // no docs pull request for a refused link): the offer is more use than a name clash.
  const linked = deps.repositoryUse
    ? await deps.repositoryUse.check(body.repos ?? [], {
        takeOver: body.takeOver,
        together: body.together,
        withBrief: !!body.brief?.trim(),
      })
    : {};
  if (linked.revive) return reviveTogether(deps, linked.revive, body);
  // D9: a together project is named as the repository's marker names it (cleaned and scanned);
  // without one, or when that name is taken here, the name the person typed.
  const markerName = linked.together?.name ?? null;
  const name =
    markerName && !(await deps.store.project.byName(markerName)) ? markerName : body.name;
  // A name another project has was the store's "UNIQUE constraint failed: project.name" as a
  // 500 `internal`; it is a sentence with a stable code, before anything is written, as the
  // chat's `project.create` says it.
  const clash = await deps.store.project.byName(name);
  if (clash)
    throw new ForerunnerError("validation", duplicateProjectSentence(clash.name), {
      details: { cause: "duplicate_name", projectId: clash.id },
    });
  // U-058: a project that names no level starts at the person's default (Settings, "the
  // default autonomy for new projects"), as `project.create` by chat or voice does.
  const autonomy =
    body.autonomyLevel ?? (await deps.store.human.get(deps.human.id))?.default_autonomy ?? 2;
  const p = await deps.store.project.insert({
    // D9: Work together adopts the repository's project id (read from GitHub at the press).
    ...(linked.together ? { id: linked.together.id } : {}),
    name,
    goal: body.goal,
    repos: body.repos ?? [],
    stage: "planning",
    status: "active",
    budget_usd_micro: body.budgetUsdMicro ?? 0,
    autonomy_level: autonomy,
    summary_cache: body.brief ? { brief: body.brief } : {},
    data_assets: [],
    settings: {
      members: [deps.agent.id],
      ...linkSettings(linked, name, deps.clock.nowIso()),
    },
    // Off at creation, whatever the brief: the mode gives a task that names no tier tier 0 (no
    // critic), and the critic reviews code tasks (the owner's decision of 2026-11-01). A short
    // brief asks the intake for a small plan instead (`intakePlanSize`, ADR 0103).
    small_project_mode: false,
    active: true,
    author_human: deps.human.id,
  });
  return afterInsert(deps, p, body, !!linked.together);
}

/** The settings a checked link adds: the take-over or the together project (ADR 0117). */
function linkSettings(linked: LinkCheck, name: string, now: string): Record<string, JsonValue> {
  if (linked.together)
    return {
      [TOGETHER_KEY]: {
        name: linked.together.name ?? name,
        at: now,
        activeOn: linked.together.activeOn,
        login: linked.together.login,
      },
    };
  if (linked.tookOver)
    return {
      [TOOK_OVER_KEY]: {
        projects: linked.tookOver.projects,
        name: linked.tookOver.name,
        at: linked.tookOver.at,
        ...(linked.tookOver.removed ? { removed: true } : {}),
      },
    };
  return {};
}

/**
 * Work together on a project that was removed here (D9): the same row comes back, its tasks as
 * they were, under its old name when that is free; never a second row with the shared id.
 */
async function reviveTogether(
  deps: CreateProjectDeps,
  row: ProjectRow,
  body: z.infer<typeof CreateProjectBody>,
): Promise<ProjectRow> {
  const kept =
    typeof row.settings[REMOVED_NAME] === "string" ? String(row.settings[REMOVED_NAME]) : "";
  const wanted = kept || body.name;
  const name = (await deps.store.project.byName(wanted)) ? row.name : wanted;
  const { [REMOVED_NAME]: _removed, ...settings } = row.settings;
  const before = togetherOf(row);
  const p = await deps.store.project.update(row.id, row.version, {
    status: "active",
    active: true,
    name,
    settings: {
      ...settings,
      [TOGETHER_KEY]: {
        name: before?.name ?? name,
        at: deps.clock.nowIso(),
        activeOn: before?.activeOn ?? null,
        login: before?.login ?? null,
      },
    },
    author_human: deps.human.id,
  });
  return afterInsert(deps, p, body, true);
}

/** The brief, the events, the active project and the doc set, for a row that now exists. */
async function afterInsert(
  deps: CreateProjectDeps,
  p: ProjectRow,
  body: z.infer<typeof CreateProjectBody>,
  together: boolean,
): Promise<ProjectRow> {
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
  // out; a rejection scaffolds the templates. A together project (D9) writes nothing to the
  // repository: its "scaffold" only brings this computer's copy along (ProjectDocs), with or
  // without a brief, since its plan-only intake drafts no documents.
  if (body.intake === true && !together) {
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
