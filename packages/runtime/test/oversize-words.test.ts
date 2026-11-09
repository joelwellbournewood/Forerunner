import { formatChf, usdToChfMicro } from "@forerunner/billing";
import { describe, expect, it } from "vitest";
import { TOOK_LARGER_EVENT } from "../src/daemon/event-audience.ts";
import {
  type ChfAmount,
  leftOutSentence,
  oversizedAsk,
  oversizedPlanClause,
  oversizedPlanNote,
  oversizedSentence,
  takenLine,
} from "../src/daemon/oversize-words.ts";
import { describeEvent, eventView } from "../src/daemon/views.ts";

/**
 * d1109-oversize-start (OS-3, the owner's D4 of 2026-11-09: "it should get a warning, but it
 * should get done anyway"): every sentence about a task larger than one session, one place, in
 * CHF at the day's rate (0.80 here), "about" for estimates, titles in quotes, no ids (design §5).
 */
const RATE = 0.8;
/** A USD amount as the sentences get it: in CHF at the rate, with its text. */
const chf = (usd: number): ChfAmount => {
  const chfMicro = usdToChfMicro(Math.round(usd * 1_000_000), RATE);
  return { chfMicro, text: formatChf(chfMicro) };
};

describe("d1109-oversize-start, run C: the sentences about a task larger than one session (OS-3)", () => {
  it("the Start check's warning: alone, after other tasks, with kept work", () => {
    // USD 7.50 is CHF 6.00, USD 5.00 CHF 4.00, USD 3.50 CHF 2.80.
    expect(
      oversizedSentence({
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
        room: null,
      }),
    ).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget of CHF 4.00: it works until that budget is used, keeps its work, and asks you to continue.',
    );
    expect(
      oversizedSentence({
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
        room: chf(3.5),
      }),
    ).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget of CHF 4.00: after the other tasks it works with about CHF 2.80, keeps its work, and asks you to continue.',
    );
    // A task that resumes from kept work names what is left and what it spent so far.
    expect(
      oversizedSentence({
        title: "Build the shop",
        estimate: chf(2.5),
        workBudget: chf(2),
        room: null,
        spent: chf(5),
      }),
    ).toBe(
      '"Build the shop" needs about CHF 2.00 more (CHF 4.00 spent so far), more than this session\'s work budget of CHF 1.60: it works until that budget is used, keeps its work, and asks you to continue.',
    );
  });

  it("why a task waits for the next session: no room, a second larger task, after the others", () => {
    expect(
      leftOutSentence("no_room", {
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
      }),
    ).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget: the tasks before it leave too little to start it, so it waits for the next session.',
    );
    expect(
      leftOutSentence("one_large", { title: "Big two", estimate: chf(11.25), workBudget: chf(5) }),
    ).toBe(
      '"Big two" needs about CHF 9.00, more than this session\'s work budget: one task that large runs a session, so it waits for the next one.',
    );
    expect(
      leftOutSentence("after_others", {
        title: "About page",
        estimate: chf(3),
        workBudget: chf(5),
        ahead: chf(3),
      }),
    ).toBe(
      '"About page" (about CHF 2.40) may be left for next time: the tasks that run first take about CHF 2.40 of this session\'s work budget of CHF 4.00 (the budget less a fifth kept for reviews). Give the session a larger budget to be sure it runs.',
    );
  });

  it("the plan card's note, the dialog's plan clause, the chat's warning and the log's line", () => {
    const note = oversizedPlanNote(chf(5));
    expect(note).toBe(
      "More than a session's work budget (CHF 4.00): it pauses with its work kept and asks you to continue.",
    );
    // Design §5 rule 1: a consequence line within 100 characters, for any work budget under
    // CHF 10 (the default session budget of CHF 5.00 has one of CHF 4.00).
    expect(note.length).toBeLessThanOrEqual(100);
    expect(oversizedPlanNote(chf(12.49)).length).toBeLessThanOrEqual(100);
    expect(oversizedPlanClause("Build the shop", true)).toBe(
      'This session works on "Build the shop" until its work budget is used.',
    );
    expect(oversizedPlanClause("Build the shop", false)).toBe(
      'then works on "Build the shop" with what is left',
    );
    expect(oversizedAsk("Build the shop", chf(5))).toBe(
      '"Build the shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to continue.',
    );
    expect(takenLine("Build the shop", chf(3.5))).toBe(
      'Took "Build the shop", larger than this session\'s work budget, with about CHF 2.80 left.',
    );
    // An amount under a centime is never "about CHF 0.00" (W15-74).
    expect(takenLine("Build the shop", chf(0.004))).toBe(
      'Took "Build the shop", larger than this session\'s work budget, with less than CHF 0.01 left.',
    );
  });

  it("the session log says the take once, as a line the person reads by default (OS-7)", () => {
    const payload = {
      taskId: "01a1c1bf-1f1f-77e0-8355-08cb744f3be9",
      title: "Build the shop",
      estimateUsdMicro: 7_500_000,
      roomUsdMicro: 1_600_000,
      workBudgetUsdMicro: 1_600_000,
    };
    expect(describeEvent(TOOK_LARGER_EVENT, payload, RATE)).toBe(
      'Took "Build the shop", larger than this session\'s work budget, with about CHF 1.28 left.',
    );
    const view = eventView(
      {
        id: "e1",
        session_id: "s1",
        seq: 3,
        type: TOOK_LARGER_EVENT,
        payload,
        cost_usd_micro: 0,
        created_at: "2026-11-09T10:00:00.000Z",
      } as never,
      RATE,
    );
    expect(view.audience).toBe("person");
    expect(view.text).not.toMatch(/01a1c1bf|USD|\$/);
  });
});
