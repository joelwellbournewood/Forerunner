import type { TransformContext, TransformResult } from "./types.ts";
import { unchanged } from "./types.ts";

const MIN_LEN = 300;
const MAX_SPACE_RATIO = 0.06;
const TOTAL_THRESHOLD = 2000;
const HEAD = 160;
const TAIL = 80;

function isDense(line: string): boolean {
  if (line.length < MIN_LEN || line.includes("\t")) return false;
  const t = line.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))
    return false;
  const spaces = (line.match(/ /g) ?? []).length;
  return spaces / line.length < MAX_SPACE_RATIO;
}

/** Elide the middle of minified/base64 lines when they add up to a lot of text. */
export function elideDenseLines(text: string, _ctx: TransformContext): TransformResult {
  try {
    const lines = text.split("\n");
    const denseTotal = lines.filter(isDense).reduce((s, l) => s + l.length, 0);
    if (denseTotal < TOTAL_THRESHOLD) return unchanged(text);
    const out = lines.map((l) =>
      isDense(l)
        ? `${l.slice(0, HEAD)}...[${l.length - HEAD - TAIL} chars elided]...${l.slice(-TAIL)}`
        : l,
    );
    const joined = out.join("\n");
    return { text: joined, changed: joined !== text, note: "dense" };
  } catch {
    return unchanged(text);
  }
}
