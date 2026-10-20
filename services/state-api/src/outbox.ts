import type { Clock } from "@forerunner/platform";
import type { Principal } from "./auth/principal.ts";
import { type JsonState, MemoryJsonState } from "./state-file.ts";

/**
 * Outbox contract (spec R.3 "works offline and queues actions until it reconnects"; phase 2
 * gate "either install can be offline for 48 simulated hours"). The client side (phone,
 * approvals web, a PC in paired mode that cannot reach Postgres) keeps actions in an
 * `Outbox` and flushes them with `flushOutbox` when it is back online. The service side is
 * `POST /sync/outbox`: a batch of actions with client-generated ids, applied in order; a
 * client id seen before is acknowledged as a duplicate without being applied again, so a
 * retry after a lost response never double-posts. The client implementations (SQLite outbox
 * on the PC, keystore-backed on the phone) live in the packages that own those clients; this
 * file is the shared interface plus the in-memory reference and the service's idempotency
 * store.
 */
export const OUTBOX_ACTION_KINDS = [
  "message.send",
  "message.receipt",
  "request.answer",
  "queue.enqueue",
  "remote.enqueue",
  "task.transition",
  "decision.record",
] as const;
export type OutboxActionKind = (typeof OUTBOX_ACTION_KINDS)[number];

export interface OutboxAction {
  /** Client-generated unique id (UUID); the idempotency key. */
  clientId: string;
  kind: OutboxActionKind;
  /** Route body of the equivalent direct call plus the path ids (`id`, `projectId`). */
  payload: Record<string, unknown>;
  createdAt: string;
}

export type OutboxStatus = "queued" | "sent" | "failed";

export interface OutboxItem extends OutboxAction {
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  result: unknown;
}

export interface Outbox {
  enqueue(action: OutboxAction): Promise<OutboxItem>;
  pending(): Promise<OutboxItem[]>;
  markSent(clientId: string, result: unknown): Promise<void>;
  /** `permanent` drops the item from the queue (rejected by the service: 4xx). */
  markFailed(clientId: string, error: string, permanent: boolean): Promise<void>;
  size(): Promise<number>;
}

export class MemoryOutbox implements Outbox {
  private readonly items = new Map<string, OutboxItem>();

  async enqueue(action: OutboxAction): Promise<OutboxItem> {
    const existing = this.items.get(action.clientId);
    if (existing) return existing;
    const item: OutboxItem = {
      ...action,
      status: "queued",
      attempts: 0,
      lastError: null,
      result: null,
    };
    this.items.set(action.clientId, item);
    return item;
  }

  async pending(): Promise<OutboxItem[]> {
    return [...this.items.values()].filter((i) => i.status === "queued");
  }

  async markSent(clientId: string, result: unknown): Promise<void> {
    const item = this.items.get(clientId);
    if (item) {
      item.status = "sent";
      item.result = result;
    }
  }

  async markFailed(clientId: string, error: string, permanent: boolean): Promise<void> {
    const item = this.items.get(clientId);
    if (!item) return;
    item.attempts += 1;
    item.lastError = error;
    if (permanent) item.status = "failed";
  }

  async size(): Promise<number> {
    return (await this.pending()).length;
  }

  all(): OutboxItem[] {
    return [...this.items.values()];
  }
}

/** What the service answers per action. */
export interface OutboxResult {
  clientId: string;
  status: "applied" | "duplicate" | "rejected";
  /** Error code for rejected actions (validation, forbidden, not_found, version_conflict, ...). */
  code?: string;
  message?: string;
  result?: unknown;
}

export interface OutboxSender {
  /** POST the batch; rejects (throws) on transport or 5xx errors so the batch is retried later. */
  send(actions: OutboxAction[]): Promise<OutboxResult[]>;
}

export interface FlushReport {
  sent: number;
  rejected: number;
  /** Actions still queued after a transport failure. */
  deferred: number;
}

export const OUTBOX_BATCH_MAX = 100;

/** Client-side flush: batches of up to 100, stop at the first transport failure. */
export async function flushOutbox(
  outbox: Outbox,
  sender: OutboxSender,
  opts: { batch?: number } = {},
): Promise<FlushReport> {
  const batchSize = Math.min(OUTBOX_BATCH_MAX, Math.max(1, opts.batch ?? OUTBOX_BATCH_MAX));
  const report: FlushReport = { sent: 0, rejected: 0, deferred: 0 };
  for (;;) {
    const pending = (await outbox.pending()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (pending.length === 0) return report;
    const batch = pending.slice(0, batchSize);
    let results: OutboxResult[];
    try {
      results = await sender.send(
        batch.map(({ clientId, kind, payload, createdAt }) => ({
          clientId,
          kind,
          payload,
          createdAt,
        })),
      );
    } catch (e) {
      for (const item of batch) await outbox.markFailed(item.clientId, String(e), false);
      report.deferred = (await outbox.pending()).length;
      return report;
    }
    const byId = new Map(results.map((r) => [r.clientId, r]));
    for (const item of batch) {
      const r = byId.get(item.clientId);
      if (!r) {
        await outbox.markFailed(item.clientId, "no result for action", false);
        continue;
      }
      if (r.status === "rejected") {
        await outbox.markFailed(item.clientId, `${r.code ?? "rejected"}: ${r.message ?? ""}`, true);
        report.rejected += 1;
      } else {
        await outbox.markSent(item.clientId, r.result ?? null);
        report.sent += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Service side: idempotency keys
// ---------------------------------------------------------------------------------------

export interface IdempotencyRecord {
  key: string;
  at: string;
  result: OutboxResult;
}

export interface IdempotencyFile {
  version: 1;
  records: IdempotencyRecord[];
}

export const emptyIdempotency = (): IdempotencyFile => ({ version: 1, records: [] });

export function migrateIdempotency(raw: unknown): IdempotencyFile {
  if (raw && typeof raw === "object" && Array.isArray((raw as { records?: unknown }).records)) {
    return raw as IdempotencyFile;
  }
  return emptyIdempotency();
}

export const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Devices are their own idempotency space; admin callers are split by install (ADR 0009).
 * `POST /sync/outbox` and `POST /remote/commands` share it: the phone retries a lost
 * `/remote/commands` answer through its outbox under the envelope's own `clientId`, so the
 * two routes must remember the same key.
 */
export function idempotencyKeyOf(p: Principal): string {
  return p.kind === "device" ? p.deviceId : `admin:${p.installId ?? "default"}`;
}

/**
 * Remembers (device, clientId) -> result for a week so retried batches are safe. `run()` is
 * the whole contract: the key is reserved before the action is applied, so two batches in
 * flight at once (a retry fired before the first answer arrived) apply it once and both get
 * the same result.
 */
export class IdempotencyStore {
  private readonly inFlight = new Map<string, Promise<OutboxResult>>();

  constructor(
    private readonly state: JsonState<IdempotencyFile> = new MemoryJsonState(emptyIdempotency()),
    private readonly clock: Clock,
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
  ) {}

  /**
   * Apply `fn` once per key. A stored result is returned as is; a concurrent call with the
   * same key waits for the first and gets its result; `fresh` is true for the caller whose
   * `fn` ran. When `fn` throws (a 5xx) the key is released so a later retry can apply.
   */
  async run(
    deviceKey: string,
    clientId: string,
    fn: () => Promise<OutboxResult>,
  ): Promise<{ result: OutboxResult; fresh: boolean }> {
    const stored = this.get(deviceKey, clientId);
    if (stored) return { result: stored, fresh: false };
    const key = this.key(deviceKey, clientId);
    const pending = this.inFlight.get(key);
    if (pending) return { result: await pending, fresh: false };
    const task = (async () => {
      const result = await fn();
      await this.put(deviceKey, clientId, result);
      return result;
    })();
    this.inFlight.set(key, task);
    try {
      return { result: await task, fresh: true };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private key(deviceKey: string, clientId: string): string {
    return `${deviceKey}:${clientId}`;
  }

  get(deviceKey: string, clientId: string): OutboxResult | undefined {
    const key = this.key(deviceKey, clientId);
    const cutoff = this.clock.now() - this.ttlMs;
    const rec = this.state.get().records.find((r) => r.key === key);
    if (!rec || Date.parse(rec.at) < cutoff) return undefined;
    return rec.result;
  }

  async put(deviceKey: string, clientId: string, result: OutboxResult): Promise<void> {
    const key = this.key(deviceKey, clientId);
    const at = this.clock.nowIso();
    const cutoff = this.clock.now() - this.ttlMs;
    await this.state.update((s) => ({
      version: 1,
      records: [
        ...s.records.filter((r) => r.key !== key && Date.parse(r.at) >= cutoff),
        { key, at, result },
      ],
    }));
  }
}
