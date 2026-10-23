/**
 * Whose rows these are, on a shared state (ADR 0041 item 4: the daemon reads and acts as its own
 * human only). The project rule is `@forerunner/commands` `ownsProject` (one rule for the routes
 * and the commands): a project belongs to this human when its members (`settings.members`,
 * agent ids) list the human's principal agent, when `settings.shared_with` lists the human, when
 * the human authored it, or when nothing records an owner at all (a local project with no
 * membership facts). A session belongs to the human who owns its agent.
 */
import type { AgentRow, SessionRow } from "@forerunner/state";

export { ownsProject, type Who } from "@forerunner/commands";

export function ownsSession(
  session: Pick<SessionRow, "agent_id">,
  agent: Pick<AgentRow, "id" | "owner_human_id"> | undefined,
  who: { humanId: string; agentId: string },
): boolean {
  if (session.agent_id === who.agentId) return true;
  return agent?.owner_human_id === who.humanId;
}
