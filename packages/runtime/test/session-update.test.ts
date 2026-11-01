import { describe, expect, it } from "vitest";
import { sessionUpdateLine } from "../src/session/result.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * The Inbox Update of a session (design §3.8, §5.10, §5.11): one line of news. Before, it
 * repeated the card beside it ('"X" needs your decision (Inbox).', stale once answered) and,
 * after the person stopped the only task, read just "<Project>: CHF 0.00." (waves 1 and 2).
 */
describe("a session's Update", () => {
  it("leaves what a card says to the card and says what was done", () => {
    expect(
      sessionUpdateLine("Quote page", [
        '"Style the page" needs your decision (Inbox).',
        'Did 2 tasks: "Create index.html" and "Write script.js".',
        "1 task waits on it. CHF 0.06.",
      ]),
    ).toBe('Quote page: did 2 tasks: "Create index.html" and "Write script.js".');
    expect(
      sessionUpdateLine("Quote page", [
        '"A" failed: Claude did not answer. "B" needs your decision (Inbox).',
        "CHF 0.02.",
      ]),
    ).toBe('Quote page: "A" failed: Claude did not answer.');
  });

  it("a session whose only news is a card says so in words that stay true; the person's own stop posts nothing", () => {
    expect(
      sessionUpdateLine("Quote page", [
        '"Style the page" needs your decision (Inbox).',
        "CHF 0.01.",
      ]),
    ).toBe("Quote page: the session ended without finishing a task.");
    expect(sessionUpdateLine("Quote page", ["CHF 0.00."])).toBeNull();
    expect(sessionUpdateLine("Quote page", ["Stopped by you. CHF 0.00."])).toBeNull();
  });

  it("in the Inbox: a session that did its task says so once; one whose only task was stopped by the person says nothing", async () => {
    const w = await loopWorld({
      replies: [submitReply({ grade: 90, verdict: "accept" }), closingReply()],
    });
    try {
      await w.addTask("Write the README");
      const result = await w.start(w.runner(doneExecutor(w)));
      expect(result.completed).toHaveLength(1);
      const updates = async () =>
        (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
          (m) => m.type === "info",
        );
      expect((await updates()).map((m) => m.body)).toEqual([
        expect.stringMatching(/: did 1 task: "Write the README"\./),
      ]);
      // A second session whose only task the person stops while it runs (the Tasks tab's
      // Stop pauses it; the session goes on and finds nothing else): no "<Project>: CHF 0.00."
      const second = await w.addTask("Write the FAQ");
      await w.start(
        w.runner({
          async execute() {
            const now = await w.store.task.mustGet(second.id);
            await w.store.task.transition(now.id, now.version, "needs_human", "Stopped by you", {
              humanId: w.human,
            });
            return { outcome: "killed", summary: "stopped", costUsdMicro: 0 };
          },
        }),
      );
      expect(await updates()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
