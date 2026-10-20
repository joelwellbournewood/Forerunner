import { BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import type { LiveCredentials } from "./env.ts";

/**
 * The dry run: the harness end to end with a scripted provider and fake credentials, no
 * network. It proves the ledger, the caps and the composition without a live call. It runs in
 * `test/harness.test.ts` under the package's own `test` script
 * (`pnpm --filter @forerunner/live test`); that script is not yet invoked by `ci.yml` and the
 * package is not in the root vitest projects, so until the orchestrator adds the step it runs
 * only when someone runs it (testing.md, "Live runs", Known issues). The fake ladder is priced
 * like the real one so the arithmetic is the real arithmetic.
 */
export const DRY_RUN_PRICING: PricingTable = Object.freeze({
  ...BUILTIN_PRICING,
  "fake-haiku": BUILTIN_PRICING["claude-haiku-5-5"] as PricingTable[string],
  "fake-sonnet": BUILTIN_PRICING["claude-sonnet-5-5"] as PricingTable[string],
  "fake-opus": BUILTIN_PRICING["claude-opus-5-5"] as PricingTable[string],
  "fake-fable": BUILTIN_PRICING["claude-fable-5-1"] as PricingTable[string],
});

/**
 * Fixture credentials built by concatenation: no credential shape sits in the source. With
 * `subscription`, a token-shaped value too (the dry run of the subscription half, where the
 * SDK's `query` is a fake and the value only has to reach the vault and nothing else).
 */
export function dryRunCredentials(opts: { subscription?: boolean } = {}): LiveCredentials {
  return {
    apiKey: ["sk-ant-", "api03-", "dry-run-", "0".repeat(16)].join(""), // not-a-secret
    workspaceId: null,
    subscriptionToken: opts.subscription
      ? ["sk-", "ant-", "oat01-", "dry-run-", "1".repeat(40)].join("") // not-a-secret
      : null,
    source: "process-env",
  };
}
