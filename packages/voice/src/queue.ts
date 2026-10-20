/**
 * Small unbounded async queue: producers push, one consumer iterates. Used for STT event
 * streams, TTS chunk pipelines and the loop's own event plumbing.
 */
interface Waiter<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (e: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: unknown = undefined;
  private failed = false;

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** No more items; pending consumers finish once the buffer drains. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as T, done: true });
  }

  /** Close with an error delivered to the consumer after the buffered items (once). */
  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiters.splice(0);
    const first = waiting.shift();
    if (first) {
      first.reject(err);
      for (const w of waiting) w.resolve({ value: undefined as T, done: true });
    } else {
      this.failure = err;
      this.failed = true;
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.closed) {
      if (this.failed) {
        const e = this.failure;
        this.failed = false;
        return Promise.reject(e);
      }
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as T, done: true });
      },
    };
  }
}

/** Drain an async iterable into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
