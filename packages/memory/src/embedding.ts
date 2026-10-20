import { ForerunnerError } from "@forerunner/platform";

/**
 * Embeddings for lesson retrieval (ADR 0001: built-in cosine over rows, local hashed n-gram
 * embedding by default; ADR 0002: the Embedder interface admits a model-backed one later).
 *
 * The default embedder needs no network, no native module and no model file, is deterministic
 * (same text, same vector, on every OS) and cheap enough to run on every lesson write.
 */
export interface Embedder {
  /** Stable name; vectors from different embedders are never compared. */
  readonly name: string;
  /** Vector length. */
  readonly dims: number;
  embed(text: string): Float32Array;
}

export interface HashedNgramOptions {
  /** Feature hashing width. Default 256. */
  dims?: number;
  /** Smallest and largest character n-gram. Default 3 and 5. */
  minGram?: number;
  maxGram?: number;
  /** Weight of a word unigram feature relative to a character n-gram feature. Default 2. */
  wordWeight?: number;
}

/** FNV-1a, 32 bit, over UTF-16 code units. Deterministic everywhere, no dependency. */
export function fnv1a32(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lower-case, Unicode-normalised, whitespace collapsed. Shared by the embedder and the dedup. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word tokens: runs of letters and digits. */
export function wordTokens(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Character 3-5-grams plus word unigrams, feature-hashed (FNV-1a, signed buckets) into
 * `dims` dimensions and L2-normalised. Empty input gives the zero vector.
 */
export class HashedNgramEmbedder implements Embedder {
  readonly name: string;
  readonly dims: number;
  private readonly minGram: number;
  private readonly maxGram: number;
  private readonly wordWeight: number;

  constructor(opts: HashedNgramOptions = {}) {
    this.dims = opts.dims ?? 256;
    this.minGram = opts.minGram ?? 3;
    this.maxGram = opts.maxGram ?? 5;
    this.wordWeight = opts.wordWeight ?? 2;
    if (!Number.isInteger(this.dims) || this.dims < 8) {
      throw new ForerunnerError("validation", "embedder dims must be an integer >= 8");
    }
    if (this.minGram < 1 || this.maxGram < this.minGram) {
      throw new ForerunnerError("validation", "embedder n-gram range is invalid");
    }
    this.name = `hashed-ngram-${this.minGram}-${this.maxGram}-w${this.dims}-v1`;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const normalized = normalizeText(text);
    if (!normalized) return v;
    const add = (feature: string, weight: number) => {
      const h = fnv1a32(feature);
      const bucket = (h >>> 1) % this.dims;
      const sign = h & 1 ? 1 : -1;
      v[bucket] = (v[bucket] ?? 0) + sign * weight;
    };
    for (const w of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) add(`w:${w}`, this.wordWeight);
    const padded = ` ${normalized} `;
    for (let n = this.minGram; n <= this.maxGram; n++) {
      for (let i = 0; i + n <= padded.length; i++) add(`c${n}:${padded.slice(i, i + n)}`, 1);
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    return v;
  }
}

/** Cosine similarity; 0 when either vector is zero or the lengths differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/** JSON-friendly vector (6 decimals keep the row small and round-trip within 1e-6). */
export function vectorToJson(v: Float32Array): number[] {
  return Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
}

export type EmbedderFactory = (options?: Record<string, unknown>) => Embedder;

/**
 * Pluggable embedders. `hashed-ngram` is built in; a model-backed embedder (a provider call per
 * lesson write) registers itself under another name and the project setting picks it. The
 * embedder name is part of every comparison guard, so two embedders never score against each other.
 */
export class EmbedderRegistry {
  private readonly factories = new Map<string, EmbedderFactory>();

  constructor() {
    this.register("hashed-ngram", (options) => new HashedNgramEmbedder(options ?? {}));
  }

  register(name: string, factory: EmbedderFactory): void {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new ForerunnerError("validation", `embedder name must be lowercase kebab: ${name}`);
    }
    this.factories.set(name, factory);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(name: string = DEFAULT_EMBEDDER, options?: Record<string, unknown>): Embedder {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new ForerunnerError("not_found", `unknown embedder ${name}`, {
        details: { name, known: this.names() },
      });
    }
    return factory(options);
  }
}

export const DEFAULT_EMBEDDER = "hashed-ngram";

export const defaultEmbedderRegistry = new EmbedderRegistry();

export function defaultEmbedder(): Embedder {
  return defaultEmbedderRegistry.create(DEFAULT_EMBEDDER);
}
