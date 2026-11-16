import {
  type ChatReplyView,
  ChatReplyView as ChatReplyViewSchema,
  type ChatRequestBody,
  ErrorBody,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import { ApiError, type DaemonClient } from "./client.ts";
import { readSseStream } from "./sse.ts";

/**
 * Chat replies always stream (spec D: "All replies stream"). `POST /chat/stream` answers with
 * `text/event-stream`: `token` frames carry `{ "text": "..." }` pieces of the reply in order,
 * a final `reply` frame carries the full `ChatReplyView`, and an `error` frame carries an
 * `ErrorBody` (ADR 0025). A daemon that answers with plain JSON is accepted too: the whole
 * reply then arrives at once.
 */

const TokenFrame = z.object({ text: z.string() });
/** d1109-chat-depth: the turn's id first (for Stop), then a step frame at each step. */
const TurnFrame = z.object({ turnId: z.string(), startedAt: z.string() });
const StepFrame = z.object({ text: z.string(), at: z.string(), reset: z.boolean().optional() });

/** `DAEMON_ROUTES.chat` names both forms; this is the streaming one. */
export const CHAT_STREAM_PATH = "/chat/stream";

export interface ChatStreamHandlers {
  /** Each token as it arrives; `soFar` is the concatenation. */
  onToken?: (text: string, soFar: string) => void;
  /** d1109-chat-depth: the turn started (its id for Stop, and when). */
  onTurn?: (turn: { turnId: string; startedAt: string }) => void;
  /**
   * d1109-chat-depth: what chat is doing now ("Reading the last session…"); `reset`: the text
   * streamed so far is dropped (a hand-over to a longer answer, the claim guard's true line).
   */
  onStep?: (step: { text: string; at: string; reset: boolean }) => void;
  signal?: AbortSignal;
}

export async function streamChat(
  client: DaemonClient,
  body: ChatRequestBody,
  handlers: ChatStreamHandlers = {},
): Promise<ChatReplyView> {
  const res = await client.raw({
    method: "POST",
    path: CHAT_STREAM_PATH,
    body,
    accept: "text/event-stream",
    signal: handlers.signal,
  });
  if (!res.ok) {
    let parsedError: z.infer<typeof ErrorBody> | null = null;
    try {
      const p = ErrorBody.safeParse(await res.json());
      if (p.success) parsedError = p.data;
    } catch {
      parsedError = null;
    }
    throw new ApiError(
      parsedError?.code ?? "ui.http_error",
      parsedError?.message ?? `${res.status}: chat failed`,
      res.status,
      parsedError?.details,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const parsed = ChatReplyViewSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ApiError("ui.invalid_response", "chat reply does not match the contract", 200);
    }
    handlers.onToken?.(parsed.data.reply, parsed.data.reply);
    return parsed.data;
  }

  let soFar = "";
  for await (const frame of readSseStream(res)) {
    if (frame.event === "turn") {
      const turn = TurnFrame.safeParse(safeJson(frame.data));
      if (turn.success) handlers.onTurn?.(turn.data);
    } else if (frame.event === "step") {
      const step = StepFrame.safeParse(safeJson(frame.data));
      if (!step.success) continue;
      if (step.data.reset) soFar = "";
      handlers.onStep?.({ ...step.data, reset: step.data.reset === true });
    } else if (frame.event === "token") {
      const token = TokenFrame.safeParse(safeJson(frame.data));
      if (!token.success) continue;
      soFar += token.data.text;
      handlers.onToken?.(token.data.text, soFar);
    } else if (frame.event === "reply") {
      const reply = ChatReplyViewSchema.safeParse(safeJson(frame.data));
      if (!reply.success) {
        throw new ApiError(
          "ui.invalid_response",
          "chat reply frame does not match the contract",
          200,
        );
      }
      return reply.data;
    } else if (frame.event === "error") {
      const err = ErrorBody.safeParse(safeJson(frame.data));
      if (err.success) throw new ApiError(err.data.code, err.data.message, 200, err.data.details);
      throw new ApiError("ui.http_error", "chat stream reported an error", 200);
    }
  }
  throw new ApiError("ui.invalid_response", "chat stream ended without a reply frame", 200);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
