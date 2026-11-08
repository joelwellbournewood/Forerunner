/**
 * Producer helpers: pure builders the orchestrator calls from the session runner, the human
 * request path, the kill switch, the critic, the updater, the email command handler and the
 * inbox. Each returns a `Notification` for `Notifier.notify`; the builders decide the kind,
 * the deep link and the dedupe key so every producer behaves the same way.
 */

import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import type { HumanRequestRow, MessageRow, ReviewRow } from "@forerunner/state";
import { requestWords } from "../daemon/request-words.ts";
import { plainPlurals, withoutIds } from "../daemon/task-words.ts";
import type { KillReport, KillScope } from "../enforcement/killswitch.ts";
import type { InjectionReport } from "../injection/scan.ts";
import { isNewsLine, stopWords } from "../session/result.ts";
import {
  isBudgetStopReason,
  MONTH_CAP_STOP,
  PLAN_SHARE_STOP,
  PROJECT_BUDGET_STOP,
  stopLimitWords,
} from "../session/stop-words.ts";
import type { Notification, NotificationRecord } from "./types.ts";

/*
 * What a notification says (core-experience design §5: title at most 60 characters, body at
 * most 140, names not ids). Before, a card read "An approval is needed (work is blocked)" for a
 * task that had failed four times, a verdict "Critic: revise (grade 35)", a session "Alice's
 * session completed: 0 done" with no project, and a body could be "Review <uuid> of task
 * <uuid>". Now the title names the project and the task and what happened; the body is one
 * sentence and what to do.
 */

/** The limits of design §5 rule 1. */
export const NOTIFICATION_TITLE_MAX = 60;
export const NOTIFICATION_BODY_MAX = 140;

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, "")}…`;
}

/** A line as the writing rules want it: no ids, plurals as the number says, no markdown. */
function plain(s: string): string {
  return plainPlurals(withoutIds(s))
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A text within `max`: the quoted names in it are shortened first (a task's title, cut at a
 * word), so what happened stays whole; only then the text itself is cut.
 */
function fit(text: string, max: number): string {
  let t = text;
  // The longest quoted name is shortened first, by what is over, never below 12 characters.
  for (let i = 0; i < 6 && t.length > max; i++) {
    const longest = [...t.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1] as string)
      .sort((a, b) => b.length - a.length)[0];
    if (!longest || longest.length <= 12) break;
    const target = Math.max(12, longest.length - (t.length - max) - 1);
    // A name is cut at a word, however short that leaves it ("Create…", never "Create inde…").
    const head = longest.slice(0, target - 1);
    const space = head.lastIndexOf(" ");
    const short = `${(space > 0 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, "")}…`;
    t = t.replace(`"${longest}"`, `"${short}"`);
  }
  return t.length <= max ? t : cut(t, max);
}

const capitalFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Quote page: <what>", the project's name first when the words do not name it already. */
function titled(projectName: string | null | undefined, what: string): string {
  const w = plain(what).replace(/[.\s]+$/, "");
  const name = projectName?.trim();
  if (!name || w.includes(name)) return fit(capitalFirst(w), NOTIFICATION_TITLE_MAX);
  return fit(`${name}: ${w}`, NOTIFICATION_TITLE_MAX);
}

/** A text and what to do, within the body's limit; a quote cut short is closed again. */
function bodyOf(text: string | null | undefined, action: string): string {
  const t = capitalFirst(plain(text ?? ""));
  if (!t) return action;
  const room = NOTIFICATION_BODY_MAX - action.length - 1;
  // Names (two or more quoted titles) are shortened first; one quotation is cut at its end.
  const shorten = (s: string, max: number) =>
    (s.match(/"[^"]+"/g)?.length ?? 0) >= 2 ? fit(s, max) : cut(s, max);
  let said = shorten(t, room);
  if ((said.match(/"/g)?.length ?? 0) % 2 === 1) said = `${shorten(t, room - 1)}"`;
  if (!/[.!?"…]$/.test(said)) said = `${said}.`;
  return `${said} ${action}`;
}

/** What a notification about a card needs beyond its row: the names it gives. */
export interface RequestNames {
  projectName?: string | null;
  taskTitle?: string | null;
}

/**
 * A human request was opened; blocking requests are urgent (ADR 0017). The title is the card's
 * own title with the project's name ('Quote page: "Style the page" failed 4 times'), the body
 * its first sentence and "Answer it in the Inbox."
 */
export function requestOpened(
  req: HumanRequestRow,
  humanId: string,
  names: RequestNames = {},
): Notification {
  const words = requestWords(req, {
    projectName: names.projectName ?? null,
    taskTitle: names.taskTitle ?? null,
  });
  return {
    kind: req.blocking ? "request_blocking" : "request_opened",
    humanId,
    title: titled(names.projectName, words.title),
    // A card whose text is one sentence has it as its title: the body only says what to do.
    body: bodyOf(words.body, "Answer it in the Inbox."),
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
  /**
   * The amount of the outer limit a pause ended the session at (this month's cap, the project's
   * budget; ADR 0112), in CHF: the budget stop's body says it first.
   */
  stopCapChfMicro?: number;
  summary: string;
  /**
   * The result's lines without what an open Inbox card already says (the runner's
   * `SessionResult.news`): the notification tells these, the cards tell the rest (design
   * §4.3: the person hears once). Absent: the summary's lines.
   */
  news?: string[];
  spentUsdMicro: number;
  /** The spend in CHF (the ledger's conversion); the title says CHF (U-074). */
  spentChfMicro?: number;
  completed: string[];
  needsHuman: string[];
  /**
   * Of `needsHuman`, the tasks paused at a budget whose card offers Continue (budget-resume): the
   * stop says to continue them from their card. A task that needs the person for another reason
   * (a question) has no Continue, so the stop says what helps instead.
   */
  paused?: string[];
  /** Failed tasks; the title names them (U-017: "0 done, 0 need you" hid a failed task). */
  failed?: string[];
  /** Sent back by the critic, in review, not started: the summary's categories (U-072). */
  retried?: string[];
  inReview?: string[];
  skipped?: string[];
  projectId?: string | null;
  /** The project's name: the title starts with it (design §5, "Notification"). */
  projectName?: string | null;
  agentName?: string;
}

/** USD micro-units in CHF micro-units at `rate` (the default rate without one). */
function chfMicroOf(usdMicro: number, rate: number = DEFAULT_CHF_PER_USD): number {
  return usdToChfMicro(Math.max(0, Math.round(usdMicro)), rate);
}

/** A text's non-empty lines, trimmed. */
const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * A result's first point and what follows it: the first sentence of its first line ("Did 2
 * tasks: …", "\"Style the page\" needs your decision (Inbox).", "Stopped by you.") and the rest
 * of the lines. The title says the first, the body only the rest: a body never repeats its
 * title (phase E #89: a one-line result was the title and then the body again).
 */
function splitResult(lines: readonly string[]): { first: string; rest: string } {
  const head = lines[0] ?? "";
  // A sentence ends at ". " outside quotes: a title in quotes may hold a dot ("index.html").
  let end = -1;
  let quoted = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && /[.!?]/.test(ch ?? "") && (i === head.length - 1 || head[i + 1] === " ")) {
      end = i;
      break;
    }
  }
  const first = end < 0 ? head : head.slice(0, end + 1);
  const rest = [head.slice(first.length).trim(), ...lines.slice(1)].filter(Boolean).join(" ");
  return { first, rest };
}

/**
 * What a session's result says first, short, for the title: its first point without the Inbox
 * pointer, which the body says.
 */
function resultGist(first: string): string {
  const g = first.replace(/\s*\(Inbox\)/g, "").replace(/[.\s]+$/, "");
  return /^(Did|Nothing|Stopped|The)\b/.test(g) ? g.charAt(0).toLowerCase() + g.slice(1) : g;
}

/** Stops the person made: Stop now ("you"), Stop all and Quit. */
const PERSON_STOPS = new Set(["you", "stop_all", "quit"]);

/**
 * Whether a session's end is a notification of its own (design §4.3, §5.10, §5.11: the person
 * hears once and is not echoed). A budget stop always is (urgent). The person's own stop is
 * not: Stop now is their click (the session page says "Stopped by you"), and Stop all and Quit
 * have the kill switch's urgent notification. Otherwise only news is: what the result says
 * beyond the open cards (each told when it was filed), more than money, how it ended or what
 * waits. Before, one failed task was told by its card and again by the session end, and Stop
 * now sent "Quote page: stopped by you" back to the person who pressed it.
 */
export function sessionEndIsNews(r: SessionEndFacts): boolean {
  if (isBudgetStopReason(r.stopReason)) return true;
  if (PERSON_STOPS.has(r.stopReason)) return false;
  return (r.news ?? linesOf(r.summary)).some(isNewsLine);
}

/**
 * Session end (spec E.5 "notify human"); a budget stop becomes the urgent `budget_stop`. The
 * title is the project and the result's first point ("Quote page: did 2 tasks: …"); the body the
 * rest of the result and where to look, never the title again. With `news`, what an open card
 * says is left out (the card was told when it was filed); `sessionEndIsNews` says whether to
 * send it at all.
 */
export function sessionEnded(humanId: string, r: SessionEndFacts): Notification {
  if (isBudgetStopReason(r.stopReason)) return budgetStop(humanId, r);
  const lines = r.news ? r.news.map((l) => l.trim()).filter(Boolean) : linesOf(r.summary);
  const { first, rest } = splitResult(lines);
  // "Answer it in the Inbox" only when the words name something the person must answer: with
  // `news`, the cards were told on their own.
  const asks = r.news
    ? lines.some((l) => /\bInbox\b/.test(l))
    : r.needsHuman.length > 0 || (r.failed?.length ?? 0) > 0;
  const gist = resultGist(first) || (r.completed.length ? "session done" : "session ended");
  return {
    kind: "session_ended",
    humanId,
    title: titled(r.projectName, gist),
    body: bodyOf(rest, asks ? "Answer it in the Inbox." : "Open the session for the details."),
    link: `/sessions/${r.sessionId}`,
    projectId: r.projectId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `session:${r.sessionId}:ended`,
  };
}

/** The outer limit's amount, as the budget stop's body says it first ("This month's cap is CHF 0.23."). */
function limitAmount(stopReason: string, capChfMicro: number | undefined): string {
  if (typeof capChfMicro !== "number" || capChfMicro <= 0) return "";
  switch (stopReason) {
    case MONTH_CAP_STOP:
      return `This month's cap is ${formatChf(capChfMicro)}.`;
    case PROJECT_BUDGET_STOP:
      return `The project's budget is ${formatChf(capChfMicro)}.`;
    default:
      return "";
  }
}

/**
 * What helps after a stop at an outer limit (ADR 0112); a larger session budget does not. At the
 * session's own budget a task that paused there has its card (budget-resume): Continue there.
 */
function goOnAfter(stopReason: string, paused = false): string {
  switch (stopReason) {
    case MONTH_CAP_STOP:
      return "Raise the monthly spending cap in Settings to go on.";
    case PROJECT_BUDGET_STOP:
      return "Raise the project budget in Settings to go on.";
    case PLAN_SHARE_STOP:
      return "It can go on once your Claude subscription's usage resets.";
    default:
      return paused
        ? "Continue it from its card in the Inbox."
        : "Start a session with a larger budget to go on.";
  }
}

/**
 * A session hit its cap and stopped with a handoff (scenario 5). The title says the stop and
 * the spend; the body what the result adds (what was done, what is left), never "The session's
 * budget is used" or the money again. A stop at an outer limit (this month's cap, the project's
 * budget, the subscription's share: ADR 0112) names it in the title and what helps in the
 * body, the amounts first (a title has 60 characters): before, it read "stopped, the budget is
 * used" and advised a larger session budget, which the month's cap refuses (review of
 * budget-stop).
 */
export function budgetStop(humanId: string, r: SessionEndFacts): Notification {
  const chf = r.spentChfMicro ?? chfMicroOf(r.spentUsdMicro);
  const limit = stopLimitWords(r.stopReason);
  let text = (r.news ?? linesOf(r.summary))
    .join(" ")
    .replace(/The session's budget is used\.\s*/g, "");
  // The title says the limit: its sentence is not said again.
  if (limit) text = text.split(stopWords(r.stopReason, r.stopCapChfMicro)).join(" ");
  const said = text
    .replace(/\s{2,}/g, " ")
    .replace(/\s*CHF \d+\.\d{2}\.\s*$/, "")
    .trim();
  return {
    kind: "budget_stop",
    humanId,
    title: titled(
      r.projectName,
      limit ? `stopped at ${limit}` : `stopped, the budget is used (${formatChf(chf)} spent)`,
    ),
    body: bodyOf(
      limit
        ? [
            limitAmount(r.stopReason, r.stopCapChfMicro),
            `The session spent ${formatChf(chf)}.`,
            said,
          ]
            .filter(Boolean)
            .join(" ")
        : said,
      goOnAfter(r.stopReason, (r.paused?.length ?? 0) > 0),
    ),
    link: `/sessions/${r.sessionId}`,
    projectId: r.projectId ?? undefined,
    sessionId: r.sessionId,
    dedupeKey: `session:${r.sessionId}:budget`,
  };
}

/** What a verdict did, as a title says it. */
function verdictTitle(verdict: string, task: string): string {
  switch (verdict) {
    case "accept":
      return `the critic accepted ${task}`;
    case "revise":
      return `the critic sent ${task} back`;
    case "escalate":
      return `${task} goes to a stronger model`;
    case "human":
      return `${task} needs your decision`;
    default:
      return `the critic reviewed ${task}`;
  }
}

/** Critic verdict; `escalate` and `human` are raised to normal so they do not wait for the digest. */
export function criticVerdict(
  humanId: string,
  review: Pick<ReviewRow, "id" | "verdict" | "grade" | "task_id" | "session_id" | "summary">,
  projectId?: string | null,
  names: RequestNames = {},
): Notification {
  const needsAttention = review.verdict === "escalate" || review.verdict === "human";
  const task = names.taskTitle ? `"${cut(names.taskTitle, 40)}"` : "a task";
  const said = plain(review.summary).replace(/^(sent back for rework|accepted)\s*:\s*/i, "");
  return {
    kind: "critic_verdict",
    humanId,
    title: titled(names.projectName, verdictTitle(review.verdict, task)),
    body: bodyOf(
      said || null,
      review.verdict === "human" ? "Answer it in the Inbox." : "Open Reviews for the details.",
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
 * reach; the quoted passages stay in the session log the link opens). One line within the
 * body's 140 characters (design §5.1): the origin is shortened first (to its host), then the
 * rule list ("and 2 more"); the count and the first rules stay. The source is the title's.
 * Before (phase E #80): "Content from … (web_page) contained 3 instruction-like passage(s).
 * They were ignored:" and one line per rule and the score, up to 1000 characters.
 */
export function summarizeInjection(report: InjectionReport, origin?: string): string {
  const total = report.matches.length;
  const counts = new Map<string, number>();
  for (const m of report.matches) counts.set(m.rule, (counts.get(m.rule) ?? 0) + 1);
  // The rules that fired most first; a count only where a rule fired more than once.
  const rules = [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([rule, n]) => (n > 1 ? `${rule} (${n})` : rule));
  const action = "Open the session to read them.";
  const build = (from: string | undefined, shown: number) => {
    const listed = shown
      ? `${rules.slice(0, shown).join(", ")}${rules.length > shown ? ` and ${rules.length - shown} more` : ""}`
      : `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
    return `Ignored ${total} ${total === 1 ? "passage" : "passages"}${from ? ` from ${from}` : ""} (${listed}). ${action}`;
  };
  const whole = build(origin, rules.length);
  if (whole.length <= NOTIFICATION_BODY_MAX) return whole;
  const host = origin ? /^[a-z][\w+.-]*:\/\/([^/?#]+)/i.exec(origin)?.[1] : undefined;
  const short = host ?? (origin ? cut(origin, 40) : undefined);
  for (let shown = rules.length; shown >= 0; shown--) {
    const text = build(short, shown);
    if (text.length <= NOTIFICATION_BODY_MAX) return text;
  }
  return cut(build(undefined, 0), NOTIFICATION_BODY_MAX);
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
    body: summarizeInjection(report, opts.origin),
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

/** A message's type as a title says it ("Bob asks you something"). */
const MESSAGE_WORDS: Record<string, string> = {
  question: "asks you something",
  request: "asks you to do something",
  warning: "warns you",
  info: "sent you a note",
  ack: "replied",
};

/** A message from an agent to the human (spec F); questions, requests and acks are normal. */
export function peerMessage(humanId: string, m: MessageRow, fromName?: string): Notification {
  const attention =
    m.requires_ack || m.type === "question" || m.type === "request" || m.type === "warning";
  return {
    kind: "peer_message",
    humanId,
    // A name, never the agent's id (U-074); what kind of message it is in words.
    title: cut(`${fromName ?? "Another agent"} ${MESSAGE_WORDS[m.type] ?? "sent you a note"}`, 60),
    body: cut(plain(m.body), NOTIFICATION_BODY_MAX),
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
export function killSwitch(
  humanId: string,
  report: KillReport,
  _reason: string,
  by?: string,
): Notification {
  const sessionId = report.scope !== "all" ? report.scope.sessionId : undefined;
  // Whose stop it was (design §4.9): Stop all, Quit, a stop from the phone or the chat.
  const title =
    by === "quit"
      ? "Forerunner was closed: its work stopped"
      : report.scope === "all" || by === "stop_all"
        ? "Stop all: every session stopped"
        : report.scope.sessionId
          ? "A session was stopped"
          : "Your agent's work was stopped";
  const runs = report.stoppedRuns === 1 ? "1 run" : `${report.stoppedRuns} runs`;
  const next =
    by === "quit"
      ? "The next start goes on where it stopped."
      : report.scope === "all" || by === "stop_all"
        ? "No session starts until you allow it again."
        : "Its task is ready again.";
  return {
    kind: "kill_switch",
    humanId,
    title,
    body: cut(`${runs} stopped. ${next}`, NOTIFICATION_BODY_MAX),
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

/** What `prMerged` says: the merge record's pull request and its task, by name. */
export interface PrMergedFacts {
  projectId: string | null;
  projectName: string | null;
  taskTitle: string;
  prNumber: number;
  /** The merge record's id: one notification per merge. */
  recordId: string;
}

/**
 * leftovers7-merge2: a merge the app made by itself, as its Inbox Update says it (the retry pass
 * once the checks passed or what it builds on merged, the resume at the daemon's start): "Quote
 * page: merged #4", '"Add the page" is merged. Open the project to see it.' A session's merge is
 * in its session's notification; the person's own click is answered where it was pressed.
 */
export function prMerged(humanId: string, f: PrMergedFacts): Notification {
  return {
    kind: "pr_merged",
    humanId,
    title: titled(f.projectName, `merged #${f.prNumber}`),
    body: bodyOf(`"${f.taskTitle}" is merged.`, "Open the project to see it."),
    link: f.projectId ? `/projects/${f.projectId}` : "/inbox",
    ...(f.projectId ? { projectId: f.projectId } : {}),
    dedupeKey: `pr-merged:${f.recordId}:${f.prNumber}`,
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
    requestOpened: (req: HumanRequestRow, humanId: string, names?: RequestNames) =>
      notifier.notify(requestOpened(req, humanId, names)),
    sessionEnded: (humanId: string, r: SessionEndFacts) =>
      notifier.notify(sessionEnded(humanId, r)),
    budgetStop: (humanId: string, r: SessionEndFacts) => notifier.notify(budgetStop(humanId, r)),
    criticVerdict: (
      humanId: string,
      review: Parameters<typeof criticVerdict>[1],
      projectId?: string | null,
      names?: RequestNames,
    ) => notifier.notify(criticVerdict(humanId, review, projectId, names)),
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
    killSwitch: (humanId: string, report: KillReport, reason: string, by?: string) =>
      notifier.notify(killSwitch(humanId, report, reason, by)),
    criticCalibration: (humanId: string, f: CalibrationFacts) =>
      notifier.notify(criticCalibration(humanId, f)),
    handoverReport: (humanId: string, f: HandoverFacts) =>
      notifier.notify(handoverReport(humanId, f)),
    prMerged: (humanId: string, f: PrMergedFacts) => notifier.notify(prMerged(humanId, f)),
  };
}

export type ProducerHooks = ReturnType<typeof bindProducers>;
