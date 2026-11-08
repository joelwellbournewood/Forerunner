import { describe, expect, it } from "vitest";
import {
  takeOutConflictSentence,
  takeOutOpenedSentence,
  unknownShapeSentence,
} from "../src/daemon/take-out-words.ts";

/**
 * "Take this work out"'s words (merged-actions, design §5: titles in quotes, up to three names
 * and then "and N more", ≤ 2 sentences). The bench walk of 2026-11-08 found "A", "B" and "C"
 * and 1 more" with two "and"s for a chain of four tasks.
 */
describe("Take this work out's words", () => {
  it("names the tasks that built on it: one, three, and more than three", () => {
    expect(takeOutOpenedSentence("Add the page", 9, [])).toBe(
      'Opened #9 to take "Add the page" out. It waits for you to merge it.',
    );
    expect(takeOutOpenedSentence("Add the page", 9, ["Style it"])).toBe(
      'Opened #9 to take "Add the page" out. It waits for you to merge it. "Style it" built on it: check it still works once #9 is merged.',
    );
    expect(takeOutOpenedSentence("Add the page", 9, ["A", "B", "C"])).toBe(
      'Opened #9 to take "Add the page" out. It waits for you to merge it. "A", "B" and "C" built on it: check they still work once #9 is merged.',
    );
    expect(takeOutOpenedSentence("Add the page", 9, ["A", "B", "C", "D"])).toBe(
      'Opened #9 to take "Add the page" out. It waits for you to merge it. "A", "B", "C" and 1 more built on it: check they still work once #9 is merged.',
    );
  });

  it("a conflict names up to three files; an unknown shape says what to do", () => {
    expect(takeOutConflictSentence("Set the price", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])).toBe(
      '"Set the price" could not be taken out by itself. Later work changed the same lines in a.ts, b.ts, c.ts and 2 more: undo it on GitHub by hand, or ask in Chat for a task that does it.',
    );
    expect(unknownShapeSentence(4)).toBe(
      "#4 was merged in a way Forerunner cannot undo safely; undo it on GitHub.",
    );
  });
});
