import { describe, expect, it } from "vitest";
import { emptyChangeSummary } from "../src/githost/pr-executor.ts";
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
  it("W15-52: an empty change says what went wrong and the report's first sentence, two sentences at most", () => {
    const report =
      "**Result: the check fails.** The page links `styles.css`, which `README.md` names, but this branch does not have it. So the check cannot pass until a later task adds it. I left the page as it was.";
    const said = emptyChangeSummary(report);
    expect(said).toBe("The run changed no file. It reported: Result: the check fails.");
    expect(said.split(/(?<=[.!?])\s+/)).toHaveLength(2);
    // A first sentence longer than a line is cut at a word, never mid-word, and says so once.
    const long = emptyChangeSummary(
      `I looked at ${"every file in the repository and ".repeat(8)}found nothing to change. Done.`,
    );
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toMatch(/ \w+…$/);
    expect(long).not.toMatch(/…\./);
    expect(emptyChangeSummary("")).toBe("The run changed no file.");
  });
});
