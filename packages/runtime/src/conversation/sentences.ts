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
  /** Text given and not passed on yet: always the splitter's pending text, less leading space. */
  private held = "";
  private started = false;

  constructor(private readonly out: (text: string) => void) {}

  /**
   * Feed a streamed delta. Every sentence it completes is passed on exactly as written, with the
   * whitespace after it (the boundary the consumer's own splitter needs to see the sentence end
   * at once, rather than when the next sentence ends). The first delta always produces a call:
   * an empty piece when no sentence is complete yet, so a consumer that stamps the model's first
   * token on its first piece (the voice loop's `modelFirstTokenMs`) still stamps it then.
   */
  push(delta: string): void {
    if (!delta) return;
    const unsent = this.held + delta.replace(/\r\n?/g, "\n");
    this.splitter.push(delta);
    // The splitter's pending text is a suffix of what was not passed on (the part already
    // passed on is at most its leading whitespace); keep only its non-blank part back.
    const keep = Math.min(this.splitter.pending.trimStart().length, unsent.length);
    const ready = unsent.slice(0, unsent.length - keep);
    this.held = unsent.slice(unsent.length - keep);
    if (ready || !this.started) this.out(ready);
    this.started = true;
  }

  /**
   * The model call ended. The held rest is passed on unless the call was `cut` off at
   * `max_tokens` and the rest is not a whole sentence (a cut that fell right after a period
   * keeps its sentence).
   */
  end(cut: boolean): void {
    const rest = this.held;
    this.held = "";
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
