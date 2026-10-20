import type { AddressInfo } from "node:net";
import { SimulatedClock } from "@forerunner/platform";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus, ChangePoller, filterForHuman } from "../src/realtime.ts";
import { ADMIN_TOKEN, type DeviceClient, type Harness, harness, readSse } from "./helpers.ts";

type SseEvent = { event: string; data: unknown; id?: string };

describe("ChangeBus", () => {
  it("buffers, resumes from a seq and tells a stale client to resync", () => {
    const bus = new ChangeBus(new SimulatedClock(), 3);
    for (let i = 1; i <= 5; i++)
      bus.publish({
        type: "task.changed",
        humanId: null,
        projectId: "p",
        sessionId: null,
        payload: { id: `t${i}`, version: 1 },
      });
    expect(bus.currentSeq).toBe(5);
    expect(bus.since(4)?.map((e) => e.seq)).toEqual([5]);
    expect(bus.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(bus.since(1)).toBeUndefined();
    expect(bus.since(5)).toEqual([]);
  });

  it("ignores its own notifications and duplicates by (table, id, version)", () => {
    const bus = new ChangeBus(new SimulatedClock());
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));
    const own = bus.publish({
      type: "message.changed",
      humanId: "h",
      projectId: null,
      sessionId: null,
      payload: { id: "m1", version: 1 },
    });
    expect(bus.ingest({ ...own })).toBeUndefined();
    const remote = {
      type: "message.changed" as const,
      at: "",
      humanId: "h",
      projectId: null,
      sessionId: null,
      payload: { id: "m1", version: 1 },
      origin: "other",
    };
    expect(bus.ingest(remote)).toBeUndefined();
    expect(bus.ingest({ ...remote, payload: { id: "m1", version: 2 } })).toBeDefined();
    expect(seen).toHaveLength(2);
  });

  it("the poller calls onTick after every pass, scheduled or direct", async () => {
    const h = await harness();
    try {
      let ticks = 0;
      const poller = new ChangePoller({
        store: h.store,
        bus: h.api.bus,
        clock: h.clock,
        intervalMs: 2_000,
        onTick: () => {
          ticks += 1;
        },
      });
      await poller.pollOnce();
      expect(ticks).toBe(1);
      poller.start();
      await h.clock.advance(2_000);
      expect(ticks).toBe(2);
      await poller.stop();
      await h.clock.advance(4_000);
      expect(ticks).toBe(2);
    } finally {
      await h.close();
    }
  });

  it("filters per human: private events of others are hidden, project-wide ones pass", () => {
    const f = filterForHuman("ada");
    const base = {
      seq: 1,
      type: "task.changed" as const,
      at: "",
      projectId: null,
      sessionId: null,
      payload: {},
      origin: "x",
    };
    expect(f({ ...base, humanId: null })).toBe(true);
    expect(f({ ...base, humanId: "ada" })).toBe(true);
    expect(f({ ...base, humanId: "bob" })).toBe(false);
    expect(filterForHuman(null)({ ...base, humanId: "bob" })).toBe(true);
  });
});

describe("SSE over a real server", () => {
  let h: Harness;
  let phone: DeviceClient;
  let server: ReturnType<typeof serve>;
  let base: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
    server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  function open(path: string, token: string, headers: Record<string, string> = {}) {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", ...headers },
      signal: controller.signal,
    });
  }

  it("delivers an inbox event to the addressee's phone after a write through the service", async () => {
    const res = await open("/events", phone.token as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const ready = await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    expect(ready[0]?.event).toBe("ready");

    const sent = await h.admin.post("/messages", {
      fromAgentId: h.seed.alice.id,
      toHumanId: h.seed.ada.id,
      body: "ping",
    });
    expect(sent.status).toBe(201);
    const events = await readSse(reader, (es) => es.some((e) => e.event === "message.changed"));
    const change = events.find((e) => e.event === "message.changed") as SseEvent;
    expect(change).toBeDefined();
    expect(change.id).toMatch(/^\d+$/);
    expect((change.data as { humanId: string }).humanId).toBe(h.seed.ada.id);
  });

  it("does not deliver another human's private events, but does deliver project-wide ones", async () => {
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    const res = await open("/events", bobPhone.token as string);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    await h.admin.post("/messages", {
      fromAgentId: h.seed.alice.id,
      toHumanId: h.seed.ada.id,
      body: "private to ada",
    });
    await h.admin.post(`/tasks/${h.seed.task2.id}/transition`, {
      version: h.seed.task2.version,
      to: "cancelled",
      reason: "x",
    });
    const events = await readSse(reader, (es) => es.some((e) => e.event === "task.changed"), 3000);
    expect(events.some((e) => e.event === "message.changed")).toBe(false);
    expect(events.some((e) => e.event === "task.changed")).toBe(true);
  });

  it("sees writes made directly through the store (polling fallback) and resumes from Last-Event-ID", async () => {
    const res = await open("/events", phone.token as string);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    // Another install writes straight to the database, bypassing the service.
    await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "direct write",
    });
    await h.api.poller.pollOnce();
    const events = await readSse(reader, (es) => es.some((e) => e.event === "message.changed"));
    const first = events.find((e) => e.event === "message.changed") as SseEvent;
    expect(first.id).toBeDefined();
    // A second poll announces nothing new.
    const before = h.api.bus.currentSeq;
    await h.api.poller.pollOnce();
    expect(h.api.bus.currentSeq).toBe(before);

    // Drop the connection, make two more changes, resume from the last id.
    controllers[0]?.abort();
    await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "while away 1",
    });
    await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "while away 2",
    });
    await h.api.poller.pollOnce();
    const resumed = await open("/events", phone.token as string, {
      "last-event-id": first.id as string,
    });
    const reader2 = (resumed.body as ReadableStream<Uint8Array>).getReader();
    const replay = await readSse(
      reader2,
      (es) => es.filter((e) => e.event === "message.changed").length >= 2,
    );
    expect(replay.filter((e) => e.event === "message.changed")).toHaveLength(2);
    expect(replay.some((e) => e.event === "resync")).toBe(false);

    // Id 0 is still inside the 2,000-entry buffer: a full replay, no resync.
    const fromStart = await open("/events", phone.token as string, { "last-event-id": "0" });
    const reader3 = (fromStart.body as ReadableStream<Uint8Array>).getReader();
    const r3 = await readSse(
      reader3,
      (es) => es.filter((e) => e.event === "message.changed").length >= 3,
    );
    expect(r3.some((e) => e.event === "ready")).toBe(true);
    expect(r3.some((e) => e.event === "resync")).toBe(false);
  });

  it("tells a client whose Last-Event-ID fell out of the buffer to resync", async () => {
    // A separate harness with a one-entry buffer: after three writes only seq 3 is kept.
    const tiny = await harness({}, { busBufferSize: 1 });
    const tinyServer = serve({ fetch: tiny.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => tinyServer.once("listening", () => resolve()));
    const tinyBase = `http://127.0.0.1:${(tinyServer.address() as AddressInfo).port}`;
    const controller = new AbortController();
    try {
      const tinyPhone = await tiny.pairDevice(tiny.seed.ada.id);
      for (const text of ["one", "two", "three"]) {
        const res = await tiny.admin.post("/messages", {
          fromAgentId: tiny.seed.alice.id,
          toHumanId: tiny.seed.ada.id,
          body: text,
        });
        expect(res.status).toBe(201);
      }
      expect(tiny.api.bus.currentSeq).toBeGreaterThanOrEqual(3);
      const res = await fetch(`${tinyBase}/events`, {
        headers: {
          authorization: `Bearer ${tinyPhone.token}`,
          accept: "text/event-stream",
          "last-event-id": "1",
        },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const frames = await readSse(reader, (es) => es.some((e) => e.event === "resync"));
      expect(frames[0]?.event).toBe("ready");
      const resync = frames.find((e) => e.event === "resync") as SseEvent;
      expect(resync).toBeDefined();
      expect((resync.data as { reason: string }).reason).toContain("too old");
      expect(frames.some((e) => e.event === "message.changed")).toBe(false);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => tinyServer.close(() => resolve()));
      await tiny.close();
    }
  });

  it("keys the public pairing limiter by the socket address over a real server", async () => {
    // 1000 per minute per device in the harness => 166 per minute for pairing completions.
    const statuses: number[] = [];
    for (let i = 0; i < 170; i++) {
      const res = await fetch(`${base}/pairing/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i % 250}` },
        body: JSON.stringify({ code: "nope" }),
      });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.some((s) => s >= 500)).toBe(false);
  });

  it("sends a heartbeat every 15 simulated seconds", async () => {
    const res = await open("/events", ADMIN_TOKEN);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    await h.clock.advance(15_000);
    const events = await readSse(reader, (es) => es.some((e) => e.event === "heartbeat"));
    expect(events.some((e) => e.event === "heartbeat")).toBe(true);
  });

  it("streams the live session log and resumes from afterSeq", async () => {
    await h.store.event.append(h.seed.session.id, "task.started", { text: "first" });
    const res = await open(
      `/sessions/${h.seed.session.id}/events?afterSeq=0`,
      phone.token as string,
    );
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const initial = await readSse(reader, (es) => es.some((e) => e.event === "session.event"));
    const firstEvent = initial.find((e) => e.event === "session.event") as SseEvent;
    expect((firstEvent.data as { seq: number }).seq).toBe(1);
    // A runtime appends directly; the poller announces it and the stream fetches it.
    await h.store.event.append(h.seed.session.id, "tool.call", { text: "second" });
    await h.api.poller.pollOnce();
    const more = await readSse(reader, (es) =>
      es.some((e) => (e.data as { seq?: number }).seq === 2),
    );
    expect(
      more.some((e) => e.event === "session.event" && (e.data as { seq: number }).seq === 2),
    ).toBe(true);
    // Session status changes are pushed on the same stream.
    await h.store.session.setStatus(
      h.seed.session.id,
      (await h.store.session.mustGet(h.seed.session.id)).version,
      "completed",
      { summary: "done" },
    );
    await h.api.poller.pollOnce();
    const changed = await readSse(reader, (es) => es.some((e) => e.event === "session.changed"));
    const sessionChanged = changed.find((e) => e.event === "session.changed") as SseEvent;
    expect((sessionChanged.data as { status: string }).status).toBe("completed");
  });

  it("refuses the stream without a token", async () => {
    const res = await fetch(`${base}/events`, { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(401);
  });
});
