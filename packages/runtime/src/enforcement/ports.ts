/**
 * Small ports the enforcement layer depends on. Concrete adapters (billing CapChecker, vault
 * resolveSecretRefs, state repos) are wired in src/wiring.ts so this layer stays testable with
 * in-memory fakes and never depends on a database being present.
 */
export interface CapScope {
  humanId: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export type CapLevel = "month" | "project" | "session" | "task" | "run" | "plan";

export interface CapDecision {
  decision: "allow" | "finish_current" | "stop";
  level?: CapLevel;
  spentUsdMicro?: number;
  capUsdMicro?: number;
  remainingUsdMicro?: number;
  message?: string;
}

/** How a run is billed (ADR 0044): the ledger kind of its rows and, for a subscription, the plan share. */
export type BillingKind = "api" | "subscription" | "plan_credits";

/**
 * The billing facts a caps check and a ledger row need from the run (ADR 0044). The caps
 * port adds the plan level for a subscription (`planUsageShare` against `planShareCap`); the
 * ledger port writes `kind` and the share on every row.
 */
export interface CapsBilling {
  sourceId: string;
  kind: BillingKind;
  /** Plan usage share (0..1) of the subscription right now; absent when unknown. */
  planUsageShare?: number;
  /** The source's own cap on that share; absent for the policy default. */
  planShareCap?: number;
}

export interface CapsPort {
  check(
    scope: CapScope,
    estimateUsdMicro: number,
    opts: { phase: "work" | "review"; billing?: CapsBilling },
  ): Promise<CapDecision> | CapDecision;
}

export interface SecretsPort {
  /** Replace whole-string "secret:<name>" values with vault values when granted; throw otherwise. */
  resolve(input: unknown, granted: ReadonlySet<string>): Promise<unknown>;
  /** Scrub any secret value that was resolved during this run out of a string. */
  redact(text: string): string;
}

export interface AuditEntry {
  sessionId: string;
  runId: string;
  agentId: string;
  humanId: string;
  tool: string;
  inputSummary: string;
  resultSummary: string;
  allowed: boolean;
  deniedReason?: string;
  costUsdMicro: number;
  occurredAt: string;
  tokenId: string;
}

export interface AuditPort {
  append(entry: AuditEntry): Promise<void> | void;
}

export interface ApprovalRequest {
  sessionId: string;
  runId: string;
  agentId: string;
  humanId: string;
  projectId?: string;
  taskId?: string;
  tool: string;
  actionClass: string;
  risk: "low" | "medium" | "high";
  why: string;
  input: unknown;
  estimateUsdMicro?: number;
}

export type ApprovalOutcome = "approved" | "denied" | "pending";

export interface ApprovalPort {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;
}

export interface LedgerEntry {
  humanId: string;
  agentId: string;
  projectId?: string;
  sessionId: string;
  taskId?: string;
  runId: string;
  model: string;
  provider: string;
  billingSourceId: string;
  /** Ledger kind of the row; default "api". A subscription run's rows are "subscription" (an estimate). */
  kind?: BillingKind;
  /** Plan usage share after this call (subscriptions), 0..1; absent when unknown. */
  planUsageShare?: number | null;
  usdMicro: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  occurredAt: string;
}

export interface LedgerPort {
  record(entry: LedgerEntry): Promise<void> | void;
}

/** In-memory fakes for tests and for solo mode bootstrapping. */
export class AllowAllCaps implements CapsPort {
  check(): CapDecision {
    return { decision: "allow" };
  }
}

export class NoSecrets implements SecretsPort {
  async resolve(input: unknown): Promise<unknown> {
    return input;
  }
  redact(text: string): string {
    return text;
  }
}

export class MemoryAudit implements AuditPort {
  readonly entries: AuditEntry[] = [];
  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

export class MemoryLedger implements LedgerPort {
  readonly entries: LedgerEntry[] = [];
  record(entry: LedgerEntry): void {
    this.entries.push(entry);
  }
  total(
    filter: Partial<
      Pick<LedgerEntry, "sessionId" | "runId" | "taskId" | "projectId" | "humanId">
    > = {},
  ): number {
    return this.entries
      .filter((e) =>
        Object.entries(filter).every(
          ([k, v]) => v === undefined || (e as unknown as Record<string, unknown>)[k] === v,
        ),
      )
      .reduce((s, e) => s + e.usdMicro, 0);
  }
}

export class AutoApprove implements ApprovalPort {
  constructor(readonly outcome: ApprovalOutcome = "approved") {}
  readonly requests: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(req);
    return this.outcome;
  }
}
