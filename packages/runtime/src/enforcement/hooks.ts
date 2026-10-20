import {
  type Clock,
  ForerunnerError,
  isInside,
  log,
  resolve as resolvePath,
} from "@forerunner/platform";
import type { ToolSpec } from "../agent/tools.ts";
import { getPath } from "../agent/tools.ts";
import { type InjectionReport, wrapUntrusted } from "../injection/scan.ts";
import type { Usage } from "../provider/types.ts";
import { type AutonomyDecision, decideAutonomy } from "./autonomy.ts";
import type { SessionBudget } from "./budget.ts";
import type { KillSwitch } from "./killswitch.ts";
import type {
  ApprovalPort,
  AuditPort,
  BillingKind,
  CapsPort,
  LedgerPort,
  SecretsPort,
} from "./ports.ts";
import type { CapabilityClaims, SignedToken, TokenIssuer } from "./token.ts";

/**
 * How the run is billed (ADR 0044). Absent: an API-style source ("api" rows, no plan level).
 * For a subscription the executor sets `kind: "subscription"`, the source's `planShareCap`
 * and `planUsageShare`, a closure that reports the plan share as this run's spend moves it;
 * the hooks read it before every model call (the caps' plan level) and after (the ledger row).
 */
export interface RunBilling {
  kind: BillingKind;
  planShareCap?: number;
  planUsageShare?: () => number | null;
}

export interface RunContext {
  token: SignedToken;
  budget: SessionBudget;
  signal: AbortSignal;
  /** Epoch ms deadline for this run (wall-clock timeout). */
  runDeadlineMs: number;
  phase: "work" | "review";
  model: string;
  provider: string;
  billingSourceId: string;
  billing?: RunBilling;
  /** Approvals already granted for this run (approval ids or tool+hash keys). */
  approvals?: Set<string>;
  /** Working directory of the run; relative paths in tool inputs resolve against it. */
  cwd?: string;
}

export interface HookDeps {
  tokens: TokenIssuer;
  caps: CapsPort;
  secrets: SecretsPort;
  kill: KillSwitch;
  clock: Clock;
  ledger: LedgerPort;
  audit: AuditPort;
  approvals: ApprovalPort;
}

export interface ToolCallDecision {
  allowed: true;
  input: unknown;
  claims: CapabilityClaims;
}

export interface ToolCallPending {
  allowed: false;
  pending: true;
  reason: string;
}

export class EnforcementHooks {
  private readonly logger = log("enforcement");

  constructor(private readonly deps: HookDeps) {}

  /** Verify the token and the kill state; shared by every hook. */
  private claims(ctx: RunContext): CapabilityClaims {
    const claims = this.deps.tokens.verify(ctx.token, this.deps.clock.now());
    if (
      ctx.signal.aborted ||
      this.deps.kill.isFrozen({ agentId: claims.agentId, sessionId: claims.sessionId })
    ) {
      throw new ForerunnerError("killed", "run stopped by kill switch", {
        details: { runId: claims.runId },
      });
    }
    return claims;
  }

  /** Before every model call: kill state, wall clock, steps, run/session/task/project/month caps. */
  async beforeModelCall(
    ctx: RunContext,
    estimateUsdMicro: number,
  ): Promise<{ decision: "allow" | "finish_current" }> {
    const claims = this.claims(ctx);
    const now = this.deps.clock.now();
    ctx.budget.checkWallClock(now);
    if (now >= ctx.runDeadlineMs) {
      throw new ForerunnerError("timeout", "run wall-clock timeout reached", {
        details: { runId: claims.runId },
      });
    }
    ctx.budget.step();
    const local = ctx.budget.precheck(
      claims.runId,
      claims.budgetUsdMicro,
      estimateUsdMicro,
      ctx.phase,
    );
    const share = ctx.billing?.planUsageShare?.();
    const outer = await this.deps.caps.check(
      {
        humanId: claims.ownerHumanId,
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        taskId: claims.taskId,
        runId: claims.runId,
      },
      estimateUsdMicro,
      {
        phase: ctx.phase,
        ...(ctx.billing
          ? {
              billing: {
                sourceId: ctx.billingSourceId,
                kind: ctx.billing.kind,
                ...(typeof share === "number" ? { planUsageShare: share } : {}),
                ...(ctx.billing.planShareCap !== undefined
                  ? { planShareCap: ctx.billing.planShareCap }
                  : {}),
              },
            }
          : {}),
      },
    );
    if (outer.decision === "stop") {
      throw new ForerunnerError(
        "budget_exceeded",
        outer.message ?? `${outer.level ?? "a"} cap reached`,
        {
          details: {
            level: outer.level,
            spentUsdMicro: outer.spentUsdMicro,
            capUsdMicro: outer.capUsdMicro,
            runId: claims.runId,
          },
        },
      );
    }
    return {
      decision:
        outer.decision === "finish_current" || local.decision === "finish_current"
          ? "finish_current"
          : "allow",
    };
  }

  /** After a model call: account the real cost. */
  async afterModelCall(ctx: RunContext, usage: Usage, usdMicro: number): Promise<void> {
    const claims = this.deps.tokens.verify(ctx.token, this.deps.clock.now());
    ctx.budget.record(claims.runId, usdMicro);
    await this.deps.ledger.record({
      humanId: claims.ownerHumanId,
      agentId: claims.agentId,
      projectId: claims.projectId,
      sessionId: claims.sessionId,
      taskId: claims.taskId,
      runId: claims.runId,
      model: ctx.model,
      provider: ctx.provider,
      billingSourceId: ctx.billingSourceId,
      kind: ctx.billing?.kind ?? "api",
      planUsageShare: ctx.billing?.planUsageShare?.() ?? null,
      usdMicro,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      occurredAt: this.deps.clock.nowIso(),
    });
  }

  /**
   * Before every tool call: token, kill state, step, tool allowlist, path containment, domain
   * allowlist, autonomy decision (may request approval), secret injection. Returns the input to
   * execute with (secrets resolved) or a pending marker when a human must answer first.
   */
  async beforeToolCall(
    ctx: RunContext,
    tool: ToolSpec,
    rawInput: unknown,
  ): Promise<ToolCallDecision | ToolCallPending> {
    const claims = this.claims(ctx);
    const deny = async (
      code: ConstructorParameters<typeof ForerunnerError>[0],
      message: string,
      details: Record<string, unknown> = {},
    ) => {
      await this.deps.audit.append({
        sessionId: claims.sessionId,
        runId: claims.runId,
        agentId: claims.agentId,
        humanId: claims.ownerHumanId,
        tool: tool.name,
        inputSummary: summarize(rawInput),
        resultSummary: "",
        allowed: false,
        deniedReason: `${code}: ${message}`,
        costUsdMicro: 0,
        occurredAt: this.deps.clock.nowIso(),
        tokenId: claims.id,
      });
      return new ForerunnerError(code, message, {
        details: { tool: tool.name, runId: claims.runId, ...details },
      });
    };

    ctx.budget.checkWallClock(this.deps.clock.now());
    ctx.budget.step();

    if (!claims.allowedTools.includes(tool.name)) {
      throw await deny("tool_not_allowed", `tool "${tool.name}" is not in this run's allowlist`);
    }

    const parsed = tool.schema.safeParse(rawInput);
    if (!parsed.success) {
      throw await deny(
        "validation",
        `invalid input for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const input = parsed.data;

    for (const field of tool.pathFields ?? []) {
      const value = getPath(input, field);
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const v of values) {
        if (typeof v !== "string") continue;
        const abs = ctx.cwd ? resolvePath(ctx.cwd, v) : resolvePath(v);
        if (!claims.allowedPaths.some((root) => isInside(root, abs))) {
          throw await deny("path_not_allowed", `path outside the run's allowed roots: ${v}`, {
            field,
          });
        }
      }
    }

    for (const field of tool.domainFields ?? []) {
      const value = getPath(input, field);
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const v of values) {
        if (typeof v !== "string") continue;
        const host = hostnameOf(v);
        if (!host || !domainAllowed(host, claims.allowedDomains)) {
          throw await deny(
            "domain_not_allowed",
            `domain not in the run's allowlist: ${host ?? v}`,
            { field },
          );
        }
      }
    }

    const approvalKey = `${tool.name}:${stableHash(input)}`;
    const decision: AutonomyDecision = decideAutonomy(tool.actionClass, {
      level: claims.autonomy,
      planApproved: claims.planApproved,
      actionApproved: ctx.approvals?.has(approvalKey) ?? false,
    });
    if (decision === "forbidden") {
      throw await deny(
        "autonomy_insufficient",
        `action class ${tool.actionClass} is never allowed`,
      );
    }
    if (decision === "approval_required") {
      const outcome = await this.deps.approvals.request({
        sessionId: claims.sessionId,
        runId: claims.runId,
        agentId: claims.agentId,
        humanId: claims.ownerHumanId,
        projectId: claims.projectId,
        taskId: claims.taskId,
        tool: tool.name,
        actionClass: tool.actionClass,
        risk: tool.risk,
        why: `autonomy level ${claims.autonomy} requires approval for ${tool.actionClass}`,
        input: redactForDisplay(input),
      });
      if (outcome === "denied") {
        throw await deny("approval_required", `human denied ${tool.name}`);
      }
      if (outcome === "pending") {
        await this.deps.audit.append({
          sessionId: claims.sessionId,
          runId: claims.runId,
          agentId: claims.agentId,
          humanId: claims.ownerHumanId,
          tool: tool.name,
          inputSummary: summarize(input),
          resultSummary: "pending human approval",
          allowed: false,
          deniedReason: "approval_required: pending",
          costUsdMicro: 0,
          occurredAt: this.deps.clock.nowIso(),
          tokenId: claims.id,
        });
        return { allowed: false, pending: true, reason: `waiting for approval of ${tool.name}` };
      }
      ctx.approvals?.add(approvalKey);
    }

    let resolved: unknown;
    try {
      resolved = await this.deps.secrets.resolve(input, new Set(claims.grantedSecrets));
    } catch (e) {
      if (e instanceof ForerunnerError) throw await deny(e.code, e.message, e.details);
      throw e;
    }
    return { allowed: true, input: resolved, claims };
  }

  /** After a tool call: redact secrets, wrap untrusted output, audit. */
  async afterToolCall(
    ctx: RunContext,
    tool: ToolSpec,
    input: unknown,
    result: {
      content: string;
      isError?: boolean;
      untrusted?: { source: import("../injection/scan.ts").ContentSource; origin?: string };
      costUsdMicro?: number;
    },
  ): Promise<{ content: string; report: InjectionReport | null }> {
    const claims = this.deps.tokens.verify(ctx.token, this.deps.clock.now());
    let content = this.deps.secrets.redact(result.content);
    let report: InjectionReport | null = null;
    if (result.untrusted) {
      const wrapped = wrapUntrusted(content, result.untrusted.source, result.untrusted.origin);
      content = wrapped.content;
      report = wrapped.report;
      if (report.suspicious) {
        this.logger.warn("instruction-like content in tool output", {
          tool: tool.name,
          source: result.untrusted.source,
          origin: result.untrusted.origin,
          rules: report.matches.map((m) => m.rule),
        });
      }
    }
    if (result.costUsdMicro) ctx.budget.record(claims.runId, result.costUsdMicro);
    await this.deps.audit.append({
      sessionId: claims.sessionId,
      runId: claims.runId,
      agentId: claims.agentId,
      humanId: claims.ownerHumanId,
      tool: tool.name,
      inputSummary: summarize(redactForDisplay(input)),
      resultSummary: summarize(content),
      allowed: true,
      costUsdMicro: result.costUsdMicro ?? 0,
      occurredAt: this.deps.clock.nowIso(),
      tokenId: claims.id,
    });
    return { content, report };
  }
}

export function hostnameOf(value: string): string | null {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return new URL(value).hostname.toLowerCase();
    if (/^[a-z0-9.-]+(:\d+)?$/i.test(value)) return value.split(":")[0]?.toLowerCase() ?? null;
    return null;
  } catch {
    return null;
  }
}

export function domainAllowed(host: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === host) return true;
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      if (host === base || host.endsWith(`.${base}`)) return true;
    }
  }
  return false;
}

function summarize(v: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = "";
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}

/** Hide secret refs' values (they are refs here, so safe) and long blobs in approval cards. */
function redactForDisplay(v: unknown): unknown {
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (Array.isArray(v)) return v.map(redactForDisplay);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = redactForDisplay(val);
    return out;
  }
  return v;
}

function stableHash(v: unknown): string {
  const s = JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
      : val,
  );
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
