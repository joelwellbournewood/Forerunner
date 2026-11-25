import { describe, expect, it } from "vitest";
import { reviewStopWords } from "../src/daemon/task-display.ts";
import { budgetPauseLabelOf } from "../src/daemon/task-words.ts";
import { sessionView } from "../src/daemon/views.ts";
import { budgetStopTitle } from "../src/session/budget-card.ts";
import { isNewsLine, sessionResultLines, stopWords } from "../src/session/result.ts";
import {
  blockedOfHandoff,
  budgetStopReasonOf,
  endedStatusText,
  isBudgetStopReason,
  sessionStatusText,
} from "../src/session/stop-words.ts";

/**
 * A session that finished with tasks waiting for the person is not "Done" (wave 1 handoff):
 * the session page's badge read "Done" for a session whose task failed or needs an answer.
 */
describe("session status words", () => {
  it("'Ended: 1 task needs you' when it completed with a task waiting for the person", () => {
    expect(endedStatusText("completed", "completed", 1)).toBe("Ended: 1 task needs you");
    expect(endedStatusText("completed", "completed", 2)).toBe("Ended: 2 tasks need you");
    expect(endedStatusText("completed", "completed", 0)).toBe("Done");
    // A stop says whose it was, whatever is left.
    expect(endedStatusText("killed", "you", 1)).toBe("Stopped by you");
    expect(endedStatusText("running", null, 3)).toBe("Working");
    // W15B-10 (w15-words): the paused ones are counted apart.
    expect(blockedOfHandoff({ blocked: ["t1", "t2"] })).toEqual({ needYou: 2, paused: 0 });
    expect(blockedOfHandoff(null)).toEqual({ needYou: 0, paused: 0 });
  });

  it("the session view carries it", () => {
    const view = sessionView(
      {
        id: "s1",
        agent_id: "a1",
        project_id: "p1",
        trigger: "manual",
        status: "completed",
        started_at: "2026-11-01T10:00:00Z",
        ended_at: "2026-11-01T10:05:00Z",
        budget_cap_usd_micro: 5_000_000,
        spent_usd_micro: 100_000,
        step_cap: 200,
        steps: 12,
        summary: '"Style the page" needs your decision (Inbox).',
        handoff: { stop_reason: "completed", blocked: ["t1"] },
        runner: "pc",
      } as never,
      "Alice",
      0.8,
    );
    expect(view.statusText).toBe("Ended: 1 task needs you");
  });
});

/**
 * Review of budget-stop (ADR 0112): a task paused at the month's cap, the project's budget or the
 * subscription's share ends its session, and the session said "Stopped: the budget is used" and
 * "The session's budget is used." though its own budget was 1% spent. It names the limit.
 */
describe("a session stopped at an outer limit names it (budget-stop)", () => {
  it("each limit has its stop reason; the session's own budget keeps budget_exceeded", () => {
    expect(budgetStopReasonOf("month")).toBe("budget_month");
    expect(budgetStopReasonOf("project")).toBe("budget_project");
    expect(budgetStopReasonOf("plan")).toBe("budget_plan");
    expect(budgetStopReasonOf("session")).toBe("budget_exceeded");
    for (const r of ["budget_exceeded", "budget_month", "budget_project", "budget_plan"])
      expect(isBudgetStopReason(r), r).toBe(true);
    expect(isBudgetStopReason("budget_finish_current")).toBe(false);
    expect(isBudgetStopReason("you")).toBe(false);
  });

  it("the status, the result's line and a stopped review say the limit", () => {
    expect(endedStatusText("stopped", "budget_month", 1)).toBe(
      "Ended before this month's cap ran out",
    );
    expect(endedStatusText("stopped", "budget_project", 0)).toBe(
      "Ended before the project's budget ran out",
    );
    expect(endedStatusText("stopped", "budget_plan", 0)).toBe(
      "Ended before your Claude subscription's share ran out",
    );
    expect(endedStatusText("stopped", "budget_exceeded", 0)).toBe("Stopped: the budget is used");
    expect(stopWords("budget_month", 230_000)).toBe(
      "Ended before this month's cap of CHF 0.23 ran out.",
    );
    expect(stopWords("budget_month")).toBe("Ended before this month's cap ran out.");
    expect(stopWords("budget_project", 400_000)).toBe(
      "Ended before the project's budget of CHF 0.40 ran out.",
    );
    expect(stopWords("budget_plan")).toBe(
      "Ended before the share of your Claude subscription that Forerunner may use ran out.",
    );
    expect(stopWords("budget_exceeded")).toBe("The session's budget is used.");
    expect(reviewStopWords({ status: "in_review" }, "budget_month")).toBe(
      "the session ended before this month's cap ran out",
    );
    const lines = sessionResultLines({
      outcome: {
        done: [],
        failed: [],
        needsYou: [{ id: "t1", title: "Write the manual" }],
        leftOver: [],
        waiting: [],
        waitingForDocker: [],
        stopReason: "budget_month",
        stopCapChfMicro: 230_000,
        spentChfMicro: 40_000,
      },
      inReview: [],
      leftOutForBudget: [],
      sessionCapChfMicro: 5_000_000,
      openTasks: 1,
    });
    expect(lines).toEqual([
      '"Write the manual" needs your decision (Inbox).',
      "Ended before this month's cap of CHF 0.23 ran out. CHF 0.04.",
    ]);
    // News: the Update says it (it is not only money and a stop the person made).
    expect(isNewsLine(lines[1] ?? "")).toBe(true);
  });
});

describe("w8-l4-leftovers, wave 8: no 'budget used' sentence while room is left (L4i-left-30)", () => {
  const facts = (stopReason: string, workLeftChfMicro: number) => ({
    outcome: {
      done: [],
      failed: [],
      needsYou: [],
      leftOver: [],
      waiting: [],
      waitingForDocker: [],
      stopReason,
      spentChfMicro: 300_000,
    },
    inReview: [],
    leftOutForBudget: [
      { id: "t4", title: "About page", estimateChfMicro: 430_000, reason: "after_others" as const },
    ],
    sessionCapChfMicro: 5_000_000,
    workBudgetChfMicro: 4_000_000,
    workLeftChfMicro,
    openTasks: 2,
  });

  it("a larger task's pause that ended the session with room left never says the budget was used", () => {
    const text = sessionResultLines(facts("budget_project", 3_700_000)).join("\n");
    expect(text).toContain(
      'Left for next time: "About page" (about CHF 0.43); it did not fit this session\'s work budget after the tasks before it.',
    );
    expect(text).not.toMatch(/was used/);
  });

  it("a session its own budget ended still says so", () => {
    expect(sessionResultLines(facts("budget_exceeded", 3_700_000)).join("\n")).toContain(
      'Left for next time: "About page" (about CHF 0.43); this session\'s CHF 5.00 was used.',
    );
  });
});

describe("w8-l4-leftovers, wave 8: one wording for a task whose review waits (L4i-left-31)", () => {
  it("a session that ended with a done task whose review waits says so, never 'paused'", () => {
    const handoff = { blocked: ["t1", "t2"], paused: ["t1", "t2"], review_waits: ["t2"] };
    expect(blockedOfHandoff(handoff)).toEqual({ needYou: 0, paused: 1, reviewWaits: 1 });
    expect(endedStatusText("completed", "completed", blockedOfHandoff(handoff))).toBe(
      "Ended: 1 paused, 1 review waits for room",
    );
    expect(
      endedStatusText("completed", "completed", { needYou: 0, paused: 0, reviewWaits: 2 }),
    ).toBe("Ended: 2 reviews wait for room");
    // A handoff of before (no review_waits) reads as it did.
    expect(blockedOfHandoff({ blocked: ["t1"], paused: ["t1"] })).toEqual({
      needYou: 0,
      paused: 1,
    });
    // fixup-w8-l4-leftovers: a row written before review_waits keeps the fact in its outcome
    // (L4-money-111's `reviewWaits` on the paused task): its badge says it the same way.
    const older = {
      blocked: ["t1"],
      paused: ["t1"],
      outcome: {
        done: [],
        failed: [],
        needsYou: [],
        paused: [{ id: "t1", title: "Write the footer", limit: "its budget", reviewWaits: true }],
      },
    };
    expect(endedStatusText("completed", "completed", blockedOfHandoff(older))).toBe(
      "Ended: 1 review waits for room",
    );
  });
});

/**
 * fixup-w8-l4-leftovers, wave 8 (L4i-left-28, the review's blocking item 2): a pause under an
 * outer limit says "paused before it ran out" while some of it is left (what the task spent is
 * below it), wrap-up or hard stop alike, and "paused at it" only once the spend reached it; the
 * session's badge, end line and result follow the session's own spend the same way. Before, a
 * hard stop read '"X" paused at the project's budget of CHF 0.06' with half of it unspent, beside
 * "Ended before the project's budget of CHF 0.06 ran out.".
 */
describe("w8-l4-leftovers, wave 8: one wording for a pause under an outer limit (L4i-left-28)", () => {
  const task = { title: "Write the heron page" };
  const stop = (spentUsdMicro: number) => ({
    capUsdMicro: 75_000,
    spentUsdMicro,
    source: "project" as const,
    specialist: "coder",
    stoppedBy: "budget" as const,
  });
  it("the card's title and the task's row: before it ran out while some is left, at it once spent", () => {
    expect(budgetStopTitle(task, stop(37_500), 0.8)).toBe(
      '"Write the heron page" paused before the project\'s budget ran out',
    );
    expect(budgetStopTitle(task, stop(84_000), 0.8)).toBe(
      '"Write the heron page" paused at the project\'s budget of CHF 0.06',
    );
    expect(
      budgetStopTitle(task, { ...stop(1_000), source: "month", capUsdMicro: 125_000 }, 0.8),
    ).toBe('"Write the heron page" paused before this month\'s cap ran out');
    expect(budgetStopTitle(task, { ...stop(1_000), source: "plan" }, 0.8)).toBe(
      '"Write the heron page" paused before your Claude subscription\'s share ran out',
    );
    // A limit Continue lifts keeps its own words (its budget, the session's budget).
    expect(budgetStopTitle(task, { ...stop(1_000), source: "task_budget" }, 0.8)).toBe(
      '"Write the heron page" paused at its budget of CHF 0.06',
    );
    const card = (spent: number) => ({
      key: "task:budget_stop",
      source: "project",
      stopped_by: "budget",
      cap_usd_micro: 75_000,
      spent_usd_micro: spent,
    });
    expect(budgetPauseLabelOf(card(37_500))).toBe("Paused before the project's budget ran out");
    expect(budgetPauseLabelOf(card(84_000))).toBe("Paused at the project's budget");
  });
  it("the session's badge and result line: ended before it ran out, stopped at it once spent", () => {
    expect(sessionStatusText("stopped", "budget_project")).toBe(
      "Ended before the project's budget ran out",
    );
    expect(sessionStatusText("stopped", "budget_project", true)).toBe(
      "Stopped at the project's budget",
    );
    expect(stopWords("budget_project", 60_000, 30_000)).toBe(
      "Ended before the project's budget of CHF 0.06 ran out.",
    );
    expect(stopWords("budget_project", 60_000, 67_000)).toBe(
      "Stopped at the project's budget of CHF 0.06.",
    );
  });
});
