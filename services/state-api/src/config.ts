import { readFileSync } from "node:fs";
import { appDirs, ForerunnerError, join } from "@forerunner/platform";

/**
 * Service configuration. Everything comes from `FORERUNNER_*` environment variables (or
 * the vault reference for the admin token, resolved by main.ts); nothing here names an
 * org, a host or a user path. Defaults are the loopback address and port 8788.
 */
export interface StateApiConfig {
  host: string;
  port: number;
  /** postgres:// (deployments) or sqlite: (tests, single-machine trials). */
  stateUrl: string;
  /** Postgres schema to use; undefined means the connection's default. */
  schema: string | undefined;
  /** Shared secret for the desktop runtime and the cloud runner. Never logged. */
  adminToken: string | undefined;
  /** Vault reference name that holds the admin token when the env var is not set. */
  adminTokenRef: string | undefined;
  /** Approvals web origin allowed by CORS; undefined disables CORS entirely. */
  corsOrigin: string | undefined;
  /**
   * True when a reverse proxy in front of the service sets X-Forwarded-For; only then is
   * that header used to key the public rate limiter. Otherwise the socket address is used.
   */
  trustProxy: boolean;
  /** Requests per minute per device (token bucket). */
  rateLimitPerMinute: number;
  /** Max JSON body size in bytes. */
  jsonBodyLimitBytes: number;
  /** Max upload size in bytes. */
  uploadMaxBytes: number;
  /** Directory for uploaded files: <appDirs().data>/uploads/<project>/. */
  uploadsDir: string;
  /** Directory for the service's own small JSON state (tokens, mirror mapping). */
  serviceStateDir: string;
  /** Session token lifetime. */
  sessionTokenTtlMs: number;
  /** Signature freshness window. */
  signatureWindowMs: number;
  /** Change-counter polling interval (realtime fallback). */
  pollIntervalMs: number;
  /** SSE heartbeat interval. */
  heartbeatMs: number;
  /** GitHub mirror: "owner/name" of the repository, when enabled. */
  mirrorRepo: string | undefined;
  /** Vault reference or env var holding the GitHub token for the mirror. */
  mirrorTokenRef: string | undefined;
  /** GitHub API base URL for the mirror (GitHub Enterprise or a stand-in); undefined = api.github.com. */
  mirrorApiUrl: string | undefined;
  /** How often the mirror pulls comments and status edits back. */
  mirrorIntervalMs: number;
  /** Service version, from package.json. */
  version: string;
}

export const DEFAULT_PORT = 8788;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const DEFAULT_JSON_BODY_LIMIT = 256 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_MIRROR_INTERVAL_MS = 60_000;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ForerunnerError("validation", `${name} must be a non-negative number`, {
      details: { name, value: raw },
    });
  }
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** `owner/name` for the mirror repository; a validation error otherwise. */
export function parseMirrorRepo(value: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (!m?.[1] || !m[2]) {
    throw new ForerunnerError("validation", "FORERUNNER_MIRROR_REPO must be owner/name", {
      details: { value },
    });
  }
  return { owner: m[1], name: m[2] };
}

export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Read the configuration from `env` (default process.env). Throws on invalid values, never on missing optional ones. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): StateApiConfig {
  const dirs = appDirs({ env });
  const stateUrl = env.FORERUNNER_STATE_URL ?? "";
  const port = intEnv(env, "FORERUNNER_STATE_API_PORT", DEFAULT_PORT);
  if (port > 65535) throw new ForerunnerError("validation", "FORERUNNER_STATE_API_PORT > 65535");
  return {
    host: env.FORERUNNER_STATE_API_HOST || DEFAULT_HOST,
    port,
    stateUrl,
    schema: env.FORERUNNER_STATE_SCHEMA || undefined,
    adminToken: env.FORERUNNER_STATE_API_ADMIN_TOKEN || undefined,
    adminTokenRef: env.FORERUNNER_STATE_API_ADMIN_TOKEN_REF || undefined,
    corsOrigin: env.FORERUNNER_STATE_API_CORS_ORIGIN || undefined,
    trustProxy: boolEnv(env, "FORERUNNER_STATE_API_TRUST_PROXY"),
    rateLimitPerMinute: intEnv(
      env,
      "FORERUNNER_STATE_API_RATE_LIMIT",
      DEFAULT_RATE_LIMIT_PER_MINUTE,
    ),
    jsonBodyLimitBytes: intEnv(env, "FORERUNNER_STATE_API_BODY_LIMIT", DEFAULT_JSON_BODY_LIMIT),
    uploadMaxBytes: intEnv(env, "FORERUNNER_STATE_API_UPLOAD_MAX_BYTES", DEFAULT_UPLOAD_MAX_BYTES),
    uploadsDir: join(dirs.data, "uploads"),
    serviceStateDir: join(dirs.data, "state-api"),
    sessionTokenTtlMs: intEnv(env, "FORERUNNER_STATE_API_TOKEN_TTL_MS", SESSION_TOKEN_TTL_MS),
    signatureWindowMs: intEnv(env, "FORERUNNER_STATE_API_SIGNATURE_WINDOW_MS", SIGNATURE_WINDOW_MS),
    pollIntervalMs: intEnv(env, "FORERUNNER_STATE_API_POLL_MS", DEFAULT_POLL_INTERVAL_MS),
    heartbeatMs: intEnv(env, "FORERUNNER_STATE_API_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    mirrorRepo: env.FORERUNNER_MIRROR_REPO || undefined,
    mirrorTokenRef: env.FORERUNNER_MIRROR_TOKEN_REF || undefined,
    mirrorApiUrl: env.FORERUNNER_MIRROR_API_URL || undefined,
    mirrorIntervalMs: intEnv(env, "FORERUNNER_MIRROR_INTERVAL_MS", DEFAULT_MIRROR_INTERVAL_MS),
    version: packageVersion(),
  };
}

/** Validation for a production start: a store URL and an admin token source are mandatory. */
export function assertStartable(cfg: StateApiConfig): void {
  if (!cfg.stateUrl) {
    throw new ForerunnerError(
      "validation",
      "FORERUNNER_STATE_URL is required (postgres://... in paired mode)",
    );
  }
  if (!cfg.adminToken && !cfg.adminTokenRef) {
    throw new ForerunnerError(
      "validation",
      "set FORERUNNER_STATE_API_ADMIN_TOKEN or FORERUNNER_STATE_API_ADMIN_TOKEN_REF (vault name)",
    );
  }
}
