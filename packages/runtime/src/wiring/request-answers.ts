import type { HumanRequestRow } from "@forerunner/state";

/**
 * Answers to Inbox requests as the person gives them. The Inbox shows a request's options as
 * buttons (`optionLabel`) and a click sends that text back as the answer; every reader of an
 * answer (`isYes`, the sign-off and findings readers, the plan, intake and specialist readers)
 * is written against those strings. A path that answers for the person in another way (the
 * phone's Reviews tab) answers with the option it means, so the stored answer is exactly
 * what a click would have stored.
 */

/**
 * What a request's option says on its button, and what a click sends back. Options are strings;
 * rows written before U-021 hold objects (`{ choice: "approve", … }`), which `String` turned into
 * "[object Object]". Such an option shows its `label` or `choice`, capitalised; `isYes` reads
 * "Approve" as yes and "Deny" as no.
 */
export function optionLabel(option: unknown): string {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    const o = option as { label?: unknown; choice?: unknown };
    const text =
      typeof o.label === "string" ? o.label : typeof o.choice === "string" ? o.choice : "";
    if (text) return text.charAt(0).toUpperCase() + text.slice(1);
    return JSON.stringify(option);
  }
  return String(option);
}

/** An answer word the way the readers compare it: trimmed, lower case, one space between words. */
export function normalAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

/** Options that approve what a review approves: the task's work stands. */
const APPROVING = /^(approve|approved|accept|accepted|yes|ok|confirm|confirmed|apply|sign off)$/;

/**
 * Options that reject what a review rejects, best first. Sending the work back (the sign-off's
 * "revise", the findings card's "rework": the findings become the next brief's constraints) is
 * what a rejected review means; "cancel" ends the task and is never a review's reject.
 */
const REJECTING: readonly RegExp[] = [
  /^(revise|rework|redo|retry)$/,
  /^(reject|rejected)$/,
  /^(deny|denied|no|decline|declined)$/,
];

/**
 * The option a review verdict from the phone's Reviews tab answers the task's open approval
 * request with (U-027): Approve is the option that accepts the work (`accept`, `yes`,
 * `approve`), Reject the one that sends it back (`revise`, `rework`, else `reject`, `deny`,
 * `no`). The answer is the option's text as the Inbox shows it, so every reader reads it as
 * the click on that button. A request without options takes the verdict's own word ("approve"
 * reads as yes, "reject" as no). Null: no option means the verdict, so the request is left
 * open for the Inbox.
 */
export function reviewVerdictOption(
  request: Pick<HumanRequestRow, "options">,
  verdict: "approve" | "reject",
): string | null {
  const labels = request.options.map(optionLabel);
  if (labels.length === 0) return verdict;
  if (verdict === "approve") return labels.find((l) => APPROVING.test(normalAnswer(l))) ?? null;
  for (const re of REJECTING) {
    const hit = labels.find((l) => re.test(normalAnswer(l)));
    if (hit !== undefined) return hit;
  }
  return null;
}
