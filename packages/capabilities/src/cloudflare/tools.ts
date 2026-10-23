/**
 * ToolSpecs for the runtime loop (shape, action classes and risk follow
 * packages/runtime/src/daemon/tools.ts). `cloudflare_deploy` carries the environment in its
 * input, so its hook class is the weaker `deploy_staging`; the deployer decides production and
 * money in code through the approval port (`deploy.ts`). `cloudflare_dns_upsert` is a
 * production action. Script and site paths are `pathFields` and are checked here again against
 * the run's roots. Route hosts and DNS record names are not `domainFields` (ADR 0035, point
 * 6): the run reaches only the API host the catalog entry declares, and the hooks' domain
 * allowlist names network destinations, not the zones a deploy configures; the deployer maps
 * every host and record name to a configured zone (`zoneForHost`) and refuses anything else
 * in code before any request. Every call writes an audit row with the scope used.
 */
import { readFileSync } from "node:fs";
import { type Clock, ForerunnerError, isInside, resolve } from "@forerunner/platform";
import {
  type AutonomyLevel,
  isValidAutonomyLevel,
  type ToolExecutionContext,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
} from "@forerunner/runtime";
import type { ProjectRow } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { z } from "zod";
import type { CloudflareApprovalPort } from "./approvals.ts";
import { CloudflareClient, cloudflareTokenSource, DNS_RECORD_TYPES } from "./client.ts";
import {
  type CloudflareAuditPort,
  CloudflareDeployer,
  type DeployActor,
  type DeployOutcome,
  type DeployPlan,
  type PlanRequest,
} from "./deploy.ts";
import { cloudflareSettingsOf, scopeOf, standInBaseUrlOf } from "./settings.ts";

export const CLOUDFLARE_TOOL_NAMES = [
  "cloudflare_plan",
  "cloudflare_deploy",
  "cloudflare_dns_upsert",
  "cloudflare_verify_token",
] as const;
export type CloudflareToolName = (typeof CLOUDFLARE_TOOL_NAMES)[number];

export interface CloudflareAutonomy {
  level: AutonomyLevel;
  planApproved?: boolean;
}

export interface CloudflareToolDeps {
  /** The deployer for the run's project (its settings name the account and zones). */
  deployerFor(ctx: ToolExecutionContext): Promise<CloudflareDeployer>;
  /** The project's autonomy level in force. */
  autonomyFor(ctx: ToolExecutionContext): Promise<CloudflareAutonomy>;
  /** Tool-call audit rows (the deployer writes one more per outward action). */
  audit?: CloudflareAuditPort;
  clock: Clock;
}

// ---------------------------------------------------------------------------------------------
// Schemas

const envSchema = z.enum(["staging", "production"]);
const hostSchema = z.string().min(1).max(253);
const bindingSchema = z.looseObject({ type: z.string().min(1), name: z.string().min(1) });

const workerTarget = z.object({
  kind: z.literal("worker"),
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  /** Path of the ES module inside the worktree. */
  scriptPath: z.string().min(1),
  mainModule: z.string().min(1).max(200).optional(),
  bindings: z.array(bindingSchema).max(64).optional(),
  compatibilityDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  compatibilityFlags: z.array(z.string().min(1).max(64)).max(50).optional(),
  routePath: z.string().max(200).optional(),
  migrations: z.record(z.string(), z.unknown()).optional(),
  logpush: z.boolean().optional(),
  usageModel: z.string().min(1).max(32).optional(),
});

const pagesTarget = z.object({
  kind: z.literal("pages"),
  project: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$/),
  /** Directory of the built site inside the worktree. */
  directory: z.string().min(1),
});

export const DeployInputSchema = z.object({
  env: envSchema,
  target: z.discriminatedUnion("kind", [workerTarget, pagesTarget]),
  /** Hosts this deploy serves (Worker routes). Each must be inside a configured zone. */
  hosts: z.array(hostSchema).max(20).optional(),
});
export type DeployInput = z.infer<typeof DeployInputSchema>;

export const DnsInputSchema = z.object({
  zoneId: z.string().min(1).max(64).optional(),
  type: z.enum(DNS_RECORD_TYPES),
  name: hostSchema,
  content: z.string().min(1).max(4096),
  ttl: z.number().int().min(1).max(86_400).optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().min(0).max(65_535).optional(),
  comment: z.string().max(500).optional(),
});
export type DnsInput = z.infer<typeof DnsInputSchema>;

export const PlanInputSchema = z.discriminatedUnion("action", [
  DeployInputSchema.extend({ action: z.literal("deploy") }),
  DnsInputSchema.extend({ action: z.literal("dns_upsert") }),
]);
export type PlanInput = z.infer<typeof PlanInputSchema>;

export const VerifyInputSchema = z.object({});
export type VerifyInput = z.infer<typeof VerifyInputSchema>;

// ---------------------------------------------------------------------------------------------
// Helpers

function failure(e: unknown): ToolResult {
  if (e instanceof ForerunnerError) {
    return { content: `refused (${e.code}): ${e.message}`, isError: true };
  }
  return { content: `error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
}

/** A worktree path, checked against the run's roots (the hooks check pathFields too). */
function inside(ctx: ToolExecutionContext, p: string): string {
  const abs = resolve(ctx.cwd ?? ".", p);
  if (!ctx.allowedPaths.some((root) => isInside(root, abs))) {
    throw new ForerunnerError("path_not_allowed", `path outside the worktree: ${p}`);
  }
  return abs;
}

function actorOf(
  ctx: ToolExecutionContext,
  autonomy: CloudflareAutonomy,
  tool: { name: string; input: unknown },
): DeployActor {
  return {
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    humanId: ctx.humanId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    autonomy: autonomy.level,
    planApproved: autonomy.planApproved,
    tool,
    ...(ctx.approvalKey ? { approvalKey: ctx.approvalKey } : {}),
    ...(ctx.approvalInput !== undefined ? { approvalInput: ctx.approvalInput } : {}),
  };
}

function describePlan(plan: DeployPlan): string {
  const lines = [
    `Plan: ${plan.operation}${plan.env ? ` (${plan.env})` : ""} on ${plan.scope}`,
    `Action class: ${plan.actionClass}; autonomy decision: ${plan.decision}`,
  ];
  if (plan.paid.length) {
    lines.push(
      `Paid resources (a human answers for each action at every level): ${plan.paid.join("; ")}`,
    );
  }
  lines.push("Changes:");
  for (const c of plan.changes) {
    lines.push(`- ${c.action} ${c.resource} ${c.target}${c.detail ? ` (${c.detail})` : ""}`);
  }
  lines.push("Nothing was changed; this was a dry run.");
  return lines.join("\n");
}

function outcomeResult(outcome: DeployOutcome): ToolResult {
  if (outcome.status === "done") {
    return { content: outcome.summary, artifacts: { ...outcome.result, scope: outcome.scope } };
  }
  return {
    content: `waiting for the human's approval (${outcome.actionClass}: ${outcome.why}); nothing was deployed. Retry the same call once the human answered.`,
    artifacts: { scope: outcome.scope, operation: outcome.operation, pending: true },
  };
}

function dnsRequestOf(input: DnsInput): PlanRequest {
  return {
    kind: "dns",
    zoneId: input.zoneId,
    record: {
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl,
      proxied: input.proxied,
      priority: input.priority,
      comment: input.comment,
    },
  };
}

function planRequestOf(input: PlanInput, ctx: ToolExecutionContext): PlanRequest {
  if (input.action === "dns_upsert") return dnsRequestOf(input);
  return deployRequestOf(input, ctx);
}

function deployRequestOf(input: DeployInput, ctx: ToolExecutionContext): PlanRequest {
  if (input.target.kind === "worker") {
    const t = input.target;
    return {
      kind: "worker",
      env: input.env,
      name: t.name,
      script: readFileSync(inside(ctx, t.scriptPath), "utf8"),
      mainModule: t.mainModule,
      bindings: t.bindings,
      compatibilityDate: t.compatibilityDate,
      compatibilityFlags: t.compatibilityFlags,
      hosts: input.hosts,
      routePath: t.routePath,
      migrations: t.migrations,
      logpush: t.logpush,
      usageModel: t.usageModel,
    };
  }
  return {
    kind: "pages",
    env: input.env,
    project: input.target.project,
    directory: inside(ctx, input.target.directory),
    hosts: input.hosts,
  };
}

// ---------------------------------------------------------------------------------------------
// The tools

export function cloudflareTools(deps: CloudflareToolDeps): ToolSpec[] {
  const audit = async (
    ctx: ToolExecutionContext,
    tool: CloudflareToolName,
    scope: string,
    input: unknown,
    result: ToolResult,
    pending = false,
  ) => {
    if (!deps.audit) return;
    const allowed = !result.isError && !pending;
    await deps.audit.append({
      tool,
      allowed,
      session_id: ctx.sessionId,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      human_id: ctx.humanId,
      input_summary: JSON.stringify({ scope, input }).slice(0, 2000),
      result_summary: result.content.slice(0, 500),
      denied_reason: allowed ? null : pending ? "approval_required: pending" : result.content,
      cost_usd_micro: 0,
      occurred_at: deps.clock.nowIso(),
      author_agent: ctx.agentId,
    });
  };

  const run = async <I>(
    ctx: ToolExecutionContext,
    name: CloudflareToolName,
    input: I,
    fn: (deployer: CloudflareDeployer, autonomy: CloudflareAutonomy) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    let scope = "(unconfigured)";
    try {
      const deployer = await deps.deployerFor(ctx);
      scope = deployer.scopeLabel(deployer.scope.zoneIds);
      const autonomy = await deps.autonomyFor(ctx);
      const result = await fn(deployer, autonomy);
      const pending = result.artifacts?.pending === true;
      await audit(
        ctx,
        name,
        (result.artifacts?.scope as string | undefined) ?? scope,
        input,
        result,
        pending,
      );
      return result;
    } catch (e) {
      const result = failure(e);
      await audit(ctx, name, scope, input, result);
      return result;
    }
  };

  const plan: ToolSpec<PlanInput> = {
    name: "cloudflare_plan",
    description:
      "Dry run of a Cloudflare deploy or DNS change: lists what would change, the autonomy decision and any paid resource. Reads only; nothing is changed and nobody is asked.",
    schema: PlanInputSchema,
    actionClass: "read",
    risk: "low",
    pathFields: ["target.scriptPath", "target.directory"],
    async execute(input, ctx) {
      return run(ctx, "cloudflare_plan", input, async (deployer, autonomy) => {
        const actor = actorOf(ctx, autonomy, { name: "cloudflare_plan", input });
        const p = await deployer.plan(planRequestOf(input, ctx), actor);
        return { content: describePlan(p), artifacts: { ...p } };
      });
    },
  };

  const deploy: ToolSpec<DeployInput> = {
    name: "cloudflare_deploy",
    description:
      "Deploy a Worker (script from the worktree, routes on the given hosts) or a Pages site (directory in the worktree) to staging or production on Cloudflare. Staging is free at autonomy 3+; production asks a human below 4; anything that creates a paid resource asks a human at every level.",
    schema: DeployInputSchema,
    actionClass: "deploy_staging",
    risk: "high",
    pathFields: ["target.scriptPath", "target.directory"],
    timeoutMs: 15 * 60 * 1000,
    async execute(input, ctx) {
      return run(ctx, "cloudflare_deploy", input, async (deployer, autonomy) => {
        const actor = actorOf(ctx, autonomy, { name: "cloudflare_deploy", input });
        const req = deployRequestOf(input, ctx);
        const outcome =
          req.kind === "worker"
            ? await deployer.deployWorker(req, actor)
            : req.kind === "pages"
              ? await deployer.deployPages(req, actor)
              : null;
        if (!outcome) throw new ForerunnerError("internal", "unexpected deploy target");
        return outcomeResult(outcome);
      });
    },
  };

  const dns: ToolSpec<DnsInput> = {
    name: "cloudflare_dns_upsert",
    description:
      "Create or update one DNS record in a configured Cloudflare zone (found by the record name, or by zoneId). DNS is live for the zone, so this is a production action: it asks a human below autonomy 4.",
    schema: DnsInputSchema,
    actionClass: "deploy_production",
    risk: "high",
    async execute(input, ctx) {
      return run(ctx, "cloudflare_dns_upsert", input, async (deployer, autonomy) => {
        const actor = actorOf(ctx, autonomy, { name: "cloudflare_dns_upsert", input });
        const req = dnsRequestOf(input);
        if (req.kind !== "dns") throw new ForerunnerError("internal", "unexpected dns request");
        return outcomeResult(
          await deployer.dnsUpsert({ zoneId: req.zoneId, record: req.record }, actor),
        );
      });
    },
  };

  const verify: ToolSpec<VerifyInput> = {
    name: "cloudflare_verify_token",
    description:
      "Check the project's Cloudflare token: status, expiry and the permission scopes it grants (what the Extensions panel shows). Never returns the token.",
    schema: VerifyInputSchema,
    actionClass: "read",
    risk: "low",
    async execute(input, ctx) {
      return run(ctx, "cloudflare_verify_token", input, async (deployer, autonomy) => {
        const actor = actorOf(ctx, autonomy, { name: "cloudflare_verify_token", input });
        const v = await deployer.verifyToken(actor);
        const lines = [
          `Token ${v.id || "(id unknown)"}: ${v.status}${v.expiresOn ? `, expires ${v.expiresOn}` : ""}`,
          `Configured scope: ${deployer.scopeLabel(deployer.scope.zoneIds)}`,
          v.scopesKnown ? "Scopes:" : "Scopes: unknown",
          ...v.scopes.map((s) => `- ${s}`),
          ...v.warnings.map((w) => `WARNING: ${w}`),
        ];
        return {
          content: lines.join("\n"),
          artifacts: {
            status: v.status,
            scopes: v.scopes,
            scopesKnown: v.scopesKnown,
            warnings: v.warnings,
            expiresOn: v.expiresOn,
          },
        };
      });
    },
  };

  return [plan as ToolSpec, deploy as ToolSpec, dns as ToolSpec, verify as ToolSpec];
}

export function registerCloudflareTools(
  registry: ToolRegistry,
  deps: CloudflareToolDeps,
): ToolRegistry {
  for (const tool of cloudflareTools(deps)) registry.register(tool);
  return registry;
}

// ---------------------------------------------------------------------------------------------
// Production wiring: one deployer per project from its settings and the vault

export interface CloudflareCapabilityDeps {
  projects: { get(id: string): Promise<ProjectRow | undefined> };
  vault: Vault;
  approvals: CloudflareApprovalPort;
  audit?: CloudflareAuditPort;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** Overrides the settings' base URL and is the one stand-in a project may name (tests). */
  baseUrl?: string;
  /** Environment to read `FORERUNNER_CLOUDFLARE_API_BASE` from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/**
 * Reads `project.settings.cloudflare` and `project.autonomy_level` for every call. The settings
 * are parsed with the stand-in the install owner allowed (`baseUrl`, else the environment), so
 * a project naming another API host or another vault entry is refused before any request.
 */
export function cloudflareToolDeps(deps: CloudflareCapabilityDeps): CloudflareToolDeps {
  const standInBaseUrl = standInBaseUrlOf(deps);
  const projectOf = async (ctx: ToolExecutionContext): Promise<ProjectRow> => {
    const project = ctx.projectId ? await deps.projects.get(ctx.projectId) : undefined;
    if (!project) {
      throw new ForerunnerError("tool_not_allowed", "Cloudflare tools need a project", {
        details: { projectId: ctx.projectId ?? null },
      });
    }
    return project;
  };
  return {
    clock: deps.clock,
    audit: deps.audit,
    async deployerFor(ctx) {
      const project = await projectOf(ctx);
      const settings = cloudflareSettingsOf(project, { standInBaseUrl });
      if (!settings) {
        throw new ForerunnerError(
          "tool_not_allowed",
          "Cloudflare is not configured for this project (settings.cloudflare)",
          { details: { projectId: project.id } },
        );
      }
      const client = new CloudflareClient({
        scope: scopeOf(settings),
        token: cloudflareTokenSource({ vault: deps.vault, ref: settings.secret_ref }),
        baseUrl: deps.baseUrl ?? settings.base_url ?? standInBaseUrl,
        fetchImpl: deps.fetchImpl,
        clock: deps.clock,
      });
      return new CloudflareDeployer({
        client,
        settings,
        approvals: deps.approvals,
        audit: deps.audit,
        clock: deps.clock,
      });
    },
    async autonomyFor(ctx) {
      const project = await projectOf(ctx);
      const level = project.autonomy_level;
      if (!isValidAutonomyLevel(level)) {
        throw new ForerunnerError("validation", `project autonomy level ${level} is not 0-4`);
      }
      return { level };
    },
  };
}
