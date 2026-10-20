import {
  type LedgerEntry as BillingLedgerEntry,
  type BillingSource,
  BUILTIN_PRICING,
  type CapChecker,
  costOf,
  estimateUsdMicro,
  type LedgerFilter,
  type LedgerQuery,
  type LedgerSink,
  type LedgerSum,
  type PricingTable,
  type StoredLedgerEntry,
} from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import type { RunPricing } from "../agent/loop.ts";
import type { CapDecision, CapScope, CapsPort } from "../enforcement/ports.ts";

/** The state store's cost ledger as the billing package's sink and query. */
export class StateLedgerStore implements LedgerSink, LedgerQuery {
  constructor(private readonly store: StateStore) {}

  async record(entry: BillingLedgerEntry): Promise<StoredLedgerEntry> {
    const row = await this.store.costLedger.record({
      ...(entry.id ? { id: entry.id } : {}),
      human_id: entry.human_id,
      agent_id: entry.agent_id ?? null,
      project_id: entry.project_id ?? null,
      session_id: entry.session_id ?? null,
      task_id: entry.task_id ?? null,
      run_id: entry.run_id ?? null,
      billing_source_id: entry.billing_source_id,
      kind: entry.kind,
      usd_micro: entry.usd_micro,
      chf_micro: entry.chf_micro,
      rate_chf_per_usd: entry.rate_chf_per_usd,
      plan_usage_share: entry.plan_usage_share ?? null,
      model: entry.model,
      specialist: entry.specialist ?? null,
      tokens_in: entry.tokens_in,
      tokens_out: entry.tokens_out,
      cache_read_tokens: entry.cache_read_tokens,
      cache_write_tokens: entry.cache_write_tokens,
      occurred_at: entry.occurred_at,
    });
    return { ...entry, id: row.id };
  }

  async sum(filter: LedgerFilter): Promise<LedgerSum> {
    const s = await this.store.costLedger.sum(filter);
    return {
      usd_micro: s.usd_micro,
      chf_micro: s.chf_micro,
      plan_usage_share: (s as { plan_usage_share?: number | null }).plan_usage_share ?? null,
      entries: (s as { entries?: number }).entries ?? 0,
      tokens_in: (s as { tokens_in?: number }).tokens_in ?? 0,
      tokens_out: (s as { tokens_out?: number }).tokens_out ?? 0,
      cache_read_tokens: (s as { cache_read_tokens?: number }).cache_read_tokens ?? 0,
      cache_write_tokens: (s as { cache_write_tokens?: number }).cache_write_tokens ?? 0,
    };
  }

  async list(filter: LedgerFilter): Promise<StoredLedgerEntry[]> {
    const rows = await this.store.costLedger.list(
      {
        ...(filter.humanId ? { human_id: filter.humanId } : {}),
        ...(filter.agentId ? { agent_id: filter.agentId } : {}),
        ...(filter.projectId ? { project_id: filter.projectId } : {}),
        ...(filter.sessionId ? { session_id: filter.sessionId } : {}),
        ...(filter.taskId ? { task_id: filter.taskId } : {}),
        ...(filter.runId ? { run_id: filter.runId } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
      } as never,
      { limit: 10_000 },
    );
    return rows
      .filter(
        (r) =>
          (!filter.from || r.occurred_at >= filter.from) &&
          (!filter.to || r.occurred_at < filter.to),
      )
      .map((r) => ({ ...r, id: r.id }));
  }
}

/** Outer caps (task, project, month, plan share) through the billing CapChecker. */
export class BillingCaps implements CapsPort {
  constructor(
    private readonly checker: CapChecker,
    private readonly planUsageShare?: () => number | undefined,
    private readonly sourceKind?: BillingSource["kind"],
  ) {}

  async check(
    scope: CapScope,
    estimateUsdMicro: number,
    opts: { phase: "work" | "review" },
  ): Promise<CapDecision> {
    const r = await this.checker.check(scope, estimateUsdMicro, {
      phase: opts.phase,
      planUsageShare: this.planUsageShare?.(),
      sourceKind: this.sourceKind,
    });
    return {
      decision: r.decision,
      level: r.level ?? undefined,
      spentUsdMicro: r.spent,
      capUsdMicro: r.cap,
      remainingUsdMicro: r.remaining,
      message: r.message,
    };
  }
}

/** Pricing for one model, as the loop driver wants it. */
export function pricingFor(modelId: string, table: PricingTable = BUILTIN_PRICING): RunPricing {
  return {
    estimate: (inputTokens, maxOutputTokens) =>
      estimateUsdMicro({ inputTokens, maxOutputTokens }, modelId, table),
    cost: (u) =>
      costOf(
        {
          tokens_in: u.input_tokens,
          tokens_out: u.output_tokens,
          cache_read_tokens: u.cache_read_input_tokens,
          cache_write_tokens: u.cache_creation_input_tokens,
        },
        modelId,
        table,
      ),
  };
}

/** Billing sources from the state store, in the shape the router expects. */
export function stateSources(store: StateStore): (humanId: string) => Promise<BillingSource[]> {
  return async (humanId) => {
    const rows = await store.billingSource.enabledFor(humanId);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as BillingSource["kind"],
      humanId: r.human_id,
      label: r.label,
      credentialRef: r.credential_ref ?? "",
      enabled: r.enabled,
      priority: r.priority,
      limits: (r.limits as BillingSource["limits"]) ?? {},
    }));
  };
}

/**
 * The one credential a run gets, read from the vault by the source's reference name. The
 * value goes straight into the provider or the SDK subprocess env, never into model context.
 */
export async function credentialFor(
  source: BillingSource,
  vault: Vault,
): Promise<{ kind: "api_key" | "oauth_token"; value: string }> {
  if (source.kind === "fake") return { kind: "api_key", value: "fake" };
  const value = await vault.get(source.credentialRef);
  if (!value) {
    throw new ForerunnerError(
      "provider_auth",
      `billing source ${source.label} has no credential in the vault (${source.credentialRef})`,
      {
        details: { sourceId: source.id, credentialRef: source.credentialRef },
      },
    );
  }
  return { kind: source.kind === "subscription" ? "oauth_token" : "api_key", value };
}
