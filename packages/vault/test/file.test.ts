import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { isForerunnerError, isWindows } from "@forerunner/platform";
import { join } from "@forerunner/platform/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE_KEY_BYTES,
  defaultKeyPath,
  defaultVaultPath,
  EncryptedFileVault,
} from "../src/file.ts";
import { caught, FAST_SCRYPT, freshValue, tempDir } from "./helpers.ts";

interface Box {
  iv: string;
  tag: string;
  ct: string;
}
interface Doc {
  version: number;
  kdf: { salt: string; N: number; r: number; p: number };
  check: Box;
  entries: Record<string, Box>;
}

let dir: string;
let cleanup: () => Promise<void>;
let vaultPath: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  vaultPath = join(dir, "vault.json");
});
afterEach(() => cleanup());

const readDoc = async (p = vaultPath): Promise<Doc> => JSON.parse(await fs.readFile(p, "utf8"));
const writeDoc = (doc: Doc, p = vaultPath) => fs.writeFile(p, JSON.stringify(doc));
const flipByte = (b64: string, at = 0): string => {
  const buf = Buffer.from(b64, "base64");
  buf[at] = (buf[at] ?? 0) ^ 0x01;
  return buf.toString("base64");
};

describe("EncryptedFileVault: basics", () => {
  it("creates the file and the device key on first open, then round-trips", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    expect(vault.backend).toBe("file");
    expect(vault.locked).toBe(false);
    expect(vault.unlockMode).toBe("device-key");
    expect(vault.keyPath).toBe(join(dir, "vault.key"));
    const key = await fs.readFile(vault.keyPath);
    expect(key).toHaveLength(DEVICE_KEY_BYTES);

    const a = freshValue();
    const b = freshValue();
    await vault.set("github_pat", a);
    await vault.set("anthropic.key", b);
    expect(await vault.get("github_pat")).toBe(a);
    expect(await vault.get("anthropic.key")).toBe(b);
    expect(await vault.get("missing")).toBeNull();
    expect(await vault.has("github_pat")).toBe(true);
    expect(await vault.has("missing")).toBe(false);
    expect(await vault.list()).toEqual(["anthropic.key", "github_pat"]);
    await vault.set("github_pat", b);
    expect(await vault.get("github_pat")).toBe(b);
    expect(await vault.delete("github_pat")).toBe(true);
    expect(await vault.delete("github_pat")).toBe(false);
    expect(await vault.list()).toEqual(["anthropic.key"]);

    // A second open with the stored key sees the same data.
    const again = await EncryptedFileVault.open({ path: vaultPath });
    expect(await again.get("anthropic.key")).toBe(b);
    expect(vault.exportKey()).toEqual(again.exportKey());
  });

  it("never writes a value in clear (nor base64) and keeps the documented layout", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const value = freshValue("plain-");
    await vault.set("name", value);
    const text = await fs.readFile(vaultPath, "utf8");
    expect(text).not.toContain(value);
    expect(text).not.toContain(Buffer.from(value).toString("base64"));
    const doc = await readDoc();
    expect(doc.version).toBe(1);
    expect(doc.kdf).toMatchObject({ N: FAST_SCRYPT.N, r: 8, p: 1 });
    expect(typeof doc.kdf.salt).toBe("string");
    expect(Object.keys(doc.entries)).toEqual(["name"]);
    expect(Object.keys(doc.entries.name ?? {}).sort()).toEqual(["ct", "iv", "tag"]);
  });

  it("validates names and values", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    await expect(vault.set("Nope", "x")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    await expect(vault.set("ok", "")).rejects.toSatisfy((e) => isForerunnerError(e, "validation"));
    await expect(vault.get("__check__")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
  });

  it.skipIf(isWindows())("writes the key file and the vault 0600 on POSIX", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    await vault.set("x", "value-1");
    expect((await fs.stat(vault.keyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(vaultPath)).mode & 0o777).toBe(0o600);
  });

  it("derives default paths from appDirs and the profile", () => {
    const env = { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv;
    expect(defaultVaultPath({ env })).toBe(join(dir, "config", "vault.json"));
    expect(defaultVaultPath({ env, profile: "test-a" })).toBe(
      join(dir, "config", "vault.test-a.json"),
    );
    expect(defaultKeyPath(join(dir, "config", "vault.test-a.json"))).toBe(
      join(dir, "config", "vault.test-a.key"),
    );
    expect(new EncryptedFileVault({ env, profile: "p" }).path).toBe(
      join(dir, "config", "vault.p.json"),
    );
  });
});

describe("EncryptedFileVault: keys", () => {
  it("rejects a wrong device key and a wrong passphrase", async () => {
    const key = randomBytes(DEVICE_KEY_BYTES);
    const vault = await EncryptedFileVault.open({ path: vaultPath, key, scrypt: FAST_SCRYPT });
    await vault.set("s", freshValue());
    expect(await fs.stat(vault.keyPath).catch(() => null)).toBeNull(); // not persisted

    const wrong = await caught(() =>
      EncryptedFileVault.open({ path: vaultPath, key: randomBytes(DEVICE_KEY_BYTES) }),
    );
    expect(isForerunnerError(wrong, "validation")).toBe(true);
    expect((wrong as { details: { reason: string } }).details.reason).toBe("wrong_key");

    const badPass = await caught(() =>
      EncryptedFileVault.open({ path: vaultPath, passphrase: "not-it" }),
    );
    expect(isForerunnerError(badPass, "validation")).toBe(true);

    const ok = await EncryptedFileVault.open({ path: vaultPath, key });
    expect(await ok.list()).toEqual(["s"]);
  });

  it("works with a passphrase and has no exportable key then", async () => {
    const value = freshValue();
    const vault = await EncryptedFileVault.open({
      path: vaultPath,
      passphrase: "correct horse",
      scrypt: FAST_SCRYPT,
    });
    expect(vault.unlockMode).toBe("passphrase");
    await vault.set("s", value);
    expect(() => vault.exportKey()).toThrow(/no exportable key/);
    expect(await fs.stat(vault.keyPath).catch(() => null)).toBeNull();
    const again = await EncryptedFileVault.open({ path: vaultPath, passphrase: "correct horse" });
    expect(await again.get("s")).toBe(value);
    await expect(EncryptedFileVault.open({ path: vaultPath, passphrase: "" })).rejects.toSatisfy(
      (e) => isForerunnerError(e, "validation"),
    );
    await expect(vault.importKey(new Uint8Array(5))).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
  });

  it("rejects a key file of the wrong size instead of using it", async () => {
    await fs.writeFile(join(dir, "vault.key"), randomBytes(16));
    const err = await caught(() => EncryptedFileVault.open({ path: vaultPath }));
    expect(isForerunnerError(err, "validation")).toBe(true);
  });
});

describe("EncryptedFileVault: tamper detection", () => {
  it("detects a flipped ciphertext byte, a flipped tag and a swapped entry", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    await vault.set("one", freshValue());
    await vault.set("two", freshValue());
    const clean = await readDoc();

    const flippedCt = structuredClone(clean);
    (flippedCt.entries.one as Box).ct = flipByte((clean.entries.one as Box).ct);
    await writeDoc(flippedCt);
    const e1 = await caught(() => vault.get("one"));
    expect(isForerunnerError(e1, "validation")).toBe(true);
    expect((e1 as { details: { reason: string } }).details.reason).toBe("integrity");
    expect(await vault.get("two")).not.toBeNull(); // untouched entry still fine

    const flippedTag = structuredClone(clean);
    (flippedTag.entries.one as Box).tag = flipByte((clean.entries.one as Box).tag);
    await writeDoc(flippedTag);
    await expect(vault.get("one")).rejects.toSatisfy((e) => isForerunnerError(e, "validation"));

    // Moving a ciphertext to another name must fail: the name is authenticated data.
    const swapped = structuredClone(clean);
    swapped.entries.one = clean.entries.two as Box;
    await writeDoc(swapped);
    await expect(vault.get("one")).rejects.toSatisfy((e) => isForerunnerError(e, "validation"));
    await writeDoc(clean);
    expect(await vault.get("one")).not.toBeNull();
  });

  it("refuses a tampered check value at unlock and a corrupt or newer file", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const key = vault.exportKey();
    const doc = await readDoc();
    await writeDoc({ ...doc, check: { ...doc.check, ct: flipByte(doc.check.ct) } });
    const e = await caught(() => EncryptedFileVault.open({ path: vaultPath, key }));
    expect(isForerunnerError(e, "validation")).toBe(true);

    await fs.writeFile(vaultPath, "{ not json");
    const corrupt = await caught(() => EncryptedFileVault.open({ path: vaultPath, key }));
    expect(isForerunnerError(corrupt, "validation")).toBe(true);
    expect((corrupt as { details: { reason: string } }).details.reason).toBe("corrupt");

    await writeDoc({ ...doc, version: 99 });
    await expect(EncryptedFileVault.open({ path: vaultPath, key })).rejects.toSatisfy((err) =>
      isForerunnerError(err, "not_supported"),
    );
  });
});

describe("EncryptedFileVault: atomic writes", () => {
  it("leaves a parseable file after every write and no temp files behind", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const expected: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      const name = `k${i % 10}`;
      expected[name] = freshValue(`w${i}-`);
      await vault.set(name, expected[name]);
      const doc = await readDoc();
      expect(Object.keys(doc.entries).sort()).toEqual(Object.keys(expected).sort());
    }
    for (const [name, value] of Object.entries(expected)) {
      expect(await vault.get(name)).toBe(value);
    }
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("ignores a stale temp file from a crashed writer", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const value = freshValue();
    await vault.set("s", value);
    await fs.writeFile(join(dir, ".vault.json.deadbeef0000.tmp"), "{ partial");
    const again = await EncryptedFileVault.open({ path: vaultPath });
    expect(await again.get("s")).toBe(value);
  });

  it("serialises concurrent writers so none is lost", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const values = Array.from({ length: 20 }, (_, i) => [`c${i}`, freshValue()] as const);
    await Promise.all(values.map(([n, v]) => vault.set(n, v)));
    expect(await vault.list()).toEqual(values.map(([n]) => n).sort());
    for (const [n, v] of values) expect(await vault.get(n)).toBe(v);
  });
});

describe("EncryptedFileVault: lock and unlock (cloud runner flow)", () => {
  it("starts locked when constructed, refuses every operation, and unlocks with the key", async () => {
    const device = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const value = freshValue();
    await device.set("deploy_token", value);
    const key = device.exportKey();
    expect(key).toHaveLength(DEVICE_KEY_BYTES);

    // The runner gets the blob but not the key file.
    const runnerDir = join(dir, "runner");
    await fs.mkdir(runnerDir);
    const runnerPath = join(runnerDir, "vault.json");
    await fs.copyFile(vaultPath, runnerPath);

    const runner = new EncryptedFileVault({ path: runnerPath });
    expect(runner.locked).toBe(true);
    for (const op of [
      () => runner.get("deploy_token"),
      () => runner.set("x", "y"),
      () => runner.delete("x"),
      () => runner.list(),
      () => runner.has("x"),
      () => Promise.resolve(runner.exportKey()),
    ]) {
      const e = await caught(op);
      expect(isForerunnerError(e, "unavailable")).toBe(true);
      expect((e as Error).message).toBe("vault locked");
    }

    await expect(runner.unlock(randomBytes(DEVICE_KEY_BYTES))).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    expect(runner.locked).toBe(true);

    await runner.unlock(key);
    expect(runner.locked).toBe(false);
    expect(await runner.get("deploy_token")).toBe(value);
    expect(await fs.stat(join(runnerDir, "vault.key")).catch(() => null)).toBeNull();

    runner.lock();
    expect(runner.locked).toBe(true);
    await expect(runner.get("deploy_token")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "unavailable"),
    );
    expect(() => runner.exportKey()).toThrow(/vault locked/);

    // importKey with persist writes the key next to the blob for a local install.
    await runner.importKey(key, { persist: true });
    expect(await fs.readFile(join(runnerDir, "vault.key"))).toEqual(key);
    const reopened = await EncryptedFileVault.open({ path: runnerPath });
    expect(await reopened.get("deploy_token")).toBe(value);
  });

  it("unlocking a missing file with a key creates a vault bound to that key", async () => {
    const key = randomBytes(DEVICE_KEY_BYTES);
    const vault = new EncryptedFileVault({ path: vaultPath, scrypt: FAST_SCRYPT });
    await vault.unlock(key);
    await vault.set("a", "value-a");
    await expect(
      EncryptedFileVault.open({ path: vaultPath, key: randomBytes(DEVICE_KEY_BYTES) }),
    ).rejects.toSatisfy((e) => isForerunnerError(e, "validation"));
    expect(await (await EncryptedFileVault.open({ path: vaultPath, key })).get("a")).toBe(
      "value-a",
    );
  });

  it("exported keys are copies: zeroing one does not affect the vault", async () => {
    const vault = await EncryptedFileVault.open({ path: vaultPath, scrypt: FAST_SCRYPT });
    const exported = vault.exportKey();
    exported.fill(0);
    expect(vault.exportKey()).not.toEqual(exported);
    await vault.set("a", "value-a");
    expect(await vault.get("a")).toBe("value-a");
  });
});
