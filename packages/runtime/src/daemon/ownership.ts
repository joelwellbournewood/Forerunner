/**
 * Whose rows these are, on a shared state (ADR 0041 item 4: the daemon reads and acts as its own
 * human only). A project belongs to this human when its members (`settings.members`, agent ids)
 * list the human's principal agent, when `settings.shared_with` lists the human, when the human
 * authored it, or when nothing records an owner at all (a local project with no membership
 * facts). A session belongs to the human who owns its agent.
 */
import type { AgentRow, ProjectRow, SessionRow } from "@forerunner/state";

export interface Who {
  humanId: string;
  agentId: string;
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function ownsProject(
  project: Pick<ProjectRow, "settings" | "author_human">,
  who: Who,
): boolean {
  const settings = (project.settings ?? {}) as { members?: unknown; shared_with?: unknown };
  const members = ids(settings.members);
  const shared = ids(settings.shared_with);
  if (members.includes(who.agentId) || shared.includes(who.humanId)) return true;
  if (project.author_human && project.author_human === who.humanId) return true;
  return members.length === 0 && !project.author_human;
}

export function ownsSession(
  session: Pick<SessionRow, "agent_id">,
  agent: Pick<AgentRow, "id" | "owner_human_id"> | undefined,
  who: Who,
): boolean {
  if (session.agent_id === who.agentId) return true;
  return agent?.owner_human_id === who.humanId;
}
