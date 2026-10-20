import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "@forerunner/platform/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_KEY_BYTES, EncryptedFileVault } from "../src/file.ts";
import { KeyringVault } from "../src/keyring.ts";
import { MemoryVault } from "../src/memory.ts";
import { openVault } from "../src/open.ts";
import { resolveSecretRefs, SecretResolver } from "../src/refs.ts";
import {
  captureOutput,
  FAST_SCRYPT,
  FakeKeyringStore,
  freshValue,
  stringify,
  tempDir,
} from "./helpers.ts";

/**
 * The invariant the whole package exists for: no stored value ever reaches a log line, an
 * error message, error details or the console, on the happy path or any failure path.
 */
let dir: string;
let cleanup: () => Promise<void>;
let output: ReturnType<typeof captureOutput>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  output = captureOutput();
});
afterEach(async () => {
  output.restore();
  await cleanup();
});

describe("no value ever leaks", () => {
  it("across every backend, openVault, refs and every error path", async () => {
    const values = [freshValue(), freshValue("second-"), `${freshValue("big-")}`.repeat(90)];
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };

    // Memory
    const memory = new MemoryVault();
    await memory.set("a", values[0] ?? "");
    await attempt(() => memory.set("Bad", values[0] ?? ""));

    // File: happy path, wrong key, tamper, locked, corrupt
    const path = join(dir, "vault.json");
    const file = await EncryptedFileVault.open({ path, scrypt: FAST_SCRYPT });
    await file.set("a", values[0] ?? "");
    await file.set("big", values[2] ?? "");
    await file.get("big");
    await attempt(() => file.set("", values[1] ?? ""));
    await attempt(() => EncryptedFileVault.open({ path, key: randomBytes(DEVICE_KEY_BYTES) }));
    const text = await fs.readFile(path, "utf8");
    const doc = JSON.parse(text);
    doc.entries.a.ct = Buffer.from("00", "hex").toString("base64") + doc.entries.a.ct.slice(4);
    await fs.writeFile(path, JSON.stringify(doc));
    await attempt(() => file.get("a"));
    await fs.writeFile(path, text);
    const locked = new EncryptedFileVault({ path });
    await attempt(() => locked.get("a"));
    await attempt(() => locked.set("a", values[1] ?? ""));
    await fs.writeFile(path, "garbage");
    await attempt(() => EncryptedFileVault.open({ path, key: file.exportKey() }));
    await fs.writeFile(path, text);

    // Keyring over the fake store: happy path, failing store, incomplete chunk
    const store = new FakeKeyringStore();
    const keyring = new KeyringVault({ profile: "leak", entries: store.factory });
    await keyring.set("a", values[0] ?? "");
    await keyring.set("big", values[2] ?? "");
    store.data.delete("forerunner-leak\u0000big#1");
    await attempt(() => keyring.get("big"));
    store.failing = true;
    await attempt(() => keyring.set("b", values[1] ?? ""));
    await attempt(() => KeyringVault.detect({ profile: "leak", entries: store.factory }));

    // openVault with fallback
    const opened = await openVault({
      env: { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv,
      detectKeyring: async () => ({ available: false, service: "forerunner", reason: "test" }),
    });
    await opened.set("a", values[1] ?? "");

    // Refs: resolution, not granted, not found, redaction through the resolver
    const resolver = new SecretResolver(memory, () => undefined);
    await resolver.resolve({ h: "secret:a" }, new Set(["a"]));
    await attempt(() => resolver.resolve({ h: "secret:a" }, new Set()));
    await attempt(() => resolveSecretRefs("secret:zzz", memory, new Set(["zzz"])));
    expect(resolver.redact(`echo ${values[0]}`)).toBe("echo [REDACTED]");

    // Everything captured: logs, console and every error (message, details, cause).
    const everything = [output.text(), ...errors.map((e) => stringify(e))].join("\n");
    expect(errors.length).toBeGreaterThanOrEqual(10);
    expect(everything.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(everything).not.toContain(v);
      expect(everything).not.toContain(Buffer.from(v).toString("base64"));
    }
    // and the vault file on disk never held a value either
    expect(await fs.readFile(path, "utf8")).not.toContain(values[0]);
  });
});
