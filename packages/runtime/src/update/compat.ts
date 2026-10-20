import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";

/**
 * Spec M (last bullet): shared state schema changes use versioned migrations; both installs
 * must be on a compatible version before sync resumes. Schema versions are the
 * `schema_migrations` count of each install; migrations are forward-only, so two installs are
 * compatible only when they are at the same version and both are at least the minimum the
 * running release supports. The lower side has to update; nothing syncs until it does.
 */
export type SchemaCompatReason = "ok" | "local_below_min" | "peer_below_min" | "version_mismatch";
export type SchemaCompatAction = "none" | "update_local" | "update_peer";

export interface SchemaCompat {
  compatible: boolean;
  reason: SchemaCompatReason;
  action: SchemaCompatAction;
  local: number;
  peer: number;
  minSchema: number;
  message: string;
}

function assertVersion(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new ForerunnerError(
      "validation",
      `${name} schema version must be a non-negative integer`,
      {
        details: { [name]: v },
      },
    );
  }
}

export function isSchemaCompatible(
  localSchemaVersion: number,
  peerSchemaVersion: number,
  minSchema: number,
): SchemaCompat {
  assertVersion("local", localSchemaVersion);
  assertVersion("peer", peerSchemaVersion);
  assertVersion("minSchema", minSchema);
  const base = { local: localSchemaVersion, peer: peerSchemaVersion, minSchema };
  if (localSchemaVersion < minSchema) {
    return {
      ...base,
      compatible: false,
      reason: "local_below_min",
      action: "update_local",
      message: `this install is at schema ${localSchemaVersion}, the release needs ${minSchema}: update this install`,
    };
  }
  if (peerSchemaVersion < minSchema) {
    return {
      ...base,
      compatible: false,
      reason: "peer_below_min",
      action: "update_peer",
      message: `the peer is at schema ${peerSchemaVersion}, the release needs ${minSchema}: the peer must update`,
    };
  }
  if (localSchemaVersion !== peerSchemaVersion) {
    const localLower = localSchemaVersion < peerSchemaVersion;
    return {
      ...base,
      compatible: false,
      reason: "version_mismatch",
      action: localLower ? "update_local" : "update_peer",
      message: localLower
        ? `this install is at schema ${localSchemaVersion}, the peer at ${peerSchemaVersion}: update this install before sync resumes`
        : `the peer is at schema ${peerSchemaVersion}, this install at ${localSchemaVersion}: the peer must update before sync resumes`,
    };
  }
  return { ...base, compatible: true, reason: "ok", action: "none", message: "schema compatible" };
}

export interface SyncGateEvent {
  type: "sync_paused" | "sync_resumed";
  at: string;
  compat: SchemaCompat;
}

export type SyncGateListener = (event: SyncGateEvent) => void;

/**
 * The flag that pauses sync. `evaluate` is called whenever either side's schema version is
 * learned (startup, peer feed, after an update); it flips the flag and emits an event only on
 * a change. `assertCanSync` is the code check every sync call goes through.
 */
export class SyncGate {
  private pausedState: SchemaCompat | null = null;
  private readonly listeners = new Set<SyncGateListener>();
  readonly events: SyncGateEvent[] = [];

  constructor(private readonly clock: Clock = systemClock) {}

  get paused(): boolean {
    return this.pausedState !== null;
  }

  get pauseReason(): SchemaCompat | null {
    return this.pausedState;
  }

  on(listener: SyncGateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  evaluate(localSchemaVersion: number, peerSchemaVersion: number, minSchema: number): SchemaCompat {
    const compat = isSchemaCompatible(localSchemaVersion, peerSchemaVersion, minSchema);
    const wasPaused = this.paused;
    if (!compat.compatible) {
      this.pausedState = compat;
      if (!wasPaused) this.emit({ type: "sync_paused", at: this.clock.nowIso(), compat });
    } else {
      this.pausedState = null;
      if (wasPaused) this.emit({ type: "sync_resumed", at: this.clock.nowIso(), compat });
    }
    return compat;
  }

  /** Throws ForerunnerError("unavailable") while sync is paused. */
  assertCanSync(): void {
    if (this.pausedState) {
      throw new ForerunnerError("unavailable", `sync paused: ${this.pausedState.message}`, {
        details: { ...this.pausedState },
        retryable: true,
      });
    }
  }

  private emit(event: SyncGateEvent): void {
    this.events.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a failing listener never blocks the gate
      }
    }
  }
}
