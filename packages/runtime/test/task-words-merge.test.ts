import type { MergeRecordRow, TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { type TaskDisplayContext, taskDisplay } from "../src/daemon/task-words.ts";

/**
 * The Tasks row of a done task whose pull request waits (merge-in-app, ADR 0111): one label per
 * merge record outcome, agreeing with the Overview's row (design §2: one status map for every
 * screen). Before (live check 2, F1; W15-55), every record left to the person but a conflict read
 * "Accepted · waiting for you to merge", while the Overview said the pull request was closed, could
 * not be rebuilt, or changed after the review, with no Merge.
 */
const task = (id = "t1"): TaskRow =>
  ({
    id,
    title: "Write the footer",
    status: "done",
    reason: "critic accepted",
    depends_on: [],
  }) as unknown as TaskRow;

function ctxWith(
  merge: Partial<MergeRecordRow> & Pick<MergeRecordRow, "state" | "sentence">,
): TaskDisplayContext {
  return {
    tasks: new Map([["t1", task()]]),
    cards: new Map(),
    sandboxReady: true,
    runs: new Map(),
    agentNames: new Map(),
    merges: new Map([["t1", { approval: "none", pr_number: 8, ...merge }]]),
  } as unknown as TaskDisplayContext;
}

describe("w15-merge, wave 15", () => {
  it("a record left to the person says what its Overview row says, never 'waiting for you to merge' when no Merge waits (W15-55)", () => {
    const cases: [string, string, string][] = [
      ["closed", "#8 was closed without merging.", "Accepted · pull request closed"],
      [
        "rebuild_conflict",
        "#8 could not be rebuilt without #4, which was closed: both change index.html. It waits for you: redo the task, or resolve it on GitHub.",
        "Accepted · could not be rebuilt",
      ],
      [
        "head_moved",
        "#8 changed after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.",
        "Accepted · changed after the review",
      ],
      [
        "rebuilt_without",
        "#8 was rebuilt without #4, which was closed. It was reviewed with #4's changes, so it waits for you: look at it, then merge it or redo the task.",
        "Accepted · rebuilt: look before you merge",
      ],
      [
        "checks_failed",
        "A check failed on #8 (ci/test): fix it, or merge it on GitHub.",
        "Accepted · a check failed",
      ],
    ];
    for (const [outcome, sentence, label] of cases) {
      const row = taskDisplay(
        task(),
        ctxWith({ state: "left_to_you", last_outcome: outcome, sentence }),
      );
      expect(row.label, outcome).toBe(label);
      expect(row.label, outcome).not.toBe("Accepted · waiting for you to merge");
      expect(row.detail, outcome).toBe(sentence);
    }
    // The plain wait for the person's Merge still reads as before.
    expect(
      taskDisplay(
        task(),
        ctxWith({
          state: "left_to_you",
          last_outcome: "not_allowed",
          sentence: "#8 waits for you to merge it: press Merge on the Overview.",
        }),
      ).label,
    ).toBe("Accepted · waiting for you to merge");
  });

  it("a merge that waits because GitHub does not answer says so, not that it waits for checks (W15-68)", () => {
    const row = taskDisplay(
      task(),
      ctxWith({
        state: "waiting_checks",
        last_outcome: "unreachable",
        sentence: "GitHub did not answer about #8: Forerunner tries the merge again.",
      }),
    );
    expect(row.label).toBe("Accepted · merges once GitHub answers");
    expect(row.detail).toBe("GitHub did not answer about #8: Forerunner tries the merge again.");
  });
});
