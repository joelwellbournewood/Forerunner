/**
 * The text fallback of the voice bridge (shells without audio capture, the approvals web page,
 * tests): a typed line enters the voice loop as the final transcript of a push-to-talk turn
 * that carried no audio. The loop then runs exactly as for a spoken line: the same `converse`
 * port, the spoken approval rules in front of a pending card, the sentence pipeline into TTS,
 * the same events and the same `voice.turn` row. Nothing is parsed twice and no second path
 * reaches the command registry.
 *
 * `TextTurnStt` wraps the STT provider the registry selected: a turn with an injected line
 * returns a session whose final transcript is that line (available the moment the turn ends,
 * so `finalTranscriptMs` reads 0); every other turn goes to the real provider untouched.
 */
import type { Clock } from "@forerunner/platform";
import {
  AsyncQueue,
  type Availability,
  type ProviderKind,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type SttStartOptions,
} from "./pkg.ts";

class InjectedTranscriptSession implements SttSession {
  readonly queue = new AsyncQueue<SttEvent>();
  readonly events: AsyncIterable<SttEvent> = this.queue;
  private ended = false;

  constructor(
    private readonly text: string,
    private readonly clock: Clock,
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  /** A text turn carries no audio; a chunk pushed by mistake is ignored. */
  push(): void {}

  endOfSpeech(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.push({ type: "final", text: this.text, atMs: this.clock.monotonic() });
    this.queue.close();
  }

  async close(): Promise<void> {
    this.ended = true;
    this.queue.close();
  }
}

export class TextTurnStt implements SttProvider {
  private injected: string | null = null;

  constructor(
    private readonly inner: SttProvider,
    private readonly clock: Clock,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get kind(): ProviderKind {
    return this.inner.kind;
  }

  isAvailable(): Promise<Availability> {
    return this.inner.isAvailable();
  }

  /** The next capture the loop opens is this line, not microphone audio. */
  inject(text: string): void {
    this.injected = text;
  }

  /** Forget an injected line the loop never picked up (the press was refused). */
  clear(): void {
    this.injected = null;
  }

  get hasInjected(): boolean {
    return this.injected !== null;
  }

  start(opts: SttStartOptions): SttSession {
    const text = this.injected;
    if (text === null) return this.inner.start(opts);
    this.injected = null;
    return new InjectedTranscriptSession(text, this.clock, opts.signal);
  }
}
