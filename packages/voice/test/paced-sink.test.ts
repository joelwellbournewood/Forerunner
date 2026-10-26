import { type Clock, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { PACED_SINK_AHEAD_MS, pacedSink } from "../src/loop.ts";
import type { AudioChunk } from "../src/types.ts";

/**
 * The daemon's default sink paces the reply's chunks (the `audio` frames go out as the loop
 * hands each chunk to it). Its timer wakes late on a busy machine (Windows timers, a CPU
 * pegged by local TTS): a sink that slept each chunk's duration from its own late wake-up fell
 * behind real time a little per chunk, so a reply streamed fast enough still reached the
 * player slower than real time and the player's queue ran dry inside words. The sink keeps a
 * play-head instead and may run a bounded amount ahead of it.
 */

const chunk = (ms: number, sampleRate = 24000): AudioChunk => ({
  pcm: new Int16Array(Math.round((sampleRate * ms) / 1000)),
  sampleRate,
  channels: 1,
  timestampMs: 0,
});

/** A clock whose sleeps wake `lateMs` after their deadline, like a loaded event loop. */
function lateClock(inner: SimulatedClock, lateMs: number): Clock {
  return {
    now: () => inner.now(),
    nowIso: () => inner.nowIso(),
    monotonic: () => inner.monotonic(),
    setTimeout: (fn, ms) => inner.setTimeout(fn, ms + lateMs),
    sleep: (ms, signal) => inner.sleep(ms + lateMs, signal),
  };
}

/** Hand `chunks` to the sink in order, recording when each was handed over. */
async function run(
  clock: SimulatedClock,
  sink: ReturnType<typeof pacedSink>,
  chunks: Array<{ c: AudioChunk; arrivesAt?: number }>,
): Promise<number[]> {
  const handed: number[] = [];
  let done = false;
  const producer = (async () => {
    const signal = new AbortController().signal;
    for (const { c, arrivesAt } of chunks) {
      while (arrivesAt !== undefined && clock.monotonic() < arrivesAt) await clock.sleep(1);
      handed.push(clock.monotonic());
      await sink.play(c, signal);
    }
    done = true;
  })();
  for (let i = 0; i < 20000 && !done; i++) {
    // Let the producer run to its next sleep before time moves on.
    await new Promise<void>((r) => setImmediate(r));
    if (!done) await clock.advance(1);
  }
  await producer;
  return handed;
}

describe("pacedSink", () => {
  it("keeps to real time when its timer wakes late (no drift over a reply)", async () => {
    const clock = new SimulatedClock();
    const sink = pacedSink(lateClock(clock, 12));
    const handed = await run(
      clock,
      sink,
      Array.from({ length: 30 }, () => ({ c: chunk(100) })),
    );
    // Chunk k is due to start playing at k * 100 ms. It is handed over no later than that
    // (the player has it before it is due), and no more than the bounded lead before it.
    for (const [k, at] of handed.entries()) {
      expect(at).toBeLessThanOrEqual(k * 100);
      expect(at).toBeGreaterThanOrEqual(k * 100 - PACED_SINK_AHEAD_MS - 12);
    }
  });

  it("hands over the first chunks at once, up to its lead, then paces", async () => {
    const clock = new SimulatedClock();
    const handed = await run(
      clock,
      pacedSink(clock),
      Array.from({ length: 10 }, () => ({ c: chunk(100) })),
    );
    const atOnce = handed.filter((t) => t === 0).length;
    expect(atOnce).toBe(Math.floor(PACED_SINK_AHEAD_MS / 100) + 1);
    expect(handed.at(-1)).toBe(900 - PACED_SINK_AHEAD_MS);
  });

  it("restarts its play-head from now after a chunk that came late (a real gap)", async () => {
    const clock = new SimulatedClock();
    const handed = await run(clock, pacedSink(clock), [
      { c: chunk(100) },
      { c: chunk(100), arrivesAt: 1000 },
      { c: chunk(100) },
      { c: chunk(100) },
      { c: chunk(100) },
      { c: chunk(100) },
    ]);
    expect(handed[1]).toBe(1000);
    // From 1000 the play-head runs on: chunk 5 starts at 1400 and goes out by its lead.
    expect(handed[5]).toBe(1400 - PACED_SINK_AHEAD_MS);
  });

  it("drain() resolves once the play-head has ended: the lead is played out, not dropped", async () => {
    const clock = new SimulatedClock();
    const sink = pacedSink(clock);
    const signal = new AbortController().signal;
    // Three 100 ms chunks fit in the lead: all handed over at 0.
    for (let i = 0; i < 3; i++) await sink.play(chunk(100), signal);
    expect(clock.monotonic()).toBe(0);
    let drained: number | null = null;
    const draining = sink.drain?.(signal).then(() => {
      drained = clock.monotonic();
    });
    expect(draining).toBeDefined();
    for (let i = 0; i < 400 && drained === null; i++) {
      await new Promise<void>((r) => setImmediate(r));
      if (drained === null) await clock.advance(1);
    }
    expect(drained).toBe(300);
    // Nothing pending: at once.
    const t = clock.monotonic();
    await sink.drain?.(signal);
    expect(clock.monotonic()).toBe(t);
  });

  it("drain() ends at once on the abort (a barge-in) and after stop()", async () => {
    const clock = new SimulatedClock();
    const sink = pacedSink(clock);
    const abort = new AbortController();
    await sink.play(chunk(250), abort.signal);
    let done = false;
    const draining = sink.drain?.(abort.signal).then(() => {
      done = true;
    });
    await clock.advance(10);
    expect(done).toBe(false);
    abort.abort();
    await draining;
    expect(done).toBe(true);
    expect(clock.monotonic()).toBe(10);
    // 240 ms of the play-head are left; a barge-in's stop() flushes them.
    sink.stop();
    await sink.drain?.(new AbortController().signal);
    expect(clock.monotonic()).toBe(10);
  });

  it("stop() flushes the play-head: the next reply starts from now", async () => {
    const clock = new SimulatedClock();
    const sink = pacedSink(clock);
    await run(
      clock,
      sink,
      Array.from({ length: 5 }, () => ({ c: chunk(100) })),
    );
    sink.stop();
    const handed = await run(
      clock,
      sink,
      Array.from({ length: 4 }, () => ({ c: chunk(100) })),
    );
    const t0 = handed[0] ?? 0;
    expect(handed.filter((t) => t === t0).length).toBe(Math.floor(PACED_SINK_AHEAD_MS / 100) + 1);
  });
});
