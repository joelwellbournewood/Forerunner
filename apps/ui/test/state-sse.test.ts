import { describe, expect, it } from "vitest";
import { createStateClient } from "../src/api/state-client.ts";
import { WebCryptoSigner } from "../src/api/state-signing.ts";
import {
  parseStateEvent,
  type StateStreamEvent,
  type SyncMode,
  subscribeStateEvents,
  subscribeStateSessionEvents,
} from "../src/api/state-sse.ts";
import { createFakeStateService, HUMAN_J } from "./fake-state-service.ts";
import { fetchFromApp } from "./helpers.tsx";
import { ADMIN_TOKEN, NOW_MS, until } from "./mobile-helpers.tsx";

async function pairedClient(options: { heartbeatMs?: number } = {}) {
  const service = createFakeStateService({
    adminToken: ADMIN_TOKEN,
    pcAutoCompleteMs: 10,
    heartbeatMs: options.heartbeatMs ?? 30,
    now: () => NOW_MS,
  });
  const signer = await WebCryptoSigner.generate();
  const anonymous = createStateClient({ baseUrl: "http://state.test", token: null }, signer, {
    fetch: fetchFromApp(service.app),
    now: () => NOW_MS,
  });
  const code = service.startPairing(HUMAN_J.id, "phone").code;
  const result = await anonymous.completePairing({ code, name: "Phone", platform: "android" });
  return { service, client: anonymous.withToken(result.token) };
}

describe("parseStateEvent", () => {
  it("parses ready, heartbeat, resync and *.changed frames; drops malformed ones", () => {
    expect(parseStateEvent("ready", JSON.stringify({ seq: 3, at: "x" }))).toEqual({
      event: "ready",
      data: { seq: 3, at: "x" },
    });
    expect(parseStateEvent("heartbeat", JSON.stringify({ at: "x" }))).toEqual({
      event: "heartbeat",
      data: { at: "x" },
    });
    expect(parseStateEvent("resync", "{}")).toEqual({ event: "resync", data: {} });
    const change = {
      seq: 9,
      type: "human_request.changed",
      at: "2026-10-20T10:00:00.000Z",
      humanId: "human_j",
      projectId: null,
      sessionId: null,
      payload: { id: "req_1", version: 2, status: "answered" },
      origin: "fake",
    };
    expect(parseStateEvent("human_request.changed", JSON.stringify(change))).toEqual({
      event: "changed",
      data: change,
    });
    expect(parseStateEvent("human_request.changed", "not json")).toBeNull();
    expect(parseStateEvent("human_request.changed", JSON.stringify({ seq: "x" }))).toBeNull();
    expect(parseStateEvent("unknown", "{}")).toBeNull();
    expect(parseStateEvent("heartbeat", JSON.stringify({}))).toBeNull();
  });
});

describe("subscribeStateEvents", () => {
  it("streams change events live over fetch with the bearer header, with heartbeats", async () => {
    const { service, client } = await pairedClient();
    const events: StateStreamEvent[] = [];
    const modes: SyncMode[] = [];
    const sub = subscribeStateEvents(client, {
      onEvent: (e) => events.push(e),
      onMode: (m) => modes.push(m),
    });
    await until(() => sub.mode === "live", 2000, "live mode");
    await service.app.request("http://state.test/__test/emit", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "human_request.changed",
        payload: { id: "req_x", version: 1, status: "open" },
      }),
    });
    await until(() => events.some((e) => e.event === "changed"), 2000, "a change event");
    await until(() => events.some((e) => e.event === "heartbeat"), 2000, "a heartbeat");
    const change = events.find((e) => e.event === "changed");
    expect(change && change.event === "changed" ? change.data.type : null).toBe(
      "human_request.changed",
    );
    expect(sub.lastSeq).toBeGreaterThan(0);
    sub.close();
    expect(sub.mode).toBe("closed");
    expect(modes).toContain("live");
  });

  it("filters events of other humans out of a device's feed", async () => {
    const { service, client } = await pairedClient();
    const events: StateStreamEvent[] = [];
    const sub = subscribeStateEvents(client, { onEvent: (e) => events.push(e) });
    await until(() => sub.mode === "live", 2000, "live mode");
    for (const humanId of ["human_other", HUMAN_J.id]) {
      await service.app.request("http://state.test/__test/emit", {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "message.changed", payload: { id: `m_${humanId}` }, humanId }),
      });
    }
    await until(() => events.some((e) => e.event === "changed"), 2000, "the own event");
    await new Promise((r) => setTimeout(r, 80));
    const ids = events
      .filter((e) => e.event === "changed")
      .map((e) => (e.event === "changed" ? e.data.payload.id : ""));
    expect(ids).toEqual([`m_${HUMAN_J.id}`]);
    sub.close();
  });

  it("falls back to polling (and calls the poller) when live is off, and to offline when the poll fails", async () => {
    const { client } = await pairedClient();
    let polls = 0;
    let fail = false;
    const modes: SyncMode[] = [];
    const notices: string[] = [];
    const sub = subscribeStateEvents(
      client,
      { onEvent: () => {}, onMode: (m) => modes.push(m), onNotice: (n) => notices.push(n) },
      {
        live: false,
        pollIntervalMs: 10,
        poll: async () => {
          polls += 1;
          if (fail) throw new Error("down");
        },
      },
    );
    await until(() => polls >= 2, 2000, "two polls");
    expect(sub.mode).toBe("polling");
    fail = true;
    await until(() => sub.mode === "offline", 2000, "offline");
    fail = false;
    await until(() => sub.mode === "polling", 2000, "back to polling");
    sub.close();
    expect(notices.some((n) => /polling/.test(n))).toBe(true);
    expect(notices.some((n) => /offline/.test(n))).toBe(true);
  });

  it("drops to polling when the stream is refused", async () => {
    const { client } = await pairedClient();
    const revoked = client.withToken("not-a-valid-token");
    let polls = 0;
    const sub = subscribeStateEvents(
      revoked,
      { onEvent: () => {} },
      {
        pollIntervalMs: 10,
        poll: async () => {
          polls += 1;
        },
      },
    );
    await until(() => sub.mode === "polling" && polls >= 1, 2000, "polling after refusal");
    sub.close();
  });
});

describe("subscribeStateSessionEvents", () => {
  it("polls the JSON page after the last seq and re-reads the session header", async () => {
    const { service, client } = await pairedClient();
    const session = {
      id: "sess_t",
      agentId: "agent_j",
      agentName: "J's agent",
      projectId: "proj_game",
      trigger: "remote",
      status: "running",
      startedAt: new Date(NOW_MS).toISOString(),
      endedAt: null,
      budgetCap: { usdMicro: 1, chfMicro: 1 },
      spent: { usdMicro: 0, chfMicro: 0 },
      stepCap: 10,
      steps: 1,
      currentTask: null,
      summary: "",
      handoff: null,
      runner: "pc",
    };
    service.state.sessions.push(session);
    const event = (seq: number) => ({
      id: `ev_${seq}`,
      sessionId: "sess_t",
      seq,
      type: "step",
      text: `step ${seq}`,
      payload: null,
      cost: { usdMicro: 0, chfMicro: 0 },
      at: new Date(NOW_MS).toISOString(),
      level: "info" as const,
    });
    service.state.events.push(event(1), event(2));
    const seen: number[] = [];
    let headers = 0;
    const sub = subscribeStateSessionEvents(
      client,
      "sess_t",
      {
        onEvent: (e) => {
          if (e.event === "session.event") seen.push(e.data.seq);
          if (e.event === "session.changed") headers += 1;
        },
      },
      { live: false, pollIntervalMs: 10, afterSeq: 1 },
    );
    await until(() => seen.length >= 1 && headers >= 1, 2000, "events and a header");
    service.state.events.push(event(3));
    await until(() => seen.includes(3), 2000, "the third event");
    sub.close();
    expect(seen).toEqual([2, 3]);
  });
});
