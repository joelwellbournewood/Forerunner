import {
  type Clock,
  type ErrorCode,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
  shortToken,
} from "@forerunner/platform";
import { type AutonomyLevel, decideAutonomy, isYes } from "@forerunner/runtime";
import { OPEN_ON_A_CLOSED_PROJECT } from "@forerunner/runtime/daemon/join-words";
import type { ChangeLogRow, DeviceRow, JsonValue, StateStore } from "@forerunner/state";
import {
  buildCard,
  type ChangeCard,
  cardToJson,
  mergeCards,
  oneQuestion,
  renderChangeCard,
} from "./change-card.ts";
import {
  joinedProjectRefusal,
  joinedProjectWords,
  removedProjectName,
  removedProjectRefusal,
} from "./commands/project.ts";
import {
  type ConfirmationAnswer,
  type ConfirmationDecision,
  ConfirmationPolicy,
  PENDING_TTL_MS,
} from "./confirmation.ts";
import {
  changedSince,
  composedRefusal,
  fixListMoved,
  namedTaskIds,
  subjectsNow,
  TASKS_CHANGED_REPLY,
  taskListFingerprint,
} from "./readback-check.ts";
import type { CommandRegistry } from "./registry.ts";
import type {
  Actor,
  CommandCall,
  CommandContext,
  CommandDef,
  CommandOutcome,
  CommandSource,
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
      /** The sentence quotes text the person did not write (`CommandOutcome.untrusted`). */
      untrusted?: CommandOutcome["untrusted"];
    }
  | {
      status: "partial";
      card: ChangeCard;
      changeLogId: string;
      undoToken: string | null;
      sentence: string;
      note: string;
      untrusted?: CommandOutcome["untrusted"];
    }
  | {
      status: "pending";
      card: ChangeCard;
      pendingId: string;
      decision: Exclude<ConfirmationDecision, "act">;
      /**
       * When the card lapses, or null for a chat or voice read-back, which waits until it is
       * answered (l4-selftasks-chat, L4-selftasks-117; the owner, 2026-11-17).
       */
      expiresAt: string | null;
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
      /**
       * d1109-onerepo-link: the refusal's details as the command threw them (a link another
       * project uses: its cause and the offer), so a caller can show the offer.
       */
      details?: Record<string, unknown>;
      /** The reason quotes text the person did not write (a repository's marker name). */
      untrusted?: CommandOutcome["untrusted"];
    };

export interface PendingConfirmation {
  /** Also the id of the HumanRequest row that shows the card in the inbox. */
  id: string;
  humanId: string;
  card: ChangeCard;
  decision: Exclude<ConfirmationDecision, "act">;
  createdAt: string;
  /** Null: a chat or voice read-back, which waits until it is answered (L4-selftasks-117). */
  expiresAt: string | null;
  emailToken: string;
  readback: string;
  wordsUsed: string;
}

/** What the executor tells when a confirmation lapses unanswered (`ExecutorOptions.onExpired`). */
export interface ExpiredConfirmation {
  id: string;
  humanId: string;
  projectId: string | null;
  /** What the card would have changed, in its own words. */
  what: string;
  /** From and to, when the card changes one value ("CHF 5.00 to CHF 20.00"), else null. */
  change: string | null;
  source: CommandSource;
}

/**
 * l4-selftasks-carried (L4f-left-1): a card that left the executor (`ExecutorOptions.onClosed`):
 * answered yes or no (here, in the Inbox, on the phone or by email), a Yes the app refused because
 * what it named changed, or one that lapsed. `sessionId` is the conversation session a chat or
 * voice read-back was said in (its context), so the daemon can tell that conversation's screens.
 */
export interface ClosedConfirmation {
  id: string;
  humanId: string;
  projectId: string | null;
  source: CommandSource;
  sessionId: string | null;
  how: "yes" | "no" | "refused" | "expired";
}

/**
 * The executor's plan of the same request again on the state now: today's decision and the card
 * it would read back now, which the Yes compares with the card as it was read back.
 */
interface Redecided {
  decision: ConfirmationDecision;
  card: ChangeCard;
}

interface PendingEntry extends PendingConfirmation {
  /**
   * Makes the change. `by` is the human whose yes confirmed it: a step said on the person's own
   * words (`Step.persons`) runs and is recorded as theirs (L4-selftasks-116).
   */
  perform: (by?: Actor) => Promise<ExecuteResult>;
  /** Plans the same request again on the current state and returns today's decision. */
  redecide: () => Promise<Redecided>;
  /** The card as it was read back: what the Yes compares the state now with (L4-selftasks-117). */
  shown: ChangeCard;
  /**
   * A fix of the task list: the list's fingerprint its check judged (run C decision 53), and the
   * tasks its set names, which the Yes compares (l4-selftasks-carried, L4f-left-2).
   */
  fingerprint?: { projectId: string; value: string; named: string[] };
  cancelTimer: () => void;
  /** An answer is being checked (a device lookup is in flight); a second answer is refused. */
  inFlight: boolean;
  /** l4-selftasks-carried (L4f-left-1): an answer took the card out (`confirm` tells it). */
  answered?: boolean;
}

interface Gate {
  decision: ConfirmationDecision;
  card: ChangeCard;
  ctx: CommandContext;
  perform: (by?: Actor) => Promise<ExecuteResult>;
  redecide: () => Promise<Redecided>;
  answer: ConfirmationAnswer | undefined;
  /** The commands, kept with a pending card so it can be armed again after a restart. */
  calls?: CommandCall[];
  /**
   * fixup-l4-selftasks-chat: the change log row an Undo read back in chat undoes, kept with its
   * card (`change_card.undo_of`) so it is armed again after a restart like every chat read-back.
   */
  undoOf?: string;
}

/**
 * What a pending card keeps of its context (`change_card.context`) so a restarted daemon can
 * arm it again (design §3.9: a Yes/No card survives a restart): who asked, through what, for
 * which project and conversation. The ports, the store and the clock are the new process's.
 */
export interface StoredCardContext {
  actor: Actor;
  humanId: string;
  agentId: string | null;
  activeProjectId: string | null;
  source: CommandSource;
  wordsUsed: string;
  deviceId: string | null;
  sessionId: string | null;
  /**
   * d1109-selftasks-chat: the agent's own fix of its task list (`CommandContext.planFix`), kept so
   * a card armed again after a restart is decided and told as before (no Inbox line after its
   * yes). Written by the daemon only; a request body never sets it.
   */
  planFix?: { level: AutonomyLevel; askFirst?: boolean; fingerprint?: string };
}

/**
 * A card as one question, for chat and voice when the card has no `ask` of its own (design
 * §3.9: a change is read back once, in one line; §5: no "Risk: low", no change-card text): its
 * own question, every part's question for a composed card, else "Change <what> from <old> to
 * <new>?". A card built without a plan (a command with none, `genericCard`) asks its
 * description, never its parameters as JSON.
 */
function questionOf(card: ChangeCard): string {
  if (card.ask) return card.ask;
  if (card.parts && card.parts.length > 1) return oneQuestion(card.parts.map(questionOf));
  const what = card.what.trim().replace(/\.$/, "");
  const to = card.newValue.trim();
  if (/^[[{]/.test(to)) return `${what}?`;
  const from = card.oldValue.trim();
  return `Change ${what}${from ? ` from ${from}` : ""} to ${to}?`;
}

/** The read-back of a pending card (design §5): its one question, else the rendered card. */
function readbackOf(
  card: ChangeCard,
  decision: Exclude<ConfirmationDecision, "act">,
  source: CommandSource,
): string {
  // A card with its one question reads back as that question (design §5: "Start a session on
  // Quote page (up to CHF 5.00)?"); the chat shows Yes and No, voice asks for the word. In chat
  // and voice a card without one is asked in one line too (review of d1109-chat-guard: after a
  // record, a project switch read back as "Change: the active project. From ... Risk: low.
  // Undo: ..." with "reply yes to the email" while email was off).
  const ask = card.ask ?? (source === "chat" || source === "voice" ? questionOf(card) : null);
  if (ask)
    return decision === "needs_device"
      ? `${ask} Confirm in the app on a paired device.`
      : source === "voice"
        ? `${ask} Say yes or no.`
        : ask;
  return `${renderChangeCard(card, { voice: true })} ${
    decision === "needs_device"
      ? "Confirm in the app on a paired device; on the phone with biometric."
      : "Say yes to confirm, or reply yes to the email."
  }`;
}

interface Step {
  def: CommandDef<unknown>;
  params: unknown;
  card: ChangeCard;
  risk: Risk;
  /** Said in words as a command that is read back first (`askFromChat`), then redirected. */
  askedAs?: boolean;
  /**
   * l4-selftasks-chat (L4-selftasks-116): the step is a change the person named in their own
   * words in a conversation (`CommandContext.onPersonsWords`, or its call's mark after a restart
   * or a merge). Once the person says yes it runs and is recorded as theirs; it never changes
   * how it is decided (the actor rule of ADR 0030 item 2 reads the agent).
   */
  persons?: boolean;
}

/** A step as a stored call: its command, its parameters and whose words it was said in. */
function callOf(step: Step): CommandCall {
  return {
    name: step.def.name,
    params: step.params,
    ...(step.persons ? { onPersonsWords: true } : {}),
  };
}

/**
 * A card's one value from and to ("CHF 5.00 to CHF 20.00"), as the Update of a lapsed card says
 * it beside what it would have changed, or null for a card that changes no single value.
 */
export function cardChange(card: Pick<ChangeCard, "oldValue" | "newValue">): string | null {
  const from = card.oldValue?.trim() ?? "";
  const to = card.newValue?.trim() ?? "";
  if (!from || !to || /^[[{]/.test(from) || /^[[{]/.test(to)) return null;
  return `${from} to ${to}`;
}

/** Whether a source's read-back waits until it is answered (chat, Talk and voice). */
function waitsUntilAnswered(source: CommandSource): boolean {
  return source === "chat" || source === "voice";
}

/**
 * The changes that still act at once in a turn that read a record (d1109-chat-guard): stopping
 * the running session (`session.stop`, scope agent or session) and "stop after this task"
 * (`session.pause`). Stop all (`session.stop` with scope all) is not one of them.
 */
function stopsAtOnceAfterRecords(step: Step): boolean {
  if (step.def.name === "session.pause") return true;
  if (step.def.name !== "session.stop") return false;
  const scope = (step.params as { scope?: unknown } | null)?.scope;
  return scope !== "all";
}

/**
 * The commands that change nothing the person keeps: they read a project out (review of
 * d1109-chat-guard: after a record, "how far is it?" answered by the model's summary_speak
 * waited for a Yes). `summary.speak` reads the person's own project only (`ownProject`) and
 * speaks only when the person's own words ask for it (`wantsAloud` reads `wordsUsed`, which a
 * record cannot write).
 */
const CHANGES_NOTHING: ReadonlySet<string> = new Set(["summary.speak"]);

/**
 * d1109-selftasks-run (ADR 0119): the context is the agent's own task-list fix (set only by the
 * runtime) at a level whose autonomy frees `plan_fix` (Standard, Trusted, Autopilot).
 */
function freesPlanFix(ctx: CommandContext): boolean {
  return (
    !!ctx.planFix &&
    !ctx.planFix.askFirst &&
    decideAutonomy("plan_fix", { level: ctx.planFix.level }) === "allow"
  );
}

/** What still acts at once in a turn that read a record: a read, or a stop of the running work. */
function actsAtOnceAfterRecords(step: Step): boolean {
  return CHANGES_NOTHING.has(step.def.name) || stopsAtOnceAfterRecords(step);
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
  /**
   * l4-selftasks-chat (L4-selftasks-117): a confirmation lapsed unanswered (its ten minutes: a
   * settings-screen or email card; chat read-backs wait until they are answered). The daemon
   * tells the open screens and the person (`inbox.changed`, `conversation.changed`, one Update).
   */
  onExpired?: (card: ExpiredConfirmation) => void | Promise<void>;
  /**
   * l4-selftasks-carried (L4f-left-1): a card left the executor, however it closed (a yes, a no,
   * a Yes refused because what it named changed, a lapse), whatever route answered it. The
   * daemon tells the open screens once (`inbox.changed`, `project.changed`, and the conversation
   * it was read back in); before, only some routes did, and the header kept "Waiting for you: 1
   * change to confirm" until a reload.
   */
  onClosed?: (card: ClosedConfirmation) => void | Promise<void>;
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
  private readonly onExpired: ExecutorOptions["onExpired"];
  private readonly onClosed: ExecutorOptions["onClosed"];
  private readonly logger = log("commands");
  private readonly pendings = new Map<string, PendingEntry>();
  /** The undo of a change made in this process; it returns the sentences its steps added. */
  private readonly undoClosures = new Map<string, () => Promise<string[]>>();
  private readonly revertTimers = new Map<string, () => void>();
  private readonly cards = new Map<string, ChangeCard>();

  constructor(opts: ExecutorOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.clock = opts.clock;
    this.policy = opts.policy ?? new ConfirmationPolicy();
    this.ttlMs = opts.pendingTtlMs ?? PENDING_TTL_MS;
    this.onExpired = opts.onExpired;
    this.onClosed = opts.onClosed;
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

  private async prepare(call: CommandCall, ctx: CommandContext, redirected = false): Promise<Step> {
    const def = this.registry.mustGet(call.name);
    const params = this.registry.validate(call.name, call.params);
    // A move said in words on a task whose card offers it is that card's answer (`redirect`).
    const instead = !redirected && def.redirect ? await def.redirect(params, ctx) : null;
    // The answer is read back as the move would have been ("cancel X" on a person's card that
    // asks nothing risky still gets its one-line question first, design §3.9).
    const persons = call.onPersonsWords ?? ctx.onPersonsWords === true;
    if (instead)
      return {
        ...(await this.prepare({ ...instead, onPersonsWords: persons }, ctx, true)),
        askedAs: def.askFromChat === true,
      };
    const risk = typeof def.risk === "function" ? await def.risk(params, ctx) : def.risk;
    const card = def.plan ? await def.plan(params, ctx) : genericCard(def, params, risk);
    card.impact.risk = risk;
    // L4-selftasks-117: what the card names, as it is now, for the Yes to compare with.
    if (def.subjects) {
      const subjects = await def.subjects(params, ctx).catch(() => []);
      if (subjects.length) card.subjects = subjects;
    }
    await this.refuseClosedProject(def.name, card);
    return { def, params, card, risk, ...(persons ? { persons: true } : {}) };
  }

  /**
   * d1109-onerepo-join (OJ-06): a project closed into another takes no new work, from the app,
   * chat or a pending yes: '"Kite club" joined "Site", so its work runs there.' (a removed project:
   * 'The project "X" was removed, so nothing of it runs.'). Before, New task, a note or a change
   * from its chat was written on the closed project, where no session ever runs it.
   */
  private async refuseClosedProject(name: string, card: ChangeCard): Promise<void> {
    if (!card.projectId || OPEN_ON_A_CLOSED_PROJECT.has(name)) return;
    const project = await this.store.project.get(card.projectId);
    const refusal = project ? removedProjectRefusal(project) : null;
    if (!project || !refusal) return;
    throw new ForerunnerError("validation", refusal, {
      details: {
        cause: joinedProjectRefusal(project) ? "project_joined" : "project_removed",
        projectId: project.id,
      },
    });
  }

  /**
   * l4-chat-depth (L4-chat-204): the refusal a pending card meets at its yes when its project was
   * closed since it was read back (the commands that stay open on a closed project excepted),
   * or null.
   */
  private async closedProjectRefusal(card: ChangeCard): Promise<ForerunnerError | null> {
    try {
      await this.refuseClosedProject(card.command, card);
      return null;
    } catch (e) {
      return isClosedProjectRefusal(e) ? (e as ForerunnerError) : null;
    }
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
      perform: (by) => this.perform([step], req.ctx, by),
      redecide: async () => {
        const again = await this.prepare(call, req.ctx);
        return { decision: this.decideSteps([again], req.ctx), card: again.card };
      },
      answer: req.confirmation,
      // The call as planned: a redirected move is stored as the card's answer it became.
      calls: [callOf(step)],
    });
  }

  /** The policy on the highest risk of the steps; a limit change by an agent needs a human. */
  private decideSteps(steps: Step[], ctx: CommandContext): ConfirmationDecision {
    let risk: Risk = "low";
    for (const s of steps) if (RISK_RANK[s.risk] > RISK_RANK[risk]) risk = s.risk;
    const decision = this.policy.decide(risk, ctx.actor, ctx.source, {
      limitChange: steps.some((s) => s.def.limit === true),
    });
    // Design §3.9: a change to a task said in words is read back once before it happens.
    // d1109-selftasks-run (ADR 0119): except the agent's own fix of its task list at a level that
    // frees it (Standard and up: "the agent changes its own tasks without asking"), which acts at
    // once with its Undo; a turn that read a record still reads it back (the rule below).
    if (
      decision === "act" &&
      (ctx.source === "chat" || ctx.source === "voice") &&
      !freesPlanFix(ctx) &&
      steps.some((s) => s.def.askFromChat === true || s.askedAs === true)
    )
      return "needs_yes";
    // d1109-chat-guard (ADR 0114, W15B-80): in a turn that read a record, the record's words may
    // be what asks for the change, so every change is read back once, whatever its risk: before,
    // a new task, a note for the next brief, a narrowing setting or a session start under the
    // costly line acted at once. Stopping is the safe direction (design §3.9): a stop of the
    // running session and "stop after this task" still act at once; Stop all is read back with
    // the header's own question, so a record cannot stop all work by itself. A command that
    // changes nothing (summary.speak) answers at once as before.
    if (decision === "act" && ctx.recordsRead && !steps.every(actsAtOnceAfterRecords))
      return "needs_yes";
    // d1109-selftasks-chat (ADR 0119 point 7): the agent's own fix of its task list at a level
    // that does not free it (Advisor, Assisted) asks first whatever the commands, a new task
    // included (task.create acts at once when the person says it).
    if (decision === "act" && ctx.planFix && !freesPlanFix(ctx)) return "needs_yes";
    return decision;
  }

  /**
   * A bespoke request: several commands as one change card, one confirmation and one change
   * log entry. All-or-nothing where the commands can be undone; otherwise partial with a note.
   */
  async compose(
    calls: CommandCall[],
    ctx: CommandContext,
    opts: {
      confirmation?: ConfirmationAnswer;
      /**
       * d1109-selftasks-chat: the one question a composed card is read back with ("Make these 3
       * changes to the tasks of Quote page? …"), kept on its row for a restart.
       */
      ask?: string;
    } = {},
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
    if (opts.ask?.trim() && steps.length > 1) card.ask = opts.ask.trim();
    return this.gate({
      decision: this.decideSteps(steps, ctx),
      card,
      ctx,
      perform: (by) => this.perform(steps, ctx, by),
      redecide: async () => this.redecideAll(calls, ctx),
      answer: opts.confirmation,
      calls: steps.map(callOf),
    });
  }

  /** The steps planned again on the state now: today's decision and today's card. */
  private async redecideAll(calls: CommandCall[], ctx: CommandContext): Promise<Redecided> {
    const steps = await this.prepareAll(calls, ctx);
    return {
      decision: this.decideSteps(steps, ctx),
      card: steps.length === 1 ? (steps[0] as Step).card : mergeCards(steps.map((s) => s.card)),
    };
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
    // Design §3.8: an Inbox card answered from chat or voice that needs a device confirmation
    // (a high-risk card) is not filed again as a second card about the first, which no chat
    // yes could confirm: the reply points to the card, which is where it is answered.
    if (g.card.command === "request.answer" && g.decision === "needs_device")
      return refusal(
        new ForerunnerError(
          "approval_required",
          // The card as the Inbox titles it ('"X" failed 3 times'); before, the card's why cut
          // at 60 characters in quotes of its own ('("\"X\" failed 4 t…")', phase E review).
          `Answer it on its card in the Inbox: ${await this.cardTitleOf(g)}. Nothing else was filed.`,
          { details: { reason: "answer_on_card" } },
        ),
        g.card,
      );
    return this.createPending(g.decision, g.card, g.ctx, g.perform, g.redecide, g.calls, g.undoOf);
  }

  /** The title of the card a `request.answer` answers, as the Inbox shows it. */
  private async cardTitleOf(g: Gate): Promise<string> {
    const fallback = g.card.what.replace(/^the request /, "");
    const params = g.calls?.[0]?.params as { request?: unknown } | undefined;
    const id = typeof params?.request === "string" ? params.request : null;
    // The chat's model names a card by the start of its id (`cardReference`).
    const row = id
      ? ((await this.store.humanRequest.get(id).catch(() => undefined)) ??
        (await this.store.humanRequest.open({ humanId: g.ctx.humanId }, { limit: 200 })).find((r) =>
          r.id.startsWith(id),
        ))
      : undefined;
    const words = row ? await g.ctx.ports.cardWords?.(row).catch(() => null) : null;
    return words?.title?.trim() || fallback;
  }

  private async createPending(
    decision: Exclude<ConfirmationDecision, "act">,
    card: ChangeCard,
    ctx: CommandContext,
    perform: (by?: Actor) => Promise<ExecuteResult>,
    redecide: () => Promise<Redecided>,
    calls?: CommandCall[],
    undoOf?: string,
  ): Promise<ExecuteResult> {
    const now = this.clock.now();
    // l4-selftasks-chat (L4-selftasks-117; the owner, 2026-11-17: "wait until I answer"): a
    // read-back in chat, Talk or voice waits until it is answered or another read-back of its
    // conversation replaces it, across a restart; its Yes is decided on the state then. Every
    // other confirmation (the settings screen, an email reply) keeps ADR 0030's ten minutes.
    const untilAnswered = waitsUntilAnswered(ctx.source);
    const expiresAt = untilAnswered ? null : new Date(now + this.ttlMs).toISOString();
    // Run C decision 53: a fix of the task list keeps the fingerprint of the list it judged.
    const fingerprint =
      ctx.planFix && card.projectId
        ? (ctx.planFix.fingerprint ??
          (await taskListFingerprint(this.store, card.projectId).catch(() => undefined)))
        : undefined;
    const emailToken = shortToken(6, "FR-");
    const readback = readbackOf(card, decision, ctx.source);
    // The commands and who asked, so a restarted daemon arms the card again (`restorePending`).
    const stored: StoredCardContext = {
      actor: ctx.actor,
      humanId: ctx.humanId,
      agentId: ctx.agentId ?? null,
      activeProjectId: ctx.activeProjectId ?? null,
      source: ctx.source,
      wordsUsed: ctx.wordsUsed,
      deviceId: ctx.deviceId ?? null,
      sessionId: ctx.sessionId ?? null,
      ...(ctx.planFix
        ? {
            planFix: {
              level: ctx.planFix.level,
              ...(ctx.planFix.askFirst ? { askFirst: true } : {}),
              ...(fingerprint ? { fingerprint } : {}),
            },
          }
        : {}),
    };
    // Design §3.8, §3.9: an Inbox card answered in chat or voice is read back there, once, and
    // the yes is said there; the card itself stays the one card about it in the Inbox. Its
    // read-back is kept as a row (so it survives a restart and its fate is known) marked
    // `chat_only`, which the Inbox and its counts leave out (`isChatOnlyCard` in the runtime):
    // before, the Inbox showed a second yes/no card about the first (U-029).
    const chatOnly =
      card.command === "request.answer" && (ctx.source === "chat" || ctx.source === "voice");
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
        ...(untilAnswered ? { until_answered: true } : {}),
        words_used: ctx.wordsUsed,
        ...(chatOnly ? { chat_only: true } : {}),
        ...(calls
          ? { calls: JSON.parse(JSON.stringify(calls)), context: stored }
          : undoOf
            ? { undo_of: undoOf, context: stored }
            : {}),
      } as never,
      author_human: ctx.actor.kind === "human" ? ctx.actor.id : null,
      author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
    const id = request.id;
    const cancelTimer = untilAnswered
      ? () => undefined
      : this.clock.setTimeout(() => {
          void this.expirePending(id);
        }, this.ttlMs);
    this.pendings.set(id, {
      id,
      humanId: ctx.humanId,
      card,
      shown: JSON.parse(JSON.stringify(card)) as ChangeCard,
      decision,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      emailToken,
      readback,
      wordsUsed: ctx.wordsUsed,
      perform,
      redecide,
      ...(fingerprint && card.projectId
        ? {
            fingerprint: {
              projectId: card.projectId,
              value: fingerprint,
              named: namedTaskIds(calls ?? [], card),
            },
          }
        : {}),
      cancelTimer,
      inFlight: false,
    });
    return { status: "pending", card, pendingId: id, decision, expiresAt, emailToken, readback };
  }

  /**
   * Arms again the cards a stopped daemon showed (design §3.9: a Yes/No card survives a
   * restart; before, U-029 expired every one at the next start): each open change card that
   * kept its commands and context, not expired, is planned again on the state as it is now
   * and waits for its yes as before, with its id, email token and expiry. A card that cannot be
   * planned any more (its task is gone, a value is refused now) is left for the caller to
   * expire. Answers the ids armed.
   */
  async restorePending(
    rows: readonly { id: string; human_id: string | null; status: string; change_card: unknown }[],
    contextFor: (stored: StoredCardContext) => Promise<CommandContext>,
  ): Promise<string[]> {
    const armed: string[] = [];
    const now = this.clock.now();
    for (const row of rows) {
      if (row.status !== "open" || this.pendings.has(row.id)) continue;
      const json = row.change_card as Record<string, unknown> | null;
      if (!json || typeof json !== "object") continue;
      const calls = json.calls;
      const stored = json.context as StoredCardContext | undefined;
      const decision = json.decision;
      const expiresAt = typeof json.expires_at === "string" ? json.expires_at : null;
      // L4-selftasks-117: a chat or voice read-back waits until it is answered, also one an
      // earlier version stored with ten minutes (the owner: none lapses).
      const untilAnswered = !!stored && waitsUntilAnswered(stored.source);
      // fixup-l4-selftasks-chat: an Undo read back in chat waits across a restart too.
      const undoOf = typeof json.undo_of === "string" ? json.undo_of : null;
      if (
        undoOf &&
        stored &&
        untilAnswered &&
        (decision === "needs_yes" || decision === "needs_device")
      ) {
        try {
          const ctx = await contextFor(stored);
          const card = json as unknown as ChangeCard;
          this.pendings.set(row.id, {
            id: row.id,
            humanId: stored.humanId,
            card,
            shown: card,
            decision,
            createdAt: new Date(now).toISOString(),
            expiresAt: null,
            emailToken: typeof json.email_token === "string" ? json.email_token : "",
            readback: readbackOf(card, decision, ctx.source),
            wordsUsed: stored.wordsUsed,
            // l4-selftasks-carried (L4f-left-3): the card as read back says what comes back.
            perform: () => this.performUndo(undoOf, ctx, card),
            redecide: () => this.redecideUndo(undoOf, card, ctx),
            cancelTimer: () => undefined,
            inFlight: false,
          });
          armed.push(row.id);
        } catch (e) {
          this.logger.warn("an undo card could not be armed again after a restart", {
            id: row.id,
            error: errorMessage(e),
          });
        }
        continue;
      }
      if (
        !Array.isArray(calls) ||
        !calls.length ||
        !stored ||
        (decision !== "needs_yes" && decision !== "needs_device") ||
        (!untilAnswered && (!expiresAt || Date.parse(expiresAt) <= now))
      )
        continue;
      try {
        const ctx = await contextFor(stored);
        const commandCalls = calls as CommandCall[];
        // l4-chat-depth (L4-chat-204): a card whose project was closed (joined or removed)
        // since it was read back is armed as it was shown, so its yes is refused in words by
        // `confirm` (the joined sentence) and changes nothing; before, it was left to expire and
        // the yes after a restart met "it expired" instead of why.
        // fixup-l4-selftasks-chat (review of L4-selftasks-117): a chat or voice read-back that
        // cannot be planned any more (its task was cancelled or finished meanwhile) is armed as
        // it was shown too: it waits until it is answered, and its Yes says what changed and
        // applies nothing (`confirm`). Before, it was left unarmed and the orphan sweep told the
        // person the card was lost to the restart.
        let steps: Step[] | null = null;
        try {
          steps = await this.prepareAll(commandCalls, ctx);
        } catch (e) {
          if (!untilAnswered && !isClosedProjectRefusal(e)) throw e;
        }
        const card = !steps
          ? (json as unknown as ChangeCard)
          : steps.length === 1
            ? (steps[0] as Step).card
            : mergeCards(steps.map((s) => s.card));
        // d1109-selftasks-chat: a composed card's own question, as it was read back.
        if (steps && steps.length > 1 && typeof json.ask === "string" && json.ask.trim())
          card.ask = json.ask;
        const id = row.id;
        const cancelTimer =
          untilAnswered || !expiresAt
            ? () => undefined
            : this.clock.setTimeout(
                () => {
                  void this.expirePending(id);
                },
                Math.max(0, Date.parse(expiresAt) - now),
              );
        // What the person was shown (the stored card), so the Yes compares with that and not
        // with the state at this restart (L4-selftasks-117).
        const shown = json as unknown as ChangeCard;
        const print = stored.planFix?.fingerprint;
        this.pendings.set(id, {
          id,
          humanId: stored.humanId,
          card,
          shown,
          decision,
          createdAt: new Date(now).toISOString(),
          expiresAt: untilAnswered ? null : expiresAt,
          emailToken: typeof json.email_token === "string" ? json.email_token : "",
          readback: readbackOf(card, decision, ctx.source),
          wordsUsed: stored.wordsUsed,
          perform: async (by) => this.perform(await this.prepareAll(commandCalls, ctx), ctx, by),
          redecide: async () => this.redecideAll(commandCalls, ctx),
          ...(print && card.projectId
            ? {
                fingerprint: {
                  projectId: card.projectId,
                  value: print,
                  named: namedTaskIds(commandCalls, shown),
                },
              }
            : {}),
          cancelTimer,
          inFlight: false,
        });
        armed.push(id);
      } catch (e) {
        this.logger.warn("a change card could not be armed again after a restart", {
          id: row.id,
          error: errorMessage(e),
        });
      }
    }
    return armed;
  }

  /**
   * Makes the planned steps. `by`, the human whose yes confirmed them: a step on the person's own
   * words runs as that human (L4-selftasks-116: "Changed by you", their name on Changes, no Inbox
   * echo); every other step, and every step that acts at once on the model's call, runs as the
   * context's actor. The steps were planned and decided as the agent, so nothing it may do widens.
   */
  private async perform(steps: Step[], ctx: CommandContext, by?: Actor): Promise<ExecuteResult> {
    const done: DoneStep[] = [];
    const working: CommandContext = { ...ctx };
    const person = by && by.kind === "human" && by.id === ctx.humanId ? by : null;
    for (const step of steps) {
      let outcome: CommandOutcome;
      try {
        outcome = await step.def.run(
          step.params,
          // Marked as on the person's words: a note the model passed stays the agent's.
          person && step.persons ? { ...working, actor: person, onPersonsWords: true } : working,
        );
      } catch (e) {
        const rollbackFailures = await this.rollback(done, working);
        if (rollbackFailures.length === 0) {
          const card =
            steps.length === 1 ? (steps[0] as Step).card : mergeCards(steps.map((s) => s.card));
          // L4-selftasks-105 (b): a set refused at one change says that none was made, which
          // and why, and what to do; never the refused change's sentence alone.
          if (steps.length > 1 && isForerunnerError(e) && e.code !== "internal")
            return refusal(
              new ForerunnerError(
                e.code,
                composedRefusal(steps.length, e.message, ctx.planFix !== undefined),
                { details: { ...(e.details ?? {}), composed: true } },
              ),
              card,
            );
          return refusal(e, card);
        }
        const note = `Step ${done.length + 1} (${step.def.name}) failed: ${errorMessage(e)}. Rolling back failed for ${rollbackFailures.join(", ")}; the earlier steps stay applied.`;
        const kept = done.filter((d) => !rollbackFailures.includes(d.step.def.name));
        const result = await this.record(kept, ctx, note, person);
        return { ...result, status: "partial", note };
      }
      done.push({ step, outcome });
      if (outcome.activeProjectId !== undefined) working.activeProjectId = outcome.activeProjectId;
    }
    return this.record(done, ctx, undefined, person);
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
  ): Promise<unknown> {
    if (outcome.undo) return outcome.undo();
    if (def.undo) return def.undo(params, outcome.before, outcome.after, ctx);
    throw new ForerunnerError("not_supported", `${def.name} cannot be undone`);
  }

  private async record(
    done: DoneStep[],
    given: CommandContext,
    note: string | undefined,
    person: Actor | null = null,
  ): Promise<Extract<ExecuteResult, { status: "done" }>> {
    // L4-selftasks-116: changes the person named in their own words and confirmed are theirs:
    // the row's author, the session line's and the post's (a set with any other step stays the
    // agent's, as fix_tasks' own changes are).
    const personsWords = done.length > 0 && done.every((d) => d.step.persons === true);
    const ctx: CommandContext = person && personsWords ? { ...given, actor: person } : given;
    // l4-selftasks-carried (L4f-left-4): a set that mixes the agent's own fixes with a change the
    // person named (a merged card) stays the agent's (its post, its session line), and its row
    // names both: the person's step reads "Changed by you" on the task, the row said the agent
    // alone. The actor rule still reads the agent (ADR 0030 item 2).
    const alsoPerson =
      person && !personsWords && ctx.actor.kind === "agent" && done.some((d) => d.step.persons)
        ? person.id
        : null;
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
      author_human: ctx.actor.kind === "human" ? ctx.actor.id : alsoPerson,
      author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
    });
    this.cards.set(row.id, card);
    if (reversible) {
      const snapshot = [...done];
      this.undoClosures.set(row.id, async () => {
        const added: string[] = [];
        for (const d of [...snapshot].reverse()) {
          const said = await this.undoStep(d.step.def, d.step.params, d.outcome, ctx);
          if (typeof said === "string" && said.trim()) added.push(said.trim());
        }
        return added;
      });
      if (expiresAt) this.scheduleRevert(row.id, expiresAt, ctx);
    }
    await this.post(ctx, sentence, {
      changeLogId: row.id,
      commands: done.map((d) => d.step.def.name),
      scope: card.scope,
      projectId: projectId ?? null,
      kind: "change",
      ...(personsWords ? { personsWords: true } : {}),
    });
    // A step whose sentence quotes text the person did not write keeps its mark (d1109-chat-guard).
    const untrusted = done.map((d) => d.outcome.untrusted).find((u) => !!u);
    return {
      status: "done",
      card,
      changeLogId: row.id,
      undoToken: reversible ? row.id : null,
      sentence,
      ...(untrusted ? { untrusted } : {}),
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
      /**
       * L4-selftasks-116: the change was said in the person's own words in a conversation: the
       * reply there tells it (with its Undo), so it is no Inbox Update (design §3.8: "never
       * echoes of the person's own ... chat commands"). The people it is shared with still hear.
       */
      personsWords?: boolean;
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
      // Design §3.8, §5.11: the Inbox never echoes the person's own clicks, chat or voice
      // commands, or project switches; they are in Changes (and the reply, where they asked).
      // A change the agent made, or one the app made by itself (a temporary change reverting
      // when its window ends), is news and goes to the person's Inbox.
      const theirOwn =
        meta.kind !== "revert" &&
        ((ctx.actor.kind === "human" && ctx.actor.id === ctx.humanId) ||
          meta.personsWords === true);
      // d1109-selftasks-run (ADR 0119, design §3.8 "What becomes an Update: one line per
      // session"): the agent's own fixes of its task list are told by the session that made them
      // (its log line, its one Update) or by chat's reply, never one Inbox line per change.
      const toldElsewhere =
        meta.kind !== "revert" && (ctx.source === "session" || ctx.planFix !== undefined);
      if (!theirOwn && !toldElsewhere)
        await this.store.message.send({
          from_agent_id: ctx.agentId,
          to_human_id: ctx.humanId,
          project_id: meta.projectId,
          type: "info",
          body: sentence,
          requires_ack: false,
          ...author,
        });
      if (!meta.projectId || toldElsewhere) return;
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
      .map(
        ({ perform: _p, cancelTimer: _c, redecide: _r, shown: _s, fingerprint: _f, ...rest }) =>
          rest,
      );
  }

  getPending(id: string): PendingConfirmation | undefined {
    this.sweepPending();
    const p = this.pendings.get(id);
    if (!p) return undefined;
    const { perform: _p, cancelTimer: _c, redecide: _r, shown: _s, fingerprint: _f, ...rest } = p;
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
    const p = this.pendings.get(pendingId);
    let r: ExecuteResult | undefined;
    try {
      r = await this.answerPending(pendingId, answer);
      return r;
    } finally {
      // l4-selftasks-carried (L4f-left-1): an answer that took the card out (a yes made or
      // refused, a no) is told once, whatever route gave it. fixup-l4-selftasks-carried: also
      // when the change after the yes threw (a change-log write that failed): the card is out
      // all the same, and before, the header kept "Waiting for you" until a reload.
      if (p?.answered)
        await this.tellClosed(
          p,
          r === undefined
            ? answer.kind === "no"
              ? "no"
              : "yes"
            : r.status === "cancelled"
              ? "no"
              : r.status === "refused"
                ? "refused"
                : "yes",
        );
    }
  }

  /** The answer to a pending card (`confirm`): checked, then made, refused or declined. */
  private async answerPending(
    pendingId: string,
    answer: ConfirmationAnswer,
  ): Promise<ExecuteResult> {
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
    p.answered = true;
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
    // Run C decision 53 (L4-selftasks-117): a fix of the task list applies only the set its check
    // made of the list as it was then. l4-selftasks-carried (L4f-left-2; session lead decision
    // 2026-11-23): judged on which tasks the list holds and on the tasks the set names, so a
    // session finishing a task the set does not name leaves the Yes valid. A failure to read
    // the list refuses, as before.
    if (p.fingerprint) {
      const { projectId, value, named } = p.fingerprint;
      const moved = await fixListMoved(this.store, projectId, value, named).catch(() => true);
      if (moved) {
        const reason = TASKS_CHANGED_REPLY;
        await this.answerRequest(pendingId, { verdict: "refused", reason, ...answered }, by.id);
        return {
          status: "refused",
          card: p.card,
          reason,
          code: "validation",
          pendingId,
          details: { reason: "changed_since" },
        };
      }
    }
    let now: ConfirmationDecision;
    let fresh: ChangeCard;
    try {
      ({ decision: now, card: fresh } = await p.redecide());
    } catch (e) {
      // fixup-l4-selftasks-chat: the request can no longer be planned (the task it named was
      // cancelled, finished or removed since). What it named is read as it is now, so the Yes
      // says in one line what changed ('"Write the FAQ" changed since I asked: it is cancelled
      // now. ...'); a refusal with nothing named that moved keeps the command's own words, and
      // so does one that already says in words what the task is and that nothing changed
      // (C-38's '"Write the FAQ" is already done; nothing changed.').
      const said = /nothing changed\.$/.test(errorMessage(e));
      const named = said ? null : await subjectsNow(this.store, p.shown).catch(() => null);
      const gone = named ? changedSince(p.shown, named) : null;
      const reason = gone ?? errorMessage(e);
      await this.answerRequest(pendingId, { verdict: "refused", reason, ...answered }, by.id);
      if (gone)
        return {
          status: "refused",
          card: p.card,
          reason: gone,
          code: "validation",
          pendingId,
          details: { reason: "changed_since" },
        };
      return { ...refusal(e, p.card), pendingId };
    }
    if (DECISION_RANK[now] > DECISION_RANK[p.decision]) {
      const reason = `the change now needs ${DECISION_TEXT[now]}: its risk rose since the card was shown; ask again`;
      await this.answerRequest(pendingId, { verdict: "refused", reason, ...answered }, by.id);
      return { status: "refused", card: p.card, reason, code: "approval_required", pendingId };
    }
    // L4-selftasks-117: what the read-back named is compared with the state now; a task changed
    // elsewhere, or a setting moved, is said in one line, and nothing is applied.
    const moved = changedSince(p.shown, fresh);
    if (moved) {
      await this.answerRequest(
        pendingId,
        { verdict: "refused", reason: moved, ...answered },
        by.id,
      );
      return {
        status: "refused",
        card: p.card,
        reason: moved,
        code: "validation",
        pendingId,
        details: { reason: "changed_since" },
      };
    }
    // l4-chat-depth (L4-chat-204): a project closed by Make one project (or removed) since the
    // card was read back takes no new work: the yes is refused with the joined sentence and
    // nothing is performed, whatever path the card came by (the chat, the Inbox, a restart).
    const closed = await this.closedProjectRefusal(p.card);
    if (closed) {
      await this.answerRequest(
        pendingId,
        { verdict: "refused", reason: closed.message, ...answered },
        by.id,
      );
      return { ...refusal(closed, p.card), pendingId };
    }
    await this.answerRequest(pendingId, { verdict, ...answered }, by.id);
    return p.perform(by);
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

  /**
   * l4-selftasks-carried (L4f-left-1): a card that left the executor, told to `onClosed` once,
   * with where it was read back (its stored context: the source and the conversation session).
   * A failure to tell never changes the answer.
   */
  private async tellClosed(p: PendingEntry, how: ClosedConfirmation["how"]): Promise<void> {
    if (!this.onClosed) return;
    try {
      const row = await this.store.humanRequest.get(p.id).catch(() => undefined);
      const context = (
        row?.change_card as { context?: { source?: CommandSource; sessionId?: string | null } }
      )?.context;
      await this.onClosed({
        id: p.id,
        humanId: p.humanId,
        projectId: p.card.projectId ?? row?.project_id ?? null,
        source: context?.source ?? "ui",
        sessionId: context?.sessionId ?? row?.session_id ?? null,
        how,
      });
    } catch (e) {
      this.logger.warn("could not tell about the closed card", {
        id: p.id,
        error: errorMessage(e),
      });
    }
  }

  private sweepPending(): void {
    const now = this.clock.now();
    for (const [id, p] of this.pendings) {
      if (p.expiresAt && Date.parse(p.expiresAt) <= now) void this.expirePending(id);
    }
  }

  private async expirePending(id: string): Promise<void> {
    const p = this.pendings.get(id);
    if (!p) return;
    this.pendings.delete(id);
    p.cancelTimer();
    let expired = false;
    let row: Awaited<ReturnType<StateStore["humanRequest"]["get"]>> | undefined;
    try {
      row = await this.store.humanRequest.get(id);
      if (row && row.status === "open") {
        await this.store.humanRequest.expire(id, row.version);
        expired = true;
      }
    } catch (e) {
      this.logger.warn("could not expire the request", { id, error: errorMessage(e) });
    }
    if (!expired) return;
    // L4-selftasks-117: an expiry that remains is told (before, the card left the Inbox with
    // no event, no message and a Yes still drawn in the open chat). fixup-l4-selftasks-carried:
    // its Update first, then the close (`onClosed`), so the screens told of the close read the
    // Inbox once with the Update in it (before, the close came first and the daemon told the
    // Inbox a second time after the Update).
    if (this.onExpired) {
      try {
        await this.onExpired({
          id,
          humanId: p.humanId,
          projectId: p.card.projectId ?? row?.project_id ?? null,
          what: p.card.what,
          change: cardChange(p.card),
          source: ((row?.change_card as { context?: { source?: CommandSource } } | null)?.context
            ?.source ?? "ui") as CommandSource,
        });
      } catch (e) {
        this.logger.warn("could not tell about the lapsed card", { id, error: errorMessage(e) });
      }
    }
    await this.tellClosed(p, "expired");
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

  /**
   * Why a change log row cannot be undone now, in plain words, or null when it can (U-061):
   * the row's state, its window, and each command's own check (`undoBlocked`: the task moved
   * on, the note was read). The Changes screen offers Undo only when this is null.
   */
  async undoBlockedReason(row: ChangeLogRow, ctx: CommandContext): Promise<string | null> {
    if (row.undo_state !== "undoable") {
      return row.undo_state === "undone"
        ? "this change was already undone"
        : row.undo_state === "expired"
          ? "this change already reverted on its own"
          : "this change cannot be undone";
    }
    if (row.expires_at && Date.parse(row.expires_at) <= this.clock.now()) {
      return "this change already reverted on its own";
    }
    // W15-36: a project whose creation was undone is gone for the person; its other changes
    // offered Undo as if it were there. (The creation's own row is already undone.)
    if (row.project_id && !stepsOf(row).some((s) => s.name === "project.create")) {
      const project = await this.store.project.get(row.project_id);
      const removed = project ? removedProjectName(project) : null;
      if (removed !== null) return `the project ${removed} was removed`;
      // d1109-onerepo-join: a project closed into another keeps its rows readable, but its own
      // changes are not undone while its work is in the kept project (the join's Undo first).
      const joined = project ? joinedProjectWords(project) : null;
      if (joined) return joined;
    }
    const steps = stepsOf(row);
    for (const step of steps) {
      const def = this.registry.get(step.name);
      if (!def?.undoBlocked) continue;
      const reason = await def.undoBlocked(step.params, step.before, step.after, ctx, { steps });
      if (reason) return reason;
    }
    return null;
  }

  /**
   * The risk of undoing a row (U-057): the highest of its commands' `undoRisk` (the risk of
   * putting the old value back on today's state); a command without one is low.
   */
  async undoRiskOf(row: ChangeLogRow, ctx: CommandContext): Promise<Risk> {
    let risk: Risk = "low";
    for (const step of stepsOf(row)) {
      const def = this.registry.get(step.name);
      if (!def?.undoRisk) continue;
      const r = await def.undoRisk(step.params, step.before, step.after, ctx);
      if (RISK_RANK[r] > RISK_RANK[risk]) risk = r;
    }
    return risk;
  }

  /**
   * The undo's own question from its one command (`undoAsk`, W15-34): the same words with or
   * without the card in memory, so after a restart too. Null for a row of several commands or a
   * command without one.
   */
  private async undoAskOf(row: ChangeLogRow, ctx: CommandContext): Promise<string | null> {
    const steps = stepsOf(row);
    const step = steps.length === 1 ? steps[0] : undefined;
    const def = step ? this.registry.get(step.name) : undefined;
    if (!step || !def?.undoAsk) return null;
    return def.undoAsk(step.params, step.before, step.after, ctx);
  }

  /**
   * One-click undo while the row is undoable. Only the human the change was made for may undo.
   * The undo goes through the same confirmation as a forward change (U-057): the risk of the
   * value it restores decides, so undoing a lowered monthly cap (a raise) waits for this PC or
   * the phone with biometric, and an undo that cannot work is refused in plain words (U-061).
   */
  async undo(
    changeLogId: string,
    ctx: CommandContext,
    opts: { confirmation?: ConfirmationAnswer } = {},
  ): Promise<ExecuteResult> {
    this.sweepPending();
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
    let risk: Risk;
    try {
      const blocked = await this.undoBlockedReason(row, ctx);
      if (blocked) return { status: "refused", card, reason: blocked, code: "validation" };
      risk = await this.undoRiskOf(row, ctx);
    } catch (e) {
      return refusal(e, card);
    }
    const decide = (r: Risk) =>
      this.policy.decide(r, ctx.actor, ctx.source, { limitChange: false });
    const decision = decide(risk);
    const undoCard = undoCardOf(
      row,
      card,
      risk,
      decision === "act" ? null : await this.undoAskOf(row, ctx).catch(() => null),
    );
    return this.gate({
      decision,
      card: undoCard,
      ctx,
      perform: () => this.performUndo(changeLogId, ctx),
      redecide: () => this.redecideUndo(changeLogId, undoCard, ctx),
      answer: opts.confirmation,
      undoOf: changeLogId,
    });
  }

  /** An undo's decision on the state now; it checks its own state when it is made. */
  private async redecideUndo(
    changeLogId: string,
    card: ChangeCard,
    ctx: CommandContext,
  ): Promise<Redecided> {
    const risk = await this.undoRiskOf(await this.store.changeLog.mustGet(changeLogId), ctx);
    return {
      decision: this.policy.decide(risk, ctx.actor, ctx.source, { limitChange: false }),
      card,
    };
  }

  /**
   * The undo itself, once confirmed: the row is read again, since the card may be minutes old.
   * `shown` is the Undo's own card as it was read back (armed again after a restart).
   */
  private async performUndo(
    changeLogId: string,
    ctx: CommandContext,
    shown?: ChangeCard,
  ): Promise<ExecuteResult> {
    const row = await this.store.changeLog.get(changeLogId);
    const card = this.cards.get(changeLogId) ?? null;
    if (!row) return { status: "refused", card, reason: "no such change", code: "not_found" };
    let added: string[];
    try {
      const blocked = await this.undoBlockedReason(row, ctx);
      if (blocked) return { status: "refused", card, reason: blocked, code: "validation" };
      added = await this.runUndo(row, ctx);
    } catch (e) {
      return refusal(e, card);
    }
    const current = await this.store.changeLog.mustGet(changeLogId);
    await this.store.changeLog.markUndone(changeLogId, current.version);
    this.clearTimers(changeLogId);
    const steps = stepsOf(row);
    const single = steps.length === 1 ? (steps[0] as UndoStep) : null;
    const own = single ? this.registry.get(single.name)?.undoSentence : undefined;
    // d1109-selftasks-run: a set of changes whose every command words its own Undo (the agent's
    // task-list fixes the person approved on one card) says each, in one sentence: 'Undone:
    // "Style the page" is one task again; cancelled the task "Check the links" you created.'
    // ("<what> is back to <old value>" joined the cards' values into no sentence at all).
    const each = steps.length > 1 ? stepWords(steps, (n) => this.registry.get(n)) : null;
    const sentence = [
      single && own
        ? own(single.params, single.before, single.after)
        : each
          ? each
          : card
            ? `Undone: ${card.what} is back to ${card.oldValue}.`
            : // l4-selftasks-carried (L4f-left-3): after a restart the change's card is gone, but
              // the Undo read back in chat kept what it puts back ("the monthly cap" back to
              // "CHF 150.00"), so the confirmation says it as it does without a restart. Before:
              // "Undone: Lowered the monthly cap from CHF 150.00 to CHF 100.00."
              shown && shown.newValue !== UNDO_UNKNOWN_BEFORE
              ? `Undone: ${shown.what} is back to ${shown.newValue}.`
              : `Undone: ${row.sentence.replace(/\s*Undo\.$/, "")}`,
      ...added,
    ].join(" ");
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

  /** Runs the undo; returns the sentences the undo steps added (`CommandDef.undo`). */
  private async runUndo(row: ChangeLogRow, ctx: CommandContext): Promise<string[]> {
    const closure = this.undoClosures.get(row.id);
    if (closure) return closure();
    const steps = stepsOf(row);
    const added: string[] = [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const c = steps[i] as UndoStep;
      const def = this.registry.get(c.name);
      if (!def?.undo) {
        throw new ForerunnerError("not_supported", `${c.name} has no state-based undo`, {
          details: { command: c.name },
        });
      }
      const said = await def.undo(c.params, c.before, c.after, ctx);
      if (typeof said === "string" && said.trim()) added.push(said.trim());
    }
    return added;
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

/** One command of a change log row with its own before and after. */
interface UndoStep {
  name: string;
  params: unknown;
  before: JsonValue;
  after: JsonValue;
}

/** The commands of a row with their before and after (a composed row stores arrays). */
function stepsOf(row: ChangeLogRow): UndoStep[] {
  const commands = (Array.isArray(row.commands) ? row.commands : []) as {
    name: string;
    params: unknown;
  }[];
  const single = commands.length === 1;
  const befores = single ? [row.before] : Array.isArray(row.before) ? row.before : [];
  const afters = single ? [row.after] : Array.isArray(row.after) ? row.after : [];
  return commands.map((c, i) => ({
    name: c.name,
    params: c.params,
    before: (befores[i] ?? null) as JsonValue,
    after: (afters[i] ?? null) as JsonValue,
  }));
}

/**
 * The Undo of a set of changes in one sentence, when every command words its own Undo: the
 * first sentence whole, the rest without their "Undone: ", joined by semicolons. Null when one
 * of them has no words of its own (the card's "<what> is back to <old value>" then).
 */
function stepWords(
  steps: readonly UndoStep[],
  defOf: (name: string) => CommandDef | undefined,
): string | null {
  // l4-chat-carried (C4-left-5, design section 5 rule 4): a step of the set that renamed a task
  // (a split's first part, an edit of the title) gets its old title back with the Undo, so the
  // other steps' words name the task as it is after it ('"Style the page" waits for what it
  // waited for before', never the first part's title that no longer exists).
  const renamed = new Map<string, string>();
  for (const s of steps) {
    const b = (s.before ?? {}) as { title?: unknown };
    const a = (s.after ?? {}) as { title?: unknown };
    if (typeof b.title === "string" && typeof a.title === "string" && a.title !== b.title)
      renamed.set(`"${a.title}"`, `"${b.title}"`);
  }
  const said: string[] = [];
  for (const s of steps) {
    const own = defOf(s.name)?.undoSentence;
    if (!own) return null;
    let words = own(s.params as never, s.before, s.after)
      .trim()
      .replace(/[.\s]+$/, "");
    for (const [now, then] of renamed) words = words.split(now).join(then);
    said.push(words);
  }
  const [first, ...rest] = said;
  if (!first) return null;
  return `${[first, ...rest.map((r) => r.replace(/^Undone:\s*/, ""))].join("; ")}.`;
}

/**
 * The card an undo shows while it waits for a confirmation (U-057): the change it takes back,
 * from the value it has now to the value it restores, with the restored value's risk.
 *
 * W15-34 (live check 2, research F13): it asks one plain question (`ask`), the command's own
 * (`undoAsk`: "Put web pages research may read for Reading rules back to any public website?
 * Research reads any public website …"), else "Put <what> back to <old value>?" from the card,
 * else 'Take back "<the change>"?' from its sentence; and its `what` is the change's own name.
 * Before, `what` was "undo: <what>" with no question, so the Inbox and Home titled the card
 * "undo" (the first sentence ended at the colon) with raw "yes"/"no".
 */
/** An Undo card's value when the change's own card was not at hand (`undoCardOf`). */
const UNDO_UNKNOWN_BEFORE = "as it was before this change";

function undoCardOf(
  row: ChangeLogRow,
  card: ChangeCard | null,
  risk: Risk,
  own: string | null = null,
): ChangeCard {
  const said = row.sentence.replace(/\s*Undo\.$/, "").trim();
  const what = card?.what ?? said;
  const restores = card ? `${card.what} back to ${card.oldValue}` : what;
  // The change without what it meant: "Set X from a to b: <effect>." reads "Set X from a to b".
  const change = (said.split(/:\s/)[0] ?? said).replace(/[.\s]+$/, "");
  const ask =
    own?.trim() || (card ? `Put ${card.what} back to ${card.oldValue}?` : `Take back "${change}"?`);
  return buildCard({
    command: "undo",
    what,
    oldValue: card?.newValue ?? "as it is now",
    newValue: card?.oldValue ?? UNDO_UNKNOWN_BEFORE,
    scope: row.scope,
    risk,
    sentence: `Undo ${restores}.`,
    reversible: false,
    projectId: row.project_id,
    projectName: card?.projectName ?? null,
    ask,
  });
}

/** A refusal of a project closed by Make one project or removed (`refuseClosedProject`). */
function isClosedProjectRefusal(e: unknown): boolean {
  if (!isForerunnerError(e)) return false;
  const cause = e.details?.cause;
  return cause === "project_joined" || cause === "project_removed";
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
  // d1109-onerepo-link: the details a command refused with (the offer of a link in use) reach
  // the caller; a reason quoting repository text keeps the untrusted mark (ADR 0114).
  const details = isForerunnerError(e) && e.details ? { ...e.details } : undefined;
  const mark = details?.untrusted as { source?: unknown; origin?: unknown } | undefined;
  const untrusted =
    mark && typeof mark.source === "string"
      ? ({
          source: mark.source,
          ...(typeof mark.origin === "string" ? { origin: mark.origin } : {}),
        } as CommandOutcome["untrusted"])
      : undefined;
  return {
    status: "refused",
    card,
    reason: errorMessage(e),
    code,
    ...(details ? { details } : {}),
    ...(untrusted ? { untrusted } : {}),
  };
}
