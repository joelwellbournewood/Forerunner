import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import { collectFakeStream, isFirstTokenEvent, type StreamErrorEvent } from "./collect.ts";
import { requestFingerprint, requestHash } from "./hash.ts";
import type { RecordingStore } from "./recording-store.ts";
import {
  errorRetryable,
  mapErrorCode,
  matchesRequest,
  type ReplyBody,
  type ScriptedReply,
  type ToolCallReply,
  validateScript,
} from "./replies.ts";
import { countTokens, lastUserText, requestText } from "./tokens.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  StopReason,
  StreamEvent,
  Usage,
} from "./types.ts";

export type FakeMode = "script" | "replay" | "record" | "echo";

/** Where a call's reply came from. "echo" also covers an unmatched script with `onNoMatch: "echo"`. */
export type FakeReplySource = "script" | "echo" | "replay" | "record";

export interface FakeProviderOptions {
  /** Default "script" (an empty script falls back to `onNoMatch`). */
  mode?: FakeMode;
  /** Script mode: entries are tried in order; the first match answers and is consumed per `times`. */
  replies?: ScriptedReply[];
  /** Script mode, nothing matches: echo the last user message (default) or throw `not_found`. */
  onNoMatch?: "echo" | "throw";
  /** Replay and record modes. */
  store?: RecordingStore;
  /** Record mode: the real provider whose replies are saved. */
  inner?: ModelProvider;
  /** Latency is simulated through this clock; tests pass a SimulatedClock. Default: system. */
  clock?: Clock;
  /** "none" skips every sleep (ttft and spacing become 0) regardless of the script. */
  latency?: "simulated" | "none";
  /** Time to first token when a reply does not set `ttftMs`. Default 300. */
  defaultTtftMs?: number;
  /** Spacing between chunks when a reply does not set `totalMs`. Default 40 (~150 tok/s). */
  defaultMsPerChunk?: number;
  /** Target characters per text chunk; chunks end on whitespace within 1.5x. Default 20 (~5 tokens). */
  chunkChars?: number;
}

/** One request the fake received, kept for assertions. `request` is a copy without `signal`. */
export interface FakeCall {
  index: number;
  /** Clock time when the request arrived, ISO-8601 UTC. */
  at: string;
  mode: FakeMode;
  hash: string;
  request: Omit<ModelRequest, "signal">;
  /** Set once the reply is resolved (immediately for script/echo/replay, after the inner stream for record). */
  source?: FakeReplySource;
  reply?: ReplyBody;
}

export const FAKE_PROVIDER_NAME = "fake";

/** The fake ladder, one model per tier, cheapest first. Ids match the runtime's DEFAULT_LADDER. */
export const FAKE_MODELS: readonly ModelRef[] = [
  { provider: FAKE_PROVIDER_NAME, id: "fake-haiku", tier: "haiku" },
  { provider: FAKE_PROVIDER_NAME, id: "fake-sonnet", tier: "sonnet" },
  { provider: FAKE_PROVIDER_NAME, id: "fake-opus", tier: "opus" },
  { provider: FAKE_PROVIDER_NAME, id: "fake-fable", tier: "fable" },
];

const DEFAULT_TTFT_MS = 300;
const DEFAULT_MS_PER_CHUNK = 40;
const DEFAULT_CHUNK_CHARS = 20;
const JSON_DELTA_CHARS = 16;

/** Split text into model-like deltas of roughly `chunkChars` characters, ending on whitespace. */
export function chunkText(text: string, chunkChars = DEFAULT_CHUNK_CHARS): string[] {
  const out: string[] = [];
  const size = Math.max(1, Math.floor(chunkChars));
  const slack = Math.ceil(size / 2);
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const limit = Math.min(text.length, end + slack);
      let j = end;
      while (j < limit && !/\s/.test(text[j] ?? "")) j++;
      if (j < limit || j === text.length) end = j;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Realistic partial JSON: fixed-width slices that only make sense once concatenated. */
export function chunkJson(json: string, width = JSON_DELTA_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < json.length; i += width) out.push(json.slice(i, i + width));
  return out.length ? out : [json];
}

/** The deterministic default answer: the last user message, back. */
export function echoReply(req: ModelRequest): ReplyBody {
  const text = lastUserText(req);
  return { text: text || "(no user message)", stopReason: "end_turn" };
}

/** Turn a collected response into the reply shape scripts and recordings use. */
export function replyFromResponse(res: ModelResponse): ReplyBody {
  const text = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  const thinking = res.content
    .filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking")
    .map((b) => b.text)
    .join("");
  const toolCalls: ToolCallReply[] = res.content
    .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const reply: ReplyBody = {
    stopReason: res.stop_reason,
    usage: res.usage,
    ttftMs: Math.max(0, Math.round(res.time_to_first_token_ms)),
    totalMs: Math.max(0, Math.round(res.duration_ms)),
  };
  if (text) reply.text = text;
  if (thinking) reply.thinking = thinking;
  if (toolCalls.length) reply.toolCalls = toolCalls;
  return reply;
}

interface ScriptEntry {
  entry: ScriptedReply;
  remaining: number;
}

/**
 * The fake model provider. Four modes share one streaming engine with simulated latency:
 *
 * - script: scripted replies matched against the request, consumed in order;
 * - echo: the last user message back (deterministic, no setup);
 * - replay: a recorded reply looked up by the request hash in a RecordingStore;
 * - record: forwards to a real provider and saves its reply for replay.
 *
 * With a SimulatedClock nothing moves until the test advances it: start the consumer first
 * (`const p = provider.complete(req)`), then `await clock.advance(ms)`, then `await p`.
 */
export class FakeProvider implements ModelProvider {
  readonly name = FAKE_PROVIDER_NAME;
  readonly mode: FakeMode;
  readonly calls: FakeCall[] = [];
  private readonly clock: Clock;
  private readonly onNoMatch: "echo" | "throw";
  private readonly store: RecordingStore | undefined;
  private readonly inner: ModelProvider | undefined;
  private readonly latency: "simulated" | "none";
  private readonly defaultTtftMs: number;
  private readonly defaultMsPerChunk: number;
  private readonly chunkChars: number;
  private readonly initialScript: ScriptedReply[];
  private script: ScriptEntry[];

  constructor(opts: FakeProviderOptions = {}) {
    this.mode = opts.mode ?? "script";
    this.clock = opts.clock ?? systemClock;
    this.onNoMatch = opts.onNoMatch ?? "echo";
    this.store = opts.store;
    this.inner = opts.inner;
    this.latency = opts.latency ?? "simulated";
    this.defaultTtftMs = opts.defaultTtftMs ?? DEFAULT_TTFT_MS;
    this.defaultMsPerChunk = opts.defaultMsPerChunk ?? DEFAULT_MS_PER_CHUNK;
    this.chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
    this.initialScript = [...(opts.replies ?? [])];
    validateScript(this.initialScript);
    this.script = FakeProvider.toEntries(this.initialScript);
    if (this.mode === "replay" && !this.store) {
      throw new ForerunnerError("validation", "FakeProvider replay mode needs a RecordingStore");
    }
    if (this.mode === "record" && (!this.store || !this.inner)) {
      throw new ForerunnerError(
        "validation",
        "FakeProvider record mode needs a RecordingStore and an inner provider",
      );
    }
    if (this.defaultTtftMs < 0 || this.defaultMsPerChunk < 0) {
      throw new ForerunnerError("validation", "latency defaults must be >= 0");
    }
  }

  private static toEntries(replies: ScriptedReply[]): ScriptEntry[] {
    return replies.map((entry) => ({ entry, remaining: entry.times ?? 1 }));
  }

  async listModels(): Promise<ModelRef[]> {
    return FAKE_MODELS.map((m) => ({ ...m }));
  }

  countTokens(text: string): number {
    return countTokens(text);
  }

  /** The most recent request, for assertions. */
  get lastCall(): FakeCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Script entries not yet consumed. */
  remainingReplies(): number {
    return this.script.filter((e) => e.remaining > 0).length;
  }

  /** Append replies to the script at runtime (they are tried after the existing ones). */
  pushReplies(...replies: ScriptedReply[]): this {
    validateScript(replies);
    this.script.push(...FakeProvider.toEntries(replies));
    return this;
  }

  /** Forget recorded calls and restore the script given to the constructor. */
  reset(): this {
    this.calls.length = 0;
    this.script = FakeProvider.toEntries(this.initialScript);
    return this;
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const startedWall = this.clock.now();
    const { signal, ...rest } = req;
    const call: FakeCall = {
      index: this.calls.length,
      at: this.clock.nowIso(),
      mode: this.mode,
      hash: requestHash(req),
      request: structuredClone(rest),
    };
    this.calls.push(call);
    if (this.mode === "record") {
      yield* this.recordStream(req, call);
      return;
    }
    const reply = this.resolveReply(req, call);
    call.reply = reply;
    yield* this.emit(req, reply, startedWall, call.index, signal);
  }

  /**
   * Collects the stream. Provider errors throw a ForerunnerError (`provider_rate_limit`,
   * `provider_auth` or `provider_error`, with `retryable`); an abort returns the partial
   * response with stop_reason "aborted".
   */
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.clock.monotonic();
    const { response, error } = await collectFakeStream(
      this.stream(req),
      () => t0,
      () => this.clock.monotonic(),
    );
    if (!error) return response;
    if (error.code === "aborted") return { ...response, stop_reason: "aborted" };
    throw new ForerunnerError(mapErrorCode(error.code), error.message, {
      retryable: error.retryable,
      details: { provider: this.name, model: req.model, hash: this.lastCall?.hash },
    });
  }

  private resolveReply(req: ModelRequest, call: FakeCall): ReplyBody {
    switch (this.mode) {
      case "echo":
        call.source = "echo";
        return echoReply(req);
      case "replay":
        return this.replayReply(call);
      case "script": {
        const entry = this.takeMatching(req);
        if (entry) {
          call.source = "script";
          return entry.reply;
        }
        if (this.onNoMatch === "throw") {
          throw new ForerunnerError(
            "not_found",
            `fake provider: no scripted reply matched call #${call.index} ` +
              `(model ${req.model}, ${this.remainingReplies()} replies left, ` +
              `last user message starts "${lastUserText(req).slice(0, 60)}")`,
            { details: { call: call.index, model: req.model, hash: call.hash } },
          );
        }
        call.source = "echo";
        return echoReply(req);
      }
      default:
        throw new ForerunnerError("internal", `fake provider: unknown mode ${String(this.mode)}`);
    }
  }

  private replayReply(call: FakeCall): ReplyBody {
    const store = this.store;
    if (!store) throw new ForerunnerError("internal", "replay mode without a store");
    const rec = store.load(call.hash);
    if (!rec) {
      throw new ForerunnerError(
        "not_found",
        `fake provider: no recording for request hash ${call.hash} in suite "${store.suite}" ` +
          `(expected file ${store.pathFor(call.hash)}). To record it, run the same request through ` +
          `new FakeProvider({ mode: "record", inner: <live provider>, store }) with a credential ` +
          `present, then commit the file.`,
        { details: { hash: call.hash, suite: store.suite, path: store.pathFor(call.hash) } },
      );
    }
    call.source = "replay";
    return rec.reply;
  }

  private takeMatching(req: ModelRequest): ScriptedReply | undefined {
    for (const e of this.script) {
      if (e.remaining <= 0) continue;
      if (!matchesRequest(e.entry.when, req)) continue;
      e.remaining -= 1;
      if (e.remaining <= 0) this.script = this.script.filter((x) => x !== e);
      return e.entry;
    }
    return undefined;
  }

  private async *recordStream(req: ModelRequest, call: FakeCall): AsyncIterable<StreamEvent> {
    const inner = this.inner;
    const store = this.store;
    if (!inner || !store)
      throw new ForerunnerError("internal", "record mode needs inner and store");
    const t0 = this.clock.monotonic();
    let ttft = -1;
    const events: StreamEvent[] = [];
    for await (const ev of inner.stream(req)) {
      if (ttft < 0 && isFirstTokenEvent(ev)) ttft = this.clock.monotonic() - t0;
      events.push(ev);
      yield ev;
    }
    const duration = this.clock.monotonic() - t0;
    const { response, error } = await collectFakeStream(
      events,
      () => 0,
      () => duration,
    );
    if (error) return; // transient failures are never recorded; replay would reproduce them
    const reply = replyFromResponse({
      ...response,
      time_to_first_token_ms: ttft < 0 ? duration : ttft,
      duration_ms: duration,
    });
    store.save({
      version: 1,
      hash: call.hash,
      suite: store.suite,
      recordedAt: this.clock.nowIso(),
      provider: inner.name,
      request: requestFingerprint(req),
      reply,
    });
    call.source = "record";
    call.reply = reply;
  }

  /** Streams one reply with simulated latency: message_start, deltas, message_end (or error). */
  private async *emit(
    req: ModelRequest,
    reply: ReplyBody,
    startedWall: number,
    callIndex: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamEvent> {
    yield { type: "message_start", model: req.model };
    const ttft = this.latency === "none" ? 0 : (reply.ttftMs ?? this.defaultTtftMs);
    if (reply.error) {
      if (!(await this.waitUntil(startedWall + ttft, signal))) {
        yield abortedEvent();
        return;
      }
      yield {
        type: "error",
        code: mapErrorCode(reply.error.code),
        message: reply.error.message,
        retryable: errorRetryable(reply.error),
      };
      return;
    }
    const units = this.units(reply, callIndex);
    const n = units.length;
    const total =
      this.latency === "none"
        ? 0
        : Math.max(ttft, reply.totalMs ?? ttft + Math.max(0, n - 1) * this.defaultMsPerChunk);
    for (let i = 0; i < n; i++) {
      const due = n === 1 ? ttft : ttft + Math.round(((total - ttft) * i) / (n - 1));
      if (!(await this.waitUntil(startedWall + due, signal))) {
        yield abortedEvent();
        return;
      }
      yield units[i] as StreamEvent;
    }
    if (n === 0 && !(await this.waitUntil(startedWall + ttft, signal))) {
      yield abortedEvent();
      return;
    }
    yield {
      type: "message_end",
      stop_reason: stopReasonOf(reply),
      usage: this.usageOf(req, reply),
    };
  }

  /** The content events of a reply in order: thinking, text, then each tool call. */
  private units(reply: ReplyBody, callIndex: number): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const text of chunkText(reply.thinking ?? "", this.chunkChars)) {
      out.push({ type: "thinking_delta", text });
    }
    for (const text of chunkText(reply.text ?? "", this.chunkChars)) {
      out.push({ type: "text_delta", text });
    }
    (reply.toolCalls ?? []).forEach((call, i) => {
      const id = call.id ?? `toolu_fake_${callIndex}_${i}`;
      out.push({ type: "tool_use_start", id, name: call.name });
      for (const partial_json of chunkJson(JSON.stringify(call.input))) {
        out.push({ type: "tool_use_delta", id, partial_json });
      }
      out.push({ type: "tool_use_end", id, input: structuredClone(call.input) });
    });
    return out;
  }

  private usageOf(req: ModelRequest, reply: ReplyBody): Usage {
    let output = countTokens((reply.thinking ?? "") + (reply.text ?? ""));
    for (const t of reply.toolCalls ?? []) output += countTokens(t.name + JSON.stringify(t.input));
    return {
      input_tokens: countTokens(requestText(req)),
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...reply.usage,
    };
  }

  /** Sleeps on the clock until `due` (wall ms). False when the signal aborted meanwhile. */
  private async waitUntil(due: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return false;
    const wait = due - this.clock.now();
    if (wait <= 0) return true;
    try {
      await this.clock.sleep(wait, signal);
      return true;
    } catch (e) {
      if (signal?.aborted) return false;
      throw e;
    }
  }
}

function stopReasonOf(reply: ReplyBody): StopReason {
  return reply.stopReason ?? (reply.toolCalls?.length ? "tool_use" : "end_turn");
}

function abortedEvent(): StreamErrorEvent {
  return { type: "error", code: "aborted", message: "aborted", retryable: false };
}
