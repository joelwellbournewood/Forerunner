import { describe, expect, it } from "vitest";
import {
  cosine,
  DEFAULT_EMBEDDER,
  defaultEmbedder,
  defaultEmbedderRegistry,
  type Embedder,
  EmbedderRegistry,
  fnv1a32,
  HashedNgramEmbedder,
  normalizeText,
  vectorToJson,
  wordTokens,
} from "../src/embedding.ts";
import { TEXTS } from "./helpers.ts";

const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));

describe("HashedNgramEmbedder", () => {
  it("is deterministic: same text, same vector, across calls and instances", () => {
    const a = new HashedNgramEmbedder();
    const b = new HashedNgramEmbedder();
    const v1 = Array.from(a.embed(TEXTS.windows));
    const v2 = Array.from(a.embed(TEXTS.windows));
    const v3 = Array.from(b.embed(TEXTS.windows));
    expect(v1).toEqual(v2);
    expect(v1).toEqual(v3);
    expect(a.name).toBe(b.name);
  });

  it("produces 256-dimensional unit vectors by default", () => {
    const e = new HashedNgramEmbedder();
    expect(e.dims).toBe(256);
    expect(e.name).toBe("hashed-ngram-3-5-w256-v1");
    const v = e.embed(TEXTS.vault);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(256);
    expect(norm(v)).toBeCloseTo(1, 5);
  });

  it("gives the zero vector for empty input", () => {
    const e = new HashedNgramEmbedder();
    expect(norm(e.embed(""))).toBe(0);
    expect(norm(e.embed("  \r\n\t "))).toBe(0);
  });

  it("ignores case and whitespace differences", () => {
    const e = new HashedNgramEmbedder();
    expect(Array.from(e.embed("Use  Vitest\nfor TESTS"))).toEqual(
      Array.from(e.embed("use vitest for tests")),
    );
  });

  it("places similar texts closer than unrelated ones", () => {
    const e = new HashedNgramEmbedder();
    const a = e.embed("use vitest for unit tests");
    const similar = e.embed("use vitest for tests");
    const unrelated = e.embed("the cat sat on the mat");
    expect(cosine(a, similar)).toBeGreaterThan(0.8);
    expect(cosine(a, unrelated)).toBeLessThan(0.2);
    expect(cosine(e.embed(TEXTS.windows), e.embed(TEXTS.windowsDup))).toBeGreaterThan(0.92);
    expect(cosine(e.embed(TEXTS.windows), e.embed(TEXTS.vault))).toBeLessThan(0.2);
  });

  it("honours dims and n-gram options and rejects invalid ones", () => {
    const e = new HashedNgramEmbedder({ dims: 64, minGram: 2, maxGram: 3 });
    expect(e.dims).toBe(64);
    expect(e.embed("abc").length).toBe(64);
    expect(e.name).toBe("hashed-ngram-2-3-w64-v1");
    expect(() => new HashedNgramEmbedder({ dims: 4 })).toThrow(/dims/);
    expect(() => new HashedNgramEmbedder({ minGram: 4, maxGram: 3 })).toThrow(/n-gram/);
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors, 0 for a zero vector or mismatched lengths, and bounded", () => {
    const e = new HashedNgramEmbedder();
    const v = e.embed(TEXTS.vitest);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
    expect(cosine(v, new Float32Array(256))).toBe(0);
    expect(cosine(v, new Float32Array(8))).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
    expect(cosine([3, 0], [0, 4])).toBe(0);
  });
});

describe("vectorToJson", () => {
  it("round-trips within 1e-6 and keeps cosine with the original at 1", () => {
    const e = new HashedNgramEmbedder();
    const v = e.embed(TEXTS.budget);
    const json = vectorToJson(v);
    expect(json.length).toBe(256);
    for (let i = 0; i < json.length; i++) {
      expect(Math.abs((json[i] ?? 0) - (v[i] ?? 0))).toBeLessThan(1e-6);
    }
    expect(cosine(v, json)).toBeCloseTo(1, 6);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("EmbedderRegistry", () => {
  it("ships the hashed-ngram default", () => {
    expect(DEFAULT_EMBEDDER).toBe("hashed-ngram");
    expect(defaultEmbedderRegistry.names()).toContain("hashed-ngram");
    expect(defaultEmbedder().dims).toBe(256);
    expect(defaultEmbedderRegistry.create("hashed-ngram", { dims: 32 }).dims).toBe(32);
  });

  it("admits a pluggable embedder under its own name", () => {
    const reg = new EmbedderRegistry();
    const fake: Embedder = {
      name: "fake-model-v1",
      dims: 3,
      embed: (t) => new Float32Array([t.length, 1, 0]),
    };
    reg.register("fake-model", () => fake);
    expect(reg.names()).toEqual(["fake-model", "hashed-ngram"]);
    expect(reg.create("fake-model")).toBe(fake);
    expect(reg.create("fake-model").name).not.toBe(reg.create().name);
  });

  it("rejects unknown and badly named embedders", () => {
    const reg = new EmbedderRegistry();
    expect(() => reg.create("nope")).toThrow(/unknown embedder/);
    expect(() => reg.register("Bad Name", () => defaultEmbedder())).toThrow(/kebab/);
  });
});

describe("text helpers", () => {
  it("normalises text and tokenises words", () => {
    expect(normalizeText("  Héllo\r\n  WORLD ")).toBe("héllo world");
    expect(wordTokens("Run the Windows-CI job, twice!")).toEqual([
      "run",
      "the",
      "windows",
      "ci",
      "job",
      "twice",
    ]);
  });

  it("computes FNV-1a 32 bit", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
});
