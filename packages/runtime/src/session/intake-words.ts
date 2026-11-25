/**
 * Sentences of the intake that the UI's fake daemon says too (it must not load the intake
 * itself). d1109-onerepo-link (OR-08).
 */

/**
 * A new brief (the New project offer's Add to it, D1) while the project's plan waits in the
 * Inbox: the project by its name and what to do, never the request's id.
 */
export function openPlanSentence(projectName: string): string {
  return `A plan for "${projectName}" waits for your answer. Answer it first.`;
}

/**
 * w8-together (L4i-left-48): a new brief while the project's plan is still being drafted in the
 * background (Add to it answered at once): the same 409 as an open plan, in words that are true.
 */
export function draftingPlanSentence(projectName: string): string {
  return `A plan for "${projectName}" is being drafted; answer it once it waits in your Inbox.`;
}

/**
 * w8-together fix-up (review blocking 3): a plan drafted in the background (Add to it, a new
 * project's plan, Try again) that a Quit cut off. After the restart the project page says it
 * ("Planning failed: Forerunner closed before ...") with Try again, which drafts it from the same
 * brief; before, the page said nothing and the brief was gone.
 */
export const DRAFT_LOST_WORDS = "Forerunner closed before the plan from your brief was drafted.";
