import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, ForerunnerError, join } from "@forerunner/platform";

/**
 * The service's own small JSON state (session tokens, idempotency keys, the GitHub mirror
 * mapping). It lives under `<appDirs().data>/state-api/<name>.json`, is written atomically
 * (temp file + rename) and is read once at start. A future migration may move each file
 * into Postgres tables; the `JsonState` interface is what the rest of the service uses so
 * that move touches one place. `MemoryJsonState` backs tests.
 */
export interface JsonState<T> {
  get(): T;
  set(value: T): Promise<void>;
  /** Read-modify-write under the store's own serialisation. */
  update(fn: (current: T) => T): Promise<T>;
}

export class MemoryJsonState<T> implements JsonState<T> {
  private value: T;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(initial: T) {
    this.value = initial;
  }
  get(): T {
    return this.value;
  }
  async set(value: T): Promise<void> {
    this.value = value;
  }
  update(fn: (current: T) => T): Promise<T> {
    const next = this.chain.then(() => {
      this.value = fn(this.value);
      return this.value;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface FileJsonStateOptions<T> {
  dir: string;
  name: string;
  initial: () => T;
  /** Upgrade or validate what was read; return `initial()` to discard. */
  migrate?: (raw: unknown) => T;
}

export class FileJsonState<T> implements JsonState<T> {
  private value: T;
  private readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: FileJsonStateOptions<T>) {
    if (!/^[a-z][a-z0-9-]*$/.test(opts.name)) {
      throw new ForerunnerError("validation", `invalid state file name ${opts.name}`);
    }
    this.path = join(opts.dir, `${opts.name}.json`);
    this.value = this.load();
  }

  get file(): string {
    return this.path;
  }

  private load(): T {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return this.opts.initial();
      throw e;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return this.opts.migrate ? this.opts.migrate(parsed) : (parsed as T);
    } catch {
      // A corrupt file must not stop the service; it is renamed aside and started afresh.
      try {
        renameSync(this.path, `${this.path}.corrupt`);
      } catch {
        // ignore
      }
      return this.opts.initial();
    }
  }

  private write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(): T {
    return this.value;
  }

  set(value: T): Promise<void> {
    return this.update(() => value).then(() => undefined);
  }

  update(fn: (current: T) => T): Promise<T> {
    const next = this.chain.then(() => {
      const value = fn(this.value);
      this.write(value);
      this.value = value;
      return value;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
