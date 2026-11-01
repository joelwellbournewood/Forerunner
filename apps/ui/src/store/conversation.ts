import type { ConversationView, DaemonClient } from "../api/client.ts";
import type { UiStore } from "./store.ts";

/**
 * One conversation as the screens show it (design §3.9): the turns the daemon keeps
 * (`GET /projects/:id/conversation`, or `GET /conversation` outside any project), the change
 * waiting for a yes, and the line being sent now with its reply as it streams. The Chat tab and
 * Talk read the same state, so they never disagree; before, the Chat tab kept its lines in the
 * browser's storage and Talk in its own memory, and neither showed the other's (U-071).
 */
export interface ConversationState {
  view: ConversationView | null;
  /** The line being sent and its reply as it streams; null when nothing is in flight. */
  live: { said: string; text: string; error: string | null } | null;
  /** The daemon did not answer the read; the screen offers Retry. */
  error: string | null;
}

export const EMPTY_CONVERSATION: ConversationState = { view: null, live: null, error: null };

/** The key of a conversation in the store: the project id, "" outside any project. */
export function conversationKey(projectId: string | null): string {
  return projectId ?? "";
}

/** Reads the conversation from the daemon into the store. */
export async function loadConversation(
  client: DaemonClient,
  store: UiStore,
  projectId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const key = conversationKey(projectId);
  try {
    const view = await client.conversation(projectId, signal);
    store.dispatch({ type: "conversation", key, update: (c) => ({ ...c, view, error: null }) });
  } catch (e) {
    if (signal?.aborted) return;
    const message = e instanceof Error ? e.message : String(e);
    store.dispatch({ type: "conversation", key, update: (c) => ({ ...c, error: message }) });
  }
}
