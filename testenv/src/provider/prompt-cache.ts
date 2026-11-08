import { createHash } from "node:crypto";
import { type Clock, systemClock } from "@forerunner/platform";
import { canonicalJson } from "./hash.ts";
import { countTokens, messageText } from "./tokens.ts";
import type { ChatMessage, ModelRequest, Usage } from "./types.ts";

/**
 * A stand-in for Anthropic's prompt cache ('cost', L-15), for the fake provider (opt-in) and the
 * bench's role-player: given a request's `cache` flags it reports what the API would bill as
 * cache reads, cache writes and plain input, so a test or a bench walk sees `cache_read` grow
 * turn by turn and the runtime's pre-call estimate is checked against a realistic bill.
 *
 * It follows the API's rules as the Anthropic adapter (`packages/runtime/src/provider/
 * anthropic.ts`) uses them: the prompt renders tools, then system, then messages; a breakpoint
 * sits at the end of the tools (`cache.tools`), of the system prompt (`cache.system`), of the
 * last message and of the last user message before the last assistant message
 * (`cache.messages`); a request reads the longest marked prefix a request of the same model
 * wrote or read less than `ttlMs` ago (an entry lives from the start of the request that wrote
 * or last read it) and writes every marked prefix past it, billed once as the tokens from the
 * read to its last breakpoint; a prefix shorter than `minTokens` is never written; what follows
 * the last breakpoint is plain input. Tokens are counted as the provider counts them.
 */
export interface PromptCacheOptions {
  clock?: Clock;
  /** The model's minimum cacheable length in tokens. Default 512 (the 5.5 generation's). */
  minTokens?: number;
  /** An entry's lifetime from the start of the request that wrote or read it. Default 5 min. */
  ttlMs?: number;
  /** Counts the tokens of a piece of text. Default: one per four characters. */
  countTokens?: (text: string) => number;
  /** The text a message counts as. Default: its text, tool inputs and tool results. */
  messageText?: (m: ChatMessage) => string;
}

export const DEFAULT_PROMPT_CACHE_MIN_TOKENS = 512;
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

export class PromptCacheSim {
  private readonly clock: Clock;
  private readonly minTokens: number;
  private readonly ttlMs: number;
  private readonly count: (text: string) => number;
  private readonly textOf: (m: ChatMessage) => string;
  /** Prefix key -> when it expires (clock ms). */
  private readonly entries = new Map<string, number>();

  constructor(opts: PromptCacheOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.minTokens = opts.minTokens ?? DEFAULT_PROMPT_CACHE_MIN_TOKENS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS;
    this.count = opts.countTokens ?? countTokens;
    this.textOf = opts.messageText ?? messageText;
  }

  /** Forget every entry (as if the cache expired). */
  clear(): void {
    this.entries.clear();
  }

  /**
   * The input side of the bill for `req` (output is the caller's), with its entries read and
   * written as the API would. `startedAt`: when the request started (default now).
   */
  bill(req: ModelRequest, startedAt = this.clock.now()): Omit<Usage, "output_tokens"> {
    const toolsTokens = (req.tools ?? []).reduce(
      (s, t) => s + this.count(`${t.name}: ${t.description} ${JSON.stringify(t.input_schema)}`),
      0,
    );
    const systemTokens = req.system ? this.count(req.system) : 0;
    const messageTokens = req.messages.map((m) => this.count(this.textOf(m)));
    const total = toolsTokens + systemTokens + messageTokens.reduce((s, n) => s + n, 0);
    // The marked prefixes, shortest first: [tokens, key].
    const marks: { tokens: number; key: string }[] = [];
    const key = (parts: unknown) =>
      createHash("sha256")
        .update(canonicalJson({ model: req.model, ...(parts as object) }), "utf8")
        .digest("hex");
    const tools = (req.tools ?? []).map((t) => ({ ...t }));
    if (req.cache?.tools && tools.length) marks.push({ tokens: toolsTokens, key: key({ tools }) });
    if (req.cache?.system && req.system)
      marks.push({ tokens: toolsTokens + systemTokens, key: key({ tools, system: req.system }) });
    if (req.cache?.messages && req.messages.length) {
      const last = req.messages.length - 1;
      const at: number[] = [];
      const lastAssistant = req.messages.findLastIndex((m) => m.role === "assistant");
      if (lastAssistant > 0) {
        const previousEnd = req.messages.findLastIndex(
          (m, i) => i < lastAssistant && m.role === "user",
        );
        if (previousEnd >= 0 && previousEnd !== last) at.push(previousEnd);
      }
      at.push(last);
      for (const i of at) {
        const upTo = messageTokens.slice(0, i + 1).reduce((s, n) => s + n, 0);
        marks.push({
          tokens: toolsTokens + systemTokens + upTo,
          key: key({ tools, system: req.system ?? "", messages: req.messages.slice(0, i + 1) }),
        });
      }
    }
    const now = startedAt;
    let read = 0;
    for (const m of marks) {
      const expires = this.entries.get(m.key);
      if (expires !== undefined && expires > now) {
        read = Math.max(read, m.tokens);
        this.entries.set(m.key, now + this.ttlMs);
      }
    }
    let written = 0;
    for (const m of marks) {
      if (m.tokens <= read || m.tokens < this.minTokens) continue;
      this.entries.set(m.key, now + this.ttlMs);
      written = Math.max(written, m.tokens);
    }
    const write = written > read ? written - read : 0;
    return {
      input_tokens: Math.max(0, total - read - write),
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
    };
  }
}
