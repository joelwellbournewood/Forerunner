import type { Clock } from "@forerunner/platform";
import { streamSSE } from "hono/streaming";
import type { Ctx } from "./http.ts";

/**
 * One SSE loop shape for /events and /sessions/:id/events: send an initial batch, then wait
 * for a push (wake), a poll tick or the heartbeat deadline, flush what is new, repeat until
 * the client goes away. Time goes through the Clock so tests drive it.
 */
export type SseSend = (event: string, data: unknown, id?: string) => Promise<void>;

export interface SseLoopOptions {
  clock: Clock;
  heartbeatMs: number;
  /** Poll interval for the flush when nothing wakes the loop; undefined = heartbeat only. */
  pollMs?: number;
  init: (send: SseSend) => Promise<void>;
  subscribe: (wake: () => void) => () => void;
  flush: (send: SseSend) => Promise<void>;
}

export function sseLoop(c: Ctx, opts: SseLoopOptions): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let wakeResolve: (() => void) | undefined;
    const wake = () => {
      const r = wakeResolve;
      wakeResolve = undefined;
      r?.();
    };
    const close = () => {
      closed = true;
      wake();
    };
    stream.onAbort(close);
    const signal = c.req.raw.signal;
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });

    const send: SseSend = async (event, data, id) => {
      if (closed) return;
      await stream.writeSSE({ event, data: JSON.stringify(data), ...(id ? { id } : {}) });
    };

    await opts.init(send);
    const unsubscribe = opts.subscribe(wake);
    let lastBeat = opts.clock.now();
    try {
      while (!closed) {
        const untilBeat = Math.max(0, opts.heartbeatMs - (opts.clock.now() - lastBeat));
        const waitMs = opts.pollMs === undefined ? untilBeat : Math.min(untilBeat, opts.pollMs);
        let cancel: (() => void) | undefined;
        await new Promise<void>((resolve) => {
          wakeResolve = resolve;
          cancel = opts.clock.setTimeout(resolve, waitMs);
        });
        cancel?.();
        wakeResolve = undefined;
        if (closed) break;
        await opts.flush(send);
        if (opts.clock.now() - lastBeat >= opts.heartbeatMs) {
          lastBeat = opts.clock.now();
          await send("heartbeat", { at: opts.clock.nowIso() });
        }
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", close);
    }
  });
}
