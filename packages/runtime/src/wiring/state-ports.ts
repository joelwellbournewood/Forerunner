import type { DecisionRow, HumanRequestRow, StateStore } from "@forerunner/state";
import type {
  ApprovalOutcome,
  ApprovalPort,
  ApprovalRequest,
  AuditEntry,
  AuditPort,
  LedgerEntry,
  LedgerPort,
} from "../enforcement/ports.ts";

/**
 * Adapters from the state store to the enforcement ports. The runtime never talks to the
 * database directly; everything durable goes through these.
 */
export interface StatePortsOptions {
  /** CHF per USD for ledger rows; the billing package supplies the daily rate. */
  chfPerUsd: () => number;
}

export class StateLedger implements LedgerPort {
  constructor(
    private readonly store: StateStore,
    private readonly opts: StatePortsOptions,
  ) {}
  async record(e: LedgerEntry): Promise<void> {
    const rate = this.opts.chfPerUsd();
    await this.store.costLedger.record({
      human_id: e.humanId,
      agent_id: e.agentId,
      project_id: e.projectId ?? null,
      session_id: e.sessionId,
      task_id: e.taskId ?? null,
      run_id: e.runId,
      billing_source_id: e.billingSourceId,
      kind: "api",
      usd_micro: e.usdMicro,
      chf_micro: Math.round(e.usdMicro * rate),
      rate_chf_per_usd: rate,
      model: e.model,
      tokens_in: e.tokensIn,
      tokens_out: e.tokensOut,
      cache_read_tokens: e.cacheReadTokens,
      cache_write_tokens: e.cacheWriteTokens,
      occurred_at: e.occurredAt,
    });
  }
}

export class StateAudit implements AuditPort {
  constructor(private readonly store: StateStore) {}
  async append(e: AuditEntry): Promise<void> {
    await this.store.auditLog.append({
      session_id: e.sessionId,
      run_id: e.runId,
      agent_id: e.agentId,
      human_id: e.humanId,
      tool: e.tool,
      input_summary: e.inputSummary,
      result_summary: e.resultSummary,
      allowed: e.allowed,
      denied_reason: e.deniedReason ?? null,
      cost_usd_micro: e.costUsdMicro,
      occurred_at: e.occurredAt,
      token_id: e.tokenId,
    });
  }
}

/**
 * Approvals become HumanRequests. A request for the same tool and input that was already
 * answered "yes" in this session counts as approved; "no" as denied; otherwise it is pending
 * and the run pauses until the human answers (the session resumes it later).
 */
export class StateApprovals implements ApprovalPort {
  constructor(private readonly store: StateStore) {}

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const key = approvalKey(req);
    const existing = await this.store.humanRequest.list(
      { session_id: req.sessionId, kind: "approval" },
      { orderBy: [{ column: "created_at", direction: "desc" }] },
    );
    const same = existing.find((r) => (r.change_card as { key?: string } | null)?.key === key);
    if (same) {
      if (same.status === "answered") return isYes(same.answer) ? "approved" : "denied";
      return "pending";
    }
    await this.store.humanRequest.insert({
      human_id: req.humanId,
      project_id: req.projectId ?? null,
      task_id: req.taskId ?? null,
      session_id: req.sessionId,
      kind: "approval",
      why: req.why,
      steps: [`Tool: ${req.tool}`, `Action class: ${req.actionClass}`],
      options: ["yes", "no"],
      blocking: true,
      risk: req.risk,
      change_card: {
        key,
        tool: req.tool,
        actionClass: req.actionClass,
        input: req.input as never,
        estimateUsdMicro: req.estimateUsdMicro ?? null,
      },
      author_agent: req.agentId,
    });
    return "pending";
  }
}

export function approvalKey(req: Pick<ApprovalRequest, "tool" | "input">): string {
  const s = JSON.stringify(req.input, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort())
      : v,
  );
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${req.tool}:${(h >>> 0).toString(16)}`;
}

export function isYes(answer: unknown): boolean {
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string")
    return /^(y|yes|ok|approve|approved|ja|oui|sí|si|confirm|confirmed)$/i.test(answer.trim());
  if (answer && typeof answer === "object")
    return isYes(
      (answer as { choice?: unknown; answer?: unknown }).choice ??
        (answer as { answer?: unknown }).answer,
    );
  return false;
}

export function statePorts(
  store: StateStore,
  opts: StatePortsOptions,
): { ledger: StateLedger; audit: StateAudit; approvals: StateApprovals } {
  return {
    ledger: new StateLedger(store, opts),
    audit: new StateAudit(store),
    approvals: new StateApprovals(store),
  };
}

/**
 * Decision log (spec J): an answered decision is recorded per project and the same question
 * is never asked again unless a newer answer supersedes it. Callers that need a decision go
 * through ask(); the daemon records answers through recordAnswer().
 */
export class DecisionLog {
  constructor(private readonly store: StateStore) {}

  /**
   * Open a decision request, unless the project already answered the same question: then
   * the recorded decision is returned and no request is opened.
   */
  async ask(
    input: Parameters<StateStore["humanRequest"]["insert"]>[0] & { kind: "decision" },
  ): Promise<{ request: HumanRequestRow | null; decision: DecisionRow | null }> {
    const projectId = typeof input.project_id === "string" ? input.project_id : null;
    const question = typeof input.why === "string" ? input.why : "";
    if (projectId && question) {
      const decision = await this.store.decision.findAnswered(projectId, question);
      if (decision) return { request: null, decision };
    }
    const request = await this.store.humanRequest.insert(input);
    return { request, decision: null };
  }

  /** Record the answer of an answered request of kind "decision"; supersedes an older answer. */
  async recordAnswer(
    request: HumanRequestRow,
    decidedBy: string,
    rationale = "",
  ): Promise<DecisionRow | null> {
    if (request.kind !== "decision" || request.status !== "answered" || !request.project_id)
      return null;
    const chosen =
      typeof request.answer === "string" ? request.answer : JSON.stringify(request.answer ?? "");
    const input = {
      project_id: request.project_id,
      question: request.why,
      options: request.options,
      chosen,
      decided_by: decidedBy,
      rationale,
      author_human: decidedBy,
    };
    const existing = await this.store.decision.findAnswered(request.project_id, request.why);
    if (existing) {
      if (existing.chosen === chosen) return existing;
      return this.store.decision.supersede(existing.id, input as never);
    }
    return this.store.decision.record(input as never);
  }

  current(projectId: string): Promise<DecisionRow[]> {
    return this.store.decision.current(projectId);
  }
}
