import type { Clock } from "@forerunner/platform";
import type { DeviceRow, StateStore } from "@forerunner/state";
import { ApiError } from "../errors.ts";
import { isValidPublicKey, newPairingCode, verifyPairingProof } from "./crypto.ts";
import { resolveScopes, type Scope } from "./scopes.ts";
import type { IssuedSessionToken, SessionTokenStore } from "./tokens.ts";

/**
 * Pairing (spec R: "scan a QR code from the desktop app; each device gets its own key").
 * The desktop (admin) starts a pairing: a one-time code valid for ten minutes, shown as a QR
 * with the service URL. The phone generates an Ed25519 key, posts the code, its public key
 * and a proof (signature over "pair:<code>") and receives a device id and a scoped session
 * token. Codes are single use and kept in memory only: a restart simply voids them.
 */
export interface PendingPairing {
  code: string;
  humanId: string;
  kind: "phone" | "web";
  scopes: Scope[];
  /** Suggested device name, overridable by the device. */
  name: string | undefined;
  createdAt: string;
  expiresAt: string;
}

export interface StartPairingInput {
  humanId: string;
  kind: "phone" | "web";
  scopes?: string[];
  name?: string;
  ttlMs?: number;
}

export interface CompletePairingInput {
  code: string;
  publicKey: string;
  proof: string;
  name?: string;
  platform: string;
  pushToken?: string;
}

export interface PairingResult {
  device: DeviceRow;
  session: IssuedSessionToken;
}

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;

export class PairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly store: StateStore,
    private readonly tokens: SessionTokenStore,
    private readonly clock: Clock,
  ) {}

  async start(input: StartPairingInput): Promise<PendingPairing> {
    const human = await this.store.human.get(input.humanId);
    if (!human) throw new ApiError(404, "not_found", `human ${input.humanId} not found`);
    const scopes = resolveScopes(input.kind, input.scopes);
    if (!scopes.ok) {
      throw new ApiError(400, "validation", "unknown or non-issuable scopes", {
        invalid: scopes.invalid,
      });
    }
    this.sweep();
    if (this.pending.size >= MAX_PENDING) {
      throw new ApiError(429, "rate_limited", "too many pending pairings");
    }
    const now = this.clock.now();
    let code = newPairingCode();
    while (this.pending.has(code)) code = newPairingCode();
    const p: PendingPairing = {
      code,
      humanId: human.id,
      kind: input.kind,
      scopes: scopes.scopes,
      name: input.name,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? PAIRING_CODE_TTL_MS)).toISOString(),
    };
    this.pending.set(code, p);
    return p;
  }

  async complete(input: CompletePairingInput): Promise<PairingResult> {
    this.sweep();
    const code = input.code.trim().toUpperCase();
    const p = this.pending.get(code);
    if (!p) throw new ApiError(400, "pairing_invalid", "unknown or expired pairing code");
    if (!isValidPublicKey(input.publicKey)) {
      throw new ApiError(400, "pairing_invalid", "publicKey must be a 32-byte base64 Ed25519 key");
    }
    if (!verifyPairingProof(input.publicKey, code, input.proof)) {
      throw new ApiError(400, "pairing_invalid", "proof does not verify against publicKey");
    }
    // Single use: taken before any write so a race cannot pair two devices with one code.
    this.pending.delete(code);
    const existing = await this.store.device.byPublicKey(input.publicKey);
    if (existing) {
      throw new ApiError(409, "pairing_invalid", "this public key is already paired", {
        deviceId: existing.id,
        revoked: existing.revoked,
      });
    }
    const device = await this.store.device.register({
      owner_human_id: p.humanId,
      name: (input.name ?? p.name ?? `${p.kind} device`).slice(0, 120),
      platform: input.platform.slice(0, 40),
      public_key: input.publicKey,
      kind: p.kind,
      // A blank token is no token: stored, it would be sent to and fail on every notice.
      push_token: input.pushToken?.trim() || null,
      author_human: p.humanId,
    });
    const session = await this.tokens.issue({
      deviceId: device.id,
      humanId: p.humanId,
      scopes: p.scopes,
    });
    return { device, session };
  }

  pendingCount(): number {
    this.sweep();
    return this.pending.size;
  }

  private sweep(): void {
    const now = this.clock.nowIso();
    for (const [code, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(code);
  }
}
