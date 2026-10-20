import { SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateStore } from "../src/store.ts";
import { openStore } from "../src/store.ts";

/**
 * Security review of the store (spec S, U; ADR 0005, ADR 0041): SQL injection through the
 * only places caller-controlled text reaches SQL text (filter keys, order-by, raw ids),
 * the workflow graphs the service and the daemon rely on, optimistic version checks and
 * the owner filter of remote command pick-up. A test marked `it.fails` is a finding.
 */
const START = "2026-03-01T09:00:00.000Z";

async function seed(store: StateStore) {
  const ada = await store.human.insert({ name: "Ada", email: "ada@example.test" });
  const bob = await store.human.insert({ name: "Bob", email: "bob@example.test" });
  const alice = await store.agent.insert({
    name: "Alice",
    owner_human_id: ada.id,
    kind: "principal",
  });
  const bobby = await store.agent.insert({
    name: "Bobby",
    owner_human_id: bob.id,
    kind: "principal",
  });
  const project = await store.project.insert({ name: "P", goal: "g", budget_usd_micro: 1 });
  const other = await store.project.insert({ name: "Q", goal: "g", budget_usd_micro: 1 });
  const task = await store.task.insert({
    project_id: project.id,
    title: "t",
    outcome: "o",
    status: "ready",
    risk_tier: 1,
    priority: 1,
  });
  const adaPhone = await store.device.register({
    owner_human_id: ada.id,
    name: "ada phone",
    platform: "android",
    public_key: "ada-key",
    kind: "phone",
  });
  const bobPhone = await store.device.register({
    owner_human_id: bob.id,
    name: "bob phone",
    platform: "android",
    public_key: "bob-key",
    kind: "phone",
  });
  return { ada, bob, alice, bobby, project, other, task, adaPhone, bobPhone };
}

describe("security: SQL injection surfaces", () => {
  let store: StateStore;
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock: new SimulatedClock(START) });
    s = await seed(store);
  });
  afterEach(async () => {
    await store.close();
  });

  const tableStillThere = async () => (await store.task.list()).length;

  it("order-by text is validated against the entity's columns, never spliced", async () => {
    const attacks: unknown[] = [
      'id"; DROP TABLE "task"; --',
      "id; DROP TABLE task",
      { column: 'id" --', direction: "asc" },
      [{ column: "priority" }, { column: "x OR 1=1" }],
      "settings",
    ];
    for (const orderBy of attacks) {
      await expect(
        store.task.list(undefined, { orderBy: orderBy as never }),
        JSON.stringify(orderBy),
      ).rejects.toMatchObject({ code: "validation" });
    }
    expect(await tableStillThere()).toBe(1);
    // Anything after "column direction" is discarded, never spliced; a direction other
    // than desc is asc.
    const rows = await store.task.list(undefined, { orderBy: "priority DROP" });
    expect(rows).toHaveLength(1);
    const trailing = await store.task.list(undefined, {
      orderBy: "created_at desc, (SELECT 1 FROM human WHERE 1=1)",
    });
    expect(trailing).toHaveLength(1);
  });

  it("filter keys are validated against the entity's columns; values are parameters", async () => {
    const badKey = { 'id" = "x" OR 1=1 --': "x" } as never;
    await expect(store.task.list(badKey)).rejects.toMatchObject({ code: "validation" });
    await expect(store.task.count(badKey)).rejects.toMatchObject({ code: "validation" });
    // JSON columns cannot be filtered (no LIKE tricks on serialized text).
    await expect(store.project.list({ settings: "{}" } as never)).rejects.toMatchObject({
      code: "validation",
    });
    // Values are bound, so classic payloads match nothing and change nothing.
    for (const value of ["' OR '1'='1", `${s.task.id}' OR 1=1 --`, 'x"; DROP TABLE "task']) {
      expect(await store.task.list({ id: value })).toEqual([]);
      expect(await store.task.get(value)).toBeUndefined();
      expect(await store.task.exists(value)).toBe(false);
      expect(await store.task.list({ id: [value, "nope"] })).toEqual([]);
    }
    expect(await tableStillThere()).toBe(1);
    expect(await store.human.count()).toBe(2);
  });

  it("limit and offset are numbers after floor; text never reaches the SQL", async () => {
    expect(await store.task.list(undefined, { limit: 1.9, offset: 0.2 })).toHaveLength(1);
    expect(await store.task.list(undefined, { limit: -5 })).toHaveLength(0);
    expect(await store.task.list(undefined, { offset: 5 })).toHaveLength(0);
    await expect(
      store.task.list(undefined, { limit: "1; DROP TABLE task" as never }),
    ).rejects.toBeDefined();
    expect(await tableStillThere()).toBe(1);
  });

  it("remote command pick-up filters are parameters: an injected owner never widens the subquery", async () => {
    // Addressed to ada's phone: only that device id (or no filter) may take it.
    await store.remoteCommand.enqueue({
      device_id: s.adaPhone.id,
      target: "pc",
      target_device_id: s.adaPhone.id,
      command: "start",
      params: {},
    });
    const widen = ["' OR 1=1 --", `${s.ada.id}' OR '1'='1`, 'x") OR 1=1 --', "%"];
    for (const v of widen) {
      expect(await store.remoteCommand.pickUp("pc", { ownerHumanId: v }), v).toBeUndefined();
      expect(await store.remoteCommand.pickUp("pc", { agentId: v }), v).toBeUndefined();
      expect(await store.remoteCommand.pickUp("pc", { deviceId: v }), v).toBeUndefined();
    }
    expect(await store.remoteCommand.pickUp("pc", { ownerHumanId: s.bob.id })).toBeUndefined();
    expect(await store.remoteCommand.pickUp("pc", { agentId: s.bobby.id })).toBeUndefined();
    expect(await store.remoteCommand.pickUp("pc", { deviceId: s.bobPhone.id })).toBeUndefined();
    const row = await store.remoteCommand.pickUp("pc", {
      agentId: s.alice.id,
      deviceId: s.adaPhone.id,
    });
    expect(row?.status).toBe("picked_up");
  });

  it("patch and update never let a caller set the envelope (id, created_at, version)", async () => {
    const before = await store.task.mustGet(s.task.id);
    const after = await store.task.patch(s.task.id, {
      id: "forged",
      created_at: "1999-01-01T00:00:00.000Z",
      version: 99,
      title: "renamed",
    } as never);
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.version).toBe(before.version + 1);
    expect(after.title).toBe("renamed");
    expect(await store.task.get("forged")).toBeUndefined();
  });

  it("insert refuses unknown columns instead of ignoring them", async () => {
    await expect(
      store.task.insert({
        project_id: s.project.id,
        title: "x",
        outcome: "o",
        risk_tier: 1,
        priority: 1,
        'title", "x': "y",
      } as never),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      store.task.insert({
        project_id: s.project.id,
        title: "x",
        outcome: "o",
        risk_tier: 1,
        priority: 1,
        is_admin: true,
      } as never),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("security: workflow graphs and version checks", () => {
  let store: StateStore;
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock: new SimulatedClock(START) });
    s = await seed(store);
  });
  afterEach(async () => {
    await store.close();
  });

  it("a task cannot skip states, be closed with open findings, or be moved with a stale version", async () => {
    const t = s.task;
    await expect(store.task.transition(t.id, t.version, "done", "skip")).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      store.task.transition(t.id, t.version + 5, "cancelled", "stale"),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const claimed = await store.task.claim(t.id, s.alice.id, 60_000);
    expect(claimed.ok).toBe(true);
    const v1 = await store.task.mustGet(t.id);
    const inProgress = await store.task.transition(t.id, v1.version, "in_progress", "go");
    const inReview = await store.task.transition(t.id, inProgress.version, "in_review", "review");
    const review = await store.review.insert({
      task_id: t.id,
      critic_model: "fake",
      verdict: "revise",
    });
    await store.finding.insert({
      review_id: review.id,
      task_id: t.id,
      severity: "high",
      description: "bug",
    });
    await expect(
      store.task.transition(t.id, inReview.version, "done", "close"),
    ).rejects.toMatchObject({ code: "findings_open" });
    expect((await store.task.mustGet(t.id)).status).toBe("in_review");
    // Terminal states are terminal.
    const cancelled = await store.task.transition(t.id, inReview.version, "cancelled", "stop");
    await expect(
      store.task.transition(t.id, cancelled.version, "ready", "resurrect"),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("claims are atomic and owner-bound: a second agent cannot take, renew or release a held claim", async () => {
    const t = s.task;
    expect((await store.task.claim(t.id, s.alice.id, 60_000)).ok).toBe(true);
    const second = await store.task.claim(t.id, s.bobby.id, 60_000);
    expect(second).toMatchObject({ ok: false, reason: "held_by", holder: s.alice.id });
    await expect(store.task.renewClaim(t.id, s.bobby.id, 60_000)).rejects.toMatchObject({
      code: "claim_conflict",
    });
    await expect(store.task.releaseClaim(t.id, s.bobby.id)).rejects.toMatchObject({
      code: "claim_conflict",
    });
    expect((await store.task.mustGet(t.id)).claimed_by).toBe(s.alice.id);
    // A stale expected version cannot steal a claim either.
    const stale = await store.task.claim(t.id, s.bobby.id, 60_000, undefined, {
      expectedVersion: 1,
    });
    expect(stale.ok).toBe(false);
  });

  it("a human request is answered once; answered, expired and withdrawn are final", async () => {
    const r = await store.humanRequest.insert({ human_id: s.ada.id, kind: "decision", why: "w" });
    const answered = await store.humanRequest.answer(r.id, r.version, "yes", s.ada.id);
    await expect(
      store.humanRequest.answer(r.id, answered.version, "no", s.bob.id),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(store.humanRequest.withdraw(r.id, answered.version)).rejects.toMatchObject({
      code: "validation",
    });
    const row = await store.humanRequest.mustGet(r.id);
    expect(row.answer).toBe("yes");
    expect(row.answered_by).toBe(s.ada.id);
    // A stale version on the first answer is a conflict, not an overwrite.
    const r2 = await store.humanRequest.insert({ human_id: s.ada.id, kind: "decision", why: "w" });
    await expect(
      store.humanRequest.answer(r2.id, r2.version + 1, "x", s.ada.id),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("remote commands move pending -> picked_up -> done|failed only; nothing rewinds", async () => {
    const c = await store.remoteCommand.enqueue({
      device_id: s.adaPhone.id,
      target: "pc",
      command: "start",
      params: {},
    });
    await expect(store.remoteCommand.complete(c.id, { ok: true })).rejects.toMatchObject({
      code: "validation",
    });
    expect((await store.remoteCommand.pickUpById(c.id))?.status).toBe("picked_up");
    expect(await store.remoteCommand.pickUpById(c.id)).toBeUndefined();
    expect(await store.remoteCommand.pickUp("pc")).toBeUndefined();
    const done = await store.remoteCommand.complete(c.id, { ok: true });
    expect(done.status).toBe("done");
    await expect(store.remoteCommand.fail(c.id, { ok: false })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(store.remoteCommand.complete(c.id, { again: true })).rejects.toMatchObject({
      code: "validation",
    });
    expect((await store.remoteCommand.mustGet(c.id)).result).toEqual({ ok: true });
  });

  it("queue items are consumed once", async () => {
    const q = await store.queue.enqueue({
      project_id: s.project.id,
      human_id: s.ada.id,
      kind: "note",
      text: "n",
    });
    const session = await store.session.insert({
      agent_id: s.alice.id,
      project_id: s.project.id,
      trigger: "manual",
      status: "running",
      started_at: START,
    });
    const consumed = await store.queue.consume(q.id, q.version, session.id);
    await expect(store.queue.consume(q.id, consumed.version, session.id)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(store.queue.dismiss(q.id, consumed.version)).rejects.toMatchObject({
      code: "validation",
    });
  });

  /**
   * security finding: `DecisionRepo.supersede(oldId, input)` records the new decision in
   * `input.project_id` and marks `oldId` superseded without checking that both belong to
   * the same project. Any caller that can record a decision in project Q (every paired
   * device, through `POST /projects/:id/decisions`) can retire a decision of project P by
   * naming its id. Fix: throw `validation` when `old.project_id !== input.project_id`
   * (and keep the route's check as the first line).
   */
  it.fails("supersede refuses a decision of another project", async () => {
    const original = await store.decision.record({
      project_id: s.project.id,
      question: "Database?",
      options: ["pg"],
      chosen: "pg",
      decided_by: s.ada.id,
    });
    await expect(
      store.decision.supersede(original.id, {
        project_id: s.other.id,
        question: "Database?",
        options: [],
        chosen: "sqlite",
        decided_by: s.bob.id,
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect((await store.decision.current(s.project.id)).map((d) => d.id)).toContain(original.id);
  });

  it("the remote command owner filter follows the device owner, including a revoked device", async () => {
    await store.remoteCommand.enqueue({
      device_id: s.bobPhone.id,
      target: "pc",
      command: "kill",
      params: { scope: "all" },
    });
    // Ada's runner never takes bob's kill.
    expect(await store.remoteCommand.pickUp("pc", { agentId: s.alice.id })).toBeUndefined();
    expect(await store.remoteCommand.pickUp("pc", { ownerHumanId: s.ada.id })).toBeUndefined();
    // Bob's own runner does, even after bob's phone was revoked (the runner refuses visibly).
    await store.device.revoke(s.bobPhone.id, s.bobPhone.version);
    const row = await store.remoteCommand.pickUp("pc", { agentId: s.bobby.id });
    expect(row?.device_id).toBe(s.bobPhone.id);
  });
});
