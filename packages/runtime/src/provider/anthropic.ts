import Anthropic from "@anthropic-ai/sdk";
import { canonicalModelId } from "@forerunner/billing";
import {
  type Clock,
  describeNetworkError,
  ForerunnerError,
  systemClock,
} from "@forerunner/platform";
import { FAST_MODE_BETA } from "../models/fast-mode.ts";
import { SUBSCRIPTION_TOKEN_PREFIX } from "../setup/validators.ts";
import {
  type ChatMessage,
  type ContentBlock,
  collectStream,
  type EffortLevel,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ModelTier,
  type ProviderDeclaredCapabilities,
  type StopReason,
  type StreamEvent,
} from "./types.ts";
import { USAGE_LIMIT_CODE, usageLimitOfApiError } from "./usage-limit.ts";

/**
 * Anthropic Messages API adapter. Streams, maps effort to output_config.effort, marks stable
 * prefixes for prompt caching, never sends temperature (current Claude models reject it) and
 * sends `speed: "fast"` with the fast-mode beta header when the request asks (spec D.20, ADR
 * 0057), on an API key and an Opus model id only (ADR 0072).
 * The credential is an API key (or a gateway's bearer token); a Claude subscription token is
 * refused here and runs through Claude Code instead (`ClaudeCodeProvider`, U-048, ADR 0098).
 * This class never reads env itself.
 */

/** Fast mode is API only for Opus (spec D.20): never on a subscription. */
export function fastModeApplies(modelId: string, auth: "api_key" | "subscription"): boolean {
  return auth === "api_key" && tierFromId(modelId) === "opus";
}
/**
 * The `thinking` parameter that turns thinking off for `model` at `effort`, or undefined when
 * nothing is to be sent: the model thinks only when asked (Claude 4.x), or it cannot turn
 * thinking off (Opus 5.5, Fable, Mythos), or the effort is above high, where Haiku 5.5 and
 * Opus 5 answer `disabled` with a 400 error. Sonnet 5 thinks adaptively by default and takes
 * `disabled`; the docs name no effort limit for it, but it gets the same xhigh/max guard as the
 * others (a chat turn asks thinking off only at low effort anyway). Sonnet 5.5 rejects
 * `disabled` and takes `between_tools` (thinking only between tool calls) at high or below.
 * Source: https://platform.claude.com/docs/en/build-with-claude/thinking ("Configuring
 * thinking"), read 2026-10-26. An unknown model gets nothing, so a new model is never sent a
 * value it refuses.
 */
export function anthropicThinkingOff(
  modelId: string,
  effort: EffortLevel | undefined,
): Anthropic.ThinkingConfigParam | undefined {
  if (effort === "xhigh" || effort === "max") return undefined;
  const id = canonicalModelId(modelId);
  if (id === "claude-sonnet-5") return { type: "disabled" };
  if (id === "claude-haiku-5-5" || id === "claude-opus-5") return { type: "disabled" };
  if (id === "claude-sonnet-5-5") return { type: "between_tools" };
  return undefined;
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  /**
   * A bearer token for an LLM gateway or proxy in front of the API (sent as
   * `Authorization: Bearer`). Exactly one of apiKey/authToken is set. Never a Claude
   * subscription token: the constructor refuses one (`SUBSCRIPTION_TOKEN_PREFIX`).
   */
  authToken?: string;
  baseURL?: string;
  /** Sent with every request, e.g. X-Headroom-Project when the base URL is the Headroom proxy. */
  defaultHeaders?: Record<string, string>;
  clock?: Clock;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
  /**
   * Where the API key lives (the vault), read before every request (U-049): a key replaced in
   * the app is used by the next call, without a restart. `apiKey` is the key read at compose;
   * a source that answers nothing (or throws) leaves the last key in use.
   */
  apiKeySource?: () => Promise<string | null>;
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  /** The API key `client` was built with (`apiKeySource` swaps the client when it changes). */
  private clientKey: string | undefined;
  private readonly clock: Clock;
  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey && !opts.authToken) {
      throw new ForerunnerError("provider_auth", "anthropic provider needs an API key");
    }
    if (
      [opts.apiKey, opts.authToken].some((v) => v?.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX))
    ) {
      throw new ForerunnerError(
        "provider_auth",
        "a Claude subscription token runs only in Claude Code (ClaudeCodeProvider), never on the Messages API",
      );
    }
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.clientKey = opts.apiKey;
    this.client = this.makeClient(opts.apiKey);
  }

  private makeClient(apiKey: string | undefined): Anthropic {
    return new Anthropic({
      apiKey: apiKey ?? null,
      authToken: this.opts.authToken ?? null,
      baseURL: this.opts.baseURL,
      defaultHeaders: this.opts.defaultHeaders,
      fetch: this.opts.fetch,
      maxRetries: this.opts.maxRetries ?? 2,
    });
  }

  /** The credentials in use, cut out of any error text. */
  private secrets(): string[] {
    return [this.clientKey ?? "", this.opts.authToken ?? ""].filter(Boolean);
  }

  /**
   * The client for the next request: rebuilt when `apiKeySource` answers another key than the
   * one in use (U-049). Never a subscription token (refused as in the constructor).
   */
  private async current(): Promise<Anthropic> {
    if (!this.opts.apiKeySource) return this.client;
    const key = (await this.opts.apiKeySource().catch(() => null))?.trim();
    if (!key || key === this.clientKey || key.startsWith(SUBSCRIPTION_TOKEN_PREFIX))
      return this.client;
    this.clientKey = key;
    this.client = this.makeClient(key);
    return this.client;
  }

  /**
   * Fast mode (ADR 0057): `speed: "fast"` on the model id, with the fast-mode beta header; on an
   * API key only, never on a subscription token (spec D.20 "API only", ADR 0072).
   */
  get fastMode(): boolean {
    return !!this.opts.apiKey;
  }

  /** Never a temperature: current Claude models reject one (ADR 0072). */
  get capabilities(): ProviderDeclaredCapabilities {
    return { acceptsTemperature: false };
  }

  /** Where this adapter sends requests (undefined: the SDK default). */
  get baseURL(): string | undefined {
    return this.opts.baseURL;
  }

  /**
   * The same credential through a local proxy (ADR 0003: the Headroom proxy on loopback) with
   * extra request headers. Returns a new adapter; this one is unchanged, so a critic run can
   * keep calling the API directly while a specialist run goes through the proxy.
   */
  viaProxy(baseURL: string, headers: Record<string, string>): AnthropicMessagesProvider {
    return new AnthropicMessagesProvider({
      ...this.opts,
      baseURL,
      defaultHeaders: { ...(this.opts.defaultHeaders ?? {}), ...headers },
    });
  }

  /**
   * Per model: the `max_tokens` limit the Models API reports (undefined when it has none or
   * the read failed), with when a failed read may be tried again (`retryAt`).
   */
  private readonly outputLimits = new Map<
    string,
    { limit: Promise<number | undefined>; retryAt?: number }
  >();

  /**
   * The model's `max_tokens` limit from the Models API (`ModelInfo.max_tokens`), read once per
   * model and kept; `listModels` fills it too. Undefined when the API reports none or the read
   * fails (the loop then does not clamp; the API itself rejects a cap past the limit). The read
   * is one attempt (`maxRetries: 0`) of at most `MODEL_LIMIT_READ_TIMEOUT_MS`, cut short by
   * `opts.signal` (the run's). A failure is kept for `MODEL_LIMIT_FAILURE_TTL_MS`, so a Models
   * API that rejects the credential (a subscription token, say) costs one round trip per few
   * minutes, not one per review; a read cut short by the caller's signal is not kept.
   */
  maxOutputTokens(model: string, opts: { signal?: AbortSignal } = {}): Promise<number | undefined> {
    const known = this.outputLimits.get(model);
    if (known && (known.retryAt === undefined || this.clock.now() < known.retryAt)) {
      return known.limit;
    }
    const entry: { limit: Promise<number | undefined>; retryAt?: number } = {
      limit: Promise.resolve(undefined),
    };
    entry.limit = this.current()
      .then((client) =>
        client.models.retrieve(model, null, {
          maxRetries: 0,
          timeout: MODEL_LIMIT_READ_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      )
      .then(
        (m) => positiveLimit(m.max_tokens),
        () => {
          if (opts.signal?.aborted) {
            // The caller gave up, not the API: the next caller asks again.
            if (this.outputLimits.get(model) === entry) this.outputLimits.delete(model);
          } else {
            entry.retryAt = this.clock.now() + MODEL_LIMIT_FAILURE_TTL_MS;
          }
          return undefined;
        },
      );
    this.outputLimits.set(model, entry);
    return entry.limit;
  }

  async listModels(): Promise<ModelRef[]> {
    const out: ModelRef[] = [];
    const client = await this.current();
    for await (const m of client.models.list({ limit: 100 })) {
      const known = positiveLimit(m.max_tokens);
      if (known !== undefined) this.outputLimits.set(m.id, { limit: Promise.resolve(known) });
      const tier = tierFromId(m.id);
      if (tier) out.push({ provider: this.name, id: m.id, tier });
    }
    return out;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.max_tokens,
      messages: req.messages.map(toApiMessage),
      stream: true,
    };
    if (req.system) {
      params.system = req.cache?.system
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
    }
    if (req.tools?.length) {
      params.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        ...(req.cache?.tools && i === req.tools!.length - 1
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      }));
    }
    if (req.effort) params.output_config = { effort: req.effort };
    if (req.thinking === "off") {
      const off = anthropicThinkingOff(req.model, req.effort);
      if (off) params.thinking = off;
    }
    if (req.metadata) params.metadata = { user_id: req.metadata.user_id };
    // Fast mode (spec D.20, ADR 0057): the same model id with the speed parameter; the beta
    // header is what the API asks for with `speed` on the models that need it. Sent only where
    // fast mode exists (ADR 0072): a subscription token or a non-Opus model gets a standard
    // call, never an error.
    const fast =
      req.speed === "fast" &&
      fastModeApplies(req.model, this.opts.apiKey ? "api_key" : "subscription");
    if (fast) params.speed = "fast";

    const aborted = (): StreamEvent => ({
      type: "error",
      code: "aborted",
      message: "aborted",
      retryable: false,
    });
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      const client = await this.current();
      stream = await client.messages.create(params, {
        signal: req.signal,
        ...(fast ? { headers: { "anthropic-beta": FAST_MODE_BETA } } : {}),
      });
    } catch (e) {
      yield req.signal?.aborted ? aborted() : mapError(e, this.secrets(), this.clock.now());
      return;
    }
    const open = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = "end_turn";
    let stopped = false;
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start":
            usage.input_tokens = ev.message.usage.input_tokens;
            usage.cache_read_input_tokens = ev.message.usage.cache_read_input_tokens ?? 0;
            usage.cache_creation_input_tokens = ev.message.usage.cache_creation_input_tokens ?? 0;
            // The input side of the bill is known here; a call aborted before message_end
            // still has it on record (the live harness's spend ledger reads it).
            yield { type: "message_start", model: ev.message.model, usage: { ...usage } };
            break;
          case "content_block_start":
            if (ev.content_block.type === "tool_use") {
              open.set(ev.index, {
                id: ev.content_block.id,
                name: ev.content_block.name,
                json: "",
              });
              yield {
                type: "tool_use_start",
                id: ev.content_block.id,
                name: ev.content_block.name,
              };
            }
            break;
          case "content_block_delta":
            if (ev.delta.type === "text_delta") yield { type: "text_delta", text: ev.delta.text };
            else if (ev.delta.type === "thinking_delta")
              yield { type: "thinking_delta", text: ev.delta.thinking };
            else if (ev.delta.type === "input_json_delta") {
              const t = open.get(ev.index);
              if (t) {
                t.json += ev.delta.partial_json;
                yield { type: "tool_use_delta", id: t.id, partial_json: ev.delta.partial_json };
              }
            }
            break;
          case "content_block_stop": {
            const t = open.get(ev.index);
            if (t) {
              open.delete(ev.index);
              let input: Record<string, unknown> = {};
              try {
                input = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
              } catch {
                input = { _unparsed: t.json };
              }
              yield { type: "tool_use_end", id: t.id, input };
            }
            break;
          }
          case "message_delta":
            stopReason = mapStop(ev.delta.stop_reason);
            usage.output_tokens = ev.usage.output_tokens;
            if (ev.usage.input_tokens != null) usage.input_tokens = ev.usage.input_tokens;
            if (ev.usage.cache_read_input_tokens != null)
              usage.cache_read_input_tokens = ev.usage.cache_read_input_tokens;
            if (ev.usage.cache_creation_input_tokens != null)
              usage.cache_creation_input_tokens = ev.usage.cache_creation_input_tokens;
            break;
          case "message_stop":
            stopped = true;
            break;
        }
      }
    } catch (e) {
      if (!stopped) {
        yield req.signal?.aborted ? aborted() : mapError(e, this.secrets(), this.clock.now());
        return;
      }
    }
    // The SDK's iterator exits without throwing when the request's signal aborts, so a
    // killed call would otherwise end as a complete message with stop_reason end_turn. A
    // message whose message_stop came before the abort is complete, with its full usage.
    if (req.signal?.aborted && !stopped) {
      yield aborted();
      return;
    }
    yield { type: "message_end", stop_reason: stopReason, usage };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.clock.monotonic(),
    );
  }
}

function toApiMessage(m: ChatMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const b of m.content as ContentBlock[]) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text });
    else if (b.type === "tool_use")
      blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "tool_result")
      blocks.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      });
    // thinking blocks from our own transcript are not replayed (the API requires signatures)
  }
  return { role: m.role, content: blocks };
}

function mapStop(s: string | null | undefined): StopReason {
  switch (s) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function mapError(e: unknown, secrets: string[], nowMs: number): StreamEvent {
  const status = (e as { status?: number }).status;
  // No answer at all (the SDK's "Connection error."): the cause says what failed (U-053), the
  // credential cut out of it (a key the runtime cannot put in a header is quoted there).
  const cause = (e as { cause?: unknown }).cause;
  if (status === undefined && cause !== undefined)
    return {
      type: "error",
      code: "provider_error",
      message: `Could not reach the Anthropic API: ${describeNetworkError(cause, secrets)}`,
      retryable: true,
    };
  let message = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s) message = message.split(s).join("[REDACTED]");
  if (status === 401 || status === 403)
    return { type: "error", code: "provider_auth", message, retryable: false };
  // The key's credit balance, spend cap or spend limit (ADR 0100): another source may serve.
  const limit = usageLimitOfApiError(e, nowMs);
  if (limit)
    return {
      type: "error",
      code: USAGE_LIMIT_CODE,
      message: `The API key's usage limit is reached: ${message}`,
      retryable: false,
      ...(limit.resetAt ? { resetAt: limit.resetAt } : {}),
    };
  if (status === 429)
    return { type: "error", code: "provider_rate_limit", message, retryable: true };
  if (status === 529 || (status && status >= 500))
    return { type: "error", code: "provider_error", message, retryable: true };
  return { type: "error", code: "provider_error", message, retryable: false };
}

/** One Models API read of a model's output limit takes at most this long (one attempt). */
export const MODEL_LIMIT_READ_TIMEOUT_MS = 5_000;
/** A failed read of a model's output limit is kept this long before it is tried again. */
export const MODEL_LIMIT_FAILURE_TTL_MS = 5 * 60_000;

/** A reported output limit, when it is a positive whole number; undefined otherwise. */
function positiveLimit(n: number | null | undefined): number | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function tierFromId(id: string): ModelTier | null {
  if (/haiku/i.test(id)) return "haiku";
  if (/sonnet/i.test(id)) return "sonnet";
  if (/opus/i.test(id)) return "opus";
  if (/fable|mythos/i.test(id)) return "fable";
  return null;
}
