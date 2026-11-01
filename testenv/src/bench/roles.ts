import type { ChatMessage, ContentBlock, ModelRequest } from "../provider/types.ts";

/**
 * Which part of Forerunner sent a model request. The loop driver labels every call
 * (`ModelRequest.origin.label`): `intake <project id>`, `<specialist> on <task title>`,
 * `critic tier <n> on <subject>`, `conversation`; the system prompt and the tools are the
 * fallback for a request without a label.
 */
export type BenchRole = "intake" | "specialist" | "critic" | "chat" | "unknown";

export interface RoleGuess {
  role: BenchRole;
  /** The specialist's registry name, for a specialist run. */
  specialist?: string;
  /** The task title from the run label, for a specialist run. */
  task?: string;
}

const SPECIALIST_LABEL = /^([a-z][a-z0-9-]*) on (.+)$/s;

export function detectRole(req: ModelRequest): RoleGuess {
  const label = req.origin?.label ?? "";
  const tools = (req.tools ?? []).map((t) => t.name);
  const system = req.system ?? "";
  if (label === "conversation") return { role: "chat" };
  if (
    label.startsWith("intake ") ||
    (system.includes("## Intake") && system.includes("firstSession"))
  )
    return { role: "intake" };
  if (label.startsWith("critic ") || tools.includes("submit_review")) return { role: "critic" };
  const m = SPECIALIST_LABEL.exec(label);
  if (m) return { role: "specialist", specialist: m[1], task: m[2] };
  const first = firstUserText(req.messages);
  if (first.startsWith("# Task brief")) {
    const named = /You are the ([a-z][a-z0-9-]*) specialist/i.exec(system);
    return { role: "specialist", ...(named?.[1] ? { specialist: named[1].toLowerCase() } : {}) };
  }
  if (first.startsWith("# Review request")) return { role: "critic" };
  if (system.includes("# Projects") && first.includes("# Now")) return { role: "chat" };
  return { role: "unknown" };
}

/** The text of a message: its string, or its text blocks joined. */
export function messageText(m: ChatMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function firstUserText(messages: readonly ChatMessage[]): string {
  return messageText(messages.find((m) => m.role === "user"));
}

/** The last user message that carries text (not only tool results). */
export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const t = messageText(m);
    if (t) return t;
  }
  return "";
}

/** Every tool call the model made earlier in this run, with its result when there is one. */
export interface PastToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export function pastToolCalls(messages: readonly ChatMessage[]): PastToolCall[] {
  const calls: PastToolCall[] = [];
  const byId = new Map<string, PastToolCall>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (m.role === "assistant" && b.type === "tool_use") {
        const call: PastToolCall = { id: b.id, name: b.name, input: b.input };
        calls.push(call);
        byId.set(b.id, call);
      } else if (m.role === "user" && b.type === "tool_result") {
        const call = byId.get(b.tool_use_id);
        if (call) {
          call.result = b.content;
          call.isError = b.is_error === true;
        }
      }
    }
  }
  return calls;
}

/** The body of a markdown section `## <title>` (up to the next `## ` heading), or "". */
export function section(text: string, title: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${title}`));
  if (start < 0) return "";
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##? /.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** The items of a numbered list (`1. ...`). */
export function numbered(body: string): string[] {
  return body
    .split("\n")
    .map((l) => /^\s*\d+\.\s+(.*)$/.exec(l)?.[1]?.trim() ?? "")
    .filter((l) => l.length > 0);
}

/** Lowercase words joined by dashes, at most `max` characters. */
export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/, "") || "item").trim();
}

/** Case-insensitive substring match against a comma-separated list of needles. */
export function matchesAny(haystack: string, needles: readonly string[]): string | null {
  const h = haystack.toLowerCase();
  for (const n of needles) if (n && h.includes(n.toLowerCase())) return n;
  return null;
}
