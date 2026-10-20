import type { ChatMessage, ModelRequest } from "./types.ts";

/** The budgeting estimate every provider uses before a call: one token per four characters. */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Text of one message: string content, text and thinking blocks, tool results, tool-use JSON. */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case "text":
      case "thinking":
        parts.push(b.text);
        break;
      case "tool_result":
        parts.push(b.content);
        break;
      case "tool_use":
        parts.push(`${b.name} ${JSON.stringify(b.input)}`);
        break;
    }
  }
  return parts.join("\n");
}

/** Text of the last user-role message (tool results count: they are user messages). */
export function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === "user") return messageText(m);
  }
  return "";
}

/** Everything the model would read: system prompt, every message, tool definitions. */
export function requestText(req: ModelRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  for (const m of req.messages) parts.push(messageText(m));
  for (const t of req.tools ?? []) {
    parts.push(`${t.name}: ${t.description} ${JSON.stringify(t.input_schema)}`);
  }
  return parts.join("\n");
}
