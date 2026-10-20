import { CrossTurnDedup, dedupWithinBlock } from "./dedup.ts";
import { elideDenseLines } from "./dense.ts";
import { collapseLogs } from "./logs.ts";
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

export interface CompressionRecord {
  tool?: string;
  tokensBefore: number;
  tokensAfter: number;
  transforms: string[];
}

/**
 * Applies the baseline transforms to one tool result (the live zone). Keeps a per-session
 * cross-turn index and the measurement records for the Run and the cost view.
 */
export class ContextPipeline {
  private readonly cross = new CrossTurnDedup();
  private turn = 0;
  readonly records: CompressionRecord[] = [];

  constructor(
    private readonly settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS,
    private readonly countTokens: (text: string) => number = (t) => Math.ceil(t.length / 4),
  ) {}

  compressToolResult(
    text: string,
    tool?: string,
    bypass: "default" | "off" = "default",
  ): { text: string; record: CompressionRecord } {
    const before = this.countTokens(text);
    if (this.settings.compression === "off" || bypass === "off") {
      const record = { tool, tokensBefore: before, tokensAfter: before, transforms: [] };
      this.records.push(record);
      this.turn++;
      return { text, record };
    }
    const profile = (tool && this.settings.toolProfiles[tool]) || {};
    const skip = new Set(profile.skip ?? []);
    const ctx: TransformContext = {
      tool,
      countTokens: this.countTokens,
      maxTokens: profile.maxTokens ?? this.settings.maxToolResultTokens,
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
      const r = this.cross.apply(out, this.turn);
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
    this.turn++;
    const after = this.countTokens(out);
    // Never make things worse.
    if (after > before) {
      out = text;
      applied.length = 0;
    }
    const record = {
      tool,
      tokensBefore: before,
      tokensAfter: Math.min(after, before),
      transforms: applied,
    };
    this.records.push(record);
    return { text: out, record };
  }

  /** Session totals for the cost view: estimated compression savings in tokens. */
  savings(): { tokensBefore: number; tokensAfter: number; saved: number } {
    const tokensBefore = this.records.reduce((s, r) => s + r.tokensBefore, 0);
    const tokensAfter = this.records.reduce((s, r) => s + r.tokensAfter, 0);
    return { tokensBefore, tokensAfter, saved: tokensBefore - tokensAfter };
  }
}
