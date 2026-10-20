import { z } from "zod";
import { CrossTurnDedup, dedupWithinBlock } from "./dedup.ts";
import { elideDenseLines } from "./dense.ts";
import { collapseLogs } from "./logs.ts";
import { type OriginalsSink, originalHash } from "./originals.ts";
import { DEFAULT_MAX_TOKENS, truncateWithErrors } from "./truncate.ts";
import type { Transform, TransformContext } from "./types.ts";

export type CompressionMode = "off" | "native" | "headroom";

export interface ToolProfile {
  maxTokens?: number;
  skip?: ("logs" | "dense" | "dedup" | "truncate")[];
}

export interface ContextSettings {
  compression: CompressionMode;
  maxToolResultTokens: number;
  toolProfiles: Record<string, ToolProfile>;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  compression: "native",
  maxToolResultTokens: DEFAULT_MAX_TOKENS,
  toolProfiles: {
    read_file: { maxTokens: 16_000 },
    "cc:Read": { maxTokens: 16_000 },
    git_diff: { skip: ["dedup"] },
    diff: { skip: ["dedup"] },
  },
};

const toolProfileSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  skip: z.array(z.enum(["logs", "dense", "dedup", "truncate"])).optional(),
});

const contextSettingsSchema = z.object({
  compression: z.enum(["off", "native", "headroom"]).default("native"),
  maxToolResultTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
  toolProfiles: z.record(z.string(), toolProfileSchema).default({}),
});

/**
 * The project's `settings.context` (ADR 0003 section 4) with the defaults in code. The input is
 * the whole `project.settings` value or undefined. A malformed `context` value falls back to the
 * defaults rather than failing a session; the per-tool profiles extend the built-in ones.
 */
export function contextSettingsFrom(settings: unknown): ContextSettings {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).context
      : undefined;
  const parsed = contextSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ...DEFAULT_CONTEXT_SETTINGS };
  const toolProfiles: Record<string, ToolProfile> = { ...DEFAULT_CONTEXT_SETTINGS.toolProfiles };
  for (const [tool, profile] of Object.entries(parsed.data.toolProfiles)) {
    const p: ToolProfile = {};
    if (profile.maxTokens !== undefined) p.maxTokens = profile.maxTokens;
    if (profile.skip !== undefined) p.skip = [...profile.skip];
    toolProfiles[tool] = p;
  }
  return {
    compression: parsed.data.compression,
    maxToolResultTokens: parsed.data.maxToolResultTokens,
    toolProfiles,
  };
}

export interface CompressionRecord {
  tool?: string;
  tokensBefore: number;
  tokensAfter: number;
  transforms: string[];
  /** Hash of the stored original (originals.ts) when the block changed and a store is in place. */
  original: string | null;
}

export interface PipelineSavings {
  /** Tokens the tool results would have cost with no transforms (estimated, counterfactual). */
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  /** Distinct transform names applied, in first-use order. */
  transforms: string[];
  /** Tool results measured. */
  records: number;
}

export interface RunCompressorOptions {
  /**
   * The caller's hard cap on a tool result as sent (the loop's `maxToolResultChars`). The
   * cross-turn index registers only what survives it, so a reference never names a cut line.
   */
  maxChars?: number;
}

/**
 * The transforms for one transcript (one `LoopAgentDriver` run). It owns the cross-turn index
 * and the turn counter, so `[same as tool result #k ...]` can only name the k-th tool result of
 * this transcript, and writes its records into the session pipeline for the measurement.
 */
export class RunCompressor {
  private readonly cross = new CrossTurnDedup();
  private turn = 0;

  constructor(
    private readonly pipeline: ContextPipeline,
    private readonly settings: ContextSettings,
    private readonly countTokens: (text: string) => number,
    private readonly originals: OriginalsSink | null,
    private readonly opts: RunCompressorOptions,
  ) {}

  compressToolResult(
    text: string,
    tool?: string,
    bypass: "default" | "off" = "default",
  ): { text: string; record: CompressionRecord } {
    const before = this.countTokens(text);
    if (this.settings.compression === "off" || bypass === "off") {
      const record: CompressionRecord = {
        tool,
        tokensBefore: before,
        tokensAfter: before,
        transforms: [],
        original: null,
      };
      this.pipeline.records.push(record);
      this.turn++;
      return { text, record };
    }
    const profile = (tool && this.settings.toolProfiles[tool]) || {};
    const skip = new Set(profile.skip ?? []);
    const hash = this.originals ? originalHash(text) : undefined;
    const ctx: TransformContext = {
      tool,
      countTokens: this.countTokens,
      maxTokens: profile.maxTokens ?? this.settings.maxToolResultTokens,
      ...(hash ? { originalHash: hash } : {}),
    };
    const applied: string[] = [];
    let out = text;
    const steps: [string, Transform][] = [
      ["logs", collapseLogs],
      ["dense", elideDenseLines],
      ["dedup", dedupWithinBlock],
    ];
    for (const [name, fn] of steps) {
      if (skip.has(name as "logs")) continue;
      const r = fn(out, ctx);
      if (r.changed) {
        applied.push(name);
        out = r.text;
      }
    }
    if (!skip.has("dedup")) {
      const r = this.cross.fold(out, this.turn);
      if (r.changed) {
        applied.push("dedup-cross");
        out = r.text;
      }
    }
    if (!skip.has("truncate")) {
      const r = truncateWithErrors(out, ctx);
      if (r.changed) {
        applied.push("truncate");
        out = r.text;
      }
    }
    let after = this.countTokens(out);
    // Never make things worse.
    if (after > before) {
      out = text;
      after = before;
      applied.length = 0;
    }
    let original: string | null = null;
    if (applied.length && hash && this.originals) {
      if (this.originals.write(hash, text)) original = hash;
      // Nothing stored: the truncate marker must not name a hash that resolves to nothing.
      else out = out.replace(`; original ${hash}]`, "]");
    }
    // Register what the model will actually see: the text as sent, under the caller's cap.
    const max = this.opts.maxChars;
    this.cross.remember(max !== undefined && out.length > max ? out.slice(0, max) : out, this.turn);
    this.turn++;
    const record: CompressionRecord = {
      tool,
      tokensBefore: before,
      tokensAfter: Math.min(after, before),
      transforms: applied,
      original,
    };
    this.pipeline.records.push(record);
    return { text: out, record };
  }
}

/**
 * The context layer of one session: settings, token counter, the original-block store and the
 * measurement records. Transforms run through a `RunCompressor` from `beginRun()`, one per
 * transcript, so cross-turn references never cross a run.
 */
export class ContextPipeline {
  readonly records: CompressionRecord[] = [];

  constructor(
    private readonly settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS,
    private readonly countTokens: (text: string) => number = (t) => Math.ceil(t.length / 4),
    private readonly originals: OriginalsSink | null = null,
  ) {}

  /** A compressor for one transcript; its records land in this session's measurement. */
  beginRun(opts: RunCompressorOptions = {}): RunCompressor {
    return new RunCompressor(this, this.settings, this.countTokens, this.originals, opts);
  }

  /**
   * One block outside any transcript (tests, tools): every transform except cross-turn
   * references, which need a transcript. Measured like any other block.
   */
  compressToolResult(
    text: string,
    tool?: string,
    bypass: "default" | "off" = "default",
  ): { text: string; record: CompressionRecord } {
    return this.beginRun().compressToolResult(text, tool, bypass);
  }

  /** Position in the record list; `savings(mark)` then measures one run inside the session. */
  mark(): number {
    return this.records.length;
  }

  /**
   * Totals since `since` (default: the whole session): estimated compression savings in tokens
   * and the transforms that produced them. Feeds the Run and Session fields and the cost view.
   */
  savings(since = 0): PipelineSavings {
    const slice = this.records.slice(Math.max(0, since));
    const transforms: string[] = [];
    let tokensBefore = 0;
    let tokensAfter = 0;
    for (const r of slice) {
      tokensBefore += r.tokensBefore;
      tokensAfter += r.tokensAfter;
      for (const t of r.transforms) if (!transforms.includes(t)) transforms.push(t);
    }
    return {
      tokensBefore,
      tokensAfter,
      saved: tokensBefore - tokensAfter,
      transforms,
      records: slice.length,
    };
  }
}
