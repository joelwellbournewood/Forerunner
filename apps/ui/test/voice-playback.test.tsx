import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
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
import { PLAYBACK_LEAD_MS } from "../src/shell/voice-playback.ts";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness } from "./helpers.tsx";

/**
 * The conversation panel plays the reply of a voice turn (spec O.3): the `audio` frames of
 * `GET /voice/sessions/:id/events` decoded from 16-bit PCM at their rate and channel count and
 * scheduled back to back through Web Audio, the first after a short lead; a barge-in, an
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
const audioFrame = (turn: number, samples: number[], sampleRate = 8000, channels = 1) =>
  frame("audio", turn, {
    sentenceIndex: 0,
    sampleRate,
    channels,
    timestampMs: 0,
    pcm: pcm(samples),
  });

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
      stream.fire("voice.event", frame("speaking_end", 1));
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: false } }));
    });
    expect(h.audio.scheduled.every((s) => !s.stopped)).toBe(true);
  });

  it("silences the queue on a barge-in, an error and a turn cut short, and keeps playing the next turn", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioFrame(1, [1, 2]));
      stream.fire("voice.event", audioFrame(1, [3, 4]));
      stream.fire("voice.event", frame("barge_in", 1, { spokenText: "" }));
    });
    expect(h.audio.scheduled.map((s) => s.stopped)).toEqual([true, true]);

    act(() => {
      stream.fire("voice.event", audioFrame(2, [5, 6]));
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
      stream.fire("voice.event", audioFrame(3, [7, 8]));
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
      stream.fire("voice.event", audioFrame(1, [1, 2]));
      stream.fire("voice.event", frame("voice.stopped", 1, {}));
    });
    expect(h.audio.scheduled[0]?.stopped).toBe(true);
    expect(stream.closed).toBe(true);
    act(() => {
      stream.fire("voice.event", audioFrame(2, [3, 4]));
    });
    expect(h.audio.scheduled).toHaveLength(1);
  });

  it("stops when the panel closes, closing the stream and the output", async () => {
    const h = setup();
    const { user, stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioFrame(1, [1, 2]));
      stream.fire("voice.event", audioFrame(1, [3, 4]));
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
    const firstChunk = audioFrame(1, [1, 2]);
    const bargeIn = frame("barge_in", 1, { spokenText: "" });
    const cutShort = frame("turn_end", 1, { latency: { interrupted: true } });
    act(() => {
      stream.fire("voice.event", firstChunk);
      stream.fire("voice.event", bargeIn);
      stream.fire("voice.event", cutShort);
      stream.fire("voice.event", audioFrame(2, [3, 4]));
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
      stream.fire("voice.event", audioFrame(2, [1, 2]));
      // Events of another turn (an earlier turn's late error or interrupted end) leave it alone.
      stream.fire("voice.event", frame("error", 1, { code: "provider_error", message: "x" }));
      stream.fire("voice.event", frame("turn_end", 1, { latency: { interrupted: true } }));
      stream.fire("voice.event", frame("barge_in", 3, { spokenText: "" }));
    });
    expect(h.audio.scheduled[0]?.stopped).toBe(false);
    act(() => {
      stream.fire("voice.event", frame("barge_in", 2, { spokenText: "" }));
      // A chunk of the cut-off turn still in flight is not played.
      stream.fire("voice.event", audioFrame(2, [3, 4]));
    });
    expect(h.audio.scheduled).toHaveLength(1);
    expect(h.audio.scheduled[0]?.stopped).toBe(true);
  });

  it("schedules after the lead whenever the queue has drained, back to back while it has not", async () => {
    const h = setup();
    const { stream } = await startTalking(h);
    act(() => {
      stream.fire("voice.event", audioFrame(1, [1, 2, 3, 4]));
    });
    const first = (h.audio.scheduled[0]?.at ?? 0) + 4 / 8000;
    h.audio.state.currentTime = 0.01; // still playing the first chunk
    act(() => {
      stream.fire("voice.event", audioFrame(1, [1, 2]));
    });
    expect(h.audio.scheduled[1]?.at).toBeCloseTo(first, 10);
    h.audio.state.currentTime = 5; // the queue ran dry (a pause between sentences)
    act(() => {
      stream.fire("voice.event", audioFrame(1, [1, 2]));
    });
    expect(h.audio.scheduled[2]?.at).toBeCloseTo(5 + PLAYBACK_LEAD_MS / 1000, 10);
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
      stream.fire("voice.event", audioFrame(1, [1, 2]));
      stream.fire("voice.event", audioFrame(1, [3, 4]));
    });
    await waitFor(() => expect(heardPosts(h)).toHaveLength(1));
    expect(heardPosts(h)[0]).toMatchObject({
      path: `/voice/sessions/${id}/heard`,
      body: { turn: 1, heardFirstAudioMs: 470 },
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
      stream.fire("voice.event", audioFrame(2, [1, 2]));
    });
    await waitFor(() => expect(heardPosts(h)).toHaveLength(2));
    expect(heardPosts(h)[1]?.body).toEqual({ turn: 2, heardFirstAudioMs: 955 });

    // Audio of a turn with no release before it (nothing pressed) is not measured.
    act(() => {
      stream.fire("voice.event", audioFrame(3, [1, 2]));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(heardPosts(h)).toHaveLength(2);
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
      stream.fire("voice.event", audioFrame(2, [1, 2]));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(heardPosts(h)).toHaveLength(0);
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
      stream.fire("voice.event", audioFrame(1, [1, 2]));
    });
    expect(h.audio.scheduled).toHaveLength(0);
  });
});
