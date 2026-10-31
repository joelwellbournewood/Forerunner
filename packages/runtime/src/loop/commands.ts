import {
  type Actor,
  activeProjectOf,
  type ChangeCard,
  type CommandCall,
  type CommandContext,
  CommandExecutor,
  type CommandPorts,
  type CommandRegistry,
  type CommandSource,
  type ConfirmationAnswer,
  cardToJson,
  defaultRegistry,
  type ExecuteResult,
  IntentParser,
  type ModelIntentPort,
  type PendingConfirmation,
  SESSION_CAP_KEY,
  SESSION_OVERRIDE_KEY,
  toToolSpecs,
} from "@forerunner/commands";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  ChangeLogRow,
  JsonObject,
  JsonValue,
  SessionRow,
  StateStore,
} from "@forerunner/state";
import type { ToolSpec } from "../agent/tools.ts";
import type { KillScope } from "../enforcement/killswitch.ts";
import type {
  Scheduler,
  SchedulerLogEntry,
  StartOutcome,
  StartRequest,
} from "../session/triggers.ts";
import type {
  CommandCallLike,
  CommandResultView,
  CommandTurn,
  ConversationCommands,
  ParsedIntent,
} from "./ports.ts";

/**
 * Commands in the loop (spec Q, phase 5). The conversation agent, the daemon routes (the UI,
 * the palette, the phone) and email commands all change state through this one object over
 * `@forerunner/commands`: the registry (typed commands with a risk and an undo), the intent
 * parser (deterministic first, a model port when configured), the executor (change card,
 * confirmation by risk, change log, undo, timed reverts). Every route builds its
 * `CommandContext` here, so the actor, the human, the active project, the time zone and the
 * device are never chosen by the caller's text.
 */
export interface CommandLoopDeps {
  store: StateStore;
  clock: Clock;
  registry?: CommandRegistry;
  executor?: CommandExecutor;
  ports: CommandPorts;
  /** A model-backed intent parser for phrases the patterns do not understand. */
  model?: ModelIntentPort;
  /**
   * What the undo of a `session.start` would do (`sessionCommandPorts().startUndoState`, asked
   * with the start's identity from the row's `after.start_id`): the undo of a start whose
   * session already ended is refused with `SESSION_START_ENDED_REASON` and the row marked
   * irreversible, before the executor runs anything.
   */
  startUndoState?: SessionCommandPorts["startUndoState"];
}

/** The daemon's view of a pending change card. */
export interface PendingView extends PendingConfirmation {
  cardJson: Record<string, unknown>;
}

/** The change log source of a turn: the settings screen and the Changes screen are `ui`. */
export const SOURCE_OF: Record<CommandTurn["source"], CommandSource> = {
  text: "chat",
  voice: "voice",
  phone: "chat",
  ui: "ui",
};

export class CommandLoop implements ConversationCommands {
  private readonly logger = log("command-loop");
  readonly registry: CommandRegistry;
  readonly executor: CommandExecutor;
  readonly parser: IntentParser;

  constructor(private readonly deps: CommandLoopDeps) {
    this.registry = deps.registry ?? defaultRegistry();
    this.executor =
      deps.executor ??
      new CommandExecutor({ registry: this.registry, store: deps.store, clock: deps.clock });
    this.parser = new IntentParser(this.registry, deps.model ? { model: deps.model } : {});
  }

  /** Persist the command table and re-arm the reverts of temporary changes (after a start). */
  async start(): Promise<{ commands: number; reverted: number; scheduled: number }> {
    const rows = await this.registry.persist(this.deps.store);
    const resumed = await this.executor.resumeScheduled((row) => this.contextForRow(row));
    return { commands: rows.length, ...resumed };
  }

  stop(): void {
    this.executor.stop();
  }

  // -------------------------------------------------------------------------------------
  // Contexts

  async contextFor(turn: CommandTurn, over: Partial<CommandContext> = {}): Promise<CommandContext> {
    const human = await this.deps.store.human.get(turn.humanId);
    return {
      actor: { kind: "human", id: turn.humanId },
      humanId: turn.humanId,
      agentId: turn.agentId,
      activeProjectId: turn.activeProjectId,
      store: this.deps.store,
      clock: this.deps.clock,
      ports: this.deps.ports,
      source: SOURCE_OF[turn.source],
      wordsUsed: turn.wordsUsed,
      timezone: human?.timezone || "UTC",
      deviceId: turn.deviceId ?? null,
      sessionId: turn.sessionId,
      ...over,
    };
  }

  /** The context a change log row's own human: timed reverts and resumed windows run in it. */
  private async contextForRow(row: ChangeLogRow): Promise<CommandContext> {
    const humanId = row.human_id ?? "";
    const human = humanId ? await this.deps.store.human.get(humanId) : undefined;
    return {
      actor: { kind: "human", id: humanId },
      humanId,
      agentId: row.agent_id,
      activeProjectId: row.project_id,
      store: this.deps.store,
      clock: this.deps.clock,
      ports: this.deps.ports,
      source: row.source,
      wordsUsed: "",
      timezone: human?.timezone || "UTC",
      deviceId: null,
      sessionId: null,
    };
  }

  // -------------------------------------------------------------------------------------
  // The conversation agent's port

  async parse(text: string, turn: CommandTurn): Promise<ParsedIntent> {
    const human = await this.deps.store.human.get(turn.humanId);
    const projects = await this.deps.store.project.active({ limit: 200 });
    const lastMessage = turn.lastMessage ?? (await this.lastMessage(turn));
    const parsed = await this.parser.parse(text, {
      source: SOURCE_OF[turn.source],
      timezone: human?.timezone || "UTC",
      now: this.deps.clock.now(),
      activeProjectId: turn.activeProjectId,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      ...(lastMessage ? { lastMessage } : {}),
    });
    return {
      commands: parsed.commands.map((c) => ({ name: c.name, params: c.params })),
      ...(parsed.question ? { question: parsed.question } : {}),
      matched: parsed.matched,
      // What a stop left not acted on (spec O.9): the clauses beside it, for the reply to name.
      ...(parsed.commands.length && parsed.unmatched.length ? { unmatched: parsed.unmatched } : {}),
    };
  }

  async compose(
    calls: CommandCallLike[],
    turn: CommandTurn,
    opts: { confirmation?: ConfirmationAnswer } = {},
  ): Promise<CommandResultView> {
    const ctx = await this.contextFor(turn);
    const r = await this.executor.compose(calls as CommandCall[], ctx, opts);
    return viewOf(
      r,
      calls.map((c) => c.name),
    );
  }

  async execute(
    call: CommandCallLike,
    turn: CommandTurn,
    opts: { confirmation?: ConfirmationAnswer; actor?: Actor } = {},
  ): Promise<CommandResultView> {
    const ctx = await this.contextFor(turn, opts.actor ? { actor: opts.actor } : {});
    const r = await this.executor.execute({
      name: call.name,
      params: call.params,
      ctx,
      confirmation: opts.confirmation,
    });
    return viewOf(r, [call.name]);
  }

  /**
   * The command tools for the model path. Each is gated by the registry (`gate: "registry"`):
   * the executor confirms by risk and the change card is the one approval, so the hooks file
   * no second request for a high-risk command (RT-P5-3; the always-human rule of the autonomy
   * table keeps applying to every tool that is not a registry command). The actor is the
   * agent, not the human: a command the model decides to call is logged as the agent's act
   * (`author_agent`, no `author_human`) and a `limit` command always asks (ADR 0030 item 2);
   * the human stays `humanId`, whose yes confirms (security-command-actor.test.ts).
   */
  tools(turn: CommandTurn, onResult: (r: CommandResultView) => void): ToolSpec[] {
    return this.commandToolSpecs(turn, onResult).map((spec) => ({ ...spec, gate: "registry" }));
  }

  private commandToolSpecs(
    turn: CommandTurn,
    onResult: (r: CommandResultView) => void,
  ): ToolSpec[] {
    return toToolSpecs(this.registry, {
      execute: async (call) => {
        const r = await this.executor.execute({
          name: call.name,
          params: call.params,
          ctx: call.ctx,
        });
        onResult(viewOf(r, [call.name]));
        return r.status === "pending"
          ? { status: "pending", pendingId: r.pendingId, card: r.card }
          : r.status === "refused"
            ? { status: "refused", reason: r.reason }
            : r.status === "cancelled"
              ? { status: "cancelled" }
              : { status: r.status, sentence: r.sentence };
      },
      ctxFor: () => this.contextFor(turn, { actor: { kind: "agent", id: turn.agentId } }),
    });
  }

  async confirmByText(
    pendingId: string,
    text: string,
    turn: CommandTurn,
  ): Promise<CommandResultView> {
    const pending = this.executor.getPending(pendingId);
    const r = await this.executor.confirmByText(pendingId, text, {
      kind: "human",
      id: turn.humanId,
    });
    return viewOf(r, commandsOf(pending?.card));
  }

  async undo(changeLogId: string | null, turn: CommandTurn): Promise<CommandResultView> {
    const ctx = await this.contextFor(turn);
    const id = changeLogId ?? (await this.executor.undoable(turn.humanId))[0]?.id;
    if (!id) {
      return {
        status: "refused",
        reason: "nothing to undo",
        code: "not_found",
        commands: ["undo"],
      };
    }
    const ended = await this.endedStart(id, turn.humanId);
    if (ended) return ended;
    const r = await this.executor.undo(id, ctx);
    return viewOf(r, ["undo"]);
  }

  /**
   * The undo of a change that is one `session.start` with nothing left to undo (phase 5
   * follow-up RT-P5-2): the row is marked irreversible (the Changes screen stops offering it)
   * and the human is told why, before the executor runs anything. The check is made for that
   * start (`after.start_id`, the scheduler entry the port answered with), so a later start of
   * the same agent, running or not, never stands in for it. A start made from a phone is a
   * remote row (`after.remote_command_id`) the PC runs: while it is `pending` the executor
   * cancels it; while it is `picked_up` the PC is starting the session this instant, so the
   * undo is refused as in flight and the row stays undoable for the next try; once `done`,
   * the id the PC's watcher recorded in the row's result (`startId`) names the start, and a
   * result without one (a runner that records none) cannot be tied to a session, so that undo
   * is refused as such rather than stopping something by guesswork; a `failed` row never ran.
   * A start the registry can still act on (a port that named the session) and a composed
   * change (the start is one part; its undo is a no-op inside the whole) go to the executor
   * as before.
   */
  private async endedStart(
    changeLogId: string,
    humanId: string,
  ): Promise<CommandResultView | null> {
    const check = this.deps.startUndoState;
    if (!check) return null;
    const { store } = this.deps;
    const row = await store.changeLog.get(changeLogId);
    if (row?.undo_state !== "undoable" || row.human_id !== humanId) return null;
    const commands = row.commands as { name?: unknown }[];
    if (commands.length !== 1 || commands[0]?.name !== "session.start") return null;
    const after =
      row.after && typeof row.after === "object" && !Array.isArray(row.after)
        ? (row.after as JsonObject)
        : {};
    if (typeof after.session_id === "string") return null;
    const refused = (reason: string, code: string): CommandResultView => ({
      status: "refused",
      reason,
      code,
      card: null,
      commands: ["undo"],
    });
    let startId = typeof after.start_id === "string" ? after.start_id : undefined;
    let reason = SESSION_START_ENDED_REASON;
    if (typeof after.remote_command_id === "string") {
      const remote = await store.remoteCommand.get(after.remote_command_id);
      if (remote?.status === "pending") return null;
      if (remote?.status === "picked_up") {
        this.logger.info("undo of a session.start deferred: the PC is picking the start up", {
          changeLogId,
          remoteCommandId: remote.id,
        });
        return refused(SESSION_START_IN_FLIGHT_REASON, "unavailable");
      }
      if (remote?.status === "failed") {
        startId = undefined;
        reason = SESSION_START_NOT_RUN_REASON;
      } else {
        startId = remoteStartId(remote?.result);
        if (!startId) reason = SESSION_START_UNKNOWN_REASON;
      }
    }
    const agentId = typeof after.agent_id === "string" ? after.agent_id : row.agent_id;
    if (!agentId || (await check(agentId, startId)) !== "ended") return null;
    await store.changeLog.update(row.id, row.version, { undo_state: "irreversible" });
    this.logger.info("undo of a session.start refused: nothing left to undo", {
      changeLogId,
      reason,
    });
    return refused(reason, "validation");
  }

  activeProject(humanId: string): Promise<string | null> {
    return activeProjectOf(this.deps.store, humanId);
  }

  // -------------------------------------------------------------------------------------
  // The daemon's routes (the UI, the palette, the phone, email replies)

  /** A yes, a tap, an email token or a paired device answers the pending change card. */
  async confirm(pendingId: string, answer: ConfirmationAnswer): Promise<CommandResultView> {
    const pending = this.executor.getPending(pendingId);
    const r = await this.executor.confirm(pendingId, answer);
    return viewOf(r, commandsOf(pending?.card));
  }

  async cancel(pendingId: string, by: Actor): Promise<CommandResultView> {
    const pending = this.executor.getPending(pendingId);
    const r = await this.executor.cancel(pendingId, by);
    return viewOf(r, commandsOf(pending?.card));
  }

  pending(humanId?: string): PendingView[] {
    return this.executor.pending(humanId).map((p) => ({ ...p, cardJson: cardToJson(p.card) }));
  }

  /** The change log (spec Q.11), newest first; `undoable` lists only what can still be undone. */
  async changeLog(
    filter: { humanId?: string; projectId?: string; undoable?: boolean; limit?: number } = {},
  ): Promise<ChangeLogRow[]> {
    const { store, clock } = this.deps;
    if (filter.undoable) {
      return store.changeLog.undoable(
        {
          ...(filter.humanId ? { humanId: filter.humanId } : {}),
          ...(filter.projectId ? { projectId: filter.projectId } : {}),
        },
        clock.nowIso(),
        { limit: filter.limit ?? 100 },
      );
    }
    return store.changeLog.list(
      {
        ...(filter.humanId ? { human_id: filter.humanId } : {}),
        ...(filter.projectId ? { project_id: filter.projectId } : {}),
      } as never,
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: filter.limit ?? 100 },
    );
  }

  /** The last chat line before the current one, for "make this a task". */
  private async lastMessage(turn: CommandTurn): Promise<string | undefined> {
    try {
      const seq = await this.deps.store.event.latestSeq(turn.sessionId);
      const rows = await this.deps.store.event.list(turn.sessionId, Math.max(0, seq - 30), 30);
      for (const e of [...rows].reverse()) {
        if (e.type !== "chat.reply" && e.type !== "chat.human") continue;
        const text = (e.payload as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.trim() && text !== turn.wordsUsed) return text;
      }
    } catch (e) {
      this.logger.warn("could not read the last chat line", { error: errorMessage(e) });
    }
    return undefined;
  }
}

function commandsOf(card: ChangeCard | null | undefined): string[] {
  if (!card) return [];
  return card.parts?.length ? card.parts.map((p) => p.command) : [card.command];
}

/** The port's view of an executor result; the card travels as JSON for the UI. */
export function viewOf(r: ExecuteResult, commands: string[]): CommandResultView {
  const cost = r.card?.impact.costUsdMicro;
  const base: CommandResultView = {
    status: r.status,
    commands,
    card: r.card ? cardToJson(r.card) : null,
    ...(typeof cost === "number" ? { costUsdMicro: cost } : {}),
  };
  switch (r.status) {
    case "done":
      return { ...base, sentence: r.sentence, changeLogId: r.changeLogId, undoToken: r.undoToken };
    case "partial":
      return {
        ...base,
        sentence: r.sentence,
        changeLogId: r.changeLogId,
        undoToken: r.undoToken,
        reason: r.note,
      };
    case "pending":
      return {
        ...base,
        readback: r.readback,
        pendingId: r.pendingId,
        decision: r.decision,
        expiresAt: r.expiresAt,
      };
    case "cancelled":
      return { ...base, pendingId: r.pendingId };
    default:
      return {
        ...base,
        reason: r.reason,
        code: r.code,
        ...(r.pendingId ? { pendingId: r.pendingId } : {}),
      };
  }
}

/**
 * The reason `session.start`'s undo passes to the kill port (`@forerunner/commands`,
 * `commands/session.ts`); the registry test below pins the coupling.
 */
export const SESSION_START_UNDO_REASON = "undo of session.start";
/** What the undo of a `session.start` whose session already ended answers with. */
export const SESSION_START_ENDED_REASON =
  "the session this start began has already ended; there is nothing to undo";
/**
 * The undo of a phone's `session.start` while the PC has taken the remote row but not
 * recorded its result yet: refused for the moment, the row stays undoable.
 */
export const SESSION_START_IN_FLIGHT_REASON =
  "your PC is picking this start up right now; undo it again in a moment";
/** The undo of a phone's `session.start` whose remote row the PC failed: nothing ran. */
export const SESSION_START_NOT_RUN_REASON =
  "this start never ran (the PC refused or dropped it); there is nothing to undo";
/**
 * The undo of a phone's `session.start` whose remote row completed without a start identity
 * (a runner that records none, such as the cloud runner): its session cannot be found from
 * here, so nothing is stopped by guesswork.
 */
export const SESSION_START_UNKNOWN_REASON =
  "the runner that picked this start up recorded no identity for its session, so it cannot be undone from here; stop the session by hand if it still runs";
/** The principal's conversation session is never a work session (`summary` marks it). */
const CONVERSATION_SUMMARY = "conversation";

/**
 * The start id a remote `start` row's result carries (`RemoteCommandWatcher.runStart` writes
 * `{ kind: "start", result, startId }`), or undefined for a result without one.
 */
export function remoteStartId(result: JsonValue | null | undefined): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const id = (result as JsonObject).startId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface SessionStartOutcome {
  /** Never known synchronously: the scheduler starts the runner in the background. */
  sessionId?: string;
  /**
   * The identity of the start: the scheduler's entry id, the same through the queue and the
   * run. `session.start` keeps it in its change log row (`after.start_id`) and its undo names
   * it (`KillScope.startId`), so the undo acts on this start and never on a later one.
   */
  startId: string;
  outcome: StartOutcome;
}

/**
 * What the undo of a `session.start` would do: drop the request still waiting (`pending`:
 * queued behind a running session or deferred by quiet hours), stop the session that start
 * began and that still runs (`running`), or nothing because that session ended, or the row
 * names no start the scheduler knows (`ended`).
 */
export type StartUndoState = "pending" | "running" | "ended";

export interface SessionCommandPorts extends Pick<CommandPorts, "startSession" | "kill"> {
  /**
   * The state of one start of the agent: `startId` is the identity `startSession` answered
   * with. Without it (a row written before starts had one) nothing running is ever matched,
   * so the answer is `ended`.
   */
  startUndoState(agentId: string, startId?: string): Promise<StartUndoState>;
}

const nothingStopped = () => ({ stoppedRuns: 0, killedProcesses: 0 });

/**
 * The session row a running start began, if its run has made it yet: the agent's active row of
 * this install's runner kind with the start's trigger, begun at or after the start (the
 * earliest such). The undo of a `session.start` stops it; `POST /sessions` answers with it.
 */
export async function sessionOfStart(
  store: Pick<StateStore, "session">,
  agentId: string,
  start: Pick<SchedulerLogEntry, "at" | "req">,
  runner: SessionRow["runner"] = "pc",
): Promise<SessionRow | undefined> {
  const rows = (await store.session.active(agentId)).filter(
    (s) =>
      s.summary !== CONVERSATION_SUMMARY &&
      s.runner === runner &&
      s.trigger === start.req.trigger &&
      (s.started_at ?? s.created_at) >= start.at,
  );
  rows.sort((a, b) =>
    (a.started_at ?? a.created_at) < (b.started_at ?? b.created_at)
      ? -1
      : (a.started_at ?? a.created_at) > (b.started_at ?? b.created_at)
        ? 1
        : a.id < b.id
          ? -1
          : 1,
  );
  return rows[0];
}

/**
 * The `startSession` and `kill` ports of the command registry over the scheduler, the kill
 * switch and the store's sessions. `session.start` reports the scheduler's outcome and the
 * start's identity (`startId`; the session id is never known synchronously); its undo
 * arrives as a kill of the agent's scope naming that start (`{ agentId, startId }`) with
 * `SESSION_START_UNDO_REASON` and is answered by `startUndoState`: a start still waiting
 * (queued or deferred, wherever it waits in the line) is dropped, and no other
 * (`Scheduler.cancelPending` with its id); a start whose session still runs
 * (`Scheduler.activeStart` carries its id) is stopped as that session only
 * (`{ agentId, sessionId }`, the row this runner began for it: the agent's active row of this
 * install's runner kind with the start's trigger, begun at or after the start), never as
 * the agent's scope, so the kill switch holds nothing else and the next scheduled session
 * runs; a start that is neither (its session ended) is a no-op that never reaches the kill
 * switch (`CommandLoop.undo` marks such a
 * row irreversible with `SESSION_START_ENDED_REASON`). A later start of the same agent, by
 * hand, from the phone or by schedule, is never mistaken for the one undone, and an undo
 * whose row names no start matches nothing running. A start made from a phone is a remote
 * row the PC's `RemoteCommandWatcher` runs through this same scheduler; the id it records in
 * the row's result is what `session.start`'s undo passes here for such a row. `session.stop`
 * reaches the kill switch unchanged.
 */
export function sessionCommandPorts(deps: {
  scheduler: Pick<Scheduler, "requestStart" | "cancelPending" | "waitingAhead" | "activeStart">;
  kill: {
    stop(
      scope: KillScope | "all",
      reason: string,
    ): Promise<{ stoppedRuns: number; killedProcesses: number }>;
  };
  /** The sessions of the store: the row of the running session an undo stops. */
  store: Pick<StateStore, "session">;
  /** The runner this scheduler starts sessions on (the rows' `runner`); default `pc`. */
  runner?: SessionRow["runner"];
}): SessionCommandPorts {
  const logger = log("session-ports");
  const runner = deps.runner ?? "pc";
  const startUndoState = async (agentId: string, startId?: string): Promise<StartUndoState> => {
    if (!startId) return "ended";
    // Any waiting start, not only the first (U-043: several wait in order now).
    if (deps.scheduler.waitingAhead(agentId, startId) !== undefined) return "pending";
    if (deps.scheduler.activeStart(agentId)?.id === startId) return "running";
    return "ended";
  };
  const sessionOf = (agentId: string, start: SchedulerLogEntry) =>
    sessionOfStart(deps.store, agentId, start, runner);
  return {
    startSession: async (req) => {
      const entry = await deps.scheduler.requestStart({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: req.trigger,
        reason: req.reason,
        ...(req.budgetUsdMicro ? { budgetUsdMicro: req.budgetUsdMicro } : {}),
      } as StartRequest);
      return {
        sessionId: undefined,
        startId: entry.id,
        outcome: entry.result,
      } satisfies SessionStartOutcome;
    },
    kill: async (scope, reason) => {
      if (
        reason === SESSION_START_UNDO_REASON &&
        scope !== "all" &&
        scope.agentId &&
        !scope.sessionId
      ) {
        const { agentId, startId } = scope;
        const state = await startUndoState(agentId, startId);
        if (state === "pending") {
          deps.scheduler.cancelPending(agentId, reason, startId);
          return nothingStopped();
        }
        if (state === "ended") return nothingStopped();
        const start = deps.scheduler.activeStart(agentId);
        const session = start ? await sessionOf(agentId, start) : undefined;
        if (!session) {
          logger.warn("undo of a session.start: the running start has no session row yet", {
            agentId,
            startId,
          });
          return nothingStopped();
        }
        return deps.kill.stop({ agentId, sessionId: session.id }, reason);
      }
      if (scope === "all") return deps.kill.stop(scope, reason);
      // The kill switch's scope is the agent and the session; a start id is the port's.
      const { startId: _startId, ...killScope } = scope;
      return deps.kill.stop(killScope, reason);
    },
    startUndoState,
  };
}

/**
 * The session cap a project's settings hold, as the command registry writes it (spec Q, I):
 * a temporary override ("give it 20 francs tonight") while its window is open, else the
 * permanent `session_cap_usd_micro`, else the given default. The scheduler-started session
 * and the settings screen therefore read the same cap.
 */
export function sessionCapFromSettings(
  settings: JsonObject | null | undefined,
  nowMs: number,
  fallback: number,
): { usdMicro: number; origin: "override" | "setting" | "default"; expiresAt: string | null } {
  const override = settings?.[SESSION_OVERRIDE_KEY];
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const o = override as JsonObject;
    const cap = o.cap_usd_micro;
    const expires = o.expires_at;
    if (
      typeof cap === "number" &&
      Number.isInteger(cap) &&
      cap > 0 &&
      typeof expires === "string" &&
      Date.parse(expires) > nowMs
    )
      return { usdMicro: cap, origin: "override", expiresAt: expires };
  }
  const cap = settings?.[SESSION_CAP_KEY];
  if (typeof cap === "number" && Number.isInteger(cap) && cap > 0)
    return { usdMicro: cap, origin: "setting", expiresAt: null };
  return { usdMicro: fallback, origin: "default", expiresAt: null };
}
