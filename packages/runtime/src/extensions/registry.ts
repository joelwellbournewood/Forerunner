import type { ChildProcess } from "node:child_process";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
  newId,
} from "@forerunner/platform";
import {
  type AuditLogRepo,
  type CostLedgerRepo,
  type ExtensionRepo,
  type ExtensionRow,
  isUniqueViolation,
  type JsonObject,
} from "@forerunner/state";
import { z } from "zod";
import type { SecretsPort } from "../enforcement/ports.ts";
import type { CapabilityClaims } from "../enforcement/token.ts";
import {
  type CatalogEntry,
  ConnectorTransport,
  type ExtensionCatalog,
  type FetchLike,
  fetchJson,
  parseCatalog,
  parseCatalogEntry,
} from "./catalog.ts";
import {
  type BridgedToolSpec,
  buildReview,
  describeTransport,
  type McpConnector,
  type McpConnectorFactory,
  ownsToolName,
  secretRefsOf,
  toolPrefixOf,
  withoutSecretRefs,
} from "./mcp.ts";
import {
  type Actor,
  EMPTY_PERMISSIONS,
  type ExtensionApprovalPort,
  type ExtensionEvent,
  type ExtensionEventSink,
  type ExtensionEventType,
  type ExtensionPanelKind,
  type ExtensionPermissions,
  type ExtensionStatus,
  type ExtensionView,
  GRANT_STAGES,
  type GrantAnswer,
  type GrantStage,
  normalizePermissions,
  PermissionReview,
  parsePermissions,
  ROW_STATUS_ERROR,
  ROW_STATUS_INSTALLED,
  ROW_STATUS_PENDING,
  uniq,
  widens,
} from "./types.ts";

/**
 * The extensions registry behind the Extensions panel (spec K, L). One `extension` row per
 * connector, skill, specialist, capability or model provider. Every change is an audit row
 * and an event. Installing and re-permissioning are "granting a new capability": they go
 * through the approval port and the row stays `pending_approval` until a yes. Before the
 * first yes nothing from outside the built-in catalog is started and no secret is resolved
 * (ADR 0016): a connector from a URL or a remote catalog, or one whose discovery without
 * secrets fails, is asked for in two stages (start it once for discovery, then grant its
 * tools). Disabling or removing revokes run tokens that list the extension's tools and
 * closes its MCP connection at once (live revocation, phase 6 gate); connector processes are
 * registered with the kill switch so a global stop kills them too.
 */

/** An enabled row that came from the catalog, with the entry it was installed from. */
export interface EnabledCatalogExtension {
  extensionId: string;
  name: string;
  catalogId: string;
  entry: CatalogEntry;
  /** The permissions in force (what the human granted), never a secret value. */
  permissions: ExtensionPermissions;
}

/** An installed row from the catalog, on or off in the panel, with the entry it was installed from. */
export interface InstalledCatalogExtension extends EnabledCatalogExtension {
  /** On, or switched off by the human (a pending row is not installed and is never listed). */
  enabled: boolean;
}

/** The TokenIssuer's revocation entry point (the kill switch holds the same issuer). */
export interface TokenRevoker {
  revokeWhere(pred: (c: CapabilityClaims) => boolean): string[];
}

/** The kill switch's registration surface (`KillSwitch.register`). */
export interface KillPort {
  register(reg: {
    agentId: string;
    sessionId: string;
    controller?: AbortController;
    child?: ChildProcess;
    label: string;
  }): () => void;
}

/** Agent id connector processes are registered under; `stop("all")` kills them, scoped stops do not. */
export const EXTENSIONS_KILL_AGENT = "extensions";

export function extensionKillSession(extensionId: string): string {
  return `extension:${extensionId}`;
}

export interface ExtensionRegistryDeps {
  extensions: ExtensionRepo;
  audit: Pick<AuditLogRepo, "append">;
  clock: Clock;
  catalog: ExtensionCatalog;
  approvals: ExtensionApprovalPort;
  connectors: McpConnectorFactory;
  secrets: SecretsPort;
  tokens: TokenRevoker;
  /** Connector processes and connections are registered here; a global stop closes them. */
  kill?: KillPort;
  /** Built-in tool names no extension may claim (the daemon's own tools). */
  reservedTools?: () => readonly string[];
  events?: ExtensionEventSink;
  fetch?: FetchLike;
  fetchTimeoutMs?: number;
  /** CHF per USD for the cost column; the billing package supplies the daily rate. */
  chfPerUsd?: () => number;
  /** Cost recorded elsewhere for this extension (a ledger query), added to the row counter. */
  ledgerCost?: (extensionId: string) => Promise<number>;
}

/**
 * `cost_ledger` has no extension column. A capability module that charges through the ledger
 * on behalf of an extension writes `specialist = extension:<id>`; `ledgerCostByExtension`
 * sums those rows for the panel's cost column, on top of the row counter `recordCost` keeps.
 */
export const EXTENSION_COST_KEY_PREFIX = "extension:";

export function extensionCostKey(extensionId: string): string {
  return `${EXTENSION_COST_KEY_PREFIX}${extensionId}`;
}

/** `ExtensionRegistryDeps.ledgerCost` over the cost ledger (micro-USD charged to the extension). */
export function ledgerCostByExtension(
  ledger: Pick<CostLedgerRepo, "breakdown">,
): (extensionId: string) => Promise<number> {
  return async (extensionId) => {
    const key = extensionCostKey(extensionId);
    const buckets = await ledger.breakdown("specialist");
    return buckets.find((b) => b.key === key)?.usd_micro ?? 0;
  };
}

const ExtensionConfig = z
  .object({
    catalogId: z.string().nullable().default(null),
    description: z.string().default(""),
    module: z.string().nullable().default(null),
    transport: ConnectorTransport.nullable().default(null),
    review: PermissionReview.nullable().default(null),
    pendingPermissions: z
      .object({
        tools: z.array(z.string()),
        actionClasses: z.array(z.string()),
        domains: z.array(z.string()),
        paths: z.array(z.string()),
        secrets: z.array(z.string()),
        scopes: z.array(z.string()),
      })
      .nullable()
      .default(null),
    pendingReview: PermissionReview.nullable().default(null),
    pendingRequestId: z.string().nullable().default(null),
    pendingStage: z.enum(GRANT_STAGES).nullable().default(null),
    requiresAutonomy: z.number().int().min(0).max(4).nullable().default(null),
    error: z.string().nullable().default(null),
  })
  .loose();
type ExtensionConfig = z.infer<typeof ExtensionConfig>;

function configOf(row: ExtensionRow): ExtensionConfig {
  const parsed = ExtensionConfig.safeParse(row.config ?? {});
  return parsed.success ? parsed.data : ExtensionConfig.parse({});
}

function toJson(cfg: ExtensionConfig): JsonObject {
  return JSON.parse(JSON.stringify(cfg)) as JsonObject;
}

export function panelKind(kind: string): ExtensionPanelKind {
  if (kind === "mcp_server") return "connector";
  return kind as ExtensionPanelKind;
}

export function isConnectorKind(kind: string): boolean {
  return kind === "connector" || kind === "mcp_server";
}

export function statusOf(row: ExtensionRow): ExtensionStatus {
  if (row.status === ROW_STATUS_PENDING) return "pending_approval";
  if (row.status === ROW_STATUS_ERROR) return "error";
  return row.enabled ? "enabled" : "disabled";
}

/**
 * The tools a grant lets through: `permissions.tools`, minus (for connectors with a review)
 * those whose class is not in `permissions.actionClasses` when that list is non-empty. The
 * gate applies the same rule per call; this is what gets bridged and what revocation tracks.
 */
export function grantedToolNames(
  permissions: ExtensionPermissions,
  review: PermissionReview | null,
): string[] {
  if (!review || permissions.actionClasses.length === 0) return permissions.tools;
  const classOf = new Map(review.tools.map((t) => [t.bridgedName, t.actionClass] as const));
  return permissions.tools.filter((t) => {
    const cls = classOf.get(t);
    return cls === undefined || permissions.actionClasses.includes(cls);
  });
}

interface Connection {
  connector: McpConnector;
  unregister: () => void;
}

interface ToolOwner {
  id: string;
  name: string;
}

export class ExtensionRegistry {
  private readonly logger = log("extensions");
  private readonly connections = new Map<string, Connection>();
  private readonly bridged = new Map<string, BridgedToolSpec[]>();
  private toolIndex: Map<string, ToolOwner> | null = null;
  private readonly listeners = new Set<ExtensionEventSink>();

  constructor(private readonly deps: ExtensionRegistryDeps) {
    if (deps.events) this.listeners.add(deps.events);
  }

  get catalog(): ExtensionCatalog {
    return this.deps.catalog;
  }

  onEvent(listener: ExtensionEventSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ----- reads -----------------------------------------------------------------------------

  async list(filter: { kind?: ExtensionPanelKind } = {}): Promise<ExtensionView[]> {
    const rows = await this.deps.extensions.list(undefined, { orderBy: "name" });
    const out: ExtensionView[] = [];
    for (const r of rows) {
      if (filter.kind && panelKind(r.kind) !== filter.kind) continue;
      out.push(await this.view(r));
    }
    return out;
  }

  async get(id: string): Promise<ExtensionView> {
    return this.view(await this.deps.extensions.mustGet(id));
  }

  /** The raw row (fresh read) for the gate. */
  row(id: string): Promise<ExtensionRow | undefined> {
    return this.deps.extensions.get(id);
  }

  /**
   * The installed rows that came from the catalog, on or off, each with its entry, for a
   * module that follows the panel's choice and must know what the human switched off (the
   * voice preferences read the `voice-*` capabilities, spec O.4: a switched-off cloud row
   * keeps its provider out of the fallback). A pending row, or one whose entry left the
   * catalog, is not listed. A fresh read every time, so a toggle in the panel is seen at the
   * next call.
   */
  async installedCatalogEntries(kind?: ExtensionPanelKind): Promise<InstalledCatalogExtension[]> {
    const rows = await this.deps.extensions.list(
      { status: ROW_STATUS_INSTALLED },
      { orderBy: "name" },
    );
    const out: InstalledCatalogExtension[] = [];
    for (const row of rows) {
      if (kind && panelKind(row.kind) !== kind) continue;
      const catalogId = configOf(row).catalogId;
      const entry = catalogId ? this.deps.catalog.get(catalogId) : undefined;
      if (!catalogId || !entry) continue;
      out.push({
        extensionId: row.id,
        name: row.name,
        catalogId,
        entry,
        enabled: Boolean(row.enabled),
        permissions: parsePermissions(row.permissions),
      });
    }
    return out;
  }

  /** The enabled rows among `installedCatalogEntries`. */
  async enabledCatalogEntries(kind?: ExtensionPanelKind): Promise<EnabledCatalogExtension[]> {
    return (await this.installedCatalogEntries(kind)).filter((e) => e.enabled);
  }

  /** Extension that owns `toolName`, from the rows' granted (and pending) tool lists. */
  async lookupTool(toolName: string): Promise<string | undefined> {
    const index = await this.ensureIndex();
    return index.get(toolName)?.id;
  }

  /** Live bridged ToolSpecs of every connected connector. */
  bridgedTools(): BridgedToolSpec[] {
    return [...this.bridged.values()].flat();
  }

  bridgedTool(name: string): BridgedToolSpec | undefined {
    return this.bridgedTools().find((t) => t.name === name);
  }

  isConnected(id: string): boolean {
    const c = this.connections.get(id);
    return c !== undefined && !c.connector.closed;
  }

  // ----- install ---------------------------------------------------------------------------

  async addFromCatalog(catalogId: string, actor: Actor = {}): Promise<ExtensionView> {
    const entry = this.deps.catalog.mustGet(catalogId);
    return this.install(entry, actor, `catalog:${entry.id}`, this.deps.catalog.isBuiltin(entry.id));
  }

  /**
   * Add from a URL: a manifest (one catalog entry, or a catalog with one entry) when the URL
   * serves JSON of that shape, otherwise a streamable-HTTP MCP server at that URL. Nothing
   * from a URL is started before the human says so.
   */
  async addFromUrl(url: string, actor: Actor = {}): Promise<ExtensionView> {
    if (!/^https?:\/\//i.test(url)) {
      throw new ForerunnerError("validation", "only http(s) URLs can be added");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ForerunnerError("validation", "not a valid URL");
    }
    const manifest = await this.probeManifest(url);
    if (manifest) return this.install(manifest, actor, url, false);
    const host = parsedUrl.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const name = /^[a-z]/.test(host) ? host : `host-${host || "remote"}`;
    const entry = parseCatalogEntry(
      {
        id: `url-${name}`,
        kind: "connector",
        name,
        description: `MCP server at ${url}`,
        version: "",
        transport: { type: "http", url, headers: {} },
        permissions: { ...EMPTY_PERMISSIONS },
      },
      url,
    );
    return this.install(entry, actor, url, false);
  }

  private async probeManifest(url: string): Promise<CatalogEntry | null> {
    let json: unknown;
    try {
      json = await fetchJson(url, { fetch: this.deps.fetch, timeoutMs: this.deps.fetchTimeoutMs });
    } catch (e) {
      // Not a JSON document (an MCP endpoint answers GET with an error): treat as a server URL.
      this.logger.debug("no manifest at url", { url, error: errorMessage(e) });
      return null;
    }
    if (!json || typeof json !== "object") return null;
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      const file = parseCatalog(json, url);
      if (file.entries.length !== 1) {
        throw new ForerunnerError(
          "validation",
          `the document at ${url} is a catalog with ${file.entries.length} entries; set it as the remote catalog (${"FORERUNNER_EXTENSION_CATALOG_URL"}) and add entries by id`,
        );
      }
      return file.entries[0] ?? null;
    }
    if (typeof obj.kind === "string" || typeof obj.transport === "object") {
      return parseCatalogEntry(json, url);
    }
    return null;
  }

  /**
   * Shared install path. `trusted` is true only for built-in catalog entries: those may be
   * started once for discovery before the yes, without any secret (references stripped).
   * Everything else, and a trusted entry whose secret-free discovery fails, is inserted
   * pending at stage `discovery`: the human first allows the start (with the secrets it
   * names), then sees the discovered tools and decides on the grant.
   */
  async install(
    entry: CatalogEntry,
    actor: Actor,
    sourceUrl: string,
    trusted = false,
  ): Promise<ExtensionView> {
    const existing = await this.deps.extensions.byName(entry.kind, entry.name);
    if (existing) throw alreadyInstalled(entry, existing.id);
    const id = newId(this.deps.clock.now());
    const isConnector = entry.kind === "connector" && entry.transport !== undefined;
    let review: PermissionReview;
    let stage: GrantStage = "grant";
    if (isConnector && entry.transport) {
      const discovered = trusted
        ? await this.discoverWithoutSecrets(id, entry.name, entry.transport, entry.permissions)
        : null;
      if (discovered && "review" in discovered) {
        review = discovered.review;
      } else {
        stage = "discovery";
        const refs = uniq([...entry.permissions.secrets, ...secretRefsOf(entry.transport)]);
        review = buildReview({
          extensionName: entry.name,
          transport: entry.transport,
          tools: [],
          resources: [],
          declared: entry.permissions,
          notes: [
            discovered
              ? `not started yet: discovery without secrets failed (${discovered.error})`
              : `not started yet: ${sourceUrl.startsWith("catalog:") ? "remote catalog entry" : "from a URL"}, not a built-in catalog entry`,
            `after your yes the server is started once for discovery${refs.length ? ` with ${refs.map((r) => `secret:${r}`).join(", ")}` : ""}; its tools are then listed for a second approval`,
          ],
        });
      }
    } else {
      review = buildReview({
        extensionName: entry.name,
        transport: null,
        tools: [],
        resources: [],
        declared: entry.permissions,
      });
    }
    await this.assertToolsOwned(
      review.permissions.tools,
      { id, name: entry.name },
      {
        requirePrefix: isConnector || !trusted,
      },
    );
    const config: ExtensionConfig = ExtensionConfig.parse({
      catalogId: sourceUrl.startsWith("catalog:") ? entry.id : null,
      description: entry.description,
      module: entry.module ?? null,
      transport: entry.transport ?? null,
      review,
      pendingStage: stage,
      requiresAutonomy: entry.requiresAutonomy ?? null,
    });
    let row: ExtensionRow;
    try {
      row = await this.deps.extensions.insert({
        id,
        kind: entry.kind,
        name: entry.name,
        ext_version: entry.version,
        enabled: false,
        permissions: review.permissions,
        source_url: sourceUrl,
        status: ROW_STATUS_PENDING,
        config: toJson(config),
        author_human: actor.humanId ?? null,
        author_agent: actor.agentId ?? null,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw alreadyInstalled(entry, null);
      throw e;
    }
    this.toolIndex = null;
    await this.audit("extensions.add", row, actor, {
      source: sourceUrl,
      stage,
      trusted,
      tools: review.permissions.tools,
      secrets: review.permissions.secrets,
      domains: review.permissions.domains,
    });
    this.emit("extension.requested", row, actor, { source: sourceUrl, stage, risk: review.risk });
    const answer = await this.deps.approvals.ask({
      extensionId: row.id,
      name: row.name,
      kind: panelKind(row.kind),
      humanId: actor.humanId ?? null,
      stage,
      why:
        stage === "discovery" && entry.transport
          ? discoveryWhy(row, entry.transport, review.permissions.secrets)
          : installWhy(row),
      review,
      permissions: review.permissions,
      previous: null,
      sourceUrl,
    });
    return this.settle(row.id, answer, actor);
  }

  /** Discovery before the yes: the transport without its secret references, nothing resolved. */
  private async discoverWithoutSecrets(
    id: string,
    name: string,
    transport: ConnectorTransport,
    declared: ExtensionPermissions,
  ): Promise<{ review: PermissionReview } | { error: string }> {
    try {
      const c = await this.deps.connectors.connect({
        extensionId: id,
        name,
        transport: withoutSecretRefs(transport),
        secrets: this.deps.secrets,
        grantedSecrets: new Set(),
      });
      try {
        return { review: await c.review(declared, { transport }) };
      } finally {
        await c.close();
      }
    } catch (e) {
      const error = this.deps.secrets.redact(errorMessage(e));
      this.logger.info("discovery without secrets failed; asking the human first", {
        extension: name,
        error,
      });
      return { error };
    }
  }

  private async settle(id: string, answer: GrantAnswer, actor: Actor): Promise<ExtensionView> {
    if (answer.outcome === "approved") return this.approve(id, actor);
    if (answer.outcome === "denied") {
      await this.deny(id, actor);
      throw new ForerunnerError("approval_required", "the human denied this capability", {
        details: { extensionId: id },
      });
    }
    const row = await this.deps.extensions.mustGet(id);
    const cfg = configOf(row);
    const updated = await this.deps.extensions.update(id, row.version, {
      config: toJson({ ...cfg, pendingRequestId: answer.requestId }),
    });
    return this.view(updated);
  }

  // ----- approval --------------------------------------------------------------------------

  /**
   * The human said yes. At stage `discovery` this starts the server once with the secrets
   * it names, lists its tools and asks for the grant (the row stays pending). At stage
   * `grant` it applies the grant, enables and connects.
   */
  async approve(id: string, actor: Actor = {}): Promise<ExtensionView> {
    const row = await this.deps.extensions.mustGet(id);
    if (row.status !== ROW_STATUS_PENDING) {
      throw new ForerunnerError("validation", `${row.name} is not waiting for approval`, {
        details: { extensionId: id, status: row.status },
      });
    }
    const cfg = configOf(row);
    if (cfg.pendingStage === "discovery") return this.discoverAfterYes(row, cfg, actor);
    const permissions = cfg.pendingPermissions
      ? normalizePermissions(cfg.pendingPermissions as Partial<ExtensionPermissions>)
      : parsePermissions(row.permissions);
    const review = cfg.pendingReview ?? cfg.review;
    let updated = await this.deps.extensions.update(id, row.version, {
      permissions,
      enabled: true,
      status: ROW_STATUS_INSTALLED,
      config: toJson({
        ...cfg,
        review,
        pendingPermissions: null,
        pendingReview: null,
        pendingRequestId: null,
        pendingStage: null,
        error: null,
      }),
      author_human: actor.humanId ?? row.author_human,
    });
    this.toolIndex = null;
    await this.audit("extensions.approve", updated, actor, {
      tools: permissions.tools,
      scopes: permissions.scopes,
    });
    this.emit("extension.approved", updated, actor, { tools: permissions.tools });
    updated = await this.open(updated, actor);
    if (updated.enabled) this.emit("extension.enabled", updated, actor, {});
    return this.view(updated);
  }

  private async discoverAfterYes(
    row: ExtensionRow,
    cfg: ExtensionConfig,
    actor: Actor,
  ): Promise<ExtensionView> {
    if (!cfg.transport) {
      throw new ForerunnerError("validation", `${row.name} has no transport to discover`);
    }
    const declared = parsePermissions(row.permissions);
    const granted = uniq([...declared.secrets, ...secretRefsOf(cfg.transport)]);
    await this.audit("extensions.approve_discovery", row, actor, {
      secrets: granted,
      transport: describeTransport(cfg.transport),
    });
    this.emit("extension.approved", row, actor, { stage: "discovery", secrets: granted });
    let review: PermissionReview;
    try {
      const c = await this.deps.connectors.connect({
        extensionId: row.id,
        name: row.name,
        transport: cfg.transport,
        secrets: this.deps.secrets,
        grantedSecrets: new Set(granted),
      });
      try {
        review = await c.review(declared);
      } finally {
        await c.close();
      }
      await this.assertToolsOwned(
        review.permissions.tools,
        { id: row.id, name: row.name },
        {
          requirePrefix: true,
        },
      );
    } catch (e) {
      const error = this.deps.secrets.redact(errorMessage(e));
      const fresh = await this.deps.extensions.mustGet(row.id);
      const failed = await this.deps.extensions.update(row.id, fresh.version, {
        config: toJson({ ...cfg, error, pendingRequestId: null }),
      });
      this.logger.warn("extension discovery failed", { extension: row.name, error });
      await this.audit("extensions.error", failed, actor, { error, stage: "discovery" });
      this.emit("extension.error", failed, actor, { error, stage: "discovery" });
      if (isForerunnerError(e)) throw e;
      throw new ForerunnerError("unavailable", `discovery of ${row.name} failed: ${error}`, {
        details: { extensionId: row.id },
        retryable: true,
        cause: e,
      });
    }
    const fresh = await this.deps.extensions.mustGet(row.id);
    const updated = await this.deps.extensions.update(row.id, fresh.version, {
      permissions: review.permissions,
      config: toJson({
        ...cfg,
        review,
        pendingStage: "grant",
        pendingRequestId: null,
        error: null,
      }),
    });
    this.toolIndex = null;
    await this.audit("extensions.discovered", updated, actor, {
      tools: review.permissions.tools,
      secrets: review.permissions.secrets,
      domains: review.permissions.domains,
    });
    this.emit("extension.discovered", updated, actor, {
      tools: review.permissions.tools,
      risk: review.risk,
    });
    const answer = await this.deps.approvals.ask({
      extensionId: updated.id,
      name: updated.name,
      kind: panelKind(updated.kind),
      humanId: actor.humanId ?? null,
      stage: "grant",
      why: installWhy(updated),
      review,
      permissions: review.permissions,
      previous: null,
      sourceUrl: updated.source_url,
    });
    return this.settle(updated.id, answer, actor);
  }

  /** The human said no: a fresh install is removed; a re-permissioning keeps the old grant. */
  async deny(id: string, actor: Actor = {}): Promise<void> {
    const row = await this.deps.extensions.mustGet(id);
    if (row.status !== ROW_STATUS_PENDING) {
      throw new ForerunnerError("validation", `${row.name} is not waiting for approval`, {
        details: { extensionId: id, status: row.status },
      });
    }
    const cfg = configOf(row);
    if (cfg.pendingPermissions) {
      const updated = await this.deps.extensions.update(id, row.version, {
        enabled: false,
        status: ROW_STATUS_INSTALLED,
        config: toJson({
          ...cfg,
          pendingPermissions: null,
          pendingReview: null,
          pendingRequestId: null,
          pendingStage: null,
        }),
      });
      await this.audit("extensions.deny", updated, actor, { kept: "previous permissions" });
      this.emit("extension.denied", updated, actor, { kept: "previous permissions" });
    } else {
      await this.deps.extensions.delete(id);
      await this.audit("extensions.deny", row, actor, { removed: true, stage: cfg.pendingStage });
      this.emit("extension.denied", row, actor, { removed: true, stage: cfg.pendingStage });
    }
    this.toolIndex = null;
  }

  /**
   * Poll the approval port for every pending row and apply answers. A yes at stage
   * `discovery` runs discovery and asks again (`discovered`); a yes at stage `grant` enables.
   */
  async syncApprovals(
    actor: Actor = {},
  ): Promise<{ approved: string[]; denied: string[]; discovered: string[] }> {
    const approved: string[] = [];
    const denied: string[] = [];
    const discovered: string[] = [];
    const rows = await this.deps.extensions.list({ status: ROW_STATUS_PENDING });
    for (const row of rows) {
      const cfg = configOf(row);
      if (!cfg.pendingRequestId) continue;
      const outcome = await this.deps.approvals.status(cfg.pendingRequestId);
      if (outcome === "approved") {
        const view = await this.approve(row.id, actor);
        if (view.status === "pending_approval") discovered.push(row.id);
        else approved.push(row.id);
      } else if (outcome === "denied") {
        await this.deny(row.id, actor);
        denied.push(row.id);
      }
    }
    return { approved, denied, discovered };
  }

  // ----- toggle / remove / permissions -----------------------------------------------------

  async toggle(id: string, enabled: boolean, actor: Actor = {}): Promise<ExtensionView> {
    const row = await this.deps.extensions.mustGet(id);
    if (row.status === ROW_STATUS_PENDING) {
      throw new ForerunnerError("approval_required", `${row.name} is waiting for approval`, {
        details: { extensionId: id },
      });
    }
    if (enabled) {
      if (row.enabled && row.status === ROW_STATUS_INSTALLED) return this.view(row);
      const cfg = configOf(row);
      let updated = await this.deps.extensions.update(id, row.version, {
        enabled: true,
        status: ROW_STATUS_INSTALLED,
        config: toJson({ ...cfg, error: null }),
      });
      await this.audit("extensions.enable", updated, actor, {});
      updated = await this.open(updated, actor);
      if (updated.enabled) this.emit("extension.enabled", updated, actor, {});
      this.toolIndex = null;
      return this.view(updated);
    }
    if (!row.enabled) return this.view(row);
    const revoked = await this.revokeLive(row);
    const updated = await this.deps.extensions.update(id, row.version, { enabled: false });
    await this.audit("extensions.disable", updated, actor, { revokedTokens: revoked.length });
    this.emit("extension.disabled", updated, actor, { revokedTokens: revoked });
    this.toolIndex = null;
    return this.view(updated);
  }

  async remove(id: string, actor: Actor = {}): Promise<void> {
    const row = await this.deps.extensions.mustGet(id);
    const revoked = await this.revokeLive(row);
    await this.deps.extensions.delete(id);
    this.toolIndex = null;
    await this.audit("extensions.remove", row, actor, { revokedTokens: revoked.length });
    this.emit("extension.removed", row, actor, { revokedTokens: revoked });
  }

  /**
   * Change the grant. Narrowing applies at once (tokens that list a tool no longer granted,
   * by name or by class, are revoked); widening anything is a new capability grant and
   * waits for a yes. A tool name can only be added when it carries the extension's own
   * prefix and belongs to no other extension or built-in tool.
   */
  async updatePermissions(
    id: string,
    next: Partial<ExtensionPermissions>,
    actor: Actor = {},
  ): Promise<ExtensionView> {
    const row = await this.deps.extensions.mustGet(id);
    if (row.status === ROW_STATUS_PENDING) {
      throw new ForerunnerError("approval_required", `${row.name} already has a pending request`, {
        details: { extensionId: id },
      });
    }
    const current = parsePermissions(row.permissions);
    const wanted = normalizePermissions({ ...current, ...next });
    const cfg = configOf(row);
    const added = widens(current, wanted);
    const addedTools = wanted.tools.filter((t) => !current.tools.includes(t));
    await this.assertToolsOwned(addedTools, { id, name: row.name }, { requirePrefix: true });
    if (added.length === 0) {
      const before = grantedToolNames(current, cfg.review);
      const after = new Set(grantedToolNames(wanted, cfg.review));
      const removedTools = before.filter((t) => !after.has(t));
      const revoked = removedTools.length
        ? this.deps.tokens.revokeWhere((c) => c.allowedTools.some((t) => removedTools.includes(t)))
        : [];
      const review = cfg.review ? { ...cfg.review, permissions: wanted } : null;
      const updated = await this.deps.extensions.update(id, row.version, {
        permissions: wanted,
        config: toJson({ ...cfg, review }),
      });
      this.toolIndex = null;
      await this.audit("extensions.update_permissions", updated, actor, {
        narrowed: true,
        removedTools,
        revokedTokens: revoked.length,
      });
      this.emit("extension.permissions_updated", updated, actor, {
        removedTools,
        revokedTokens: revoked,
      });
      if (updated.enabled && isConnectorKind(updated.kind)) await this.open(updated, actor);
      return this.view(updated);
    }
    const revoked = await this.revokeLive(row);
    const base =
      cfg.review ??
      buildReview({
        extensionName: row.name,
        transport: cfg.transport,
        tools: [],
        resources: [],
        declared: wanted,
      });
    const pendingReview: PermissionReview = {
      ...base,
      permissions: wanted,
      summary: [
        ...base.summary.filter((l) => !l.startsWith("scope: ")),
        ...added.map((a) => `adds ${a}`),
        ...wanted.scopes.map((s) => `scope: ${s}`),
      ],
    };
    const updated = await this.deps.extensions.update(id, row.version, {
      status: ROW_STATUS_PENDING,
      config: toJson({ ...cfg, pendingPermissions: wanted, pendingReview, pendingStage: "grant" }),
    });
    this.toolIndex = null;
    await this.audit("extensions.update_permissions", updated, actor, {
      pending: true,
      added,
      revokedTokens: revoked.length,
    });
    this.emit("extension.requested", updated, actor, {
      added,
      stage: "grant",
      revokedTokens: revoked,
    });
    const answer = await this.deps.approvals.ask({
      extensionId: id,
      name: row.name,
      kind: panelKind(row.kind),
      humanId: actor.humanId ?? null,
      stage: "grant",
      why: `Widen the grant of ${panelKind(row.kind)} "${row.name}" (${added.join(", ")}): granting a new capability needs your approval.`,
      review: pendingReview,
      permissions: wanted,
      previous: current,
      sourceUrl: row.source_url,
    });
    return this.settle(id, answer, actor);
  }

  /** Add to the extension's cost counter (bridged tool calls, capability modules). */
  async recordCost(id: string, usdMicro: number): Promise<void> {
    if (!Number.isFinite(usdMicro) || usdMicro <= 0) return;
    await this.deps.extensions.updateWhere({}, '"id" = ?', [id], {
      set: ['"cost_usd_micro" = "cost_usd_micro" + ?'],
      params: [Math.round(usdMicro)],
    });
  }

  // ----- lifecycle -------------------------------------------------------------------------

  /**
   * Connect every enabled connector that is not connected (daemon start, and after the kill
   * switch is resumed). Failures mark the row `error`.
   */
  async start(): Promise<void> {
    const rows = await this.deps.extensions.list({ enabled: true });
    for (const row of rows) {
      if (!isConnectorKind(row.kind) || row.status !== ROW_STATUS_INSTALLED) continue;
      if (this.isConnected(row.id)) continue;
      await this.open(row, {});
    }
  }

  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.closeConnection(id);
  }

  private async open(row: ExtensionRow, actor: Actor): Promise<ExtensionRow> {
    if (!isConnectorKind(row.kind)) return row;
    const cfg = configOf(row);
    if (!cfg.transport) return this.markError(row, actor, "connector has no transport");
    await this.closeConnection(row.id);
    const permissions = parsePermissions(row.permissions);
    try {
      const c = await this.deps.connectors.connect({
        extensionId: row.id,
        name: row.name,
        transport: cfg.transport,
        secrets: this.deps.secrets,
        grantedSecrets: new Set(permissions.secrets),
      });
      const review = cfg.review ?? (await c.review(permissions));
      const granted = grantedToolNames(permissions, review);
      const entry: Connection = { connector: c, unregister: () => undefined };
      this.connections.set(row.id, entry);
      this.bridged.set(row.id, c.bridgeTools(review, granted, permissions.actionClasses));
      if (this.deps.kill) {
        // Registered like a run: a global stop aborts the controller (we close the client)
        // and kills the server's process tree; a frozen kill switch aborts at once.
        const controller = new AbortController();
        controller.signal.addEventListener(
          "abort",
          () => {
            // after the kill switch's own loop has killed the process tree, close the client
            setTimeout(() => void this.closeConnection(row.id), 0);
          },
          { once: true },
        );
        entry.unregister = this.deps.kill.register({
          agentId: EXTENSIONS_KILL_AGENT,
          sessionId: extensionKillSession(row.id),
          controller,
          child: c.child ?? undefined,
          label: `connector:${row.name}`,
        });
      }
      return row;
    } catch (e) {
      return this.markError(row, actor, this.deps.secrets.redact(errorMessage(e)));
    }
  }

  private async markError(row: ExtensionRow, actor: Actor, error: string): Promise<ExtensionRow> {
    const cfg = configOf(row);
    const fresh = await this.deps.extensions.mustGet(row.id);
    const updated = await this.deps.extensions.update(row.id, fresh.version, {
      enabled: false,
      status: ROW_STATUS_ERROR,
      config: toJson({ ...cfg, error }),
    });
    this.logger.warn("extension error", { extension: row.name, error });
    await this.audit("extensions.error", updated, actor, { error });
    this.emit("extension.error", updated, actor, { error });
    return updated;
  }

  private async closeConnection(id: string): Promise<void> {
    const c = this.connections.get(id);
    this.connections.delete(id);
    this.bridged.delete(id);
    if (!c) return;
    c.unregister();
    await c.connector.close();
  }

  /** Revoke every run token that lists one of the extension's tools and close its connection. */
  private async revokeLive(row: ExtensionRow): Promise<string[]> {
    const tools = new Set(parsePermissions(row.permissions).tools);
    for (const t of this.bridged.get(row.id) ?? []) tools.add(t.name);
    const revoked = tools.size
      ? this.deps.tokens.revokeWhere((c) => c.allowedTools.some((t) => tools.has(t)))
      : [];
    await this.closeConnection(row.id);
    if (revoked.length) {
      this.logger.warn("revoked run tokens", { extension: row.name, tokens: revoked.length });
    }
    return revoked;
  }

  /**
   * Tool name → owning extension, from every row's granted and pending tool lists. The
   * oldest row wins a (legacy) collision; new grants are refused by `assertToolsOwned`.
   */
  private async ensureIndex(): Promise<Map<string, ToolOwner>> {
    if (this.toolIndex) return this.toolIndex;
    const index = new Map<string, ToolOwner>();
    for (const row of await this.deps.extensions.list(undefined, { orderBy: "created_at" })) {
      const cfg = configOf(row);
      const names = [
        ...parsePermissions(row.permissions).tools,
        ...(cfg.pendingPermissions?.tools ?? []),
      ];
      for (const t of names) if (!index.has(t)) index.set(t, { id: row.id, name: row.name });
    }
    this.toolIndex = index;
    return index;
  }

  /**
   * A grant may name a tool only when no other extension owns it, it is not a built-in tool
   * (`reservedTools`), and, for connectors and anything not from the built-in catalog, it
   * starts with the extension's own prefix (`<name>.`) so a manifest cannot shadow or
   * re-ceiling another extension's tools.
   */
  private async assertToolsOwned(
    tools: readonly string[],
    owner: ToolOwner,
    opts: { requirePrefix: boolean },
  ): Promise<void> {
    if (tools.length === 0) return;
    const reserved = new Set(this.deps.reservedTools?.() ?? []);
    const index = await this.ensureIndex();
    for (const t of tools) {
      if (reserved.has(t)) {
        throw new ForerunnerError(
          "validation",
          `tool ${t} is a built-in tool; ${owner.name} cannot claim it`,
          {
            details: { tool: t, extensionId: owner.id },
          },
        );
      }
      const other = index.get(t);
      if (other && other.id !== owner.id) {
        throw new ForerunnerError(
          "validation",
          `tool ${t} already belongs to extension ${other.name}; ${owner.name} cannot claim it`,
          { details: { tool: t, extensionId: owner.id, ownerExtensionId: other.id } },
        );
      }
      if (opts.requirePrefix && !ownsToolName(owner.name, t)) {
        throw new ForerunnerError(
          "validation",
          `tool ${t} must start with ${toolPrefixOf(owner.name)} (the extension's own name)`,
          { details: { tool: t, extensionId: owner.id } },
        );
      }
    }
  }

  // ----- views, audit, events --------------------------------------------------------------

  async view(row: ExtensionRow): Promise<ExtensionView> {
    const cfg = configOf(row);
    let extra = 0;
    if (this.deps.ledgerCost) {
      try {
        extra = await this.deps.ledgerCost(row.id);
      } catch (e) {
        this.logger.debug("ledger cost lookup failed", { error: errorMessage(e) });
      }
    }
    const usdMicro = row.cost_usd_micro + extra;
    const rate = this.deps.chfPerUsd?.() ?? 0;
    return {
      id: row.id,
      name: row.name,
      kind: panelKind(row.kind),
      status: statusOf(row),
      enabled: row.enabled,
      description: cfg.description,
      permissions: parsePermissions(row.permissions),
      pendingPermissions: cfg.pendingPermissions
        ? normalizePermissions(cfg.pendingPermissions as Partial<ExtensionPermissions>)
        : null,
      pendingStage: row.status === ROW_STATUS_PENDING ? (cfg.pendingStage ?? "grant") : null,
      review: cfg.pendingReview ?? cfg.review,
      cost: { usdMicro, chfMicro: Math.round(usdMicro * rate) },
      version: row.ext_version,
      source: row.source_url,
      installedAt: row.created_at,
      updatedAt: row.updated_at,
      rowVersion: row.version,
      error: cfg.error,
      connected: this.isConnected(row.id),
    };
  }

  private async audit(
    op: string,
    row: ExtensionRow,
    actor: Actor,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.append({
      tool: op,
      allowed: true,
      human_id: actor.humanId ?? null,
      agent_id: actor.agentId ?? null,
      input_summary: JSON.stringify({
        extensionId: row.id,
        name: row.name,
        kind: panelKind(row.kind),
      }),
      result_summary: JSON.stringify({ status: statusOf(row), ...detail }).slice(0, 1000),
      occurred_at: this.deps.clock.nowIso(),
      author_human: actor.humanId ?? null,
      author_agent: actor.agentId ?? null,
    });
  }

  private emit(
    type: ExtensionEventType,
    row: ExtensionRow,
    actor: Actor,
    detail: Record<string, unknown>,
  ): void {
    const event: ExtensionEvent = {
      type,
      extensionId: row.id,
      name: row.name,
      kind: panelKind(row.kind),
      at: this.deps.clock.nowIso(),
      by: { humanId: actor.humanId ?? null, agentId: actor.agentId ?? null },
      detail,
    };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        this.logger.debug("event listener failed", { error: errorMessage(e) });
      }
    }
  }
}

function alreadyInstalled(entry: CatalogEntry, extensionId: string | null): ForerunnerError {
  return new ForerunnerError("validation", `${entry.kind} ${entry.name} is already installed`, {
    details: { extensionId },
  });
}

function installWhy(row: ExtensionRow): string {
  return `Install ${panelKind(row.kind)} "${row.name}": granting a new capability needs your approval.`;
}

function discoveryWhy(row: ExtensionRow, transport: ConnectorTransport, secrets: string[]): string {
  const using = secrets.length ? `, using ${secrets.map((s) => `secret:${s}`).join(", ")}` : "";
  return `Start ${panelKind(row.kind)} "${row.name}" once for discovery (${describeTransport(transport)}${using}): it lists its tools for a second approval; nothing is granted yet.`;
}

export function isDenied(e: unknown): boolean {
  return isForerunnerError(e, "approval_required");
}
