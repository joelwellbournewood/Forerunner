import { randomUUID } from "node:crypto";
import { type Clock, errorMessage, log } from "@forerunner/platform";
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
  /** "daily" at hh:mm local, "weekdays" at hh:mm local, or "every" N minutes. */
  kind: "daily" | "weekdays" | "every";
  time?: string; // hh:mm for daily/weekdays
  everyMinutes?: number;
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
}

export interface SchedulerDeps {
  clock: Clock;
  /** Starts a session and resolves when it ends. Throws claim_conflict when one is active. */
  start: (req: StartRequest) => Promise<unknown>;
  /** Quiet hours: when true, non-manual triggers are deferred to the next check. */
  isQuietHours?: (agentId: string, now: number) => boolean;
}

/** Local wall-clock parts in a time zone, without a date library. */
export function localParts(
  nowMs: number,
  timezone: string,
): { hour: number; minute: number; weekday: number; dayKey: string } {
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
  return {
    hour,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
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

/** What `request` answers: the start ran, waits behind a running session, or waits for daytime. */
export type StartOutcome = "started" | "queued" | "deferred";

/** The log entry of a request just made (`requestStart`): never cancelled or in error yet. */
export interface StartEntry extends SchedulerLogEntry {
  result: StartOutcome;
}

export class Scheduler {
  private readonly schedules = new Map<string, Schedule>();
  private readonly firedDay = new Map<string, string>();
  private readonly lastEvery = new Map<string, number>();
  private readonly active = new Set<string>();
  /** The log entry of the start each active agent is running, until it ends. */
  private readonly activeStarts = new Map<string, SchedulerLogEntry>();
  /** The request waiting per agent (queued or deferred), as its log entry so the id follows it. */
  private readonly pending = new Map<string, SchedulerLogEntry>();
  private cancel: (() => void) | null = null;
  private readonly logger = log("scheduler");
  readonly log: SchedulerLogEntry[] = [];

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly tickMs = 30_000,
  ) {}

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
    for (const s of this.schedules.values()) {
      if (!s.enabled) continue;
      if (s.kind === "every") {
        const last = this.lastEvery.get(s.id) ?? Number.NEGATIVE_INFINITY;
        if (now - last >= (s.everyMinutes ?? 60) * 60_000) {
          this.lastEvery.set(s.id, now);
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
      const due = lp.hour > (hh ?? 0) || (lp.hour === (hh ?? 0) && lp.minute >= (mm ?? 0));
      if (due && this.firedDay.get(s.id) !== lp.dayKey) {
        this.firedDay.set(s.id, lp.dayKey);
        await this.request({
          agentId: s.agentId,
          projectId: s.projectId,
          trigger: "schedule",
          reason: `${s.kind} at ${s.time} ${s.timezone}`,
        });
      }
    }
    // Drain queued requests for agents that are now free; a drained request keeps its id.
    for (const [agentId, waiting] of [...this.pending]) {
      if (!this.active.has(agentId)) {
        this.pending.delete(agentId);
        await this.requestStart(waiting.req, undefined, waiting.id);
      }
    }
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
    if (req.trigger !== "manual" && this.deps.isQuietHours?.(req.agentId, now)) {
      const deferred: StartEntry = { id, at, req, result: "deferred", detail: "quiet hours" };
      this.pending.set(req.agentId, deferred);
      this.log.push(deferred);
      return deferred;
    }
    if (this.active.has(req.agentId)) {
      // One active session per agent; the newest request wins the queue slot (the next session
      // reads the inbox anyway, so nothing is lost).
      const queued: StartEntry = { id, at, req, result: "queued" };
      this.pending.set(req.agentId, queued);
      this.log.push(queued);
      return queued;
    }
    this.active.add(req.agentId);
    const entry: StartEntry = { id, at, req, result: "started" };
    this.log.push(entry);
    this.activeStarts.set(req.agentId, entry);
    void this.deps
      .start(req)
      .catch((e) => {
        this.log.push({
          id,
          at: new Date(this.deps.clock.now()).toISOString(),
          req,
          result: "error",
          detail: errorMessage(e),
        });
      })
      .finally(() => {
        this.active.delete(req.agentId);
        if (this.activeStarts.get(req.agentId) === entry) this.activeStarts.delete(req.agentId);
      });
    return entry;
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

  /** The request waiting for the agent (queued behind an active session or deferred by quiet hours). */
  pendingFor(agentId: string): StartRequest | undefined {
    return this.pending.get(agentId)?.req;
  }

  /** The waiting request as its log entry (its `id` is the start's identity). */
  pendingStart(agentId: string): SchedulerLogEntry | undefined {
    return this.pending.get(agentId);
  }

  /**
   * Drop the agent's waiting request (the undo of a start that only queued): nothing running
   * is touched. Returns the dropped request, or undefined when none was waiting.
   */
  cancelPending(agentId: string, reason = "cancelled"): StartRequest | undefined {
    const waiting = this.pending.get(agentId);
    if (!waiting) return undefined;
    this.pending.delete(agentId);
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
