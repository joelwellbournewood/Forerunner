import { type Clock, log } from "@forerunner/platform";
import { isQuietAt, resolvePrefs } from "@forerunner/runtime/notifications/prefs";
import { KIND_URGENCY, type Urgency } from "@forerunner/runtime/notifications/types";
import type { DeviceRow, StateStore } from "@forerunner/state";
import type { ChangeBus, ChangeEvent } from "../realtime.ts";
import type { PushMessage, PushSender } from "./fcm.ts";

/**
 * Push fan-out (spec R.6; ADR 0085). Watches the change bus (the service's own writes and the
 * poller's view of everyone else's) for the four push kinds and sends each, once, to every
 * active device of the human that holds a `push_token`:
 *
 * - approval: a `human_request` opened for the human (blocking ones are urgent);
 * - session: a session of the human's agent completed, failed or stopped;
 * - budget: a session stopped at its budget cap (urgent) or crossed the warning share of it;
 * - message: a new message to the human, or to the human's agent from another human's agent.
 *
 * Quiet hours are the human's own (`human.notify_prefs`, the rule of ADR 0017 via
 * `isQuietAt`): urgent kinds go through; the others are held in memory and sent when the window
 * ends (`flushHeld`, run on every poller tick). A token FCM reports dead (404 / UNREGISTERED)
 * is cleared from the device with an audit row. Without a sender (no service account) nothing
 * is sent and `status()` says why: the app's change feed raises the same notices in-app.
 *
 * Payloads are data-minimal: a generic title and body plus ids and a deep link; message text,
 * request reasons and project names never leave through Google.
 */
export type PushKind = "approval" | "session" | "budget" | "message";
export const PUSH_KINDS: readonly PushKind[] = ["approval", "session", "budget", "message"];

/** Share of a session's budget cap at which the budget warning goes out (spec D, K.8). */
export const BUDGET_WARNING_SHARE = 0.8;
/** Held notices kept per service instance; the oldest are dropped (and logged) beyond it. */
export const MAX_HELD = 1_000;
const SEEN_MAX = 20_000;

export const AUDIT_TOOL_TOKEN_CLEARED = "push.token_cleared";

export interface PushNotice {
  kind: PushKind;
  /** ADR 0017 urgency: urgent goes through quiet hours, normal and info wait for the window to end. */
  urgency: Urgency;
  humanId: string;
  /** Sent once per key (row id plus what happened to it). */
  key: string;
  title: string;
  body: string;
  link: string;
  /** Row the notice is about. */
  refId: string;
  projectId: string | null;
}

export interface PushCounters {
  sent: number;
  failed: number;
  held: number;
  invalidated: number;
}

export interface PushStatusView {
  /** "fcm" when a sender is configured; "polling" is the stand-in (the app's change feed). */
  mode: "fcm" | "polling";
  enabled: boolean;
  /** Why push is off, or null when it is on. */
  reason: string | null;
  /** Firebase project id when configured (an identifier, not a secret). */
  projectId: string | null;
  /** Notices waiting for a quiet window to end. */
  holding: number;
  counters: PushCounters;
  /** The last send failure (HTTP status and FCM code only), or null. */
  lastError: string | null;
}

export interface PushFanoutOptions {
  store: StateStore;
  bus: ChangeBus;
  clock: Clock;
  /** Absent: push is off and `disabledReason` is what /health shows. */
  sender?: PushSender;
  disabledReason?: string;
}

export const PUSH_NOT_CONFIGURED =
  "FCM not configured (FORERUNNER_FCM_SERVICE_ACCOUNT_REF is not set); the app's change feed raises notices in-app";

const logger = log("state-api:push");

/** Bounded set of keys already pushed. */
class SeenKeys {
  private readonly keys = new Set<string>();
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    if (this.keys.size >= SEEN_MAX) {
      const first = this.keys.values().next().value;
      if (first !== undefined) this.keys.delete(first);
    }
    this.keys.add(key);
    return true;
  }
}

export class PushFanout {
  private readonly seen = new SeenKeys();
  private readonly held: PushNotice[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private unsubscribe: (() => void) | undefined;
  private lastError: string | null = null;
  private flushing: Promise<number> | undefined;
  readonly counters: PushCounters = { sent: 0, failed: 0, held: 0, invalidated: 0 };

  constructor(private readonly opts: PushFanoutOptions) {}

  get enabled(): boolean {
    return this.opts.sender !== undefined;
  }

  start(): void {
    if (!this.opts.sender || this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.subscribe((e) => {
      const p = this.handle(e).catch((err) =>
        logger.warn("push fan-out failed", { type: e.type, error: String(err) }),
      );
      this.inFlight.add(p);
      p.finally(() => this.inFlight.delete(p));
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.idle();
  }

  /** Resolves when every fan-out started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    if (this.flushing) await this.flushing;
  }

  status(): PushStatusView {
    return {
      mode: this.enabled ? "fcm" : "polling",
      enabled: this.enabled,
      reason: this.enabled ? null : (this.opts.disabledReason ?? PUSH_NOT_CONFIGURED),
      projectId: this.opts.sender?.projectId ?? null,
      holding: this.held.length,
      counters: { ...this.counters },
      lastError: this.lastError,
    };
  }

  /** One change event: the notice it raises (if any), sent now or held for quiet hours. */
  async handle(event: ChangeEvent): Promise<void> {
    if (!this.opts.sender) return;
    const notice = await this.noticeFor(event);
    if (!notice || !this.seen.add(notice.key)) return;
    if (await this.isQuietFor(notice)) {
      this.hold(notice);
      return;
    }
    await this.deliver(notice);
  }

  /** Send the held notices whose human is out of quiet hours now; returns how many went out. */
  flushHeld(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.runFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<number> {
    if (!this.opts.sender || this.held.length === 0) return 0;
    const due: PushNotice[] = [];
    const quietByHuman = new Map<string, boolean>();
    for (let i = 0; i < this.held.length; ) {
      const n = this.held[i] as PushNotice;
      let quiet = quietByHuman.get(n.humanId);
      if (quiet === undefined) {
        quiet = await this.isQuietFor(n);
        quietByHuman.set(n.humanId, quiet);
      }
      if (quiet) i += 1;
      else due.push(...this.held.splice(i, 1));
    }
    for (const n of due) await this.deliver(n);
    return due.length;
  }

  private hold(notice: PushNotice): void {
    this.held.push(notice);
    this.counters.held += 1;
    while (this.held.length > MAX_HELD) {
      const dropped = this.held.shift();
      logger.warn("held push notice dropped (queue full)", {
        kind: dropped?.kind,
        humanId: dropped?.humanId,
      });
    }
  }

  private async isQuietFor(notice: PushNotice): Promise<boolean> {
    if (notice.urgency === "urgent") return false;
    const human = await this.opts.store.human.get(notice.humanId);
    if (!human) return false;
    const prefs = resolvePrefs(human);
    return isQuietAt(prefs.quiet_hours, prefs.timezone, this.opts.clock.now());
  }

  private async deliver(notice: PushNotice): Promise<void> {
    const sender = this.opts.sender;
    if (!sender) return;
    const devices = await this.opts.store.device.pushTargets(notice.humanId);
    const message = messageOf(notice);
    for (const device of devices) {
      const token = device.push_token as string;
      const outcome = await sender.send(token, message);
      if (outcome.status === "sent") {
        this.counters.sent += 1;
        logger.info("push sent", {
          kind: notice.kind,
          deviceId: device.id,
          attempts: outcome.attempts,
        });
      } else if (outcome.status === "unregistered") {
        await this.invalidate(device, token, outcome.reason);
      } else {
        this.counters.failed += 1;
        this.lastError = outcome.reason;
        logger.warn("push failed", {
          kind: notice.kind,
          deviceId: device.id,
          attempts: outcome.attempts,
          reason: outcome.reason,
        });
      }
    }
  }

  /** FCM says the token is dead: clear it (unless the device already sent a new one) and audit. */
  private async invalidate(device: DeviceRow, token: string, reason: string): Promise<void> {
    const current = await this.opts.store.device.get(device.id);
    if (!current || current.push_token !== token) return;
    await this.opts.store.device.setPushToken(device.id, null);
    this.counters.invalidated += 1;
    logger.info("push token cleared", { deviceId: device.id, reason });
    await this.opts.store.auditLog.append({
      tool: AUDIT_TOOL_TOKEN_CLEARED,
      allowed: true,
      human_id: device.owner_human_id,
      input_summary: JSON.stringify({ deviceId: device.id, platform: device.platform }),
      result_summary: JSON.stringify({ cleared: true, reason }),
      cost_usd_micro: 0,
      occurred_at: this.opts.clock.nowIso(),
      author_human: device.owner_human_id,
    });
  }

  /** The notice a change event raises for push, or null. Reads the row to decide. */
  async noticeFor(e: ChangeEvent): Promise<PushNotice | null> {
    const id = typeof e.payload.id === "string" ? e.payload.id : null;
    if (!id) return null;
    const store = this.opts.store;
    switch (e.type) {
      case "human_request.changed": {
        if (e.payload.status !== "open") return null;
        const row = await store.humanRequest.get(id);
        if (row?.status !== "open" || !row.human_id) return null;
        return {
          kind: "approval",
          urgency: KIND_URGENCY[row.blocking ? "request_blocking" : "request_opened"],
          humanId: row.human_id,
          key: `approval:${id}`,
          title: row.blocking ? "Approval needed (blocking)" : "A request waits on you",
          body: "Open the inbox to answer.",
          link: "/inbox",
          refId: id,
          projectId: row.project_id,
        };
      }
      case "session.changed": {
        if (!e.humanId) return null;
        const row = await store.session.get(id);
        if (!row) return null;
        const cap = row.budget_cap_usd_micro;
        const atCap = cap > 0 && row.spent_usd_micro >= cap;
        const base = { humanId: e.humanId, refId: id, projectId: row.project_id };
        const link = `/sessions/${id}`;
        if (row.status === "stopped" || row.status === "failed" || row.status === "completed") {
          if (atCap && row.status !== "completed") {
            return {
              ...base,
              kind: "budget",
              urgency: KIND_URGENCY.budget_stop,
              key: `budget:${id}:stop`,
              title: "Budget reached: session stopped",
              body: "A session stopped at its budget cap.",
              link,
            };
          }
          return {
            ...base,
            kind: "session",
            urgency: KIND_URGENCY.session_ended,
            key: `session:${id}:ended`,
            title:
              row.status === "completed"
                ? "Session finished"
                : row.status === "failed"
                  ? "Session failed"
                  : "Session stopped",
            body: "Open the session for the summary.",
            link,
          };
        }
        if (
          row.status === "running" &&
          cap > 0 &&
          row.spent_usd_micro >= cap * BUDGET_WARNING_SHARE
        ) {
          return {
            ...base,
            kind: "budget",
            // No runtime kind for the 80% warning: normal, so it waits out quiet hours.
            urgency: "normal",
            key: `budget:${id}:warn`,
            title: "Budget warning",
            body: `A session has used ${Math.round(BUDGET_WARNING_SHARE * 100)}% of its budget.`,
            link,
          };
        }
        return null;
      }
      case "message.changed": {
        if (!e.humanId) return null;
        const row = await store.message.get(id);
        // Unread only: a message the human already read on another device is not news.
        if (!row || row.read_at !== null) return null;
        if (!row.to_human_id) {
          // A message to the human's agent is pushed only when it comes from another human's agent.
          const from = await store.agent.get(row.from_agent_id);
          if (!from || from.owner_human_id === e.humanId) return null;
        } else if (row.to_human_id !== e.humanId) {
          return null;
        }
        return {
          kind: "message",
          urgency: KIND_URGENCY.peer_message,
          humanId: e.humanId,
          key: `message:${id}`,
          title: "New message",
          body: "Open the inbox to read it.",
          link: "/inbox",
          refId: id,
          projectId: row.project_id,
        };
      }
      default:
        return null;
    }
  }
}

/** The FCM message for a notice: generic text, ids and the deep link as string data. */
export function messageOf(n: PushNotice): PushMessage {
  return {
    title: n.title,
    body: n.body,
    data: {
      kind: n.kind,
      id: n.refId,
      link: n.link,
      ...(n.projectId ? { projectId: n.projectId } : {}),
    },
    priority: n.urgency === "urgent" ? "high" : "normal",
  };
}
