import { SIGNOFF_OPTIONS, signoffCard } from "@forerunner/critic";
import { requestView } from "@forerunner/runtime/daemon/views";
import { StateApprovals } from "@forerunner/runtime/wiring/state-ports";
import type { HumanRequestRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeviceClient, type Harness, harness, json } from "./helpers.ts";

/**
 * U-034 on the state service: the phone's Inbox (`POST /requests/:id/answer` and its offline
 * queue, `POST /sync/outbox`) and the approvals page answer through `answerRequestAs`, which
 * now refuses an answer a structured card cannot act on, the way the daemon does: a 400
 * `validation` whose message lists the options as the card shows them, the request left open.
 * A matching typed answer and free text on a question still go through.
 */
describe("the state service refuses an answer a structured card cannot act on (U-034)", () => {
  let h: Harness;
  let phone: DeviceClient;

  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(async () => {
    await h.close();
  });

  const signoff = () =>
    h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      task_id: h.seed.task1.id,
      kind: "approval",
      why: "Tier 3 sign-off",
      options: [...SIGNOFF_OPTIONS],
      blocking: true,
      risk: "medium",
      change_card: signoffCard({
        taskId: h.seed.task1.id,
        reviewId: null,
        runId: null,
        findingIds: [],
        reason: "verdict",
      }),
    });

  const toolApproval = async (): Promise<HumanRequestRow> => {
    await new StateApprovals(h.store).request({
      sessionId: h.seed.session.id,
      runId: "r-1",
      agentId: h.seed.alice.id,
      humanId: h.seed.ada.id,
      projectId: h.seed.project.id,
      tool: "Bash",
      actionClass: "external_write",
      risk: "low",
      why: "Push the branch",
      input: { command: "git push" },
    });
    const [row] = await h.store.humanRequest.list({ session_id: h.seed.session.id });
    return row as HumanRequestRow;
  };

  async function expectRefused(res: Response, row: HumanRequestRow) {
    expect(res.status).toBe(400);
    const body = await json<{ code: string; message: string; details: { options: string[] } }>(res);
    const shown = requestView(row, null).options;
    expect(body.code).toBe("validation");
    expect(body.message).toContain(`Choose one of: ${shown.join(", ")}`);
    expect(body.details.options).toEqual(shown);
    const after = await h.store.humanRequest.mustGet(row.id);
    expect(after.status).toBe("open");
    expect(after.version).toBe(row.version);
  }

  it("the phone: an unmatched answer on a sign-off is refused and the card stays; a typed 'accept' goes through", async () => {
    const row = await signoff();
    await expectRefused(
      await phone.post(`/requests/${row.id}/answer`, { version: row.version, answer: "looks ok" }),
      row,
    );
    const inbox = await json<{ requests: { id: string; options: string[] }[] }>(
      await phone.get("/inbox"),
    );
    expect(inbox.requests.find((r) => r.id === row.id)?.options).toEqual([...SIGNOFF_OPTIONS]);
    const ok = await phone.post(`/requests/${row.id}/answer`, {
      version: row.version,
      answer: " Accept ",
    });
    expect(ok.status).toBe(200);
    expect((await h.store.humanRequest.mustGet(row.id)).status).toBe("answered");
  });

  it("the approvals page: an unmatched answer on a yes/no card is refused; 'approve' is a yes", async () => {
    const web = await h.pairDevice(h.seed.ada.id, "web");
    const row = await toolApproval();
    await expectRefused(
      await web.post(`/requests/${row.id}/answer`, { version: row.version, answer: "later" }),
      row,
    );
    const ok = await web.post(`/requests/${row.id}/answer`, {
      version: row.version,
      answer: "approve",
    });
    expect(ok.status).toBe(200);
  });

  it("the phone's offline queue: a queued unmatched answer is rejected with the options and the card stays", async () => {
    const row = await signoff();
    const res = await phone.post("/sync/outbox", {
      actions: [
        {
          clientId: "client-answer-1",
          kind: "request.answer",
          payload: { id: row.id, version: row.version, answer: "maybe" },
          createdAt: h.clock.nowIso(),
        },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = await json<{
      results: { status: string; code?: string; message?: string }[];
    }>(res);
    expect(results[0]).toMatchObject({ status: "rejected", code: "validation" });
    expect(results[0]?.message).toContain("Choose one of: accept, revise, cancel");
    expect((await h.store.humanRequest.mustGet(row.id)).status).toBe("open");
  });

  it("a question that takes free text still accepts it", async () => {
    const question = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "Which region?",
      options: ["eu-central", "us-east"],
      risk: "low",
    });
    const ok = await phone.post(`/requests/${question.id}/answer`, {
      version: question.version,
      answer: "Frankfurt, near the users",
    });
    expect(ok.status).toBe(200);
  });

  it("an old row's object options show as the buttons the desktop shows, and that click is accepted (U-021)", async () => {
    const old = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "Install capability voice-local",
      options: [{ choice: "approve", stage: "install" }, { choice: "deny" }] as never,
      risk: "medium",
    });
    const inbox = await json<{ requests: { id: string; options: string[] }[] }>(
      await phone.get("/inbox"),
    );
    const shown = inbox.requests.find((r) => r.id === old.id)?.options;
    expect(shown).toEqual(requestView(old, null).options);
    expect(shown).toEqual(["Approve", "Deny"]);
    const ok = await phone.post(`/requests/${old.id}/answer`, {
      version: old.version,
      answer: shown?.[1],
    });
    expect(ok.status).toBe(200);
  });
});
