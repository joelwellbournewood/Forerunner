import { describe, expect, it } from "vitest";
import { sessionView } from "../src/daemon/views.ts";
import { blockedOfHandoff, endedStatusText } from "../src/session/stop-words.ts";

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
    expect(blockedOfHandoff({ blocked: ["t1", "t2"] })).toBe(2);
    expect(blockedOfHandoff(null)).toBe(0);
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
