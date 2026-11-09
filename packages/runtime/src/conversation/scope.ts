import type { ProjectRow, StateStore } from "@forerunner/state";
import { ownsProject } from "../daemon/ownership.ts";

/**
 * Whose records chat may read (d1109-chat-guard, ADR 0114; AGENTS.md privacy): the projects of
 * this person, as one function the chat's read tools, its facts and recall (d1109-chat-recall)
 * all ask. A project is theirs when its members list one of their agents, when it is shared
 * with them (`settings.shared_with`), when they authored it, or when nothing records an owner
 * (a local project with no membership facts): `ownsProject`, the daemon routes' rule. Before
 * (7d6b34a) the read tools found a project by name among every project on the store, with no
 * owner filter. Later areas change the rule here only: d1109-onerepo-join adds the projects
 * joined into the asked one, wave 8's collab-privacy replaces the rule.
 */
export async function scopeOf(
  store: Pick<StateStore, "project" | "agent">,
  humanId: string,
): Promise<ProjectRow[]> {
  const agents = await store.agent.forOwner(humanId, { limit: 100 });
  const projects = await store.project.list({}, { limit: 2000 });
  return projects.filter(
    (p) =>
      ownsProject(p, { humanId, agentId: null }) ||
      agents.some((a) => ownsProject(p, { humanId, agentId: a.id })),
  );
}
