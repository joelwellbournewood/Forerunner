import {
  activeProjectOf,
  type CommandCall,
  type CommandContext,
  type CommandExecutor,
  type CommandPorts,
  type ExecuteResult,
} from "@forerunner/commands";
import {
  type Clock,
  type ErrorCode,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
} from "@forerunner/platform";
import {
  type ChangeSource,
  type DeviceRow,
  type JsonObject,
  type JsonValue,
  MIGRATIONS,
  type StateStore,
} from "@forerunner/state";
import { z } from "zod";
import type { ChatReply, ChatRequest } from "../conversation/agent.ts";
import type { KillReport, KillScope, KillSwitch } from "../enforcement/killswitch.ts";
import type { StartRequest } from "../session/triggers.ts";
import { isYes } from "../wiring/state-ports.ts";
import {
  isRemoteEnvelope,
  RemoteChatParams,
  RemoteEnvelope,
  RemoteKillParams,
  type RemotePlanEnvelope,
  RemoteStartParams,
  RemoteStopParams,
} from "./remote-envelope.ts";

/**
 * Remote commands from the human's paired devices to this PC (spec R.4, ADR 0032). The phone
 * enqueues a `remote_command` with target "pc" through the shared state service; this watcher
 * polls the service's `GET /remote/commands/pending?target=pc` with the runtime's admin token
 * (so the pick-up and the result are announced to the phone in realtime), authorizes the
 * issuing device (same human, not revoked; ADR 0033 item 8b) and acts:
 *
 * - a `plan` envelope runs through the command registry exactly like the settings screen:
 *   the registry plans the change again on the real state (the phone's card is never read),
 *   the confirmation policy decides on the real risk, a medium-risk change takes the human's
 *   confirmation on the device as its tap, a high-risk change files the executor's device
 *   confirmation request and the command waits (`picked_up`) until a paired device answers
 *   it with biometric through the service, or it expires; `undoOf` undoes that change-log row;
 * - a `chat` envelope (or the bare `chat` verb of ADR 0034) is answered by the conversation
 *   agent and completes with `{ reply }`;
 * - the bare verbs `kill`, `stop` and `start` are the daemon's session controls; `pause` is
 *   refused until the runtime can pause a session.
 *
 * Every command ends `done` or `failed` with a result the device shows, plus an audit row.
 */
export const REMOTE_TARGET = "pc" as const;
export const REMOTE_AUDIT_TOOL = "daemon.remote_command";
export const DEFAULT_REMOTE_POLL_MS = 500;

/** One command as the service's pending route returns it. */
export const RemoteCommandView = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  target: z.string(),
  targetDeviceId: z.string().nullable().default(null),
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  status: z.string(),
  createdAt: z.string(),
});
export type RemoteCommand = z.infer<typeof RemoteCommandView>;

/** Where commands come from and where results go: the state service, or a stand-in in tests. */
export interface RemoteCommandQueue {
  /** Atomically take the oldest pending PC command addressed to `deviceId` or to nobody. */
  pickUp(opts: { deviceId?: string }): Promise<RemoteCommand | null>;
  complete(id: string, result: JsonObject): Promise<void>;
  fail(id: string, result: JsonObject): Promise<void>;
}

export interface HttpRemoteCommandQueueOptions {
  /** The state service, e.g. http://127.0.0.1:8788. */
  baseUrl: string;
  /** The service's admin token (the runtime's shared secret; never logged). */
  adminToken: string;
  fetchImpl?: typeof fetch;
  /** `X-Forerunner-Install`: keys the service's admin rate limit per install. */
  installId?: string;
}

/** The three remote-command routes of the state service, as the runtime calls them. */
export class HttpRemoteCommandQueue implements RemoteCommandQueue {
  private readonly base: string;

  constructor(private readonly opts: HttpRemoteCommandQueueOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async pickUp(opts: { deviceId?: string }): Promise<RemoteCommand | null> {
    const q = new URLSearchParams({ target: REMOTE_TARGET });
    if (opts.deviceId) q.set("deviceId", opts.deviceId);
    const res = await this.call("GET", `/remote/commands/pending?${q.toString()}`);
    if (res.status === 204) return null;
    await assertOk(res, "pick up a remote command");
    const parsed = RemoteCommandView.safeParse(await res.json());
    if (!parsed.success) {
      throw new ForerunnerError("validation", "the state service returned a malformed command", {
        details: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }
    return parsed.data;
  }

  async complete(id: string, result: JsonObject): Promise<void> {
    const res = await this.call("POST", `/remote/commands/${encodeURIComponent(id)}/complete`, {
      result,
    });
    await assertOk(res, "report a remote command result");
  }

  async fail(id: string, result: JsonObject): Promise<void> {
    const res = await this.call("POST", `/remote/commands/${encodeURIComponent(id)}/fail`, {
      result,
    });
    await assertOk(res, "report a remote command failure");
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    return fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.adminToken}`,
        accept: "application/json",
        "x-forerunner-schema": String(MIGRATIONS.length),
        ...(this.opts.installId ? { "x-forerunner-install": this.opts.installId } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    detail = [body.code, body.message].filter((x) => typeof x === "string").join(": ");
  } catch {
    // no JSON body
  }
  const code: ErrorCode =
    res.status === 401 || res.status === 403
      ? "provider_auth"
      : res.status === 404
        ? "not_found"
        : res.status === 409
          ? "version_conflict"
          : "unavailable";
  throw new ForerunnerError(
    code,
    `could not ${what}: state service answered ${res.status}${detail ? ` (${detail})` : ""}`,
  );
}

/** The daemon's session start as the watcher needs it: the scheduler's verdict plus the id. */
export type RemoteStartFn = (
  req: StartRequest & { budgetUsdMicro?: number },
) => Promise<{ result: string; sessionId: string | null }>;

export interface RemoteWatcherDeps {
  queue: RemoteCommandQueue;
  store: StateStore;
  clock: Clock;
  /** The human this PC belongs to; only their devices may command it. */
  humanId: string;
  /** Their principal agent: the subject of every session command. */
  agentId: string;
  /** This PC's own device row when the daemon has one; commands addressed elsewhere are refused. */
  deviceId?: string;
  /** The command registry's executor (spec Q) with the daemon's live ports. */
  commands: CommandExecutor;
  ports: CommandPorts;
  /** The conversation agent; null when no model credential is configured. */
  conversation: { chat(req: ChatRequest): Promise<ChatReply> } | null;
  kill: KillSwitch;
  start: RemoteStartFn;
  /** After a kill: the daemon writes the kill file and tells the shells. */
  onKill?: (scope: KillScope | "all", reason: string, report: KillReport) => void;
  /** A plan changed the active project (the daemon tells the conversation agent). */
  onActiveProject?: (humanId: string, projectId: string | null) => void;
  pollMs?: number;
  /** Called after every finished command (tests). */
  onHandled?: (cmd: RemoteCommand, ok: boolean, result: JsonObject) => void;
}

interface PlanMeta {
  executed: string[];
  undoOf: string | null;
}

type Outcome =
  | { kind: "done"; result: JsonObject }
  | {
      kind: "waiting";
      pendingId: string;
      decision: "needs_yes" | "needs_device";
      expiresAt: string;
      ctx: CommandContext;
      meta: PlanMeta;
    };

interface Waiting extends Extract<Outcome, { kind: "waiting" }> {
  cmd: RemoteCommand;
  t0: number;
  settling: boolean;
}

const YES_LIKE = /^\s*(approve|approved|approve on device|confirm|confirmed|yes|ok|ja|oui)\b/i;
const NO_LIKE = /^\s*(no|nope|reject|rejected|decline|declined|cancel|cancelled|nein|non)\b/i;

export class RemoteCommandWatcher {
  private readonly logger = log("daemon:remote");
  private readonly pollMs: number;
  private cancel: (() => void) | null = null;
  private ticking = false;
  private handled = 0;
  private failed = 0;
  private lastKill: KillReport | null = null;
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly deps: RemoteWatcherDeps) {
    this.pollMs = Math.max(100, deps.pollMs ?? DEFAULT_REMOTE_POLL_MS);
  }

  get stats(): { handled: number; failed: number; waiting: number; lastKill: KillReport | null } {
    return {
      handled: this.handled,
      failed: this.failed,
      waiting: this.waiting.size,
      lastKill: this.lastKill,
    };
  }

  /** Ids of the commands waiting for a device confirmation, with their request ids. */
  pendingConfirmations(): { commandId: string; requestId: string; expiresAt: string }[] {
    return [...this.waiting.values()].map((w) => ({
      commandId: w.cmd.id,
      requestId: w.pendingId,
      expiresAt: w.expiresAt,
    }));
  }

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      await this.tick();
      if (this.cancel) this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
    };
    this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** One poll: pick up and run every pending command, then look at the waiting ones. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.warn("remote command poll failed", { error: errorMessage(e) });
    } finally {
      this.ticking = false;
    }
    await this.checkWaiting();
  }

  /** Something changed in the inbox: look at the waiting commands now instead of at the next poll. */
  async wake(): Promise<void> {
    await this.checkWaiting();
  }

  /** Pick up and execute every pending PC command (tests and the daemon's tick). */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const cmd = await this.deps.queue.pickUp({
        ...(this.deps.deviceId ? { deviceId: this.deps.deviceId } : {}),
      });
      if (!cmd) return n;
      n++;
      await this.execute(cmd);
    }
  }

  private async execute(cmd: RemoteCommand): Promise<void> {
    const t0 = this.deps.clock.monotonic();
    let outcome: Outcome;
    try {
      const device = await this.authorize(cmd);
      outcome = await this.run(cmd, device);
    } catch (e) {
      await this.finish(cmd, false, failureResult(e), t0);
      return;
    }
    if (outcome.kind === "waiting") {
      this.waiting.set(cmd.id, { ...outcome, cmd, t0, settling: false });
      this.logger.info("remote command waits for a confirmation", {
        id: cmd.id,
        command: cmd.command,
        requestId: outcome.pendingId,
        decision: outcome.decision,
        expiresAt: outcome.expiresAt,
      });
      return;
    }
    await this.finish(cmd, true, outcome.result, t0);
  }

  /**
   * The issuing device must be a live device of this PC's human. `pickUp` filters on the target
   * only, so another human's phone on a shared state can enqueue for "pc"; it is refused here
   * (`failed`, `forbidden: ...`, audit row) before anything runs. A command addressed to another
   * device is refused too: this PC has no business executing it.
   */
  private async authorize(cmd: RemoteCommand): Promise<DeviceRow> {
    const device = await this.deps.store.device.get(cmd.deviceId);
    if (!device) {
      throw new ForerunnerError("validation", `forbidden: unknown device ${cmd.deviceId}`);
    }
    if (device.owner_human_id !== this.deps.humanId) {
      throw new ForerunnerError("validation", "forbidden: device of another human");
    }
    if (device.revoked) {
      throw new ForerunnerError("validation", "forbidden: revoked device");
    }
    if (cmd.targetDeviceId && cmd.targetDeviceId !== this.deps.deviceId) {
      throw new ForerunnerError(
        "validation",
        `forbidden: addressed to device ${cmd.targetDeviceId}, which is not this PC`,
      );
    }
    return device;
  }

  private async run(cmd: RemoteCommand, device: DeviceRow): Promise<Outcome> {
    if (isRemoteEnvelope(cmd.params)) {
      const parsed = RemoteEnvelope.safeParse(cmd.params);
      if (!parsed.success) {
        throw new ForerunnerError(
          "validation",
          `malformed remote envelope: ${issues(parsed.error)}`,
        );
      }
      return parsed.data.kind === "plan"
        ? this.runPlan(cmd, parsed.data)
        : this.runChat(cmd, parsed.data.text, parsed.data.projectId);
    }
    switch (cmd.command) {
      case "kill":
        return this.runKill(cmd);
      case "stop":
      case "session.stop":
        return this.runStop(cmd);
      case "start":
      case "session.start":
        return this.runStart(cmd);
      case "pause":
      case "session.pause":
        throw new ForerunnerError(
          "not_supported",
          "pause is not supported on the PC runtime yet; stop the session instead",
        );
      case "chat": {
        const p = RemoteChatParams.parse(cmd.params);
        return this.runChat(cmd, p.text, p.projectId);
      }
      default:
        throw new ForerunnerError(
          "validation",
          `unknown remote command ${cmd.command} from device ${device.name}`,
        );
    }
  }

  // -------------------------------------------------------------------------------------
  // Plans (spec Q through the registry)

  private async runPlan(cmd: RemoteCommand, env: RemotePlanEnvelope): Promise<Outcome> {
    const ctx = await this.contextFor({
      wordsUsed: env.wordsUsed,
      source: env.source ?? "ui",
      remoteDeviceId: cmd.deviceId,
    });
    if (env.undoOf) {
      // The one-click undo of a logged change: the registry's own inverse from the row, for the
      // human the change was made for (the executor refuses anyone else).
      const r = await this.deps.commands.undo(env.undoOf, ctx);
      return this.planOutcome(r, { executed: ["undo"], undoOf: env.undoOf }, ctx);
    }
    if (env.plan.length === 0) throw new ForerunnerError("validation", "the plan is empty");
    const calls: CommandCall[] = env.plan.map((s) => ({ name: s.name, params: s.params ?? {} }));
    if (calls.some((c) => c.name === "session.pause")) {
      throw new ForerunnerError(
        "not_supported",
        "session.pause is not supported on the PC runtime yet; stop the session instead",
      );
    }
    // Decide on the registry's own card for the real state, never on the phone's card.
    const card = await this.deps.commands.planCompose(calls, ctx);
    const decision = this.deps.commands.policy.decide(card.impact.risk, ctx.actor, ctx.source, {
      limitChange: calls.some((c) => this.deps.commands.registry.get(c.name)?.limit === true),
    });
    // The human confirmed the card on their device: for a medium-risk change that is the tap
    // the policy accepts. High risk needs a device answer with biometric, which only the
    // confirmation request the executor files can carry; the command then waits for it.
    const confirmation =
      decision === "needs_yes" && env.confirmedAt
        ? ({ kind: "tap", by: ctx.actor, source: ctx.source } as const)
        : undefined;
    const r = await this.deps.commands.compose(calls, ctx, confirmation ? { confirmation } : {});
    return this.planOutcome(r, { executed: calls.map((c) => c.name), undoOf: null }, ctx);
  }

  private async planOutcome(
    r: ExecuteResult,
    meta: PlanMeta,
    ctx: CommandContext,
  ): Promise<Outcome> {
    switch (r.status) {
      case "done":
      case "partial": {
        const sessionId = await this.sessionIdOf(r.changeLogId);
        if (meta.executed.includes("project.switch") || meta.undoOf) {
          this.deps.onActiveProject?.(ctx.humanId, await activeProjectOf(ctx.store, ctx.humanId));
        }
        const result: JsonObject = {
          executed: meta.executed,
          changeLogId: r.changeLogId,
          undoOf: meta.undoOf,
          undoToken: r.undoToken,
          sentence: r.sentence,
          status: r.status,
          ...(r.status === "partial" ? { note: r.note } : {}),
          ...(sessionId ? { sessionId } : {}),
        };
        return { kind: "done", result };
      }
      case "pending":
        return {
          kind: "waiting",
          pendingId: r.pendingId,
          decision: r.decision,
          expiresAt: r.expiresAt,
          ctx,
          meta,
        };
      case "cancelled":
        throw new ForerunnerError("approval_required", "the change was declined", {
          details: { requestId: r.pendingId },
        });
      case "refused":
        throw new ForerunnerError(r.code, r.reason, {
          details: r.pendingId ? { requestId: r.pendingId } : {},
        });
      default:
        throw new ForerunnerError("internal", "unexpected executor result");
    }
  }

  /** The session a logged `session.start` recorded, for the result and the phone's live view. */
  private async sessionIdOf(changeLogId: string): Promise<string | null> {
    const row = await this.deps.store.changeLog.get(changeLogId);
    if (!row) return null;
    const afters: JsonValue[] = Array.isArray(row.after) ? row.after : [row.after];
    for (const a of afters) {
      if (a && typeof a === "object" && !Array.isArray(a) && typeof a.session_id === "string") {
        return a.session_id;
      }
    }
    return null;
  }

  private async contextFor(over: {
    wordsUsed: string;
    source: ChangeSource;
    remoteDeviceId: string;
  }): Promise<CommandContext> {
    const human = await this.deps.store.human.mustGet(this.deps.humanId);
    const conversation = await this.deps.store.session.list(
      { agent_id: this.deps.agentId, trigger: "manual", summary: "conversation" } as never,
      { limit: 1 },
    );
    return {
      actor: { kind: "human", id: this.deps.humanId },
      humanId: this.deps.humanId,
      agentId: this.deps.agentId,
      activeProjectId: await activeProjectOf(this.deps.store, this.deps.humanId),
      store: this.deps.store,
      clock: this.deps.clock,
      ports: this.deps.ports,
      source: over.source,
      wordsUsed: over.wordsUsed,
      timezone: human.timezone,
      // The plan runs here, on the PC: the device is this machine, never the phone, or the
      // registry would enqueue session.start as another remote command (ADR 0030 item 7).
      deviceId: this.deps.deviceId ?? null,
      // Session commands record the phone as the session's device, trigger "remote".
      remoteDeviceId: over.remoteDeviceId,
      sessionId: conversation[0]?.id ?? null,
    };
  }

  // -------------------------------------------------------------------------------------
  // Waiting for a device confirmation

  /** Settle every command whose confirmation request was answered, expired or withdrawn. */
  async checkWaiting(): Promise<void> {
    for (const w of [...this.waiting.values()]) {
      if (w.settling) continue;
      w.settling = true;
      let done: { ok: boolean; result: JsonObject } | null;
      try {
        done = await this.settle(w);
      } catch (e) {
        done = { ok: false, result: failureResult(e) };
      } finally {
        w.settling = false;
      }
      if (!done) continue;
      this.waiting.delete(w.cmd.id);
      await this.finish(w.cmd, done.ok, done.result, w.t0);
    }
  }

  private async settle(w: Waiting): Promise<{ ok: boolean; result: JsonObject } | null> {
    const row = await this.deps.store.humanRequest.get(w.pendingId);
    const pending = this.deps.commands.getPending(w.pendingId);
    if (!row) {
      throw new ForerunnerError("not_found", "the confirmation request no longer exists", {
        details: { requestId: w.pendingId },
      });
    }
    if (row.status === "open") {
      if (pending) return null;
      throw new ForerunnerError(
        "approval_required",
        "the confirmation expired before it was answered; ask again",
        { details: { requestId: w.pendingId } },
      );
    }
    if (row.status !== "answered") {
      throw new ForerunnerError("approval_required", `the confirmation was ${row.status}`, {
        details: { requestId: w.pendingId },
      });
    }
    if (!pending) {
      throw new ForerunnerError(
        "approval_required",
        "the confirmation was answered after it expired; ask again",
        { details: { requestId: w.pendingId } },
      );
    }
    const by = { kind: "human", id: this.deps.humanId } as const;
    const answer = readAnswer(row.answer);
    let r: ExecuteResult;
    if (answer.verdict === "declined") {
      await this.deps.commands.cancel(w.pendingId, by);
      throw new ForerunnerError("approval_required", "the change was declined on the device", {
        details: { requestId: w.pendingId },
      });
    }
    if (answer.verdict === "unknown") {
      await this.deps.commands.cancel(w.pendingId, by);
      throw new ForerunnerError("validation", "the answer to the confirmation was not understood", {
        details: { requestId: w.pendingId },
      });
    }
    if (answer.deviceId) {
      r = await this.deps.commands.confirmFromDevice(
        w.pendingId,
        { deviceId: answer.deviceId, biometric: answer.biometric },
        by,
      );
    } else if (w.decision === "needs_yes" && row.answered_by === this.deps.humanId) {
      // A yes from the inbox without a device is enough for a medium-risk change.
      r = await this.deps.commands.confirm(w.pendingId, { kind: "tap", by });
    } else {
      await this.deps.commands.cancel(w.pendingId, by);
      throw new ForerunnerError(
        "approval_required",
        "a high-risk change needs the answer from a paired device with biometric; the answer named no device",
        { details: { requestId: w.pendingId } },
      );
    }
    if (r.status === "refused") {
      // A phone without biometric, a revoked device, a risk that rose: the pending entry would
      // otherwise sit until its TTL; the human asks again with a fresh card.
      if (this.deps.commands.getPending(w.pendingId)) {
        await this.deps.commands.cancel(w.pendingId, by);
      }
      throw new ForerunnerError(r.code, r.reason, { details: { requestId: w.pendingId } });
    }
    const outcome = await this.planOutcome(r, w.meta, w.ctx);
    if (outcome.kind !== "done") {
      throw new ForerunnerError("internal", "a confirmed change asked for another confirmation");
    }
    return { ok: true, result: { ...outcome.result, confirmedBy: answer.deviceId ?? "inbox" } };
  }

  // -------------------------------------------------------------------------------------
  // Chat and the bare verbs

  private async runChat(cmd: RemoteCommand, text: string, projectId?: string): Promise<Outcome> {
    if (!this.deps.conversation) {
      throw new ForerunnerError("provider_auth", "no model credential configured; chat is off");
    }
    const r = await this.deps.conversation.chat({
      humanId: this.deps.humanId,
      agentId: this.deps.agentId,
      ...(projectId ? { projectId } : {}),
      text,
      source: "phone",
    });
    return {
      kind: "done",
      result: {
        reply: r.reply,
        actions: r.actions.map((a) => ({ kind: a.kind, summary: a.summary, id: a.id ?? null })),
        transcriptId: r.transcriptId,
        activeProjectId: r.activeProjectId,
        ttftMs: r.ttftMs,
        ...(r.pendingConfirmation
          ? {
              pendingConfirmation: {
                id: r.pendingConfirmation.id,
                readback: r.pendingConfirmation.readback,
              },
            }
          : {}),
        ...(cmd.params.clientId ? { clientId: String(cmd.params.clientId) } : {}),
      },
    };
  }

  private async runKill(cmd: RemoteCommand): Promise<Outcome> {
    const p = RemoteKillParams.parse(cmd.params);
    const reason = `remote kill from device ${cmd.deviceId}${p.reason ? `: ${p.reason}` : ""}`;
    const report = await this.deps.kill.stop(p.scope, reason);
    this.lastKill = report;
    this.deps.onKill?.(p.scope, reason, report);
    return {
      kind: "done",
      result: {
        stoppedRuns: report.stoppedRuns,
        killedProcesses: report.killedProcesses,
        revokedTokens: report.revokedTokens,
        killDurationMs: report.durationMs,
        killActive: this.deps.kill.isFrozen({ agentId: this.deps.agentId }),
      },
    };
  }

  private async runStop(cmd: RemoteCommand): Promise<Outcome> {
    const p = RemoteStopParams.parse(cmd.params);
    if (p.agentId && p.agentId !== this.deps.agentId) {
      throw new ForerunnerError(
        "validation",
        `forbidden: agent ${p.agentId} is not this PC's agent`,
      );
    }
    let scope: KillScope | "all";
    if (p.scope === "all") scope = "all";
    else if (p.scope === "agent") scope = { agentId: this.deps.agentId };
    else if (p.scope === "session") {
      if (!p.session) {
        throw new ForerunnerError("validation", "stop with scope session needs a session id");
      }
      scope = { sessionId: p.session };
    } else {
      if (p.scope.agentId && p.scope.agentId !== this.deps.agentId) {
        throw new ForerunnerError(
          "validation",
          `forbidden: agent ${p.scope.agentId} is not this PC's agent`,
        );
      }
      scope = { agentId: p.scope.agentId ?? this.deps.agentId, ...p.scope };
    }
    // Stop the work but leave the PC free to start new sessions: stop, then lift the freeze.
    const report = await this.deps.kill.stop(
      scope,
      `remote stop from device ${cmd.deviceId}${p.reason ? `: ${p.reason}` : ""}`,
    );
    this.deps.kill.resume();
    return {
      kind: "done",
      result: {
        stoppedRuns: report.stoppedRuns,
        killedProcesses: report.killedProcesses,
        killDurationMs: report.durationMs,
      },
    };
  }

  private async runStart(cmd: RemoteCommand): Promise<Outcome> {
    const p = RemoteStartParams.parse(cmd.params);
    if (p.agentId && p.agentId !== this.deps.agentId) {
      throw new ForerunnerError(
        "validation",
        `forbidden: agent ${p.agentId} is not this PC's agent`,
      );
    }
    // A start after a kill lifts the freeze: the human asked for work explicitly.
    this.deps.kill.resume();
    const started = await this.deps.start({
      agentId: this.deps.agentId,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      trigger: "remote",
      reason: p.reason ?? `remote start from device ${cmd.deviceId}`,
      ...(p.budgetUsdMicro ? { budgetUsdMicro: p.budgetUsdMicro } : {}),
    });
    return {
      kind: "done",
      result: { result: started.result, sessionId: started.sessionId },
    };
  }

  // -------------------------------------------------------------------------------------
  // Reporting

  private async finish(
    cmd: RemoteCommand,
    ok: boolean,
    result: JsonObject,
    t0: number,
  ): Promise<void> {
    const full = { ...result, durationMs: Math.round(this.deps.clock.monotonic() - t0) };
    try {
      if (ok) await this.deps.queue.complete(cmd.id, full);
      else await this.deps.queue.fail(cmd.id, full);
    } catch (e) {
      this.logger.warn("could not record the remote command result", {
        id: cmd.id,
        error: errorMessage(e),
      });
    }
    await this.audit(cmd, ok, full);
    this.handled++;
    if (!ok) this.failed++;
    this.logger.info("remote command handled", { id: cmd.id, command: cmd.command, ok });
    this.deps.onHandled?.(cmd, ok, full);
  }

  private async audit(cmd: RemoteCommand, ok: boolean, result: JsonObject): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        tool: REMOTE_AUDIT_TOOL,
        allowed: ok,
        denied_reason: ok ? null : String(result.error ?? "failed"),
        agent_id: this.deps.agentId,
        human_id: this.deps.humanId,
        input_summary: JSON.stringify({
          commandId: cmd.id,
          command: cmd.command,
          deviceId: cmd.deviceId,
          params: cmd.params,
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

function failureResult(e: unknown): JsonObject {
  return {
    error: errorMessage(e),
    code: isForerunnerError(e) ? e.code : "internal",
  };
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * What an answered confirmation request says. The state service records a device's answer to
 * a command confirmation as `{ choice, kind: "device", by, device_id, biometric }` (the shape
 * the executor writes itself); the daemon's own answer route and older clients store the raw
 * choice. "approve", "approve on device", "yes" and the executor's `verdict: "confirmed"` all
 * approve; "reject", "no" and `verdict: "declined"` decline.
 */
export function readAnswer(answer: JsonValue | null): {
  verdict: "approved" | "declined" | "unknown";
  deviceId?: string;
  biometric: boolean;
} {
  const obj =
    answer && typeof answer === "object" && !Array.isArray(answer)
      ? (answer as Record<string, JsonValue>)
      : null;
  const deviceId =
    obj && typeof obj.device_id === "string"
      ? obj.device_id
      : obj && typeof obj.deviceId === "string"
        ? obj.deviceId
        : undefined;
  const biometric = obj?.biometric === true;
  const verdictField = obj && typeof obj.verdict === "string" ? obj.verdict : null;
  const choice: JsonValue | null = obj ? (obj.choice ?? obj.answer ?? verdictField) : answer;
  let verdict: "approved" | "declined" | "unknown" = "unknown";
  if (choice === true || verdictField === "confirmed") verdict = "approved";
  else if (choice === false || verdictField === "declined") verdict = "declined";
  else if (typeof choice === "string") {
    if (isYes(choice) || YES_LIKE.test(choice)) verdict = "approved";
    else if (NO_LIKE.test(choice)) verdict = "declined";
  }
  return { verdict, biometric, ...(deviceId ? { deviceId } : {}) };
}
