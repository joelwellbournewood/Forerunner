import { normalizeText } from "./embedding.ts";

/**
 * Opposite-polarity word pairs. A lesson takes one side of a pair; two lessons on opposite
 * sides of the same pair contradict each other. Used by `remember` (never merge an opposite
 * into its counterpart) and by consolidation (flag the pair for the human, never resolve it).
 * A heuristic, not a model call: it runs offline, costs nothing and its verdict is explainable.
 */
export const POLARITY_PAIRS: readonly (readonly [
  positive: RegExp,
  negative: RegExp,
  label: string,
])[] = [
  [/\balways\b/, /\bnever\b/, "always/never"],
  [/\buse\b/, /\bavoid\b/, "use/avoid"],
  [/\bdo\b(?! not\b)/, /\bdo not\b/, "do/don't"],
  [/\bshould\b(?! not\b)/, /\bshould not\b/, "should/should not"],
  [/\bprefer\b/, /\bavoid\b/, "prefer/avoid"],
];

function polarityText(text: string): string {
  return normalizeText(text)
    .replace(/n't\b/g, " not")
    .replace(/\bdont\b/g, "do not")
    .replace(/\bshouldnt\b/g, "should not");
}

/** The pair label when `a` and `b` take opposite sides of one polarity pair, else null. */
export function polarityConflict(a: string, b: string): string | null {
  const ta = polarityText(a);
  const tb = polarityText(b);
  for (const [pos, neg, label] of POLARITY_PAIRS) {
    const aPos = pos.test(ta) && !neg.test(ta);
    const aNeg = neg.test(ta) && !pos.test(ta);
    const bPos = pos.test(tb) && !neg.test(tb);
    const bNeg = neg.test(tb) && !pos.test(tb);
    if ((aPos && bNeg) || (aNeg && bPos)) return label;
  }
  return null;
}
