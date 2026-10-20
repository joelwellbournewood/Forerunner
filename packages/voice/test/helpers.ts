import { fileURLToPath } from "node:url";
import type { Clock } from "@forerunner/platform";
import type { WsConnectOptions, WsFactory, WsSocket } from "../src/providers/cloud/transport.ts";

/** Let every pending microtask and I/O callback run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Advance a simulated clock and let the continuations it released run. */
export async function advance(
  clock: Clock & { advance(ms: number): Promise<void> },
  ms: number,
): Promise<void> {
  await settle();
  await clock.advance(ms);
  await settle();
}

/** Advance in small steps so timers registered along the way fire at the right time. */
export async function advanceStepwise(
  clock: Clock & { advance(ms: number): Promise<void> },
  totalMs: number,
  stepMs = 10,
): Promise<void> {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    await advance(clock, step);
    left -= step;
  }
}

/** Advance in steps until the loop reports idle (real IO such as WAV writes may interleave). */
export async function runUntilIdle(
  loop: { state: string; idle(): Promise<void> },
  clock: Clock & { advance(ms: number): Promise<void> },
  maxMs = 30_000,
): Promise<void> {
  let spent = 0;
  while (loop.state !== "idle" && spent < maxMs) {
    await advance(clock, 50);
    spent += 50;
  }
  await loop.idle();
}

export function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** A WebSocket the test drives by hand. */
export class FakeWsSocket implements WsSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closed: { code?: number; reason?: string } | null = null;
  private openCb: (() => void) | null = null;
  private messageCb: ((data: string | Uint8Array) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  constructor(
    readonly url: string,
    readonly opts: WsConnectOptions,
  ) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.closeCb?.(code ?? 1000, reason ?? "");
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  // test-side controls
  open(): void {
    this.openCb?.();
  }
  message(data: string | Uint8Array | Record<string, unknown>): void {
    const payload =
      typeof data === "string" || data instanceof Uint8Array ? data : JSON.stringify(data);
    this.messageCb?.(payload);
  }
  fail(err: Error): void {
    this.errorCb?.(err);
  }
  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

export function fakeWsFactory(): { factory: WsFactory; sockets: FakeWsSocket[] } {
  const sockets: FakeWsSocket[] = [];
  const factory: WsFactory = (url, opts) => {
    const s = new FakeWsSocket(url, opts);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

/** Yields the given byte pieces one per tick. */
export async function* bytePieces(pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of pieces) {
    await new Promise<void>((r) => setImmediate(r));
    yield p;
  }
}

/** Credential-shaped fixture built by concatenation. */
export function fakeKey(prefix: string): string {
  return [prefix, "0123456789", "abcdef0123", "4567890abc", "def0123456"].join(""); // not-a-secret
}
