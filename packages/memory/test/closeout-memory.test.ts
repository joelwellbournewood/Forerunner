import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/record.ts";
import { DEFAULT_WEIGHTS, recall } from "../src/retrieval.ts";
import { TEXTS, type World, world } from "./helpers.ts";

/**
 * Release close-out for module G (docs/requirements.md):
 *   G.2  the memory unit is a Lesson with source, tags, confidence and a usage count;
 *   G.7  the reference design (aerovato/operator-memory) was studied and an ADR says what to
 *        adopt; the retrieval code implements the formula that ADR fixes.
 */
describe("G.2: a Lesson carries source, tags, confidence and a usage count", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.close());

  it("the row and the file both carry the four fields; recall advances the usage count", async () => {
    const res = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windows,
      tags: ["windows", "ci"],
      source: "session:ses_1;review:rev_2",
      confidence: 0.8,
      projectId: w.project,
      authorAgent: w.alice,
    });
    expect(res.action).toBe("inserted");
    // The row (the index the code scores).
    expect(res.lesson).toMatchObject({
      source: "session:ses_1;review:rev_2",
      tags: ["ci", "windows"],
      confidence: 0.8,
      hit_count: 0,
      last_used: null,
    });
    // The file (the canonical copy a human can open).
    const file = await w.files.read(res.filePath);
    expect(file).toMatchObject({
      source: "session:ses_1;review:rev_2",
      tags: ["ci", "windows"],
      confidence: 0.8,
      hit_count: 0,
    });

    // Usage count: one recall that returns the lesson is one use, in the row and in the file.
    const hit = await recall(w.ctx, {
      scopes: ["shared"],
      agentId: w.alice,
      projectId: w.project,
      query: TEXTS.windows,
      tags: ["windows"],
    });
    expect(hit.lessons.map((l) => l.lesson.id)).toEqual([res.lesson.id]);
    const row = await w.store.lesson.mustGet(res.lesson.id);
    expect(row.hit_count).toBe(1);
    expect(row.last_used).toBe(w.clock.nowIso());
    expect((await w.files.read(res.filePath)).hit_count).toBe(1);
  });

  it("a lesson without a well-formed source, tags or confidence is refused", async () => {
    const base = {
      scope: "shared" as const,
      text: TEXTS.windows,
      projectId: w.project,
      authorAgent: w.alice,
    };
    await expect(remember(w.ctx, { ...base, source: "nonsense" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(remember(w.ctx, { ...base, tags: ["Not Kebab"] })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(remember(w.ctx, { ...base, confidence: 1.5 })).rejects.toMatchObject({
      code: "validation",
    });
  });
});

describe("G.7: the operator-memory reference design has an ADR on what to adopt", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const adrPath = join(repoRoot, "docs", "decisions", "0002-operator-memory.md");

  it("ADR 0002 names the reference, is accepted, and says what is adopted and what is rejected", () => {
    const adr = readFileSync(adrPath, "utf8");
    expect(adr).toMatch(/^# 0002 — What to adopt from aerovato\/operator-memory/m);
    expect(adr).toMatch(/^Status: accepted/m);
    expect(adr).toMatch(/^### Adopted/m);
    expect(adr).toMatch(/^### Rejected/m);
  });

  it("the retrieval code uses the scoring formula the ADR fixes", () => {
    const adr = readFileSync(adrPath, "utf8");
    const formula =
      /score = ([\d.]+)·sim \+ ([\d.]+)·tag \+ ([\d.]+)·conf \+ ([\d.]+)·fresh \+ ([\d.]+)·use/.exec(
        adr,
      );
    expect(formula).not.toBeNull();
    const [, sim, tag, conf, fresh, use] = formula ?? [];
    expect(DEFAULT_WEIGHTS).toMatchObject({
      sim: Number(sim),
      tag: Number(tag),
      conf: Number(conf),
      fresh: Number(fresh),
      use: Number(use),
    });
    const minSim = /sim < ([\d.]+)/.exec(adr);
    expect(DEFAULT_WEIGHTS.minSim).toBe(Number(minSim?.[1]));
  });
});
