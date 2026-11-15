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
