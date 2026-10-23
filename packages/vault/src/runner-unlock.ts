/**
 * The device side of the cloud runner's vault unlock (spec S.12, ADR 0033, ADR 0068), with no
 * dependency at all: WebCrypto only, so the same file runs in the daemon (Node 22), in the
 * desktop and Android web views and in the tests. The runner side (filing the challenge,
 * unwrapping, the window watcher) is `services/cloud-runner/src/vault-unlock.ts`, which takes
 * its constants and the window rule from here so both ends cannot drift.
 *
 * The answer wraps the 32-byte vault key to the challenge's one-time runner key: a fresh
 * X25519 device key pair, the shared secret through HKDF-SHA256 (salt: the challenge nonce,
 * info: `forerunner-runner-unlock:v1:<challengeId>`), AES-256-GCM with the AAD
 * `<runnerId>:<challengeId>`. The device key pair and every derived byte live only for the call;
 * the caller zeroes the vault key it passed in.
 */

export const UNLOCK_CARD_KIND = "runner_vault_unlock";
export const UNLOCK_PROTOCOL_VERSION = 1;
export const UNLOCK_OPTIONS = ["unlock", "deny"] as const;
export const AUTO_UNLOCK_SETTING = "cloud_runner" as const;
/** Longest window a device may set through an answer (a week); longer values are refused. */
export const MAX_AUTO_UNLOCK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The window lengths the inbox cards offer, in hours (ADR 0068). */
export const AUTO_UNLOCK_WINDOW_HOURS = [1, 8, 24] as const;
export const UNLOCK_KEY_BYTES = 32;
export const UNLOCK_HKDF_INFO_PREFIX = "forerunner-runner-unlock:v1:";

/** The challenge a runner files as the `change_card` of its `credential` request. */
export interface UnlockChallengeCard {
  kind: typeof UNLOCK_CARD_KIND;
  version: typeof UNLOCK_PROTOCOL_VERSION;
  runnerId: string;
  challengeId: string;
  /** Raw 32-byte X25519 public key of the runner, base64. */
  runnerPublicKey: string;
  /** 32 random bytes, base64; the HKDF salt. */
  nonce: string;
  expiresAt: string;
}

/** What the device sends as the request's answer. Only ciphertext and public keys. */
export interface UnlockAnswer {
  challengeId: string;
  /** Raw 32-byte X25519 public key of the answering device, base64. */
  devicePublicKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
  /** Optional: the device sets (or clears with null) the human's auto-unlock window. */
  autoUnlockUntil?: string | null;
}

export interface WrapOptions {
  /** The device's idea of now (ms); an expired challenge is refused before any key is touched. */
  now?: number;
  /** Set the human's auto-unlock window with this answer (ISO-8601); null clears it. */
  autoUnlockUntil?: string | null;
}

export class RunnerUnlockError extends Error {
  readonly code: "not_a_challenge" | "expired" | "bad_key" | "bad_window";
  constructor(code: RunnerUnlockError["code"], message: string) {
    super(message);
    this.name = "RunnerUnlockError";
    this.code = code;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The challenge on a request's change card, or null when the card is something else. */
export function parseUnlockChallenge(card: unknown): UnlockChallengeCard | null {
  if (!isRecord(card)) return null;
  const { kind, version, runnerId, challengeId, runnerPublicKey, nonce, expiresAt } = card;
  if (kind !== UNLOCK_CARD_KIND || version !== UNLOCK_PROTOCOL_VERSION) return null;
  if (typeof runnerId !== "string" || runnerId.length === 0) return null;
  if (typeof challengeId !== "string" || challengeId.length < 8) return null;
  if (typeof runnerPublicKey !== "string" || !BASE64.test(runnerPublicKey)) return null;
  if (typeof nonce !== "string" || !BASE64.test(nonce)) return null;
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return null;
  return {
    kind,
    version,
    runnerId,
    challengeId,
    runnerPublicKey,
    nonce,
    expiresAt,
  };
}

function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
  return c.subtle;
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/**
 * Wrap the 32-byte vault key to the challenge's runner key. Pure: no store, no network; the
 * caller sends the result as the request's answer. The device key pair is fresh per answer and
 * not extractable beyond its public half.
 */
export async function wrapVaultKey(
  card: unknown,
  vaultKey: Uint8Array,
  opts: WrapOptions = {},
): Promise<UnlockAnswer> {
  const c = parseUnlockChallenge(card);
  if (!c) throw new RunnerUnlockError("not_a_challenge", "not a runner unlock challenge");
  if (vaultKey.length !== UNLOCK_KEY_BYTES) {
    throw new RunnerUnlockError("bad_key", `vault key must be ${UNLOCK_KEY_BYTES} bytes`);
  }
  if (opts.now !== undefined && Date.parse(c.expiresAt) <= opts.now) {
    throw new RunnerUnlockError("expired", "the unlock challenge has expired");
  }
  const runnerRaw = fromBase64(c.runnerPublicKey);
  if (runnerRaw.length !== 32) {
    throw new RunnerUnlockError("not_a_challenge", "runner public key must be 32 bytes");
  }
  const s = subtle();
  const runnerKey = await s.importKey("raw", runnerRaw, { name: "X25519" }, false, []);
  const device = (await s.generateKey({ name: "X25519" }, false, ["deriveBits"])) as {
    publicKey: Parameters<typeof s.exportKey>[1];
    privateKey: Parameters<typeof s.exportKey>[1];
  };
  const shared = new Uint8Array(
    await s.deriveBits({ name: "X25519", public: runnerKey }, device.privateKey, 256),
  );
  let wrap: Uint8Array<ArrayBuffer> | null = null;
  const plain = new Uint8Array(vaultKey);
  try {
    const ikm = await s.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    wrap = new Uint8Array(
      await s.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: fromBase64(c.nonce),
          info: utf8(`${UNLOCK_HKDF_INFO_PREFIX}${c.challengeId}`),
        },
        ikm,
        256,
      ),
    );
    const aes = await s.importKey("raw", wrap, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
      await s.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: utf8(`${c.runnerId}:${c.challengeId}`),
          tagLength: 128,
        },
        aes,
        plain,
      ),
    );
    const devicePublic = new Uint8Array(await s.exportKey("raw", device.publicKey));
    return {
      challengeId: c.challengeId,
      devicePublicKey: toBase64(devicePublic),
      iv: toBase64(iv),
      ciphertext: toBase64(sealed.subarray(0, sealed.length - 16)),
      tag: toBase64(sealed.subarray(sealed.length - 16)),
      ...(opts.autoUnlockUntil !== undefined ? { autoUnlockUntil: opts.autoUnlockUntil } : {}),
    };
  } finally {
    shared.fill(0);
    wrap?.fill(0);
    plain.fill(0);
  }
}

// ---------------------------------------------------------------------------------------------
// The auto-unlock window

/** The window end from a settings object shaped `{ cloud_runner: { auto_unlock_until } }`, as epoch ms. */
export function autoUnlockUntilOf(settings: unknown): number | null {
  if (!isRecord(settings)) return null;
  const setting = settings[AUTO_UNLOCK_SETTING];
  if (!isRecord(setting)) return null;
  const until = setting.auto_unlock_until;
  if (typeof until !== "string") return null;
  const ms = Date.parse(until);
  return Number.isFinite(ms) ? ms : null;
}

/** Device-side rule: answer without asking for a choice while the window is open. */
export function shouldAutoAnswer(settings: unknown, now: number): boolean {
  const until = autoUnlockUntilOf(settings);
  return until !== null && until > now;
}

/** The ISO end of a window of `hours` from `now`; refused beyond the runner's maximum. */
export function autoUnlockWindowEnd(hours: number, now: number): string {
  const ms = hours * 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_AUTO_UNLOCK_WINDOW_MS) {
    throw new RunnerUnlockError("bad_window", "the auto-unlock window must be up to a week");
  }
  return new Date(now + ms).toISOString();
}

/**
 * The vault entry (daemon) under which this device keeps a runner's vault key, base64 of the 32
 * bytes. The runner id is folded into the secret-name alphabet.
 */
export function runnerKeySecretName(runnerId: string): string {
  const id = runnerId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 100);
  return `cloud_runner_vault_key:${id || "default"}`;
}

/** The Android secure-store key (`[A-Za-z0-9_-]` only) for a runner's vault key. */
export function runnerKeySecureStoreKey(runnerId: string): string {
  const id = runnerId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
  return `runner-vault-key-${id || "default"}`;
}

/** Decode a stored key (base64 of 32 bytes); null for anything else. The caller zeroes it. */
export function decodeStoredKey(value: string | null): Uint8Array<ArrayBuffer> | null {
  if (!value) return null;
  const text = value.trim();
  if (!BASE64.test(text)) return null;
  const bytes = fromBase64(text);
  if (bytes.length !== UNLOCK_KEY_BYTES) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}
