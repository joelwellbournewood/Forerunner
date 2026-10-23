import type { Clock } from "@forerunner/platform";
import type { BaseRow, StateStore } from "@forerunner/state";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { PairingService } from "./auth/pairing.ts";
import type { Principal } from "./auth/principal.ts";
import type { SessionTokenStore } from "./auth/tokens.ts";
import type { StateApiConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import type { GitHubMirror } from "./mirror/github.ts";
import type { IdempotencyStore } from "./outbox.ts";
import type { PushFanout } from "./push/fanout.ts";
import type {
  ChangeBus,
  ChangeInput,
  ChangePoller,
  ChangeType,
  PostgresNotifier,
} from "./realtime.ts";

/** Hono environment: what middleware puts on the context. */
export type Env = {
  Variables: {
    principal: Principal;
    requestId: string;
  };
};

export type App = Hono<Env>;
export type Ctx = Context<Env>;

/** Everything a route module needs. Built once by createApp(). */
export interface RouteContext {
  store: StateStore;
  clock: Clock;
  config: StateApiConfig;
  tokens: SessionTokenStore;
  pairing: PairingService;
  bus: ChangeBus;
  poller: ChangePoller;
  notifier: PostgresNotifier | undefined;
  idempotency: IdempotencyStore;
  mirror: GitHubMirror | undefined;
  /** Android push fan-out (spec R.6); `enabled` is false without a service account. */
  push: PushFanout;
  /** Highest schema version the code knows (MIGRATIONS.length). */
  codeSchemaVersion: number;
  startedAt: number;
  /** Configured CHF/USD fallback rate (undefined: use the latest ledger rate). */
  chfPerUsd: number | undefined;
}

export function principal(c: Ctx): Principal {
  return c.get("principal");
}

/** Parse the JSON body against a zod schema; 400 with the issues on failure. */
export async function parseBody<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  const text = await c.req.text();
  if (!text.trim()) raw = {};
  else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, "validation", "malformed JSON body");
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(400, "validation", "invalid request body", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export function parseQuery<T extends z.ZodType>(c: Ctx, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new ApiError(400, "validation", "invalid query", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export function intParam(value: string | undefined, fallback: number, max = 500): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new ApiError(400, "validation", "expected a non-negative integer");
  return Math.min(n, max);
}

/**
 * Announce a row the service just wrote. Marks it seen on the bus (so the poller does not
 * repeat it) and publishes the change (so SSE clients and the NOTIFY bridge see it now).
 */
export function announce(
  ctx: RouteContext,
  type: ChangeType,
  table: string,
  row: BaseRow,
  extra: Partial<Omit<ChangeInput, "type" | "payload">> & {
    payload?: Record<string, unknown>;
  } = {},
): void {
  ctx.bus.markSeen(table, row.id, row.version);
  ctx.bus.publish({
    type,
    humanId: extra.humanId ?? null,
    projectId: extra.projectId ?? null,
    sessionId: extra.sessionId ?? null,
    payload: {
      id: row.id,
      version: row.version,
      ...(extra.payload ?? {}),
    } as ChangeInput["payload"],
  });
}

const agentNameCache = new WeakMap<StateStore, Map<string, string>>();

/** Agent display name with a per-store cache (names change rarely; the cache holds 1000 entries). */
export async function agentName(store: StateStore, agentId: string): Promise<string> {
  let cache = agentNameCache.get(store);
  if (!cache) {
    cache = new Map();
    agentNameCache.set(store, cache);
  }
  const hit = cache.get(agentId);
  if (hit) return hit;
  const agent = await store.agent.get(agentId);
  const name = agent?.name ?? agentId;
  if (cache.size > 1000) cache.clear();
  cache.set(agentId, name);
  return name;
}
