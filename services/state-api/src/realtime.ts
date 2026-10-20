import { randomBytes } from "node:crypto";
import { type Clock, log } from "@forerunner/platform";
import type { JsonObject, Row, StateStore } from "@forerunner/state";
import pg from "pg";

/**
 * Realtime (spec F: "realtime push when both are online; polling fallback").
 *
 * Three parts, composed by createApp():
 * - `ChangeBus`: in-process fan-out with a ring buffer so an SSE client can resume from
 *   `Last-Event-ID`.
 * - `PostgresNotifier`: after the service's own writes it issues NOTIFY on a per-schema
 *   channel; a dedicated LISTEN connection ingests what other service instances (or a
 *   runtime that chooses to NOTIFY) publish. packages/state is not changed: no triggers.
 * - `ChangePoller`: every 2 s it reads rows whose `updated_at` moved past a high-water mark
 *   per table, so writes made directly through @forerunner/state by the PCs and the cloud
 *   runner are seen too. Rows are de-duplicated by (table, id, version) with the bus, so a
 *   write the service made itself is not announced twice.
 */
export type ChangeType =
  | "message.changed"
  | "human_request.changed"
  | "task.changed"
  | "milestone.changed"
  | "project.changed"
  | "session.changed"
  | "session.event"
  | "remote_command.changed"
  | "queue_item.changed"
  | "decision.changed"
  | "review.changed"
  | "finding.changed"
  | "device.changed"
  | "cost_ledger.changed";

export interface ChangeEvent {
  /** Process-local, strictly increasing; doubles as the SSE id. */
  seq: number;
  type: ChangeType;
  at: string;
  /** The human this concerns; null means everyone with access to the project. */
  humanId: string | null;
  projectId: string | null;
  sessionId: string | null;
  payload: JsonObject;
  /** Instance that first saw the change (for de-duplication across instances). */
  origin: string;
}

export type ChangeInput = Omit<ChangeEvent, "seq" | "at" | "origin">;
export type ChangeListener = (event: ChangeEvent) => void;
export type ChangeFilter = (event: ChangeEvent) => boolean;

const logger = log("state-api:realtime");

/** Bounded set of "<table>:<id>:<version>" keys already announced. */
class SeenKeys {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 20_000) {}
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.order.push(key);
    while (this.order.length > this.max) {
      const old = this.order.shift();
      if (old) this.keys.delete(old);
    }
    return true;
  }
  has(key: string): boolean {
    return this.keys.has(key);
  }
}

export function changeKey(table: string, id: string, version: number | string): string {
  return `${table}:${id}:${version}`;
}

/** The table a change type describes ("session.event" rows live in "event"). */
export function tableOf(type: ChangeType): string {
  return type === "session.event" ? "event" : type.replace(/\.changed$/, "");
}

export class ChangeBus {
  readonly instanceId: string;
  private seq = 0;
  private readonly buffer: ChangeEvent[] = [];
  private readonly listeners = new Set<ChangeListener>();
  private readonly forwarders = new Set<ChangeListener>();
  private readonly seen = new SeenKeys();

  constructor(
    private readonly clock: Clock,
    private readonly bufferSize = 2_000,
    instanceId?: string,
  ) {
    this.instanceId = instanceId ?? randomBytes(6).toString("hex");
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Mark a row version as announced; returns false when it was already known. */
  markSeen(table: string, id: string, version: number | string): boolean {
    return this.seen.add(changeKey(table, id, version));
  }

  hasSeen(table: string, id: string, version: number | string): boolean {
    return this.seen.has(changeKey(table, id, version));
  }

  /** Publish a local change: buffered, delivered to subscribers and handed to forwarders (NOTIFY). */
  publish(input: ChangeInput): ChangeEvent {
    this.remember(input);
    const event = this.deliver({ ...input, origin: this.instanceId });
    for (const f of this.forwarders) {
      try {
        f(event);
      } catch (e) {
        logger.warn("forwarder failed", { error: String(e) });
      }
    }
    return event;
  }

  /** Ingest a change announced by another instance (never forwarded again). */
  ingest(remote: Omit<ChangeEvent, "seq">): ChangeEvent | undefined {
    if (remote.origin === this.instanceId) return undefined;
    if (!this.remember(remote)) return undefined;
    return this.deliver(remote);
  }

  /** Mark the row version behind an event as seen; false when it was already announced. */
  private remember(e: Pick<ChangeEvent, "type" | "payload">): boolean {
    const id = e.payload.id;
    const version = e.payload.version;
    if (typeof id === "string" && (typeof version === "number" || typeof version === "string")) {
      return this.markSeen(tableOf(e.type), id, version);
    }
    return true;
  }

  private deliver(e: Omit<ChangeEvent, "seq" | "at"> & { at?: string }): ChangeEvent {
    const event: ChangeEvent = { ...e, seq: ++this.seq, at: e.at || this.clock.nowIso() };
    this.buffer.push(event);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        logger.warn("listener failed", { error: String(err) });
      }
    }
    return event;
  }

  subscribe(listener: ChangeListener, filter?: ChangeFilter): () => void {
    const wrapped: ChangeListener = filter ? (e) => filter(e) && listener(e) : listener;
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  /** Called for every locally published event (the NOTIFY bridge registers here). */
  onPublish(forwarder: ChangeListener): () => void {
    this.forwarders.add(forwarder);
    return () => this.forwarders.delete(forwarder);
  }

  /**
   * Events after `afterSeq` that pass `filter`, or undefined when `afterSeq` is older than
   * the buffer (the client must reload its state).
   */
  since(afterSeq: number, filter: ChangeFilter = () => true): ChangeEvent[] | undefined {
    const oldest = this.buffer[0];
    if (afterSeq > this.seq) return [];
    if (oldest && afterSeq < oldest.seq - 1) return undefined;
    return this.buffer.filter((e) => e.seq > afterSeq && filter(e));
  }

  subscriberCount(): number {
    return this.listeners.size;
  }
}

// ---------------------------------------------------------------------------------------
// Postgres LISTEN / NOTIFY bridge
// ---------------------------------------------------------------------------------------

export const NOTIFY_CHANNEL_PREFIX = "forerunner_changes";

export function notifyChannel(schema: string | undefined): string {
  return schema ? `${NOTIFY_CHANNEL_PREFIX}_${schema}` : NOTIFY_CHANNEL_PREFIX;
}

export interface PostgresNotifierOptions {
  url: string;
  schema?: string;
  store: StateStore;
  bus: ChangeBus;
  clock: Clock;
  /** Reconnect delay after the LISTEN connection drops. Default 2 s, doubling to 30 s. */
  reconnectMs?: number;
}

export class PostgresNotifier {
  private client: pg.Client | undefined;
  private stopped = false;
  private unforward: (() => void) | undefined;
  private backoff: number;
  readonly channel: string;
  private readonly pendingPublishes = new Set<Promise<void>>();

  constructor(private readonly opts: PostgresNotifierOptions) {
    this.channel = notifyChannel(opts.schema);
    this.backoff = opts.reconnectMs ?? 2_000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unforward = this.opts.bus.onPublish((e) => {
      const p = this.notify(e).catch((err) =>
        logger.warn("notify failed", { error: String(err), channel: this.channel }),
      );
      this.pendingPublishes.add(p);
      p.finally(() => this.pendingPublishes.delete(p));
    });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.opts.url });
    client.on("notification", (msg) => this.onNotification(msg.payload));
    client.on("error", (e) => {
      logger.warn("listen connection error", { error: e.message });
      this.scheduleReconnect();
    });
    client.on("end", () => {
      if (!this.stopped) this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN "${this.channel}"`);
      this.client = client;
      this.backoff = this.opts.reconnectMs ?? 2_000;
      logger.info("listening", { channel: this.channel });
    } catch (e) {
      logger.warn("listen connect failed", { error: String(e) });
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(30_000, this.backoff * 2);
    this.client = undefined;
    this.opts.clock.setTimeout(() => {
      this.connect().catch(() => undefined);
    }, delay);
  }

  private onNotification(payload: string | undefined): void {
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload) as Omit<ChangeEvent, "seq">;
      if (typeof parsed.type !== "string" || typeof parsed.origin !== "string") return;
      this.opts.bus.ingest({
        type: parsed.type,
        at: typeof parsed.at === "string" ? parsed.at : this.opts.clock.nowIso(),
        humanId: typeof parsed.humanId === "string" ? parsed.humanId : null,
        projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {},
        origin: parsed.origin,
      });
    } catch (e) {
      logger.warn("bad notification payload", { error: String(e) });
    }
  }

  /** NOTIFY payloads are capped at 8000 bytes; events carry ids and versions only. */
  private async notify(e: ChangeEvent): Promise<void> {
    const { seq: _seq, ...rest } = e;
    const text = JSON.stringify(rest);
    if (Buffer.byteLength(text) > 7_900) return;
    await this.opts.store.db.query("SELECT pg_notify(?, ?)", [this.channel, text]);
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unforward?.();
    await Promise.allSettled([...this.pendingPublishes]);
    const c = this.client;
    this.client = undefined;
    if (c) await c.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------------------

interface WatchedTable {
  table: string;
  type: ChangeType;
  /** Column holding the change time ("updated_at" for envelope tables, "created_at" for append-only). */
  column: "updated_at" | "created_at";
}

const WATCHED: readonly WatchedTable[] = [
  { table: "message", type: "message.changed", column: "updated_at" },
  { table: "human_request", type: "human_request.changed", column: "updated_at" },
  { table: "task", type: "task.changed", column: "updated_at" },
  { table: "milestone", type: "milestone.changed", column: "updated_at" },
  { table: "project", type: "project.changed", column: "updated_at" },
  { table: "session", type: "session.changed", column: "updated_at" },
  { table: "remote_command", type: "remote_command.changed", column: "updated_at" },
  { table: "queue_item", type: "queue_item.changed", column: "updated_at" },
  { table: "decision", type: "decision.changed", column: "updated_at" },
  { table: "review", type: "review.changed", column: "updated_at" },
  { table: "finding", type: "finding.changed", column: "updated_at" },
  { table: "device", type: "device.changed", column: "updated_at" },
  { table: "event", type: "session.event", column: "created_at" },
];

const POLL_LIMIT = 500;

export interface ChangePollerOptions {
  store: StateStore;
  bus: ChangeBus;
  clock: Clock;
  intervalMs: number;
  /** Start reading from this time instead of "now" (tests). */
  since?: string;
  /** Called after every pass (scheduled or `pollOnce`); the service sweeps its limiters here. */
  onTick?: () => void;
}

/**
 * Reads rows changed since the last poll and announces them. The human an event concerns is
 * derived per table (message addressee or the addressee agent's owner, request human,
 * remote command issuer's owner); other tables are project-wide.
 */
export class ChangePoller {
  private readonly marks = new Map<string, string>();
  private cancel: (() => void) | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;
  private readonly agentOwner = new Map<string, string>();
  private readonly deviceOwner = new Map<string, string>();
  polls = 0;

  constructor(private readonly opts: ChangePollerOptions) {
    const start = opts.since ?? opts.clock.nowIso();
    for (const w of WATCHED) this.marks.set(w.table, start);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.pollOnce()
        .catch((e) => logger.warn("poll failed", { error: String(e) }))
        .finally(() => {
          if (this.running) this.cancel = this.opts.clock.setTimeout(tick, this.opts.intervalMs);
        });
    };
    this.cancel = this.opts.clock.setTimeout(tick, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.cancel?.();
    this.cancel = undefined;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /** One pass over every watched table. Safe to call directly (tests, admin "sync now"). */
  pollOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    this.polls += 1;
    for (const w of WATCHED) {
      const mark = this.marks.get(w.table) ?? this.opts.clock.nowIso();
      const rows = await this.opts.store.db.query<Row>(
        `SELECT * FROM "${w.table}" WHERE "${w.column}" >= ? ORDER BY "${w.column}", "id" LIMIT ?`,
        [mark, POLL_LIMIT],
      );
      let newest = mark;
      for (const row of rows) {
        const id = String(row.id);
        const version = row.version === undefined ? "1" : String(row.version);
        const at = String(row[w.column] ?? mark);
        if (at > newest) newest = at;
        if (!this.opts.bus.markSeen(w.table, id, version)) continue;
        const event = await this.describe(w, row, id, Number(version));
        this.opts.bus.publish(event);
      }
      this.marks.set(w.table, newest);
    }
    try {
      this.opts.onTick?.();
    } catch (e) {
      logger.warn("tick hook failed", { error: String(e) });
    }
  }

  private async ownerOfAgent(agentId: string): Promise<string | null> {
    const cached = this.agentOwner.get(agentId);
    if (cached) return cached;
    const agent = await this.opts.store.agent.get(agentId);
    if (!agent) return null;
    this.agentOwner.set(agentId, agent.owner_human_id);
    return agent.owner_human_id;
  }

  private async ownerOfDevice(deviceId: string): Promise<string | null> {
    const cached = this.deviceOwner.get(deviceId);
    if (cached) return cached;
    const device = await this.opts.store.device.get(deviceId);
    if (!device) return null;
    this.deviceOwner.set(deviceId, device.owner_human_id);
    return device.owner_human_id;
  }

  private async describe(
    w: WatchedTable,
    row: Row,
    id: string,
    version: number,
  ): Promise<ChangeInput> {
    const str = (k: string): string | null =>
      typeof row[k] === "string" ? (row[k] as string) : null;
    let humanId: string | null = null;
    let projectId = str("project_id");
    let sessionId: string | null = null;
    const payload: JsonObject = { id, version };
    switch (w.table) {
      case "message":
        humanId =
          str("to_human_id") ??
          (str("to_agent_id") ? await this.ownerOfAgent(str("to_agent_id") as string) : null);
        payload.toAgentId = str("to_agent_id");
        payload.toHumanId = str("to_human_id");
        payload.type = str("type");
        break;
      case "human_request":
        humanId = str("human_id");
        payload.status = str("status");
        payload.blocking = row.blocking === true || row.blocking === 1;
        break;
      case "remote_command":
        humanId = str("device_id") ? await this.ownerOfDevice(str("device_id") as string) : null;
        payload.status = str("status");
        payload.target = str("target");
        break;
      case "device":
        humanId = str("owner_human_id");
        payload.revoked = row.revoked === true || row.revoked === 1;
        break;
      case "queue_item":
        humanId = str("human_id");
        payload.status = str("status");
        break;
      case "session":
        sessionId = id;
        payload.status = str("status");
        payload.agentId = str("agent_id");
        break;
      case "event":
        sessionId = str("session_id");
        payload.seq = Number(row.seq ?? 0);
        payload.type = str("type");
        break;
      case "task":
        payload.status = str("status");
        payload.claimedBy = str("claimed_by");
        break;
      case "project":
        projectId = id;
        break;
      case "cost_ledger":
        humanId = str("human_id");
        break;
      default:
        break;
    }
    return { type: w.type, humanId, projectId, sessionId, payload };
  }
}

/** Filter for a device stream: events for its human, plus project-wide ones. */
export function filterForHuman(humanId: string | null): ChangeFilter {
  return (e) => humanId === null || e.humanId === null || e.humanId === humanId;
}
