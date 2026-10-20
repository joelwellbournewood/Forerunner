import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flushOutbox,
  IdempotencyStore,
  MemoryOutbox,
  type OutboxAction,
  type OutboxResult,
  type OutboxSender,
} from "../src/outbox.ts";
import { FileJsonState } from "../src/state-file.ts";
import { type DeviceClient, type Harness, harness, json } from "./helpers.ts";

function action(
  clientId: string,
  kind: OutboxAction["kind"],
  payload: Record<string, unknown>,
  createdAt = "2026-03-01T09:00:00.000Z",
): OutboxAction {
  return { clientId, kind, payload, createdAt };
}

describe("client outbox", () => {
  it("flushes in creation order, drops rejected actions and keeps items on transport failure", async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(
      action("c2", "queue.enqueue", { text: "second" }, "2026-03-01T09:00:02.000Z"),
    );
    await outbox.enqueue(
      action("c1", "queue.enqueue", { text: "first" }, "2026-03-01T09:00:01.000Z"),
    );
    await outbox.enqueue(
      action("c3", "message.receipt", { id: "missing", state: "read" }, "2026-03-01T09:00:03.000Z"),
    );
    await outbox.enqueue(action("c1", "queue.enqueue", { text: "duplicate enqueue is ignored" }));
    expect(await outbox.size()).toBe(3);

    const batches: OutboxAction[][] = [];
    let failOnce = true;
    const sender: OutboxSender = {
      async send(actions) {
        batches.push(actions);
        if (failOnce) {
          failOnce = false;
          throw new Error("offline");
        }
        return actions.map<OutboxResult>((a) =>
          a.clientId === "c3"
            ? { clientId: a.clientId, status: "rejected", code: "not_found", message: "no" }
            : { clientId: a.clientId, status: "applied", result: { id: a.clientId } },
        );
      },
    };
    const first = await flushOutbox(outbox, sender);
    expect(first).toEqual({ sent: 0, rejected: 0, deferred: 3 });
    expect(batches[0]?.map((a) => a.clientId)).toEqual(["c1", "c2", "c3"]);
    const second = await flushOutbox(outbox, sender);
    expect(second).toEqual({ sent: 2, rejected: 1, deferred: 0 });
    expect(await outbox.size()).toBe(0);
    const items = outbox.all();
    expect(items.find((i) => i.clientId === "c3")?.status).toBe("failed");
    expect(items.find((i) => i.clientId === "c1")?.attempts).toBe(1);
  });

  it("run() applies a key once even when calls overlap, and releases the key when the apply fails", async () => {
    const clock = new SimulatedClock("2026-03-01T09:00:00.000Z");
    const store = new IdempotencyStore(undefined, clock);
    let applied = 0;
    const apply = async (): Promise<OutboxResult> => {
      applied += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { clientId: "c1", status: "applied", result: { n: applied } };
    };
    const [a, b] = await Promise.all([store.run("d", "c1", apply), store.run("d", "c1", apply)]);
    expect(applied).toBe(1);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
    expect(a.result).toEqual(b.result);
    const later = await store.run("d", "c1", apply);
    expect(later.fresh).toBe(false);
    expect(applied).toBe(1);
    expect(store.get("d", "c1")?.status).toBe("applied");
    await expect(
      store.run("d", "c2", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    const retry = await store.run("d", "c2", async () => ({ clientId: "c2", status: "applied" }));
    expect(retry.fresh).toBe(true);
  });

  it("the idempotency store remembers results for a week and persists to a JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fr-state-api-"));
    try {
      const clock = new SimulatedClock("2026-03-01T09:00:00.000Z");
      const state = new FileJsonState({
        dir,
        name: "idempotency",
        initial: () => ({ version: 1 as const, records: [] }),
      });
      const store = new IdempotencyStore(state, clock);
      await store.put("dev1", "c1", { clientId: "c1", status: "applied", result: { id: "x" } });
      expect(store.get("dev1", "c1")?.status).toBe("applied");
      expect(store.get("dev2", "c1")).toBeUndefined();
      const raw = JSON.parse(await readFile(join(dir, "idempotency.json"), "utf8")) as {
        records: unknown[];
      };
      expect(raw.records).toHaveLength(1);
      const reopened = new IdempotencyStore(
        new FileJsonState({
          dir,
          name: "idempotency",
          initial: () => ({ version: 1 as const, records: [] }),
        }),
        clock,
      );
      expect(reopened.get("dev1", "c1")?.status).toBe("applied");
      await clock.advance(8 * 24 * 3600 * 1000);
      expect(reopened.get("dev1", "c1")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /sync/outbox (service side)", () => {
  let h: Harness;
  let phone: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(() => h.close());

  it("applies a batch in order, reports rejections per action and acknowledges duplicates", async () => {
    const message = await h.store.message.send({
      from_agent_id: h.seed.alice.id,
      to_human_id: h.seed.ada.id,
      type: "question",
      body: "ok?",
    });
    const request = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick",
      options: ["a", "b"],
    });
    const actions = [
      action("11111111-1", "queue.enqueue", {
        projectId: h.seed.project.id,
        kind: "note",
        text: "queued while offline",
      }),
      action("11111111-2", "message.receipt", { id: message.id, state: "acted" }),
      action("11111111-3", "request.answer", {
        id: request.id,
        version: request.version,
        answer: "b",
      }),
      action("11111111-4", "remote.enqueue", { target: "pc", command: "start", params: {} }),
      action("11111111-5", "task.transition", {
        id: h.seed.task2.id,
        version: 99,
        to: "cancelled",
        reason: "stale",
      }),
      action("11111111-6", "message.send", {
        fromAgentId: h.seed.bobAgent.id,
        toHumanId: h.seed.ada.id,
        body: "not my agent",
      }),
      action("11111111-7", "decision.record", {
        projectId: h.seed.project.id,
        question: "q",
        chosen: "c",
      }),
    ];
    const res = await phone.post("/sync/outbox", { actions });
    expect(res.status).toBe(200);
    const { results } = await json<{ results: OutboxResult[] }>(res);
    expect(results.map((r) => r.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "rejected",
      "rejected",
      "applied",
    ]);
    expect(results[4]?.code).toBe("version_conflict");
    expect(results[5]?.code).toBe("forbidden");
    expect((await h.store.message.mustGet(message.id)).acted_at).toBeTruthy();
    expect((await h.store.humanRequest.mustGet(request.id)).status).toBe("answered");
    expect(await h.store.queue.pending(h.seed.project.id)).toHaveLength(1);
    expect(await h.store.remoteCommand.pending("pc")).toHaveLength(1);

    // The same batch again (response lost, re-signed by the client): nothing is applied twice.
    await h.clock.advance(1);
    const again = await json<{ results: OutboxResult[] }>(
      await phone.post("/sync/outbox", { actions }),
    );
    expect(again.results.map((r) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "rejected",
      "rejected",
      "duplicate",
    ]);
    expect(await h.store.queue.pending(h.seed.project.id)).toHaveLength(1);
    expect(await h.store.remoteCommand.pending("pc")).toHaveLength(1);
    expect(await h.store.decision.current(h.seed.project.id)).toHaveLength(1);
  });

  it("two batches in flight with the same clientId apply once (a retry fired before the first answer)", async () => {
    const actions = [
      action("33333333-1", "queue.enqueue", {
        projectId: h.seed.project.id,
        kind: "note",
        text: "exactly once",
      }),
    ];
    const [a, b] = await Promise.all([
      phone.post("/sync/outbox", { actions }),
      phone.post("/sync/outbox", { actions }, { timestamp: String(h.clock.now() + 1) }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ra = (await json<{ results: OutboxResult[] }>(a)).results[0];
    const rb = (await json<{ results: OutboxResult[] }>(b)).results[0];
    expect([ra?.status, rb?.status].sort()).toEqual(["applied", "duplicate"]);
    expect(await h.store.queue.pending(h.seed.project.id)).toHaveLength(1);
  });

  it("needs a signed request, respects scopes per action and rejects malformed batches", async () => {
    expect(
      (
        await phone.post(
          "/sync/outbox",
          {
            actions: [
              action("11111111-1", "queue.enqueue", { projectId: h.seed.project.id, text: "x" }),
            ],
          },
          { unsigned: true },
        )
      ).status,
    ).toBe(401);
    const web = await h.pairDevice(h.seed.ada.id, "web");
    const { results } = await json<{ results: OutboxResult[] }>(
      await web.post("/sync/outbox", {
        actions: [
          action("11111111-9", "remote.enqueue", { target: "pc", command: "stop", params: {} }),
        ],
      }),
    );
    expect(results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    expect((await phone.post("/sync/outbox", { actions: [] })).status).toBe(400);
    expect(
      (
        await phone.post("/sync/outbox", {
          actions: [{ clientId: "short", kind: "nope", payload: {}, createdAt: "" }],
        })
      ).status,
    ).toBe(400);
  });

  it("the client-side flush works end to end against the service", async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(
      action("22222222-1", "queue.enqueue", {
        projectId: h.seed.project.id,
        text: "from the outbox",
      }),
    );
    const sender: OutboxSender = {
      async send(actions) {
        const res = await phone.post("/sync/outbox", { actions });
        if (res.status >= 500) throw new Error(`server ${res.status}`);
        return (await json<{ results: OutboxResult[] }>(res)).results;
      },
    };
    expect(await flushOutbox(outbox, sender)).toEqual({ sent: 1, rejected: 0, deferred: 0 });
    expect(await h.store.queue.pending(h.seed.project.id)).toHaveLength(1);
  });
});
