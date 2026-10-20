/** Greedy fit by rank, whole items only. Used for lessons and docs retrieval under a token budget. */
export function fitToBudget<T>(
  items: readonly T[],
  maxTokens: number,
  countTokens: (item: T) => number,
): { kept: T[]; tokensUsed: number; dropped: number } {
  const kept: T[] = [];
  let used = 0;
  let dropped = 0;
  for (const item of items) {
    const n = countTokens(item);
    if (used + n <= maxTokens) {
      kept.push(item);
      used += n;
    } else {
      dropped++;
    }
  }
  return { kept, tokensUsed: used, dropped };
}
