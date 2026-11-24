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
    // fixup-l4-selftasks-carried (the review's blocking item): a technology's or a site's dotted
    // name is no file the words ask for ("so Node.js is not written" was a false sentence).
    [["Write a review of the Node.js setup"], null],
    [["Write a review of the node.js setup"], null],
    [["Create a report on the Express.js routes"], null],
    [["Write up the risks in the ASP.NET app"], null],
    [["Produce a list of issues with the Vue.js components"], null],
    [["Create a summary of the Next.js and D3.js code"], null],
    [["Write the findings about the Socket.IO server"], null],
    [["Write the findings for example.com"], null],
    [["Write e.g. the risks and the gaps"], null],
    [["Write a review of the Node.js setup to review.md"], "review.md"],
    [["Save the review as review.markdown"], "review.markdown"],
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
