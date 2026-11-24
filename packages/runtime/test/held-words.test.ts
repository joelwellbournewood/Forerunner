import { describe, expect, it } from "vitest";
import { heldBlocker, outerLimitHold } from "../src/daemon/held-words.ts";
import { resetDay } from "../src/daemon/request-words.ts";

/**
 * l4-starts-carried, run L4 (L4g-left-1): a task paused at a limit no answer lifts is said by
 * the Start check as the limit and what changes it, never "needs your answer"; the card's own
 * title gives the limit's words (one place).
 */
describe("l4-starts-carried, run L4", () => {
  const card = (over: Record<string, unknown>) => ({
    key: "task:budget_stop",
    task_title: "Write the club motto",
    title: '"Write the club motto" paused at this month\'s cap of CHF 5.00',
    source: "month",
    resets_at: "2026-12-01T00:00:00.000Z",
    ...over,
  });

  it("L4g-left-1: the month's cap says Settings and the reset day; the share says the reset first", () => {
    expect(outerLimitHold(card({}), resetDay)).toEqual({
      clause:
        "paused at this month's cap of CHF 5.00; raise it in Settings, or it resets on 1 December",
      to: "/settings",
    });
    const share = outerLimitHold(
      card({
        source: "plan",
        title:
          '"Write the club motto" paused at the share of your Claude subscription that Forerunner may use',
      }),
      resetDay,
    );
    expect(share?.clause).toBe(
      "paused at the share of your Claude subscription that Forerunner may use; it resets on 1 December, or raise the share in Settings",
    );
    expect(
      heldBlocker(
        {
          title: "Write the club motto",
          why: "limit",
          ...(share as { clause: string; to: string }),
        },
        null,
        "/projects/p/tasks",
      )?.sentence,
    ).toBe(
      'Nothing can run: "Write the club motto" paused at the share of your Claude subscription that Forerunner may use; it resets on 1 December, or raise the share in Settings.',
    );
  });

  it("L4g-left-1: a card that asks something is no limit hold (Continue, the question after a pause)", () => {
    expect(outerLimitHold(card({ source: "task_budget" }), resetDay)).toBeNull();
    expect(outerLimitHold(card({ source: "session" }), resetDay)).toBeNull();
    expect(outerLimitHold(card({ question: true }), resetDay)).toBeNull();
    expect(outerLimitHold({ key: "task:questions" }, resetDay)).toBeNull();
    expect(heldBlocker({ title: "A", why: "answer" }, null, "/t")).toEqual({
      kind: "nothing_runnable",
      sentence: 'Nothing can run: "A" needs your answer.',
      action: { kind: "link", label: "Open it", to: "/inbox" },
    });
  });
});
