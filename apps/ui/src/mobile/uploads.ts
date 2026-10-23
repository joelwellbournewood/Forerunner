import {
  StateApiError,
  type StateClient,
  type UploadFile,
  type UploadView,
} from "../api/state-client.ts";
import { fromBase64, toBase64 } from "../api/state-signing.ts";
import { type MobileStorage, readJson } from "./storage.ts";

/**
 * The phone's offline queue for uploads (spec R.3, R.5; ADR 0080). A file picked while the
 * service is unreachable is kept here (bytes in base64) and sent to the multipart upload route
 * when the phone reconnects, under the `clientId` it got when it was picked: the service
 * returns the asset it already made for a resend after a lost answer (200), never a second
 * copy. Kept apart from the action outbox (`outbox.ts`) because `POST /sync/outbox` is JSON
 * with a 256 KiB body cap and a photo is not an action. What fits in browser storage is
 * persisted (`PERSIST_MAX_BYTES` in total); a larger file stays queued in memory until the
 * app closes, and the screen says so.
 */
export const PERSIST_MAX_BYTES = 2 * 1024 * 1024;

export interface QueuedUpload {
  clientId: string;
  projectId: string;
  name: string;
  type: string;
  kind: string;
  sizeBytes: number;
  createdAt: string;
  /** The file, base64. */
  data: string;
  attempts: number;
  lastError: string | null;
  /** False when the file is too large for browser storage: lost if the app closes. */
  persisted: boolean;
}

export interface UploadFlushReport {
  sent: { clientId: string; upload: UploadView }[];
  rejected: { clientId: string; name: string; code: string; message: string }[];
  deferred: number;
}

export class UploadQueue {
  private items: QueuedUpload[];

  constructor(
    private readonly storage: MobileStorage,
    private readonly key: string,
  ) {
    this.items = readJson<QueuedUpload[]>(storage, key, []).filter(
      (i) => i && typeof i.clientId === "string" && typeof i.data === "string",
    );
  }

  pending(): QueuedUpload[] {
    return [...this.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  size(): number {
    return this.items.length;
  }

  /** Whether the queued file is in browser storage (false: held in memory, lost on close). */
  isPersisted(clientId: string): boolean {
    return this.items.find((i) => i.clientId === clientId)?.persisted ?? false;
  }

  enqueue(input: {
    clientId: string;
    projectId: string;
    file: UploadFile;
    kind: string;
    createdAt: string;
  }): QueuedUpload {
    const existing = this.items.find((i) => i.clientId === input.clientId);
    if (existing) return existing;
    const item: QueuedUpload = {
      clientId: input.clientId,
      projectId: input.projectId,
      name: input.file.name,
      type: input.file.type,
      kind: input.kind,
      sizeBytes: input.file.bytes.byteLength,
      createdAt: input.createdAt,
      data: toBase64(input.file.bytes),
      attempts: 0,
      lastError: null,
      persisted: true,
    };
    this.items = [...this.items, item];
    this.persist();
    return item;
  }

  /** Send every queued file in order; stops at the first transport failure and keeps the rest. */
  async flush(client: StateClient): Promise<UploadFlushReport> {
    const report: UploadFlushReport = { sent: [], rejected: [], deferred: 0 };
    for (const item of this.pending()) {
      try {
        const upload = await client.upload(
          item.projectId,
          { name: item.name, type: item.type, bytes: fromBase64(item.data) },
          { clientId: item.clientId, kind: item.kind },
        );
        this.drop(item.clientId);
        report.sent.push({ clientId: item.clientId, upload });
      } catch (error) {
        if (
          error instanceof StateApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 401 &&
          error.status !== 408 &&
          error.status !== 429
        ) {
          this.drop(item.clientId);
          report.rejected.push({
            clientId: item.clientId,
            name: item.name,
            code: error.code,
            message: error.message,
          });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.items = this.items.map((i) =>
          i.clientId === item.clientId ? { ...i, attempts: i.attempts + 1, lastError: message } : i,
        );
        this.persist();
        report.deferred = this.size();
        return report;
      }
    }
    return report;
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  private drop(clientId: string): void {
    this.items = this.items.filter((i) => i.clientId !== clientId);
    this.persist();
  }

  /** Persist what fits (oldest first); the rest is marked as held in memory only. */
  private persist(): void {
    let budget = PERSIST_MAX_BYTES;
    const kept: QueuedUpload[] = [];
    this.items = this.items.map((i) => {
      const fits = i.sizeBytes <= budget;
      if (fits) {
        budget -= i.sizeBytes;
        kept.push(i);
      }
      return fits === i.persisted ? i : { ...i, persisted: fits };
    });
    // Browser storage swallows a full quota; read back to know whether the write held.
    const json = JSON.stringify(kept);
    this.storage.set(this.key, json);
    if (kept.length > 0 && this.storage.get(this.key) !== json) {
      this.items = this.items.map((i) => (i.persisted ? { ...i, persisted: false } : i));
    }
  }
}
