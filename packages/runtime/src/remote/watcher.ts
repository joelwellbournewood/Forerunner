import type { ChangeCard } from "@forerunner/commands";
import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  JsonValue,
  RemoteCommandRow,
  StateStore,
} from "@forerunner/state";
import { z } from "zod";
import type { ChatReply, ChatRequest } from "../conversation/agent.ts";
import type { KillReport, KillScope, KillSwitch } from "../enforcement/killswitch.ts";
import type { CommandLoop, PendingView } from "../loop/commands.ts";
import type { CommandResultView, CommandTurn } from "../loop/ports.ts";
import type { StartRequest } from "../session/triggers.ts";

/**
 * Remote commands for the PC (spec R.4, R.8, Q.12; ADR 0032 item 4, ADR 0041). A paired phone
 * or web client enqueues a `remote_command` with target "pc" through the state service; the
 * daemon polls the shared store every `pollMs` (500 ms by default), takes one row atomically
 * (`RemoteCommandRepo.pickUp`, so two daemons of one human never run the same command) and
 * executes it:
 *
 * - `params.kind: "plan"` (the phone's envelope: module-Q commands behind ONE change card) runs
 *   through the command registry with the same enforcement as the settings screen: the
 *   executor plans every step against the real state, a low-risk plan acts at once, the tap
 *   the phone recorded (`confirmedAt`) answers a medium-risk card, and a high-risk card stays
 *   a `human_request` the phone answers with its biometric (`confirm:high`); the daemon then
 *   applies that answer to the pending card (`syncAnswered`).
 * - `params.kind: "chat"` is one turn of the conversation agent for the principal.
 * - a plain `kill` / `stop` / `pause` / `start` (the approvals web, the state service API, the
 *   registry's own remote rows `session.*`) goes through the kill switch, the registry's
 *   `session.pause` (whose port in the daemon, `wiring/session-ports.ts`, ends a session
 *   running here at the next task boundary) and the scheduler.
 *
 * Authorisation has two lines: the store's `pickUp` takes only rows whose issuing device
 * belongs to the human who owns this daemon's agent (another human's command stays pending
 * for their own PC), and `authorize` loads the issuing device before every command and
 * refuses an unknown, revoked or foreign device (`failed`, `forbidden: ...`, audit row) without
 * acting. A `start` may name no agent but this daemon's. Every command ends `done` or `failed`
 * with a result the phone reads back, plus one `audit_log` row (`daemon.remote_command`).
 * A kill reaches the kill switch within one poll, so a session stops within 2 s of the tap.
 *
 * One tap acts once. The phone's outbox POSTs an envelope until it is acknowledged, and the
 * state service dedupes per device and `clientId`; as the second line, an envelope whose
 * (issuing device, clientId) this daemon already handled (in this process, or in an audit
 * row of the last `duplicateWindowMs`) is refused (`failed`, `status: "duplicate"`, the first
 * row's id as `duplicateOf`, an audit row) without composing anything, so a copy that slipped
 * past the service (two services, a restored backup, a row older than the service's week)
 * never starts a second session or raises a budget twice.
 */
export const REMOTE_AUDIT_TOOL = "daemon.remote_command";
/**
 * How far back the watcher reads audit rows for an earlier handling of the same (device,
 * clientId) when its own memory has none: a month, well beyond the service's seven-day
 * idempotency record, so a replay that outlived the service's memory is still refused.
 */
export const DEFAULT_DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How many (device, clientId) pairs this process remembers before the oldest is forgotten. */
const SEEN_MAX = 5_000;
export const PC_REMOTE_TARGET = "pc" as const;
export const DEFAULT_REMOTE_POLL_MS = 500;
/**
 * A tap older than a change card's own life no longer confirms a medium-risk card. Equal to
 * the executor's `PENDING_TTL_MS` (`@forerunner/commands`; the test pins it) but spelled out
 * here because that package's module graph reaches back into this one and a live import
 * would be read before it is initialised.
 */
export const DEFAULT_TAP_MAX_AGE_MS = 10 * 60 * 1000;
/** How far ahead of this clock a phone's `confirmedAt` may be (clocks drift). */
export const TAP_MAX_SKEW_MS = 2 * 60_000;

/**
 * Whether the phone's `confirmedAt` is a tap this drain may count as the answer to a
 * medium-risk card: parseable, at most `maxAgeMs` old and at most `TAP_MAX_SKEW_MS` ahead.
 * The phone's offline outbox (spec R.3) replays queued envelopes after a reconnect, so a tap
 * recorded days earlier must not confirm a change later; the card then waits for a yes.
 */
export function isFreshTap(
  confirmedAt: string | undefined,
  nowMs: number,
  maxAgeMs: number = DEFAULT_TAP_MAX_AGE_MS,
): boolean {
  if (!confirmedAt) return false;
  const t = Date.parse(confirmedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs && t - nowMs <= TAP_MAX_SKEW_MS;
}

const PlanStep = z.object({
  name: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** The phone's plan envelope (ADR 0032 item 4). */
export const PlanEnvelope = z.object({
  v: z.literal(1),
  kind: z.literal("plan"),
  plan: z.array(PlanStep).min(1).max(20),
  wordsUsed: z.string().max(2_000).default(""),
  card: z.record(z.string(), z.unknown()).optional(),
  clientId: z.string().max(200).optional(),
  /** When the human tapped the card on the phone; that tap answers a medium-risk card. */
  confirmedAt: z.string().max(64).optional(),
  undoOf: z.string().max(200).optional(),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelope>;

/** The phone's quick-chat envelope. */
export const ChatEnvelope = z.object({
  v: z.literal(1),
  kind: z.literal("chat"),
  text: z.string().min(1).max(4_000),
  projectId: z.string().max(200).nullable().optional(),
  clientId: z.string().max(200).optional(),
});
export type ChatEnvelope = z.infer<typeof ChatEnvelope>;

const ScopeObject = z.object({ agentId: z.string().optional(), sessionId: z.string().optional() });

/** `kill` and `stop` parameters: the runner's shape and the registry's `session.stop` shape. */
export const StopParams = z.object({
  scope: z
    .union([z.literal("all"), z.literal("agent"), z.literal("session"), ScopeObject])
    .default("agent"),
  session: z.string().nullable().optional(),
  agentId: z.string().optional(),
  reason: z.string().max(200).optional(),
});

export const PauseParams = z.object({
  session: z.string().nullable().optional(),
  reason: z.string().max(200).optional(),
});

export const StartParams = z.object({
  agentId: z.string().optional(),
  projectId: z.string().optional(),
  budgetUsdMicro: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
});

export type RemoteVerb = "kill" | "stop" | "pause" | "start";

/** The verb of a row: the phone's four verbs and the registry's `session.*` remote rows. */
export function verbOf(command: string): RemoteVerb | null {
  switch (command) {
    case "kill":
      return "kill";
    case "stop":
    case "session.stop":
      return "stop";
    case "pause":
    case "session.pause":
      return "pause";
    case "start":
    case "session.start":
      return "start";
    default:
      return null;
  }
}

export interface RemoteCommandDeps {
  store: Pick<StateStore, "remoteCommand" | "auditLog" | "device" | "humanRequest">;
  clock: Clock;
  kill: Pick<KillSwitch, "stop" | "resume">;
  /** A plain `start`: the scheduler's request (the registry's `session.start` uses the same port). */
  start: (
    req: StartRequest & { budgetUsdMicro?: number },
  ) => Promise<"started" | "queued" | "deferred" | "skipped">;
  /** The command registry in the loop: plans, pauses and the answers to pending cards. */
  commands: Pick<CommandLoop, "compose" | "confirm" | "cancel" | "pending" | "activeProject">;
  /** One conversation turn for `kind: "chat"`; null when no model credential is configured. */
  chat: ((req: ChatRequest) => Promise<ChatReply>) | null;
  /** The principal's conversation session: the activity log a plan's sentence goes to. */
  conversationSessionId: () => Promise<string>;
  /** This daemon's own `desktop` device row (commands can be addressed to it). */
  deviceId: string;
  agentId: string;
  humanId: string;
  pollMs?: number;
  /** How old the phone's `confirmedAt` may be to count as a tap (default: the card's TTL). */
  tapMaxAgeMs?: number;
  /** How far back audit rows are read for a replayed envelope (default: 30 days). */
  duplicateWindowMs?: number;
  /** Called after every handled command (tests). */
  onHandled?: (row: RemoteCommandRow, result: JsonObject) => void;
}

interface Outcome {
  ok: boolean;
  result: JsonObject;
}

export class RemoteCommandWatcher {
  private readonly logger = log("daemon:remote");
  private readonly pollMs: number;
  private readonly tapMaxAgeMs: number;
  private readonly duplicateWindowMs: number;
  /** (device, clientId) -> the id of the row that handled the envelope, in this process. */
  private readonly seen = new Map<string, string>();
  private cancel: (() => void) | null = null;
  private handled = 0;
  private refusedCards = 0;
  private duplicates = 0;
  private lastKill: KillReport | null = null;
  private draining: Promise<number> | null = null;

  constructor(private readonly deps: RemoteCommandDeps) {
    this.pollMs = Math.max(100, deps.pollMs ?? DEFAULT_REMOTE_POLL_MS);
    this.tapMaxAgeMs = Math.max(0, deps.tapMaxAgeMs ?? DEFAULT_TAP_MAX_AGE_MS);
    this.duplicateWindowMs = Math.max(0, deps.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS);
  }

  get stats(): {
    handled: number;
    refusedCards: number;
    duplicates: number;
    lastKill: KillReport | null;
    running: boolean;
    pollMs: number;
  } {
    return {
      handled: this.handled,
      refusedCards: this.refusedCards,
      duplicates: this.duplicates,
      lastKill: this.lastKill,
      running: this.cancel !== null,
      pollMs: this.pollMs,
    };
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

  /**
   * Pick up and execute every pending PC command of this human, then apply the answers the
   * inbox gave to pending change cards. Exposed for tests and the health view; a call while
   * one runs joins it.
   */
  drain(): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<number> {
    let n = 0;
    for (;;) {
      const row = await this.deps.store.remoteCommand.pickUp(PC_REMOTE_TARGET, {
        deviceId: this.deps.deviceId,
        agentId: this.deps.agentId,
      });
      if (!row) break;
      n++;
      await this.handle(row);
    }
    await this.syncAnswered();
    return n;
  }

  /** Execute one picked-up row: authorise, run, record the result and the audit row. */
  async handle(row: RemoteCommandRow): Promise<JsonObject> {
    const t0 = this.deps.clock.monotonic();
    let outcome: Outcome;
    try {
      await this.authorize(row);
      outcome = await this.run(row);
    } catch (e) {
      outcome = { ok: false, result: { error: errorMessage(e), code: codeOf(e) } };
    }
    const result: JsonObject = {
      ...outcome.result,
      durationMs: Math.round(this.deps.clock.monotonic() - t0),
    };
    try {
      if (outcome.ok) await this.deps.store.remoteCommand.complete(row.id, result);
      else await this.deps.store.remoteCommand.fail(row.id, result);
    } catch (e) {
      this.logger.warn("could not record the remote command result", {
        id: row.id,
        error: errorMessage(e),
      });
    }
    await this.audit(row, outcome.ok, result);
    this.remember(row, result);
    this.handled++;
    this.logger.info("remote command handled", {
      id: row.id,
      command: row.command,
      ok: outcome.ok,
    });
    this.deps.onHandled?.(row, result);
    return result;
  }

  /**
   * The issuing device must be a live device of this daemon's human. The store's `pickUp`
   * already keeps other humans' rows away (first line); this is the second line, and the one
   * that refuses a revoked device of the owner visibly.
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

  private async run(row: RemoteCommandRow): Promise<Outcome> {
    const params = row.params ?? {};
    const plan = PlanEnvelope.safeParse(params);
    if (plan.success) {
      return (await this.replayOf(row, plan.data.clientId)) ?? this.runPlan(plan.data);
    }
    const chat = ChatEnvelope.safeParse(params);
    if (chat.success) {
      return (await this.replayOf(row, chat.data.clientId)) ?? this.runChat(row, chat.data);
    }
    const kind = (params as { kind?: unknown }).kind;
    if (kind === "plan" || kind === "chat") {
      const issues = (kind === "plan" ? plan : chat).success
        ? ""
        : (kind === "plan" ? plan : chat).error?.issues.map((i) => i.message).join("; ");
      throw new ForerunnerError("validation", `malformed ${kind} envelope: ${issues}`);
    }
    switch (verbOf(row.command)) {
      case "kill":
        return this.runKill(row, "kill");
      case "stop":
        return this.runKill(row, "stop");
      case "pause":
        return this.runPause(row);
      case "start":
        return this.runStart(row);
      default:
        throw new ForerunnerError("validation", `unknown remote command ${row.command}`);
    }
  }

  // -------------------------------------------------------------------------------------
  // The phone's envelopes

  /**
   * The failed outcome of a replayed envelope, or null when this (issuing device, clientId)
   * is new. Defence in depth behind the state service's per-device idempotency on
   * `POST /remote/commands`: the first handling is looked up in this process's memory, then
   * in the audit rows of the last `duplicateWindowMs` (every handled envelope's row names
   * its device and clientId), so a duplicate row that two services or a restored backup let
   * through fails with the first row's id instead of acting a second time. The lookup runs
   * before anything is composed; nothing in a refused replay reaches the registry.
   */
  private async replayOf(
    row: RemoteCommandRow,
    clientId: string | undefined,
  ): Promise<Outcome | null> {
    if (!clientId) return null;
    const first = await this.handledBefore(row.device_id, clientId);
    if (!first || first === row.id) return null;
    this.duplicates++;
    this.logger.warn("replayed envelope refused: it was already handled", {
      id: row.id,
      duplicateOf: first,
      clientId,
    });
    return {
      ok: false,
      result: {
        kind: envelopeKind(row.params),
        status: "duplicate",
        error: `duplicate: envelope ${clientId} from device ${row.device_id} was already handled as command ${first}`,
        code: "duplicate",
        duplicateOf: first,
        clientId,
      },
    };
  }

  /** The id of the row that already handled (device, clientId), or null. */
  private async handledBefore(deviceId: string, clientId: string): Promise<string | null> {
    const local = this.seen.get(seenKey(deviceId, clientId));
    if (local) return local;
    const from = new Date(this.deps.clock.now() - this.duplicateWindowMs).toISOString();
    const rows = await this.deps.store.auditLog.list({
      tool: REMOTE_AUDIT_TOOL,
      agentId: this.deps.agentId,
      from,
    });
    for (const a of rows) {
      if (!a.input_summary.includes(clientId)) continue;
      const input = parseAuditInput(a.input_summary);
      if (input?.deviceId === deviceId && input.clientId === clientId) {
        return typeof input.commandId === "string" ? input.commandId : a.id;
      }
    }
    return null;
  }

  /** Remember a handled envelope's (device, clientId) under the row that handled it first. */
  private remember(row: RemoteCommandRow, result: JsonObject): void {
    const clientId = envelopeClientId(row.params);
    if (!clientId) return;
    const key = seenKey(row.device_id, clientId);
    if (this.seen.has(key)) return;
    const first = typeof result.duplicateOf === "string" ? result.duplicateOf : row.id;
    this.seen.set(key, first);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private async runPlan(env: PlanEnvelope): Promise<Outcome> {
    const calls = env.plan.map((s) => ({ name: s.name, params: s.params }));
    // A start after a kill lifts the freeze: the human asked for work explicitly (ADR 0033).
    if (calls.some((c) => c.name === "session.start")) this.deps.kill.resume();
    const turn = await this.turn(env.wordsUsed);
    let r = await this.deps.commands.compose(calls, turn);
    if (r.status === "pending" && r.decision === "needs_yes" && r.pendingId && env.confirmedAt) {
      // The human tapped the card on the phone: a recent tap answers a medium-risk card (ADR
      // 0030 item 3); one the outbox replayed from long ago leaves the card waiting for a yes
      // in the inbox. A high-risk card needs the device answer and stays open either way.
      if (isFreshTap(env.confirmedAt, this.deps.clock.now(), this.tapMaxAgeMs)) {
        r = await this.deps.commands.confirm(r.pendingId, {
          kind: "tap",
          by: { kind: "human", id: this.deps.humanId },
          source: "chat",
        });
      } else {
        this.logger.warn("the phone's tap is too old to confirm the card; it waits for a yes", {
          pendingId: r.pendingId,
          confirmedAt: env.confirmedAt,
        });
      }
    }
    const result: JsonObject = {
      kind: "plan",
      ...viewToJson(r),
      executed: r.status === "done" || r.status === "partial" ? r.commands : [],
      clientId: env.clientId ?? null,
      undoOf: env.undoOf ?? null,
    };
    if (r.status === "refused" || r.status === "cancelled") {
      return {
        ok: false,
        result: { ...result, error: r.reason ?? `plan ${r.status}` },
      };
    }
    return { ok: true, result };
  }

  private async runChat(row: RemoteCommandRow, env: ChatEnvelope): Promise<Outcome> {
    if (!this.deps.chat) {
      throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
    }
    const reply = await this.deps.chat({
      humanId: this.deps.humanId,
      agentId: this.deps.agentId,
      ...(env.projectId ? { projectId: env.projectId } : {}),
      text: env.text,
      source: "phone",
      // The PC runs the registry's session commands itself; the phone's device would route
      // them back into this queue.
      deviceId: this.deps.deviceId,
    });
    const pending = reply.pendingConfirmation;
    return {
      ok: true,
      result: {
        kind: "chat",
        reply: reply.reply,
        actions: reply.actions.map((a) => ({
          kind: a.kind,
          summary: a.summary,
          id: a.id ?? null,
          undoToken: a.undoToken ?? null,
        })),
        pendingConfirmation: pending
          ? {
              id: pending.id,
              readback: pending.readback,
              commands: pending.commands,
              decision: pending.decision ?? null,
              costUsdMicro: pending.costUsdMicro ?? null,
            }
          : null,
        question: reply.question,
        costUsdMicro: reply.costUsdMicro,
        activeProjectId: reply.activeProjectId,
        clientId: env.clientId ?? null,
        issuedBy: row.device_id,
      },
    };
  }

  // -------------------------------------------------------------------------------------
  // The plain verbs

  private async runKill(row: RemoteCommandRow, verb: "kill" | "stop"): Promise<Outcome> {
    const params = StopParams.parse(row.params ?? {});
    const scope = this.scopeOf(params, verb);
    const reason = `remote ${verb} from device ${row.device_id}${params.reason ? `: ${params.reason}` : ""}`;
    const report = await this.deps.kill.stop(scope, reason);
    this.lastKill = report;
    // A stop ends the runs but leaves the daemon free to start new ones; a kill freezes.
    if (verb === "stop") this.deps.kill.resume();
    return {
      ok: true,
      result: {
        kind: verb,
        stopped: true,
        stoppedRuns: report.stoppedRuns,
        killedProcesses: report.killedProcesses,
        revokedTokens: report.revokedTokens,
        killDurationMs: report.durationMs,
        frozen: verb === "kill",
      },
    };
  }

  /** The kill scope of a `kill`/`stop` row; a scope naming another agent is refused. */
  private scopeOf(params: z.infer<typeof StopParams>, verb: "kill" | "stop"): KillScope | "all" {
    const own = this.deps.agentId;
    const assertOwn = (agentId: string | undefined): void => {
      if (agentId && agentId !== own) {
        throw new ForerunnerError(
          "validation",
          `forbidden: agent ${agentId} is not this PC's agent`,
        );
      }
    };
    const scope = params.scope;
    if (scope === "all") return verb === "kill" ? "all" : { agentId: own };
    if (scope === "session") {
      if (!params.session) {
        throw new ForerunnerError("validation", `${verb} with scope session needs a session id`);
      }
      return { sessionId: params.session };
    }
    if (scope === "agent") {
      assertOwn(params.agentId);
      return { agentId: own };
    }
    assertOwn(scope.agentId);
    if (scope.sessionId) return { agentId: scope.agentId ?? own, sessionId: scope.sessionId };
    return { agentId: own };
  }

  private async runPause(row: RemoteCommandRow): Promise<Outcome> {
    const params = PauseParams.parse(row.params ?? {});
    const turn = await this.turn(`pause from device ${row.device_id}`);
    const r = await this.deps.commands.compose(
      [
        {
          name: "session.pause",
          params: {
            ...(params.session ? { session: params.session } : {}),
            ...(params.reason ? { reason: params.reason } : {}),
          },
        },
      ],
      turn,
    );
    const result: JsonObject = { kind: "pause", ...viewToJson(r) };
    if (r.status === "done" || r.status === "partial") return { ok: true, result };
    return { ok: false, result: { ...result, error: r.reason ?? `pause ${r.status}` } };
  }

  private async runStart(row: RemoteCommandRow): Promise<Outcome> {
    const params = StartParams.parse(row.params ?? {});
    if (params.agentId && params.agentId !== this.deps.agentId) {
      throw new ForerunnerError(
        "validation",
        `forbidden: agent ${params.agentId} is not this PC's agent`,
      );
    }
    // A start after a kill lifts the freeze: the human asked for work explicitly.
    this.deps.kill.resume();
    const outcome = await this.deps.start({
      agentId: this.deps.agentId,
      projectId: params.projectId,
      trigger: "remote",
      reason: params.reason ?? `remote start from device ${row.device_id}`,
      ...(params.budgetUsdMicro ? { budgetUsdMicro: params.budgetUsdMicro } : {}),
    });
    return { ok: true, result: { kind: "start", result: outcome } };
  }

  // -------------------------------------------------------------------------------------
  // Pending change cards answered in the inbox

  /**
   * A pending change card is a `human_request` row plus the executor's closure (ADR 0030
   * item 3). The phone answers the row through the state service, which is the enforcement
   * point for the device signature and, on a high-risk card, the biometric (`confirm:high`);
   * the daemon's own route answers it for the human at the PC. Neither path reaches the
   * closure, so every drain reads the rows behind the open cards: an approval runs the change
   * (a medium card as a tap, a high-risk card as a device confirmation naming this daemon's
   * desktop row without a biometric of its own, which the policy accepts for the same human
   * because the service already checked the phone's), a rejection cancels it. Rows the
   * executor answered itself (they carry its `verdict`) are left alone. An approval the
   * executor refuses (this daemon's device row revoked, the risk rose since the card was
   * shown) is not applied: it is warned once, audited and the dead card dropped, so the next
   * drain does not repeat it and the human asks again; a refusal because another answer is in
   * flight is retried on the next drain.
   */
  async syncAnswered(): Promise<{ applied: number; cancelled: number; refused: number }> {
    let applied = 0;
    let cancelled = 0;
    let refused = 0;
    for (const p of this.deps.commands.pending(this.deps.humanId)) {
      let row: HumanRequestRow | undefined;
      try {
        row = await this.deps.store.humanRequest.get(p.id);
      } catch (e) {
        this.logger.warn("could not read the request behind a pending card", {
          id: p.id,
          error: errorMessage(e),
        });
        continue;
      }
      if (row?.status !== "answered") continue;
      if (isExecutorAnswer(row.answer)) continue;
      const by = { kind: "human" as const, id: row.answered_by ?? this.deps.humanId };
      if (by.id !== this.deps.humanId) {
        this.logger.warn("a pending card was answered by another human; ignored", { id: p.id });
        continue;
      }
      const approved = approvalOf(
        row.answer,
        row.options.filter((o): o is string => typeof o === "string"),
      );
      let r: CommandResultView;
      if (!approved) {
        r = await this.deps.commands.cancel(p.id, by);
        // A refused cancel means the card is already gone (expired, answered elsewhere).
        if (r.status !== "refused") cancelled++;
        this.logger.info("answered change card cancelled", { id: p.id, status: r.status });
        continue;
      }
      r =
        p.decision === "needs_device"
          ? await this.deps.commands.confirm(p.id, {
              kind: "device",
              deviceId: this.deps.deviceId,
              biometric: false,
              by,
            })
          : await this.deps.commands.confirm(p.id, { kind: "tap", by, source: "chat" });
      if (r.status === "refused") {
        // Another answer (the UI's route) holds the card: it is theirs, or ours next drain.
        if (r.code === "version_conflict") continue;
        refused++;
        this.refusedCards++;
        await this.dropRefusedCard(p, r, by);
        continue;
      }
      applied++;
      this.logger.info("answered change card applied", { id: p.id, status: r.status });
    }
    return { applied, cancelled, refused };
  }

  /**
   * The executor refused the inbox's approval (not a transient conflict): warn with the
   * reason, audit it and cancel the card so the next drain does not try again. The change
   * did not run; the human asks again from a working device.
   */
  private async dropRefusedCard(
    p: PendingView,
    r: CommandResultView,
    by: { kind: "human"; id: string },
  ): Promise<void> {
    const reason = r.reason ?? "refused";
    this.logger.warn("answered change card refused by the executor; card dropped", {
      id: p.id,
      code: r.code ?? null,
      reason,
    });
    await this.appendAudit(
      false,
      { pendingId: p.id, kind: "card", decision: p.decision, commands: cardCommands(p.card) },
      { status: "refused", code: r.code ?? null, error: reason },
    );
    try {
      // A refusal that already took the card out of the executor (its risk rose) makes this a
      // no-op refusal; either way nothing is pending afterwards.
      await this.deps.commands.cancel(p.id, by);
    } catch (e) {
      this.logger.warn("could not drop the refused card", { id: p.id, error: errorMessage(e) });
    }
  }

  // -------------------------------------------------------------------------------------

  private async turn(wordsUsed: string): Promise<CommandTurn> {
    return {
      humanId: this.deps.humanId,
      agentId: this.deps.agentId,
      activeProjectId: (await this.deps.commands.activeProject(this.deps.humanId)) ?? null,
      sessionId: await this.deps.conversationSessionId(),
      source: "phone",
      wordsUsed,
      // The PC itself: the registry's session commands run here through the ports instead
      // of travelling as another remote command (which the phone's device id would cause).
      deviceId: this.deps.deviceId,
    };
  }

  private audit(row: RemoteCommandRow, ok: boolean, result: JsonObject): Promise<void> {
    return this.appendAudit(
      ok,
      {
        commandId: row.id,
        command: row.command,
        deviceId: row.device_id,
        kind: envelopeKind(row.params),
        // The envelope's outbox key: what `handledBefore` finds a replay by.
        clientId: envelopeClientId(row.params),
        commands: planNames(row.params),
      },
      result,
    );
  }

  /** One `audit_log` row per outward action; the input names commands, never parameters. */
  private async appendAudit(ok: boolean, input: JsonObject, result: JsonObject): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        tool: REMOTE_AUDIT_TOOL,
        allowed: ok,
        denied_reason: ok ? null : String(result.error ?? "failed"),
        agent_id: this.deps.agentId,
        human_id: this.deps.humanId,
        input_summary: JSON.stringify(input),
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

/** The command result as the phone reads it (undefined fields become null). */
function viewToJson(r: CommandResultView): JsonObject {
  return {
    status: r.status,
    commands: r.commands,
    sentence: r.sentence ?? null,
    changeLogId: r.changeLogId ?? null,
    undoToken: r.undoToken ?? null,
    pendingId: r.pendingId ?? null,
    decision: r.decision ?? null,
    readback: r.readback ?? null,
    expiresAt: r.expiresAt ?? null,
    reason: r.reason ?? null,
    code: r.code ?? null,
    card: (r.card as JsonObject | null | undefined) ?? null,
    costUsdMicro: r.costUsdMicro ?? null,
    sessionId: null,
  };
}

function codeOf(e: unknown): string {
  return e instanceof ForerunnerError ? e.code : "internal";
}

function envelopeKind(params: JsonObject | null | undefined): string | null {
  const kind = params?.kind;
  return typeof kind === "string" ? kind : null;
}

/** The envelope's `clientId` (plan and chat envelopes carry one; the plain verbs do not). */
function envelopeClientId(params: JsonObject | null | undefined): string | null {
  const id = params?.clientId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function seenKey(deviceId: string, clientId: string): string {
  return `${deviceId}\n${clientId}`;
}

/** The audit row's input as `appendAudit` wrote it; null when it is not ours to read. */
function parseAuditInput(summary: string): JsonObject | null {
  try {
    const v: unknown = JSON.parse(summary);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

/** The command names a change card covers (its parts, else the one command). */
function cardCommands(card: ChangeCard | null | undefined): string[] {
  if (!card) return [];
  return card.parts?.length ? card.parts.map((p) => p.command) : [card.command];
}

/** The command names of a plan envelope (never the parameters: the audit row names, not values). */
function planNames(params: JsonObject | null | undefined): string[] {
  const plan = params?.plan;
  if (!Array.isArray(plan)) return [];
  return plan
    .map((s) => (s && typeof s === "object" && !Array.isArray(s) ? s.name : null))
    .filter((n): n is string => typeof n === "string");
}

/** The executor records its own confirmation as `{ verdict, kind, by, device_id, biometric }`. */
function isExecutorAnswer(answer: JsonValue | null): boolean {
  return (
    answer !== null &&
    typeof answer === "object" &&
    !Array.isArray(answer) &&
    typeof (answer as JsonObject).verdict === "string"
  );
}

const YES_RE = /^\s*(yes|ja|oui|ok|okay|approve|approved|confirm|confirmed|approve on device)\b/i;

/**
 * Whether an inbox answer approves the card: the first option (`yes` / `approve on device`),
 * a yes-like word, `true`, or an object whose `choice`, `option`, `answer` or `approved`
 * says so. Anything else is a rejection.
 */
export function approvalOf(answer: JsonValue | null, options: readonly string[]): boolean {
  if (answer === null || answer === undefined) return false;
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string") {
    const first = options[0];
    if (first && answer.trim().toLowerCase() === first.toLowerCase()) return true;
    return YES_RE.test(answer);
  }
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const o = answer as JsonObject;
    if (typeof o.approved === "boolean") return o.approved;
    for (const key of ["choice", "option", "answer", "verdict"]) {
      const v = o[key];
      if (typeof v === "string" || typeof v === "boolean") return approvalOf(v, options);
    }
  }
  return false;
}
