import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { KillReport, KillScope, KillSwitch, StartRequest } from "@forerunner/runtime";
import type { JsonObject, RemoteCommandRow, StateStore } from "@forerunner/state";
import { z } from "zod";

/**
 * Remote commands from the shared state (spec R.4, S.8): the phone, the approvals page or the
 * desktop enqueue a `remote_command` with target "cloud"; this watcher picks one up atomically
 * (`RemoteCommandRepo.pickUp`, so two runners never execute the same command) every
 * `pollMs` and executes it. A `kill` reaches the runner's KillSwitch within one poll interval
 * (500 ms by default), so cloud sessions stop within 2 s of the request. Every command gets an
 * audit row and a `done` / `failed` result the device can read back.
 *
 * Only the runner's own human may command it (S.14: the vault and the billing source behind
 * every command are that human's). `pickUp` is called with the runner's device and
 * `ownerHumanId`, so a command another human's device enqueued (`{ target: "cloud" }` with no
 * target device) is never taken by this runner and stays pending for that human's own runner
 * (ADR 0041); `authorize` still refuses, on the picked-up row, a `start` naming any agent but
 * the runner's (`failed`, reason `forbidden: ...`, audit row). ADR 0033 records the rule.
 */
export const KillParams = z.object({
  scope: z
    .union([
      z.literal("all"),
      z.object({ agentId: z.string().optional(), sessionId: z.string().optional() }),
    ])
    .default("all"),
  reason: z.string().max(200).optional(),
});

export const StartParams = z.object({
  agentId: z.string().optional(),
  projectId: z.string().optional(),
  budgetUsdMicro: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
});

export const REMOTE_AUDIT_TOOL = "runner.remote_command";

export interface RemoteCommandDeps {
  store: Pick<StateStore, "remoteCommand" | "auditLog" | "device">;
  clock: Clock;
  kill: KillSwitch;
  runnerDeviceId: string;
  agentId: string;
  humanId: string;
  /** Start a session (the scheduler's request); "stop" and "kill" never need it. */
  start: (req: StartRequest) => Promise<"started" | "queued" | "deferred" | "skipped">;
  pollMs?: number;
  /** Called after every handled command (tests). */
  onHandled?: (row: RemoteCommandRow, result: JsonObject) => void;
}

export class RemoteCommandWatcher {
  private readonly logger = log("cloud-runner:remote");
  private readonly pollMs: number;
  private cancel: (() => void) | null = null;
  private handled = 0;
  private lastKill: KillReport | null = null;

  constructor(private readonly deps: RemoteCommandDeps) {
    this.pollMs = Math.max(100, deps.pollMs ?? 500);
  }

  get stats(): { handled: number; lastKill: KillReport | null } {
    return { handled: this.handled, lastKill: this.lastKill };
  }

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      try {
        await this.drain();
      } catch (e) {
        this.logger.warn("remote command poll failed", { error: errorMessage(e) });
      }
      if (this.cancel) this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
    };
    this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Pick up and execute every pending cloud command (exposed for tests and the health check). */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const row = await this.deps.store.remoteCommand.pickUp("cloud", {
        deviceId: this.deps.runnerDeviceId,
        ownerHumanId: this.deps.humanId,
      });
      if (!row) return n;
      n++;
      await this.execute(row);
    }
  }

  private async execute(row: RemoteCommandRow): Promise<void> {
    const t0 = this.deps.clock.monotonic();
    let result: JsonObject;
    let ok = true;
    try {
      await this.authorize(row);
      result = await this.run(row);
    } catch (e) {
      ok = false;
      result = { error: errorMessage(e) };
    }
    result = { ...result, durationMs: Math.round(this.deps.clock.monotonic() - t0) };
    try {
      if (ok) await this.deps.store.remoteCommand.complete(row.id, result);
      else await this.deps.store.remoteCommand.fail(row.id, result);
    } catch (e) {
      this.logger.warn("could not record the remote command result", {
        id: row.id,
        error: errorMessage(e),
      });
    }
    await this.audit(row, ok, result);
    this.handled++;
    this.logger.info("remote command handled", { id: row.id, command: row.command, ok });
    this.deps.onHandled?.(row, result);
  }

  /**
   * The issuing device must be a live device of the runner's human. The store's `pickUp` does
   * not filter by owner (see cloud-runner.md "Known issues"), so this is the check that keeps
   * another human's phone from running or killing work on this human's vault and billing source.
   */
  private async authorize(row: RemoteCommandRow): Promise<void> {
    const device = await this.deps.store.device.get(row.device_id);
    if (!device) {
      throw new ForerunnerError("validation", `forbidden: unknown device ${row.device_id}`);
    }
    if (device.owner_human_id !== this.deps.humanId) {
      throw new ForerunnerError("validation", "forbidden: device of another human");
    }
    if (device.revoked) {
      throw new ForerunnerError("validation", "forbidden: revoked device");
    }
  }

  private async run(row: RemoteCommandRow): Promise<JsonObject> {
    switch (row.command) {
      case "kill": {
        const params = KillParams.parse(row.params ?? {});
        const scope: KillScope | "all" = params.scope;
        const report = await this.deps.kill.stop(
          scope,
          `remote kill from device ${row.device_id}${params.reason ? `: ${params.reason}` : ""}`,
        );
        this.lastKill = report;
        return {
          stoppedRuns: report.stoppedRuns,
          killedProcesses: report.killedProcesses,
          revokedTokens: report.revokedTokens,
          killDurationMs: report.durationMs,
        };
      }
      case "stop": {
        // Stop the running cloud session(s) of the agent but leave the runner free to start new
        // ones: stop, then lift the freeze.
        const params = KillParams.parse(row.params ?? {});
        const scope: KillScope =
          params.scope === "all"
            ? { agentId: this.deps.agentId }
            : { agentId: params.scope.agentId ?? this.deps.agentId, ...params.scope };
        const report = await this.deps.kill.stop(scope, `remote stop from device ${row.device_id}`);
        this.deps.kill.resume();
        return { stoppedRuns: report.stoppedRuns, killDurationMs: report.durationMs };
      }
      case "start": {
        const params = StartParams.parse(row.params ?? {});
        if (params.agentId && params.agentId !== this.deps.agentId) {
          throw new ForerunnerError(
            "validation",
            `forbidden: agent ${params.agentId} is not this runner's agent`,
          );
        }
        // A start after a kill lifts the freeze: the human asked for work explicitly.
        this.deps.kill.resume();
        const result = await this.deps.start({
          agentId: params.agentId ?? this.deps.agentId,
          projectId: params.projectId,
          trigger: "remote",
          reason: params.reason ?? `remote start from device ${row.device_id}`,
          ...(params.budgetUsdMicro ? { budgetUsdMicro: params.budgetUsdMicro } : {}),
        } as StartRequest);
        return { result };
      }
      case "pause":
        throw new Error("pause is not supported on the cloud runner; use stop or kill");
      default:
        throw new Error(`unknown remote command ${row.command}`);
    }
  }

  private async audit(row: RemoteCommandRow, ok: boolean, result: JsonObject): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        tool: REMOTE_AUDIT_TOOL,
        allowed: ok,
        denied_reason: ok ? null : String(result.error ?? "failed"),
        agent_id: this.deps.agentId,
        human_id: this.deps.humanId,
        input_summary: JSON.stringify({
          commandId: row.id,
          command: row.command,
          deviceId: row.device_id,
          params: row.params,
        }),
        result_summary: JSON.stringify(result),
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
        author_agent: this.deps.agentId,
      });
    } catch (e) {
      this.logger.warn("could not write the remote command audit row", {
        error: errorMessage(e),
      });
    }
  }
}
