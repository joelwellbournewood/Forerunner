import { writeFileSync } from "node:fs";
import {
  type AppDirs,
  type Clock,
  errorMessage,
  isForerunnerError,
  log,
} from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { Restarter } from "../update/ports.ts";
import {
  SetupAnthropicBody as AnthropicBody,
  SetupGitHubBody as GitHubBody,
  SetupProfileBody as ProfileBody,
  type SetupCheckView,
  type SetupFinishView,
  type SetupStatusView,
} from "./types.ts";
import { CREDENTIAL_REQUESTS, classifyCredential, type ValidationResult } from "./validators.ts";
import {
  configPath,
  readConfig,
  runSetup,
  SECRET_NAMES,
  type SetupConfig,
  type SetupInput,
} from "./wizard.ts";

/**
 * The app's setup assistant (ADR 0092): a new user pastes the Anthropic key or Claude
 * subscription token and the GitHub token into the app instead of a terminal. Every credential
 * goes through `runSetup`, the same checks `fr setup` runs, and is stored in the vault by name
 * only when the check passes; no value is ever echoed, logged or written to config.json. The
 * runtime registers its model provider and billing sources when it composes, so `finish`
 * restarts the daemon (the shell relaunches it, ADR 0026) when a credential was stored since
 * this process started.
 *   GET  /setup                             -> SetupStatusView
 *   POST /setup/profile   { name?, timezone? } -> SetupStatusView
 *   POST /setup/anthropic { value }          -> SetupCheckView (API key, or sk-ant-oat… token)
 *   POST /setup/github    { token, repos? }   -> SetupCheckView
 *   POST /setup/finish                       -> { status, restarting }
 * Mounted behind the bearer check.
 */
export interface SetupRoutesDeps {
  dirs: AppDirs;
  vault: Vault;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  store: Pick<StateStore, "human" | "auditLog">;
  humanId: string;
  appVersion: string;
  restarter: Restarter;
  fetchImpl?: typeof fetch;
  /** Restart delay after `finish` answered (tests pass 0). */
  restartDelayMs?: number;
}

/** GitHub's form for a fine-grained token with Forerunner's permissions filled in. */
export const GITHUB_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Forerunner&description=Forerunner+agent+access&expires_in=90&contents=write&pull_requests=write&issues=write&statuses=read&metadata=read";
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

export type { SetupCheckView, SetupFinishView, SetupStatusView } from "./types.ts";

/** Credential variables `runSetup` would read from the environment; the routes take only the pasted value. */
const CREDENTIAL_ENV = [
  "FORERUNNER_GITHUB_TOKEN",
  "FORERUNNER_ANTHROPIC_KEY",
  "FORERUNNER_SUBSCRIPTION_TOKEN",
];

function statusFor(code: string): ContentfulStatusCode {
  switch (code) {
    case "validation":
      return 400;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function credentialsIn(vault: Vault): Promise<SetupStatusView["credentials"]> {
  return {
    github: await vault.has(SECRET_NAMES.github),
    anthropicApiKey: await vault.has(SECRET_NAMES.anthropic),
    subscription: await vault.has(SECRET_NAMES.anthropicOauth),
  };
}

export function createSetupRoutes(deps: SetupRoutesDeps): Hono {
  const logger = log("setup:routes");
  const app = new Hono();
  // What this process composed with: a credential stored later needs a restart to be used.
  // Read once at mount (the server is built right after compose); a vault that cannot answer
  // counts as holding nothing.
  const startedWith = credentialsIn(deps.vault).catch(() => ({
    github: false,
    anthropicApiKey: false,
    subscription: false,
  }));
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(deps.env ?? {}).filter(([k]) => !CREDENTIAL_ENV.includes(k)),
  );

  const setup = (input: Partial<SetupInput>) =>
    runSetup(deps.vault, {
      nonInteractive: false,
      installRecord: false,
      dirs: deps.dirs,
      env,
      fetchImpl: deps.fetchImpl,
      ...input,
    });

  async function status(): Promise<SetupStatusView> {
    const config = readConfig(deps.dirs);
    const human = await deps.store.human.get(deps.humanId);
    const credentials = await credentialsIn(deps.vault);
    const before = await startedWith;
    const complete =
      credentials.github && (credentials.anthropicApiKey || credentials.subscription);
    return {
      complete,
      showAssistant: !complete && !config?.setupAcknowledgedAt,
      name: human?.name ?? config?.humanName ?? "",
      timezone: human?.timezone ?? config?.timezone ?? "UTC",
      credentials,
      restartNeeded:
        (credentials.github && !before.github) ||
        (credentials.anthropicApiKey && !before.anthropicApiKey) ||
        (credentials.subscription && !before.subscription),
      links: { anthropicKeys: ANTHROPIC_KEYS_URL, githubToken: GITHUB_TOKEN_URL },
      githubPermissions: CREDENTIAL_REQUESTS.github.scopes,
    };
  }

  async function audit(name: string, result: ValidationResult | undefined, stored: boolean) {
    await deps.store.auditLog
      .append({
        tool: "setup.credential",
        allowed: stored,
        human_id: deps.humanId,
        input_summary: `name: ${name}`,
        result_summary: stored ? "stored" : `refused: ${result?.summary ?? "not checked"}`,
        occurred_at: deps.clock.nowIso(),
      })
      .catch((e) => logger.warn("audit row not written", { error: errorMessage(e) }));
  }

  function badBody(issues: z.ZodError) {
    return {
      code: "validation",
      message: "invalid request body",
      details: { issues: issues.issues.map((i) => i.path.join(".") || i.message) },
    };
  }

  app.onError((err, c) => {
    if (isForerunnerError(err)) {
      const s = statusFor(err.code);
      return c.json(
        {
          code: err.code,
          message: s === 500 ? "internal error" : err.message,
          details: s === 500 ? {} : (err.details ?? {}),
        },
        s,
      );
    }
    logger.error("setup route failed", { error: errorMessage(err) });
    return c.json({ code: "internal", message: "internal error", details: {} }, 500);
  });

  app.get("/setup", async (c) => c.json(await status()));

  app.post("/setup/profile", async (c) => {
    const parsed = ProfileBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badBody(parsed.error), 400);
    const { name, timezone } = parsed.data;
    if (timezone !== undefined && !isTimezone(timezone)) {
      return c.json(
        { code: "validation", message: `unknown time zone: ${timezone}`, details: {} },
        400,
      );
    }
    await setup({
      ...(name !== undefined ? { humanName: name } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    });
    const patch = {
      ...(name !== undefined ? { name } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
    if (Object.keys(patch).length) await deps.store.human.patch(deps.humanId, patch);
    return c.json(await status());
  });

  app.post("/setup/anthropic", async (c) => {
    const parsed = AnthropicBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badBody(parsed.error), 400);
    const value = parsed.data.value.trim();
    const kind = classifyCredential(value);
    if (kind === "github") {
      return c.json(
        {
          code: "validation",
          message:
            "This is a GitHub token. Paste it in the GitHub step; here Forerunner needs an Anthropic API key (sk-ant-api…) or a Claude subscription token (sk-ant-oat…).",
          details: {},
        },
        400,
      );
    }
    const subscription = kind === "anthropic_oauth";
    const report = await setup(
      subscription ? { subscriptionToken: value } : { anthropicKey: value },
    );
    const result = subscription ? report.results.subscription : report.results.anthropic;
    const name = subscription ? SECRET_NAMES.anthropicOauth : SECRET_NAMES.anthropic;
    const stored = report.stored.includes(name);
    await audit(name, result, stored);
    const view: SetupCheckView = {
      ok: stored,
      kind: subscription ? "subscription" : "api_key",
      summary: result?.summary ?? "Not checked.",
      problems: result?.problems ?? [],
      status: await status(),
    };
    return c.json(view);
  });

  app.post("/setup/github", async (c) => {
    const parsed = GitHubBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badBody(parsed.error), 400);
    const token = parsed.data.token.trim();
    const kind = classifyCredential(token);
    if (kind === "anthropic_api_key" || kind === "anthropic_oauth") {
      return c.json(
        {
          code: "validation",
          message:
            "This is an Anthropic credential. Paste it in the Claude step; here Forerunner needs a GitHub token (github_pat_…).",
          details: {},
        },
        400,
      );
    }
    const report = await setup({
      githubToken: token,
      ...(parsed.data.repos ? { repos: parsed.data.repos } : {}),
    });
    const result = report.results.github;
    const stored = report.stored.includes(SECRET_NAMES.github);
    await audit(SECRET_NAMES.github, result, stored);
    const login = result?.details.login;
    const view: SetupCheckView = {
      ok: stored,
      kind: "github",
      summary: result?.summary ?? "Not checked.",
      problems: result?.problems ?? [],
      ...(typeof login === "string" ? { login } : {}),
      status: await status(),
    };
    return c.json(view);
  });

  app.post("/setup/finish", async (c) => {
    // `runSetup` writes config.json when there is none yet (a fresh install), then the mark.
    await setup({});
    const config = readConfig(deps.dirs);
    if (config) {
      const next: SetupConfig = { ...config, setupAcknowledgedAt: deps.clock.nowIso() };
      writeFileSync(configPath(deps.dirs), `${JSON.stringify(next, null, 2)}\n`);
    }
    const view = await status();
    const restarting = view.restartNeeded;
    if (restarting) {
      logger.info("restarting so the new credentials take effect");
      setTimeout(() => {
        deps.restarter
          .restart({
            reason: "setup",
            targetVersion: deps.appVersion,
            fromVersion: deps.appVersion,
          })
          .catch((e) => logger.error("restart after setup failed", { error: errorMessage(e) }));
      }, deps.restartDelayMs ?? 300);
    }
    const answer: SetupFinishView = { status: view, restarting };
    return c.json(answer);
  });

  return app;
}
