import {
  DesktopIndicatorEventData,
  type EventView,
  EventView as EventViewSchema,
  type SessionView,
  SessionView as SessionViewSchema,
  SpeakStartedView as SpeakStartedSchema,
  type SpeakStartedView,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import { type DaemonClient, routePath } from "./client.ts";

/**
 * Realtime from the daemon (ADR 0011, ADR 0025). Two streams: `/events` for the whole
 * install (inbox counts, session and project changes) and `/sessions/:id/events` for one
 * live log. Both use EventSource when the browser has it; EventSource cannot send headers, so
 * the bearer token travels as the `token` query parameter on these two routes only. When
 * EventSource is missing or gives up (readyState CLOSED, e.g. a 401 or a proxy that buffers),
 * the helper polls the JSON routes every `pollIntervalMs` (5 s) and retries SSE later, so the
 * UI never sits on a silent spinner.
 */

export type { DesktopIndicatorEventData };

export type StreamMode = "connecting" | "sse" | "polling" | "closed";

export interface ExtensionChanged {
  type: string;
  id: string;
  name: string;
}
/** "Update and restart": the daemon is going down and comes back as `targetVersion`. */
export interface RestartRequested {
  reason: string;
  targetVersion: string;
  fromVersion: string;
  exitCode: number;
}

export type DaemonEvent =
  | { event: "session.event"; data: EventView }
  | { event: "inbox.changed"; data: { blockingCount: number } }
  | { event: "session.changed"; data: SessionView }
  | { event: "project.changed"; data: { id: string } }
  /** An agent was renamed (U-025): `/me` and `/agents` are read again. */
  | { event: "agent.changed"; data: { id: string; name: string } }
  | { event: "extension.changed"; data: ExtensionChanged }
  | { event: "restart.requested"; data: RestartRequested }
  /** Desktop control's on-screen indicator (spec S.32): the banner shows while `on`. */
  | { event: "desktop.indicator"; data: DesktopIndicatorEventData }
  /** Something is being read aloud (ADR 0063); a speech player plays `player: "any"` ones. */
  | { event: "speak.started"; data: SpeakStartedView }
  | { event: "heartbeat"; data: { at: string } };

const InboxChanged = z.object({ blockingCount: z.number().int() });
const ProjectChanged = z.object({ id: z.string() });
const AgentChanged = z.object({ id: z.string(), name: z.string() });
const ExtensionChangedSchema = z.object({ type: z.string(), id: z.string(), name: z.string() });
const RestartRequestedSchema = z.object({
  reason: z.string(),
  targetVersion: z.string(),
  fromVersion: z.string(),
  exitCode: z.number().int(),
});
const Heartbeat = z.object({ at: z.string() });

/** Parse one named SSE message into a typed event; null when the name or data is unknown. */
export function parseDaemonEvent(event: string, rawData: string): DaemonEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }
  switch (event) {
    case "session.event": {
      const p = EventViewSchema.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "inbox.changed": {
      const p = InboxChanged.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "session.changed": {
      const p = SessionViewSchema.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "project.changed": {
      const p = ProjectChanged.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "agent.changed": {
      const p = AgentChanged.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "extension.changed": {
      const p = ExtensionChangedSchema.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "restart.requested": {
      const p = RestartRequestedSchema.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "desktop.indicator": {
      const p = DesktopIndicatorEventData.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "speak.started": {
      const p = SpeakStartedSchema.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    case "heartbeat": {
      const p = Heartbeat.safeParse(data);
      return p.success ? { event, data: p.data } : null;
    }
    default:
      return null;
  }
}

export const DAEMON_EVENT_NAMES = [
  "session.event",
  "inbox.changed",
  "session.changed",
  "project.changed",
  "agent.changed",
  "extension.changed",
  "restart.requested",
  "desktop.indicator",
  "speak.started",
  "heartbeat",
] as const;

/** The subset of the EventSource interface the helpers use; injectable for tests. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface StreamHandlers {
  onEvent: (event: DaemonEvent) => void;
  onMode?: (mode: StreamMode) => void;
  /** Called with a short reason on every fallback or reconnect, for the status line. */
  onNotice?: (notice: string) => void;
  /**
   * The daemon did not answer a poll, or refused it (a 401 after a restart with a new token):
   * the shell shows "not connected" (U-071). Polling goes on, and `onUp` follows the next
   * answer.
   */
  onDown?: (error: unknown) => void;
  /** The daemon answered again: a poll went through, or the live stream (re)opened (U-071). */
  onUp?: () => void;
}

export interface StreamOptions {
  /** Polling cadence in the fallback; 5 s by default. */
  pollIntervalMs?: number;
  /** After this long in polling mode, try SSE again; 30 s by default. */
  retrySseMs?: number;
  /** EventSource constructor; `undefined` forces polling (jsdom has none). */
  eventSource?: EventSourceFactory | undefined;
  /** Timer functions, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StreamSubscription {
  close(): void;
  readonly mode: StreamMode;
}

const CLOSED = 2;

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  if (typeof EventSource === "undefined") return undefined;
  return (url) => new EventSource(url);
}

interface Poller {
  tick(): Promise<void>;
}

/** Shared machinery: SSE first, polling fallback, periodic retry of SSE. */
function runStream(
  sseUrl: string,
  poller: Poller,
  handlers: StreamHandlers,
  options: StreamOptions,
): StreamSubscription {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const retrySseMs = options.retrySseMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const factory =
    options.eventSource === undefined ? defaultEventSourceFactory() : options.eventSource;

  let mode: StreamMode = "connecting";
  let closed = false;
  let source: EventSourceLike | null = null;
  let pollHandle: unknown = null;
  let retryHandle: unknown = null;
  let sseFailures = 0;

  const setMode = (next: StreamMode) => {
    if (mode === next) return;
    mode = next;
    handlers.onMode?.(next);
  };

  const stopPolling = () => {
    if (pollHandle !== null) clearTimer(pollHandle);
    pollHandle = null;
    if (retryHandle !== null) clearTimer(retryHandle);
    retryHandle = null;
  };

  const startPolling = (reason: string) => {
    if (closed) return;
    if (source) {
      source.close();
      source = null;
    }
    setMode("polling");
    handlers.onNotice?.(reason);
    const loop = () => {
      if (closed || mode !== "polling") return;
      poller
        .tick()
        .then(
          () => {
            if (!closed) handlers.onUp?.();
          },
          (error: unknown) => {
            if (closed) return;
            handlers.onNotice?.("poll failed; retrying");
            handlers.onDown?.(error);
          },
        )
        .finally(() => {
          if (!closed && mode === "polling") pollHandle = setTimer(loop, pollIntervalMs);
        });
    };
    loop();
    if (factory) {
      retryHandle = setTimer(() => {
        if (closed) return;
        stopPolling();
        startSse();
      }, retrySseMs);
    }
  };

  const startSse = () => {
    if (closed) return;
    if (!factory) {
      startPolling("live stream unavailable in this browser; polling every 5 s");
      return;
    }
    setMode("connecting");
    let es: EventSourceLike;
    try {
      es = factory(sseUrl);
    } catch {
      startPolling("live stream failed to open; polling every 5 s");
      return;
    }
    source = es;
    es.onopen = () => {
      sseFailures = 0;
      setMode("sse");
      handlers.onUp?.();
    };
    for (const name of DAEMON_EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        if (closed) return;
        const parsed = parseDaemonEvent(name, String(ev.data));
        if (parsed) handlers.onEvent(parsed);
      });
    }
    es.onerror = () => {
      if (closed || source !== es) return;
      sseFailures += 1;
      if (es.readyState === CLOSED || sseFailures >= 3) {
        startPolling("live stream dropped; polling every 5 s");
      } else {
        setMode("connecting");
        handlers.onNotice?.("live stream reconnecting");
      }
    };
  };

  startSse();

  return {
    get mode() {
      return mode;
    },
    close() {
      if (closed) return;
      closed = true;
      stopPolling();
      if (source) source.close();
      source = null;
      setMode("closed");
    },
  };
}

/**
 * The indicator frame a status read stands for: what a shell that missed the frames (polling,
 * a reconnect) would have been told last. `on` carries the names the banner shows.
 */
export function indicatorFromStatus(control: {
  active: boolean;
  app: string | null;
  sessionId: string | null;
  agentId: string | null;
  since: string | null;
}): DesktopIndicatorEventData {
  if (!control.active) return { on: false };
  return {
    on: true,
    ...(control.app ? { app: control.app } : {}),
    ...(control.sessionId ? { sessionId: control.sessionId } : {}),
    ...(control.agentId ? { agentId: control.agentId } : {}),
    ...(control.since ? { at: control.since } : {}),
  };
}

/**
 * The install-wide stream. In polling mode it reads `/inbox` for the blocking count,
 * `/sessions?status=running` for session changes and `/desktop/status` for the desktop
 * control indicator (a daemon without the desktop routes leaves the indicator as it is).
 * `speechPlayer` declares this window a speech player (`?speech=play`, ADR 0063): the daemon
 * then counts it as someone who hears voice alerts and `summary.speak`, so pass it only where
 * the window plays the frames.
 */
export function subscribeDaemonEvents(
  client: DaemonClient,
  humanId: string,
  handlers: StreamHandlers,
  options: StreamOptions & { speechPlayer?: boolean } = {},
): StreamSubscription {
  const poller: Poller = {
    async tick() {
      const inbox = await client.inbox(humanId);
      handlers.onEvent({ event: "inbox.changed", data: { blockingCount: inbox.blockingCount } });
      const running = await client.sessions({ status: "running" });
      for (const s of running) handlers.onEvent({ event: "session.changed", data: s });
      try {
        const desktop = await client.desktopStatus();
        handlers.onEvent({
          event: "desktop.indicator",
          data: indicatorFromStatus(desktop.desktopControl),
        });
      } catch {
        // no desktop routes on this daemon, or a transient failure: the next tick reads again
      }
      handlers.onEvent({ event: "heartbeat", data: { at: new Date().toISOString() } });
    },
  };
  const query = options.speechPlayer ? { speech: "play" } : undefined;
  return runStream(client.url(routePath("events"), query, true), poller, handlers, options);
}

/**
 * One session's live log. In polling mode it reads the JSON route with `afterSeq` so no
 * event is delivered twice, and re-reads the session header for status and spend.
 */
export function subscribeSessionEvents(
  client: DaemonClient,
  sessionId: string,
  handlers: StreamHandlers,
  options: StreamOptions & { afterSeq?: number } = {},
): StreamSubscription {
  let lastSeq = options.afterSeq ?? 0;
  const wrapped: StreamHandlers = {
    ...handlers,
    onEvent: (event) => {
      if (event.event === "session.event" && event.data.seq > lastSeq) lastSeq = event.data.seq;
      handlers.onEvent(event);
    },
  };
  const poller: Poller = {
    async tick() {
      const events = await client.sessionEvents(sessionId, lastSeq);
      for (const ev of events) {
        if (ev.seq <= lastSeq) continue;
        wrapped.onEvent({ event: "session.event", data: ev });
      }
      const session = await client.session(sessionId);
      wrapped.onEvent({ event: "session.changed", data: session });
    },
  };
  const url = client.url(routePath("sessionEvents", { id: sessionId }), undefined, true);
  return runStream(url, poller, wrapped, options);
}

/** One SSE frame. */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for `text/event-stream` bodies read through fetch (used by the chat
 * stream, which is a POST and cannot use EventSource). Feed chunks; collect frames.
 */
export class SseParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];
  private id: string | undefined;

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: SseFrame[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const frame = this.line(line);
      if (frame) frames.push(frame);
      idx = this.buffer.indexOf("\n");
    }
    return frames;
  }

  /** Flush a trailing frame without a final blank line. */
  end(): SseFrame[] {
    const frames = this.feed("\n");
    if (this.buffer.length > 0) {
      const frame = this.line(this.buffer);
      this.buffer = "";
      if (frame) frames.push(frame);
    }
    const last = this.dispatch();
    if (last) frames.push(last);
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line.length === 0) return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
    return null;
  }

  private dispatch(): SseFrame | null {
    if (this.data.length === 0) {
      this.event = "message";
      return null;
    }
    const frame: SseFrame = { event: this.event, data: this.data.join("\n") };
    if (this.id !== undefined) frame.id = this.id;
    this.event = "message";
    this.data = [];
    this.id = undefined;
    return frame;
  }
}

/** Read a streamed Response body as SSE frames. */
export async function* readSseStream(res: Response): AsyncGenerator<SseFrame> {
  const body = res.body;
  if (!body) {
    const parser = new SseParser();
    for (const frame of parser.end()) yield frame;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) yield frame;
    }
    for (const frame of parser.end()) yield frame;
  } finally {
    reader.releaseLock();
  }
}
