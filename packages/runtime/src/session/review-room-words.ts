/**
 * l4-money-pause, run L4 (L4-money-111): the words of a review that waits for room, in a module
 * with no imports, so the UI's fake daemon can read the task words without the runtime's store.
 */
/**
 * Where a waiting review needs room, by the limit that refused it (L4-money-111): "room in its
 * budget", "room in this session's budget", "room in the project's budget", "room under this
 * month's cap", "room in your Claude subscription's share".
 */
export function reviewRoomWords(source: unknown): string {
  switch (source) {
    case "session":
    case "session_budget":
      return "room in this session's budget";
    case "project":
      return "room in the project's budget";
    case "month":
      return "room under this month's cap";
    case "plan":
      return "room in your Claude subscription's share";
    default:
      return "room in its budget";
  }
}
