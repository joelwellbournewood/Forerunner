import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppDirs, appDirs, ForerunnerError, join, log, osFacts } from "@forerunner/platform";
import type { Vault } from "@forerunner/vault";
import {
  currentInstallRecord,
  INSTALL_RECORD_FILE,
  type InstallRecord,
  writeInstallRecord,
} from "./install-record.ts";
import {
  assertPlanUsdMonthly,
  DEFAULT_PLAN_USD_MONTHLY,
  describePlanAllowance,
  PLAN_USD_MONTHLY_ENV,
  type PlanAllowance,
  parsePlanUsdMonthly,
  resolvePlanAllowance,
} from "./plan-allowance.ts";
import {
  assertCredentialKind,
  CREDENTIAL_REQUESTS,
  type ValidationResult,
  validateAnthropicKey,
  validateGitHubToken,
  validateSubscriptionTokenFormat,
} from "./validators.ts";

/**
 * Guided setup (spec A, phase 0): creates the app directories, validates each credential as
 * it is pasted, stores it in the vault by name, and writes a config file that never holds a
 * secret. Non-interactive mode takes values from flags or FORERUNNER_* environment variables
 * and is what the scripted fresh-install uses.
 */
export const SECRET_NAMES = {
  github: "github_token",
  anthropic: "anthropic_api_key",
  anthropicOauth: "anthropic_subscription_token",
} as const;

export {
  DEFAULT_PLAN_USD_MONTHLY,
  describePlanAllowance,
  PLAN_USD_MONTHLY_ENV,
  type PlanAllowance,
  type PlanAllowanceOrigin,
  parsePlanUsdMonthly,
  resolvePlanAllowance,
} from "./plan-allowance.ts";

export interface SetupConfig {
  version: 1;
  profile: string;
  humanName?: string;
  /**
   * The human this install binds to on a shared store (ADR 0082). `humanId`: from
   * `fr setup --human-id`, or recorded by the daemon at its first bind so a later email change
   * never rebinds the install. `humanEmail`: from `fr setup --email`, lower case; finds the
   * human by email or names the one created at first start. `FORERUNNER_HUMAN` (an id or an
   * email) overrides both for one start. Neither is a secret.
   */
  humanId?: string;
  humanEmail?: string;
  timezone: string;
  githubApiBase: string;
  anthropicApiBase: string;
  /** Sent as anthropic-workspace-id with every request; required for user-scoped keys. Not a secret. */
  anthropicWorkspaceId?: string;
  repos: string[];
  credentials: { github: boolean; anthropic: boolean; anthropicSubscription: boolean };
  /**
   * The subscription's plan allowance the human gave (`--plan-usd-monthly`,
   * `FORERUNNER_PLAN_USD_MONTHLY` or the interactive question; ADR 0044): USD of
   * API-equivalent usage per month, the base of the plan usage share. Absent: the default
   * (`DEFAULT_PLAN_USD_MONTHLY`) applies at compose. Not a secret.
   */
  subscription?: { planUsdMonthly: number };
  stateUrl: string;
  setupCompletedAt?: string;
  /**
   * When the human finished or closed the app's setup assistant (ADR 0092); the app opens it on
   * start until then, unless the credentials are already complete.
   */
  setupAcknowledgedAt?: string;
  /**
   * Notification channels (`src/notifications/config.ts`): the Signal sender account and the
   * Telegram bot token reference; `FORERUNNER_SIGNAL_ACCOUNT`, `FORERUNNER_TELEGRAM_TOKEN_REF`
   * and `FORERUNNER_TELEGRAM_API_BASE` override them. Never a secret value.
   */
  notifications?: {
    signalAccount?: string | null;
    telegramTokenRef?: string;
    telegramApiBase?: string;
  };
}

export interface SetupInput {
  profile?: string;
  humanName?: string;
  /** `--email`: the human's email (format-checked, stored lower case); `--human-id`: an existing human's id. */
  humanEmail?: string;
  humanId?: string;
  timezone?: string;
  githubToken?: string;
  anthropicKey?: string;
  /** A `claude setup-token` token (or FORERUNNER_SUBSCRIPTION_TOKEN); format-checked, stored as `anthropic_subscription_token`. */
  subscriptionToken?: string;
  /** `--plan-usd-monthly`: the plan allowance in USD per month (or FORERUNNER_PLAN_USD_MONTHLY); a bad value is a `validation` error. */
  planUsdMonthly?: number | string;
  repos?: string[];
  githubApiBase?: string;
  anthropicApiBase?: string;
  anthropicWorkspaceId?: string;
  stateUrl?: string;
  nonInteractive: boolean;
  /** Prompt function for interactive mode; returns "" when the user skips. */
  prompt?: (question: string, secret: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  dirs?: AppDirs;
  env?: NodeJS.ProcessEnv;
  /**
   * Write `<config>/install.json` for this process (default true: `fr setup` from a checkout).
   * The daemon's setup routes pass false: a bundled runtime is found by the shell without it.
   */
  installRecord?: boolean;
}

export interface SetupReport {
  dirs: AppDirs;
  configPath: string;
  config: SetupConfig;
  /** `<config>/install.json`: where this checkout and its node binary are (read by the shell). */
  installRecordPath: string;
  installRecord: InstallRecord;
  results: {
    github?: ValidationResult;
    anthropic?: ValidationResult;
    subscription?: ValidationResult;
    /** The interactive allowance answer when one was given: accepted, or why the default applies. */
    planAllowance?: ValidationResult;
  };
  stored: string[];
  skipped: string[];
  complete: boolean;
  /**
   * The billing sources this install will register at its next start (ADR 0044): the
   * subscription when `anthropic_subscription_token` is in the vault, the API key when
   * `anthropic_api_key` is; both when both are.
   */
  sources: {
    subscription: boolean;
    apiKey: boolean;
    /** The plan allowance in force for the subscription source (with its origin); null without one. */
    planAllowance: PlanAllowance | null;
  };
}

/** Environment variable the non-interactive setup reads the subscription token from. */
export const SUBSCRIPTION_TOKEN_ENV = "FORERUNNER_SUBSCRIPTION_TOKEN";

/** The interactive question for the plan allowance (asked once a subscription source exists). */
export const PLAN_ALLOWANCE_QUESTION = [
  "\nPlan allowance",
  "What: the API-equivalent usage your Claude plan covers per month, in USD (an estimate; not a secret).",
  "Why: the provider reports no plan usage to the Agent SDK, so Forerunner estimates the plan share from this and stops subscription work at the plan share cap (the API key takes over when there is one).",
  `Enter a number of USD, or press Enter for the default USD ${DEFAULT_PLAN_USD_MONTHLY} (change it any time with fr setup --plan-usd-monthly): `,
].join("\n");

export function configPath(dirs: AppDirs = appDirs()): string {
  return join(dirs.config, "config.json");
}

export function readConfig(dirs: AppDirs = appDirs()): SetupConfig | null {
  const p = configPath(dirs);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SetupConfig;
  } catch {
    return null;
  }
}

/**
 * Record the human the daemon bound to (ADR 0082) in `config.json` when the file exists and
 * names another or none; returns whether it was written. The setup wizard keeps the key.
 */
export function rememberBoundHuman(dirs: AppDirs, humanId: string): boolean {
  const p = configPath(dirs);
  if (!existsSync(p)) return false;
  let current: SetupConfig;
  try {
    current = JSON.parse(readFileSync(p, "utf8")) as SetupConfig;
  } catch {
    return false;
  }
  if (current.humanId === humanId) return false;
  writeFileSync(p, `${JSON.stringify({ ...current, humanId }, null, 2)}\n`);
  return true;
}

/** `--email`: trimmed and lower case; anything but one `@` between two non-empty parts is a `validation` error. */
export function normalizeHumanEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new ForerunnerError(
      "validation",
      `--email: ${JSON.stringify(value)} is not an email address`,
    );
  }
  return email;
}

export function ensureDirs(dirs: AppDirs = appDirs()): AppDirs {
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

export async function runSetup(vault: Vault, input: SetupInput): Promise<SetupReport> {
  const logger = log("setup");
  const env = input.env ?? process.env;
  const dirs = ensureDirs(input.dirs ?? appDirs({ env }));
  const existing = readConfig(dirs);
  const profile = input.profile ?? existing?.profile ?? "default";
  const facts = osFacts(env);
  const humanEmail = normalizeHumanEmail(input.humanEmail);
  const humanId = input.humanId?.trim() || undefined;
  const config: SetupConfig = {
    // Keys this function does not set (notifications, the assistant's acknowledgement) are kept.
    ...(existing ?? {}),
    version: 1,
    profile,
    humanName: input.humanName ?? existing?.humanName,
    humanId: humanId ?? existing?.humanId,
    humanEmail: humanEmail ?? existing?.humanEmail,
    timezone:
      input.timezone ??
      existing?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
    githubApiBase:
      input.githubApiBase ??
      env.FORERUNNER_GITHUB_API ??
      existing?.githubApiBase ??
      "https://api.github.com",
    anthropicApiBase:
      input.anthropicApiBase ??
      env.FORERUNNER_ANTHROPIC_API ??
      existing?.anthropicApiBase ??
      "https://api.anthropic.com",
    anthropicWorkspaceId:
      input.anthropicWorkspaceId ??
      env.FORERUNNER_ANTHROPIC_WORKSPACE_ID ??
      existing?.anthropicWorkspaceId,
    repos: input.repos ?? existing?.repos ?? [],
    credentials: existing?.credentials ?? {
      github: false,
      anthropic: false,
      anthropicSubscription: false,
    },
    stateUrl:
      input.stateUrl ??
      env.FORERUNNER_STATE_URL ??
      existing?.stateUrl ??
      `sqlite:${join(dirs.data, "state.sqlite")}`,
    setupCompletedAt: existing?.setupCompletedAt,
  };
  const results: SetupReport["results"] = {};
  const stored: string[] = [];
  const skipped: string[] = [];
  // The plan allowance from the flag and the environment is checked before any prompt, so a
  // bad value fails the run before a credential is stored.
  const planFromFlag =
    input.planUsdMonthly === undefined
      ? null
      : assertPlanUsdMonthly(input.planUsdMonthly, "--plan-usd-monthly");
  const planEnvValue = env[PLAN_USD_MONTHLY_ENV]?.trim();
  const planFromEnv = planEnvValue
    ? assertPlanUsdMonthly(planEnvValue, PLAN_USD_MONTHLY_ENV)
    : null;

  const ask = async (
    kind: "github" | "anthropic" | "subscription",
    provided: string | undefined,
  ): Promise<string | undefined> => {
    if (provided) return provided;
    if (input.nonInteractive || !input.prompt) return undefined;
    const req = CREDENTIAL_REQUESTS[kind];
    const text = [
      `\n${req.name}`,
      `What: ${req.what}`,
      `Why: ${req.why}`,
      `Scopes: ${req.scopes.join("; ")}`,
      `Where: ${req.whereToClick}`,
      `Verified: ${req.howVerified}`,
      "Paste the value (or press Enter to skip for now): ",
    ].join("\n");
    const v = (await input.prompt(text, true)).trim();
    return v || undefined;
  };

  // GitHub
  const gh = await ask("github", input.githubToken ?? env.FORERUNNER_GITHUB_TOKEN);
  if (gh) {
    assertCredentialKind(gh, "github");
    results.github = await validateGitHubToken({
      token: gh,
      apiBase: config.githubApiBase,
      repos: config.repos,
      fetchImpl: input.fetchImpl,
    });
    if (results.github.ok) {
      await vault.set(SECRET_NAMES.github, gh);
      config.credentials.github = true;
      stored.push(SECRET_NAMES.github);
    } else if (input.nonInteractive) {
      throw new ForerunnerError(
        "validation",
        `GitHub token rejected: ${results.github.problems.join(" ")}`,
      );
    }
  } else {
    skipped.push("github");
  }

  // Anthropic (API key or subscription token)
  const ak = await ask("anthropic", input.anthropicKey ?? env.FORERUNNER_ANTHROPIC_KEY);
  if (ak) {
    assertCredentialKind(ak, "anthropic");
    results.anthropic = await validateAnthropicKey({
      key: ak,
      apiBase: config.anthropicApiBase,
      workspaceId: config.anthropicWorkspaceId,
      fetchImpl: input.fetchImpl,
    });
    if (results.anthropic.ok) {
      const name =
        results.anthropic.details.kind === "subscription"
          ? SECRET_NAMES.anthropicOauth
          : SECRET_NAMES.anthropic;
      await vault.set(name, ak);
      if (name === SECRET_NAMES.anthropic) config.credentials.anthropic = true;
      else config.credentials.anthropicSubscription = true;
      stored.push(name);
    } else if (input.nonInteractive) {
      throw new ForerunnerError(
        "validation",
        `Anthropic key rejected: ${results.anthropic.problems.join(" ")}`,
      );
    }
  } else {
    skipped.push("anthropic");
  }

  // Subscription token (ADR 0044): from the flag or FORERUNNER_SUBSCRIPTION_TOKEN, or asked
  // for interactively unless the Anthropic step already stored one. Format-checked only: a
  // live call through the Agent SDK is never made at setup (the live harness does that).
  const subscriptionProvided = input.subscriptionToken ?? env[SUBSCRIPTION_TOKEN_ENV];
  const alreadyStoredByAnthropicStep = stored.includes(SECRET_NAMES.anthropicOauth);
  const st = alreadyStoredByAnthropicStep
    ? undefined
    : await ask("subscription", subscriptionProvided);
  if (st) {
    results.subscription = validateSubscriptionTokenFormat(st);
    if (results.subscription.ok) {
      await vault.set(SECRET_NAMES.anthropicOauth, st.trim());
      config.credentials.anthropicSubscription = true;
      stored.push(SECRET_NAMES.anthropicOauth);
    } else if (input.nonInteractive) {
      throw new ForerunnerError(
        "validation",
        `Subscription token rejected: ${results.subscription.problems.join(" ")}`,
      );
    }
  } else if (!alreadyStoredByAnthropicStep && !(await vault.has(SECRET_NAMES.anthropicOauth))) {
    skipped.push("subscription");
  }
  const hasSubscription = await vault.has(SECRET_NAMES.anthropicOauth);
  const hasApiKey = await vault.has(SECRET_NAMES.anthropic);
  config.credentials.anthropicSubscription = hasSubscription;
  config.credentials.anthropic = hasApiKey;

  // Plan allowance (ADR 0044): a first-class input next to the token, so the plan share cap
  // is never silently absent. The flag, then the environment, then (interactively, when
  // neither spoke and the config holds none) one question, then the config file, then the
  // default; what the human gave is written to config.json (never a secret).
  let planFromPrompt: number | null = null;
  if (
    hasSubscription &&
    planFromFlag === null &&
    planFromEnv === null &&
    existing?.subscription === undefined &&
    !input.nonInteractive &&
    input.prompt
  ) {
    const answer = (await input.prompt(PLAN_ALLOWANCE_QUESTION, false)).trim();
    if (answer) {
      planFromPrompt = parsePlanUsdMonthly(answer);
      results.planAllowance =
        planFromPrompt === null
          ? {
              ok: false,
              summary: `The plan allowance was not a number of USD; the default USD ${DEFAULT_PLAN_USD_MONTHLY}/month applies.`,
              problems: [
                "Enter a positive number such as 100, or set it later with fr setup --plan-usd-monthly.",
              ],
              details: { kind: "plan_allowance" },
            }
          : {
              ok: true,
              summary: `Plan allowance USD ${planFromPrompt}/month accepted.`,
              problems: [],
              details: { kind: "plan_allowance" },
            };
    }
  }
  const planAllowance = hasSubscription
    ? resolvePlanAllowance([
        { value: planFromFlag, origin: "flag" },
        { value: planFromEnv, origin: "env" },
        { value: planFromPrompt, origin: "prompt" },
        { value: existing?.subscription?.planUsdMonthly, origin: "config" },
      ])
    : null;
  if (planAllowance && planAllowance.origin !== "default") {
    config.subscription = { planUsdMonthly: planAllowance.usdMonthly };
  } else if (existing?.subscription) {
    config.subscription = existing.subscription;
  }
  const sources = { subscription: hasSubscription, apiKey: hasApiKey, planAllowance };

  const complete =
    config.credentials.github &&
    (config.credentials.anthropic || config.credentials.anthropicSubscription);
  if (complete) config.setupCompletedAt = new Date().toISOString();
  const p = configPath(dirs);
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
  // The install record (ADR 0026): on every setup run, from the running process, so the
  // desktop shell finds this checkout and this node binary without an environment variable.
  const installRecord = currentInstallRecord();
  const installRecordPath =
    input.installRecord === false
      ? join(dirs.config, INSTALL_RECORD_FILE)
      : writeInstallRecord(dirs, installRecord);
  logger.info("setup written", {
    configPath: p,
    installRecordPath,
    installDir: installRecord.installDir,
    platform: facts.platform,
    keychain: facts.keychain,
    vault: vault.backend,
    stored,
    skipped,
    complete,
    sources: {
      subscription: sources.subscription,
      apiKey: sources.apiKey,
      planAllowance: planAllowance ? describePlanAllowance(planAllowance) : null,
    },
  });
  return {
    dirs,
    configPath: p,
    config,
    installRecordPath,
    installRecord,
    results,
    stored,
    skipped,
    complete,
    sources,
  };
}
