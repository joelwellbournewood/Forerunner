import { formatChf, usdToChfMicro } from "@forerunner/billing";
import { describe, expect, it } from "vitest";
import { TOOK_LARGER_EVENT } from "../src/daemon/event-audience.ts";
import {
  type ChfAmount,
  comesAfterSentence,
  leftOutSentence,
  oversizedAsk,
  oversizedPlanClause,
  oversizedPlanNote,
  oversizedSentence,
  takenLine,
  waitsForNextSessionSentence,
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
    // d1109-oversize-pause (OP-0, the owner's answer 5): the tasks before it by name.
    expect(
      oversizedSentence({
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
        room: chf(3.5),
        before: ["A"],
      }),
    ).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget of CHF 4.00: after "A" it works with about CHF 2.80, keeps its work, and asks you to continue.',
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

  it("why a task waits for the next session: no room, after the larger task, after the others", () => {
    expect(
      leftOutSentence("no_room", {
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
      }),
    ).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget: the tasks before it leave too little to start it, so it waits for the next session.',
    );
    // d1109-oversize-pause (OP-0): a second larger task comes after the first ("after_large").
    expect(
      leftOutSentence("after_large", {
        title: "Big two",
        estimate: chf(11.25),
        workBudget: chf(5),
        after: "Build the shop",
      }),
    ).toBe(
      '"Big two" comes after it: it runs if "Build the shop" leaves budget, else in your next session.',
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

  it("the plan line under Details names the larger task the session takes (lineOf)", () => {
    const oversized = {
      taskId: "01a1c1bf-1f1f-77e0-8355-08cb744f3be9",
      title: "Build the shop",
      estimateUsdMicro: 8_000_000,
    };
    expect(
      describeEvent(
        "session.planned",
        { items: 0, estimateUsdMicro: 0, summary: "1 ready task in priority order", oversized },
        RATE,
      ),
    ).toBe(
      'Plan: "Build the shop" (about CHF 6.40), larger than this session\'s work budget: it works until that budget is used. 1 ready task in priority order.',
    );
    expect(
      describeEvent(
        "session.planned",
        { items: 2, estimateUsdMicro: 500_000, summary: "", oversized },
        RATE,
      ),
    ).toBe(
      'Plan: 2 tasks, about CHF 0.40, then "Build the shop" (about CHF 6.40), larger than this session\'s work budget, with what is left.',
    );
    // Without one, the line of before.
    expect(describeEvent("session.planned", { items: 1, estimateUsdMicro: 500_000 }, RATE)).toBe(
      "Plan: 1 task, about CHF 0.40.",
    );
  });
});

/**
 * d1109-oversize-pause (OP-0; the owner's answer 5 of 2026-11-09: "As i said, it should work on
 * tasks even when it cannot complete them, and be able to wrap up and continue next time"): the
 * larger task runs in its turn in the plan's order, so the sentences name the tasks before it and
 * the ones after it; "after the other tasks", "after the work that fits" and "one task that large
 * runs a session" are gone.
 */
describe("d1109-oversize-pause, run C: the order sentences (OP-0)", () => {
  it("the warning names the tasks before it, up to three, then 'and N more'", () => {
    const facts = (before: string[]) =>
      oversizedSentence({
        title: "Build the shop",
        estimate: chf(7.5),
        workBudget: chf(5),
        room: chf(3.5),
        before,
      });
    expect(facts(["A", "B"])).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget of CHF 4.00: after "A" and "B" it works with about CHF 2.80, keeps its work, and asks you to continue.',
    );
    expect(facts(["A", "B", "C", "D", "E"])).toBe(
      '"Build the shop" needs about CHF 6.00, more than this session\'s work budget of CHF 4.00: after "A", "B", "C" and 2 more it works with about CHF 2.80, keeps its work, and asks you to continue.',
    );
    // First in order: the sentence of before, unchanged.
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
  });

  it("the tasks after it, before the run and in the result, in two forms that stay true", () => {
    expect(comesAfterSentence(["B"], "Build the shop")).toBe(
      '"B" comes after it: it runs if "Build the shop" leaves budget, else in your next session.',
    );
    expect(comesAfterSentence(["B", "C"], "Build the shop")).toBe(
      '"B" and 1 more come after it: they run if "Build the shop" leaves budget, else in your next session.',
    );
    expect(comesAfterSentence([], "Build the shop")).toBeNull();
    expect(waitsForNextSessionSentence(["B"], "Build the shop")).toBe(
      '"B" waits for your next session: "Build the shop" used the rest of this one.',
    );
    expect(waitsForNextSessionSentence(["B", "C"], "Build the shop")).toBe(
      '"B" and 1 more wait for your next session: "Build the shop" used the rest of this one.',
    );
  });

  it("the plan clause: first in order it names what runs after it only if budget is left", () => {
    expect(oversizedPlanClause("Build the shop", true, ["B"])).toBe(
      'This session works on "Build the shop" until its work budget is used; "B" runs after it only if budget is left.',
    );
    expect(oversizedPlanClause("Build the shop", true, ["B", "C"])).toBe(
      'This session works on "Build the shop" until its work budget is used; "B" and 1 more run after it only if budget is left.',
    );
    expect(oversizedPlanClause("Build the shop", true)).toBe(
      'This session works on "Build the shop" until its work budget is used.',
    );
    expect(oversizedPlanClause("Build the shop", false, ["B"])).toBe(
      'then works on "Build the shop" with what is left',
    );
  });

  it("no sentence says the order of before", () => {
    const all = [
      oversizedSentence({
        title: "X",
        estimate: chf(7.5),
        workBudget: chf(5),
        room: chf(1),
        before: ["A"],
      }),
      leftOutSentence("after_large", {
        title: "B",
        estimate: chf(1),
        workBudget: chf(5),
        after: "X",
      }),
      leftOutSentence("no_room", { title: "B", estimate: chf(9), workBudget: chf(5) }),
      oversizedPlanClause("X", true, ["B"]),
      comesAfterSentence(["B"], "X") ?? "",
      waitsForNextSessionSentence(["B"], "X"),
    ].join(" ");
    expect(all).not.toMatch(/after the other tasks|after the work that fits|one task that large/);
  });
});

describe("l4-money-pause, run L4: the tasks after a larger one say what it left (L4-money-102)", () => {
  const amount = (chfMicro: number) => ({ chfMicro, text: formatChf(chfMicro) });
  it("what it left of the work budget and the one task's estimate; 'used the rest' only under a centime", () => {
    expect(
      waitsForNextSessionSentence(["Write a tagline in tagline.md"], "Compare three hosts", {
        left: amount(30_000),
        estimate: amount(60_000),
      }),
    ).toBe(
      '"Write a tagline in tagline.md" (about CHF 0.06) waits for your next session: "Compare three hosts" left CHF 0.03 of this one.',
    );
    expect(
      waitsForNextSessionSentence(["B", "C"], "Build the shop", {
        left: amount(80_000),
        estimate: amount(60_000),
      }),
    ).toBe(
      '"B" and 1 more wait for your next session: "Build the shop" left CHF 0.08 of this one.',
    );
    expect(
      waitsForNextSessionSentence(["B"], "Build the shop", {
        left: amount(4_000),
        estimate: amount(60_000),
      }),
    ).toBe('"B" waits for your next session: "Build the shop" used the rest of this one.');
  });
});
