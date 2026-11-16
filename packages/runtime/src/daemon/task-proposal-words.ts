/**
 * d1109-selftasks-run (ADR 0119 point 7): the words of the agent's suggestion card about its own
 * task list, import-free so the Inbox's words (request-words.ts) and the UI's fake daemon read them
 * without the session's modules. `session/task-proposal.ts` files and applies the card.
 */

/** The card's key (`change_card.key`). */
export const TASK_PROPOSAL_KEY = "task_proposal";
/** The card's two answers, in order: the first makes the changes, the second keeps the tasks. */
export const TASK_PROPOSAL_OPTIONS = ["Make these changes", "Keep the tasks"] as const;

type Card = Record<string, unknown>;

/**
 * The card's Done line (design §3.8: what happens next): 'Changed 3 tasks; the session takes them
 * if they fit.' while a session runs, 'Changed 3 tasks; your next Start runs them.' with none; a
 * change that no longer applied is named; Keep says nothing changed; a replaced card says so.
 */
export function proposalOutcome(card: Card): string | null {
  if (card.replaced === true) return "A newer suggestion of the agent replaced this one.";
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const left = Array.isArray(card.left_out)
    ? card.left_out.filter((x): x is string => typeof x === "string")
    : [];
  // Each left-out change with why, at most two, then how many more: one sentence.
  const named = left.slice(0, 2).map((l) => l.trim().replace(/[.;:]+$/, ""));
  const leftWords = left.length
    ? ` Left out: ${named.join("; ")}${left.length > 2 ? `; and ${left.length - 2} more` : ""}.`
    : "";
  switch (card.outcome) {
    case "kept":
      return "Kept the tasks as they are; nothing changed.";
    case "applied": {
      const n = typeof card.changed === "number" ? card.changed : 0;
      const next =
        card.running === true ? "the session takes them if they fit" : "your next Start runs them";
      return `Changed ${n} ${plural(n, "task", "tasks")}; ${next}.${leftWords}`;
    }
    case "not_applied":
      return `Nothing changed: none of the changes applies now.${leftWords}`;
    case "applying":
      return "Making the changes…";
    default:
      return null;
  }
}
