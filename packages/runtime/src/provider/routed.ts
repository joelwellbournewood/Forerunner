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
import { type CredentialWait, clockTime, credentialWaitOf } from "../session/credential-wait.ts";
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
 * - **Which source.** `RouterTaskBilling.pick` with the purpose of the caller under the person's
 *   credential policy (CE-1, CE-4, ADR 0120: one order and one rule at a stop for every call; the
 *   non-task calls' own order, ADR 0098's API key first, is gone), and the router's rules (caps,
 *   plan share, monthly limit, the rest after a usage limit, the credential in the vault).
 * - **Who paid.** `message_end` carries `billing` (`CallBilling`): the source, its ledger kind
 *   and, for a subscription, the plan share after the call. The loop driver books the call's
 *   ledger row to it, so the plan share and the key's monthly spend stay right.
 * - **Fallback.** A call that meets `provider_usage_limit` (or a refusal) before it streamed
 *   anything rests (or marks) the source and picks again under the person's rule: under `next`
 *   it is made once more on the next source, written to the session log and the audit log as a
 *   plain sentence; under `wait` and `ask` the pick holds (the stopped source goes to the router
 *   as held), so the call ends with the limit and no other credential is asked (CE-4: before,
 *   every non-task call moved, so a subscription at its limit sent chat, planning and the
 *   critic's reviews to the API key while the app said the work waits). A second limit, or a
 *   limit after the reply began, is the call's error.
 */
export interface RoutedProviderDeps {
  /** The router over the person's sources (`RouterTaskBilling`). */
  billing: {
    pick(req: TaskBillingRequest): Promise<TaskBillingPick>;
    rest?(sourceId: string, resetAt: string | undefined, why: string): Promise<string>;
    /** Anthropic refused the source's credential (U-078): marked, skipped, one card. */
    refuse?(sourceId: string, why: string): Promise<void>;
    /** A project's work waits for the source (its reset, a new credential; U-078). */
    noteWait?(sourceId: string, projectId: string, agentId: string): Promise<void>;
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
  /** True when an API-style source exists: fast mode can apply (API only, spec D.20). */
  fastMode?: boolean;
  /** Each fallback as the session log words it (tests and the daemon's own log). */
  onFallback?: (sentence: string, info: FallbackInfo) => void;
  /** CE-11: the person's time zone, so the session log names the time in their clock. */
  timezone?: () => Promise<string | undefined>;
  /**
   * CE-8: whether Anthropic's refusal of this source stands (its credential was not replaced
   * since): such a source is asked nothing, not even the model list or a model's output limit,
   * until a different credential is saved.
   */
  refused?: (source: BillingSource) => Promise<boolean>;
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
    /** CE-9: this instance's calls may move to the next credential at a stop (one chat turn). */
    private readonly allowSwitch = false,
  ) {}

  /** The same routing for another purpose (the critic, the intake, the model watch). */
  withPurpose(purpose: Purpose): RoutedProvider {
    return new RoutedProvider(this.deps, purpose);
  }

  /**
   * CE-9: the same routing for one chat question the person pressed "Use API key" for: its calls
   * may move to the next credential at a stop (no grant, no card, never a background job).
   */
  withOneOffSwitch(): RoutedProvider {
    return new RoutedProvider(this.deps, this.purpose, this.purpose !== "batch");
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

  /**
   * What a call of this purpose would wait for now, without making one (U-078): the wait the
   * router's "no source" means (the only credential that may serve it is refused or resting),
   * or null when one can serve or none is saved at all. The intake asks it after a planning
   * call failed, so the plan waits for the credential instead of failing.
   */
  async waitNow(model = "claude-sonnet-5-5"): Promise<CredentialWait | null> {
    try {
      await this.pick(model, []);
      return null;
    } catch (e) {
      return credentialWaitOf(e);
    }
  }

  /**
   * CE-4, CE-9: whether a call of this purpose would be held now under the person's rule (the
   * wait), and whether a one-off switch could serve it (`switchTo`: the source that would; null
   * when none could). Null when the call would be made. Nothing is spent: the picks only read.
   */
  async holdNow(
    model = "claude-sonnet-5-5",
  ): Promise<{ wait: CredentialWait; switchTo: BillingSource | null } | null> {
    if (this.allowSwitch) return null;
    let wait: CredentialWait | null = null;
    try {
      await this.pick(model, []);
      return null;
    } catch (e) {
      wait = credentialWaitOf(e);
    }
    if (!wait) return null;
    let switchTo: BillingSource | null = null;
    if (wait.reason !== "needs")
      try {
        switchTo = (await this.pick(model, [], true)).source;
      } catch {
        switchTo = null;
      }
    return { wait, switchTo };
  }

  /**
   * A project's work waits for this source (U-078): kept on it (`limits.waiting`), so the
   * project's session starts by itself once the source serves again. The critic's review of a
   * task that no credential could serve asks it (the task runs again then and is reviewed).
   */
  async noteWait(sourceId: string, projectId: string, agentId: string): Promise<void> {
    await this.deps.billing.noteWait?.(sourceId, projectId, agentId);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const tried: string[] = [];
    let last: { source: BillingSource; event: StreamEvent & { type: "error" } } | null = null;
    /** The refusal a fallback met (U-078): the call's error when no other source can serve. */
    let refusedLast: (StreamEvent & { type: "error" }) | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let pick: TaskBillingPick;
      try {
        pick = await this.pick(req.model, tried);
      } catch (e) {
        if (last) {
          // The fallback found nothing, or the person's rule holds (CE-4: no other credential is
          // asked under 'wait' and 'ask'): the limit is the call's error, and the log says so.
          await this.recordFallback(req, last.source, null, last.event, heldByRule(e));
          yield { ...last.event, sourceId: last.source.id };
          return;
        }
        if (refusedLast) {
          yield refusedLast;
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
      // The input side of the bill, as message_start said it (a call cut off before its end).
      let startUsage: Usage | null = null;
      for await (const ev of provider.stream(call)) {
        if (ev.type === "error") {
          failed = ev;
          break;
        }
        if (ev.type === "message_end") {
          yield { ...ev, billing: this.billingOf(source, pick.plan, req.model, ev.usage) };
          continue;
        }
        if (ev.type === "message_start" && ev.usage) startUsage = ev.usage;
        if (ev.type !== "message_start") streamed = true;
        yield ev;
      }
      if (!failed) return;
      // U-078: a credential Anthropic refused (a 401 or 403 key, an expired sign-in) is marked
      // refused like a task run's (one card, skipped until a new one is saved), and the call is
      // made once more on the next source, as at a usage limit.
      const refused = failed.code === "provider_auth";
      if (failed.code !== USAGE_LIMIT_CODE && !refused) {
        // l4-cred-engine L4-creds-5: a call cut off (Stop, a timeout) or failed after it began
        // is booked on the source that served it, as a finished call is (`billing`).
        yield {
          ...failed,
          sourceId: source.id,
          ...(startUsage
            ? { billing: this.billingOf(source, pick.plan, req.model, startUsage) }
            : {}),
        };
        return;
      }
      tried.push(source.id);
      if (refused) {
        await this.refuse(source, failed);
        if (streamed) {
          yield { ...failed, sourceId: source.id };
          return;
        }
        last = null;
        refusedLast = { ...failed, sourceId: source.id };
        continue;
      }
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
      return;
    }
    if (refusedLast) yield refusedLast;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.deps.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.deps.clock.monotonic(),
    );
  }

  private pick(
    model: string,
    exclude: readonly string[],
    allowSwitch = this.allowSwitch,
  ): Promise<TaskBillingPick> {
    // One order for every call (CE-4): the person's policy, read in the pick; no order of its own.
    return this.deps.billing.pick({
      agentId: this.deps.agentId,
      agentOwnerHumanId: this.deps.humanId,
      runner: this.deps.runner ?? "pc",
      modelTier: tierFromId(model) ?? "sonnet",
      purpose: this.purpose,
      exclude: [...exclude],
      ...(allowSwitch ? { allowSwitch: true } : {}),
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

  /** Marks the source refused (U-078), best effort: a mark not saved never fails the call. */
  private async refuse(source: BillingSource, failed: StreamEvent & { type: "error" }) {
    if (!this.deps.billing.refuse) return;
    try {
      await this.deps.billing.refuse(source.id, failed.message);
    } catch (e) {
      this.logger.warn("the refused credential was not marked", {
        sourceId: source.id,
        error: errorMessage(e),
      });
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
    held = false,
  ): Promise<void> {
    const until = failed.resetAt ?? null;
    const timezone = await this.deps.timezone?.().catch(() => undefined);
    const sentence = fallbackSentence(from, to, until, {
      ...(timezone ? { timezone } : {}),
      nowMs: this.deps.clock.now(),
      held,
    });
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

  /**
   * The first API-style source's provider, for the model list and a model's output limit; never
   * one whose refusal stands (CE-8: a refused key gets no second request from any path; before,
   * the model list asked it again after its 401).
   */
  private async apiProvider(): Promise<ModelProvider | null> {
    const sources = await this.deps.sources().catch(() => [] as BillingSource[]);
    for (const s of sources) {
      if (s.kind !== "api_key" && s.kind !== "plan_credits") continue;
      if (await this.deps.refused?.(s).catch(() => true)) continue;
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

/**
 * The session log's sentence for a fallback (U-078): what ran out, until when (CE-11: in the
 * person's clock, never UTC), what answered, or that the person's rule holds the work for it.
 */
export function fallbackSentence(
  from: Pick<BillingSource, "kind" | "label">,
  to: Pick<BillingSource, "kind" | "label"> | null,
  restingUntil: string | null,
  opts: { timezone?: string; nowMs?: number; held?: boolean } = {},
): string {
  const at =
    restingUntil && Number.isFinite(Date.parse(restingUntil))
      ? clockTime(restingUntil, opts.timezone, opts.nowMs ?? Date.parse(restingUntil))
      : "later";
  const head = `${capital(labelOf(from))} reached its usage limit and rests until ${at}`;
  if (to) return `${head}; ${labelOf(to)} answered instead.`;
  return opts.held
    ? `${head}; the work waits for it, as you chose.`
    : `${head}; no other Claude credential can be used now.`;
}

/** Whether a pick's "no source" is the person's rule holding to a stopped first choice (CE-4). */
function heldByRule(e: unknown): boolean {
  return (
    e instanceof ForerunnerError && !!(e.details as { waitFor?: unknown } | undefined)?.waitFor
  );
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
    case "refused":
      return "Anthropic refused it; save a new one in Settings";
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
