import { appendFileSync, mkdirSync } from "node:fs";
import { type Clock, dirname, join, redact, systemClock } from "@forerunner/platform";
import { collectFakeStream } from "../provider/collect.ts";
import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  StreamEvent,
  Usage,
} from "../provider/types.ts";
import { detectRole, type RoleGuess } from "./roles.ts";

/**
 * The bench's model-call log (scripts/bench/README.md): one JSON line per request the daemon
 * sends a model, with what the app gave it (system prompt, messages, tool names) and what came
 * back. It is how a tester sees what context the app hands the model. Every string passes
 * through the platform's `redact` and every value in `secrets` is replaced, so a key never
 * reaches the file even if a provider echoed it.
 */

/** What a model answered, as the log records it. */
export interface LoggedReply {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  stopReason: StopReason | null;
  usage?: Usage;
  error?: { code: string; message: string };
}

export interface ModelCallRecord {
  seq: number;
  time: string;
  /** "stand-in" for the role-player, "live" for the logging wrapper around a real provider. */
  mode: "stand-in" | "live";
  role: RoleGuess["role"];
  /** Specialist name for a specialist run; the task title it ran on when the label says so. */
  specialist?: string;
  task?: string;
  /** The loop driver's run label (`ModelRequest.origin.label`). */
  label: string | null;
  sessionId: string | null;
  runId: string | null;
  provider: string;
  model: string;
  max_tokens: number;
  effort: string | null;
  thinking: string | null;
  system: string;
  messages: ChatMessage[];
  tools: string[];
  reply: LoggedReply;
  /** Failure injection that shaped this reply (stand-in only). */
  injected?: string;
  durationMs: number;
  /** `ModelRequest.speed` when the request set one (fast mode is priced on its own row). */
  speed?: string;
  /**
   * What the request asked the provider's prompt cache to keep (`ModelRequest.cache`: the
   * system prompt, the tools, the conversation), when it asked ('cost', L-15). With
   * `reply.usage.cache_read_input_tokens` it shows the conversation cached turn by turn.
   */
  cache?: { system?: boolean; tools?: boolean; messages?: boolean };
  /**
   * What the call cost in USD by the app's own price table (`packages/billing/src/pricing.ts`
   * and `<config>/pricing.json`, through `ModelCallLogOptions.priceOf`): null when the model has
   * no price row (the stand-in's `fake-*` rungs) or the reply carried no usage.
   */
  usd?: number | null;
  /** The price row `usd` was computed from (USD per million tokens). */
  price?: PriceRowUsed | null;
  /** Why there is no `usd` ("no price known for model ..."). */
  priceError?: string;
}

/** A row of the app's price table as a log line records it. */
export interface PriceRowUsed {
  /** The table's key: the canonical model id (`-fast` for a fast-mode call). */
  model: string;
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  cache_read_per_mtok_usd: number;
  cache_write_per_mtok_usd: number;
  source: string;
  as_of: string;
}

/** What one call cost: the USD and the row, or why there is none. */
export interface CallPrice {
  usd: number | null;
  price: PriceRowUsed | null;
  priceError?: string;
}

/**
 * Prices a call from its model (and speed) and its usage. The daemon passes one built from the
 * app's own table (`packages/runtime/src/cli/main.ts`, `daemonProvider`); testenv itself does
 * not depend on billing.
 */
export type PriceOf = (call: { model: string; speed?: string }, usage: Usage) => CallPrice;

export interface ModelCallLogOptions {
  /** The JSONL file; its directory is created on the first write. */
  file: string;
  /**
   * Values that must never appear in the file (an API key): neither whole nor any part of
   * `SECRET_FRAGMENT_CHARS` characters or more.
   */
  secrets?: readonly string[];
  /** Adds `usd` and `price` to every line whose reply carried usage. */
  priceOf?: PriceOf;
  clock?: Clock;
}

/** The shortest run of a secret's characters the log replaces (a key's fragment in an error). */
export const SECRET_FRAGMENT_CHARS = 8;

/**
 * `s` with every run of `min` or more characters that also occurs in `secret` replaced. A
 * provider error may quote part of a key ("key ending in ..."); the whole key is caught by the
 * plain replacement, a fragment only here. Cheap when nothing matches: one set lookup per
 * position.
 */
export function withoutSecretParts(s: string, secret: string, min = SECRET_FRAGMENT_CHARS): string {
  if (!secret || secret.length < min) return secret ? s.split(secret).join("[REDACTED]") : s;
  const windows = new Set<string>();
  for (let i = 0; i + min <= secret.length; i++) windows.add(secret.slice(i, i + min));
  let out = "";
  let pos = 0;
  let plainFrom = 0;
  while (pos + min <= s.length) {
    if (!windows.has(s.slice(pos, pos + min))) {
      pos++;
      continue;
    }
    let len = min;
    while (pos + len < s.length && secret.includes(s.slice(pos, pos + len + 1))) len++;
    out += `${s.slice(plainFrom, pos)}[REDACTED]`;
    pos += len;
    plainFrom = pos;
  }
  return plainFrom === 0 ? s : out + s.slice(plainFrom);
}

/** The log file for a daemon home: `<FORERUNNER_HOME>/bench/model-calls.jsonl`. */
export function modelCallLogPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.FORERUNNER_BENCH_LOG?.trim();
  if (explicit) return explicit;
  const home = env.FORERUNNER_HOME?.trim();
  if (home) return join(home, "bench", "model-calls.jsonl");
  return join(process.cwd(), "bench-model-calls.jsonl");
}

export class ModelCallLog {
  private seq = 0;
  private readonly clock: Clock;
  private readonly secrets: string[];
  private dirReady = false;

  constructor(private readonly opts: ModelCallLogOptions) {
    this.clock = opts.clock ?? systemClock;
    this.secrets = (opts.secrets ?? []).filter((s) => s.length >= 8);
  }

  get file(): string {
    return this.opts.file;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  monotonic(): number {
    return this.clock.monotonic();
  }

  /** Append one record; never throws (a full disk must not fail the model call). */
  write(record: Omit<ModelCallRecord, "seq">): ModelCallRecord {
    this.seq += 1;
    const full: ModelCallRecord = { seq: this.seq, ...record, ...this.priced(record) };
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.opts.file), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.opts.file, `${JSON.stringify(this.scrub(full))}\n`);
    } catch (e) {
      console.error(`[bench] model-call log not written: ${String(e)}`);
    }
    return full;
  }

  /** `usd` and `price` from `priceOf`, for a reply that carried usage; nothing otherwise. */
  private priced(record: Omit<ModelCallRecord, "seq">): Partial<CallPrice> {
    const usage = record.reply.usage;
    if (!this.opts.priceOf || !usage) return {};
    try {
      const p = this.opts.priceOf(
        { model: record.model, ...(record.speed ? { speed: record.speed } : {}) },
        usage,
      );
      return { usd: p.usd, price: p.price, ...(p.priceError ? { priceError: p.priceError } : {}) };
    } catch (e) {
      return { usd: null, price: null, priceError: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Every string redacted and every secret (whole or in part) replaced, at any depth. */
  private scrub<T>(value: T): T {
    if (typeof value === "string") {
      let s: string = value;
      for (const secret of this.secrets) s = withoutSecretParts(s, secret);
      return redact(s) as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.scrub(v);
      return out as T;
    }
    return value;
  }
}

/** The request fields every record carries. */
export function requestFields(
  req: ModelRequest,
  provider: string,
): Pick<
  ModelCallRecord,
  | "role"
  | "specialist"
  | "task"
  | "label"
  | "sessionId"
  | "runId"
  | "provider"
  | "model"
  | "max_tokens"
  | "effort"
  | "thinking"
  | "system"
  | "messages"
  | "tools"
  | "speed"
  | "cache"
> {
  const guess = detectRole(req);
  return {
    role: guess.role,
    ...(guess.specialist ? { specialist: guess.specialist } : {}),
    ...(guess.task ? { task: guess.task } : {}),
    label: req.origin?.label ?? null,
    sessionId: req.origin?.sessionId ?? null,
    runId: req.origin?.runId ?? null,
    provider,
    model: req.model,
    max_tokens: req.max_tokens,
    effort: req.effort ?? null,
    thinking: req.thinking ?? null,
    system: req.system ?? "",
    messages: req.messages,
    tools: (req.tools ?? []).map((t) => t.name),
    ...(req.speed ? { speed: req.speed } : {}),
    ...(req.cache ? { cache: { ...req.cache } } : {}),
  };
}

/**
 * Live mode (`fr daemon --provider bench-live`): the real provider, unchanged, with every
 * request and its reply written to the model-call log. Events pass through as they arrive.
 */
export function withModelCallLog(inner: ModelProvider, log: ModelCallLog): ModelProvider {
  const provider: ModelProvider = {
    name: inner.name,
    ...(inner.fastMode !== undefined ? { fastMode: inner.fastMode } : {}),
    ...(inner.capabilities ? { capabilities: inner.capabilities } : {}),
    listModels: () => inner.listModels(),
    countTokens: (t) => inner.countTokens(t),
    ...(inner.maxOutputTokens
      ? {
          maxOutputTokens: (model: string, opts?: { signal?: AbortSignal }) =>
            inner.maxOutputTokens?.(model, opts),
        }
      : {}),
    async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
      const started = log.monotonic();
      const time = log.nowIso();
      const reply: LoggedReply = { text: "", toolCalls: [], stopReason: null };
      const pendingNames = new Map<string, string>();
      try {
        for await (const ev of inner.stream(req)) {
          if (ev.type === "text_delta") reply.text += ev.text;
          else if (ev.type === "tool_use_end") {
            const name = pendingNames.get(ev.id) ?? "";
            reply.toolCalls.push({ name, input: ev.input });
          } else if (ev.type === "tool_use_start") pendingNames.set(ev.id, ev.name);
          else if (ev.type === "message_end") {
            reply.stopReason = ev.stop_reason;
            reply.usage = ev.usage;
          } else if (ev.type === "error") {
            reply.stopReason = "error";
            reply.error = { code: ev.code, message: ev.message };
          }
          yield ev;
        }
      } catch (e) {
        reply.stopReason = "error";
        reply.error = { code: "thrown", message: e instanceof Error ? e.message : String(e) };
        throw e;
      } finally {
        log.write({
          time,
          mode: "live",
          ...requestFields(req, inner.name),
          reply,
          durationMs: Math.round(log.monotonic() - started),
        });
      }
    },
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const { response, error } = await collectFakeStream(
        provider.stream(req),
        () => log.monotonic(),
        () => log.monotonic(),
      );
      return error
        ? { ...response, error: { code: error.code, message: error.message } }
        : response;
    },
  };
  return provider;
}
