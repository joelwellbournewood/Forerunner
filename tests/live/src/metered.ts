import { type Clock, errorMessage, systemClock } from "@forerunner/platform";
import {
  collectStream,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Usage,
} from "@forerunner/runtime";
import { type LiveBudget, LiveBudgetError } from "./budget.ts";
import type { SpendRow } from "./ledger.ts";

/**
 * The budget gate in front of a real provider. Every call, from any driver (the agent loop, the
 * critic, the conversation agent, a direct `complete`), passes through `stream()`: the budget
 * takes a reservation before the request leaves (a refusal throws before anything is sent),
 * the usage the provider reports is written to the ledger when the stream ends, and a failed or
 * aborted call still writes its row with whatever the provider reported. The adapter's
 * `signal` reaches the inner provider unchanged, so the kill switch aborts a live call the
 * same way it aborts a fake one.
 */
export type LiveCallStatus = "ok" | "error" | "aborted" | "refused";

export interface LiveCall {
  at: string;
  model: string;
  estimateUsd: number;
  status: LiveCallStatus;
  /** The refusal or the error text, passed through the `redact` option before it is kept. */
  reason?: string;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  durationMs: number;
  ttftMs: number | null;
  stopReason: string | null;
}

export interface MeteredProviderOptions {
  clock?: Clock;
  /** Called after every call, allowed or refused, with its record (audit rows, logs). */
  onCall?: (call: LiveCall) => void | Promise<void>;
  /**
   * Applied to every error text (an error event's message, a thrown error's message) before
   * it is recorded in the call, the ledger note or the audit row: the harness passes
   * `redactCredentials` so an SDK error that echoes a header never lands anywhere.
   */
  redact?: (text: string) => string;
}

export class MeteredProvider implements ModelProvider {
  readonly name: string;
  readonly calls: LiveCall[] = [];
  private readonly clock: Clock;

  constructor(
    readonly inner: ModelProvider,
    readonly budget: LiveBudget,
    private readonly opts: MeteredProviderOptions = {},
  ) {
    this.name = inner.name;
    this.clock = opts.clock ?? systemClock;
  }

  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  private redact(text: string): string {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const at = this.clock.nowIso();
    const estimateMicro = this.budget.estimateFor(req, (t) => this.inner.countTokens(t));
    let reservation: ReturnType<LiveBudget["reserve"]>;
    try {
      reservation = this.budget.reserve(estimateMicro, req.model);
    } catch (e) {
      if (e instanceof LiveBudgetError) {
        await this.record({
          at,
          model: req.model,
          estimateUsd: e.decision.estimateUsd,
          status: "refused",
          reason: this.redact(e.message),
          usd: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheWrite: 0,
          durationMs: 0,
          ttftMs: null,
          stopReason: null,
        });
      }
      throw e;
    }
    let usage: Usage | null = null;
    let model = req.model;
    let status: LiveCallStatus = "ok";
    let reason: string | undefined;
    let ttft: number | null = null;
    let stopReason: string | null = null;
    // The clock starts once the gate has passed, so the ledger read and the estimate are not
    // in the measured time to first token or the call's duration.
    const t0 = this.clock.monotonic();
    try {
      for await (const ev of this.inner.stream(req)) {
        if (
          ttft === null &&
          (ev.type === "text_delta" || ev.type === "tool_use_start" || ev.type === "thinking_delta")
        ) {
          ttft = this.clock.monotonic() - t0;
        }
        if (ev.type === "message_start" && ev.model) model = ev.model;
        else if (ev.type === "message_end") {
          usage = ev.usage;
          stopReason = ev.stop_reason;
        } else if (ev.type === "error") {
          status = ev.code === "aborted" || req.signal?.aborted ? "aborted" : "error";
          reason = this.redact(ev.code === ev.message ? ev.code : `${ev.code}: ${ev.message}`);
          stopReason = "error";
        }
        yield ev;
      }
    } catch (e) {
      status = req.signal?.aborted ? "aborted" : "error";
      reason = this.redact(errorMessage(e));
      throw e;
    } finally {
      // A consumer that stops iterating early (a kill, a timeout) lands here too.
      if (status === "ok" && usage === null) {
        status = req.signal?.aborted ? "aborted" : "error";
        reason ??= "stream ended without a message_end event";
      }
      const note =
        status === "ok" ? undefined : reason && reason !== status ? `${status}: ${reason}` : status;
      const row = this.budget.settle(reservation, usage, {
        model: modelForLedger(model, req.model),
        requestedModel: req.model,
        ...(note ? { note } : {}),
      });
      await this.record(
        callRecord(row, at, status, reason, estimateMicro, t0, this.clock, ttft, stopReason),
      );
    }
  }

  complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.clock.monotonic(),
    );
  }

  /** Totals over this provider's calls (this process), not the ledger. */
  totals(): { calls: number; usd: number; tokensIn: number; tokensOut: number; refused: number } {
    let usd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let refused = 0;
    for (const c of this.calls) {
      usd += c.usd;
      tokensIn += c.tokensIn;
      tokensOut += c.tokensOut;
      if (c.status === "refused") refused++;
    }
    return {
      calls: this.calls.length,
      usd: Math.round(usd * 1e6) / 1e6,
      tokensIn,
      tokensOut,
      refused,
    };
  }

  private async record(call: LiveCall): Promise<void> {
    this.calls.push(call);
    await this.opts.onCall?.(call);
  }
}

/**
 * The ledger prices the model the provider answered with when the billing table knows it (a
 * dated snapshot of the requested id), else the id that was requested.
 */
function modelForLedger(answered: string, requested: string): string {
  return answered && answered.trim() !== "" ? answered : requested;
}

function callRecord(
  row: SpendRow,
  at: string,
  status: LiveCallStatus,
  reason: string | undefined,
  estimateMicro: number,
  t0: number,
  clock: Clock,
  ttft: number | null,
  stopReason: string | null,
): LiveCall {
  return {
    at,
    model: row.model,
    estimateUsd: Math.round(estimateMicro) / 1_000_000,
    status,
    ...(reason ? { reason } : {}),
    usd: row.usd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
    ttftMs: ttft === null ? null : Math.round(ttft),
    stopReason,
  };
}
