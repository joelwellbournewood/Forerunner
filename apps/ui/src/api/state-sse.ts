import {
  type EventView,
  EventView as EventViewSchema,
  type SessionView,
  SessionView as SessionViewSchema,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import { readSseStream } from "./sse.ts";
import type { StateClient } from "./state-client.ts";

/**
 * Realtime from the shared state service (spec F.3, R.3): `GET /events` (the change feed for
 * this human) and `GET /sessions/:id/events` (one live log). The service wants the bearer
 * token in a header, which `EventSource` cannot send, so the stream is a `fetch` with
 * `Accept: text/event-stream` read through `readSseStream`. When the stream cannot be opened
 * or drops, the helper polls (the caller's `poll` reloads what the screen shows) every
 * `pollIntervalMs` and retries the stream every `retryLiveMs`; when even polling fails the
 * mode is `offline`. The mode is shown in Settings as live / polling / offline.
 */
export type SyncMode = "connecting" | "live" | "polling" | "offline" | "closed";

const ChangePayload = z.looseObject({
  id: z.string().optional(),
  version: z.number().int().optional(),
});

export const StateChangeEvent = z.object({
  seq: z.number().int(),
  type: z.string(),
  at: z.string(),
  humanId: z.string().nullable(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  payload: ChangePayload,
  origin: z.string().optional(),
});
export type StateChangeEvent = z.infer<typeof StateChangeEvent>;

const Ready = z.looseObject({ seq: z.number().int().optional(), at: z.string().optional() });
const Resync = z.looseObject({ reason: z.string().optional() });
const Heartbeat = z.object({ at: z.string() });

export type StateStreamEvent =
  | { event: "ready"; data: z.infer<typeof Ready> }
  | { event: "resync"; data: z.infer<typeof Resync> }
  | { event: "heartbeat"; data: { at: string } }
  | { event: "changed"; data: StateChangeEvent }
  | { event: "session.event"; data: EventView }
  | { event: "session.changed"; data: SessionView };

/** One named SSE frame into a typed event; null for unknown names or malformed data. */
export function parseStateEvent(event: string, rawData: string): StateStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (event === "ready") {
    const p = Ready.safeParse(data);
    return p.success ? { event, data: p.data } : null;
  }
  if (event === "resync") {
    const p = Resync.safeParse(data);
    return p.success ? { event, data: p.data } : null;
  }
  if (event === "heartbeat") {
    const p = Heartbeat.safeParse(data);
    return p.success ? { event, data: p.data } : null;
  }
  if (event === "session.event") {
    // On /events the frame is a change event wrapping the row; on a session stream it is the view.
    const view = EventViewSchema.safeParse(data);
    if (view.success) return { event, data: view.data };
    const change = StateChangeEvent.safeParse(data);
    return change.success ? { event: "changed", data: change.data } : null;
  }
  if (event === "session.changed") {
    const view = SessionViewSchema.safeParse(data);
    if (view.success) return { event, data: view.data };
    const change = StateChangeEvent.safeParse(data);
    return change.success ? { event: "changed", data: change.data } : null;
  }
  if (event.endsWith(".changed")) {
    const p = StateChangeEvent.safeParse(data);
    return p.success ? { event: "changed", data: p.data } : null;
  }
  return null;
}

export interface StateStreamHandlers {
  onEvent: (event: StateStreamEvent) => void;
  onMode?: (mode: SyncMode) => void;
  onNotice?: (notice: string) => void;
}

export interface StateStreamOptions {
  /** Reload what the screen shows; called on every poll tick in polling mode. */
  poll?: () => Promise<void>;
  pollIntervalMs?: number;
  retryLiveMs?: number;
  /** Resume the change feed after this sequence number (`Last-Event-ID`). */
  lastEventId?: number;
  /** `false` forces polling (tests); default tries the stream first. */
  live?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StateStreamSubscription {
  close(): void;
  readonly mode: SyncMode;
  /** Highest change `seq` seen on the feed (for a resume). */
  readonly lastSeq: number | null;
}

interface Source {
  path: string;
  lastId: () => string | null;
}

function runStateStream(
  client: StateClient,
  source: Source,
  handlers: StateStreamHandlers,
  options: StateStreamOptions,
): StateStreamSubscription {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const retryLiveMs = options.retryLiveMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const liveAllowed = options.live ?? true;

  let mode: SyncMode = "connecting";
  let closed = false;
  let lastSeq: number | null = null;
  let controller: AbortController | null = null;
  let pollHandle: unknown = null;
  let retryHandle: unknown = null;

  const setMode = (next: SyncMode) => {
    if (mode === next) return;
    mode = next;
    handlers.onMode?.(next);
  };

  const deliver = (event: StateStreamEvent) => {
    if (closed) return;
    if (event.event === "changed") lastSeq = Math.max(lastSeq ?? 0, event.data.seq);
    handlers.onEvent(event);
  };

  const stopPolling = () => {
    if (pollHandle !== null) clearTimer(pollHandle);
    pollHandle = null;
    if (retryHandle !== null) clearTimer(retryHandle);
    retryHandle = null;
  };

  const startPolling = (reason: string) => {
    if (closed) return;
    controller?.abort();
    controller = null;
    if (mode !== "offline") setMode("polling");
    handlers.onNotice?.(reason);
    const loop = () => {
      if (closed || (mode !== "polling" && mode !== "offline")) return;
      const tick = options.poll ? options.poll() : Promise.resolve();
      tick
        .then(() => {
          if (mode === "offline") {
            setMode("polling");
            handlers.onNotice?.("back online; polling");
          }
        })
        .catch(() => {
          setMode("offline");
          handlers.onNotice?.("offline; retrying");
        })
        .finally(() => {
          if (!closed && (mode === "polling" || mode === "offline")) {
            pollHandle = setTimer(loop, pollIntervalMs);
          }
        });
    };
    loop();
    if (liveAllowed) {
      retryHandle = setTimer(() => {
        if (closed) return;
        stopPolling();
        void startLive();
      }, retryLiveMs);
    }
  };

  const startLive = async () => {
    if (closed) return;
    if (!liveAllowed) {
      startPolling("live stream disabled; polling");
      return;
    }
    setMode("connecting");
    const ac = new AbortController();
    controller = ac;
    let res: Response;
    try {
      const lastId = source.lastId();
      res = await client.raw({
        method: "GET",
        path: source.path,
        accept: "text/event-stream",
        signal: ac.signal,
        ...(lastId ? { headers: { "Last-Event-ID": lastId } } : {}),
      });
    } catch {
      if (closed || controller !== ac) return;
      startPolling("live stream failed to open; polling");
      return;
    }
    if (closed || controller !== ac) return;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/event-stream")) {
      startPolling(
        res.status === 401 || res.status === 403
          ? "live stream refused; polling"
          : "live stream unavailable; polling",
      );
      return;
    }
    setMode("live");
    try {
      for await (const frame of readSseStream(res)) {
        if (closed || controller !== ac) break;
        const parsed = parseStateEvent(frame.event, frame.data);
        if (parsed) deliver(parsed);
      }
    } catch {
      // dropped
    }
    if (closed || controller !== ac) return;
    startPolling("live stream dropped; polling");
  };

  void startLive();

  return {
    get mode() {
      return mode;
    },
    get lastSeq() {
      return lastSeq;
    },
    close() {
      if (closed) return;
      closed = true;
      stopPolling();
      controller?.abort();
      controller = null;
      setMode("closed");
    },
  };
}

/** The human's change feed: `*.changed` events plus heartbeat; resumes with `lastEventId`. */
export function subscribeStateEvents(
  client: StateClient,
  handlers: StateStreamHandlers,
  options: StateStreamOptions = {},
): StateStreamSubscription {
  let lastSeq = options.lastEventId ?? null;
  const wrapped: StateStreamHandlers = {
    ...handlers,
    onEvent: (event) => {
      if (event.event === "changed") lastSeq = event.data.seq;
      handlers.onEvent(event);
    },
  };
  return runStateStream(
    client,
    { path: "/events", lastId: () => (lastSeq === null ? null : String(lastSeq)) },
    wrapped,
    options,
  );
}

/** One session's live log; polling reads the JSON page after the last `seq` seen. */
export function subscribeStateSessionEvents(
  client: StateClient,
  sessionId: string,
  handlers: StateStreamHandlers,
  options: StateStreamOptions & { afterSeq?: number } = {},
): StateStreamSubscription {
  let lastSeq = options.afterSeq ?? 0;
  const wrapped: StateStreamHandlers = {
    ...handlers,
    onEvent: (event) => {
      if (event.event === "session.event" && event.data.seq > lastSeq) lastSeq = event.data.seq;
      handlers.onEvent(event);
    },
  };
  const poll = async () => {
    const events = await client.sessionEvents(sessionId, lastSeq);
    for (const ev of events) {
      if (ev.seq <= lastSeq) continue;
      wrapped.onEvent({ event: "session.event", data: ev });
    }
    const session = await client.session(sessionId);
    wrapped.onEvent({ event: "session.changed", data: session });
  };
  return runStateStream(
    client,
    {
      path: `/sessions/${encodeURIComponent(sessionId)}/events`,
      lastId: () => (lastSeq > 0 ? String(lastSeq) : null),
    },
    wrapped,
    { ...options, poll },
  );
}
