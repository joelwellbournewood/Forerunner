import { describe, expect, it } from "vitest";
import {
  buildPlanCard,
  type CardContext,
  chfPerUsdFrom,
  chfShort,
  DEFAULT_CHF_PER_USD,
  inversePlan,
  renderCard,
} from "../src/mobile/change-card.ts";
import { NOW_MS } from "./mobile-helpers.tsx";

const ctx: CardContext = {
  timezone: "Europe/Zurich",
  now: NOW_MS,
  activeProjectId: "proj_pharma",
  projects: [
    { id: "proj_pharma", name: "PharmaWatch", budgetChfMicro: 50_000_000 },
    { id: "proj_game", name: "Space game", budgetChfMicro: 40_000_000 },
  ],
  monthlyCeilingChfMicro: 150_000_000,
};

const SCENARIO = [
  { name: "project.switch", params: { project: "proj_game" } },
  {
    name: "budget.set",
    params: {
      scope: "session",
      amountChf: 15,
      project: "proj_game",
      until: "2026-10-21T04:00:00.000Z",
    },
  },
  { name: "session.start", params: { project: "proj_game", runner: "pc" } },
];

describe("buildPlanCard", () => {
  it("makes ONE card for the scenario-9 plan with three parts, medium risk, undo", () => {
    const card = buildPlanCard(SCENARIO, ctx);
    expect(card.command).toBe("compose");
    expect(card.parts).toHaveLength(3);
    expect(card.impact.risk).toBe("medium");
    expect(card.scope).toBe("global");
    expect(card.reversible).toBe(true);
    expect(card.projectId).toBe("proj_game");
    expect(card.projectName).toBe("Space game");
    expect(card.duration).toBe("until 06:00");
    expect(card.expiresAt).toBe("2026-10-21T04:00:00.000Z");
    const [sw, budget, start] = card.parts ?? [];
    expect(sw).toMatchObject({
      what: "the active project",
      oldValue: "PharmaWatch",
      newValue: "Space game",
      impact: { risk: "low" },
    });
    // The budget step applies to the project the first step switched to.
    expect(budget).toMatchObject({
      what: "tonight's session budget for Space game",
      newValue: "CHF 15",
      duration: "until 06:00",
      impact: { risk: "medium" },
      projectId: "proj_game",
    });
    expect(start).toMatchObject({
      what: "a session on Space game on your PC",
      oldValue: "no session",
      impact: { risk: "low" },
    });
    const text = renderCard(card);
    expect(text).toMatch(/^Plan of 3 changes:/);
    expect(text).toContain("Risk: medium.");
    expect(text).toContain("Undo: Tap Undo in the change log.");
  });

  it("marks a monthly cap raise and anything above the ceiling high", () => {
    const month = buildPlanCard(
      [{ name: "budget.set", params: { scope: "month", amountChf: 250 } }],
      ctx,
    );
    expect(month.impact.risk).toBe("high");
    expect(month.oldValue).toBe("CHF 150");
    const over = buildPlanCard(
      [{ name: "budget.set", params: { scope: "session", amountChf: 200 } }],
      ctx,
    );
    expect(over.impact.risk).toBe("high");
    const lower = buildPlanCard(
      [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      ctx,
    );
    expect(lower.impact.risk).toBe("medium");
  });

  it("with an unknown ceiling it says so and treats a monthly change as a raise; the rate comes from the service", () => {
    const unknown: CardContext = { ...ctx, monthlyCeilingChfMicro: null, chfPerUsd: 0.9 };
    const month = buildPlanCard(
      [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      unknown,
    );
    expect(month.oldValue).toBe("the current cap");
    expect(month.impact.risk).toBe("high");
    expect(month.impact.costChfMicro).toBeUndefined();
    expect(month.sentence).toBe("Raised the monthly cap from the current cap to CHF 100. Undo.");
    // Without a known ceiling a session budget is never called "above the ceiling".
    const session = buildPlanCard(
      [{ name: "budget.set", params: { scope: "session", amountChf: 200 } }],
      unknown,
    );
    expect(session.impact.risk).toBe("medium");
    // The undo of a monthly change restores by the PC's log when the phone has no number.
    const plan = [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }];
    expect(inversePlan(plan, month, unknown)).toEqual([
      { name: "budget.set", params: { scope: "month", restore: true } },
    ]);
    expect(inversePlan(plan, buildPlanCard(plan, ctx), ctx)).toEqual([
      { name: "budget.set", params: { scope: "month", restore: true, amountChf: 150 } },
    ]);
    // USD amounts convert at the service's rate, and at the default only when none is known.
    const usd = [{ name: "budget.set", params: { scope: "project", amountUsdMicro: 10_000_000 } }];
    expect(buildPlanCard(usd, unknown).newValue).toBe("CHF 9");
    expect(buildPlanCard(usd, { ...ctx, chfPerUsd: null }).newValue).toBe(
      chfShort(Math.round(10_000_000 * DEFAULT_CHF_PER_USD)),
    );
    expect(chfPerUsdFrom([{ usdMicro: 0, chfMicro: 0 }])).toBeNull();
    expect(
      chfPerUsdFrom([
        { usdMicro: 0, chfMicro: 0 },
        { usdMicro: 50, chfMicro: 45 },
      ]),
    ).toBe(0.9);
  });

  it("says when a command applies to the active project and formats CHF", () => {
    const card = buildPlanCard(
      [{ name: "budget.set", params: { scope: "project", amountChf: 60 } }],
      ctx,
    );
    expect(card.usesActiveProject).toBe(true);
    expect(card.oldValue).toBe("CHF 50");
    expect(card.impact.costChfMicro).toBe(10_000_000);
    expect(renderCard(card)).toContain("(PharmaWatch, the active project)");
    expect(chfShort(12_500_000)).toBe("CHF 12.50");
    expect(chfShort(5_000_000)).toBe("CHF 5");
    const stop = buildPlanCard([{ name: "session.stop", params: { scope: "all" } }], ctx);
    expect(stop.reversible).toBe(false);
    expect(stop.scope).toBe("global");
    expect(() => buildPlanCard([], ctx)).toThrow(/at least one/);
  });
});

describe("inversePlan", () => {
  it("reverses the scenario: stop the session, restore the budget, switch back", () => {
    const card = buildPlanCard(SCENARIO, ctx);
    const inverse = inversePlan(SCENARIO, card, ctx);
    expect(inverse).toEqual([
      {
        name: "session.stop",
        params: { scope: "agent", reason: "undo of session.start", project: "proj_game" },
      },
      { name: "budget.set", params: { scope: "session", restore: true, project: "proj_game" } },
      { name: "project.switch", params: { back: true } },
    ]);
  });

  it("restores a known project budget and refuses irreversible steps", () => {
    const plan = [
      { name: "budget.set", params: { scope: "project", amountChf: 60, project: "proj_game" } },
    ];
    const card = buildPlanCard(plan, ctx);
    expect(inversePlan(plan, card, ctx)).toEqual([
      {
        name: "budget.set",
        params: { scope: "project", restore: true, project: "proj_game", amountChf: 40 },
      },
    ]);
    const stop = [{ name: "session.stop", params: { scope: "all" } }];
    expect(inversePlan(stop, buildPlanCard(stop, ctx), ctx)).toBeNull();
  });
});
