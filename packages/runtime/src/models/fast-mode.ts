/**
 * Opus fast mode per project (spec D.20, ADR 0057).
 *
 * A project's `fast_mode` setting (off by default) routes every Opus rung of the project's
 * specialist runs to the fast-mode variant: the same model id requested with the provider's
 * speed parameter (`speed: "fast"` on the Anthropic Messages API). Everything Forerunner
 * records about such a run names the variant (`claude-opus-5-5-fast`): the Run row's model,
 * the ledger row, the per-call estimate and the price row in `@forerunner/billing`, so the
 * research-preview surcharge shows apart from the standard rung.
 *
 * The flag is a request, never a guarantee: the executor decides per run (`decideFastMode`)
 * and writes one `model.fast_mode` audit row whenever the flag meets an Opus rung, applied
 * or ignored. Fast mode is API only: a subscription or plan-credits source ignores the flag
 * ("API only"); so does the Agent SDK path (no speed parameter), a provider that does not
 * offer it, and an Opus id with no fast-mode price row (a run is never priced from a guess).
 */
import {
  BUILTIN_PRICING,
  type BillingSourceKind,
  fastModeBillable,
  fastModeVariantId,
  type PricingTable,
} from "@forerunner/billing";
import type { JsonObject } from "@forerunner/state";
import type { ModelProvider, ModelTier } from "../provider/types.ts";
import { DEFAULT_LADDER } from "./ladder.ts";

/** The project settings key (`project.settings.fast_mode`), changed through `settings.set`. */
export const FAST_MODE_SETTING = "fast_mode";
/** The audit row `tool` of a fast-mode decision on a run. */
export const FAST_MODE_AUDIT_TOOL = "model.fast_mode";
/** What the audit row and the session log say when a non-API source meets the flag. */
export const FAST_MODE_API_ONLY = "API only";
/** The beta the Messages API wants with `speed` on some models (SDK docs, fast mode). */
export const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** The flag from a project's settings: on only for a literal `true`. */
export function fastModeOf(settings: JsonObject | null | undefined): boolean {
  return settings?.[FAST_MODE_SETTING] === true;
}

export type FastModeDecision =
  /** The flag is off, or the run is not on the Opus rung: nothing changes, nothing is written. */
  | { kind: "off" }
  /** `model` is requested with speed fast and recorded and priced as `variant`. */
  | { kind: "applied"; model: string; variant: string }
  /** The flag met an Opus rung but the run stays at the standard speed, for `reason`. */
  | { kind: "ignored"; model: string; reason: string };

export interface FastModeInput {
  enabled: boolean;
  tier: ModelTier;
  /** The rung's model id from the ladder in force. */
  model: string;
  driver: "loop" | "sdk";
  /** The picked source's kind; null when no billing port picks (an API-style source). */
  sourceKind: BillingSourceKind | null;
  provider: Pick<ModelProvider, "name" | "fastMode">;
  /** The price table in force: the variant needs its own row. */
  pricing: PricingTable;
}

/** Whether this run goes fast. Pure: the executor records the result. */
export function decideFastMode(input: FastModeInput): FastModeDecision {
  if (!input.enabled || input.tier !== "opus") return { kind: "off" };
  const { model } = input;
  if (input.sourceKind !== null && !fastModeBillable(input.sourceKind)) {
    return {
      kind: "ignored",
      model,
      reason: `${FAST_MODE_API_ONLY}: a ${input.sourceKind} source runs Opus at the standard speed`,
    };
  }
  if (input.driver === "sdk") {
    return {
      kind: "ignored",
      model,
      reason: "the Agent SDK path does not send the speed parameter",
    };
  }
  if (input.provider.fastMode !== true) {
    return { kind: "ignored", model, reason: `provider ${input.provider.name} has no fast mode` };
  }
  const variant = fastModeVariantId(model);
  if (!input.pricing[variant]) {
    return {
      kind: "ignored",
      model,
      reason: `no fast-mode price row for ${variant}; the run is never priced from a guess`,
    };
  }
  return { kind: "applied", model, variant };
}

/** The audit row's result line: "applied: ..." or "ignored (API only): ..." / "ignored: ...". */
export function fastModeAuditLine(d: Exclude<FastModeDecision, { kind: "off" }>): string {
  if (d.kind === "applied")
    return `applied: ${d.model} requested with speed fast, recorded and priced as ${d.variant}`;
  const prefix = `${FAST_MODE_API_ONLY}: `;
  return d.reason.startsWith(prefix)
    ? `ignored (${FAST_MODE_API_ONLY}): ${d.reason.slice(prefix.length)}`
    : `ignored: ${d.reason}`;
}

/** The default Opus rung on the Anthropic ladder, the model the Settings text prices. */
const OPUS_MODEL = DEFAULT_LADDER.find((r) => r.tier === "opus")?.models.anthropic ?? "";

function usd(n: number): string {
  return String(Math.round(n * 1_000_000) / 1_000_000);
}

/**
 * What switching the flag changes, both ways, with the surcharge from the price table in
 * force (the standard and the variant row of the default Opus rung). Used for the change
 * card's new value and the change log sentence (`SettingSpec.effect`, ADR 0051 item 4) and
 * for the Settings row's description.
 */
export function fastModeEffect(on: boolean, table: PricingTable = BUILTIN_PRICING): string {
  const standard = table[OPUS_MODEL];
  const fast = table[fastModeVariantId(OPUS_MODEL)];
  if (!standard || !fast) {
    return on
      ? "Opus runs of this project on an API key are requested in fast mode (research preview) once a fast-mode price row exists; a subscription ignores it (API only)"
      : "Opus runs of this project go back to the standard speed";
  }
  const std = `USD ${usd(standard.input_per_mtok_usd)} / ${usd(standard.output_per_mtok_usd)}`;
  const fst = `USD ${usd(fast.input_per_mtok_usd)} / ${usd(fast.output_per_mtok_usd)}`;
  const factor =
    standard.output_per_mtok_usd > 0
      ? `${Math.round((fast.output_per_mtok_usd / standard.output_per_mtok_usd) * 100) / 100}x`
      : "a";
  return on
    ? `Opus runs of this project on an API key are requested in fast mode (research preview) at ${fst} per million input / output tokens instead of ${std}, a ${factor} surcharge; a subscription ignores it (${FAST_MODE_API_ONLY})`
    : `Opus runs of this project go back to the standard speed at ${std} per million input / output tokens; the fast-mode surcharge (${factor}, ${fst}) stops`;
}

/** The Settings row's description: what the flag is, and its effect both ways. */
export function fastModeDescription(table: PricingTable = BUILTIN_PRICING): string {
  return `Opus fast mode for urgent work (research preview, API only, priced separately). On: ${fastModeEffect(true, table)}. Off: ${fastModeEffect(false, table)}.`;
}
