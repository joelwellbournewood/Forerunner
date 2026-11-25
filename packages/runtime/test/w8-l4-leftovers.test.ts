import { describe, expect, it } from "vitest";
import { requestWords } from "../src/daemon/request-words.ts";
import { PLAN_APPROVAL_OPTIONS, planAnswer, planKeyOf } from "../src/session/plan-approval.ts";

/**
 * w8-l4-leftovers, wave 8: run L4's leftovers on starts, sessions and money (the words GET /inbox
 * shows are `requestWords` of the stored card).
 */
describe("w8-l4-leftovers, wave 8: the session plan card's buttons (L4i-left-27)", () => {
  // L4b-left-6 (design section 3.4): the "Assisted mode: approve this session plan before work
  // starts." card offered "approve" and "reject" in lower case with no line of what each does.
  const row = {
    kind: "approval" as const,
    why: "Assisted mode: approve this session plan before work starts.",
    steps: [],
    options: [...PLAN_APPROVAL_OPTIONS],
    change_card: { key: planKeyOf("s1"), plan_id: `${planKeyOf("s1")}#${"0".repeat(64)}` },
    status: "open" as const,
    answer: null,
  };

  it("says Approve and Reject, each with one line of what it does; the stored answers stay", () => {
    const words = requestWords(row as never);
    expect(words.choices.map((c) => [c.label, c.explain, c.tone])).toEqual([
      ["Approve", "Starts the session with these tasks, in this order.", "primary"],
      [
        "Reject",
        "Nothing runs; the tasks stay ready and your next session asks again.",
        "secondary",
      ],
    ]);
    // A click sends the label; the plan's sync reads it as the stored option.
    expect(words.choices.map((c) => planAnswer(c.label))).toEqual(["approve", "reject"]);
    expect([...PLAN_APPROVAL_OPTIONS]).toEqual(["approve", "reject"]);
    for (const c of words.choices) expect((c.explain ?? "").length).toBeLessThanOrEqual(100);
  });
});
