import type { StateStore, TaskRow } from "@forerunner/state";
import type { ProjectCard } from "./api-types.ts";

/**
 * A project's state on its card (U-071). "blocked" only when something waits on the person in
 * the Inbox: an open blocking request, or a task that needs them with its card open. A task
 * marked as needing the person with no card (a person's "Needs me", a budget stop) is
 * `needsYou`: the card names it and links to it, since nothing in the Inbox would. Failed tasks
 * or a non-blocking request open are "attention"; no task is "idle".
 */
export async function projectHealth(
  store: StateStore,
  projectId: string,
  humanId: string,
  tasks: readonly Pick<TaskRow, "id" | "title" | "status">[],
  failed: number,
): Promise<{ health: ProjectCard["health"]; needsYou: ProjectCard["needsYou"] }> {
  const open = await store.humanRequest.list(
    { status: "open", project_id: projectId, human_id: humanId } as never,
    { limit: 1000 },
  );
  const carded = new Set(open.map((r) => r.task_id).filter((id): id is string => Boolean(id)));
  const needsHuman = tasks.filter((t) => t.status === "needs_human");
  const waitsInInbox = open.some((r) => r.blocking) || needsHuman.some((t) => carded.has(t.id));
  const uncarded = needsHuman.find((t) => !carded.has(t.id));
  const needsYou = uncarded ? { taskId: uncarded.id, title: uncarded.title } : null;
  const health: ProjectCard["health"] = waitsInInbox
    ? "blocked"
    : needsYou || failed > 0 || open.length > 0
      ? "attention"
      : tasks.length === 0
        ? "idle"
        : "good";
  return { health, needsYou };
}
