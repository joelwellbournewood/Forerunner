import type { HumanRequestView, MessageView } from "../api/state-client.ts";

/**
 * Inbox order on the phone (spec K.4, J.3): blocking requests first, then newest; unread
 * messages first, then newest. Kept next to the phone screens so they do not depend on the
 * desktop pages (same rule as `pages/InboxPage.tsx`).
 */
export function sortRequests(requests: readonly HumanRequestView[]): HumanRequestView[] {
  return [...requests].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function sortMessages(messages: readonly MessageView[]): MessageView[] {
  return [...messages].sort((a, b) => {
    const aUnread = a.readAt === null ? 0 : 1;
    const bUnread = b.readAt === null ? 0 : 1;
    if (aUnread !== bUnread) return aUnread - bUnread;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
