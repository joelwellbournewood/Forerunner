import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  type Clock,
  dirname,
  ForerunnerError,
  isInside,
  join,
  log,
  redact,
  resolve as resolvePath,
} from "@forerunner/platform";
import type { ToolSpec } from "../agent/tools.ts";
import { getPath } from "../agent/tools.ts";
import { type InjectionReport, wrapUntrusted } from "../injection/scan.ts";
import type { Usage } from "../provider/types.ts";
import { ALWAYS_HUMAN, type AutonomyDecision, decideAutonomy } from "./autonomy.ts";
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
  /**
   * Approvals already granted for this run (`tool:<sha256 of the canonical input>` keys). An
   * approval of an always-human action (`ALWAYS_HUMAN`) admits one call and is taken out as
   * it is used; every other approval holds for the run. The durable port (`StateApprovals`)
   * keeps the same rule across runs: its always-human rows are spent as they are handed out.
   */
  approvals?: Set<string>;
  /** Working directory of the run; relative paths in tool inputs resolve against it. */
  cwd?: string;
  /**
   * The runtime's own step, not a model's request (the merge after an accepting review, ADR
   * 0062): an action the autonomy level does not free is refused as `autonomy_insufficient`
   * with its audit row instead of filing an approval request, since no run waits on the
   * answer; the human does the action themself. An approval already in `approvals` still
   * admits the call.
   */
  unattended?: boolean;
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
  /**
   * The key this call's approval is remembered under (`approvalKeyFor` over the parsed input,
   * before secret references are resolved). The executor hands it to the tool as
   * `ToolExecutionContext.approvalKey`, so a tool that asks a human on its own (the Cloudflare
   * deployer) finds the hooks' row for the call even though it sees the resolved input.
   */
  approvalKey: string;
  /**
   * The call's input as the hooks show it on an approval card: parsed, before secret
   * references are resolved (`secret:<name>` stays a reference), long strings cut. The
   * executor hands it to the tool as `ToolExecutionContext.approvalInput`, so a tool that files
   * its own approval card (the Cloudflare deployer) shows this copy instead of `input`, which
   * carries the resolved secret values.
   */
  approvalInput: unknown;
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
    let claims: CapabilityClaims;
    try {
      claims = this.claims(ctx);
    } catch (e) {
      // Spec S.9, every tool call: a call on a revoked, expired or forged token, or after a
      // stop, leaves a row too. The claims are unverified here, so the row carries what the
      // token says it is (its id and run), which is what the human needs to find the attempt.
      if (e instanceof ForerunnerError) await this.auditUnverified(ctx, tool, rawInput, e);
      throw e;
    }
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
        inputSummary: this.summary(rawInput),
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
        if (!claims.allowedPaths.some((root) => pathInsideRoot(root, abs))) {
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

    // A command tool of the registry is confirmed by the registry's own policy (the change
    // card: a yes for medium risk, the paired device for high, ADR 0030); a hold here would
    // make one change need two answers. Everything above and below still applies to it.
    // The key is the raw input's (canonical JSON, SHA-256), computed before the display copy
    // below cuts long strings: the row and the run remember the exact call, never its card.
    const approvalKey = approvalKeyFor(tool.name, input);
    // An approval of an always-human action (delete, purchase, send) admits one call: the key
    // is taken out as it is used, so the resume path re-makes the paused call once and every
    // further identical call asks again. Other approvals hold for the rest of the run.
    const alwaysHuman = ALWAYS_HUMAN.has(tool.actionClass);
    const actionApproved = ctx.approvals?.has(approvalKey) ?? false;
    if (actionApproved && alwaysHuman) ctx.approvals?.delete(approvalKey);
    const decision: AutonomyDecision =
      tool.gate === "registry"
        ? "allow"
        : decideAutonomy(tool.actionClass, {
            level: claims.autonomy,
            planApproved: claims.planApproved,
            actionApproved,
          });
    if (decision === "forbidden") {
      throw await deny(
        "autonomy_insufficient",
        `action class ${tool.actionClass} is never allowed`,
      );
    }
    if (decision === "approval_required" && ctx.unattended) {
      throw await deny(
        "autonomy_insufficient",
        `autonomy level ${claims.autonomy} does not free ${tool.actionClass} for an unattended step; a human does it`,
        { actionClass: tool.actionClass, autonomy: claims.autonomy },
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
        key: approvalKey,
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
          inputSummary: this.summary(input),
          resultSummary: "pending human approval",
          allowed: false,
          deniedReason: "approval_required: pending",
          costUsdMicro: 0,
          occurredAt: this.deps.clock.nowIso(),
          tokenId: claims.id,
        });
        return { allowed: false, pending: true, reason: `waiting for approval of ${tool.name}` };
      }
      if (!alwaysHuman) ctx.approvals?.add(approvalKey);
    }

    let resolved: unknown;
    try {
      resolved = await this.deps.secrets.resolve(input, new Set(claims.grantedSecrets));
    } catch (e) {
      if (e instanceof ForerunnerError) throw await deny(e.code, e.message, e.details);
      throw e;
    }
    return {
      allowed: true,
      input: resolved,
      claims,
      approvalKey,
      approvalInput: redactForDisplay(input),
    };
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
      inputSummary: this.summary(redactForDisplay(input)),
      resultSummary: this.summary(content),
      allowed: true,
      costUsdMicro: result.costUsdMicro ?? 0,
      occurredAt: this.deps.clock.nowIso(),
      tokenId: claims.id,
    });
    return { content, report };
  }

  /** An audit summary: stringified, scrubbed of secret values and credential shapes, truncated. */
  private summary(v: unknown): string {
    return summarize(scrubSummary(this.deps.secrets, stringify(v)));
  }

  /** The audit row of a call refused before the token verified (revoked, expired, forged, stopped). */
  private async auditUnverified(
    ctx: RunContext,
    tool: ToolSpec,
    rawInput: unknown,
    e: ForerunnerError,
  ): Promise<void> {
    const c = (ctx.token?.claims ?? {}) as Partial<CapabilityClaims>;
    try {
      await this.deps.audit.append({
        sessionId: String(c.sessionId ?? ""),
        runId: String(c.runId ?? ""),
        agentId: String(c.agentId ?? ""),
        humanId: String(c.ownerHumanId ?? ""),
        tool: tool.name,
        inputSummary: this.summary(rawInput),
        resultSummary: "",
        allowed: false,
        deniedReason: `${e.code}: ${e.message}`,
        costUsdMicro: 0,
        occurredAt: this.deps.clock.nowIso(),
        tokenId: String(c.id ?? ""),
      });
    } catch (auditError) {
      // The refusal stands whatever happened to the row; the failure is logged, not hidden.
      this.logger.error("audit row for a refused call failed", {
        tool: tool.name,
        error: String(auditError),
      });
    }
  }
}

/**
 * Containment with symlinks resolved: `abs` must lie inside `root` as written and once the
 * links in its existing part are followed. A repository cloned into the worktree can carry a
 * committed `link -> ~/.ssh/id_ed25519` or a linked directory; the lexical check alone would
 * let a read-class tool read it and a routine write land outside the worktree. A link that
 * cannot be resolved (dangling, a loop) is outside: a write through it would land wherever
 * it points once the target exists.
 */
export function pathInsideRoot(root: string, abs: string): boolean {
  if (!isInside(root, abs)) return false;
  const real = realPathOf(abs);
  if (real === null) return false;
  return isInside(realPathOf(root) ?? root, real);
}

/** `abs` with the symlinks of its existing part resolved; null when a link cannot be resolved. */
export function realPathOf(abs: string): string | null {
  const tail: string[] = [];
  let head = abs;
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      let link = false;
      try {
        link = lstatSync(head).isSymbolicLink();
      } catch {
        // Does not exist yet: resolve the parent and keep this segment as written.
      }
      if (link) return null;
      const parent = dirname(head);
      if (parent === head) return null;
      tail.push(basename(head));
      head = parent;
    }
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

function stringify(v: unknown): string {
  try {
    return (typeof v === "string" ? v : JSON.stringify(v)) ?? "";
  } catch {
    return String(v);
  }
}

function summarize(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}

const SECRET_REF = /secret:[A-Za-z0-9_][A-Za-z0-9_.-]*/g;

/**
 * Scrub a summary bound for the audit log: every value the run's resolver handed out (in its
 * encodings), then the platform's credential shapes as a last line, for a value the model
 * obtained elsewhere (the subprocess environment, a page) and pasted into a later input.
 * `secret:<name>` references are what the audit is meant to carry, so they are kept out of
 * the shape pass, which would otherwise take a long name for a value.
 */
function scrubSummary(secrets: SecretsPort, s: string): string {
  const refs: string[] = [];
  const held = secrets.redact(s).replace(SECRET_REF, (m) => {
    refs.push(m);
    return `\uE000${refs.length - 1}\uE001`;
  });
  return redact(held).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => refs[Number(i)] ?? "");
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

/**
 * The key under which an approval of `tool` with `input` is remembered, in the run and in the
 * state store (`StateApprovals`): SHA-256 of the canonical JSON, so two inputs never share a
 * key (a 32-bit string hash let `{repo: "Aa"}` and `{repo: "BB"}` collide).
 */
export function approvalKeyFor(tool: string, input: unknown): string {
  return `${tool}:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

/** JSON with object keys sorted at every level; the same value always gives the same text. */
export function canonicalJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, val) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(
            Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : val,
    ) ?? ""
  );
}
