import { type Clock, errorMessage, log, systemClock } from "@forerunner/platform";
import {
  appliedVersions,
  type HumanRequestRow,
  MIGRATIONS,
  type StateStore,
} from "@forerunner/state";
import { type SchemaCompat, SyncGate, type SyncGateEvent } from "./compat.ts";

/**
 * The sync gate of spec M ("both apps must be on a compatible version before sync resumes")
 * wired to the shared state. The peer side of the comparison is the shared store itself: its
 * `schema_migrations` table holds the highest migration any install applied, so an install
 * whose code knows fewer migrations than the store carries (a peer updated and migrated the
 * shared database) is behind, and one whose code knows more has, on open, migrated the store
 * ahead of its peers (who then learn it the same way on their next read). This install's side
 * is the migration count its code ships (`MIGRATIONS.length`).
 *
 * `refresh` reads the store's version (startup, after an update's health check); `learn` takes
 * one the peer feed already read. Both go through `SyncGate.evaluate`, which pauses or resumes
 * only on a change. A pause is audited (`sync.paused`) and surfaced once as a non-blocking
 * inbox item that names what to do; the item is reused while it is open (across ticks and
 * daemon restarts) and withdrawn when sync resumes (`sync.resumed`). `assertCanSync` is the
 * code check in front of every sync call; a refusal is audited once per call site and pause.
 */
export const SYNC_GATE_AUTHOR = "sync-gate";
export const SYNC_PAUSED_KEY = "sync.paused";

export type SchemaSyncSource = "startup" | "peer_feed" | "update" | "tick" | "manual";

/** What the peer feed and the session runner need (structural, so neither imports this module). */
export interface SchemaSyncPort {
  /** A peer's schema version arrived; evaluate it. */
  learn(peerSchemaVersion: number, source: SchemaSyncSource): Promise<SchemaCompat>;
  /** Throws `unavailable` while sync is paused; `what` names the refused call for the audit row. */
  assertCanSync(what: string): Promise<void>;
}

export interface SchemaSyncStatus {
  paused: boolean;
  local: number;
  /** The shared store's schema version as last read; null before the first check. */
  peer: number | null;
  minSchema: number;
  reason: SchemaCompat["reason"] | null;
  action: SchemaCompat["action"];
  message: string;
  checkedAt: string | null;
  /** Sync calls refused since the current pause began. */
  refused: number;
}

export interface SchemaSyncOptions {
  store: Pick<StateStore, "db" | "auditLog" | "humanRequest">;
  clock?: Clock;
  /** The human whose inbox gets the pause item and whose audit rows these are. */
  humanId: string | null;
  /** The schema version this install's code ships; default `MIGRATIONS.length`. */
  localSchemaVersion?: number;
  /** The oldest schema the running release supports; default 1 (the first migration). */
  minSchema?: number;
}

export class SchemaSync implements SchemaSyncPort {
  readonly gate: SyncGate;
  readonly localSchemaVersion: number;
  readonly minSchema: number;
  private readonly store: SchemaSyncOptions["store"];
  private readonly clock: Clock;
  private readonly humanId: string | null;
  private readonly logger = log("sync-gate");
  private peer: number | null = null;
  private checkedAt: string | null = null;
  private refusedCount = 0;
  /** Call sites refused during the current pause (one audit row each). */
  private readonly refusedSites = new Set<string>();
  private settling: Promise<void> = Promise.resolve();

  constructor(opts: SchemaSyncOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.humanId = opts.humanId;
    this.localSchemaVersion = opts.localSchemaVersion ?? MIGRATIONS.length;
    this.minSchema = opts.minSchema ?? 1;
    this.gate = new SyncGate(this.clock);
  }

  get paused(): boolean {
    return this.gate.paused;
  }

  on(listener: (event: SyncGateEvent) => void): () => void {
    return this.gate.on(listener);
  }

  status(): SchemaSyncStatus {
    const reason = this.gate.pauseReason;
    return {
      paused: this.gate.paused,
      local: this.localSchemaVersion,
      peer: this.peer,
      minSchema: this.minSchema,
      reason: reason?.reason ?? null,
      action: reason?.action ?? "none",
      message: reason?.message ?? "schema compatible",
      checkedAt: this.checkedAt,
      refused: this.refusedCount,
    };
  }

  /** The shared store's applied schema version (what the state service reports as `compatibleSchemaVersion`). */
  async storeSchemaVersion(): Promise<number> {
    const applied = await appliedVersions(this.store.db);
    return applied.length ? Math.max(...applied) : 0;
  }

  /** Read the store's version and evaluate: startup, after an update, a manual check. */
  async refresh(source: SchemaSyncSource): Promise<SchemaCompat> {
    return this.learn(await this.storeSchemaVersion(), source);
  }

  async learn(peerSchemaVersion: number, source: SchemaSyncSource): Promise<SchemaCompat> {
    const before = this.gate.events.length;
    const compat = this.gate.evaluate(this.localSchemaVersion, peerSchemaVersion, this.minSchema);
    const changed = this.gate.events.length > before;
    this.peer = peerSchemaVersion;
    this.checkedAt = this.clock.nowIso();
    if (compat.compatible && changed) {
      this.refusedSites.clear();
      this.refusedCount = 0;
    }
    // Bookkeeping runs one at a time so two learns in flight never file two inbox items.
    this.settling = this.settling.then(() => this.settle(compat, source, changed));
    await this.settling;
    return compat;
  }

  async assertCanSync(what: string): Promise<void> {
    const reason = this.gate.pauseReason;
    if (!reason) return;
    this.refusedCount++;
    if (!this.refusedSites.has(what)) {
      this.refusedSites.add(what);
      await this.audit("sync.refused", false, { what }, reason, reason.reason);
    }
    this.gate.assertCanSync();
  }

  private async settle(compat: SchemaCompat, source: SchemaSyncSource, changed: boolean) {
    try {
      if (!compat.compatible) {
        if (!changed) return;
        this.logger.warn("sync paused", { source, ...summary(compat) });
        await this.audit("sync.paused", false, { source }, compat, compat.reason);
        await this.ensureRequest(compat);
        return;
      }
      if (changed) {
        this.logger.info("sync resumed", { source, ...summary(compat) });
        await this.audit("sync.resumed", true, { source }, compat, null);
      }
      // A resume, a start or a restart after the update: the pause item of the previous
      // process is closed; between checks of a compatible install nothing is queried.
      if (changed || source === "startup" || source === "update") await this.withdrawRequests();
    } catch (e) {
      this.logger.error("sync gate bookkeeping failed", { error: errorMessage(e) });
    }
  }

  private async audit(
    tool: string,
    allowed: boolean,
    input: Record<string, unknown>,
    compat: SchemaCompat,
    deniedReason: string | null,
  ): Promise<void> {
    await this.store.auditLog.append({
      tool,
      allowed,
      denied_reason: deniedReason,
      input_summary: JSON.stringify({ ...input, ...summary(compat) }),
      result_summary: compat.message,
      human_id: this.humanId,
      agent_id: null,
      session_id: null,
      run_id: null,
      cost_usd_micro: 0,
      token_id: null,
      occurred_at: this.clock.nowIso(),
    });
  }

  private async openRequests(): Promise<HumanRequestRow[]> {
    const rows = await this.store.humanRequest.list(
      { status: "open", author_agent: SYNC_GATE_AUTHOR },
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: 50 },
    );
    return rows.filter((r) => (r.change_card as { key?: unknown } | null)?.key === SYNC_PAUSED_KEY);
  }

  /** One open inbox item per pause: reused while open, so neither a tick nor a restart repeats it. */
  private async ensureRequest(compat: SchemaCompat): Promise<HumanRequestRow> {
    const open = (await this.openRequests())[0];
    if (open) return open;
    const step =
      compat.action === "update_local"
        ? "Update this install (Updates screen, or `fr update apply`); sync resumes on its own once both installs are on the same schema."
        : "Update the other install; sync resumes on its own once both installs are on the same schema.";
    return this.store.humanRequest.insert({
      human_id: this.humanId,
      kind: "info",
      why: `Sync with the shared state is paused: ${compat.message}. Until then no session starts and no approval, mirror run or peer feed is read from the shared state.`,
      steps: [step],
      options: [],
      blocking: false,
      risk: "medium",
      author_agent: SYNC_GATE_AUTHOR,
      change_card: { key: SYNC_PAUSED_KEY, ...summary(compat) },
    });
  }

  private async withdrawRequests(): Promise<void> {
    for (const r of await this.openRequests()) {
      await this.store.humanRequest.withdraw(r.id, r.version);
    }
  }
}

function summary(compat: SchemaCompat) {
  return {
    local: compat.local,
    peer: compat.peer,
    minSchema: compat.minSchema,
    reason: compat.reason,
    action: compat.action,
  };
}
