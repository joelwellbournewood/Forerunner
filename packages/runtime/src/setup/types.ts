import { z } from "zod";

/**
 * The setup assistant's shapes (ADR 0092): the daemon's `/setup` routes' bodies and answers,
 * browser-safe (zod only) so the app imports them through `api-types.ts`.
 */

export const SetupCredentialsView = z.object({
  github: z.boolean(),
  anthropicApiKey: z.boolean(),
  subscription: z.boolean(),
});

export const SetupStatusView = z.object({
  /** GitHub and a model credential are stored (what `fr setup` calls complete). */
  complete: z.boolean(),
  /** The app opens the assistant: not complete, and not finished or closed before. */
  showAssistant: z.boolean(),
  name: z.string(),
  timezone: z.string(),
  credentials: SetupCredentialsView,
  /** A credential was stored after this daemon started; `finish` restarts it to use it. */
  restartNeeded: z.boolean(),
  links: z.object({ anthropicKeys: z.string(), githubToken: z.string() }),
  githubPermissions: z.array(z.string()),
});
export type SetupStatusView = z.infer<typeof SetupStatusView>;

export const SetupCheckView = z.object({
  /** The value passed its check and is stored in the vault. */
  ok: z.boolean(),
  /** `api_key`, `subscription` or `github`. */
  kind: z.string(),
  summary: z.string(),
  problems: z.array(z.string()),
  /** The GitHub account the token belongs to. */
  login: z.string().optional(),
  /**
   * The repositories a GitHub token reaches, with the access GitHub reports for each (U-051):
   * `write` is contents read and write, `read` read only, `admin` more than Forerunner needs.
   * Absent when the list could not be read (the problems say why).
   */
  repos: z
    .array(z.object({ fullName: z.string(), access: z.enum(["admin", "write", "read"]) }))
    .optional(),
  status: SetupStatusView,
});
export type SetupCheckView = z.infer<typeof SetupCheckView>;

export const SetupFinishView = z.object({
  status: SetupStatusView,
  /** The daemon restarts now so the runtime composes with the new credentials. */
  restarting: z.boolean(),
});
export type SetupFinishView = z.infer<typeof SetupFinishView>;

export const SetupProfileBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});
export type SetupProfileBody = z.infer<typeof SetupProfileBody>;

export const SetupAnthropicBody = z.object({ value: z.string().min(1).max(4096) });
export type SetupAnthropicBody = z.infer<typeof SetupAnthropicBody>;

export const SetupGitHubBody = z.object({
  token: z.string().min(1).max(4096),
  repos: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
    )
    .max(50)
    .optional(),
});
export type SetupGitHubBody = z.infer<typeof SetupGitHubBody>;

export const SETUP_ROUTES = {
  setupStatus:
    "GET /setup (SetupStatusView: which credentials the vault holds, whether the app opens the setup assistant, the name and time zone, the links to create each credential; ADR 0092)",
  setupProfile:
    "POST /setup/profile { name?, timezone? } (SetupStatusView: config.json and the human row; 400 validation for an unknown IANA time zone)",
  setupAnthropic:
    "POST /setup/anthropic { value } (SetupCheckView: an Anthropic API key checked with GET /v1/models, or a sk-ant-oat… subscription token checked for its format, as `fr setup` does; stored in the vault by name only when it passes; the value is never echoed; one setup.credential audit row with the name; 400 validation for a GitHub token)",
  setupGitHub:
    "POST /setup/github { token, repos?: owner/name[] } (SetupCheckView with the login and the repositories the token reaches with their access (GET /user, GET /user/repos; U-051): a token that reaches none or only reads is stored with a warning in the problems; each named repository's permissions, as `fr setup` does; stored only when it passes; 400 validation for an Anthropic credential or a malformed repository)",
  setupFinish:
    "POST /setup/finish (SetupFinishView: marks the assistant done in config.json; when a credential was stored since the daemon started it restarts (restart.json reason setup, exit 86) and the shell relaunches it)",
} as const;

/**
 * Settings → Claude subscription allowance (U-052; `plan-allowance-routes.ts`): the plan
 * allowance of ADR 0044, entered in CHF, stored in USD as the runtime expects.
 */
export const PlanAllowanceView = z.object({
  /** A Claude subscription token is saved: the allowance applies to it. */
  subscription: z.boolean(),
  /** USD of API-equivalent usage per month, as stored. */
  usdMonthly: z.number(),
  /** The same in CHF at `chfPerUsd`. */
  chfMonthly: z.number(),
  chfPerUsd: z.number(),
  /** Where the value in force came from: `default`, `config` (this field), `env`, ... */
  origin: z.string(),
  /** `FORERUNNER_PLAN_USD_MONTHLY` (or the composition) sets it and the field cannot. */
  overridden: z.boolean(),
  /** The share of the allowance at which subscription work stops (the row's `planShareCap`). */
  stopShare: z.number(),
});
export type PlanAllowanceView = z.infer<typeof PlanAllowanceView>;

export const PlanAllowanceBody = z.object({
  /** CHF per month: a positive amount, at most CHF 100,000. */
  chfMonthly: z.number().positive().max(100_000),
});
export type PlanAllowanceBody = z.infer<typeof PlanAllowanceBody>;

export const PLAN_ALLOWANCE_ROUTES = {
  planAllowance:
    "GET /settings/plan-allowance (PlanAllowanceView: the Claude subscription's monthly allowance in USD as stored and in CHF at the day's rate, where it comes from, whether the environment overrides it; U-052)",
  setPlanAllowance:
    "POST /settings/plan-allowance { chfMonthly } (PlanAllowanceView: converted to USD at the day's rate and stored in config.json and on the subscription billing row, in force for the next pick; 400 validation for a non-positive amount, 409 when FORERUNNER_PLAN_USD_MONTHLY decides)",
} as const;
