import { BUILTIN_PRICING, type PricingTable, priceFor } from "@forerunner/billing";
import { errorMessage, ForerunnerError } from "@forerunner/platform";
import type { EffortLevel } from "@forerunner/runtime";
import { microFromUsd, usdFromMicro } from "./ledger.ts";
import type { LiveCallStatus, MeteredProvider } from "./metered.ts";

/**
 * The effort probe: one tiny request at a model and an effort no live run has sent before,
 * through the metered provider (so it is gated, priced and in the ledger like any call), before
 * a file spends money on work that depends on the provider accepting that effort. `live-7`
 * probes Opus at `max` before its first tier 2 review: the tier 3 reviews would be the first
 * live requests at `max`. A rejection fails with the provider's reason (`not_supported`).
 */
export const PROBE_MAX_TOKENS = 64;
/** An upper bound on the probe's input (the one-line prompt), for its share of the ceiling. */
export const PROBE_INPUT_TOKENS = 200;

export interface ProbeResult {
  model: string;
  effort: EffortLevel;
  status: LiveCallStatus;
  stopReason: string | null;
  usd: number;
  durationMs: number;
  ttftMs: number | null;
}

/** The most the probe can cost: its input bound at the cache-write rate, `max_tokens` at the output rate. */
export function probeCeilingUsd(model: string, pricing: PricingTable = BUILTIN_PRICING): number {
  const p = priceFor(model, pricing);
  const inputRate = Math.max(p.input_per_mtok_usd, p.cache_write_per_mtok_usd);
  return usdFromMicro(
    Math.round(PROBE_INPUT_TOKENS * inputRate + PROBE_MAX_TOKENS * p.output_per_mtok_usd),
  );
}

export async function probeEffort(
  provider: MeteredProvider,
  opts: { model: string; effort: EffortLevel },
): Promise<ProbeResult> {
  const mark = provider.calls.length;
  const fail = (reason: string): never => {
    throw new ForerunnerError(
      "not_supported",
      `effort probe: the provider rejected effort "${opts.effort}" on ${opts.model}: ${reason}`,
      { retryable: false, details: { model: opts.model, effort: opts.effort } },
    );
  };
  let stop: string;
  try {
    const res = await provider.complete({
      model: opts.model,
      effort: opts.effort,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
    });
    stop = res.stop_reason;
  } catch (e) {
    return fail(errorMessage(e));
  }
  const call = provider.calls.slice(mark).at(-1);
  if (stop === "error" || !call || call.status !== "ok") {
    return fail(call?.reason ?? `stop reason ${stop}`);
  }
  return {
    model: opts.model,
    effort: opts.effort,
    status: call.status,
    stopReason: call.stopReason,
    usd: usdFromMicro(microFromUsd(call.usd)),
    durationMs: call.durationMs,
    ttftMs: call.ttftMs,
  };
}
