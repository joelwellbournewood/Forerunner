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

export class Scheduler {
  private readonly schedules = new Map<string, Schedule>();
  private readonly firedDay = new Map<string, string>();
  private readonly lastEvery = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, StartRequest>();
  private cancel: (() => void) | null = null;
  private readonly logger = log("scheduler");
  readonly log: {
    at: string;
    req: StartRequest;
    result: "started" | "queued" | "deferred" | "error";
    detail?: string;
  }[] = [];

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
    // Drain queued requests for agents that are now free.
    for (const [agentId, req] of [...this.pending]) {
      if (!this.active.has(agentId)) {
        this.pending.delete(agentId);
        await this.request(req);
      }
    }
  }

  /** External triggers call this: message, human answer, CI, PR comment, email, remote, manual. */
  async request(
    req: StartRequest,
    now: number = this.deps.clock.now(),
  ): Promise<"started" | "queued" | "deferred"> {
    const at = new Date(now).toISOString();
    if (req.trigger !== "manual" && this.deps.isQuietHours?.(req.agentId, now)) {
      this.pending.set(req.agentId, req);
      this.log.push({ at, req, result: "deferred", detail: "quiet hours" });
      return "deferred";
    }
    if (this.active.has(req.agentId)) {
      // One active session per agent; the newest request wins the queue slot (the next session
      // reads the inbox anyway, so nothing is lost).
      this.pending.set(req.agentId, req);
      this.log.push({ at, req, result: "queued" });
      return "queued";
    }
    this.active.add(req.agentId);
    this.log.push({ at, req, result: "started" });
    void this.deps
      .start(req)
      .catch((e) => {
        this.log.push({
          at: new Date(this.deps.clock.now()).toISOString(),
          req,
          result: "error",
          detail: errorMessage(e),
        });
      })
      .finally(() => {
        this.active.delete(req.agentId);
      });
    return "started";
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }
}
