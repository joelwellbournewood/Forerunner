import { describe, expect, it, vi } from "vitest";
import { streamChat } from "../src/api/chat-stream.ts";
import { ApiError, createClient } from "../src/api/client.ts";
import {
  type EventSourceLike,
  parseDaemonEvent,
  SseParser,
  subscribeDaemonEvents,
  subscribeSessionEvents,
} from "../src/api/sse.ts";
import { createFakeDaemon } from "./fake-daemon.ts";
import { EVENTS } from "./fixtures.ts";
import { fetchFromApp, testConfig } from "./helpers.tsx";

describe("SseParser", () => {
  it("splits frames on blank lines, joins multi-line data and skips comments", () => {
    const p = new SseParser();
    const frames = p.feed(
      ': hello\nevent: token\ndata: {"a":1}\n\ndata: first\ndata: second\nid: 7\n\r\n',
    );
    expect(frames).toEqual([
      { event: "token", data: '{"a":1}' },
      { event: "message", data: "first\nsecond", id: "7" },
    ]);
    expect(p.feed("event: reply\ndata: tail")).toEqual([]);
    expect(p.end()).toEqual([{ event: "reply", data: "tail" }]);
  });
});

describe("parseDaemonEvent", () => {
  it("validates known events and drops unknown or malformed ones", () => {
    const ev = parseDaemonEvent("session.event", JSON.stringify(EVENTS[0]));
    expect(ev?.event).toBe("session.event");
    expect(parseDaemonEvent("inbox.changed", '{"blockingCount":2}')).toEqual({
      event: "inbox.changed",
      data: { blockingCount: 2 },
    });
    expect(parseDaemonEvent("inbox.changed", '{"blockingCount":"two"}')).toBeNull();
    expect(
      parseDaemonEvent(
        "extension.changed",
        '{"type":"extension.enabled","id":"e","name":"GitHub"}',
      ),
    ).toEqual({
      event: "extension.changed",
      data: { type: "extension.enabled", id: "e", name: "GitHub" },
    });
    expect(parseDaemonEvent("extension.changed", '{"type":"x"}')).toBeNull();
    expect(
      parseDaemonEvent(
        "restart.requested",
        '{"reason":"update","targetVersion":"0.2.0","fromVersion":"0.1.0","exitCode":86}',
      ),
    ).toEqual({
      event: "restart.requested",
      data: { reason: "update", targetVersion: "0.2.0", fromVersion: "0.1.0", exitCode: 86 },
    });
    expect(parseDaemonEvent("restart.requested", '{"reason":"update"}')).toBeNull();
    expect(
      parseDaemonEvent(
        "desktop.indicator",
        '{"on":true,"app":"code","sessionId":"sess_1","agentId":"agent_alice","at":"2026-10-23T08:00:00.000Z"}',
      ),
    ).toEqual({
      event: "desktop.indicator",
      data: {
        on: true,
        app: "code",
        sessionId: "sess_1",
        agentId: "agent_alice",
        at: "2026-10-23T08:00:00.000Z",
      },
    });
    expect(parseDaemonEvent("desktop.indicator", '{"on":false}')).toEqual({
      event: "desktop.indicator",
      data: { on: false },
    });
    expect(parseDaemonEvent("desktop.indicator", '{"on":"yes"}')).toBeNull();
    const started = {
      id: "speak_1",
      subject: { kind: "notification", id: "rec_1", notificationKind: "budget_stop" },
      source: "notification",
      player: "any",
      sentences: 2,
    };
    expect(parseDaemonEvent("speak.started", JSON.stringify(started))).toEqual({
      event: "speak.started",
      data: started,
    });
    expect(
      parseDaemonEvent("speak.started", JSON.stringify({ ...started, player: "everyone" })),
    ).toBeNull();
    expect(parseDaemonEvent("session.event", "not json")).toBeNull();
    expect(parseDaemonEvent("something.else", "{}")).toBeNull();
  });
});

function fakeEventSourceFactory(behaviour: "closed" | "ok") {
  const instances: Array<EventSourceLike & { fire: (name: string, data: string) => void }> = [];
  const factory = (_url: string) => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const es = {
      readyState: 0,
      onerror: null as ((ev: Event) => void) | null,
      onopen: null as ((ev: Event) => void) | null,
      addEventListener(type: string, listener: (ev: MessageEvent) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.readyState = 2;
      },
      fire(name: string, data: string) {
        for (const l of listeners.get(name) ?? []) l({ data } as MessageEvent);
      },
    };
    instances.push(es);
    queueMicrotask(() => {
      if (behaviour === "ok") {
        es.readyState = 1;
        es.onopen?.(new Event("open"));
      } else {
        es.readyState = 2;
        es.onerror?.(new Event("error"));
      }
    });
    return es;
  };
  return { factory, instances };
}

describe("subscribeSessionEvents", () => {
  it("delivers parsed events over EventSource", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const { factory, instances } = fakeEventSourceFactory("ok");
    const seen: string[] = [];
    const modes: string[] = [];
    const sub = subscribeSessionEvents(
      client,
      "sess_1",
      { onEvent: (e) => seen.push(e.event), onMode: (m) => modes.push(m) },
      { eventSource: factory },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(modes).toEqual(["sse"]);
    instances[0]?.fire("session.event", JSON.stringify(EVENTS[1]));
    instances[0]?.fire("heartbeat", JSON.stringify({ at: "2026-10-20T00:00:00.000Z" }));
    instances[0]?.fire("session.event", "garbage");
    expect(seen).toEqual(["session.event", "heartbeat"]);
    sub.close();
    expect(sub.mode).toBe("closed");
    expect(instances[0]?.readyState).toBe(2);
  });

  it("falls back to polling the JSON route when EventSource closes, without repeats", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const { factory } = fakeEventSourceFactory("closed");
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const seen: Array<{ event: string; seq?: number }> = [];
    const notices: string[] = [];
    const sub = subscribeSessionEvents(
      client,
      "sess_1",
      {
        onEvent: (e) =>
          seen.push({ event: e.event, seq: e.event === "session.event" ? e.data.seq : undefined }),
        onNotice: (n) => notices.push(n),
      },
      {
        eventSource: factory,
        afterSeq: 3,
        pollIntervalMs: 5000,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length;
        },
        clearTimer: () => {},
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(sub.mode).toBe("polling");
    expect(notices[0]).toMatch(/polling every 5 s/);
    expect(seen.filter((s) => s.event === "session.event").map((s) => s.seq)).toEqual([4, 5]);
    expect(seen.some((s) => s.event === "session.changed")).toBe(true);
    // The next poll is scheduled 5 s out and SSE retry 30 s out; a second tick repeats nothing.
    expect(timers.map((t) => t.ms)).toEqual([30_000, 5000]);
    const before = seen.length;
    timers[1]?.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.slice(before).filter((s) => s.event === "session.event")).toEqual([]);
    sub.close();
  });

  it("polls immediately when the browser has no EventSource at all", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const counts: number[] = [];
    const sub = subscribeDaemonEvents(
      client,
      "human_alice",
      {
        onEvent: (e) => {
          if (e.event === "inbox.changed") counts.push(e.data.blockingCount);
        },
      },
      { eventSource: undefined, setTimer: () => 0, clearTimer: () => {} },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(sub.mode).toBe("polling");
    expect(counts).toEqual([1]);
    sub.close();
  });
});

describe("streamChat", () => {
  it("collects tokens in order and returns the final reply", async () => {
    const daemon = createFakeDaemon({ token: "tok", tokenDelayMs: 0 });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const tokens: string[] = [];
    const reply = await streamChat(
      client,
      { humanId: "h", agentId: "agent_alice", projectId: "proj_atlas", text: "hello" },
      { onToken: (t) => tokens.push(t) },
    );
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens.join("")).toBe(reply.reply);
    expect(reply.reply).toContain("hello");
  });

  it("accepts a plain JSON reply, surfaces error frames and rejects a stream without a reply", async () => {
    const json = createClient(testConfig(), async () =>
      Response.json({
        reply: "plain",
        actions: [],
        pendingConfirmation: null,
        question: null,
        ttftMs: null,
        cost: { usdMicro: 0, chfMicro: 0 },
        transcriptId: "t",
        activeProjectId: null,
      }),
    );
    const onToken = vi.fn();
    const reply = await streamChat(json, { humanId: "h", agentId: "a", text: "x" }, { onToken });
    expect(reply.reply).toBe("plain");
    expect(onToken).toHaveBeenCalledWith("plain", "plain");

    const sse = (body: string) =>
      createClient(
        testConfig(),
        async () =>
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    const errored = await streamChat(
      sse('event: error\ndata: {"code":"budget.exceeded","message":"over cap"}\n\n'),
      { humanId: "h", agentId: "a", text: "x" },
    ).catch((e: unknown) => e);
    expect(errored).toBeInstanceOf(ApiError);
    expect((errored as ApiError).code).toBe("budget.exceeded");

    await expect(
      streamChat(sse('event: token\ndata: {"text":"hi"}\n\n'), {
        humanId: "h",
        agentId: "a",
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "ui.invalid_response" });

    const denied = createClient(testConfig(), async () =>
      Response.json({ code: "auth.unauthorized", message: "no" }, { status: 401 }),
    );
    await expect(
      streamChat(denied, { humanId: "h", agentId: "a", text: "x" }),
    ).rejects.toMatchObject({
      code: "auth.unauthorized",
      status: 401,
    });
  });
});
