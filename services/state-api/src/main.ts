import { mkdirSync } from "node:fs";
import { GitHubHost } from "@forerunner/capabilities/githost/github";
import type { RepoRef } from "@forerunner/capabilities/githost/types";
import { ForerunnerError, log, osFacts, systemClock } from "@forerunner/platform";
import { appliedVersions, MIGRATIONS, migrate, openStore } from "@forerunner/state";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { migrateTokenState, SessionTokenStore } from "./auth/tokens.ts";
import { assertStartable, parseMirrorRepo, readConfig, type StateApiConfig } from "./config.ts";
import {
  emptyMirrorMapping,
  GitHubMirror,
  type MirrorHost,
  migrateMirrorMapping,
} from "./mirror/github.ts";
import { type MirrorRunReport, MirrorScheduler } from "./mirror/scheduler.ts";
import { IdempotencyStore, migrateIdempotency } from "./outbox.ts";
import { PostgresNotifier } from "./realtime.ts";
import { FileJsonState } from "./state-file.ts";

/**
 * `pnpm state-api`: read the environment, resolve the admin token, open the store, check the
 * schema, build the GitHub mirror when configured, start the LISTEN bridge and the HTTP
 * server, stop cleanly on SIGINT / SIGTERM.
 *
 * Secrets by reference: FORERUNNER_STATE_API_ADMIN_TOKEN_REF and FORERUNNER_MIRROR_TOKEN_REF
 * name vault secrets. The service has no vault of its own (the keychain belongs to the
 * desktop); the runner that starts it injects vault values into the environment as
 * FORERUNNER_SECRET_<NAME>, which is what `envSecretResolver` reads. A `SecretResolver` can
 * be passed in by whoever embeds the service in a process that holds a vault.
 */
export type SecretResolver = (name: string) => Promise<string | undefined>;

/** Seams for tests and embedders. */
export interface StartHooks {
  /** Build the mirror's git host; default `GitHubHost` with the resolved token. */
  mirrorHost?: (opts: { token: string; repo: RepoRef; apiUrl: string | undefined }) => MirrorHost;
}

const logger = log("state-api");

export function envSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return async (name) => {
    const key = `FORERUNNER_SECRET_${name
      .replace(/^secret:/, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase()}`;
    return env[key] || undefined;
  };
}

export async function resolveAdminToken(
  cfg: StateApiConfig,
  resolve: SecretResolver,
): Promise<string> {
  if (cfg.adminToken) return cfg.adminToken;
  if (cfg.adminTokenRef) {
    const value = await resolve(cfg.adminTokenRef);
    if (value) return value;
    throw new ForerunnerError(
      "secret_not_granted",
      `admin token reference ${cfg.adminTokenRef} resolved to nothing`,
    );
  }
  throw new ForerunnerError("validation", "no admin token configured");
}

/** The mirror token by reference; undefined when the mirror is not configured. */
export async function resolveMirrorToken(
  cfg: StateApiConfig,
  resolve: SecretResolver,
): Promise<string | undefined> {
  if (!cfg.mirrorRepo) return undefined;
  if (!cfg.mirrorTokenRef) {
    throw new ForerunnerError(
      "validation",
      "FORERUNNER_MIRROR_REPO needs FORERUNNER_MIRROR_TOKEN_REF (vault name of the GitHub token)",
    );
  }
  const value = await resolve(cfg.mirrorTokenRef);
  if (value) return value;
  throw new ForerunnerError(
    "secret_not_granted",
    `mirror token reference ${cfg.mirrorTokenRef} resolved to nothing`,
  );
}

export interface StartedService {
  config: StateApiConfig;
  url: string;
  /** Present when FORERUNNER_MIRROR_REPO is set: the scheduled one-way GitHub mirror. */
  mirror:
    | {
        repo: string;
        /** Passes completed so far. */
        readonly runs: number;
        lastReport: MirrorRunReport | undefined;
        /** Sync every active project now (also what the schedule does). */
        runOnce(): Promise<MirrorRunReport>;
      }
    | undefined;
  stop(): Promise<void>;
}

export async function startService(
  env: NodeJS.ProcessEnv = process.env,
  resolve: SecretResolver = envSecretResolver(env),
  hooks: StartHooks = {},
): Promise<StartedService> {
  const cfg = readConfig(env);
  assertStartable(cfg);
  const adminToken = await resolveAdminToken(cfg, resolve);
  const mirrorRepo = cfg.mirrorRepo ? parseMirrorRepo(cfg.mirrorRepo) : undefined;
  const mirrorToken = await resolveMirrorToken(cfg, resolve);
  const store = await openStore({
    url: cfg.stateUrl,
    migrate: false,
    ...(cfg.schema ? { schema: cfg.schema } : {}),
  });

  // Migration check (spec M): apply on an empty database, otherwise only when asked.
  const applied = await appliedVersions(store.db);
  const appliedVersion = applied.length ? Math.max(...applied) : 0;
  const codeVersion = MIGRATIONS.length;
  if (appliedVersion > codeVersion) {
    await store.close();
    throw new ForerunnerError(
      "not_supported",
      `database schema ${appliedVersion} is newer than this service (${codeVersion}); update the service`,
    );
  }
  if (appliedVersion < codeVersion) {
    if (appliedVersion === 0 || env.FORERUNNER_STATE_API_MIGRATE === "1") {
      const result = await migrate(store.db);
      logger.info("migrations applied", { applied: result.applied, version: result.version });
    } else {
      await store.close();
      throw new ForerunnerError(
        "not_supported",
        `database schema ${appliedVersion} is behind this service (${codeVersion}); set FORERUNNER_STATE_API_MIGRATE=1 to migrate`,
      );
    }
  }

  mkdirSync(cfg.serviceStateDir, { recursive: true });
  const tokens = new SessionTokenStore(
    new FileJsonState({
      dir: cfg.serviceStateDir,
      name: "tokens",
      initial: () => ({ version: 1, tokens: [] }),
      migrate: migrateTokenState,
    }),
    systemClock,
    cfg.sessionTokenTtlMs,
  );
  const idempotency = new IdempotencyStore(
    new FileJsonState({
      dir: cfg.serviceStateDir,
      name: "idempotency",
      initial: () => ({ version: 1, records: [] }),
      migrate: migrateIdempotency,
    }),
    systemClock,
  );

  // GitHub mirror (ADR 0024): the host token comes by reference like the admin token; the
  // issue mapping lives in mirror.json next to the other service state.
  let mirror: GitHubMirror | undefined;
  let scheduler: MirrorScheduler | undefined;
  if (mirrorRepo && mirrorToken) {
    const repoName = `${mirrorRepo.owner}/${mirrorRepo.name}`;
    const host =
      hooks.mirrorHost?.({ token: mirrorToken, repo: mirrorRepo, apiUrl: cfg.mirrorApiUrl }) ??
      new GitHubHost({
        token: mirrorToken,
        ...(cfg.mirrorApiUrl ? { baseUrl: cfg.mirrorApiUrl } : {}),
        clock: systemClock,
        userAgent: `forerunner-state-api/${cfg.version}`,
      });
    mirror = new GitHubMirror({
      host,
      repo: mirrorRepo,
      store,
      clock: systemClock,
      state: new FileJsonState({
        dir: cfg.serviceStateDir,
        name: "mirror",
        initial: () => emptyMirrorMapping(repoName),
        migrate: migrateMirrorMapping,
      }),
    });
    scheduler = new MirrorScheduler({
      mirror,
      store,
      clock: systemClock,
      intervalMs: Math.max(1, cfg.mirrorIntervalMs),
    });
  }

  const { app, bus, close } = createApp({
    store,
    clock: systemClock,
    config: { ...cfg, adminToken },
    tokens,
    idempotency,
    mirror,
    chfPerUsd: env.FORERUNNER_CHF_PER_USD ? Number(env.FORERUNNER_CHF_PER_USD) : undefined,
  });

  let notifier: PostgresNotifier | undefined;
  if (store.dialect === "postgres") {
    notifier = new PostgresNotifier({
      url: cfg.stateUrl,
      schema: cfg.schema,
      store,
      bus,
      clock: systemClock,
    });
    await notifier.start();
  }

  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolveListening, rejectListening) => {
      const srv = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) =>
        resolveListening({ server: srv, port: info.port }),
      );
      srv.once("error", rejectListening);
    },
  );
  const url = `http://${cfg.host}:${port}`;
  scheduler?.start();
  logger.info("state service listening", {
    url,
    dialect: store.dialect,
    schemaVersion: codeVersion,
    version: cfg.version,
    mirror: scheduler?.repo ?? null,
    ...osFacts(env),
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("state service stopping");
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await scheduler?.stop();
    await close();
    await notifier?.stop();
    await store.close();
    logger.info("state service stopped");
  };
  return {
    config: { ...cfg, adminToken: "[set]" },
    url,
    mirror: scheduler ? mirrorHandle(scheduler) : undefined,
    stop,
  };
}

function mirrorHandle(scheduler: MirrorScheduler): NonNullable<StartedService["mirror"]> {
  return {
    repo: scheduler.repo,
    get runs() {
      return scheduler.runs;
    },
    get lastReport() {
      return scheduler.lastReport;
    },
    runOnce: () => scheduler.runOnce(),
  };
}

const isMain =
  typeof process.argv[1] === "string" &&
  /main\.ts$|main\.js$/.test(process.argv[1]) &&
  process.argv[1].includes("state-api");

if (isMain) {
  startService()
    .then((service) => {
      const onSignal = (signal: NodeJS.Signals) => {
        logger.info("signal received", { signal });
        service
          .stop()
          .then(() => process.exit(0))
          .catch((e) => {
            logger.error("stop failed", { error: String(e) });
            process.exit(1);
          });
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    })
    .catch((e) => {
      logger.error("state service failed to start", {
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof ForerunnerError ? e.code : undefined,
      });
      process.exit(1);
    });
}
