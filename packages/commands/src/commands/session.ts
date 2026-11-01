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

/**
 * What the start did, said when it is known (design §3.9, §5: no promise the code does not
 * keep): started, waiting behind the running session, or waiting for quiet hours to end. A
 * phone's start is handed to the PC. No "Undo." in the words: the Undo is a button.
 */
function startSentence(s: StartPlan, outcome?: "started" | "queued" | "deferred"): string {
  const where = s.runner === "cloud" ? " on the cloud runner" : "";
  const up = `(up to ${chf(s.budgetChf)})`;
  const name = s.resolved.project.name;
  if (s.remote)
    return `Sent a start for ${name}${where} to your PC ${up}; it picks it up in seconds.`;
  if (outcome === "queued")
    return `A session on ${name}${where} starts after the one running now ${up}.`;
  if (outcome === "deferred")
    return `A session on ${name}${where} starts when your quiet hours end ${up}.`;
  return `Started a session on ${name}${where} ${up}.`;
}

/**
 * Design §3.6 and §3.9: a start that would do nothing (Stop all is on, Claude is not connected,
 * nothing can run) is refused in words, as the Start dialog refuses it; before, the chat said
 * "Started a session ... Undo." while nothing started. A phone's start is the PC's to judge.
 */
async function refuseBlockedStart(s: StartPlan, ctx: CommandContext): Promise<void> {
  if (s.remote) return;
  const blocked = await ctx.ports.startBlocked?.(s.resolved.project.id, s.budgetUsd);
  if (blocked) throw new ForerunnerError("validation", blocked, { details: { blocked } });
}

/** The start as one question for the read-back (design §5, "Chat read-back"). */
function startAsk(s: StartPlan): string {
  const where = s.runner === "cloud" ? " on the cloud runner" : "";
  return `Start a session on ${s.resolved.project.name}${where} (up to ${chf(s.budgetChf)})?`;
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
    // A start that would do nothing is refused before any card is shown: the chat says why at
    // once, as the Start dialog does, instead of a Yes/No for a start that cannot happen (review
    // of fix/chat). `run` checks again: the state may change while a card waits.
    await refuseBlockedStart(s, ctx);
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
      ask: startAsk(s),
    });
  },
  async run(p, ctx): Promise<CommandOutcome> {
    const s = await startPlan(p, ctx);
    const agentId = needAgent(ctx);
    await refuseBlockedStart(s, ctx);
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
      // No start id yet: the PC that picks the row up makes the start and records its
      // identity in the row's result (`startId`), where the undo reads it.
      return {
        before: { session_id: null, remote_command_id: null },
        after: {
          session_id: null,
          start_id: null,
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
    const started = await ctx.ports.startSession({
      agentId,
      projectId: s.resolved.project.id,
      trigger: ctx.deviceId ? "remote" : "manual",
      reason,
      budgetUsdMicro: s.budgetUsd,
      runner: s.runner,
      ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
    });
    const sessionId =
      started && typeof started === "object" && typeof started.sessionId === "string"
        ? started.sessionId
        : null;
    // The start's identity (the scheduler's entry): the undo names it so the runtime stops
    // the session this start began, never a later start of the agent.
    const startId =
      started && typeof started === "object" && typeof started.startId === "string"
        ? started.startId
        : null;
    const outcome =
      started && typeof started === "object" && "outcome" in started
        ? (started as { outcome?: unknown }).outcome
        : undefined;
    return {
      before: { session_id: null, remote_command_id: null },
      after: {
        session_id: sessionId,
        start_id: startId,
        remote_command_id: null,
        agent_id: agentId,
        budget_usd_micro: s.budgetUsd,
      },
      sentence: startSentence(
        s,
        outcome === "queued" || outcome === "deferred" || outcome === "started"
          ? outcome
          : undefined,
      ),
      projectId: s.resolved.project.id,
    };
  },
  async undo(_p, _before, after, ctx) {
    const a = asObject(after);
    let startId = typeof a.start_id === "string" ? a.start_id : undefined;
    if (typeof a.remote_command_id === "string") {
      const row = await ctx.store.remoteCommand.get(a.remote_command_id);
      if (row?.status === "pending") {
        await ctx.store.remoteCommand.fail(row.id, { cancelled: true, reason: "undo" });
        return;
      }
      // The runner that picked the row up recorded the start's identity in its result (the
      // runtime's `RemoteCommandWatcher`): the kill names it, so the runtime stops the
      // session that start began and no later start of the agent. A result without one
      // names no start, and the runtime's port stops nothing for it.
      const recorded = asObject(row?.result).startId;
      startId = typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
    }
    const scope =
      typeof a.session_id === "string"
        ? { sessionId: a.session_id }
        : {
            agentId: typeof a.agent_id === "string" ? a.agent_id : (ctx.agentId ?? ""),
            ...(startId ? { startId } : {}),
          };
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
      ? "the session"
      : "the running session";
}

/** The agent's work sessions that run now (not its conversation session). */
async function runningWork(ctx: CommandContext): Promise<SessionRow[]> {
  const agentId = needAgent(ctx);
  return (await ctx.store.session.active(agentId)).filter(
    (s) => (s.status === "running" || s.status === "paused") && s.summary !== "conversation",
  );
}

/** "Stopped the session on Quote page during "Style the page": it is ready again." */
async function stoppedSentence(ctx: CommandContext, rows: readonly SessionRow[]): Promise<string> {
  if (!rows.length) return "Nothing is running, so nothing was stopped.";
  const names: string[] = [];
  for (const r of rows) {
    const project = r.project_id ? await ctx.store.project.get(r.project_id) : undefined;
    names.push(project ? `the session on ${project.name}` : "the session");
  }
  return `Stopped ${names.join(" and ")}. What it wrote stays; the task it was on is ready again.`;
}

export const sessionStop: CommandDef<SessionStopParams> = {
  name: "session.stop",
  description:
    "Stop now: the running session (scope agent, the default) or one session (scope session) stops at once; its task goes back to ready and sessions can start again. Scope all is Stop all: every running session stops and none starts until the person allows sessions again (session.resume).",
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
      ask:
        p.scope === "all"
          ? "Stop every running session now? No session starts until you allow it again."
          : "Stop the running session now?",
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
    if (p.scope === "session" && !p.session) {
      throw new ForerunnerError("validation", "session.stop with scope session needs a session id");
    }
    if (p.scope === "all") {
      // Stop all (design §4.9): every run stops and nothing starts until allowed again.
      const report = await ctx.ports.kill("all", reason);
      return {
        before: { running: true },
        after: {
          stopped: true,
          stoppedRuns: report?.stoppedRuns ?? null,
          killedProcesses: report?.killedProcesses ?? null,
        },
        sentence:
          'Stopped every running session. No session starts until you say "resume" or press Allow sessions again.',
      };
    }
    // Stop now (design §3.7, §4.9): the running session, or the one named, stops at once
    // without freezing the agent; the next start works. Before, a chat "stop" stopped the
    // agent's scope, which froze it ("Sessions are stopped") until Allow sessions again.
    const rows =
      p.scope === "session"
        ? [await ctx.store.session.mustGet(p.session as string)]
        : await runningWork(ctx);
    let stoppedRuns = 0;
    let killedProcesses = 0;
    for (const row of rows) {
      const report = await ctx.ports.kill({ sessionId: row.id }, reason);
      stoppedRuns += report?.stoppedRuns ?? 0;
      killedProcesses += report?.killedProcesses ?? 0;
    }
    return {
      before: { running: rows.length > 0 },
      after: {
        stopped: rows.length > 0,
        sessions: rows.map((r) => r.id),
        stoppedRuns,
        killedProcesses,
      },
      sentence: await stoppedSentence(ctx, rows),
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
  if (!row)
    throw new ForerunnerError("validation", "Nothing is running, so there is nothing to stop.");
  return row;
}

export const sessionPause: CommandDef<SessionPauseParams> = {
  name: "session.pause",
  description:
    "Stop after this task: the running session finishes the task it is on, then ends (Undo lets it go on).",
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
      sentence: `The session${project ? ` on ${project.name}` : ""} stops after the task it is on.`,
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
      sentence: `The session${project ? ` on ${project.name}` : ""} stops after the task it is on.`,
      projectId: s.project_id,
    };
  },
  // U-061: a session that ended since cannot be resumed; the undo says so.
  async undoBlocked(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.session_id !== "string") return "this change does not name the session it paused";
    const s = await ctx.store.session.get(b.session_id);
    if (!s) return "the session no longer exists";
    return s.status === "paused" || s.status === "running"
      ? null
      : `the session already ended (${s.status}); there is nothing to resume`;
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

const resumeParams = z.object({ reason: z.string().optional() });
export type SessionResumeParams = z.infer<typeof resumeParams>;

/**
 * "resume", "allow sessions again" (design §3.1, §3.9): lifts Stop all, so sessions may start
 * again. It starts nothing itself; the reply says how to continue. Before, "resume" had neither
 * a command nor a tool, and a chat "stop" froze the agent with no way back by chat.
 */
export const sessionResume: CommandDef<SessionResumeParams> = {
  name: "session.resume",
  description:
    "Allow sessions again after Stop all: new sessions may start. Starts nothing by itself (session.start does).",
  params: resumeParams,
  risk: "low",
  scope: "global",
  reversible: false,
  undoStrategy: "say stop everything to stop all sessions again",
  actionClass: "routine_reversible",
  async plan() {
    return buildCard({
      command: "session.resume",
      what: "whether sessions may start",
      oldValue: "stopped",
      newValue: "allowed",
      scope: "global",
      risk: "low",
      sentence: "Sessions can start again.",
      reversible: false,
    });
  },
  async run(_p, ctx): Promise<CommandOutcome> {
    if (!ctx.ports.allowSessions)
      throw new ForerunnerError("not_supported", "allowing sessions again is not available here");
    const { wasStopped } = await ctx.ports.allowSessions();
    return {
      before: { stopped: wasStopped },
      after: { stopped: false },
      sentence: wasStopped
        ? 'Sessions can start again. Say "start a session" to continue where it stopped.'
        : 'Sessions were not stopped. Say "start a session" to start one.',
    };
  },
};
