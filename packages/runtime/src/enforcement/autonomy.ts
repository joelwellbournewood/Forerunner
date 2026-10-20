/**
 * Autonomy levels (spec J) and the actions they allow. The table is data; the decision is code.
 * "Always needs a human" actions (spec Security) are forbidden to act on without approval at every
 * level, including 4.
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export type ActionClass =
  | "read" // reading files, state, docs, web pages inside the allowlist
  | "routine_reversible" // edits in a worktree, running tests, opening a PR, comments, notes, drafts
  | "non_routine" // creating or editing tasks and docs outside the worktree, sending a message to a peer, costly session start
  | "merge_pr" // merging a reviewed PR
  | "deploy_staging"
  | "deploy_production"
  | "external_send" // sending email to an allowlisted recipient, posting to third parties
  | "destructive" // deleting repos or data, force-pushing to main
  | "financial" // spending real money, purchases, sending money
  | "credential" // sharing secrets, entering passwords on third-party sites
  | "permission_change" // changing permissions, autonomy, caps above ceiling
  | "capability_grant"; // granting a new capability or connector

export type AutonomyDecision = "allow" | "approval_required" | "forbidden";

export const ALWAYS_HUMAN: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "destructive",
  "financial",
  "credential",
  "permission_change",
  "capability_grant",
]);

/** Minimum autonomy level at which the class is free of per-action approval. */
const FREE_AT: Record<
  Exclude<
    ActionClass,
    "destructive" | "financial" | "credential" | "permission_change" | "capability_grant"
  >,
  AutonomyLevel | null
> = {
  read: 0,
  routine_reversible: 2,
  non_routine: 3,
  merge_pr: 3,
  deploy_staging: 3,
  deploy_production: 4,
  external_send: 4,
};

export interface AutonomyContext {
  level: AutonomyLevel;
  /** Level 1 acts after approval of each plan; once a plan is approved its routine actions run. */
  planApproved?: boolean;
  /** A human already approved this specific action (e.g. an answered HumanRequest). */
  actionApproved?: boolean;
}

export function decideAutonomy(action: ActionClass, ctx: AutonomyContext): AutonomyDecision {
  if (ALWAYS_HUMAN.has(action)) {
    return ctx.actionApproved ? "allow" : "approval_required";
  }
  if (ctx.actionApproved) return "allow";
  if (action === "read") return "allow";
  if (ctx.level === 0) {
    // Advisor: plans and proposes only. Nothing that changes state runs.
    return "approval_required";
  }
  if (ctx.level === 1) {
    // Assisted: routine actions run once the plan is approved; everything else asks.
    if (action === "routine_reversible") return ctx.planApproved ? "allow" : "approval_required";
    return "approval_required";
  }
  const free = FREE_AT[action as keyof typeof FREE_AT];
  if (free === null || free === undefined) return "approval_required";
  return ctx.level >= free ? "allow" : "approval_required";
}

export function isValidAutonomyLevel(n: unknown): n is AutonomyLevel {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4;
}

export const AUTONOMY_NAMES: Record<AutonomyLevel, string> = {
  0: "Advisor",
  1: "Assisted",
  2: "Standard",
  3: "Trusted",
  4: "Autopilot",
};
