import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/daemon/views.ts";
import { sessionEnded } from "../src/notifications/producers.ts";
import { countsBrief, countsList, countsSentence } from "../src/session/counts.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * One set of counts everywhere (U-072). A session whose only task the critic sent back said
 * "0 done, 0 need you" in its notification, its log line counted done, in review, failed and
 * not started, its summary another set, and the session review graded it as fine.
 */
describe("session counts (U-072)", () => {
  it("a session whose only task was sent back says so in the summary, the log line and the notification, and grades below 100", async () => {
    const w = await loopWorld({
      replies: [
        submitReply({
          grade: 40,
          verdict: "revise",
          summary: "The clamp has no test.",
          findings: [
            {
              severity: "major",
              what: "No test covers clamp",
              required_action: "Add a unit test for clamp",
            },
          ],
        }),
        closingReply(),
      ],
    });
    try {
      const task = await w.addTask("Add clamp");
      const result = await w.start(w.runner(doneExecutor(w)));
      expect(result.retried).toEqual([task.id]);

      // The summary the person receives.
      expect(result.summary).toContain(
        "Done: 0. Failed: 0. Needs you: 0. Sent back by the critic: 1. In review: 0. Not started: 0 of 1 planned.",
      );
      // The session log's last line, as the live view shows it.
      const ended = (await w.store.event.list(result.sessionId)).find(
        (e) => e.type === "session.ended",
      );
      expect(
        describeEvent("session.ended", (ended?.payload ?? {}) as Record<string, unknown>),
      ).toContain("0 done, 0 failed, 0 need you, 1 sent back, 0 in review, 0 not started");
      // The notification title, built from the run's lists as the daemon builds it.
      const note = sessionEnded("h-1", {
        sessionId: result.sessionId,
        status: result.status,
        stopReason: result.stopReason,
        summary: result.summary,
        spentUsdMicro: result.spentUsdMicro,
        completed: result.completed,
        needsHuman: result.needsHuman,
        failed: result.failed,
        retried: result.retried,
        inReview: result.inReview,
        skipped: result.skipped,
        agentName: "Alice",
      });
      expect(note.title).toBe(`Alice's session ${result.status}: 0 done, 1 sent back`);
      // The session review does not read it as fine.
      expect(result.sessionReview?.grade).toBeLessThan(100);
      expect(result.sessionReview?.findings.map((f) => f.description)).toContain(
        "No planned task was done: 1 of 1 sent back by the critic",
      );
    } finally {
      await w.close();
    }
  });

  it("the three forms count the same categories in the same order", () => {
    const c = { done: 2, failed: 1, needsYou: 1, sentBack: 0, inReview: 3, notStarted: 4 };
    expect(countsSentence(c, 11)).toBe(
      "Done: 2. Failed: 1. Needs you: 1. Sent back by the critic: 0. In review: 3. Not started: 4 of 11 planned.",
    );
    expect(countsList(c)).toBe(
      "2 done, 1 failed, 1 needs you, 0 sent back, 3 in review, 4 not started",
    );
    expect(countsBrief(c)).toBe("2 done, 1 failed, 1 needs you, 3 in review, 4 not started");
    expect(countsBrief({ ...c, done: 0, failed: 0, needsYou: 0, inReview: 0, notStarted: 0 })).toBe(
      "0 done",
    );
  });
});
