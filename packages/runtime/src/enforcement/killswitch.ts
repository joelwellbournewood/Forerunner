import type { ChildProcess } from "node:child_process";
import { ForerunnerError, killTree, log } from "@forerunner/platform";
import type { TokenIssuer } from "./token.ts";

/**
 * Global and per-scope stop. Terminates every registered run (abort signals), every child
 * process tree, revokes run tokens and asks the state layer to freeze claims. Target: under 2 s.
 */
export interface KillScope {
  agentId?: string;
  sessionId?: string;
}

interface Registration {
  id: number;
  agentId: string;
  sessionId: string;
  /**
   * The task the run works on (a specialist's run, the session runner's own hold on the task):
   * `stopTask` ends exactly these when a person moves the task while it runs (U-039).
   */
  taskId?: string;
  controller?: AbortController;
  child?: ChildProcess;
  label: string;
  /** The human's own channel (conversation): never stopped, never frozen. */
  protected?: boolean;
}

/**
 * Whose stop a kill switch stop is (core-experience design §4.9): the person's Stop now
 * (`you`: a session page's Stop now, the phone's stop, the chat's stop of one session), Stop
 * all (`stop_all`: the header, the tray, `fr kill`, a kill from the phone, the chat's stop of
 * the agent; it freezes) or Quit (`quit`). The place that asks for the stop names it; the run
 * reads it from its abort signal (`stopByOf`). Before, the runner matched the reason's free
 * text against three fixed strings, so the header's Stop all ("stop all from the UI"), the
 * chat's and the phone's stops ended the session as an error ("killed").
 */
export type StopBy = "you" | "stop_all" | "quit";

/** `stop()` options. */
export interface StopOptions {
  /**
   * Default true: the scope stays stopped (new work in it is refused) until `resume()`.
   * False ends the runs in scope and leaves the freeze as it was (a session's Stop button, the
   * phone's `stop`): it never lifts a kill already in force (U-032).
   */
  freeze?: boolean;
  /** Whose stop this is; the runs read it from their abort signal. None: an error ("killed"). */
  by?: StopBy;
}

/**
 * The abort reason the kill switch gives every run it stops: the reason in words (`message`)
 * and whose stop it was (`stopBy`, null when the caller named none).
 */
export class KillSwitchStop extends Error {
  readonly stopBy: StopBy | null;
  constructor(message: string, stopBy: StopBy | null) {
    super(message);
    this.name = "KillSwitchStop";
    this.stopBy = stopBy;
  }
}

const STOP_BY: readonly string[] = ["you", "stop_all", "quit"];

/** Whose stop an abort reason names (a `KillSwitchStop`'s `stopBy`), or null for any other. */
export function stopByOf(reason: unknown): StopBy | null {
  if (!reason || typeof reason !== "object") return null;
  const by = (reason as { stopBy?: unknown }).stopBy;
  return typeof by === "string" && STOP_BY.includes(by) ? (by as StopBy) : null;
}

export interface KillReport {
  stoppedRuns: number;
  killedProcesses: number;
  revokedTokens: number;
  durationMs: number;
  scope: KillScope | "all";
}

export class KillSwitch {
  private regs = new Map<number, Registration>();
  private nextId = 1;
  private readonly logger = log("killswitch");
  /**
   * Every scope stopped since the last `resume()`. A narrower stop never replaces a wider one:
   * a session stopped during Stop all leaves everything stopped (U-032).
   */
  private frozen: (KillScope | "all")[] = [];
  /**
   * The sessions whose runs Stop all (a stop `by: "stop_all"`) ended since the last `resume()`:
   * what "Continue where it stopped" starts again (later #60), and nothing else. Only Stop all's
   * own stops count, never another freezing one: the undo of a start stops its session by you
   * with the freeze on, and that session must not come back (review of later #60).
   */
  private stoppedByFreeze = new Set<string>();
  private listeners = new Set<(report: KillReport, reason: string, by: StopBy | null) => void>();
  private readonly protectedSessions = new Set<string>();

  /**
   * `onResume` runs at the start of every `resume()`. The daemon removes `kill.json` there, the
   * file that makes a kill survive a restart, so no path that lifts the kill can leave the file
   * for the next start to apply again (U-019, U-032). If it throws, the kill stays in force and
   * the error reaches the caller.
   */
  constructor(
    private readonly tokens?: TokenIssuer,
    private readonly onFreezeClaims?: (
      scope: KillScope | "all",
      reason: string,
      by: StopBy | null,
    ) => Promise<void> | void,
    private readonly onResume?: () => void,
  ) {}

  /** Register a run; returns an unregister function to call when it ends normally. */
  register(reg: Omit<Registration, "id">): () => void {
    const id = this.nextId++;
    this.regs.set(id, { ...reg, id });
    if (reg.protected) this.protectedSessions.add(reg.sessionId);
    if (!reg.protected && this.isFrozen({ agentId: reg.agentId, sessionId: reg.sessionId })) {
      // Stopped scope: abort immediately so nothing new starts. A freeze is Stop all's
      // ("Sessions are stopped" until allowed again), whoever asked for it.
      reg.controller?.abort(new KillSwitchStop("kill switch active", "stop_all"));
    }
    return () => {
      this.regs.delete(id);
    };
  }

  /** Called after every stop with the report, the reason and whose stop it was (`by`). */
  onStop(fn: (report: KillReport, reason: string, by: StopBy | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isFrozen(scope: KillScope): boolean {
    if (this.frozen.length === 0) return false;
    if (scope.sessionId && this.protectedSessions.has(scope.sessionId)) return false;
    return this.frozen.some((f) => {
      if (f === "all") return true;
      if (f.sessionId) return f.sessionId === scope.sessionId;
      return !!f.agentId && f.agentId === scope.agentId;
    });
  }

  /**
   * Lift every stop so new sessions may start again, in this process and at the next start:
   * `onResume` first (the daemon's `kill.json`), then the freeze here.
   */
  resume(): void {
    this.onResume?.();
    this.frozen = [];
    this.stoppedByFreeze.clear();
  }

  /**
   * The sessions Stop all ended since the last `resume()`, in the order they were stopped.
   * Read before `resume()`, which forgets them.
   */
  stoppedSessions(): string[] {
    return [...this.stoppedByFreeze];
  }

  async stop(
    scope: KillScope | "all" = "all",
    reason = "kill switch",
    opts: StopOptions = {},
  ): Promise<KillReport> {
    const t0 = performance.now();
    const by = opts.by ?? null;
    const matches = (r: Registration) =>
      scope === "all" ||
      ((scope.sessionId ? r.sessionId === scope.sessionId : true) &&
        (scope.agentId ? r.agentId === scope.agentId : true));
    let stoppedRuns = 0;
    let killedProcesses = 0;
    for (const r of [...this.regs.values()]) {
      if (r.protected || !matches(r)) continue;
      if (r.controller && !r.controller.signal.aborted) {
        r.controller.abort(new KillSwitchStop(reason, by));
        stoppedRuns++;
        if (by === "stop_all" && opts.freeze !== false) this.stoppedByFreeze.add(r.sessionId);
      }
      if (r.child && r.child.exitCode === null && !r.child.killed) {
        killTree(r.child);
        killedProcesses++;
      }
      this.regs.delete(r.id);
    }
    let revokedTokens = 0;
    if (this.tokens) {
      revokedTokens = this.tokens.revokeWhere(
        (c) =>
          !this.protectedSessions.has(c.sessionId) &&
          (scope === "all" ||
            ((scope.sessionId ? c.sessionId === scope.sessionId : true) &&
              (scope.agentId ? c.agentId === scope.agentId : true))),
      ).length;
    }
    if (opts.freeze !== false) this.freeze(scope);
    try {
      await this.onFreezeClaims?.(scope, reason, by);
    } catch (e) {
      this.logger.error("freezing claims failed", { error: String(e) });
    }
    const report: KillReport = {
      stoppedRuns,
      killedProcesses,
      revokedTokens,
      durationMs: Math.round(performance.now() - t0),
      scope,
    };
    this.logger.warn("stopped", { ...report, reason, by });
    for (const l of this.listeners) l(report, reason, by);
    return report;
  }

  /**
   * End the runs of one task (U-039): a person cancelled it, marked it failed or "needs me"
   * while it ran. Every registration naming the task is aborted (its child process killed) and
   * the tokens issued for the task are revoked, so a tool call already on its way is refused.
   * Nothing is frozen and the claims are left alone: the session goes on with its other tasks,
   * and the stop listeners (the kill switch notification) are not told, since this is not the
   * kill switch. A no-op when nothing of the task runs.
   */
  stopTask(
    taskId: string,
    reason = "task moved by a person",
  ): Pick<KillReport, "stoppedRuns" | "killedProcesses" | "revokedTokens"> {
    let stoppedRuns = 0;
    let killedProcesses = 0;
    for (const r of [...this.regs.values()]) {
      if (r.protected || r.taskId !== taskId) continue;
      if (r.controller && !r.controller.signal.aborted) {
        r.controller.abort(new ForerunnerError("killed", reason));
        stoppedRuns++;
      }
      if (r.child && r.child.exitCode === null && !r.child.killed) {
        killTree(r.child);
        killedProcesses++;
      }
      this.regs.delete(r.id);
    }
    const tokens = this.tokens;
    const revokedTokens = tokens
      ? tokens.revokeWhere((c) => c.taskId === taskId && !tokens.isRevoked(c.id)).length
      : 0;
    if (stoppedRuns || killedProcesses)
      this.logger.info("task stopped", { taskId, stoppedRuns, killedProcesses, reason });
    return { stoppedRuns, killedProcesses, revokedTokens };
  }

  /** Add `scope` to the stopped scopes; "all" covers every other, so it replaces them. */
  private freeze(scope: KillScope | "all"): void {
    if (scope === "all") {
      this.frozen = ["all"];
      return;
    }
    if (this.frozen.includes("all")) return;
    const same = (f: KillScope | "all") =>
      f !== "all" && f.agentId === scope.agentId && f.sessionId === scope.sessionId;
    if (!this.frozen.some(same)) this.frozen.push({ ...scope });
  }

  activeCount(scope?: KillScope): number {
    if (!scope) return this.regs.size;
    let n = 0;
    for (const r of this.regs.values()) {
      if (
        (scope.sessionId ? r.sessionId === scope.sessionId : true) &&
        (scope.agentId ? r.agentId === scope.agentId : true)
      )
        n++;
    }
    return n;
  }
}
