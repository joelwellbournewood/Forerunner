import type { StateStore, TaskRow } from "@forerunner/state";
import { isChatOnlyCard } from "../wiring/request-answers.ts";
import type { ProjectCard } from "./api-types.ts";

/**
 * A project's state on its card (U-071), from its open Inbox cards (design §3.8: what becomes
 * a card, and nothing else, counts as "needs you"). `needsYou` names the task of the project's
 * oldest open card about a task, so "needs you: <task>" never stands beside "Waiting on you 0"
 * (`waitingOnYou` counts the same open cards). "blocked" while a blocking card is open or a task
 * waits on its card; failed tasks, an open card that blocks nothing, or a task an agent left
 * waiting with no card (a budget stop: the Tasks tab reads "Paused" with Resume) are
 * "attention"; a task the person paused waits on nobody; no task is "idle".
 */
export async function projectHealth(
  store: StateStore,
  projectId: string,
  humanId: string,
  tasks: readonly Pick<TaskRow, "id" | "title" | "status">[],
  failed: number,
): Promise<{ health: ProjectCard["health"]; needsYou: ProjectCard["needsYou"] }> {
  // The chat's read-back of an answer to a card is the conversation's, no card of its own.
  const open = (
    await store.humanRequest.list(
      { status: "open", project_id: projectId, human_id: humanId } as never,
      { orderBy: [{ column: "created_at" }, { column: "id" }], limit: 1000 },
    )
  ).filter((r) => !isChatOnlyCard(r));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const carded = open
    .map((r) => (r.task_id ? byId.get(r.task_id) : undefined))
    .find((t): t is Pick<TaskRow, "id" | "title" | "status"> => t !== undefined);
  const needsYou = carded ? { taskId: carded.id, title: carded.title } : null;
  const cardedIds = new Set(open.map((r) => r.task_id).filter((id): id is string => !!id));
  const needsHuman = tasks.filter((t) => t.status === "needs_human");
  const waitsInInbox = open.some((r) => r.blocking) || needsHuman.some((t) => cardedIds.has(t.id));
  // A task an agent left needing the person with no card (not the person's own pause).
  const agentLeft = needsHuman.some(
    (t) =>
      !cardedIds.has(t.id) &&
      !("author_human" in t && (t as TaskRow).author_human && !(t as TaskRow).author_agent),
  );
  const health: ProjectCard["health"] = waitsInInbox
    ? "blocked"
    : agentLeft || failed > 0 || open.length > 0
      ? "attention"
      : tasks.length === 0
        ? "idle"
        : "good";
  return { health, needsYou };
}
