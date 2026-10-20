import { isForerunnerError, Logger, type LogRecord } from "@forerunner/platform";
import { join } from "@forerunner/platform/paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedFileVault } from "../src/file.ts";
import type { KeyringDetection } from "../src/keyring.ts";
import { KeyringVault } from "../src/keyring.ts";
import { MemoryVault } from "../src/memory.ts";
import { openVault, VAULT_BACKEND_ENV } from "../src/open.ts";
import { caught, FakeKeyringStore, freshValue, tempDir } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let records: LogRecord[];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  records = [];
  Logger.setSinks([(r) => records.push(r)]);
  Logger.setLevel("debug");
});
afterEach(async () => {
  Logger.setSinks([]);
  await cleanup();
});

const unavailable = async (): Promise<KeyringDetection> => ({
  available: false,
  service: "forerunner",
  reason: "no secret service (test)",
});

describe("openVault", () => {
  it("falls back to the encrypted file vault when the keyring is unavailable, and logs why", async () => {
    const env = { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv;
    const vault = await openVault({ prefer: "keyring", env, detectKeyring: unavailable });
    expect(vault.backend).toBe("file");
    expect(vault).toBeInstanceOf(EncryptedFileVault);
    expect((vault as EncryptedFileVault).path).toBe(join(dir, "config", "vault.json"));
    const value = freshValue();
    await vault.set("k", value);
    expect(await vault.get("k")).toBe(value);
    const warn = records.find((r) => r.level === "warn");
    expect(warn?.msg).toMatch(/falling back/);
    expect(JSON.stringify(records)).toContain("no secret service (test)");
    expect(JSON.stringify(records)).not.toContain(value);
  });

  it("falls back for real when this machine has no keyring, otherwise picks it", async () => {
    const env = { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv;
    const detection = await KeyringVault.detect({ profile: "open-test", timeoutMs: 5_000 });
    const vault = await openVault({ env, profile: "open-test" });
    expect(vault.backend).toBe(detection.available ? "keyring" : "file");
  });

  it("uses the keyring when the probe succeeds", async () => {
    const store = new FakeKeyringStore();
    const vault = await openVault({
      profile: "test-a",
      env: { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv,
      keyringEntries: store.factory,
    });
    expect(vault.backend).toBe("keyring");
    expect((vault as KeyringVault).service).toBe("forerunner-test-a");
    await vault.set("k", "value-k");
    expect(store.accounts("forerunner-test-a")).toContain("k");
    expect(records.some((r) => r.msg.includes("keyring"))).toBe(true);
  });

  it(`${VAULT_BACKEND_ENV}=file skips the keyring probe entirely`, async () => {
    const detect = vi.fn(unavailable);
    const vault = await openVault({
      prefer: "keyring",
      env: { [VAULT_BACKEND_ENV]: "file", FORERUNNER_HOME: dir } as NodeJS.ProcessEnv,
      detectKeyring: detect,
      path: join(dir, "custom.json"),
      passphrase: "pass phrase",
    });
    expect(vault.backend).toBe("file");
    expect((vault as EncryptedFileVault).path).toBe(join(dir, "custom.json"));
    expect((vault as EncryptedFileVault).unlockMode).toBe("passphrase");
    expect(detect).not.toHaveBeenCalled();
  });

  it(`${VAULT_BACKEND_ENV}=memory gives a MemoryVault and warns`, async () => {
    const vault = await openVault({ env: { [VAULT_BACKEND_ENV]: "memory" } as NodeJS.ProcessEnv });
    expect(vault).toBeInstanceOf(MemoryVault);
    expect(records.some((r) => r.level === "warn" && /memory/.test(r.msg))).toBe(true);
  });

  it(`${VAULT_BACKEND_ENV}=keyring with no keyring fails loudly instead of silently downgrading`, async () => {
    const err = await caught(() =>
      openVault({
        env: { [VAULT_BACKEND_ENV]: "keyring", FORERUNNER_HOME: dir } as NodeJS.ProcessEnv,
        detectKeyring: unavailable,
      }),
    );
    expect(isForerunnerError(err, "unavailable")).toBe(true);
  });

  it("rejects an unknown backend value", async () => {
    await expect(
      openVault({ env: { [VAULT_BACKEND_ENV]: "cloud" } as NodeJS.ProcessEnv }),
    ).rejects.toSatisfy((e) => isForerunnerError(e, "validation"));
  });

  it("prefer=file never probes the keyring", async () => {
    const detect = vi.fn(unavailable);
    const vault = await openVault({
      prefer: "file",
      env: { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv,
      detectKeyring: detect,
    });
    expect(vault.backend).toBe("file");
    expect(detect).not.toHaveBeenCalled();
  });
});
