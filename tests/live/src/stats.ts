/** Small, dependency-free statistics for the timing table. */
export interface Summary {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = sorted(xs);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest-rank percentile (p in 0..100): the value at rank ceil(p/100 * n). */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = sorted(xs);
  const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
  return s[rank - 1] as number;
}

export function summarize(xs: readonly number[]): Summary {
  if (xs.length === 0) {
    return {
      n: 0,
      min: Number.NaN,
      median: Number.NaN,
      p90: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
    };
  }
  const s = sorted(xs);
  return {
    n: s.length,
    min: s[0] as number,
    median: median(s),
    p90: percentile(s, 90),
    max: s[s.length - 1] as number,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

export function ms(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n)} ms` : "n/a";
}
