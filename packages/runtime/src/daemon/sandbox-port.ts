import type { Clock } from "@forerunner/platform";
import type { AuditLogRepo, StateStore } from "@forerunner/state";
import type { EngineDetection } from "../sandbox/detect.ts";
import { type CreatedSandbox, createSandbox } from "../sandbox/factory.ts";
import {
  isSandboxNotReady,
  type SandboxReadiness,
  type SandboxReadinessService,
  sandboxNotReadyError,
} from "../sandbox/readiness.ts";
import type { RunFn, WhichFn } from "../sandbox/types.ts";
import type { RunSandboxLease, RunSandboxPort } from "../session/executor.ts";
import type { SandboxHealth } from "./api-types.ts";

/**
 * The daemon's RunSandboxPort: one sandbox per run through `createSandbox` (ADR 0007). A
 * container when the sandbox is ready (U-079: an engine that runs Linux containers and the
 * runner image on this computer, `SandboxReadinessService`), else the process stand-in for
 * tasks at risk tier 0 and 1. Tasks at tier 2 and above never get the stand-in: while the
 * sandbox is not ready their lease is refused with `sandboxNotReadyError`, and the runner puts
 * the task back to ready with its attempt count unchanged. No project setting changes that;
 * only the composition's test-only pin (`pinnedProcess`) does. Only the task worktree is
 * mounted; the run token's domain allowlist is the egress allowlist (none -> the sandbox is
 * disconnected). Every egress decision is an audit row.
 */
export interface DetectingSandboxPortDeps {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  store: Pick<StateStore, "project">;
  audit?: Pick<AuditLogRepo, "append">;
  /** Whether the container sandbox is ready, and which image it runs (U-079). */
  readiness: Pick<SandboxReadinessService, "ensureChecked" | "check">;
  /** Tests only: every risk tier may use the process stand-in (the readiness is pinned too). */
  pinnedProcess?: boolean;
  run?: RunFn;
  which?: WhichFn;
}

interface SandboxProjectSettings {
  sandbox?: { cpus?: unknown; memoryMb?: unknown; pidsLimit?: unknown; image?: unknown };
}

/** The detection the factory gets: the engine only when the sandbox is ready. */
function detectionFor(r: SandboxReadiness): EngineDetection {
  return r.state === "ready" ? r.detection : { ...r.detection, engine: "none" };
}

export class DetectingSandboxPort implements RunSandboxPort {
  constructor(private readonly deps: DetectingSandboxPortDeps) {}

  async open(req: Parameters<RunSandboxPort["open"]>[0]): Promise<RunSandboxLease> {
    const project = await this.deps.store.project.get(req.task.project_id);
    const settings = (project?.settings ?? {}) as SandboxProjectSettings;
    const limits = settings.sandbox ?? {};
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const fullReview = req.task.risk_tier >= 2;
    let readiness = await this.deps.readiness.ensureChecked();
    if (fullReview && readiness.state !== "ready" && !this.deps.pinnedProcess) {
      // The answer may be old (Docker started since): look again before refusing.
      readiness = await this.deps.readiness.check({ force: true });
      if (readiness.state !== "ready") throw sandboxNotReadyError(readiness, req.task);
    }
    const open = (r: SandboxReadiness) =>
      createSandbox({
        taskId: req.task.id,
        worktree: req.worktree,
        limits: {
          timeoutMs: req.timeoutMs,
          cpus: num(limits.cpus),
          memoryMb: num(limits.memoryMb),
          pidsLimit: num(limits.pidsLimit),
        },
        network: req.allowedDomains.length
          ? { mode: "allowlist", domains: [...req.allowedDomains] }
          : { mode: "none" },
        riskTier: req.task.risk_tier,
        allowProcessSandbox: this.deps.pinnedProcess === true,
        image: typeof limits.image === "string" && limits.image.trim() ? limits.image : r.image,
        processEnv: this.deps.env,
        detection: detectionFor(r),
        run: this.deps.run,
        which: this.deps.which,
        clock: this.deps.clock,
        egress: {
          onDecision: (d) => {
            void this.deps.audit?.append({
              agent_id: null,
              human_id: null,
              tool: "sandbox.egress",
              input_summary: `${d.method} ${d.host}:${d.port} (task ${req.task.id})`,
              result_summary: d.allowed ? "allowed" : "blocked",
              allowed: d.allowed,
              denied_reason: d.allowed ? null : "domain_not_allowed: not in the run's allowlist",
              occurred_at: d.at,
            });
          },
        },
      });
    let created: CreatedSandbox;
    try {
      created = await open(readiness);
    } catch (e) {
      // Docker quit, or the image went away, between the check and this run: a full-review
      // task waits instead of failing; a lower tier falls back to the stand-in.
      if (isSandboxNotReady(e) || readiness.state !== "ready" || this.deps.pinnedProcess) throw e;
      const now = await this.deps.readiness.check({ force: true });
      if (now.state === "ready") throw e;
      if (fullReview) throw sandboxNotReadyError(now, req.task);
      created = await open(now);
    }
    return { sandbox: created.sandbox, engine: created.engine, warnings: created.warnings };
  }
}

/** What `/health` reports about where task commands run on this machine. */
export function sandboxHealth(r: SandboxReadiness): SandboxHealth {
  const ready = r.state === "ready" && !r.pinned;
  return {
    kind: ready ? "container" : "process",
    available: ready,
    engine: ready ? r.engine : "none",
    reason: r.reason,
    state: r.state,
  };
}
