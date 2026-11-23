import type { ProjectRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { lastSessionBlock } from "../src/conversation/project-facts.ts";
import {
  FIX_NEEDS_CLAUDE,
  FIX_NO_PROJECT,
  fixAsk,
  fixBusyReply,
  fixChangedReply,
  fixCheckingStep,
  fixCostFooter,
  fixFailedReply,
  fixHeldReply,
  fixLeftOut,
  fixNoChangeReply,
  fixNoRoomReply,
  fixUnreadableReply,
  fixWhichProject,
} from "../src/conversation/sentences.ts";
import { proposalOutcome } from "../src/daemon/task-proposal-words.ts";

/**
 * l4-chat-carried, run L4 (SC-10, a test run C left): every sentence "fix the tasks" says in chat,
 * word for word (design section 5: one sentence, names in quotes, CHF only, no ids, no raw
 * states), so a rewording is a decision this file shows. The composed and real-daemon cases
 * assert where each appears; this file asserts what each says.
 */
describe("l4-chat-carried, run L4: the chat fix sentences, word for word (SC-10)", () => {
  it("each reply, step and footer of 'fix the tasks'", () => {
    expect(FIX_NEEDS_CLAUDE).toBe("Fixing the tasks needs Claude: connect it in Settings, Basics.");
    expect(FIX_NO_PROJECT).toBe("There is no project whose tasks I could fix yet.");
    expect(fixCheckingStep("Quote page")).toBe("Checking the tasks of Quote page…");
    expect(fixBusyReply("Quote page")).toBe(
      "The agent is checking the tasks of Quote page now; ask again in a moment.",
    );
    expect(fixNoRoomReply("project")).toBe(
      "Fixing the tasks would pass this project's budget; nothing changed.",
    );
    expect(fixNoRoomReply("month")).toBe(
      "Fixing the tasks would pass your monthly cap; nothing changed.",
    );
    expect(fixNoRoomReply("plan")).toBe(
      "Fixing the tasks would pass the share of your subscription Forerunner may use; nothing changed.",
    );
    expect(fixHeldReply("your Claude subscription is at its limit until 15:40")).toBe(
      "Fixing the tasks waits for Claude: your Claude subscription is at its limit until 15:40. Nothing changed.",
    );
    expect(fixChangedReply(1, "Quote page")).toBe("I changed 1 task of Quote page.");
    expect(fixChangedReply(3, "Quote page")).toBe("I changed 3 tasks of Quote page.");
    expect(fixNoChangeReply("Quote page")).toBe(
      "The tasks of Quote page look right; nothing changed.",
    );
    expect(fixFailedReply("Quote page")).toBe(
      "Checking the tasks of Quote page did not work: Claude did not answer. Nothing changed.",
    );
    expect(fixUnreadableReply("Quote page")).toBe(
      "The agent's answer about the tasks of Quote page could not be read; nothing changed.",
    );
    expect(fixCostFooter("CHF 0.03")).toBe("Checking the tasks cost CHF 0.03.");
  });

  it("the project question and the read-back of one change and of several", () => {
    expect(fixWhichProject(["Notes"])).toBe("Which project: Notes?");
    expect(fixWhichProject(["Notes", "Site"])).toBe("Which project: Notes or Site?");
    expect(fixWhichProject(["A", "B", "C", "D"])).toBe(
      "Which project: A, B or C (or another of your 4)?",
    );
    expect(fixAsk("Quote page", ['Split "Style the page" into "A" and "B".'])).toBe(
      'Split "Style the page" into "A" and "B"?',
    );
    expect(
      fixAsk("Quote page", ['Split "Style the page" into "A" and "B".', 'Add "Check the links".']),
    ).toBe(
      'Make these 2 changes to the tasks of Quote page? Split "Style the page" into "A" and "B"; add "Check the links".',
    );
    expect(fixLeftOut([])).toBe("");
    expect(
      fixLeftOut([
        { what: 'split "X".', reason: "it is running, so it is not split." },
        { what: 'add "Y"', reason: "it is there already" },
      ]),
    ).toBe('Left out (and 1 more): split "X": it is running, so it is not split.');
  });

  it("the suggestion card's Done lines (C4-left-5)", () => {
    const split = { calls: [{ name: "task.split", params: { task: "t1" } }] };
    expect(
      proposalOutcome({ outcome: "applied", changed: 1, running: false, changes: [split] }),
    ).toBe("Changed 1 task; your next Start runs it.");
    expect(
      proposalOutcome({ outcome: "applied", changed: 1, running: true, changes: [split] }),
    ).toBe("Changed 1 task; the session takes it if it fits.");
    expect(proposalOutcome({ outcome: "applying" })).toBe("Making the changes…");
    expect(proposalOutcome({ outcome: "kept" })).toBe(
      "Kept the tasks as they are; nothing changed.",
    );
  });
});

/**
 * l4-chat-carried, run L4 (L4c-left-5, L4-money-111's sibling): the chat's `# Last session` block,
 * which the model reads, said 'Paused: "X" at its budget of CHF 0.40' for a task whose work is
 * done and only its review waits for room; the Result line and the card say it is done.
 */
describe("l4-chat-carried, run L4: the chat's last-session block for a review that waits (L4c-left-5)", () => {
  const project = (paused: Record<string, unknown>[]) =>
    ({
      summary_cache: {
        last_session: {
          summary:
            '"Write the guide" is done; its review waits for room in its budget of CHF 0.40.',
          outcome: { done: [], paused },
        },
      },
    }) as unknown as ProjectRow;

  it("a review that waits reads as done with its review waiting, never as paused at its budget", () => {
    const block = lastSessionBlock(
      project([
        { id: "t1", title: "Write the guide", limit: "its budget of CHF 0.40", reviewWaits: true },
      ]),
    );
    expect(block.split("\n")).toContain(
      'Review waits: "Write the guide" is done; its review waits for room in its budget of CHF 0.40',
    );
    expect(block).not.toContain('Paused: "Write the guide"');
  });

  it("a pause at a budget and one before it ran out keep their lines", () => {
    const block = lastSessionBlock(
      project([
        { id: "t1", title: "Write the guide", limit: "its budget of CHF 0.40" },
        { id: "t2", title: "Write the notes", limit: "its budget of CHF 0.10", before: true },
      ]),
    );
    expect(block.split("\n")).toEqual(
      expect.arrayContaining([
        'Paused: "Write the guide" at its budget of CHF 0.40',
        'Paused: "Write the notes" before its budget of CHF 0.10 ran out',
      ]),
    );
  });
});
