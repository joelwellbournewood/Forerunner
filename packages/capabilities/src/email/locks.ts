/**
 * In-process serialization per key. The email caps (daily send, per-recipient, daily task)
 * are check-then-act over the audit log, so every check-plus-action for one agent runs under
 * that agent's lock: concurrent sessions, the acknowledgement path and a tool call cannot all
 * read "one below the cap" and then all act. Different agents never wait on each other.
 *
 * It only covers one process; a second runner handling the same mailbox is kept honest by
 * the audit-row check in commands.ts (one row per Message-ID) and by marking messages seen.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `fn` after every earlier `run` for the same key has finished (success or failure). */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** True while something runs or waits under the key. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
