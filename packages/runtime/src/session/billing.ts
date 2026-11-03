import type { BillingSource, BillingSourceKind, Purpose, RouteSkip } from "@forerunner/billing";
import type { SpecialistDriver } from "../registry/tools.ts";

/**
 * Per-task billing (ADR 0044): which of the human's sources pays for one specialist run and,
 * from that, which driver runs it. The executor asks the port once per task, before the Run
 * row is written; the pick is recorded on the row (`billing_source_id`) and as an audit row
 * (`billing.pick`) with the router's reason. The wiring (`src/wiring/billing-pick.ts`)
 * implements the port over `BillingRouter.pick` from `@forerunner/billing`.
 */
export const BILLING_PICK_AUDIT_TOOL = "billing.pick";

/**
 * The session log's event when a credential met its usage limit and the next one took over, or
 * a task went back to ready for it (U-078, ADR 0100). Its `sentence` is what the log shows.
 */
export const BILLING_FALLBACK_EVENT = "billing.fallback";

export interface TaskBillingRequest {
  agentId: string;
  /** The agent's owner: a subscription is only ever used for its owner's agent (spec, Security). */
  agentOwnerHumanId: string;
  /** Where the session runs; the daemon's sessions run on the PC. */
  runner: "pc" | "cloud";
  /** The ladder tier the run starts on (a `kindsForTier` policy may exclude kinds). */
  modelTier: string;
  /** What the call is for (the policy's per-purpose kinds); default `session`. */
  purpose?: Purpose;
  /** Sources not to use for this pick: one the same call just failed on (ADR 0100). */
  exclude?: readonly string[];
  /**
   * The order to use when the person chose none (ADR 0100): the non-task calls keep ADR 0098's
   * choice, the API key when there is one. Absent: the purpose's own order, as task runs use.
   */
  fallbackOrder?: readonly BillingSourceKind[];
  /**
   * What the task needs of its credential (U-078, the owner's decision of 2026-11-02, ADR 0100
   * amended): the pick keeps the credentials that meet every hard need and lets the person's
   * order decide among them; when none meets them all, the ones that meet the most (page reading
   * before search), in the person's order. Absent: the order alone (non-task calls).
   */
  needs?: TaskNeeds;
  /**
   * "When my first choice runs out mid-session: Wait" (U-078, the default): a first choice that
   * rests after a usage limit makes the pick wait for it (`unavailable` with `waitFor`) rather
   * than move the task onto the next credential. Task runs only; the non-task calls never set it.
   */
  waitOnRest?: boolean;
}

/** Plan usage of a subscription source as the pick saw it, and what moves it. */
export interface PlanUsage {
  /** Share of the plan limit (0..1) consumed this month; null when nothing reports one. */
  share: number | null;
  /** This month's "subscription" rows for the source, API-equivalent usd_micro. */
  monthUsdMicro: number;
  /** The plan's allowance (`limits.planUsdMicro`); null when the source does not say. */
  allowanceUsdMicro: number | null;
  /** The share at which the caps stop subscription work (`limits.planShareCap` or the policy's). */
  cap: number;
}

export interface TaskBillingPick {
  source: BillingSource;
  /** "sdk" for a subscription (the Agent SDK with the OAuth token), "loop" for everything else. */
  driver: SpecialistDriver;
  reason: string;
  skipped: RouteSkip[];
  /** Set for a subscription source; null for API-style sources. */
  plan: PlanUsage | null;
}

export interface TaskBillingPort {
  pick(req: TaskBillingRequest): Promise<TaskBillingPick>;
  /**
   * The source met its provider's usage limit (`provider_usage_limit`, ADR 0100): it rests
   * until `resetAt` when that is ahead, else for an hour, and the next picks skip it
   * (`cooldown`). Returns the ISO time it rests until. Optional: a port without it never rests
   * a source.
   */
  rest?(sourceId: string, resetAt: string | undefined, why: string): Promise<string>;
  /**
   * Anthropic refused the source's credential (`provider_auth`, U-078): it is marked refused, the
   * next picks skip it until a new one is saved, and one Inbox card names it. Optional.
   */
  refuse?(sourceId: string, why: string): Promise<void>;
  /** The project's work waits for the source (its reset, a new credential; U-078). Optional. */
  noteWait?(sourceId: string, projectId: string, agentId: string): Promise<void>;
}

/** The person's setting "When my first choice runs out mid-session" (U-078). */
export type MidSessionLimit = "wait" | "use_other";

/** The setting's key in `human.notify_prefs`, and its default (owner-answers.md section 2). */
export const MID_SESSION_LIMIT_SETTING = "mid_session_limit";
export const MID_SESSION_LIMIT_DEFAULT: MidSessionLimit = "wait";

/** The stored setting, or the default for anything else. */
export function midSessionLimitOf(value: unknown): MidSessionLimit {
  return value === "use_other" ? "use_other" : MID_SESSION_LIMIT_DEFAULT;
}

/**
 * What a task needs of the credential it runs on (U-078, ADR 0100 amended): reading web pages,
 * searching the web, running commands, asking the person while it works.
 */
export type TaskNeed = "webRead" | "webSearch" | "commands" | "askPerson";

/** The needs in the order the chooser weighs them when none meets them all. */
export const TASK_NEEDS: readonly TaskNeed[] = ["webRead", "webSearch", "askPerson", "commands"];

export interface TaskNeeds {
  /** What the task cannot be done properly without: the chooser keeps credentials that meet it. */
  hard: readonly TaskNeed[];
  /** What only makes the work better: the person's order decides; the words say what is lost. */
  better: readonly TaskNeed[];
}

/** What one credential can do on this install (`capabilitiesOf`, `wiring/billing-pick.ts`). */
export type CredentialAbilities = Readonly<Record<TaskNeed, boolean>>;

/**
 * The person's setting "Code tasks that need commands" (U-078, the owner's decision of
 * 2026-11-02): `first_choice` (the default) keeps such a task on the first credential in the
 * person's order, which on a subscription cannot run commands; `api_key` makes running commands
 * a hard need, so the task goes to the API key (which costs money).
 */
export type CodeCommands = "first_choice" | "api_key";
export const CODE_COMMANDS_SETTING = "code_commands";
export const CODE_COMMANDS_DEFAULT: CodeCommands = "first_choice";

/** The stored setting, or the default for anything else. */
export function codeCommandsOf(value: unknown): CodeCommands {
  return value === "api_key" ? "api_key" : CODE_COMMANDS_DEFAULT;
}

/**
 * The plan share after `extraUsdMicro` more API-equivalent spend on the source: computed from
 * the allowance when the source has one, else the share the pick saw (a run cannot move a
 * share nobody can compute; the ledger's MAX keeps the last known value).
 */
export function planShareAfter(plan: PlanUsage, extraUsdMicro: number): number | null {
  if (plan.allowanceUsdMicro && plan.allowanceUsdMicro > 0) {
    const share = (plan.monthUsdMicro + Math.max(0, extraUsdMicro)) / plan.allowanceUsdMicro;
    // Six decimals: one millionth of the plan, so a small run still moves the share.
    return Math.round(share * 1_000_000) / 1_000_000;
  }
  return plan.share;
}
