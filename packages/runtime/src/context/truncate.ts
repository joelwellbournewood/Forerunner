import { createHash } from "node:crypto";
import type { TransformContext, TransformResult } from "./types.ts";
import { unchanged } from "./types.ts";

const ERROR_RE =
  /\b(error|fatal|exception|traceback|failed|panic|assert(ion)?|denied|timeout|timed out)\b/i;
const SUMMARY_RE =
  /^(=+ .* (passed|failed|error).* =+|Tests?:\s+\d|Test Files\s+\d|\d+ passing|\d+ failing|test result:|FAIL |PASS |npm ERR!|error\[E\d+\]|warning: .* generated)/i;
const MAX_ERRORS = 20;
const CONTEXT = 2;
export const DEFAULT_MAX_TOKENS = 4000;

/** Head/tail truncation that keeps error lines (with context) and test summaries. */
export function truncateWithErrors(text: string, ctx: TransformContext): TransformResult {
  try {
    const cap = ctx.maxTokens ?? DEFAULT_MAX_TOKENS;
    const tokens = ctx.countTokens(text);
    if (tokens <= cap) return unchanged(text);
    const lines = text.split("\n");
    const charBudget = Math.max(200, Math.floor((text.length * cap) / tokens));
    const keep = new Set<number>();
    let errors = 0;
    lines.forEach((l, i) => {
      if (SUMMARY_RE.test(l)) keep.add(i);
      if (errors < MAX_ERRORS && ERROR_RE.test(l)) {
        errors++;
        for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++)
          keep.add(k);
      }
    });
    const errorBlock = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`);
    const errorChars = errorBlock.join("\n").length;
    const remaining = Math.max(100, charBudget - errorChars);
    const headChars = Math.floor(remaining * 0.6);
    const tailChars = remaining - headChars;
    const head = text.slice(0, headChars);
    const tail = text.slice(-tailChars);
    const headLines = head.split("\n").length;
    const tailLines = tail.split("\n").length;
    const omitted = Math.max(0, lines.length - headLines - tailLines);
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
    const parts = [
      head,
      `\n[... ${omitted} lines, ~${Math.max(0, tokens - ctx.countTokens(head) - ctx.countTokens(tail))} tokens omitted; original ${hash}]`,
    ];
    if (errorBlock.length)
      parts.push(`\n[errors and summaries kept from the omitted part]\n${errorBlock.join("\n")}`);
    parts.push("\n[... tail]\n", tail);
    const out = parts.join("");
    return { text: out, changed: true, note: "truncate" };
  } catch {
    return unchanged(text);
  }
}
