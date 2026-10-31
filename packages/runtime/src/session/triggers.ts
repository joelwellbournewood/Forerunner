import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Clock, errorMessage, join, log } from "@forerunner/platform";
import type { SessionTriggerKind } from "./runner.ts";

/**
 * Session triggers (spec E): manual start, schedule, new message or human answer, CI result,
 * PR comment, verified email, budget reset, remote command from a paired device. The scheduler
 * turns each into a start request and guarantees one active session per agent.
 */
export interface Schedule {
  id: string;
  agentId: string;
  projectId?: string;
  /**
   * "daily" at hh:mm local, "weekdays" at hh:mm local, "every" N minutes, or "monthly" on
   * `dayOfMonth` at hh:mm local (ADR 0060: the critic calibration and the handover test).
   */
  kind: "daily" | "weekdays" | "every" | "monthly";
  time?: string; // hh:mm for daily/weekdays/monthly
  everyMinutes?: number;
  /** 1 to 31 for "monthly"; a day past the month's end fires on its last day. Default 1. */
  dayOfMonth?: number;
  /**
   * "every" only: keep the time of the last firing in the `fired` store (an ISO timestamp), so
   * a restarted daemon waits out the rest of the interval instead of firing at its first tick.
   * The weekly model watch sets it (ADR 0089): one boot a day must not mean one run a day.
   */
  persist?: boolean;
  timezone: string;
  enabled: boolean;
}

export interface StartRequest {
  agentId: string;
  projectId?: string;
  trigger: SessionTriggerKind;
  reason: string;
  /**
   * The approved plan this start runs (spec J.6, J.7; ADR 0053): the `plan_id` of the answered
   * plan request (`plan:<session>#<hash>`, `plan-approval.ts`). The runner runs the plan only
   * while it is still that plan; a bare "approved" is never carried here.
   */
  planApproved?: string;
  /**
   * The session's budget cap; unset, the project's cap applies. A start bound to an approved
   * plan carries the cap of the session that filed it, so the plan is cut as the human saw it.
   */
  budgetUsdMicro?: number;
  /**
   * The answered hooks approval this start acts on (ADR 0088; `late-approval.ts`): a human
   * request a session filed for a tool call of its task and answered after that session
   * ended. A start that fails after the scheduler took it is reported on that request
   * (`start_failed`, one warning) rather than lost.
   */
  approvalRequestId?: string;
}

export interface SchedulerDeps {
  clock: Clock;
  /** Starts a session and resolves when it ends. Throws claim_conflict when one is active. */
  start: (req: StartRequest) => Promise<unknown>;
  /** Quiet hours: when true, non-manual triggers are deferred to the next check. */
  isQuietHours?: (agentId: string, now: number) => boolean;
  /**
   * Where the last fired day (daily, weekdays) or month (monthly) of each schedule is kept.
   * Default: this process's memory. The daemon passes `fileFiredKeys` under its data
   * directory so a restart after the due time does not fire a day's or a month's job again
   * (ADR 0060: a monthly calibration costs money on a live model).
   */
  fired?: FiredKeys;
  /**
   * Runs before every tick: re-reads the settings that decide which schedules exist (the
   * handover per project, the calibration), so a change made by a route, a command or the
   * phone takes effect at the next tick without a restart. An error is logged, never fatal.
   */
  refresh?: (scheduler: Scheduler) => Promise<void>;
}

/** The last day or month key a schedule fired on, by schedule id. */
export interface FiredKeys {
  get(id: string): string | undefined;
  set(id: string, key: string): void;
}

export function memoryFiredKeys(): FiredKeys {
  const map = new Map<string, string>();
  return { get: (id) => map.get(id), set: (id, key) => void map.set(id, key) };
}

/**
 * Fired keys in one JSON file (`<data dir>/scheduler-fired.json`): read on first use, written
 * on every set. A missing or unreadable file is an empty store and a failed write is logged;
 * the schedule then behaves as it did before (once per process).
 */
export function fileFiredKeys(file: string): FiredKeys {
  const logger = log("scheduler");
  let map: Map<string, string> | null = null;
  const load = (): Map<string, string> => {
    if (map) return map;
    map = new Map();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
          if (typeof v === "string") map.set(k, v);
      }
    } catch {
      // absent or malformed: start empty
    }
    return map;
  };
  return {
    get: (id) => load().get(id),
    set: (id, key) => {
      const m = load();
      m.set(id, key);
      try {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, `${JSON.stringify(Object.fromEntries(m), null, 2)}\n`, "utf8");
      } catch (e) {
        logger.warn("could not write the fired keys", { file, error: errorMessage(e) });
      }
    },
  };
}

/** Local wall-clock parts in a time zone, without a date library. */
export function localParts(
  nowMs: number,
  timezone: string,
): {
  hour: number;
  minute: number;
  weekday: number;
  dayKey: string;
  /** Day of the month, 1 to 31. */
  day: number;
  /** `YYYY-MM` in the zone: the dedupe key of a monthly schedule. */
  monthKey: string;
  daysInMonth: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = Number(parts.hour) % 24;
  const year = Number(parts.year);
  const month = Number(parts.month);
  return {
    hour,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    day: Number(parts.day),
    monthKey: `${parts.year}-${parts.month}`,
    // Day 0 of the next month is the last day of this one (UTC arithmetic on the calendar
    // only; the zone decided year and month above).
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

export interface SchedulerLogEntry {
  /**
   * The identity of the start request: one id from the request through the queue (queued or
   * deferred, then started when the queue drains) to its end. The command registry's
   * `session.start` records it in its change log row (`after.start_id`), so the undo of a
   * start is the undo of that start and never of a later one of the same agent.
   */
  id: string;
  at: string;
  req: StartRequest;
  result: "started" | "queued" | "deferred" | "cancelled" | "error";
  detail?: string;
}

/**
 * Two waiting requests that would do the same work (U-043): the same agent, project, trigger,
 * approved plan, answered approval and cap. The reason is a description and does not count.
 */
function sameStart(a: StartRequest, b: StartRequest): boolean {
  return (
    a.agentId === b.agentId &&
    a.projectId === b.projectId &&
    a.trigger === b.trigger &&
    a.planApproved === b.planApproved &&
    a.approvalRequestId === b.approvalRequestId &&
    a.budgetUsdMicro === b.budgetUsdMicro
  );
}

/** What `request` answers: the start ran, waits behind a running session, or waits for daytime. */
export type StartOutcome = "started" | "queued" | "deferred";

/** How a start's run ended: it returned, or the error that ended it (logged as `error`). */
export type StartRunOutcome = { ok: true } | { ok: false; error: unknown };

/** How many recent runs `runOutcome` remembers. */
const RUN_OUTCOMES_KEPT = 50;

/** The log entry of a request just made (`requestStart`): never cancelled or in error yet. */
export interface StartEntry extends SchedulerLogEntry {
  result: StartOutcome;
}

export class Scheduler {
  private readonly schedules = new Map<string, Schedule>();
  /**
   * Last fired day (daily, weekdays) or month (monthly) per schedule id, and the last firing
   * time of an "every" schedule with `persist`.
   */
  private readonly fired: FiredKeys;
  private readonly lastEvery = new Map<string, number>();
  private readonly active = new Set<string>();
  /** The log entry of the start each active agent is running, until it ends. */
  private readonly activeStarts = new Map<string, SchedulerLogEntry>();
  /**
   * The requests waiting per agent (queued behind its running session or deferred by quiet
   * hours), first come first, each as its log entry so the id follows it (U-043: one slot per
   * agent used to hold only the newest, so an approved plan's start or a CI trigger waiting
   * there was replaced by the next request without a word).
   */
  private readonly pending = new Map<string, SchedulerLogEntry[]>();
  /** How the runs of the most recent starts ended, by start id (`runOutcome`). */
  private readonly runs = new Map<string, Promise<StartRunOutcome>>();
  private cancel: (() => void) | null = null;
  private readonly logger = log("scheduler");
  readonly log: SchedulerLogEntry[] = [];

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly tickMs = 30_000,
  ) {
    this.fired = deps.fired ?? memoryFiredKeys();
  }

  add(s: Schedule): void {
    this.schedules.set(s.id, s);
  }
  remove(id: string): void {
    this.schedules.delete(id);
  }
  list(): Schedule[] {
    return [...this.schedules.values()];
  }

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      try {
        await this.tick();
      } catch (e) {
        this.logger.error("tick failed", { error: errorMessage(e) });
      }
      this.cancel = this.deps.clock.setTimeout(tick, this.tickMs);
    };
    this.cancel = this.deps.clock.setTimeout(tick, this.tickMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Evaluate schedules once. Exposed for tests and for the app's manual "check now". */
  async tick(now: number = this.deps.clock.now()): Promise<void> {
    if (this.deps.refresh) {
      try {
        await this.deps.refresh(this);
      } catch (e) {
        this.logger.warn("schedule refresh failed", { error: errorMessage(e) });
      }
    }
    for (const s of this.schedules.values()) {
      if (!s.enabled) continue;
      if (s.kind === "every") {
        let last = this.lastEvery.get(s.id) ?? this.persistedEvery(s);
        if (last > now) {
          // A last run in the future (the clock was corrected back): clamp it to now, so the
          // schedule waits one interval from here instead of never firing or firing at once.
          last = now;
          this.lastEvery.set(s.id, now);
          if (s.persist) this.fired.set(s.id, new Date(now).toISOString());
        }
        if (now - last >= (s.everyMinutes ?? 60) * 60_000) {
          this.lastEvery.set(s.id, now);
          if (s.persist) this.fired.set(s.id, new Date(now).toISOString());
          await this.request({
            agentId: s.agentId,
            projectId: s.projectId,
            trigger: "schedule",
            reason: `every ${s.everyMinutes} min`,
          });
        }
        continue;
      }
      const lp = localParts(now, s.timezone);
      if (s.kind === "weekdays" && (lp.weekday === 0 || lp.weekday === 6)) continue;
      const [hh, mm] = (s.time ?? "06:00").split(":").map(Number);
      const timePassed = lp.hour > (hh ?? 0) || (lp.hour === (hh ?? 0) && lp.minute >= (mm ?? 0));
      if (s.kind === "monthly") {
        // The due day, clamped to the month's length; once per month however often we tick
        // (or restart, with a persistent `fired` store).
        const day = Math.min(Math.max(1, Math.trunc(s.dayOfMonth ?? 1)), lp.daysInMonth);
        const due = lp.day > day || (lp.day === day && timePassed);
        const last = this.fired.get(s.id);
        if (last === undefined) {
          // First sight of the schedule (a new install, a job just switched on). After its day
          // this month: wait for the next month rather than run (and spend) at once; `fr jobs`
          // runs it by hand. Before its day, or on it: remember the sighting ("" is "seen,
          // never fired"), so a daemon that is then down on the day catches up afterwards.
          if (lp.day > day) {
            this.fired.set(s.id, lp.monthKey);
            continue;
          }
          if (!due) {
            this.fired.set(s.id, "");
            continue;
          }
        }
        if (due && last !== lp.monthKey) {
          this.fired.set(s.id, lp.monthKey);
          await this.request({
            agentId: s.agentId,
            projectId: s.projectId,
            trigger: "schedule",
            reason: `monthly on day ${s.dayOfMonth ?? 1} at ${s.time ?? "06:00"} ${s.timezone}`,
          });
        }
        continue;
      }
      if (timePassed && this.fired.get(s.id) !== lp.dayKey) {
        this.fired.set(s.id, lp.dayKey);
        await this.request({
          agentId: s.agentId,
          projectId: s.projectId,
          trigger: "schedule",
          reason: `${s.kind} at ${s.time} ${s.timezone}`,
        });
      }
    }
    // Drain: an agent that is now free starts its first waiting request that may start now (a
    // start deferred by quiet hours keeps its place while they last and holds up no one behind
    // it); the rest wait their turn. A drained request keeps its id.
    for (const [agentId, waiting] of [...this.pending]) {
      if (this.active.has(agentId)) continue;
      const next = waiting.find((e) => !this.deferredNow(e.req, now));
      if (!next) continue;
      this.removePending(agentId, next.id);
      await this.requestStart(next.req, now, next.id);
    }
  }

  /** True while quiet hours hold a non-manual start back. */
  private deferredNow(req: StartRequest, now: number): boolean {
    return req.trigger !== "manual" && (this.deps.isQuietHours?.(req.agentId, now) ?? false);
  }

  /**
   * Put a request at the end of the agent's waiting line, unless the same automatic start
   * already waits there (the same project, trigger, approved plan, answered approval and cap):
   * then that one answers for both and the log records it, since running the same work twice
   * in a row does nothing more. A person's own start is always kept.
   */
  private enqueue(entry: StartEntry): StartEntry {
    const line = this.pending.get(entry.req.agentId) ?? [];
    const same =
      entry.req.trigger === "manual" ? undefined : line.find((e) => sameStart(e.req, entry.req));
    if (same) {
      this.log.push({
        id: same.id,
        at: entry.at,
        req: entry.req,
        result: same.result === "deferred" ? "deferred" : "queued",
        detail: "asked again while it waits; it runs once",
      });
      return { ...same, result: same.result === "deferred" ? "deferred" : "queued" };
    }
    line.push(entry);
    this.pending.set(entry.req.agentId, line);
    this.log.push(entry);
    return entry;
  }

  private removePending(agentId: string, startId: string): SchedulerLogEntry | undefined {
    const line = this.pending.get(agentId);
    const at = line?.findIndex((e) => e.id === startId) ?? -1;
    if (!line || at < 0) return undefined;
    const [removed] = line.splice(at, 1);
    if (line.length === 0) this.pending.delete(agentId);
    return removed;
  }

  /** External triggers call this: message, human answer, CI, PR comment, email, remote, manual. */
  async request(req: StartRequest, now: number = this.deps.clock.now()): Promise<StartOutcome> {
    return (await this.requestStart(req, now)).result;
  }

  /**
   * `request` with the log entry it made, whose `id` names the start from now on (the entry
   * `activeStart` or `pendingStart` answers with carries the same id until the start ends).
   */
  async requestStart(
    req: StartRequest,
    now: number = this.deps.clock.now(),
    id: string = randomUUID(),
  ): Promise<StartEntry> {
    const at = new Date(now).toISOString();
    if (this.deferredNow(req, now)) {
      return this.enqueue({ id, at, req, result: "deferred", detail: "quiet hours" });
    }
    if (this.active.has(req.agentId)) {
      // One active session per agent; the request waits its turn behind the ones already
      // waiting (U-043), and runs when the session before it ends.
      return this.enqueue({ id, at, req, result: "queued" });
    }
    this.active.add(req.agentId);
    const entry: StartEntry = { id, at, req, result: "started" };
    this.log.push(entry);
    this.activeStarts.set(req.agentId, entry);
    const run = this.deps
      .start(req)
      .then(
        (): StartRunOutcome => ({ ok: true }),
        (e: unknown): StartRunOutcome => {
          this.log.push({
            id,
            at: new Date(this.deps.clock.now()).toISOString(),
            req,
            result: "error",
            detail: errorMessage(e),
          });
          return { ok: false, error: e };
        },
      )
      .finally(() => {
        this.active.delete(req.agentId);
        if (this.activeStarts.get(req.agentId) === entry) this.activeStarts.delete(req.agentId);
      });
    this.runs.set(id, run);
    for (const old of this.runs.keys()) {
      if (this.runs.size <= RUN_OUTCOMES_KEPT) break;
      this.runs.delete(old);
    }
    return entry;
  }

  /**
   * How the run of a start ended, for a caller that waits on it (`POST /sessions` answers a
   * start whose run failed before its session began with that error). Undefined for a start
   * that has not run (queued or deferred) or one older than the last 50.
   */
  runOutcome(startId: string): Promise<StartRunOutcome> | undefined {
    return this.runs.get(startId);
  }

  /** The persisted last firing of an "every" schedule; never fired (or unreadable) is -Infinity. */
  private persistedEvery(s: Schedule): number {
    if (!s.persist) return Number.NEGATIVE_INFINITY;
    const raw = this.fired.get(s.id);
    const at = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  /**
   * The start the agent is running now (its log entry, the same object `log` holds), or
   * undefined when nothing runs. The registry's session ports compare its `id` with the one
   * their change log row recorded to tell "that start's session still runs" from "a later
   * session of the agent runs".
   */
  activeStart(agentId: string): SchedulerLogEntry | undefined {
    return this.activeStarts.get(agentId);
  }

  /**
   * The first request waiting for the agent (queued behind an active session or deferred by
   * quiet hours); `pendingStarts` lists them all.
   */
  pendingFor(agentId: string): StartRequest | undefined {
    return this.pending.get(agentId)?.[0]?.req;
  }

  /** The first waiting request as its log entry (its `id` is the start's identity). */
  pendingStart(agentId: string): SchedulerLogEntry | undefined {
    return this.pending.get(agentId)?.[0];
  }

  /** Every request waiting for the agent, in the order they will start (U-043). */
  pendingStarts(agentId: string): SchedulerLogEntry[] {
    return [...(this.pending.get(agentId) ?? [])];
  }

  /**
   * How many waiting starts come before this one (0: it starts when the running session ends),
   * or undefined when it is not waiting.
   */
  waitingAhead(agentId: string, startId: string): number | undefined {
    const at = this.pending.get(agentId)?.findIndex((e) => e.id === startId) ?? -1;
    return at < 0 ? undefined : at;
  }

  /**
   * Drop a waiting request of the agent (the undo of a start that only queued): the one
   * `startId` names, else the first. Nothing running is touched and the others keep their
   * order. Returns the dropped request, or undefined when it was not waiting.
   */
  cancelPending(agentId: string, reason = "cancelled", startId?: string): StartRequest | undefined {
    const id = startId ?? this.pending.get(agentId)?.[0]?.id;
    const waiting = id === undefined ? undefined : this.removePending(agentId, id);
    if (!waiting) return undefined;
    this.log.push({
      id: waiting.id,
      at: new Date(this.deps.clock.now()).toISOString(),
      req: waiting.req,
      result: "cancelled",
      detail: reason,
    });
    return waiting.req;
  }
}
