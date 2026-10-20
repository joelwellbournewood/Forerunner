import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { errorMessage, ForerunnerError, isWindows, log } from "@forerunner/platform";
import { appDirs, basename, dirname, extname, join } from "@forerunner/platform/paths";
import { Mutex } from "./mutex.ts";
import { assertSecretName, assertSecretValue, type Vault } from "./types.ts";

/**
 * Encrypted file store. One JSON document holds the KDF parameters, a key-check value and
 * one AES-256-GCM ciphertext per entry. The AES key is derived with scrypt from either a
 * passphrase or a 32-byte device key. Locally the device key lives next to the file
 * (`vault.key`, 0600 on POSIX); on the cloud runner the file is present but the key is not:
 * the vault starts locked and the human's device supplies the key at unlock time.
 *
 * Writes are atomic: temp file in the same directory, fsync, rename over the target.
 * Plaintext lives in Buffers that are zeroed after use; the string handed to the caller is
 * the one copy we cannot erase.
 */

export const FILE_VAULT_VERSION = 1;
export const DEVICE_KEY_BYTES = 32;
export const DEFAULT_SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const AAD_PREFIX = `forerunner-vault:v${FILE_VAULT_VERSION}:`;
const CHECK_ACCOUNT = "__check__";
const CHECK_PLAINTEXT = "forerunner-vault-check";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

interface SealedBox {
  iv: string;
  tag: string;
  ct: string;
}

interface VaultDocument {
  version: number;
  kdf: { salt: string } & ScryptParams;
  check: SealedBox;
  entries: Record<string, SealedBox>;
}

export interface FileVaultOptions {
  /** Vault file. Default: appDirs().config/vault.json (vault.<profile>.json with a profile). */
  path?: string;
  /** Device key file. Default: next to the vault file with the `.key` extension. */
  keyPath?: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
  /** Derive the key from this passphrase instead of a device key. */
  passphrase?: string;
  /** Use this 32-byte device key (not persisted unless `persistKey` is true). */
  key?: Uint8Array;
  /** With `key`: also write it to keyPath. Default false. */
  persistKey?: boolean;
  /** KDF parameters for a vault created by this call; existing files keep theirs. */
  scrypt?: Partial<ScryptParams>;
}

export type FileVaultMode = "device-key" | "passphrase";

export function defaultVaultPath(opts: Pick<FileVaultOptions, "profile" | "env"> = {}): string {
  const dir = appDirs({ env: opts.env }).config;
  return join(dir, opts.profile ? `vault.${opts.profile}.json` : "vault.json");
}

export function defaultKeyPath(vaultPath: string): string {
  const ext = extname(vaultPath);
  const stem = ext ? basename(vaultPath, ext) : basename(vaultPath);
  return join(dirname(vaultPath), `${stem}.key`);
}

function scrypt(secret: Uint8Array, salt: Uint8Array, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      secret,
      salt,
      32,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: Math.max(64 * 1024 * 1024, 128 * params.N * params.r * 2),
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export class EncryptedFileVault implements Vault {
  readonly backend = "file" as const;
  readonly path: string;
  readonly keyPath: string;
  private readonly opts: FileVaultOptions;
  private readonly mutex = new Mutex();
  private readonly logger = log("vault:file");
  private aesKey: Buffer | null = null;
  private deviceKey: Buffer | null = null;
  private mode: FileVaultMode | null = null;

  /** A vault constructed directly starts locked. Use `open()` or `unlock*()`. */
  constructor(opts: FileVaultOptions = {}) {
    this.opts = opts;
    this.path = opts.path ?? defaultVaultPath(opts);
    this.keyPath = opts.keyPath ?? defaultKeyPath(this.path);
  }

  /**
   * Open unlocked: with a passphrase, with a given key, or (default) with the device key
   * from keyPath, created on first use. Creates the vault file when missing.
   */
  static async open(opts: FileVaultOptions = {}): Promise<EncryptedFileVault> {
    const vault = new EncryptedFileVault(opts);
    if (opts.passphrase !== undefined) {
      await vault.unlockWithPassphrase(opts.passphrase);
    } else if (opts.key) {
      await vault.importKey(opts.key, { persist: opts.persistKey ?? false });
    } else {
      await vault.unlockWithStoredKey();
    }
    return vault;
  }

  get locked(): boolean {
    return this.aesKey === null;
  }

  /** Forget the key material; every operation throws `unavailable` until unlocked again. */
  lock(): void {
    this.aesKey?.fill(0);
    this.deviceKey?.fill(0);
    this.aesKey = null;
    this.deviceKey = null;
    this.mode = null;
  }

  /** Unlock with a 32-byte device key held in memory only (the cloud runner flow). */
  async unlock(key: Uint8Array): Promise<void> {
    await this.importKey(key, { persist: false });
  }

  async unlockWithPassphrase(passphrase: string): Promise<void> {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      throw new ForerunnerError("validation", "vault passphrase must not be empty");
    }
    await this.mutex.run(async () => {
      const secret = Buffer.from(passphrase, "utf8");
      try {
        await this.deriveAndVerify(secret);
      } finally {
        secret.fill(0);
      }
      this.deviceKey = null;
      this.mode = "passphrase";
      this.logger.info("vault unlocked", { path: this.path, mode: "passphrase" });
    });
  }

  /** Unlock with a device key; with `persist` the key is written to keyPath (0600). */
  async importKey(key: Uint8Array, opts: { persist?: boolean } = {}): Promise<void> {
    if (!(key instanceof Uint8Array) || key.length !== DEVICE_KEY_BYTES) {
      throw new ForerunnerError("validation", `vault key must be ${DEVICE_KEY_BYTES} bytes`);
    }
    await this.mutex.run(async () => {
      const copy = Buffer.from(key);
      await this.deriveAndVerify(copy);
      this.deviceKey = copy;
      this.mode = "device-key";
      if (opts.persist) await this.writeKeyFile(copy);
      this.logger.info("vault unlocked", { path: this.path, mode: "device-key" });
    });
  }

  /** A copy of the device key (what the human's device holds). Passphrase vaults have none. */
  exportKey(): Buffer {
    this.assertUnlocked();
    if (!this.deviceKey) {
      throw new ForerunnerError("not_supported", "passphrase vaults have no exportable key");
    }
    return Buffer.from(this.deviceKey);
  }

  get unlockMode(): FileVaultMode | null {
    return this.mode;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value);
    await this.mutex.run(async () => {
      const key = this.assertUnlocked();
      const doc = await this.load();
      const plain = Buffer.from(value, "utf8");
      try {
        doc.entries[name] = seal(key, name, plain);
      } finally {
        plain.fill(0);
      }
      await this.store(doc);
    });
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    return this.mutex.run(async () => {
      const key = this.assertUnlocked();
      const doc = await this.load();
      const box = doc.entries[name];
      if (!box) return null;
      const plain = openBox(key, name, box, { path: this.path, name });
      try {
        return plain.toString("utf8");
      } finally {
        plain.fill(0);
      }
    });
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.mutex.run(async () => {
      this.assertUnlocked();
      const doc = await this.load();
      if (!(name in doc.entries)) return false;
      delete doc.entries[name];
      await this.store(doc);
      return true;
    });
  }

  async list(): Promise<string[]> {
    return this.mutex.run(async () => {
      this.assertUnlocked();
      return Object.keys((await this.load()).entries).sort();
    });
  }

  async has(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.mutex.run(async () => {
      this.assertUnlocked();
      return name in (await this.load()).entries;
    });
  }

  // ---- key handling ----------------------------------------------------------------------

  private assertUnlocked(): Buffer {
    if (!this.aesKey) {
      throw new ForerunnerError("unavailable", "vault locked", { details: { path: this.path } });
    }
    return this.aesKey;
  }

  private async unlockWithStoredKey(): Promise<void> {
    let key: Buffer;
    let created = false;
    try {
      key = await fs.readFile(this.keyPath);
    } catch (e) {
      if (!isMissing(e)) throw e;
      key = randomBytes(DEVICE_KEY_BYTES);
      created = true;
    }
    if (key.length !== DEVICE_KEY_BYTES) {
      throw new ForerunnerError("validation", "vault key file has the wrong size", {
        details: { keyPath: this.keyPath, reason: "corrupt" },
      });
    }
    await this.importKey(key, { persist: created });
    key.fill(0);
  }

  /** Derive the AES key from `secret` and verify it against the file's check value. */
  private async deriveAndVerify(secret: Buffer): Promise<void> {
    const existing = await this.loadOrNull();
    if (existing) {
      const derived = await scrypt(secret, Buffer.from(existing.kdf.salt, "base64"), existing.kdf);
      try {
        const check = openBox(derived, CHECK_ACCOUNT, existing.check, { path: this.path });
        const ok =
          check.length === CHECK_PLAINTEXT.length &&
          timingSafeEqual(check, Buffer.from(CHECK_PLAINTEXT));
        check.fill(0);
        if (!ok) throw new Error("check mismatch");
      } catch {
        derived.fill(0);
        throw new ForerunnerError("validation", "wrong vault key", {
          details: { path: this.path, reason: "wrong_key" },
        });
      }
      this.aesKey?.fill(0);
      this.aesKey = derived;
      return;
    }
    const params: ScryptParams = { ...DEFAULT_SCRYPT, ...this.opts.scrypt };
    const salt = randomBytes(16);
    const derived = await scrypt(secret, salt, params);
    const doc: VaultDocument = {
      version: FILE_VAULT_VERSION,
      kdf: { salt: salt.toString("base64"), ...params },
      check: seal(derived, CHECK_ACCOUNT, Buffer.from(CHECK_PLAINTEXT)),
      entries: {},
    };
    await this.store(doc);
    this.aesKey?.fill(0);
    this.aesKey = derived;
    this.logger.info("vault created", { path: this.path, scrypt: params });
  }

  private async writeKeyFile(key: Buffer): Promise<void> {
    await atomicWrite(this.keyPath, key, 0o600);
    if (isWindows()) {
      this.logger.info("device key written; relying on the profile directory ACL", {
        keyPath: this.keyPath,
      });
    }
  }

  // ---- file io ---------------------------------------------------------------------------

  private async load(): Promise<VaultDocument> {
    const doc = await this.loadOrNull();
    if (doc) return doc;
    throw new ForerunnerError("unavailable", "vault file missing", {
      details: { path: this.path },
    });
  }

  private async loadOrNull(): Promise<VaultDocument | null> {
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch (e) {
      if (isMissing(e)) return null;
      throw new ForerunnerError("unavailable", `cannot read vault file: ${errorMessage(e)}`, {
        details: { path: this.path },
        cause: e,
      });
    }
    return parseDocument(text, this.path);
  }

  private async store(doc: VaultDocument): Promise<void> {
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    await atomicWrite(this.path, Buffer.from(text, "utf8"), 0o600);
  }
}

// ---- crypto helpers -------------------------------------------------------------------------

function seal(key: Buffer, account: string, plain: Buffer): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${account}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function openBox(
  key: Buffer,
  account: string,
  box: SealedBox,
  details: Record<string, unknown>,
): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${account}`, "utf8"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
  } catch (e) {
    throw new ForerunnerError("validation", "vault entry failed authentication", {
      details: { ...details, reason: "integrity" },
      cause: e,
    });
  }
}

function isSealedBox(v: unknown): v is SealedBox {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return typeof b.iv === "string" && typeof b.tag === "string" && typeof b.ct === "string";
}

function parseDocument(text: string, path: string): VaultDocument {
  const corrupt = (why: string) =>
    new ForerunnerError("validation", `vault file is corrupt: ${why}`, {
      details: { path, reason: "corrupt" },
    });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt("not JSON");
  }
  if (!raw || typeof raw !== "object") throw corrupt("not an object");
  const doc = raw as Record<string, unknown>;
  if (doc.version !== FILE_VAULT_VERSION) {
    throw new ForerunnerError("not_supported", "vault file version not supported", {
      details: { path, version: doc.version },
    });
  }
  const kdf = doc.kdf as Record<string, unknown> | undefined;
  if (
    !kdf ||
    typeof kdf.salt !== "string" ||
    typeof kdf.N !== "number" ||
    typeof kdf.r !== "number" ||
    typeof kdf.p !== "number"
  ) {
    throw corrupt("kdf");
  }
  if (!isSealedBox(doc.check)) throw corrupt("check");
  if (!doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries)) {
    throw corrupt("entries");
  }
  const entries: Record<string, SealedBox> = {};
  for (const [name, box] of Object.entries(doc.entries as Record<string, unknown>)) {
    if (!isSealedBox(box)) throw corrupt(`entry ${name.slice(0, 40)}`);
    entries[name] = { iv: box.iv, tag: box.tag, ct: box.ct };
  }
  return {
    version: FILE_VAULT_VERSION,
    kdf: { salt: kdf.salt, N: kdf.N, r: kdf.r, p: kdf.p },
    check: { iv: doc.check.iv, tag: doc.check.tag, ct: doc.check.ct },
    entries,
  };
}

// ---- atomic file write ----------------------------------------------------------------------

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Write `data` to `target` atomically: temp file in the same directory (same filesystem, so
 * rename is a metadata operation), fsync, rename over the target. On Windows the mode is
 * ignored by the filesystem; the per-user profile directory ACL protects the file instead.
 */
export async function atomicWrite(target: string, data: Buffer, mode: number): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    if (!isWindows()) {
      try {
        await fs.chmod(tmp, mode);
      } catch {
        // best effort (some filesystems refuse)
      }
    }
    await fs.rename(tmp, target);
  } catch (e) {
    try {
      if (handle) await handle.close();
      await fs.rm(tmp, { force: true });
    } catch {
      // nothing more we can do
    }
    throw new ForerunnerError("unavailable", `cannot write vault file: ${errorMessage(e)}`, {
      details: { path: target },
      cause: e,
    });
  }
  if (!isWindows()) {
    try {
      const dh = await fs.open(dir, "r");
      await dh.sync().catch(() => undefined);
      await dh.close();
    } catch {
      // directory fsync is best effort
    }
  }
}
