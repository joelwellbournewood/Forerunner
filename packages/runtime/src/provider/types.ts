/**
 * Model provider contract. Every model call in Forerunner goes through a ModelProvider so that
 * (a) the fake provider in testenv can replace Anthropic in unit and integration tests and
 * (b) other vendors can be added as adapters (docs/maintainers/adding-a-provider.md).
 *
 * Shapes follow the Anthropic Messages API closely so the Anthropic adapter is a thin mapping.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ModelTier = "haiku" | "sonnet" | "opus" | "fable";

/**
 * Speed mode of a model call (spec D.4 and D.20; ADRs 0057 and 0072): "standard", or "fast"
 * where the provider offers it (`fastMode`; Anthropic: Opus fast mode, API only, priced
 * apart) on the same model id; absent means the provider's standard speed.
 */
export type SpeedMode = "standard" | "fast";

/**
 * What a provider declares it accepts beyond the common request (spec D.4, ADR 0072). Only the
 * temperature flag lives here; fast mode is the provider's own `fastMode` flag (D.20, ADR 0057).
 */
export interface ProviderDeclaredCapabilities {
  /** The provider accepts a sampling temperature (current Claude models reject one). */
  acceptsTemperature?: boolean;
}

/**
 * What the loop, the settings view and the settings command read about a provider (ADR 0072):
 * a field the provider does not accept is never sent and never shown.
 */
export interface ProviderCapabilities {
  /** The provider accepts a sampling temperature (`capabilities.acceptsTemperature`). */
  acceptsTemperature: boolean;
  /** The provider honours `speed: "fast"` (`ModelProvider.fastMode`, D.20, ADR 0057). */
  fastMode: boolean;
}

/** What a provider that declares nothing gets: no temperature, no fast mode. */
export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  acceptsTemperature: false,
  fastMode: false,
};

/** A provider's capabilities: its declared temperature flag and its `fastMode`, defaults filled in. */
export function providerCapabilities(
  p: Pick<ModelProvider, "capabilities" | "fastMode">,
): ProviderCapabilities {
  return {
    acceptsTemperature: p.capabilities?.acceptsTemperature === true,
    fastMode: p.fastMode === true,
  };
}

export interface ModelRef {
  provider: string; // "anthropic" | "fake" | ...
  /** Provider model id, e.g. claude-haiku-5-5 */
  id: string;
  tier: ModelTier;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the input. */
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens: number;
  effort?: EffortLevel;
  /**
   * Only sent to providers whose capabilities say `acceptsTemperature` (the loop drops it
   * otherwise); the Anthropic adapter never sends it.
   */
  temperature?: number;
  /**
   * Fast mode (spec D.20 and D.4; ADRs 0057 and 0072): set only by the executor after
   * `decideFastMode` applied it (a project with `fast_mode` on, an Opus rung, an API-style
   * source, the run's speed mode not `standard` by an explicit setting), and sent by the loop
   * only to a provider whose `fastMode` is true. The model id stays the base id; the run's
   * records name the variant (`<id>-fast`).
   */
  speed?: SpeedMode;
  /** Mark stable prefixes (system prompt, project brief) for prompt caching. */
  cache?: { system?: boolean; tools?: boolean };
  /** Opaque metadata recorded with the run (prompt version, task id). Never sent as instructions. */
  metadata?: Record<string, string>;
  /**
   * Context-layer bypass (ADR 0003 section 4). "off" means every tool result reaches the model
   * exactly as produced: the critic, evals and the model watch set it. Never sent to the provider.
   */
  compression?: "default" | "off";
  /**
   * Which run made the call: the run's label (`conversation` for a chat turn), its session
   * and its run id (a chat turn's transcript id). Set by the loop driver for every call it
   * makes; measures and meters pick a run's calls by it. Never sent to the provider.
   */
  origin?: { label: string; sessionId: string; runId: string };
  signal?: AbortSignal;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "aborted"
  | "error";

export type StreamEvent =
  /**
   * `usage`, when the provider reports it, is the input side of the bill as the message opens
   * (Anthropic's `message_start`: input, cache read and cache write tokens, output 0), so a
   * call cut off before `message_end` still shows what was billed for its input.
   */
  | { type: "message_start"; model: string; usage?: Usage }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Record<string, unknown> }
  | { type: "message_end"; stop_reason: StopReason; usage: Usage }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface ModelResponse {
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: Usage;
  /** Milliseconds from request start to first streamed token. */
  time_to_first_token_ms: number;
  duration_ms: number;
}

export interface ModelProvider {
  readonly name: string;
  /**
   * True when the provider honours `ModelRequest.speed = "fast"` (the Anthropic Messages
   * adapter on an API key). Absent or false: the executor never asks it for fast mode and the
   * loop never sends `speed` (ADRs 0057 and 0072).
   */
  readonly fastMode?: boolean;
  /** What this provider accepts beyond the common request; absent: no temperature (ADR 0072). */
  readonly capabilities?: ProviderDeclaredCapabilities;
  /** Models this provider offers, ranked cheapest first inside each tier. */
  listModels(): Promise<ModelRef[]>;
  /** Streams events; the final event is message_end or error. */
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
  /** Convenience: collect a stream into a response. Adapters may override. */
  complete(req: ModelRequest): Promise<ModelResponse>;
  /** Rough token count for budgeting before a call. */
  countTokens(text: string): number;
  /**
   * The largest `max_tokens` the provider accepts for `model`; undefined when unknown. The loop
   * clamps a run's `maxTokensCeiling` to it, so the ceiling never raises a call's cap past the
   * model's limit (a `maxTokensPerCall` above the limit is still sent as asked). Optional; must
   * not throw (an unknown limit is undefined) and should stop when `opts.signal` aborts. The
   * loop waits at most `MODEL_LIMIT_WAIT_MS` for it and then goes on without a clamp.
   */
  maxOutputTokens?(
    model: string,
    opts?: { signal?: AbortSignal },
  ): Promise<number | undefined> | number | undefined;
}

/** Collects a stream into a ModelResponse. Shared by every adapter. */
export async function collectStream(
  stream: AsyncIterable<StreamEvent>,
  startedAt: () => number,
  now: () => number,
): Promise<ModelResponse> {
  const t0 = startedAt();
  let ttft = -1;
  let model = "";
  const content: ContentBlock[] = [];
  let text = "";
  let thinking = "";
  const tools = new Map<string, { name: string; json: string }>();
  let stop: StopReason = "end_turn";
  let usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const flushText = () => {
    if (text) {
      content.push({ type: "text", text });
      text = "";
    }
    if (thinking) {
      content.push({ type: "thinking", text: thinking });
      thinking = "";
    }
  };
  for await (const ev of stream) {
    if (
      ttft < 0 &&
      (ev.type === "text_delta" || ev.type === "tool_use_start" || ev.type === "thinking_delta")
    ) {
      ttft = now() - t0;
    }
    switch (ev.type) {
      case "message_start":
        model = ev.model;
        // The input side of the bill; message_end replaces it with the full figure, and a
        // stream cut off before message_end returns it with stop_reason "error".
        if (ev.usage) usage = { ...ev.usage };
        break;
      case "text_delta":
        text += ev.text;
        break;
      case "thinking_delta":
        thinking += ev.text;
        break;
      case "tool_use_start":
        flushText();
        tools.set(ev.id, { name: ev.name, json: "" });
        break;
      case "tool_use_delta": {
        const t = tools.get(ev.id);
        if (t) t.json += ev.partial_json;
        break;
      }
      case "tool_use_end": {
        const t = tools.get(ev.id);
        content.push({ type: "tool_use", id: ev.id, name: t?.name ?? "", input: ev.input });
        tools.delete(ev.id);
        break;
      }
      case "message_end":
        stop = ev.stop_reason;
        usage = ev.usage;
        break;
      case "error":
        flushText();
        return {
          model,
          content,
          stop_reason: "error",
          usage,
          time_to_first_token_ms: ttft < 0 ? now() - t0 : ttft,
          duration_ms: now() - t0,
        };
    }
  }
  flushText();
  return {
    model,
    content,
    stop_reason: stop,
    usage,
    time_to_first_token_ms: ttft < 0 ? now() - t0 : ttft,
    duration_ms: now() - t0,
  };
}
