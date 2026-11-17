import { describe, expect, it } from "vitest";
import { agentChangeLine } from "../src/daemon/task-words.ts";

/**
 * d1109-selftasks-chat, run C (SC-8; ADR 0119; the owner, D7: "every change shown"): the task
 * drawer's line for a change the project's agent made, from the reason the commands store for it
 * (task.ts, SC-12). Every form task.ts writes for the agent reads as one plain sentence; every
 * other reason (the person's own, the plan's, the runner's, a note) gives no line.
 */
describe("d1109-selftasks-chat, run C: agentChangeLine (SC-8)", () => {
  it("each reason the commands store for the agent reads as one sentence, with no id", () => {
    const said: Array<[string, string]> = [
      [
        "Added by the agent: the coder said nothing checks the links",
        "Added by the agent: the coder said nothing checks the links.",
      ],
      ["Added by the agent", "Added by the agent."],
      ["Changed by the agent: priority to High", "Changed by the agent: priority to High."],
      ["What it waits for changed by the agent", "What it waits for changed by the agent."],
      ['Split from "Style the page" by the agent', 'Split from "Style the page" by the agent.'],
      [
        'Split into "Style the page: layout" and "Style the page: colours" by the agent',
        'Split into "Style the page: layout" and "Style the page: colours" by the agent.',
      ],
      [
        'Dropped by the agent: same as "Add the README"',
        'Dropped by the agent: same as "Add the README".',
      ],
      ["Paused by the agent", "Paused by the agent."],
      ["Stopped by the agent", "Stopped by the agent."],
      ["Cancelled by the agent", "Cancelled by the agent."],
      ["Made ready by the agent", "Made ready by the agent."],
      ["Made ready again by the agent", "Made ready again by the agent."],
      ["Marked a draft by the agent", "Marked a draft by the agent."],
      // The bench's stand-in marks its words; the view leaves the mark out.
      [
        "Added by the agent: [stand-in model] Nothing checks that the links work",
        "Added by the agent: Nothing checks that the links work.",
      ],
    ];
    for (const [reason, line] of said) expect(agentChangeLine(reason), reason).toBe(line);
  });

  it("the person's own moves, the plan's, the runner's and a note give no line", () => {
    for (const reason of [
      "Added by you",
      "Changed by you: priority to High",
      "What it waits for changed by you",
      "Paused by you",
      'Split from "Style the page" by you',
      "From the plan",
      "planned",
      "retry ladder exhausted after 4 failed attempt(s)",
      "Wait for the logo: the agent said so",
      "",
    ])
      expect(agentChangeLine(reason), reason).toBeNull();
  });

  it("a long why is cut at a word, still one sentence", () => {
    const line = agentChangeLine(`Added by the agent: ${"the links on every page ".repeat(20)}`);
    expect(line?.length).toBeLessThanOrEqual(201);
    expect(line).toMatch(/^Added by the agent: the links on every page .*…$/);
  });
});
