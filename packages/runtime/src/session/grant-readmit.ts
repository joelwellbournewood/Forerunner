import type { StateStore } from "@forerunner/state";
import { CREDENTIAL_WAIT_REASON } from "./credential-wait.ts";

/**
 * l4-cred-screens (L4-creds-15, C5L-6; ADR 0120 amended 2026-11-22): the tasks a yes to "Use
 * your API key until 15:40?" takes back into the project's running session: the ready tasks that
 * waited for a Claude credential inside it (the runner gave each back with
 * `CREDENTIAL_WAIT_REASON` and set it aside), and nothing else. Other ready work joins a running
 * session only if it fits (the owner's option C, "the session keeps its promise"), as every
 * prepared task does; before, the yes took every ready task back, also one the session had left
 * out because it did not fit, so the key ran more than the card's figure counted.
 */
export async function waitedForCredential(
  store: Pick<StateStore, "task">,
  projectId: string,
): Promise<string[]> {
  const ready = await store.task.readyTasks(projectId, { limit: 50 }).catch(() => []);
  return ready.filter((t) => t.reason === CREDENTIAL_WAIT_REASON).map((t) => t.id);
}
