import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

/**
 * Device identity primitives (ADR 0009): Ed25519 keys from @noble/ed25519 with the
 * synchronous SHA-512 from @noble/hashes wired in, SHA-256 for body hashes and token
 * hashes, and the canonical signed string for a request.
 */
ed.hashes.sha512 = sha512;

export const SIGNATURE_ALGORITHM = "ed25519";

export interface DeviceKeyPair {
  /** 32-byte secret key (seed), base64. Stays on the device; never sent to the service. */
  secretKey: string;
  /** 32-byte public key, base64. Registered at pairing. */
  publicKey: string;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** Generate a device key pair (used by shells and by tests). */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const secret = ed.utils.randomSecretKey();
  return { secretKey: toBase64(secret), publicKey: toBase64(ed.getPublicKey(secret)) };
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of a bearer token as stored by the service (the token itself is never stored). */
export function hashToken(token: string): string {
  return sha256Hex(`forerunner-session:${token}`);
}

/** Random session token: 32 bytes, URL-safe base64 (43 chars). */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** One-time pairing code: 8 characters from an alphabet without look-alikes. */
export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface SignedRequestParts {
  method: string;
  /** Path including the query string, as the client sent it. */
  path: string;
  /** Raw request body (empty string for none). */
  body: string | Uint8Array;
  /** ISO-8601 UTC or milliseconds since the epoch, exactly as put in X-Device-Timestamp. */
  timestamp: string;
  /** True when the shell has just passed a biometric prompt for this request. */
  biometric: boolean;
}

/**
 * The string a device signs: method, path, SHA-256 of the body, timestamp and the biometric
 * flag, newline separated. The flag is inside the signature so nobody but the key holder can
 * add it (R.7: biometric for high-risk confirmations).
 */
export function canonicalRequest(parts: SignedRequestParts): string {
  return [
    parts.method.toUpperCase(),
    parts.path,
    sha256Hex(parts.body),
    parts.timestamp,
    parts.biometric ? "biometric=1" : "biometric=0",
  ].join("\n");
}

export function signRequest(secretKeyB64: string, parts: SignedRequestParts): string {
  const message = new TextEncoder().encode(canonicalRequest(parts));
  return toBase64(ed.sign(message, fromBase64(secretKeyB64)));
}

export function verifyRequestSignature(
  publicKeyB64: string,
  signatureB64: string,
  parts: SignedRequestParts,
): boolean {
  try {
    const message = new TextEncoder().encode(canonicalRequest(parts));
    return ed.verify(fromBase64(signatureB64), message, fromBase64(publicKeyB64));
  } catch {
    return false;
  }
}

/** Proof of possession at pairing: the device signs "pair:<code>" with its new key. */
export function pairingProofMessage(code: string): Uint8Array {
  return new TextEncoder().encode(`pair:${code}`);
}

export function signPairingProof(secretKeyB64: string, code: string): string {
  return toBase64(ed.sign(pairingProofMessage(code), fromBase64(secretKeyB64)));
}

export function verifyPairingProof(publicKeyB64: string, code: string, proofB64: string): boolean {
  try {
    const pub = fromBase64(publicKeyB64);
    if (pub.length !== 32) return false;
    return ed.verify(fromBase64(proofB64), pairingProofMessage(code), pub);
  } catch {
    return false;
  }
}

export function isValidPublicKey(publicKeyB64: string): boolean {
  try {
    const bytes = fromBase64(publicKeyB64);
    if (bytes.length !== 32) return false;
    // Round-trip guards against whitespace or non-base64 input.
    return toBase64(bytes) === publicKeyB64.replace(/\s+/g, "");
  } catch {
    return false;
  }
}
