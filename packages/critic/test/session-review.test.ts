import { describe, expect, it } from "vitest";
import {
  COST_OVERRUN_RATIO,
  loadSessionReviewData,
  parseSummaryClaims,
  planItemsOf,
  reviewSession,
  SESSION_REVIEW_KEY,
  SESSION_REVIEW_MODEL,
  SESSION_REVIEW_OPTIONS,
  sessionChecks,
} from "../src/session-review.ts";
import { world } from "./helpers.ts";

describe("session review (H.6)", () => {
  it("parses the claims a summary makes that the store can check", () => {
    expect(parseSummaryClaims("Done: 3, failed: 1. Cost: USD 1.25.")).toEqual({
      done: 3,
      failed: 1,
      costUsdMicro: 1_250_000,
    });
    expect(parseSummaryClaims("I completed 2 tasks and spent $0.40 on it")).toEqual({
      done: 2,
      costUsdMicro: 400_000,
    });
    expect(parseSummaryClaims("4 tasks done; total USD 2")).toEqual({
      done: 4,
      costUsdMicro: 2_000_000,
    });
    expect(parseSummaryClaims("Nothing to report.")).toEqual({});
  });

  it("reads plan items from the runtime's plan shape, a bare array, or junk", () => {
    expect(
      planItemsOf({ items: [{ taskId: "t1", title: "A", estimateUsdMicro: 5 }, { nope: 1 }] }),
    ).toEqual([{ taskId: "t1", title: "A", specialist: undefined, estimateUsdMicro: 5 }]);
    expect(planItemsOf([{ taskId: "t2" }])).toEqual([
      { taskId: "t2", title: undefined, specialist: undefined, estimateUsdMicro: undefined },
    ]);
    expect(planItemsOf("plan")).toEqual([]);
    expect(planItemsOf(null)).toEqual([]);
  });

  it("catches a lie: 'Done: 3' when one planned task is done is a high finding and a human verdict", async () => {
    const w = await world();
    try {
      const done = await w.newTask({ status: "done", title: "A" });
      const b = await w.newTask({ status: "in_progress", title: "B" });
      const c = await w.newTask({ status: "ready", title: "C" });
      const items = [done, b, c].map((t) => ({
        taskId: t.id,
        title: t.title,
        estimateUsdMicro: 100_000,
      }));
      await w.store.session.patch(w.ids.session, {
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: { items, estimateUsdMicro: 300_000, summary: "three tasks" },
        summary: "Done: 3. All green. Cost: USD 0.30.",
        status: "completed",
      });
      await w.store.costLedger.record({
        human_id: w.ids.human,
        session_id: w.ids.session,
        kind: "api",
        usd_micro: 300_000,
        chf_micro: 240_000,
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out.model).toBe(SESSION_REVIEW_MODEL);
      expect(out.verdict).toBe("human");
      expect(out.costUsdMicro).toBe(0);
      const lie = out.findings.find((f) => f.description.startsWith("Summary claims"));
      expect(lie).toMatchObject({
        severity: "high",
        description:
          "Summary claims 3 task(s) done but 1 of the 3 task(s) the session planned or ran are done",
      });
      expect(out.grade).toBe(70);
      expect(out.evidence.some((e) => e.startsWith("honesty:"))).toBe(true);
      const review = await w.store.review.mustGet(out.reviewId as string);
      expect(review).toMatchObject({
        session_id: w.ids.session,
        task_id: null,
        verdict: "human",
        critic_model: "none",
      });
      const findings = await w.store.finding.forReview(review.id);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ task_id: null, status: "open", severity: "high" });
      const req = await w.store.humanRequest.mustGet(out.humanRequestId as string);
      expect(req).toMatchObject({
        session_id: w.ids.session,
        kind: "approval",
        project_id: w.ids.project,
        // U-033: filed for the human who owns the session's agent, so an inbox lists it.
        human_id: w.ids.human,
        options: [...SESSION_REVIEW_OPTIONS],
      });
      expect(req.change_card).toMatchObject({
        key: SESSION_REVIEW_KEY,
        review_id: review.id,
        finding_ids: [findings[0]?.id],
      });
      expect(await w.store.humanRequest.open({ humanId: w.ids.human })).toContainEqual(
        expect.objectContaining({ id: req.id }),
      );
      expect(req.steps[0]).toContain("Summary claims 3");
    } finally {
      await w.close();
    }
  });

  it("counts a task the session's runs finished even when the plan did not list it: 'Done: 1' is honest", async () => {
    const w = await world();
    try {
      const done = await w.newTask({ status: "done", title: "Unplanned but finished" });
      await w.store.run.insert({
        session_id: w.ids.session,
        task_id: done.id,
        specialist: "coder",
        model: "fake-sonnet",
      });
      await w.store.session.patch(w.ids.session, {
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: { items: [], estimateUsdMicro: 0, summary: "" },
        summary: "Done: 1.",
        status: "completed",
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
        persist: false,
      });
      expect(out.findings.map((f) => f.description)).toEqual([]);
      expect(out.verdict).toBe("accept");
      expect(out.summary).toContain("1 done task(s) (0/0 planned)");
      const data = await loadSessionReviewData(w.store, w.ids.session);
      expect(sessionChecks(data).metrics).toMatchObject({
        plannedTasks: 0,
        plannedDoneTasks: 0,
        doneTasks: 1,
        claimedDone: 1,
      });
      // A claim that matches neither the planned nor the overall count is still a lie.
      await w.store.session.patch(w.ids.session, { summary: "Done: 2." });
      const lie = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
        persist: false,
      });
      expect(lie.verdict).toBe("human");
      expect(lie.findings[0]?.description).toBe(
        "Summary claims 2 task(s) done but 1 of the 1 task(s) the session planned or ran are done",
      );
    } finally {
      await w.close();
    }
  });

  it("grades plan quality: an estimate over the budget, a missing task and a draft item are findings", async () => {
    const w = await world();
    try {
      const draft = await w.newTask({ status: "draft", title: "Draft thing" });
      await w.store.session.patch(w.ids.session, {
        budget_cap_usd_micro: 1_000_000,
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [
            { taskId: draft.id, title: draft.title, estimateUsdMicro: 900_000 },
            { taskId: "task-that-does-not-exist", title: "Ghost", estimateUsdMicro: 400_000 },
          ],
          estimateUsdMicro: 1_300_000,
          summary: "",
        },
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
        persist: false,
      });
      const descriptions = out.findings.map((f) => f.description);
      expect(descriptions).toContainEqual(
        expect.stringContaining("Plan estimate USD 1.3000 exceeded the session budget USD 1.0000"),
      );
      expect(descriptions).toContainEqual(
        expect.stringContaining("Plan item references a task that does not exist: Ghost"),
      );
      expect(descriptions).toContainEqual(
        expect.stringContaining("Plan item was not a ready task: Draft thing"),
      );
      expect(out.verdict).toBe("revise");
      expect(out.reviewId).toBeUndefined();
      expect(await w.store.review.count()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it("grades cost efficiency: actual spend far over the estimate, and cost per done task", async () => {
    const w = await world();
    try {
      const a = await w.newTask({ status: "done", title: "A" });
      const b = await w.newTask({ status: "done", title: "B" });
      await w.store.session.patch(w.ids.session, {
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [
            { taskId: a.id, estimateUsdMicro: 50_000 },
            { taskId: b.id, estimateUsdMicro: 50_000 },
          ],
          estimateUsdMicro: 100_000,
          summary: "",
        },
        summary: "Done: 2.",
        status: "completed",
      });
      const actual = Math.round(100_000 * COST_OVERRUN_RATIO) + 50_000;
      for (const usd of [actual / 2, actual / 2]) {
        await w.store.costLedger.record({
          human_id: w.ids.human,
          session_id: w.ids.session,
          kind: "api",
          usd_micro: usd,
          chf_micro: usd,
          rate_chf_per_usd: 1,
          model: "fake-sonnet",
        });
      }
      const data = await loadSessionReviewData(w.store, w.ids.session);
      const checks = sessionChecks(data);
      expect(checks.metrics).toMatchObject({
        plannedTasks: 2,
        doneTasks: 2,
        estimateUsdMicro: 100_000,
        actualUsdMicro: actual,
        costPerDoneTaskUsdMicro: actual / 2,
        claimedDone: 2,
      });
      expect(checks.findings.map((f) => f.description)).toEqual([
        expect.stringMatching(
          /^Session cost USD 0\.2000 exceeded its estimate USD 0\.1000 by 100%/,
        ),
      ]);
      expect(checks.verdict).toBe("revise");
      expect(checks.grade).toBe(85);
    } finally {
      await w.close();
    }
  });

  it("a session whose every planned task failed, spending nothing, is not graded 100 (U-017)", async () => {
    const w = await world();
    try {
      const a = await w.newTask({ status: "failed", title: "Confirm the stack" });
      await w.store.session.patch(w.ids.session, {
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [{ taskId: a.id, title: a.title, estimateUsdMicro: 200_000 }],
          estimateUsdMicro: 200_000,
          summary: "",
        },
        summary: "Done: 0. Failed: 1.",
        status: "completed",
        spent_usd_micro: 0,
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out.grade).toBeLessThan(100);
      expect(out.findings.map((f) => f.description)).toEqual([
        "No planned task was done: 1 of 1 failed",
      ]);
      // The runner reports the review itself; the critic's own event is its measurements.
      const types = (await w.store.event.list(w.ids.session)).map((e) => e.type);
      expect(types).toContain("critic.session_review_metrics");
      expect(types).not.toContain("critic.session_review");
    } finally {
      await w.close();
    }
  });

  it("a task finished after the session ended does not make its summary a lie", () => {
    // Release scenario 1 (a good day): the summary said "Done: 2" at the session's end; by the
    // time the review ran, a later session had finished a third planned task. Counting task
    // states at review time called that summary dishonest and, once U-033 filed the request for
    // the person, put a false "needs your eyes" card in the Inbox after a normal session.
    const ended = "2026-11-03T05:00:00.000Z";
    const task = (id: string, status: string, updated_at: string) =>
      [id, { id, status, updated_at, title: id }] as const;
    const data = {
      session: {
        status: "completed",
        ended_at: ended,
        budget_cap_usd_micro: 1_000_000,
        summary:
          "Session completed. Done: 2. In review: 0. Not started: 2 of 4 planned. Spent $0.01.",
      },
      planItems: ["a", "b", "c", "d"].map((taskId) => ({ taskId, estimateUsdMicro: 50_000 })),
      planEstimateUsdMicro: 200_000,
      tasks: new Map([
        task("a", "done", "2026-11-03T03:00:00.000Z"),
        task("b", "done", "2026-11-03T04:00:00.000Z"),
        task("c", "done", "2026-11-03T08:00:00.000Z"),
        task("d", "ready", "2026-11-02T20:00:00.000Z"),
      ]),
      runs: [],
      ledgerUsdMicro: 13_591,
    } as never;
    const checks = sessionChecks(data);
    expect(checks.verdict).not.toBe("human");
    expect(checks.findings.map((f) => f.description).join(" | ")).not.toMatch(/Summary claims/);
    // A count that matches neither the end of the session nor now is still a lie.
    const lying = {
      ...(data as object),
      session: { ...(data as { session: object }).session, summary: "Done: 4. Spent $0.01." },
    } as never;
    expect(sessionChecks(lying).verdict).toBe("human");
  });

  it("a planned task a peer finished before the session is not the session's to count", () => {
    // Release scenario 1: Bob finished "Shared config module"; Alice's session picked the change
    // up and ran two other tasks. Its summary says "Done: 2", the tasks its own runs finished.
    const at = "2026-11-03T05:00:00.000Z";
    const task = (id: string, status: string) =>
      [id, { id, status, updated_at: at, title: id }] as const;
    const data = {
      session: {
        status: "completed",
        ended_at: at,
        budget_cap_usd_micro: 1_000_000,
        summary: "Session completed. Done: 2. Needs you: 1. Spent $0.01.",
      },
      planItems: ["peer", "a", "b", "c"].map((taskId) => ({ taskId, estimateUsdMicro: 50_000 })),
      planEstimateUsdMicro: 200_000,
      tasks: new Map([
        task("peer", "done"),
        task("a", "done"),
        task("b", "done"),
        task("c", "needs_human"),
      ]),
      runs: ["a", "b", "c"].map((task_id) => ({ task_id, session_id: "s" })),
      ledgerUsdMicro: 13_591,
    } as never;
    expect(sessionChecks(data).verdict).not.toBe("human");
  });

  it("reads a CHF amount in the summary and checks it against the ledger's CHF (U-074)", async () => {
    expect(parseSummaryClaims("Done: 1. Failed: 0. Spent CHF 1'204.50.")).toMatchObject({
      done: 1,
      costChfMicro: 1_204_500_000,
    });
    const w = await world();
    try {
      const a = await w.newTask({ status: "done", title: "A" });
      await w.store.session.patch(w.ids.session, {
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [{ taskId: a.id, title: a.title, estimateUsdMicro: 300_000 }],
          estimateUsdMicro: 300_000,
          summary: "",
        },
        summary: "Session completed. Done: 1. Spent CHF 5.00.",
        status: "completed",
      });
      await w.store.costLedger.record({
        human_id: w.ids.human,
        session_id: w.ids.session,
        kind: "api",
        usd_micro: 300_000,
        chf_micro: 240_000,
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out.findings.map((f) => f.description)).toContain(
        "Summary claims a cost of CHF 5.00 but the ledger shows CHF 0.24",
      );
      // The review's own summary, read in the log and the Inbox, says CHF too.
      expect(out.summary).toContain("cost CHF 0.24 against an estimate of CHF 0.24");
      expect(out.summary).not.toContain("USD");
    } finally {
      await w.close();
    }
  });

  it("a session whose only planned task was sent back by the critic is not graded 100 (U-072)", async () => {
    const w = await world();
    try {
      // After a revise the task is back to ready; the session's handoff names it as sent back.
      const a = await w.newTask({ status: "ready", title: "Add clamp" });
      await w.store.session.patch(w.ids.session, {
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [{ taskId: a.id, title: a.title, estimateUsdMicro: 200_000 }],
          estimateUsdMicro: 200_000,
          summary: "",
        },
        summary:
          "Session completed. Done: 0. Failed: 0. Needs you: 0. Sent back by the critic: 1. In review: 0. Not started: 0 of 1 planned.",
        handoff: { done: [], sent_back: [a.id], blocked: [] },
        status: "completed",
        spent_usd_micro: 0,
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out.grade).toBe(85);
      expect(out.findings.map((f) => f.description)).toEqual([
        "No planned task was done: 1 of 1 sent back by the critic",
      ]);
      expect(out.findings[0]?.requiredAction).toBe(
        "Address the critic's findings on each task sent back before planning it again",
      );
    } finally {
      await w.close();
    }
  });

  it("a session with one task failed and one sent back names both in one finding (U-072)", async () => {
    const w = await world();
    try {
      const a = await w.newTask({ status: "failed", title: "Confirm the stack" });
      const b = await w.newTask({ status: "ready", title: "Add clamp" });
      await w.store.session.patch(w.ids.session, {
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [a, b].map((t) => ({ taskId: t.id, title: t.title, estimateUsdMicro: 100_000 })),
          estimateUsdMicro: 200_000,
          summary: "",
        },
        summary: "Done: 0. Failed: 1.",
        handoff: { sent_back: [b.id] },
        status: "completed",
        spent_usd_micro: 0,
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out.grade).toBe(85);
      expect(out.findings.map((f) => f.description)).toEqual([
        "No planned task was done: 1 of 2 failed, 1 sent back by the critic",
      ]);
    } finally {
      await w.close();
    }
  });

  it("an honest, in-budget session is accepted with grade 100 and no finding", async () => {
    const w = await world();
    try {
      const a = await w.newTask({ status: "done", title: "A" });
      await w.store.session.patch(w.ids.session, {
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [{ taskId: a.id, title: "A", estimateUsdMicro: 200_000 }],
          estimateUsdMicro: 200_000,
          summary: "",
        },
        summary: "Done: 1 (A merged). Cost: USD 0.18.",
        status: "completed",
        spent_usd_micro: 180_000,
      });
      const out = await reviewSession({
        store: w.store,
        sessionId: w.ids.session,
        criticAgentId: w.ids.critic,
      });
      expect(out).toMatchObject({ verdict: "accept", grade: 100, findings: [], confidence: 0.95 });
      expect(out.evidence.find((e) => e.startsWith("cost:"))).toContain("session counter");
      expect(await w.store.review.count()).toBe(1);
    } finally {
      await w.close();
    }
  });

  it("CriticService.review with a session subject at tier 0 runs the deterministic checks without a model", async () => {
    const w = await world();
    try {
      await w.store.session.patch(w.ids.session, {
        summary: "Done: 9.",
        status: "completed",
        spent_usd_micro: 5,
      });
      const out = await w.critic.review(
        {
          subject: { kind: "session", sessionId: w.ids.session },
          tier: 0,
          evidence: { acceptanceCriteria: [] },
        },
        w.ctx(),
      );
      expect(out.model).toBe("none");
      expect(out.tier).toBe(0);
      expect(out.verdict).toBe("human");
      expect(w.provider.calls).toHaveLength(0);
      expect(out.findings.some((f) => f.description.includes("without a plan"))).toBe(true);
    } finally {
      await w.close();
    }
  });
});
