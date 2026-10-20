import type { StateClient } from "./client.ts";
import { ChangeEvent } from "./types.ts";

/**
 * The change feed (`GET /events`, ADR 0024). `EventSource` cannot send an `Authorization`
 * header and the service takes no query token, so the stream is read with `fetch` and a
 * `ReadableStream` reader. When the stream cannot be opened or ends, the feed polls: it
 * fires `onPoll` every `pollIntervalMs` so screens refetch, and retries the stream after
 * `retryMs`. Frames are parsed with the `ChangeEvent` schema; unknown ones are dropped.
 */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Incremental parser for `text/event-stream` chunks. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const message = this.line(line);
      if (message) out.push(message);
      index = this.buffer.indexOf("\n");
    }
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.data.length === 0 && this.event === "") return null;
      const message: SseMessage = {
        event: this.event || "message",
        data: this.data.join("\n"),
        ...(this.id !== undefined ? { id: this.id } : {}),
      };
      this.event = "";
      this.data = [];
      return message;
    }
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
}

export type FeedMode = "connecting" | "live" | "polling" | "closed";

export interface FeedHandlers {
  onEvent: (event: ChangeEvent) => void;
  onMode?: (mode: FeedMode) => void;
  /** Fired on every polling tick: screens reload what they show. */
  onPoll?: () => void;
  /** The service said the resume id is too old: reload everything. */
  onResync?: () => void;
}

export interface FeedOptions {
  pollIntervalMs?: number;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FeedSubscription {
  close(): void;
  readonly mode: FeedMode;
}

export function parseChangeFrame(message: SseMessage): ChangeEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(message.data);
  } catch {
    return null;
  }
  const parsed = ChangeEvent.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function subscribeChanges(
  client: StateClient,
  handlers: FeedHandlers,
  options: FeedOptions = {},
): FeedSubscription {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const retryMs = options.retryMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let mode: FeedMode = "connecting";
  let closed = false;
  let lastEventId: string | null = null;
  let controller: AbortController | null = null;
  let pollHandle: unknown = null;
  let retryHandle: unknown = null;

  const setMode = (next: FeedMode) => {
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

  const pollTick = () => {
    if (closed) return;
    handlers.onPoll?.();
    pollHandle = setTimer(pollTick, pollIntervalMs);
  };

  const startPolling = () => {
    if (closed) return;
    setMode("polling");
    stopPolling();
    pollHandle = setTimer(pollTick, pollIntervalMs);
    retryHandle = setTimer(() => {
      retryHandle = null;
      void connect();
    }, retryMs);
  };

  const handle = (message: SseMessage) => {
    if (message.id !== undefined) lastEventId = message.id;
    if (message.event === "ready") {
      stopPolling();
      setMode("live");
      return;
    }
    if (message.event === "heartbeat") return;
    if (message.event === "resync") {
      handlers.onResync?.();
      return;
    }
    const event = parseChangeFrame(message);
    if (event) handlers.onEvent(event);
  };

  async function connect(): Promise<void> {
    if (closed) return;
    setMode("connecting");
    controller = new AbortController();
    try {
      const res = await client.stream("/events", { lastEventId, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const message of parser.feed(decoder.decode(value, { stream: true }))) handle(message);
      }
    } catch {
      // opening failed or the connection dropped: fall back below
    }
    if (!closed) startPolling();
  }

  void connect();

  return {
    close() {
      closed = true;
      stopPolling();
      controller?.abort();
      setMode("closed");
    },
    get mode() {
      return mode;
    },
  };
}
