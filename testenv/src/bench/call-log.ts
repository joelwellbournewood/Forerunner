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
}

export interface ModelCallLogOptions {
  /** The JSONL file; its directory is created on the first write. */
  file: string;
  /** Literal values that must never appear in the file (an API key). */
  secrets?: readonly string[];
  clock?: Clock;
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
    const full: ModelCallRecord = { seq: this.seq, ...record };
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

  /** Every string redacted and every secret replaced, at any depth. */
  private scrub<T>(value: T): T {
    if (typeof value === "string") {
      let s: string = value;
      for (const secret of this.secrets) s = s.split(secret).join("[REDACTED]");
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
