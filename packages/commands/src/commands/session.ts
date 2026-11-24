import { chfMicro, chfToUsdMicro, usdToChfMicro } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { DeviceRow, SessionRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, CommandOutcome } from "../types.ts";
import { rateOf, sessionBudgetOf } from "./budget.ts";
import { asObject, authorOf, chfExact, type ResolvedProject, resolveProject } from "./shared.ts";

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
function startSentence(
  s: StartPlan,
  outcome?: "started" | "queued" | "deferred",
  /** L4a-left-5: the start is kept for the credential's reset ("at 15:40"). */
  keptWhen?: string | null,
): string {
  const where = s.runner === "cloud" ? " on the cloud runner" : "";
  // l4-chat-depth (L4-chat-210): two decimals (design §5 rule 7), "(up to CHF 1.00)".
  const up = `(up to ${chfExact(s.budgetChf)})`;
  const name = s.resolved.project.name;
  if (keptWhen && !s.remote) return `A session on ${name}${where} starts ${keptWhen} ${up}.`;
  if (s.remote)
    return `Sent a start for ${name}${where} to your PC ${up}; it picks it up in seconds.`;
  if (outcome === "queued")
    return `A session on ${name}${where} starts after the one running now ${up}.`;
  if (outcome === "deferred")
    return `A session on ${name}${where} starts when your quiet hours end ${up}.`;
  return `Started a session on ${name}${where} ${up}.`;
}

/** A sentence with the larger task's warning after it (D4), when there is one. */
function withWarning(sentence: string, warning: string | null): string {
  return warning ? `${sentence} ${warning}` : sentence;
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

/**
 * S-10 (ADR 0118): one wait per project: while the person's session waits to go on after its
 * Claude credential (or a Start was kept for the reset), a start keeps nothing new and starts
 * nothing; it says when that session goes on, with no read-back. Asked after
 * `refuseBlockedStart`: a start the Start dialog refuses (a refused credential, Stop all, a
 * removed project) says the dialog's sentence first.
 */
async function refuseWhileWaiting(s: StartPlan, ctx: CommandContext): Promise<void> {
  if (s.remote) return;
  const waits = await ctx.ports.startWaits?.(s.resolved.project.id);
  if (waits)
    throw new ForerunnerError("validation", waits, { details: { cause: "continuation_waits" } });
}

/**
 * The start as one question for the read-back (design §5, "Chat read-back"). D4
 * (d1109-oversize-start): when the session would take a task larger than its work budget, the
 * Start dialog's warning follows ('Start a session on Shop (up to CHF 5.00)? "Build the shop"
 * needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to
 * continue.'), then the tasks after it in the plan's order (d1109-oversize-pause, OP-0: '"B"
 * comes after it: it runs if "Build the shop" leaves budget, else in your next session.'), as
 * the port's one text; the start itself is not refused for it.
 */
function startAsk(
  s: StartPlan,
  warning: string | null = null,
  /**
   * l4-starts-carried (L4a-left-5): the start is kept for the credential's reset: 'Start a
   * session on Map notes at 15:40 (up to CHF 5.00)?'; before, the read-back said a start now and
   * the session then ended at once to wait.
   */
  keptWhen: string | null = null,
): string {
  const where = s.runner === "cloud" ? " on the cloud runner" : "";
  const when = keptWhen ? ` ${keptWhen}` : "";
  const ask = `Start a session on ${s.resolved.project.name}${where}${when} (up to ${chfExact(s.budgetChf)})?`;
  return warning ? `${ask} ${warning}` : ask;
}

/** When a start now is kept for the credential's reset ("at 15:40"), or null (L4a-left-5). */
async function keptWhenOf(s: StartPlan, ctx: CommandContext): Promise<string | null> {
  if (s.remote || s.runner === "cloud") return null;
  return (await ctx.ports.startKeptWhen?.(s.resolved.project.id).catch(() => null)) ?? null;
}

/**
 * The warning of a start that takes a task larger than its work budget (D4, the runtime's
 * `CommandPorts.startWarning`, the Start check's own sentence for the chat), or null. A phone's
 * start is the PC's to judge.
 */
async function startWarningOf(s: StartPlan, ctx: CommandContext): Promise<string | null> {
  if (s.remote) return null;
  return (await ctx.ports.startWarning?.(s.resolved.project.id, s.budgetUsd)) ?? null;
}

export const sessionStart: CommandDef<SessionStartParams> = {
  name: "session.start",
  // d1109-starts-engine (S-11, ADR 0118): model-facing text, asserted as the model receives it.
  description:
    "Start a work session now on the person's say-so, on a project, on the PC or the cloud runner, with an optional budget in CHF; read back for their yes. Answers and task changes never start one.",
  params: startParams,
  // S-11 (the owner: "the user clearly states when a session will run"): a start said in chat or
  // voice is read back for the person's yes at any budget, whether the parser or the chat model
  // asked for it ("ok" or "sounds good" read by a model is not the person saying when).
  askFromChat: true,
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
    // fixup-l4-cred-engine (L4-creds-8): the dialog's refusal comes before the one-wait rule, so a
    // refused credential's start says what to do ("Nothing can run until you save a new API key
    // in Settings.") also while the person's session is kept to go on; before, chat said 'Your
    // session of 10:00 goes on by itself once its Claude credential is back.' beside the dialog.
    await refuseBlockedStart(s, ctx);
    await refuseWhileWaiting(s, ctx);
    const costly =
      s.budgetUsd > (ctx.ports.costlySessionUsdMicro ?? DEFAULT_COSTLY_SESSION_USD_MICRO);
    const warning = await startWarningOf(s, ctx);
    const keptWhen = await keptWhenOf(s, ctx);
    return buildCard({
      command: "session.start",
      what: `a session on ${s.resolved.project.name} ${s.where}`,
      oldValue: "no session",
      newValue: `running with a budget of ${chfExact(s.budgetChf)}`,
      scope: "session",
      risk: costly ? "medium" : "low",
      sentence: startSentence(s, undefined, keptWhen),
      reversible: true,
      projectId: s.resolved.project.id,
      projectName: s.resolved.project.name,
      usesActiveProject: s.resolved.usedActive,
      costUsdMicro: s.budgetUsd,
      costChfMicro: s.budgetChf,
      ask: startAsk(s, warning, keptWhen),
    });
  },
  async run(p, ctx): Promise<CommandOutcome> {
    const s = await startPlan(p, ctx);
    const agentId = needAgent(ctx);
    await refuseBlockedStart(s, ctx);
    await refuseWhileWaiting(s, ctx);
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
    // l4-starts-carried (L4a-left-5): while the Claude credential the work needs rests and
    // nothing is kept for the project, the start is kept for its reset, as the Start dialog's
    // "Start at 15:40" keeps it: no session now (it would only meet the wait), one at the reset
    // by the person; Undo drops it. Before, a session started and ended at once to wait.
    if (s.runner !== "cloud" && ctx.ports.keepStart) {
      const kept = await ctx.ports.keepStart(s.resolved.project.id, s.budgetUsd);
      if (kept)
        return {
          before: { session_id: null, remote_command_id: null },
          after: {
            session_id: null,
            start_id: null,
            remote_command_id: null,
            agent_id: agentId,
            budget_usd_micro: s.budgetUsd,
            kept_start: true,
            project_id: s.resolved.project.id,
          },
          sentence: kept,
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
      sentence: withWarning(
        startSentence(
          s,
          outcome === "queued" || outcome === "deferred" || outcome === "started"
            ? outcome
            : undefined,
        ),
        // D4: a start said in chat or voice said its warning in its read-back (`startAsk`, S-11:
        // every one is read back); one from the app's palette or the phone hears it now.
        ctx.source === "chat" || ctx.source === "voice" ? null : await startWarningOf(s, ctx),
      ),
      projectId: s.resolved.project.id,
    };
  },
  async undo(_p, _before, after, ctx) {
    const a = asObject(after);
    // L4a-left-5: a start kept for the reset is dropped; nothing starts at the reset.
    if (a.kept_start === true && typeof a.project_id === "string") {
      await ctx.ports.cancelKeptStart?.(a.project_id);
      return;
    }
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
      ask: "Allow sessions to start again?",
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
