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
  WebSearchHit,
  WebSearchOptions,
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
 *
 * Web search ('web-search'), as the API runs it: a request may offer the `web_search_*` server
 * tool; the model behind it searches (`server_tool_use` and `server_tool_result` events) and the
 * stand-in streams each search as the API does, its results sealed (`encrypted_content`, an opaque
 * string it remembers). On every later request it checks, byte for byte, that each server block
 * it issued comes back unchanged, and refuses the request with the API's 400 otherwise; a search
 * the model left pending (a mixed step: its turn also asks for the app's tools) needs the server
 * tool again and a follow-up of tool results only, and the stand-in runs it at the start of that
 * request; a paused turn (`pause_turn`) is continued. Its knobs (`search`): search switched off
 * for the account (the "not enabled" 400), the organisation's allowed list (an allowed list
 * outside it is a 400), and the input tokens each search's results add; a wildcard domain is
 * refused as the API refuses it.
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
  answer: KeyAnswer["kind"] | "not_found" | "invalid";
  model?: string;
  /** The web search tool the request offered ('web-search'), as it was sent. */
  webSearch?: Record<string, unknown>;
  /** Server blocks the request sent back (all checked byte for byte), and searches run in it. */
  serverBlocksBack?: number;
  searchesRun?: number;
}

/** How the stand-in plays Anthropic's web search ('web-search'). */
export interface WebSearchStandInOptions {
  /** False: the account's administrator switched web search off (the "not enabled" 400). */
  enabled?: boolean;
  /** The organisation's allowed list: a request's `allowed_domains` outside it is a 400. */
  orgAllowedDomains?: readonly string[];
  /** Input tokens one search's results add to its call (the API counts them as input). */
  resultTokens?: number;
  /** Results for a search the model left pending (a mixed step), run at the next request. */
  results?: (query: string) => WebSearchHit[];
}

/** One search the stand-in ran: its query, results and the call it was billed in. */
export interface StandInSearch {
  id: string;
  query: string;
  urls: string[];
  errorCode?: string;
}

export interface MessagesApiStandInOptions {
  /** The model behind the API for a key it serves. */
  model: ModelProvider;
  /** Web search on the stand-in ('web-search'); default: on, any domain, 1,500 tokens a search. */
  search?: WebSearchStandInOptions;
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
  /** The searches it ran, oldest first ('web-search'). */
  readonly searches: readonly StandInSearch[];
  /** The 400s it gave for the server tool or its blocks, with the API's words ('web-search'). */
  readonly refusals: readonly string[];
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

/**
 * The bench's web search rule ('web-search', `FORERUNNER_BENCH_API_*`): `SEARCH=off` answers a
 * request with the server tool with the "not enabled" 400 (an administrator switched search off);
 * `ORG_DOMAINS` (comma-separated) is the organisation's allowed list; `SEARCH_TOKENS` the input
 * tokens one search's results add (default 1,500); a search left pending finds
 * `FORERUNNER_BENCH_SEARCH_RESULTS` (`url|title`, comma-separated).
 */
export function searchRuleFromEnv(env: NodeJS.ProcessEnv): WebSearchStandInOptions {
  const off = ["off", "0", "false", "no"].includes(
    (env.FORERUNNER_BENCH_API_SEARCH ?? "").trim().toLowerCase(),
  );
  const org = (env.FORERUNNER_BENCH_API_ORG_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = Number(env.FORERUNNER_BENCH_API_SEARCH_TOKENS ?? "");
  const results: WebSearchHit[] = (env.FORERUNNER_BENCH_SEARCH_RESULTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, ...title] = entry.split("|");
      return { url: (url ?? "").trim(), title: title.join("|").trim() || (url ?? "").trim() };
    });
  return {
    ...(off ? { enabled: false } : {}),
    ...(org.length ? { orgAllowedDomains: org } : {}),
    ...(Number.isFinite(tokens) && tokens > 0 ? { resultTokens: Math.round(tokens) } : {}),
    results: () => results,
  };
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
  const search = searchState(opts.search ?? {});
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
    // Web search ('web-search'): the server tool and every server block sent back are checked
    // as the API checks them; a refusal is the API's 400 with its words.
    const tool = serverToolOf(body);
    const checked = search.check(body, tool);
    if ("refusal" in checked) {
      record({
        ...base,
        status: 400,
        answer: "invalid",
        model: body.model,
        ...(tool ? { webSearch: tool } : {}),
      });
      return errorResponse(400, "invalid_request_error", checked.refusal);
    }
    const req = toModelRequest(body, request.signal, checked.runNow);
    const entry: StandInRequest = {
      ...base,
      status: 200,
      answer: "ok",
      model: body.model,
      ...(tool ? { webSearch: tool } : {}),
      ...(checked.blocksBack ? { serverBlocksBack: checked.blocksBack } : {}),
    };
    const events = opts.model.stream(req);
    if (body.stream === false) {
      record(entry);
      return json(200, await collectMessage(events, body.model));
    }
    const maxUses = typeof tool?.max_uses === "number" ? tool.max_uses : Number.POSITIVE_INFINITY;
    return new Response(
      sse(
        events,
        body.model,
        search.streamer(checked.runNow, maxUses, (n) => {
          if (n) entry.searchesRun = n;
          record(entry);
        }),
      ),
      {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      },
    );
  };

  return {
    handle,
    requests,
    get searches() {
      return search.searches;
    },
    get refusals() {
      return search.refusals;
    },
  };
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
    const request = new Request(input, init);
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
  tools?: {
    type?: string;
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }[];
}

/** The web search server tool a request offers, as it was sent; undefined when none. */
function serverToolOf(body: MessagesBody): Record<string, unknown> | undefined {
  const t = (body.tools ?? []).find(
    (x) => typeof x.type === "string" && x.type.startsWith("web_search_"),
  );
  return t ? (t as unknown as Record<string, unknown>) : undefined;
}

/** A search the stand-in runs at the start of a request: one the model left pending. */
interface PendingSearch {
  id: string;
  query: string;
  results: WebSearchHit[];
}

/** What the server-block checks decided for one request. */
type SearchCheck = { refusal: string } | { runNow: PendingSearch[]; blocksBack: number };

/** What a domain entry may look like for the server tool: a bare domain, an optional path. */
function domainProblem(entry: unknown): string | null {
  if (typeof entry !== "string" || !entry.trim()) return "an empty entry";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return `"${entry}" has a scheme`;
  const domain = entry.split("/")[0] ?? "";
  if (domain.includes("*")) return `"${entry}": wildcards are not allowed in the domain`;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) return `"${entry}" is not a domain`;
  return null;
}

/** The domain `entry` is, or is under, one of `list` (the API's subdomain rule). */
function underAny(entry: string, list: readonly string[]): boolean {
  const d = (entry.split("/")[0] ?? "").toLowerCase();
  return list.some((o) => {
    const x = o.toLowerCase();
    return d === x || d.endsWith(`.${x}`);
  });
}

/** An opaque sealed blob for one result, as the API's `encrypted_content` is to a client. */
function sealed(id: string, url: string): string {
  const h = createHash("sha256").update(`stand-in|${id}|${url}`).digest("base64");
  return `Eq${h.replace(/[^A-Za-z0-9]/g, "")}${h.slice(0, 12).replace(/[^A-Za-z0-9]/g, "x")}`;
}

/**
 * The stand-in's web search state: the server blocks it issued (to check they come back byte for
 * byte), the searches the model left pending, the searches it ran and the 400s it gave.
 */
function searchState(opts: WebSearchStandInOptions) {
  const issued = new Map<string, string>();
  const pending = new Map<string, { query: string }>();
  const searches: StandInSearch[] = [];
  const refusals: string[] = [];
  const refuse = (words: string): SearchCheck => {
    refusals.push(words);
    return { refusal: words };
  };
  const resultBlock = (id: string, hits: WebSearchHit[], errorCode?: string) => ({
    type: "web_search_tool_result",
    tool_use_id: id,
    content: errorCode
      ? { type: "web_search_tool_result_error", error_code: errorCode }
      : hits.map((h) => ({
          type: "web_search_result",
          url: h.url,
          title: h.title,
          encrypted_content: sealed(id, h.url),
          ...(h.pageAge ? { page_age: h.pageAge } : {}),
        })),
  });

  const check = (body: MessagesBody, tool: Record<string, unknown> | undefined): SearchCheck => {
    if (tool) {
      if (opts.enabled === false)
        return refuse(
          "Web search is not enabled for this organization. An administrator can enable it in the Claude Console.",
        );
      const allowed = tool.allowed_domains;
      const blocked = tool.blocked_domains;
      if (Array.isArray(allowed) && Array.isArray(blocked) && allowed.length && blocked.length)
        return refuse("web_search: use allowed_domains or blocked_domains, not both");
      for (const [field, list] of [
        ["allowed_domains", allowed],
        ["blocked_domains", blocked],
      ] as const) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
          const problem = domainProblem(e);
          if (problem) return refuse(`web_search.${field}: invalid domain ${problem}`);
        }
      }
      if (Array.isArray(allowed) && opts.orgAllowedDomains) {
        const outside = (allowed as string[]).filter(
          (d) => !underAny(d, opts.orgAllowedDomains ?? []),
        );
        if (outside.length)
          return refuse(
            `web_search.allowed_domains: the domains ${outside.join(", ")} are outside your organization's allowed domains`,
          );
      }
      const max = tool.max_uses;
      if (max !== undefined && max !== null && !(Number.isInteger(max) && (max as number) > 0))
        return refuse("web_search.max_uses: must be a positive integer");
    }
    // Every server block sent back must be the one issued, byte for byte.
    const answered = new Set<string>();
    const asked: { id: string; at: number }[] = [];
    let blocksBack = 0;
    const msgs = body.messages ?? [];
    for (const [i, m] of msgs.entries()) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Record<string, unknown>[]) {
        if (b?.type !== "server_tool_use" && b?.type !== "web_search_tool_result") continue;
        blocksBack++;
        const id = String(b.type === "server_tool_use" ? b.id : b.tool_use_id);
        const key = `${b.type}:${id}`;
        const want = issued.get(key);
        if (want === undefined)
          return refuse(`messages.${i}: ${String(b.type)} block ${id} was not issued by this API`);
        if (JSON.stringify(b) !== want)
          return refuse(
            b.type === "web_search_tool_result"
              ? `messages.${i}: the web_search_tool_result block for ${id} was modified: encrypted_content and every field must be passed back exactly as received`
              : `messages.${i}: the server_tool_use block ${id} was modified`,
          );
        if (b.type === "server_tool_use") asked.push({ id, at: i });
        else answered.add(id);
      }
    }
    const open = asked.filter((a) => !answered.has(a.id));
    const runNow: PendingSearch[] = [];
    for (const a of open) {
      if (!tool)
        return refuse(
          `messages.${a.at}: web_search tool use with id ${a.id} is waiting for its result, but no \`web_search\` tool was provided`,
        );
      const next = msgs[a.at + 1];
      if (next) {
        // A mixed step: the follow-up holds the app's tool results and nothing else.
        const blocks = Array.isArray(next.content)
          ? (next.content as Record<string, unknown>[])
          : [];
        if (
          next.role !== "user" ||
          !blocks.length ||
          blocks.some((b) => b?.type !== "tool_result") ||
          a.at + 1 !== msgs.length - 1
        )
          return refuse(
            `\`web_search\` tool use with id \`${a.id}\` was found without a corresponding \`web_search_tool_result\` block`,
          );
      }
      const q = pending.get(a.id)?.query ?? "";
      runNow.push({ id: a.id, query: q, results: opts.results?.(q) ?? [] });
    }
    return { runNow, blocksBack };
  };

  /**
   * The SSE writer's search side: the pending searches first (their results start the reply),
   * then each search the model runs, sealed and remembered; `done(n)` gets the searches run.
   */
  const streamer = (runNow: PendingSearch[], maxUses: number, done: (n: number) => void) => {
    let run = 0;
    const uses = new Map<string, string>();
    return {
      opening(): Record<string, unknown>[] {
        return runNow.map((p) => {
          pending.delete(p.id);
          run++;
          searches.push({ id: p.id, query: p.query, urls: p.results.map((r) => r.url) });
          const block = resultBlock(p.id, p.results);
          issued.set(`web_search_tool_result:${p.id}`, JSON.stringify(block));
          return block;
        });
      },
      use(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
        const block = { type: "server_tool_use", id, name, input };
        issued.set(`server_tool_use:${id}`, JSON.stringify(block));
        uses.set(id, String(input.query ?? ""));
        pending.set(id, { query: String(input.query ?? "") });
        return block;
      },
      result(id: string, hits: WebSearchHit[], errorCode?: string): Record<string, unknown> {
        pending.delete(id);
        // Past `max_uses` the API answers with an error result, which is not billed.
        const over = !errorCode && run >= maxUses;
        const code = errorCode ?? (over ? "max_uses_exceeded" : undefined);
        if (!code) run++;
        searches.push({
          id,
          query: uses.get(id) ?? "",
          urls: code ? [] : hits.map((h) => h.url),
          ...(code ? { errorCode: code } : {}),
        });
        const block = resultBlock(id, code ? [] : hits, code);
        issued.set(`web_search_tool_result:${id}`, JSON.stringify(block));
        return block;
      },
      searchTokens(): number {
        return run * (opts.resultTokens ?? 1_500);
      },
      runs(): number {
        return run;
      },
      done(): void {
        done(run);
      },
    };
  };

  return { check, streamer, searches, refusals };
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
    if (b.type === "server_tool_use")
      out.push({
        type: "server_tool_use",
        id: String(b.id),
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
      });
    else if (b.type === "web_search_tool_result") {
      const c = b.content;
      out.push({
        type: "server_tool_result",
        tool_use_id: String(b.tool_use_id),
        name: "web_search",
        results: Array.isArray(c)
          ? (c as Record<string, unknown>[]).map((r) => ({
              url: String(r.url ?? ""),
              title: String(r.title ?? ""),
              ...(typeof r.page_age === "string" ? { pageAge: r.page_age } : {}),
            }))
          : [],
        ...(Array.isArray(c)
          ? {}
          : { errorCode: String((c as { error_code?: unknown })?.error_code ?? "unavailable") }),
      });
    } else if (b.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
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

function toModelRequest(
  body: MessagesBody,
  signal: AbortSignal,
  runNow: readonly PendingSearch[] = [],
): ModelRequest {
  const messages: ChatMessage[] = (body.messages ?? []).map((m) => ({
    role: m.role,
    content: toBlocks(m.content),
  }));
  // A pending search runs at the start of this request: the model sees its results as the end
  // of its own turn ('web-search').
  if (runNow.length) {
    const results: ContentBlock[] = runNow.map((p) => ({
      type: "server_tool_result",
      tool_use_id: p.id,
      name: "web_search",
      results: p.results,
    }));
    const last = messages.at(-1);
    if (last?.role === "assistant" && Array.isArray(last.content))
      last.content = [...last.content, ...results];
    else messages.push({ role: "assistant", content: results });
  }
  // The app's own tools; the server tool is the request's `webSearch`.
  const tools: ToolDefinition[] = (body.tools ?? [])
    .filter((t) => typeof t.type !== "string" || t.type === "custom")
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.input_schema ?? {},
    }));
  const server = serverToolOf(body);
  const webSearch: WebSearchOptions | undefined = server
    ? {
        maxUses: typeof server.max_uses === "number" ? server.max_uses : 1_000,
        ...(Array.isArray(server.allowed_domains)
          ? { allowedDomains: server.allowed_domains as string[] }
          : {}),
        ...(Array.isArray(server.blocked_domains)
          ? { blockedDomains: server.blocked_domains as string[] }
          : {}),
      }
    : undefined;
  const cache = cacheMarks(body);
  return {
    model: body.model,
    ...(body.system ? { system: textOf(body.system) } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(webSearch ? { webSearch } : {}),
    max_tokens: body.max_tokens ?? 4096,
    ...(cache ? { cache } : {}),
    signal,
  };
}

/**
 * The prompt-cache breakpoints the body carries (`cache_control` on the system prompt, a tool,
 * a message block), as the request's `cache` flags ('cost'): the role-player bills them as the
 * API would and the model-call log shows what the Anthropic adapter asked for.
 */
function cacheMarks(body: MessagesBody): ModelRequest["cache"] | undefined {
  const marked = (b: unknown) =>
    !!b && typeof b === "object" && (b as { cache_control?: unknown }).cache_control != null;
  const system = Array.isArray(body.system) && body.system.some(marked);
  const tools = (body.tools ?? []).some(marked);
  const messages = (body.messages ?? []).some(
    (m) => Array.isArray(m.content) && (m.content as unknown[]).some(marked),
  );
  if (!system && !tools && !messages) return undefined;
  return {
    ...(system ? { system: true } : {}),
    ...(tools ? { tools: true } : {}),
    ...(messages ? { messages: true } : {}),
  };
}

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** The model's events as the API's SSE stream. */
function sse(
  events: AsyncIterable<StreamEvent>,
  model: string,
  search?: ReturnType<ReturnType<typeof searchState>["streamer"]>,
): ReadableStream<Uint8Array> {
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
      const block = (content_block: Record<string, unknown>, json?: string) => {
        index++;
        const start =
          json === undefined ? content_block : { ...content_block, input: {} as unknown };
        controller.enqueue(line("content_block_start", { index, content_block: start }));
        if (json !== undefined)
          controller.enqueue(
            line("content_block_delta", {
              index,
              delta: { type: "input_json_delta", partial_json: json },
            }),
          );
        controller.enqueue(line("content_block_stop", { index }));
      };
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
        // A search left pending in the last turn runs first; its result starts the reply.
        for (const b of search?.opening() ?? []) block(b);
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
            case "server_tool_use": {
              begin(EMPTY_USAGE);
              closeText();
              const b = search?.use(ev.id, ev.name, ev.input) ?? {
                type: "server_tool_use",
                id: ev.id,
                name: ev.name,
                input: ev.input,
              };
              block(b, JSON.stringify(ev.input));
              break;
            }
            case "server_tool_result": {
              begin(EMPTY_USAGE);
              closeText();
              if (search) block(search.result(ev.tool_use_id, ev.results, ev.errorCode));
              break;
            }
            case "message_end": {
              begin(EMPTY_USAGE);
              closeText();
              // The whole message's counters, as the API's message_delta carries them: each
              // search's results are input, and each search is counted ('web-search').
              const runs = search?.runs() ?? 0;
              controller.enqueue(
                line("message_delta", {
                  delta: {
                    stop_reason: ev.stop_reason === "error" ? "end_turn" : ev.stop_reason,
                    stop_sequence: null,
                  },
                  usage: {
                    output_tokens: ev.usage.output_tokens,
                    input_tokens: ev.usage.input_tokens + (search?.searchTokens() ?? 0),
                    cache_read_input_tokens: ev.usage.cache_read_input_tokens,
                    cache_creation_input_tokens: ev.usage.cache_creation_input_tokens,
                    ...(runs ? { server_tool_use: { web_search_requests: runs } } : {}),
                  },
                }),
              );
              controller.enqueue(line("message_stop", {}));
              break;
            }
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
        search?.done();
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
