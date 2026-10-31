import { describe, expect, it } from "vitest";
import {
  applyVerdict,
  type FollowupContext,
  SIGNOFF_KEY,
  SIGNOFF_OPTIONS,
} from "../src/followup.ts";
import type { ReviewFinding } from "../src/types.ts";
import { reviewOutput, type World, world } from "./helpers.ts";

const finding = (description: string): ReviewFinding => ({
  severity: "high",
  description,
  requiredAction: `Fix: ${description}`,
  fingerprint: "deadbeefdeadbeef",
});

/** A persisted review with open findings on the task, as CriticService would leave it. */
async function persistedReview(
  w: World,
  taskId: string,
  verdict: "revise" | "accept",
  findings: ReviewFinding[],
) {
  const review = await w.store.review.insert({
    task_id: taskId,
    session_id: w.ids.session,
    critic_model: "fake-sonnet",
    tier: 1,
    grade: verdict === "accept" ? 90 : 40,
    confidence: 0.9,
    verdict,
    summary: "s",
    author_agent: w.ids.critic,
  });
  const ids: string[] = [];
  for (const f of findings) {
    const row = await w.store.finding.insert({
      review_id: review.id,
      task_id: taskId,
      severity: f.severity,
      description: f.description,
      required_action: f.requiredAction,
      status: "open",
      fingerprint: f.fingerprint,
      author_agent: w.ids.critic,
    });
    ids.push(row.id);
  }
  return { review, findingIds: ids };
}

const ctxOf = (w: World, over: Partial<FollowupContext> = {}): FollowupContext => ({
  store: w.store,
  criticAgentId: w.ids.critic,
  humanId: w.ids.human,
  sessionId: w.ids.session,
  runId: null,
  ...over,
});

describe("applyVerdict (B.4, D.2)", () => {
  it("accept: resolves the review's findings with the run that produced the work and closes the task", async () => {
    const w = await world();
    try {
      const { review, findingIds } = await persistedReview(w, w.ids.task, "accept", [
        finding("nit"),
      ]);
      const work = await w.store.run.insert({
        session_id: w.ids.session,
        task_id: w.ids.task,
        specialist: "coder",
        model: "fake-sonnet",
      });
      const d = await applyVerdict(
        w.ids.task,
        reviewOutput({ verdict: "accept", reviewId: review.id, findingIds }),
        ctxOf(w, { runId: work.id }),
      );
      expect(d.action).toBe("accepted");
      if (d.action !== "accepted") return;
      expect(d.task.status).toBe("done");
      expect(d.task.reason).toContain("critic accepted");
      expect(d.task.author_agent).toBe(w.ids.critic);
      expect(d.resolvedFindingIds).toEqual(findingIds);
      const f = await w.store.finding.mustGet(findingIds[0] as string);
      expect(f).toMatchObject({ status: "resolved", resolved_by_run: work.id });
    } finally {
      await w.close();
    }
  });

  it("accept cannot close a task while a finding from another review is still open (findings_open)", async () => {
    const w = await world();
    try {
      const earlier = await persistedReview(w, w.ids.task, "revise", [finding("security hole")]);
      const mine = await persistedReview(w, w.ids.task, "accept", []);
      await expect(
        applyVerdict(
          w.ids.task,
          reviewOutput({ verdict: "accept", reviewId: mine.review.id }),
          ctxOf(w),
        ),
      ).rejects.toMatchObject({ code: "findings_open", details: { findings: earlier.findingIds } });
      expect((await w.store.task.mustGet(w.ids.task)).status).toBe("in_review");
      expect((await w.store.finding.mustGet(earlier.findingIds[0] as string)).status).toBe("open");
    } finally {
      await w.close();
    }
  });

  it("revise: the task goes back to ready with attempt + 1 and the owner agent gets the required actions", async () => {
    const w = await world();
    try {
      const d = await applyVerdict(
        w.ids.task,
        reviewOutput({
          verdict: "revise",
          grade: 55,
          reviewId: "rev-1",
          findings: [finding("Off by one"), { ...finding("Missing test"), severity: "medium" }],
        }),
        ctxOf(w),
      );
      expect(d.action).toBe("revise");
      if (d.action !== "revise") return;
      expect(d.task).toMatchObject({ status: "ready", attempt: 1, claimed_by: null });
      expect(d.requiredActions).toEqual([
        "[high] Off by one: Fix: Off by one",
        "[medium] Missing test: Fix: Missing test",
      ]);
      const msg = await w.store.message.mustGet(d.messageId as string);
      expect(msg).toMatchObject({
        from_agent_id: w.ids.critic,
        to_agent_id: w.ids.owner,
        task_id: w.ids.task,
        project_id: w.ids.project,
        type: "request",
        requires_ack: true,
      });
      expect(msg.body).toContain("Revision requested");
      expect(msg.body).toContain("- [high] Off by one: Fix: Off by one");
      expect(msg.body).toContain("Review: rev-1");
      const inbox = await w.store.message.inbox({ agentId: w.ids.owner });
      expect(inbox).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it("escalate follows the retry ladder: improve brief, split or change specialist, escalate one rung, then human", async () => {
    const w = await world();
    try {
      const review = reviewOutput({
        verdict: "escalate",
        grade: 30,
        findings: [finding("Wrong approach")],
      });
      const first = await applyVerdict(w.ids.task, review, ctxOf(w));
      expect(first).toMatchObject({
        action: "retry",
        retry: "improve_brief",
        attempt: 1,
        nextTier: null,
      });
      expect((await w.store.task.mustGet(w.ids.task)).status).toBe("ready");

      await w.store.task.patch(w.ids.task, { status: "in_review" });
      const second = await applyVerdict(w.ids.task, review, ctxOf(w));
      expect(second).toMatchObject({
        action: "retry",
        retry: "split_or_change_specialist",
        attempt: 2,
      });
      expect(
        (await w.store.message.mustGet((second as { messageId: string }).messageId)).body,
      ).toContain("Split the task");

      await w.store.task.patch(w.ids.task, { status: "in_review" });
      const third = await applyVerdict(
        w.ids.task,
        review,
        ctxOf(w, { currentTier: "sonnet", ceiling: "opus" }),
      );
      expect(third).toMatchObject({
        action: "retry",
        retry: "escalate",
        attempt: 3,
        nextTier: "opus",
      });

      await w.store.task.patch(w.ids.task, { status: "in_review" });
      const fourth = await applyVerdict(
        w.ids.task,
        review,
        ctxOf(w, { currentTier: "opus", ceiling: "opus" }),
      );
      expect(fourth).toMatchObject({ action: "human", reason: "retry_ladder_exhausted" });
      const task = await w.store.task.mustGet(w.ids.task);
      expect(task.status).toBe("needs_human");
      expect(task.attempt).toBe(3);
      const req = await w.store.humanRequest.mustGet(
        (fourth as { humanRequestId: string }).humanRequestId,
      );
      expect(req).toMatchObject({
        task_id: w.ids.task,
        human_id: w.ids.human,
        blocking: true,
        kind: "approval",
        change_card: { key: SIGNOFF_KEY, reason: "retry_ladder_exhausted", applied_at: null },
      });
      expect(req.why).toContain("Retry ladder exhausted");
      // U-073: the card names the task it asks about.
      expect(req.why).toContain('"Add clamp"');
    } finally {
      await w.close();
    }
  });

  it("escalate at the ceiling on the third failure goes to the human instead of above the ceiling", async () => {
    const w = await world();
    try {
      await w.store.task.patch(w.ids.task, { attempt: 2 });
      const d = await applyVerdict(
        w.ids.task,
        reviewOutput({ verdict: "escalate" }),
        ctxOf(w, { currentTier: "sonnet", ceiling: "sonnet" }),
      );
      expect(d.action).toBe("human");
      expect((await w.store.task.mustGet(w.ids.task)).status).toBe("needs_human");
    } finally {
      await w.close();
    }
  });

  it("escalate honours the project's critic_ceiling from the store when the context gives none, and the stricter ceiling wins (D.3)", async () => {
    const w = await world({ projectSettings: { critic_ceiling: "sonnet" } });
    try {
      await w.store.task.patch(w.ids.task, { attempt: 2 });
      // No ceiling in the context: the project row says sonnet, the attempt ran on sonnet, so
      // the third failure cannot escalate and goes to the human.
      const d = await applyVerdict(
        w.ids.task,
        reviewOutput({ verdict: "escalate" }),
        ctxOf(w, { currentTier: "sonnet" }),
      );
      expect(d).toMatchObject({ action: "human", reason: "retry_ladder_exhausted" });
      const req = await w.store.humanRequest.mustGet(
        (d as { humanRequestId: string }).humanRequestId,
      );
      expect(req.why).toContain("ceiling sonnet");

      // A caller cannot raise the ceiling above the project's.
      const task2 = await w.newTask({ attempt: 2 });
      const raised = await applyVerdict(
        task2.id,
        reviewOutput({ verdict: "escalate" }),
        ctxOf(w, { currentTier: "sonnet", ceiling: "opus" }),
      );
      expect(raised).toMatchObject({ action: "human", reason: "retry_ladder_exhausted" });

      // A stricter caller ceiling than the project's is honoured too.
      const w2 = await world({ projectSettings: { critic_ceiling: "opus" } });
      try {
        await w2.store.task.patch(w2.ids.task, { attempt: 2 });
        const lowered = await applyVerdict(
          w2.ids.task,
          reviewOutput({ verdict: "escalate" }),
          ctxOf(w2, { currentTier: "sonnet", ceiling: "sonnet" }),
        );
        expect(lowered.action).toBe("human");
      } finally {
        await w2.close();
      }
    } finally {
      await w.close();
    }
  });

  it("human: the task needs a human and the review's own sign-off request is reused while open", async () => {
    const w = await world();
    try {
      const existing = await w.store.humanRequest.insert({
        kind: "approval",
        why: "sign off",
        task_id: w.ids.task,
        human_id: w.ids.human,
      });
      const d = await applyVerdict(
        w.ids.task,
        reviewOutput({ verdict: "human", humanRequestId: existing.id }),
        ctxOf(w),
      );
      expect(d).toMatchObject({ action: "human", humanRequestId: existing.id, reason: "verdict" });
      expect((await w.store.task.mustGet(w.ids.task)).status).toBe("needs_human");
      expect(await w.store.humanRequest.count()).toBe(1);

      const w2 = await world();
      try {
        const d2 = await applyVerdict(
          w2.ids.task,
          reviewOutput({ verdict: "human", summary: "Needs eyes." }),
          ctxOf(w2),
        );
        if (d2.action !== "human") throw new Error("expected human");
        const req = await w2.store.humanRequest.mustGet(d2.humanRequestId);
        expect(req.why).toContain("Needs eyes.");
        // U-073: the card names the task it asks about.
        expect(req.why).toContain('"Add clamp"');
        expect(req.session_id).toBe(w2.ids.session);
        expect(req.options).toEqual([...SIGNOFF_OPTIONS]);
        // The card the runtime's sign-off sync applies the answer through (RT-P5-1).
        expect(req.change_card).toMatchObject({
          key: SIGNOFF_KEY,
          task_id: w2.ids.task,
          reason: "verdict",
          applied_at: null,
        });
      } finally {
        await w2.close();
      }
    } finally {
      await w.close();
    }
  });

  it("moves an in_progress task to in_review first and refuses a task in any other state", async () => {
    const w = await world({ taskStatus: "in_progress" });
    try {
      const d = await applyVerdict(w.ids.task, reviewOutput({ verdict: "accept" }), ctxOf(w));
      expect(d.action).toBe("accepted");
      const ready = await w.newTask({ status: "ready" });
      await expect(
        applyVerdict(ready.id, reviewOutput({ verdict: "accept" }), ctxOf(w)),
      ).rejects.toMatchObject({ code: "validation" });
    } finally {
      await w.close();
    }
  });
});
