import {
  type BillingSource,
  type BillingSourceKind,
  ledgerKindFor,
  type Purpose,
} from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { RunPricing } from "../agent/loop.ts";
import {
  BILLING_FALLBACK_EVENT,
  type PlanUsage,
  planShareAfter,
  type TaskBillingPick,
  type TaskBillingRequest,
} from "../session/billing.ts";
import { tierFromId } from "./anthropic.ts";
import {
  type CallBilling,
  collectStream,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ProviderDeclaredCapabilities,
  type StreamEvent,
  type Usage,
} from "./types.ts";
import { USAGE_LIMIT_CODE } from "./usage-limit.ts";

/**
 * Every model call outside a task run follows the person's order (U-078, ADR 0100): chat, the PM
 * intake, the critic, the model watch and the monthly jobs ask the billing router per call which
 * of the person's credentials pays, and the call runs on the provider that credential is for:
 * the Messages adapter on an API key or plan credits, `ClaudeCodeProvider` on the subscription's
 * token (ADR 0098: the token never reaches the Messages API; ADR 0100: a key never reaches
 * Claude Code). One instance per purpose (`withPurpose`) shares the rest.
 *
 * - **Which source.** `RouterTaskBilling.pick` with the purpose of the caller, the person's
 *   order when they chose one, else `fallbackOrder` (ADR 0098's choice: the API key first), and
 *   the router's rules (caps, plan share, monthly limit, the rest after a usage limit, the
 *   credential in the vault).
 * - **Who paid.** `message_end` carries `billing` (`CallBilling`): the source, its ledger kind
 *   and, for a subscription, the plan share after the call. The loop driver books the call's
 *   ledger row to it, so the plan share and the key's monthly spend stay right.
 * - **Fallback.** A call that meets `provider_usage_limit` before it streamed anything rests the
 *   source (`rest`: until the reported reset, else an hour), is written to the session log and
 *   the audit log as a plain sentence, and is made once more on the next source. A second limit,
 *   or a limit after the reply began, is the call's error.
 */
export interface RoutedProviderDeps {
  /** The router over the person's sources (`RouterTaskBilling`). */
  billing: {
    pick(req: TaskBillingRequest): Promise<TaskBillingPick>;
    rest?(sourceId: string, resetAt: string | undefined, why: string): Promise<string>;
  };
  /** The provider a source's calls run on; null when none can (no credential, the fake row). */
  providerFor: (source: BillingSource) => Promise<ModelProvider | null>;
  /** The person's enabled sources (for `listModels` and `maxOutputTokens`). */
  sources: () => Promise<BillingSource[]>;
  humanId: string;
  /** The agent the picks name (the principal: non-task calls run for the daemon's own agents). */
  agentId: string;
  runner?: "pc" | "cloud";
  clock: Clock;
  /** Where a fallback is written: the call's session log and the audit log (best effort). */
  store?: Pick<StateStore, "event" | "auditLog">;
  /** The call's price, for the plan share a subscription row carries after the call. */
  pricing?: (modelId: string) => RunPricing;
  /** The order when the person chose none (`CALL_FALLBACK_ORDER`). */
  fallbackOrder?: readonly BillingSourceKind[];
  /** True when an API-style source exists: fast mode can apply (API only, spec D.20). */
  fastMode?: boolean;
  /** Each fallback as the session log words it (tests and the daemon's own log). */
  onFallback?: (sentence: string, info: FallbackInfo) => void;
}

export interface FallbackInfo {
  from: { sourceId: string; kind: BillingSourceKind; label: string };
  to: { sourceId: string; kind: BillingSourceKind; label: string } | null;
  restingUntil: string;
  purpose: Purpose;
  sessionId: string | null;
}

/** The audit row of a fallback. */
export const BILLING_FALLBACK_AUDIT_TOOL = "billing.fallback";

export class RoutedProvider implements ModelProvider {
  /** Anthropic's models, priced and laddered as the Messages adapter's are. */
  readonly name = "anthropic";
  readonly via = "routed" as const;
  readonly capabilities: ProviderDeclaredCapabilities = { acceptsTemperature: false };
  private readonly logger = log("routed-provider");

  constructor(
    private readonly deps: RoutedProviderDeps,
    readonly purpose: Purpose = "chat",
  ) {}

  /** The same routing for another purpose (the critic, the intake, the model watch). */
  withPurpose(purpose: Purpose): RoutedProvider {
    return new RoutedProvider(this.deps, purpose);
  }

  /** Fast mode is API only: offered when an API-style source exists; a subscription call drops it. */
  get fastMode(): boolean {
    return this.deps.fastMode === true;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** The models the first API-style source lists (Claude Code lists none for a token). */
  async listModels(): Promise<ModelRef[]> {
    const p = await this.apiProvider();
    return p ? p.listModels() : [];
  }

  async maxOutputTokens(
    model: string,
    opts?: { signal?: AbortSignal },
  ): Promise<number | undefined> {
    try {
      const p = await this.apiProvider();
      return p?.maxOutputTokens ? await p.maxOutputTokens(model, opts) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The source a call of this purpose would use now, without making one (the critic's fast-mode
   * decision reads its kind); null when none can serve.
   */
  async peek(model = "claude-sonnet-5-5"): Promise<BillingSource | null> {
    try {
      return (await this.pick(model, [])).source;
    } catch {
      return null;
    }
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const tried: string[] = [];
    let last: { source: BillingSource; event: StreamEvent & { type: "error" } } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let pick: TaskBillingPick;
      try {
        pick = await this.pick(req.model, tried);
      } catch (e) {
        if (last) {
          // The fallback found nothing: the limit is the call's error, and the log says so.
          await this.recordFallback(req, last.source, null, last.event);
          yield { ...last.event, sourceId: last.source.id };
          return;
        }
        yield {
          type: "error",
          code:
            e instanceof ForerunnerError && e.code === "unavailable"
              ? "unavailable"
              : "provider_error",
          message: noSourceMessage(e),
          retryable: false,
        };
        return;
      }
      const source = pick.source;
      if (last) await this.recordFallback(req, last.source, source, last.event);
      const provider = await this.deps.providerFor(source).catch(() => null);
      if (!provider) {
        yield {
          type: "error",
          code: "provider_auth",
          message: `${capital(labelOf(source))} has no credential saved; add it in Settings → Accounts and keys (the setup assistant).`,
          retryable: false,
          sourceId: source.id,
        };
        return;
      }
      // Fast mode is API only (spec D.20): a subscription call runs at the standard speed.
      const call: ModelRequest =
        source.kind === "subscription" && req.speed ? { ...req, speed: undefined } : req;
      let streamed = false;
      let failed: (StreamEvent & { type: "error" }) | null = null;
      for await (const ev of provider.stream(call)) {
        if (ev.type === "error") {
          failed = ev;
          break;
        }
        if (ev.type === "message_end") {
          yield { ...ev, billing: this.billingOf(source, pick.plan, req.model, ev.usage) };
          continue;
        }
        if (ev.type !== "message_start") streamed = true;
        yield ev;
      }
      if (!failed) return;
      if (failed.code !== USAGE_LIMIT_CODE) {
        yield { ...failed, sourceId: source.id };
        return;
      }
      tried.push(source.id);
      const until = await this.rest(source, failed);
      last = { source, event: { ...failed, ...(until ? { resetAt: until } : {}) } };
      // A reply that already began is not made twice: the limit is the call's error.
      if (streamed) {
        await this.recordFallback(req, source, null, last.event);
        yield { ...last.event, sourceId: source.id };
        return;
      }
    }
    // Two usage limits in a row: the second is the call's error (logged above as a fallback).
    if (last) {
      await this.recordFallback(req, last.source, null, last.event);
      yield { ...last.event, sourceId: last.source.id };
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.deps.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.deps.clock.monotonic(),
    );
  }

  private pick(model: string, exclude: readonly string[]): Promise<TaskBillingPick> {
    return this.deps.billing.pick({
      agentId: this.deps.agentId,
      agentOwnerHumanId: this.deps.humanId,
      runner: this.deps.runner ?? "pc",
      modelTier: tierFromId(model) ?? "sonnet",
      purpose: this.purpose,
      exclude: [...exclude],
      ...(this.deps.fallbackOrder ? { fallbackOrder: this.deps.fallbackOrder } : {}),
    });
  }

  private async rest(
    source: BillingSource,
    failed: StreamEvent & { type: "error" },
  ): Promise<string | undefined> {
    if (!this.deps.billing.rest) return failed.resetAt;
    try {
      return await this.deps.billing.rest(source.id, failed.resetAt, failed.message);
    } catch (e) {
      this.logger.warn("the source's rest was not saved", {
        sourceId: source.id,
        error: errorMessage(e),
      });
      return failed.resetAt;
    }
  }

  private billingOf(
    source: BillingSource,
    plan: PlanUsage | null,
    model: string,
    usage: Usage,
  ): CallBilling {
    const kind = ledgerKindFor(source.kind);
    if (source.kind !== "subscription" || !plan) return { sourceId: source.id, kind };
    let cost = 0;
    try {
      cost = this.deps.pricing?.(model).cost(usage) ?? 0;
    } catch {
      cost = 0;
    }
    return { sourceId: source.id, kind, planUsageShare: planShareAfter(plan, cost) };
  }

  /** The fallback as a plain sentence in the call's session log, an audit row and the log. */
  private async recordFallback(
    req: ModelRequest,
    from: BillingSource,
    to: BillingSource | null,
    failed: StreamEvent & { type: "error" },
  ): Promise<void> {
    const until = failed.resetAt ?? null;
    const sentence = fallbackSentence(from, to, until);
    const sessionId = req.origin?.sessionId ?? null;
    const info: FallbackInfo = {
      from: { sourceId: from.id, kind: from.kind, label: from.label },
      to: to ? { sourceId: to.id, kind: to.kind, label: to.label } : null,
      restingUntil: until ?? "",
      purpose: this.purpose,
      sessionId,
    };
    this.logger.warn("billing fallback", {
      from: from.id,
      to: to?.id ?? null,
      purpose: this.purpose,
      restingUntil: until,
    });
    this.deps.onFallback?.(sentence, info);
    const store = this.deps.store;
    if (!store) return;
    if (sessionId)
      await store.event
        .append(sessionId, BILLING_FALLBACK_EVENT, {
          sentence,
          from: from.id,
          to: to?.id ?? null,
          purpose: this.purpose,
          restingUntil: until,
        })
        .catch(() => undefined);
    await store.auditLog
      .append({
        tool: BILLING_FALLBACK_AUDIT_TOOL,
        allowed: true,
        human_id: this.deps.humanId,
        agent_id: this.deps.agentId,
        input_summary: JSON.stringify({ from: from.id, to: to?.id ?? null, purpose: this.purpose }),
        result_summary: sentence.slice(0, 500),
        occurred_at: this.deps.clock.nowIso(),
      })
      .catch(() => undefined);
  }

  private async apiProvider(): Promise<ModelProvider | null> {
    const sources = await this.deps.sources().catch(() => [] as BillingSource[]);
    for (const s of sources) {
      if (s.kind !== "api_key" && s.kind !== "plan_credits") continue;
      const p = await this.deps.providerFor(s).catch(() => null);
      if (p) return p;
    }
    return null;
  }
}

/** How a person names a source in a sentence: "the Claude subscription", "the API key". */
export function labelOf(source: Pick<BillingSource, "kind" | "label">): string {
  switch (source.kind) {
    case "subscription":
      return "the Claude subscription";
    case "api_key":
      return "the API key";
    case "plan_credits":
      return "the plan credits";
    default:
      return source.label;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An ISO time as the session log says it: "2026-11-01 15:00 UTC". */
export function plainTime(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "later";
  const d = new Date(iso).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

/** The session log's sentence for a fallback (U-078): what ran out, until when, what answered. */
export function fallbackSentence(
  from: Pick<BillingSource, "kind" | "label">,
  to: Pick<BillingSource, "kind" | "label"> | null,
  restingUntil: string | null,
): string {
  const head = `${capital(labelOf(from))} reached its usage limit and rests until ${plainTime(restingUntil)}`;
  return to
    ? `${head}; ${labelOf(to)} answered instead.`
    : `${head}; no other Claude credential can be used now.`;
}

/** Why no source can serve, from the router's skips, in plain words. */
function noSourceMessage(e: unknown): string {
  const skipped = (e instanceof ForerunnerError ? e.details.skipped : undefined) as
    | { kind?: BillingSourceKind; code?: string; reason?: string }[]
    | undefined;
  const why = (skipped ?? [])
    .filter((s) => s.kind !== "fake")
    .map(
      (s) =>
        `${labelOf({ kind: s.kind ?? "fake", label: s.kind ?? "a source" })}: ${skipWords(s.code, s.reason)}`,
    );
  return why.length
    ? `No Claude credential can be used now (${why.join("; ")}).`
    : `No Claude credential can be used now: ${errorMessage(e)}`;
}

function skipWords(code: string | undefined, reason: string | undefined): string {
  switch (code) {
    case "cooldown":
      return "resting after a usage limit";
    case "plan_share":
      return "its allowance is reached";
    case "monthly_limit":
      return "its monthly cap is reached";
    case "unavailable":
      return "no credential saved";
    case "purpose":
      return "not used for this work";
    default:
      return reason ?? code ?? "not available";
  }
}
