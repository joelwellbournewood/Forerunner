/**
 * Producer helpers: pure builders the orchestrator calls from the session runner, the human
 * request path, the kill switch, the critic, the updater, the email command handler and the
 * inbox. Each returns a `Notification` for `Notifier.notify`; the builders decide the kind,
 * the deep link and the dedupe key so every producer behaves the same way.
 */
import type { HumanRequestRow, MessageRow, ReviewRow } from "@forerunner/state";
import type { KillReport, KillScope } from "../enforcement/killswitch.ts";
import { describeInjection, type InjectionReport } from "../injection/scan.ts";
import type { Notification, NotificationRecord } from "./types.ts";

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const REQUEST_LABEL: Record<HumanRequestRow["kind"], string> = {
  decision: "A decision is needed",
  credential: "A credential is needed",
  approval: "An approval is needed",
  info: "Information is needed",
};

/** A human request was opened; blocking requests are urgent (ADR 0017). */
export function requestOpened(req: HumanRequestRow, humanId: string): Notification {
  return {
    kind: req.blocking ? "request_blocking" : "request_opened",
    humanId,
    title: `${REQUEST_LABEL[req.kind]}${req.blocking ? " (work is blocked)" : ""}`,
    body: cut(req.why, 500),
    link: "/inbox",
    projectId: req.project_id ?? undefined,
    sessionId: req.session_id ?? undefined,
    dedupeKey: `request:${req.id}`,
  };
}

export interface SessionEndFacts {
  sessionId: string;
  status: string;
  stopReason: string;
  summary: string;
  spentUsdMicro: number;
  completed: string[];
  needsHuman: string[];
  projectId?: string | null;
  agentName?: string;
}

/** Session end (spec E.5 "notify human"); a budget stop becomes the urgent `budget_stop`. */
export function sessionEnded(humanId: string, r: SessionEndFacts): Notification {
  if (r.stopReason === "budget_exceeded") return budgetStop(humanId, r);
  const who = r.agentName ? `${r.agentName}'s session` : "Session";
  return {
    kind: "session_ended",
    humanId,
    title: `${who} ${r.status}: ${r.completed.length} done, ${r.needsHuman.length} need${r.needsHuman.length === 1 ? "s" : ""} you`,
    body: cut(r.summary, 1000),
    link: `/sessions/${r.sessionId}`,
    projectId: r.projectId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `session:${r.sessionId}:ended`,
  };
}

/** A session hit its cap and stopped with a handoff (scenario 5). */
export function budgetStop(humanId: string, r: SessionEndFacts): Notification {
  const usd = (r.spentUsdMicro / 1_000_000).toFixed(2);
  return {
    kind: "budget_stop",
    humanId,
    title: `${r.agentName ? `${r.agentName} ` : ""}stopped: budget cap reached (USD ${usd} spent)`,
    body: cut(r.summary, 1000),
    link: `/sessions/${r.sessionId}`,
    projectId: r.projectId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `session:${r.sessionId}:budget`,
  };
}

/** Critic verdict; `escalate` and `human` are raised to normal so they do not wait for the digest. */
export function criticVerdict(
  humanId: string,
  review: Pick<ReviewRow, "id" | "verdict" | "grade" | "task_id" | "session_id" | "summary">,
  projectId?: string | null,
): Notification {
  const needsAttention = review.verdict === "escalate" || review.verdict === "human";
  return {
    kind: "critic_verdict",
    humanId,
    title: `Critic: ${review.verdict} (grade ${review.grade})`,
    body: cut(
      review.summary || `Review ${review.id}${review.task_id ? ` of task ${review.task_id}` : ""}`,
      500,
    ),
    link: projectId ? `/projects/${projectId}/reviews` : "/inbox",
    projectId: projectId ?? undefined,
    sessionId: review.session_id ?? undefined,
    dedupeKey: `review:${review.id}`,
    urgency: needsAttention ? "normal" : "info",
  };
}

/** Prompt injection seen and ignored (scenario 6): always urgent, quoted to the human. */
export function injectionFlagged(
  humanId: string,
  report: InjectionReport,
  opts: { origin?: string; sessionId?: string; projectId?: string | null } = {},
): Notification {
  const rules = [...new Set(report.matches.map((m) => m.rule))].sort().join(",");
  return {
    kind: "injection_flagged",
    humanId,
    title: `Instructions found in ${report.source} content were ignored`,
    body: cut(describeInjection(report, opts.origin), 1000),
    link: opts.sessionId ? `/sessions/${opts.sessionId}` : "/inbox",
    projectId: opts.projectId ?? undefined,
    sessionId: opts.sessionId,
    dedupeKey: `injection:${opts.sessionId ?? "none"}:${report.source}:${opts.origin ?? ""}:${rules}`,
  };
}

/**
 * A signed release is available (spec M.3). The UI has a dedicated `/updates` page, but the
 * desktop shell only opens the roots listed in its `deeplink.rs`; `/settings` is the nearest
 * one it accepts today. Point the link at `/updates` once the shell lists that root.
 */
export function updateAvailable(
  humanId: string,
  u: { version: string; channel: string; notes?: string },
): Notification {
  return {
    kind: "update_available",
    humanId,
    title: `Update available: ${u.version} (${u.channel})`,
    body: cut(u.notes ?? "Open Settings to read the changelog and update.", 500),
    link: "/settings",
    dedupeKey: `update:${u.version}`,
  };
}

/** A verified email command was received (spec T); the outcome names what happened. */
export function emailCommandReceived(
  humanId: string,
  e: { messageId: string; from: string; subject: string; outcome: string; sessionId?: string },
): Notification {
  return {
    kind: "email_command_received",
    humanId,
    title: `Email command ${e.outcome}`,
    body: cut(`From ${e.from}: ${e.subject}`, 300),
    link: "/inbox",
    sessionId: e.sessionId,
    dedupeKey: `email-command:${e.messageId}`,
  };
}

/** A message from an agent to the human (spec F); questions, requests and acks are normal. */
export function peerMessage(humanId: string, m: MessageRow, fromName?: string): Notification {
  const attention =
    m.requires_ack || m.type === "question" || m.type === "request" || m.type === "warning";
  return {
    kind: "peer_message",
    humanId,
    title: `${fromName ?? m.from_agent_id}: ${m.type}`,
    body: cut(m.body, 500),
    link: "/inbox",
    projectId: m.project_id ?? undefined,
    dedupeKey: `message:${m.id}`,
    urgency: attention ? "normal" : "info",
  };
}

function scopeKey(scope: KillScope | "all"): string {
  if (scope === "all") return "all";
  return `${scope.agentId ?? "*"}:${scope.sessionId ?? "*"}`;
}

/**
 * The kill switch fired (spec S.8): urgent, scoped by what was stopped. The link is the stopped
 * session when there is one, else the home route "/" (the shell opens "/" and the UI roots
 * only; `deepLinkFor("/")` is `fr://open`).
 */
export function killSwitch(humanId: string, report: KillReport, reason: string): Notification {
  const scope =
    report.scope === "all" ? "everything" : report.scope.sessionId ? "one session" : "one agent";
  const sessionId = report.scope !== "all" ? report.scope.sessionId : undefined;
  return {
    kind: "kill_switch",
    humanId,
    title: `Kill switch: ${scope} stopped`,
    body: cut(
      `${report.stoppedRuns} run(s) stopped, ${report.killedProcesses} process(es) killed, ${report.revokedTokens} token(s) revoked in ${report.durationMs} ms. Reason: ${reason}`,
      500,
    ),
    link: sessionId ? `/sessions/${sessionId}` : "/",
    sessionId,
    dedupeKey: `kill:${scopeKey(report.scope)}`,
  };
}

/** What `bindProducers` needs: `Notifier` satisfies it, so does a fake in tests. */
export interface NotifierLike {
  notify(n: Notification): Promise<NotificationRecord>;
}

/**
 * The builders above bound to one notifier: the hooks the orchestrator hands to the session
 * runner, the human request path, the kill switch, the critic, the updater, the email command
 * handler and the inbox. Each resolves with the notifier's record (delivered, held, ...).
 */
export function bindProducers(notifier: NotifierLike) {
  return {
    requestOpened: (req: HumanRequestRow, humanId: string) =>
      notifier.notify(requestOpened(req, humanId)),
    sessionEnded: (humanId: string, r: SessionEndFacts) =>
      notifier.notify(sessionEnded(humanId, r)),
    budgetStop: (humanId: string, r: SessionEndFacts) => notifier.notify(budgetStop(humanId, r)),
    criticVerdict: (
      humanId: string,
      review: Parameters<typeof criticVerdict>[1],
      projectId?: string | null,
    ) => notifier.notify(criticVerdict(humanId, review, projectId)),
    injectionFlagged: (
      humanId: string,
      report: InjectionReport,
      opts?: Parameters<typeof injectionFlagged>[2],
    ) => notifier.notify(injectionFlagged(humanId, report, opts)),
    updateAvailable: (humanId: string, u: Parameters<typeof updateAvailable>[1]) =>
      notifier.notify(updateAvailable(humanId, u)),
    emailCommandReceived: (humanId: string, e: Parameters<typeof emailCommandReceived>[1]) =>
      notifier.notify(emailCommandReceived(humanId, e)),
    peerMessage: (humanId: string, m: MessageRow, fromName?: string) =>
      notifier.notify(peerMessage(humanId, m, fromName)),
    killSwitch: (humanId: string, report: KillReport, reason: string) =>
      notifier.notify(killSwitch(humanId, report, reason)),
  };
}

export type ProducerHooks = ReturnType<typeof bindProducers>;
