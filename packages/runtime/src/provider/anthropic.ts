import Anthropic from "@anthropic-ai/sdk";
import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import {
  type ChatMessage,
  type ContentBlock,
  collectStream,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ModelTier,
  type StopReason,
  type StreamEvent,
} from "./types.ts";

/**
 * Anthropic Messages API adapter. Streams, maps effort to output_config.effort, marks stable
 * prefixes for prompt caching, never sends temperature (current Claude models reject it).
 * The credential is passed in by the billing router; this class never reads env itself.
 */
export interface AnthropicProviderOptions {
  apiKey?: string;
  /** OAuth token from `claude setup-token` (subscription). Exactly one of apiKey/authToken is set. */
  authToken?: string;
  baseURL?: string;
  /** Sent with every request, e.g. X-Headroom-Project when the base URL is the Headroom proxy. */
  defaultHeaders?: Record<string, string>;
  clock?: Clock;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly clock: Clock;
  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey && !opts.authToken) {
      throw new ForerunnerError(
        "provider_auth",
        "anthropic provider needs an API key or a subscription token",
      );
    }
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? null,
      authToken: opts.authToken ?? null,
      baseURL: opts.baseURL,
      defaultHeaders: opts.defaultHeaders,
      fetch: opts.fetch,
      maxRetries: opts.maxRetries ?? 2,
    });
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

  async listModels(): Promise<ModelRef[]> {
    const out: ModelRef[] = [];
    for await (const m of this.client.models.list({ limit: 100 })) {
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
    if (req.metadata) params.metadata = { user_id: req.metadata.user_id };

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(params, { signal: req.signal });
    } catch (e) {
      yield mapError(e);
      return;
    }
    const open = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = "end_turn";
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
            yield { type: "message_start", model: ev.message.model };
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
            break;
        }
      }
    } catch (e) {
      if (req.signal?.aborted) {
        yield { type: "error", code: "aborted", message: "aborted", retryable: false };
        return;
      }
      yield mapError(e);
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

function mapError(e: unknown): StreamEvent {
  const status = (e as { status?: number }).status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403)
    return { type: "error", code: "provider_auth", message, retryable: false };
  if (status === 429)
    return { type: "error", code: "provider_rate_limit", message, retryable: true };
  if (status === 529 || (status && status >= 500))
    return { type: "error", code: "provider_error", message, retryable: true };
  return { type: "error", code: "provider_error", message, retryable: false };
}

export function tierFromId(id: string): ModelTier | null {
  if (/haiku/i.test(id)) return "haiku";
  if (/sonnet/i.test(id)) return "sonnet";
  if (/opus/i.test(id)) return "opus";
  if (/fable|mythos/i.test(id)) return "fable";
  return null;
}
