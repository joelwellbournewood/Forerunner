import { describe, expect, it } from "vitest";
import { reviewStopWords } from "../src/daemon/task-display.ts";
import { sessionView } from "../src/daemon/views.ts";
import { isNewsLine, sessionResultLines, stopWords } from "../src/session/result.ts";
import {
  blockedOfHandoff,
  budgetStopReasonOf,
  endedStatusText,
  isBudgetStopReason,
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
    expect(endedStatusText("stopped", "budget_month", 1)).toBe("Stopped at this month's cap");
    expect(endedStatusText("stopped", "budget_project", 0)).toBe("Stopped at the project's budget");
    expect(endedStatusText("stopped", "budget_plan", 0)).toBe(
      "Stopped at your Claude subscription's share",
    );
    expect(endedStatusText("stopped", "budget_exceeded", 0)).toBe("Stopped: the budget is used");
    expect(stopWords("budget_month", 230_000)).toBe("Stopped at this month's cap of CHF 0.23.");
    expect(stopWords("budget_month")).toBe("Stopped at this month's cap.");
    expect(stopWords("budget_project", 400_000)).toBe(
      "Stopped at the project's budget of CHF 0.40.",
    );
    expect(stopWords("budget_plan")).toBe(
      "Stopped at the share of your Claude subscription that Forerunner may use.",
    );
    expect(stopWords("budget_exceeded")).toBe("The session's budget is used.");
    expect(reviewStopWords({ status: "in_review" }, "budget_month")).toBe(
      "the session stopped at this month's cap",
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
      "Stopped at this month's cap of CHF 0.23. CHF 0.04.",
    ]);
    // News: the Update says it (it is not only money and a stop the person made).
    expect(isNewsLine(lines[1] ?? "")).toBe(true);
  });
});
