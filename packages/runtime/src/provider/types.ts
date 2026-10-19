/**
 * Model provider contract. Every model call in Forerunner goes through a ModelProvider so that
 * (a) the fake provider in testenv can replace Anthropic in unit and integration tests and
 * (b) other vendors can be added as adapters (docs/maintainers/adding-a-provider.md).
 *
 * Shapes follow the Anthropic Messages API closely so the Anthropic adapter is a thin mapping.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ModelTier = "haiku" | "sonnet" | "opus" | "fable";

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
  /** Only honoured by providers that accept it; Anthropic adapters drop it. */
  temperature?: number;
  /** Mark stable prefixes (system prompt, project brief) for prompt caching. */
  cache?: { system?: boolean; tools?: boolean };
  /** Opaque metadata recorded with the run (prompt version, task id). Never sent as instructions. */
  metadata?: Record<string, string>;
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
  | { type: "message_start"; model: string }
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
  /** Models this provider offers, ranked cheapest first inside each tier. */
  listModels(): Promise<ModelRef[]>;
  /** Streams events; the final event is message_end or error. */
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
  /** Convenience: collect a stream into a response. Adapters may override. */
  complete(req: ModelRequest): Promise<ModelResponse>;
  /** Rough token count for budgeting before a call. */
  countTokens(text: string): number;
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
