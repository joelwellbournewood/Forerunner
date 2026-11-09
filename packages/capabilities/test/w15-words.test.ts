import { describe, expect, it } from "vitest";
import { WebReadPolicy } from "../src/web/policy.ts";

/**
 * w15-words (wave 15 run B): the capability sentences a person (and the model) reads, at the
 * function that writes them (design §5).
 */
describe("w15-words, wave 15 run B", () => {
  it("W15-78: the reader's refusal on an empty 'only these websites' list says it plainly", () => {
    const none = new WebReadPolicy({ mode: "only", only: [], never: [] });
    expect(none.checkUrl("https://example.org/x")).toEqual({
      ok: false,
      reason: "not_only",
      host: "example.org",
      // Before: '... is not on this project's "only these websites" list, which names no website'.
      message: 'example.org was not read: this project\'s "only these websites" list is empty',
    });
    // A list that names sites keeps its words.
    const some = new WebReadPolicy({ mode: "only", only: ["example.com"], never: [] });
    expect(some.checkUrl("https://example.org/x")).toMatchObject({
      message: 'example.org is not on this project\'s "only these websites" list (example.com)',
    });
  });
});
