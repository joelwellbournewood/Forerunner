import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";
import type { EventSourceLike } from "../src/api/sse.ts";
import {
  type AudioOutput,
  createSpeechAnnouncer,
  decodeFrame,
  playSpeech,
} from "../src/lib/speech.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { AppProvider } from "../src/store/context.tsx";
import { createStore } from "../src/store/store.ts";
import { createFakeDaemon } from "./fake-daemon.ts";
import { fetchFromApp, testConfig } from "./helpers.tsx";

/**
 * Playback of what the daemon reads aloud (spec A.6, L.6; ADR 0063): the `audio` frames of
 * `GET /speak/:id/events` decoded from 16-bit PCM and scheduled back to back through Web Audio,
 * and the window's speech player, which declares itself on `/events` (`?speech=play`) and plays
 * every utterance the daemon announces for any player (a voice alert, `summary.speak` by chat).
 * jsdom has neither EventSource nor AudioContext, so both are fakes here.
 */

type FakeSource = EventSourceLike & { url: string; fire: (name: string, data: unknown) => void };

function fakeEventSources() {
  const instances: FakeSource[] = [];
  const factory = (url: string) => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const es: FakeSource = {
      url,
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
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
}

function fakeAudio() {
  const scheduled: Scheduled[] = [];
  const state = { closed: false, resumed: 0, currentTime: 0 };
  const output: AudioOutput = {
    get currentTime() {
      return state.currentTime;
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
      const node = {
        buffer: null as (AudioBuffer & { __data: Float32Array[] }) | null,
        connect() {},
        start(at: number) {
          scheduled.push({
            at,
            channels: node.buffer?.__data ?? [],
            sampleRate: node.buffer?.sampleRate ?? 0,
          });
        },
      };
      return node as unknown as AudioBufferSourceNode;
    },
    async close() {
      state.closed = true;
    },
    async resume() {
      state.resumed++;
    },
  };
  return { output, scheduled, state };
}

/** Base64 of 16-bit little-endian PCM. */
function pcm(samples: number[]): string {
  const bytes = new Uint8Array(new Int16Array(samples).buffer);
  return btoa(String.fromCharCode(...bytes));
}

const client = createClient(testConfig("tok"), async () => new Response("{}"));

describe("playSpeech", () => {
  it("decodes the PCM frames, schedules them back to back, follows the sentences and ends on speak.done", async () => {
    const { factory, instances } = fakeEventSources();
    const audio = fakeAudio();
    const sentences: number[] = [];
    const pb = playSpeech(client, "speak_7", {
      eventSource: factory,
      audio: () => audio.output,
      onSentence: (i) => sentences.push(i),
    });
    const es = instances[0];
    if (!es) throw new Error("no stream opened");
    expect(es.url).toContain("/speak/speak_7/events");
    expect(es.url).toContain("afterSeq=0");
    expect(audio.state.resumed).toBe(1);
    // 4 samples at 8 kHz = 0.5 ms each frame; a stereo frame of 2 frames per channel.
    es.fire("speak.event", {
      seq: 2,
      type: "audio",
      data: {
        sentenceIndex: 0,
        sampleRate: 8000,
        channels: 1,
        pcm: pcm([0, 16384, -32768, 32767]),
      },
    });
    es.fire("speak.event", {
      seq: 3,
      type: "audio",
      data: { sentenceIndex: 1, sampleRate: 8000, channels: 2, pcm: pcm([16384, -16384, 0, 8192]) },
    });
    es.fire("speak.event", "not json");
    expect(audio.scheduled).toHaveLength(2);
    expect(Array.from(audio.scheduled[0]?.channels[0] ?? [])).toEqual([0, 0.5, -1, 32767 / 32768]);
    expect(audio.scheduled[0]?.at).toBe(0);
    // The second buffer starts where the first ends (4 frames at 8 kHz = 0.5 ms).
    expect(audio.scheduled[1]?.at).toBeCloseTo(4 / 8000, 10);
    expect(audio.scheduled[1]?.channels.map((c) => Array.from(c))).toEqual([
      [0.5, 0],
      [-0.5, 0.25],
    ]);
    expect(sentences).toEqual([0, 1]);
    es.fire("speak.event", { seq: 4, type: "speak.done", data: { record: { state: "done" } } });
    await expect(pb.done).resolves.toBe("done");
    expect(es.readyState).toBe(2);
    expect(audio.state.closed).toBe(true);
  });

  it("speak.done does not cut the tail: the output closes only once the scheduled audio has played", async () => {
    const { factory, instances } = fakeEventSources();
    const audio = fakeAudio();
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const pb = playSpeech(client, "speak_9", {
      eventSource: factory,
      audio: () => audio.output,
      setTimer: (fn, ms) => {
        const t = { ms, fn };
        timers.push(t);
        return () => {
          timers.splice(timers.indexOf(t), 1);
        };
      },
    });
    const es = instances[0];
    if (!es) throw new Error("no stream opened");
    // 300 ms of audio at 8 kHz, scheduled from 0; the daemon says it is done at 100 ms.
    es.fire("speak.event", {
      seq: 2,
      type: "audio",
      data: { sentenceIndex: 0, sampleRate: 8000, channels: 1, pcm: pcm(new Array(2400).fill(1)) },
    });
    audio.state.currentTime = 0.1;
    let ended: string | null = null;
    void pb.done.then((e) => {
      ended = e;
    });
    es.fire("speak.event", { seq: 3, type: "speak.done", data: { record: { state: "done" } } });
    await Promise.resolve();
    expect(audio.state.closed).toBe(false);
    expect(ended).toBeNull();
    // The rest of the audio (200 ms) and then some: the timer covers the tail.
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeGreaterThanOrEqual(200);
    timers[0]?.fn();
    await expect(pb.done).resolves.toBe("done");
    expect(audio.state.closed).toBe(true);
  });

  it("stop() during the tail closes at once", async () => {
    const { factory, instances } = fakeEventSources();
    const audio = fakeAudio();
    const pb = playSpeech(client, "speak_10", {
      eventSource: factory,
      audio: () => audio.output,
      setTimer: () => () => undefined,
    });
    const es = instances[0];
    if (!es) throw new Error("no stream opened");
    es.fire("speak.event", {
      seq: 2,
      type: "audio",
      data: { sentenceIndex: 0, sampleRate: 8000, channels: 1, pcm: pcm(new Array(2400).fill(1)) },
    });
    es.fire("speak.event", { seq: 3, type: "speak.done", data: { record: { state: "done" } } });
    expect(audio.state.closed).toBe(false);
    pb.stop();
    await expect(pb.done).resolves.toBe("cancelled");
    expect(audio.state.closed).toBe(true);
  });

  it("an error frame ends it as failed; a cancelled record as cancelled", async () => {
    const one = fakeEventSources();
    const failed = playSpeech(client, "a", { eventSource: one.factory, audio: () => null });
    one.instances[0]?.fire("speak.event", { type: "error", data: { code: "provider_error" } });
    await expect(failed.done).resolves.toBe("failed");
    const two = fakeEventSources();
    const cut = playSpeech(client, "b", { eventSource: two.factory, audio: () => null });
    two.instances[0]?.fire("speak.event", {
      type: "speak.done",
      data: { record: { state: "cancelled" } },
    });
    await expect(cut.done).resolves.toBe("cancelled");
  });

  it("decodeFrame keeps whole samples only", () => {
    const odd = btoa(String.fromCharCode(0, 64, 7));
    expect(
      decodeFrame({ sentenceIndex: 0, sampleRate: 16000, channels: 1, pcm: odd }).map((c) =>
        Array.from(c),
      ),
    ).toEqual([[0.5]]);
  });
});

describe("the window's speech player", () => {
  it("plays utterances announced for any player, one at a time, and leaves the button's own alone", () => {
    const { factory, instances } = fakeEventSources();
    const announcer = createSpeechAnnouncer(client, { eventSource: factory, audio: () => null });
    const subject = { kind: "notification" as const, id: "n1", notificationKind: "budget_stop" };
    announcer.started({ id: "mine", subject, source: "ui", player: "requester", sentences: 1 });
    expect(instances).toHaveLength(0);
    expect(announcer.playing).toBeNull();
    announcer.started({
      id: "alert_1",
      subject,
      source: "notification",
      player: "any",
      sentences: 2,
    });
    expect(announcer.playing).toBe("alert_1");
    expect(instances[0]?.url).toContain("/speak/alert_1/events");
    // The same frame twice (a reconnect) does not start it again.
    announcer.started({
      id: "alert_1",
      subject,
      source: "notification",
      player: "any",
      sentences: 2,
    });
    expect(instances).toHaveLength(1);
    // A newer one replaces it (the daemon has one voice and already cut the older short).
    announcer.started({ id: "alert_2", subject, source: "chat", player: "any", sentences: 1 });
    expect(instances[0]?.readyState).toBe(2);
    expect(announcer.playing).toBe("alert_2");
    announcer.close();
    expect(instances[1]?.readyState).toBe(2);
    expect(announcer.playing).toBeNull();
  });

  it("the app declares itself a speech player on /events and plays a voice alert the daemon announces", async () => {
    const daemon = createFakeDaemon({ token: "tok", eventDelayMs: 20, tokenDelayMs: 0 });
    const config = testConfig("tok");
    const appClient = createClient(config, fetchFromApp(daemon.app));
    const store = createStore(config, memoryStorage());
    const { factory, instances } = fakeEventSources();
    const audio = fakeAudio();
    const realtime = { eventSource: factory, audio: () => audio.output };
    const view = render(
      <AppProvider client={appClient} store={store} realtime={realtime}>
        <MemoryRouter>
          <span>app</span>
        </MemoryRouter>
      </AppProvider>,
    );
    await waitFor(() => expect(instances.some((es) => es.url.includes("/events?"))).toBe(true));
    const bus = instances.find((es) => /\/events\?/.test(es.url) && !es.url.includes("/speak/"));
    if (!bus) throw new Error("no /events stream");
    expect(new URL(bus.url).searchParams.get("speech")).toBe("play");
    bus.fire("speak.started", {
      id: "speak_alert",
      subject: { kind: "notification", id: "rec_1", notificationKind: "budget_stop" },
      source: "notification",
      player: "any",
      sentences: 2,
    });
    const speech = instances.find((es) => es.url.includes("/speak/speak_alert/events"));
    if (!speech) throw new Error("the alert's stream was not opened");
    speech.fire("speak.event", {
      seq: 3,
      type: "audio",
      data: { sentenceIndex: 0, sampleRate: 16000, channels: 1, pcm: pcm([1, 2, 3, 4]) },
    });
    expect(audio.scheduled).toHaveLength(1);
    view.unmount();
    expect(speech.readyState).toBe(2);
  });
});
