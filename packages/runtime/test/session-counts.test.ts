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
      // The rework would run in the same session (design §4.3); a stop sent while the task ran
      // ends the session after it, so the task is left sent back and ready.
      const done = doneExecutor(w);
      const result = await w.start(
        w.runner({
          async execute(ctx) {
            const r = await done.execute(ctx);
            await w.store.message.send({
              from_agent_id: ctx.session.agent_id,
              to_agent_id: ctx.session.agent_id,
              type: "request",
              body: "stop after this task",
              requires_ack: false,
            });
            return r;
          },
        }),
      );
      expect(result.retried).toEqual([task.id]);

      // The result the person receives: what is left and why the session ended.
      expect(result.summary).toMatch(
        /^Stopped after the task, as asked\. "Add clamp" is ready to continue\. CHF \d+\.\d{2}\.$/,
      );
      // The session log's last line, as the live view shows it: the counts that happened, no
      // zero counts (design §5 rule 5).
      const ended = (await w.store.event.list(result.sessionId)).find(
        (e) => e.type === "session.ended",
      );
      expect(
        describeEvent("session.ended", (ended?.payload ?? {}) as Record<string, unknown>),
      ).toMatch(/^Stopped after the task, as asked: 1 sent back\. CHF \d+\.\d{2}\.$/);
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
        projectName: "Clamp",
      });
      // Design §5, "Notification": the project and the result's first point, not a count list.
      expect(note.title).toBe("Clamp: stopped after the task, as asked");
      // The body says what the title does not (phase E #89: it repeated the title's sentence).
      expect(note.body).toMatch(
        /^"Add clamp" is ready to continue\. CHF \d+\.\d{2}\. Open the session for the details\.$/,
      );
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
