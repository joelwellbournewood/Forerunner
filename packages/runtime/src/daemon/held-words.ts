import type { JsonObject } from "@forerunner/state";
import { ANSWER_CARD_KEYS } from "../wiring/request-answers.ts";
import type { StartCheckView } from "./api-types.ts";

/**
 * Why a task of the project that waits on the person (`needs_human`) holds, as the Start check
 * says it (l4-starts-carried, L4g-left-1, sibling of L4-money-204): its open card asks the person
 * something (`answer`: "needs your answer" with Open it), it is paused at a limit no answer lifts
 * (`limit`: the limit and what changes it, with the Settings link; before, "needs your answer"
 * though the card asks nothing until the limit changes), or the person paused it and no card asks
 * anything (`paused`: "which you paused"; before, "needs your answer" too). A leaf with no store
 * or billing import, so the UI's fake daemon says the same words.
 */
export type HeldTask =
  | { title: string; why: "answer" }
  | {
      title: string;
      why: "limit";
      clause: string;
      to: string;
      /** The limit alone ("paused at the project's budget of CHF 0.06"), the clause's first half. */
      limit: string;
      /** What changes it, with its noun ("Raise the project's budget in Settings"). */
      raise: string;
    }
  /**
   * fixup-l4-starts-carried: `byYou` false for a task paused with no card that asks and that the
   * person did not pause (a run left it so): "which is paused", never "needs your answer".
   */
  | { title: string; why: "paused"; byYou?: boolean };

/**
 * What holds a task paused at a limit no answer lifts (this month's cap, the project's budget,
 * the subscription's share): the card's own title after the task's name ("paused at the
 * project's budget of CHF 0.06", `budgetStopTitle`) and what changes it, with the Settings link:
 * 'paused at the project's budget of CHF 0.06; raise it in Settings'. Null for any other card: a
 * card that asks something (Continue at the task's own budget, the question after a pause that
 * got no further) needs the person's answer.
 */
export function outerLimitHold(
  card: JsonObject | null | undefined,
  resetDay: (iso: unknown) => string | null,
): { clause: string; to: string; limit: string; raise: string } | null {
  if (!card || card.key !== ANSWER_CARD_KEYS.budgetStop || card.question === true) return null;
  const source = card.source;
  if (source !== "project" && source !== "month" && source !== "plan") return null;
  const limit = limitWords(card, source);
  const day = resetDay(card.resets_at);
  if (source === "project")
    return {
      clause: `${limit}; raise it in Settings`,
      to: "/settings#other-settings",
      limit,
      raise: "Raise the project's budget in Settings",
    };
  if (source === "month")
    return {
      clause: `${limit}; raise it in Settings${day ? `, or it resets on ${day}` : ""}`,
      to: "/settings",
      limit,
      raise: "Raise the monthly cap in Settings",
    };
  return {
    clause: `${limit}; ${day ? `it resets on ${day}, or raise the share in Settings` : "raise the share in Settings"}`,
    to: "/settings",
    limit,
    raise: "Raise the share in Settings",
  };
}

/** The card's title after the quoted task name (one place for the limit's words), or the limit. */
function limitWords(card: JsonObject, source: "project" | "month" | "plan"): string {
  const title = typeof card.title === "string" ? card.title : "";
  const task = typeof card.task_title === "string" ? card.task_title : "";
  const prefix = `"${task.replace(/\s+/g, " ").trim()}" `;
  if (task && title.startsWith(prefix) && title.length > prefix.length)
    return title.slice(prefix.length);
  return source === "project"
    ? "paused at the project's budget"
    : source === "month"
      ? "paused at this month's cap"
      : "paused at the share of your Claude subscription that Forerunner may use";
}

/**
 * The Start check's sentence and button for a held task (`HeldTask`): '"X" paused at the
 * project's budget of CHF 0.06; raise it in Settings.' [Open Settings]; with the task that waits
 * on it ('"B" waits on "A", paused at ...'), or '"B" waits on "A", which you paused.' [Open
 * Tasks]; else '"X" needs your answer.' [Open it].
 */
export function heldBlocker(
  h: HeldTask,
  waiter: string | null,
  tasksTab: string,
): StartCheckView["blocked"] {
  const name = `"${h.title}"`;
  const subject = waiter ? `"${waiter}" waits on ${name},` : name;
  // fixup-l4-starts-carried: `holds` says the work exists and a task of it holds it, so the
  // Start dialog gives no "Give your agent work first" beside the sentence.
  if (h.why === "limit")
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run: ${subject} ${waiter ? afterName(h.clause) : h.clause}.`,
      action: { kind: "link", label: "Open Settings", to: h.to },
      holds: "limit",
    };
  if (h.why === "paused" && waiter)
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run: ${subject} ${pausedState(h)}.`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
      holds: "paused",
    };
  return {
    kind: "nothing_runnable",
    sentence: `Nothing can run: ${name} needs your answer.`,
    action: { kind: "link", label: "Open it", to: "/inbox" },
    holds: "answer",
  };
}

/**
 * The limit's words after a comma that follows the task's name: "paused at ..." as they are,
 * any other ("is done; its review waits for room in the project's budget", the card of a task
 * whose review waits) with "which" (fixup-l4-starts-carried's bench walk: '"A", is done; ...').
 */
function afterName(limit: string): string {
  return /^paused\b/.test(limit) ? limit : `which ${limit}`;
}

/** "which you paused", or "which is paused" for a pause no card asks about and not the person's. */
function pausedState(h: { byYou?: boolean }): string {
  return h.byYou === false ? "which is paused" : "which you paused";
}

/**
 * fixup-l4-starts-carried (L4g-left-1 on the Start dialog's waiting list): how the list says a
 * dependency that waits on the person, by what holds it, as `heldBlocker` does: its state after
 * its name ('"B" waits on "A", paused at the project's budget of CHF 0.06, so it cannot run.')
 * and what to do ('Raise the project's budget in Settings, or change what it waits for on the
 * Tasks tab.'). "needs your answer" only when its card asks; before, every such dependency read
 * "which needs your answer ... Answer it in the Inbox", also one the person paused (no card).
 */
export function heldDependency(h: HeldTask): {
  why: HeldTask["why"];
  state: string;
  advice: string;
} {
  const rewire = "or change what it waits for on the Tasks tab.";
  if (h.why === "limit")
    return { why: "limit", state: afterName(h.limit), advice: `${h.raise}, ${rewire}` };
  if (h.why === "paused")
    return { why: "paused", state: pausedState(h), advice: `Resume "${h.title}", ${rewire}` };
  return {
    why: "answer",
    state: "which needs your answer",
    advice: `Answer it in the Inbox, ${rewire}`,
  };
}
