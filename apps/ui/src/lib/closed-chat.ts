import { joinedChatSentence } from "@forerunner/runtime/daemon/join-words";

/** A removed project's chat: kept to read, with nowhere to ask about it. */
export const REMOVED_CHAT = "This chat is kept to read; the project was removed.";

/**
 * OJ-06 (d1109-onerepo-join) and l4-chat-carried (C4-left-9): the line of a closed project's
 * conversation, the same on its Chat tab and in Talk: a project joined into another says where to
 * ask ('This chat is kept to read; ask about its work in the Chat of "Site".', with Open it to that
 * Chat), a removed one that it was removed. Null for a project that takes new work.
 */
export function closedChatOf(
  project: {
    status?: string | null;
    joinedInto?: { projectId: string; name: string } | null;
  } | null,
): { text: string; to: string | null } | null {
  if (!project) return null;
  const joined = project.joinedInto ?? null;
  if (joined)
    return {
      text: joinedChatSentence(joined.name),
      to: `/projects/${encodeURIComponent(joined.projectId)}/chat`,
    };
  return project.status === "archived" ? { text: REMOVED_CHAT, to: null } : null;
}
