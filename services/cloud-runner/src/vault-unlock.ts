import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { DEVICE_KEY_BYTES } from "@forerunner/vault";
import { z } from "zod";

/**
 * Vault unlock for the cloud runner (spec "Secrets vault": encrypted blob, key held by the
 * human's device; the human approves the unlock per runner start or sets an auto-unlock
 * window). ADR 0033 records the protocol.
 *
 * The runner holds the encrypted vault file but not its key. To unlock it files a
 * `human_request` of kind "credential" that carries a one-time, time-limited challenge: a fresh
 * X25519 public key, a nonce and an expiry. The human's device answers with the vault key
 * wrapped to that public key (X25519 + HKDF-SHA256 + AES-256-GCM). The runner unwraps the key
 * in memory, hands it to the vault and discards its private key. A wrong key, a tampered
 * answer, an answer to another challenge or an answer after the expiry is refused with an audit
 * row and a fresh challenge.
 *
 * The key never reaches a log line, the store or a model: only ciphertext and public keys are
 * stored, and `redactKey` scrubs the key's encodings out of error messages as a last line of
 * defence. Tests assert all of that.
 *
 * Auto-unlock window: `human.notify_prefs.cloud_runner.auto_unlock_until` (ISO-8601). While it
 * is in the future the runner keeps a copy of the key and re-unlocks from it (after an idle
 * lock) without asking; when the window ends the copy is zeroed, the vault is locked and the
 * next unlock asks again. With `policy: "ask"` the window is ignored and every unlock asks.
 */

export const UNLOCK_CARD_KIND = "runner_vault_unlock";
export const UNLOCK_PROTOCOL_VERSION = 1;
export const UNLOCK_OPTIONS = ["unlock", "deny"] as const;
export const AUTO_UNLOCK_SETTING = "cloud_runner" as const;
/** Longest window a device may set through an answer (a week); longer values are refused. */
export const MAX_AUTO_UNLOCK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const UNLOCK_AUDIT_TOOLS = {
  requested: "runner.unlock_requested",
  granted: "runner.unlock_granted",
  refused: "runner.unlock_refused",
  locked: "runner.vault_locked",
} as const;

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const HKDF_INFO_PREFIX = "forerunner-runner-unlock:v1:";

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");

export const UnlockChallengeCardSchema = z.object({
  kind: z.literal(UNLOCK_CARD_KIND),
  version: z.literal(UNLOCK_PROTOCOL_VERSION),
  runnerId: z.string().min(1),
  challengeId: z.string().min(8),
  /** Raw 32-byte X25519 public key of the runner, base64. */
  runnerPublicKey: base64,
  /** 32 random bytes, base64; the HKDF salt. */
  nonce: base64,
  expiresAt: z.string().min(1),
});
export type UnlockChallengeCard = z.infer<typeof UnlockChallengeCardSchema>;

export const UnlockAnswerSchema = z.object({
  challengeId: z.string().min(8),
  /** Raw 32-byte X25519 public key of the answering device, base64. */
  devicePublicKey: base64,
  iv: base64,
  ciphertext: base64,
  tag: base64,
  /** Optional: the device sets (or clears with null) the human's auto-unlock window. */
  autoUnlockUntil: z.string().nullable().optional(),
});
export type UnlockAnswer = z.infer<typeof UnlockAnswerSchema>;

export type UnlockRefusal =
  | "denied"
  | "malformed"
  | "stale_challenge"
  | "expired"
  | "bad_device_key"
  | "unwrap_failed"
  | "wrong_key"
  | "bad_window";

export interface UnlockOutcome {
  via: "already" | "cached" | "human";
  requestId?: string;
  unlockedUntil: string | null;
}

export interface UnlockState {
  locked: boolean;
  /** When the current unlock ends (the auto-unlock window), or null for the process lifetime. */
  unlockedUntil: string | null;
  cachedKey: boolean;
  pendingRequestId: string | null;
  attempts: number;
  refusals: number;
}

/** What the runner needs from the vault: the `EncryptedFileVault` shape. */
export interface LockableVault {
  readonly locked: boolean;
  unlock(key: Uint8Array): Promise<void>;
  lock(): void;
}

export interface RunnerVaultUnlockDeps {
  vault: LockableVault;
  /** A getter so the runner can swap the store it uses after the runtime is composed. */
  store: () => Pick<StateStore, "humanRequest" | "human" | "auditLog">;
  clock: Clock;
  humanId: string;
  runnerId: string;
  /** Agent recorded as the author of the request (the agent the runner serves), if known. */
  agentId?: string | null;
  policy?: "ask" | "window";
  challengeTtlMs?: number;
  pollMs?: number;
  /** Total time to wait for a usable answer before giving up. */
  timeoutMs?: number;
  /** Refusals tolerated before giving up (a new challenge follows each refusal). */
  maxAttempts?: number;
  /** Window check cadence once started. */
  tickMs?: number;
  /** Called after the window ended and the key was forgotten (the runner restarts when idle). */
  onForget?: (reason: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Key encodings and the shared-secret derivation (both sides use these)

export function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(
    key.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length),
  );
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new ForerunnerError("validation", "X25519 public key must be 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function wrappingKey(
  privateKey: KeyObject,
  peerPublicRaw: Buffer,
  nonce: Buffer,
  challengeId: string,
): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublicRaw) });
  try {
    return Buffer.from(hkdfSync("sha256", shared, nonce, `${HKDF_INFO_PREFIX}${challengeId}`, 32));
  } finally {
    shared.fill(0);
  }
}

function aad(runnerId: string, challengeId: string): Buffer {
  return Buffer.from(`${runnerId}:${challengeId}`, "utf8");
}

/** Every encoding of the key a log line or an error could carry; scrubbed before anything is recorded. */
export function keyEncodings(key: Uint8Array): string[] {
  const b = Buffer.from(key);
  return [b.toString("base64"), b.toString("base64url"), b.toString("hex"), [...b].join(",")];
}

export function redactKey(text: string, key: Uint8Array | null): string {
  if (!key) return text;
  let out = text;
  for (const enc of keyEncodings(key)) {
    if (enc.length >= 16 && out.includes(enc)) out = out.split(enc).join("[REDACTED]");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Device side: answer a challenge (the desktop app, the phone, and the tests use this)

export interface AnswerOptions {
  /** The device's idea of now (ms); rejects an expired challenge up front. */
  now?: number;
  /** Set the human's auto-unlock window with this answer (ISO-8601); null clears it. */
  autoUnlockUntil?: string | null;
}

/**
 * Wrap the 32-byte vault key to the challenge's runner key. Pure: no store, no network. The
 * caller sends the result as the `human_request` answer. The device key pair is fresh per
 * answer and discarded.
 */
export function answerUnlockChallenge(
  card: unknown,
  vaultKey: Uint8Array,
  opts: AnswerOptions = {},
): UnlockAnswer {
  const parsed = UnlockChallengeCardSchema.safeParse(card);
  if (!parsed.success) {
    throw new ForerunnerError("validation", "not a runner unlock challenge", {
      details: { issues: parsed.error.issues.map((i) => i.path.join(".")) },
    });
  }
  if (vaultKey.length !== DEVICE_KEY_BYTES) {
    throw new ForerunnerError("validation", `vault key must be ${DEVICE_KEY_BYTES} bytes`);
  }
  const c = parsed.data;
  if (opts.now !== undefined && Date.parse(c.expiresAt) <= opts.now) {
    throw new ForerunnerError("validation", "the unlock challenge has expired", {
      details: { challengeId: c.challengeId, expiresAt: c.expiresAt },
    });
  }
  const device = generateKeyPairSync("x25519");
  const nonce = Buffer.from(c.nonce, "base64");
  const wrap = wrappingKey(
    device.privateKey,
    Buffer.from(c.runnerPublicKey, "base64"),
    nonce,
    c.challengeId,
  );
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", wrap, iv);
    cipher.setAAD(aad(c.runnerId, c.challengeId));
    const ct = Buffer.concat([cipher.update(Buffer.from(vaultKey)), cipher.final()]);
    return {
      challengeId: c.challengeId,
      devicePublicKey: rawPublicKey(device.publicKey).toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ct.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ...(opts.autoUnlockUntil !== undefined ? { autoUnlockUntil: opts.autoUnlockUntil } : {}),
    };
  } finally {
    wrap.fill(0);
  }
}

/** The human's auto-unlock window from their settings JSON, as epoch ms, or null. */
export function autoUnlockUntilOf(notifyPrefs: JsonValue | null | undefined): number | null {
  if (!notifyPrefs || typeof notifyPrefs !== "object" || Array.isArray(notifyPrefs)) return null;
  const setting = (notifyPrefs as JsonObject)[AUTO_UNLOCK_SETTING];
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return null;
  const until = (setting as JsonObject).auto_unlock_until;
  if (typeof until !== "string") return null;
  const ms = Date.parse(until);
  return Number.isFinite(ms) ? ms : null;
}

/** Device-side rule: answer without prompting while the human's window is open. */
export function shouldAutoAnswer(notifyPrefs: JsonValue | null | undefined, now: number): boolean {
  const until = autoUnlockUntilOf(notifyPrefs);
  return until !== null && until > now;
}

// ---------------------------------------------------------------------------------------------
// Runner side

interface Challenge {
  id: string;
  privateKey: KeyObject;
  publicRaw: Buffer;
  nonce: Buffer;
  expiresAt: number;
  requestId: string;
}

export class RunnerVaultUnlock {
  private readonly logger = log("cloud-runner:unlock");
  private readonly policy: "ask" | "window";
  private readonly challengeTtlMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly tickMs: number;
  private cachedKey: Buffer | null = null;
  private unlockedUntil: number | null = null;
  private pending: Challenge | null = null;
  private cancelTick: (() => void) | null = null;
  private inFlight: Promise<UnlockOutcome> | null = null;
  private attempts = 0;
  private refusals = 0;

  constructor(private readonly deps: RunnerVaultUnlockDeps) {
    this.policy = deps.policy ?? "window";
    this.challengeTtlMs = deps.challengeTtlMs ?? 10 * 60 * 1000;
    this.pollMs = Math.max(100, deps.pollMs ?? 2_000);
    this.timeoutMs = deps.timeoutMs ?? 24 * 60 * 60 * 1000;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
    this.tickMs = Math.max(1_000, deps.tickMs ?? 30_000);
  }

  get state(): UnlockState {
    return {
      locked: this.deps.vault.locked,
      unlockedUntil:
        this.unlockedUntil === null ? null : new Date(this.unlockedUntil).toISOString(),
      cachedKey: this.cachedKey !== null,
      pendingRequestId: this.pending?.requestId ?? null,
      attempts: this.attempts,
      refusals: this.refusals,
    };
  }

  /** The human's window end (ms) when the policy honours windows and one is open; else null. */
  async windowEnd(now: number = this.deps.clock.now()): Promise<number | null> {
    if (this.policy !== "window") return null;
    const human = await this.deps.store().human.get(this.deps.humanId);
    const until = autoUnlockUntilOf(human?.notify_prefs);
    return until !== null && until > now ? until : null;
  }

  /**
   * Make the vault usable: already unlocked, re-unlocked from the cached key inside the window,
   * or unlocked by the human through a challenge. Concurrent callers share one flow.
   */
  ensureUnlocked(reason: string): Promise<UnlockOutcome> {
    if (!this.deps.vault.locked) {
      return Promise.resolve({
        via: "already",
        unlockedUntil: this.state.unlockedUntil,
      });
    }
    if (!this.inFlight) {
      this.inFlight = this.unlockFlow(reason).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Lock the vault now; the cached key (if any, inside the window) survives for a re-unlock. */
  lock(reason: string): void {
    if (!this.deps.vault.locked) {
      this.deps.vault.lock();
      this.logger.info("vault locked", { reason });
    }
  }

  /** Forget the key: zero the cache, lock the vault, drop the window. */
  forget(reason: string): void {
    const had = this.cachedKey !== null || !this.deps.vault.locked;
    this.cachedKey?.fill(0);
    this.cachedKey = null;
    this.unlockedUntil = null;
    this.deps.vault.lock();
    if (had) {
      this.logger.info("vault key forgotten", { reason });
      void this.audit(UNLOCK_AUDIT_TOOLS.locked, true, { reason }, null);
      this.deps.onForget?.(reason);
    }
  }

  /** Start the window watcher: when the window ends the key is forgotten. */
  start(): void {
    if (this.cancelTick) return;
    const tick = async () => {
      try {
        await this.checkWindow();
      } catch (e) {
        this.logger.warn("window check failed", { error: errorMessage(e) });
      }
      this.cancelTick = this.deps.clock.setTimeout(tick, this.tickMs);
    };
    this.cancelTick = this.deps.clock.setTimeout(tick, this.tickMs);
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
  }

  /** One window check (the tick; exposed for tests). */
  async checkWindow(now: number = this.deps.clock.now()): Promise<void> {
    if (this.unlockedUntil === null) {
      // Unlocked for the process lifetime, but a human may have opened a window since: nothing
      // to do until the next unlock. A cached key without a window cannot exist.
      return;
    }
    const end = await this.windowEnd(now);
    // The window the unlock relied on ended, or the human shortened or cleared it.
    if (end === null || now >= this.unlockedUntil || end < this.unlockedUntil) {
      if (end !== null && end >= now && end < this.unlockedUntil) {
        this.unlockedUntil = end;
        return;
      }
      this.forget("auto-unlock window ended");
    }
  }

  // -- the flow ------------------------------------------------------------------------------

  private async unlockFlow(reason: string): Promise<UnlockOutcome> {
    const { clock } = this.deps;
    const windowEnd = await this.windowEnd();
    if (this.cachedKey && windowEnd !== null) {
      await this.deps.vault.unlock(this.cachedKey);
      this.unlockedUntil = windowEnd;
      await this.audit(UNLOCK_AUDIT_TOOLS.granted, true, { via: "cached", reason }, null);
      this.logger.info("vault unlocked from the cached key inside the auto-unlock window", {
        reason,
        until: new Date(windowEnd).toISOString(),
      });
      return { via: "cached", unlockedUntil: new Date(windowEnd).toISOString() };
    }
    // A cached key outside a window is forgotten before anything else happens.
    if (this.cachedKey) this.forget("no auto-unlock window");

    const deadline = clock.now() + this.timeoutMs;
    let attempt = 0;
    while (attempt < this.maxAttempts) {
      attempt++;
      this.attempts++;
      const challenge = await this.fileChallenge(reason);
      const result = await this.awaitAnswer(challenge, deadline);
      if (result.ok) {
        const until = await this.applyWindow(result.autoUnlockUntil);
        const outcome: UnlockOutcome = {
          via: "human",
          requestId: challenge.requestId,
          unlockedUntil: until === null ? null : new Date(until).toISOString(),
        };
        await this.audit(
          UNLOCK_AUDIT_TOOLS.granted,
          true,
          {
            via: "human",
            requestId: challenge.requestId,
            reason,
            unlockedUntil: outcome.unlockedUntil,
          },
          null,
        );
        this.logger.info("vault unlocked by the human's device", {
          requestId: challenge.requestId,
          unlockedUntil: outcome.unlockedUntil,
        });
        return outcome;
      }
      this.refusals++;
      await this.audit(
        UNLOCK_AUDIT_TOOLS.refused,
        false,
        { requestId: challenge.requestId, refusal: result.refusal, detail: result.detail ?? null },
        result.refusal,
      );
      this.logger.warn("unlock answer refused", {
        requestId: challenge.requestId,
        refusal: result.refusal,
        detail: result.detail ?? null,
      });
      if (result.refusal === "denied") {
        throw new ForerunnerError("unavailable", "the human denied the vault unlock", {
          details: { requestId: challenge.requestId },
        });
      }
      if (clock.now() >= deadline) break;
    }
    throw new ForerunnerError("unavailable", "vault unlock not granted", {
      details: { attempts: attempt, timeoutMs: this.timeoutMs },
    });
  }

  private async fileChallenge(reason: string): Promise<Challenge> {
    const { clock } = this.deps;
    const pair = generateKeyPairSync("x25519");
    const id = randomUUID();
    const nonce = randomBytes(32);
    const expiresAt = clock.now() + this.challengeTtlMs;
    const card: UnlockChallengeCard = {
      kind: UNLOCK_CARD_KIND,
      version: UNLOCK_PROTOCOL_VERSION,
      runnerId: this.deps.runnerId,
      challengeId: id,
      runnerPublicKey: rawPublicKey(pair.publicKey).toString("base64"),
      nonce: nonce.toString("base64"),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const row = await this.deps.store().humanRequest.insert({
      human_id: this.deps.humanId,
      project_id: null,
      session_id: null,
      task_id: null,
      kind: "credential",
      why: `Cloud runner "${this.deps.runnerId}" needs the vault key to start (${reason}). The key is wrapped to a one-time runner key and never stored.`,
      steps: [
        "Confirm on a paired device (biometric on the phone).",
        `The challenge expires at ${card.expiresAt}.`,
        "Optionally set an auto-unlock window so the runner can re-unlock without asking until then.",
      ],
      options: [...UNLOCK_OPTIONS],
      blocking: true,
      risk: "high",
      change_card: card as unknown as JsonObject,
      author_agent: this.deps.agentId ?? null,
    });
    const challenge: Challenge = {
      id,
      privateKey: pair.privateKey,
      publicRaw: rawPublicKey(pair.publicKey),
      nonce,
      expiresAt,
      requestId: row.id,
    };
    this.pending = challenge;
    await this.audit(
      UNLOCK_AUDIT_TOOLS.requested,
      true,
      { requestId: row.id, challengeId: id, expiresAt: card.expiresAt, reason },
      null,
    );
    this.logger.info("vault unlock requested", {
      requestId: row.id,
      challengeId: id,
      expiresAt: card.expiresAt,
    });
    return challenge;
  }

  private async awaitAnswer(
    challenge: Challenge,
    deadline: number,
  ): Promise<
    | { ok: true; autoUnlockUntil: string | null | undefined }
    | { ok: false; refusal: UnlockRefusal; detail?: string }
  > {
    const { clock } = this.deps;
    try {
      for (;;) {
        const row = await this.deps.store().humanRequest.get(challenge.requestId);
        if (!row) return { ok: false, refusal: "malformed", detail: "request vanished" };
        if (row.status === "answered") return this.verifyAnswer(challenge, row);
        if (row.status !== "open") return { ok: false, refusal: "denied", detail: row.status };
        const now = clock.now();
        if (now >= challenge.expiresAt) {
          await this.withdraw(row);
          return { ok: false, refusal: "expired" };
        }
        if (now >= deadline) {
          await this.withdraw(row);
          throw new ForerunnerError("unavailable", "timed out waiting for the vault unlock", {
            details: { requestId: challenge.requestId },
          });
        }
        await clock.sleep(Math.min(this.pollMs, challenge.expiresAt - now, deadline - now));
      }
    } finally {
      this.pending = null;
    }
  }

  private async withdraw(row: HumanRequestRow): Promise<void> {
    try {
      const current = await this.deps.store().humanRequest.mustGet(row.id);
      if (current.status === "open")
        await this.deps.store().humanRequest.withdraw(current.id, current.version);
    } catch (e) {
      this.logger.warn("could not withdraw the unlock request", { error: errorMessage(e) });
    }
  }

  /** Unwrap and verify; the plaintext key lives in a Buffer that is zeroed before returning. */
  private async verifyAnswer(
    challenge: Challenge,
    row: HumanRequestRow,
  ): Promise<
    | { ok: true; autoUnlockUntil: string | null | undefined }
    | { ok: false; refusal: UnlockRefusal; detail?: string }
  > {
    const { clock } = this.deps;
    const raw = row.answer;
    if (typeof raw === "string") {
      // A plain option from the inbox: "deny" ends the flow; anything else carries no key.
      if (raw.trim().toLowerCase() === "deny") return { ok: false, refusal: "denied" };
      return { ok: false, refusal: "malformed", detail: raw.slice(0, 40) };
    }
    const parsed = UnlockAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        refusal: "malformed",
        detail: parsed.error.issues.map((i) => i.path.join(".")).join(","),
      };
    }
    const answer = parsed.data;
    if (answer.challengeId !== challenge.id) return { ok: false, refusal: "stale_challenge" };
    if (clock.now() >= challenge.expiresAt) return { ok: false, refusal: "expired" };
    const devicePublic = Buffer.from(answer.devicePublicKey, "base64");
    if (devicePublic.length !== 32) return { ok: false, refusal: "bad_device_key" };
    let key: Buffer | null = null;
    let wrap: Buffer | null = null;
    try {
      wrap = wrappingKey(challenge.privateKey, devicePublic, challenge.nonce, challenge.id);
      const decipher = createDecipheriv("aes-256-gcm", wrap, Buffer.from(answer.iv, "base64"));
      decipher.setAAD(aad(this.deps.runnerId, challenge.id));
      decipher.setAuthTag(Buffer.from(answer.tag, "base64"));
      key = Buffer.concat([
        decipher.update(Buffer.from(answer.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      return { ok: false, refusal: "unwrap_failed" };
    } finally {
      wrap?.fill(0);
    }
    try {
      if (key.length !== DEVICE_KEY_BYTES)
        return { ok: false, refusal: "wrong_key", detail: "size" };
      try {
        await this.deps.vault.unlock(key);
      } catch (e) {
        const msg = redactKey(errorMessage(e), key);
        return { ok: false, refusal: "wrong_key", detail: msg.slice(0, 80) };
      }
      // Keep a copy only while an auto-unlock window is open (decided by applyWindow).
      this.cachedKey?.fill(0);
      this.cachedKey = Buffer.from(key);
      return { ok: true, autoUnlockUntil: answer.autoUnlockUntil };
    } finally {
      key.fill(0);
    }
  }

  /**
   * Apply the window after a human unlock: the answer may set or clear the human's setting;
   * then, with policy "window", an open window keeps the cached key until it ends. Without a
   * window the cached key is zeroed at once and the unlock lasts for the process lifetime.
   */
  private async applyWindow(requested: string | null | undefined): Promise<number | null> {
    const now = this.deps.clock.now();
    if (requested !== undefined) {
      const human = await this.deps.store().human.get(this.deps.humanId);
      if (human) {
        const prefs = { ...(human.notify_prefs as JsonObject) };
        const current = (prefs[AUTO_UNLOCK_SETTING] ?? {}) as JsonObject;
        if (requested === null) {
          prefs[AUTO_UNLOCK_SETTING] = { ...current, auto_unlock_until: null };
        } else {
          const ms = Date.parse(requested);
          if (Number.isFinite(ms) && ms > now && ms - now <= MAX_AUTO_UNLOCK_WINDOW_MS) {
            prefs[AUTO_UNLOCK_SETTING] = {
              ...current,
              auto_unlock_until: new Date(ms).toISOString(),
              set_by_runner: this.deps.runnerId,
            };
          } else {
            await this.audit(
              UNLOCK_AUDIT_TOOLS.refused,
              false,
              { refusal: "bad_window", requested },
              "bad_window",
            );
            this.logger.warn("ignored an invalid auto-unlock window", { requested });
          }
        }
        await this.deps.store().human.patch(human.id, { notify_prefs: prefs });
      }
    }
    const end = await this.windowEnd(now);
    if (end === null) {
      this.cachedKey?.fill(0);
      this.cachedKey = null;
      this.unlockedUntil = null;
      return null;
    }
    this.unlockedUntil = end;
    return end;
  }

  private async audit(
    tool: string,
    allowed: boolean,
    result: JsonObject,
    deniedReason: string | null,
  ): Promise<void> {
    try {
      await this.deps.store().auditLog.append({
        tool,
        allowed,
        denied_reason: deniedReason,
        agent_id: this.deps.agentId ?? null,
        human_id: this.deps.humanId,
        input_summary: JSON.stringify({ runnerId: this.deps.runnerId }),
        result_summary: JSON.stringify(result),
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
        author_agent: this.deps.agentId ?? null,
      });
    } catch (e) {
      this.logger.warn("could not write the unlock audit row", { error: errorMessage(e) });
    }
  }
}

/** Constant-time equality for tests and callers comparing key material. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
