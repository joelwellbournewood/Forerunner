/**
 * In-process notification bus. The daemon forwards `notification` payloads as the SSE event
 * `notification` to the attached shells (tray toast, ADR 0031 point 2); `record` carries every
 * notifier decision (delivered, held, deduped, ...) for UIs that show a recent list.
 */
import type { NotificationKind, NotificationRecord, Urgency } from "./types.ts";

/** What a shell receives: the fields ADR 0031 names, `route` being the UI route to open. */
export interface NotificationEventPayload {
  /** The `NotificationRecord` id (as `GET /notifications/recent` lists it); a test send's dedupe key. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  level: Urgency;
  route: string;
  humanId: string;
  projectId: string | null;
}

export interface NotificationEmitterEvents {
  notification: NotificationEventPayload;
  record: NotificationRecord;
}

type Listener<K extends keyof NotificationEmitterEvents> = (
  payload: NotificationEmitterEvents[K],
) => void;

export class NotificationEmitter {
  private readonly listeners: { [K in keyof NotificationEmitterEvents]: Set<Listener<K>> } = {
    notification: new Set(),
    record: new Set(),
  };

  on<K extends keyof NotificationEmitterEvents>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners[type] as Set<Listener<K>>;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<K extends keyof NotificationEmitterEvents>(
    type: K,
    payload: NotificationEmitterEvents[K],
  ): void {
    for (const fn of this.listeners[type] as Set<Listener<K>>) {
      try {
        fn(payload);
      } catch {
        // a failing listener never breaks a delivery
      }
    }
  }

  listenerCount(type: keyof NotificationEmitterEvents): number {
    return this.listeners[type].size;
  }
}
