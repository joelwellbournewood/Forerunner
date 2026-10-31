/**
 * Producer helpers: pure builders the orchestrator calls from the session runner, the human
 * request path, the kill switch, the critic, the updater, the email command handler and the
 * inbox. Each returns a `Notification` for `Notifier.notify`; the builders decide the kind,
 * the deep link and the dedupe key so every producer behaves the same way.
 */

import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import type { HumanRequestRow, MessageRow, ReviewRow } from "@forerunner/state";
import type { KillReport, KillScope } from "../enforcement/killswitch.ts";
import type { InjectionReport } from "../injection/scan.ts";
import { countsBrief, countsOf } from "../session/counts.ts";
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
  /** The spend in CHF (the ledger's conversion); the title says CHF (U-074). */
  spentChfMicro?: number;
  completed: string[];
  needsHuman: string[];
  /** Failed tasks; the title names them (U-017: "0 done, 0 need you" hid a failed task). */
  failed?: string[];
  /** Sent back by the critic, in review, not started: the summary's categories (U-072). */
  retried?: string[];
  inReview?: string[];
  skipped?: string[];
  projectId?: string | null;
  agentName?: string;
}

/** USD micro-units in CHF micro-units at `rate` (the default rate without one). */
function chfMicroOf(usdMicro: number, rate: number = DEFAULT_CHF_PER_USD): number {
  return usdToChfMicro(Math.max(0, Math.round(usdMicro)), rate);
}

/** Session end (spec E.5 "notify human"); a budget stop becomes the urgent `budget_stop`. */
export function sessionEnded(humanId: string, r: SessionEndFacts): Notification {
  if (r.stopReason === "budget_exceeded") return budgetStop(humanId, r);
  const who = r.agentName ? `${r.agentName}'s session` : "Session";
  return {
    kind: "session_ended",
    humanId,
    // The summary's categories, those that happened (U-072): a session whose only task was
    // sent back reads "0 done, 1 sent back", not "0 done, 0 need you".
    title: `${who} ${r.status}: ${countsBrief(countsOf(r))}`,
    body: cut(r.summary, 1000),
    link: `/sessions/${r.sessionId}`,
    projectId: r.projectId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `session:${r.sessionId}:ended`,
  };
}

/** A session hit its cap and stopped with a handoff (scenario 5). */
export function budgetStop(humanId: string, r: SessionEndFacts): Notification {
  const chf = r.spentChfMicro ?? chfMicroOf(r.spentUsdMicro);
  return {
    kind: "budget_stop",
    humanId,
    title: `${r.agentName ? `${r.agentName} ` : ""}stopped: budget cap reached (${formatChf(chf)} spent)`,
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

/**
 * The report's summary for a notification body: where the content came from, how many
 * instruction-like passages the scan found and which rules fired, never the passages
 * themselves (ADR 0047: a notification travels through channels the flagged text must not
 * reach; the quoted passages stay in the session log the link opens).
 */
export function summarizeInjection(report: InjectionReport, origin?: string): string {
  const where = origin ? ` from ${origin}` : "";
  const counts = new Map<string, number>();
  for (const m of report.matches) counts.set(m.rule, (counts.get(m.rule) ?? 0) + 1);
  const lines = [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rule, n]) => `- ${rule}: ${n} passage${n === 1 ? "" : "s"}`);
  return `Content${where} (${report.source}) contained ${report.matches.length} instruction-like passage(s). They were ignored:\n${lines.join("\n")}\nScore ${report.score}; open the session log to read them.`;
}

/**
 * Prompt injection seen and ignored (scenario 6): always urgent, the human is told where and
 * which rules fired; the passages themselves are in the audit row and the session log.
 */
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
    body: cut(summarizeInjection(report, opts.origin), 1000),
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

export interface UpdateOutcomeFacts {
  /** `update`: a release was staged and the daemon restarts into it; `rollback`: it went back. */
  reason: "update" | "rollback";
  targetVersion: string;
  fromVersion: string | null;
}

/**
 * An update was applied or rolled back (spec M.4, M.5): the daemon restarts right after, so
 * the human learns why the app went away for a moment. Normal urgency: it waits for the morning
 * inside quiet hours like a finished session does. Links to `/settings` for the same reason
 * `updateAvailable` does.
 */
export function updateApplied(humanId: string, u: UpdateOutcomeFacts): Notification {
  const from = u.fromVersion ? ` (from ${u.fromVersion})` : "";
  return {
    kind: "update_applied",
    humanId,
    title:
      u.reason === "rollback"
        ? `Rolled back to ${u.targetVersion}${from}`
        : `Update ${u.targetVersion} applied${from}; restarting`,
    body:
      u.reason === "rollback"
        ? "The new version did not pass its health check or a rollback was requested; the previous version is running again. Open Settings to read the details."
        : "The daemon restarts into the new version now. Open Settings to read the changelog.",
    link: "/settings",
    dedupeKey: `update-applied:${u.reason}:${u.targetVersion}`,
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

/**
 * Switching the sending mode to off turned email commands off (ADR 0081): the owner hears it
 * at once, whoever changed the mode, so a command mailed afterwards is not expected to run.
 */
export function emailCommandsOff(
  humanId: string,
  e: { agentId: string; at: string; message: string; modeBefore: string },
): Notification {
  return {
    kind: "email_commands_off",
    humanId,
    title: "Email commands turned off",
    body: cut(e.message, 500),
    link: "/settings",
    dedupeKey: `email-commands-off:${e.agentId}:${e.at}`,
  };
}

/** A message from an agent to the human (spec F); questions, requests and acks are normal. */
export function peerMessage(humanId: string, m: MessageRow, fromName?: string): Notification {
  const attention =
    m.requires_ack || m.type === "question" || m.type === "request" || m.type === "warning";
  return {
    kind: "peer_message",
    humanId,
    // A name, never the agent's id (U-074).
    title: `${fromName ?? "Another agent"}: ${m.type}`,
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

export interface CalibrationDriftFacts {
  since: string | null;
  catchRatePoints: number | null;
  passRatePoints: number | null;
}

export interface CalibrationFacts {
  date: string;
  sessionId: string | null;
  /** Set when the run did not finish: the title says so and the body carries the reason. */
  error?: string;
  catchRate?: number;
  passRate?: number;
  counts?: {
    cleanReviewed: number;
    cleanAccepted: number;
    seededReviewed: number;
    defectsCaught: number;
  };
  gateOk?: boolean;
  thresholds?: { catchRate: number; passRate: number };
  drift?: CalibrationDriftFacts;
  model?: string;
  tier?: number;
  reviews?: number;
  costUsdMicro?: number;
  /** The day's CHF per USD for the cost line; the default rate without it (U-074). */
  chfPerUsd?: number;
  file?: string | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The drift line (spec H.7 "so drift is visible"): points against the previous report. */
export function calibrationDriftLine(d: CalibrationDriftFacts): string {
  if (d.since === null) return "Drift: no earlier report, this run is the baseline.";
  const part = (name: string, p: number | null) =>
    p === null || p === 0 ? `${name} unchanged` : `${name} ${p > 0 ? "+" : ""}${p} points`;
  return `Drift: ${part("catch rate", d.catchRatePoints)}, ${part("pass rate", d.passRatePoints)} since ${d.since}.`;
}

/**
 * The monthly critic calibration ran (spec H.7, ADR 0060): the catch rate, the pass rate, the
 * gate and the drift against the previous report in the title and the body; a failed run
 * names its reason. Normal urgency: it waits for the morning inside quiet hours.
 */
export function criticCalibration(humanId: string, f: CalibrationFacts): Notification {
  const link = f.sessionId ? `/sessions/${f.sessionId}` : "/inbox";
  if (f.error !== undefined) {
    return {
      kind: "critic_calibration",
      humanId,
      title: `Critic calibration ${f.date} failed`,
      body: cut(`The monthly calibration did not finish: ${f.error}`, 500),
      link,
      sessionId: f.sessionId ?? undefined,
      dedupeKey: `calibration:${f.date}:failed`,
    };
  }
  const catchRate = f.catchRate ?? 0;
  const passRate = f.passRate ?? 0;
  const c = f.counts;
  const lines = [
    `Defects caught ${c ? `${c.defectsCaught}/${c.seededReviewed}` : pct(catchRate)} (${pct(catchRate)}${f.thresholds ? `, gate ${pct(f.thresholds.catchRate)}` : ""}); clean work accepted ${c ? `${c.cleanAccepted}/${c.cleanReviewed}` : pct(passRate)} (${pct(passRate)}${f.thresholds ? `, gate ${pct(f.thresholds.passRate)}` : ""}).`,
    f.drift ? calibrationDriftLine(f.drift) : "",
    `Review level ${f.tier ?? "?"} on ${f.model ?? "?"}, ${f.reviews ?? "?"} reviews, ${formatChf(chfMicroOf(f.costUsdMicro ?? 0, f.chfPerUsd))}.${f.file ? ` Report: ${f.file}` : ""}`,
  ].filter((l) => l !== "");
  return {
    kind: "critic_calibration",
    humanId,
    title: `Critic calibration ${f.date}: caught ${pct(catchRate)}, accepted ${pct(passRate)}${f.gateOk === false ? " (gate not met)" : ""}`,
    body: cut(lines.join("\n"), 1000),
    link,
    sessionId: f.sessionId ?? undefined,
    dedupeKey: `calibration:${f.date}`,
  };
}

export interface HandoverFacts {
  date: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  stuck: number;
  docsTaskId: string | null;
  status: string;
  summary: string;
}

/**
 * The monthly handover test ran on a project (spec P.15, ADR 0060): how many places the fresh
 * agent got stuck at and whether a docs task was filed; the body is the report the inbox got.
 */
export function handoverReport(humanId: string, f: HandoverFacts): Notification {
  return {
    kind: "handover_report",
    humanId,
    title: `Handover test ${f.date} on ${f.projectName}: ${f.stuck} stuck place${f.stuck === 1 ? "" : "s"}${f.docsTaskId ? ", docs task filed" : ""} (session ${f.status})`,
    body: cut(f.summary, 1000),
    link: `/sessions/${f.sessionId}`,
    projectId: f.projectId,
    sessionId: f.sessionId,
    dedupeKey: `handover:${f.projectId}:${f.date}`,
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
    updateApplied: (humanId: string, u: UpdateOutcomeFacts) =>
      notifier.notify(updateApplied(humanId, u)),
    emailCommandReceived: (humanId: string, e: Parameters<typeof emailCommandReceived>[1]) =>
      notifier.notify(emailCommandReceived(humanId, e)),
    emailCommandsOff: (humanId: string, e: Parameters<typeof emailCommandsOff>[1]) =>
      notifier.notify(emailCommandsOff(humanId, e)),
    peerMessage: (humanId: string, m: MessageRow, fromName?: string) =>
      notifier.notify(peerMessage(humanId, m, fromName)),
    killSwitch: (humanId: string, report: KillReport, reason: string) =>
      notifier.notify(killSwitch(humanId, report, reason)),
    criticCalibration: (humanId: string, f: CalibrationFacts) =>
      notifier.notify(criticCalibration(humanId, f)),
    handoverReport: (humanId: string, f: HandoverFacts) =>
      notifier.notify(handoverReport(humanId, f)),
  };
}

export type ProducerHooks = ReturnType<typeof bindProducers>;
