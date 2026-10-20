import {
  type Clock,
  ForerunnerError,
  isInside,
  resolve as resolvePath,
} from "@forerunner/platform";
import type { AuditLogRepo } from "@forerunner/state";
import { getPath, type ToolSpec } from "../agent/tools.ts";
import {
  domainAllowed,
  EnforcementHooks,
  type HookDeps,
  hostnameOf,
  type RunContext,
  type ToolCallDecision,
  type ToolCallPending,
} from "../enforcement/hooks.ts";
import type { CapabilityClaims } from "../enforcement/token.ts";
import { isBridgedTool } from "./mcp.ts";
import type { ExtensionRegistry } from "./registry.ts";
import { parsePermissions, ROW_STATUS_ERROR, ROW_STATUS_PENDING } from "./types.ts";

/**
 * The extension gate: before every tool call, a tool that belongs to an extension which is
 * disabled, removed, in error or waiting for approval is refused in code, even when the run
 * token lists it. The extension's own domain and path ceilings are checked too. Tools that
 * belong to no extension pass through untouched.
 */
export interface ExtensionGateDeps {
  registry: ExtensionRegistry;
  clock: Clock;
  /** Denials are audited when a token is known. */
  audit?: Pick<AuditLogRepo, "append">;
}

export interface GateContext {
  claims?: Pick<CapabilityClaims, "id" | "runId" | "sessionId" | "agentId" | "ownerHumanId">;
  input?: unknown;
  cwd?: string;
}

export class ExtensionGate {
  constructor(private readonly deps: ExtensionGateDeps) {}

  async check(tool: ToolSpec, ctx: GateContext = {}): Promise<void> {
    const extensionId = isBridgedTool(tool)
      ? tool.extensionId
      : await this.deps.registry.lookupTool(tool.name);
    if (!extensionId) return;
    const row = await this.deps.registry.row(extensionId);
    const deny = async (
      code: ConstructorParameters<typeof ForerunnerError>[0],
      message: string,
    ): Promise<never> => {
      if (this.deps.audit && ctx.claims) {
        await this.deps.audit.append({
          session_id: ctx.claims.sessionId,
          run_id: ctx.claims.runId,
          agent_id: ctx.claims.agentId,
          human_id: ctx.claims.ownerHumanId,
          tool: tool.name,
          input_summary: summarize(ctx.input),
          result_summary: "",
          allowed: false,
          denied_reason: `${code}: ${message}`,
          occurred_at: this.deps.clock.nowIso(),
          token_id: ctx.claims.id,
        });
      }
      throw new ForerunnerError(code, message, { details: { tool: tool.name, extensionId } });
    };
    if (!row) return deny("tool_not_allowed", `extension of tool ${tool.name} was removed`);
    if (row.status === ROW_STATUS_PENDING) {
      return deny("approval_required", `extension ${row.name} is waiting for approval`);
    }
    if (!row.enabled || row.status === ROW_STATUS_ERROR) {
      return deny("tool_not_allowed", `extension ${row.name} is disabled`);
    }
    const perms = parsePermissions(row.permissions);
    if (perms.tools.length > 0 && !perms.tools.includes(tool.name)) {
      return deny("tool_not_allowed", `tool ${tool.name} is not granted to ${row.name}`);
    }
    if (ctx.input === undefined) return;
    if (perms.domains.length > 0) {
      for (const field of tool.domainFields ?? []) {
        for (const v of values(getPath(ctx.input, field))) {
          const host = hostnameOf(v);
          if (!host || !domainAllowed(host, perms.domains)) {
            return deny("domain_not_allowed", `${row.name} may not reach ${host ?? v}`);
          }
        }
      }
    }
    if (perms.paths.length > 0) {
      for (const field of tool.pathFields ?? []) {
        for (const v of values(getPath(ctx.input, field))) {
          const abs = ctx.cwd ? resolvePath(ctx.cwd, v) : resolvePath(v);
          if (!perms.paths.some((root) => isInside(root, abs))) {
            return deny("path_not_allowed", `${row.name} may not touch ${v}`);
          }
        }
      }
    }
  }
}

function values(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function summarize(v: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}

/**
 * Enforcement hooks with the extension gate in front of `beforeToolCall`. A drop-in for
 * `EnforcementHooks` wherever the drivers take one.
 */
export class GatedEnforcementHooks extends EnforcementHooks {
  constructor(
    deps: HookDeps,
    private readonly gate: ExtensionGate,
  ) {
    super(deps);
  }

  override async beforeToolCall(
    ctx: RunContext,
    tool: ToolSpec,
    rawInput: unknown,
  ): Promise<ToolCallDecision | ToolCallPending> {
    await this.gate.check(tool, { claims: ctx.token.claims, input: rawInput, cwd: ctx.cwd });
    return super.beforeToolCall(ctx, tool, rawInput);
  }
}

/** Wrap a ToolSpec so its execute() is refused by the gate even when called without hooks. */
export function gateTool<I>(spec: ToolSpec<I>, gate: ExtensionGate): ToolSpec<I> {
  return {
    ...spec,
    async execute(input, ctx) {
      await gate.check(spec as ToolSpec, {
        claims: {
          id: "",
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          ownerHumanId: ctx.humanId,
        },
        input,
        cwd: ctx.cwd,
      });
      return spec.execute(input, ctx);
    },
  };
}
