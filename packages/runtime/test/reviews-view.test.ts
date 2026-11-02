import { describe, expect, it } from "vitest";
import { reviewsView } from "../src/daemon/views.ts";
import { loopWorld } from "./loop-helpers.ts";

const ID = "01a196fe-2aa9-7114-a15e-2024baa5e65e";

/**
 * The Reviews tab's counts and words (design §3.5, §5): before, "17 open findings" were the same
 * three counted on every attempt, those of a task the person had accepted included, the session
 * self-check's findings were open work nobody could act on, and the evidence listed the prompt
 * hash, the run id and the context note.
 */
describe("reviews view", () => {
  it("counts each open finding once per task, none for a done task or a session check, and leaves the internals out of the evidence", async () => {
    const w = await loopWorld();
    try {
      const open = await w.addTask("Style the page");
      const closed = await w.addTask("Write the README");
      await w.store.task.patch(closed.id, { status: "done" } as never);
      const session = await w.store.session.insert({
        agent_id: w.alice,
        project_id: w.project,
        budget_cap_usd_micro: 1_000_000,
        step_cap: 10,
      } as never);
      const review = async (taskId: string | null, verdict: string) =>
        w.store.review.insert({
          task_id: taskId,
          session_id: session.id,
          critic_model: "fake-sonnet",
          tier: 1,
          grade: 35,
          confidence: 0.9,
          verdict,
          evidence: [
            "[unmet] styles.css exists",
            "prompt:critic@1.1.0+7661cc6c",
            `run:${ID}`,
            "context: 2 evidence block(s) sent uncompressed (bypass)",
            `ran: node --check script.js (run ${ID})`,
          ],
          summary: "[stand-in model] Sent back for rework: 2 finding(s).",
          author_agent: w.criticAgent,
        } as never);
      const finding = (reviewId: string, taskId: string | null, description: string) =>
        w.store.finding.insert({
          review_id: reviewId,
          task_id: taskId,
          severity: "high",
          description,
          required_action: "Write it",
          status: "open",
          fingerprint: description.toLowerCase().replace(/\W+/g, "-"),
        } as never);
      // The same finding filed on each of three attempts of the open task: one open finding.
      for (let i = 0; i < 3; i++) {
        const r = await review(open.id, "revise");
        await finding(r.id, open.id, "styles.css is missing");
      }
      // A done task's finding and a session check's finding are no open work.
      const r2 = await review(closed.id, "revise");
      await finding(r2.id, closed.id, "README.md is empty");
      const s = await review(null, "revise");
      await finding(s.id, null, "Say in the summary what the spend bought");
      // The session check's own words, as the critic package writes them (phase E #80: the
      // Reviews tab's Session checks read "1 of the 2 task(s)").
      await finding(
        s.id,
        null,
        "Summary claims 2 task(s) done but 1 of the 2 task(s) the session planned or ran are done",
      );

      const view = await reviewsView(w.store, { projectId: w.project });
      expect(view.openFindings).toBe(1);
      expect(view.reviews.filter((r) => r.taskId === open.id).map((r) => r.openFindings)).toEqual([
        1, 1, 1,
      ]);
      expect(view.reviews.find((r) => r.taskId === closed.id)).toMatchObject({
        taskStatus: "done",
        openFindings: 0,
      });
      // The trend, the average and the verdict counts are the tasks' reviews only.
      expect(view.gradeTrend).toHaveLength(4);
      expect(view.verdicts).toEqual({ revise: 4 });
      const one = view.reviews[0];
      expect(one?.evidence).toEqual(["[unmet] styles.css exists", "ran: node --check script.js"]);
      expect(one?.summary).toBe("Sent back for rework: 2 findings.");
      const words = view.reviews.flatMap((r) => r.findings.map((f) => f.description));
      expect(words).toContain(
        "Summary claims 2 tasks done but 1 of the 2 tasks the session planned or ran are done",
      );
      for (const d of words) expect(d).not.toMatch(/\(s\)/);
    } finally {
      await w.close();
    }
  });

  it("a session that ended no task is not graded (before: 'Session review: accepted (grade 100)')", async () => {
    const w = await loopWorld();
    try {
      await w.addTask("Create the page skeleton");
      // The run is stopped before it finishes: the task goes back to ready, nothing ended.
      const result = await w.start(
        w.runner({
          async execute() {
            return { outcome: "killed", summary: "stopped", costUsdMicro: 0 };
          },
        }),
      );
      expect(result.status).toBe("killed");
      expect(result.sessionReview).toBeNull();
      const types = (await w.store.event.list(result.sessionId)).map((e) => e.type);
      expect(types).not.toContain("critic.session_review");
      const reviews = await reviewsView(w.store, { projectId: w.project });
      expect(reviews.reviews).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
