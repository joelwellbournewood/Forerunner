import { type Clock, errorMessage, ForerunnerError } from "@forerunner/platform";
import type { ExtensionRepo } from "@forerunner/state";
import { Hono } from "hono";
import { z } from "zod";
import type { UpdateActor, UpdateCheck, UpdateManager } from "./install.ts";
import { UPDATE_CHANNELS } from "./manifest.ts";
import type { ExtensionCatalog, ModelWatchReport } from "./ports.ts";
import { compareSemver, isSemver } from "./semver.ts";

/**
 * The updates screen (spec K Settings/Extensions, M): one view with the app update, connector
 * updates (extension rows whose catalog version is newer) and model updates (the model watch),
 * plus the Hono sub-app the daemon mounts. Every shape is a zod schema so the UI validates.
 */
export const APP_UPDATE_STATES = [
  "up_to_date",
  "available",
  "pending_health_check",
  "rolled_back",
  "failed",
  "rejected",
  "unknown",
] as const;
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

export const AppUpdateView = z.object({
  currentVersion: z.string(),
  runningVersion: z.string(),
  channel: z.enum(UPDATE_CHANNELS),
  state: z.enum(APP_UPDATE_STATES),
  available: z
    .object({
      version: z.string(),
      changelog: z.string(),
      publishedAt: z.string(),
      sizeBytes: z.number().int().nullable(),
      artifactName: z.string().nullable(),
      /** Where the artefact is downloaded from (the desktop's installer is run by hand, ADR 0092). */
      artifactUrl: z.string().nullable(),
      minSchema: z.number().int(),
    })
    .nullable(),
  previousVersion: z.string().nullable(),
  rejected: z.array(z.object({ version: z.string(), reason: z.string(), message: z.string() })),
  lastRollback: z
    .object({
      from: z.string(),
      to: z.string().nullable(),
      reason: z.string(),
      at: z.string(),
      automatic: z.boolean(),
    })
    .nullable(),
  lastError: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type AppUpdateView = z.infer<typeof AppUpdateView>;

export const ConnectorUpdateView = z.object({
  extensionId: z.string(),
  kind: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  installedVersion: z.string(),
  availableVersion: z.string(),
  sourceUrl: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ConnectorUpdateView = z.infer<typeof ConnectorUpdateView>;

export const ModelUpdateView = z.object({
  model: z.string(),
  provider: z.string(),
  kind: z.enum(["new_model", "price_change", "deprecation", "recommendation"]),
  summary: z.string(),
  recommendedAction: z.string().nullable(),
  evidence: z.array(z.string()),
  reportedAt: z.string(),
});
export type ModelUpdateView = z.infer<typeof ModelUpdateView>;

export const UpdatesView = z.object({
  app: AppUpdateView,
  connectors: z.array(ConnectorUpdateView),
  models: z.array(ModelUpdateView),
  generatedAt: z.string(),
});
export type UpdatesView = z.infer<typeof UpdatesView>;

export interface UpdatesViewDeps {
  manager: UpdateManager;
  clock: Clock;
  extensions?: Pick<ExtensionRepo, "list">;
  catalog?: ExtensionCatalog;
  modelWatch?: ModelWatchReport;
  /**
   * Ask the release feed. Default false: the view is local state only and shows the result of
   * the last check, if any (the human's decision of 2026-10-25: checks are manual, ADR 0015).
   * True only for the human's "Check for updates" (POST /updates/check) and the gate harnesses.
   */
  checkFeed?: boolean;
  /** With `checkFeed`: bypass the manager's check cache (the button always asks the feed). */
  fresh?: boolean;
  /** With `checkFeed`: who asked, for the `update.check` audit row. Default the system. */
  checkedBy?: UpdateActor;
  /** Why update.json was ignored (updates are then off); shown as the view's `lastError`. */
  configError?: string | null;
}

/** True when the catalog offers something newer than what is installed. */
export function isConnectorUpdate(installed: string, available: string): boolean {
  if (!available) return false;
  if (isSemver(installed) && isSemver(available)) return compareSemver(available, installed) > 0;
  return installed !== available;
}

export async function composeUpdatesView(deps: UpdatesViewDeps): Promise<UpdatesView> {
  const status = deps.manager.status();
  const pointer = status.pointer;
  const app: AppUpdateView = {
    currentVersion: pointer?.current ?? status.runningVersion,
    runningVersion: status.runningVersion,
    channel: status.channel,
    state: "unknown",
    available: null,
    previousVersion: pointer?.previous ?? null,
    rejected: [],
    lastRollback: pointer?.lastRollback ?? null,
    lastError: null,
    checkedAt: null,
  };
  const fill = (check: UpdateCheck) => {
    app.checkedAt = check.checkedAt;
    app.rejected = check.rejected.map((r) => ({
      version: r.version,
      reason: r.reason,
      message: r.message,
    }));
    if (check.available) {
      const artifact = deps.manager.platform
        ? check.available.artifacts.find((a) => a.platform === deps.manager.platform)
        : undefined;
      app.available = {
        version: check.available.version,
        changelog: check.available.notes,
        publishedAt: check.available.publishedAt,
        sizeBytes: artifact?.size ?? null,
        artifactName: artifact?.name ?? null,
        artifactUrl: artifact?.url ?? null,
        minSchema: check.available.minSchema,
      };
    }
    app.state = "up_to_date";
  };
  if (deps.checkFeed === true) {
    try {
      fill(
        await deps.manager.check(deps.checkedBy ?? { kind: "system", id: null }, {
          fresh: deps.fresh === true,
        }),
      );
    } catch (e) {
      // Keep showing the last good check (as GET /updates does) next to the error.
      const last = deps.manager.lastCheckResult();
      if (last) fill(last);
      app.lastError = errorMessage(e);
    }
  } else {
    // Local state only: the last check's result, never a feed request or an audit row.
    const last = deps.manager.lastCheckResult();
    if (last) fill(last);
  }
  if (deps.configError) {
    app.lastError = `update.json ignored (updates are off): ${deps.configError}`;
  }
  if (pointer?.state === "pending_health_check") app.state = "pending_health_check";
  else if (app.available) app.state = "available";
  else if (pointer?.state === "failed") app.state = "failed";
  else if (pointer?.lastRollback && !app.available)
    app.state = app.lastError ? "unknown" : "rolled_back";
  else if (app.lastError) app.state = "unknown";
  else if (app.rejected.length) app.state = "rejected";

  const connectors: ConnectorUpdateView[] = [];
  if (deps.extensions && deps.catalog) {
    const rows = await deps.extensions.list();
    const entries = await deps.catalog.latestVersions(
      rows.map((r) => ({ kind: r.kind, name: r.name })),
    );
    for (const row of rows) {
      const entry = entries.find((e) => e.kind === row.kind && e.name === row.name);
      if (!entry || !isConnectorUpdate(row.ext_version, entry.version)) continue;
      connectors.push({
        extensionId: row.id,
        kind: row.kind,
        name: row.name,
        enabled: row.enabled,
        installedVersion: row.ext_version,
        availableVersion: entry.version,
        sourceUrl: entry.sourceUrl ?? row.source_url ?? null,
        notes: entry.notes ?? null,
      });
    }
    connectors.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  const models: ModelUpdateView[] = deps.modelWatch
    ? (await deps.modelWatch.latest()).map((m) => ({
        model: m.model,
        provider: m.provider,
        kind: m.kind,
        summary: m.summary,
        recommendedAction: m.recommendedAction ?? null,
        evidence: m.evidence ?? [],
        reportedAt: m.reportedAt,
      }))
    : [];

  return UpdatesView.parse({ app, connectors, models, generatedAt: deps.clock.nowIso() });
}

export const ApplyUpdateBody = z.object({ version: z.string().min(1).optional() });
export const RollbackBody = z.object({ reason: z.string().max(2000).optional() });

export interface UpdateRouteDeps extends UpdatesViewDeps {
  /** The human using this install; every apply and rollback from the UI is theirs. */
  humanId: string;
}

function statusOf(err: ForerunnerError): 400 | 403 | 404 | 409 | 500 | 503 {
  switch (err.code) {
    case "not_found":
      return 404;
    case "validation":
    case "version_conflict": // includes "in_progress": another update operation holds the lock
      return 409;
    case "approval_required":
    case "autonomy_insufficient":
    case "path_not_allowed":
      return 403;
    case "unavailable":
      return 503;
    case "not_supported":
      return 400;
    default:
      return 500;
  }
}

/**
 * GET /updates and GET /updates/status (local state, no network), POST /updates/check (the
 * human's "Check for updates": asks the feed), POST /updates/apply, POST /updates/rollback.
 */
export function createUpdateRoutes(deps: UpdateRouteDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ForerunnerError)
      return c.json({ code: err.code, message: err.message, details: err.details }, statusOf(err));
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  // Opening the screen never asks the feed (ADR 0015 amendment of 2026-10-25).
  app.get("/updates", async (c) => c.json(await composeUpdatesView({ ...deps, checkFeed: false })));
  app.get("/updates/status", async (c) =>
    c.json(await composeUpdatesView({ ...deps, checkFeed: false })),
  );
  app.post("/updates/check", async (c) =>
    c.json(
      await composeUpdatesView({
        ...deps,
        checkFeed: true,
        fresh: true,
        checkedBy: { kind: "human", id: deps.humanId },
      }),
    ),
  );
  app.post("/updates/apply", async (c) => {
    const body = ApplyUpdateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ForerunnerError("validation", "body: version must be a string");
    const r = await deps.manager.apply({
      by: { kind: "human", id: deps.humanId },
      version: body.data.version,
    });
    return c.json(
      { version: r.version, previous: r.previous, state: r.pointer.state, restarting: true },
      202,
    );
  });
  app.post("/updates/rollback", async (c) => {
    const body = RollbackBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ForerunnerError("validation", "body: reason must be a string");
    const r = await deps.manager.rollback({
      by: { kind: "human", id: deps.humanId },
      reason: body.data.reason,
    });
    return c.json({ from: r.from, to: r.to, state: r.pointer.state, restarting: true }, 202);
  });
  return app;
}
