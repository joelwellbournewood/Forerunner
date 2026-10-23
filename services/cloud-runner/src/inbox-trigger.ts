import { type Clock, errorMessage, log } from "@forerunner/platform";
import {
  approvedPlanIdOf,
  isPlanRequest,
  markPlanAnswer,
  planAnswer,
  planAnswerApplied,
  type StartRequest,
} from "@forerunner/runtime";
import type { HumanRequestRow, MessageRow, StateStore } from "@forerunner/state";

/**
 * Inbox triggers (spec E: a new message or a human answer starts a session; E.1). While the
 * PC is off the runner is the only process that can notice a peer's handoff or the human's
 * answer to a question a session asked, so it polls the agent's inbox and the answered
 * requests and asks the scheduler for a session with trigger "message".
 *
 * What counts, in code:
 *  - an unread message addressed to the agent from another agent, created after `since`
 *    (the runner's start) and not already triggered on; a session reads and marks the inbox
 *    itself (checklist, re-checks between tasks), which is why a check waits while one runs;
 *  - a request a session filed (`session_id` set, `author_agent` the agent) that the human
 *    answered after `since`; a plan approval (`change_card.key` "plan:<session>") answered
 *    "approve" starts the session with `planApproved` bound to the card's `plan_id` (the
 *    runner runs the plan only while it is still that plan, ADR 0053; a card without the id
 *    starts a plain session that proposes the plan again), a rejected plan starts nothing.
 *
 * Each item triggers at most once (the ids are remembered until the message is read or the
 * answer falls out of the look-back). An approved plan is acted on once across processes as
 * well: the trigger shares the daemon's mark (`markPlanAnswer`, ADR 0053), so a plan request
 * whose card carries `applied_at` is not triggered on, and the one a start binds to is
 * claimed (a write conditional on the row's version) before the start is asked for and
 * marked with the scheduler's answer after; an older approved plan in the same check is
 * marked `superseded`. The start carries the cap of the session that filed the plan. When `shouldDefer` says a PC is online the items stay
 * untouched for the PC and the next check waits `deferMs` (ADR 0033: a PC daemon that is
 * online wins). The same holds when the scheduler's start reports "skipped" (a PC came online
 * between `shouldDefer` and the start): the items are remembered only once the scheduler owns
 * the request, so a dropped firing never loses them. Nothing here runs the session: the
 * scheduler keeps one per agent.
 */
export type InboxStartRequest = StartRequest;

/**
 * What became of a request: "started", "queued" and "deferred" are the scheduler's answers (it
 * owns the request from then on); "skipped" means the start was dropped for a PC that is online
 * (the items stay for the next check); "failed" means the start threw before a session existed.
 */
export type InboxRequestOutcome = "started" | "queued" | "deferred" | "skipped" | "failed";

export interface InboxTriggerDeps {
  store: Pick<StateStore, "message" | "humanRequest" | "session">;
  clock: Clock;
  agentId: string;
  /** A session of the agent runs (or the kill switch holds it): the check waits. */
  isActive: () => boolean;
  /** The PC-wins rule: true leaves the items for the PC and backs the check off. */
  shouldDefer?: () => Promise<boolean>;
  request: (req: InboxStartRequest) => Promise<InboxRequestOutcome>;
  pollMs?: number;
  /** Items at or before this instant (ms) are left to the next session; default: now. */
  since?: number;
  /** How long a check waits after a deferral; default six polls. */
  deferMs?: number;
  /** How far back a check looks for answered requests; default 24 h. */
  lookbackMs?: number;
}

export interface InboxTriggerStats {
  checks: number;
  triggered: number;
  deferred: number;
  lastCheckAt: string | null;
  lastTriggerAt: string | null;
  lastReason: string | null;
}

export const DEFAULT_INBOX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export class InboxTrigger {
  private readonly logger = log("cloud-runner:inbox");
  private readonly pollMs: number;
  private readonly since: number;
  private readonly deferMs: number;
  private readonly lookbackMs: number;
  /** message id -> created_at ms, for messages already triggered on and still unread. */
  private readonly seenMessages = new Map<string, number>();
  /** request id -> answered_at ms, for answers already triggered on inside the look-back. */
  private readonly seenAnswers = new Map<string, number>();
  private deferredUntil: number | null = null;
  private cancel: (() => void) | null = null;
  private readonly counters: InboxTriggerStats = {
    checks: 0,
    triggered: 0,
    deferred: 0,
    lastCheckAt: null,
    lastTriggerAt: null,
    lastReason: null,
  };

  constructor(private readonly deps: InboxTriggerDeps) {
    this.pollMs = Math.max(1_000, deps.pollMs ?? 30_000);
    this.since = deps.since ?? deps.clock.now();
    this.deferMs = Math.max(this.pollMs, deps.deferMs ?? this.pollMs * 6);
    this.lookbackMs = Math.max(this.pollMs, deps.lookbackMs ?? DEFAULT_INBOX_LOOKBACK_MS);
  }

  get stats(): InboxTriggerStats {
    return { ...this.counters };
  }

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      try {
        await this.check();
      } catch (e) {
        this.logger.warn("inbox check failed", { error: errorMessage(e) });
      }
      if (this.cancel) this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
    };
    this.cancel = this.deps.clock.setTimeout(tick, this.pollMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** One check (the tick; exposed for tests): the request made, or null. */
  async check(now: number = this.deps.clock.now()): Promise<InboxStartRequest | null> {
    this.counters.checks++;
    this.counters.lastCheckAt = new Date(now).toISOString();
    if (this.deps.isActive()) return null;
    if (this.deferredUntil !== null && now < this.deferredUntil) return null;
    this.deferredUntil = null;
    const floor = Math.max(this.since, now - this.lookbackMs);
    const { agentId } = this.deps;

    const unread = await this.deps.store.message.inbox(
      { agentId },
      { unreadOnly: true, limit: 200 },
    );
    const unreadIds = new Set(unread.map((m) => m.id));
    for (const id of [...this.seenMessages.keys()])
      if (!unreadIds.has(id)) this.seenMessages.delete(id);
    const messages = unread.filter(
      (m) =>
        m.from_agent_id !== agentId &&
        Date.parse(m.created_at) > floor &&
        !this.seenMessages.has(m.id),
    );

    const answeredRows = await this.deps.store.humanRequest.list(
      { status: "answered", author_agent: agentId },
      { orderBy: "answered_at desc", limit: 200 },
    );
    for (const [id, at] of [...this.seenAnswers]) if (at <= floor) this.seenAnswers.delete(id);
    const answers = answeredRows.filter(
      (r) =>
        r.session_id !== null &&
        r.answered_at !== null &&
        Date.parse(r.answered_at) > floor &&
        !this.seenAnswers.has(r.id) &&
        // A plan the PC's daemon (or an earlier check) acted on is not acted on again.
        !(isPlanRequest(r) && planAnswerApplied(r)),
    );
    if (messages.length === 0 && answers.length === 0) return null;

    if (this.deps.shouldDefer && (await this.deps.shouldDefer())) {
      this.counters.deferred++;
      this.deferredUntil = now + this.deferMs;
      this.logger.info("inbox items left to the PC daemon that is online", {
        messages: messages.length,
        answers: answers.length,
        until: new Date(this.deferredUntil).toISOString(),
      });
      return null;
    }

    const remember = () => {
      for (const m of messages) this.seenMessages.set(m.id, Date.parse(m.created_at));
      for (const r of answers) this.seenAnswers.set(r.id, Date.parse(r.answered_at ?? ""));
    };
    // Claim the approved plan the start binds to; one another runner claimed first is its own.
    let planned = this.requestFor(messages, answers);
    let claimed: HumanRequestRow | null = null;
    while (planned.planRow) {
      const row: HumanRequestRow = planned.planRow;
      claimed = await markPlanAnswer(this.deps.store, this.deps.clock, row, "starting");
      if (claimed) break;
      this.logger.info("approved plan already acted on by another runner", { id: row.id });
      this.seenAnswers.set(row.id, Date.parse(row.answered_at ?? ""));
      answers.splice(answers.indexOf(row), 1);
      planned = this.requestFor(messages, answers);
    }
    const { planRow, superseded } = planned;
    let req = planned.req;
    if (req && planRow?.session_id) {
      const filing = await this.deps.store.session.get(planRow.session_id);
      if (filing && filing.budget_cap_usd_micro > 0)
        req = { ...req, budgetUsdMicro: filing.budget_cap_usd_micro };
    }
    if (!req) {
      // Only rejected plans: nothing to run, and nothing to look at again.
      remember();
      return null;
    }
    this.logger.info("inbox trigger: asking for a session", {
      reason: req.reason,
      projectId: req.projectId ?? null,
      planApproved: req.planApproved ?? null,
    });
    const outcome = await this.deps.request(req);
    if (planRow && claimed) {
      if (outcome === "skipped") {
        // Released for the PC that came online: its daemon's sync acts on the plan.
        await this.deps.store.humanRequest
          .update(claimed.id, claimed.version, { change_card: planRow.change_card })
          .catch((e) => this.logger.warn("plan claim not released", { error: errorMessage(e) }));
      } else {
        const result = outcome === "failed" ? "start_failed" : outcome;
        await markPlanAnswer(this.deps.store, this.deps.clock, claimed, result);
        for (const r of superseded)
          await markPlanAnswer(this.deps.store, this.deps.clock, r, "superseded", {
            superseded_by: planRow.id,
          });
      }
    }
    if (outcome === "skipped") {
      // A PC came online after shouldDefer looked: the items stay for it, as a deferral does.
      this.counters.deferred++;
      this.deferredUntil = now + this.deferMs;
      this.logger.info("inbox items left to the PC daemon that came online", {
        messages: messages.length,
        answers: answers.length,
        until: new Date(this.deferredUntil).toISOString(),
      });
      return null;
    }
    remember();
    this.counters.triggered++;
    this.counters.lastTriggerAt = new Date(now).toISOString();
    this.counters.lastReason = req.reason;
    return req;
  }

  private requestFor(
    messages: MessageRow[],
    answers: HumanRequestRow[],
  ): {
    req: InboxStartRequest | null;
    /** The approved plan request the start binds to. */
    planRow: HumanRequestRow | null;
    /** Older approved plans of the same check: marked `superseded` once the start is made. */
    superseded: HumanRequestRow[];
  } {
    // The newest approved plan's id binds the start (`answers` is newest first); an older
    // approved plan in the same check is superseded by it. A card without a plan id starts
    // the session unbound: it proposes again.
    let planRow: HumanRequestRow | null = null;
    const superseded: HumanRequestRow[] = [];
    let rejectedPlans = 0;
    const useful: HumanRequestRow[] = [];
    for (const r of answers) {
      if (isPlanRequest(r)) {
        if (planAnswer(r.answer) === "approve") {
          const id = approvedPlanIdOf(r);
          if (id && planRow === null) planRow = r;
          else if (id) {
            superseded.push(r);
            this.logger.info("older approved plan superseded in this check", { id });
          } else this.logger.warn("approved plan names no plan id; proposing again", { id: r.id });
          useful.push(r);
        } else {
          rejectedPlans++;
        }
        continue;
      }
      useful.push(r);
    }
    if (messages.length === 0 && useful.length === 0) {
      if (rejectedPlans > 0) this.logger.info("plan rejected; no session", { rejectedPlans });
      return { req: null, planRow: null, superseded: [] };
    }
    const projects = new Set<string>();
    for (const m of messages) if (m.project_id) projects.add(m.project_id);
    for (const r of useful) if (r.project_id) projects.add(r.project_id);
    const parts: string[] = [];
    if (messages.length > 0)
      parts.push(`${messages.length} new message${messages.length === 1 ? "" : "s"}`);
    if (useful.length > 0)
      parts.push(`${useful.length} answered request${useful.length === 1 ? "" : "s"}`);
    const [only] = projects.size === 1 ? [...projects] : [undefined];
    const planApproved = planRow ? approvedPlanIdOf(planRow) : null;
    return {
      req: {
        agentId: this.deps.agentId,
        ...(only ? { projectId: only } : {}),
        trigger: "message",
        reason: parts.join(", "),
        ...(planApproved ? { planApproved } : {}),
      },
      planRow,
      superseded,
    };
  }
}
