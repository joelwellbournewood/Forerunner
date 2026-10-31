import { SIGNOFF_OPTIONS, signoffCard } from "@forerunner/critic";
import { requestView } from "@forerunner/runtime/daemon/views";
import {
  fileBlockedByFindingsRequest,
  syncBlockedByFindings,
  syncSignoffAnswers,
} from "@forerunner/runtime/session/findings";
import { StateApprovals } from "@forerunner/runtime/wiring/state-ports";
import type { HumanRequestRow, TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeviceClient, type Harness, harness, json } from "./helpers.ts";

/**
 * U-027: Approve and Reject in the phone's Reviews tab answer the task's open approval request.
 * The route answered `{ decision, comment, reviewId }`, which no reader reads (they read the
 * option a click sends: `choice`/`answer` or the string itself), so a sign-off or findings card
 * ended `unrecognized_answer` with the task stranded and a tool approval was denied, while the
 * phone said the session continues. Each case here answers through the route exactly as the
 * phone does, then runs the runtime's own reader and asserts the outcome the button names.
 */
describe("a review verdict from the phone acts like the matching Inbox option (U-027)", () => {
  let h: Harness;
  let phone: DeviceClient;

  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(async () => {
    await h.close();
  });

  /** A task in the state its card waits in, with a critic review the phone lists. */
  async function reviewedTask(status: TaskRow["status"]) {
    const task = await h.store.task.insert({
      project_id: h.seed.project.id,
      title: "Payment webhook",
      outcome: "Webhook handled",
      status,
      risk_tier: 3,
      priority: 5,
      owner_agent_id: h.seed.alice.id,
    });
    const review = await h.store.review.insert({
      task_id: task.id,
      session_id: h.seed.session.id,
      critic_model: "fake-opus",
      tier: 3,
      grade: 80,
      confidence: 0.8,
      verdict: "human",
      summary: "Needs a person's sign-off",
    });
    const finding = await h.store.finding.insert({
      review_id: review.id,
      task_id: task.id,
      severity: "medium",
      description: "No retry on a 500",
      required_action: "Add a retry",
    });
    return { task, review, finding };
  }

  /** The critic's sign-off card on a task in `needs_human`, as `loop/critic.ts` files it. */
  async function signoff() {
    const r = await reviewedTask("needs_human");
    const request = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      task_id: r.task.id,
      session_id: h.seed.session.id,
      kind: "approval",
      why: "Tier 3 sign-off: Needs a person's sign-off",
      steps: ["Add a retry"],
      options: [...SIGNOFF_OPTIONS],
      blocking: true,
      risk: "medium",
      change_card: signoffCard({
        taskId: r.task.id,
        reviewId: r.review.id,
        runId: null,
        findingIds: [r.finding.id],
        reason: "verdict",
      }),
      author_agent: h.seed.alice.id,
    });
    return { ...r, request };
  }

  /** The findings card on a task in review whose close an open finding refused. */
  async function blocked() {
    const r = await reviewedTask("in_review");
    const { request } = await fileBlockedByFindingsRequest({
      store: h.store,
      task: r.task,
      session: { id: h.seed.session.id },
      humanId: h.seed.ada.id,
      agentId: h.seed.alice.id,
      runId: null,
      findings: [r.finding],
      path: "tier0",
    });
    return { ...r, request };
  }

  /** A tool approval the hooks filed for the task (`StateApprovals`). */
  async function toolApproval() {
    const r = await reviewedTask("in_progress");
    const approvals = new StateApprovals(h.store);
    const ask = {
      sessionId: h.seed.session.id,
      runId: "run-1",
      agentId: h.seed.alice.id,
      humanId: h.seed.ada.id,
      projectId: h.seed.project.id,
      taskId: r.task.id,
      tool: "Bash",
      actionClass: "external_write",
      risk: "medium" as const,
      why: "Push the branch",
      input: { command: "git push origin feature" },
    };
    expect(await approvals.request(ask)).toBe("pending");
    const [request] = (await h.store.humanRequest.open({ projectId: h.seed.project.id })).filter(
      (q) => q.task_id === r.task.id,
    );
    return { ...r, request: request as HumanRequestRow, outcome: () => approvals.request(ask) };
  }

  /** The verdict exactly as the phone sends it: the comment and the version of the card it shows. */
  async function verdict(reviewId: string, v: "approve" | "reject", request: HumanRequestRow) {
    const res = await phone.post(`/reviews/${reviewId}/${v}`, {
      body: "from the phone",
      requestVersion: request.version,
    });
    expect(res.status).toBe(200);
    const out = await json<{ answeredRequestId: string | null }>(res);
    // What the phone reads to say "the waiting session continues".
    expect(out.answeredRequestId).toBe(request.id);
    const answered = await h.store.humanRequest.mustGet(request.id);
    expect(answered.status).toBe("answered");
    // The stored answer is a button of the card as the Inbox shows it, as a click stores it.
    expect(requestView(request, null).options).toContain(answered.answer);
    return answered;
  }

  const sync = {
    signoffs: () =>
      syncSignoffAnswers({
        store: h.store,
        clock: h.clock,
        humanId: h.seed.ada.id,
        agentId: h.seed.alice.id,
      }),
    findings: () =>
      syncBlockedByFindings({
        store: h.store,
        clock: h.clock,
        humanId: h.seed.ada.id,
        agentId: h.seed.alice.id,
      }),
  };

  it("sign-off card: Approve accepts the work and the task is done", async () => {
    const s = await signoff();
    const answered = await verdict(s.review.id, "approve", s.request);
    expect(answered.answer).toBe("accept");
    expect(await sync.signoffs()).toMatchObject({ accepted: 1, skipped: 0 });
    expect((await h.store.task.mustGet(s.task.id)).status).toBe("done");
    expect(await h.store.finding.openFor(s.task.id)).toEqual([]);
  });

  it("sign-off card: Reject sends the work back and the task is ready for a rework", async () => {
    const s = await signoff();
    const answered = await verdict(s.review.id, "reject", s.request);
    expect(answered.answer).toBe("revise");
    expect(await sync.signoffs()).toMatchObject({ revised: 1, skipped: 0 });
    expect((await h.store.task.mustGet(s.task.id)).status).toBe("ready");
  });

  it("findings card: Approve accepts the findings as resolved and the task is done", async () => {
    const b = await blocked();
    const answered = await verdict(b.review.id, "approve", b.request);
    expect(answered.answer).toBe("accept");
    expect(await sync.findings()).toMatchObject({ accepted: 1, skipped: 0 });
    expect((await h.store.task.mustGet(b.task.id)).status).toBe("done");
    expect(await h.store.finding.openFor(b.task.id)).toEqual([]);
  });

  it("findings card: Reject reworks the task", async () => {
    const b = await blocked();
    const answered = await verdict(b.review.id, "reject", b.request);
    expect(answered.answer).toBe("rework");
    expect(await sync.findings()).toMatchObject({ reworked: 1, skipped: 0 });
    expect((await h.store.task.mustGet(b.task.id)).status).toBe("ready");
  });

  it("tool approval: Approve approves the call", async () => {
    const t = await toolApproval();
    const answered = await verdict(t.review.id, "approve", t.request);
    expect(answered.answer).toBe("yes");
    expect(await t.outcome()).toBe("approved");
  });

  it("tool approval: Reject denies the call", async () => {
    const t = await toolApproval();
    const answered = await verdict(t.review.id, "reject", t.request);
    expect(answered.answer).toBe("no");
    expect(await t.outcome()).toBe("denied");
  });
});
