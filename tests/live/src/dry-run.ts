import { BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import {
  collectStream,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@forerunner/runtime";
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

/**
 * The smallest prefix the provider caches on the chat model (Haiku 5.5: 512 tokens; source:
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching, "Cache limitations").
 */
export const DRY_RUN_MIN_CACHEABLE_TOKENS = 512;

/**
 * A stand-in for the provider's prompt cache, for the dry run of the chat cache measure
 * (`live-5-chat-cache.live.test.ts`). It wraps a scripted provider and rewrites each reply's
 * usage the way the real cache reports it: the prefix is the model, the tool definitions and
 * the system text, in the provider's order (tools -> system), when the request asks for
 * caching and the prefix reaches the minimum length. A prefix seen before is a cache read, a
 * new one a cache write. A byte of difference in the tools or the system text is a new prefix,
 * so an unstable prefix shows up in the dry run as warm turns with no cache read.
 */
export class PrefixCacheFake implements ModelProvider {
  readonly name: string;
  private readonly seen = new Set<string>();

  constructor(
    readonly inner: ModelProvider,
    private readonly clock: Clock,
    private readonly minTokens = DRY_RUN_MIN_CACHEABLE_TOKENS,
  ) {
    this.name = inner.name;
  }

  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const cached = req.cache?.tools || req.cache?.system;
    const prefix = JSON.stringify([req.model, req.tools ?? [], req.system ?? ""]);
    const prefixTokens = this.countTokens(prefix);
    const cacheable = !!cached && prefixTokens >= this.minTokens;
    const hit = cacheable && this.seen.has(prefix);
    if (cacheable) this.seen.add(prefix);
    for await (const ev of this.inner.stream(req)) {
      if (ev.type !== "message_end" || !cacheable) {
        yield ev;
        continue;
      }
      const uncached = Math.max(0, ev.usage.input_tokens - prefixTokens);
      yield {
        ...ev,
        usage: {
          ...ev.usage,
          input_tokens: uncached,
          cache_read_input_tokens: hit ? prefixTokens : 0,
          cache_creation_input_tokens: hit ? 0 : prefixTokens,
        },
      };
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
}
