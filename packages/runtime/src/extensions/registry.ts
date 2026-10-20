import {
  type Clock,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
  newId,
} from "@forerunner/platform";
import type { AuditLogRepo, ExtensionRepo, ExtensionRow, JsonObject } from "@forerunner/state";
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
  type McpConnector,
  type McpConnectorFactory,
  secretRefsOf,
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
  type GrantAnswer,
  normalizePermissions,
  PermissionReview,
  parsePermissions,
  ROW_STATUS_ERROR,
  ROW_STATUS_INSTALLED,
  ROW_STATUS_PENDING,
  widens,
} from "./types.ts";

/**
 * The extensions registry behind the Extensions panel (spec K, L). One `extension` row per
 * connector, skill, specialist, capability or model provider. Every change is an audit row
 * and an event. Installing and re-permissioning are "granting a new capability": they go
 * through the approval port and the row stays `pending_approval` until a yes. Disabling or
 * removing revokes run tokens that list the extension's tools and closes its MCP
 * connection at once (live revocation, phase 6 gate).
 */

/** The TokenIssuer's revocation entry point (the kill switch holds the same issuer). */
export interface TokenRevoker {
  revokeWhere(pred: (c: CapabilityClaims) => boolean): string[];
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
  events?: ExtensionEventSink;
  fetch?: FetchLike;
  fetchTimeoutMs?: number;
  /** CHF per USD for the cost column; the billing package supplies the daily rate. */
  chfPerUsd?: () => number;
  /** Cost recorded elsewhere for this extension (a ledger query), added to the row counter. */
  ledgerCost?: (extensionId: string) => Promise<number>;
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

export class ExtensionRegistry {
  private readonly logger = log("extensions");
  private readonly connections = new Map<string, McpConnector>();
  private readonly bridged = new Map<string, BridgedToolSpec[]>();
  private toolIndex: Map<string, string> | null = null;
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

  /** Extension that contributes `toolName`, from the rows' granted tool lists. */
  async lookupTool(toolName: string): Promise<string | undefined> {
    const index = await this.ensureIndex();
    return index.get(toolName);
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
    return c !== undefined && !c.closed;
  }

  // ----- install ---------------------------------------------------------------------------

  async addFromCatalog(catalogId: string, actor: Actor = {}): Promise<ExtensionView> {
    const entry = this.deps.catalog.mustGet(catalogId);
    return this.install(entry, actor, `catalog:${entry.id}`);
  }

  /**
   * Add from a URL: a manifest (one catalog entry, or a catalog with one entry) when the URL
   * serves JSON of that shape, otherwise a streamable-HTTP MCP server at that URL.
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
    if (manifest) return this.install(manifest, actor, url);
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
    return this.install(entry, actor, url);
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

  /** Shared install path: review (connecting for connectors), insert pending, ask the human. */
  async install(entry: CatalogEntry, actor: Actor, sourceUrl: string): Promise<ExtensionView> {
    const existing = await this.deps.extensions.byName(entry.kind, entry.name);
    if (existing) {
      throw new ForerunnerError("validation", `${entry.kind} ${entry.name} is already installed`, {
        details: { extensionId: existing.id },
      });
    }
    const id = newId(this.deps.clock.now());
    let review: PermissionReview;
    if (entry.kind === "connector" && entry.transport) {
      // Discovery: list tools and resources, then close; nothing is callable until the yes.
      const c = await this.deps.connectors.connect({
        extensionId: id,
        name: entry.name,
        transport: entry.transport,
        secrets: this.deps.secrets,
        grantedSecrets: new Set([...entry.permissions.secrets, ...secretRefsOf(entry.transport)]),
      });
      try {
        review = await c.review(entry.permissions);
      } finally {
        await c.close();
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
    const config: ExtensionConfig = ExtensionConfig.parse({
      catalogId: sourceUrl.startsWith("catalog:") ? entry.id : null,
      description: entry.description,
      module: entry.module ?? null,
      transport: entry.transport ?? null,
      review,
      requiresAutonomy: entry.requiresAutonomy ?? null,
    });
    const row = await this.deps.extensions.insert({
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
    this.toolIndex = null;
    await this.audit("extensions.add", row, actor, {
      source: sourceUrl,
      tools: review.permissions.tools,
      secrets: review.permissions.secrets,
      domains: review.permissions.domains,
    });
    this.emit("extension.requested", row, actor, { source: sourceUrl, risk: review.risk });
    const answer = await this.deps.approvals.ask({
      extensionId: row.id,
      name: row.name,
      kind: panelKind(row.kind),
      humanId: actor.humanId ?? null,
      why: `Install ${panelKind(row.kind)} "${row.name}": granting a new capability needs your approval.`,
      review,
      permissions: review.permissions,
      previous: null,
      sourceUrl,
    });
    return this.settle(row.id, answer, actor);
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

  /** The human said yes: apply the pending grant, enable, connect. */
  async approve(id: string, actor: Actor = {}): Promise<ExtensionView> {
    const row = await this.deps.extensions.mustGet(id);
    if (row.status !== ROW_STATUS_PENDING) {
      throw new ForerunnerError("validation", `${row.name} is not waiting for approval`, {
        details: { extensionId: id, status: row.status },
      });
    }
    const cfg = configOf(row);
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
        }),
      });
      await this.audit("extensions.deny", updated, actor, { kept: "previous permissions" });
      this.emit("extension.denied", updated, actor, { kept: "previous permissions" });
    } else {
      await this.deps.extensions.delete(id);
      await this.audit("extensions.deny", row, actor, { removed: true });
      this.emit("extension.denied", row, actor, { removed: true });
    }
    this.toolIndex = null;
  }

  /** Poll the approval port for every pending row and apply answers. */
  async syncApprovals(actor: Actor = {}): Promise<{ approved: string[]; denied: string[] }> {
    const approved: string[] = [];
    const denied: string[] = [];
    const rows = await this.deps.extensions.list({ status: ROW_STATUS_PENDING });
    for (const row of rows) {
      const cfg = configOf(row);
      if (!cfg.pendingRequestId) continue;
      const outcome = await this.deps.approvals.status(cfg.pendingRequestId);
      if (outcome === "approved") {
        await this.approve(row.id, actor);
        approved.push(row.id);
      } else if (outcome === "denied") {
        await this.deny(row.id, actor);
        denied.push(row.id);
      }
    }
    return { approved, denied };
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
   * Change the grant. Narrowing applies at once (tokens that list a removed tool are
   * revoked); widening anything is a new capability grant and waits for a yes.
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
    if (added.length === 0) {
      const removedTools = current.tools.filter((t) => !wanted.tools.includes(t));
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
      config: toJson({ ...cfg, pendingPermissions: wanted, pendingReview }),
    });
    this.toolIndex = null;
    await this.audit("extensions.update_permissions", updated, actor, {
      pending: true,
      added,
      revokedTokens: revoked.length,
    });
    this.emit("extension.requested", updated, actor, { added, revokedTokens: revoked });
    const answer = await this.deps.approvals.ask({
      extensionId: id,
      name: row.name,
      kind: panelKind(row.kind),
      humanId: actor.humanId ?? null,
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

  /** Connect every enabled connector (daemon start). Failures mark the row `error`. */
  async start(): Promise<void> {
    const rows = await this.deps.extensions.list({ enabled: true });
    for (const row of rows) {
      if (!isConnectorKind(row.kind) || row.status !== ROW_STATUS_INSTALLED) continue;
      await this.open(row, {});
    }
  }

  async close(): Promise<void> {
    for (const [id, c] of this.connections) {
      await c.close();
      this.connections.delete(id);
      this.bridged.delete(id);
    }
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
      const review = cfg.review ?? (await c.review());
      this.connections.set(row.id, c);
      this.bridged.set(row.id, c.bridgeTools(review, permissions.tools));
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
    if (c) await c.close();
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

  private async ensureIndex(): Promise<Map<string, string>> {
    if (this.toolIndex) return this.toolIndex;
    const index = new Map<string, string>();
    for (const row of await this.deps.extensions.list()) {
      for (const t of parsePermissions(row.permissions).tools) index.set(t, row.id);
    }
    this.toolIndex = index;
    return index;
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

export function isDenied(e: unknown): boolean {
  return isForerunnerError(e, "approval_required");
}
