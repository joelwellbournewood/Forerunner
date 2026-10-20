import { randomBytes } from "node:crypto";
import { type Clock, errorMessage, ForerunnerError, log, systemClock } from "@forerunner/platform";
import { Mutex } from "./mutex.ts";
import { assertSecretName, assertSecretValue, type Vault } from "./types.ts";

/**
 * Vault over the OS keychain through @napi-rs/keyring (keyring-rs): Windows Credential
 * Manager, libsecret (GNOME Keyring, KWallet) on Linux, Keychain on macOS.
 *
 * Keychains cannot enumerate, so the service keeps an index entry (`__index__`, a JSON
 * array of names). Windows caps a credential blob at 2560 bytes (1280 UTF-16 units), so
 * values longer than KEYRING_CHUNK_CHARS are split across `<name>#<i>` entries with a
 * header in `<name>`. Linux is pinned to the Secret Service: keyring-rs would otherwise fall
 * back to the kernel keyring, which does not survive a reboot.
 */

export const DEFAULT_KEYRING_SERVICE = "forerunner";
export const KEYRING_INDEX_ACCOUNT = "__index__";
export const KEYRING_CHUNK_CHARS = 1024;
const CHUNK_HEADER_PREFIX = "forerunner-chunked:v1:";
const DEFAULT_TIMEOUT_MS = 10_000;

/** The subset of @napi-rs/keyring's AsyncEntry the vault needs; tests supply fakes. */
export interface KeyringEntryLike {
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  getPassword(signal?: AbortSignal | null): Promise<string | null>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

export type KeyringEntryFactory = (
  service: string,
  account: string,
) => Promise<KeyringEntryLike> | KeyringEntryLike;

export interface KeyringVaultOptions {
  /** Appended to the service name: "forerunner-<profile>" (two-install test environment). */
  profile?: string;
  /** Full service name; overrides profile. */
  service?: string;
  /** Entry factory; default loads @napi-rs/keyring lazily. */
  entries?: KeyringEntryFactory;
  clock?: Clock;
  /** Per-operation timeout (a locked keyring may show a prompt). */
  timeoutMs?: number;
}

export type KeyringDetection =
  | { available: true; service: string }
  | { available: false; service: string; reason: string };

export function keyringServiceName(opts: Pick<KeyringVaultOptions, "profile" | "service">): string {
  if (opts.service) return opts.service;
  if (opts.profile) {
    const p = opts.profile.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p)) {
      throw new ForerunnerError("validation", "invalid vault profile", { details: { profile: p } });
    }
    return `${DEFAULT_KEYRING_SERVICE}-${p}`;
  }
  return DEFAULT_KEYRING_SERVICE;
}

interface NativeKeyring {
  AsyncEntry: new (
    service: string,
    username: string,
    options?: { linux?: { store?: "secret-service" | "keyutils" } } | null,
  ) => KeyringEntryLike;
}

let nativePromise: Promise<NativeKeyring> | null = null;

/** Loads the native binding once; a missing binary surfaces as `unavailable`, not a crash. */
function loadNative(): Promise<NativeKeyring> {
  if (!nativePromise) {
    nativePromise = import("@napi-rs/keyring").then(
      (m) => m as unknown as NativeKeyring,
      (e: unknown) => {
        nativePromise = null;
        throw new ForerunnerError("unavailable", "OS keyring binding could not be loaded", {
          details: { reason: errorMessage(e) },
          cause: e,
        });
      },
    );
  }
  return nativePromise;
}

export const nativeKeyringEntries: KeyringEntryFactory = async (service, account) => {
  const native = await loadNative();
  return new native.AsyncEntry(service, account, { linux: { store: "secret-service" } });
};

export class KeyringVault implements Vault {
  readonly backend = "keyring" as const;
  readonly service: string;
  private readonly entries: KeyringEntryFactory;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly mutex = new Mutex();
  private readonly logger = log("vault:keyring");

  constructor(opts: KeyringVaultOptions = {}) {
    this.service = keyringServiceName(opts);
    this.entries = opts.entries ?? nativeKeyringEntries;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Probe: write, read back and delete a random internal name. Any failure (no Secret
   * Service, locked store, missing binding, timeout) reports unavailable with a reason.
   */
  static async detect(opts: KeyringVaultOptions = {}): Promise<KeyringDetection> {
    const vault = new KeyringVault(opts);
    const account = `__probe__${randomBytes(8).toString("hex")}`;
    const nonce = randomBytes(16).toString("hex");
    try {
      await vault.rawSet(account, nonce);
      const back = await vault.rawGet(account);
      await vault.rawDelete(account);
      if (back !== nonce) {
        return { available: false, service: vault.service, reason: "probe read back mismatch" };
      }
      return { available: true, service: vault.service };
    } catch (e) {
      try {
        await vault.rawDelete(account);
      } catch {
        // best effort cleanup
      }
      return { available: false, service: vault.service, reason: errorMessage(e) };
    }
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value);
    await this.mutex.run(async () => {
      await this.writeChunked(name, value);
      const index = await this.readIndex();
      if (!index.includes(name)) {
        index.push(name);
        await this.writeIndex(index);
      }
    });
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    return this.mutex.run(() => this.readChunked(name));
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.mutex.run(async () => {
      const index = await this.readIndex();
      if (index.includes(name)) await this.writeIndex(index.filter((n) => n !== name));
      return this.deleteChunked(name);
    });
  }

  async list(): Promise<string[]> {
    return this.mutex.run(async () => (await this.readIndex()).sort());
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  // ---- index -----------------------------------------------------------------------------

  private async readIndex(): Promise<string[]> {
    const raw = await this.readChunked(KEYRING_INDEX_ACCOUNT);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((n): n is string => typeof n === "string");
    } catch {
      this.logger.warn("keyring index unreadable, treating as empty", { service: this.service });
    }
    return [];
  }

  private writeIndex(names: string[]): Promise<void> {
    return this.writeChunked(KEYRING_INDEX_ACCOUNT, JSON.stringify([...names].sort()));
  }

  // ---- chunking --------------------------------------------------------------------------

  private async writeChunked(account: string, value: string): Promise<void> {
    const previous = await this.chunkCount(account);
    if (value.length <= KEYRING_CHUNK_CHARS && !value.startsWith(CHUNK_HEADER_PREFIX)) {
      await this.rawSet(account, value);
    } else {
      const count = Math.ceil(value.length / KEYRING_CHUNK_CHARS);
      for (let i = 0; i < count; i++) {
        await this.rawSet(
          `${account}#${i}`,
          value.slice(i * KEYRING_CHUNK_CHARS, (i + 1) * KEYRING_CHUNK_CHARS),
        );
      }
      await this.rawSet(account, `${CHUNK_HEADER_PREFIX}${count}`);
      for (let i = count; i < previous; i++) await this.rawDelete(`${account}#${i}`);
      return;
    }
    for (let i = 0; i < previous; i++) await this.rawDelete(`${account}#${i}`);
  }

  private async readChunked(account: string): Promise<string | null> {
    const head = await this.rawGet(account);
    if (head === null) return null;
    const count = parseHeader(head);
    if (count === null) return head;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await this.rawGet(`${account}#${i}`);
      if (part === null) {
        throw new ForerunnerError("internal", "keyring entry is incomplete", {
          details: { service: this.service, account, missingChunk: i },
        });
      }
      parts.push(part);
    }
    return parts.join("");
  }

  private async deleteChunked(account: string): Promise<boolean> {
    const previous = await this.chunkCount(account);
    const existed = await this.rawDelete(account);
    for (let i = 0; i < previous; i++) await this.rawDelete(`${account}#${i}`);
    return existed || previous > 0;
  }

  private async chunkCount(account: string): Promise<number> {
    const head = await this.rawGet(account);
    return head === null ? 0 : (parseHeader(head) ?? 0);
  }

  // ---- raw entry access ------------------------------------------------------------------

  private async withTimeout<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (e) {
      if (e instanceof ForerunnerError) throw e;
      throw new ForerunnerError(
        "unavailable",
        controller.signal.aborted
          ? `keyring ${op} timed out after ${this.timeoutMs} ms`
          : `keyring ${op} failed: ${errorMessage(e)}`,
        { details: { service: this.service, op }, cause: e, retryable: true },
      );
    } finally {
      cancel();
    }
  }

  private async rawSet(account: string, value: string): Promise<void> {
    const entry = await this.entries(this.service, account);
    await this.withTimeout("write", (signal) => entry.setPassword(value, signal));
  }

  private async rawGet(account: string): Promise<string | null> {
    const entry = await this.entries(this.service, account);
    return this.withTimeout("read", (signal) => entry.getPassword(signal));
  }

  private async rawDelete(account: string): Promise<boolean> {
    const entry = await this.entries(this.service, account);
    return this.withTimeout("delete", (signal) => entry.deleteCredential(signal));
  }
}

function parseHeader(value: string): number | null {
  if (!value.startsWith(CHUNK_HEADER_PREFIX)) return null;
  const n = Number.parseInt(value.slice(CHUNK_HEADER_PREFIX.length), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
