import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppDirs, appDirs, ForerunnerError, join, log, osFacts } from "@forerunner/platform";
import type { Vault } from "@forerunner/vault";
import {
  assertCredentialKind,
  CREDENTIAL_REQUESTS,
  type ValidationResult,
  validateAnthropicKey,
  validateGitHubToken,
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
  /** The shared state service's admin token (the phone's remote commands, ADR 0032). */
  stateApiAdmin: "state_api_admin_token",
} as const;

export interface SetupConfig {
  version: 1;
  profile: string;
  humanName?: string;
  timezone: string;
  githubApiBase: string;
  anthropicApiBase: string;
  repos: string[];
  credentials: { github: boolean; anthropic: boolean; anthropicSubscription: boolean };
  stateUrl: string;
  /** Postgres schema of the shared state, when not the connection's default. */
  stateSchema?: string;
  /** The shared state service (ADR 0024) the phone talks to; the daemon takes its remote commands from it. */
  stateApiUrl?: string;
  setupCompletedAt?: string;
}

export interface SetupInput {
  profile?: string;
  humanName?: string;
  timezone?: string;
  githubToken?: string;
  anthropicKey?: string;
  repos?: string[];
  githubApiBase?: string;
  anthropicApiBase?: string;
  stateUrl?: string;
  nonInteractive: boolean;
  /** Prompt function for interactive mode; returns "" when the user skips. */
  prompt?: (question: string, secret: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  dirs?: AppDirs;
  env?: NodeJS.ProcessEnv;
}

export interface SetupReport {
  dirs: AppDirs;
  configPath: string;
  config: SetupConfig;
  results: { github?: ValidationResult; anthropic?: ValidationResult };
  stored: string[];
  skipped: string[];
  complete: boolean;
}

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
  const config: SetupConfig = {
    version: 1,
    profile,
    humanName: input.humanName ?? existing?.humanName,
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

  const ask = async (
    kind: "github" | "anthropic",
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

  const complete =
    config.credentials.github &&
    (config.credentials.anthropic || config.credentials.anthropicSubscription);
  if (complete) config.setupCompletedAt = new Date().toISOString();
  const p = configPath(dirs);
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
  logger.info("setup written", {
    configPath: p,
    platform: facts.platform,
    keychain: facts.keychain,
    vault: vault.backend,
    stored,
    skipped,
    complete,
  });
  return { dirs, configPath: p, config, results, stored, skipped, complete };
}
