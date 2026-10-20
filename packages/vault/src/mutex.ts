/**
 * Tiny in-process serialiser. Backends use it so concurrent set/delete calls never interleave
 * their read-modify-write of the index (keyring) or the file (encrypted store).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
