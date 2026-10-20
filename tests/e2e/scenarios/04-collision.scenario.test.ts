/**
 * Scenario 4, "Collision" (spec, Phase 8): "Both agents try to take the same task. One wins the
 * claim, the other messages and moves on."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. Two ready tasks; Alice and Bob
 * start a session at the same moment and both plan the same first task. The scenario makes the
 * race deterministic with holds, in both halves: both planners wait with their plans made (both
 * name the same first task), Alice is released first and claims it, Bob is released once she
 * holds the claim, Alice's specialist waits until Bob has started the next task, and Bob's
 * specialist on that task waits until Alice's session has ended, so she finds his claim when
 * she reaches it and the second skip is pinned to the same reason as the first. The claim
 * itself, the peer overlap check, the message to the holder, the move to the next task and the
 * clean end are the production runner's. Asserted on task rows, run rows, messages, events,
 * audit rows and the git host: one run and one PR per task, no duplicate work, both sessions
 * completed.
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coderOn, coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";
import { specialistTurn } from "../src/world.ts";

const START = "2026-11-03T08:00:00Z"; // 09:00 Europe/Zurich

describe("scenario 4: collision", () => {
  let w: ScenarioWorld;
  beforeAll(async () => {
    w = await scenarioWorld({ start: START });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("both agents try to take the same task: one wins the claim, the other messages the holder and moves on; no duplicate work; both sessions end cleanly", async () => {
    const TA = "Rate limiter";
    const TB = "Retry policy";
    w.provider.pushReplies(
      ...coderWrites(TA, { "src/rate-limit.ts": "export const limit = 100;\n" }),
      ...coderWrites(TB, { "src/retry.ts": "export const retries = 3;\n" }),
      ...criticAccepts(),
    );
    const tA = await w.addTask({
      title: TA,
      outcome: "src/rate-limit.ts exports the limit",
      priority: 90,
    });
    const tB = await w.addTask({
      title: TB,
      outcome: "src/retry.ts exports the retry count",
      priority: 80,
    });

    // Both plan the same two tasks; Alice claims first; Bob goes on only once she holds the
    // claim; Alice works only after Bob moved on to tB; Bob works on tB only after Alice's
    // session ended, so she meets his claim on tB.
    const alicePlans = w.holdPlan(w.alice);
    const bobPlans = w.holdPlan(w.bob);
    const aliceWorks = w.holdModelCalls((req) => specialistTurn(req) && coderOn(TA)(req));
    const bobWorks = w.holdModelCalls((req) => specialistTurn(req) && coderOn(TB)(req));
    const aliceClaimed = w.waitForEvent(w.alice, "task.started", (e) => e.payload.taskId === tA.id);
    const bobMovedOn = w.waitForEvent(w.bob, "task.started", (e) => e.payload.taskId === tB.id);

    const aliceRun = w.runSession(w.alice);
    const bobRun = w.runSession(w.bob);
    const [alicePlanCtx, bobPlanCtx] = await Promise.all([alicePlans.waiting, bobPlans.waiting]);
    expect(alicePlanCtx.readyTasks.map((t) => t.id)).toEqual([tA.id, tB.id]);
    expect(bobPlanCtx.readyTasks.map((t) => t.id)).toEqual([tA.id, tB.id]);
    alicePlans.release();
    await aliceClaimed;
    const claimedRow = await w.store.task.mustGet(tA.id);
    expect(claimedRow.claimed_by).toBe(w.alice.agent.id);
    expect(claimedRow.status).toBe("in_progress");
    bobPlans.release();
    await bobMovedOn;
    await bobWorks.waiting;
    const bobClaim = await w.store.task.mustGet(tB.id);
    expect(bobClaim.claimed_by).toBe(w.bob.agent.id);
    expect(bobClaim.status).toBe("in_progress");
    aliceWorks.release();
    const alice = await aliceRun;
    expect(await w.store.session.active(w.alice.agent.id)).toEqual([]);
    bobWorks.release();
    const bob = await bobRun;

    // --- Clause: both agents tried to take the same task --------------------------------------
    const aliceEvents = await w.eventsOf(alice.sessionId);
    const bobEvents = await w.eventsOf(bob.sessionId);
    expect(alice.plan?.items.map((i) => i.taskId)).toEqual([tA.id, tB.id]);
    expect(bob.plan?.items.map((i) => i.taskId)).toEqual([tA.id, tB.id]);
    expect(alice.brief.tasks.readyCount).toBe(2);
    expect(bob.brief.tasks.readyCount).toBe(2);

    // --- Clause: one wins the claim ---------------------------------------------------------
    const aliceStarted = aliceEvents.filter((e) => e.type === "task.started");
    expect(aliceStarted.map((e) => (e.payload as { taskId: string }).taskId)).toEqual([tA.id]);
    const claimReason = (await w.store.task.mustGet(tA.id)).owner_agent_id;
    expect(claimReason).toBe(w.alice.agent.id);

    // --- Clause: the other messages the holder and moves on -----------------------------------
    const overlap = bobEvents.find((e) => e.type === "peer.overlap")?.payload as {
      kind: string;
      peerId: string;
      taskId: string;
      plannedTaskId: string;
    };
    expect(overlap).toMatchObject({
      kind: "task_claimed",
      peerId: w.alice.agent.id,
      taskId: tA.id,
      plannedTaskId: tA.id,
    });
    const skipped = bobEvents.find(
      (e) => e.type === "task.skipped" && (e.payload as { taskId: string }).taskId === tA.id,
    );
    expect(skipped?.payload).toMatchObject({ reason: "held_by", holder: w.alice.agent.id });
    const note = (await w.inbox(w.alice)).find(
      (m) => m.type === "info" && m.from_agent_id === w.bob.agent.id && m.task_id === tA.id,
    );
    expect(note).toBeDefined();
    expect(note?.body).toContain(`"${TA}"`);
    expect(note?.body).toContain("you hold the claim; I moved on");
    expect(
      (note?.created_at ?? "") <=
        (bobEvents.find((e) => e.type === "task.started")?.created_at ?? ""),
    ).toBe(true);
    // Alice read it at her next inbox check, between her tasks.
    expect(note?.read_at).toBeTruthy();
    expect(
      aliceEvents.some(
        (e) => e.type === "inbox.message" && (e.payload as { id?: string }).id === note?.id,
      ),
    ).toBe(true);
    expect(bob.skipped).toContain(tA.id);
    expect(bob.completed).toEqual([tB.id]);
    expect(
      bobEvents
        .filter((e) => e.type === "task.started")
        .map((e) => (e.payload as { taskId: string }).taskId),
    ).toEqual([tB.id]);
    // The same the other way round: Alice found Bob's claim on tB when she got to it (the feed
    // is rebuilt before every task), told him and left it alone; his session had no task after
    // tB, so her note waits in his inbox for his next session.
    expect(alice.completed).toEqual([tA.id]);
    expect(alice.skipped).toEqual([tB.id]);
    const aliceOverlap = aliceEvents.find((e) => e.type === "peer.overlap")?.payload;
    expect(aliceOverlap).toMatchObject({
      kind: "task_claimed",
      peerId: w.bob.agent.id,
      taskId: tB.id,
      plannedTaskId: tB.id,
    });
    const aliceSkip = aliceEvents.find(
      (e) => e.type === "task.skipped" && (e.payload as { taskId: string }).taskId === tB.id,
    )?.payload;
    expect(aliceSkip).toMatchObject({ reason: "held_by", holder: w.bob.agent.id });
    const aliceNote = (await w.inbox(w.bob)).find(
      (m) => m.type === "info" && m.from_agent_id === w.alice.agent.id && m.task_id === tB.id,
    );
    expect(aliceNote?.body).toContain(`"${TB}"`);
    expect(aliceNote?.body).toContain("you hold the claim; I moved on");
    const bobStartedB = bobEvents.find(
      (e) => e.type === "task.started" && (e.payload as { taskId: string }).taskId === tB.id,
    );
    expect((aliceNote?.created_at ?? "") >= (bobStartedB?.created_at ?? "z")).toBe(true);
    expect(
      (aliceNote?.created_at ?? "z") <=
        ((await w.store.session.mustGet(alice.sessionId)).ended_at ?? ""),
    ).toBe(true);

    // --- Clause: no duplicate work ------------------------------------------------------------
    for (const [task, agentId] of [
      [tA, w.alice.agent.id],
      [tB, w.bob.agent.id],
    ] as const) {
      const runs = (await w.store.run.forTask(task.id)).filter((r) => r.specialist === "coder");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.author_agent).toBe(agentId);
      expect(runs[0]?.outcome).toBe("completed");
      const row = await w.store.task.mustGet(task.id);
      expect(row.status).toBe("done");
      expect(row.owner_agent_id).toBe(agentId);
      expect(row.claimed_by).toBeNull();
      expect(row.pr_url).toBeTruthy();
      expect((await w.store.review.forTask(task.id)).map((r) => r.verdict)).toEqual(["accept"]);
    }
    const prs = await w.pullRequests({ state: "open" });
    expect(prs).toHaveLength(2);
    expect(new Set(prs.map((p) => p.head.ref)).size).toBe(2);
    expect(prs.map((p) => p.title).sort()).toEqual([TA, TB].sort());
    const writes = (await w.auditRows({ tool: "write_file" })).filter((r) => r.allowed);
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((r) => r.agent_id))).toEqual(
      new Set([w.alice.agent.id, w.bob.agent.id]),
    );

    // --- Clause: both sessions end cleanly ----------------------------------------------------
    for (const [result, install] of [
      [alice, w.alice],
      [bob, w.bob],
    ] as const) {
      expect(result.status).toBe("completed");
      expect(result.stopReason).toBe("completed");
      const row = await w.store.session.mustGet(result.sessionId);
      expect(row.status).toBe("completed");
      expect(row.ended_at).toBeTruthy();
      expect(row.handoff).toMatchObject({ stop_reason: "completed" });
      const ended = (await w.eventsOf(result.sessionId)).find((e) => e.type === "session.ended");
      expect(ended?.payload).toMatchObject({ status: "completed", stopReason: "completed" });
      expect(
        (await w.auditRows({ sessionId: result.sessionId })).filter((r) => !r.allowed),
      ).toHaveLength(0);
      expect(await w.store.task.claimedBy(install.agent.id)).toEqual([]);
      expect(await w.store.session.active(install.agent.id)).toEqual([]);
    }
    const handoffs = await w.store.message.list({ type: "handoff" });
    expect(handoffs).toHaveLength(2);
    expect(handoffs.every((m) => m.requires_ack)).toBe(true);
    expect(new Set(handoffs.map((m) => m.to_agent_id))).toEqual(
      new Set([w.alice.agent.id, w.bob.agent.id]),
    );
    const summaries = [await w.inbox(w.j), await w.inbox(w.m)].map((box) =>
      box.filter((m) => m.type === "info"),
    );
    expect(summaries[0]?.[0]?.body).toMatch(/^Session completed\. Done: 1\./);
    expect(summaries[1]?.[0]?.body).toMatch(/^Session completed\. Done: 1\./);
    expect(summaries[0]?.[0]?.body).toContain("Not started: 1 of 2 planned");
    expect(summaries[1]?.[0]?.body).toContain("Not started: 1 of 2 planned");
  }, 90_000);
});
