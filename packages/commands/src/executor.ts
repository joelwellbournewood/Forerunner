import {
  type Clock,
  type ErrorCode,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
  shortToken,
} from "@forerunner/platform";
import { isYes } from "@forerunner/runtime";
import type { ChangeLogRow, DeviceRow, JsonValue, StateStore } from "@forerunner/state";
import {
  buildCard,
  type ChangeCard,
  cardToJson,
  mergeCards,
  renderChangeCard,
} from "./change-card.ts";
import {
  type ConfirmationAnswer,
  type ConfirmationDecision,
  ConfirmationPolicy,
  PENDING_TTL_MS,
} from "./confirmation.ts";
import type { CommandRegistry } from "./registry.ts";
import type {
  Actor,
  CommandCall,
  CommandContext,
  CommandDef,
  CommandOutcome,
  Risk,
} from "./types.ts";

/**
 * The executor runs every command the same way, whatever asked for it (spec Q):
 * validate -> plan the change card -> confirmation policy -> (pending | run) -> change log
 * row -> the sentence goes to the activity log and the project chat -> temporary changes
 * are reverted by the clock -> one-click undo while the row is undoable.
 */
export interface ExecuteRequest {
  name: string;
  params: unknown;
  ctx: CommandContext;
  /** An answer the caller already has (the settings screen showed the card and got a tap). */
  confirmation?: ConfirmationAnswer;
}

export type ExecuteResult =
  | {
      status: "done";
      card: ChangeCard;
      changeLogId: string;
      /** The change log id while the change is undoable, for the one-click undo. */
      undoToken: string | null;
      sentence: string;
    }
  | {
      status: "partial";
      card: ChangeCard;
      changeLogId: string;
      undoToken: string | null;
      sentence: string;
      note: string;
    }
  | {
      status: "pending";
      card: ChangeCard;
      pendingId: string;
      decision: Exclude<ConfirmationDecision, "act">;
      expiresAt: string;
      /** Token an email reply carries to confirm a medium-risk change. */
      emailToken: string;
      /** What the card says, read out in voice mode. */
      readback: string;
    }
  | { status: "cancelled"; card: ChangeCard; pendingId: string }
  | {
      status: "refused";
      card: ChangeCard | null;
      reason: string;
      code: ErrorCode;
      pendingId?: string;
    };

export interface PendingConfirmation {
  /** Also the id of the HumanRequest row that shows the card in the inbox. */
  id: string;
  humanId: string;
  card: ChangeCard;
  decision: Exclude<ConfirmationDecision, "act">;
  createdAt: string;
  expiresAt: string;
  emailToken: string;
  readback: string;
  wordsUsed: string;
}

interface PendingEntry extends PendingConfirmation {
  perform: () => Promise<ExecuteResult>;
  /** Plans the same request again on the current state and returns today's decision. */
  redecide: () => Promise<ConfirmationDecision>;
  cancelTimer: () => void;
  /** An answer is being checked (a device lookup is in flight); a second answer is refused. */
  inFlight: boolean;
}

interface Gate {
  decision: ConfirmationDecision;
  card: ChangeCard;
  ctx: CommandContext;
  perform: () => Promise<ExecuteResult>;
  redecide: () => Promise<ConfirmationDecision>;
  answer: ConfirmationAnswer | undefined;
}

interface Step {
  def: CommandDef<unknown>;
  params: unknown;
  card: ChangeCard;
  risk: Risk;
}

interface DoneStep {
  step: Step;
  outcome: CommandOutcome;
}

export interface ExecutorOptions {
  registry: CommandRegistry;
  store: StateStore;
  clock: Clock;
  policy?: ConfirmationPolicy;
  pendingTtlMs?: number;
}

const NO_RE = /^\s*(no|nope|cancel|stop|nein|non|abbrechen)\b/i;
const EVENT_TYPE = "change";
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const DECISION_RANK: Record<ConfirmationDecision, number> = {
  act: 0,
  needs_yes: 1,
  needs_device: 2,
};
const DECISION_TEXT: Record<ConfirmationDecision, string> = {
  act: "no confirmation",
  needs_yes: "a yes",
  needs_device: "confirmation in the app on a paired device",
};

export class CommandExecutor {
  readonly registry: CommandRegistry;
  readonly policy: ConfirmationPolicy;
  private readonly store: StateStore;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly logger = log("commands");
  private readonly pendings = new Map<string, PendingEntry>();
  private readonly undoClosures = new Map<string, () => Promise<void>>();
  private readonly revertTimers = new Map<string, () => void>();
  private readonly cards = new Map<string, ChangeCard>();

  constructor(opts: ExecutorOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.clock = opts.clock;
    this.policy = opts.policy ?? new ConfirmationPolicy();
    this.ttlMs = opts.pendingTtlMs ?? PENDING_TTL_MS;
  }

  // -------------------------------------------------------------------------------------
  // Planning

  /** The change card of a command without acting. */
  async plan(call: CommandCall, ctx: CommandContext): Promise<ChangeCard> {
    return (await this.prepare(call, ctx)).card;
  }

  /** One card for a plan of several commands. */
  async planCompose(calls: CommandCall[], ctx: CommandContext): Promise<ChangeCard> {
    const steps = await this.prepareAll(calls, ctx);
    return mergeCards(steps.map((s) => s.card));
  }

  private async prepare(call: CommandCall, ctx: CommandContext): Promise<Step> {
    const def = this.registry.mustGet(call.name);
    const params = this.registry.validate(call.name, call.params);
    const risk = typeof def.risk === "function" ? await def.risk(params, ctx) : def.risk;
    const card = def.plan ? await def.plan(params, ctx) : genericCard(def, params, risk);
    card.impact.risk = risk;
    return { def, params, card, risk };
  }

  private async prepareAll(calls: CommandCall[], ctx: CommandContext): Promise<Step[]> {
    if (calls.length === 0) throw new ForerunnerError("validation", "nothing to do");
    const steps: Step[] = [];
    const working: CommandContext = { ...ctx };
    for (const call of calls) {
      const step = await this.prepare(call, working);
      steps.push(step);
      // A switch earlier in the plan makes the later steps apply to the new project.
      if (step.def.name === "project.switch" && step.card.projectId) {
        working.activeProjectId = step.card.projectId;
      }
    }
    return steps;
  }

  // -------------------------------------------------------------------------------------
  // Execution

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    this.sweepPending();
    const call: CommandCall = { name: req.name, params: req.params };
    let step: Step;
    try {
      step = await this.prepare(call, req.ctx);
    } catch (e) {
      return refusal(e, null);
    }
    return this.gate({
      decision: this.decideSteps([step], req.ctx),
      card: step.card,
      ctx: req.ctx,
      perform: () => this.perform([step], req.ctx),
      redecide: async () => this.decideSteps([await this.prepare(call, req.ctx)], req.ctx),
      answer: req.confirmation,
    });
  }

  /** The policy on the highest risk of the steps; a limit change by an agent needs a human. */
  private decideSteps(steps: Step[], ctx: CommandContext): ConfirmationDecision {
    let risk: Risk = "low";
    for (const s of steps) if (RISK_RANK[s.risk] > RISK_RANK[risk]) risk = s.risk;
    return this.policy.decide(risk, ctx.actor, ctx.source, {
      limitChange: steps.some((s) => s.def.limit === true),
    });
  }

  /**
   * A bespoke request: several commands as one change card, one confirmation and one change
   * log entry. All-or-nothing where the commands can be undone; otherwise partial with a note.
   */
  async compose(
    calls: CommandCall[],
    ctx: CommandContext,
    opts: { confirmation?: ConfirmationAnswer } = {},
  ): Promise<ExecuteResult> {
    this.sweepPending();
    let steps: Step[];
    try {
      steps = await this.prepareAll(calls, ctx);
    } catch (e) {
      return refusal(e, null);
    }
    const card =
      steps.length === 1 ? (steps[0] as Step).card : mergeCards(steps.map((s) => s.card));
    return this.gate({
      decision: this.decideSteps(steps, ctx),
      card,
      ctx,
      perform: () => this.perform(steps, ctx),
      redecide: async () => this.decideSteps(await this.prepareAll(calls, ctx), ctx),
      answer: opts.confirmation,
    });
  }

  private async gate(g: Gate): Promise<ExecuteResult> {
    if (g.decision === "act") return g.perform();
    if (g.answer) {
      if (g.answer.kind === "email") {
        // An email reply confirms a pending change by the token that change was sent with;
        // before the card exists there is no token, so nothing an email says can match.
        return refusal(
          new ForerunnerError(
            "approval_required",
            "an email reply confirms a pending change by its token; show the card first and answer the pending change",
            { details: { answer: "email" } },
          ),
          g.card,
        );
      }
      const device =
        g.answer.kind === "device" ? await this.store.device.get(g.answer.deviceId) : undefined;
      try {
        const verdict = this.policy.check(g.decision, g.answer, {
          humanId: g.ctx.humanId,
          emailToken: "",
          device,
        });
        if (verdict === "declined") return { status: "cancelled", card: g.card, pendingId: "" };
      } catch (e) {
        return refusal(e, g.card);
      }
      return g.perform();
    }
    return this.createPending(g.decision, g.card, g.ctx, g.perform, g.redecide);
  }

  private async createPending(
    decision: Exclude<ConfirmationDecision, "act">,
    card: ChangeCard,
    ctx: CommandContext,
    perform: () => Promise<ExecuteResult>,
    redecide: () => Promise<ConfirmationDecision>,
  ): Promise<ExecuteResult> {
    const now = this.clock.now();
    const expiresAt = new Date(now + this.ttlMs).toISOString();
    const emailToken = shortToken(6, "FR-");
    const readback = `${renderChangeCard(card, { voice: true })} ${
      decision === "needs_device"
        ? "Confirm in the app on a paired device; on the phone with biometric."
        : "Say yes to confirm, or reply yes to the email."
    }`;
    const request = await this.store.humanRequest.insert({
      human_id: ctx.humanId,
      project_id: card.projectId,
      session_id: ctx.sessionId ?? null,
      kind: "approval",
      why: card.what,
      steps: renderChangeCard(card).split("\n"),
      options: decision === "needs_device" ? ["approve on device", "reject"] : ["yes", "no"],
      blocking: false,
      risk: card.impact.risk,
      change_card: {
        ...cardToJson(card),
        decision,
        email_token: emailToken,
        expires_at: expiresAt,
        words_used: ctx.wordsUsed,
      } as never,
      author_human: ctx.actor.kind === "human" ? ctx.actor.id : null,
      author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
    const id = request.id;
    const cancelTimer = this.clock.setTimeout(() => {
      void this.expirePending(id);
    }, this.ttlMs);
    this.pendings.set(id, {
      id,
      humanId: ctx.humanId,
      card,
      decision,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      emailToken,
      readback,
      wordsUsed: ctx.wordsUsed,
      perform,
      redecide,
      cancelTimer,
      inFlight: false,
    });
    return { status: "pending", card, pendingId: id, decision, expiresAt, emailToken, readback };
  }

  private async perform(steps: Step[], ctx: CommandContext): Promise<ExecuteResult> {
    const done: DoneStep[] = [];
    const working: CommandContext = { ...ctx };
    for (const step of steps) {
      let outcome: CommandOutcome;
      try {
        outcome = await step.def.run(step.params, working);
      } catch (e) {
        const rollbackFailures = await this.rollback(done, working);
        if (rollbackFailures.length === 0)
          return refusal(
            e,
            steps.length === 1 ? (steps[0] as Step).card : mergeCards(steps.map((s) => s.card)),
          );
        const note = `Step ${done.length + 1} (${step.def.name}) failed: ${errorMessage(e)}. Rolling back failed for ${rollbackFailures.join(", ")}; the earlier steps stay applied.`;
        const kept = done.filter((d) => !rollbackFailures.includes(d.step.def.name));
        const result = await this.record(kept, ctx, note);
        return { ...result, status: "partial", note };
      }
      done.push({ step, outcome });
      if (outcome.activeProjectId !== undefined) working.activeProjectId = outcome.activeProjectId;
    }
    return this.record(done, ctx, undefined);
  }

  /** Undo already-applied steps in reverse; returns the names of the steps whose undo failed. */
  private async rollback(done: DoneStep[], ctx: CommandContext): Promise<string[]> {
    const failed: string[] = [];
    for (const d of [...done].reverse()) {
      try {
        await this.undoStep(d.step.def, d.step.params, d.outcome, ctx);
      } catch (e) {
        this.logger.warn("rollback failed", { command: d.step.def.name, error: errorMessage(e) });
        failed.push(d.step.def.name);
      }
    }
    return failed;
  }

  private async undoStep(
    def: CommandDef<unknown>,
    params: unknown,
    outcome: CommandOutcome,
    ctx: CommandContext,
  ): Promise<void> {
    if (outcome.undo) return outcome.undo();
    if (def.undo) return def.undo(params, outcome.before, outcome.after, ctx);
    throw new ForerunnerError("not_supported", `${def.name} cannot be undone`);
  }

  private async record(
    done: DoneStep[],
    ctx: CommandContext,
    note: string | undefined,
  ): Promise<Extract<ExecuteResult, { status: "done" }>> {
    const reversible = done.every((d) => d.outcome.reversible ?? d.step.def.reversible);
    const expiring = done
      .map((d) => d.outcome.expiresAt)
      .filter((x): x is string => typeof x === "string")
      .sort();
    const expiresAt = expiring[0] ?? null;
    const single = done.length === 1 ? (done[0] as DoneStep) : null;
    const card = single
      ? single.step.card
      : mergeCards(done.map((d) => ({ ...d.step.card, sentence: d.outcome.sentence })));
    const sentence = `${done.map((d) => d.outcome.sentence).join(" ")}${note ? ` (${note})` : ""}`;
    card.sentence = sentence;
    card.reversible = reversible;
    const projectId =
      done.find((d) => d.outcome.projectId)?.outcome.projectId ??
      card.projectId ??
      ctx.activeProjectId;
    const row = await this.store.changeLog.record({
      human_id: ctx.humanId,
      agent_id: ctx.actor.kind === "agent" ? ctx.actor.id : ctx.agentId,
      words_used: ctx.wordsUsed,
      commands: done.map((d) => ({ name: d.step.def.name, params: d.step.params as JsonValue })),
      before: single ? single.outcome.before : done.map((d) => d.outcome.before),
      after: single ? single.outcome.after : done.map((d) => d.outcome.after),
      scope: card.scope,
      project_id: projectId ?? null,
      expires_at: expiresAt,
      undo_state: reversible ? "undoable" : "irreversible",
      source: ctx.source,
      sentence,
      author_human: ctx.actor.kind === "human" ? ctx.actor.id : null,
      author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
    this.cards.set(row.id, card);
    if (reversible) {
      const snapshot = [...done];
      this.undoClosures.set(row.id, async () => {
        for (const d of [...snapshot].reverse())
          await this.undoStep(d.step.def, d.step.params, d.outcome, ctx);
      });
      if (expiresAt) this.scheduleRevert(row.id, expiresAt, ctx);
    }
    await this.post(ctx, sentence, {
      changeLogId: row.id,
      commands: done.map((d) => d.step.def.name),
      scope: card.scope,
      projectId: projectId ?? null,
      kind: "change",
    });
    return {
      status: "done",
      card,
      changeLogId: row.id,
      undoToken: reversible ? row.id : null,
      sentence,
    };
  }

  // -------------------------------------------------------------------------------------
  // Spelled out every time: the activity log and the project chat

  private async post(
    ctx: CommandContext,
    sentence: string,
    meta: {
      changeLogId: string;
      commands: string[];
      scope: string;
      projectId: string | null;
      kind: string;
    },
  ): Promise<void> {
    try {
      if (ctx.sessionId) {
        await this.store.event.append(
          ctx.sessionId,
          EVENT_TYPE,
          { ...meta, sentence, source: ctx.source } as never,
          0,
          {
            authorHuman: ctx.actor.kind === "human" ? ctx.actor.id : null,
            authorAgent: ctx.actor.kind === "agent" ? ctx.actor.id : ctx.agentId,
          },
        );
      }
      if (!ctx.agentId) return;
      const author = {
        author_human: ctx.actor.kind === "human" ? ctx.actor.id : null,
        author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
      };
      await this.store.message.send({
        from_agent_id: ctx.agentId,
        to_human_id: ctx.humanId,
        project_id: meta.projectId,
        type: "info",
        body: sentence,
        requires_ack: false,
        ...author,
      });
      if (!meta.projectId) return;
      const others = await this.sharedWith(ctx, meta.projectId);
      if (others.length === 0) return;
      const human = await this.store.human.get(ctx.humanId);
      for (const other of others) {
        if (other === ctx.humanId) continue;
        await this.store.message.send({
          from_agent_id: ctx.agentId,
          to_human_id: other,
          project_id: meta.projectId,
          type: "info",
          body: `${human?.name ?? ctx.humanId}: ${sentence}`,
          requires_ack: false,
          ...author,
        });
      }
    } catch (e) {
      // The change is made and logged; a failed post must not undo it.
      this.logger.warn("could not post the change sentence", { error: errorMessage(e) });
    }
  }

  private async sharedWith(ctx: CommandContext, projectId: string): Promise<string[]> {
    if (ctx.ports.sharedWith) return ctx.ports.sharedWith(projectId, ctx.humanId);
    const project = await this.store.project.get(projectId);
    const shared = (project?.settings as { shared_with?: unknown } | undefined)?.shared_with;
    return Array.isArray(shared) ? shared.filter((x): x is string => typeof x === "string") : [];
  }

  // -------------------------------------------------------------------------------------
  // Confirmations

  pending(humanId?: string): PendingConfirmation[] {
    this.sweepPending();
    return [...this.pendings.values()]
      .filter((p) => humanId === undefined || p.humanId === humanId)
      .map(({ perform: _p, cancelTimer: _c, ...rest }) => rest);
  }

  getPending(id: string): PendingConfirmation | undefined {
    this.sweepPending();
    const p = this.pendings.get(id);
    if (!p) return undefined;
    const { perform: _p, cancelTimer: _c, ...rest } = p;
    return rest;
  }

  /**
   * Answer a pending confirmation with a yes/no/tap, an email reply token or a device. One
   * answer runs the change once: while an answer is being checked a second one is refused,
   * and the entry leaves the map in the same tick the check passes (a double tap on the phone
   * cannot start two sessions). The risk is resolved again on the current state before the
   * run, because the card may be ten minutes old; a risk that rose since is refused.
   */
  async confirm(pendingId: string, answer: ConfirmationAnswer): Promise<ExecuteResult> {
    this.sweepPending();
    const p = this.pendings.get(pendingId);
    if (!p) return noPending(pendingId);
    if (p.inFlight) {
      return {
        status: "refused",
        card: p.card,
        reason: "this confirmation is already being answered",
        code: "version_conflict",
        pendingId,
      };
    }
    p.inFlight = true;
    let device: DeviceRow | undefined;
    let verdict: "confirmed" | "declined";
    try {
      device = answer.kind === "device" ? await this.store.device.get(answer.deviceId) : undefined;
      // The entry may have expired while the device was looked up.
      if (this.pendings.get(pendingId) !== p) return noPending(pendingId);
      verdict = this.policy.check(p.decision, answer, {
        humanId: p.humanId,
        emailToken: p.emailToken,
        device,
      });
    } catch (e) {
      // The pending change stays open for a proper confirmation.
      return { ...refusal(e, p.card), pendingId };
    } finally {
      p.inFlight = false;
    }
    // Nothing has awaited since the check passed: the entry is taken before anyone else can.
    this.pendings.delete(pendingId);
    p.cancelTimer();
    const by: Actor =
      answer.kind === "device"
        ? (answer.by ?? { kind: "human", id: device?.owner_human_id ?? p.humanId })
        : answer.by;
    const answered = {
      kind: answer.kind,
      by: by.id,
      device_id: answer.kind === "device" ? answer.deviceId : null,
      biometric: answer.kind === "device" ? answer.biometric : null,
    };
    if (verdict === "declined") {
      await this.answerRequest(pendingId, { verdict, ...answered }, by.id);
      return { status: "cancelled", card: p.card, pendingId };
    }
    let now: ConfirmationDecision;
    try {
      now = await p.redecide();
    } catch (e) {
      await this.answerRequest(
        pendingId,
        { verdict: "refused", reason: errorMessage(e), ...answered },
        by.id,
      );
      return { ...refusal(e, p.card), pendingId };
    }
    if (DECISION_RANK[now] > DECISION_RANK[p.decision]) {
      const reason = `the change now needs ${DECISION_TEXT[now]}: its risk rose since the card was shown; ask again`;
      await this.answerRequest(pendingId, { verdict: "refused", reason, ...answered }, by.id);
      return { status: "refused", card: p.card, reason, code: "approval_required", pendingId };
    }
    await this.answerRequest(pendingId, { verdict, ...answered }, by.id);
    return p.perform();
  }

  /** A typed or spoken reply: "yes"/"ja" confirms, "no"/"nein" cancels, anything else is neither. */
  async confirmByText(pendingId: string, text: string, by: Actor): Promise<ExecuteResult> {
    if (isYes(text)) return this.confirm(pendingId, { kind: "yes", by });
    if (NO_RE.test(text)) return this.confirm(pendingId, { kind: "no", by });
    const p = this.getPending(pendingId);
    return {
      status: "refused",
      card: p?.card ?? null,
      reason: "not a yes or a no",
      code: "validation",
      pendingId,
    };
  }

  /** An email reply carrying the token confirms a medium-risk change. */
  async confirmByToken(token: string, by: Actor): Promise<ExecuteResult> {
    this.sweepPending();
    const p = [...this.pendings.values()].find((x) => x.emailToken === token);
    if (!p) {
      return {
        status: "refused",
        card: null,
        reason: "unknown or expired token",
        code: "not_found",
      };
    }
    return this.confirm(p.id, { kind: "email", token, by });
  }

  /** The paired-device confirmation for high-risk changes (biometric on a phone). */
  confirmFromDevice(
    pendingId: string,
    device: { deviceId: string; biometric: boolean },
    by?: Actor,
  ): Promise<ExecuteResult> {
    return this.confirm(pendingId, { kind: "device", ...device, ...(by ? { by } : {}) });
  }

  async cancel(pendingId: string, by: Actor): Promise<ExecuteResult> {
    return this.confirm(pendingId, { kind: "no", by });
  }

  private async answerRequest(id: string, answer: JsonValue, by: string): Promise<void> {
    try {
      const row = await this.store.humanRequest.get(id);
      if (row && row.status === "open")
        await this.store.humanRequest.answer(id, row.version, answer, by);
    } catch (e) {
      this.logger.warn("could not record the confirmation on the request", {
        id,
        error: errorMessage(e),
      });
    }
  }

  private sweepPending(): void {
    const now = this.clock.now();
    for (const [id, p] of this.pendings) {
      if (Date.parse(p.expiresAt) <= now) void this.expirePending(id);
    }
  }

  private async expirePending(id: string): Promise<void> {
    const p = this.pendings.get(id);
    if (!p) return;
    this.pendings.delete(id);
    p.cancelTimer();
    try {
      const row = await this.store.humanRequest.get(id);
      if (row && row.status === "open") await this.store.humanRequest.expire(id, row.version);
    } catch (e) {
      this.logger.warn("could not expire the request", { id, error: errorMessage(e) });
    }
  }

  // -------------------------------------------------------------------------------------
  // Undo and temporary changes

  /** Changes the human can still undo, newest first. */
  undoable(humanId: string, projectId?: string): Promise<ChangeLogRow[]> {
    return this.store.changeLog.undoable(
      projectId === undefined ? { humanId } : { humanId, projectId },
      this.clock.nowIso(),
    );
  }

  /** One-click undo while the row is undoable. Only the human the change was made for may undo. */
  async undo(changeLogId: string, ctx: CommandContext): Promise<ExecuteResult> {
    const row = await this.store.changeLog.get(changeLogId);
    const card = this.cards.get(changeLogId) ?? null;
    if (!row) {
      return { status: "refused", card, reason: "no such change", code: "not_found" };
    }
    if (ctx.actor.kind !== "human") {
      return {
        status: "refused",
        card,
        reason: "only a human can undo a change",
        code: "approval_required",
      };
    }
    if (row.human_id !== ctx.humanId) {
      return {
        status: "refused",
        card,
        reason: "this change was made for another human; only they can undo it",
        code: "approval_required",
      };
    }
    if (row.undo_state !== "undoable") {
      return {
        status: "refused",
        card,
        reason: `this change can no longer be undone (${row.undo_state})`,
        code: "validation",
      };
    }
    if (row.expires_at && Date.parse(row.expires_at) <= this.clock.now()) {
      await this.revert(changeLogId, ctx);
      return {
        status: "refused",
        card,
        reason: "the change already reverted on its own",
        code: "validation",
      };
    }
    try {
      await this.runUndo(row, ctx);
    } catch (e) {
      return refusal(e, card);
    }
    const current = await this.store.changeLog.mustGet(changeLogId);
    await this.store.changeLog.markUndone(changeLogId, current.version);
    this.clearTimers(changeLogId);
    const sentence = card
      ? `Undone: ${card.what} is back to ${card.oldValue}.`
      : `Undone: ${row.sentence.replace(/\s*Undo\.$/, "")}`;
    const undoRow = await this.store.changeLog.record({
      human_id: ctx.humanId,
      agent_id: ctx.agentId,
      words_used: ctx.wordsUsed,
      commands: [{ name: "undo", params: { change_log_id: changeLogId } }],
      before: row.after,
      after: row.before,
      scope: row.scope,
      project_id: row.project_id,
      undo_state: "irreversible",
      source: ctx.source,
      sentence,
      author_human: ctx.actor.id,
    });
    await this.post(ctx, sentence, {
      changeLogId: undoRow.id,
      commands: ["undo"],
      scope: row.scope,
      projectId: row.project_id,
      kind: "undo",
    });
    const resultCard =
      card ??
      buildCard({
        command: "undo",
        what: row.sentence,
        oldValue: "",
        newValue: "",
        scope: row.scope,
        risk: "low",
        sentence,
        reversible: false,
      });
    return { status: "done", card: resultCard, changeLogId: undoRow.id, undoToken: null, sentence };
  }

  private async runUndo(row: ChangeLogRow, ctx: CommandContext): Promise<void> {
    const closure = this.undoClosures.get(row.id);
    if (closure) return closure();
    const commands = row.commands as { name: string; params: unknown }[];
    const befores = commands.length === 1 ? [row.before] : (row.before as JsonValue[]);
    const afters = commands.length === 1 ? [row.after] : (row.after as JsonValue[]);
    for (let i = commands.length - 1; i >= 0; i--) {
      const c = commands[i] as { name: string; params: unknown };
      const def = this.registry.get(c.name);
      if (!def?.undo) {
        throw new ForerunnerError("not_supported", `${c.name} has no state-based undo`, {
          details: { command: c.name },
        });
      }
      await def.undo(c.params, befores[i] ?? null, afters[i] ?? null, ctx);
    }
  }

  private scheduleRevert(changeLogId: string, expiresAt: string, ctx: CommandContext): void {
    this.clearTimers(changeLogId);
    const delay = Math.max(0, Date.parse(expiresAt) - this.clock.now());
    const cancel = this.clock.setTimeout(() => {
      void this.revert(changeLogId, ctx).catch((e) => {
        this.logger.error("scheduled revert failed", { changeLogId, error: errorMessage(e) });
      });
    }, delay);
    this.revertTimers.set(changeLogId, cancel);
  }

  /** The window of a temporary change closed: undo it, mark the row expired, log the revert. */
  async revert(changeLogId: string, ctx: CommandContext): Promise<ChangeLogRow | null> {
    const row = await this.store.changeLog.get(changeLogId);
    if (row?.undo_state !== "undoable") {
      this.clearTimers(changeLogId);
      return null;
    }
    if (row.human_id !== ctx.humanId) {
      // The timer and resumeScheduled run with the row's own human; anyone else is refused.
      throw new ForerunnerError(
        "approval_required",
        "this change was made for another human; it reverts in their context",
        { details: { changeLogId, humanId: row.human_id } },
      );
    }
    this.clearTimers(changeLogId);
    await this.runUndo(row, ctx);
    await this.store.changeLog.update(changeLogId, row.version, { undo_state: "expired" });
    const card = this.cards.get(changeLogId);
    const sentence = card
      ? `Reverted ${card.what} to ${card.oldValue}; the window ${card.duration} ended.`
      : `Reverted: ${row.sentence.replace(/\s*Undo\.$/, "")}`;
    const commands = (row.commands as { name: string; params: unknown }[]).map((c) => ({
      name: c.name,
      params: c.params as JsonValue,
      revert_of: changeLogId,
    }));
    const revertRow = await this.store.changeLog.record({
      human_id: row.human_id,
      agent_id: row.agent_id,
      words_used: "",
      commands,
      before: row.after,
      after: row.before,
      scope: row.scope,
      project_id: row.project_id,
      undo_state: "irreversible",
      source: row.source,
      sentence,
      author_agent: ctx.agentId,
    });
    await this.post(ctx, sentence, {
      changeLogId: revertRow.id,
      commands: commands.map((c) => c.name),
      scope: row.scope,
      projectId: row.project_id,
      kind: "revert",
    });
    this.undoClosures.delete(changeLogId);
    return revertRow;
  }

  /**
   * After a restart: revert temporary changes whose window already closed and re-arm the
   * timers of the ones still open. `ctxFor` builds a context for each row's human.
   */
  async resumeScheduled(
    ctxFor: (row: ChangeLogRow) => CommandContext | Promise<CommandContext>,
  ): Promise<{ reverted: number; scheduled: number }> {
    const rows = await this.store.changeLog.list({ undo_state: "undoable" });
    let reverted = 0;
    let scheduled = 0;
    const now = this.clock.now();
    for (const row of rows) {
      if (!row.expires_at) continue;
      const ctx = await ctxFor(row);
      if (Date.parse(row.expires_at) <= now) {
        await this.revert(row.id, ctx);
        reverted++;
      } else {
        this.scheduleRevert(row.id, row.expires_at, ctx);
        scheduled++;
      }
    }
    return { reverted, scheduled };
  }

  private clearTimers(changeLogId: string): void {
    this.revertTimers.get(changeLogId)?.();
    this.revertTimers.delete(changeLogId);
  }

  /**
   * Cancel every timer (shutdown). Reverts resume from the store; pending confirmations do not
   * (their closures are gone), so the next daemon expires their cards (U-029).
   */
  stop(): void {
    for (const cancel of this.revertTimers.values()) cancel();
    this.revertTimers.clear();
    for (const p of this.pendings.values()) p.cancelTimer();
  }
}

function genericCard(def: CommandDef<unknown>, params: unknown, risk: Risk): ChangeCard {
  const scope = typeof def.scope === "function" ? def.scope(params) : def.scope;
  return buildCard({
    command: def.name,
    what: def.description,
    oldValue: "current",
    newValue: JSON.stringify(params),
    scope,
    risk,
    sentence: `${def.description}${def.reversible ? " Undo." : ""}`,
    reversible: def.reversible,
  });
}

function noPending(pendingId: string): Extract<ExecuteResult, { status: "refused" }> {
  return {
    status: "refused",
    card: null,
    reason: "no pending confirmation with that id (it may have expired)",
    code: "not_found",
    pendingId,
  };
}

function refusal(
  e: unknown,
  card: ChangeCard | null,
): Extract<ExecuteResult, { status: "refused" }> {
  const code: ErrorCode = isForerunnerError(e) ? e.code : "internal";
  return { status: "refused", card, reason: errorMessage(e), code };
}
