import { appliedVersions } from "@forerunner/state";
import type { App, RouteContext } from "../http.ts";
import type { PushStatusView } from "../push/fanout.ts";

export type MigrationState = "current" | "pending" | "ahead";

export interface HealthView {
  ok: true;
  service: "state-api";
  version: string;
  schema: {
    /** Highest migration the running code knows. */
    code: number;
    /** Highest migration applied in the database. */
    applied: number;
    state: MigrationState;
  };
  /** Clients compare this to their own schema version before syncing (spec M). */
  compatibleSchemaVersion: number;
  dialect: string;
  time: string;
  uptimeMs: number;
  realtime: { listening: boolean; pollIntervalMs: number; subscribers: number };
  mirror: { enabled: boolean; repo: string | null };
  /**
   * Android push (spec R.6, ADR 0085): "fcm" with counters when a service account is
   * configured, "polling" with the reason otherwise. Never a token or a key.
   */
  push: PushStatusView;
}

export async function healthView(ctx: RouteContext): Promise<HealthView> {
  const applied = await appliedVersions(ctx.store.db);
  const appliedVersion = applied.length ? Math.max(...applied) : 0;
  const state: MigrationState =
    appliedVersion === ctx.codeSchemaVersion
      ? "current"
      : appliedVersion < ctx.codeSchemaVersion
        ? "pending"
        : "ahead";
  return {
    ok: true,
    service: "state-api",
    version: ctx.config.version,
    schema: { code: ctx.codeSchemaVersion, applied: appliedVersion, state },
    compatibleSchemaVersion: appliedVersion,
    dialect: ctx.store.dialect,
    time: ctx.clock.nowIso(),
    uptimeMs: Math.max(0, ctx.clock.now() - ctx.startedAt),
    realtime: {
      listening: ctx.notifier?.connected ?? false,
      pollIntervalMs: ctx.config.pollIntervalMs,
      subscribers: ctx.bus.subscriberCount(),
    },
    mirror: { enabled: ctx.mirror !== undefined, repo: ctx.mirror?.repoName ?? null },
    push: ctx.push.status(),
  };
}

export function registerHealthRoutes(app: App, ctx: RouteContext): void {
  app.get("/health", async (c) => c.json(await healthView(ctx)));
}
