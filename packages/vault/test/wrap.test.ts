import { randomBytes } from "node:crypto";
import { isForerunnerError } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/memory.ts";
import {
  INSTALL_WRAP_KEY_NAME,
  ensureInstallWrapKey,
  generateWrapKeyPair,
  isWrappedSecret,
  parseWrappedSecret,
  valueEncodings,
  WRAP_PROTOCOL_VERSION,
  type WrapBinding,
  wrapSecret,
  unwrapSecret,
} from "../src/wrap.ts";
import { captureOutput, caught, freshValue, stringify } from "./helpers.ts";

/**
 * Shared secrets (spec S.13, ADR 0065): a value is wrapped on the owner's install to the
 * named agent's install wrapping key (X25519 + HKDF-SHA256 + AES-256-GCM) and bound to the
 * secret name, the agent and the device it was made for. Only the holder of that install's
 * private key unwraps it; anyone else, any other binding, any tampered field fails closed,
 * and no failure ever names the value.
 */
const binding: WrapBinding = {
  name: "org_deploy_token",
  ownerHumanId: "human-ada",
  agentId: "agent-bobby",
  deviceId: "device-bob-pc",
};

let output: ReturnType<typeof captureOutput>;
beforeEach(() => {
  output = captureOutput();
});
afterEach(() => {
  output.restore();
});

describe("wrap keys", () => {
  it("generates raw 32-byte X25519 pairs as base64 and never the same twice", () => {
    const a = generateWrapKeyPair();
    const b = generateWrapKeyPair();
    expect(Buffer.from(a.publicKey, "base64")).toHaveLength(32);
    expect(Buffer.from(a.privateKey, "base64")).toHaveLength(32);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("keeps the install's private key in the vault under a reserved name, created once", async () => {
    const vault = new MemoryVault();
    const first = await ensureInstallWrapKey(vault);
    const again = await ensureInstallWrapKey(vault);
    expect(again).toEqual(first);
    expect(await vault.list()).toEqual([INSTALL_WRAP_KEY_NAME]);
    // The vault entry holds the private key only; the public key is derived from it.
    expect(await vault.get(INSTALL_WRAP_KEY_NAME)).toBe(first.privateKey);
    expect(first.publicKey).toHaveLength(44);
    // A value that is not a key is refused rather than used.
    await vault.set(INSTALL_WRAP_KEY_NAME, "not-a-key");
    const err = await caught(() => ensureInstallWrapKey(vault));
    expect(isForerunnerError(err, "validation")).toBe(true);
  });
});

describe("wrap and unwrap", () => {
  it("round-trips a value to the recipient and nobody else", () => {
    const recipient = generateWrapKeyPair();
    const other = generateWrapKeyPair();
    const value = freshValue("deploy-");
    const blob = wrapSecret(value, recipient.publicKey, binding);
    expect(blob.v).toBe(WRAP_PROTOCOL_VERSION);
    expect(isWrappedSecret(blob)).toBe(true);
    expect(JSON.stringify(blob)).not.toContain(value);
    for (const enc of valueEncodings(value)) expect(JSON.stringify(blob)).not.toContain(enc);
    expect(unwrapSecret(blob, recipient.privateKey, binding)).toBe(value);
    const err = caughtSync(() => unwrapSecret(blob, other.privateKey, binding));
    expect(isForerunnerError(err, "validation")).toBe(true);
    expect((err as { details: { reason: string } }).details.reason).toBe("integrity");
  });

  it("is bound to the name, the agent, the device and the owner: another binding fails closed", () => {
    const recipient = generateWrapKeyPair();
    const value = freshValue();
    const blob = wrapSecret(value, recipient.publicKey, binding);
    for (const key of Object.keys(binding) as (keyof WrapBinding)[]) {
      const err = caughtSync(() =>
        unwrapSecret(blob, recipient.privateKey, { ...binding, [key]: `${binding[key]}-x` }),
      );
      expect(isForerunnerError(err, "validation"), key).toBe(true);
    }
  });

  it("refuses a tampered field, a wrong version and a malformed blob without naming the value", () => {
    const recipient = generateWrapKeyPair();
    const value = freshValue("tamper-");
    const blob = wrapSecret(value, recipient.publicKey, binding);
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64");
      b[0] = (b[0] as number) ^ 0x01;
      return b.toString("base64");
    };
    const errors: unknown[] = [];
    for (const field of ["ciphertext", "tag", "iv", "salt", "ephemeralPublicKey"] as const) {
      errors.push(
        caughtSync(() =>
          unwrapSecret({ ...blob, [field]: flip(blob[field]) }, recipient.privateKey, binding),
        ),
      );
    }
    errors.push(caughtSync(() => unwrapSecret({ ...blob, v: 2 }, recipient.privateKey, binding)));
    errors.push(caughtSync(() => parseWrappedSecret({ v: 1, iv: "x" })));
    errors.push(caughtSync(() => parseWrappedSecret("nope")));
    errors.push(
      caughtSync(() =>
        unwrapSecret({ ...blob, ephemeralPublicKey: "AAAA" }, recipient.privateKey, binding),
      ),
    );
    errors.push(caughtSync(() => wrapSecret(value, "AAAA", binding)));
    errors.push(caughtSync(() => wrapSecret("", recipient.publicKey, binding)));
    for (const err of errors) {
      expect(isForerunnerError(err, "validation")).toBe(true);
      const text = stringify(err);
      expect(text).not.toContain(value);
      for (const enc of valueEncodings(value)) expect(text).not.toContain(enc);
    }
    expect(output.text()).not.toContain(value);
  });

  it("each wrap uses a fresh ephemeral key and salt: the same value wraps differently every time", () => {
    const recipient = generateWrapKeyPair();
    const value = freshValue();
    const a = wrapSecret(value, recipient.publicKey, binding);
    const b = wrapSecret(value, recipient.publicKey, binding);
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(unwrapSecret(b, recipient.privateKey, binding)).toBe(value);
  });

  it("carries values up to the vault's cap and multi-byte text intact", () => {
    const recipient = generateWrapKeyPair();
    const big = randomBytes(24_000).toString("base64");
    const text = `tökén-${freshValue()}-日本語`;
    for (const value of [big, text]) {
      const blob = wrapSecret(value, recipient.publicKey, binding);
      expect(unwrapSecret(blob, recipient.privateKey, binding)).toBe(value);
    }
  });
});

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the operation to throw");
}
