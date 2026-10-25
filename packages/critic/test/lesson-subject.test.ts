import { describe, expect, it } from "vitest";
import type { ReviewInput } from "../src/types.ts";
import { closingReply, submitReply, world } from "./helpers.ts";

/**
 * A lesson as the review subject (spec G.6: a lesson tagged `general` is promoted to the
 * shared store after critic approval). The runtime asks for a tier-1 light read of the
 * lesson text against the promotion criteria; the review row carries no task and the
 * token's session, and a `human` verdict files no sign-off request (there is no task to
 * sign off; the runtime retires the proposal as on any other non-accepting verdict and tells
 * the human, ADR 0059).
 */
const LESSON =
  "Run the Windows CI job before merging any change that touches file paths or separators.";

const lessonInput = (lessonId: string): ReviewInput => ({
  subject: { kind: "lesson", lessonId },
  tier: 1,
  evidence: {
    acceptanceCriteria: [
      "The lesson applies beyond the project it was learned in.",
      "The lesson is one present-tense observation, not an instruction to the agent.",
    ],
    brief: `Promote lesson ${lessonId} from critic memory to the shared store.`,
    inputFiles: [{ path: "lesson.md", content: LESSON }],
    finalReport: LESSON,
    artifacts: ["tags: general, windows, ci", "confidence: 0.8"],
  },
});

describe("CriticService: a lesson subject", () => {
  it("reviews the lesson at tier 1 on a clean context and records the review without a task", async () => {
    const w = await world({
      replies: [
        submitReply({
          grade: 88,
          verdict: "accept",
          summary: "General, actionable, no project detail.",
        }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(lessonInput("les_general_1"), w.ctx());
      expect(out.verdict).toBe("accept");
      expect(out.outcome).toBe("completed");
      expect(out.tier).toBe(1);
      expect(out.reviewId).toBeDefined();
      const user = String(w.provider.calls[0]?.request.messages[0]?.content);
      expect(user).toContain("Subject: lesson les_general_1");
      expect(user).toContain(LESSON);
      expect(user).toContain("tags: general, windows, ci");
      expect(w.provider.calls[0]?.request.tools?.map((t) => t.name)).toEqual(["submit_review"]);
      const review = await w.store.review.mustGet(out.reviewId ?? "");
      expect(review.task_id).toBeNull();
      expect(review.session_id).toBe(w.ids.session);
      expect(review.verdict).toBe("accept");
      expect(review.tier).toBe(1);
      const runs = await w.store.run.list({ session_id: w.ids.session } as never);
      expect(runs.some((r) => r.specialist === "critic" && r.task_id === null)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("a human verdict on a lesson files no sign-off request; a revise is recorded with its finding", async () => {
    const w = await world({
      replies: [
        submitReply(
          {
            grade: 55,
            confidence: "high",
            verdict: "human",
            summary: "Not sure this holds outside the CI project.",
            findings: [
              {
                severity: "minor",
                what: "Names a project-specific job",
                required_action: "Generalise the wording",
              },
            ],
          },
          { times: 1 },
        ),
        closingReply(),
        submitReply(
          {
            grade: 40,
            verdict: "revise",
            summary: "Too specific.",
            findings: [
              {
                severity: "major",
                what: "Names the project's CI job by name",
                required_action: "Drop the project detail",
              },
            ],
          },
          { times: 1 },
        ),
        closingReply(),
      ],
    });
    try {
      const human = await w.critic.review(lessonInput("les_general_2"), w.ctx());
      expect(human.verdict).toBe("human");
      expect(human.humanRequestId).toBeUndefined();
      expect(await w.store.humanRequest.open({ humanId: w.ids.human })).toEqual([]);
      const revise = await w.critic.review(lessonInput("les_general_3"), w.ctx());
      expect(revise.verdict).toBe("revise");
      expect(revise.findings).toHaveLength(1);
      const rows = await w.store.finding.forReview(revise.reviewId ?? "");
      expect(rows[0]).toMatchObject({ task_id: null, status: "open" });
    } finally {
      await w.close();
    }
  });

  it("refuses an unknown subject kind", async () => {
    const w = await world();
    try {
      await expect(
        w.critic.review(
          {
            subject: { kind: "lesson", lessonId: "" } as never,
            tier: 1,
            evidence: lessonInput("x").evidence,
          },
          w.ctx(),
        ),
      ).rejects.toMatchObject({ code: "validation" });
      await expect(
        w.critic.review(
          {
            subject: { kind: "note", id: "n" } as never,
            tier: 1,
            evidence: lessonInput("x").evidence,
          },
          w.ctx(),
        ),
      ).rejects.toMatchObject({ code: "validation" });
    } finally {
      await w.close();
    }
  });
});
