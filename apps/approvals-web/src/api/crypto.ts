/**
 * Device-side primitives for the state service (ADR 0009), browser only: base64 and hex,
 * SHA-256 and Ed25519 through WebCrypto, and the canonical signed request string exactly as
 * `services/state-api/src/auth/crypto.ts` verifies it. Nothing here logs and nothing keeps
 * a key outside the caller's hands.
 */

export const HEADER_SIGNATURE = "X-Device-Signature";
export const HEADER_TIMESTAMP = "X-Device-Timestamp";
export const HEADER_BIOMETRIC = "X-Biometric-Assertion";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this browser");
  return c.subtle;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? utf8(input) : input;
  const digest = await subtle().digest("SHA-256", data as BufferSource);
  return toHex(new Uint8Array(digest));
}

export interface SignedRequestParts {
  method: string;
  /** Path including the query string, exactly as sent. */
  path: string;
  /** Raw request body (empty string for none). */
  body: string | Uint8Array;
  /** Milliseconds since the epoch as a string, exactly as put in X-Device-Timestamp. */
  timestamp: string;
  /** True only when a biometric prompt succeeded for this request; never true on the web. */
  biometric: boolean;
}

/**
 * `METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`: the string the service
 * verifies (`canonicalRequest` in its crypto module). The biometric flag sits inside the
 * signature; this page has no biometric prompt and always signs `biometric=0`.
 */
export async function canonicalRequest(parts: SignedRequestParts): Promise<string> {
  return [
    parts.method.toUpperCase(),
    parts.path,
    await sha256Hex(parts.body),
    parts.timestamp,
    parts.biometric ? "biometric=1" : "biometric=0",
  ].join("\n");
}

/** Proof of possession at pairing: the device signs "pair:<code>" with its new key. */
export function pairingProofMessage(code: string): Uint8Array {
  return utf8(`pair:${code}`);
}

/** An Ed25519 key as this page stores it: the public key for the service, the private key as a JWK. */
export interface DeviceKey {
  /** 32-byte public key, base64. */
  publicKey: string;
  /** Private key JWK (`kty: OKP, crv: Ed25519, d, x`). Lives in sessionStorage with the token. */
  privateJwk: { kty: "OKP"; crv: "Ed25519"; d: string; x: string };
}

const ED25519 = { name: "Ed25519" } as const;

export async function isEd25519Supported(): Promise<boolean> {
  try {
    await subtle().generateKey(ED25519, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

export async function generateDeviceKey(): Promise<DeviceKey> {
  const keys = (await subtle().generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await subtle().exportKey("jwk", keys.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("WebCrypto did not export an Ed25519 private key");
  const raw = new Uint8Array(await subtle().exportKey("raw", keys.publicKey));
  return {
    publicKey: toBase64(raw),
    privateJwk: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x },
  };
}

/** Import the stored private key for signing (not extractable again). */
export async function importSigningKey(jwk: DeviceKey["privateJwk"]): Promise<CryptoKey> {
  return subtle().importKey("jwk", { ...jwk, ext: true }, ED25519, false, ["sign"]);
}

export async function signBytes(key: CryptoKey, message: Uint8Array): Promise<string> {
  const sig = await subtle().sign(ED25519.name, key, message as BufferSource);
  return toBase64(new Uint8Array(sig));
}

/** Verify an Ed25519 signature with WebCrypto (tests and the pairing self-check). */
export async function verifyBytes(
  publicKeyB64: string,
  signatureB64: string,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      "raw",
      fromBase64(publicKeyB64) as BufferSource,
      ED25519,
      false,
      ["verify"],
    );
    return await subtle().verify(
      ED25519.name,
      key,
      fromBase64(signatureB64) as BufferSource,
      message as BufferSource,
    );
  } catch {
    return false;
  }
}
