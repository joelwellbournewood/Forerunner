import type { HumanRequestRow, JsonObject } from "@forerunner/state";
import { approvalOf, isExecutorAnswer } from "../loop/answered-cards.ts";

/**
 * What became of a change card a conversation read back (design §3.9, §5 rule 4: what the chat
 * says about it is true now). The card's request row says it: open while the registry holds it
 * (`waiting`); answered by the registry itself (a yes or a no typed or tapped in Chat or Talk,
 * spoken, tapped on the phone or in Changes: the row carries the executor's `verdict`) or in
 * the Inbox (the row carries the option the Inbox sent); else it expired (its ten minutes ran
 * out, a restart could not arm it again, it was withdrawn).
 *
 * The conversation view (`GET /projects/:id/conversation`, each read-back's `card`) and the
 * chat's "yes" with nothing waiting read it from here. Before, the view called an Inbox "no" a
 * "yes" (the Inbox's answer has no verdict), and the chat said "it expired or was answered in
 * the Inbox" for a card answered in the chat itself.
 */
export type CardFate =
  | { state: "waiting" }
  | { state: "yes" | "no"; where: "inbox" | "registry" }
  | { state: "expired" };

export function cardFate(
  row: Pick<HumanRequestRow, "status" | "answer" | "options"> | null | undefined,
  live: boolean,
): CardFate {
  if (live) return { state: "waiting" };
  if (row?.status !== "answered") return { state: "expired" };
  if (isExecutorAnswer(row.answer)) {
    // "declined" is a no. "confirmed" is a yes, and so is "refused": the person said yes and the
    // registry could not carry it out (its risk rose, a start that can no longer happen); the
    // reply to that yes said why.
    const verdict = (row.answer as JsonObject).verdict;
    return { state: verdict === "declined" ? "no" : "yes", where: "registry" };
  }
  const options = row.options.filter((o): o is string => typeof o === "string");
  return { state: approvalOf(row.answer, options) ? "yes" : "no", where: "inbox" };
}
