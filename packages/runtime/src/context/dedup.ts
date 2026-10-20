import { createHash } from "node:crypto";
import type { TransformContext, TransformResult } from "./types.ts";
import { unchanged } from "./types.ts";

const TRIVIAL = new Set([
  "}",
  "{",
  "]",
  "[",
  ")",
  "(",
  "return",
  "pass",
  "end",
  "else",
  "fi",
  "done",
  "};",
  "});",
  "/>",
  "<div>",
  "</div>",
]);
const MIN_WINDOW = 3;
const MAX_WINDOW = 64;

function anchorable(line: string): boolean {
  const t = line.trim();
  return t.length >= 4 && !TRIVIAL.has(t);
}

function hashLines(lines: string[]): string {
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** Within one block: a window of lines that appeared earlier in the same block is folded. */
export function dedupWithinBlock(text: string, _ctx: TransformContext): TransformResult {
  try {
    const lines = text.split("\n");
    if (lines.length < MIN_WINDOW * 2) return unchanged(text);
    const seen = new Map<string, number>(); // hash -> start line
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      let folded = false;
      for (let w = Math.min(MAX_WINDOW, lines.length - i); w >= MIN_WINDOW; w--) {
        const window = lines.slice(i, i + w);
        if (!window.some(anchorable)) continue;
        const h = hashLines(window);
        const prev = seen.get(h);
        if (prev !== undefined && prev + w <= i) {
          out.push(`... (repeats ${w} lines from ${i - prev} lines back)`);
          i += w;
          folded = true;
          break;
        }
      }
      if (folded) continue;
      // register windows starting here
      for (let w = MIN_WINDOW; w <= Math.min(MAX_WINDOW, lines.length - i); w++) {
        const window = lines.slice(i, i + w);
        if (!window.some(anchorable)) continue;
        const h = hashLines(window);
        if (!seen.has(h)) seen.set(h, i);
      }
      out.push(lines[i] ?? "");
      i++;
    }
    const joined = out.join("\n");
    return { text: joined, changed: joined !== text, note: joined !== text ? "dedup" : undefined };
  } catch {
    return unchanged(text);
  }
}

/**
 * Across tool results in one transcript: spans of >= 8 lines and >= 200 chars that appeared
 * verbatim in a strictly earlier result of the same transcript are replaced by a reference.
 * Matching looks only backwards, so appending a turn never changes an earlier one. One index
 * per run (`ContextPipeline.beginRun`): a reference `#k` must name a result that is in the
 * model's current context, so the index is never shared between runs, and `remember()` is
 * given the text as sent (after truncation and the hard cap) so the lines a reference names
 * are lines the model has.
 */
export class CrossTurnDedup {
  private index = new Map<string, { turn: number; line: number }>();
  private turns: string[][] = [];
  private static SPAN = 8;
  private static MIN_CHARS = 200;

  /** Folds spans seen in earlier turns; does not register this turn. */
  fold(text: string, turn: number): TransformResult {
    try {
      const lines = text.split("\n");
      const out: string[] = [];
      let i = 0;
      let changed = false;
      while (i < lines.length) {
        const line = lines[i] ?? "";
        const hit = anchorable(line) ? this.index.get(line) : undefined;
        if (hit && hit.turn < turn) {
          const prev = this.turns[hit.turn] ?? [];
          let len = 0;
          let chars = 0;
          while (
            i + len < lines.length &&
            hit.line + len < prev.length &&
            lines[i + len] === prev[hit.line + len]
          ) {
            chars += (lines[i + len] ?? "").length + 1;
            len++;
          }
          if (len >= CrossTurnDedup.SPAN && chars >= CrossTurnDedup.MIN_CHARS) {
            out.push(
              `[same as tool result #${hit.turn + 1} lines ${hit.line + 1}-${hit.line + len}]`,
            );
            i += len;
            changed = true;
            continue;
          }
        }
        out.push(line);
        i++;
      }
      const joined = out.join("\n");
      return { text: joined, changed, note: changed ? "dedup-cross" : undefined };
    } catch {
      return unchanged(text);
    }
  }

  /** Registers the lines of a turn as sent (earliest occurrence wins). Never throws. */
  remember(text: string, turn: number): void {
    try {
      const lines = text.split("\n");
      this.turns[turn] = lines;
      lines.forEach((l, n) => {
        if (anchorable(l) && !this.index.has(l)) this.index.set(l, { turn, line: n });
      });
    } catch {
      // registration is best effort
    }
  }

  /** `fold` then `remember` of the folded text: the one-step form for a block sent as is. */
  apply(text: string, turn: number): TransformResult {
    const r = this.fold(text, turn);
    this.remember(r.text, turn);
    return r;
  }
}
