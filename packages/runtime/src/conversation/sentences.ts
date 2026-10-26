/**
 * Complete sentences of a chat reply (the real-audio run of 2026-10-26): a reply that ends at
 * the model's `max_tokens` stops mid-sentence ("...one of the three options: adopt,"), and
 * neither the speaker nor the transcript may present that fragment as a finished answer.
 *
 * `SentenceGate` passes streamed text on one complete sentence at a time (the voice loop's own
 * splitter decides what a sentence is, abbreviations and decimals included) and holds the
 * unfinished rest until the model call ends: a call that ended normally releases it, a call
 * cut off at `max_tokens` drops it. `completeSentencesOf` applies the same rule to a whole text.
 */
import { SentenceSplitter } from "@forerunner/voice/sentences";

/** Ends with a sentence terminator, optionally followed by closing quotes or brackets. */
const SENTENCE_END = /[.!?…。！？]["”’'»)\]}›]*$/u;

export class SentenceGate {
  private readonly splitter = new SentenceSplitter();

  constructor(private readonly out: (text: string) => void) {}

  /** Feed a streamed delta; passes on every sentence it completes, exactly as written. */
  push(delta: string): void {
    if (!delta) return;
    const all = this.splitter.pending + delta.replace(/\r\n?/g, "\n");
    this.splitter.push(delta);
    const ready = all.slice(0, all.length - this.splitter.pending.length);
    if (ready) this.out(ready);
  }

  /**
   * The model call ended. The held rest is passed on unless the call was `cut` off at
   * `max_tokens` and the rest is not a whole sentence (a cut that fell right after a period
   * keeps its sentence).
   */
  end(cut: boolean): void {
    const rest = this.splitter.pending;
    this.splitter.reset();
    if (!rest) return;
    if (!cut || SENTENCE_END.test(rest.trimEnd())) this.out(rest);
  }
}

/** The text up to its last complete sentence, trimmed; "" when it has none. */
export function completeSentencesOf(text: string): string {
  const parts: string[] = [];
  const gate = new SentenceGate((t) => parts.push(t));
  gate.push(text);
  gate.end(true);
  return parts.join("").trim();
}
