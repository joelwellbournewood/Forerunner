import { promises as fs } from "node:fs";
import { type ForerunnerError, isForerunnerError } from "@forerunner/platform";
import { join } from "@forerunner/platform/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedFileVault } from "../src/file.ts";
import { MemoryVault } from "../src/memory.ts";
import { redactValues, resolveSecretRefs, SecretResolver } from "../src/refs.ts";
import type { Vault } from "../src/types.ts";
import { captureOutput, caught, FAST_SCRYPT, freshValue, stringify, tempDir } from "./helpers.ts";

/**
 * Security review of the vault (spec S.4, S.11, S.12, ADR 0006, ADR 0033): a copied vault
 * file without its key, a world-readable key file, a tampered KDF block, the locked state,
 * what an error may say, and what the reference resolver and the redactor miss. A test marked
 * `it.fails` is a finding on the current code (comment above it).
 */

const isWindows = process.platform === "win32";

describe("file vault: the key is the boundary", () => {
  let dir = "";
  let cleanup: () => Promise<void> = async () => undefined;
  beforeEach(async () => {
    const t = await tempDir();
    dir = t.dir;
    cleanup = t.cleanup;
  });
  afterEach(() => cleanup());

  it("a vault file copied without its key cannot be opened: a fresh key is refused and never written next to the stolen file", async () => {
    const value = freshValue();
    const v = await EncryptedFileVault.open({ path: join(dir, "vault.json"), scrypt: FAST_SCRYPT });
    await v.set("github_pat", value);
    v.lock();
    const stolen = join(dir, "stolen");
    await fs.mkdir(stolen);
    await fs.copyFile(join(dir, "vault.json"), join(stolen, "vault.json"));
    const out = captureOutput();
    try {
      const e = await caught(() =>
        EncryptedFileVault.open({ path: join(stolen, "vault.json"), scrypt: FAST_SCRYPT }),
      );
      expect(isForerunnerError(e) && e.code === "validation").toBe(true);
      expect((e as ForerunnerError).details.reason).toBe("wrong_key");
      // Nothing was created: the attacker's directory holds no key and the file is untouched.
      await expect(fs.stat(join(stolen, "vault.key"))).rejects.toThrow();
      const text = `${stringify(e)}\n${out.text()}`;
      expect(text).not.toContain(value);
      expect(text).not.toContain(Buffer.from(value).toString("base64"));
    } finally {
      out.restore();
    }
    // A wrong 32-byte key given explicitly is refused the same way, and the real key still works.
    const wrong = await caught(() =>
      EncryptedFileVault.open({
        path: join(stolen, "vault.json"),
        key: new Uint8Array(32),
        scrypt: FAST_SCRYPT,
      }),
    );
    expect((wrong as ForerunnerError).details.reason).toBe("wrong_key");
    const again = await EncryptedFileVault.open({
      path: join(dir, "vault.json"),
      scrypt: FAST_SCRYPT,
    });
    expect(await again.get("github_pat")).toBe(value);
  });

  it("a locked vault refuses every operation with `unavailable`, naming the path and never a value", async () => {
    const value = freshValue();
    const v = await EncryptedFileVault.open({ path: join(dir, "vault.json"), scrypt: FAST_SCRYPT });
    await v.set("github_pat", value);
    const key = v.exportKey();
    v.lock();
    const ops: (() => Promise<unknown>)[] = [
      () => v.get("github_pat"),
      () => v.has("github_pat"),
      () => v.list(),
      () => v.set("x", "y"),
      () => v.delete("github_pat"),
      async () => v.exportKey(),
    ];
    for (const op of ops) {
      const e = await caught(op);
      expect(isForerunnerError(e) && e.code === "unavailable").toBe(true);
      expect(stringify(e)).not.toContain(value);
    }
    await v.unlock(key);
    expect(await v.get("github_pat")).toBe(value);
  });

  // security finding (low): `vault.key` is written 0600, but a key file that already exists
  // with wider permissions (restored from a backup, copied with `cp`, created by another
  // tool) is used as is: on a shared Linux host every local user can then decrypt the vault.
  // Fix: in `unlockWithStoredKey`, refuse (or chmod and log) a key file whose mode grants
  // group or other any bit, as ssh does for private keys.
  it.skipIf(isWindows)(
    "security finding: a world-readable device key file is refused or tightened before use",
    async () => {
      const path = join(dir, "vault.json");
      const v = await EncryptedFileVault.open({ path, scrypt: FAST_SCRYPT });
      await v.set("github_pat", freshValue());
      v.lock();
      await fs.chmod(v.keyPath, 0o644);
      let refused = false;
      try {
        await EncryptedFileVault.open({ path, scrypt: FAST_SCRYPT });
      } catch {
        refused = true;
      }
      const mode = (await fs.stat(v.keyPath)).mode & 0o777;
      expect(refused || mode === 0o600).toBe(true);
    },
  );

  // security finding (low): `parseDocument` takes `kdf.N`, `r` and `p` from the file without
  // bounds. A tampered file makes `scrypt` throw a raw Node error (not a
  // `ForerunnerError("validation", reason "corrupt")`) that escapes `open()`, and a huge N
  // turns the unlock into a memory bomb (`maxmem` is computed from N, so nothing refuses it).
  // Fix: validate N (power of two, 2^10..2^20), r (1..32) and p (1..16) in `parseDocument`.
  it("security finding: a tampered KDF block is refused as a corrupt vault file, never a raw crypto error", async () => {
    const path = join(dir, "vault.json");
    const v = await EncryptedFileVault.open({ path, scrypt: FAST_SCRYPT });
    await v.set("github_pat", freshValue());
    v.lock();
    const doc = JSON.parse(await fs.readFile(path, "utf8")) as { kdf: { N: number } };
    doc.kdf.N = 3;
    await fs.writeFile(path, JSON.stringify(doc));
    const e = await caught(() => EncryptedFileVault.open({ path, scrypt: FAST_SCRYPT }));
    expect(isForerunnerError(e)).toBe(true);
    expect((e as ForerunnerError).details.reason).toBe("corrupt");
  });
});

describe("references and redaction", () => {
  function countingVault(values: Record<string, string>): { vault: Vault; reads: () => number } {
    const inner = new MemoryVault(values);
    let reads = 0;
    const vault: Vault = {
      backend: "memory",
      get: async (n) => {
        reads++;
        return inner.get(n);
      },
      set: (n, v) => inner.set(n, v),
      delete: (n) => inner.delete(n),
      list: () => inner.list(),
      has: (n) => inner.has(n),
    };
    return { vault, reads: () => reads };
  }

  it("an ungranted name is refused before the vault is read, even when granted names sit next to it", async () => {
    const value = freshValue();
    const cv = countingVault({ gh: value, aws: freshValue() });
    const e = await caught(() =>
      resolveSecretRefs({ a: "secret:aws", b: "secret:gh" }, cv.vault, new Set(["gh"])),
    );
    expect(isForerunnerError(e) && e.code === "secret_not_granted").toBe(true);
    expect(cv.reads()).toBe(0);
    expect(stringify(e)).not.toContain(value);
  });

  it("the resolver never resolves inside keys, mid-string, in a class instance, or an invalid name; depth is capped", async () => {
    const value = freshValue();
    const cv = countingVault({ gh: value });
    const dated = new Date(0);
    const out = (await resolveSecretRefs(
      {
        "secret:gh": "secret:gh",
        mid: "token secret:gh here",
        bad: "secret:GH",
        inst: dated,
        list: [["secret:gh"]],
      },
      cv.vault,
      new Set(["gh"]),
    )) as Record<string, unknown>;
    expect(out["secret:gh"]).toBe(value);
    expect(Object.keys(out)).toContain("secret:gh");
    expect(out.mid).toBe("token secret:gh here");
    expect(out.bad).toBe("secret:GH");
    expect(out.inst).toBe(dated);
    expect(out.list).toEqual([[value]]);
    expect(cv.reads()).toBe(1);
    let deep: unknown = "secret:gh";
    for (let i = 0; i < 70; i++) deep = [deep];
    const e = await caught(() => resolveSecretRefs(deep, cv.vault, new Set(["gh"])));
    expect(isForerunnerError(e) && e.code === "validation").toBe(true);
  });

  it("the resolver scrubs raw, JSON-escaped, URL-encoded and base64 forms of every value it handed out", async () => {
    const value = `${freshValue()}/+="quote"`;
    const r = new SecretResolver(new MemoryVault({ gh: value }));
    await r.resolve({ t: "secret:gh" }, new Set(["gh"]));
    const text = [
      value,
      JSON.stringify({ v: value }),
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ].join("|");
    const out = r.redact(text);
    expect(out).not.toContain(value);
    expect(out).not.toContain(Buffer.from(value).toString("base64"));
    expect(out).not.toContain(encodeURIComponent(value));
    expect(out.split("[REDACTED]").length).toBeGreaterThanOrEqual(5);
    r.forget();
    expect(r.redact(value)).toBe(value);
  });

  // security finding (low): `redactValues` knows raw, JSON, URL and standard base64 forms. A
  // tool that prints the value base64url-encoded (JWT segments, `Authorization: Basic` in
  // some clients, `jq -r @base64d` pipelines) or hex-encoded gets through to the model.
  // Fix: add the base64url (with and without padding) and hex forms to the needle set.
  it("security finding: base64url and hex encodings of a resolved value are scrubbed too", () => {
    const value = `${freshValue()}>>??`;
    const b64url = Buffer.from(value).toString("base64url");
    const hex = Buffer.from(value).toString("hex");
    const out = redactValues(`a ${b64url} b ${hex} c`, [value]);
    expect(out).not.toContain(b64url);
    expect(out).not.toContain(hex);
  });
});
