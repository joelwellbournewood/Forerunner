/**
 * The notifier: routes a notification by kind and the human's preferences, holds non-urgent
 * ones during quiet hours, bundles info items into the daily digest, dedupes repeats, retries a
 * channel with backoff and falls back to the next configured channel. Every delivery attempt is
 * an `audit_log` row, an event on the session (when the notification names one) and a `record`
 * on the in-process bus. Rules live here, in code; channels only send.
 */
import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import type { HumanRow, JsonValue, NewAuditLog } from "@forerunner/state";
import type { Channel, ChannelContext, HumanFacts } from "./channels/types.ts";
import { NotificationEmitter } from "./emitter.ts";
import {
  channelsFor,
  digestState,
  isQuietAt,
  NotificationPrefsPatch,
  readPrefs,
  resolvePrefs,
  writePrefs,
} from "./prefs.ts";
import {
  CHANNEL_NAMES,
  type ChannelName,
  type Delivery,
  type Notification,
  type NotificationPrefs,
  type NotificationRecord,
  type ResolvedPrefs,
  type Urgency,
  urgencyOf,
} from "./types.ts";

export interface HumanLookup {
  get(id: string): Promise<HumanRow | undefined>;
  patch(id: string, patch: Partial<HumanRow>): Promise<HumanRow>;
}

export interface AuditSink {
  append(input: NewAuditLog): Promise<unknown>;
}

export interface EventSink {
  append(sessionId: string, type: string, payload?: JsonValue): Promise<unknown>;
}

export interface RetryPolicy {
  /** Attempts per channel before falling back (1 = no retry). */
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: Readonly<RetryPolicy> = { attempts: 3, baseMs: 500, maxMs: 5_000 };
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000;
export const DEFAULT_RECENT_LIMIT = 200;
/** Most items one digest lists in full; the rest are counted. */
export const DIGEST_MAX_LINES = 50;

export interface NotifierDeps {
  clock: Clock;
  channels: Channel[];
  humans: HumanLookup;
  audit: AuditSink;
  /** Session event log; a delivery is appended when the notification names a session. */
  events?: EventSink;
  emitter?: NotificationEmitter;
  retry?: Partial<RetryPolicy>;
  dedupeWindowMs?: number;
  recentLimit?: number;
}

export interface ChannelStatus {
  name: ChannelName;
  /** The channel exists in this daemon (wired by the orchestrator). */
  available: boolean;
  configured: boolean;
  reason: string | null;
}

export interface PrefsView {
  prefs: NotificationPrefs;
  resolved: { timezone: string; email: string | null };
  channels: ChannelStatus[];
}

interface HumanState {
  held: NotificationRecord[];
  digest: NotificationRecord[];
  lastDigestDay: string | null;
  dedupe: Map<string, number>;
}

const EVENT_TYPE = "notification";

export class Notifier {
  readonly emitter: NotificationEmitter;
  private readonly logger = log("notify");
  private readonly retry: RetryPolicy;
  private readonly byName = new Map<ChannelName, Channel>();
  /** Announcing channels (ADR 0063): run after the chain for urgent records, never end it. */
  private readonly announcers: Channel[] = [];
  private readonly state = new Map<string, HumanState>();
  private readonly recentRecords: NotificationRecord[] = [];
  private ticking: Promise<void> | null = null;

  constructor(private readonly deps: NotifierDeps) {
    this.emitter = deps.emitter ?? new NotificationEmitter();
    this.retry = { ...DEFAULT_RETRY, ...(deps.retry ?? {}) };
    for (const c of deps.channels) {
      this.byName.set(c.name, c);
      if (c.announce) this.announcers.push(c);
    }
  }

  /** Route one notification. Resolves once it is delivered, held, bundled or deduped. */
  async notify(n: Notification): Promise<NotificationRecord> {
    if (!n.humanId || !n.title.trim() || !n.dedupeKey) {
      throw new ForerunnerError("validation", "notification needs humanId, title and dedupeKey", {
        details: { kind: n.kind },
      });
    }
    const ctx = await this.context(n.humanId);
    const now = this.deps.clock.now();
    const st = this.stateOf(n.humanId, ctx.prefs, now);
    const urgency = urgencyOf(n);
    const record: NotificationRecord = {
      id: newId(now),
      notification: { ...n },
      urgency,
      outcome: "held",
      heldFor: null,
      deliveries: [],
      createdAt: this.deps.clock.nowIso(),
      resolvedAt: null,
    };

    const key = dedupeKeyOf(n);
    const window = this.deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const last = st.dedupe.get(key);
    if (last !== undefined && now - last < window) {
      record.outcome = "deduped";
      record.resolvedAt = this.deps.clock.nowIso();
      this.remember(record);
      return record;
    }
    // Reserved now so a concurrent duplicate is deduped; released again by `dispatch` when
    // nothing was delivered (ADR 0017 point 5): a failed send never blocks a re-send.
    st.dedupe.set(key, now);
    if (st.dedupe.size > 1000) {
      for (const [k, t] of st.dedupe) if (now - t >= window) st.dedupe.delete(k);
    }

    if (urgency === "urgent") {
      await this.dispatch(record, ctx);
    } else if (urgency === "info" && ctx.prefs.digest_time) {
      record.heldFor = "digest";
      st.digest.push(record);
      this.emitter.emit("record", record);
    } else if (isQuietAt(ctx.prefs.quiet_hours, ctx.prefs.timezone, now)) {
      record.heldFor = "quiet_hours";
      st.held.push(record);
      this.emitter.emit("record", record);
    } else {
      await this.dispatch(record, ctx);
    }
    return record;
  }

  /**
   * Flush what is due: the digest (once per local day at the digest time, bundling the digest
   * queue and whatever is still held) or, outside quiet hours, the held items one by one.
   */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    for (const [humanId, st] of this.state) {
      if (st.held.length === 0 && st.digest.length === 0) continue;
      let ctx: ChannelContext;
      try {
        ctx = await this.context(humanId);
      } catch (e) {
        this.logger.warn("tick skipped a human", { humanId, error: errorMessage(e) });
        continue;
      }
      const now = this.deps.clock.now();
      const prefs = ctx.prefs;
      const ds = digestState(prefs.digest_time, prefs.timezone, now);
      if (prefs.digest_time && ds.due && st.lastDigestDay !== ds.dayKey) {
        st.lastDigestDay = ds.dayKey;
        const items = [...st.digest, ...st.held];
        st.digest = [];
        st.held = [];
        if (items.length > 0) await this.sendDigest(items, ctx, ds.dayKey);
        continue;
      }
      if (!prefs.digest_time && st.digest.length > 0) {
        // The digest was switched off: its queue follows the quiet-hours rules from now on.
        for (const r of st.digest) r.heldFor = "quiet_hours";
        st.held.push(...st.digest);
        st.digest = [];
      }
      if (st.held.length > 0 && !isQuietAt(prefs.quiet_hours, prefs.timezone, now)) {
        const items = st.held;
        st.held = [];
        for (const r of items) await this.dispatch(r, ctx);
      }
    }
  }

  /** Periodic tick on the clock; returns the stop function. */
  start(intervalMs = 60_000): () => void {
    let stopped = false;
    let cancel: () => void = () => undefined;
    const loop = () => {
      if (stopped) return;
      cancel = this.deps.clock.setTimeout(() => {
        void this.tick()
          .catch((e) => this.logger.warn("tick failed", { error: errorMessage(e) }))
          .finally(loop);
      }, intervalMs);
    };
    loop();
    return () => {
      stopped = true;
      cancel();
    };
  }

  /** Newest first. */
  recent(opts: { humanId?: string; limit?: number } = {}): NotificationRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, DEFAULT_RECENT_LIMIT));
    const rows = opts.humanId
      ? this.recentRecords.filter((r) => r.notification.humanId === opts.humanId)
      : this.recentRecords;
    return rows.slice(0, limit);
  }

  /** What waits for this human: quiet-hours holds and digest items. */
  pending(humanId: string): { held: NotificationRecord[]; digest: NotificationRecord[] } {
    const st = this.state.get(humanId);
    return { held: [...(st?.held ?? [])], digest: [...(st?.digest ?? [])] };
  }

  async getPrefs(humanId: string): Promise<PrefsView> {
    const human = await this.human(humanId);
    return this.prefsView(human);
  }

  /** Validate, merge into the stored JSON (keeping other modules' keys) and save. */
  async setPrefs(humanId: string, patch: unknown): Promise<PrefsView> {
    const parsed = NotificationPrefsPatch.safeParse(patch);
    if (!parsed.success) {
      throw new ForerunnerError("validation", "notification preferences are malformed", {
        details: {
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      });
    }
    const human = await this.human(humanId);
    const notify_prefs = writePrefs(human.notify_prefs, parsed.data);
    const saved = await this.deps.humans.patch(human.id, { notify_prefs });
    return this.prefsView(saved);
  }

  /**
   * One test notification to every configured channel, outside quiet hours and dedupe; an
   * announcing channel speaks its test too, so "Send a test" is heard.
   */
  async sendTest(humanId: string): Promise<Delivery[]> {
    const ctx = await this.context(humanId);
    const out: Delivery[] = [];
    for (const name of CHANNEL_NAMES) {
      const channel = this.byName.get(name);
      if (!channel) continue;
      const why = channel.configured(ctx);
      if (why) {
        out.push({
          channel: name,
          status: "skipped",
          reason: why,
          attempts: 0,
          at: this.deps.clock.nowIso(),
        });
        continue;
      }
      const n: Notification = {
        kind: "daily_digest",
        humanId,
        title: "Test notification from Forerunner",
        body: `This is a test of the ${name} channel. If you can read this, the channel works.`,
        link: "/settings",
        dedupeKey: `test:${name}:${this.deps.clock.now()}`,
      };
      const d = await this.attempt(channel, n, ctx);
      out.push(d);
      await this.audit(n, d, "test");
    }
    return out;
  }

  // ---- internals -----------------------------------------------------------------------

  /**
   * Per-human queues, created on first use. A digest time that already passed today counts as
   * sent, so a daemon started (or a first item arriving) after the digest time does not fire a
   * stray digest on the next tick: items wait for tomorrow's.
   */
  private stateOf(humanId: string, prefs: ResolvedPrefs, now: number): HumanState {
    let st = this.state.get(humanId);
    if (!st) {
      const ds = digestState(prefs.digest_time, prefs.timezone, now);
      st = {
        held: [],
        digest: [],
        lastDigestDay: ds.due ? ds.dayKey : null,
        dedupe: new Map(),
      };
      this.state.set(humanId, st);
    }
    return st;
  }

  private async human(humanId: string): Promise<HumanRow> {
    const human = await this.deps.humans.get(humanId);
    if (!human) throw new ForerunnerError("not_found", `human ${humanId} not found`);
    return human;
  }

  private async context(humanId: string): Promise<ChannelContext> {
    const human = await this.human(humanId);
    const prefs: ResolvedPrefs = resolvePrefs(human);
    const facts: HumanFacts = {
      id: human.id,
      name: human.name,
      email: human.email,
      timezone: prefs.timezone,
    };
    return { human: facts, prefs };
  }

  private prefsView(human: HumanRow): PrefsView {
    const prefs = readPrefs(human.notify_prefs);
    const resolved = resolvePrefs(human);
    const ctx: ChannelContext = {
      human: { id: human.id, name: human.name, email: human.email, timezone: resolved.timezone },
      prefs: resolved,
    };
    const channels: ChannelStatus[] = CHANNEL_NAMES.map((name) => {
      const c = this.byName.get(name);
      if (!c)
        return { name, available: false, configured: false, reason: "not wired in this daemon" };
      const reason = c.configured(ctx);
      return { name, available: true, configured: reason === null, reason };
    });
    return { prefs, resolved: { timezone: resolved.timezone, email: resolved.email }, channels };
  }

  /**
   * Try the channels in preference order; stop at the first delivery. Then the announcing
   * channels for an urgent record (ADR 0063): on top of the delivery, never instead of it.
   */
  private async dispatch(record: NotificationRecord, ctx: ChannelContext): Promise<void> {
    const n = record.notification;
    let tried = 0;
    for (const name of channelsFor(n.kind, ctx.prefs)) {
      const channel = this.byName.get(name);
      if (!channel || channel.announce) continue;
      const why = channel.configured(ctx) ?? channel.accepts?.(n, ctx) ?? null;
      if (why) {
        record.deliveries.push(this.skipped(name, why));
        continue;
      }
      tried++;
      const d = await this.attempt(channel, n, { ...ctx, recordId: record.id });
      record.deliveries.push(d);
      await this.audit(n, d, record.id);
      if (d.status === "delivered") break;
    }
    if (record.urgency === "urgent") {
      for (const channel of this.announcers) {
        // Off for this human: not wired as far as this record is concerned, no row.
        if (channel.configured(ctx)) continue;
        const why = channel.accepts?.(n, ctx) ?? null;
        if (why) {
          record.deliveries.push(this.skipped(channel.name, why));
          continue;
        }
        const d = await this.attempt(channel, n, { ...ctx, recordId: record.id });
        record.deliveries.push(d);
        await this.audit(n, d, record.id);
      }
    }
    const delivered = record.deliveries.some((d) => d.status === "delivered");
    record.outcome = delivered ? "delivered" : tried === 0 ? "no_channel" : "failed";
    record.heldFor = null;
    record.resolvedAt = this.deps.clock.nowIso();
    if (record.outcome !== "delivered") {
      // Only a delivered (or still held) notification occupies the dedupe window.
      this.state.get(n.humanId)?.dedupe.delete(dedupeKeyOf(n));
      this.logger.warn("not delivered", {
        kind: n.kind,
        humanId: n.humanId,
        outcome: record.outcome,
        reasons: record.deliveries.map((d) => `${d.channel}: ${d.reason ?? d.status}`),
      });
    }
    await this.event(record);
    this.remember(record);
  }

  private skipped(channel: ChannelName, reason: string): Delivery {
    return { channel, status: "skipped", reason, attempts: 0, at: this.deps.clock.nowIso() };
  }

  /** One channel with retries and exponential backoff on the clock. */
  private async attempt(channel: Channel, n: Notification, ctx: ChannelContext): Promise<Delivery> {
    let attempts = 0;
    let reason: string | null = null;
    let status: Delivery["status"] = "failed";
    for (let i = 0; i < Math.max(1, this.retry.attempts); i++) {
      attempts++;
      let res: Awaited<ReturnType<Channel["send"]>>;
      try {
        res = await channel.send(n, ctx);
      } catch (e) {
        res = { ok: false, reason: `${channel.name} threw: ${errorMessage(e)}`, retryable: true };
      }
      if (res.ok) {
        status = "delivered";
        reason = res.detail;
        break;
      }
      reason = res.reason;
      if (!res.retryable) {
        status = "unavailable";
        break;
      }
      status = "failed";
      if (i < this.retry.attempts - 1) {
        await this.deps.clock.sleep(Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** i));
      }
    }
    return { channel: channel.name, status, reason, attempts, at: this.deps.clock.nowIso() };
  }

  private async audit(n: Notification, d: Delivery, ref: string): Promise<void> {
    const ok = d.status === "delivered";
    const input: NewAuditLog = {
      tool: `notify.${d.channel}`,
      allowed: ok,
      human_id: n.humanId,
      session_id: n.sessionId ?? null,
      input_summary: `${n.kind}: ${n.title.slice(0, 200)} (${ref})`,
      result_summary: `${d.status} after ${d.attempts} attempt(s)${d.reason ? `: ${d.reason.slice(0, 300)}` : ""}`,
      denied_reason: ok ? null : (d.reason ?? d.status).slice(0, 300),
      occurred_at: this.deps.clock.nowIso(),
    };
    try {
      await this.deps.audit.append(input);
    } catch (e) {
      this.logger.error("audit append failed", { error: errorMessage(e) });
    }
  }

  private async event(record: NotificationRecord): Promise<void> {
    const n = record.notification;
    if (!n.sessionId || !this.deps.events) return;
    try {
      await this.deps.events.append(n.sessionId, EVENT_TYPE, {
        id: record.id,
        kind: n.kind,
        humanId: n.humanId,
        title: n.title,
        urgency: record.urgency,
        outcome: record.outcome,
        deliveries: record.deliveries.map((d) => ({
          channel: d.channel,
          status: d.status,
          attempts: d.attempts,
          reason: d.reason,
        })),
      });
    } catch (e) {
      this.logger.warn("event append failed", { sessionId: n.sessionId, error: errorMessage(e) });
    }
  }

  private remember(record: NotificationRecord): void {
    this.recentRecords.unshift(record);
    const limit = this.deps.recentLimit ?? DEFAULT_RECENT_LIMIT;
    if (this.recentRecords.length > limit) this.recentRecords.length = limit;
    this.emitter.emit("record", record);
  }

  private async sendDigest(
    items: NotificationRecord[],
    ctx: ChannelContext,
    dayKey: string,
  ): Promise<void> {
    const now = this.deps.clock.nowIso();
    for (const r of items) {
      r.outcome = "digested";
      r.heldFor = null;
      r.resolvedAt = now;
      this.remember(r);
    }
    const lines = items
      .slice(0, DIGEST_MAX_LINES)
      .map(
        (r) =>
          `- [${r.notification.kind}] ${r.notification.title}${r.notification.body ? ` — ${oneLine(r.notification.body, 160)}` : ""}`,
      );
    if (items.length > DIGEST_MAX_LINES)
      lines.push(`… and ${items.length - DIGEST_MAX_LINES} more`);
    const urgency: Urgency = "normal";
    const digest: NotificationRecord = {
      id: newId(this.deps.clock.now()),
      notification: {
        kind: "daily_digest",
        humanId: ctx.human.id,
        title: `Daily digest: ${items.length} ${items.length === 1 ? "item" : "items"}`,
        body: lines.join("\n"),
        link: "/inbox",
        dedupeKey: `digest:${dayKey}`,
      },
      urgency,
      outcome: "held",
      heldFor: null,
      deliveries: [],
      createdAt: now,
      resolvedAt: null,
    };
    await this.dispatch(digest, ctx);
  }
}

function dedupeKeyOf(n: Pick<Notification, "humanId" | "dedupeKey">): string {
  return `${n.humanId}\u0000${n.dedupeKey}`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
