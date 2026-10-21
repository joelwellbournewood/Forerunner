import { SIGNOFF_KEY, SIGNOFF_OPTIONS } from "@forerunner/critic";
import type { HumanRequestRow, StateStore, TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  SIGNOFF_AUDIT_TOOL,
  type SignoffSyncResult,
  signoffAnswer,
  syncSignoffAnswers,
} from "../src/session/findings.ts";
import {
  closingReply,
  doneExecutor,
  type LoopWorld,
  loopWorld,
  submitReply,
} from "./loop-helpers.ts";

/**
 * The answer to a critic sign-off (spec H.2: tier 3 is a deep review plus human sign-off;
 * follow-up RT-P5-1 of the phase 5 gate). The critic loop's `human` decision moves the task
 * to `needs_human` and files one blocking request with the options accept / revise / cancel;
 * `syncSignoffAnswers`, run from `RuntimeApp.syncApprovals`, applies the inbox's answer:
 * accept closes the task with the review's findings resolved against the run, revise sends
 * it down the retry ladder (`failed -> ready`, the attempt counted, the findings kept open as
 * the next brief's constraints), cancel cancels it. Every answer is applied once, recorded on
 * the request's card and as an audit row; a task the human moved on in the meantime and an
 * answer outside the options are skipped and recorded as such.
 */
const NONE: SignoffSyncResult = { accepted: 0, revised: 0, cancelled: 0, skipped: 0 };

interface Signoff {
  w: LoopWorld;
  task: TaskRow;
  request: HumanRequestRow;
  runId: string;
}

/** A tier 3 task through the critic loop on the fake provider: the sign-off waits for J. */
async function signoff(
  review: Parameters<typeof submitReply>[0] = { grade: 97 },
  title = "Payment webhook",
): Promise<Signoff> {
  const w = await loopWorld({ replies: [submitReply(review), closingReply()] });
  const task = await w.addTask(title, { risk_tier: 3 });
  const result = await w.start(w.runner(doneExecutor(w)));
  expect(result.needsHuman).toEqual([task.id]);
  expect(result.reviews[0]).toMatchObject({ tier: 3, verdict: "human", decision: "human" });
  const request = await signoffRequestOf(w, task.id);
  expect(request).toMatchObject({
    kind: "approval",
    blocking: true,
    status: "open",
    task_id: task.id,
    options: [...SIGNOFF_OPTIONS],
  });
  expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
  return { w, task, request, runId: `run-${task.id}-0` };
}

/** The one open sign-off request of a task (its card is keyed `SIGNOFF_KEY`). */
async function signoffRequestOf(w: LoopWorld, taskId: string): Promise<HumanRequestRow> {
  const open = (await w.store.humanRequest.open({ humanId: w.human })).filter(
    (r) => r.task_id === taskId && card(r).key === SIGNOFF_KEY,
  );
  expect(open).toHaveLength(1);
  return open[0] as HumanRequestRow;
}

async function answer(s: Signoff, text: string): Promise<SignoffSyncResult> {
  const current = await s.w.store.humanRequest.mustGet(s.request.id);
  await s.w.store.humanRequest.answer(current.id, current.version, text, s.w.human);
  return syncSignoffAnswers({
    store: s.w.store,
    clock: s.w.clock,
    humanId: s.w.human,
    agentId: s.w.alice,
  });
}

function card(r: HumanRequestRow): Record<string, unknown> {
  return (r.change_card ?? {}) as Record<string, unknown>;
}

describe("critic sign-off answers", () => {
  it("the sign-off request carries a card the sync recognises: the task, the review, the run and the findings", async () => {
    const s = await signoff({
      grade: 60,
      verdict: "revise",
      summary: "One gap.",
      findings: [{ severity: "major", what: "No retry", required_action: "Add a retry" }],
    });
    const c = card(s.request);
    expect(c.key).toBe(SIGNOFF_KEY);
    expect(c).toMatchObject({ task_id: s.task.id, run_id: s.runId, reason: "verdict" });
    expect(c.applied_at).toBeNull();
    const findings = await s.w.store.finding.openFor(s.task.id);
    expect(findings).toHaveLength(1);
    expect(c.finding_ids).toEqual(findings.map((f) => f.id));
    expect(typeof c.review_id).toBe("string");
    await s.w.close();
  });

  it("accept: the task is done, the review's findings are resolved against the run, the card and the audit log record it, and the answer is applied once", async () => {
    const s = await signoff({
      grade: 60,
      verdict: "revise",
      summary: "One gap.",
      findings: [{ severity: "major", what: "No retry", required_action: "Add a retry" }],
    });
    expect(await answer(s, "accept")).toEqual({ ...NONE, accepted: 1 });
    const after = await s.w.store.task.mustGet(s.task.id);
    expect(after.status).toBe("done");
    expect(after.attempt).toBe(0);
    expect(after.author_human).toBe(s.w.human);
    expect(after.reason).toContain(s.request.id);
    expect(await s.w.store.finding.openFor(s.task.id)).toEqual([]);
    const resolved = await s.w.store.finding.forReview(card(s.request).review_id as string);
    expect(resolved.map((f) => [f.status, f.resolved_by_run])).toEqual([["resolved", s.runId]]);
    const c = card(await s.w.store.humanRequest.mustGet(s.request.id));
    expect(c.outcome).toBe("accept");
    expect(typeof c.applied_at).toBe("string");
    const audit = (await s.w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      allowed: true,
      human_id: s.w.human,
      agent_id: s.w.alice,
      run_id: s.runId,
      cost_usd_micro: 0,
    });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toEqual({
      requestId: s.request.id,
      taskId: s.task.id,
      answer: "accept",
    });
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toMatchObject({
      outcome: "accept",
      status: "done",
      resolvedFindings: 1,
    });
    // Applied once: a second sync finds nothing to do.
    expect(
      await syncSignoffAnswers({
        store: s.w.store,
        clock: s.w.clock,
        humanId: s.w.human,
        agentId: s.w.alice,
      }),
    ).toEqual(NONE);
    expect(
      (await s.w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL),
    ).toHaveLength(1);
    await s.w.close();
  });

  it("accept of a clean tier 3 review (no finding) closes the task", async () => {
    const s = await signoff({ grade: 97 });
    expect(card(s.request).finding_ids).toEqual([]);
    expect(await answer(s, "Accepted")).toEqual({ ...NONE, accepted: 1 });
    expect((await s.w.store.task.mustGet(s.task.id)).status).toBe("done");
    await s.w.close();
  });

  it("revise: the task goes down the retry ladder (failed -> ready, the attempt counted), the findings stay open and the owner agent is told", async () => {
    const s = await signoff({
      grade: 60,
      verdict: "revise",
      summary: "One gap.",
      findings: [{ severity: "major", what: "No retry", required_action: "Add a retry" }],
    });
    expect(await answer(s, "revise")).toEqual({ ...NONE, revised: 1 });
    const after = await s.w.store.task.mustGet(s.task.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(1);
    expect(after.claimed_by).toBeNull();
    const open = await s.w.store.finding.openFor(s.task.id);
    expect(open.map((f) => f.description)).toEqual(["No retry"]);
    const inbox = await s.w.store.message.inbox({ agentId: s.w.alice }, { unreadOnly: true });
    const note = inbox.find((m) => m.task_id === s.task.id && m.body.includes("sign-off"));
    expect(note).toMatchObject({ type: "request", requires_ack: true });
    expect(note?.body).toContain("Add a retry");
    expect(card(await s.w.store.humanRequest.mustGet(s.request.id)).outcome).toBe("revise");
    const audit = (await s.w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL);
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toMatchObject({
      outcome: "revise",
      status: "ready",
      attempt: 1,
    });
    await s.w.close();
  });

  it("cancel: the task is cancelled", async () => {
    const s = await signoff({ grade: 97 });
    expect(await answer(s, "cancel")).toEqual({ ...NONE, cancelled: 1 });
    expect((await s.w.store.task.mustGet(s.task.id)).status).toBe("cancelled");
    expect(card(await s.w.store.humanRequest.mustGet(s.request.id)).outcome).toBe("cancel");
    await s.w.close();
  });

  it("the sign-off the retry ladder files after its last rung is applied the same way", async () => {
    const revise = () =>
      submitReply({
        grade: 40,
        verdict: "revise",
        summary: "Still wrong.",
        findings: [{ severity: "major", what: "Still wrong", required_action: "Fix it" }],
      });
    const w = await loopWorld({
      replies: [revise(), revise(), revise(), revise(), closingReply()],
      projectSettings: { critic_ceiling: "sonnet" },
    });
    const task = await w.addTask("Stubborn task");
    const runner = w.runner(doneExecutor(w));
    await w.start(runner);
    await w.start(runner);
    const r3 = await w.start(runner);
    expect(r3.reviews[0]?.decision).toBe("human");
    const request = await signoffRequestOf(w, task.id);
    expect(card(request)).toMatchObject({
      key: SIGNOFF_KEY,
      task_id: task.id,
      reason: "retry_ladder_exhausted",
      run_id: `run-${task.id}-2`,
    });
    expect((card(request).finding_ids as string[]).length).toBeGreaterThan(0);
    await w.store.humanRequest.answer(request.id, request.version, "accept", w.human);
    expect(
      await syncSignoffAnswers({
        store: w.store,
        clock: w.clock,
        humanId: w.human,
        agentId: w.alice,
      }),
    ).toEqual({ ...NONE, accepted: 1 });
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    // Every finding of the task's reviews is resolved against the last run.
    const open = await w.store.finding.openFor(task.id);
    expect(open).toEqual([]);
    const audit = (await w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL);
    expect(audit[0]?.run_id).toBe(`run-${task.id}-2`);
    await w.close();
  });

  it("a task the human moved on before the sync, and an answer outside the options, are skipped and recorded", async () => {
    const s = await signoff({ grade: 97 });
    // The human sent the task back to ready from the UI before answering the sign-off.
    const current = await s.w.store.task.mustGet(s.task.id);
    const moved = await s.w.store.task.transition(
      current.id,
      current.version,
      "ready",
      "human: try again",
      { humanId: s.w.human },
    );
    expect(moved.status).toBe("ready");
    expect(await answer(s, "accept")).toEqual({ ...NONE, skipped: 1 });
    expect((await s.w.store.task.mustGet(s.task.id)).status).toBe("ready");
    expect(card(await s.w.store.humanRequest.mustGet(s.request.id)).outcome).toBe("task_moved_on");

    const t = await signoff({ grade: 97 }, "Second webhook");
    expect(await answer(t, "maybe later")).toEqual({ ...NONE, skipped: 1 });
    expect((await t.w.store.task.mustGet(t.task.id)).status).toBe("needs_human");
    expect(card(await t.w.store.humanRequest.mustGet(t.request.id)).outcome).toBe(
      "unrecognized_answer",
    );
    expect((await t.w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL)).toEqual(
      [],
    );
    await s.w.close();
    await t.w.close();
  });

  it("a sign-off left open from an earlier review is stale once the task was reviewed again: its answer is skipped and recorded, nothing resolved; the current review's sign-off closes the task with every finding up to its review resolved against its run", async () => {
    const gap = (what: string) =>
      submitReply({
        grade: 60,
        verdict: "revise",
        summary: "One gap.",
        findings: [{ severity: "major", what, required_action: `Fix: ${what}` }],
      });
    const w = await loopWorld({
      replies: [gap("No retry"), closingReply(), gap("No timeout"), closingReply()],
    });
    const task = await w.addTask("Payment webhook", { risk_tier: 3 });
    const runner = w.runner(doneExecutor(w));
    expect((await w.start(runner)).needsHuman).toEqual([task.id]);
    const r1 = await signoffRequestOf(w, task.id);
    // J sends the task back for another attempt from the UI without answering the sign-off
    // (needs_human -> ready -> failed -> ready); the next session reviews it again and files
    // a new sign-off. The first request stays open in the inbox.
    const t1 = await w.store.task.mustGet(task.id);
    const ready = await w.store.task.transition(t1.id, t1.version, "ready", "human: again", {
      humanId: w.human,
    });
    const failed = await w.store.task.transition(ready.id, ready.version, "failed", "retry", {
      humanId: w.human,
    });
    await w.store.task.transition(failed.id, failed.version, "ready", "retry", {
      humanId: w.human,
    });
    expect((await w.start(runner)).needsHuman).toEqual([task.id]);
    const open = (await w.store.humanRequest.open({ humanId: w.human })).filter(
      (r) => r.task_id === task.id && card(r).key === SIGNOFF_KEY,
    );
    expect(open.map((r) => r.id)).toContain(r1.id);
    expect(open).toHaveLength(2);
    const r2 = open.find((r) => r.id !== r1.id) as HumanRequestRow;
    expect(card(r2).review_id).not.toBe(card(r1).review_id);
    expect(card(r2).run_id).toBe(`run-${task.id}-1`);
    expect(await w.store.finding.openFor(task.id)).toHaveLength(2);
    const sync = () =>
      syncSignoffAnswers({ store: w.store, clock: w.clock, humanId: w.human, agentId: w.alice });

    // The old card answered "accept": not the task's current review, so nothing is applied.
    await w.store.humanRequest.answer(r1.id, r1.version, "accept", w.human);
    expect(await sync()).toEqual({ ...NONE, skipped: 1 });
    expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
    expect(await w.store.finding.openFor(task.id)).toHaveLength(2);
    expect(card(await w.store.humanRequest.mustGet(r1.id)).outcome).toBe("stale");
    expect((await w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL)).toEqual(
      [],
    );
    expect((await w.store.humanRequest.mustGet(r2.id)).status).toBe("open");

    // The current card's accept closes the task: the findings of its review and of the
    // earlier one (the rework's history, open since the critic never accepted) are resolved
    // against the run the card names.
    const current = await w.store.humanRequest.mustGet(r2.id);
    await w.store.humanRequest.answer(current.id, current.version, "accept", w.human);
    expect(await sync()).toEqual({ ...NONE, accepted: 1 });
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    expect(await w.store.finding.openFor(task.id)).toEqual([]);
    const findings = await w.store.finding.list({ task_id: task.id });
    expect(findings.map((f) => [f.status, f.resolved_by_run])).toEqual([
      ["resolved", `run-${task.id}-1`],
      ["resolved", `run-${task.id}-1`],
    ]);
    const audit = (await w.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toMatchObject({
      outcome: "accept",
      status: "done",
      resolvedFindings: 2,
    });
    await w.close();
  });

  it("an accept the store refuses over a finding of a newer review, filed between the stale check and the close, is recorded findings_open: the task stays needs_human, nothing of the card's is resolved, no audit row", async () => {
    const s = await signoff({
      grade: 60,
      verdict: "revise",
      summary: "One gap.",
      findings: [{ severity: "major", what: "No retry", required_action: "Add a retry" }],
    });
    const { store } = s.w;
    // A later review of the task with an open finding lands in the instant between the
    // sync's stale check and its transaction (a critic session finishing elsewhere): the
    // card is no longer current, and the store's own rule (no open finding at close,
    // `findings_open`) is what catches it.
    let raced = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (fn: Parameters<StateStore["transaction"]>[0]) => {
            if (!raced) {
              raced = true;
              await s.w.clock.advance(60_000);
              const later = await store.review.insert({
                task_id: s.task.id,
                critic_model: "fake-opus",
                tier: 3,
                grade: 50,
                confidence: 0.9,
                verdict: "revise",
                evidence: [],
                summary: "a later review",
                author_agent: s.w.alice,
              });
              await store.finding.insert({
                review_id: later.id,
                task_id: s.task.id,
                severity: "high",
                description: "No timeout",
                required_action: "Add a timeout",
                status: "open",
                fingerprint: "fp-timeout",
                author_agent: s.w.alice,
              });
            }
            return target.transaction(fn);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as StateStore;
    const current = await store.humanRequest.mustGet(s.request.id);
    await store.humanRequest.answer(current.id, current.version, "accept", s.w.human);
    expect(
      await syncSignoffAnswers({
        store: racing,
        clock: s.w.clock,
        humanId: s.w.human,
        agentId: s.w.alice,
      }),
    ).toEqual({ ...NONE, skipped: 1 });
    expect(raced).toBe(true);
    expect((await store.task.mustGet(s.task.id)).status).toBe("needs_human");
    // The transaction rolled back: the card's own finding is open too, and nothing was audited.
    expect((await store.finding.openFor(s.task.id)).map((f) => f.description).sort()).toEqual([
      "No retry",
      "No timeout",
    ]);
    expect(card(await store.humanRequest.mustGet(s.request.id)).outcome).toBe("findings_open");
    expect((await store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL)).toEqual([]);
    // Applied once: the answer is consumed; the later review's own sign-off is the one to answer.
    expect(
      await syncSignoffAnswers({
        store,
        clock: s.w.clock,
        humanId: s.w.human,
        agentId: s.w.alice,
      }),
    ).toEqual(NONE);
    await s.w.close();
  });

  it("a sign-off answered behind more than a page of later-answered blocking requests is still applied", async () => {
    const s = await signoff({ grade: 97 });
    const current = await s.w.store.humanRequest.mustGet(s.request.id);
    await s.w.store.humanRequest.answer(current.id, current.version, "accept", s.w.human);
    // 210 blocking approvals of the human filed and answered after it, each a second later:
    // the sign-off sits behind more than one page of the newest-first scan.
    for (let i = 0; i < 210; i++) {
      await s.w.clock.advance(1_000);
      const r = await s.w.store.humanRequest.insert({
        human_id: s.w.human,
        project_id: s.w.project,
        task_id: null,
        session_id: null,
        kind: "approval",
        why: `later approval ${i}`,
        steps: [],
        options: ["yes", "no"],
        blocking: true,
        risk: "low",
        change_card: null,
        author_agent: s.w.alice,
      });
      await s.w.store.humanRequest.answer(r.id, r.version, "yes", s.w.human);
    }
    expect(
      await syncSignoffAnswers({
        store: s.w.store,
        clock: s.w.clock,
        humanId: s.w.human,
        agentId: s.w.alice,
      }),
    ).toEqual({ ...NONE, accepted: 1 });
    expect((await s.w.store.task.mustGet(s.task.id)).status).toBe("done");
    await s.w.close();
  });

  it("the answer words: the options, their synonyms and the choice object the phone sends", () => {
    expect(signoffAnswer("accept")).toBe("accept");
    expect(signoffAnswer(" Approved ")).toBe("accept");
    expect(signoffAnswer("sign off")).toBe("accept");
    expect(signoffAnswer("revise")).toBe("revise");
    expect(signoffAnswer("rework")).toBe("revise");
    expect(signoffAnswer("cancel")).toBe("cancel");
    expect(signoffAnswer("canceled")).toBe("cancel");
    expect(signoffAnswer({ choice: "accept" })).toBe("accept");
    expect(signoffAnswer({ answer: "revise" })).toBe("revise");
    expect(signoffAnswer("yes")).toBeNull();
    expect(signoffAnswer(null)).toBeNull();
    expect(signoffAnswer(["accept"])).toBeNull();
  });
});
