import type { PricingTable } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
// The module path, not the package index: the index imports this package back (a cycle).
import { AUTONOMY_NAMES, type AutonomyLevel } from "@forerunner/runtime/enforcement/autonomy";
import {
  MERGE_MODE_SETTING,
  MERGE_MODE_WORDS,
  MERGE_MODES,
  mergeModeEffect,
} from "@forerunner/runtime/loop/merge-mode";
import { FAST_MODE_SETTING, fastModeEffect } from "@forerunner/runtime/models/fast-mode";
import { DEFAULT_CEILING, TIERS } from "@forerunner/runtime/models/ladder";
import { PUSH_UNFINISHED_SETTING } from "@forerunner/runtime/session/push-unfinished";
import {
  cleanSiteList,
  WEB_ACCESS_SETTING,
  webAccessNarrows,
  webAccessOf,
  webAccessWords,
} from "@forerunner/runtime/wiring/web-access";
import type { HumanRow, JsonValue, ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, Risk } from "../types.ts";
import {
  asObject,
  authorOf,
  patchHumanPrefs,
  patchProjectSettings,
  resolveProject,
} from "./shared.ts";

/**
 * settings.set: the generic key/value command behind the settings screen. Every key is in
 * SETTING_SPECS with its scope, risk and schema, so a setting changed by voice or chat goes
 * through the same validation and confirmation as the UI. Unknown keys are refused.
 */
export interface SettingSpec {
  key: string;
  label: string;
  scope: "project" | "global";
  risk: Risk;
  /**
   * The risk of one value, when it is not the key's flat `risk`: `model_watch` with
   * `allow_process_sandbox: true` is high (device confirmation), ADR 0089.
   */
  riskFor?: (value: unknown) => Risk;
  /**
   * The value `to` is the safe side of `from` (U-057): a lower default autonomy, fast mode off,
   * fewer people, a lower model ceiling, less the model watch may do. An undo that puts such a
   * value back acts at once; any other undo asks for the value's risk.
   */
  narrows?: (to: unknown, from: unknown) => boolean;
  schema: z.ZodType<JsonValue>;
  /** A column instead of the JSON bag, when the row has one. */
  column?: keyof ProjectRow | keyof HumanRow;
  description: string;
  /**
   * What the new value changes in practice, for the card's new value and the change log
   * sentence ("Set X from a to b: <effect>. Undo."), when the key's name alone does not say.
   */
  effect?: (value: JsonValue, ctx: SettingEffectContext) => string;
  /** A value in words for the card and the change log, when JSON would show (U-074). */
  display?: (value: unknown) => string;
  /**
   * 'sites': a change that `narrows` acts at once and only a widening asks a yes, judged against
   * the value in force when the change is made (new code in settings.set; before, a key's risk
   * was the same both ways and `narrows` was read only by an undo).
   */
  narrowingActsAtOnce?: boolean;
  /** The value in force for a project key, when it is not only the stored key ('sites'). */
  currentOf?: (settings: ProjectRow["settings"]) => JsonValue;
  /** Other project settings the write changes with it ('sites': the older block list moved). */
  writeAlso?: (settings: ProjectRow["settings"]) => Record<string, JsonValue | undefined>;
  /** The schema's messages are whole sentences: the refusal shows them without the key. */
  plainRefusals?: boolean;
  /**
   * Values the chat model is shown as examples in `settings_set`'s definition (W15-29), where
   * the shape alone does not say how a person's words map to it ('sites': only and never).
   */
  examples?: JsonValue[];
}

/** What an effect sentence may read besides the value: the prices in force (ADR 0057). */
export interface SettingEffectContext {
  /** The price table in force (`CommandPorts.pricingTable`); absent: the built-in table. */
  pricing?: PricingTable;
  /** CHF per USD at the day's rate (`CommandPorts.chfPerUsd`); absent: the default rate. */
  chfPerUsd?: number;
}

/**
 * The prices and the day's rate an effect sentence quotes (W15-47: fast mode's price in CHF).
 * Read only for a key with an effect; a rate that cannot be read leaves the default rate.
 */
async function effectContext(
  spec: SettingSpec,
  ctx: CommandContext,
): Promise<SettingEffectContext> {
  if (!spec.effect) return {};
  const pricing = ctx.ports.pricingTable?.();
  let chfPerUsd: number | undefined;
  try {
    chfPerUsd = await ctx.ports.chfPerUsd(ctx.clock.nowIso());
  } catch {
    chfPerUsd = undefined;
  }
  return {
    ...(pricing ? { pricing } : {}),
    ...(typeof chfPerUsd === "number" && chfPerUsd > 0 ? { chfPerUsd } : {}),
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Quiet hours as a person reads them: "12:00–18:00", "off" (design §5: never JSON). */
export function quietHoursWords(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "off";
  const o = v as Record<string, unknown>;
  return typeof o.start === "string" && typeof o.end === "string" ? `${o.start}–${o.end}` : "off";
}

/** An autonomy level by its name: "Trusted (level 3)" (design §2: autonomy by name). */
export function autonomyLevelWords(v: unknown): string {
  if (typeof v !== "number") return "not set";
  const name = AUTONOMY_NAMES[v as AutonomyLevel];
  return name ? `${name} (level ${v})` : `level ${v}`;
}

/** The rung a ceiling names, `DEFAULT_CEILING` for unset: for comparing two ceilings. */
const rungOf = (v: unknown): number =>
  TIERS.indexOf((typeof v === "string" ? v : DEFAULT_CEILING) as (typeof TIERS)[number]);

/** Every flag `to` turns on was on in `from` as well. */
function flagsWithin(to: unknown, from: unknown): boolean {
  const t = (to && typeof to === "object" ? to : {}) as Record<string, unknown>;
  const f = (from && typeof from === "object" ? from : {}) as Record<string, unknown>;
  return Object.keys(t).every((k) => t[k] !== true || f[k] === true);
}
const DAY_OF_MONTH = z.number().int().min(1).max(31);

/**
 * The monthly jobs' settings (ADR 0060). `calibration` is global (`human.notify_prefs`,
 * the runtime reads it before every scheduler tick); `handover` is per project
 * (`project.settings.handover`, off until `enabled` is true). Day and time are the human's
 * local time; the budget is the cap the hooks enforce on the run, in USD.
 */
const MonthlyJobFields = {
  enabled: z.boolean().optional(),
  day: DAY_OF_MONTH.optional(),
  time: z.string().regex(HHMM).optional(),
  budget_usd: z.number().positive().max(1000).optional(),
};
export const CalibrationSetting = z.object({
  ...MonthlyJobFields,
  tier: z.number().int().min(1).max(3).optional(),
  specialists: z.array(z.string().min(1)).optional(),
});
/**
 * The model watch's consent settings (ADR 0089), global in `human.notify_prefs.model_watch`;
 * the daemon reads them at every run. Both default off.
 */
export const ModelWatchSetting = z
  .object({
    run_evals: z.boolean().optional(),
    allow_process_sandbox: z.boolean().optional(),
  })
  .strict();
export const HandoverSetting = z.object({
  ...MonthlyJobFields,
  enabled: z.boolean(),
  seed: z
    .object({
      title: z.string().min(1).max(200),
      outcome: z.string().min(1).max(4000),
      acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
      riskTier: z.number().int().min(0).max(3),
      specialist: z.string().min(1).optional(),
      files: z.array(z.string().min(1)).min(1).max(50),
    })
    .optional(),
});

/**
 * The person's order of their Claude credentials (U-078, ADR 0100), global in
 * `human.notify_prefs.billing_order`: distinct kinds, first used first; null clears it (the
 * defaults apply). The billing router reads it at every pick.
 */
export const BillingOrderSetting = z
  .array(z.enum(["subscription", "api_key", "plan_credits"]))
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length, "each credential once")
  .nullable();

const CREDENTIAL_WORDS: Record<string, string> = {
  subscription: "the Claude subscription",
  api_key: "the API key",
  plan_credits: "the plan credits",
};

/** An order in words for the card and the change log: "the API key, then the Claude subscription". */
export function billingOrderWords(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "not chosen (the defaults)";
  return value.map((k) => CREDENTIAL_WORDS[String(k)] ?? String(k)).join(", then ");
}

/**
 * "Web pages research may read" ('sites', the owner's decision of 2026-11-02): any public website
 * (`any`, with an optional "never" list) or only the websites on a list (`only`, which may not
 * be empty). Every entry goes through the one clean-up (`cleanSiteList`): the stored value is the
 * cleaned one, and an entry it cannot take is refused in words, never dropped.
 */
export const WebAccessSetting = z
  .object({
    mode: z.enum(["any", "only"]),
    only: z.array(z.string().max(500)).max(200).optional(),
    never: z.array(z.string().max(500)).max(200).optional(),
  })
  .strict()
  .transform((v, ctx) => {
    const only = v.mode === "only" ? cleanSiteList(v.only ?? [], "only") : null;
    const never = cleanSiteList(v.never ?? [], "never");
    for (const r of [...(only?.refused ?? []), ...never.refused])
      ctx.addIssue({ code: "custom", message: `"${r.entry}" is ${r.why}.` });
    if (only && only.sites.length === 0 && only.refused.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Only these websites needs at least one website, or research would be stuck.",
      });
    return { mode: v.mode, only: only?.sites ?? [], never: never.sites };
  });

/** What a rule means for research, for the card and the change log. */
export function webAccessEffect(value: unknown): string {
  const v = webAccessOf({ [WEB_ACCESS_SETTING]: value as JsonValue });
  return v.mode === "only"
    ? "research reads only these websites and their subdomains, on the API key and on the subscription"
    : "research reads any public website except the ones listed, on the API key and on the subscription";
}

/** What flipping small-project mode (spec B.6) changes; existing tasks keep their tier. */
export const SMALL_PROJECT_MODE_EFFECT = {
  on: "new tasks default to critic tier 0 and the next plan is written as one milestone with a flat task list; existing tasks keep their tier",
  off: "new tasks default to critic tier 1 and the next plan may have several milestones; existing tasks keep their tier",
} as const;

/**
 * What each position of the speed-versus-quality slider (spec D.16) changes: every mode's
 * default effort (chat, voice, planning, the specialists, the critic) one step down or up,
 * read by the runtime from the project row at the next run, chat or voice turn and planning
 * session. An effort already at the bottom (low) or the top (max) of the scale stays there.
 */
export const SPEED_QUALITY_EFFECT = {
  speed:
    "speed, every mode's default effort one step lower (faster and cheaper) from the next run, turn or planning session",
  balanced:
    "balanced, every mode at its default effort from the next run, turn or planning session",
  quality:
    "quality, every mode's default effort one step higher (slower, more thorough) from the next run, turn or planning session",
} as const;

/** The slider's position for a value: -1 speed, +1 quality, anything else balanced. */
export function speedQualityEffect(value: JsonValue): string {
  return value === -1
    ? SPEED_QUALITY_EFFECT.speed
    : value === 1
      ? SPEED_QUALITY_EFFECT.quality
      : SPEED_QUALITY_EFFECT.balanced;
}

export const SETTING_SPECS: Record<string, SettingSpec> = {
  speed_quality_offset: {
    key: "speed_quality_offset",
    label: "the speed-versus-quality slider",
    scope: "project",
    risk: "low",
    schema: z.number().int().min(-1).max(1),
    description:
      "Shifts every mode's default effort one step per project: -1 speed, 0 balanced, +1 quality.",
    effect: speedQualityEffect,
  },
  critic_ceiling: {
    key: "critic_ceiling",
    label: "the highest model",
    scope: "project",
    risk: "medium",
    // A rung of the ladder (spec D.3); anything else would be ignored by every run.
    schema: z.enum(TIERS as unknown as [string, ...string[]]),
    narrows: (to, from) => rungOf(to) < rungOf(from),
    description:
      "Highest model rung the project's runs may use: the specialists, their retries, planning and the critic (default opus; fable only where set).",
  },
  session_reserve_share: {
    key: "session_reserve_share",
    label: "the review reserve share",
    scope: "project",
    risk: "medium",
    schema: z.number().min(0.15).max(0.25),
    description: "Share of each session budget kept for review and fixes.",
  },
  small_project_mode: {
    key: "small_project_mode",
    label: "small project mode",
    scope: "project",
    risk: "low",
    schema: z.boolean(),
    column: "small_project_mode",
    description: "One milestone, flat task list, critic tier 0 by default.",
    effect: (value) =>
      value === true ? SMALL_PROJECT_MODE_EFFECT.on : SMALL_PROJECT_MODE_EFFECT.off,
  },
  [FAST_MODE_SETTING]: {
    key: FAST_MODE_SETTING,
    label: "Opus fast mode",
    scope: "project",
    // It raises what every Opus call of the project costs: a yes before it changes.
    risk: "medium",
    schema: z.boolean(),
    narrows: (to) => to !== true,
    description:
      "Opus fast mode for urgent work (API only, priced separately): Opus runs of the project on an API key ask for the fast variant.",
    // Spec D.20, ADR 0057: the effect and the surcharge both ways, from the price table.
    // Priced from the table in force, so the card quotes the surcharge runs are charged.
    // W15-47: in CHF at the day's rate, never the provider's USD (design §5 rule 7).
    effect: (value, ctx) => fastModeEffect(value === true, ctx.pricing, ctx.chfPerUsd),
  },
  // C-57 (ADR 0106, the session lead's default): off, a repository project's docs/status.md
  // stays in the app; on, each session's status goes to the repository as one pull request.
  status_pull_request: {
    key: "status_pull_request",
    label: "the status pull request",
    scope: "project",
    risk: "low",
    schema: z.boolean(),
    narrows: (to) => to !== true,
    description:
      "A repository project's status (docs/status.md) as one pull request on GitHub, which each session adds to; off, it stays in the app.",
    effect: (value) =>
      value === true
        ? "each session's status goes to the repository as one pull request, docs: project status, which you merge when you like"
        : "each session's status stays in the app (Docs, Status); no status pull request is opened",
    display: (value) => (value === true ? "on" : "off"),
  },
  // merge-in-app (the owner's decision of 2026-11-02, ADR 0111 amended): who merges a
  // repository project's accepted work. "you" (the default): each pull request waits for the
  // person's Merge in the app; "after_review": Forerunner merges it once the critic accepted it.
  // Separate from the autonomy level, which frees no merge. Turning it on asks a yes, with
  // what it means; turning it off acts at once.
  [MERGE_MODE_SETTING]: {
    key: MERGE_MODE_SETTING,
    label: "who merges accepted work",
    scope: "project",
    risk: "medium",
    schema: z.enum(MERGE_MODES),
    narrows: (to) => to !== "after_review",
    description:
      "Who merges a repository project's accepted work: you (each pull request waits for your Merge on the Overview; the default) or after_review (Forerunner merges it once the critic accepted it).",
    display: (value) => MERGE_MODE_WORDS[value === "after_review" ? "after_review" : "you"],
    effect: (value) => mergeModeEffect(value === "after_review" ? "after_review" : "you"),
  },
  // budget-resume (the owner's decision of 2026-11-02, ADR 0112 amended): off (the default), a
  // paused task's work in progress stays on this computer, on its branch; on, it is pushed to
  // that branch on GitHub too (where it starts the repository's automatic checks and co-workers
  // see it). Never a Local only file: the push guard refuses one, as for every push.
  [PUSH_UNFINISHED_SETTING]: {
    key: PUSH_UNFINISHED_SETTING,
    label: "pushing unfinished work to GitHub",
    scope: "project",
    risk: "low",
    schema: z.boolean(),
    narrows: (to) => to !== true,
    description:
      "A paused task's work in progress, pushed to its branch on GitHub too (off: it stays on this computer until the task is done).",
    effect: (value) =>
      value === true
        ? "a paused task's work in progress is pushed to its branch on GitHub too, where it starts the repository's checks and others see it"
        : "a paused task's work in progress stays on this computer until the task is done",
    display: (value) => (value === true ? "on" : "off"),
  },
  // 'sites' (the owner's decision of 2026-11-02, ADR 0107 amended): "Web pages research may
  // read", the same on both credentials. Widening it asks a yes; narrowing it acts at once. The
  // value in force includes the blocks still under `browser.blockedDomains` (written before this
  // setting), and writing it takes them into this one list.
  [WEB_ACCESS_SETTING]: {
    key: WEB_ACCESS_SETTING,
    label: "web pages research may read",
    scope: "project",
    risk: "medium",
    narrowingActsAtOnce: true,
    plainRefusals: true,
    schema: WebAccessSetting as unknown as z.ZodType<JsonValue>,
    narrows: webAccessNarrows,
    currentOf: (settings) => webAccessOf(settings) as unknown as JsonValue,
    writeAlso: (settings) => {
      const b = settings.browser;
      if (!b || typeof b !== "object" || Array.isArray(b)) return {};
      const browser = { ...(b as Record<string, JsonValue>) };
      if (!("blockedDomains" in browser) && !("blocked_domains" in browser)) return {};
      delete browser.blockedDomains;
      delete browser.blocked_domains;
      return { browser: Object.keys(browser).length ? browser : undefined };
    },
    description:
      "What research reads on the web: mode any (any public website, except the never list) or only (only the websites on the only list); each entry covers the site and its subdomains. Never this computer or the local network.",
    display: webAccessWords,
    effect: (value) => webAccessEffect(value),
    examples: [
      { mode: "only", only: ["developer.mozilla.org"] },
      { mode: "any", never: ["facebook.com"] },
      { mode: "any" },
    ],
  },
  shared_with: {
    key: "shared_with",
    label: "who the project is shared with",
    scope: "project",
    risk: "high",
    schema: z.array(z.string()),
    narrows: (to, from) =>
      (Array.isArray(to) ? to : []).every((id) => Array.isArray(from) && from.includes(id)),
    description: "Human ids that see the project's data and change sentences.",
  },
  billing_order: {
    key: "billing_order",
    label: "which Claude credential is used first",
    scope: "global",
    // Low risk (ADR 0100): it changes which of the person's own credentials pays first, never
    // a cap; Settings -> Claude: which to use first sets it without a card, and Undo puts the
    // previous order back.
    risk: "low",
    schema: BillingOrderSetting as unknown as z.ZodType<JsonValue>,
    description:
      "The person's Claude credentials in the order every model call uses them (subscription, api_key, plan_credits); when one cannot be used, the next one is. null: the defaults.",
    display: billingOrderWords,
    effect: () =>
      "every model call uses them in this order, and when one cannot be used the next one is",
  },
  // U-078 (the owner's decision of 2026-11-02, owner-answers.md section 2): when the first
  // credential reaches its usage limit during a session, its tasks wait for the reset and start
  // by themselves (the default), or go on at once on the next credential, which moves work from
  // plan limits onto money (a yes first). Task runs only: chat, planning and reviews always use
  // the next one (ADR 0100 point 4).
  mid_session_limit: {
    key: "mid_session_limit",
    label: "what tasks do when your first Claude credential runs out mid-session",
    scope: "global",
    risk: "medium",
    schema: z.enum(["wait", "use_other"]),
    narrows: (to) => to !== "use_other",
    description:
      "When the first Claude credential reaches its usage limit during a session: wait (its tasks wait for the reset and start by themselves) or use_other (they go on at once on the next one, which may cost money). Task runs only; chat, planning and reviews always use the next one.",
    display: (value) => (value === "use_other" ? "use the other one" : "wait"),
    effect: (value) =>
      value === "use_other"
        ? "a task whose first credential runs out goes on at once on the next one, which may cost money"
        : "a task whose first credential runs out waits for its reset and starts by itself",
  },
  // U-078 (the owner's decision of 2026-11-02, the credential chooser): a code task that needs
  // commands stays on the first credential in the person's order (the default; on a Claude
  // subscription it cannot run commands, so its own tests do not run), or goes to the API key,
  // which can run them in the sandbox and costs money (a yes first).
  code_commands: {
    key: "code_commands",
    label: "where code tasks that need commands run",
    scope: "global",
    risk: "medium",
    schema: z.enum(["first_choice", "api_key"]),
    narrows: (to) => to !== "api_key",
    description:
      "Code tasks that need commands (their tests): first_choice (your first Claude credential anyway; on a subscription they cannot run commands, so their tests do not run there) or api_key (the API key, which runs them in the sandbox and costs money).",
    display: (value) => (value === "api_key" ? "the API key" : "my first choice anyway"),
    effect: (value) =>
      value === "api_key"
        ? "code tasks that need commands run on the API key, which costs money"
        : "code tasks that need commands run on your first Claude credential; on a subscription their tests do not run",
  },
  quiet_hours: {
    key: "quiet_hours",
    label: "quiet hours",
    scope: "global",
    risk: "low",
    // null turns quiet hours off (the notification settings read null as "none").
    schema: z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }).nullable(),
    description:
      "No notifications and no non-manual session starts between start and end (local time).",
    display: quietHoursWords,
    examples: [{ start: "22:00", end: "07:00" }, null],
  },
  notify_channel: {
    key: "notify_channel",
    label: "the notification channel",
    scope: "global",
    risk: "low",
    schema: z.enum(["desktop", "email", "telegram", "signal", "push"]),
    description: "Where notifications go.",
  },
  voice_alerts: {
    key: "voice_alerts",
    label: "voice alerts",
    scope: "global",
    risk: "low",
    schema: z.boolean(),
    description:
      "Speak urgent notifications aloud through the voice provider while the desktop app is open, outside quiet hours (ADR 0063).",
  },
  default_autonomy: {
    key: "default_autonomy",
    label: "the default autonomy for new projects",
    scope: "global",
    risk: "medium",
    schema: z.number().int().min(0).max(4),
    narrows: (to, from) => typeof to === "number" && typeof from === "number" && to < from,
    column: "default_autonomy",
    description: "Autonomy level new projects start with.",
    display: autonomyLevelWords,
  },
  language: {
    key: "language",
    label: "the language",
    scope: "global",
    risk: "low",
    schema: z.enum(["en", "de"]),
    column: "locale",
    description: "UI and voice language.",
  },
  calibration: {
    key: "calibration",
    label: "the monthly critic calibration",
    scope: "global",
    risk: "medium",
    schema: CalibrationSetting as unknown as z.ZodType<JsonValue>,
    // Off spends nothing: an undo that turns the monthly run off acts at once.
    narrows: (to) => (to as { enabled?: unknown } | null)?.enabled === false,
    description:
      "Monthly critic calibration over the golden eval sets: enabled (default on), day of month, local time, budget_usd cap, tier, specialists.",
    display: calibrationWords,
    effect: (value) => {
      const v = (value ?? {}) as { enabled?: boolean; day?: number; time?: string };
      return v.enabled === false
        ? "the critic is no longer graded against the eval sets each month"
        : // W15-46: the value in words names the schedule ("on, day 1 at 06:00"); said once.
          "each month the critic grades the eval sets";
    },
  },
  model_watch: {
    key: "model_watch",
    label: "the model watch evals",
    scope: "global",
    risk: "medium",
    // Letting eval commands run without a container is a weaker sandbox: the device confirms.
    riskFor: (value) =>
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).allow_process_sandbox === true
        ? "high"
        : "medium",
    schema: ModelWatchSetting as unknown as z.ZodType<JsonValue>,
    narrows: flagsWithin,
    description:
      "Model watch (ADR 0089): run_evals runs the paid eval sets on every weekly run without asking (default off); allow_process_sandbox lets eval tasks run commands in the process stand-in when no container engine exists (default off).",
    display: modelWatchWords,
    effect: (value) => {
      const v = (value ?? {}) as { run_evals?: boolean; allow_process_sandbox?: boolean };
      const evals = v.run_evals
        ? "the model watch runs its eval sets every week without asking; the spend counts against your caps"
        : "the model watch checks models and prices only and asks before any paid eval";
      return v.allow_process_sandbox
        ? `${evals}, and eval commands may run in the process sandbox when no container engine exists`
        : evals;
    },
  },
  handover: {
    key: "handover",
    label: "the monthly handover test",
    scope: "project",
    risk: "medium",
    schema: HandoverSetting as unknown as z.ZodType<JsonValue>,
    // Unset or off runs nothing (the test is off until enabled).
    narrows: (to) => (to as { enabled?: unknown } | null)?.enabled !== true,
    description:
      "Monthly handover test on the project: a fresh agent with only the repo and docs makes a seeded change; where it got stuck becomes a docs task. enabled, day, time, budget_usd, seed.",
    display: handoverWords,
    effect: (value) => {
      const v = (value ?? {}) as { enabled?: boolean; day?: number; time?: string };
      return v.enabled
        ? // W15-46: the value in words names the schedule ("on, day 2 at 08:00"); said once.
          "each month a fresh agent runs the seeded change and its stuck places become a docs task"
        : "no monthly handover test runs on the project";
    },
  },
};

/** The risk of setting `value` on the key: its `riskFor` when it has one, else its `risk`. */
export function settingRisk(spec: SettingSpec, value: unknown): Risk {
  return spec.riskFor ? spec.riskFor(value) : spec.risk;
}

/** Own keys only: "constructor" or "__proto__" are unknown settings, not prototype lookups. */
export function settingSpec(key: string): SettingSpec {
  const spec = Object.hasOwn(SETTING_SPECS, key) ? SETTING_SPECS[key] : undefined;
  if (!spec) {
    throw new ForerunnerError("validation", `unknown setting ${key}`, {
      details: { key, known: Object.keys(SETTING_SPECS) },
    });
  }
  return spec;
}

/** One JSON Schema node, as `z.toJSONSchema` writes it. */
type SchemaNode = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

/**
 * A value's shape in one short line for the chat model (W15-29): `{"mode": "any" | "only",
 * "only"?: [string]}`, `integer from -1 to 1`, `"HH:MM"`. Before, `settings_set` reached the
 * model as `{"key": string, "value": {}}` with the key names alone, and the live model sent
 * "public", then {allowed: "public_websites"}, then "any" for web_access and gave up.
 */
function shapeOf(node: SchemaNode): string {
  if (node.anyOf) return node.anyOf.map(shapeOf).join(" | ");
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (node.const !== undefined) return JSON.stringify(node.const);
  switch (node.type) {
    case "object": {
      const required = new Set(node.required ?? []);
      const fields = Object.entries(node.properties ?? {}).map(
        ([k, v]) => `"${k}"${required.has(k) ? "" : "?"}: ${shapeOf(v)}`,
      );
      return `{${fields.join(", ")}}`;
    }
    case "array":
      return `[${node.items ? shapeOf(node.items) : "any"}]`;
    case "string":
      return node.pattern === HHMM.source ? '"HH:MM"' : "string";
    case "integer":
    case "number": {
      const range =
        node.minimum !== undefined && node.maximum !== undefined
          ? ` from ${node.minimum} to ${node.maximum}`
          : "";
      return `${node.type}${range}`;
    }
    case "boolean":
      return "true | false";
    case "null":
      return "null";
    default:
      return "any JSON value";
  }
}

/**
 * The shape a key's value takes. The input side of the schema: the site rule's transform cleans
 * the lists after parsing, and the default (output) side cannot be written as JSON Schema.
 */
export function settingValueShape(spec: SettingSpec): string {
  return shapeOf(z.toJSONSchema(spec.schema, { io: "input" }) as SchemaNode);
}

/** A key's line in `settings_set`'s definition: scope, what it does, its value's shape, examples. */
export function settingDefinitionLine(spec: SettingSpec): string {
  const examples = spec.examples?.length
    ? ` For example ${spec.examples.map((e) => JSON.stringify(e)).join(" or ")}.`
    : "";
  const scope = spec.scope === "project" ? "per project" : "for the person";
  return `- ${spec.key} (${scope}): ${spec.description} Value: ${settingValueShape(spec)}.${examples}`;
}

/**
 * `settings_set`'s definition for the chat model: what a setting is (a rule the app enforces,
 * never a lesson), then every key with its value's shape (W15-29).
 */
export function settingsSetDescription(): string {
  return [
    "Change a setting by key: a rule the app enforces, such as what research may read on the web (web_access), who merges accepted work, fast mode or quiet hours. Such a rule is a setting: change it here, never record it as a lesson instead (a lesson changes no setting). value takes the shape given for its key. A change that narrows what the app may do acts at once; one that widens it waits for the person's yes. Keys:",
    ...Object.values(SETTING_SPECS).map(settingDefinitionLine),
  ].join("\n");
}

const params = z.object({
  key: z.string().min(1).describe("The setting's key, one of those the description lists."),
  value: z
    .unknown()
    .describe(
      "The new value, in the shape the description gives for the key (an object, a list, a number, true or false, a string or null).",
    ),
  project: z
    .string()
    .optional()
    .describe("For a per-project key: the project's name; without it, the active project."),
});
export type SettingsSetParams = z.infer<typeof params>;

/**
 * A value in words when its key has none of its own: never JSON (later #30: "from unset to
 * {"enabled":false,…}"). An object reads as its fields ("enabled: false, day: 1").
 */
function show(v: unknown): string {
  if (v === undefined || v === null) return "unset";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length ? v.map(show).join(", ") : "none";
  if (typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k.replace(/_/g, " ")}: ${show(x)}`)
      .join(", ");
  return String(v);
}

/** The monthly critic calibration in words (later #30): "off", "on, day 1 at 06:00". */
export function calibrationWords(value: unknown): string {
  if (value === undefined || value === null) return "on, day 1 at 06:00 (the default)";
  const v = value as { enabled?: unknown; day?: unknown; time?: unknown };
  if (v.enabled === false) return "off";
  return `on, day ${typeof v.day === "number" ? v.day : 1} at ${typeof v.time === "string" ? v.time : "06:00"}`;
}

/** The monthly handover test in words: "off" (unset is off), "on, day 2 at 08:00". */
export function handoverWords(value: unknown): string {
  const v = (value ?? {}) as { enabled?: unknown; day?: unknown; time?: unknown };
  if (v.enabled !== true) return "off";
  return `on, day ${typeof v.day === "number" ? v.day : 1} at ${typeof v.time === "string" ? v.time : "07:00"}`;
}

/** The model watch's two switches in words (later #99). */
export function modelWatchWords(value: unknown): string {
  const v = (value ?? {}) as { run_evals?: unknown; allow_process_sandbox?: unknown };
  return `${v.run_evals === true ? "runs the paid evaluations without asking" : "asks before any paid evaluation"}; ${
    v.allow_process_sandbox === true
      ? "evaluations may run without a container"
      : "evaluations need a container"
  }`;
}

/**
 * A value the key's schema refused, in words the chat model can act on (W15-29). A key whose
 * messages are whole sentences ('sites': '"10.0.0.1" is this computer or the local network.')
 * keeps them; a value of the wrong shape ("public", {allowed: …}) names each field that was
 * wrong and the shape the key takes, with an example. Before, web_access answered "Invalid
 * input: expected object, received string" and the live model never found `mode`.
 */
function refusalOf(spec: SettingSpec, issues: readonly z.core.$ZodIssue[]): ForerunnerError {
  const fieldOf = (i: z.core.$ZodIssue) => (i.path.length ? `${i.path.join(".")}: ` : "");
  if (!spec.plainRefusals)
    return new ForerunnerError(
      "validation",
      `${spec.key}: ${issues.map((i) => `${fieldOf(i)}${i.message}`).join("; ")}`,
      { details: { key: spec.key } },
    );
  if (issues.every((i) => i.code === "custom"))
    return new ForerunnerError("validation", issues.map((i) => i.message).join(" "), {
      details: { key: spec.key },
    });
  const wrong = issues.map((i) => `${fieldOf(i)}${i.message.replace(/[.\s]+$/, "")}`).join("; ");
  const example = spec.examples?.[0];
  return new ForerunnerError(
    "validation",
    `That is not a value for ${spec.label} (${wrong}). It takes ${settingValueShape(spec)}${
      example !== undefined ? `, for example ${JSON.stringify(example)}` : ""
    }.`,
    { details: { key: spec.key, shape: settingValueShape(spec) } },
  );
}

interface Target {
  spec: SettingSpec;
  value: JsonValue;
  project: ProjectRow | null;
  usedActive: boolean;
  human: HumanRow;
  current: JsonValue | null;
  what: string;
  /** The key's effect sentence for this value, when the key defines one. */
  effect: string | undefined;
}

async function target(p: SettingsSetParams, ctx: CommandContext): Promise<Target> {
  const spec = settingSpec(p.key);
  const parsed = spec.schema.safeParse(p.value);
  if (!parsed.success) throw refusalOf(spec, parsed.error.issues);
  const human = await ctx.store.human.mustGet(ctx.humanId);
  const effect = spec.effect?.(parsed.data, await effectContext(spec, ctx));
  if (spec.scope === "project") {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    const current = spec.column
      ? ((project[spec.column as keyof ProjectRow] as JsonValue | undefined) ?? null)
      : spec.currentOf
        ? spec.currentOf(project.settings)
        : (project.settings[spec.key] ?? null);
    return {
      spec,
      value: parsed.data,
      project,
      usedActive,
      human,
      current,
      what: `${spec.label} for ${project.name}`,
      effect,
    };
  }
  const current = spec.column
    ? ((human[spec.column as keyof HumanRow] as JsonValue | undefined) ?? null)
    : (human.notify_prefs[spec.key] ?? null);
  return {
    spec,
    value: parsed.data,
    project: null,
    usedActive: false,
    human,
    current,
    what: spec.label,
    effect,
  };
}

/** A value as the card and the change log say it: the key's own words when it has them. */
const showFor = (spec: SettingSpec, v: unknown): string =>
  spec.display ? spec.display(v) : show(v);

function sentenceOf(t: Target): string {
  const { effect } = t;
  return `Set ${t.what} from ${showFor(t.spec, t.current)} to ${showFor(t.spec, t.value)}${effect ? `: ${effect}` : ""}. Undo.`;
}

/** The same value in JSON terms (key order aside): a change from it to it changes nothing. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, x]) => [k, norm(x)]),
        )
      : Array.isArray(v)
        ? v.map(norm)
        : (v ?? null);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * A change to the value already set is refused in words (design §5; the walks: "Set the
 * default autonomy for new projects from 3 to 3." was accepted and logged in Changes).
 */
function refuseNoChange(t: Target): void {
  if (!sameValue(t.current, t.value)) return;
  const what = t.what.charAt(0).toUpperCase() + t.what.slice(1);
  throw new ForerunnerError("validation", `${what} is already ${showFor(t.spec, t.current)}.`, {
    details: { key: t.spec.key, unchanged: true },
  });
}

/**
 * The card's new value is the value in words, never with its effect (P7-10: "Who merges
 * accepted work" showed the label plus the whole 290-character effect in its monospace value).
 * The effect is the card's sentence: the change log's ("Set X from a to b: <effect>.") and the
 * read-back's second sentence (`askOf`), which the Inbox shows as the card's body.
 */
function newValueOf(t: Target): string {
  return showFor(t.spec, t.value);
}

/** "Set X to b? <Effect>." (design §3.9: the question, then what it changes). */
function askOf(t: Target): string {
  const q = `Set ${t.what} to ${showFor(t.spec, t.value)}?`;
  const e = t.effect?.trim().replace(/\.$/, "");
  return e ? `${q} ${e.charAt(0).toUpperCase()}${e.slice(1)}.` : q;
}

async function write(
  ctx: CommandContext,
  spec: SettingSpec,
  projectId: string | null,
  value: JsonValue | null,
) {
  const author = authorOf(ctx);
  if (spec.scope === "project") {
    const id = projectId as string;
    if (spec.column) {
      const project = await ctx.store.project.mustGet(id);
      await ctx.store.project.update(id, project.version, {
        [spec.column]: value,
        ...author,
      } as never);
    } else {
      const also = spec.writeAlso
        ? spec.writeAlso((await ctx.store.project.mustGet(id)).settings)
        : {};
      await patchProjectSettings(ctx.store, id, { ...also, [spec.key]: value }, author);
    }
    return;
  }
  if (spec.column) {
    await patchHumanPrefs(ctx.store, ctx.humanId, {}, { [spec.column]: value, ...author } as never);
  } else {
    await patchHumanPrefs(ctx.store, ctx.humanId, { [spec.key]: value }, author);
  }
}

export const settingsSet: CommandDef<SettingsSetParams> = {
  name: "settings.set",
  // W15-29: each key with its value's shape, so the chat model can fill `value` (before: the key
  // names alone, and `value` reached the model as `{}`).
  description: settingsSetDescription(),
  params,
  // 'sites': a key whose narrowing acts at once is judged against the value in force now.
  risk: async (p, ctx) => {
    const spec = settingSpec(p.key);
    if (spec.narrowingActsAtOnce && spec.narrows) {
      const t = await target(p, ctx).catch(() => null);
      if (t && spec.narrows(t.value, t.current)) return "low";
    }
    return settingRisk(spec, p.value);
  },
  maxRisk: "high",
  scope: (p) =>
    Object.hasOwn(SETTING_SPECS, p.key) && SETTING_SPECS[p.key]?.scope === "global"
      ? "global"
      : "project",
  reversible: true,
  undoStrategy: "restore the previous value from the change log",
  async plan(p, ctx) {
    const t = await target(p, ctx);
    refuseNoChange(t);
    return buildCard({
      command: "settings.set",
      what: t.what,
      oldValue: showFor(t.spec, t.current),
      newValue: newValueOf(t),
      scope: t.spec.scope === "global" ? "global" : "project",
      risk: settingRisk(t.spec, t.value),
      sentence: sentenceOf(t),
      reversible: true,
      projectId: t.project?.id ?? null,
      projectName: t.project?.name ?? null,
      usesActiveProject: t.usedActive,
      // The read-back (design §3.9, §5): "Set quiet hours to 12:00–18:00?", then what it
      // changes when the key says (P7-10).
      ask: askOf(t),
    });
  },
  async run(p, ctx) {
    const t = await target(p, ctx);
    refuseNoChange(t);
    await write(ctx, t.spec, t.project?.id ?? null, t.value);
    return {
      before: { key: t.spec.key, project_id: t.project?.id ?? null, value: t.current },
      after: { key: t.spec.key, project_id: t.project?.id ?? null, value: t.value },
      sentence: sentenceOf(t),
      projectId: t.project?.id ?? null,
    };
  },
  // U-057: the value the undo puts back asks for what setting it would (process sandbox for
  // the evals: the paired device; a medium key: a yes); the safe side (`narrows`) acts at once.
  async undoRisk(_p, before, after) {
    const b = asObject(before);
    if (typeof b.key !== "string" || !Object.hasOwn(SETTING_SPECS, b.key)) return "low";
    const spec = settingSpec(b.key);
    const restored = b.value ?? null;
    if (spec.narrows?.(restored, asObject(after).value ?? null)) return "low";
    return settingRisk(spec, restored);
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.key !== "string") return;
    const spec = settingSpec(b.key);
    await write(ctx, spec, typeof b.project_id === "string" ? b.project_id : null, b.value ?? null);
  },
  // W15-34: an undo that waits for a yes asks as the change would ("Put web pages research may
  // read for Reading rules back to any public website? Research reads …"), from the row alone.
  async undoAsk(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.key !== "string" || !Object.hasOwn(SETTING_SPECS, b.key)) return null;
    const spec = settingSpec(b.key);
    const restored = (b.value ?? null) as JsonValue;
    const project =
      spec.scope === "project" && typeof b.project_id === "string"
        ? await ctx.store.project.get(b.project_id)
        : undefined;
    const what = project ? `${spec.label} for ${project.name}` : spec.label;
    const effect = spec
      .effect?.(restored, await effectContext(spec, ctx))
      ?.trim()
      .replace(/\.$/, "");
    const q = `Put ${what} back to ${showFor(spec, restored)}?`;
    return effect ? `${q} ${effect.charAt(0).toUpperCase()}${effect.slice(1)}.` : q;
  },
};
