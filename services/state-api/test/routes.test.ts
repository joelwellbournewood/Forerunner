import { readdir } from "node:fs/promises";
import { join } from "@forerunner/platform";
import { DecisionLog } from "@forerunner/runtime/wiring/state-ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN, type DeviceClient, type Harness, harness, json } from "./helpers.ts";

describe("state service routes", () => {
  let h: Harness;
  let phone: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(() => h.close());

  it("GET /health reports version, schema state and time without authentication", async () => {
    const res = await h.anonymous.get("/health");
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      version: string;
      schema: { code: number; applied: number; state: string };
      time: string;
      dialect: string;
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.schema.applied).toBe(body.schema.code);
    expect(body.schema.state).toBe("current");
    expect(body.time).toBe(h.clock.nowIso());
    expect(body.dialect).toBe("sqlite");
  });

  it("unknown routes answer 404 with the error shape", async () => {
    const res = await h.admin.get("/nothing-here");
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });

  it("lists projects as ProjectCards with spend, budget, waiting count and health", async () => {
    await h.store.costLedger.record({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "api",
      usd_micro: 1_000_000,
      chf_micro: 800_000,
      rate_chf_per_usd: 0.8,
      model: "fake-haiku",
    });
    await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "pick",
      blocking: true,
    });
    const body = await json<{ projects: Record<string, unknown>[] }>(await phone.get("/projects"));
    expect(body.projects).toHaveLength(1);
    const card = body.projects[0] as {
      name: string;
      spend: { usdMicro: number; chfMicro: number };
      budget: { usdMicro: number; chfMicro: number };
      waitingOnYou: number;
      health: string;
      nextMilestone: { name: string } | null;
    };
    expect(card.name).toBe("Demo");
    expect(card.spend).toEqual({ usdMicro: 1_000_000, chfMicro: 800_000 });
    expect(card.budget).toEqual({ usdMicro: 50_000_000, chfMicro: 40_000_000 });
    expect(card.waitingOnYou).toBe(1);
    expect(card.health).toBe("blocked");
    expect(card.nextMilestone?.name).toBe("First cut");
    expect((await phone.get(`/projects/${h.seed.project.id}`)).status).toBe(200);
    expect((await phone.get("/projects/missing")).status).toBe(404);
  });

  it("lists, gets and transitions tasks with the version check", async () => {
    const list = await json<{ tasks: { id: string; status: string; version: number }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/tasks?status=ready`),
    );
    expect(list.tasks.map((t) => t.id).sort()).toEqual([h.seed.task1.id, h.seed.task2.id].sort());
    const one = await json<{ id: string; version: number; status: string }>(
      await phone.get(`/tasks/${h.seed.task1.id}`),
    );
    expect(one.status).toBe("ready");

    const stale = await phone.post(`/tasks/${h.seed.task1.id}/transition`, {
      version: one.version + 5,
      to: "cancelled",
      reason: "no longer needed",
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("version_conflict");

    const illegal = await phone.post(`/tasks/${h.seed.task1.id}/transition`, {
      version: one.version,
      to: "done",
      reason: "skip",
    });
    expect(illegal.status).toBe(400);

    const ok = await phone.post(`/tasks/${h.seed.task1.id}/transition`, {
      version: one.version,
      to: "cancelled",
      reason: "dropped",
    });
    expect(ok.status).toBe(200);
    const after = await json<{ status: string; version: number }>(ok);
    expect(after.status).toBe("cancelled");
    expect(after.version).toBe(one.version + 1);
    expect(
      (await phone.post("/tasks/missing/transition", { version: 1, to: "ready", reason: "x" }))
        .status,
    ).toBe(404);
    expect((await phone.get(`/projects/${h.seed.project.id}/milestones`)).status).toBe(200);
  });

  it("inbox, send and receipts: delivered < read < acted, first receipt wins, other humans refused", async () => {
    const sent = await json<{ id: string }>(
      await h.admin.post("/messages", {
        fromAgentId: h.seed.alice.id,
        toHumanId: h.seed.ada.id,
        projectId: h.seed.project.id,
        type: "question",
        body: "Ship on Friday?",
        requiresAck: true,
      }),
    );
    const inbox = await json<{
      messages: { id: string; fromAgentName: string; readAt: string | null }[];
      requests: unknown[];
      blockingCount: number;
    }>(await phone.get("/inbox"));
    expect(inbox.messages.map((m) => m.id)).toEqual([sent.id]);
    expect(inbox.messages[0]?.fromAgentName).toBe("Alice");

    const delivered = await json<{ deliveredAt: string | null; readAt: string | null }>(
      await phone.post(`/messages/${sent.id}/receipt`, { state: "delivered" }),
    );
    expect(delivered.deliveredAt).toBe(h.clock.nowIso());
    expect(delivered.readAt).toBeNull();
    await h.clock.advance(1000);
    const read = await json<{ deliveredAt: string; readAt: string }>(
      await phone.post(`/messages/${sent.id}/receipt`, { state: "read" }),
    );
    expect(read.deliveredAt).toBe(delivered.deliveredAt);
    expect(read.readAt).toBe(h.clock.nowIso());
    await h.clock.advance(1000);
    const acted = await json<{ actedAt: string; readAt: string }>(
      await phone.post(`/messages/${sent.id}/receipt`, { state: "acted" }),
    );
    expect(acted.readAt).toBe(read.readAt);
    expect(acted.actedAt).toBe(h.clock.nowIso());
    const unread = await json<{ messages: unknown[] }>(await phone.get("/inbox?unreadOnly=1"));
    expect(unread.messages).toHaveLength(0);

    const bobPhone = await h.pairDevice(h.seed.bob.id);
    expect((await bobPhone.post(`/messages/${sent.id}/receipt`, { state: "read" })).status).toBe(
      403,
    );
    expect((await bobPhone.get(`/inbox?humanId=${h.seed.ada.id}`)).status).toBe(403);
    expect(
      (
        await bobPhone.post("/messages", {
          fromAgentId: h.seed.alice.id,
          toHumanId: h.seed.bob.id,
          body: "as alice",
        })
      ).status,
    ).toBe(403);
    expect(
      (await phone.post("/messages", { fromAgentId: h.seed.alice.id, body: "nobody" })).status,
    ).toBe(400);
    expect((await phone.post("/messages/missing/receipt", { state: "read" })).status).toBe(404);
  });

  it("receipts come only from the addressee: the sender's device is refused, reads stay allowed", async () => {
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    // Ada's phone sends Alice -> Bob with requires_ack; Ada's phone must not acknowledge it herself.
    const sent = await json<{ id: string }>(
      await phone.post("/messages", {
        fromAgentId: h.seed.alice.id,
        toHumanId: h.seed.bob.id,
        type: "handoff",
        body: "over to you",
        requiresAck: true,
      }),
    );
    for (const state of ["delivered", "read", "acted"] as const) {
      const forged = await phone.post(`/messages/${sent.id}/receipt`, { state });
      expect(forged.status).toBe(403);
    }
    const untouched = await h.store.message.mustGet(sent.id);
    expect(untouched.delivered_at).toBeNull();
    expect(untouched.acted_at).toBeNull();
    // The sender may still read what it sent.
    expect((await phone.get(`/messages/${sent.id}`)).status).toBe(200);
    // The same rule applies through the offline outbox.
    const batch = await json<{ results: { status: string; code?: string }[] }>(
      await phone.post("/sync/outbox", {
        actions: [
          {
            clientId: "forge-receipt-1",
            kind: "message.receipt",
            payload: { id: sent.id, state: "read" },
            createdAt: h.clock.nowIso(),
          },
        ],
      }),
    );
    expect(batch.results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    // The addressee's phone acknowledges.
    expect((await bobPhone.post(`/messages/${sent.id}/receipt`, { state: "acted" })).status).toBe(
      200,
    );
    // A message to Bob's agent: only Bob's devices (or the runtime) may receipt it.
    const toAgent = await json<{ id: string }>(
      await phone.post("/messages", {
        fromAgentId: h.seed.alice.id,
        toAgentId: h.seed.bobAgent.id,
        body: "to bobby",
      }),
    );
    expect(
      (await phone.post(`/messages/${toAgent.id}/receipt`, { state: "delivered" })).status,
    ).toBe(403);
    expect(
      (await bobPhone.post(`/messages/${toAgent.id}/receipt`, { state: "delivered" })).status,
    ).toBe(200);
    expect((await h.admin.post(`/messages/${toAgent.id}/receipt`, { state: "read" })).status).toBe(
      200,
    );
  });

  it("sessions are scoped to the device's human's agents; unaddressed requests are the runtime's", async () => {
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    const bobs = await json<{ sessions: unknown[] }>(await bobPhone.get("/sessions"));
    expect(bobs.sessions).toEqual([]);
    expect((await bobPhone.get(`/sessions/${h.seed.session.id}`)).status).toBe(403);
    expect((await bobPhone.get(`/sessions?agentId=${h.seed.alice.id}`)).status).toBe(403);
    const adas = await json<{ sessions: { id: string }[] }>(await phone.get("/sessions"));
    expect(adas.sessions.map((s) => s.id)).toEqual([h.seed.session.id]);
    expect((await phone.get(`/sessions/${h.seed.session.id}`)).status).toBe(200);
    const all = await json<{ sessions: { id: string }[] }>(await h.admin.get("/sessions"));
    expect(all.sessions.map((s) => s.id)).toEqual([h.seed.session.id]);

    const unaddressed = await h.store.humanRequest.insert({
      human_id: null,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "anyone?",
      options: ["a", "b"],
    });
    expect((await phone.get(`/requests/${unaddressed.id}`)).status).toBe(403);
    const list = await json<{ requests: { id: string }[] }>(await phone.get("/requests"));
    expect(list.requests.map((r) => r.id)).not.toContain(unaddressed.id);
    expect(
      (
        await phone.post(`/requests/${unaddressed.id}/answer`, {
          version: unaddressed.version,
          answer: "a",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.admin.post(`/requests/${unaddressed.id}/answer`, {
          version: unaddressed.version,
          answer: "a",
        })
      ).status,
    ).toBe(200);
  });

  it("agent inbox for the runtime and unacknowledged handoffs", async () => {
    await h.admin.post("/messages", {
      fromAgentId: h.seed.bobAgent.id,
      toAgentId: h.seed.alice.id,
      type: "handoff",
      body: "done: parser; next: docs",
      requiresAck: true,
    });
    const inbox = await json<{ messages: { type: string }[] }>(
      await h.admin.get(`/inbox?agentId=${h.seed.alice.id}`),
    );
    expect(inbox.messages.map((m) => m.type)).toEqual(["handoff"]);
    const mine = await json<{ messages: { type: string }[] }>(
      await phone.get(`/inbox?agentId=${h.seed.alice.id}`),
    );
    expect(mine.messages).toHaveLength(1);
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    expect((await bobPhone.get(`/inbox?agentId=${h.seed.alice.id}`)).status).toBe(403);
  });

  it("human requests: open list, answer with version, 409 on a stale version, 404 unknown", async () => {
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "Which database?",
      options: ["sqlite", "postgres"],
      blocking: true,
    });
    const open = await json<{
      requests: { id: string; projectName: string; options: string[] }[];
      blockingCount: number;
    }>(await phone.get("/requests"));
    expect(open.requests.map((x) => x.id)).toEqual([r.id]);
    expect(open.requests[0]?.projectName).toBe("Demo");
    expect(open.requests[0]?.options).toEqual(["sqlite", "postgres"]);
    expect(open.blockingCount).toBe(1);
    const stale = await phone.post(`/requests/${r.id}/answer`, {
      version: r.version + 1,
      answer: "postgres",
    });
    expect(stale.status).toBe(409);
    const ok = await json<{ status: string; answer: unknown }>(
      await phone.post(`/requests/${r.id}/answer`, { version: r.version, answer: "postgres" }),
    );
    expect(ok.status).toBe("answered");
    expect(ok.answer).toBe("postgres");
    const twice = await phone.post(`/requests/${r.id}/answer`, {
      version: r.version + 1,
      answer: "sqlite",
    });
    expect(twice.status).toBe(400);
    expect((await phone.post("/requests/missing/answer", { version: 1, answer: "x" })).status).toBe(
      404,
    );
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    expect((await bobPhone.get(`/requests/${r.id}`)).status).toBe(403);
  });

  it("answering a decision request writes the decision-log entry: who, what, when, from which device; supersede through the outbox; nothing for an approval", async () => {
    const why = "Which database?";
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why,
      options: ["sqlite", "postgres"],
      blocking: true,
    });
    await h.clock.advance(5 * 60_000);
    const res = await phone.post(`/requests/${r.id}/answer`, {
      version: r.version,
      answer: "postgres",
    });
    expect(res.status).toBe(200);
    const answeredAt = h.clock.nowIso();
    // The same entry the daemon's answer route writes: one current decision on the project.
    const current = await h.store.decision.current(h.seed.project.id);
    expect(current).toHaveLength(1);
    const first = current[0] as (typeof current)[number];
    expect(first).toMatchObject({
      project_id: h.seed.project.id,
      question: why,
      options: ["sqlite", "postgres"],
      chosen: "postgres",
      decided_by: h.seed.ada.id,
      author_human: h.seed.ada.id,
      created_at: answeredAt,
      supersedes: null,
      superseded_by: null,
    });
    // From which device, and for which request (the row has no device column).
    expect(first.rationale).toBe(
      `request ${r.id} answered from device ${phone.deviceId} (phone) through the state service`,
    );
    expect(await h.store.decision.findAnswered(h.seed.project.id, "which database")).toMatchObject({
      id: first.id,
    });
    // The service lists it, and the change feed carried it.
    const listed = await json<{ decisions: { id: string; decidedBy: string }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/decisions`),
    );
    expect(listed.decisions.map((d) => d.id)).toEqual([first.id]);
    const events = h.api.bus.since(0, (e) => e.type === "decision.changed") ?? [];
    expect(events.map((e) => e.payload)).toEqual([
      { id: first.id, version: first.version, requestId: r.id },
    ]);

    // An answered approval is not a decision: nothing is written.
    const approval = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "Merge the PR?",
      options: ["yes", "no"],
      blocking: true,
    });
    expect(
      (
        await phone.post(`/requests/${approval.id}/answer`, {
          version: approval.version,
          answer: "yes",
        })
      ).status,
    ).toBe(200);
    expect(await h.store.decision.current(h.seed.project.id)).toHaveLength(1);

    // A different answer to the same question through the outbox supersedes the first entry.
    const again = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why,
      options: ["sqlite", "postgres"],
      blocking: true,
    });
    await h.clock.advance(60_000);
    const sync = await phone.post("/sync/outbox", {
      actions: [
        {
          clientId: "22222222-1",
          kind: "request.answer",
          payload: { id: again.id, version: again.version, answer: "sqlite" },
          createdAt: h.clock.nowIso(),
        },
      ],
    });
    expect(sync.status).toBe(200);
    const after = await h.store.decision.current(h.seed.project.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      chosen: "sqlite",
      decided_by: h.seed.ada.id,
      supersedes: first.id,
      created_at: h.clock.nowIso(),
    });
    expect(after[0]?.rationale).toContain(
      `request ${again.id} answered from device ${phone.deviceId}`,
    );
    expect((await h.store.decision.mustGet(first.id)).superseded_by).toBe(after[0]?.id);

    // The runtime answering an unaddressed request through the service is logged as the
    // runtime, naming its install.
    const unaddressed = await h.store.humanRequest.insert({
      project_id: h.seed.project.id,
      kind: "decision",
      why: "Which region?",
      options: ["eu", "us"],
      blocking: false,
    });
    const byRuntime = await h.admin.post(
      `/requests/${unaddressed.id}/answer`,
      { version: unaddressed.version, answer: "eu" },
      { headers: { "x-forerunner-install": "pc-ada" } },
    );
    expect(byRuntime.status).toBe(200);
    const region = await h.store.decision.findAnswered(h.seed.project.id, "Which region?");
    expect(region).toMatchObject({ chosen: "eu", decided_by: "runtime", author_human: "runtime" });
    expect(region?.rationale).toBe(
      `request ${unaddressed.id} answered from the runtime (install pc-ada) through the state service`,
    );
    expect(await h.store.decision.current(h.seed.project.id)).toHaveLength(2);
  });

  it("the answer and its decision-log entry are one write: a failed decision write leaves the request open and the retry succeeds", async () => {
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "Which queue?",
      options: ["redis", "postgres"],
      blocking: true,
    });
    const spy = vi
      .spyOn(DecisionLog.prototype, "recordAnswer")
      .mockRejectedValueOnce(new Error("decision table unavailable"));
    try {
      const failed = await phone.post(`/requests/${r.id}/answer`, {
        version: r.version,
        answer: "postgres",
      });
      expect(failed.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      // Rolled back together: the request is still open at its version, no decision row, and
      // nothing went on the change feed.
      expect(await h.store.humanRequest.get(r.id)).toMatchObject({
        status: "open",
        version: r.version,
        answer: null,
      });
      expect(await h.store.decision.current(h.seed.project.id)).toEqual([]);
      expect(
        h.api.bus.since(
          0,
          (e) => e.type === "human_request.changed" || e.type === "decision.changed",
        ) ?? [],
      ).toEqual([]);
      // The retry at the same version (re-signed a moment later, as a client would) goes
      // through and writes both.
      await h.clock.advance(1_000);
      const retry = await phone.post(`/requests/${r.id}/answer`, {
        version: r.version,
        answer: "postgres",
      });
      expect(retry.status).toBe(200);
      expect(await h.store.humanRequest.get(r.id)).toMatchObject({
        status: "answered",
        answer: "postgres",
      });
      expect(await h.store.decision.current(h.seed.project.id)).toMatchObject([
        { question: "Which queue?", chosen: "postgres", decided_by: h.seed.ada.id },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("records and lists decisions, with supersede", async () => {
    const first = await json<{ id: string; chosen: string; decidedBy: string }>(
      await phone.post(`/projects/${h.seed.project.id}/decisions`, {
        question: "Which DB?",
        options: ["a", "b"],
        chosen: "a",
        rationale: "simpler",
      }),
    );
    expect(first.decidedBy).toBe(h.seed.ada.id);
    const second = await json<{ id: string; supersedes: string }>(
      await phone.post(`/projects/${h.seed.project.id}/decisions`, {
        question: "Which DB?",
        chosen: "b",
        supersedes: first.id,
      }),
    );
    expect(second.supersedes).toBe(first.id);
    const current = await json<{ decisions: { id: string }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/decisions`),
    );
    expect(current.decisions.map((d) => d.id)).toEqual([second.id]);
    const all = await json<{ decisions: { id: string }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/decisions?all=1`),
    );
    expect(all.decisions).toHaveLength(2);
    expect(
      (await phone.post("/projects/missing/decisions", { question: "q", chosen: "c" })).status,
    ).toBe(404);
  });

  it("queues notes, tasks and ideas from the phone for the next session", async () => {
    const note = await json<{ id: string; kind: string; humanId: string; status: string }>(
      await phone.post(`/projects/${h.seed.project.id}/queue`, {
        kind: "idea",
        text: "Try a cache",
        priority: 2,
      }),
    );
    expect(note.kind).toBe("idea");
    expect(note.humanId).toBe(h.seed.ada.id);
    expect(note.status).toBe("queued");
    const pending = await h.store.queue.pending(h.seed.project.id);
    expect(pending.map((q) => q.id)).toEqual([note.id]);
    const list = await json<{ items: { id: string }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/queue`),
    );
    expect(list.items.map((i) => i.id)).toEqual([note.id]);
    expect((await phone.post(`/projects/${h.seed.project.id}/queue`, { text: "" })).status).toBe(
      400,
    );
    expect(
      (await h.admin.post(`/projects/${h.seed.project.id}/queue`, { text: "no human" })).status,
    ).toBe(400);
    expect(
      (
        await h.admin.post(`/projects/${h.seed.project.id}/queue?humanId=${h.seed.ada.id}`, {
          text: "ok",
        })
      ).status,
    ).toBe(201);
  });

  it("costs: totals by project for the device's own human only", async () => {
    for (const [human, usd] of [
      [h.seed.ada.id, 2_000_000],
      [h.seed.bob.id, 5_000_000],
    ] as const) {
      await h.store.costLedger.record({
        human_id: human,
        project_id: h.seed.project.id,
        kind: "api",
        usd_micro: usd,
        chf_micro: Math.round(usd * 0.8),
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
        specialist: "coder",
      });
    }
    const mine = await json<{
      totals: { usdMicro: number };
      byProject: { label: string }[];
      byModel: { key: string }[];
    }>(await phone.get("/costs"));
    expect(mine.totals.usdMicro).toBe(2_000_000);
    expect(mine.byProject[0]?.label).toBe("Demo");
    expect(mine.byModel[0]?.key).toBe("fake-sonnet");
    expect((await phone.get(`/costs?humanId=${h.seed.bob.id}`)).status).toBe(403);
    const all = await json<{ totals: { usdMicro: number } }>(
      await h.admin.get(`/costs?projectId=${h.seed.project.id}`),
    );
    expect(all.totals.usdMicro).toBe(7_000_000);
    expect((await phone.get("/costs?from=notadate")).status).toBe(400);
  });

  it("reviews: list with findings, comment becomes a message, approve answers the approval request", async () => {
    await h.store.task.patch(h.seed.task1.id, { owner_agent_id: h.seed.alice.id });
    const review = await h.store.review.insert({
      task_id: h.seed.task1.id,
      session_id: h.seed.session.id,
      critic_model: "fake-opus",
      tier: 2,
      grade: 72,
      confidence: 0.8,
      verdict: "human",
      summary: "Needs a look",
    });
    await h.store.finding.insert({
      review_id: review.id,
      task_id: h.seed.task1.id,
      severity: "medium",
      description: "No tests for errors",
      required_action: "add tests",
    });
    const approval = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      task_id: h.seed.task1.id,
      kind: "approval",
      why: "Merge?",
      risk: "medium",
    });
    const list = await json<{
      reviews: { id: string; taskTitle: string; findings: { severity: string }[] }[];
    }>(await phone.get(`/reviews?projectId=${h.seed.project.id}`));
    expect(list.reviews).toHaveLength(1);
    expect(list.reviews[0]?.taskTitle).toBe("Write the parser");
    expect(list.reviews[0]?.findings.map((f) => f.severity)).toEqual(["medium"]);
    expect((await phone.get(`/reviews/${review.id}`)).status).toBe(200);

    const comment = await json<{ messageId: string }>(
      await phone.post(`/reviews/${review.id}/comment`, { body: "Looks fine to me" }),
    );
    const message = await h.store.message.mustGet(comment.messageId);
    expect(message.to_agent_id).toBe(h.seed.alice.id);
    expect(message.from_agent_id).toBe(h.seed.alice.id);
    expect(message.body).toContain("Looks fine to me");

    const approved = await json<{ messageId: string; answeredRequestId: string | null }>(
      await phone.post(`/reviews/${review.id}/approve`, { body: "ship it" }),
    );
    expect(approved.answeredRequestId).toBe(approval.id);
    const request = await h.store.humanRequest.mustGet(approval.id);
    expect(request.status).toBe("answered");
    expect((request.answer as { decision: string }).decision).toBe("approve");
    const decision = await h.store.message.mustGet(approved.messageId);
    expect(decision.type).toBe("decision");
    expect(decision.requires_ack).toBe(true);
    expect((await phone.post("/reviews/missing/reject", {})).status).toBe(404);
  });

  it("sessions: list, get and the JSON event page", async () => {
    await h.store.event.append(h.seed.session.id, "task.started", { text: "Write the parser" });
    await h.store.event.append(h.seed.session.id, "budget.warning", { message: "80% used" }, 1200);
    const list = await json<{ sessions: { id: string; agentName: string; status: string }[] }>(
      await phone.get(`/sessions?projectId=${h.seed.project.id}`),
    );
    expect(list.sessions.map((s) => s.id)).toEqual([h.seed.session.id]);
    expect(list.sessions[0]?.agentName).toBe("Alice");
    const events = await json<{ events: { seq: number; level: string; text: string }[] }>(
      await phone.get(`/sessions/${h.seed.session.id}/events?afterSeq=1`),
    );
    expect(events.events.map((e) => e.seq)).toEqual([2]);
    expect(events.events[0]?.level).toBe("warning");
    expect(events.events[0]?.text).toContain("80% used");
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    expect((await bobPhone.get(`/sessions/${h.seed.session.id}/events`)).status).toBe(403);
    expect((await phone.get("/sessions/missing")).status).toBe(404);
  });

  it("uploads a file to a project: data_asset row, file on disk, metadata only in the response", async () => {
    const boundary = "----forerunner-test-boundary";
    const content = "hello,world\n1,2\n";
    const body = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="kind"',
        "",
        "csv",
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="../../evil name.csv"',
        "Content-Type: text/csv",
        "",
        content,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const res = await phone.send("POST", `/projects/${h.seed.project.id}/uploads`, body, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.status).toBe(201);
    const asset = await json<{
      id: string;
      name: string;
      sizeBytes: number;
      kind: string;
      projectIds: string[];
    }>(res);
    expect(asset.sizeBytes).toBe(content.length);
    expect(asset.kind).toBe("csv");
    expect(asset.name).not.toContain("..");
    expect(JSON.stringify(asset)).not.toContain(h.api.config.uploadsDir);
    // The harness writes under its own temp directory, never the developer's data directory.
    expect(h.api.config.uploadsDir.startsWith(h.dir)).toBe(true);
    expect(h.api.config.serviceStateDir.startsWith(h.dir)).toBe(true);
    const row = await h.store.dataAsset.mustGet(asset.id);
    expect(row.owner_device_id).toBe(phone.deviceId);
    const files = await readdir(join(h.api.config.uploadsDir, h.seed.project.id));
    expect(files.some((f) => f.startsWith(asset.id))).toBe(true);
    const listed = await json<{ uploads: { id: string }[] }>(
      await phone.get(`/projects/${h.seed.project.id}/uploads`),
    );
    expect(listed.uploads.map((u) => u.id)).toEqual([asset.id]);
  });

  it("an upload with a clientId is applied once and the list reports the cap", async () => {
    const boundary = "----forerunner-test-boundary";
    const clientId = "0f6c2a4e-upload-retry-1";
    const form = (id: string) =>
      new TextEncoder().encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="clientId"',
          "",
          id,
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="photo.jpg"',
          "Content-Type: image/jpeg",
          "",
          "jpeg-bytes",
          `--${boundary}--`,
          "",
        ].join("\r\n"),
      );
    const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const path = `/projects/${h.seed.project.id}/uploads`;
    const before = await json<{ uploads: unknown[] }>(await phone.get(path));
    const first = await phone.send("POST", path, form(clientId), headers);
    expect(first.status).toBe(201);
    const asset = await json<{ id: string }>(first);
    // The resend after a lost answer (signed afresh): same asset, 200, no second file.
    await h.clock.advance(1_000);
    const again = await phone.send("POST", path, form(clientId), headers);
    expect(again.status).toBe(200);
    expect((await json<{ id: string }>(again)).id).toBe(asset.id);
    const listed = await json<{ uploads: { id: string }[]; maxBytes: number }>(
      await phone.get(path),
    );
    expect(listed.uploads).toHaveLength(before.uploads.length + 1);
    expect(listed.maxBytes).toBe(h.api.config.uploadMaxBytes);
    const files = await readdir(join(h.api.config.uploadsDir, h.seed.project.id));
    expect(files.filter((f) => f.startsWith(asset.id))).toHaveLength(1);
    await h.clock.advance(1_000);
    const bad = await phone.send("POST", path, form("no spaces allowed"), headers);
    expect(bad.status).toBe(400);
  });

  it("refuses uploads over the cap and without a file field", async () => {
    const boundary = "----forerunner-test-boundary";
    const big = "x".repeat(70 * 1024);
    const body = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="big.bin"',
        "",
        big,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const res = await phone.send("POST", `/projects/${h.seed.project.id}/uploads`, body, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.status).toBe(413);
    const noFile = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="kind"',
        "",
        "csv",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const bad = await phone.send("POST", `/projects/${h.seed.project.id}/uploads`, noFile, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(bad.status).toBe(400);
  });

  it("admin token is accepted on every route the runtime needs", async () => {
    expect(ADMIN_TOKEN.length).toBeGreaterThan(10);
    for (const path of [
      "/projects",
      `/projects/${h.seed.project.id}/tasks`,
      `/inbox?humanId=${h.seed.ada.id}`,
      "/sessions",
      "/devices",
      "/reviews",
    ]) {
      expect((await h.admin.get(path)).status, path).toBe(200);
    }
  });
});
