import { describe, expect, it } from "vitest";
import { describeEvent, requestView } from "../src/daemon/views.ts";
import { continueLabel, continueUsdMicro } from "../src/session/budget-card.ts";
import { budgetLineWords, limitWords, pauseSentence } from "../src/session/budget-pause.ts";
import { runCapOf, workRunCapOf } from "../src/session/executor.ts";

/**
 * d1116-budget-all, run C (BA-4, BA-5; the owner's "yes it should count critics reviews, and
 * fixes." and "wrap up in an organized and error free way such that the work can be continued in
 * the next run"): a work run of a task with a budget of its own keeps room for its review when the
 * budget can hold it, its words say the room only when it keeps one, and one Continue at the
 * task's budget gives what the task needs.
 */
const RATE = 0.8;
const chf = (usd: number) => `CHF ${((Math.round(usd * RATE) / 1e6) as number).toFixed(2)}`;

describe("d1116-budget-all, run C: the room a work run keeps for its review (BA-4)", () => {
  it("runCapOf stays what is left of the budget (the Tasks row's cap)", () => {
    expect(
      runCapOf({ budget_usd_micro: 2_000_000, actual_cost_usd_micro: 500_000 }, 3_000_000),
    ).toEqual({ usdMicro: 1_500_000, source: "task_budget" });
  });

  it("workRunCapOf keeps R + W when it is at most half of what is left, else nothing", () => {
    const room = 30_000 + 100_000;
    expect(
      workRunCapOf(
        { budget_usd_micro: 2_000_000, actual_cost_usd_micro: 500_000 },
        3_000_000,
        room,
      ),
    ).toEqual({ capUsdMicro: 1_370_000, roomUsdMicro: 130_000, source: "task_budget" });
    // 130,000 is more than half of the 200,000 left: the work gets all of it.
    expect(
      workRunCapOf(
        { budget_usd_micro: 2_000_000, actual_cost_usd_micro: 1_800_000 },
        3_000_000,
        room,
      ),
    ).toEqual({ capUsdMicro: 200_000, roomUsdMicro: 0, source: "task_budget" });
    expect(
      workRunCapOf(
        { budget_usd_micro: 2_000_000, actual_cost_usd_micro: 2_000_000 },
        3_000_000,
        room,
      ),
    ).toEqual({ capUsdMicro: 0, roomUsdMicro: 0, source: "task_budget" });
    // A task without a budget of its own keeps its specialist's limit, with no room.
    expect(
      workRunCapOf({ budget_usd_micro: 0, actual_cost_usd_micro: 0 }, 3_000_000, room),
    ).toEqual({ capUsdMicro: 3_000_000, roomUsdMicro: 0, source: "specialist_limit" });
  });

  it("the start line says the room after the amount, in every form; with no room it reads as before", () => {
    const line = {
      capUsdMicro: 875_000,
      lineUsdMicro: 700_000,
      reserveUsdMicro: 175_000,
      firstCallUsdMicro: 60_000,
      saveOnly: false,
    };
    expect(budgetLineWords(line, chf, 125_000)).toBe(
      "This run may spend CHF 0.70 (CHF 0.10 of the task's budget is kept for its review): before a step that could take it past CHF 0.56 it is told to wrap up, keeping a reserve of CHF 0.14 to finish.",
    );
    expect(budgetLineWords(line, chf, 0)).toBe(
      "This run may spend CHF 0.70: before a step that could take it past CHF 0.56 it is told to wrap up, keeping a reserve of CHF 0.14 to finish.",
    );
    expect(budgetLineWords(line, chf)).toBe(budgetLineWords(line, chf, 0));
    expect(budgetLineWords({ ...line, saveOnly: true }, chf, 125_000)).toBe(
      "This run may spend CHF 0.70 (CHF 0.10 of the task's budget is kept for its review), too little to wrap up (two steps may cost CHF 0.14): it pauses at its budget and keeps its work.",
    );
    expect(
      budgetLineWords({ ...line, saveOnly: true, firstCallUsdMicro: 900_000 }, chf, 125_000),
    ).toBe(
      "This run may spend CHF 0.70 (CHF 0.10 of the task's budget is kept for its review), less than its first step may cost (CHF 0.72): it pauses at its budget before that step.",
    );
  });

  it("a stop at the work cap and a wrap-up pause name the room kept", () => {
    const what = limitWords("task_budget", 250_000, chf, "coder");
    expect(
      pauseSentence(
        { stopped: "", leftToDo: [], stoppedBy: "budget" },
        what,
        100_000,
        200_000,
        chf,
        100_000,
        50_000,
      ),
    ).toBe(
      "The run stopped at its budget of CHF 0.20, less the CHF 0.04 kept for its review: it spent CHF 0.08, and its next step would have gone over.",
    );
    expect(
      pauseSentence(
        { stopped: "Half done.", leftToDo: ["a", "b"], stoppedBy: "wrap_up" },
        what,
        100_000,
        200_000,
        chf,
        100_000,
        50_000,
      ),
    ).toBe(
      "The run paused before its budget of CHF 0.20 ran out: it spent CHF 0.08 and listed 2 things left to do; CHF 0.04 is kept for its review.",
    );
    // No room: the words of before.
    expect(
      pauseSentence(
        { stopped: "", leftToDo: [], stoppedBy: "budget" },
        what,
        100_000,
        200_000,
        chf,
      ),
    ).toBe(
      "The run stopped at its budget of CHF 0.20: it spent CHF 0.08, and its next step would have gone over.",
    );
  });

  it("the card's first sentence names the room the run kept", () => {
    const view = requestView(
      {
        id: "r1",
        human_id: "h1",
        project_id: "p1",
        task_id: "t1",
        session_id: null,
        kind: "approval",
        why: '"Write the page" paused before its budget ran out.',
        steps: [],
        options: [continueLabel(250_000, RATE), "Cancel task"],
        blocking: true,
        risk: "medium",
        change_card: {
          key: "task:budget_stop",
          task_id: "t1",
          task_title: "Write the page",
          title: '"Write the page" paused before its budget ran out',
          source: "task_budget",
          specialist: "coder",
          cap_usd_micro: 250_000,
          spent_usd_micro: 100_000,
          continue_usd_micro: 250_000,
          stopped_by: "wrap_up",
          done: "Half done.",
          left: ["a"],
          room_usd_micro: 50_000,
          chf_per_usd: RATE,
          applied_at: null,
        },
        status: "open",
        answer: null,
        created_at: "2026-11-16T09:00:00.000Z",
        updated_at: "2026-11-16T09:00:00.000Z",
        version: 1,
        author_agent: "a1",
        author_human: null,
      } as never,
      null,
    );
    expect(view.body).toBe(
      "It spent CHF 0.08 of its budget of CHF 0.20, keeping CHF 0.04 for its review.",
    );
  });
});

describe("d1116-budget-all, run C: one Continue at the task's budget gives what it needs (BA-5)", () => {
  const task = { est_cost_usd_micro: 0 };
  it("at the task's budget Continue gives the larger of the same amount again and what the card needs", () => {
    const more = continueUsdMicro(task, { capUsdMicro: 250_000, source: "task_budget" }, RATE, {
      needsUsdMicro: 400_000,
    });
    expect(continueLabel(more, RATE)).toBe("Continue (CHF 0.32 more)");
    // A review that waits: cap 75,000, needs R 30,000 + the refused 110,000 - left 55,000.
    const review = continueUsdMicro(task, { capUsdMicro: 75_000, source: "task_budget" }, RATE, {
      needsUsdMicro: 30_000 + 110_000 - 55_000,
    });
    expect(continueLabel(review, RATE)).toBe("Continue (CHF 0.07 more)");
    // Needs below the same amount again: the same amount again.
    expect(
      continueUsdMicro(task, { capUsdMicro: 250_000, source: "task_budget" }, RATE, {
        needsUsdMicro: 10_000,
      }),
    ).toBe(continueUsdMicro(task, { capUsdMicro: 250_000, source: "task_budget" }, RATE));
  });

  it("a card filed before (no needs) and the session's budget answer as before", () => {
    expect(
      continueUsdMicro(
        { est_cost_usd_micro: 300_000 },
        { capUsdMicro: 250_000, source: "task_budget" },
        RATE,
      ),
    ).toBe(300_000);
    // OP-6: at the session's budget, the estimate left over its work budget; needs never read.
    expect(
      continueUsdMicro(task, { capUsdMicro: 1_000_000, source: "session" }, RATE, {
        estimateLeftUsdMicro: 1_600_000,
        needsUsdMicro: 5_000_000,
      }),
    ).toBe(2_000_000);
  });

  it("BA-8: the session review's line sets the planned tasks' whole cost against a plan that counts it, the session's own checks apart; a line of before reads as written", () => {
    const line = (metrics: Record<string, unknown>) =>
      describeEvent("critic.session_review_metrics", { metrics }, 0.8);
    expect(
      line({
        plannedDoneTasks: 1,
        plannedTasks: 1,
        actualUsdMicro: 280_000,
        workUsdMicro: 180_000,
        reviewsUsdMicro: 100_000,
        estimateUsdMicro: 240_000,
        counts: "all",
        tasksUsdMicro: 250_000,
        otherUsdMicro: 30_000,
      }),
    ).toBe(
      "Session review measured: 1 of 1 planned task done; the planned tasks cost CHF 0.20 against an estimate of CHF 0.19, and the session's own checks CHF 0.02.",
    );
    expect(
      line({
        plannedDoneTasks: 1,
        plannedTasks: 1,
        actualUsdMicro: 250_000,
        workUsdMicro: 150_000,
        reviewsUsdMicro: 100_000,
        estimateUsdMicro: 240_000,
        counts: "all",
        tasksUsdMicro: 250_000,
        otherUsdMicro: 0,
      }),
    ).toBe(
      "Session review measured: 1 of 1 planned task done; the planned tasks cost CHF 0.20 against an estimate of CHF 0.19.",
    );
    // Written before the mark: the work against the estimate, the reviews apart.
    expect(
      line({
        plannedDoneTasks: 1,
        plannedTasks: 1,
        actualUsdMicro: 250_000,
        workUsdMicro: 150_000,
        reviewsUsdMicro: 100_000,
        estimateUsdMicro: 240_000,
      }),
    ).toBe(
      "Session review measured: 1 of 1 planned task done; the work cost CHF 0.12 against an estimate of CHF 0.19, and the reviews CHF 0.08.",
    );
  });
});
