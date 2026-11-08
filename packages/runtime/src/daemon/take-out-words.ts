/**
 * The words of "Take this work out" (merged-actions, `loop/take-out.ts`), in a module of their
 * own so the UI's fake daemon says exactly what the daemon says (design §5: ≤ 2 sentences, task
 * titles in quotes, "and N more" beyond three).
 */

/** "A", "A and B", "A, B and C". */
export function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Up to three names, then "and N more" (design §5 rule 5): "A, B, C and 2 more". */
export function namesList(items: readonly string[]): string {
  if (items.length <= 3) return andList(items);
  return `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

/** A task's title in quotes, on one line. */
export const quoted = (title: string): string => `"${title.replace(/\s+/g, " ").trim()}"`;

/** The sentence for a merge whose shape Forerunner cannot undo safely (the fix scope's words). */
export function unknownShapeSentence(number: number): string {
  return `#${number} was merged in a way Forerunner cannot undo safely; undo it on GitHub.`;
}

/** The answer of a take-out that waits for the person, with the done tasks that built on it. */
export function takeOutOpenedSentence(
  title: string,
  number: number,
  builtOn: readonly string[],
): string {
  const opened = `Opened #${number} to take ${quoted(title)} out. It waits for you to merge it.`;
  if (!builtOn.length) return opened;
  const they = builtOn.length === 1 ? "it still works" : "they still work";
  const names = namesList(builtOn.map(quoted));
  return `${opened} ${names} built on it: check ${they} once #${number} is merged.`;
}

/**
 * The Inbox notice of a take-out that conflicted with later work: one per task while it is open
 * (`TaskTakeOut.notice`, `isTakeOutNotice`). Its change card keeps the task's title and the
 * files, and `request-words.ts` words it from them (`takeOutNoticeCard`), so a title that holds
 * ": " or ". " is never cut into a title and a body (review of merged-actions).
 */
export const TAKE_OUT_NOTICE_PREFIX = "take_out:conflict:";

/** What went wrong and what to do, after the task's name (the notice's body). */
export function takeOutConflictBody(files: readonly string[]): string {
  return `Later work changed the same lines in ${namesList(files)}: undo it on GitHub by hand, or ask in Chat for a task that does it.`;
}

/** The answer of a take-out that conflicted with later work (the notice's `why` too). */
export function takeOutConflictSentence(title: string, files: readonly string[]): string {
  return `${quoted(title)} could not be taken out by itself. ${takeOutConflictBody(files)}`;
}
