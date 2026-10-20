import type { Clock } from "@forerunner/platform";
import { type JsonState, MemoryJsonState } from "../state-file.ts";
import { hashToken, newSessionToken } from "./crypto.ts";
import type { Scope } from "./scopes.ts";

/**
 * Scoped session tokens for paired devices. Only the SHA-256 of a token is stored; the raw
 * token is returned once at pairing and lives in the phone's OS keystore. Records persist
 * in the service's JSON state (ADR 0024: a future migration may move them to a table).
 */
export interface SessionTokenRecord {
  tokenHash: string;
  deviceId: string;
  humanId: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface TokenStateFile {
  version: 1;
  tokens: SessionTokenRecord[];
}

export const emptyTokenState = (): TokenStateFile => ({ version: 1, tokens: [] });

export function migrateTokenState(raw: unknown): TokenStateFile {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { version?: unknown }).version === 1 &&
    Array.isArray((raw as { tokens?: unknown }).tokens)
  ) {
    return raw as TokenStateFile;
  }
  return emptyTokenState();
}

export interface IssuedSessionToken {
  /** The raw token; shown once. */
  token: string;
  record: SessionTokenRecord;
}

export class SessionTokenStore {
  constructor(
    private readonly state: JsonState<TokenStateFile> = new MemoryJsonState(emptyTokenState()),
    private readonly clock: Clock,
    private readonly ttlMs: number,
  ) {}

  async issue(input: {
    deviceId: string;
    humanId: string;
    scopes: Scope[];
  }): Promise<IssuedSessionToken> {
    const token = newSessionToken();
    const now = this.clock.now();
    const record: SessionTokenRecord = {
      tokenHash: hashToken(token),
      deviceId: input.deviceId,
      humanId: input.humanId,
      scopes: [...input.scopes],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      lastUsedAt: null,
    };
    await this.state.update((s) => ({ ...s, tokens: [...this.prune(s.tokens), record] }));
    return { token, record };
  }

  /** Look a raw token up. Returns undefined for unknown or expired tokens. */
  lookup(token: string): SessionTokenRecord | undefined {
    const hash = hashToken(token);
    const rec = this.state.get().tokens.find((t) => t.tokenHash === hash);
    if (!rec) return undefined;
    if (rec.expiresAt <= this.clock.nowIso()) return undefined;
    return rec;
  }

  /** Record use (at most once per minute per token to keep writes rare). */
  async touch(record: SessionTokenRecord): Promise<void> {
    const now = this.clock.now();
    if (record.lastUsedAt && now - new Date(record.lastUsedAt).getTime() < 60_000) return;
    const iso = new Date(now).toISOString();
    record.lastUsedAt = iso;
    await this.state.update((s) => ({
      ...s,
      tokens: s.tokens.map((t) =>
        t.tokenHash === record.tokenHash ? { ...t, lastUsedAt: iso } : t,
      ),
    }));
  }

  /** Drop every token of a device (revocation). */
  async revokeDevice(deviceId: string): Promise<number> {
    let removed = 0;
    await this.state.update((s) => {
      const kept = s.tokens.filter((t) => t.deviceId !== deviceId);
      removed = s.tokens.length - kept.length;
      return { ...s, tokens: kept };
    });
    return removed;
  }

  forDevice(deviceId: string): SessionTokenRecord[] {
    return this.state.get().tokens.filter((t) => t.deviceId === deviceId);
  }

  private prune(tokens: SessionTokenRecord[]): SessionTokenRecord[] {
    const now = this.clock.nowIso();
    return tokens.filter((t) => t.expiresAt > now);
  }
}
