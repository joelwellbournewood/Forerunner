import { SimulatedClock } from "@forerunner/platform";
import {
  AsyncQueue,
  type ConverseFn,
  chunkify,
  FakeStt,
  FakeTts,
  SentenceSplitter,
  synth,
  VoiceLoop,
} from "@forerunner/voice";
import { describe, expect, it } from "vitest";
import { completeSentencesOf, SentenceGate } from "../src/conversation/sentences.ts";

/**
 * The gate between the conversation agent's streamed text and the voice loop on a spoken turn
 * (`src/conversation/sentences.ts`). It must hold back only the unfinished tail of a model call:
 * a sentence goes on, with the whitespace that ends it, the moment the model finishes it, so the
 * voice loop's own splitter sees the boundary at once (review of eead616: the first version
 * released "Hello." without its space, and the loop only spoke it when the next sentence ended).
 */
const DELTAS = ["Hel", "lo. ", "Wor", "ld is ", "big. "];

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

async function advance(clock: SimulatedClock, ms: number, step = 10): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await settle();
    await clock.advance(Math.min(step, left));
  }
  await settle();
}

describe("SentenceGate", () => {
  it("passes a sentence on with its boundary, so the voice loop's splitter emits it before the next one ends", () => {
    const downstream = new SentenceSplitter();
    const spoken: string[] = [];
    const sentencesAfter: number[] = [];
    const gate = new SentenceGate((t) => spoken.push(...downstream.push(t)));
    for (const d of DELTAS) {
      gate.push(d);
      sentencesAfter.push(spoken.length);
    }
    // "Hello." is out after "lo. ", before "World is big." is complete.
    expect(sentencesAfter).toEqual([0, 1, 1, 1, 2]);
    expect(spoken).toEqual(["Hello.", "World is big."]);
    gate.end(false);
    expect(downstream.flush()).toBeNull();
  });

  it("passes on exactly the text it was given, and an empty first piece marks the first token", () => {
    const out: string[] = [];
    const gate = new SentenceGate((t) => out.push(t));
    for (const d of DELTAS) gate.push(d);
    gate.end(false);
    // The first delta has no complete sentence yet: an empty piece stamps the model's first
    // token for the consumer (the voice loop's modelFirstTokenMs) without any text.
    expect(out[0]).toBe("");
    expect(out.join("")).toBe(DELTAS.join(""));
  });

  it("drops an unfinished tail when the call was cut off, and keeps a whole last sentence", () => {
    const cut: string[] = [];
    const gate = new SentenceGate((t) => cut.push(t));
    for (const d of ["One. ", "Two thr"]) gate.push(d);
    gate.end(true);
    expect(cut.join("")).toBe("One. ");
    expect(completeSentencesOf("One. Two.")).toBe("One. Two.");
    expect(completeSentencesOf("One. Two thr")).toBe("One.");
    expect(completeSentencesOf("adopt,")).toBe("");
  });

  it("does not push back the voice loop's first sentence or its model-first-token time", async () => {
    const clock = new SimulatedClock(0);
    const sentenceAt: Array<[string, number]> = [];
    const converse: ConverseFn = async function* (_text, signal) {
      const q = new AsyncQueue<string>();
      const gate = new SentenceGate((t) => q.push(t));
      void (async () => {
        await clock.sleep(500, signal);
        for (const d of DELTAS) {
          gate.push(d);
          await clock.sleep(100, signal);
        }
        gate.end(false);
        q.close();
      })().catch((e: unknown) => q.fail(e));
      for await (const d of q) yield d;
    };
    const loop = new VoiceLoop({
      stt: new FakeStt({ clock, scripts: [{ final: "how big is the world" }], finalDelayMs: 300 }),
      tts: new FakeTts({ clock, firstChunkLatencyMs: 200, chunkMs: 100, chunks: 2 }),
      mode: "push_to_talk",
      converse,
      clock,
      onEvent: (e) => {
        if (e.type === "sentence") sentenceAt.push([e.text, clock.monotonic()]);
      },
    });
    loop.start();
    loop.pressStart();
    for (const c of chunkify(synth(440, 400), 20, 16000)) loop.push(c);
    clock.tickMonotonic(20);
    loop.pressEnd();
    const released = clock.monotonic();
    await advance(clock, 3000);
    await loop.idle();
    // Final transcript at +300, the model's first delta 500 later: the stage is the model's.
    expect(loop.latencies[0]?.modelFirstTokenMs).toBe(500);
    // "Hello." completes with the second delta (+900 from the release) and is a sentence then,
    // not when "big." arrives (+1200).
    expect(sentenceAt.map(([t]) => t)).toEqual(["Hello.", "World is big."]);
    expect((sentenceAt[0]?.[1] ?? 0) - released).toBe(900);
    loop.stop();
  });
});
