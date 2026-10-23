import { DAEMON_ROUTES, Money } from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";

/**
 * Shapes the UI validates that `api-types.ts` does not carry (ADR 0032).
 *
 * Two groups:
 *
 * 1. Mirrors of runtime schemas that live in modules the browser cannot import
 *    (`extensions/types.ts` is fine, but `extensions/routes.ts`, `update/screen.ts`,
 *    `models/watch.ts` and `estimates/view.ts` pull `@forerunner/platform` or `node:fs`). The
 *    mirror is kept field for field; `test/contracts.test.ts` parses the fixtures with both the
 *    runtime's schema and the mirror so drift fails a test before it reaches a screen.
 *
 * 2. Proposed shapes for routes the daemon does not serve yet (the next-session queue,
 *    data assets and imports, project docs, performance). The paths live in
 *    `PROPOSED_ROUTES`; `proposedPath()` prefers the daemon's `DAEMON_ROUTES` entry of the same
 *    name as soon as one exists, and the pages render a visible "route not available" state
 *    (`isRouteMissing`) until the daemon serves the route. Reviews, memory, commands and the
 *    change log were proposed here first and now come from `api-types.ts` directly.
 */

// ---------------------------------------------------------------------------------------
// Extensions (mirror of packages/runtime/src/extensions/{types,catalog,routes}.ts)
// ---------------------------------------------------------------------------------------

export const EXTENSION_KINDS = [
  "connector",
  "skill",
  "specialist",
  "capability",
  "model_provider",
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXTENSION_STATUSES = ["enabled", "disabled", "error", "pending_approval"] as const;

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

/** What a pending row waits for: the discovery run, or the capability grant itself. */
export const GRANT_STAGES = ["discovery", "grant"] as const;
export type GrantStage = (typeof GRANT_STAGES)[number];

export const ExtensionPermissions = z.object({
  tools: z.array(z.string()).default([]),
  actionClasses: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
});
export type ExtensionPermissions = z.infer<typeof ExtensionPermissions>;

export const EMPTY_PERMISSIONS: ExtensionPermissions = {
  tools: [],
  actionClasses: [],
  domains: [],
  paths: [],
  secrets: [],
  scopes: [],
};

export const ReviewedTool = z.object({
  name: z.string(),
  bridgedName: z.string(),
  description: z.string().default(""),
  actionClass: z.string(),
  risk: z.enum(RISK_LEVELS),
  pathFields: z.array(z.string()).default([]),
  domainFields: z.array(z.string()).default([]),
  inferredFrom: z.string().default(""),
});

export const ReviewedResource = z.object({
  uri: z.string(),
  name: z.string().default(""),
  description: z.string().default(""),
  mimeType: z.string().default(""),
});

export const PermissionReview = z.object({
  tools: z.array(ReviewedTool),
  resources: z.array(ReviewedResource),
  permissions: ExtensionPermissions,
  risk: z.enum(RISK_LEVELS),
  summary: z.array(z.string()),
});
export type PermissionReview = z.infer<typeof PermissionReview>;

export const ExtensionView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(EXTENSION_KINDS),
  status: z.enum(EXTENSION_STATUSES),
  enabled: z.boolean(),
  description: z.string(),
  permissions: ExtensionPermissions,
  pendingPermissions: ExtensionPermissions.nullable(),
  pendingStage: z.enum(GRANT_STAGES).nullable(),
  review: PermissionReview.nullable(),
  cost: Money,
  version: z.string(),
  source: z.string().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
  rowVersion: z.number().int(),
  error: z.string().nullable(),
  connected: z.boolean(),
});
export type ExtensionView = z.infer<typeof ExtensionView>;
export const ExtensionList = z.array(ExtensionView);

/** Catalog entries as the panel needs them; the transport and module details stay opaque. */
export const CatalogEntryView = z.looseObject({
  id: z.string(),
  kind: z.enum(EXTENSION_KINDS),
  name: z.string(),
  description: z.string(),
  version: z.string().default(""),
  homepage: z.string().optional(),
  permissions: ExtensionPermissions.default({ ...EMPTY_PERMISSIONS }),
  requiresAutonomy: z.number().int().min(0).max(4).optional(),
  tags: z.array(z.string()).default([]),
});
export type CatalogEntryView = z.infer<typeof CatalogEntryView>;

export const CatalogView = z.object({
  remoteUrl: z.string().nullable(),
  entries: z.array(CatalogEntryView),
});
export type CatalogView = z.infer<typeof CatalogView>;

export type AddExtensionInput = { catalogId: string } | { url: string };
export type UpdatePermissionsInput = Partial<ExtensionPermissions>;

export const OkView = z.looseObject({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------
// Updates (mirror of packages/runtime/src/update/screen.ts)
// ---------------------------------------------------------------------------------------

export const APP_UPDATE_STATES = [
  "up_to_date",
  "available",
  "pending_health_check",
  "rolled_back",
  "failed",
  "rejected",
  "unknown",
] as const;

export const AppUpdateView = z.object({
  currentVersion: z.string(),
  runningVersion: z.string(),
  channel: z.string(),
  state: z.enum(APP_UPDATE_STATES),
  available: z
    .object({
      version: z.string(),
      changelog: z.string(),
      publishedAt: z.string(),
      sizeBytes: z.number().int().nullable(),
      artifactName: z.string().nullable(),
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

export const ApplyUpdateResult = z.looseObject({
  version: z.string(),
  previous: z.string().nullable(),
  state: z.string(),
  restarting: z.boolean(),
});
export type ApplyUpdateResult = z.infer<typeof ApplyUpdateResult>;

export const RollbackResult = z.looseObject({
  from: z.string(),
  to: z.string().nullable(),
  state: z.string(),
  restarting: z.boolean(),
});
export type RollbackResult = z.infer<typeof RollbackResult>;

// ---------------------------------------------------------------------------------------
// Model watch (mirror of packages/runtime/src/models/{watch,watch-routes}.ts)
// ---------------------------------------------------------------------------------------

export const ModelWatchReportSummary = z.object({
  id: z.string(),
  generated_at: z.string(),
  status: z.string(),
  decision: z.string(),
  request_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  recommendations: z.number().int().nonnegative(),
  new_models: z.number().int().nonnegative(),
  retired_models: z.number().int().nonnegative(),
  repriced: z.number().int().nonnegative(),
  summary: z.string(),
});
export type ModelWatchReportSummary = z.infer<typeof ModelWatchReportSummary>;

export const ModelWatchReportsView = z.object({ reports: z.array(ModelWatchReportSummary) });
export type ModelWatchReportsView = z.infer<typeof ModelWatchReportsView>;

/** The full report is large; the screen reads the parts it shows and keeps the rest opaque. */
export const ModelWatchReportDetail = z.looseObject({
  id: z.string(),
  generated_at: z.string(),
  summary: z.string(),
  recommendations: z.array(z.looseObject({ id: z.string(), kind: z.string(), text: z.string() })),
  skipped: z.array(z.string()).default([]),
});
export const ModelWatchHealthView = z.looseObject({
  decision: z.enum(["pending", "nothing_to_decide", "adopted", "ignored", "remind"]),
  request_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  by: z.string().nullable(),
  applied: z.array(z.string()),
  remind_at: z.string().nullable(),
});
export const ModelWatchReportView = z.object({
  report: ModelWatchReportDetail.nullable(),
  health: ModelWatchHealthView.nullable(),
});
export type ModelWatchReportView = z.infer<typeof ModelWatchReportView>;

export const ModelWatchRunView = z.looseObject({
  report: ModelWatchReportDetail,
  decision: z.string(),
  requestId: z.string().nullable(),
  applied: z.array(z.string()),
});
export type ModelWatchRunView = z.infer<typeof ModelWatchRunView>;

export interface ModelWatchAnswerInput {
  decision: "adopt" | "ignore" | "remind";
  adopt?: string[];
  by: string;
}
export const ModelWatchAnswerView = z.looseObject({
  decision: z.string(),
  applied: z.array(z.string()),
  status: z.string(),
});
export type ModelWatchAnswerView = z.infer<typeof ModelWatchAnswerView>;

export const ModelWatchSyncView = z.looseObject({ resolved: z.unknown() });

// ---------------------------------------------------------------------------------------
// Estimates (mirror of packages/runtime/src/estimates/view.ts, snake_case as the daemon sends it)
// ---------------------------------------------------------------------------------------

export const EstimateAccuracyRow = z.object({
  specialist: z.string(),
  kind: z.string(),
  samples: z.number().int().nonnegative(),
  cost_ratio: z.number(),
  wall_ratio: z.number(),
  mean_abs_error_pct: z.number(),
  confidence: z.number().min(0).max(1),
  last_sample_at: z.string().nullable(),
});
export const EstimateAccuracySample = z.object({
  task_id: z.string().nullable(),
  specialist: z.string(),
  kind: z.string(),
  estimate_usd_micro: z.number().int(),
  actual_usd_micro: z.number().int(),
  error_pct: z.number(),
  estimate_wall_ms: z.number().int(),
  actual_wall_ms: z.number().int(),
  at: z.string(),
});
export const EstimateAccuracyView = z.object({
  generated_at: z.string(),
  overall: z.object({
    samples: z.number().int().nonnegative(),
    mean_abs_error_pct: z.number(),
    bias_pct: z.number(),
    within_25_pct_share: z.number().min(0).max(1),
  }),
  rows: z.array(EstimateAccuracyRow),
  recent: z.array(EstimateAccuracySample),
});
export type EstimateAccuracyView = z.infer<typeof EstimateAccuracyView>;

// ---------------------------------------------------------------------------------------
// Project settings and the mirror (the daemon's answer to PUT /projects/:id/settings)
// ---------------------------------------------------------------------------------------

export const ProjectSettingsView = z.object({
  id: z.string(),
  version: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
  mirrorScheduled: z.boolean(),
});
export type ProjectSettingsView = z.infer<typeof ProjectSettingsView>;

// ---------------------------------------------------------------------------------------
// The change card (spec Q.4) as the daemon sends it inside a CommandResultView (`card`)
// ---------------------------------------------------------------------------------------

export const CHANGE_SCOPES = ["session", "project", "global"] as const;

const ChangeCardBase = z.looseObject({
  command: z.string().default(""),
  what: z.string().default(""),
  oldValue: z.string().default(""),
  newValue: z.string().default(""),
  scope: z.enum(CHANGE_SCOPES).default("project"),
  scopeLabel: z.string().default(""),
  duration: z.string().default("permanent"),
  impact: z
    .looseObject({
      costUsdMicro: z.number().optional(),
      costChfMicro: z.number().optional(),
      risk: z.enum(RISK_LEVELS).default("low"),
    })
    .default({ risk: "low" }),
  undoHint: z.string().default(""),
  sentence: z.string().default(""),
  projectId: z.string().nullable().default(null),
  projectName: z.string().nullable().default(null),
  usesActiveProject: z.boolean().default(false),
  expiresAt: z.string().nullable().default(null),
  reversible: z.boolean().default(true),
});
/** `parts` carries the cards of a composed plan (one level, spec Q.9). */
export const ChangeCardView = ChangeCardBase.extend({ parts: z.array(ChangeCardBase).optional() });
export type ChangeCardView = z.infer<typeof ChangeCardView>;

/** The card out of a command result, or null when the daemon sent none or something else. */
export function parseChangeCard(card: unknown): ChangeCardView | null {
  if (card === null || card === undefined || typeof card !== "object") return null;
  const parsed = ChangeCardView.safeParse(card);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------
// Proposed: next-session queue (spec J.2)
// ---------------------------------------------------------------------------------------

export const QUEUE_KINDS = ["note", "task", "correction", "idea", "voice_note"] as const;
export const QUEUE_STATUSES = ["queued", "consumed", "dismissed"] as const;

export const QueueItemView = z.object({
  id: z.string(),
  projectId: z.string(),
  humanId: z.string(),
  kind: z.enum(QUEUE_KINDS),
  text: z.string(),
  priority: z.number().int(),
  status: z.enum(QUEUE_STATUSES),
  consumedBySession: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type QueueItemView = z.infer<typeof QueueItemView>;
export const QueueList = z.array(QueueItemView);
export interface EnqueueInput {
  kind: (typeof QUEUE_KINDS)[number];
  text: string;
  priority?: number;
}

// ---------------------------------------------------------------------------------------
// Milestones (spec B, K.2 Plan tab; B.5 reasons): a mirror of the daemon's MilestoneView
// ---------------------------------------------------------------------------------------

export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;

export const MilestoneView = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  successCriteria: z.array(z.string()),
  targetDate: z.string().nullable(),
  status: z.enum(MILESTONE_STATUSES),
  orderIndex: z.number().int(),
  /** Reason for the last change, with its author (spec B.5); "" on a row never changed. */
  reason: z.string(),
  authorAgent: z.string().nullable(),
  authorHuman: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type MilestoneView = z.infer<typeof MilestoneView>;
export const MilestoneList = z.array(MilestoneView);

// ---------------------------------------------------------------------------------------
// Proposed: data assets and imports (spec L.1, A.3, K.2 Data tab)
// ---------------------------------------------------------------------------------------

export const DataAssetView = z.object({
  id: z.string(),
  projectIds: z.array(z.string()),
  locator: z.string(),
  name: z.string(),
  sizeBytes: z.number().int(),
  kind: z.string(),
  ownerDeviceId: z.string().nullable(),
  sample: z.unknown().nullable(),
  registeredBy: z.string(),
  createdAt: z.string(),
});
export type DataAssetView = z.infer<typeof DataAssetView>;
export const DataAssetList = z.array(DataAssetView);
export interface RegisterDataAssetInput {
  locator: string;
  kind: string;
}

export const IMPORT_SOURCES = ["zip", "folder", "repo"] as const;
export interface ImportInput {
  source: (typeof IMPORT_SOURCES)[number];
  locator: string;
}
export const ImportResultView = z.object({
  status: z.enum(["queued", "done"]),
  taskId: z.string().nullable(),
  requestId: z.string().nullable(),
  message: z.string(),
});
export type ImportResultView = z.infer<typeof ImportResultView>;

// ---------------------------------------------------------------------------------------
// Proposed: project docs (spec G.5, K.2 Docs tab)
// ---------------------------------------------------------------------------------------

export const DocView = z.object({
  path: z.string(),
  title: z.string(),
  exists: z.boolean(),
  sizeBytes: z.number().int(),
  updatedAt: z.string().nullable(),
  /** The critic's drift check: the module changed and the doc did not. */
  drift: z.boolean(),
  note: z.string(),
});
export type DocView = z.infer<typeof DocView>;
export const DocList = z.array(DocView);
export const DocContentView = z.object({
  path: z.string(),
  content: z.string(),
  updatedAt: z.string().nullable(),
});
export type DocContentView = z.infer<typeof DocContentView>;

// ---------------------------------------------------------------------------------------
// Proposed: performance (spec D.7, D.19)
// ---------------------------------------------------------------------------------------

export const TARGET_KINDS = ["first_token", "first_audio", "total", "by_task"] as const;

export const PerformanceModeView = z.object({
  mode: z.string(),
  label: z.string(),
  /** 0 when the target is set by the task budget and timeout. */
  targetMs: z.number().int().nonnegative(),
  targetKind: z.enum(TARGET_KINDS),
  samples: z.number().int().nonnegative(),
  ttftP50Ms: z.number().nullable(),
  ttftP95Ms: z.number().nullable(),
  totalP50Ms: z.number().nullable(),
  totalP95Ms: z.number().nullable(),
  /** Share of samples that met the target; null without samples or without a target. */
  withinTargetShare: z.number().min(0).max(1).nullable(),
});
export type PerformanceModeView = z.infer<typeof PerformanceModeView>;

export const PerformanceSampleView = z.object({
  runId: z.string(),
  mode: z.string(),
  specialist: z.string(),
  model: z.string(),
  ttftMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  at: z.string(),
});

export const PerformanceView = z.object({
  generatedAt: z.string(),
  projectId: z.string().nullable(),
  modes: z.array(PerformanceModeView),
  recent: z.array(PerformanceSampleView),
});
export type PerformanceView = z.infer<typeof PerformanceView>;

// ---------------------------------------------------------------------------------------
// Proposed routes
// ---------------------------------------------------------------------------------------

/**
 * Routes the screens need that `DAEMON_ROUTES` does not list yet, in the same notation. When
 * the daemon gains a route of the same name, `proposedPath()` follows the daemon's path and
 * `test/contracts.test.ts` fails if the two disagree.
 */
export const PROPOSED_ROUTES = {
  queue: "GET /projects/:id/queue?status= (QueueItemView[])",
  enqueue: "POST /projects/:id/queue { kind, text, priority? }",
  dismissQueueItem: "POST /queue/:id/dismiss",
  importProject: "POST /projects/:id/import { source, locator } (202 ImportResultView)",
  docs: "GET /projects/:id/docs (DocView[])",
  doc: "GET /projects/:id/docs/:path",
  performance: "GET /performance?projectId= (PerformanceView)",
} as const;
export type ProposedRouteName = keyof typeof PROPOSED_ROUTES;
/** A route the pages may report as missing: proposed here or listed by the daemon. */
export type KnownRouteName = ProposedRouteName | keyof typeof DAEMON_ROUTES;

/** Path with `:param` placeholders filled from a route spec ("VERB /path?query (note)"). */
export function pathFromSpec(spec: string, params: Record<string, string> = {}): string {
  const afterVerb = spec.slice(spec.indexOf(" ") + 1);
  const pathOnly = afterVerb.split(/[ ?]/)[0] ?? afterVerb;
  return pathOnly.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`route: missing param ${name} in ${spec}`);
    return encodeURIComponent(value);
  });
}

/** The verb of a route spec. */
export function verbFromSpec(spec: string): string {
  return spec.slice(0, spec.indexOf(" "));
}

/** The daemon's spec for a route when it has one, else the proposal. */
export function routeSpec(name: KnownRouteName): string {
  const daemon = (DAEMON_ROUTES as Record<string, string>)[name];
  return daemon ?? (PROPOSED_ROUTES as Record<string, string>)[name] ?? `GET /${name}`;
}

export function proposedPath(name: ProposedRouteName, params: Record<string, string> = {}) {
  return pathFromSpec(routeSpec(name), params);
}
