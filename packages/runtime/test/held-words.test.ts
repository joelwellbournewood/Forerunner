import { describe, expect, it } from "vitest";
import { heldBlocker, heldDependency, outerLimitHold } from "../src/daemon/held-words.ts";
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
      // fixup-l4-starts-carried: the limit alone and what changes it, for the waiting list.
      limit: "paused at this month's cap of CHF 5.00",
      raise: "Raise the monthly cap in Settings",
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
          ...(share as NonNullable<typeof share>),
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
      holds: "answer",
    });
  });

  // fixup-l4-starts-carried (the review's blocking 2): the Start dialog's waiting list said
  // "which needs your answer ... Answer it in the Inbox" for every dependency that waits on the
  // person; it now says what holds each, as the blocker does.
  it("fixup: the waiting list's words for a dependency held by a limit, by your pause, by a pause, or by a card that asks", () => {
    const project = outerLimitHold(
      card({
        source: "project",
        title: '"Write the club motto" paused at the project\'s budget of CHF 0.06',
      }),
      resetDay,
    );
    if (!project) throw new Error("no hold");
    expect(heldDependency({ title: "Write the club motto", why: "limit", ...project })).toEqual({
      why: "limit",
      state: "paused at the project's budget of CHF 0.06",
      advice:
        "Raise the project's budget in Settings, or change what it waits for on the Tasks tab.",
    });
    expect(heldDependency({ title: "Write the song", why: "paused" })).toEqual({
      why: "paused",
      state: "which you paused",
      advice: 'Resume "Write the song", or change what it waits for on the Tasks tab.',
    });
    expect(heldDependency({ title: "Draw the flag", why: "paused", byYou: false }).state).toBe(
      "which is paused",
    );
    expect(heldDependency({ title: "A", why: "answer" })).toEqual({
      why: "answer",
      state: "which needs your answer",
      advice: "Answer it in the Inbox, or change what it waits for on the Tasks tab.",
    });
    // The bench's walk: a task whose work is done and whose review waits for room in the
    // project's budget ('"A" is done; its review waits ...') reads after a comma with "which".
    const review = outerLimitHold(
      card({
        source: "project",
        title: '"Write the club motto" is done; its review waits for room in the project\'s budget',
      }),
      resetDay,
    );
    if (!review) throw new Error("no hold");
    const held = { title: "Write the club motto", why: "limit" as const, ...review };
    expect(heldDependency(held).state).toBe(
      "which is done; its review waits for room in the project's budget",
    );
    expect(heldBlocker(held, "Write the club rules", "/t")?.sentence).toBe(
      'Nothing can run: "Write the club rules" waits on "Write the club motto", which is done; its review waits for room in the project\'s budget; raise it in Settings.',
    );
    expect(heldBlocker(held, null, "/t")?.sentence).toBe(
      'Nothing can run: "Write the club motto" is done; its review waits for room in the project\'s budget; raise it in Settings.',
    );
    // The blocker of a task that waits on a pause no card asks about and not the person's.
    expect(
      heldBlocker({ title: "Draw the flag", why: "paused", byYou: false }, "Wave the flag", "/t"),
    ).toEqual({
      kind: "nothing_runnable",
      sentence: 'Nothing can run: "Wave the flag" waits on "Draw the flag", which is paused.',
      action: { kind: "link", label: "Open Tasks", to: "/t" },
      holds: "paused",
    });
  });
});
