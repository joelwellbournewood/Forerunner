import { describe, expect, it } from "vitest";
import { LOW_CONFIDENCE } from "../src/rules.ts";
import {
  confidenceOf,
  parseReviewFromText,
  SubmitReviewSchema,
  severityOf,
} from "../src/schema.ts";

describe("submit_review schema", () => {
  it("maps the prompt's vocabulary onto the store's: medium confidence sits below the accept line", () => {
    expect(confidenceOf("high")).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    expect(confidenceOf("medium")).toBeLessThan(LOW_CONFIDENCE);
    expect(confidenceOf("low")).toBeLessThan(confidenceOf("medium"));
    expect(confidenceOf(0.42)).toBe(0.42);
    expect(severityOf("blocker")).toBe("critical");
    expect(severityOf("major")).toBe("high");
    expect(severityOf("minor")).toBe("low");
    expect(severityOf("note")).toBe("info");
    expect(severityOf("medium")).toBe("medium");
  });

  it("parses the JSON object the prompt describes out of free text, or returns null", () => {
    const text =
      'Here is my review.\n{"grade": 81, "confidence": "high", "verdict": "revise", "summary": "ok", ' +
      '"findings": [{"severity": "minor", "what": "a {nit}", "where": "src/a.ts:3"}]}\nRationale: fine.';
    const r = parseReviewFromText(text);
    expect(r?.grade).toBe(81);
    expect(r?.findings[0]?.what).toBe("a {nit}");
    expect(r?.criteria).toEqual([]);
    expect(parseReviewFromText("no json here {not: valid}")).toBeNull();
    expect(parseReviewFromText('{"grade": 5}')).toBeNull();
  });

  it("rejects grades outside 0-100 and unknown verdicts", () => {
    const base = { grade: 50, confidence: "high", verdict: "accept", summary: "s" };
    expect(SubmitReviewSchema.safeParse(base).success).toBe(true);
    expect(SubmitReviewSchema.safeParse({ ...base, grade: 101 }).success).toBe(false);
    expect(SubmitReviewSchema.safeParse({ ...base, verdict: "approve" }).success).toBe(false);
    expect(SubmitReviewSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
  });
});
