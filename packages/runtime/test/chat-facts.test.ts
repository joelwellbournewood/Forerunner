import { describe, expect, it } from "vitest";
import { filesBlock } from "../src/conversation/project-facts.ts";

/**
 * d1109-chat-guard, run C: the facts a chat turn is given, as units (ADR 0114). The composed
 * cases are in chat-guard.test.ts.
 */
describe("d1109-chat-guard, run C: # Your files from the app's merge records (CG-4, D3-8)", () => {
  it("names the repository and this computer's copy, then the merges that wait with their record's sentence, the ones going on, the merged, the closed and those without a record; never 'merges it on GitHub'", () => {
    const block = filesBlock("/home/robin/app", {
      fullName: "alice/app",
      waiting: [
        {
          title: "Style the page",
          url: "https://github.com/alice/app/pull/4",
          sentence: "#4 waits for you to merge it: press Merge on the Overview.",
        },
      ],
      merging: [
        {
          title: "Add the script",
          url: "https://github.com/alice/app/pull/5",
          sentence: "#5 merges when its checks pass.",
        },
      ],
      merged: [{ title: "Write the README", url: "https://github.com/alice/app/pull/3" }],
      closed: [{ title: "Old try", url: "https://github.com/alice/app/pull/2" }],
      unknown: [{ title: "First page", url: "https://github.com/alice/app/pull/1" }],
    });
    expect(block).toBe(
      [
        "# Your files",
        "The repository: alice/app. Each task's work is a pull request there; it is on the default branch once it is merged.",
        "This computer's copy of the default branch: /home/robin/app",
        'Waiting for your Merge: "Style the page": #4 waits for you to merge it: press Merge on the Overview.',
        'Merging by itself: "Add the script": #5 merges when its checks pass.',
        'Merged: "Write the README" https://github.com/alice/app/pull/3',
        'Closed without merging: "Old try" https://github.com/alice/app/pull/2',
        'Pull requests of finished tasks: "First page" https://github.com/alice/app/pull/1',
      ].join("\n"),
    );
    expect(block).not.toContain("merges it on GitHub");
  });

  it("a folder project names its folder only", () => {
    expect(filesBlock("/home/robin/notes", null)).toBe(
      "# Your files\nThe project's folder: /home/robin/notes",
    );
  });
});
