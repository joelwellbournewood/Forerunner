import { hostname } from "node:os";
import { appDirs, ForerunnerError, join, safeSegment } from "@forerunner/platform";
import { z } from "zod";

/**
 * Runner configuration. Everything comes from `FORERUNNER_*` environment variables, validated
 * with zod; nothing names an org, a host, a mailbox or a user path. The shared state URL is the
 * only mandatory value: a runner without a shared store has nothing to run.
 *
 * See docs/maintainers/cloud-runner.md for the table of variables and their defaults.
 */

export const DEFAULT_HEALTH_PORT = 8787;
export const DEFAULT_HEALTH_HOST = "127.0.0.1";
export const DEFAULT_MAIL_CHECK_MS = 5 * 60 * 1000;
export const MIN_MAIL_CHECK_MS = 10_000;
export const DEFAULT_UNLOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UNLOCK_POLL_MS = 2_000;
export const DEFAULT_UNLOCK_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_UNLOCK_TICK_MS = 30_000;
export const DEFAULT_PC_ONLINE_MS = 3 * 60 * 1000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_COMMAND_POLL_MS = 500;
export const DEFAULT_SCHEDULE_TICK_MS = 30_000;
/** Inbox trigger poll (new peer messages and answered requests); 0 turns inbox triggers off. */
export const DEFAULT_INBOX_POLL_MS = 30_000;
/** CHF 5 at 0.8 CHF/USD, the same default the daemon uses for a session. */
export const DEFAULT_SESSION_CAP_USD_MICRO = 6_250_000;
export const DEFAULT_IDLE_LOCK_MS = 0;

const UNLOCK_POLICIES = ["ask", "window"] as const;
export type UnlockPolicy = (typeof UNLOCK_POLICIES)[number];
const MAIL_VERIFIERS = ["mailauth", "header"] as const;
export type MailVerifierKind = (typeof MAIL_VERIFIERS)[number];

/** A store URL the state package opens: sqlite: for single-machine trials, postgres:// shared. */
const storeUrl = z
  .string()
  .min(1, "FORERUNNER_STATE_URL is required (postgres://... in hybrid and cloud mode)")
  .refine(
    (u) => u.startsWith("sqlite:") || /^postgres(ql)?:\/\//.test(u),
    "FORERUNNER_STATE_URL must start with sqlite: or postgres://",
  );

const runnerId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, "runner id may contain letters, digits, . _ : -");

export const RunnerConfigSchema = z.object({
  stateUrl: storeUrl,
  stateSchema: z.string().trim().min(1).optional(),
  runnerId,
  /** Human id or email of the person this runner serves; the first human when absent. */
  human: z.string().trim().min(1).optional(),
  /** Agent id or name; the human's first principal agent when absent. */
  agent: z.string().trim().min(1).optional(),
  vaultPath: z.string().min(1),
  unlock: z.object({
    policy: z.enum(UNLOCK_POLICIES),
    timeoutMs: z.number().int().positive(),
    pollMs: z.number().int().min(100),
    challengeTtlMs: z.number().int().min(10_000),
    tickMs: z.number().int().min(1_000),
    /** Lock the vault after this long without a session (0 = never). */
    idleLockMs: z.number().int().min(0),
  }),
  /** The subscription of the human may be used: this runner serves one person only. */
  personal: z.boolean(),
  mail: z.object({
    checkIntervalMs: z.number().int().min(MIN_MAIL_CHECK_MS),
    push: z.boolean(),
    verifier: z.enum(MAIL_VERIFIERS),
    trustedAuthservIds: z.array(z.string().trim().min(1)),
  }),
  health: z.object({
    host: z
      .string()
      .trim()
      .min(1)
      .refine(
        isLoopbackHost,
        "the health route binds the loopback interface only (127.0.0.1, localhost or ::1)",
      ),
    port: z.number().int().min(0).max(65535),
    readyFile: z.string().min(1),
  }),
  pcOnlineMs: z.number().int().min(1_000),
  heartbeatMs: z.number().int().min(1_000),
  commandPollMs: z.number().int().min(100).max(2_000),
  scheduleTickMs: z.number().int().min(1_000),
  inboxPollMs: z
    .number()
    .int()
    .min(0)
    .refine((n) => n === 0 || n >= 1_000, "0 (off) or at least 1000 ms"),
  sessionCapUsdMicro: z.number().int().positive(),
  version: z.string().min(1),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ForerunnerError("validation", `${name} must be a number`, {
      details: { name, value: raw },
    });
  }
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function listEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The loopback interface by name or literal address; the health route binds nothing else. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** `runner-<host>` with the host name reduced to safe characters; never an org or a person. */
export function defaultRunnerId(host: string = hostname()): string {
  return `runner-${safeSegment(host.toLowerCase(), "host").slice(0, 48)}`;
}

/** Read and validate the configuration. Throws `validation` with every issue listed. */
export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const dirs = appDirs({ env });
  const candidate = {
    stateUrl: env.FORERUNNER_STATE_URL ?? "",
    stateSchema: env.FORERUNNER_STATE_SCHEMA || undefined,
    runnerId: env.FORERUNNER_RUNNER_ID || defaultRunnerId(),
    human: env.FORERUNNER_RUNNER_HUMAN || undefined,
    agent: env.FORERUNNER_RUNNER_AGENT || undefined,
    vaultPath: env.FORERUNNER_RUNNER_VAULT_PATH || join(dirs.config, "vault.runner.json"),
    unlock: {
      policy: (env.FORERUNNER_RUNNER_UNLOCK || "window").trim().toLowerCase(),
      timeoutMs: intEnv(env, "FORERUNNER_RUNNER_UNLOCK_TIMEOUT_MS", DEFAULT_UNLOCK_TIMEOUT_MS),
      pollMs: intEnv(env, "FORERUNNER_RUNNER_UNLOCK_POLL_MS", DEFAULT_UNLOCK_POLL_MS),
      challengeTtlMs: intEnv(
        env,
        "FORERUNNER_RUNNER_UNLOCK_CHALLENGE_TTL_MS",
        DEFAULT_UNLOCK_CHALLENGE_TTL_MS,
      ),
      tickMs: intEnv(env, "FORERUNNER_RUNNER_UNLOCK_TICK_MS", DEFAULT_UNLOCK_TICK_MS),
      idleLockMs: intEnv(env, "FORERUNNER_RUNNER_IDLE_LOCK_MS", DEFAULT_IDLE_LOCK_MS),
    },
    personal: boolEnv(env, "FORERUNNER_RUNNER_PERSONAL", false),
    mail: {
      checkIntervalMs: intEnv(env, "FORERUNNER_RUNNER_MAIL_CHECK_MS", DEFAULT_MAIL_CHECK_MS),
      push: boolEnv(env, "FORERUNNER_RUNNER_MAIL_PUSH", true),
      verifier: (env.FORERUNNER_RUNNER_MAIL_VERIFIER || "mailauth").trim().toLowerCase(),
      trustedAuthservIds: listEnv(env, "FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS"),
    },
    health: {
      host: env.FORERUNNER_RUNNER_HEALTH_HOST || DEFAULT_HEALTH_HOST,
      port: intEnv(env, "FORERUNNER_RUNNER_HEALTH_PORT", DEFAULT_HEALTH_PORT),
      readyFile: env.FORERUNNER_RUNNER_READY_FILE || join(dirs.runtime, "runner-ready.json"),
    },
    pcOnlineMs: intEnv(env, "FORERUNNER_RUNNER_PC_ONLINE_MS", DEFAULT_PC_ONLINE_MS),
    heartbeatMs: intEnv(env, "FORERUNNER_RUNNER_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    commandPollMs: intEnv(env, "FORERUNNER_RUNNER_COMMAND_POLL_MS", DEFAULT_COMMAND_POLL_MS),
    scheduleTickMs: intEnv(env, "FORERUNNER_RUNNER_SCHEDULE_TICK_MS", DEFAULT_SCHEDULE_TICK_MS),
    inboxPollMs: intEnv(env, "FORERUNNER_RUNNER_INBOX_POLL_MS", DEFAULT_INBOX_POLL_MS),
    sessionCapUsdMicro: intEnv(
      env,
      "FORERUNNER_RUNNER_SESSION_CAP_USD_MICRO",
      DEFAULT_SESSION_CAP_USD_MICRO,
    ),
    version: env.FORERUNNER_VERSION || "0.1.0",
  };
  const parsed = RunnerConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
    throw new ForerunnerError("validation", `invalid runner configuration: ${issues.join("; ")}`, {
      details: { issues },
    });
  }
  const cfg = parsed.data;
  if (cfg.mail.verifier === "header" && cfg.mail.trustedAuthservIds.length === 0) {
    throw new ForerunnerError(
      "validation",
      "FORERUNNER_RUNNER_MAIL_VERIFIER=header needs FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS (the mail host's authserv-id); a header from an unlisted host is never believed",
    );
  }
  return cfg;
}

/**
 * The store URL with any credential replaced, for logs and the health view. The authority is
 * everything between `://` and the first `/`, `?` or `#`; a credential ends at the authority's
 * last `@` (a password may contain one unescaped), so the match is greedy up to there.
 */
export function redactStoreUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1[REDACTED]@");
}

/** What the runner logs at start: the configuration without the store credential. */
export function describeConfig(cfg: RunnerConfig): Record<string, unknown> {
  return {
    runnerId: cfg.runnerId,
    stateUrl: redactStoreUrl(cfg.stateUrl),
    stateSchema: cfg.stateSchema ?? null,
    human: cfg.human ?? "(first)",
    agent: cfg.agent ?? "(first principal)",
    vaultPath: cfg.vaultPath,
    unlock: cfg.unlock,
    personal: cfg.personal,
    mail: cfg.mail,
    health: cfg.health,
    pcOnlineMs: cfg.pcOnlineMs,
    heartbeatMs: cfg.heartbeatMs,
    commandPollMs: cfg.commandPollMs,
    scheduleTickMs: cfg.scheduleTickMs,
    inboxPollMs: cfg.inboxPollMs,
    sessionCapUsdMicro: cfg.sessionCapUsdMicro,
    version: cfg.version,
  };
}
