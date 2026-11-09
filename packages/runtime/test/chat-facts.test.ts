import { describe, expect, it } from "vitest";
import { filesBlock, todayLine } from "../src/conversation/project-facts.ts";

describe("d1109-chat-guard, run C: the person's own day and time in the facts (CG-5, D3-6)", () => {
  it("says the weekday, the date and the time where the person is, with the zone", () => {
    expect(todayLine("Europe/Zurich", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 23:30 (Europe/Zurich)",
    );
    // At 7d6b34a the facts had only "now: 2026-11-09T22:30:00.000Z": in UTC it was still 22:30,
    // and "yesterday" or "on Monday" were the UTC's days.
    expect(todayLine("Pacific/Auckland", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Tuesday 10 November 2026, 11:30 (Pacific/Auckland)",
    );
  });

  it("follows the clock change in the week of 26 October (summer time ends on the 25th)", () => {
    // 00:30 summer time (UTC+2) on Sunday 25 October, then 23:30 winter time (UTC+1) that night.
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-24T22:30:00Z"))).toBe(
      "Sunday 25 October 2026, 00:30 (Europe/Zurich)",
    );
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-25T22:30:00Z"))).toBe(
      "Sunday 25 October 2026, 23:30 (Europe/Zurich)",
    );
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-26T10:00:00Z"))).toBe(
      "Monday 26 October 2026, 11:00 (Europe/Zurich)",
    );
  });

  it("a zone the platform does not know is read as UTC and says so", () => {
    expect(todayLine("Mars/Olympus", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 22:30 (UTC)",
    );
    expect(todayLine("", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 22:30 (UTC)",
    );
  });
});

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
