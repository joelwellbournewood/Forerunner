import type { OutboxActionInput, OutboxResultView, StateClient } from "../api/state-client.ts";
import { type MobileStorage, readJson, writeJson } from "./storage.ts";

/**
 * The phone's offline queue (spec R.3 "works offline and queues actions until it
 * reconnects"), the client side of the service's `Outbox` contract (`services/state-api/src/
 * outbox.ts`): actions with client-generated ids, flushed in batches to `POST /sync/outbox`
 * where a repeated id is a duplicate and never applied twice. Persisted in per-install
 * browser storage (actions hold no secrets). Rejected actions (4xx) are dropped and reported;
 * transport failures keep the queue. A high-risk answer is never queued: its biometric flag
 * must be inside the signature of the request that carries it, so it needs a connection.
 */
export const OUTBOX_KINDS = [
  "message.send",
  "message.receipt",
  "request.answer",
  "queue.enqueue",
  "remote.enqueue",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export interface OutboxItem extends OutboxActionInput {
  kind: OutboxKind;
  status: "queued" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  /** What the screen should say once applied ("Answer to request X sent"). */
  label: string;
}

export interface FlushReport {
  sent: number;
  /** Applied actions with what the service answered (e.g. the remote command id). */
  applied: { clientId: string; kind: OutboxKind; result: unknown }[];
  rejected: { clientId: string; label: string; code: string; message: string }[];
  deferred: number;
}

export const OUTBOX_BATCH = 50;

export class LocalOutbox {
  private items: OutboxItem[];

  constructor(
    private readonly storage: MobileStorage,
    private readonly key: string,
  ) {
    this.items = readJson<OutboxItem[]>(storage, key, []).filter(
      (i) => i && typeof i.clientId === "string" && i.status === "queued",
    );
  }

  pending(): OutboxItem[] {
    return this.items
      .filter((i) => i.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  size(): number {
    return this.pending().length;
  }

  enqueue(action: OutboxActionInput & { kind: OutboxKind; label: string }): OutboxItem {
    const existing = this.items.find((i) => i.clientId === action.clientId);
    if (existing) return existing;
    const item: OutboxItem = { ...action, status: "queued", attempts: 0, lastError: null };
    this.items = [...this.items, item];
    this.persist();
    return item;
  }

  /** Send every queued action; stops at the first transport failure and keeps the rest. */
  async flush(client: StateClient): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, applied: [], rejected: [], deferred: 0 };
    for (;;) {
      const batch = this.pending().slice(0, OUTBOX_BATCH);
      if (batch.length === 0) return report;
      let results: OutboxResultView[];
      try {
        results = await client.syncOutbox(
          batch.map(({ clientId, kind, payload, createdAt }) => ({
            clientId,
            kind,
            payload,
            createdAt,
          })),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const item of batch) this.mark(item.clientId, "queued", message);
        report.deferred = this.size();
        return report;
      }
      const byId = new Map(results.map((r) => [r.clientId, r]));
      for (const item of batch) {
        const r = byId.get(item.clientId);
        if (!r) {
          this.mark(item.clientId, "queued", "no result for action");
          continue;
        }
        if (r.status === "rejected") {
          this.mark(item.clientId, "failed", `${r.code ?? "rejected"}: ${r.message ?? ""}`);
          report.rejected.push({
            clientId: item.clientId,
            label: item.label,
            code: r.code ?? "rejected",
            message: r.message ?? "",
          });
        } else {
          this.mark(item.clientId, "sent", null);
          report.sent += 1;
          report.applied.push({
            clientId: item.clientId,
            kind: item.kind,
            result: r.result ?? null,
          });
        }
      }
    }
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  private mark(clientId: string, status: OutboxItem["status"], error: string | null): void {
    this.items = this.items.map((i) =>
      i.clientId === clientId ? { ...i, status, attempts: i.attempts + 1, lastError: error } : i,
    );
    // Sent and failed items are not kept: the change log and the screens hold the outcome.
    this.items = this.items.filter((i) => i.status === "queued");
    this.persist();
  }

  private persist(): void {
    writeJson(this.storage, this.key, this.items);
  }
}
