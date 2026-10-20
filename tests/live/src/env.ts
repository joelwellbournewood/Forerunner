import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "@forerunner/platform";

/**
 * The live credentials (the API key, the workspace id and, for the subscription half of the
 * phase 1 check, the `claude setup-token` value) come from the build box's `.env.build`
 * (git-ignored, never committed) or from the process environment. The file is parsed here with a few lines of code, no
 * dependency: `KEY=value`, optional `export `, optional single or double quotes (a trailing
 * ` # comment` is allowed after the closing quote; a `#` inside the quotes is kept), `#`
 * comments, blank lines, CRLF. Values are returned to the caller and nowhere else: nothing in this module
 * logs, throws with, or formats a value.
 */
export const BUILD_ENV_FILE = ".env.build";
export const KEY_VAR = "FORERUNNER_ANTHROPIC_KEY";
export const WORKSPACE_VAR = "FORERUNNER_ANTHROPIC_WORKSPACE_ID";
/** The `claude setup-token` value for the subscription half of the phase 1 check (ADR 0044). */
export const SUBSCRIPTION_VAR = "FORERUNNER_SUBSCRIPTION_TOKEN";
/** Overrides where `.env.build` is looked for (a path to the file). */
export const BUILD_ENV_PATH_VAR = "FORERUNNER_ENV_BUILD";
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

export interface LiveCredentials {
  apiKey: string;
  workspaceId: string | null;
  /**
   * The subscription token (the `claude setup-token` value), or null when neither the
   * environment nor the file holds one. It goes into the vault as `anthropic_subscription_token` and nowhere else: the
   * Agent SDK subprocess reads it from there through the runtime, by reference.
   */
  subscriptionToken: string | null;
  /** Where the key came from (the token follows the same order: the environment, else the file). */
  source: "process-env" | ".env.build";
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = parseValue(body.slice(eq + 1).trim());
  }
  return out;
}

/**
 * A quoted value runs to its closing quote, keeps any `#` inside, and may be followed by a
 * trailing comment; anything else after the closing quote makes the whole text an unquoted
 * value, which ends at the first ` #`.
 */
function parseValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, 1);
    if (close > 0) {
      const rest = raw.slice(close + 1).trim();
      if (rest === "" || rest.startsWith("#")) return raw.slice(1, close);
    }
  }
  const hash = raw.indexOf(" #");
  return hash >= 0 ? raw.slice(0, hash).trim() : raw;
}

/** The repository root: the nearest ancestor holding `pnpm-workspace.yaml`, or null. */
export function findRepoRoot(startDir?: string): string | null {
  let current = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface LoadBuildEnvOptions {
  env?: NodeJS.ProcessEnv;
  /** The file to read; default `<repo root>/.env.build` or `FORERUNNER_ENV_BUILD`. */
  file?: string;
  startDir?: string;
}

/**
 * The credentials, or null when neither the environment nor the file holds a key. The process
 * environment wins (the orchestrator may export the key for one command); the file is the
 * build box's default.
 */
export function loadBuildEnv(opts: LoadBuildEnvOptions = {}): LiveCredentials | null {
  const env = opts.env ?? process.env;
  const file =
    opts.file ??
    env[BUILD_ENV_PATH_VAR]?.trim() ??
    (() => {
      const root = findRepoRoot(opts.startDir);
      return root ? join(root, BUILD_ENV_FILE) : null;
    })();
  const parsed: Record<string, string> =
    file && existsSync(resolve(file)) ? parseDotEnv(readFileSync(resolve(file), "utf8")) : {};
  const blank = (v: string | undefined): string | null => {
    const t = v?.trim();
    return t ? t : null;
  };
  // The token: the process environment first, else the file; absent is null, never an error
  // (the API-key half runs without one; the subscription half skips with the reason).
  const subscriptionToken = blank(env[SUBSCRIPTION_VAR]) ?? blank(parsed[SUBSCRIPTION_VAR]);
  const fromEnv = blank(env[KEY_VAR]);
  if (fromEnv) {
    return {
      apiKey: fromEnv,
      workspaceId: blank(env[WORKSPACE_VAR]),
      subscriptionToken,
      source: "process-env",
    };
  }
  const apiKey = blank(parsed[KEY_VAR]);
  if (!apiKey) return null;
  return {
    apiKey,
    workspaceId: blank(parsed[WORKSPACE_VAR]) ?? blank(env[WORKSPACE_VAR]),
    subscriptionToken,
    source: ".env.build",
  };
}

/** What may be said about the credentials: where they came from and whether a workspace is set. */
export function describeCredentials(c: LiveCredentials | null): string {
  if (!c) return "no live credentials";
  return (
    `live credentials from ${c.source}${c.workspaceId ? " with a workspace id" : ""}` +
    `${c.subscriptionToken ? ", with a subscription token" : ", no subscription token"}`
  );
}

/** Replace every credential value in `text` (error messages, logs) with a placeholder. */
export function redactCredentials(text: string, c: LiveCredentials | null): string {
  if (!c) return text;
  let out = text.split(c.apiKey).join("[REDACTED]");
  if (c.workspaceId) out = out.split(c.workspaceId).join("[REDACTED]");
  if (c.subscriptionToken) out = out.split(c.subscriptionToken).join("[REDACTED]");
  return out;
}
