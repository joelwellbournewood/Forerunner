import type { ChatReplyView } from "../api/client.ts";
import { type KeyValueStore, storageKey } from "../lib/storage.ts";

/**
 * A project's Chat conversation, kept by the store per project and saved in the browser's
 * storage for this install (U-071): a tab switch or a reload used to lose it, with any Yes/No
 * card still waiting for an answer. The daemon keeps no per-project transcript route, so the
 * window keeps what it showed.
 */
export interface ChatMessage {
  id: string;
  role: "human" | "agent";
  text: string;
  /** Agent messages: true until the final reply frame arrived. */
  streaming?: boolean;
  reply?: ChatReplyView;
  error?: string;
}

/** The newest messages kept per project; older ones drop off the top. */
export const CHAT_HISTORY_LIMIT = 100;

/** What a reply that was still streaming when the window closed says after a reload. */
export const INTERRUPTED_REPLY =
  "The reply did not finish: the window was closed or reloaded while it came in.";

export function chatStorageName(projectId: string): string {
  return `chat.${projectId}`;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<ChatMessage>;
  return (
    typeof m.id === "string" &&
    (m.role === "human" || m.role === "agent") &&
    typeof m.text === "string"
  );
}

/** The saved conversation of a project; a reply cut off by a reload says so. */
export function loadChat(
  storage: KeyValueStore,
  installId: string | null,
  projectId: string,
): ChatMessage[] {
  const raw = storage.get(storageKey(installId, chatStorageName(projectId)));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMessage)
      .map((m) =>
        m.streaming ? { ...m, streaming: false, error: m.error ?? INTERRUPTED_REPLY } : m,
      );
  } catch {
    return [];
  }
}

export function saveChat(
  storage: KeyValueStore,
  installId: string | null,
  projectId: string,
  messages: readonly ChatMessage[],
): void {
  const key = storageKey(installId, chatStorageName(projectId));
  if (messages.length === 0) {
    storage.remove(key);
    return;
  }
  storage.set(key, JSON.stringify(messages.slice(-CHAT_HISTORY_LIMIT)));
}
