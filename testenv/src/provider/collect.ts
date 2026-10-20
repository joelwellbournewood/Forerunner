import type { ContentBlock, ModelResponse, StopReason, StreamEvent, Usage } from "./types.ts";

export type StreamErrorEvent = Extract<StreamEvent, { type: "error" }>;

export interface Collected {
  response: ModelResponse;
  /** The error event that ended the stream, when one did. */
  error?: StreamErrorEvent;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function isFirstTokenEvent(ev: StreamEvent): boolean {
  return ev.type === "text_delta" || ev.type === "tool_use_start" || ev.type === "thinking_delta";
}

/**
 * Collects a stream into a ModelResponse the same way the runtime's `collectStream` does, and
 * also hands back the terminating error event so callers can tell an abort from a provider
 * failure. testenv cannot import the runtime at runtime, so this mirrors it; the fake provider's
 * tests check both collectors agree on the same stream.
 */
export async function collectFakeStream(
  stream: AsyncIterable<StreamEvent> | Iterable<StreamEvent>,
  startedAt: () => number,
  now: () => number,
): Promise<Collected> {
  const t0 = startedAt();
  let ttft = -1;
  let model = "";
  const content: ContentBlock[] = [];
  let text = "";
  let thinking = "";
  const tools = new Map<string, { name: string; json: string }>();
  let stop: StopReason = "end_turn";
  let usage: Usage = { ...ZERO_USAGE };
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
  const finish = (error?: StreamErrorEvent): Collected => {
    flushText();
    const response: ModelResponse = {
      model,
      content,
      stop_reason: error ? "error" : stop,
      usage,
      time_to_first_token_ms: ttft < 0 ? now() - t0 : ttft,
      duration_ms: now() - t0,
    };
    return error ? { response, error } : { response };
  };
  for await (const ev of stream) {
    if (ttft < 0 && isFirstTokenEvent(ev)) ttft = now() - t0;
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
        return finish(ev);
    }
  }
  return finish();
}
