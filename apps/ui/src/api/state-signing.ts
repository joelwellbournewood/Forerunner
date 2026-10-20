/**
 * Device-side primitives for the shared state service (ADR 0009): the canonical signed
 * request string exactly as `services/state-api/src/auth/crypto.ts` defines it, SHA-256 and
 * Ed25519 through WebCrypto, and the ports a shell fills in (a signer whose key lives in the
 * Android Keystore, a biometric prompt). Nothing here logs; the secret key never leaves the
 * signer. Browser-safe: no Node modules, no Buffer.
 */

export const HEADER_SIGNATURE = "x-device-signature";
export const HEADER_TIMESTAMP = "x-device-timestamp";
export const HEADER_BIOMETRIC = "x-biometric-assertion";

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

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("hex string has an odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
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
  /** Milliseconds since the epoch (or ISO-8601), exactly as put in X-Device-Timestamp. */
  timestamp: string;
  /** True only when a biometric prompt succeeded for this request. */
  biometric: boolean;
}

/**
 * `METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`: the string the service
 * verifies (`canonicalRequest` in the service's crypto module). The biometric flag is inside
 * the signature so nobody but the key holder can add it.
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

/** How long a ticket from a prompt stays valid in the web fallback (the shell has the same). */
export const TICKET_TTL_MS = 120_000;

/** Where a prompt draws its one-time ticket. */
export interface TicketIssuer {
  issue(): string;
}

/**
 * The web fallback's ticket book (the shell keeps its own in Rust): a successful simulated
 * prompt issues one ticket; `WebCryptoSigner.sign` redeems it for exactly one `biometric=1`
 * string inside the TTL. A new prompt replaces an unused ticket.
 */
export class TicketBook implements TicketIssuer {
  private current: { ticket: string; issuedAt: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const ticket = toHex(bytes);
    this.current = { ticket, issuedAt: this.now() };
    return ticket;
  }

  /** True once per issued ticket; a wrong ticket does not burn the outstanding one. */
  redeem(presented: string | null | undefined): boolean {
    const ticket = presented?.trim();
    if (!ticket || !this.current || this.current.ticket !== ticket) return false;
    const fresh = this.now() - this.current.issuedAt <= TICKET_TTL_MS;
    this.current = null;
    return fresh;
  }

  get outstanding(): boolean {
    return this.current !== null;
  }
}

/** A `biometric=1` string offered for signing without the ticket of a successful prompt. */
export class BiometricTicketError extends Error {
  readonly code = "biometric_ticket";
  constructor(message: string) {
    super(message);
    this.name = "BiometricTicketError";
  }
}

/** True when `message` is a canonical request string whose last line is `biometric=1`. */
export function needsBiometricTicket(message: Uint8Array): boolean {
  let start = message.length;
  while (start > 0 && message[start - 1] !== 0x0a) start--;
  return new TextDecoder().decode(message.subarray(start)) === "biometric=1";
}

export interface SignOptions {
  /** The assertion of the prompt that ran for this very request, when one did. */
  biometric?: BiometricAssertion | null;
}

/** Who signs requests. The shell implements it over the Android Keystore; tests use WebCrypto. */
export interface DeviceSigner {
  readonly kind: "webcrypto" | "shell";
  /** 32-byte Ed25519 public key, base64. Generated on first use. */
  publicKey(): Promise<string>;
  /**
   * Ed25519 signature over `message`, base64. A message whose last line is `biometric=1`
   * is signed only against the ticket of a successful prompt (`BiometricTicketError`
   * otherwise); the ticket is consumed.
   */
  sign(message: Uint8Array, options?: SignOptions): Promise<string>;
  /** Drop the key (the device forgets its identity; the desktop revokes the row). */
  forget(): Promise<void>;
  /** Web fallback only: where the simulated prompt draws the ticket `sign` redeems. The shell issues its own. */
  readonly tickets?: TicketIssuer;
}

const PKCS8_ED25519_PREFIX = fromHex("302e020100300506032b657004220420");

/**
 * Ed25519 through WebCrypto (Node 22, Chromium, Android WebView). The fallback when the app
 * runs outside the Tauri shell (tests, a browser); the Android shell signs with a key that
 * never leaves the Keystore-wrapped store (`ShellSigner`). Keys are not extractable unless a
 * test asks for it.
 */
export class WebCryptoSigner implements DeviceSigner {
  readonly kind = "webcrypto" as const;
  readonly tickets: TicketBook;
  private forgotten = false;

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly publicKeyB64: string,
    tickets?: TicketBook,
  ) {
    this.tickets = tickets ?? new TicketBook();
  }

  static async isSupported(): Promise<boolean> {
    try {
      await subtle().generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      return true;
    } catch {
      return false;
    }
  }

  static async generate(
    opts: { extractable?: boolean; tickets?: TicketBook } = {},
  ): Promise<WebCryptoSigner> {
    const keys = (await subtle().generateKey({ name: "Ed25519" }, opts.extractable ?? false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return new WebCryptoSigner(keys, await exportPublic(keys.publicKey), opts.tickets);
  }

  /** Deterministic signer from a 32-byte seed (test vectors); always extractable. */
  static async fromSeed(seed: Uint8Array): Promise<WebCryptoSigner> {
    if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    pkcs8.set(PKCS8_ED25519_PREFIX, 0);
    pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
    const privateKey = await subtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
      "sign",
    ]);
    const jwk = await subtle().exportKey("jwk", privateKey);
    const publicJwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    const publicKey = await subtle().importKey("jwk", publicJwk, { name: "Ed25519" }, true, [
      "verify",
    ]);
    return new WebCryptoSigner({ privateKey, publicKey }, await exportPublic(publicKey));
  }

  async publicKey(): Promise<string> {
    if (this.forgotten) throw new Error("device key forgotten");
    return this.publicKeyB64;
  }

  async sign(message: Uint8Array, options?: SignOptions): Promise<string> {
    if (this.forgotten) throw new Error("device key forgotten");
    if (needsBiometricTicket(message) && !this.tickets.redeem(options?.biometric?.ticket)) {
      throw new BiometricTicketError(
        "a biometric=1 signature needs the one-time ticket of a successful prompt",
      );
    }
    const sig = await subtle().sign("Ed25519", this.keys.privateKey, message as BufferSource);
    return toBase64(new Uint8Array(sig));
  }

  async forget(): Promise<void> {
    this.forgotten = true;
  }

  /** The seed, only for signers generated with `extractable: true` or from a seed. */
  async exportSeed(): Promise<Uint8Array> {
    const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", this.keys.privateKey));
    return pkcs8.slice(pkcs8.length - 32);
  }
}

async function exportPublic(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await subtle().exportKey("raw", key)));
}

/** Verify an Ed25519 signature with WebCrypto (used by tests and by the pairing self-check). */
export async function verifySignature(
  publicKeyB64: string,
  signatureB64: string,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      "raw",
      fromBase64(publicKeyB64) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await subtle().verify(
      "Ed25519",
      key,
      fromBase64(signatureB64) as BufferSource,
      message as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * The result of a successful platform biometric prompt. Only a `BiometricPort` creates one.
 * The client sets `biometric=1` in the signed string only when it holds one, and the signer
 * signs that string only against the prompt's one-time `ticket` (the shell's `TicketBook`
 * in Rust, `WebCryptoSigner.tickets` in the web fallback), so a screen that fabricates this
 * object still gets no `biometric=1` signature (spec R.7, ADR 0009, ADR 0032 item 3).
 */
export interface BiometricAssertion {
  readonly asserted: true;
  readonly at: string;
  /** "android-biometric", "simulated" (tests, web), ... */
  readonly method: string;
  /** The prompt's one-time ticket; the signer consumes it with the signature. */
  readonly ticket: string;
}

export interface BiometricPort {
  available(): Promise<boolean>;
  /** Null when the prompt was cancelled or failed; never throws for a refusal. */
  assert(reason: string): Promise<BiometricAssertion | null>;
}

export const noBiometric: BiometricPort = {
  available: async () => false,
  assert: async () => null,
};

/**
 * A visible stand-in for the web and for tests: `decide` is the simulated prompt (a dialog
 * that says it is simulated). It never pretends to be the platform prompt: `method` says so.
 * Its ticket comes from the signer's book (`WebCryptoSigner.tickets`), so the signer honours
 * the assertion exactly once, as the shell does with its own prompt.
 */
export function simulatedBiometric(
  decide: (reason: string) => Promise<boolean>,
  options: { tickets: TicketIssuer; now?: () => number },
): BiometricPort {
  const now = options.now ?? (() => Date.now());
  return {
    available: async () => true,
    assert: async (reason) =>
      (await decide(reason))
        ? {
            asserted: true,
            at: new Date(now()).toISOString(),
            method: "simulated",
            ticket: options.tickets.issue(),
          }
        : null,
  };
}
