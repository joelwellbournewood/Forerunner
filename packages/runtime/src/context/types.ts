/**
 * Context layer (ADR 0003). Every transform is pure, deterministic, idempotent and never
 * throws: on any failure it returns its input unchanged.
 */
export interface TransformContext {
  /** Tool that produced the block, for per-tool profiles. */
  tool?: string;
  /** Token counter shared with budgeting. */
  countTokens: (text: string) => number;
  /** Cap for truncate; set per tool profile. */
  maxTokens?: number;
  /**
   * Hash under which the pipeline stores the block's original (originals.ts). Only set when a
   * store is in place: a marker must never name a hash that resolves to nothing.
   */
  originalHash?: string;
}

export interface TransformResult {
  text: string;
  changed: boolean;
  note?: string;
}

export type Transform = (text: string, ctx: TransformContext) => TransformResult;

export const unchanged = (text: string): TransformResult => ({ text, changed: false });
