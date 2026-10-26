import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../src/api/client.ts";
import type { EventSourceLike } from "../src/api/sse.ts";
import type { AudioOutput } from "../src/lib/speech.ts";
import { storageKey } from "../src/lib/storage.ts";
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
import { createStore } from "../src/store/store.ts";
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
  /** The node played to its end (what `onended` reports in a browser). */
  end: () => void;
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
              end: () => node.onended?.(),
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
  const ends: number[] = [];
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
      onSpeakingEnd: (turn) => ends.push(turn),
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
  return { player, audio, heard, ends, at, fire, gaps };
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

/**
 * The reply's text in the panel (the real-audio run of 2026-10-26: the text showed only once
 * the reply had been spoken): the human's words as the STT recognises them, the reply's text
 * as the model generates it (`model_delta`, `sentence`), the sentence being spoken marked, and
 * after a barge-in what was not spoken set apart. And the reply mode: "Reply: text" asks the
 * daemon for text-only replies (no TTS, no audio), is remembered per install, and a Talk press
 * while the text is written stops it.
 */
describe("conversation panel: the reply's text as it comes", () => {
  const agentLine = () => screen.getAllByTestId("conversation-agent").at(-1) as HTMLElement;
  const humanLine = () => screen.getAllByTestId("conversation-human").at(-1) as HTMLElement;

  it("shows the human's words as they are recognised and the reply as it is generated, before the turn ends", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("transcript_partial", 1, { text: "what is" }));
    });
    expect(humanLine().textContent).toContain("what is");
    expect(humanLine().dataset.partial).toBe("true");
    act(() => {
      stream.fire("voice.event", frame("transcript_final", 1, { text: "what is next" }));
    });
    expect(humanLine().textContent).toContain("what is next");
    expect(humanLine().dataset.partial).toBeUndefined();
    // One human line for the turn, not one per frame.
    expect(screen.getAllByTestId("conversation-human")).toHaveLength(1);

    act(() => {
      stream.fire("voice.event", frame("model_delta", 1, { text: "All good. " }));
    });
    expect(agentLine().textContent).toContain("All good.");
    act(() => {
      stream.fire("voice.event", frame("sentence", 1, { index: 0, text: "All good." }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "Two tasks" }));
    });
    // The finished sentence and the part of the next one generated so far.
    expect(agentLine().textContent).toContain("All good. Two tasks");
    act(() => {
      stream.fire("voice.event", frame("model_delta", 1, { text: " remain." }));
      stream.fire("voice.event", frame("sentence", 1, { index: 1, text: "Two tasks remain." }));
    });
    expect(agentLine().textContent).toContain("All good. Two tasks remain.");
    expect(agentLine().textContent).not.toContain("remain. remain.");
    expect(screen.getAllByTestId("conversation-agent")).toHaveLength(1);
  });

  it("marks the sentence being spoken, and after a barge-in sets apart what was not spoken", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "what is next" }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "All good. Two tasks remain." }));
      stream.fire("voice.event", frame("sentence", 1, { index: 0, text: "All good." }));
      stream.fire("voice.event", frame("sentence", 1, { index: 1, text: "Two tasks remain." }));
      stream.fire("voice.event", audioMs(1, JITTER_START_MS, 0));
    });
    // Marked when its audio starts at the speaker (after the lead), not when the frame came.
    await waitFor(() =>
      expect(within(agentLine()).getByText("All good.").dataset.speaking).toBe("true"),
    );
    // The current sentence, for assistive technology too (not a live region: no re-reading).
    expect(within(agentLine()).getByText("All good.").getAttribute("aria-current")).toBe("true");
    expect(within(agentLine()).getByText("Two tasks remain.").dataset.speaking).toBeUndefined();
    act(() => {
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "All good." }));
      stream.fire(
        "voice.event",
        frame("turn_end", 1, {
          replyMode: "voice",
          latency: { interrupted: true },
          entry: { turn: 1, role: "assistant", text: "All good.", interrupted: true },
          unspokenText: "Two tasks remain.",
        }),
      );
    });
    const unspoken = within(agentLine()).getByTestId("conversation-unspoken");
    expect(unspoken.textContent).toContain("Two tasks remain.");
    expect(unspoken.textContent).toMatch(/not spoken/i);
    // What was spoken stays as it was, outside the unspoken part.
    expect(agentLine().textContent).toMatch(/All good\..*Two tasks remain\./);
    expect(
      within(agentLine()).queryByText("All good.")?.closest("[data-testid=conversation-unspoken]"),
    ).toBeNull();
    expect(agentLine().querySelector("[data-speaking]")).toBeNull();
  });

  it("a reconnect's replay does not show the reply's text twice", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    // Numbered in the order the daemon sent them.
    const start = frame("turn_start", 1);
    const partial = frame("transcript_partial", 1, { text: "what" });
    const final = frame("transcript_final", 1, { text: "what is next" });
    const delta = frame("model_delta", 1, { text: "All good. " });
    act(() => {
      for (const f of [start, partial, final, delta]) stream.fire("voice.event", f);
    });
    act(() => {
      stream.fire("voice.event", partial);
      stream.fire("voice.event", delta);
    });
    expect(agentLine().textContent).not.toContain("All good. All good.");
    expect(humanLine().textContent).toContain("what is next");
  });

  it("the turn's record completes the lines: the polled turn does not add them a second time", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "what is next" }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "Shown as it came." }));
    });
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    expect(screen.getAllByTestId("conversation-human")).toHaveLength(1);
    expect(screen.getAllByTestId("conversation-agent")).toHaveLength(1);
  });
});

describe("conversation panel: reply in text", () => {
  const replyToggle = () => screen.getByTestId("voice-reply-mode");

  it("asks the daemon for text replies, remembers the choice per install, and shows the reply as text", async () => {
    const h = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("talk-open"));
    // One fixed label; the state is aria-pressed.
    expect(replyToggle().textContent).toBe("Reply in text");
    expect(replyToggle().getAttribute("aria-pressed")).toBe("false");
    await user.click(replyToggle());
    expect(replyToggle().textContent).toBe("Reply in text");
    expect(replyToggle().getAttribute("aria-pressed")).toBe("true");
    const key = storageKey(h.harness.store.getState().config.installId, "voiceReply");
    expect(h.harness.storage.get(key)).toBe("text");
    await user.click(await screen.findByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const calls = h.harness.daemon.state.calls;
    expect(calls.find((c) => c.path === "/voice/sessions")?.body).toMatchObject({
      replyMode: "text",
    });
    // Every press says the mode, whatever the session last reported.
    expect(calls.find((c) => c.path.endsWith("/press"))?.body).toEqual({
      pressed: true,
      replyMode: "text",
    });
    const id = [...h.harness.daemon.state.voiceSessions.keys()][0] ?? "";
    const stream = h.sources.instances.find((s) => s.url.includes(`/voice/sessions/${id}/events`));
    if (!stream) throw new Error("no stream");
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "what is next" }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "Written, not said." }));
    });
    const agent = screen.getAllByTestId("conversation-agent").at(-1) as HTMLElement;
    expect(agent.textContent).toContain("Written, not said.");
    expect(agent.dataset.reply).toBe("text");

    // Switching back to voice applies from the next press.
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    await user.click(replyToggle());
    expect(h.harness.storage.get(key)).toBe("voice");
    await user.click(screen.getByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const presses = calls.filter((c) => c.path.endsWith("/press"));
    expect(presses.at(-1)?.body).toEqual({ pressed: true, replyMode: "voice" });
  });

  it("starts in the remembered mode", async () => {
    const harness = createHarness();
    harness.storage.set(
      storageKey(harness.store.getState().config.installId, "voiceReply"),
      "text",
    );
    const store = createStore(harness.store.getState().config, harness.storage);
    render(
      <VoiceCaptureContext.Provider value={silentCapture()}>
        <AppProvider
          client={harness.client}
          store={store}
          realtime={{ eventSource: fakeEventSources().factory, audio: () => null }}
        >
          <MemoryRouter initialEntries={["/"]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProvider>
      </VoiceCaptureContext.Provider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("talk-open"));
    expect(replyToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("Talk while the text is written stops it, as a typed stop does: the line says it stopped", async () => {
    const h = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("talk-open"));
    await user.click(replyToggle());
    await user.click(await screen.findByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const id = [...h.harness.daemon.state.voiceSessions.keys()][0] ?? "";
    const stream = h.sources.instances.find((s) => s.url.includes(`/voice/sessions/${id}/events`));
    if (!stream) throw new Error("no stream");
    // The daemon keeps the turn running after the release: the reply is being written.
    h.harness.daemon.state.voiceHold = true;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Thinking/));
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "tell me everything" }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "First this. Then" }));
    });
    // The press is allowed while the reply is written: it is the barge-in.
    const talk = screen.getByTestId("voice-talk");
    expect(talk).not.toBeDisabled();
    await user.click(talk);
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const presses = h.harness.daemon.state.calls.filter((c) => c.path.endsWith("/press"));
    expect(presses.map((c) => (c.body as { pressed: boolean }).pressed)).toEqual([
      true,
      false,
      true,
    ]);
    act(() => {
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "" }));
      stream.fire(
        "voice.event",
        frame("turn_end", 1, {
          replyMode: "text",
          latency: { interrupted: true },
          entry: { turn: 1, role: "assistant", text: "First this. Then", interrupted: true },
          unspokenText: null,
        }),
      );
    });
    const agent = screen.getAllByTestId("conversation-agent").at(-1) as HTMLElement;
    expect(agent.textContent).toContain("First this. Then");
    expect(within(agent).getByTestId("conversation-stopped").textContent).toMatch(/stopped/i);
    expect(within(agent).queryByTestId("conversation-unspoken")).toBeNull();
    // Nothing was played, so nothing was measured as heard.
    expect(heardPosts(h)).toHaveLength(0);
  });
});

describe("conversation panel: review follow-ups", () => {
  const agentLines = () => screen.queryAllByTestId("conversation-agent");

  it("announces the final words, a text reply's finished sentences, errors and turn ends; a spoken reply's sentences are heard, not announced", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    const lines = screen.getByTestId("conversation-lines");
    // The visible lines change with every delta: they are not a live region.
    expect(lines.getAttribute("aria-live")).not.toBe("polite");
    const log = screen.getByTestId("conversation-announcer");
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1, { replyMode: "voice" }));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "what is next" }));
      stream.fire("voice.event", frame("model_delta", 1, { text: "All good. Two" }));
    });
    expect(log.textContent).toContain("You: what is next");
    expect(log.textContent).not.toContain("All good");
    act(() => {
      stream.fire("voice.event", frame("sentence", 1, { index: 0, text: "All good." }));
    });
    // The TTS speaks it: announcing it too would talk over the reply.
    expect(log.textContent).not.toContain("All good.");
    act(() => {
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "All good." }));
      stream.fire(
        "voice.event",
        frame("turn_end", 1, {
          replyMode: "voice",
          latency: { interrupted: true },
          entry: { turn: 1, role: "assistant", text: "All good.", interrupted: true },
          unspokenText: "Two tasks remain.",
        }),
      );
    });
    expect(log.textContent).toMatch(/interrupted/i);
    // A text reply is only read: its finished sentences are announced, not the deltas.
    act(() => {
      stream.fire("voice.event", frame("turn_start", 2, { replyMode: "text" }));
      stream.fire("voice.event", frame("model_delta", 2, { text: "Written. Then" }));
      stream.fire("voice.event", frame("sentence", 2, { index: 0, text: "Written." }));
    });
    expect(log.textContent).toContain("Written.");
    expect(log.textContent).not.toContain("Then");
    // An error is announced in either mode.
    act(() => {
      stream.fire(
        "voice.event",
        frame("error", 2, { code: "provider_error", message: "model down" }),
      );
    });
    expect(log.textContent).toMatch(/model down/);
    // Each announcement is said once: a replayed frame adds nothing.
    const before = log.textContent;
    act(() => {
      stream.fire("voice.event", {
        ...frame("sentence", 2, { index: 0, text: "Written." }),
        seq: 1,
      });
    });
    expect(log.textContent).toBe(before);
  });

  it("a press the daemon did not take is rolled back: the reply keeps playing and the panel waits again", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    h.harness.daemon.state.voiceHold = true;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Thinking/));
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1, { replyMode: "voice" }));
      stream.fire("voice.event", audioMs(1, JITTER_START_MS));
    });
    expect(h.audio.scheduled).toHaveLength(1);
    h.harness.daemon.state.voiceRefusePress = true;
    await user.click(screen.getByTestId("voice-talk"));
    // Not listening: the press was refused, so the panel goes back to waiting for turn 1.
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Thinking/));
    // The rest of turn 1's reply is not silenced.
    act(() => {
      stream.fire("voice.event", audioMs(1, JITTER_START_MS));
    });
    expect(h.audio.scheduled).toHaveLength(2);
    expect(h.audio.scheduled[1]?.stopped).toBe(false);
    // And the wait for turn 1 resumes: once it ends, the panel is idle again.
    h.harness.daemon.state.voiceRefusePress = false;
    h.harness.daemon.state.voiceHold = false;
    const v = [...h.harness.daemon.state.voiceSessions.values()][0];
    if (!v) throw new Error("no session");
    v.view = { ...v.view, state: "idle", turns: 1, lastTurn: null };
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/), {
      timeout: 3000,
    });
  });

  it("a press on a session the daemon no longer has starts a new one, once", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    // The daemon restarted: the session is gone.
    h.harness.daemon.state.voiceSessions.clear();
    await user.click(screen.getByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    expect(h.harness.daemon.state.voiceSessions.size).toBe(1);
    const fresh = [...h.harness.daemon.state.voiceSessions.keys()][0] ?? "";
    // The old session's player is closed; the new session has its own stream.
    expect(stream.closed).toBe(true);
    expect(h.sources.instances.some((s) => s.url.includes(`/voice/sessions/${fresh}/events`))).toBe(
      true,
    );
    expect(screen.queryByTestId("voice-reason")).toBeNull();
    // The output made in the first click (where a webview lets it start) goes to the new
    // player: none is created after the awaits, none closed.
    expect(h.audio.state.created).toBe(1);
    expect(h.audio.state.closed).toBe(0);
  });

  it("a turn's record alone (the polled record, no transcript frames) marks a carried line as continued", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire(
        "voice.event",
        frame("voice.turn", 2, {
          record: {
            turn: 2,
            source: "audio",
            replyMode: "voice",
            continued: false,
            carriedFrom: 1,
            said: "to Friday.",
            heard: "Done.",
            reply: null,
            error: null,
            interrupted: false,
            unspokenText: null,
          },
        }),
      );
    });
    const human = screen.getByTestId("conversation-human");
    expect(human.textContent).toContain("(continued)");
    expect(human.dataset.continued).toBe("true");
  });

  it("a press while the last turn transcribed carries its words: one line goes on, no reply stopped", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1, { replyMode: "voice" }));
      stream.fire("voice.event", frame("transcript_final", 1, { text: "Move the review" }));
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "" }));
      stream.fire(
        "voice.event",
        frame("turn_end", 1, {
          replyMode: "voice",
          latency: { interrupted: true },
          entry: null,
          unspokenText: null,
          continued: true,
        }),
      );
      stream.fire("voice.event", frame("turn_start", 2, { replyMode: "voice" }));
      stream.fire(
        "voice.event",
        frame("transcript_final", 2, {
          text: "to Friday.",
          carried: { turn: 1, text: "Move the review" },
        }),
      );
    });
    const humans = screen.getAllByTestId("conversation-human");
    expect(humans).toHaveLength(2);
    expect(humans[0]?.textContent).toContain("Move the review");
    expect(humans[1]?.textContent).toContain("(continued)");
    expect(humans[1]?.textContent).toContain("to Friday.");
    expect(humans[1]?.dataset.continued).toBe("true");
    expect(screen.queryAllByTestId("conversation-agent")).toHaveLength(0);
    const log = screen.getByTestId("conversation-announcer");
    expect(log.textContent).not.toMatch(/stopped|interrupted/i);
    expect(log.textContent).toContain("You: to Friday.");
  });

  it("keeps the sentence marked until the window has played it, past the daemon's turn end", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", frame("turn_start", 1));
      stream.fire("voice.event", frame("model_delta", 1, { text: "All good." }));
      stream.fire("voice.event", frame("sentence", 1, { index: 0, text: "All good." }));
      stream.fire("voice.event", audioMs(1, JITTER_START_MS, 0));
      stream.fire("voice.event", frame("speaking_end", 1));
      stream.fire(
        "voice.event",
        frame("turn_end", 1, {
          replyMode: "voice",
          latency: { interrupted: false },
          entry: { turn: 1, role: "assistant", text: "All good." },
        }),
      );
    });
    const sentence = () => within(agentLines().at(-1) as HTMLElement).getByText("All good.");
    // The daemon is done; the window still plays the sentence (its buffer and lead).
    await waitFor(() => expect(sentence().dataset.speaking).toBe("true"));
    act(() => {
      for (const s of h.audio.scheduled) s.end();
    });
    await waitFor(() => expect(sentence().dataset.speaking).toBeUndefined());
  });

  it("a press while the reply still runs posts the press at once, without asking for the status again", async () => {
    const h = setup();
    const { user } = await startTalking(h);
    let statusCalls = 0;
    const status = h.harness.client.voiceStatus;
    h.harness.client.voiceStatus = async (signal) => {
      statusCalls++;
      return status(signal);
    };
    h.harness.daemon.state.voiceHold = true;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Thinking/));
    await user.click(screen.getByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    expect(statusCalls).toBe(0);
  });

  it("without an event stream, a turn cut short by a barge-in still shows: every ended turn is applied", async () => {
    const harness = createHarness();
    harness.daemon.state.nextVoiceLine = "tell me everything";
    render(
      <VoiceCaptureContext.Provider value={silentCapture()}>
        <AppProvider client={harness.client} store={harness.store} realtime={{ audio: () => null }}>
          <MemoryRouter initialEntries={["/"]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProvider>
      </VoiceCaptureContext.Provider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("talk-open"));
    await user.click(await screen.findByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    harness.daemon.state.voiceHold = true;
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Thinking/));
    // The barge-in: the held turn ends cut short while the panel was waiting for it.
    await user.click(screen.getByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    harness.daemon.state.voiceHold = false;
    harness.daemon.state.nextVoiceLine = "what is next";
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    const humans = screen.getAllByTestId("conversation-human").map((l) => l.textContent ?? "");
    expect(humans).toHaveLength(2);
    expect(humans[0]).toContain("tell me everything");
    expect(humans[1]).toContain("what is next");
    const agents = screen.getAllByTestId("conversation-agent");
    expect(agents).toHaveLength(2);
    expect(within(agents[0] as HTMLElement).getByTestId("conversation-unspoken")).toBeTruthy();
  });

  it("shows no empty Agent line for a turn with nothing heard, no reply and no error", async () => {
    const harness = createHarness();
    harness.daemon.state.nextVoiceLine = "";
    render(
      <VoiceCaptureContext.Provider value={silentCapture()}>
        <AppProvider client={harness.client} store={harness.store} realtime={{ audio: () => null }}>
          <MemoryRouter initialEntries={["/"]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProvider>
      </VoiceCaptureContext.Provider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("talk-open"));
    await user.click(await screen.findByTestId("voice-talk"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    await user.click(screen.getByTestId("voice-send"));
    await waitFor(() => expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press/));
    expect(screen.getByTestId("conversation-human").textContent).toContain("(nothing heard)");
    expect(screen.queryAllByTestId("conversation-agent")).toHaveLength(0);
  });
});

describe("voice reply player: a press silences every turn up to the newest one seen", () => {
  it("interrupt() while turn 2 is still thinking drops turn 2's late audio too, and turn 3 plays", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS)); // turn 1's tail plays
    p.fire(frame("turn_start", 2));
    p.fire(frame("transcript_final", 2, { text: "and then?" }));
    expect(p.audio.scheduled).toHaveLength(1);
    p.player.interrupt();
    expect(p.audio.scheduled[0]?.stopped).toBe(true);
    // Turn 2 was barged in on before its first chunk: what still comes of it is not played.
    p.fire(audioMs(2, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(1);
    p.fire(audioMs(3, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(2);
    expect(p.audio.scheduled[1]?.stopped).toBe(false);
  });

  it("silenceBefore(turn) drops every earlier turn, even one whose frames had not come yet", () => {
    const p = directPlayer();
    p.player.silenceBefore(5);
    p.fire(audioMs(4, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(0);
    p.fire(audioMs(5, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(1);
  });
});

describe("voice reply player: the end of what is heard", () => {
  it("a queue that runs dry inside a turn is not its end: onSpeakingEnd waits for the turn's end", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS, 0));
    expect(p.audio.scheduled).toHaveLength(1);
    // The chunk played out before the next one came (an underrun): the turn is not over.
    p.audio.scheduled[0]?.end();
    expect(p.ends).toEqual([]);
    p.at(1000);
    p.fire(audioMs(1, JITTER_START_MS, 0));
    p.fire(frame("speaking_end", 1));
    expect(p.audio.scheduled).toHaveLength(2);
    expect(p.ends).toEqual([]);
    p.audio.scheduled[1]?.end();
    expect(p.ends).toEqual([1]);
  });

  it("when the turn's end comes after its audio played out, that is the end", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS, 0));
    p.audio.scheduled[0]?.end();
    expect(p.ends).toEqual([]);
    p.fire(frame("turn_end", 1, { latency: { interrupted: false } }));
    expect(p.ends).toEqual([1]);
  });
});

describe("voice reply player: the undo of a press is compare-and-restore", () => {
  it("does not lower what a later press raised", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS));
    const undo = p.player.interrupt();
    p.player.silenceBefore(5); // a later press that the daemon took
    undo();
    p.fire(audioMs(3, JITTER_MAX_MS));
    expect(p.audio.scheduled.filter((x) => !x.stopped)).toHaveLength(0);
    p.fire(audioMs(5, JITTER_MAX_MS));
    expect(p.audio.scheduled.filter((x) => !x.stopped)).toHaveLength(1);
  });

  it("does not unsilence a turn a real barge_in silenced in between", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS));
    const undo = p.player.interrupt();
    p.fire(frame("barge_in", 1, { spokenText: "" }));
    undo();
    p.fire(audioMs(1, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(1);
  });

  it("restores when nothing happened in between: the turn's later audio plays", () => {
    const p = directPlayer();
    p.at(0);
    p.fire(audioMs(1, JITTER_START_MS));
    const undo = p.player.interrupt();
    undo();
    p.fire(audioMs(1, JITTER_MAX_MS));
    expect(p.audio.scheduled).toHaveLength(2);
    expect(p.audio.scheduled[1]?.stopped).toBe(false);
  });
});
