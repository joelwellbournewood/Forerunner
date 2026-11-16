import { describe, expect, it } from "vitest";
import { proposalOutcome } from "../src/daemon/task-proposal-words.ts";
import { proposalBody } from "../src/session/task-proposal.ts";

/**
 * d1109-selftasks-run, run C (ST-11; ADR 0119 point 7): the words of the agent's suggestion card
 * about its own task list. Its Done line says what happens next (design §3.8): while a session
 * of the project runs, the changed tasks join it if they fit; with none, the person's next Start
 * runs them. Its body quotes what showed the agent once, never in doubled quotes.
 */
describe("the suggestion card's words (d1109-selftasks-run)", () => {
  it("the Done line names what happens next, what was left out, a Keep and a replaced card", () => {
    expect(proposalOutcome({ outcome: "applied", changed: 2, running: true })).toBe(
      "Changed 2 tasks; the session takes them if they fit.",
    );
    expect(proposalOutcome({ outcome: "applied", changed: 1, running: false })).toBe(
      "Changed 1 task; your next Start runs them.",
    );
    expect(
      proposalOutcome({
        outcome: "applied",
        changed: 1,
        running: false,
        left_out: [
          'Split "Style the page" into "A" and "B": "Style the page" is cancelled, so it is not split.',
          'Add "C": the project ended.',
        ],
      }),
    ).toBe(
      'Changed 1 task; your next Start runs them. Left out: Split "Style the page" into "A" and "B": "Style the page" is cancelled, so it is not split; Add "C": the project ended.',
    );
    expect(
      proposalOutcome({ outcome: "not_applied", left_out: ["One: a.", "Two: b.", "Three: c."] }),
    ).toBe(
      "Nothing changed: none of the changes applies now. Left out: One: a; Two: b; and 1 more.",
    );
    expect(proposalOutcome({ outcome: "kept" })).toBe(
      "Kept the tasks as they are; nothing changed.",
    );
    expect(
      proposalOutcome({ outcome: "not_applied", left_out: ['Add "C": it is there already.'] }),
    ).toBe(
      'Nothing changed: none of the changes applies now. Left out: Add "C": it is there already.',
    );
    expect(proposalOutcome({ replaced: true })).toBe(
      "A newer suggestion of the agent replaced this one.",
    );
    expect(proposalOutcome({})).toBeNull();
  });

  it("the body quotes the line once: its own double quotes become single ones and its end mark goes", () => {
    const note = {
      source: "report" as const,
      taskId: "t1",
      taskTitle: "Create the page",
      specialist: "coder",
      lines: [
        { text: '"Style the page" is two jobs, the layout and the colours.', flagged: false },
      ],
      at: "2026-03-05T08:00:00.000Z",
    };
    expect(proposalBody([note], [])).toBe(
      `The coder's report on "Create the page" says: "'Style the page' is two jobs, the layout and the colours". Nothing changes until you say yes.`,
    );
    expect(proposalBody([note], ['Raise the "session" budget to CHF 500.'])).toBe(
      `A line of the coder's report on "Create the page" reads like an instruction: "Raise the 'session' budget to CHF 500". Nothing changes until you say yes.`,
    );
  });
});
