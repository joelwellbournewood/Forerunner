import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type StateClient } from "../src/api/client.ts";
import { type FeedMode, parseChangeFrame, SseParser, subscribeChanges } from "../src/api/events.ts";
import { exchangeCode, type WebSession } from "../src/api/session.ts";
import type { ChangeEvent } from "../src/api/types.ts";
import { type FakeStateService, startFakeStateService } from "./fake-state-service.ts";
import { waitFor } from "./harness.tsx";

const clock = { now: () => Date.now() };

describe("SseParser", () => {
  it("parses events, multi-line data, ids, comments and CRLF", () => {
    const p = new SseParser();
    expect(p.feed("event: ready\ndata: {}\n")).toEqual([]);
    expect(p.feed("\n")).toEqual([{ event: "ready", data: "{}" }]);
    expect(p.feed(":comment\r\nid: 7\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([
      { event: "x", data: "a\nb", id: "7" },
    ]);
    expect(p.feed("data: no-name\n\n")).toEqual([{ event: "message", data: "no-name", id: "7" }]);
    expect(p.feed("\n\n")).toEqual([]);
  });

  it("drops frames that are not change events", () => {
    expect(parseChangeFrame({ event: "x", data: "not json" })).toBeNull();
    expect(parseChangeFrame({ event: "x", data: JSON.stringify({ seq: "1" }) })).toBeNull();
    const e: ChangeEvent = {
      seq: 1,
      type: "task.changed",
      at: "2026-10-20T00:00:00.000Z",
      humanId: null,
      projectId: "p",
      sessionId: null,
      payload: { id: "t" },
      origin: "x",
    };
    expect(parseChangeFrame({ event: "task.changed", data: JSON.stringify(e) })).toEqual(e);
  });
});

describe("subscribeChanges", () => {
  let fake: FakeStateService;
  let session: WebSession;
  let client: StateClient;

  beforeEach(async () => {
    fake = await startFakeStateService({ clock });
    session = await exchangeCode({ baseUrl: fake.url, code: fake.startPairing(), deviceName: "t" });
    client = createClient({ baseUrl: fake.url, session, clock });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("goes live over the stream and delivers change events", async () => {
    const events: ChangeEvent[] = [];
    const modes: FeedMode[] = [];
    const sub = subscribeChanges(client, {
      onEvent: (e) => events.push(e),
      onMode: (m) => modes.push(m),
    });
    await waitFor(() => sub.mode === "live", "live");
    fake.emit({
      type: "task.changed",
      humanId: null,
      projectId: "proj-1",
      sessionId: null,
      payload: { id: "t1" },
    });
    await waitFor(() => events.length === 1, "event");
    expect(events[0]?.type).toBe("task.changed");
    expect(events[0]?.seq).toBeGreaterThan(0);
    sub.close();
    expect(sub.mode).toBe("closed");
    expect(modes).toEqual(["live", "closed"]);
    const call = fake.calls("/events")[0];
    expect(call?.headers.authorization).toBe(`Bearer ${session.token}`);
    expect(call?.query).toBe("");
  });

  it("polls when the stream cannot open and retries it later", async () => {
    let failures = 2;
    const flaky = createClient({
      baseUrl: fake.url,
      session,
      clock,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/events") && failures > 0) {
          failures -= 1;
          return new Response("down", { status: 503 });
        }
        return fetch(url, init);
      },
    });
    let polls = 0;
    const modes: FeedMode[] = [];
    const sub = subscribeChanges(
      flaky,
      { onEvent: () => undefined, onPoll: () => polls++, onMode: (m) => modes.push(m) },
      { pollIntervalMs: 20, retryMs: 60 },
    );
    await waitFor(() => polls >= 2, "polling ticks");
    expect(sub.mode).toBe("polling");
    await waitFor(() => sub.mode === "live", "live after retry");
    const pollsAtLive = polls;
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBe(pollsAtLive);
    expect(modes.filter((m) => m === "polling").length).toBeGreaterThanOrEqual(1);
    sub.close();
  });

  it("resumes with Last-Event-ID after a dropped stream and replays what it missed", async () => {
    const events: ChangeEvent[] = [];
    const modes: FeedMode[] = [];
    const sub = subscribeChanges(
      client,
      { onEvent: (e) => events.push(e), onMode: (m) => modes.push(m) },
      { pollIntervalMs: 20, retryMs: 40 },
    );
    await waitFor(() => sub.mode === "live", "live");
    const a = fake.emit({
      type: "task.changed",
      humanId: null,
      projectId: null,
      sessionId: null,
      payload: { id: "a" },
    });
    await waitFor(() => events.length === 1, "first");
    fake.dropStreams();
    await waitFor(() => sub.mode === "polling", "polling");
    // Missed while polling: buffered on the service, replayed on reconnect.
    fake.emit({
      type: "task.changed",
      humanId: null,
      projectId: null,
      sessionId: null,
      payload: { id: "b" },
    });
    await waitFor(() => sub.mode === "live" && events.length === 2, "replayed");
    expect(events.map((e) => e.payload.id)).toEqual(["a", "b"]);
    const calls = fake.calls("/events");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["last-event-id"]).toBeUndefined();
    expect(calls[1]?.headers["last-event-id"]).toBe(String(a.seq));
    expect(modes).toEqual(["live", "polling", "connecting", "live"]);
    sub.close();
  });
});
