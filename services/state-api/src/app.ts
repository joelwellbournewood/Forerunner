import { randomBytes } from "node:crypto";
import { type Clock, log, systemClock } from "@forerunner/platform";
import { MIGRATIONS, type StateStore } from "@forerunner/state";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { PairingService } from "./auth/pairing.ts";
import { authenticate, HEADER_INSTALL } from "./auth/principal.ts";
import { ReplayGuard } from "./auth/replay.ts";
import { SessionTokenStore } from "./auth/tokens.ts";
import { readConfig, type StateApiConfig } from "./config.ts";
import { ApiError, toApiError } from "./errors.ts";
import type { App, Ctx, Env, RouteContext } from "./http.ts";
import type { GitHubMirror } from "./mirror/github.ts";
import { IdempotencyStore } from "./outbox.ts";
import type { PushSender } from "./push/fcm.ts";
import { PushFanout } from "./push/fanout.ts";
import { TokenBucketLimiter } from "./ratelimit.ts";
import { ChangeBus, ChangePoller, type PostgresNotifier } from "./realtime.ts";
import { registerAuditRoutes } from "./routes/audit.ts";
import { registerCostRoutes } from "./routes/costs.ts";
import { registerDeviceRoutes } from "./routes/devices.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerInboxRoutes } from "./routes/inbox.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerRemoteRoutes } from "./routes/remote.ts";
import { registerReviewRoutes } from "./routes/reviews.ts";
import { registerSecretRoutes } from "./routes/secrets.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSyncRoutes } from "./routes/sync.ts";

/**
 * createApp(deps) builds the Hono application for tests and for main.ts. Middleware order:
 * request id -> CORS (only for the configured approvals web origin) -> body limit ->
 * authentication (bearer, device signature, revocation) -> rate limit -> schema check ->
 * routes. Errors become `{ code, message, details }` with the mapped status.
 */
export interface AppDeps {
  store: StateStore;
  clock?: Clock;
  config?: Partial<StateApiConfig>;
  tokens?: SessionTokenStore;
  idempotency?: IdempotencyStore;
  bus?: ChangeBus;
  notifier?: PostgresNotifier;
  mirror?: GitHubMirror;
  /** Fallback CHF per USD when the ledger has no entry yet. */
  chfPerUsd?: number;
  /** Start the change poller (default true; tests may call poller.pollOnce()). */
  startPoller?: boolean;
  /**
   * Android push (spec R.6, ADR 0085): the FCM sender main.ts built from the service account
   * reference, or none with the reason /health shows. Absent: push is off, "not configured".
   */
  push?: { sender?: PushSender; disabledReason?: string };
}

export interface StateApiApp {
  app: App;
  config: StateApiConfig;
  ctx: RouteContext;
  bus: ChangeBus;
  poller: ChangePoller;
  tokens: SessionTokenStore;
  pairing: PairingService;
  /** Per-device, per-install (admin) and public (pairing) token buckets; swept on every poller tick. */
  limiters: { device: TokenBucketLimiter; admin: TokenBucketLimiter; public: TokenBucketLimiter };
  /** Signed mutations seen inside the signature window. */
  replay: ReplayGuard;
  /** Push fan-out to the humans' Android devices (a visible no-op without a sender). */
  push: PushFanout;
  /** Stop timers and the LISTEN connection (the store is the caller's). */
  close(): Promise<void>;
}

export const HEADER_SCHEMA_VERSION = "x-forerunner-schema";

const logger = log("state-api:http");
const PUBLIC_PATHS = new Set(["/health", "/pairing/complete"]);
const ADMIN_RATE_MULTIPLIER = 10;
/** Public buckets are keyed by client address; a flood of addresses must not grow memory. */
const PUBLIC_MAX_KEYS = 10_000;

/**
 * Rate-limit key for unauthenticated requests: the socket address, or the first
 * X-Forwarded-For entry only when the operator declared a trusted proxy in front
 * (`FORERUNNER_STATE_API_TRUST_PROXY`), since any client can set that header itself.
 */
export function clientKey(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return `ip:${first.slice(0, 64)}`;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return `ip:${address}`;
  } catch {
    // Not served by @hono/node-server (tests call app.request()): one shared bucket.
  }
  return "ip:local";
}

export function createApp(deps: AppDeps): StateApiApp {
  const clock = deps.clock ?? systemClock;
  const config: StateApiConfig = { ...readConfig({}), ...(deps.config ?? {}) };
  const tokens = deps.tokens ?? new SessionTokenStore(undefined, clock, config.sessionTokenTtlMs);
  const pairing = new PairingService(deps.store, tokens, clock);
  const bus = deps.bus ?? new ChangeBus(clock);
  const limiter = new TokenBucketLimiter(clock, config.rateLimitPerMinute);
  const adminLimiter = new TokenBucketLimiter(
    clock,
    config.rateLimitPerMinute * ADMIN_RATE_MULTIPLIER,
  );
  const publicLimiter = new TokenBucketLimiter(
    clock,
    Math.max(10, Math.floor(config.rateLimitPerMinute / 6)),
    { maxKeys: PUBLIC_MAX_KEYS },
  );
  const replay = new ReplayGuard(clock, config.signatureWindowMs);
  const push = new PushFanout({
    store: deps.store,
    bus,
    clock,
    ...(deps.push?.sender ? { sender: deps.push.sender } : {}),
    ...(deps.push?.disabledReason ? { disabledReason: deps.push.disabledReason } : {}),
  });
  const poller = new ChangePoller({
    store: deps.store,
    bus,
    clock,
    intervalMs: config.pollIntervalMs,
    onTick: () => {
      limiter.sweep();
      adminLimiter.sweep();
      publicLimiter.sweep();
      replay.sweep();
      // Notices held for quiet hours go out once the human's window has ended.
      if (push.enabled) {
        push
          .flushHeld()
          .catch((e) => logger.warn("held push flush failed", { error: String(e) }));
      }
    },
  });

  const ctx: RouteContext = {
    store: deps.store,
    clock,
    config,
    tokens,
    pairing,
    bus,
    poller,
    notifier: deps.notifier,
    idempotency: deps.idempotency ?? new IdempotencyStore(undefined, clock),
    mirror: deps.mirror,
    push,
    codeSchemaVersion: MIGRATIONS.length,
    startedAt: clock.now(),
    chfPerUsd: deps.chfPerUsd,
  };

  const app = new Hono<Env>();

  app.onError((err, c) => {
    const api = toApiError(err);
    if (api.status >= 500) {
      logger.error("request failed", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    c.header("Cache-Control", "no-store");
    if (api.code === "rate_limited" && typeof api.details.retryAfterSec === "number") {
      c.header("Retry-After", String(api.details.retryAfterSec));
    }
    return c.json(api.body(), api.status);
  });
  app.notFound((c) =>
    c.json(
      { code: "not_found", message: `no route ${c.req.method} ${c.req.path}`, details: {} },
      404,
    ),
  );

  // Request id and access log (debug level; the logger redacts, but headers are never logged anyway).
  app.use("*", async (c, next) => {
    const id = randomBytes(6).toString("hex");
    c.set("requestId", id);
    const started = clock.monotonic();
    await next();
    const p = c.get("principal") as { kind: string; deviceId: string | null } | undefined;
    logger.debug("request", {
      requestId: id,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(clock.monotonic() - started),
      principal: p?.kind ?? "none",
      deviceId: p?.deviceId ?? null,
    });
  });

  if (config.corsOrigin) {
    app.use(
      "*",
      cors({
        origin: config.corsOrigin,
        allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "Last-Event-ID",
          "X-Device-Signature",
          "X-Device-Timestamp",
          "X-Biometric-Assertion",
          HEADER_INSTALL,
          HEADER_SCHEMA_VERSION,
        ],
        exposeHeaders: ["Retry-After"],
        maxAge: 600,
      }),
    );
  }

  const tooLarge = (max: number) => (c: { json: (b: unknown, s: 413) => Response }) =>
    c.json(
      { code: "payload_too_large", message: "request body too large", details: { maxBytes: max } },
      413,
    );
  app.use(
    "/projects/:id/uploads",
    bodyLimit({
      maxSize: config.uploadMaxBytes + 64 * 1024,
      onError: tooLarge(config.uploadMaxBytes),
    }),
  );
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && /^\/projects\/[^/]+\/uploads$/.test(c.req.path)) return next();
    return bodyLimit({
      maxSize: config.jsonBodyLimitBytes,
      onError: tooLarge(config.jsonBodyLimitBytes),
    })(c, next);
  });

  // Authentication, rate limit and schema compatibility for everything but the public paths.
  app.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      if (c.req.method !== "GET") {
        const decision = publicLimiter.take(clientKey(c, config.trustProxy));
        if (!decision.allowed) {
          throw new ApiError(429, "rate_limited", "too many requests", {
            retryAfterSec: decision.retryAfterSec,
          });
        }
      }
      return next();
    }
    if (c.req.method === "OPTIONS") return next();
    const url = new URL(c.req.url);
    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? new Uint8Array()
        : new Uint8Array(await c.req.arrayBuffer());
    const p = await authenticate(
      {
        store: deps.store,
        tokens,
        clock,
        adminToken: config.adminToken,
        signatureWindowMs: config.signatureWindowMs,
        replay,
      },
      {
        method: c.req.method,
        pathWithQuery: `${url.pathname}${url.search}`,
        headers: { get: (name) => c.req.header(name) ?? null },
        body,
      },
    );
    c.set("principal", p);
    const decision =
      p.kind === "admin"
        ? adminLimiter.take(`admin:${p.installId ?? "default"}`)
        : limiter.take(p.deviceId);
    if (!decision.allowed) {
      throw new ApiError(429, "rate_limited", "too many requests", {
        retryAfterSec: decision.retryAfterSec,
      });
    }
    // Spec M: both sides must be on a compatible schema before sync resumes.
    const declared = c.req.header(HEADER_SCHEMA_VERSION);
    if (declared !== undefined && declared !== "") {
      const n = Number(declared);
      if (!Number.isInteger(n) || n !== ctx.codeSchemaVersion) {
        throw new ApiError(
          409,
          "schema_mismatch",
          "client schema version differs from the service",
          {
            client: declared,
            service: ctx.codeSchemaVersion,
          },
        );
      }
    }
    return next();
  });

  registerHealthRoutes(app, ctx);
  registerDeviceRoutes(app, ctx, app);
  registerProjectRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerRemoteRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerCostRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerSyncRoutes(app, ctx);

  push.start();
  if (deps.startPoller !== false) poller.start();

  return {
    app,
    config,
    ctx,
    bus,
    poller,
    tokens,
    pairing,
    limiters: { device: limiter, admin: adminLimiter, public: publicLimiter },
    replay,
    push,
    async close() {
      await poller.stop();
      await push.stop();
      await deps.notifier?.stop();
    },
  };
}
