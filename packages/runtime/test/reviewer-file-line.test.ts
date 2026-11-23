import { describe, expect, it } from "vitest";
import { fileTheWordsWrite, writesNoFileLine } from "../src/registry/tools.ts";

/**
 * l4-selftasks-carried, run L4 (L4-other-1 D-5; ADR 0109: a reviewer's findings are its report):
 * when a task's words ask for a file to be written, the line under Who does it for a specialist
 * that writes no file names it; a file the words only read never does.
 */
describe("l4-selftasks-carried, run L4: the file a task's words ask to be written (L4-other-1 D-5)", () => {
  const golden: [string[], string | null][] = [
    [["review.md lists the gaps and risks found in notes/plan.md"], "review.md"],
    [["The review.md file lists the gaps"], "review.md"],
    [["Write the gaps and risks to review.md"], "review.md"],
    [["Create review.md with the findings"], "review.md"],
    [["Save the review as review.md"], "review.md"],
    [["Write the findings in review.md"], "review.md"],
    [["Read data.csv and write summary.md"], "summary.md"],
    [["The gaps are listed", "findings.md exists"], "findings.md"],
    // Files the words only read:
    [["List the gaps and risks found in notes/plan.md"], null],
    [["Review README.md and list the gaps"], null],
    [["Check notes/plan.md against the brief"], null],
    [["The gaps found in notes/plan.md are listed"], null],
    [["Write notes on report.md"], null],
    [["A short list of the risks"], null],
    [[], null],
  ];
  for (const [words, file] of golden)
    it(`${JSON.stringify(words)} -> ${file ?? "none"}`, () => {
      expect(fileTheWordsWrite(words)).toBe(file);
    });

  it("the line names the file, or keeps the plain words", () => {
    expect(writesNoFileLine("reviewer", "review.md")).toBe(
      "The reviewer writes no file, so review.md is not written: its findings are its report, which you read in the task's drawer.",
    );
    expect(writesNoFileLine("reviewer")).toBe(
      "The reviewer writes no file: its findings are its report, which you read in the task's drawer.",
    );
  });
});
