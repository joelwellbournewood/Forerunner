import type { ChildProcess } from "node:child_process";
import { killTree, log } from "@forerunner/platform";
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
  controller?: AbortController;
  child?: ChildProcess;
  label: string;
  /** The human's own channel (conversation): never stopped, never frozen. */
  protected?: boolean;
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
  private frozen: KillScope | "all" | null = null;
  private listeners = new Set<(report: KillReport, reason: string) => void>();
  private readonly protectedSessions = new Set<string>();

  constructor(
    private readonly tokens?: TokenIssuer,
    private readonly onFreezeClaims?: (scope: KillScope | "all") => Promise<void> | void,
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
    if (this.frozen === null) return false;
    if (scope.sessionId && this.protectedSessions.has(scope.sessionId)) return false;
    if (this.frozen === "all") return true;
    if (this.frozen.sessionId && this.frozen.sessionId === scope.sessionId) return true;
    if (this.frozen.agentId && !this.frozen.sessionId && this.frozen.agentId === scope.agentId)
      return true;
    return false;
  }

  /** Lift a stop so new sessions may start again. */
  resume(): void {
    this.frozen = null;
  }

  async stop(scope: KillScope | "all" = "all", reason = "kill switch"): Promise<KillReport> {
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
    this.frozen = scope;
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
