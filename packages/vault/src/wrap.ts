import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { ForerunnerError } from "@forerunner/platform";
import { assertSecretValue, MAX_SECRET_VALUE_LENGTH, type Vault } from "./types.ts";

/**
 * Shared secrets (spec S.13, ADR 0065). A secret shared between two humans' agents never
 * leaves the owner's install in clear: the owner wraps the value to the *install wrapping
 * key* of every install that runs a named agent, the state service stores and serves the
 * wrapped blobs, and the named agent's install unwraps with its private key at resolution
 * time. The service, the phones and the other install's owner see ciphertext only.
 *
 * Scheme (node:crypto only, the same primitives as the runner unlock of ADR 0033):
 *   per blob: an ephemeral X25519 pair and a 32-byte salt;
 *   key = HKDF-SHA256(X25519(ephemeralPriv, installPub), salt, info "forerunner-shared-secret:v1");
 *   AES-256-GCM over the UTF-8 value with AAD = "<version>:<ownerHumanId>:<name>:<agentId>:<deviceId>".
 * The AAD binds a blob to one secret name, one agent and one device: a blob served for
 * another agent or copied to another install fails authentication instead of decrypting.
 *
 * The install's private key lives in its vault under `INSTALL_WRAP_KEY_NAME` (keyring or
 * encrypted file), so it is never on disk in clear; the public key is registered on the
 * install's `device` row. Keys are raw 32-byte values, base64; the DER prefixes below turn
 * them into KeyObjects.
 */

export const WRAP_PROTOCOL_VERSION = 1;
/** Vault entry (every backend) that holds this install's X25519 private key, base64. */
export const INSTALL_WRAP_KEY_NAME = "forerunner.install_wrap_key";
const HKDF_INFO = `forerunner-shared-secret:v${WRAP_PROTOCOL_VERSION}`;
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const RAW_KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Ciphertext bound: the vault's value cap in UTF-8 (4 bytes per UTF-16 unit at most) plus the tag. */
const MAX_CIPHERTEXT_BYTES = MAX_SECRET_VALUE_LENGTH * 4 + TAG_BYTES;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface WrapKeyPair {
  /** Raw 32-byte X25519 public key, base64: what the device row carries. */
  publicKey: string;
  /** Raw 32-byte X25519 private key, base64: what the vault holds. */
  privateKey: string;
}

/** What a wrapped blob is bound to; every field is part of the AAD. */
export interface WrapBinding {
  name: string;
  ownerHumanId: string;
  agentId: string;
  deviceId: string;
}

/** A wrapped secret: ciphertext and public material only. Safe to store and to log. */
export interface WrappedSecret {
  v: number;
  /** The sender's one-time X25519 public key, base64. */
  ephemeralPublicKey: string;
  /** HKDF salt, base64. */
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function generateWrapKeyPair(): WrapKeyPair {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublicKey(pair.publicKey).toString("base64"),
    privateKey: rawPrivateKey(pair.privateKey).toString("base64"),
  };
}

/** The install's wrapping pair from its vault, created on first use. */
export async function ensureInstallWrapKey(vault: Vault): Promise<WrapKeyPair> {
  const stored = await vault.get(INSTALL_WRAP_KEY_NAME);
  if (stored !== null) {
    const priv = privateKeyFromRaw(decodeRaw(stored, "install wrapping key"));
    return {
      publicKey: rawPublicKey(createPublicKey(priv)).toString("base64"),
      privateKey: stored,
    };
  }
  const pair = generateWrapKeyPair();
  await vault.set(INSTALL_WRAP_KEY_NAME, pair.privateKey);
  return pair;
}

/** Wrap `value` to `recipientPublicKey` (raw base64) under `binding`. Pure; no store, no log. */
export function wrapSecret(
  value: string,
  recipientPublicKey: string,
  binding: WrapBinding,
): WrappedSecret {
  assertSecretValue(value);
  const recipient = publicKeyFromRaw(decodeRaw(recipientPublicKey, "recipient wrapping key"));
  const ephemeral = generateKeyPairSync("x25519");
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(ephemeral.privateKey, recipient, salt);
  const iv = randomBytes(IV_BYTES);
  const plain = Buffer.from(value, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(binding));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      v: WRAP_PROTOCOL_VERSION,
      ephemeralPublicKey: rawPublicKey(ephemeral.publicKey).toString("base64"),
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ct.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

/**
 * Unwrap with the install's private key (raw base64) under the same binding. Any mismatch
 * (another key, another binding, a tampered field) is `validation` with reason `integrity`;
 * the message never carries plaintext because none was produced.
 */
export function unwrapSecret(
  blob: unknown,
  installPrivateKey: string,
  binding: WrapBinding,
): string {
  const parsed = parseWrappedSecret(blob);
  const priv = privateKeyFromRaw(decodeRaw(installPrivateKey, "install wrapping key"));
  const sender = publicKeyFromRaw(decodeRaw(parsed.ephemeralPublicKey, "ephemeral key"));
  const key = deriveKey(priv, sender, Buffer.from(parsed.salt, "base64"));
  let plain: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    plain = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch (e) {
    throw new ForerunnerError("validation", "shared secret failed authentication", {
      details: { name: binding.name, agentId: binding.agentId, reason: "integrity" },
      cause: e instanceof Error ? e.message : undefined,
    });
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

export function isWrappedSecret(v: unknown): v is WrappedSecret {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  const b64 = (s: unknown, max: number) =>
    typeof s === "string" && s.length > 0 && s.length <= max && BASE64.test(s);
  return (
    b.v === WRAP_PROTOCOL_VERSION &&
    b64(b.ephemeralPublicKey, 44) &&
    b64(b.salt, 44) &&
    b64(b.iv, 16) &&
    b64(b.tag, 24) &&
    b64(b.ciphertext, Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4)
  );
}

/** The blob with only its known fields, or `validation`. */
export function parseWrappedSecret(v: unknown): WrappedSecret {
  if (!isWrappedSecret(v)) {
    throw new ForerunnerError("validation", "not a wrapped secret", {
      details: { reason: "malformed", version: (v as { v?: unknown } | null)?.v ?? null },
    });
  }
  return {
    v: v.v,
    ephemeralPublicKey: v.ephemeralPublicKey,
    salt: v.salt,
    iv: v.iv,
    ciphertext: v.ciphertext,
    tag: v.tag,
  };
}

/** Every encoding of a value a row, a log line or an error could carry (for leak tests and scrubbing). */
export function valueEncodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    b64,
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    bytes.toString("hex"),
  ].filter((s) => s.length >= 4);
}

// ---- key encodings -------------------------------------------------------------------------

function decodeRaw(b64: string, what: string): Buffer {
  const raw = typeof b64 === "string" && BASE64.test(b64) ? Buffer.from(b64, "base64") : null;
  if (!raw || raw.length !== RAW_KEY_BYTES) {
    throw new ForerunnerError("validation", `${what} must be a raw 32-byte X25519 key`, {
      details: { reason: "bad_key", length: raw?.length ?? null },
    });
  }
  return raw;
}

function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(
    key.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length),
  );
}

function rawPrivateKey(key: KeyObject): Buffer {
  return Buffer.from(
    key.export({ format: "der", type: "pkcs8" }).subarray(X25519_PKCS8_PREFIX.length),
  );
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function privateKeyFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function deriveKey(privateKey: KeyObject, publicKey: KeyObject, salt: Buffer): Buffer {
  const shared = Buffer.from(diffieHellman({ privateKey, publicKey }));
  try {
    return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, 32));
  } finally {
    shared.fill(0);
  }
}

function aad(b: WrapBinding): Buffer {
  return Buffer.from(
    `${WRAP_PROTOCOL_VERSION}:${b.ownerHumanId}:${b.name}:${b.agentId}:${b.deviceId}`,
    "utf8",
  );
}
