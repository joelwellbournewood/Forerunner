import type { Clock } from "@forerunner/platform";
import type { AuditLogRepo, StateStore } from "@forerunner/state";
import type { EngineDetection } from "../sandbox/detect.ts";
import { type CreatedSandbox, createSandbox } from "../sandbox/factory.ts";
import type { RunFn, WhichFn } from "../sandbox/types.ts";
import type { RunSandboxLease, RunSandboxPort } from "../session/executor.ts";
import type { SandboxHealth } from "./api-types.ts";

/**
 * The daemon's RunSandboxPort: one sandbox per run through `createSandbox` (ADR 0007). A
 * container when Docker or Podman is reachable, else the process stand-in; tasks at risk tier
 * 2+ refuse the stand-in unless the project setting `allowProcessSandbox` is on (enforced in
 * the factory). Only the task worktree is mounted; the run token's domain allowlist is the
 * egress allowlist (none -> the sandbox is disconnected). Every egress decision is an audit row.
 */
export interface DetectingSandboxPortDeps {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  store: Pick<StateStore, "project">;
  audit?: Pick<AuditLogRepo, "append">;
  /** Pre-computed detection (tests, and the health view's answer); else probed per open. */
  detection?: EngineDetection;
  run?: RunFn;
  which?: WhichFn;
  /** Runner image from app configuration; else FORERUNNER_RUNNER_IMAGE, then the local tag. */
  image?: string;
}

interface SandboxProjectSettings {
  allowProcessSandbox?: unknown;
  sandbox?: { cpus?: unknown; memoryMb?: unknown; pidsLimit?: unknown; image?: unknown };
}

export class DetectingSandboxPort implements RunSandboxPort {
  constructor(private readonly deps: DetectingSandboxPortDeps) {}

  async open(req: Parameters<RunSandboxPort["open"]>[0]): Promise<RunSandboxLease> {
    const project = await this.deps.store.project.get(req.task.project_id);
    const settings = (project?.settings ?? {}) as SandboxProjectSettings;
    const limits = settings.sandbox ?? {};
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const created: CreatedSandbox = await createSandbox({
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
      allowProcessSandbox: settings.allowProcessSandbox === true,
      image: typeof limits.image === "string" ? limits.image : this.deps.image,
      processEnv: this.deps.env,
      detection: this.deps.detection,
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
    return { sandbox: created.sandbox, engine: created.engine, warnings: created.warnings };
  }
}

/** What `/health` reports about where task commands run on this machine. */
export function sandboxHealth(detection: EngineDetection): SandboxHealth {
  return {
    kind: detection.engine === "none" ? "process" : "container",
    available: detection.engine !== "none",
    engine: detection.engine,
    reason: detection.reason,
  };
}
