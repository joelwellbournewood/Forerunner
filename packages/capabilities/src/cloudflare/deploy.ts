/**
 * Cloudflare deploys with the autonomy rules in code (spec J: "3 Trusted: also ... deploys to
 * staging"; "4 Autopilot: everything except destructive, financial and credential actions";
 * Security: "spending real money" always needs a human). Every method resolves the scope it
 * touches (reads only), decides with `decideAutonomy`, asks the approval port when needed,
 * asks again, one answer per action, for anything that creates a paid resource or changes a
 * plan, and only then sends writes. Every outward action appends an audit row with the scope.
 *
 * Staging and production: a Worker deploys to `<name><staging_suffix>` for staging and to
 * `<name>` for production; a Pages deploy goes to the preview branch named in the settings
 * for staging and to the project's production branch for production. DNS records are live for
 * the whole zone, so a DNS upsert is a production action. See docs/maintainers/cloudflare.md
 * and ADR 0035.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  type Clock,
  extname,
  ForerunnerError,
  isInside,
  join,
  type Logger,
  log,
  relative,
  resolve,
  toPosix,
} from "@forerunner/platform";
import {
  type ActionClass,
  ALWAYS_HUMAN,
  type AutonomyDecision,
  type AutonomyLevel,
  decideAutonomy,
} from "@forerunner/runtime";
import type { NewAuditLog } from "@forerunner/state";
import type { CloudflareApprovalPort, DeployEnv } from "./approvals.ts";
import {
  type CloudflareClient,
  type DnsRecordInfo,
  type DnsRecordInput,
  normaliseHost,
  type PagesAssetUpload,
  type TokenVerification,
  type WorkerBinding,
  type ZoneInfo,
} from "./client.ts";
import type { CloudflareScope, CloudflareSettings } from "./settings.ts";

// ---------------------------------------------------------------------------------------------
// Requests, plans and outcomes

/** Who deploys, under which autonomy, for which tool call (approvals key on it). */
export interface DeployActor {
  runId: string;
  sessionId: string;
  agentId: string;
  humanId: string;
  projectId?: string;
  taskId?: string;
  autonomy: AutonomyLevel;
  planApproved?: boolean;
  /** The tool call this deploy serves; the hooks' answer for it is reused when it matches. */
  tool?: { name: string; input: unknown };
  /**
   * The hooks' approval key for that tool call (`ToolExecutionContext.approvalKey`, computed
   * on the input before secret references were resolved). Passed on as the approval's `key`
   * so the hooks' row matches although `tool.input` carries resolved values.
   */
  approvalKey?: string;
  /**
   * The hooks' display copy of that tool call's input (`ToolExecutionContext.approvalInput`,
   * secret references unresolved). Passed on as the approval's `displayInput`: a card the port
   * files itself shows it, never `tool.input`, which carries resolved secret values.
   */
  approvalInput?: unknown;
}

export interface WorkerDeployRequest {
  env: DeployEnv;
  /** Worker name; staging appends the settings' suffix. */
  name: string;
  /** ES module source. */
  script: string;
  mainModule?: string;
  bindings?: WorkerBinding[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** Route hosts; each must lie inside a configured zone. */
  hosts?: string[];
  /** Path pattern appended to each host for the route; default `/*`. */
  routePath?: string;
  /** Durable Object migrations: creates paid resources, always asks a human. */
  migrations?: Record<string, unknown>;
  /** Paid feature, always asks a human. */
  logpush?: boolean;
  /** Billing change, always asks a human. */
  usageModel?: string;
}

export interface PagesDeployRequest {
  env: DeployEnv;
  project: string;
  /** Absolute path of the built site. Symlinks are skipped. */
  directory: string;
  /** Hosts the site serves; checked against the configured zones, not changed. */
  hosts?: string[];
}

export interface DnsUpsertRequest {
  /** When absent the zone is found by the record name. */
  zoneId?: string;
  record: DnsRecordInput;
}

export interface ZonePlanChangeRequest {
  zoneId: string;
  planId: string;
}

export type PlanRequest =
  | ({ kind: "worker" } & WorkerDeployRequest)
  | ({ kind: "pages" } & PagesDeployRequest)
  | ({ kind: "dns" } & DnsUpsertRequest)
  | ({ kind: "zone_plan" } & ZonePlanChangeRequest);

export type DeployOperation = "deploy_worker" | "deploy_pages" | "dns_upsert" | "change_plan";

export interface PlanChange {
  resource: "worker_script" | "worker_route" | "pages_deployment" | "dns_record" | "zone_plan";
  action: "create" | "update" | "unchanged";
  target: string;
  detail?: string;
}

export interface DeployPlan {
  operation: DeployOperation;
  env: DeployEnv | null;
  scope: string;
  actionClass: ActionClass;
  /** What the autonomy rules say for this actor, before any paid resource is considered. */
  decision: AutonomyDecision;
  /** Paid resources or plan changes: a human answers for each action at every level. */
  paid: string[];
  changes: PlanChange[];
}

export type DeployOutcome =
  | {
      status: "done";
      operation: DeployOperation;
      env: DeployEnv | null;
      scope: string;
      summary: string;
      result: Record<string, unknown>;
    }
  | {
      status: "awaiting_approval";
      operation: DeployOperation;
      env: DeployEnv | null;
      scope: string;
      actionClass: ActionClass;
      why: string;
    };

/** Structurally satisfied by `AuditLogRepo`. */
export interface CloudflareAuditPort {
  append(row: NewAuditLog): Promise<unknown>;
}

export interface CloudflareDeployerDeps {
  client: CloudflareClient;
  settings: Pick<CloudflareSettings, "workers" | "pages">;
  approvals: CloudflareApprovalPort;
  audit?: CloudflareAuditPort;
  clock: Clock;
  logger?: Logger;
  /** Asset key for a Pages file; default sha256 of the content and extension, 32 hex chars. */
  hashAsset?: (content: Buffer, relPath: string) => string;
}

/** Pages direct upload limits (Cloudflare's documented ones). */
export const PAGES_MAX_FILES = 20_000;
export const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Files per upload request and bytes per request. */
export const PAGES_UPLOAD_BUCKET_FILES = 100;
export const PAGES_UPLOAD_BUCKET_BYTES = 20 * 1024 * 1024;

export const DEFAULT_ROUTE_PATH = "/*";

export function scopeLabel(scope: CloudflareScope, zoneIds: readonly string[] = []): string {
  const zones = [...new Set(zoneIds)].sort();
  return zones.length
    ? `account:${scope.accountId} ${zones.map((z) => `zone:${z}`).join(" ")}`
    : `account:${scope.accountId}`;
}

/** Worker features that create a paid resource or change billing (spec: always a human). */
export function paidWorkerFeatures(
  req: Pick<WorkerDeployRequest, "migrations" | "logpush" | "usageModel">,
): string[] {
  const paid: string[] = [];
  if (req.migrations && Object.keys(req.migrations).length > 0)
    paid.push("Durable Object migrations (creates Durable Object classes, a paid resource)");
  if (req.logpush === true) paid.push("Workers Logpush (paid feature)");
  if (req.usageModel) paid.push(`usage model "${req.usageModel}" (billing change)`);
  return paid;
}

export function defaultHashAsset(content: Buffer, relPath: string): string {
  return createHash("sha256").update(content).update(extname(relPath)).digest("hex").slice(0, 32);
}

/** Digest of a Worker script for approval cards and audit rows (never the source). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function contentTypeOf(relPath: string): string {
  const ext = extname(relPath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".wasm": "application/wasm",
  };
  return types[ext] ?? "application/octet-stream";
}

export interface PagesFile {
  /** Posix path with a leading slash, the manifest key. */
  path: string;
  absPath: string;
  size: number;
  hash: string;
}

/**
 * Walks a built site. Symlinks are skipped (never followed), every file must lie inside the
 * directory, and the Pages limits are enforced before any request.
 */
export function collectPagesFiles(
  directory: string,
  hashAsset: (content: Buffer, relPath: string) => string = defaultHashAsset,
): PagesFile[] {
  const root = resolve(directory);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new ForerunnerError("not_found", `Pages directory does not exist: ${directory}`);
  }
  if (!rootStat.isDirectory()) {
    throw new ForerunnerError("validation", `Pages directory is not a directory: ${directory}`);
  }
  const files: PagesFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!isInside(root, abs)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = lstatSync(abs).size;
      if (size > PAGES_MAX_FILE_BYTES) {
        throw new ForerunnerError(
          "validation",
          `Pages file exceeds ${PAGES_MAX_FILE_BYTES} bytes: ${relative(root, abs)}`,
          { details: { file: relative(root, abs), size } },
        );
      }
      const rel = `/${toPosix(relative(root, abs))}`;
      files.push({ path: rel, absPath: abs, size, hash: hashAsset(readFileSync(abs), rel) });
      if (files.length > PAGES_MAX_FILES) {
        throw new ForerunnerError("validation", `Pages deploy exceeds ${PAGES_MAX_FILES} files`);
      }
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------------------------
// Deployer

type GateResult =
  | { ok: true }
  | { ok: false; outcome: Extract<DeployOutcome, { status: "awaiting_approval" }> };

interface GateInput {
  operation: DeployOperation;
  actionClass: ActionClass;
  env: DeployEnv | null;
  scope: string;
  why: string;
  /** Paid resources this action creates; each deploy asks once for all of them. */
  paid: string[];
  /**
   * Summary used as the approval input when the actor has no tool call. Never the script
   * source: a length and a sha256 instead, so the card stays small and a changed script
   * still asks again (the approval key hashes this input).
   */
  request: unknown;
}

export class CloudflareDeployer {
  private readonly logger: Logger;
  private readonly hashAsset: (content: Buffer, relPath: string) => string;

  constructor(private readonly deps: CloudflareDeployerDeps) {
    this.logger = deps.logger ?? log("cloudflare:deploy");
    this.hashAsset = deps.hashAsset ?? defaultHashAsset;
  }

  get client(): CloudflareClient {
    return this.deps.client;
  }

  get scope(): CloudflareScope {
    return this.deps.client.scope;
  }

  /** `account:<id> zone:<id> ...` for audit rows and approval cards. */
  scopeLabel(zoneIds: readonly string[] = []): string {
    return scopeLabel(this.scope, zoneIds);
  }

  // -- token ----------------------------------------------------------------------------------

  async verifyToken(actor: DeployActor): Promise<TokenVerification> {
    try {
      const v = await this.deps.client.verifyToken();
      await this.record(
        actor,
        "cloudflare.verify_token",
        true,
        { scope: this.scopeLabel() },
        {
          status: v.status,
          scopes: v.scopes,
          warnings: v.warnings,
        },
      );
      return v;
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.verify_token", { scope: this.scopeLabel() }, e);
      throw e;
    }
  }

  // -- plan (dry run) -------------------------------------------------------------------------

  /** Lists what a deploy would change. Reads only; nothing is written and nobody is asked. */
  async plan(req: PlanRequest, actor: DeployActor): Promise<DeployPlan> {
    const ctx = { level: actor.autonomy, planApproved: actor.planApproved };
    switch (req.kind) {
      case "worker": {
        const w = await this.resolveWorker(req);
        const changes: PlanChange[] = [];
        const existing = await this.deps.client.listWorkerScripts();
        changes.push({
          resource: "worker_script",
          action: existing.some((s) => s.id === w.scriptName) ? "update" : "create",
          target: w.scriptName,
          detail: `${req.script.length} chars, ${req.bindings?.length ?? 0} binding(s)`,
        });
        for (const route of w.routes) {
          const current = await this.deps.client.listWorkerRoutes(route.zone.id);
          const same = current.find((r) => r.pattern === route.pattern);
          changes.push({
            resource: "worker_route",
            action: !same ? "create" : same.script === w.scriptName ? "unchanged" : "update",
            target: route.pattern,
            detail: `zone ${route.zone.name}`,
          });
        }
        const actionClass = classOf(req.env);
        return {
          operation: "deploy_worker",
          env: req.env,
          scope: w.scope,
          actionClass,
          decision: decideAutonomy(actionClass, ctx),
          paid: paidWorkerFeatures(req),
          changes,
        };
      }
      case "pages": {
        const p = await this.resolvePages(req);
        const actionClass = classOf(req.env);
        const bytes = p.files.reduce((s, f) => s + f.size, 0);
        return {
          operation: "deploy_pages",
          env: req.env,
          scope: p.scope,
          actionClass,
          decision: decideAutonomy(actionClass, ctx),
          paid: [],
          changes: [
            {
              resource: "pages_deployment",
              action: "create",
              target: `${req.project}@${p.branch}`,
              detail: `${p.files.length} file(s), ${bytes} bytes; missing assets are negotiated at deploy`,
            },
          ],
        };
      }
      case "dns": {
        const d = await this.resolveDns(req);
        return {
          operation: "dns_upsert",
          env: null,
          scope: d.scope,
          actionClass: "deploy_production",
          decision: decideAutonomy("deploy_production", ctx),
          paid: [],
          changes: [d.change],
        };
      }
      case "zone_plan": {
        const zone = await this.deps.client.getZone(req.zoneId);
        return {
          operation: "change_plan",
          env: null,
          scope: this.scopeLabel([zone.id]),
          actionClass: "financial",
          decision: decideAutonomy("financial", ctx),
          paid: [`zone ${zone.name} plan change to ${req.planId}`],
          changes: [
            {
              resource: "zone_plan",
              action: zone.plan?.id === req.planId ? "unchanged" : "update",
              target: zone.name,
              detail: `${zone.plan?.id ?? "unknown"} -> ${req.planId}`,
            },
          ],
        };
      }
    }
  }

  // -- workers --------------------------------------------------------------------------------

  async deployWorker(req: WorkerDeployRequest, actor: DeployActor): Promise<DeployOutcome> {
    const w = await this.resolveWorker(req);
    const gate = await this.gate(actor, {
      operation: "deploy_worker",
      actionClass: classOf(req.env),
      env: req.env,
      scope: w.scope,
      why: `deploy Worker ${w.scriptName} to ${req.env}`,
      paid: paidWorkerFeatures(req),
      request: {
        name: req.name,
        env: req.env,
        hosts: req.hosts ?? [],
        scriptChars: req.script.length,
        scriptSha256: sha256Hex(req.script),
      },
    });
    if (!gate.ok) return gate.outcome;

    const auditInput = { scope: w.scope, env: req.env, script: w.scriptName };
    let script: Awaited<ReturnType<CloudflareClient["uploadWorkerScript"]>>;
    try {
      script = await this.deps.client.uploadWorkerScript(w.scriptName, {
        script: req.script,
        mainModule: req.mainModule,
        bindings: req.bindings,
        compatibilityDate: req.compatibilityDate,
        compatibilityFlags: req.compatibilityFlags,
        migrations: req.migrations,
        logpush: req.logpush,
        usageModel: req.usageModel,
      });
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.deploy_worker", auditInput, e);
      throw e;
    }
    await this.record(actor, "cloudflare.deploy_worker", true, auditInput, {
      etag: script.etag,
      modifiedOn: script.modifiedOn,
    });

    const routes: { pattern: string; zoneId: string; action: PlanChange["action"] }[] = [];
    for (const route of w.routes) {
      const input = { scope: this.scopeLabel([route.zone.id]), pattern: route.pattern };
      try {
        const current = await this.deps.client.listWorkerRoutes(route.zone.id);
        const same = current.find((r) => r.pattern === route.pattern);
        if (same && same.script === w.scriptName) {
          routes.push({ pattern: route.pattern, zoneId: route.zone.id, action: "unchanged" });
          continue;
        }
        if (same) {
          await this.deps.client.updateWorkerRoute(
            route.zone.id,
            same.id,
            route.pattern,
            w.scriptName,
          );
          routes.push({ pattern: route.pattern, zoneId: route.zone.id, action: "update" });
        } else {
          await this.deps.client.createWorkerRoute(route.zone.id, route.pattern, w.scriptName);
          routes.push({ pattern: route.pattern, zoneId: route.zone.id, action: "create" });
        }
        await this.record(actor, "cloudflare.worker_route", true, input, {
          script: w.scriptName,
          action: routes[routes.length - 1]?.action,
        });
      } catch (e) {
        await this.recordFailure(actor, "cloudflare.worker_route", input, e);
        throw e;
      }
    }
    const summary = `deployed Worker ${w.scriptName} to ${req.env}${
      routes.length ? ` on ${routes.map((r) => `${r.pattern} (${r.action})`).join(", ")}` : ""
    }`;
    this.logger.info("worker deployed", { script: w.scriptName, env: req.env, scope: w.scope });
    return {
      status: "done",
      operation: "deploy_worker",
      env: req.env,
      scope: w.scope,
      summary,
      result: { script: w.scriptName, etag: script.etag, routes },
    };
  }

  // -- pages ----------------------------------------------------------------------------------

  async deployPages(req: PagesDeployRequest, actor: DeployActor): Promise<DeployOutcome> {
    const p = await this.resolvePages(req);
    const gate = await this.gate(actor, {
      operation: "deploy_pages",
      actionClass: classOf(req.env),
      env: req.env,
      scope: p.scope,
      why: `deploy Pages project ${req.project} to ${req.env} (branch ${p.branch})`,
      paid: [],
      request: { project: req.project, env: req.env, files: p.files.length },
    });
    if (!gate.ok) return gate.outcome;

    const auditInput = { scope: p.scope, env: req.env, project: req.project, branch: p.branch };
    const manifest: Record<string, string> = {};
    for (const f of p.files) manifest[f.path] = f.hash;
    const hashes = [...new Set(p.files.map((f) => f.hash))];
    let uploaded = 0;
    try {
      const jwt = await this.deps.client.createPagesUploadToken(req.project);
      const missing = new Set(await this.deps.client.checkMissingPagesAssets(jwt, hashes));
      const seen = new Set<string>();
      let bucket: PagesAssetUpload[] = [];
      let bucketBytes = 0;
      const flush = async () => {
        if (bucket.length === 0) return;
        await this.deps.client.uploadPagesAssets(jwt, bucket);
        uploaded += bucket.length;
        bucket = [];
        bucketBytes = 0;
      };
      for (const f of p.files) {
        if (!missing.has(f.hash) || seen.has(f.hash)) continue;
        seen.add(f.hash);
        if (
          bucket.length >= PAGES_UPLOAD_BUCKET_FILES ||
          bucketBytes + f.size > PAGES_UPLOAD_BUCKET_BYTES
        )
          await flush();
        bucket.push({
          key: f.hash,
          value: readFileSync(f.absPath).toString("base64"),
          contentType: contentTypeOf(f.path),
        });
        bucketBytes += f.size;
      }
      await flush();
      await this.deps.client.upsertPagesAssetHashes(jwt, hashes);
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.pages_upload", { ...auditInput, uploaded }, e);
      throw e;
    }
    await this.record(actor, "cloudflare.pages_upload", true, auditInput, {
      uploaded,
      total: p.files.length,
    });
    let deployment: Awaited<ReturnType<CloudflareClient["createPagesDeployment"]>>;
    try {
      deployment = await this.deps.client.createPagesDeployment(req.project, manifest, p.branch);
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.deploy_pages", auditInput, e);
      throw e;
    }
    await this.record(actor, "cloudflare.deploy_pages", true, auditInput, {
      deploymentId: deployment.id,
      url: deployment.url,
      environment: deployment.environment,
    });
    this.logger.info("pages deployed", { project: req.project, env: req.env, scope: p.scope });
    return {
      status: "done",
      operation: "deploy_pages",
      env: req.env,
      scope: p.scope,
      summary: `deployed Pages project ${req.project} to ${req.env} (branch ${p.branch}, ${uploaded} of ${p.files.length} file(s) uploaded)${deployment.url ? `: ${deployment.url}` : ""}`,
      result: {
        deploymentId: deployment.id,
        url: deployment.url,
        environment: deployment.environment,
        branch: p.branch,
        uploaded,
        total: p.files.length,
      },
    };
  }

  // -- dns ------------------------------------------------------------------------------------

  async dnsUpsert(req: DnsUpsertRequest, actor: DeployActor): Promise<DeployOutcome> {
    const d = await this.resolveDns(req);
    const gate = await this.gate(actor, {
      operation: "dns_upsert",
      actionClass: "deploy_production",
      env: null,
      scope: d.scope,
      why: `${d.change.action} DNS ${d.record.type} record ${d.record.name} in zone ${d.zone.name}`,
      paid: [],
      request: { zoneId: d.zone.id, record: d.record },
    });
    if (!gate.ok) return gate.outcome;

    const auditInput = {
      scope: d.scope,
      type: d.record.type,
      name: d.record.name,
      action: d.change.action,
    };
    let record: DnsRecordInfo;
    try {
      if (d.change.action === "unchanged" && d.existing) {
        record = d.existing;
      } else if (d.existing) {
        record = await this.deps.client.updateDnsRecord(d.zone.id, d.existing.id, d.record);
      } else {
        record = await this.deps.client.createDnsRecord(d.zone.id, d.record);
      }
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.dns_upsert", auditInput, e);
      throw e;
    }
    await this.record(actor, "cloudflare.dns_upsert", true, auditInput, {
      id: record.id,
      content: record.content,
    });
    return {
      status: "done",
      operation: "dns_upsert",
      env: null,
      scope: d.scope,
      summary: `${d.change.action} ${d.record.type} ${d.record.name} -> ${d.record.content} (zone ${d.zone.name})`,
      result: { action: d.change.action, record },
    };
  }

  // -- money ----------------------------------------------------------------------------------

  /** Changes a zone's plan: real money, a human answers for this one action at every level. */
  async changeZonePlan(req: ZonePlanChangeRequest, actor: DeployActor): Promise<DeployOutcome> {
    const zone = await this.deps.client.getZone(req.zoneId);
    const scope = this.scopeLabel([zone.id]);
    const gate = await this.gate(actor, {
      operation: "change_plan",
      actionClass: "financial",
      env: null,
      scope,
      why: `change the plan of zone ${zone.name} to ${req.planId}`,
      paid: [`zone ${zone.name} plan change to ${req.planId}`],
      request: { zoneId: zone.id, planId: req.planId },
    });
    if (!gate.ok) return gate.outcome;
    const auditInput = { scope, planId: req.planId };
    let result: { id: string; planId: string };
    try {
      result = await this.deps.client.changeZonePlan(zone.id, req.planId, {
        moneyApproved: true,
      });
    } catch (e) {
      await this.recordFailure(actor, "cloudflare.change_plan", auditInput, e);
      throw e;
    }
    await this.record(actor, "cloudflare.change_plan", true, auditInput, result);
    return {
      status: "done",
      operation: "change_plan",
      env: null,
      scope,
      summary: `changed the plan of zone ${zone.name} to ${result.planId}`,
      result: { ...result },
    };
  }

  // -- resolution (reads only) ----------------------------------------------------------------

  private async resolveWorker(req: WorkerDeployRequest): Promise<{
    scriptName: string;
    routes: { zone: ZoneInfo; pattern: string }[];
    scope: string;
  }> {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(req.name)) {
      throw new ForerunnerError("validation", `not a Worker name: ${req.name.slice(0, 80)}`);
    }
    if (!req.script) throw new ForerunnerError("validation", "Worker script is empty");
    const routePath = req.routePath ?? DEFAULT_ROUTE_PATH;
    if (!routePath.startsWith("/")) {
      throw new ForerunnerError("validation", "route path must start with /");
    }
    const scriptName =
      req.env === "staging" ? `${req.name}${this.deps.settings.workers.staging_suffix}` : req.name;
    const routes: { zone: ZoneInfo; pattern: string }[] = [];
    for (const host of req.hosts ?? []) {
      const zone = await this.deps.client.zoneForHost(host);
      routes.push({ zone, pattern: `${normaliseHost(host)}${routePath}` });
    }
    return {
      scriptName,
      routes,
      scope: this.scopeLabel(routes.map((r) => r.zone.id)),
    };
  }

  private async resolvePages(req: PagesDeployRequest): Promise<{
    branch: string;
    files: PagesFile[];
    scope: string;
  }> {
    const project = await this.deps.client.getPagesProject(req.project);
    if (!project) {
      throw new ForerunnerError(
        "not_found",
        `Pages project ${req.project} does not exist in this account; a human creates it first`,
        { details: { project: req.project } },
      );
    }
    const branch =
      req.env === "production" ? project.productionBranch : this.deps.settings.pages.staging_branch;
    if (req.env === "staging" && branch === project.productionBranch) {
      throw new ForerunnerError(
        "validation",
        `staging branch ${branch} is the production branch of ${req.project}; a staging deploy would go live`,
        { details: { project: req.project, branch } },
      );
    }
    const zoneIds: string[] = [];
    for (const host of req.hosts ?? []) zoneIds.push((await this.deps.client.zoneForHost(host)).id);
    const files = collectPagesFiles(req.directory, this.hashAsset);
    if (files.length === 0) {
      throw new ForerunnerError("validation", `Pages directory is empty: ${req.directory}`);
    }
    return { branch, files, scope: this.scopeLabel(zoneIds) };
  }

  private async resolveDns(req: DnsUpsertRequest): Promise<{
    zone: ZoneInfo;
    record: DnsRecordInput;
    existing: DnsRecordInfo | null;
    change: PlanChange;
    scope: string;
  }> {
    const name = normaliseHost(req.record.name);
    const zone = req.zoneId
      ? await this.deps.client.getZone(req.zoneId)
      : await this.deps.client.zoneForHost(name);
    if (name !== zone.name && !name.endsWith(`.${zone.name}`)) {
      throw new ForerunnerError(
        "domain_not_allowed",
        `record ${name} is not inside zone ${zone.name}`,
        { details: { name, zone: zone.name } },
      );
    }
    const record: DnsRecordInput = { ...req.record, name };
    const current = await this.deps.client.listDnsRecords(zone.id, {
      type: record.type,
      name,
    });
    const existing = current.find((r) => r.type === record.type && r.name === name) ?? null;
    let action: PlanChange["action"] = "create";
    if (existing) {
      const sameTtl = record.ttl === undefined || record.ttl === existing.ttl;
      const sameProxied = record.proxied === undefined || record.proxied === existing.proxied;
      const samePriority = record.priority === undefined || record.priority === existing.priority;
      action =
        existing.content === record.content && sameTtl && sameProxied && samePriority
          ? "unchanged"
          : "update";
    }
    return {
      zone,
      record,
      existing,
      change: {
        resource: "dns_record",
        action,
        target: `${record.type} ${name}`,
        detail: existing ? `${existing.content} -> ${record.content}` : `-> ${record.content}`,
      },
      scope: this.scopeLabel([zone.id]),
    };
  }

  // -- the gate -------------------------------------------------------------------------------

  /**
   * Autonomy first (one answer per tool call, reused), then money (one answer per action,
   * never reused), so a pending production approval never spends a money "yes".
   */
  private async gate(actor: DeployActor, g: GateInput): Promise<GateResult> {
    const tool = actor.tool?.name ?? `cloudflare.${g.operation}`;
    const input = actor.tool?.input ?? g.request;
    const key = actor.tool ? actor.approvalKey : undefined;
    const displayInput = actor.tool ? actor.approvalInput : undefined;
    const base = {
      sessionId: actor.sessionId,
      runId: actor.runId,
      agentId: actor.agentId,
      humanId: actor.humanId,
      projectId: actor.projectId,
      taskId: actor.taskId,
      tool,
      input,
      ...(key ? { key } : {}),
      ...(displayInput !== undefined ? { displayInput } : {}),
      operation: g.operation,
      scope: g.scope,
      env: g.env ?? undefined,
    };
    const decision = decideAutonomy(g.actionClass, {
      level: actor.autonomy,
      planApproved: actor.planApproved,
    });
    if (decision === "forbidden") {
      await this.record(
        actor,
        `cloudflare.${g.operation}`,
        false,
        { scope: g.scope, env: g.env },
        null,
        `autonomy_insufficient: ${g.actionClass} is never allowed`,
      );
      throw new ForerunnerError("autonomy_insufficient", `${g.actionClass} is never allowed`, {
        details: { operation: g.operation, scope: g.scope },
      });
    }
    const alwaysHuman = ALWAYS_HUMAN.has(g.actionClass);
    if (decision === "approval_required" && !alwaysHuman) {
      const why = `autonomy level ${actor.autonomy} requires a human's approval to ${g.why}`;
      const answer = await this.deps.approvals.ask({
        ...base,
        actionClass: g.actionClass,
        risk: g.actionClass === "deploy_staging" ? "medium" : "high",
        why,
        oneShot: false,
      });
      const stop = await this.stopFor(actor, g, answer, g.actionClass, why);
      if (stop) return stop;
    }
    if (g.paid.length > 0 || alwaysHuman) {
      const why = `${g.why}: creates a paid resource or changes a plan (${g.paid.join("; ") || g.actionClass}); a human answers for this one action at every autonomy level`;
      const answer = await this.deps.approvals.ask({
        ...base,
        actionClass: "financial",
        risk: "high",
        why,
        oneShot: true,
      });
      const stop = await this.stopFor(actor, g, answer, "financial", why);
      if (stop) return stop;
    }
    return { ok: true };
  }

  private async stopFor(
    actor: DeployActor,
    g: GateInput,
    answer: "approved" | "denied" | "pending",
    actionClass: ActionClass,
    why: string,
  ): Promise<GateResult | null> {
    if (answer === "approved") return null;
    const tool = `cloudflare.${g.operation}`;
    const input = { scope: g.scope, env: g.env, actionClass };
    if (answer === "denied") {
      await this.record(actor, tool, false, input, null, "approval_required: human denied");
      throw new ForerunnerError("approval_required", `human denied: ${g.why}`, {
        details: { operation: g.operation, scope: g.scope, actionClass, outcome: "denied" },
      });
    }
    await this.record(actor, tool, false, input, null, "approval_required: pending");
    return {
      ok: false,
      outcome: {
        status: "awaiting_approval",
        operation: g.operation,
        env: g.env,
        scope: g.scope,
        actionClass,
        why,
      },
    };
  }

  // -- audit ----------------------------------------------------------------------------------

  private async record(
    actor: DeployActor,
    tool: string,
    allowed: boolean,
    input: Record<string, unknown>,
    result: unknown,
    deniedReason?: string,
  ): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit.append({
      tool,
      allowed,
      session_id: actor.sessionId,
      run_id: actor.runId,
      agent_id: actor.agentId,
      human_id: actor.humanId,
      input_summary: this.deps.client.scrub(JSON.stringify(input)),
      result_summary: result === null ? "" : this.deps.client.scrub(JSON.stringify(result)),
      denied_reason: deniedReason ?? null,
      cost_usd_micro: 0,
      occurred_at: this.deps.clock.nowIso(),
      author_agent: actor.agentId,
    });
  }

  private async recordFailure(
    actor: DeployActor,
    tool: string,
    input: Record<string, unknown>,
    e: unknown,
  ): Promise<void> {
    const code = e instanceof ForerunnerError ? e.code : "internal";
    const message = e instanceof Error ? e.message : String(e);
    await this.record(actor, tool, false, input, null, `${code}: ${message}`);
  }
}

function classOf(env: DeployEnv): ActionClass {
  return env === "production" ? "deploy_production" : "deploy_staging";
}
