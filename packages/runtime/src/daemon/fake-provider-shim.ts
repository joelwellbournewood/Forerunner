import type { ModelProvider, ModelRequest, ModelResponse, StreamEvent } from "../provider/types.ts";
import { collectStream } from "../provider/types.ts";

/**
 * A tiny deterministic provider for `fr daemon --provider fake` (demos and the fresh-install
 * check): echoes the last user message. Tests use the richer FakeProvider from testenv.
 */
export function fakeProvider(): ModelProvider {
  return {
    name: "fake",
    async listModels() {
      return [
        { provider: "fake", id: "fake-haiku", tier: "haiku" },
        { provider: "fake", id: "fake-sonnet", tier: "sonnet" },
      ];
    },
    countTokens: (t) => Math.ceil(t.length / 4),
    async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
      const last = req.messages.at(-1);
      const text = typeof last?.content === "string" ? last.content : "(tool results received)";
      yield { type: "message_start", model: req.model };
      yield { type: "text_delta", text: `Echo: ${text.slice(0, 200)}` };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: {
          input_tokens: Math.ceil(JSON.stringify(req.messages).length / 4),
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    },
    complete(req: ModelRequest): Promise<ModelResponse> {
      const t0 = performance.now();
      return collectStream(
        this.stream(req),
        () => t0,
        () => performance.now(),
      );
    },
  };
}
