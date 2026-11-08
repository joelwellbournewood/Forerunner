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
/**
 * A tool the provider ran itself, inside the call (Anthropic's web search, 'web-search', ADR
 * 0107 amended): what it was asked, as the app reads it. The block that goes back to the
 * provider is the message's `raw` copy, never this one.
 */
export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
/** One search result as the app reads it: the plain fields; the page text stays sealed. */
export interface WebSearchHit {
  url: string;
  title: string;
  pageAge?: string;
}
/**
 * The result of a server tool's call (`server_tool_use` with the same id): for web search the
 * results' plain fields, or the error code the provider gave (`max_uses_exceeded`, ...). The
 * result's sealed content (`encrypted_content`) is only in the message's `raw` copy.
 */
export interface ServerToolResultBlock {
  type: "server_tool_result";
  tool_use_id: string;
  name: string;
  results: WebSearchHit[];
  errorCode?: string;
}
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ServerToolUseBlock
  | ServerToolResultBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /**
   * The provider's own blocks of an assistant turn, exactly as it sent them ('web-search'): set
   * when the turn holds a server tool's blocks (a search and its sealed results, which must go
   * back unchanged or the next request is refused) or paused (`pause_turn`). The adapter sends
   * this instead of `content`; nothing else edits it (context compression, the prompt cache's
   * marks and the Headroom proxy keep off it). `content` is the app's own reading of the turn.
   */
  raw?: readonly Record<string, unknown>[];
}

/**
 * Anthropic's web search on a call ('web-search', the owner's decision of 2026-11-02): offered
 * by the loop driver when the run's token grants `web_search` and the provider can run it
 * (`ModelProvider.serverWebSearch`). `maxUses` is set by code from the money left (at least 1);
 * the project's lists in the server's form (`wiring/web-ports.ts`), never both in one request.
 */
export interface WebSearchOptions {
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

/** The server tools a call ran (Anthropic's `usage.server_tool_use`). */
export interface ServerToolUsage {
  web_search_requests: number;
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
  /**
   * Anthropic's web search on this call ('web-search'): sent as the server tool beside `tools`
   * by a provider that can run it (`serverWebSearch`), ignored by every other provider.
   */
  webSearch?: WebSearchOptions;
  max_tokens: number;
  effort?: EffortLevel;
  /**
   * "off": the caller wants no thinking on this call, so the cap is the reply's own (a chat turn
   * at low effort). A provider maps it to what the model accepts (the Anthropic adapter:
   * `anthropicThinkingOff`) and sends nothing where the model cannot turn thinking off or
   * thinks only when asked. Absent: the model's default, which on current Claude models is
   * adaptive thinking whose depth the effort sets, counted against `max_tokens`.
   */
  thinking?: "off";
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
  /**
   * Prompt caching (Anthropic's `cache_control` breakpoints, at most four a request): `system`
   * the system prompt, `tools` the tool definitions, `messages` the conversation, so each call
   * of a run reads what the call before it sent and pays the write price only for what is new
   * ('cost', L-15: a research task re-sent 78k tokens a turn uncached). With `messages` the
   * Anthropic adapter marks the last block of the last message and the last block of the last
   * user message before the last assistant message, where the previous call of an agent loop
   * ended (so the read never depends on the API's 20-block lookback). A provider without a
   * prompt cache ignores the field.
   */
  cache?: { system?: boolean; tools?: boolean; messages?: boolean };
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
  /**
   * The server tools the call ran ('web-search'): each web search is billed apart (USD 10 per
   * 1,000) and its results are in `input_tokens`. Absent: none ran.
   */
  server_tool_use?: ServerToolUsage;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  /**
   * The provider paused a long server-tool turn ('web-search'): the turn goes back unchanged
   * (the message's `raw`) in the next request, which continues it.
   */
  | "pause_turn"
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
  /** A server tool's call, complete ('web-search'): the provider runs it, not the app. */
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  /** A server tool's result, complete: the plain fields of each result, or its error code. */
  | {
      type: "server_tool_result";
      tool_use_id: string;
      name: string;
      results: WebSearchHit[];
      errorCode?: string;
    }
  /**
   * The turn's blocks exactly as the provider sent them, before `message_end`, when the turn
   * holds a server tool's blocks or paused: the loop keeps them as the message's `raw`.
   */
  | { type: "raw_content"; blocks: Record<string, unknown>[] }
  | {
      type: "message_end";
      stop_reason: StopReason;
      usage: Usage;
      /** Which billing source paid for this call, when the provider chose it (`RoutedProvider`). */
      billing?: CallBilling;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      /**
       * `provider_usage_limit` only: when the credential's limit resets, if the provider said
       * (ISO). The source rests until then, else for an hour (ADR 0100).
       */
      resetAt?: string;
      /** The billing source the failed call was made on, when the provider chose it. */
      sourceId?: string;
    };

/**
 * The billing source a routed call was made on (U-078, ADR 0100): the loop driver books the
 * call's ledger row to it, with its ledger kind and, for a subscription, the plan share after
 * the call.
 */
export interface CallBilling {
  sourceId: string;
  kind: "api" | "subscription" | "plan_credits";
  planUsageShare?: number | null;
}

export interface ModelResponse {
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: Usage;
  /** Milliseconds from request start to first streamed token. */
  time_to_first_token_ms: number;
  duration_ms: number;
  /** The source that paid, when the provider chose it (`message_end.billing`). */
  billing?: CallBilling;
  /**
   * The turn's blocks exactly as the provider sent them (`raw_content`), when it holds a server
   * tool's blocks or paused ('web-search'): the loop keeps them as the message's `raw`.
   */
  raw?: Record<string, unknown>[];
  /** Set with `stop_reason: "error"`: the provider's error event, as it said it. */
  error?: { code: string; message: string; resetAt?: string; sourceId?: string };
}

/**
 * The error codes of a call refused for its web search ('web-search', ADR 0107 amended): the
 * account's administrator switched web search off (`WEB_SEARCH_OFF_CODE`), or the server tool
 * refused the project's site lists (`WEB_SEARCH_LISTS_CODE`: a wildcard domain, an allowed list
 * outside the organisation's). The loop makes the call again without the tool; never a failure.
 */
export const WEB_SEARCH_OFF_CODE = "provider_web_search_off";
export const WEB_SEARCH_LISTS_CODE = "provider_web_search_lists";

/** The name of Anthropic's web search tool in a call and in its `server_tool_use` blocks. */
export const WEB_SEARCH_SERVER_TOOL = "web_search";

/**
 * The ids of the server tool calls in `messages` that have no result yet ('web-search'): a call
 * the provider deferred because the turn also asked for the app's tools (a mixed step), or that
 * a paused turn ends with. The next request must still offer the server tool, and nothing may
 * follow the app's tool results in that request's last message.
 */
export function pendingServerToolUses(messages: readonly ChatMessage[]): string[] {
  const asked: string[] = [];
  const answered = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "server_tool_use") asked.push(b.id);
      else if (b.type === "server_tool_result") answered.add(b.tool_use_id);
    }
  }
  return asked.filter((id) => !answered.has(id));
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
  /**
   * True when the provider runs Anthropic's web search itself (`ModelRequest.webSearch`): the
   * Anthropic Messages adapter on an API key ('web-search'). Absent or false: the executor never
   * offers search on a run of this provider.
   */
  readonly serverWebSearch?: boolean;
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
  let billing: CallBilling | undefined;
  let raw: Record<string, unknown>[] | undefined;
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
      case "server_tool_use":
        flushText();
        content.push({ type: "server_tool_use", id: ev.id, name: ev.name, input: ev.input });
        break;
      case "server_tool_result":
        flushText();
        content.push({
          type: "server_tool_result",
          tool_use_id: ev.tool_use_id,
          name: ev.name,
          results: ev.results,
          ...(ev.errorCode ? { errorCode: ev.errorCode } : {}),
        });
        break;
      case "raw_content":
        raw = ev.blocks;
        break;
      case "message_end":
        stop = ev.stop_reason;
        usage = ev.usage;
        if (ev.billing) billing = ev.billing;
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
          error: {
            code: ev.code,
            message: ev.message,
            ...(ev.resetAt ? { resetAt: ev.resetAt } : {}),
            ...(ev.sourceId ? { sourceId: ev.sourceId } : {}),
          },
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
    ...(billing ? { billing } : {}),
    ...(raw ? { raw } : {}),
  };
}
