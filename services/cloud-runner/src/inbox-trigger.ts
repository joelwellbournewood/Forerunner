import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { StartRequest } from "@forerunner/runtime";
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
 *    "approve" starts the session with `planApproved`, a rejected plan starts nothing.
 *
 * Each item triggers at most once (the ids are remembered until the message is read or the
 * answer falls out of the look-back). When `shouldDefer` says a PC is online the items stay
 * untouched for the PC and the next check waits `deferMs` (ADR 0033: a PC daemon that is
 * online wins). The same holds when the scheduler's start reports "skipped" (a PC came online
 * between `shouldDefer` and the start): the items are remembered only once the scheduler owns
 * the request, so a dropped firing never loses them. Nothing here runs the session: the
 * scheduler keeps one per agent.
 */
export interface InboxStartRequest extends StartRequest {
  planApproved?: boolean;
}

/**
 * What became of a request: "started", "queued" and "deferred" are the scheduler's answers (it
 * owns the request from then on); "skipped" means the start was dropped for a PC that is online
 * (the items stay for the next check); "failed" means the start threw before a session existed.
 */
export type InboxRequestOutcome = "started" | "queued" | "deferred" | "skipped" | "failed";

export interface InboxTriggerDeps {
  store: Pick<StateStore, "message" | "humanRequest">;
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

function planKeyOf(row: HumanRequestRow): string | null {
  const key = row.change_card?.key;
  return typeof key === "string" && key.startsWith("plan:") ? key : null;
}

function answerWord(row: HumanRequestRow): string {
  const a = row.answer;
  if (typeof a === "string") return a.trim().toLowerCase();
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const option = (a as { option?: unknown }).option;
    if (typeof option === "string") return option.trim().toLowerCase();
  }
  return "";
}

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
        !this.seenAnswers.has(r.id),
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
    const req = this.requestFor(messages, answers);
    if (!req) {
      // Only rejected plans: nothing to run, and nothing to look at again.
      remember();
      return null;
    }
    this.logger.info("inbox trigger: asking for a session", {
      reason: req.reason,
      projectId: req.projectId ?? null,
      planApproved: req.planApproved ?? false,
    });
    const outcome = await this.deps.request(req);
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

  private requestFor(messages: MessageRow[], answers: HumanRequestRow[]): InboxStartRequest | null {
    let planApproved = false;
    let rejectedPlans = 0;
    const useful: HumanRequestRow[] = [];
    for (const r of answers) {
      if (planKeyOf(r)) {
        if (answerWord(r) === "approve") {
          planApproved = true;
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
      return null;
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
    return {
      agentId: this.deps.agentId,
      ...(only ? { projectId: only } : {}),
      trigger: "message",
      reason: parts.join(", "),
      ...(planApproved ? { planApproved: true } : {}),
    };
  }
}
