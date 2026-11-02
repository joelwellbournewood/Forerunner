import type { ReviewTier } from "@forerunner/critic";

/**
 * Proportional verification of a task's work (ADR 0104, the owner's decision of 2026-11-01).
 * The rules every place that decides or says how work is checked shares: the runner (which
 * tasks go to the critic), the critic loop (the review level, the criterion of a task that
 * names none) and the specialist's brief (what it is told about the check).
 *
 * 1. The project's own build, lint and tests run for every code task, at every review level,
 *    and are never shown to the person as a level (`project-checks.ts`).
 * 2. The critic reviews every task an agent finished, with read access to the task's folder;
 *    a planner's tier 0 is reviewed as the light review (`reviewTierOf`).
 * 3. Work a person will use is also tried as a person would use it (`try-it.ts`): a page is
 *    opened in a headless browser and what a person would see is evidence.
 * 4. Deploys and data migrations keep the full review and the person's sign-off: a specialist's
 *    `risk_tier_floor` in the registry raises the review level (`reviewTierOf`).
 * 5. The person sees "Done" only after the right check, with "Reviewed" or "Reviewed and
 *    tried" and the evidence in the task drawer (`daemon/task-display.ts`).
 */

/**
 * The review level a task gets: its risk tier, never below the light review (no task closes on
 * the specialist's own word) and never below its specialist's floor (`floor`, the registry's
 * `risk_tier_floor`: a deploy or a migration keeps the full review). Tier 3 ends with the
 * person's sign-off.
 */
export function reviewTierOf(riskTier: number, floor = 0): ReviewTier {
  const tier = Math.max(1, Math.round(riskTier), Math.round(floor));
  return Math.min(3, tier) as ReviewTier;
}

/**
 * Specialists whose work is a deploy or a data migration (the owner's decision 4): the review
 * ends with the person's sign-off whatever the task's tier says.
 */
export const SIGNOFF_SPECIALISTS: ReadonlySet<string> = new Set([
  "ops-deploy",
  "migration-specialist",
]);

/**
 * The review level floor of a task's specialist: its registry `risk_tier_floor`, and the
 * sign-off (3) for a deploy or a migration. 0 when the specialist is unknown.
 */
export function reviewFloorOf(
  specialist: string | null | undefined,
  registryFloor?: (name: string) => number | undefined,
): number {
  if (!specialist) return 0;
  if (SIGNOFF_SPECIALISTS.has(specialist)) return 3;
  return registryFloor?.(specialist) ?? 0;
}

/**
 * The criterion of a task that names none (live, 2026-11-01: a task added in chat had "The
 * outcome described in the goal is achieved and verified.", which the critic marked met though
 * nothing was verified): the outcome itself, to be shown by the work, not by the report.
 */
export function outcomeCriterion(outcome: string): string {
  const o = outcome.trim().replace(/\s+/g, " ");
  return o
    ? `The work itself shows this outcome (a file, a page or an output, not only the report): ${o.slice(0, 400)}`
    : "The work itself shows what the task's title asks for (a file, a page or an output, not only the report).";
}

/**
 * What the specialist's brief says about how its work is checked (ADR 0104): true for every
 * task the daemon runs, since the critic reviews every one (live, 2026-11-01: the brief said
 * "the critic checks each" while tier 0 had no critic at all).
 */
export const HOW_WORK_IS_CHECKED =
  "How your work is checked: after your run Forerunner runs the project's own build, lint and tests (its package.json scripts), opens a page you made or changed in a browser, and the critic reads your work and the project's files against each acceptance criterion. Nothing is done on your word alone.";

/** What the brief asks of a code change that adds behaviour (the owner's decision 1). */
export const TESTS_FOR_BEHAVIOUR =
  "If you add behaviour to code (a function, a command, a route, logic in a script), add a test that runs it and say how to run it, unless the brief leaves the tests to another task.";
