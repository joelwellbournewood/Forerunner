import { chfMicro, chfToUsdMicro, usdToChfMicro } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { DeviceRow, SessionRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, CommandOutcome } from "../types.ts";
import { rateOf, sessionBudgetOf } from "./budget.ts";
import { asObject, authorOf, chf, type ResolvedProject, resolveProject } from "./shared.ts";

/**
 * Session control (spec E, Q, R). From a paired phone or web client the commands become
 * remote_command rows that the PC or the cloud runner picks up (R.4); from the desktop they
 * call the runtime ports directly. Starting a costly session is medium risk; stopping is the
 * kill switch and always acts at once.
 */
export const DEFAULT_COSTLY_SESSION_USD_MICRO = 2_000_000;

async function requestingDevice(ctx: CommandContext): Promise<DeviceRow | null> {
  if (!ctx.deviceId) return null;
  return (await ctx.store.device.get(ctx.deviceId)) ?? null;
}

/** True when the command came from a phone or web client and must travel as a remote command. */
export async function isRemote(ctx: CommandContext): Promise<boolean> {
  const device = await requestingDevice(ctx);
  return !!device && !device.revoked && (device.kind === "phone" || device.kind === "web");
}

function needAgent(ctx: CommandContext): string {
  if (!ctx.agentId) throw new ForerunnerError("validation", "no principal agent for this human");
  return ctx.agentId;
}

const startParams = z.object({
  project: z.string().optional(),
  runner: z.enum(["pc", "cloud"]).optional(),
  budgetChf: z.number().positive().optional(),
  reason: z.string().optional(),
});
export type SessionStartParams = z.infer<typeof startParams>;

interface StartPlan {
  resolved: ResolvedProject;
  budgetUsd: number;
  budgetChf: number;
  runner: "pc" | "cloud";
  remote: boolean;
  where: string;
}

async function startPlan(p: SessionStartParams, ctx: CommandContext): Promise<StartPlan> {
  const resolved = await resolveProject(ctx, p.project);
  const rate = await rateOf(ctx);
  let budgetUsd: number;
  let budgetChf: number;
  if (p.budgetChf !== undefined) {
    budgetChf = chfMicro(p.budgetChf);
    budgetUsd = chfToUsdMicro(budgetChf, rate);
  } else {
    const b = await sessionBudgetOf(resolved.project, ctx);
    budgetUsd = b.usdMicro;
    budgetChf = b.chfMicro || usdToChfMicro(b.usdMicro, rate);
  }
  const runner = p.runner ?? "pc";
  const remote = await isRemote(ctx);
  return {
    resolved,
    budgetUsd,
    budgetChf,
    runner,
    remote,
    where: runner === "cloud" ? "on the cloud runner" : "on your PC",
  };
}

function startSentence(s: StartPlan): string {
  return `Started a session on ${s.resolved.project.name} ${s.where} with a budget of ${chf(s.budgetChf)}${
    s.remote ? "; the PC picks it up in seconds" : ""
  }. Undo.`;
}

export const sessionStart: CommandDef<SessionStartParams> = {
  name: "session.start",
  description:
    "Start a work session for the principal agent on a project, on the PC or the cloud runner, with an optional budget in CHF.",
  params: startParams,
  risk: async (p, ctx) => {
    const s = await startPlan(p, ctx);
    return s.budgetUsd > (ctx.ports.costlySessionUsdMicro ?? DEFAULT_COSTLY_SESSION_USD_MICRO)
      ? "medium"
      : "low";
  },
  maxRisk: "medium",
  scope: "session",
  reversible: true,
  undoStrategy: "stop the started session (or cancel the remote command while pending)",
  actionClass: "non_routine",
  async plan(p, ctx) {
    const s = await startPlan(p, ctx);
    const costly =
      s.budgetUsd > (ctx.ports.costlySessionUsdMicro ?? DEFAULT_COSTLY_SESSION_USD_MICRO);
    return buildCard({
      command: "session.start",
      what: `a session on ${s.resolved.project.name} ${s.where}`,
      oldValue: "no session",
      newValue: `running with a budget of ${chf(s.budgetChf)}`,
      scope: "session",
      risk: costly ? "medium" : "low",
      sentence: startSentence(s),
      reversible: true,
      projectId: s.resolved.project.id,
      projectName: s.resolved.project.name,
      usesActiveProject: s.resolved.usedActive,
      costUsdMicro: s.budgetUsd,
      costChfMicro: s.budgetChf,
    });
  },
  async run(p, ctx): Promise<CommandOutcome> {
    const s = await startPlan(p, ctx);
    const agentId = needAgent(ctx);
    const reason = p.reason ?? `${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`;
    if (s.remote) {
      const row = await ctx.store.remoteCommand.enqueue({
        device_id: ctx.deviceId as string,
        target: s.runner,
        command: "session.start",
        params: {
          agentId,
          projectId: s.resolved.project.id,
          budgetUsdMicro: s.budgetUsd,
          reason,
          trigger: "remote",
        },
        ...authorOf(ctx),
      });
      return {
        before: { session_id: null, remote_command_id: null },
        after: {
          session_id: null,
          remote_command_id: row.id,
          agent_id: agentId,
          budget_usd_micro: s.budgetUsd,
        },
        sentence: startSentence(s),
        projectId: s.resolved.project.id,
      };
    }
    if (!ctx.ports.startSession) {
      throw new ForerunnerError("not_supported", "session start is not available here");
    }
    const fromDevice = ctx.deviceId ?? ctx.remoteDeviceId ?? null;
    const started = await ctx.ports.startSession({
      agentId,
      projectId: s.resolved.project.id,
      trigger: fromDevice ? "remote" : "manual",
      reason,
      budgetUsdMicro: s.budgetUsd,
      runner: s.runner,
      ...(fromDevice ? { deviceId: fromDevice } : {}),
    });
    const sessionId =
      started && typeof started === "object" && typeof started.sessionId === "string"
        ? started.sessionId
        : null;
    return {
      before: { session_id: null, remote_command_id: null },
      after: {
        session_id: sessionId,
        remote_command_id: null,
        agent_id: agentId,
        budget_usd_micro: s.budgetUsd,
      },
      sentence: startSentence(s),
      projectId: s.resolved.project.id,
    };
  },
  async undo(_p, _before, after, ctx) {
    const a = asObject(after);
    if (typeof a.remote_command_id === "string") {
      const row = await ctx.store.remoteCommand.get(a.remote_command_id);
      if (row?.status === "pending") {
        await ctx.store.remoteCommand.fail(row.id, { cancelled: true, reason: "undo" });
        return;
      }
    }
    const scope =
      typeof a.session_id === "string"
        ? { sessionId: a.session_id }
        : { agentId: typeof a.agent_id === "string" ? a.agent_id : (ctx.agentId ?? "") };
    await ctx.ports.kill?.(scope, "undo of session.start");
  },
};

const stopParams = z.object({
  scope: z.enum(["all", "agent", "session"]).default("agent"),
  session: z.string().optional(),
  reason: z.string().optional(),
});
export type SessionStopParams = z.infer<typeof stopParams>;

function stopWhat(p: SessionStopParams): string {
  return p.scope === "all"
    ? "every running session"
    : p.scope === "session"
      ? `the session ${p.session ?? ""}`.trim()
      : "your agent's running sessions";
}

export const sessionStop: CommandDef<SessionStopParams> = {
  name: "session.stop",
  description:
    "Stop running sessions at once (the kill switch): your agent's, one session, or everything.",
  params: stopParams,
  risk: "low",
  scope: (p) => (p.scope === "all" ? "global" : "session"),
  reversible: false,
  undoStrategy: "start a new session; a stopped session does not resume",
  actionClass: "routine_reversible",
  async plan(p) {
    return buildCard({
      command: "session.stop",
      what: stopWhat(p),
      oldValue: "running",
      newValue: "stopped",
      scope: p.scope === "all" ? "global" : "session",
      risk: "low",
      sentence: `Stopped ${stopWhat(p)}.`,
      reversible: false,
    });
  },
  async run(p, ctx): Promise<CommandOutcome> {
    const reason = p.reason ?? `${ctx.actor.kind} ${ctx.actor.id} via ${ctx.source}`;
    if (await isRemote(ctx)) {
      const row = await ctx.store.remoteCommand.enqueue({
        device_id: ctx.deviceId as string,
        target: "pc",
        command: "session.stop",
        params: { scope: p.scope, session: p.session ?? null, agentId: ctx.agentId, reason },
        ...authorOf(ctx),
      });
      return {
        before: { running: true },
        after: { remote_command_id: row.id },
        sentence: `Sent stop for ${stopWhat(p)} to your PC; it picks it up in seconds.`,
      };
    }
    if (!ctx.ports.kill)
      throw new ForerunnerError("not_supported", "the kill switch is not available here");
    const scope =
      p.scope === "all"
        ? "all"
        : p.scope === "session"
          ? { sessionId: p.session }
          : { agentId: needAgent(ctx) };
    if (scope !== "all" && "sessionId" in scope && !scope.sessionId) {
      throw new ForerunnerError("validation", "session.stop with scope session needs a session id");
    }
    const report = await ctx.ports.kill(scope, reason);
    const detail = report
      ? ` (${report.stoppedRuns} run${report.stoppedRuns === 1 ? "" : "s"}, ${report.killedProcesses} process${report.killedProcesses === 1 ? "" : "es"})`
      : "";
    return {
      before: { running: true },
      after: {
        stopped: true,
        stoppedRuns: report?.stoppedRuns ?? null,
        killedProcesses: report?.killedProcesses ?? null,
      },
      sentence: `Stopped ${stopWhat(p)}${detail}.`,
    };
  },
};

const pauseParams = z.object({
  session: z.string().optional(),
  reason: z.string().optional(),
});
export type SessionPauseParams = z.infer<typeof pauseParams>;

async function pausable(p: SessionPauseParams, ctx: CommandContext): Promise<SessionRow> {
  if (p.session) {
    const row = await ctx.store.session.get(p.session);
    if (!row) throw new ForerunnerError("not_found", `no session ${p.session}`);
    return row;
  }
  const agentId = needAgent(ctx);
  const active = (await ctx.store.session.active(agentId)).filter(
    (s) => s.status === "running" && s.summary !== "conversation",
  );
  const row = active[0];
  if (!row) throw new ForerunnerError("validation", "no running session to pause");
  return row;
}

export const sessionPause: CommandDef<SessionPauseParams> = {
  name: "session.pause",
  description: "Pause the running session (it can be resumed).",
  params: pauseParams,
  risk: "low",
  scope: "session",
  reversible: true,
  undoStrategy: "resume the paused session",
  actionClass: "routine_reversible",
  async plan(p, ctx) {
    const s = await pausable(p, ctx);
    const project = s.project_id ? await ctx.store.project.get(s.project_id) : undefined;
    return buildCard({
      command: "session.pause",
      what: `the session${project ? ` on ${project.name}` : ""}`,
      oldValue: s.status,
      newValue: "paused",
      scope: "session",
      risk: "low",
      sentence: `Paused the session${project ? ` on ${project.name}` : ""}. Undo.`,
      reversible: true,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    });
  },
  async run(p, ctx) {
    const s = await pausable(p, ctx);
    const project = s.project_id ? await ctx.store.project.get(s.project_id) : undefined;
    if (ctx.ports.pauseSession) await ctx.ports.pauseSession(s.id, p.reason ?? "paused by command");
    else await ctx.store.session.setStatus(s.id, s.version, "paused");
    return {
      before: { session_id: s.id, status: s.status },
      after: { session_id: s.id, status: "paused" },
      sentence: `Paused the session${project ? ` on ${project.name}` : ""}. Undo.`,
      projectId: s.project_id,
    };
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.session_id !== "string") return;
    if (ctx.ports.resumeSession) {
      await ctx.ports.resumeSession(b.session_id, "undo of session.pause");
      return;
    }
    const s = await ctx.store.session.mustGet(b.session_id);
    if (s.status === "paused") await ctx.store.session.setStatus(s.id, s.version, "running");
  },
};
