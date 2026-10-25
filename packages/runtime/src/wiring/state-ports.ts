import { ForerunnerError } from "@forerunner/platform";
import type { DecisionRow, HumanRequestRow, StateStore } from "@forerunner/state";
import { type ActionClass, ALWAYS_HUMAN } from "../enforcement/autonomy.ts";
import { approvalKeyFor } from "../enforcement/hooks.ts";
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
      // A subscription run's rows are "subscription": an API-equivalent estimate with the plan
      // share the run reports (ADR 0044); everything else is exact "api" spend.
      kind: e.kind ?? "api",
      usd_micro: e.usdMicro,
      chf_micro: Math.round(e.usdMicro * rate),
      rate_chf_per_usd: rate,
      plan_usage_share: e.planUsageShare ?? null,
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

/** The part of `change_card` this port reads and writes on an approval row. */
interface ApprovalChangeCard {
  key?: string;
  actionClass?: string;
  /** When an always-human "yes" was handed out; a spent row never approves again. */
  consumedAt?: string;
  /** The run the "yes" was handed to. */
  consumedByRun?: string;
}

/**
 * Approvals become HumanRequests, matched by `change_card.key` within the session and, when
 * the call names a task, across the agent's sessions of that task (the rows with the same
 * `task_id`, filed by the same agent for the same human; ADR 0088), so an answer that comes
 * after the filing session ended is found by the next session of the task. An open row for
 * the same key keeps the call pending; a "no" denies it for the session (and the task); a
 * "yes" approves it. For an always-human class (`ALWAYS_HUMAN`: delete, purchase, credential,
 * permission, capability grant) the "yes" admits exactly one call: the row is marked spent
 * (`consumedAt`, `consumedByRun`; an envelope update, so the version moves) as the answer is
 * handed out, before the call runs, and the next identical request files a new row and waits.
 * Spent when handed out rather than after the call, so a call that then fails for another
 * reason (a secret not granted, a network error) has used its answer and the human is asked
 * afresh: conservative on purpose for the classes that always need a human. Two consumers of
 * one "yes" cannot both take it (optimistic concurrency: the loser asks afresh). Every other
 * class's "yes" holds for the session and the task. A withdrawn or expired row holds nothing:
 * the next request files a new one.
 */
export class StateApprovals implements ApprovalPort {
  constructor(private readonly store: StateStore) {}

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const key = approvalKey(req);
    const rows = (await this.rowsFor(req)).filter((r) => cardOf(r).key === key);
    if (rows.some((r) => r.status === "open")) return "pending";
    const latest = rows.find((r) => r.status === "answered");
    if (latest) {
      if (!isYes(latest.answer)) return "denied";
      const card = cardOf(latest);
      const oneShot = isAlwaysHuman(req.actionClass) || isAlwaysHuman(card.actionClass);
      if (!oneShot) return "approved";
      if (!card.consumedAt) {
        try {
          await this.store.humanRequest.update(latest.id, latest.version, {
            change_card: {
              ...(latest.change_card ?? {}),
              consumedAt: this.store.clock.nowIso(),
              consumedByRun: req.runId,
            },
          });
          return "approved";
        } catch (e) {
          // Another consumer took the "yes" between the read and the write: ask afresh.
          if (!(e instanceof ForerunnerError && e.code === "version_conflict")) throw e;
        }
      }
      // spent: a new question below
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

  /**
   * The approval rows a request is matched against, newest first: the session's own, plus,
   * for a call that names a task, the rows of that task filed by the same agent for the same
   * human in its earlier sessions (an answer given after a session ended is otherwise never
   * found, ADR 0088). Another agent's row for the task, or one addressed to another human, is
   * never this call's answer.
   */
  private async rowsFor(req: ApprovalRequest): Promise<HumanRequestRow[]> {
    const order = {
      orderBy: [
        { column: "created_at", direction: "desc" as const },
        { column: "id", direction: "desc" as const },
      ],
    };
    const own = await this.store.humanRequest.list(
      { session_id: req.sessionId, kind: "approval" },
      order,
    );
    if (!req.taskId) return own;
    const seen = new Set(own.map((r) => r.id));
    const ofTask = (
      await this.store.humanRequest.list({ task_id: req.taskId, kind: "approval" }, order)
    ).filter(
      (r) => !seen.has(r.id) && r.author_agent === req.agentId && r.human_id === req.humanId,
    );
    return [...own, ...ofTask].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
    );
  }
}

function cardOf(row: Pick<HumanRequestRow, "change_card">): ApprovalChangeCard {
  return (row.change_card ?? {}) as ApprovalChangeCard;
}

function isAlwaysHuman(actionClass: string | undefined): boolean {
  return actionClass !== undefined && ALWAYS_HUMAN.has(actionClass as ActionClass);
}

/**
 * The durable key of an approval (`change_card.key`): the hooks' collision-resistant key, a
 * SHA-256 of the canonical raw input (`req.key`, computed by the hooks before the input was
 * cut for the card; else computed here from `req.input`, which must then be the raw input),
 * so an answer for one input never admits another that displays alike or whose 32-bit string
 * hash happened to match. A row written under a former key no longer matches, which fails
 * closed: the human is asked again once.
 */
export function approvalKey(req: Pick<ApprovalRequest, "tool" | "input" | "key">): string {
  return req.key ?? approvalKeyFor(req.tool, req.input);
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
