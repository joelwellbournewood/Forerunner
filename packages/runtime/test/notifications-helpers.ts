import { Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { type JsonObject, openStore, type StateStore } from "@forerunner/state";
import {
  type Channel,
  type ChannelContext,
  type ChannelName,
  type ChannelResult,
  type Notification,
  NotificationEmitter,
  Notifier,
  type NotifierDeps,
} from "../src/notifications/index.ts";

/** A scripted channel: answers from `results` in order, then delivers. Records every send. */
export class FakeChannel implements Channel {
  readonly announce: boolean;
  readonly sent: Notification[] = [];
  /** The context of each send (its `recordId` is what the notifier passed). */
  readonly contexts: ChannelContext[] = [];
  /** Clock time of each send, when a clock is given. */
  readonly sentAt: number[] = [];
  private readonly results: ChannelResult[];

  constructor(
    readonly name: ChannelName,
    private readonly opts: {
      configured?: (ctx: ChannelContext) => string | null;
      /** An announcing channel (ADR 0063): after the chain, urgent only, never ends it. */
      announce?: boolean;
      accepts?: (n: Notification, ctx: ChannelContext) => string | null;
      results?: ChannelResult[];
      clock?: SimulatedClock;
    } = {},
  ) {
    this.announce = opts.announce === true;
    this.results = [...(opts.results ?? [])];
  }

  accepts(n: Notification, ctx: ChannelContext): string | null {
    return this.opts.accepts?.(n, ctx) ?? null;
  }

  configured(ctx: ChannelContext): string | null {
    return this.opts.configured?.(ctx) ?? null;
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    this.sent.push(n);
    this.contexts.push(ctx);
    if (this.opts.clock) this.sentAt.push(this.opts.clock.now());
    return this.results.shift() ?? { ok: true, detail: this.name };
  }

  /** Queue more scripted answers. */
  answer(...results: ChannelResult[]): void {
    this.results.push(...results);
  }
}

export const ok: ChannelResult = { ok: true, detail: null };
export const fail = (reason: string, retryable = true): ChannelResult => ({
  ok: false,
  reason,
  retryable,
});

export interface RecordedEvent {
  sessionId: string;
  type: string;
  payload: unknown;
}

export interface World {
  clock: SimulatedClock;
  store: StateStore;
  humanId: string;
  emitter: NotificationEmitter;
  channels: Record<ChannelName, FakeChannel>;
  notifier: Notifier;
  /** Session events, from the store when `storeEvents` is on, else captured in memory. */
  events: RecordedEvent[];
  logs: LogRecord[];
  close(): Promise<void>;
}

export interface WorldOptions {
  /** Clock start, ISO UTC. Default 08:00Z = 10:00 in Europe/Zurich (CEST). */
  start?: string;
  timezone?: string;
  prefs?: JsonObject;
  channels?: Partial<Record<ChannelName, FakeChannel>>;
  retry?: NotifierDeps["retry"];
  dedupeWindowMs?: number;
  recentLimit?: number;
  /** Append session events to the store (the session must exist) instead of memory. */
  storeEvents?: boolean;
}

/** The default channels behave like the real ones' `configured()`: desktop always, the rest by prefs; voice announces. */
export function defaultChannels(clock: SimulatedClock): Record<ChannelName, FakeChannel> {
  return {
    desktop: new FakeChannel("desktop", { clock }),
    telegram: new FakeChannel("telegram", {
      clock,
      configured: (ctx) => (ctx.prefs.telegram_chat_id ? null : "no Telegram chat id"),
    }),
    signal: new FakeChannel("signal", {
      clock,
      configured: (ctx) => (ctx.prefs.signal_number ? null : "no Signal number"),
    }),
    email: new FakeChannel("email", {
      clock,
      configured: (ctx) => (ctx.prefs.email ? null : "no email address"),
    }),
    // The real voice channel's rules without the TTS: off unless the human turned it on.
    voice: new FakeChannel("voice", {
      clock,
      announce: true,
      configured: (ctx) => (ctx.prefs.voice_alerts ? null : "voice alerts are off"),
    }),
  };
}

export async function world(opts: WorldOptions = {}): Promise<World> {
  const clock = new SimulatedClock(opts.start ?? "2026-10-20T08:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: "j@example.test",
    timezone: opts.timezone ?? "Europe/Zurich",
    notify_prefs: opts.prefs ?? {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 150_000_000,
    locale: "en",
  });
  const emitter = new NotificationEmitter();
  const channels = { ...defaultChannels(clock), ...(opts.channels ?? {}) };
  const events: RecordedEvent[] = [];
  const logs: LogRecord[] = [];
  const stopLogs = Logger.addSink((r) => logs.push(r));
  const notifier = new Notifier({
    clock,
    channels: Object.values(channels),
    humans: store.human,
    audit: store.auditLog,
    events: opts.storeEvents
      ? store.event
      : {
          async append(sessionId, type, payload) {
            events.push({ sessionId, type, payload });
          },
        },
    emitter,
    retry: opts.retry,
    dedupeWindowMs: opts.dedupeWindowMs,
    recentLimit: opts.recentLimit,
  });
  return {
    clock,
    store,
    humanId: human.id,
    emitter,
    channels,
    notifier,
    events,
    logs,
    async close() {
      stopLogs();
      await store.close();
    },
  };
}

/** A notification with sensible defaults; `kind` and `dedupeKey` are what tests vary. */
export function note(humanId: string, over: Partial<Notification> = {}): Notification {
  return {
    kind: "session_ended",
    humanId,
    title: "Session finished: 3 done, 1 needs you",
    body: "Summary of the night.",
    link: "/sessions/s-1",
    dedupeKey: over.dedupeKey ?? `k:${over.kind ?? "session_ended"}`,
    ...over,
  };
}

/** Advance the simulated clock in steps until `p` settles (retries sleep on the clock). */
export async function settle<T>(
  clock: SimulatedClock,
  p: Promise<T>,
  stepMs = 250,
  maxSteps = 400,
): Promise<T> {
  const box: { done: boolean; value?: T; error?: unknown; failed: boolean } = {
    done: false,
    failed: false,
  };
  p.then(
    (v) => {
      box.done = true;
      box.value = v;
    },
    (e) => {
      box.done = true;
      box.failed = true;
      box.error = e;
    },
  );
  for (let i = 0; !box.done && i < maxSteps; i++) await clock.advance(stepMs);
  if (!box.done) throw new Error(`promise did not settle within ${maxSteps * stepMs} ms`);
  if (box.failed) throw box.error;
  return box.value as T;
}

/** Insert an agent and a session for the human so store-backed event rows have a parent. */
export async function sessionFor(w: World): Promise<string> {
  const agent = await w.store.agent.insert({
    name: "Alice",
    owner_human_id: w.humanId,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const session = await w.store.session.insert({ agent_id: agent.id });
  return session.id;
}
