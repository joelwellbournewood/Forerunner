/**
 * Whose project this is, on a shared state (ADR 0041 item 4: a human's agent reads and acts as
 * its own human only). A project belongs to the human when its members (`settings.members`,
 * agent ids) list the human's principal agent, when `settings.shared_with` lists the human,
 * when the human authored it, or when nothing records an owner at all (a local project with no
 * membership facts). One rule for the daemon's routes (`packages/runtime/src/daemon/
 * ownership.ts` re-exports it) and for the commands that read a project out (`summary.speak`).
 */
import type { ProjectRow } from "@forerunner/state";

export interface Who {
  humanId: string;
  /** The human's principal agent; null when the caller has none (membership cannot match). */
  agentId: string | null;
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
  if ((who.agentId !== null && members.includes(who.agentId)) || shared.includes(who.humanId))
    return true;
  if (project.author_human && project.author_human === who.humanId) return true;
  return members.length === 0 && !project.author_human;
}
