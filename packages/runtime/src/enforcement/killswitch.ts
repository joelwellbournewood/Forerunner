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

/** `stop()` options. */
export interface StopOptions {
  /**
   * Default true: the scope stays stopped (new work in it is refused) until `resume()`.
   * False ends the runs in scope and leaves the freeze as it was (a session's Stop button, the
   * phone's `stop`): it never lifts a kill already in force (U-032).
   */
  freeze?: boolean;
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
  private listeners = new Set<(report: KillReport, reason: string) => void>();
  private readonly protectedSessions = new Set<string>();

  /**
   * `onResume` runs at the start of every `resume()`. The daemon removes `kill.json` there, the
   * file that makes a kill survive a restart, so no path that lifts the kill can leave the file
   * for the next start to apply again (U-019, U-032). If it throws, the kill stays in force and
   * the error reaches the caller.
   */
  constructor(
    private readonly tokens?: TokenIssuer,
    private readonly onFreezeClaims?: (scope: KillScope | "all") => Promise<void> | void,
    private readonly onResume?: () => void,
  ) {}

  /** Register a run; returns an unregister function to call when it ends normally. */
  register(reg: Omit<Registration, "id">): () => void {
    const id = this.nextId++;
    this.regs.set(id, { ...reg, id });
    if (reg.protected) this.protectedSessions.add(reg.sessionId);
    if (!reg.protected && this.isFrozen({ agentId: reg.agentId, sessionId: reg.sessionId })) {
      // Stopped scope: abort immediately so nothing new starts.
      reg.controller?.abort(new Error("kill switch active"));
    }
    return () => {
      this.regs.delete(id);
    };
  }

  /** Called after every stop with the report and the reason given to `stop()`. */
  onStop(fn: (report: KillReport, reason: string) => void): () => void {
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
  }

  async stop(
    scope: KillScope | "all" = "all",
    reason = "kill switch",
    opts: StopOptions = {},
  ): Promise<KillReport> {
    const t0 = performance.now();
    const matches = (r: Registration) =>
      scope === "all" ||
      ((scope.sessionId ? r.sessionId === scope.sessionId : true) &&
        (scope.agentId ? r.agentId === scope.agentId : true));
    let stoppedRuns = 0;
    let killedProcesses = 0;
    for (const r of [...this.regs.values()]) {
      if (r.protected || !matches(r)) continue;
      if (r.controller && !r.controller.signal.aborted) {
        r.controller.abort(new Error(reason));
        stoppedRuns++;
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
      await this.onFreezeClaims?.(scope);
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
    this.logger.warn("stopped", { ...report, reason });
    for (const l of this.listeners) l(report, reason);
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
