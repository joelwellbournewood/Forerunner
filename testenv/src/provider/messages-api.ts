import { createHash } from "node:crypto";
import { type Clock, systemClock } from "@forerunner/platform";
import type {
  ChatMessage,
  ContentBlock,
  ModelProvider,
  ModelRequest,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "./types.ts";

/**
 * A stand-in of the Anthropic Messages API (U-078, ADR 0100), for the tests and the bench's
 * `--provider bench-api`: the app's own routed provider talks to it through the real Anthropic
 * SDK, so the router, the billing sources, the refused and resting marks and a key saved in the
 * vault are all exercised, with no real key and no money.
 *
 * It answers per key, the way the API does:
 * - a refused key: 401 `authentication_error` ("invalid x-api-key");
 * - a key at its limit: the spend cap as ADR 0100 point 6 reads it, a 429 `rate_limit_error`
 *   with `error.details.error_code: "enforced_spend_limit_reached"` and "You will regain access
 *   on <date> at <hh:mm> UTC." (form `429`), or the spend limit the person set, a 400
 *   `invalid_request_error` "You have reached your specified API usage limits ..." (form `400`);
 *   until the reset, then it answers normally again;
 * - any other key: the model behind it (`model`: the bench's role-player, a test's scripted
 *   provider), streamed as the API streams (`message_start`, content blocks, `message_delta`,
 *   `message_stop`), or one JSON message when the request asks for no stream.
 *
 * `GET /v1/models` and `GET /v1/models/<id>` list the Claude models (the setup's key check and
 * the adapter's output limit read them). Every request is logged without key text: the key is
 * named by `keyId` (the first 12 hex characters of its SHA-256), never by its characters.
 */

/** What the stand-in answers a key. */
export type KeyAnswer =
  | { kind: "ok" }
  | { kind: "refused" }
  | { kind: "limit"; form: "429" | "400"; resetAt: string };

/** One request as the stand-in's log keeps it: never the key, only its id. */
export interface StandInRequest {
  time: string;
  method: string;
  path: string;
  /** `key-<12 hex>`: the SHA-256 of the key, cut; "none" when the request carried none. */
  keyId: string;
  status: number;
  answer: KeyAnswer["kind"] | "not_found";
  model?: string;
}

export interface MessagesApiStandInOptions {
  /** The model behind the API for a key it serves. */
  model: ModelProvider;
  /** How each key is answered; default: every key is served (`ok`). */
  answerFor?: (key: string, nowMs: number) => KeyAnswer;
  /** Each request as it is logged (a file, a test's list). */
  onRequest?: (entry: StandInRequest) => void;
  clock?: Clock;
  /** The model ids `GET /v1/models` lists. */
  models?: readonly string[];
}

export interface MessagesApiStandIn {
  /** Answers one request (a `fetch` for the Anthropic SDK, or a server's handler). */
  handle(request: Request): Promise<Response>;
  /** The requests so far, oldest first. */
  readonly requests: readonly StandInRequest[];
}

export const STAND_IN_MODELS: readonly string[] = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
];

/** The id a log names a key by: never its characters. */
export function keyIdOf(key: string): string {
  if (!key) return "none";
  return `key-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * The bench's key rule (`FORERUNNER_BENCH_API_*`): a key holding one of the `REFUSE` substrings
 * (default "refused") is refused; one holding a `LIMIT` substring (default "limited") is at its
 * limit from its first call for `LIMIT_MIN` minutes (default 3), in the `LIMIT_FORM` form (429 or
 * 400, default 429), then served again; every other key is served.
 */
export function keyRuleFromEnv(env: NodeJS.ProcessEnv): (key: string, nowMs: number) => KeyAnswer {
  const list = (raw: string | undefined, fallback: string) =>
    (raw ?? fallback)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const refuse = list(env.FORERUNNER_BENCH_API_REFUSE, "refused");
  const limit = list(env.FORERUNNER_BENCH_API_LIMIT, "limited");
  const minutes = Number(env.FORERUNNER_BENCH_API_LIMIT_MIN ?? 3);
  const form = env.FORERUNNER_BENCH_API_LIMIT_FORM === "400" ? "400" : "429";
  return keyRule({
    refuse,
    limit,
    limitMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 3) * 60_000,
    form,
  });
}

/** A key rule from substrings: refused, at a limit for `limitMs` from its first call, or served. */
export function keyRule(opts: {
  refuse?: readonly string[];
  limit?: readonly string[];
  limitMs?: number;
  form?: "429" | "400";
}): (key: string, nowMs: number) => KeyAnswer {
  const until = new Map<string, number>();
  return (key, nowMs) => {
    if ((opts.refuse ?? []).some((s) => key.includes(s))) return { kind: "refused" };
    if ((opts.limit ?? []).some((s) => key.includes(s))) {
      const end = until.get(key) ?? nowMs + (opts.limitMs ?? 3 * 60_000);
      until.set(key, end);
      if (nowMs < end) {
        // The API names the minute access comes back; a limit ends on a whole minute.
        const reset = new Date(Math.ceil(end / 60_000) * 60_000).toISOString();
        return { kind: "limit", form: opts.form ?? "429", resetAt: reset };
      }
    }
    return { kind: "ok" };
  };
}

export function messagesApiStandIn(opts: MessagesApiStandInOptions): MessagesApiStandIn {
  const clock = opts.clock ?? systemClock;
  const answerFor = opts.answerFor ?? (() => ({ kind: "ok" }) as const);
  const models = opts.models ?? STAND_IN_MODELS;
  const requests: StandInRequest[] = [];
  const record = (entry: StandInRequest) => {
    requests.push(entry);
    try {
      opts.onRequest?.(entry);
    } catch {
      // a log that cannot be written never fails the call
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const key = request.headers.get("x-api-key") ?? "";
    const keyId = keyIdOf(key);
    const time = clock.nowIso();
    const path = url.pathname.replace(/\/+$/, "");
    const base = { time, method: request.method, path, keyId };
    const known =
      (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) ||
      (request.method === "POST" && path === "/v1/messages");
    if (!known) {
      record({ ...base, status: 404, answer: "not_found" });
      return errorResponse(404, "not_found_error", `Not found: ${request.method} ${path}`);
    }
    const answer = answerFor(key, clock.now());
    if (answer.kind === "refused") {
      record({ ...base, status: 401, answer: "refused" });
      return errorResponse(401, "authentication_error", "invalid x-api-key");
    }
    if (answer.kind === "limit") {
      const status = answer.form === "400" ? 400 : 429;
      record({ ...base, status, answer: "limit" });
      return limitResponse(answer);
    }
    if (request.method === "GET") {
      record({ ...base, status: 200, answer: "ok" });
      if (path === "/v1/models")
        return json(200, {
          data: models.map(modelInfo),
          has_more: false,
          first_id: models[0] ?? null,
          last_id: models.at(-1) ?? null,
        });
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      return json(200, modelInfo(id));
    }
    let body: MessagesBody;
    try {
      body = (await request.json()) as MessagesBody;
    } catch {
      record({ ...base, status: 400, answer: "ok" });
      return errorResponse(400, "invalid_request_error", "the body is not JSON");
    }
    record({ ...base, status: 200, answer: "ok", model: body.model });
    const req = toModelRequest(body, request.signal);
    const events = opts.model.stream(req);
    if (body.stream === false) return json(200, await collectMessage(events, body.model));
    return new Response(sse(events, body.model), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  return { handle, requests };
}

/**
 * A `fetch` for the app (`composeRuntime`'s `fetchImpl`): requests for the Anthropic API (its
 * host, or `base` when one is named) go to the stand-in; everything else to `fallback`.
 */
export function standInFetch(
  standIn: Pick<MessagesApiStandIn, "handle">,
  opts: { base?: string; fallback?: typeof fetch } = {},
): typeof fetch {
  const fallback = opts.fallback ?? globalThis.fetch.bind(globalThis);
  const base = opts.base?.replace(/\/+$/, "");
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const ours =
      url.hostname === "api.anthropic.com" || (base !== undefined && request.url.startsWith(base));
    return ours ? standIn.handle(request) : fallback(input, init);
  }) as typeof fetch;
}

interface MessagesBody {
  model: string;
  max_tokens?: number;
  stream?: boolean;
  system?: string | { type: string; text?: string }[];
  messages?: { role: "user" | "assistant"; content: unknown }[];
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
}

function modelInfo(id: string) {
  return {
    type: "model",
    id,
    display_name: id,
    created_at: "2026-01-01T00:00:00Z",
    max_tokens: 64_000,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { type: "error", error: { type, message, ...extra }, request_id: "req_stand_in" },
    headers,
  );
}

/** The two usage-limit forms ADR 0100 point 6 reads; the SDK is told not to retry them. */
function limitResponse(answer: Extract<KeyAnswer, { kind: "limit" }>): Response {
  const d = new Date(answer.resetAt).toISOString();
  const when = `${d.slice(0, 10)} at ${d.slice(11, 16)} UTC`;
  const noRetry = { "x-should-retry": "false" };
  if (answer.form === "400")
    return errorResponse(
      400,
      "invalid_request_error",
      `You have reached your specified API usage limits. You will regain access on ${when}.`,
      {},
      noRetry,
    );
  return errorResponse(
    429,
    "rate_limit_error",
    `This organization has reached its monthly spend limit. You will regain access on ${when}.`,
    { details: { error_code: "enforced_spend_limit_reached" } },
    noRetry,
  );
}

function textOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  return raw
    .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text ?? "") : ""))
    .join("");
}

function toBlocks(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const out: ContentBlock[] = [];
  for (const b of raw as Record<string, unknown>[]) {
    if (b.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
    else if (b.type === "tool_use")
      out.push({
        type: "tool_use",
        id: String(b.id),
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
      });
    else if (b.type === "tool_result")
      out.push({
        type: "tool_result",
        tool_use_id: String(b.tool_use_id),
        content: textOf(b.content),
        ...(b.is_error === true ? { is_error: true } : {}),
      });
  }
  return out;
}

function toModelRequest(body: MessagesBody, signal: AbortSignal): ModelRequest {
  const messages: ChatMessage[] = (body.messages ?? []).map((m) => ({
    role: m.role,
    content: toBlocks(m.content),
  }));
  const tools: ToolDefinition[] = (body.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.input_schema ?? {},
  }));
  return {
    model: body.model,
    ...(body.system ? { system: textOf(body.system) } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    max_tokens: body.max_tokens ?? 4096,
    signal,
  };
}

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** The model's events as the API's SSE stream. */
function sse(events: AsyncIterable<StreamEvent>, model: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const line = (type: string, data: unknown) =>
    enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let index = -1;
      let textOpen = false;
      let started = false;
      /** Tool names by id, from `tool_use_start` (its `tool_use_end` carries no name). */
      const names = new Map<string, string>();
      const begin = (usage: Usage) => {
        if (started) return;
        started = true;
        controller.enqueue(
          line("message_start", {
            message: {
              id: "msg_stand_in",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: usage.input_tokens,
                output_tokens: 0,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
              },
            },
          }),
        );
      };
      const closeText = () => {
        if (!textOpen) return;
        controller.enqueue(line("content_block_stop", { index }));
        textOpen = false;
      };
      try {
        for await (const ev of events) {
          switch (ev.type) {
            case "message_start":
              begin(ev.usage ?? EMPTY_USAGE);
              break;
            case "text_delta":
              begin(EMPTY_USAGE);
              if (!textOpen) {
                index++;
                textOpen = true;
                controller.enqueue(
                  line("content_block_start", { index, content_block: { type: "text", text: "" } }),
                );
              }
              controller.enqueue(
                line("content_block_delta", {
                  index,
                  delta: { type: "text_delta", text: ev.text },
                }),
              );
              break;
            case "tool_use_end": {
              begin(EMPTY_USAGE);
              closeText();
              index++;
              controller.enqueue(
                line("content_block_start", {
                  index,
                  content_block: {
                    type: "tool_use",
                    id: ev.id,
                    name: names.get(ev.id) ?? "unknown_tool",
                    input: {},
                  },
                }),
              );
              controller.enqueue(
                line("content_block_delta", {
                  index,
                  delta: { type: "input_json_delta", partial_json: JSON.stringify(ev.input) },
                }),
              );
              controller.enqueue(line("content_block_stop", { index }));
              break;
            }
            case "tool_use_start":
              names.set(ev.id, ev.name);
              break;
            case "message_end":
              begin(EMPTY_USAGE);
              closeText();
              controller.enqueue(
                line("message_delta", {
                  delta: {
                    stop_reason: ev.stop_reason === "error" ? "end_turn" : ev.stop_reason,
                    stop_sequence: null,
                  },
                  usage: { output_tokens: ev.usage.output_tokens },
                }),
              );
              controller.enqueue(line("message_stop", {}));
              break;
            case "error":
              begin(EMPTY_USAGE);
              closeText();
              controller.enqueue(
                line("error", { error: { type: "api_error", message: ev.message } }),
              );
              break;
            default:
              break;
          }
        }
      } catch (e) {
        controller.enqueue(
          line("error", {
            error: { type: "api_error", message: e instanceof Error ? e.message : String(e) },
          }),
        );
      } finally {
        controller.close();
      }
    },
  });
}

/** The model's events as one Messages API message (a request with `stream: false`). */
async function collectMessage(events: AsyncIterable<StreamEvent>, model: string) {
  const content: Record<string, unknown>[] = [];
  let text = "";
  let usage: Usage = EMPTY_USAGE;
  let stop = "end_turn";
  const local = new Map<string, string>();
  for await (const ev of events) {
    if (ev.type === "text_delta") text += ev.text;
    else if (ev.type === "tool_use_start") local.set(ev.id, ev.name);
    else if (ev.type === "tool_use_end") {
      if (text) content.push({ type: "text", text });
      text = "";
      content.push({ type: "tool_use", id: ev.id, name: local.get(ev.id) ?? "", input: ev.input });
    } else if (ev.type === "message_end") {
      usage = ev.usage;
      stop = ev.stop_reason;
    }
  }
  if (text) content.push({ type: "text", text });
  return {
    id: "msg_stand_in",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  };
}
