import { ForerunnerError } from "@forerunner/platform";
import { lastUserText } from "./tokens.ts";
import type { ModelRequest, StopReason, Usage } from "./types.ts";

/** One tool call the fake "model" asks for. `id` is set by recordings; scripts leave it out. */
export interface ToolCallReply {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/** A provider failure the fake reproduces. `code` is mapped by {@link mapErrorCode}. */
export interface ReplyError {
  code: string;
  message: string;
  retryable?: boolean;
}

/** What the fake answers: the same shape in scripts, echo replies and recordings. */
export interface ReplyBody {
  text?: string;
  /** Emitted as thinking_delta events before the text. */
  thinking?: string;
  toolCalls?: ToolCallReply[];
  /** Defaults to "tool_use" when there are tool calls, else "end_turn". */
  stopReason?: StopReason;
  /** Overrides the computed usage field by field. */
  usage?: Partial<Usage>;
  /** Time to first token; defaults to the provider's `defaultTtftMs` (300). */
  ttftMs?: number;
  /** Time to the last token; defaults to ttft plus `defaultMsPerChunk` per further chunk. */
  totalMs?: number;
  /** When set, the stream emits an error event after `ttftMs` instead of content. */
  error?: ReplyError;
}

/** Declarative request matcher. Every set field must hold (substring matches, exact model). */
export interface ReplyMatcher {
  systemIncludes?: string;
  lastUserIncludes?: string;
  toolAvailable?: string;
  model?: string;
}

export type ReplyPredicate = (req: ModelRequest) => boolean;

export interface ScriptedReply {
  /** Without `when` the reply matches every request. */
  when?: ReplyPredicate | ReplyMatcher;
  reply: ReplyBody;
  /** How many requests this entry answers before it is consumed. Default 1; Infinity never. */
  times?: number;
}

export function matchesRequest(when: ScriptedReply["when"], req: ModelRequest): boolean {
  if (when === undefined) return true;
  if (typeof when === "function") return when(req);
  if (when.model !== undefined && req.model !== when.model) return false;
  if (when.systemIncludes !== undefined && !(req.system ?? "").includes(when.systemIncludes)) {
    return false;
  }
  if (when.lastUserIncludes !== undefined && !lastUserText(req).includes(when.lastUserIncludes)) {
    return false;
  }
  if (when.toolAvailable !== undefined) {
    const name = when.toolAvailable;
    if (!(req.tools ?? []).some((t) => t.name === name)) return false;
  }
  return true;
}

/** Stream error codes the runtime understands. Anything unknown is a generic provider error. */
export type MappedErrorCode = "provider_rate_limit" | "provider_auth" | "provider_error";

export function mapErrorCode(code: string): MappedErrorCode {
  switch (code) {
    case "rate_limit":
    case "provider_rate_limit":
      return "provider_rate_limit";
    case "auth":
    case "provider_auth":
      return "provider_auth";
    default:
      return "provider_error";
  }
}

/** Rate limits are retryable unless the script says otherwise; everything else is not. */
export function errorRetryable(err: ReplyError): boolean {
  return err.retryable ?? mapErrorCode(err.code) === "provider_rate_limit";
}

export function validateScript(replies: ScriptedReply[]): void {
  replies.forEach((r, i) => {
    if (!r || typeof r !== "object" || !r.reply || typeof r.reply !== "object") {
      throw new ForerunnerError("validation", `scripted reply #${i} has no reply body`);
    }
    const times = r.times ?? 1;
    if (times !== Number.POSITIVE_INFINITY && (!Number.isInteger(times) || times < 1)) {
      throw new ForerunnerError(
        "validation",
        `scripted reply #${i}: times must be a positive integer or Infinity`,
      );
    }
    if (r.reply.ttftMs !== undefined && r.reply.ttftMs < 0) {
      throw new ForerunnerError("validation", `scripted reply #${i}: ttftMs must be >= 0`);
    }
    if (r.reply.totalMs !== undefined && r.reply.totalMs < 0) {
      throw new ForerunnerError("validation", `scripted reply #${i}: totalMs must be >= 0`);
    }
  });
}

/** Options accepted by the reply helpers: the rest of the body plus matching and consumption. */
export type ReplyOptions = Omit<ReplyBody, "text" | "toolCalls" | "error"> & {
  when?: ScriptedReply["when"];
  times?: number;
};

function entry(body: ReplyBody, opts: ReplyOptions): ScriptedReply {
  const { when, times, ...rest } = opts;
  const out: ScriptedReply = { reply: { ...rest, ...body } };
  if (when !== undefined) out.when = when;
  if (times !== undefined) out.times = times;
  return out;
}

/** A plain text answer that ends the turn. */
export function textReply(text: string, opts: ReplyOptions = {}): ScriptedReply {
  return entry({ text }, opts);
}

/** One tool call, optionally preceded by text; stop reason "tool_use". */
export function toolReply(
  name: string,
  input: Record<string, unknown>,
  text?: string,
  opts: ReplyOptions = {},
): ScriptedReply {
  const body: ReplyBody = { toolCalls: [{ name, input }] };
  if (text !== undefined) body.text = text;
  return entry(body, opts);
}

/** A provider failure: "rate_limit", "auth" or any other code (mapped to provider_error). */
export function errorReply(
  code: string,
  message = `fake provider error: ${code}`,
  opts: ReplyOptions & { retryable?: boolean } = {},
): ScriptedReply {
  const { retryable, ...rest } = opts;
  const error: ReplyError = { code, message };
  if (retryable !== undefined) error.retryable = retryable;
  return entry({ error }, rest);
}

export type SeqItem = ScriptedReply | ReplyBody | string;

function isScriptedReply(item: SeqItem): item is ScriptedReply {
  return typeof item === "object" && "reply" in item && typeof item.reply === "object";
}

/** A conversation in order: each item answers exactly one request (unless it sets `times`). */
export function seqReplies(items: SeqItem[]): ScriptedReply[] {
  return items.map((item) => {
    if (typeof item === "string") return textReply(item, { times: 1 });
    if (isScriptedReply(item)) return { ...item, times: item.times ?? 1 };
    return { reply: item, times: 1 };
  });
}
