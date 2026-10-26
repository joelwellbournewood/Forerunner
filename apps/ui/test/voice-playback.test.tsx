import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../src/api/client.ts";
import type { EventSourceLike } from "../src/api/sse.ts";
import type { AudioOutput } from "../src/lib/speech.ts";
import { AppRoutes } from "../src/routes.tsx";
import {
  type CapturedChunk,
  type CaptureFactory,
  floatToPcmBase64,
  type MicCapture,
  VoiceCaptureContext,
} from "../src/shell/voice-capture.ts";
import {
  followVoiceReply,
  JITTER_IDLE_MS,
  JITTER_MAX_MS,
  JITTER_START_MS,
  PLAYBACK_LEAD_MS,
} from "../src/shell/voice-playback.ts";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness } from "./helpers.tsx";

/**
 * The conversation panel plays the reply of a voice turn (spec O.3): the `audio` frames of
 * `GET /voice/sessions/:id/events` decoded from 16-bit PCM at their rate and channel count and
 * scheduled back to back through Web Audio once enough is buffered (a jitter buffer: a turn
 * starts, and a queue that ran dry inside a turn resumes, only with the target in hand or the
 * whole sentence; the target grows after each underrun, bounded), the first after a short
 * lead; a barge-in, an
 * error, a turn cut short (each for the turn being played), the session's stop and closing the
 * panel silence what is still queued; a frame replayed by a reconnect is not acted on twice;
 * what the human heard (release to the first chunk at the speaker) is posted per turn. jsdom
 * has neither EventSource nor AudioContext, so both are fakes here, and the page's clock too.
 */

type FakeSource = EventSourceLike & {
  url: string;
  closed: boolean;
  fire: (name: string, data: unknown) => void;
};

function fakeEventSources() {
  const instances: FakeSource[] = [];
  const factory = (url: string) => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const es: FakeSource = {
      url,
      closed: false,
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.closed = true;
        (es as { readyState: number }).readyState = 2;
      },
      fire(name, data) {
        for (const l of listeners.get(name) ?? [])
          l({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
      },
    };
    instances.push(es);
    queueMicrotask(() => {
      if (es.readyState !== 0) return;
      (es as { readyState: number }).readyState = 1;
      es.onopen?.(new Event("open"));
    });
    return es;
  };
  return { factory, instances };
}

interface Scheduled {
  at: number;
  channels: Float32Array[];
  sampleRate: number;
  stopped: boolean;
}

function fakeAudio(atCreate: () => void = () => {}) {
  const scheduled: Scheduled[] = [];
  const state = {
    closed: 0,
    resumed: 0,
    created: 0,
    currentTime: 0,
    outputLatency: undefined as number | undefined,
    baseLatency: undefined as number | undefined,
    running: "running" as "running" | "suspended",
  };
  const make = (): AudioOutput => {
    state.created++;
    atCreate();
    return {
      get currentTime() {
        return state.currentTime;
      },
      get outputLatency() {
        return state.outputLatency;
      },
      get baseLatency() {
        return state.baseLatency;
      },
      get state() {
        return state.running;
      },
      destination: {} as AudioNode,
      createBuffer(channels, frames, sampleRate) {
        const data = Array.from({ length: channels }, () => new Float32Array(frames));
        return {
          duration: frames / sampleRate,
          sampleRate,
          numberOfChannels: channels,
          copyToChannel(src: Float32Array, c: number) {
            data[c]?.set(src);
          },
          __data: data,
        } as unknown as AudioBuffer;
      },
      createBufferSource() {
        let entry: Scheduled | null = null;
        const node = {
          buffer: null as (AudioBuffer & { __data: Float32Array[] }) | null,
          onended: null as (() => void) | null,
          connect() {},
          disconnect() {},
          start(at: number) {
            entry = {
              at,
              channels: node.buffer?.__data ?? [],
              sampleRate: node.buffer?.sampleRate ?? 0,
              stopped: false,
            };
            scheduled.push(entry);
          },
          stop() {
            if (entry) entry.stopped = true;
          },
        };
        return node as unknown as AudioBufferSourceNode;
      },
      async close() {
        state.closed++;
      },
      async resume() {
        state.resumed++;
      },
    };
  };
  return { make, scheduled, state };
}

/** Base64 of 16-bit little-endian PCM. */
function pcm(samples: number[]): string {
  const bytes = new Uint8Array(new Int16Array(samples).buffer);
  return btoa(String.fromCharCode(...bytes));
}

function silentCapture(): CaptureFactory {
  return (): MicCapture => ({
    async start(onChunk: (c: CapturedChunk) => void) {
      onChunk({
        pcm: floatToPcmBase64(new Float32Array([0, 0.5])),
        sampleRate: 16000,
        channels: 1,
        timestampMs: 0,
      });
    },
    stop() {},
  });
}

function setup(withAudio = true) {
  const sources = fakeEventSources();
  const harness: Harness = createHarness();
  // Requests the panel had made when the output was created (it must come before the first).
  const madeAfter: number[] = [];
  const audio = fakeAudio(() => madeAfter.push(harness.daemon.state.calls.length));
  harness.daemon.state.nextVoiceLine = "what is next";
  const page = { now: 0 };
  const now = () => page.now;
  const realtime = withAudio
    ? { eventSource: sources.factory, audio: () => audio.make(), now }
    : { eventSource: sources.factory, audio: () => null, now };
  render(
    <VoiceCaptureContext.Provider value={silentCapture()}>
      <AppProvider client={harness.client} store={harness.store} realtime={realtime}>
        <MemoryRouter initialEntries={["/"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>
    </VoiceCaptureContext.Provider>,
  );
  return { sources, audio, harness, page, madeAfter };
}

const heardPosts = (h: ReturnType<typeof setup>) =>
  h.harness.daemon.state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/heard"));

async function startTalking(h: ReturnType<typeof setup>) {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("talk-open"));
  await user.click(await screen.findByTestId("voice-talk"));
  await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/));
  const id = [...h.harness.daemon.state.voiceSessions.keys()][0] ?? "";
  const stream = h.sources.instances.find((s) => s.url.includes(`/voice/sessions/${id}/events`));
  if (!stream) throw new Error("the panel opened no voice event stream");
  return { user, id, stream };
}

let seq = 100;
const frame = (type: string, turn: number | null, data: unknown = {}) => ({
  seq: ++seq,
  at: "2026-10-25T20:00:00.000Z",
  type,
  turn,
  data,
});
const audioFrame = (
  turn: number,
  samples: number[],
  sampleRate = 8000,
  channels = 1,
  sentenceIndex = 0,
) =>
  frame("audio", turn, {
    sentenceIndex,
    sampleRate,
    channels,
    timestampMs: 0,
    pcm: pcm(samples),
  });
/** `ms` of mono audio at 8 kHz in one chunk; the default fills the start target on its own. */
const audioMs = (turn: number, ms = JITTER_START_MS, sentenceIndex = 0) =>
  audioFrame(turn, new Array<number>(Math.round(ms * 8)).fill(1), 8000, 1, sentenceIndex);

describe("conversation panel: the voice reply is played", () => {
  it("follows the session's events with the token and plays the audio frames back to back", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    expect(stream.url).toContain("token=");
    expect(h.audio.state.created).toBe(1);
    expect(h.audio.state.resumed).toBe(1);

    act(() => {
      stream.fire("voice.event", frame("speaking_start", 1));
      stream.fire("voice.event", audioFrame(1, [0, 16384, -32768, 32767]));
      stream.fire("voice.event", audioFrame(1, [1, 2, 3, 4], 8000, 2));
    });
    // Less than the start target: held until the turn's audio is complete.
    expect(h.audio.scheduled).toHaveLength(0);
    act(() => {
      stream.fire("voice.event", frame("speaking_end", 1));
    });
    expect(h.audio.scheduled).toHaveLength(2);
    expect(Array.from(h.audio.scheduled[0]?.channels[0] ?? [])).toEqual([
      0,
      0.5,
      -1,
      32767 / 32768,
    ]);
    expect(h.audio.scheduled[0]?.sampleRate).toBe(8000);
    // An empty queue starts after the lead (no click if the main thread stalls a moment).
    expect(h.audio.scheduled[0]?.at).toBeCloseTo(PLAYBACK_LEAD_MS / 1000, 10);
    // The second chunk starts where the first ends: 4 frames at 8 kHz; stereo is two channels.
    expect(h.audio.scheduled[1]?.at).toBeCloseTo(PLAYBACK_LEAD_MS / 1000 + 4 / 8000, 10);
    expect(h.audio.scheduled[1]?.channels.map((c) => Array.from(c))).toEqual([
      [1 / 32768, 3 / 32768],
      [2 / 32768, 4 / 32768],
    ]);
    // A turn that ends normally lets the queued audio finish.
    act(() => {
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: false } }));
    });
    expect(h.audio.scheduled.every((s) => !s.stopped)).toBe(true);
  });

  it("silences the queue on a barge-in, an error and a turn cut short, and keeps playing the next turn", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(1, 100));
      stream.fire("voice.event", audioMs(1, 100));
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "" }));
    });
    expect(h.audio.scheduled.map((s) => s.stopped)).toEqual([true, true]);

    act(() => {
      stream.fire("voice.event", audioMs(2));
    });
    expect(h.audio.scheduled).toHaveLength(3);
    // After the silence the next chunk starts after the lead, not after the cut-off ones.
    expect(h.audio.scheduled[2]?.at).toBeCloseTo(PLAYBACK_LEAD_MS / 1000, 10);
    expect(h.audio.scheduled[2]?.stopped).toBe(false);
    act(() => {
      stream.fire("voice.event", frame("error", 2, { code: "provider_error", message: "x" }));
    });
    expect(h.audio.scheduled[2]?.stopped).toBe(true);

    act(() => {
      stream.fire("voice.event", audioMs(3));
      stream.fire("voice.event", frame("turn_end", 3, { latency: { interrupted: true } }));
    });
    expect(h.audio.scheduled[3]?.stopped).toBe(true);
    // Frames from before this panel's subscription are never replayed as sound.
    expect(stream.url).toMatch(/afterSeq=\d+/);
  });

  it("stops at the session's stop, which also ends the stream (no reconnect churn)", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(1));
      stream.fire("voice.event", frame("voice.stopped", 1, {}));
    });
    expect(h.audio.scheduled[0]?.stopped).toBe(true);
    expect(stream.closed).toBe(true);
    act(() => {
      stream.fire("voice.event", audioMs(2));
    });
    expect(h.audio.scheduled).toHaveLength(1);
  });

  it("stops when the panel closes, closing the stream and the output", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(1));
      stream.fire("voice.event", audioMs(1));
    });
    expect(h.audio.scheduled[1]?.stopped).toBe(false);

    await user.click(
      within(screen.getByTestId("conversation")).getByRole("button", { name: "Close" }),
    );
    await waitFor(() => expect(screen.queryByTestId("conversation")).toBeNull());
    expect(h.audio.scheduled[1]?.stopped).toBe(true);
    expect(stream.closed).toBe(true);
    expect(h.audio.state.closed).toBe(1);
  });

  it("a reconnect's replay is not acted on twice: an old barge-in does not silence the reply playing now", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    // Numbered in the order the daemon sent them.
    const firstChunk = audioMs(1);
    const bargeIn = frame("barge_in", 1, { spokenText: "" });
    const cutShort = frame("turn_end", 1, { latency: { interrupted: true } });
    act(() => {
      stream.fire("voice.event", firstChunk);
      stream.fire("voice.event", bargeIn);
      stream.fire("voice.event", cutShort);
      stream.fire("voice.event", audioMs(2));
    });
    expect(h.audio.scheduled.map((s) => s.stopped)).toEqual([true, false]);
    // The EventSource reconnected and the daemon replayed what it sent before.
    act(() => {
      stream.fire("voice.event", bargeIn);
      stream.fire("voice.event", cutShort);
      stream.fire("voice.event", { ...frame("error", 2, { code: "x", message: "x" }), seq: 1 });
    });
    expect(h.audio.scheduled[1]?.stopped).toBe(false);
  });

  it("acts on a silencing event only for the turn being played, and drops a silenced turn's late frames", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(2));
      // Events of another turn (an earlier turn's late error or interrupted end) leave it alone.
      stream.fire("voice.event", frame("error", 1, { code: "provider_error", message: "x" }));
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: true } }));
      stream.fire("voice.event", frame("barge_in", 3, { spokenText: "" }));
    });
    expect(h.audio.scheduled[0]?.stopped).toBe(false);
    act(() => {
      stream.fire("voice.event", frame("barge_in", 2, { spokenText: "" }));
      // A chunk of the cut-off turn still in flight is not played.
      stream.fire("voice.event", audioMs(2));
    });
    expect(h.audio.scheduled).toHaveLength(1);
    expect(h.audio.scheduled[0]?.stopped).toBe(true);
  });

  it("plays back to back while audio is queued, and re-buffers once the queue ran dry inside a turn", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(1));
    });
    const first = (h.audio.scheduled[0]?.at ?? 0) + JITTER_START_MS / 1000;
    h.audio.state.currentTime = 0.1; // still playing the first chunk
    act(() => {
      stream.fire("voice.event", audioMs(1, 20));
    });
    expect(h.audio.scheduled[1]?.at).toBeCloseTo(first, 10);
    h.audio.state.currentTime = 5; // the queue ran dry inside the reply (a late chunk)
    act(() => {
      stream.fire("voice.event", audioMs(1));
    });
    // Not played at once with a gap after it: held until the grown target is in hand.
    expect(h.audio.scheduled).toHaveLength(2);
    act(() => {
      stream.fire("voice.event", audioMs(1));
    });
    expect(h.audio.scheduled).toHaveLength(4);
    expect(h.audio.scheduled[2]?.at).toBeCloseTo(5 + PLAYBACK_LEAD_MS / 1000, 10);
    expect(h.audio.scheduled[3]?.at).toBeCloseTo(
      5 + (PLAYBACK_LEAD_MS + JITTER_START_MS) / 1000,
      10,
    );
  });

  it("measures what the human heard: the release to the first chunk at the speaker, posted once per turn", async () => {
    const h = setup();
    const { user, id, stream } = await startTalking(h);
    // Send at 1000 ms on the page's clock; the first chunk arrives at 1400 ms, the context at
    // 2 s, so it starts at 2.05 s (the lead) = 1450 ms on the page, and the device adds 20 ms.
    h.page.now = 1000;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    h.page.now = 1400;
    h.audio.state.currentTime = 2;
    h.audio.state.outputLatency = 0.02;
    h.audio.state.baseLatency = 0.005;
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", audioMs(1));
      stream.fire("voice.event", audioMs(1));
    });
    await waitFor(() => expect(heardPosts(h)).toHaveLength(1));
    expect(heardPosts(h)[0]).toMatchObject({
      path: `/voice/sessions/${id}/heard`,
      // 1450 ms on the page + 5 ms in the context (baseLatency) + 20 ms to the device
      // (outputLatency): the two are consecutive stages.
      body: { turn: 1, heardFirstAudioMs: 475 },
    });

    // The next turn: measured from its own release; without outputLatency, baseLatency counts.
    await user.click(screen.getByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    expect(h.audio.state.created).toBe(1); // the session's player keeps its output
    expect(h.audio.state.resumed).toBe(2); // resumed in the click
    h.page.now = 5000;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    h.page.now = 5900;
    h.audio.state.currentTime = 10;
    h.audio.state.outputLatency = undefined;
    act(() => {
      stream.fire("voice.event", audioMs(2));
    });
    await waitFor(() => expect(heardPosts(h)).toHaveLength(2));
    expect(heardPosts(h)[1]?.body).toEqual({ turn: 2, heardFirstAudioMs: 955 });

    // Audio of a turn with no release before it (nothing pressed) is not measured.
    act(() => {
      stream.fire("voice.event", audioMs(3));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(heardPosts(h)).toHaveLength(2);
  });

  it("does not measure a turn while the output is suspended (its clock is frozen; the sound is late or never)", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    h.page.now = 1000;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    h.page.now = 1400;
    h.audio.state.running = "suspended";
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", audioMs(1));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.audio.scheduled).toHaveLength(1);
    expect(heardPosts(h)).toHaveLength(0);
  });

  it("a released turn that ends without audio is not the reference for the next turn's audio", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    const user = userEvent.setup();
    h.page.now = 1000;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    act(() => {
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: false } }));
      stream.fire("voice.event", audioMs(2));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.audio.scheduled).toHaveLength(1);
    expect(heardPosts(h)).toHaveLength(0);
  });

  it("a Talk press while the ended turn's reply still plays stops it at once", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    act(() => {
      stream.fire("voice.event", audioMs(1, 600));
      stream.fire("voice.event", audioMs(1, 600));
      stream.fire("voice.event", frame("speaking_end", 1));
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: false } }));
    });
    // The daemon's turn is over; the window still has 1.2 s of it queued.
    expect(h.audio.scheduled.map((s) => s.stopped)).toEqual([false, false]);
    await user.click(screen.getByTestId("voice-talk"));
    expect(h.audio.scheduled.map((s) => s.stopped)).toEqual([true, true]);
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
  });

  it("creates and resumes the audio output in the Talk click, before the panel's first request", async () => {
    const h = setup();
    await startTalking(h);
    expect(h.audio.state.created).toBe(1);
    expect(h.madeAfter).toEqual([0]);
  });

  it("plays nothing where the window has no audio output, and the turn still works", async () => {
    const h = setup(false);
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioMs(1));
    });
    expect(h.audio.scheduled).toHaveLength(0);
  });
});

/**
 * The jitter buffer on its own (the player without the panel): a local TTS on a slow CPU
 * (Kokoro, the real-audio run of 2026-10-26) streams ~100 ms chunks slower than real time, and
 * a player that schedules each one as it arrives leaves a gap inside words at every late
 * chunk. Here the page's clock and the context's run together (1 ms of page time = 1 ms of
 * context time) and the player's timer is driven by `at()`.
 */
function directPlayer() {
  const sources = fakeEventSources();
  const audio = fakeAudio();
  const page = { now: 0 };
  const heard: Array<[number, number]> = [];
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const client = {
    url: () => "http://daemon.test/voice/sessions/s1/events",
    voiceHeard: async () => undefined,
  } as unknown as DaemonClient;
  const player = followVoiceReply(
    client,
    { id: "s1", lastSeq: 0 },
    {
      eventSource: sources.factory,
      output: audio.make(),
      now: () => page.now,
      onHeard: (turn, ms) => heard.push([turn, ms]),
      setTimer: (fn, ms) => {
        const t = { at: page.now + ms, fn, done: false };
        timers.push(t);
        return () => {
          t.done = true;
        };
      },
    },
  );
  if (!player) throw new Error("no player");
  const stream = sources.instances[0] as FakeSource;
  /** Move both clocks to `ms` (page time), firing the player's timers that fall due. */
  const at = (ms: number) => {
    page.now = ms;
    audio.state.currentTime = ms / 1000;
    for (const t of timers) {
      if (t.done || t.at > ms) continue;
      t.done = true;
      t.fn();
    }
  };
  const fire = (f: unknown) => stream.fire("voice.event", f);
  /** Gaps between consecutive scheduled chunks (s): where one does not start as the last ends. */
  const gaps = (chunkS: number) =>
    audio.scheduled
      .slice(1)
      .map((s, i) => s.at - ((audio.scheduled[i]?.at ?? 0) + chunkS))
      .filter((g) => g > 1e-9);
  return { player, audio, heard, at, fire, gaps };
}

describe("voice reply player: the jitter buffer", () => {
  it("plays chunks arriving slower than real time without a gap once the start target is buffered", () => {
    const p = directPlayer();
    // A sentence of eight 100 ms chunks, one every 120 ms (the TTS runs at 0.83x real time).
    for (let k = 0; k < 8; k++) {
      p.at(k * 120);
      p.fire(audioMs(1, 100));
    }
    p.fire(frame("speaking_end", 1));
    expect(p.audio.scheduled).toHaveLength(8);
    // Started once 200 ms were in hand (the second chunk, at 120 ms), after the lead.
    expect(p.audio.scheduled[0]?.at).toBeCloseTo(0.12 + PLAYBACK_LEAD_MS / 1000, 10);
    // Every start is where the previous chunk ends: no gap inside the sentence.
    expect(p.gaps(0.1)).toEqual([]);
    expect(p.player.bufferTargetMs).toBe(JITTER_START_MS);
  });

  it("re-buffers after an underrun instead of playing each late chunk with a gap, growing the target", () => {
    const p = directPlayer();
    // A long reply at 0.83x real time: the start buffer runs dry after a while.
    const n = 60;
    for (let k = 0; k < n; k++) {
      p.at(k * 120);
      p.fire(audioMs(1, 100));
    }
    p.fire(frame("speaking_end", 1));
    expect(p.audio.scheduled).toHaveLength(n);
    const gaps = p.gaps(0.1);
    // Scheduling each chunk on arrival would leave a gap at nearly every chunk; the buffer
    // leaves one pause per underrun, each long enough to refill the grown target.
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps.length).toBeLessThanOrEqual(3);
    expect(p.player.bufferTargetMs).toBeGreaterThan(JITTER_START_MS);
    expect(p.player.bufferTargetMs).toBeLessThanOrEqual(JITTER_MAX_MS);
    // Each resumption had the target in hand: the pause before it covers at least 300 ms of
    // arrivals (the 400 ms target at 0.83x real time, less the 100 ms that was late).
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(0.3);
  });

  it("a queue that ran dry at a sentence boundary re-buffers without raising the target", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 200, 0));
    // Sentence 1 comes after sentence 0 has played out (the model or TTS was slow to start it):
    // a pause between sentences, not a sign that the audio within a sentence comes too slowly.
    p.at(1000);
    p.fire(audioMs(1, 100, 1));
    expect(p.audio.scheduled).toHaveLength(1);
    expect(p.player.bufferTargetMs).toBe(JITTER_START_MS);
    p.at(1100);
    p.fire(audioMs(1, 100, 1));
    expect(p.audio.scheduled).toHaveLength(3);
    expect(p.player.bufferTargetMs).toBe(JITTER_START_MS);
    // Within sentence 1 the queue runs dry: that is too slow audio, and the target doubles.
    p.at(2000);
    p.fire(audioMs(1, 100, 1));
    expect(p.player.bufferTargetMs).toBe(JITTER_START_MS * 2);
    expect(p.audio.scheduled).toHaveLength(3);
  });

  it("bounds the target's growth and keeps it for the session's next turn", () => {
    const p = directPlayer();
    const seen: number[] = [];
    let t = 0;
    for (let i = 0; i < 6; i++) {
      // A chunk that fills even the largest target, then the queue runs dry before the next.
      p.at(t);
      p.fire(audioMs(1, JITTER_MAX_MS));
      t += JITTER_MAX_MS + 500;
      seen.push(p.player.bufferTargetMs);
    }
    expect(seen[0]).toBe(JITTER_START_MS);
    expect(seen[1]).toBe(JITTER_START_MS * 2);
    expect(Math.max(...seen)).toBe(JITTER_MAX_MS);
    expect(seen.at(-1)).toBe(JITTER_MAX_MS);
    // The next turn starts with the grown target: a slow CPU stays slow.
    p.at(t);
    p.fire(audioMs(2, JITTER_START_MS));
    const before = p.audio.scheduled.length;
    p.fire(audioMs(2, JITTER_MAX_MS - JITTER_START_MS));
    expect(p.audio.scheduled.length).toBe(before + 2);
  });

  it("starts a sentence shorter than the target once it is complete: the next sentence, the reply's end or a pause", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 50, 0));
    p.fire(audioMs(1, 50, 0));
    expect(p.audio.scheduled).toHaveLength(0);
    // The next sentence's first chunk says the first one is complete (before the pause rule).
    p.at(JITTER_IDLE_MS - 50);
    p.fire(audioMs(1, 50, 1));
    expect(p.audio.scheduled).toHaveLength(3);
    expect(p.gaps(0.05)).toEqual([]);

    // A short reply whose end is never announced still starts once nothing came for a while.
    p.at(5000);
    p.fire(audioMs(2, 80));
    p.at(5000 + JITTER_IDLE_MS - 1);
    expect(p.audio.scheduled).toHaveLength(3);
    p.at(5000 + JITTER_IDLE_MS);
    expect(p.audio.scheduled).toHaveLength(4);
    expect(p.audio.scheduled[3]?.at).toBeCloseTo(5 + JITTER_IDLE_MS / 1000 + 0.05, 10);
  });

  it("counts the buffering in what the human heard", () => {
    const p = directPlayer();
    p.at(1000);
    p.player.turnEnded();
    p.at(1100);
    p.fire(audioMs(1, 100));
    expect(p.heard).toEqual([]);
    p.at(1250);
    p.fire(audioMs(1, 100));
    // The first chunk came at 1100 but starts only once 200 ms are buffered (1250) plus the
    // lead: 1300 ms on the page, 300 ms after the release.
    expect(p.heard).toEqual([[1, 300]]);
  });

  it("a barge-in silences at once: what plays is stopped, what is buffered is dropped", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 200));
    p.at(100);
    p.fire(audioMs(1, 100));
    p.at(400); // ran dry: the next chunk is buffered, not played
    p.fire(audioMs(1, 100));
    expect(p.audio.scheduled).toHaveLength(2);
    p.fire(frame("barge_in", 1, { spokenText: "" }));
    expect(p.audio.scheduled.map((s) => s.stopped)).toEqual([true, true]);
    // Nothing buffered comes back: not on the pause timer, not on a late chunk of that turn.
    p.at(400 + JITTER_IDLE_MS * 4);
    p.fire(audioMs(1, 1000));
    expect(p.audio.scheduled).toHaveLength(2);
    // The next turn starts fresh after the lead.
    p.fire(audioMs(2, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(3);
    expect(p.audio.scheduled[2]?.stopped).toBe(false);
  });

  it.each([
    ["an error", frame("error", 1, { code: "provider_error", message: "x" })],
    ["the session's stop", frame("voice.stopped", 1, {})],
    ["a turn cut short", frame("turn_end", 1, { latency: { interrupted: true } })],
  ])("%s while audio sits buffered drops it: nothing plays later", (_name, event) => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 100));
    expect(p.audio.scheduled).toHaveLength(0);
    p.fire({ ...event, seq: ++seq });
    p.at(JITTER_IDLE_MS * 4);
    p.fire(frame("speaking_end", 1));
    expect(p.audio.scheduled).toHaveLength(0);
  });

  it("close() while audio sits buffered drops it and closes the output", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 100));
    p.player.close();
    p.at(JITTER_IDLE_MS * 4);
    expect(p.audio.scheduled).toHaveLength(0);
    expect(p.audio.state.closed).toBe(1);
  });

  it("interrupt() stops what plays and drops what is buffered, and the next turn plays", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, 300));
    p.at(400); // ran dry
    p.fire(audioMs(1, 100));
    expect(p.audio.scheduled).toHaveLength(1);
    p.player.interrupt();
    expect(p.audio.scheduled[0]?.stopped).toBe(true);
    p.at(400 + JITTER_IDLE_MS * 4);
    p.fire(audioMs(1, 1000));
    expect(p.audio.scheduled).toHaveLength(1);
    p.fire(audioMs(2, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(2);
    expect(p.audio.state.closed).toBe(0);
  });
});
