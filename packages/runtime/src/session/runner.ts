import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  log,
  newId,
} from "@forerunner/platform";
import {
  type AgentRow,
  type JsonObject,
  SESSION_TRANSITIONS,
  type SessionRow,
  type StateStore,
  type TaskRow,
  type WaitingTask,
} from "@forerunner/state";
import type { ContextManager, ContextSessionEnd } from "../context/manager.ts";
import { couldNotWords } from "../daemon/event-lines.ts";
import { holdsTask, isPausedByPerson } from "../daemon/task-words.ts";
import type { AutonomyLevel } from "../enforcement/autonomy.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import type { KillSwitch } from "../enforcement/killswitch.ts";
import type { SignedToken, TokenIssuer } from "../enforcement/token.ts";
import { type EstimatePort, planEstimateUsdMicro, withinTaskBudget } from "../estimates/model.ts";
import {
  type CriticPort,
  DEFAULT_MEMORY_TOKEN_BUDGET,
  type LessonCandidate,
  MAX_PROMOTION_REVIEWS_PER_SESSION,
  type MemoryPort,
  type MemoryRecallResult,
  type MergeOutcome,
  type MergePort,
  type MergeRequest,
  memoryBudgetOf,
  type ProjectDocsPort,
  type PromotionCandidate,
  type PromotionReviewOutcome,
  type SessionReviewOutcome,
  type SessionStatusOutcome,
  type TaskReviewOutcome,
} from "../loop/ports.ts";
import { isSandboxNotReady } from "../sandbox/readiness.ts";
import type { SchemaSyncPort } from "../update/sync.ts";
import { decisionSentence, plainRows } from "../wiring/state-ports.ts";
import { BILLING_FALLBACK_EVENT } from "./billing.ts";
import { renderStateBrief, type StateBrief } from "./brief.ts";
import {
  BUDGET_STOP_KEY,
  budgetCardSource,
  budgetStopTitle,
  fileBudgetStopCard,
} from "./budget-card.ts";
import {
  type BudgetStopSource,
  limitWords,
  type RunHandoff,
  stopEndsSession,
} from "./budget-pause.ts";
import { fileCannotRunCard, plainStopReason } from "./cannot-run-card.ts";
import { type ChecklistInput, carriedFromLastEnd, runStartupChecklist } from "./checklist.ts";
import { CREDENTIAL_WAIT_STOP, type CredentialWait, waitSentence } from "./credential-wait.ts";
import {
  fileBlockedByFindingsRequest,
  fileFailedTaskCard,
  fileReviewFailedRequest,
} from "./findings.ts";
import { describeRejectedLessons, type RejectedLesson, screenLessons } from "./lessons.ts";
import { type HeardDelivery, type HeardLine, heardLineOf } from "./live-chat.ts";
import {
  firstSessionPlan,
  isFirstSessionItem,
  markFirstSessionRun,
  notesForTask,
  type QueueNote,
} from "./next-session.ts";
import {
  buildPeerFeed,
  detectOverlap,
  extractPathHints,
  overlapBlocks,
  overlapMessage,
  renderPeerFeed,
  TASK_FILES_EVENT,
} from "./peers.ts";
import {
  PLAN_APPROVAL_OPTIONS,
  parsePlanId,
  planApprovalOf,
  planIdOf,
  planKeyOf,
} from "./plan-approval.ts";
import { namesOf } from "./recovery.ts";
import {
  closeFinishedWork,
  collectEndState,
  type LastSessionOutcome,
  MERGE_WAITS,
  type NamedTask,
  sessionResultLines,
  sessionUpdateLine,
  waitingOf,
} from "./result.ts";
import {
  needsContainerSandbox,
  type SandboxGate,
  type SandboxGateAnswer,
  type SandboxWaitingTask,
  summarizeSandboxWaiting,
} from "./sandbox-gate.ts";
import {
  budgetStopReasonOf,
  type PersonStop,
  personStopOf,
  stopLimitWords,
  taskReasonForStop,
} from "./stop-words.ts";
import type { WebSource } from "./web-sources.ts";

/**
 * One working period of a principal agent (spec E). Code owns the skeleton: checklist, plan
 * within budget, claim-before-work, inbox re-checks between tasks and before writes, handoff
 * and summary at the end. The model decides *what* inside each step through the Planner and
 * the TaskExecutor; both are ports so tests run with fakes.
 */
export type SessionTriggerKind =
  | "manual"
  | "schedule"
  | "message"
  | "ci"
  | "pr_comment"
  | "email"
  | "budget_reset"
  | "remote";

/**
 * Audit row written once per session for the next-session queue items its brief carried
 * (spec J.2): the session and the item ids consumed and skipped, never the text.
 */
export const QUEUE_CONSUMED_AUDIT_TOOL = "queue.consumed";

/** Store errors that mean one queue item moved since the brief was built; the rest propagate. */
const QUEUE_SKIP_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "validation",
  "version_conflict",
]);

/** Message types that are acted on by reading them into the plan; the rest need a reply. */
const ACK_BY_READING: ReadonlySet<string> = new Set(["handoff", "info", "warning", "decision"]);

/** A message whose body starts with a stop word stops the session (never a handoff). */
const STOP_WORD_RE = /^\s*(stop|halt|pause)\b/i;

/** One message an inbox re-check read: a stop, a pause or anything else. */
interface InboxRead {
  id: string;
  type: string;
  from: string | null;
  kind: "stop" | "pause" | "message";
}

/** What an inbox re-check read, and the first stop or pause among it (null: none). */
interface InboxRecheck {
  read: InboxRead[];
  interrupt: InboxRead | null;
}

export interface PlanItem {
  taskId: string;
  title: string;
  specialist: string;
  estimateUsdMicro: number;
  rationale?: string;
}

export interface SessionPlan {
  items: PlanItem[];
  estimateUsdMicro: number;
  summary: string;
  /** Planned items that did not fit the work budget (`cutPlanToBudget`, U-040), in order. */
  leftOutForBudget?: PlanItem[];
  /** The work budget the plan was cut to, set with `leftOutForBudget`. */
  workBudgetUsdMicro?: number;
}

export interface PlannerContext {
  brief: StateBrief;
  briefText: string;
  readyTasks: TaskRow[];
  budgetUsdMicro: number;
  reserveShare: number;
  session: SessionRow;
  token: SignedToken;
  budget: SessionBudget;
}

export interface Planner {
  plan(ctx: PlannerContext): Promise<SessionPlan>;
}

export interface TaskExecutionResult {
  /**
   * The specialist that ran (U-044): the one the executor handed the task to when it differs
   * from the plan item's (a web routing). `task.finished` names it. Absent: the item's.
   */
  specialist?: string;
  outcome:
    | "done"
    | "in_review"
    | "failed"
    | "needs_human"
    | "budget_exceeded"
    | "timeout"
    | "killed"
    /**
     * A Claude credential stopped the run or kept it from starting (U-078, ADR 0100 amended):
     * its usage limit, a refusal (a 401 or 403 key, an expired sign-in), or no credential that
     * may serve it can now. The runner puts the task back to ready (its claim released, no
     * attempt counted, never retried as a passing error); with `credentialWait` the session ends
     * on that wait, else the task goes on at once on the credential that takes over. `summary`
     * is the session log's sentence.
     */
    | "usage_limit"
    /**
     * The run paused at a budget (ADR 0112): it stopped at one of any level, or it heard the
     * wrap-up and listed work left. No critic reviews it and no try is counted; `budgetStop`
     * names the limit and `handoff` what it left. The runner files today's budget card.
     */
    | "paused";
  summary: string;
  costUsdMicro: number;
  /**
   * `usage_limit` only (U-078): no credential that may serve the task can now, so it waits for
   * this one (its reset, or a new credential); the session ends with the wait's sentence.
   */
  credentialWait?: CredentialWait;
  /**
   * The error's stable code when the run ended on one (the driver's `error.code`, or the code of
   * the exception the executor threw): the runner tries a transient one again at once.
   */
  errorCode?: string;
  prUrl?: string;
  branch?: string;
  /** Files the task changed (relative to the worktree root), for peer overlap detection. */
  changedFiles?: string[];
  artifacts?: unknown[];
  /** True when automated checks (tier 0) passed, so the task may close without a critic review. */
  checksPassed?: boolean;
  /** The Run row that produced the work; the critic resolves findings against it. */
  runId?: string;
  /** The worktree the task ran in, for the critic's diff and checks. */
  worktree?: string;
  /** The specialist's final report, in full; the critic reads it as claims. */
  finalReport?: string;
  /** Lessons the specialist spelled out ("Lesson: ..."), recorded at session end. */
  lessons?: LessonCandidate[];
  /**
   * Set on a `paused` result (ADR 0112; before, a `needs_human` one at the task's own cap,
   * U-042): the limit the run paused at. The runner files the budget card
   * (`session/budget-card.ts`: Raise the budget, Cancel task; live walk 2, B2).
   */
  budgetStop?: BudgetStop;
  /** A paused run's "Where I stopped:" and "Left to do:" (ADR 0112), data only. */
  handoff?: RunHandoff;
  /** The web pages the run read (ADR 0107); the critic checks cited claims against them. */
  webSources?: WebSource[];
}

/** Where a run paused at a budget, in micro-USD (`TaskExecutionResult.budgetStop`). */
export interface BudgetStop {
  /**
   * The cap it stopped at: the task's budget, the specialist's limit per run, the session's
   * budget, the project's budget or the month's cap (for the subscription's share: the run's cap).
   */
  capUsdMicro: number;
  /** What the task has spent in all its runs, this one included. */
  spentUsdMicro: number;
  /** Which limit it was (ADR 0112): the refusal's level, not only where the run's cap came from. */
  source: BudgetStopSource;
  specialist: string;
  /** `wrap_up`: it heard the wrap-up and listed work left; `budget`: a budget refused a call. */
  stoppedBy?: RunHandoff["stoppedBy"];
}

export interface TaskExecutor {
  execute(ctx: {
    task: TaskRow;
    session: SessionRow;
    token: SignedToken;
    budget: SessionBudget;
    item: PlanItem;
    signal: AbortSignal;
    /**
     * What the human said during the session since the last task started (spec O.9): lines
     * the runner collected at this boundary, for the task's brief as quoted data. Each line
     * reaches one task.
     */
    heard?: readonly HeardLine[];
    /**
     * What the person queued for this session that concerns this task (spec J.2, U-038): the
     * brief's queue items that name it, or that name no task. Quoted data in the task's brief.
     */
    notes?: readonly QueueNote[];
    /** The person's note for this session (the Start dialog's), for every task's brief. */
    sessionNote?: string;
    /**
     * Called for every model call and tool result of the task's run (design §4.14): the runner
     * counts the step and the spend on the session row and logs a step line while it runs.
     */
    onStep?: (step: TaskStep) => void;
  }): Promise<TaskExecutionResult>;
  /**
   * A task the person cancelled while it ran or was reviewed (phase C, live walk 2 C1): what
   * its run changed is taken out of the folder it ran in and kept for Undo of the cancel, so
   * the next task never builds on it. Returns the files taken out. Absent: the files stay.
   */
  setAside?(task: TaskRow): Promise<string[]>;
  /**
   * The specialist the next attempt of the task runs with, when it is not the plan item's
   * (U-044): the retry ladder's stand-in after two failed attempts by it, or the registry's name
   * for the plan's. Asked before `task.started` is written, so the log names who runs; `execute`
   * then gets the item with that specialist. Null or absent: the item's.
   */
  chooseSpecialist?(ctx: { task: TaskRow; item: PlanItem }): Promise<string | null>;
}

/**
 * The specialist of the task's latest work run (not the critic's review), from any session:
 * who ran it last, so a hand-over in a later session still says from whom.
 */
async function lastWorkSpecialist(store: StateStore, taskId: string): Promise<string | null> {
  const runs = (await store.run.forTask(taskId)).filter(
    (r) => r.specialist !== "critic" && !r.parent_run_id,
  );
  runs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return runs.at(-1)?.specialist ?? null;
}

/** One step of a task's run, as the executor reports it to the runner (`onStep`). */
export type TaskStep =
  | { kind: "model"; costUsdMicro: number }
  | { kind: "tool"; name: string; input?: unknown; isError: boolean; denied?: boolean }
  /** A line of the run's own (its budget line, its wrap-up, ADR 0112): the log says `text`. */
  | { kind: "note"; text: string };

export interface SessionStartOptions {
  agentId: string;
  projectId?: string;
  trigger: SessionTriggerKind;
  budgetCapUsdMicro: number;
  stepCap?: number;
  wallClockMs?: number;
  reserveShare?: number;
  /** Autonomy level for this session; defaults to the project's. */
  autonomy?: AutonomyLevel;
  /**
   * The person's note for this session (the Start dialog's "Note for this session"): it reaches
   * every task's brief (design §4.6) and is kept on the session's handoff. Before, the typed
   * Reason was thrown away.
   */
  note?: string;
  /**
   * The plan the human approved (spec J.6, J.7; ADR 0053): the `plan_id` of the answered plan
   * request (`plan:<session>#<hash>`), which runs the plan only while the plan computed now is
   * that plan (same task ids in the same order), else the changed plan is filed again and
   * nothing runs. `true` approves whatever is planned and is for callers that are the approver
   * themselves (the scenario harness); the daemon and the cloud runner pass the bound id.
   */
  planApproved?: boolean | string;
  appVersion?: string;
  runner?: "pc" | "cloud";
  deviceId?: string;
  claimTtlMs?: number;
  /** Tools, paths, domains and secrets the principal may use. */
  grant: {
    allowedTools: string[];
    allowedPaths: string[];
    allowedDomains: string[];
    grantedSecrets: string[];
    maxDepth?: number;
  };
  checklist?: Partial<Pick<ChecklistInput, "git" | "sync" | "repoDirs" | "planUsageShare">>;
  /** Called for every session event (live view). */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /**
   * Token budget for the lessons loaded into the brief. The project's
   * `settings.memory_token_budget` wins; then this; then the default (ADR 0036).
   */
  memoryTokenBudget?: number;
}

/** One task's critic review as the session saw it. */
export interface SessionReviewRecord {
  taskId: string;
  reviewId: string | null;
  tier: number;
  verdict: string;
  grade: number;
  decision: TaskReviewOutcome["decision"];
  retry?: TaskReviewOutcome["retry"];
  attempt: number;
}

export interface SessionResult {
  sessionId: string;
  status: SessionRow["status"];
  brief: StateBrief;
  plan: SessionPlan | null;
  completed: string[];
  inReview: string[];
  failed: string[];
  /**
   * Tasks planned and not started, each once; a task sent back by the critic whose rework was
   * still queued is in `retried` only (U-072). The handoff's `next` keeps both.
   */
  skipped: string[];
  needsHuman: string[];
  /** Tasks a person cancelled while they ran (U-039). */
  cancelled: string[];
  /**
   * Tasks moved while their run was going (U-039): Cancel, Mark failed, Needs me or Send to
   * review on the Tasks tab, the phone or Chat. Each is also counted in the list of the state
   * it was moved to (`cancelled`, `failed`, `needsHuman`, `inReview`).
   */
  movedWhileRunning: MovedWhileRunning[];
  /**
   * Tasks whose critic review failed (an error, not a verdict): each waits in review (also in
   * `inReview`) with a card in the Inbox whose options act (U-045).
   */
  reviewFailed: string[];
  /** Tasks the critic sent back to ready (revise or a retry rung). */
  retried: string[];
  /** Tasks whose close was refused because a finding is still open (B.4). */
  blockedByFindings: string[];
  reviews: SessionReviewRecord[];
  /** What became of each accepted task's pull request (spec J.9): merged or left open, and why. */
  merges: MergeOutcome[];
  /** The lessons block loaded at start, or null without a memory port. */
  memory: { tokens: number; budget: number; lessons: number } | null;
  lessonsRecorded: number;
  /** Shared-store proposals the critic decided at the end (spec G.6); null when not wired. */
  promotions: PromotionTally | null;
  sessionReview: SessionReviewOutcome | null;
  spentUsdMicro: number;
  /** The spend in CHF as the cost ledger converted it (what a person reads, U-074). */
  spentChfMicro?: number;
  steps: number;
  summary: string;
  /**
   * The result's lines without what an open Inbox card already says (`sessionResultLines(f,
   * told)`): what the Update and the session-end notification carry, so the person hears each
   * thing once (design §4.3, §5.10). Empty or only money and stops: nothing to tell.
   */
  news: string[];
  handoff: Record<string, unknown>;
  stopReason: string;
  /**
   * The amount of the outer limit a task's pause ended the session at (this month's cap, the
   * project's budget: ADR 0112), in CHF; the budget-stop notification names it.
   */
  stopCapChfMicro?: number;
  /** What the human said during the session and the task each line reached (spec O.9). */
  heard: HeardDelivery[];
}

export interface PromotionTally {
  reviewed: number;
  promoted: number;
  rejected: number;
  pending: number;
  /** Offers filed for other projects of the same human. */
  offered: number;
}

/** What the runner reports when a task's execution ends (estimate-versus-actual learning, spec I). */
export interface TaskFinishedInfo {
  sessionId: string;
  task: TaskRow;
  item: PlanItem;
  result: TaskExecutionResult;
  /** Wall time of the executor call. */
  durationMs: number;
}

export interface SessionRunnerDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  kill: KillSwitch;
  planner: Planner;
  executor: TaskExecutor;
  /** Peer agents to hand off to; default: other principal agents on the project's humans. */
  peersOf?: (agentId: string, projectId: string | undefined) => Promise<string[]>;
  /** Called after every `task.finished` event; failures are logged, never fatal. */
  onTaskFinished?: (info: TaskFinishedInfo) => void | Promise<void>;
  /**
   * The day's CHF per USD for amounts a person reads before they are spent (the plan's
   * estimates on its approval card, U-074); `DEFAULT_CHF_PER_USD` without it. Spent amounts
   * come from the cost ledger's own CHF.
   */
  chfPerUsd?: () => number;
  /**
   * Called once the plan is written (`session.planned`); failures are logged, never fatal. The
   * daemon proposes a repository here for a project without one whose plan holds code work
   * (U-037, `loop/repo-create.ts`).
   */
  onPlanned?: (info: {
    sessionId: string;
    projectId: string | null;
    plan: SessionPlan;
  }) => void | Promise<void>;
  /**
   * Context layer (ADR 0003): probes Headroom at session start when the project asks for it and
   * turns the proxy's counter delta into `session.headroom_saved_tokens` at the end.
   */
  context?: ContextManager;
  /**
   * The critic (spec H, ADR 0104): reviews every task after its run (tier 0 as the light
   * review) and the session at its end. Without it (an engine test world) tasks stay in review
   * for a later reviewer and tier 0 closes on its run.
   */
  critic?: CriticPort;
  /** Session review tier (H.6). Default 0: the deterministic checks, no model call. */
  sessionReviewTier?: 0 | 1 | 2 | 3;
  /**
   * Memory (spec G): lessons into the brief at start under the budget, lessons recorded at
   * the end. Without it the session runs without lessons.
   */
  memory?: MemoryPort;
  /** Default retrieval budget when neither the project nor the start options set one. */
  memoryTokenBudget?: number;
  /**
   * Project docs (spec G.5): the session's status update written into `docs/status.md` at
   * its end, on the session's pull request or one of its own. Without it the critic's drift
   * check is the only reminder.
   */
  docs?: ProjectDocsPort;
  /**
   * The merge of a reviewed pull request (spec J.9, ADR 0062): after an accepting review the
   * task's PR goes through the `merge_pr` tool behind the hooks; level 3 merges, below it the
   * hooks refuse and the PR stays open for the human. Without it every PR stays open.
   */
  merge?: MergePort;
  /**
   * The schema sync gate (spec M): a session is refused before its row exists while sync is
   * paused, and the peer feed (start and before every task) re-evaluates and is refused too.
   */
  schemaSync?: SchemaSyncPort;
  /**
   * U-079: whether tasks at risk tier 2+ can run now (the container sandbox is ready). Asked
   * before every plan; while it is not, those tasks are left out of the plan and named in the
   * summary, and their attempt count does not change. Absent: every ready task is planned.
   */
  sandboxGate?: SandboxGate;
  /**
   * How often the runner re-reads a running task's row (U-039), default
   * `DEFAULT_TASK_WATCH_MS`: a person's move made where no route of this process sees it (the
   * phone through the state service, Chat) stops the task's run within this time. The daemon's
   * own transition route stops it at once (`KillSwitch.stopTask`).
   */
  taskWatchMs?: number;
}

/** Share of a session's cap kept for reviews; the plan is cut to the rest (`cutPlanToBudget`). */
export const DEFAULT_RESERVE_SHARE = 0.2;

/** A string field of a tool call's input, when it has one. */
function inputField(input: unknown, ...keys: string[]): string {
  if (!input || typeof input !== "object") return "";
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return "";
}

/** A web address as a step line names it: the host and the path, no scheme, query or fragment. */
function webPageName(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * One tool step in the person's words (design §3.7: "read index.html", "wrote styles.css",
 * "ran node --check: ok"); one short line, never the tool's output.
 */
export function stepLine(step: Extract<TaskStep, { kind: "tool" }>): string {
  const name = step.name.replace(/^cc:/, "").toLowerCase();
  const raw = inputField(step.input, "path", "file_path", "file");
  const path = raw === "." || raw === "./" ? "" : raw;
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  if (step.denied) return `was not allowed to use ${name.replace(/_/g, " ")}`;
  const failed = step.isError ? " (failed)" : "";
  if (/^(read_file|read)$/.test(name)) return `read ${cut(path || "a file")}${failed}`;
  if (/^(write_file|write|edit|multiedit)$/.test(name))
    return `wrote ${cut(path || "a file")}${failed}`;
  if (/^(list_dir|ls|glob)$/.test(name)) return `looked at ${cut(path || "the folder")}${failed}`;
  if (/^(run_command|bash)$/.test(name)) {
    const cmd = inputField(step.input, "command", "argv", "cmd");
    return `ran ${cut(cmd || "a command")}: ${step.isError ? "failed" : "ok"}`;
  }
  if (name === "ask_person") return "asked you a question (Inbox)";
  if (name === "web_fetch" || name === "webfetch") {
    const url = inputField(step.input, "url");
    return url ? `read the web page ${cut(webPageName(url))}${failed}` : `read a web page${failed}`;
  }
  return `used ${name.replace(/_/g, " ")}${failed}`;
}

/** Error codes of a run that may well pass when tried again at once (design §4.4). */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "provider_error",
  "network",
  "rate_limited",
  "overloaded",
  "overloaded_error",
]);

/**
 * How often one task may move on to the next credential in a session after its credential
 * stopped it (U-078): one per credential a person can have, so a task never goes round them.
 */
const MAX_CREDENTIAL_MOVES = 3;

/** Whether a run's error is transient (the model call failed, the network, a rate limit). */
export function isTransientError(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT_ERROR_CODES.has(code);
}

/** The stop reason of a session that found nothing it could run (design §4.8). */
export const NOTHING_RUNNABLE = "nothing_runnable";

/**
 * Runs of one task in one session at most (design §4.3: retries happen inside the session, up
 * to the retry limit). The critic's ladder hands a task to the person after its fourth failed
 * attempt; this only stops a task that keeps coming back for another reason.
 */
export const MAX_RUNS_PER_TASK_IN_SESSION = 6;

/** The runner's re-read of a running task's row (U-039): a person's move stops the run within it. */
export const DEFAULT_TASK_WATCH_MS = 5_000;

/** A critic review that failed with an error, not a verdict (U-045). */
interface ReviewFailure {
  failed: true;
  error: string;
}

/** A task moved while its run was going (U-039): the state set then, which stands. */
export interface MovedWhileRunning {
  taskId: string;
  title: string;
  status: TaskRow["status"];
  /** True when a person made the move (`author_human` on the row); false for another agent's. */
  byPerson: boolean;
}

/**
 * What the human reads when the critic declined a proposal (spec G.6, ADR 0059): the review's
 * verdict, grade and summary, the lesson (the shared proposal's text, as data), where it stays
 * and how to try again. The proposal is gone from the memory page, so this is the one place
 * the reason reaches the human.
 */
export function describeRejectedPromotion(
  lesson: Pick<PromotionCandidate, "text" | "originScope" | "originProjectId">,
  review: Pick<PromotionReviewOutcome, "verdict" | "grade" | "summary">,
): string {
  const where = lesson.originScope
    ? `${lesson.originScope} memory${lesson.originProjectId ? ` of project ${lesson.originProjectId}` : ""}`
    : "its memory";
  const summary = review.summary.trim() || "(no summary)";
  return [
    `The critic did not share a lesson across projects (verdict ${review.verdict}, grade ${review.grade}): ${summary}`,
    `Lesson: "${lesson.text.slice(0, 300)}"`,
    `It stays in ${where}. Edit it on the Memory page and share it again when it holds beyond its project.`,
  ].join("\n");
}

/** Lines a specialist's final report spells out as lessons. */
const LESSON_LINE = /^\s*(?:[-*]\s*)?lesson\s*:\s*(.+?)\s*$/i;

/** "Lesson: ..." lines of a report, each a candidate for private memory (20 to 2000 chars). */
export function lessonsFromReport(
  text: string | undefined,
  tags: string[] = [],
): LessonCandidate[] {
  if (!text) return [];
  const out: LessonCandidate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LESSON_LINE.exec(line);
    if (!m?.[1]) continue;
    const body = m[1].trim();
    if (body.length < 20 || body.length > 2000) continue;
    out.push({ text: body, tags: ["session", ...tags], confidence: 0.5 });
  }
  return out;
}

export class SessionRunner {
  private readonly logger = log("session");

  constructor(private readonly deps: SessionRunnerDeps) {}

  async start(opts: SessionStartOptions): Promise<SessionResult> {
    const { store, clock } = this.deps;
    const agent = await store.agent.mustGet(opts.agentId);
    const project = opts.projectId ? await store.project.mustGet(opts.projectId) : null;
    const autonomy = (opts.autonomy ??
      (project?.autonomy_level as AutonomyLevel | undefined) ??
      2) as AutonomyLevel;
    const stepCap = opts.stepCap ?? 200;
    const wallClockMs = opts.wallClockMs ?? 4 * 60 * 60 * 1000;
    const reserveShare = opts.reserveShare ?? DEFAULT_RESERVE_SHARE;
    const claimTtlMs = opts.claimTtlMs ?? 30 * 60 * 1000;

    if (this.deps.kill.isFrozen({ agentId: agent.id })) {
      throw new ForerunnerError("killed", "kill switch is active for this agent; resume it first");
    }
    // Spec M: nothing syncs while the schema versions differ; a session is a sync.
    await this.deps.schemaSync?.assertCanSync("session.start");
    // One session per agent (spec E). Said in words, never with the other session's id (design
    // §4.10); a session a dead process left is ended at the next daemon start
    // (`recoverInterruptedSessions`) and by Stop on its page, so this is a session that runs.
    const active = await store.session.active(agent.id);
    if (active.length > 0) {
      throw new ForerunnerError(
        "claim_conflict",
        `${agent.name} is already working in another session, so this one did not start. It can start once that session ends.`,
        { details: { sessionId: active[0]?.id } },
      );
    }

    let session = await store.session.insert({
      agent_id: agent.id,
      project_id: project?.id ?? null,
      trigger: opts.trigger,
      plan: {},
      budget_cap_usd_micro: opts.budgetCapUsdMicro,
      step_cap: stepCap,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "planned",
      summary: "",
      handoff: {},
      runner: opts.runner ?? "pc",
      device_id: opts.deviceId ?? null,
      author_agent: agent.id,
    });
    session = await store.session.start(session.id, session.version);
    const emit = async (type: string, payload: Record<string, unknown> = {}, cost = 0) => {
      await store.event.append(session.id, type, payload as never, cost);
      opts.onEvent?.(type, payload);
    };
    await emit("session.started", {
      trigger: opts.trigger,
      budgetCapUsdMicro: opts.budgetCapUsdMicro,
      stepCap,
      autonomy,
    });
    // Context layer: resolve the project's compression policy now; when it asked for Headroom
    // and the proxy is not usable, say so once per session (never silently native).
    const sessionContext = await this.deps.context?.forSession(session.id, project?.id);
    if (sessionContext?.selection.notice) {
      await emit("context.headroom_unavailable", {
        warning: sessionContext.selection.notice,
        status: sessionContext.selection.headroom?.status ?? "disabled",
        policy: sessionContext.selection.policy,
        mode: sessionContext.selection.mode,
      });
    }

    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: opts.budgetCapUsdMicro,
      stepCap,
      deadlineMs: clock.now() + wallClockMs,
      reserveShare,
    });
    const controller = new AbortController();
    const unregister = this.deps.kill.register({
      agentId: agent.id,
      sessionId: session.id,
      controller,
      label: `session ${session.id}`,
    });
    // The token's `planApproved` claim is what the hooks read (level 1 frees routine actions
    // on it). A bound id is verified against the plan computed below; until then the claim is
    // false, and the token is re-issued once the plan is known to be the approved one.
    const runId = newId(clock.now());
    const issueToken = (planApproved: boolean) =>
      this.deps.tokens.issue({
        runId,
        sessionId: session.id,
        agentId: agent.id,
        ownerHumanId: agent.owner_human_id,
        projectId: project?.id,
        allowedTools: opts.grant.allowedTools,
        allowedPaths: opts.grant.allowedPaths,
        allowedDomains: opts.grant.allowedDomains,
        grantedSecrets: opts.grant.grantedSecrets,
        budgetUsdMicro: opts.budgetCapUsdMicro,
        depth: 0,
        maxDepth: opts.grant.maxDepth ?? 2,
        autonomy,
        planApproved,
        expiresAt: new Date(clock.now() + wallClockMs).toISOString(),
      });
    let token = issueToken(opts.planApproved === true);

    const completed: string[] = [];
    const inReview: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const retried: string[] = [];
    const blockedByFindings: string[] = [];
    const reviews: SessionReviewRecord[] = [];
    const merges: MergeOutcome[] = [];
    /** What the human said during the session (spec O.9), collected between tasks. */
    const heard: HeardDelivery[] = [];
    /**
     * The startup receipts ran: the brief's inbox, including what the last session read at its
     * end (spec E.4), was taken in. A session that ends before that passes the carry on.
     */
    let inboxTakenIn = false;
    const lessonCandidates: LessonCandidate[] = [];
    /** Lesson proposals the critic port refused as instruction-shaped (quoted to the human). */
    const quarantinedByCritic: RejectedLesson[] = [];
    const resolvedFindingTitles: string[] = [];
    let memoryLoaded: MemoryRecallResult | null = null;
    const memoryBudget = memoryBudgetOf(
      project?.settings,
      undefined,
      opts.memoryTokenBudget ?? this.deps.memoryTokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    );
    const filesByTask = new Map<string, string[]>();
    const overlapNotified = new Set<string>();
    let peerIds: string[] = [];
    const needsHuman: string[] = [];
    const cancelled: string[] = [];
    const movedWhileRunning: MovedWhileRunning[] = [];
    /** Tasks whose critic review failed; each has a card in the Inbox (U-045). */
    const reviewFailed: string[] = [];
    /** Ready tasks that wait on a task not done (U-040), named in the summary. */
    let waiting: WaitingTask[] = [];
    /** Ready tasks at tier 2+ that wait for the container sandbox (U-079). */
    const waitingForSandbox: SandboxWaitingTask[] = [];
    let sandboxAnswer: SandboxGateAnswer | null = null;
    /** The Claude credential the session's work waits for, when it ended on one (U-078). */
    let credentialWait: CredentialWait | null = null;
    let plan: SessionPlan | null = null;
    let brief: StateBrief | null = null;
    let stopReason = "completed";
    /** The amount of the outer limit a task's pause ended the session at (ADR 0112), if any. */
    let stopCapUsdMicro: number | null = null;
    let status: SessionRow["status"] = "completed";
    /** The queue items each task's brief carried (design §4.7: used up by finished work). */
    const notesGiven = new Map<string, string[]>();
    /** Who stopped the session from outside its run (Stop now, Stop all, Quit), if anyone. */
    let personStop: PersonStop | null = null;
    /** The task whose run is going now, for the stop line. */
    let runningTask: { id: string; title: string } | null = null;
    const heldClaims = new Set<string>();

    // Some transitions (in_review, done) clear the claim themselves; release only what we still hold.
    const releaseIfHeld = async (taskId: string, reason: string) => {
      heldClaims.delete(taskId);
      const t = await store.task.get(taskId);
      if (t?.claimed_by === agent.id) await store.task.releaseClaim(taskId, agent.id, reason);
    };
    const releaseAll = async (reason: string) => {
      for (const id of [...heldClaims]) {
        try {
          await releaseIfHeld(id, reason);
        } catch (e) {
          this.logger.warn("release failed", { taskId: id, error: errorMessage(e) });
        }
      }
      heldClaims.clear();
    };
    /**
     * Whether a person's move of the task stopped this live run or review (`KillSwitch.stopTask`
     * aborts the task's own controller), not the session's own stop: a controller the session
     * aborted carries the session's abort reason.
     */
    const stoppedByMove = (c: AbortController) =>
      c.signal.aborted && c.signal.reason !== controller.signal.reason;
    /**
     * A task someone else moved while this session held it (U-039: during its run; U-045:
     * during its review): the state set stands, it is counted in the list of that state and
     * named, and the session goes on. `stopped`: the move stopped its live run or review
     * (`stoppedByMove`), which is when the cancel's line promised its work is removed.
     */
    const recordMove = async (
      t: TaskRow,
      outcome: string,
      during: "run" | "review",
      stopped: boolean,
    ) => {
      const moved: MovedWhileRunning = {
        taskId: t.id,
        title: t.title,
        status: t.status,
        byPerson: t.author_human !== null,
      };
      movedWhileRunning.push(moved);
      const into: Partial<Record<TaskRow["status"], string[]>> = {
        cancelled,
        failed,
        needs_human: needsHuman,
        in_review: inReview,
        done: completed,
      };
      (into[t.status] ?? skipped).push(t.id);
      // Cancelled while it ran or was reviewed (phase C, live walk 2 C1): what its run changed
      // is taken out of the folder, kept for Undo of the cancel, before the next task starts,
      // so no later task builds on work the person dropped. Only when the cancel stopped the
      // live run or review: then the cancel's line said so (`moveSentence`, from what
      // `stopTask` stopped); a cancel that came between the run's end and its review stopped
      // nothing and said nothing about the files, which stay. A failure here leaves the files
      // where they are and says so in the log; it never ends the session.
      let setAside: string[] | null = null;
      if (t.status === "cancelled" && stopped && this.deps.executor.setAside) {
        try {
          setAside = await this.deps.executor.setAside(t);
        } catch (e) {
          this.logger.warn("the cancelled task's changes were not set aside", {
            taskId: t.id,
            error: errorMessage(e),
          });
        }
      }
      await emit("task.moved_while_running", {
        ...moved,
        during,
        reason: t.reason,
        outcome,
        ...(setAside?.length ? { setAside: setAside.length, files: setAside.slice(0, 20) } : {}),
        warning: `"${t.title}" was moved to ${t.status} while ${
          during === "run" ? "it ran; its run was stopped" : "it was reviewed"
        } and the session goes on`,
      });
      await releaseIfHeld(
        t.id,
        `moved to ${t.status} while it ${during === "run" ? "ran" : "was reviewed"}`,
      );
    };

    try {
      // 0. Lapsed claims (a crashed session's) and claims nobody holds go back to ready
      // first, so the brief and the plan see them (spec §347; U-013).
      const released = await store.task.expireClaims(clock.now());
      if (released.length) {
        await emit("task.claims_released", {
          count: released.length,
          tasks: released.slice(0, 20).map((t) => ({ id: t.id, reason: t.reason })),
        });
      }
      // 1. Startup checklist (code, not the model).
      brief = await runStartupChecklist({
        store,
        clock,
        agentId: agent.id,
        projectId: project?.id,
        appVersion: opts.appVersion ?? "0.0.0",
        sessionCapUsdMicro: opts.budgetCapUsdMicro,
        signal: controller.signal,
        ...opts.checklist,
      });
      // Peer feed: what the other agents on the project are doing (spec F).
      peerIds = await (this.deps.peersOf ?? defaultPeers(store))(agent.id, project?.id);
      const peerFeed = async () =>
        buildPeerFeed({
          store,
          clock,
          agentId: agent.id,
          projectId: project?.id,
          peerIds,
          schemaSync: this.deps.schemaSync,
        });
      let feed = await peerFeed();
      const feedText = renderPeerFeed(feed);
      const stateText = renderStateBrief(brief);
      // Memory (spec G): the lessons that match this brief, under the token budget. The
      // budget is enforced in code twice: the memory package cuts to it, and a block that
      // still exceeds it is dropped here rather than sent.
      let memoryText = "";
      if (this.deps.memory) {
        try {
          memoryLoaded = await this.deps.memory.recall({
            agentId: agent.id,
            kind: "principal",
            projectId: project?.id ?? null,
            query: stateText,
            maxTokens: memoryBudget,
          });
          if (memoryLoaded.tokens > memoryBudget) {
            await emit("memory.over_budget", {
              warning: `memory block of ${memoryLoaded.tokens} tokens exceeds the budget of ${memoryBudget}; dropped`,
              tokens: memoryLoaded.tokens,
              budget: memoryBudget,
            });
            memoryLoaded = { ...memoryLoaded, block: "", tokens: 0, lessonIds: [] };
          }
          memoryText = memoryLoaded.block;
          await emit("memory.loaded", {
            tokens: memoryLoaded.tokens,
            budget: memoryBudget,
            lessons: memoryLoaded.lessonIds.length,
            denied: memoryLoaded.denied,
            warnings: memoryLoaded.warnings,
          });
        } catch (e) {
          await emit("memory.load_failed", { warning: errorMessage(e) });
        }
      }
      const briefText = [stateText, feedText, memoryText].filter((t) => t).join("\n\n");
      await emit("session.brief", {
        tokensApprox: Math.ceil(briefText.length / 4),
        warnings: brief.warnings,
        unread: brief.inbox.unreadCount,
        ready: brief.tasks.readyCount,
        memoryTokens: memoryLoaded?.tokens ?? 0,
      });
      // Next-session queue (spec J.2): the items the brief carried go to the tasks' briefs; they
      // are used up only by work that finished (design §4.7), at the session's end.
      await emit("peers.feed", {
        peers: feed.peers.map((p) => ({
          agentId: p.agentId,
          name: p.agentName,
          online: p.online,
          claims: p.activeClaims.length,
          openPrs: p.openPullRequests.length,
          filesInFlight: Object.values(p.inFlightFiles).flat().length,
        })),
      });

      // Receipts (spec F): seen messages are delivered and read; ack-required messages that carry
      // information (handoffs, warnings, decisions, info) are acted on by taking them into the
      // plan. Questions and requests count as acted on only once a reply exists (checked at the
      // end of the session). Messages this agent sent that nobody acted on resurface here.
      for (const m of brief.inbox.unread) {
        await store.message.markDelivered(m.id);
        await store.message.markRead(m.id);
        if (m.requiresAck && ACK_BY_READING.has(m.type)) {
          await store.message.markActed(m.id);
          await emit("inbox.acted", { id: m.id, type: m.type });
        }
      }
      inboxTakenIn = true;
      const unacked = await store.message.unacknowledged(agent.id, { limit: 50 });
      if (unacked.length) {
        await emit("inbox.unacknowledged", {
          count: unacked.length,
          messages: unacked.slice(0, 20).map((m) => ({
            id: m.id,
            to: m.to_agent_id ?? m.to_human_id,
            type: m.type,
            createdAt: m.created_at,
          })),
        });
      }

      // 2. Plan within budget. Plans over budget are cut before starting.
      let readyTasks = project ? await store.task.readyTasks(project.id, { limit: 100 }) : [];
      // U-079: a full-review task runs only in the container sandbox; while it is not ready
      // the task waits (left out of the plan, its attempt count unchanged) and the session
      // goes on with the others. The gate re-checks Docker before every plan.
      if (this.deps.sandboxGate && readyTasks.some(needsContainerSandbox)) {
        sandboxAnswer = await this.deps.sandboxGate.check();
        if (!sandboxAnswer.ready) {
          for (const t of readyTasks.filter(needsContainerSandbox))
            waitingForSandbox.push({ id: t.id, title: t.title });
          readyTasks = readyTasks.filter((t) => !needsContainerSandbox(t));
        }
      }
      plan = await this.deps.planner.plan({
        brief,
        briefText,
        readyTasks,
        budgetUsdMicro: opts.budgetCapUsdMicro,
        reserveShare,
        session,
        token,
        budget,
      });
      plan = cutPlanToBudget(plan, Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare)));
      /** Every task row the session planned, by id (the start's ready tasks, then each re-plan). */
      const knownTasks = new Map<string, TaskRow>(readyTasks.map((t) => [t.id, t]));
      // What cannot run is named, never silent (U-040): the ready tasks that wait on a task not
      // done (a cancelled or failed one waits for good) and the items left out for budget.
      waiting = project ? await store.task.waitingTasks(project.id) : [];
      // B.5: the plan is a versioned change to the session with the agent as author and the
      // planner's summary as the reason. The row is read fresh here because its status may have
      // moved while the planner worked: the daemon's pause port marks a running row `paused` at
      // once and a kill ends it, each bumping `version`, and neither is a plan conflict. This
      // runner is the row's only plan writer (one active session per agent, checked above), so
      // the fresh version is the one the plan is a change to; the repository still refuses a
      // stale write (session.test.ts "writes the plan against a fresh read of the row").
      const beforePlan = await store.session.mustGet(session.id);
      session = await store.session.setPlan(
        beforePlan.id,
        beforePlan.version,
        plan as never,
        planReason(plan),
        { agentId: agent.id },
      );
      await emit("session.planned", {
        items: plan.items.length,
        estimateUsdMicro: plan.estimateUsdMicro,
        summary: plan.summary,
        ...(plan.leftOutForBudget?.length
          ? {
              leftOutForBudget: plan.leftOutForBudget.map((i) => ({
                taskId: i.taskId,
                title: i.title,
                estimateUsdMicro: i.estimateUsdMicro,
              })),
              workBudgetUsdMicro: plan.workBudgetUsdMicro,
            }
          : {}),
        ...(waiting.length
          ? {
              waiting: waiting.map((w) => ({
                taskId: w.task.id,
                title: w.task.title,
                waitsOn: w.waitsOn,
              })),
            }
          : {}),
        ...(waitingForSandbox.length && sandboxAnswer
          ? {
              waitingForSandbox: {
                state: sandboxAnswer.state,
                step: sandboxAnswer.step,
                tasks: waitingForSandbox.map((t) => ({ taskId: t.id, title: t.title })),
              },
            }
          : {}),
      });
      if (waitingForSandbox.length && sandboxAnswer) {
        await emit("session.sandbox_waiting", {
          state: sandboxAnswer.state,
          step: sandboxAnswer.step,
          tasks: waitingForSandbox.map((t) => ({ taskId: t.id, title: t.title })),
          warning: summarizeSandboxWaiting(waitingForSandbox, sandboxAnswer)[0],
        });
        try {
          await this.deps.sandboxGate?.waiting?.({
            sessionId: session.id,
            projectId: project?.id ?? null,
            tasks: [...waitingForSandbox],
            answer: sandboxAnswer,
          });
        } catch (e) {
          this.logger.warn("sandbox waiting hook failed", {
            sessionId: session.id,
            error: errorMessage(e),
          });
        }
      }
      try {
        await this.deps.onPlanned?.({
          sessionId: session.id,
          projectId: project?.id ?? null,
          plan,
        });
      } catch (e) {
        this.logger.warn("plan hook failed", { sessionId: session.id, error: errorMessage(e) });
      }

      // Levels 0 and 1 run nothing the human has not approved (spec J.6, J.7; ADR 0053): the
      // plan is filed as one blocking request whose card names it (`plan_id`), and the
      // session ends `stopped` so the approval can start the follow-up. A start bound to an
      // approved plan runs it only while the plan is still that plan; a plan that changed
      // since the human looked (a task added, removed or reordered) is asked again. An empty
      // plan (no task ready, or the approved tasks were done meanwhile) asks nothing: there is
      // nothing to approve, and the session ends `completed` having run nothing.
      const approval = planApprovalOf(opts.planApproved, plan.items);
      if ((autonomy === 0 || autonomy === 1) && approval !== "approved" && plan.items.length > 0) {
        const changed = approval === "changed";
        const approvedPlanId = typeof opts.planApproved === "string" ? opts.planApproved : null;
        const planId = planIdOf(session.id, plan.items);
        const request = await store.humanRequest.insert({
          human_id: agent.owner_human_id,
          project_id: project?.id ?? null,
          session_id: session.id,
          kind: "approval",
          why: [
            autonomy === 0
              ? "Advisor mode: the plan is a proposal; approve to run it as a new session (every action that changes state is still asked at this level)."
              : "Assisted mode: approve this session plan before work starts.",
            ...(changed
              ? [
                  "The ready tasks changed since the plan you approved; this is the plan now, and nothing ran.",
                ]
              : []),
          ].join(" "),
          steps: plan.items.map(
            (i) =>
              `${i.title} (${i.specialist}, about ${formatChf(
                usdToChfMicro(
                  Math.max(0, Math.round(i.estimateUsdMicro)),
                  this.deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD,
                ),
              )})`,
          ),
          options: [...PLAN_APPROVAL_OPTIONS],
          blocking: true,
          risk: "medium",
          change_card: {
            key: planKeyOf(session.id),
            plan_id: planId,
            plan: plan as never,
            ...(approvedPlanId ? { superseded_plan_id: approvedPlanId } : {}),
          },
          author_agent: agent.id,
        });
        stopReason = "plan_awaiting_approval";
        status = "stopped";
        await emit("session.plan_filed", {
          requestId: request.id,
          planId,
          items: plan.items.length,
          changed,
          approvedPlanId,
        });
      } else {
        if (approval === "approved" && typeof opts.planApproved === "string") {
          token = issueToken(true);
          await emit("session.plan_approved", {
            planId: opts.planApproved,
            approvedSessionId: parsePlanId(opts.planApproved)?.sessionId ?? null,
            items: plan.items.length,
          });
        }
        // Nothing runnable means nothing is consumed, reviewed or graded (design §4.8).
        if (plan.items.length === 0) stopReason = NOTHING_RUNNABLE;
        // 3. Execute, claim-before-work, inbox re-check between tasks. The session keeps going
        // (design §4.2): once the plan is run it looks again and takes the tasks that became
        // ready meanwhile (their dependencies finished), the ones the critic sent back (the next
        // attempt, in this session) and the ones the person made ready. Before, it ran only the
        // tasks ready when it started: a 7-task chain took 7 Starts and every rework waited for
        // the next one. It stops when nothing it can run is left, the budget is used (the
        // reserve kept for reviews), the person stops it or the wall clock runs out.
        const queue: PlanItem[] = [...plan.items];
        /** Runs per task in this session: a guard against a task that keeps coming back. */
        const runsOf = new Map<string, number>();
        /**
         * The specialist each task last started with in this session: a later start is a retry
         * (`again`), and one with another specialist a hand-over (`handedFrom`). The session log
         * tells a retry by what came of it (design §3.7, `eventAudience`).
         */
        const startedWith = new Map<string, string>();
        /** Tasks not to take again in this session (a peer holds it, the sandbox, a limit). */
        const notAgain = new Set<string>();
        /** At levels 0 and 1 only what the person approved runs (its retries included). */
        const onlyThese = autonomy < 2 ? new Set(plan.items.map((i) => i.taskId)) : null;
        /** Tasks whose run failed with a transient error and were tried again at once. */
        const transientRetried = new Set<string>();
        /** How often a credential stopped each task and the next one took over (U-078). */
        const movedOnCredential = new Map<string, number>();
        const replan = async (): Promise<PlanItem[]> => {
          if (!project || !brief) return [];
          const queued = new Set(queue.map((i) => i.taskId));
          let ready = (await store.task.readyTasks(project.id, { limit: 100 })).filter(
            (t) =>
              !notAgain.has(t.id) &&
              !queued.has(t.id) &&
              (runsOf.get(t.id) ?? 0) < MAX_RUNS_PER_TASK_IN_SESSION &&
              (!onlyThese || onlyThese.has(t.id)),
          );
          if (ready.length && this.deps.sandboxGate && ready.some(needsContainerSandbox)) {
            const answer = await this.deps.sandboxGate.check();
            if (!answer.ready) {
              sandboxAnswer ??= answer;
              const newlyWaiting: SandboxWaitingTask[] = [];
              for (const t of ready.filter(needsContainerSandbox)) {
                notAgain.add(t.id);
                if (waitingForSandbox.some((w) => w.id === t.id)) continue;
                waitingForSandbox.push({ id: t.id, title: t.title });
                newlyWaiting.push({ id: t.id, title: t.title });
              }
              ready = ready.filter((t) => !needsContainerSandbox(t));
              if (newlyWaiting.length) {
                await emit("session.sandbox_waiting", {
                  state: answer.state,
                  step: answer.step,
                  tasks: newlyWaiting.map((t) => ({ taskId: t.id, title: t.title })),
                  warning: summarizeSandboxWaiting(newlyWaiting, answer)[0],
                });
                await this.deps.sandboxGate
                  .waiting?.({
                    sessionId: session.id,
                    projectId: project.id,
                    tasks: [...waitingForSandbox],
                    answer,
                  })
                  .catch((e: unknown) =>
                    this.logger.warn("sandbox waiting hook failed", { error: errorMessage(e) }),
                  );
              }
            }
          }
          if (ready.length === 0) return [];
          for (const t of ready) knownTasks.set(t.id, t);
          const next = await this.deps.planner.plan({
            brief,
            briefText,
            readyTasks: ready,
            budgetUsdMicro: opts.budgetCapUsdMicro,
            reserveShare,
            session,
            token,
            budget,
          });
          // What is left of the work budget now, not at the start.
          const room = Math.max(
            0,
            Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare)) -
              budget.snapshot().sessionSpentUsdMicro,
          );
          const cut = cutPlanToBudget(next, room);
          const current = plan as SessionPlan;
          const leftOut = (cut.leftOutForBudget ?? []).filter(
            (i) => !(current.leftOutForBudget ?? []).some((l) => l.taskId === i.taskId),
          );
          for (const i of cut.leftOutForBudget ?? []) notAgain.add(i.taskId);
          if (cut.items.length === 0 && leftOut.length === 0) return [];
          plan = {
            ...current,
            items: [...current.items, ...cut.items],
            estimateUsdMicro: current.estimateUsdMicro + cut.estimateUsdMicro,
            ...(leftOut.length || current.leftOutForBudget
              ? {
                  leftOutForBudget: [...(current.leftOutForBudget ?? []), ...leftOut],
                  workBudgetUsdMicro: Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare)),
                }
              : {}),
          };
          if (cut.items.length === 0) return [];
          // The plan on the row grows with what the session took (spec B.5: a versioned change
          // with its reason), so the session review checks what really ran.
          const fresh = await store.session.mustGet(session.id);
          session = await store.session.setPlan(
            fresh.id,
            fresh.version,
            plan as never,
            `took ${cut.items.length} more task${cut.items.length === 1 ? "" : "s"} as ${
              cut.items.length === 1 ? "it" : "they"
            } became ready`,
            { agentId: agent.id },
          );
          await emit("session.replanned", {
            items: cut.items.map((i) => ({ taskId: i.taskId, title: i.title })),
            estimateUsdMicro: cut.estimateUsdMicro,
            text: `Continuing with ${namesOf(cut.items.map((i) => i.title))}.`,
          });
          return cut.items;
        };
        for (;;) {
          if (controller.signal.aborted) throw new ForerunnerError("killed", "session stopped");
          budget.checkWallClock(clock.now());
          if (queue.length === 0) {
            // "Stop after this task" (the pause port marks the row `paused`): nothing more.
            if (budget.noNewWork || (await store.session.get(session.id))?.status === "paused")
              break;
            const more = await replan();
            if (more.length === 0) break;
            queue.push(...more);
            continue;
          }
          const item = queue.shift() as PlanItem;
          if (budget.noNewWork) {
            skipped.push(item.taskId);
            continue;
          }
          const recheck = await this.recheckInbox(agent.id, session.id, emit, heard);
          if (recheck.interrupt) {
            stopReason = "stopped_by_message";
            skipped.push(item.taskId, ...queue.map((i) => i.taskId));
            queue.length = 0;
            break;
          }
          runsOf.set(item.taskId, (runsOf.get(item.taskId) ?? 0) + 1);
          // Overlap check against the peers' current activity before any work starts.
          const planned = knownTasks.get(item.taskId);
          const work = {
            taskId: item.taskId,
            title: item.title,
            files: planned
              ? extractPathHints(
                  `${planned.title}\n${planned.outcome}\n${planned.acceptance_criteria.join("\n")}`,
                )
              : [],
          };
          feed = await peerFeed();
          const overlaps = detectOverlap(work, feed);
          let blocked = false;
          for (const o of overlaps) {
            const key = `${o.peerId}:${o.kind}:${o.taskId}`;
            if (overlapNotified.has(key)) continue;
            overlapNotified.add(key);
            await emit("peer.overlap", { ...o, plannedTaskId: item.taskId });
            if (o.kind === "task_claimed") continue; // the claim below reports and messages this case
            await store.message.send({
              from_agent_id: agent.id,
              to_agent_id: o.peerId,
              project_id: project?.id ?? null,
              task_id: item.taskId,
              type: "warning",
              body: overlapMessage(work, o),
              requires_ack: false,
              author_agent: agent.id,
            });
            if (overlapBlocks(o)) blocked = true;
          }
          if (blocked) {
            skipped.push(item.taskId);
            notAgain.add(item.taskId);
            await emit("task.skipped", { taskId: item.taskId, reason: "peer_in_flight" });
            continue;
          }
          const claim = await store.task.claim(item.taskId, agent.id, claimTtlMs, clock.now(), {
            reason: `session ${session.id}`,
          });
          if (!claim.ok) {
            skipped.push(item.taskId);
            notAgain.add(item.taskId);
            await emit("task.skipped", {
              taskId: item.taskId,
              reason: claim.reason,
              holder: claim.reason === "held_by" ? claim.holder : undefined,
            });
            if (claim.reason === "held_by") {
              await store.message.send({
                from_agent_id: agent.id,
                to_agent_id: claim.holder,
                project_id: project?.id ?? null,
                task_id: item.taskId,
                type: "info",
                body: `I planned to work on "${item.title}" but you hold the claim; I moved on.`,
                requires_ack: false,
                author_agent: agent.id,
              });
            }
            continue;
          }
          heldClaims.add(item.taskId);
          let task = claim.task;
          if (task.status === "claimed")
            task = await store.task.transition(
              task.id,
              task.version,
              "in_progress",
              `session ${session.id} started work`,
              { agentId: agent.id },
            );
          // The specialist that runs this attempt, known before the log says who started it
          // (U-044): the retry ladder's stand-in after two failed attempts, the plan's name read
          // as the registry's. Before, the log named the plan's specialist for work another one
          // did ("The coder started …" for the migration specialist's run).
          const chosen = await this.deps.executor
            .chooseSpecialist?.({ task, item })
            .catch((e: unknown) => {
              this.logger.warn("the specialist for the task was not chosen ahead", {
                taskId: task.id,
                error: errorMessage(e),
              });
              return null;
            });
          const runItem: PlanItem = chosen ? { ...item, specialist: chosen } : item;
          const before = startedWith.get(task.id);
          const again = before !== undefined;
          // Who ran it last, in this session or an earlier one: another specialist taking over
          // says so ("The migration specialist takes over … from the coder").
          const previous = before ?? (chosen ? await lastWorkSpecialist(store, task.id) : null);
          startedWith.set(task.id, runItem.specialist);
          await emit("task.started", {
            taskId: task.id,
            title: task.title,
            specialist: runItem.specialist,
            estimateUsdMicro: item.estimateUsdMicro,
            ...(again ? { again: true } : {}),
            ...(previous && previous !== runItem.specialist ? { handedFrom: previous } : {}),
          });
          runningTask = { id: task.id, title: task.title };
          // The claim is renewed every sixth of its TTL for as long as the task runs: a
          // one-shot timer would let a long task's claim lapse and a peer take the task.
          const renewEveryMs = Math.max(1000, Math.floor(claimTtlMs / 6));
          let cancelRenew: () => void = () => undefined;
          const scheduleRenew = () => {
            cancelRenew = clock.setTimeout(function tick() {
              void store.task.renewClaim(task.id, agent.id, claimTtlMs).catch(() => undefined);
              scheduleRenew();
            }, renewEveryMs);
          };
          scheduleRenew();
          const renew = () => cancelRenew();
          // What the human said since the last task started reaches this task's brief (spec
          // O.9): read now, between the tasks, and given to this task alone.
          const said = heard.filter((h) => h.deliveredTo === null);
          for (const h of said) {
            h.deliveredTo = task.id;
            await store.message.markRead(h.id);
          }
          if (said.length)
            await emit("task.heard", { taskId: task.id, ids: said.map((h) => h.id) });
          // A person's move of this task while it runs (Cancel, Mark failed, Needs me) stops this
          // task's run and nothing else (U-039): the task's own controller, registered with the
          // kill switch under the task, which the daemon's transition route stops at once
          // (`KillSwitch.stopTask`; the specialist's run is registered under the task too), and
          // a watch of the task's row for a move made where no route of this process sees it.
          const taskController = new AbortController();
          const onSessionAbort = () => taskController.abort(controller.signal.reason);
          if (controller.signal.aborted) onSessionAbort();
          else controller.signal.addEventListener("abort", onSessionAbort, { once: true });
          const unregisterTask = this.deps.kill.register({
            agentId: agent.id,
            sessionId: session.id,
            taskId: task.id,
            controller: taskController,
            label: `task ${task.id} of session ${session.id}`,
          });
          const stopWatch = this.watchTask(task.id, taskController.signal);
          // The queue's notes for this task (U-038): those naming it, or naming no task.
          const notes = notesForTask(brief.queue.items, task, [...knownTasks.values()]);
          for (const n of notes) notesGiven.set(n.id, [...(notesGiven.get(n.id) ?? []), task.id]);
          if (notes.length)
            await emit("task.notes", {
              taskId: task.id,
              title: task.title,
              ids: notes.map((q) => q.id),
              count: notes.length,
            });
          let result: TaskExecutionResult;
          const execStarted = clock.monotonic();
          // Steps are recorded in order, one after the other, and all before the task ends.
          let steps: Promise<void> = Promise.resolve();
          const recordStep = async (t: TaskRow, step: TaskStep) => {
            if (step.kind === "model") {
              await store.session.recordSpend(session.id, Math.max(0, step.costUsdMicro), 1);
              return;
            }
            // A line of the run's own (its budget line, its wrap-up; ADR 0112): no step.
            if (step.kind === "note") {
              await emit("task.step", { taskId: t.id, title: t.title, ok: true, text: step.text });
              return;
            }
            await store.session.recordSpend(session.id, 0, 1);
            await emit("task.step", {
              taskId: t.id,
              title: t.title,
              tool: step.name,
              ok: !step.isError,
              text: stepLine(step),
            });
          };
          try {
            result = await this.deps.executor.execute({
              task,
              session,
              token,
              budget,
              item: runItem,
              signal: taskController.signal,
              heard: said.map(({ deliveredTo: _to, ...line }) => line),
              ...(notes.length ? { notes } : {}),
              ...(opts.note?.trim() ? { sessionNote: opts.note.trim() } : {}),
              onStep: (step) => {
                steps = steps
                  .then(() => recordStep(task, step))
                  .catch((e: unknown) =>
                    this.logger.warn("step not recorded", { error: errorMessage(e) }),
                  );
              },
            });
          } catch (e) {
            if (isSandboxNotReady(e)) {
              // U-079: the sandbox stopped being ready after the plan (Docker quit): the task
              // waits for it like the ones left out of the plan. Its claim is given back, so it
              // is ready again with its attempt count unchanged, and the session goes on.
              // (The finally below stops the claim renewal, the watch and the registration.)
              const details = (e.details ?? {}) as Partial<SandboxGateAnswer>;
              sandboxAnswer ??= {
                ready: false,
                state: details.state ?? "not_running",
                step: details.step ?? "",
                headline: details.headline ?? "The Docker sandbox is not ready.",
              };
              waitingForSandbox.push({ id: task.id, title: task.title });
              notAgain.add(task.id);
              await releaseIfHeld(task.id, "waits for the Docker sandbox (U-079)");
              await emit("task.sandbox_waiting", {
                taskId: task.id,
                title: task.title,
                state: details.state ?? null,
                warning: errorMessage(e),
              });
              continue;
            }
            const code = e instanceof ForerunnerError ? e.code : "internal";
            // U-078: no credential that may serve the task can now (each rests or was refused,
            // or 'wait' holds to a first choice that rests). Before, the router's "no billing
            // source available ..." made it a failed task with that raw sentence on its card,
            // task after task. Now it waits, and the session ends on that one sentence.
            const wait =
              code === "unavailable" && e instanceof ForerunnerError
                ? (e.details.wait as unknown as CredentialWait | undefined)
                : undefined;
            result = wait
              ? {
                  outcome: "usage_limit",
                  summary: errorMessage(e),
                  costUsdMicro: 0,
                  credentialWait: wait,
                }
              : {
                  outcome:
                    code === "budget_exceeded"
                      ? "budget_exceeded"
                      : code === "timeout"
                        ? "timeout"
                        : code === "killed"
                          ? "killed"
                          : "failed",
                  summary: errorMessage(e),
                  costUsdMicro: 0,
                  errorCode: code,
                };
          } finally {
            await steps;
            renew();
            stopWatch();
            unregisterTask();
            controller.signal.removeEventListener("abort", onSessionAbort);
          }
          task = await store.task.mustGet(task.id);
          await store.task.patch(task.id, {
            actual_cost_usd_micro: task.actual_cost_usd_micro + result.costUsdMicro,
            ...(result.prUrl ? { pr_url: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(task.owner_agent_id ? {} : { owner_agent_id: agent.id }),
          });
          task = await store.task.mustGet(task.id);
          // A run the person cancelled changed nothing that stays (`recordMove` sets it aside):
          // the session's result and the task's files never list it.
          if (result.changedFiles?.length && task.status !== "cancelled") {
            filesByTask.set(task.id, result.changedFiles);
            // The pull request and branch the files went to, for the session page and the log
            // (GitHub walk, 2026-11-02: neither named the PR or the branch).
            await emit(TASK_FILES_EVENT, {
              taskId: task.id,
              files: result.changedFiles,
              ...(result.prUrl ? { prUrl: result.prUrl } : {}),
              ...(result.prUrl && result.branch ? { branch: result.branch } : {}),
            });
          }
          // What the session log needs to tell the run once (design §3.7, `eventAudience`):
          // whether the critic reviews it next (the branches below), and the words of a run
          // that said it could not do the work, which the critic's line then quotes.
          // ADR 0104: every task an agent finished goes to the critic, tier 0 included.
          const toCritic =
            !!this.deps.critic &&
            task.status === "in_progress" &&
            (result.outcome === "done" || result.outcome === "in_review");
          const couldNot =
            result.outcome === "done" || result.outcome === "in_review"
              ? couldNotWords(result.summary)
              : null;
          await emit(
            "task.finished",
            {
              taskId: task.id,
              // The log's line names the task and who did it (design §3.7, §5 rule 3).
              title: task.title,
              specialist: result.specialist ?? runItem.specialist,
              outcome: result.outcome,
              costUsdMicro: result.costUsdMicro,
              summary: result.summary,
              // A paused run's own report (ADR 0112): the drawer shows it under the sentence.
              ...(result.outcome === "paused" && result.finalReport?.trim()
                ? { report: result.finalReport.trim().slice(0, 4_000) }
                : {}),
              ...(toCritic ? { review: true } : {}),
              ...(couldNot !== null ? { couldNot } : {}),
              ...(again ? { again: true } : {}),
            },
            result.costUsdMicro,
          );
          try {
            await this.deps.onTaskFinished?.({
              sessionId: session.id,
              task,
              item,
              result,
              durationMs: Math.max(0, Math.round(clock.monotonic() - execStarted)),
            });
          } catch (e) {
            this.logger.warn("task finished hook failed", {
              taskId: task.id,
              error: errorMessage(e),
            });
          }
          // The task is read again now that the run returned: a state a person set while it ran
          // stands, and the runner never moves the task from it (U-039). A session stopped by
          // the kill switch still ends as killed; when the person's move of the task stopped
          // the run first (a cancel, then Stop now), the move is recorded before, so a
          // cancel's work is set aside as its line said.
          const sessionStopped = controller.signal.aborted && result.outcome === "killed";
          const movedByPerson = task.status !== "in_progress" && stoppedByMove(taskController);
          if (sessionStopped && !movedByPerson)
            throw new ForerunnerError("killed", "session stopped during task");
          runningTask = null;
          if (task.status !== "in_progress") {
            await recordMove(task, result.outcome, "run", movedByPerson);
            if (sessionStopped) throw new ForerunnerError("killed", "session stopped during task");
            continue;
          }
          if (result.outcome === "usage_limit") {
            // U-078, ADR 0100 amended: a credential stopped the run (its usage limit, or
            // Anthropic refused it) or no credential may serve it now. The executor rested or
            // marked the source; the task goes back to ready by its claim's release, not
            // through `failed`, so the retry ladder's attempt stays as it was, no critic
            // reviews it and it is never tried again as a passing error. The session log says
            // what happened and what comes next in one plain sentence.
            await emit(BILLING_FALLBACK_EVENT, {
              taskId: task.id,
              title: task.title,
              sentence: result.summary,
            });
            await releaseIfHeld(task.id, "a Claude credential could not serve: back to ready");
            const tries = (movedOnCredential.get(task.id) ?? 0) + 1;
            movedOnCredential.set(task.id, tries);
            if (result.credentialWait || tries > MAX_CREDENTIAL_MOVES) {
              // Nothing it may run can be billed now: the session ends on the wait (one
              // sentence, no row of failed tasks); the rest stays ready and starts by itself
              // at the reset, or once a new credential is saved (the executor noted the wait).
              credentialWait ??= result.credentialWait ?? null;
              skipped.push(task.id, ...queue.map((i) => i.taskId));
              notAgain.add(task.id);
              queue.length = 0;
              stopReason = CREDENTIAL_WAIT_STOP;
              break;
            }
            // Another credential takes over now ("Use the other one", or after a refusal): the
            // task goes on at once in this session.
            queue.unshift(item);
            continue;
          }
          lessonCandidates.push(...(result.lessons ?? []));
          // A runner composed without a critic (an engine test world; the daemon always
          // composes one) closes a tier 0 task on its run. With a critic, nothing is Done
          // before the critic reviewed it (ADR 0104): tier 0 is reviewed as the light review.
          const closeTier0 =
            !this.deps.critic &&
            result.outcome === "done" &&
            task.risk_tier === 0 &&
            result.checksPassed;
          if (closeTier0) {
            // The store still refuses the close while a finding is open (B.4); that is
            // surfaced, never worked around.
            await store.task.transition(
              task.id,
              task.version,
              "in_review",
              "automated checks passed",
              { agentId: agent.id },
            );
            const t2 = await store.task.mustGet(task.id);
            try {
              await store.task.transition(
                t2.id,
                t2.version,
                "done",
                "tier 0: automated checks only",
                { agentId: agent.id },
              );
              completed.push(task.id);
            } catch (e) {
              if (!(e instanceof ForerunnerError && e.code === "findings_open")) throw e;
              inReview.push(task.id);
              blockedByFindings.push(task.id);
              await this.blockedByFindings({
                task: await store.task.mustGet(task.id),
                session,
                agentId: agent.id,
                humanId: agent.owner_human_id,
                runId: result.runId ?? null,
                path: "tier0",
                emit,
              });
            }
          } else if (result.outcome === "done" || result.outcome === "in_review") {
            // The review is stopped with the task's run when the person cancels it meanwhile
            // (`KillSwitch.stopTask`, as for the run, U-039): its own controller, registered
            // under the task, which a stop of the session aborts too. Registered before the
            // task reads "Being reviewed" (L-8, live check of phase C): a Cancel from the first
            // moment it reads so finds the review to stop, and its line says so truly.
            const reviewController = new AbortController();
            const onReviewAbort = () => reviewController.abort(controller.signal.reason);
            if (controller.signal.aborted) onReviewAbort();
            else controller.signal.addEventListener("abort", onReviewAbort, { once: true });
            const unregisterReview = this.deps.kill.register({
              agentId: agent.id,
              sessionId: session.id,
              taskId: task.id,
              controller: reviewController,
              label: `review of task ${task.id} in session ${session.id}`,
            });
            const endReviewHold = () => {
              unregisterReview();
              controller.signal.removeEventListener("abort", onReviewAbort);
            };
            try {
              await store.task.transition(
                task.id,
                task.version,
                "in_review",
                result.summary.slice(0, 200),
                { agentId: agent.id },
              );
            } catch (e) {
              // Moved by a person after its run returned and before it went to review (a
              // cancel in that moment): their state stands, as for a move during the run.
              const now = await store.task.mustGet(task.id);
              if (now.status === "in_progress") {
                endReviewHold();
                throw e;
              }
              endReviewHold();
              await recordMove(now, result.outcome, "run", stoppedByMove(reviewController));
              continue;
            }
            // A task cancelled between its run and its review is never reviewed (phase C, live
            // walk 2 C1: the critic "accepted" a cancelled task). Its files go only when the
            // cancel stopped the review's hold (then its line said so).
            const toReview = await store.task.mustGet(task.id);
            if (toReview.status !== "in_review") {
              endReviewHold();
              await recordMove(toReview, result.outcome, "review", stoppedByMove(reviewController));
              continue;
            }
            // The critic (spec H, ADR 0104): every task is reviewed before it can count as
            // done (tier 0 as the light review); the verdict is applied through the state
            // workflow.
            let reviewed: Awaited<ReturnType<SessionRunner["reviewTask"]>>;
            try {
              reviewed = this.deps.critic
                ? await this.reviewTask({
                    task: toReview,
                    session,
                    token,
                    budget,
                    // The plan item: the review level and sign-off stay the planned specialist's (ADR 0108).
                    item,
                    // Who ran the attempt, for the critic's line about it (U-044): the stand-in
                    // after a hand-over, never the plan's name for the stand-in's work.
                    ranBy: result.specialist ?? runItem.specialist,
                    result,
                    agentId: agent.id,
                    signal: reviewController.signal,
                    emit,
                  })
                : null;
            } finally {
              endReviewHold();
            }
            if (!reviewed) {
              inReview.push(task.id);
            } else if ("failed" in reviewed) {
              // U-045: the review failed (an error, not a verdict), or was stopped (the critic
              // records no review then). A task the person moved meanwhile stays as they set it
              // (a cancel's work set aside when the cancel stopped the review); a session
              // stopped meanwhile ends as killed; else the task waits in review and the person
              // gets one card whose options act.
              const now = await store.task.mustGet(task.id);
              const movedByPerson = now.status !== "in_review" && stoppedByMove(reviewController);
              if (controller.signal.aborted && !movedByPerson) {
                // Stop now, Stop all, Quit (design §4.9) or the session's own end stopped the
                // review: the task goes back to Ready, its attempt unchanged and its files
                // kept, as for a stopped run, and the next session runs it again. Before, it
                // stayed "Being reviewed" for good: the session's release at its end puts back
                // only a claimed or running task, no card was filed and no session plans a task
                // in review (phase C review).
                if (now.status === "in_review") {
                  const stop = personStopOf(controller.signal.reason);
                  await store.task.restoreStatus(
                    now.id,
                    now.version,
                    "in_review",
                    stop ? taskReasonForStop(stop) : "the session ended during its review",
                    { agentId: agent.id },
                  );
                  runningTask = { id: task.id, title: task.title };
                }
                throw new ForerunnerError("killed", "session stopped during the review");
              }
              if (now.status !== "in_review") {
                await recordMove(now, "review_failed", "review", movedByPerson);
                if (controller.signal.aborted)
                  throw new ForerunnerError("killed", "session stopped during the review");
                continue;
              }
              inReview.push(task.id);
              reviewFailed.push(task.id);
              let humanRequestId: string | null = null;
              try {
                const filed = await fileReviewFailedRequest({
                  store,
                  task: now,
                  session,
                  humanId: agent.owner_human_id,
                  agentId: agent.id,
                  runId: result.runId ?? null,
                  error: reviewed.error,
                });
                humanRequestId = filed.request.id;
              } catch (e) {
                this.logger.warn("review-failed request not filed", {
                  taskId: task.id,
                  error: errorMessage(e),
                });
              }
              await emit("critic.review_failed", {
                taskId: task.id,
                title: task.title,
                specialist: result.specialist ?? runItem.specialist,
                ...(couldNot !== null ? { couldNot } : {}),
                warning: `critic review failed: ${reviewed.error}${
                  humanRequestId ? "; asked you to rework, accept or cancel" : ""
                }`,
                humanRequestId,
                escalation: true,
              });
            } else {
              reviews.push({
                taskId: task.id,
                reviewId: reviewed.reviewId,
                tier: reviewed.tier,
                verdict: reviewed.verdict,
                grade: reviewed.grade,
                decision: reviewed.decision,
                retry: reviewed.retry,
                attempt: reviewed.attempt,
              });
              // A resolved finding always comes from an earlier review, so its row is loaded:
              // the lesson says what was wrong and what fixed it, not that something was.
              for (const id of reviewed.resolvedFindingIds) {
                const finding = await store.finding.get(id);
                lessonCandidates.push({
                  text: `Critic finding resolved on "${task.title}" (${result.specialist ?? runItem.specialist}): ${
                    finding
                      ? `[${finding.severity}] ${finding.description} -> ${finding.required_action}`
                      : `finding ${id} was resolved by the rework`
                  }`,
                  tags: ["critic-finding", "resolved", ...(finding ? [finding.severity] : [])],
                  confidence: 0.6,
                  source: `session:${session.id};review:${reviewed.reviewId ?? "none"};finding:${id}`,
                });
              }
              if (reviewed.resolvedFindingIds.length) resolvedFindingTitles.push(task.title);
              quarantinedByCritic.push(
                ...reviewed.quarantinedLessons.map((q) => ({
                  text: q.text,
                  rules: q.rules,
                  score: 0,
                  source: "agent_output" as const,
                  error: `instruction-like content ignored (${q.rules.join(", ")})`,
                })),
              );
              switch (reviewed.decision) {
                case "accepted": {
                  completed.push(task.id);
                  // Level 3 merges the reviewed PR (J.9); the hooks decide, the outcome is
                  // reported either way.
                  const merged = await this.mergeReviewed({
                    task: await store.task.mustGet(task.id),
                    session,
                    token,
                    budget,
                    signal: controller.signal,
                    agentId: agent.id,
                    emit,
                  });
                  if (merged) merges.push(merged);
                  break;
                }
                case "revise":
                case "retry":
                  // Sent back: the next attempt runs in this session (design §4.3); a task
                  // sent back several times is counted once.
                  if (!retried.includes(task.id)) retried.push(task.id);
                  break;
                case "human":
                  needsHuman.push(task.id);
                  break;
                case "blocked_by_findings":
                  inReview.push(task.id);
                  blockedByFindings.push(task.id);
                  await this.blockedByFindings({
                    task: reviewed.task,
                    session,
                    agentId: agent.id,
                    humanId: agent.owner_human_id,
                    runId: result.runId ?? null,
                    path: "critic_accept",
                    emit,
                  });
                  break;
                default:
                  inReview.push(task.id);
              }
            }
          } else if (
            result.outcome === "needs_human" ||
            (result.outcome === "paused" && !!result.budgetStop)
          ) {
            // ADR 0112 (amended by budget-resume): a paused run (a budget of any level, or a
            // wrap-up with work left) is no work for the critic and no failed try: it waits on
            // one card, filed at the first stop of any kind, which names the limit and offers
            // Continue (CHF N more) where a bigger budget helps. A stop at the session's budget,
            // the project's budget, the month's cap or the subscription's share ends the
            // session after it: nothing else of it can run there. Before, a stop at the
            // session's budget filed nothing the first time (C-36: a card at the second).
            const rate = this.deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD;
            const waiting = await store.task.transition(
              task.id,
              task.version,
              "needs_human",
              // Live walk 2 (B2): a stop at the task's own budget names it in CHF, as its card.
              // Live walk 4: any other reason in whole sentences, without tool names (it was
              // cut at 200 characters mid-word).
              result.budgetStop
                ? `${budgetStopTitle(task, result.budgetStop, rate)}.`
                : plainStopReason(result.summary, 200, 1),
              { agentId: agent.id },
            );
            needsHuman.push(task.id);
            // Design §3.8: every task a run leaves waiting has one card, so the result's "needs
            // your decision (Inbox)" is true. A stop at its budget: Raise the budget, Cancel task
            // (live walk 2, B2). Anything else that asked nothing (live walk 4: the researcher
            // refused at once): Try again, Cancel task. A run that asked (its questions, an
            // approval, a rebase conflict) filed its own card, and no second one is filed.
            try {
              if (result.budgetStop)
                await fileBudgetStopCard({
                  store,
                  task: waiting,
                  session,
                  humanId: agent.owner_human_id,
                  agentId: agent.id,
                  runId: result.runId ?? null,
                  stop: result.budgetStop,
                  handoff: result.handoff ?? null,
                  now: clock.nowIso(),
                  chfPerUsd: rate,
                });
              else
                await fileCannotRunCard({
                  store,
                  task: waiting,
                  session,
                  humanId: agent.owner_human_id,
                  agentId: agent.id,
                  runId: result.runId ?? null,
                  reason: result.summary,
                });
            } catch (e) {
              this.logger.warn("card of the waiting task not filed", {
                taskId: task.id,
                error: errorMessage(e),
              });
            }
            if (
              result.outcome === "paused" &&
              result.budgetStop &&
              stopEndsSession(result.budgetStop.source)
            ) {
              // The session names the limit that ended it (review of budget-stop): before, it
              // said "the session's budget is used" at 1% of its own budget.
              stopReason = budgetStopReasonOf(result.budgetStop.source);
              stopCapUsdMicro = result.budgetStop.capUsdMicro;
              skipped.push(...queue.map((i) => i.taskId));
              queue.length = 0;
              break;
            }
          } else if (
            result.outcome === "failed" &&
            isTransientError(result.errorCode) &&
            !transientRetried.has(task.id)
          ) {
            // A transient error (the model call failed, the network, a rate limit) is tried
            // again once, at once (design §4.4); the attempt count stays as it was.
            transientRetried.add(task.id);
            await releaseIfHeld(task.id, "trying again at once after a transient error");
            await emit("task.retrying", {
              taskId: task.id,
              title: task.title,
              text: `${result.summary} Trying "${task.title}" again.`,
            });
            queue.unshift(item);
            continue;
          } else if (result.outcome === "failed" || result.outcome === "timeout") {
            const failedTask = await store.task.transition(
              task.id,
              task.version,
              "failed",
              result.summary.slice(0, 200),
              { agentId: agent.id },
            );
            failed.push(task.id);
            // Design §3.8, §4.4: a failed task gets one card (Try again, Mark done anyway,
            // Cancel task), so it is never stuck silently behind "Nothing waits on you".
            try {
              await fileFailedTaskCard({
                store,
                task: failedTask,
                session,
                humanId: agent.owner_human_id,
                agentId: agent.id,
                runId: result.runId ?? null,
                reason: result.summary,
              });
            } catch (e) {
              this.logger.warn("failed-task card not filed", {
                taskId: task.id,
                error: errorMessage(e),
              });
            }
          } else if (result.outcome === "budget_exceeded" || result.outcome === "paused") {
            // A stop with no pause's details (an executor from before ADR 0112): the session's
            // own budget is used (design §4.2), the task goes back to ready by its claim's
            // release, its attempt count unchanged, and the next session continues it. The
            // executor of today pauses with the limit named (the branch above: one card).
            stopReason = "budget_exceeded";
            await releaseIfHeld(
              task.id,
              "the session's budget was used during its run; the next session continues it",
            );
            skipped.push(task.id, ...queue.map((i) => i.taskId));
            queue.length = 0;
            break;
          } else if (result.outcome === "killed") {
            throw new ForerunnerError("killed", "session stopped during task");
          }
          await releaseIfHeld(task.id, "task finished for this session");
        }
        if (stopReason === "completed" && budget.noNewWork && skipped.length)
          stopReason = "budget_finish_current";
      }
    } catch (e) {
      const code = e instanceof ForerunnerError ? e.code : "internal";
      // Stop now, Stop all and Quit end the run through the kill switch; whose stop it was is
      // the reason it was given (design §4.9). A person's stop is no error: the session says who
      // stopped it and the task goes back to ready with that reason.
      personStop = code === "killed" ? personStopOf(controller.signal.reason) : null;
      stopReason = personStop ?? code;
      status =
        code === "killed"
          ? "killed"
          : code === "timeout"
            ? "stopped"
            : code === "budget_exceeded"
              ? "stopped"
              : "failed";
      if (status === "failed")
        this.logger.error("session failed", { sessionId: session.id, error: errorMessage(e) });
      if (personStop) {
        await emit("session.stopped", {
          by: personStop,
          ...(runningTask ? { taskId: runningTask.id, title: runningTask.title } : {}),
          text: `${taskReasonForStop(personStop)}${
            runningTask ? ` during "${runningTask.title}". It is ready again.` : "."
          }`,
        });
      } else await emit("session.error", { code, message: errorMessage(e) });
    } finally {
      await releaseAll(personStop ? taskReasonForStop(personStop) : `session ${stopReason}`);
      unregister();
    }

    // 4. Session end: summary, project summary cache, handoff to peers, notify human.
    // The inbox is re-checked first (spec E.4: before any write to shared state), so a message
    // that landed during the last task is read before these writes and they account for it: a
    // stop or a pause ends the session `stopped` (a pause defers nothing, no task is left, but
    // the row leaves `paused`), and every message read here is named in the handoff. The task
    // states were written as each task ended; the writes below stay as they are.
    let endInbox: InboxRecheck = { read: [], interrupt: null };
    try {
      endInbox = await this.recheckInbox(agent.id, session.id, emit, heard, { atEnd: true });
    } catch (e) {
      this.logger.warn("inbox re-check before the session-end writes failed", {
        sessionId: session.id,
        error: errorMessage(e),
      });
      await emit("inbox.recheck_failed", { warning: errorMessage(e) });
    }
    const endStop = endInbox.interrupt;
    // Only a session that would otherwise end as completed takes the message as its reason; a
    // session already stopped (killed, out of budget, plan filed) keeps the reason it has.
    const stoppedAtEnd =
      endStop !== null &&
      status === "completed" &&
      (stopReason === "completed" || stopReason === "budget_finish_current");
    if (stoppedAtEnd) stopReason = "stopped_by_message";
    if (endInbox.read.length)
      await emit("session.end_inbox", {
        read: endInbox.read.map((m) => m.id),
        interrupt: endStop ? { id: endStop.id, kind: endStop.kind } : null,
        stopped: stoppedAtEnd,
      });
    // A session that ends before its startup receipts (a startup step failed, the kill switch)
    // never took in what the last session read at its end: it passes those messages on in its
    // own handoff (`carried_forward`), so the next brief still carries them (checklist.ts).
    let carriedForward: InboxRead[] = [];
    if (!inboxTakenIn) {
      try {
        carriedForward = (await carriedFromLastEnd(store, agent.id, new Set())).map((m) => ({
          id: m.id,
          type: m.type,
          from: m.from_agent_id,
          kind: "message" as const,
        }));
      } catch (e) {
        this.logger.warn("messages read at the last session end not carried forward", {
          sessionId: session.id,
          error: errorMessage(e),
        });
        await emit("inbox.carry_failed", { warning: errorMessage(e) });
      }
      if (carriedForward.length)
        await emit("inbox.carried_forward", { ids: carriedForward.map((m) => m.id) });
    }
    await this.ackAnswered(agent.id, emit);
    // Notes and the approved first session are used up only by work that finished (design §4.7):
    // a task done or in review. A session stopped, crashed or that ran nothing leaves them for
    // the next one; before, the first session consumed them at its start, whatever happened.
    // A task whose work the critic took (accepted, or handed to the person for sign-off) counts.
    const finished = new Set([
      ...completed,
      ...inReview,
      ...reviews
        .filter((r) => r.decision !== "revise" && r.decision !== "retry")
        .map((r) => r.taskId),
    ]);
    if (brief && finished.size > 0) {
      try {
        let firstRan = false;
        if (project && plan)
          firstRan = await markFirstSessionRun(
            store,
            project.id,
            session.id,
            plan.items.filter((i) => finished.has(i.taskId)),
          );
        const used = brief.queue.items.filter(
          (q) =>
            (notesGiven.get(q.id) ?? []).some((id) => finished.has(id)) ||
            (firstRan && isFirstSessionItem(q)),
        );
        await this.consumeQueue(used, session, agent, emit);
      } catch (e) {
        this.logger.warn("queue items not marked used", {
          sessionId: session.id,
          error: errorMessage(e),
        });
      }
    }
    const spentTotals = await store.costLedger.sum({ sessionId: session.id });
    const spent = spentTotals.usd_micro;
    // What the person reads is CHF, from the ledger's own conversion (U-074).
    const spentChf = spentTotals.chf_micro;
    // The result (design §5): read from the tasks as they stand now, at most three lines.
    const rate = this.deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD;
    const endState = await collectEndState(store, project?.id ?? null, [
      ...completed,
      ...inReview,
      ...failed,
      ...needsHuman,
      ...reviewFailed,
      ...blockedByFindings,
      ...retried,
      ...skipped,
    ]);
    const named = (id: string): NamedTask => ({
      id,
      title: endState.rows.get(id)?.title ?? plan?.items.find((i) => i.taskId === id)?.title ?? id,
    });
    const uniq = (ids: readonly string[]) => [...new Set(ids)];
    const doneNow = uniq(completed).filter((id) => endState.rows.get(id)?.status === "done");
    const failedNow = uniq(failed).filter((id) => endState.rows.get(id)?.status === "failed");
    // A task the person paused or stopped (the Tasks tab's Pause and Stop: needs_human by
    // them, no card) waits on nobody: it is "Paused by you", not a decision in the Inbox
    // (design §2), and their own click is not news (§5.11).
    const openCards = project
      ? await store.humanRequest.list({ status: "open", project_id: project.id } as never, {
          limit: 1000,
        })
      : [];
    const carded = new Set(
      openCards
        // A card that asks nothing of its task (the project's Docker card) does not hold
        // it: a task the person paused while one was open is "Paused by you" (wave 2).
        .filter((r) => holdsTask(r))
        .map((r) => r.task_id)
        .filter((id): id is string => Boolean(id)),
    );
    const pausedByYou = (id: string) => {
      const row = endState.rows.get(id);
      return !!row && isPausedByPerson(row, carded.has(id));
    };
    const needsYouNow = uniq([...needsHuman, ...reviewFailed, ...blockedByFindings]).filter(
      (id) => {
        const st = endState.rows.get(id)?.status;
        return (st === "needs_human" && !pausedByYou(id)) || st === "in_review";
      },
    );
    const inReviewNow = uniq(inReview).filter(
      (id) => endState.rows.get(id)?.status === "in_review" && !needsYouNow.includes(id),
    );
    // budget-resume: a task paused at a budget is said as a pause, with the limit its card
    // names ("Continue or cancel it in the Inbox"), never as "needs your decision".
    const pausedCards = new Map(
      openCards
        .filter(
          (r) => r.task_id && (r.change_card as { key?: unknown } | null)?.key === BUDGET_STOP_KEY,
        )
        .map((r) => [r.task_id as string, r]),
    );
    const pausedNow = needsYouNow.filter((id) => pausedCards.has(id));
    const leftOutIds = new Set((plan?.leftOutForBudget ?? []).map((i) => i.taskId));
    // U-078: the wait's one sentence, its reset in the person's time zone, true when written.
    const waitOwner = credentialWait
      ? await store.human.get(agent.owner_human_id).catch(() => undefined)
      : undefined;
    const outcome: LastSessionOutcome = {
      done: doneNow.map(named),
      failed: failedNow.map((id) => ({
        ...named(id),
        reason: endState.rows.get(id)?.reason ?? "",
      })),
      needsYou: needsYouNow.filter((id) => !pausedCards.has(id)).map(named),
      ...(pausedNow.length
        ? {
            paused: pausedNow.map((id) => {
              const card = (pausedCards.get(id)?.change_card ?? {}) as Record<string, unknown>;
              const source = budgetCardSource({ change_card: card }) ?? "task_budget";
              return {
                ...named(id),
                limit: limitWords(
                  source,
                  typeof card.cap_usd_micro === "number" ? card.cap_usd_micro : 0,
                  (n) => formatChf(usdToChfMicro(Math.max(0, Math.round(n)), rate)),
                  typeof card.specialist === "string" ? card.specialist : "specialist",
                ),
              };
            }),
          }
        : {}),
      leftOver: endState.readyNow
        .filter((t) => !leftOutIds.has(t.id))
        .map((t) => ({ id: t.id, title: t.title })),
      waiting: endState.waitingNow.map(waitingOf),
      waitingForDocker: waitingForSandbox
        .filter((t) => endState.readyNow.some((r) => r.id === t.id))
        .map((t) => ({ id: t.id, title: t.title })),
      stopReason,
      // The outer limit's amount, while the session still ends there (ADR 0112).
      ...(stopCapUsdMicro !== null && stopLimitWords(stopReason) !== null
        ? { stopCapChfMicro: usdToChfMicro(stopCapUsdMicro, rate) }
        : {}),
      ...(credentialWait
        ? {
            credentialWait: waitSentence(credentialWait, {
              ...(waitOwner?.timezone ? { timezone: waitOwner.timezone } : {}),
              nowMs: clock.now(),
            }),
          }
        : {}),
      spentChfMicro: spentChf,
    };
    const resultFacts = {
      outcome,
      inReview: inReviewNow.map(named),
      leftOutForBudget: (plan?.leftOutForBudget ?? [])
        .filter((i) => endState.readyNow.some((r) => r.id === i.taskId))
        .map((i) => ({
          id: i.taskId,
          title: i.title,
          estimateChfMicro: usdToChfMicro(Math.max(0, Math.round(i.estimateUsdMicro)), rate),
        })),
      sessionCapChfMicro: usdToChfMicro(opts.budgetCapUsdMicro, rate),
      ...(plan?.workBudgetUsdMicro !== undefined
        ? { workBudgetChfMicro: usdToChfMicro(plan.workBudgetUsdMicro, rate) }
        : {}),
      openTasks: endState.openTasks,
      mergedPrs: merges.filter((m) => m.status === "merged").length,
      // merge-in-app: a merge that waits for its checks (or a silent GitHub) merges by itself
      // later, so it is not one the person must merge.
      openPrs: merges.filter((m) => m.status !== "merged" && !MERGE_WAITS.has(m.status)).length,
      waitingPrs: merges.filter((m) => MERGE_WAITS.has(m.status)).length,
    };
    const resultLines = sessionResultLines(resultFacts);
    const summary = resultLines.join("\n");
    // What the session says beyond its cards (design §4.3, §5.10: the person hears once): each
    // open card was notified when it was filed and stands in the Inbox's Needs you, so the
    // Update and the session-end notification leave out what a card says (the session page and
    // the Overview keep the whole result). Before, one failed task was told by its card, by the
    // session end's '"X" needs your decision' and by an Update under the card (phase E, #87).
    const news = sessionResultLines(resultFacts, {
      tasks: carded,
      docker: openCards.some((r) => !holdsTask(r)),
      plan: true,
    }).filter((l) => l.trim().length > 0);
    // Project docs (spec G.5): the PM's status update into docs/status.md, on Forerunner's own
    // status branch and pull request, never on a task's reviewed one (ADR 0106); in a project's
    // folder it is committed with the session's work. A session that touched no task writes
    // nothing, and a failure is an event, never fatal.
    let docsOutcome: SessionStatusOutcome | null = null;
    if (project && this.deps.docs && plan && stopReason !== "plan_awaiting_approval") {
      const touched = [completed, inReview, failed, needsHuman, retried, blockedByFindings].some(
        (l) => l.length > 0,
      );
      if (!touched) {
        await emit("docs.status_skipped", { reason: "no task changed state" });
      } else {
        const items = plan.items;
        const titleOf = (id: string) => items.find((i) => i.taskId === id)?.title ?? id;
        try {
          docsOutcome = await this.deps.docs.writeSessionStatus({
            project,
            session,
            update: {
              sessionId: session.id,
              endedAt: clock.nowIso(),
              done: completed.map(titleOf),
              inFlight: inReviewNow.map(titleOf),
              // What is blocked now (design §4.13): the tasks that need the person, the failed
              // ones, those waiting on another task and those waiting for Docker; before, a
              // whole blocked chain read "Blocked: nothing".
              blocked: [
                ...needsYouNow.map((id) => `${titleOf(id)} (needs your decision)`),
                ...failedNow.map((id) => `${titleOf(id)} (failed)`),
                ...outcome.waiting.map((w) => `${w.title} (waits on ${w.waitsOn.join(" and ")})`),
                ...outcome.waitingForDocker.map((t) => `${t.title} (waits for Docker)`),
              ],
              next: endState.readyNow.map((t) => t.title),
              note: `stop reason ${stopReason}; spent ${formatChf(spentChf)}`,
            },
          });
          await emit("docs.status_written", { ...docsOutcome });
        } catch (e) {
          this.logger.warn("status update not written", {
            sessionId: session.id,
            projectId: project.id,
            error: errorMessage(e),
          });
          await emit("docs.status_failed", { warning: errorMessage(e) });
        }
      }
    }
    // What the re-check before these writes read (spec E.4): ids and kinds, never the words
    // (another agent's message is data); `stopped_by` is the stop or pause this session ended
    // on, null when it ended for another reason. A session that ended on it also says what was
    // and was not written after it was read (`after_stop`, filled in once memory and the
    // promotions below are done, since they are written after the stop was read too).
    const endInboxRecord: {
      read: InboxRead[];
      stopped_by: InboxRead | null;
      after_stop?: { written: string[]; not_written: string[] };
    } | null = endInbox.read.length
      ? { read: endInbox.read, stopped_by: stoppedAtEnd ? endStop : null }
      : null;
    const handoff = {
      // The lines the human said and the task each reached; the words stay in the message
      // rows and the human's own summary message (peers and the project cache read this).
      heard: heard.map((h) => ({
        id: h.id,
        source: h.source,
        said_at: h.saidAt,
        delivered_to: h.deliveredTo,
      })),
      done: completed,
      in_flight: inReview,
      in_flight_files: Object.fromEntries(
        inReview.filter((id) => filesByTask.has(id)).map((id) => [id, filesByTask.get(id)]),
      ),
      blocked: [...needsHuman, ...failed],
      cancelled,
      moved_while_running: movedWhileRunning.map((m) => ({
        task_id: m.taskId,
        status: m.status,
        by_person: m.byPerson,
      })),
      blocked_by_findings: blockedByFindings,
      review_failed: reviewFailed,
      sent_back: retried,
      reviews: reviews.map((r) => ({
        task_id: r.taskId,
        review_id: r.reviewId,
        verdict: r.verdict,
        grade: r.grade,
        decision: r.decision,
      })),
      merges: merges.map((m) => ({
        task_id: m.taskId,
        pr_url: m.prUrl,
        status: m.status,
        merge_sha: m.mergeSha ?? null,
        human_request_id: m.humanRequestId ?? null,
      })),
      next: skipped,
      stop_reason: stopReason,
      ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
      ...(endInboxRecord ? { end_inbox: endInboxRecord } : {}),
      ...(carriedForward.length ? { carried_forward: carriedForward } : {}),
      spent_usd_micro: spent,
      ...(docsOutcome ? { docs: docsOutcome } : {}),
    };
    // Memory (spec G, E.5): what this session learned goes into the agent's private memory:
    // lessons the specialists spelled out, critic findings resolved by rework, and decisions
    // the human answered since the last session. Rejections are reported, never fatal.
    let lessonsRecorded = 0;
    let memoryWritten = false;
    let lessonWarningSent = false;
    if (this.deps.memory) {
      try {
        const decisions = project
          ? await this.decisionsSince(project.id, brief?.lastSession?.endedAt ?? null)
          : [];
        const all: LessonCandidate[] = [
          ...lessonCandidates,
          ...decisions.map((d) => ({
            // One sentence a specialist can use (design §5 "Decision"): the question and the
            // person's answer, never the card's instructions or the form's JSON.
            text: `Decision for ${project?.name ?? "the project"}: ${decisionSentence(d.question, d.chosen)}${d.rationale ? ` (${d.rationale})` : ""}`,
            tags: ["decision", "human"],
            confidence: 0.8,
            source: `session:${session.id};human:${d.decided_by}`,
          })),
        ];
        // The injection gate: a candidate that reads like an instruction (a specialist's
        // report is model output over untrusted content) is dropped here and again inside the
        // port, reported in the session log and quoted to the human, never stored.
        const screened = screenLessons(all, "agent_output");
        const rejectedLessons = [...screened.rejected, ...quarantinedByCritic];
        if (rejectedLessons.length) {
          await emit("memory.lessons_rejected", {
            count: rejectedLessons.length,
            warning: `${rejectedLessons.length} proposed lesson(s) read like instructions and were not stored`,
            lessons: rejectedLessons.map((r) => ({
              text: r.text.slice(0, 300),
              rules: r.rules,
            })),
          });
          await store.message.send({
            from_agent_id: agent.id,
            to_human_id: agent.owner_human_id,
            project_id: project?.id ?? null,
            type: "warning",
            body: describeRejectedLessons(rejectedLessons, `session ${session.id}`),
            requires_ack: false,
            author_agent: agent.id,
          });
          lessonWarningSent = true;
        }
        if (screened.kept.length) {
          const recorded = await this.deps.memory.record({
            agentId: agent.id,
            sessionId: session.id,
            projectId: project?.id ?? null,
            lessons: screened.kept,
          });
          lessonsRecorded = recorded.recorded;
          memoryWritten = recorded.recorded + recorded.merged > 0;
          const rejected = recorded.rejected.length + rejectedLessons.length;
          await emit("memory.recorded", {
            recorded: recorded.recorded,
            merged: recorded.merged,
            rejected,
            quarantined:
              rejectedLessons.length + recorded.rejected.filter((r) => r.injection).length,
            ...(rejected
              ? {
                  warning: `${rejected} lesson(s) rejected: ${recorded.rejected[0]?.error ?? rejectedLessons[0]?.error ?? ""}`,
                }
              : {}),
          });
        } else if (rejectedLessons.length) {
          await emit("memory.recorded", {
            recorded: 0,
            merged: 0,
            rejected: rejectedLessons.length,
            quarantined: rejectedLessons.length,
            warning: `${rejectedLessons.length} lesson(s) rejected: ${rejectedLessons[0]?.error ?? ""}`,
          });
        }
      } catch (e) {
        await emit("memory.record_failed", { warning: errorMessage(e) });
      }
    }
    // Cross-project sharing (spec G.6, ADR 0059): the critic decides this human's pending
    // shared-store proposals now, under the session token and budget, a few per session; an
    // accepting review promotes and files the offers, any other completed one rejects, a run
    // that did not complete leaves the proposal for the next session. Never fatal.
    const promotions = await this.reviewPromotions({
      token,
      budget,
      projectSettings: project?.settings ?? null,
      signal: controller.signal,
      emit,
      agent,
      projectId: project?.id ?? null,
    });
    if (endInboxRecord && stoppedAtEnd)
      endInboxRecord.after_stop = endWritesAccount({
        statusDoc: docsOutcome !== null,
        memory: memoryWritten,
        lessonWarning: lessonWarningSent,
        promotions: (promotions?.promoted ?? 0) + (promotions?.rejected ?? 0) > 0,
        summaryCache: project !== null,
        handoffs: peerIds.length > 0,
      });
    if (project) {
      // Read fresh: what changed on the row during the session (an intake approved meanwhile,
      // the first session marked as run, U-038) is kept, not overwritten by the start's copy.
      const current = (await store.project.get(project.id)) ?? project;
      // Done means done (design §4.13): finished milestones close and the stage follows.
      let stage = current.stage;
      try {
        stage = await closeFinishedWork(store, current, endState.all, agent.id);
      } catch (e) {
        this.logger.warn("milestones and stage not updated", {
          projectId: project.id,
          error: errorMessage(e),
        });
      }
      await store.project.patch(project.id, {
        ...(stage !== current.stage ? { stage } : {}),
        summary_cache: {
          ...(current.summary_cache as Record<string, never>),
          goal: project.goal,
          stage,
          last_session: {
            id: session.id,
            ended_at: clock.nowIso(),
            summary,
            stop_reason: stopReason,
            outcome,
          },
          // What is next, true now (titles, as the intake writes them): the ready tasks, then
          // the ones that wait. Before, this was the planned tasks the session skipped, which
          // is empty whenever the plan ran, so the project read "Nothing planned".
          next_steps: [
            ...endState.readyNow.map((t) => t.title),
            ...endState.waitingNow.map((w) => w.task.title),
          ].slice(0, 3),
          open_questions: needsHuman.filter((id) => !pausedByYou(id)).length,
          spend_usd_micro: (await store.costLedger.sum({ projectId: project.id })).usd_micro,
        } as never,
      });
    }
    for (const peerId of peerIds) {
      await store.message.send({
        from_agent_id: agent.id,
        to_agent_id: peerId,
        project_id: project?.id ?? null,
        type: "handoff",
        body: summary,
        requires_ack: true,
        author_agent: agent.id,
      });
    }
    // One line per session in the Inbox's Updates (design §3.8, §5.10): the result lives on
    // the project; the line names the project and the gist. A session that only filed its plan
    // has a card for that, and one that ran nothing has nothing to say. What the person said
    // during the session is not quoted back (design §5.11: do not echo the person); the session
    // log names the task each line went to (`inbox.heard`, `task.heard`).
    // A session the person stopped (Stop now, Stop all, Quit) before anything finished is
    // their own click, not news (design §3.8, §5.11): the session page says who stopped it.
    const onlyTheirStop =
      personStop !== null &&
      !outcome.done.length &&
      !outcome.failed.length &&
      !outcome.needsYou.length &&
      !inReviewNow.length;
    const update = sessionUpdateLine(
      project?.name ?? null,
      news,
      outcome.needsYou.map((t) => t.title),
    );
    if (
      update &&
      stopReason !== "plan_awaiting_approval" &&
      stopReason !== NOTHING_RUNNABLE &&
      !onlyTheirStop
    ) {
      await store.message.send({
        from_agent_id: agent.id,
        to_human_id: agent.owner_human_id,
        project_id: project?.id ?? null,
        type: "info",
        body: update,
        requires_ack: false,
        author_agent: agent.id,
      });
    }
    const finalStatus: SessionRow["status"] =
      status === "completed" &&
      stopReason !== "completed" &&
      stopReason !== "budget_finish_current" &&
      stopReason !== NOTHING_RUNNABLE
        ? "stopped"
        : status;
    const current = await store.session.mustGet(session.id);
    let contextEnd: ContextSessionEnd | null = null;
    try {
      contextEnd = (await this.deps.context?.endSession(session.id)) ?? null;
    } catch (e) {
      this.logger.warn("context end failed", { sessionId: session.id, error: errorMessage(e) });
    }
    const patched = await store.session.patch(session.id, {
      summary,
      handoff: handoff as never,
      spent_usd_micro: spent,
      steps: budget.snapshot().steps,
      ended_at: clock.nowIso(),
      headroom_saved_tokens: contextEnd?.headroomSavedTokens ?? 0,
    });
    try {
      // A row a pause left `paused` (the pause port marks it at once) cannot move straight to
      // `failed` or `completed`; it goes back through `running`, or it would stay `paused`
      // with `ended_at` set and every later session of the agent would be refused as active.
      const row =
        patched.status === "paused" && !SESSION_TRANSITIONS.paused.includes(finalStatus)
          ? await store.session.setStatus(patched.id, patched.version, "running")
          : patched;
      await store.session.setStatus(row.id, row.version, finalStatus);
    } catch {
      // already terminal (e.g. killed by the kill switch callback)
    }
    void current;
    // Session review (H.6): the critic checks the plan, the spend and the honesty of the
    // summary the human just received; a false count ends with the human. Runs after the
    // summary and the task states are written, since that is what it checks. A session that
    // only filed its plan did no work to review.
    let sessionReview: SessionReviewOutcome | null = null;
    // A session that ended no task one way or another (stopped in its first seconds, nothing
    // planned) did no work to grade (design §4.8): before, it read "Session review: accepted
    // (grade 100)".
    const endedAnyTask = [
      completed,
      inReview,
      failed,
      needsHuman,
      retried,
      blockedByFindings,
      cancelled,
      reviewFailed,
    ].some((l) => l.length > 0);
    if (
      this.deps.critic &&
      endedAnyTask &&
      stopReason !== "plan_awaiting_approval" &&
      stopReason !== NOTHING_RUNNABLE
    ) {
      try {
        sessionReview = await this.deps.critic.reviewSession({
          sessionId: session.id,
          token,
          budget,
          agentId: agent.id,
          projectId: project?.id ?? null,
        });
        await emit(
          "critic.session_review",
          {
            reviewId: sessionReview.reviewId,
            tier: sessionReview.tier,
            grade: sessionReview.grade,
            confidence: sessionReview.confidence,
            verdict: sessionReview.verdict,
            findings: sessionReview.findings.length,
            summary: sessionReview.summary,
            ...(sessionReview.verdict === "human"
              ? { escalation: true, warning: "the session review needs the human" }
              : {}),
            // The card the critic filed for it is the one notification (design §4.3): the
            // daemon tells an escalation only when no request of its own was filed. Without
            // the id, a session review that asked the person was told twice.
            ...(sessionReview.humanRequestId
              ? { humanRequestId: sessionReview.humanRequestId }
              : {}),
          },
          sessionReview.costUsdMicro,
        );
      } catch (e) {
        await emit("critic.session_review_failed", { warning: errorMessage(e) });
      }
    }
    // A task the critic sent back whose rework was still queued when the session ended is one
    // task, counted once: sent back, not also "not started" (U-072). It stays in the handoff's
    // `next`, where the next session and the peers read what is left.
    const notStarted = [...new Set(skipped)].filter((id) => !retried.includes(id));
    // A task sent back and then accepted, failed or handed to the person in this same session
    // is counted where it ended, once (design §4.3: the rework runs in the session).
    const sentBackNow = retried.filter(
      (id) => !completed.includes(id) && !failed.includes(id) && !needsHuman.includes(id),
    );
    await emit("session.ended", {
      status: finalStatus,
      stopReason,
      // The person's stop was said by its own line (`session.stopped`): the end line after it
      // says only what it adds (phase E, C-42: "Stopped by you during …" then "Stopped by you:
      // nothing done. CHF 0.00.").
      ...(personStop ? { stopSaid: true } : {}),
      spentUsdMicro: spent,
      completed: completed.length,
      inReview: inReview.length,
      failed: failed.length,
      // What needs the person now, as the result says it: a task the person paused is theirs,
      // not "needs you" (design §2).
      needsHuman: needsYouNow.length,
      cancelled: cancelled.length,
      reviewFailed: reviewFailed.length,
      skipped: notStarted.length,
      retried: sentBackNow.length,
      blockedByFindings: blockedByFindings.length,
      lessonsRecorded,
      sessionReviewGrade: sessionReview?.grade ?? null,
      compressionSavedTokens: contextEnd?.compression.saved ?? 0,
      headroomSavedTokens: contextEnd?.headroomSavedTokens ?? 0,
      headroomUsed: contextEnd?.selection.headroomUsed ?? false,
    });
    return {
      sessionId: session.id,
      status: finalStatus,
      brief: brief as StateBrief,
      plan,
      completed,
      inReview,
      failed,
      skipped: notStarted,
      needsHuman,
      cancelled,
      movedWhileRunning,
      reviewFailed,
      retried,
      blockedByFindings,
      reviews,
      merges,
      memory: memoryLoaded
        ? {
            tokens: memoryLoaded.tokens,
            budget: memoryBudget,
            lessons: memoryLoaded.lessonIds.length,
          }
        : null,
      lessonsRecorded,
      promotions,
      sessionReview,
      spentUsdMicro: spent,
      spentChfMicro: spentChf,
      steps: budget.snapshot().steps,
      summary,
      news,
      handoff,
      stopReason,
      ...(outcome.stopCapChfMicro !== undefined
        ? { stopCapChfMicro: outcome.stopCapChfMicro }
        : {}),
      heard,
    };
  }

  /**
   * The watch of a running task's row (U-039): every `taskWatchMs` the row is read, and a task
   * no longer `in_progress` (a person moved it through the phone, Chat or another device's
   * daemon) has its runs stopped through the kill switch, which aborts `signal`'s controller
   * too. Returns the function that ends the watch; nothing is scheduled after it is called.
   */
  private watchTask(taskId: string, signal: AbortSignal): () => void {
    const { store, clock, kill } = this.deps;
    const every = Math.max(1, this.deps.taskWatchMs ?? DEFAULT_TASK_WATCH_MS);
    let watching = true;
    let cancel: () => void = () => undefined;
    const schedule = () => {
      if (!watching || signal.aborted) return;
      cancel = clock.setTimeout(() => {
        void store.task.get(taskId).then(
          (row) => {
            if (!watching || signal.aborted) return;
            if (row && row.status !== "in_progress") {
              kill.stopTask(taskId, `task moved to ${row.status} while it ran`);
              return;
            }
            schedule();
          },
          (e: unknown) => {
            this.logger.warn("task watch read failed", { taskId, error: errorMessage(e) });
            schedule();
          },
        );
      }, every);
    };
    schedule();
    return () => {
      watching = false;
      cancel();
    };
  }

  /**
   * One task through the critic at its tier (spec H). The port applies the verdict through the
   * state workflow and returns the decision; a port failure is returned as a `ReviewFailure`,
   * which the runner turns into a card for the person (U-045), never swallowed.
   */
  private async reviewTask(
    req: Parameters<CriticPort["reviewTask"]>[0] & {
      emit: (t: string, p: Record<string, unknown>, cost?: number) => Promise<void>;
      /**
       * The specialist that ran the reviewed attempt: the retry ladder's stand-in after a
       * hand-over (U-044), while `item` stays the plan's (its review level and sign-off, ADR
       * 0108). The verdict's line names it ("The migration specialist could not do …").
       */
      ranBy: string;
    },
  ): Promise<TaskReviewOutcome | ReviewFailure | null> {
    const { emit, ranBy, ...request } = req;
    const critic = this.deps.critic;
    if (!critic) return null;
    await emit("critic.review_started", {
      taskId: request.task.id,
      tier: request.task.risk_tier,
      attempt: request.task.attempt,
    });
    let outcome: TaskReviewOutcome;
    try {
      outcome = await critic.reviewTask(request);
    } catch (e) {
      // The caller files the card and reports it (U-045).
      return { failed: true, error: errorMessage(e) };
    }
    // A run that said it could not do the work: the verdict's line quotes it, so the session log
    // tells the attempt in one line (design §5, "Log line").
    const couldNot =
      request.result.outcome === "done" || request.result.outcome === "in_review"
        ? couldNotWords(request.result.summary)
        : null;
    await emit(
      "critic.verdict",
      {
        taskId: request.task.id,
        title: request.task.title,
        specialist: ranBy,
        ...(couldNot !== null ? { couldNot } : {}),
        reviewId: outcome.reviewId,
        tier: outcome.tier,
        verdict: outcome.verdict,
        grade: outcome.grade,
        confidence: outcome.confidence,
        findings: outcome.findings.length,
        openFindings: outcome.openFindings,
        decision: outcome.decision,
        attempt: outcome.attempt,
        ...(outcome.retry ? { retry: outcome.retry } : {}),
        ...(outcome.nextTier ? { nextTier: outcome.nextTier } : {}),
        ...(outcome.humanRequestId ? { humanRequestId: outcome.humanRequestId } : {}),
        ...(outcome.decision === "human" || outcome.retry === "escalate"
          ? { escalation: true }
          : {}),
        ...(outcome.decision === "blocked_by_findings"
          ? {
              warning: `cannot close "${request.task.title}": ${outcome.openFindings} finding(s) from an earlier review still open`,
            }
          : {}),
        summary: outcome.summary.slice(0, 400),
      },
      outcome.costUsdMicro,
    );
    return outcome;
  }

  /**
   * The merge of an accepted task's pull request (spec J.9) through the merge port; a port
   * failure leaves the PR open and is surfaced as an event, never fatal to the session.
   */
  private async mergeReviewed(
    req: MergeRequest & {
      emit: (t: string, p: Record<string, unknown>, cost?: number) => Promise<void>;
    },
  ): Promise<MergeOutcome | null> {
    const { emit, ...request } = req;
    const port = this.deps.merge;
    if (!port || !request.task.pr_url) return null;
    let outcome: MergeOutcome | null;
    try {
      outcome = await port.mergeReviewed(request);
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "killed") throw e;
      await emit("pr.merge_failed", {
        taskId: request.task.id,
        prUrl: request.task.pr_url,
        warning: `merge step failed, PR left open: ${errorMessage(e)}`,
      });
      return null;
    }
    if (!outcome) return null;
    await emit(outcome.status === "merged" ? "pr.merged" : "pr.left_open", {
      taskId: outcome.taskId,
      prUrl: outcome.prUrl,
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.mergeSha ? { mergeSha: outcome.mergeSha } : {}),
      ...(outcome.rebased ? { rebased: true } : {}),
      ...(outcome.humanRequestId
        ? { humanRequestId: outcome.humanRequestId, warning: outcome.reason }
        : {}),
    });
    return outcome;
  }

  /**
   * A close the store refused over open findings (B.4): the task stays in review and the human
   * gets one blocking request (rework, accept the findings as resolved, cancel); the answer
   * is applied by `syncBlockedByFindings` from the inbox. Surfaced as an event either way.
   */
  private async blockedByFindings(input: {
    task: TaskRow;
    session: SessionRow;
    agentId: string;
    humanId: string;
    runId: string | null;
    path: "tier0" | "critic_accept";
    emit: (t: string, p: Record<string, unknown>) => Promise<void>;
  }): Promise<void> {
    const { store } = this.deps;
    const findings = await store.finding.openFor(input.task.id);
    let humanRequestId: string | null = null;
    let reused = false;
    try {
      const filed = await fileBlockedByFindingsRequest({
        store,
        task: input.task,
        session: input.session,
        humanId: input.humanId,
        agentId: input.agentId,
        runId: input.runId,
        findings,
        path: input.path,
      });
      humanRequestId = filed.request.id;
      reused = filed.reused;
    } catch (e) {
      this.logger.warn("blocked-findings request not filed", {
        taskId: input.task.id,
        error: errorMessage(e),
      });
    }
    await input.emit("task.blocked_by_findings", {
      taskId: input.task.id,
      title: input.task.title,
      path: input.path,
      warning: `cannot close "${input.task.title}": ${findings.length} open critic finding(s) remain${
        humanRequestId ? "; asked you to rework, accept or cancel" : ""
      }`,
      findings: findings.map((f) => f.id),
      exit: humanRequestId ? "human_request" : "manual",
      humanRequestId,
      reused,
      escalation: true,
    });
  }

  /**
   * Mark the next-session queue items the brief carried consumed by this session (spec J.2):
   * exactly those items, each at the version the checklist read them, in one store
   * transaction with one `queue.consumed` audit row (ids and the session, never the text) and
   * a `queue.consumed` event. Every item goes through `QueueRepo.consume`, so the workflow
   * graph (`queued -> consumed`; a dismissed item is never consumed) and the version are
   * checked in the store: an item the human dismissed or edited in the UI while the checklist
   * ran fails its own check, is skipped with the reason and left as it is (an edited note
   * reaches the next session once more, with its new text). An item enqueued after the
   * checklist read the queue is not in the brief and stays queued for the next session. Runs
   * after the brief is written and before the plan; a session that fails earlier never gets
   * here, so it consumes nothing.
   */
  private async consumeQueue(
    items: StateBrief["queue"]["items"],
    session: SessionRow,
    agent: AgentRow,
    emit: (type: string, payload?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    const { store, clock } = this.deps;
    const outcome = await store.transaction(async (tx) => {
      const consumed: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const item of items) {
        try {
          await tx.queue.consume(item.id, item.version, session.id);
          consumed.push(item.id);
        } catch (e) {
          if (!isForerunnerError(e) || !QUEUE_SKIP_CODES.has(e.code)) throw e;
          skipped.push({ id: item.id, reason: e.code });
        }
      }
      await tx.auditLog.append({
        session_id: session.id,
        agent_id: agent.id,
        human_id: agent.owner_human_id,
        tool: QUEUE_CONSUMED_AUDIT_TOOL,
        input_summary: JSON.stringify({ sessionId: session.id, items: items.map((i) => i.id) }),
        result_summary: JSON.stringify({ consumed, skipped }),
        allowed: true,
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
      });
      return { consumed, skipped };
    });
    if (outcome.skipped.length)
      this.logger.warn("queue items moved while the checklist ran", {
        sessionId: session.id,
        skipped: outcome.skipped,
      });
    await emit("queue.consumed", {
      ids: outcome.consumed,
      count: outcome.consumed.length,
      skipped: outcome.skipped,
      ...(outcome.skipped.length
        ? {
            warning: `${outcome.skipped.length} queue item(s) changed while the checklist ran and stay as they are`,
          }
        : {}),
    });
  }

  /**
   * The promotion step of the session end (spec G.6); null when either port lacks it. A
   * proposal the critic declined is gone from the memory page's "waiting" list, so the human is
   * told in one non-blocking warning (as for lessons the injection gate refused): the verdict,
   * the critic's summary, the lesson and the recourse (edit it, share it again).
   */
  private async reviewPromotions(args: {
    token: SignedToken;
    budget: SessionBudget;
    projectSettings: JsonObject | null;
    signal: AbortSignal;
    emit: (type: string, payload: Record<string, unknown>, cost?: number) => Promise<void>;
    agent: AgentRow;
    projectId: string | null;
  }): Promise<PromotionTally | null> {
    const memory = this.deps.memory;
    const critic = this.deps.critic;
    if (!memory?.pendingPromotions || !memory.resolvePromotion || !critic?.reviewPromotion)
      return null;
    const tally: PromotionTally = { reviewed: 0, promoted: 0, rejected: 0, pending: 0, offered: 0 };
    let pending: Awaited<ReturnType<NonNullable<MemoryPort["pendingPromotions"]>>>;
    try {
      pending = (await memory.pendingPromotions()).slice(0, MAX_PROMOTION_REVIEWS_PER_SESSION);
    } catch (e) {
      await args.emit("memory.promotion_failed", { warning: errorMessage(e) });
      return tally;
    }
    for (const candidate of pending) {
      if (args.signal.aborted) break;
      try {
        const review = await critic.reviewPromotion({
          lesson: candidate,
          token: args.token,
          budget: args.budget,
          projectSettings: args.projectSettings,
          signal: args.signal,
        });
        tally.reviewed++;
        const resolved = await memory.resolvePromotion(candidate.id, review);
        tally[resolved.status]++;
        tally.offered += resolved.offers.length;
        if (resolved.status === "rejected") {
          try {
            await this.deps.store.message.send({
              from_agent_id: args.agent.id,
              to_human_id: args.agent.owner_human_id,
              project_id: args.projectId,
              type: "warning",
              body: describeRejectedPromotion(candidate, review),
              requires_ack: false,
              author_agent: args.agent.id,
            });
          } catch (e) {
            this.logger.warn("declined promotion not reported to the human", {
              lessonId: candidate.id,
              error: errorMessage(e),
            });
          }
        }
        await args.emit(
          "memory.promotion",
          {
            lessonId: candidate.id,
            reviewId: review.reviewId,
            verdict: review.verdict,
            grade: review.grade,
            confidence: review.confidence,
            status: resolved.status,
            offers: resolved.offers.length,
            summary: review.summary,
            ...(resolved.status === "pending"
              ? { warning: "the promotion review did not complete; the proposal waits" }
              : {}),
          },
          review.costUsdMicro,
        );
      } catch (e) {
        await args.emit("memory.promotion_failed", {
          lessonId: candidate.id,
          warning: errorMessage(e),
        });
      }
    }
    return tally;
  }

  /** Decisions the human answered on the project since the last session ended (for memory). */
  private async decisionsSince(
    projectId: string,
    sinceIso: string | null,
  ): Promise<{ question: string; chosen: string; rationale: string; decided_by: string }[]> {
    const rows = await this.deps.store.decision.current(projectId);
    // A row from before the per-question rows is read as its plain pairs (`plainRows`).
    return rows
      .filter((d) => !sinceIso || d.created_at > sinceIso)
      .flatMap((d) => plainRows(d).map((pair) => ({ ...d, ...pair })));
  }

  /**
   * Inbox re-check between tasks: a human "stop" message stops the session; questions become
   * requests. A line the human said during this session (spec O.9, `heardLineOf`) is collected
   * into `heard` as delivered and stays unread until a task's brief carries it: one that no
   * task follows reaches the next session's brief like any unread message. A stop or pause
   * the session obeys is acted on by stopping (`acted_at`), whatever its type.
   *
   * `atEnd` is the re-check before the session-end writes (spec E.4): no task follows, so a
   * said line is left untouched for the next session's brief, and an ordinary message is read
   * but not acted on (the next session's brief carries it, `checklist.ts`).
   */
  private async recheckInbox(
    agentId: string,
    sessionId: string,
    emit: (t: string, p: Record<string, unknown>) => Promise<void>,
    heard: HeardDelivery[],
    opts: { atEnd?: boolean } = {},
  ): Promise<InboxRecheck> {
    const unread = await this.deps.store.message.inbox(
      { agentId },
      { unreadOnly: true, limit: 50 },
    );
    const read: InboxRead[] = [];
    let interrupt: InboxRead | null = null;
    for (const m of unread) {
      const said = heardLineOf(m.body);
      if (said && said.sessionId === sessionId && m.from_agent_id === agentId) {
        if (opts.atEnd || heard.some((h) => h.id === m.id)) continue;
        await this.deps.store.message.markDelivered(m.id);
        heard.push({
          id: m.id,
          source: said.source,
          text: said.text,
          saidAt: m.created_at,
          deliveredTo: null,
        });
        await emit("inbox.heard", { id: m.id, source: said.source, sessionId });
        continue;
      }
      await this.deps.store.message.markDelivered(m.id);
      await this.deps.store.message.markRead(m.id);
      const word = m.type === "handoff" ? null : STOP_WORD_RE.exec(m.body)?.[1]?.toLowerCase();
      const entry: InboxRead = {
        id: m.id,
        type: m.type,
        from: m.from_agent_id,
        kind: word === "pause" ? "pause" : word ? "stop" : "message",
      };
      read.push(entry);
      if (entry.kind !== "message") interrupt ??= entry;
      // The log names the sender, never only its id (U-074).
      const fromName = m.from_agent_id
        ? ((await this.deps.store.agent.get(m.from_agent_id))?.name ?? null)
        : null;
      await emit("inbox.message", {
        id: m.id,
        type: m.type,
        from: m.from_agent_id,
        fromName,
        sessionId,
      });
      // At the end no plan follows to take an ordinary message in: it is read and named in the
      // handoff, and the next session's brief carries it and acts on it (checklist.ts).
      const actByReading = !opts.atEnd && ACK_BY_READING.has(m.type);
      if (m.requires_ack && (entry.kind !== "message" || actByReading)) {
        await this.deps.store.message.markActed(m.id);
        await emit("inbox.acted", {
          id: m.id,
          type: m.type,
          ...(entry.kind !== "message"
            ? { [entry.kind === "pause" ? "paused" : "stopped"]: true }
            : {}),
        });
      }
    }
    return { read, interrupt };
  }

  /** Questions and requests are acted on once this agent replied to them. */
  private async ackAnswered(
    agentId: string,
    emit: (t: string, p: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const received = await this.deps.store.message.inbox({ agentId }, { limit: 200 });
    for (const m of received) {
      if (!m.requires_ack || m.acted_at || ACK_BY_READING.has(m.type)) continue;
      const replies = await this.deps.store.message.replies(m.id);
      if (replies.some((r) => r.from_agent_id === agentId)) {
        await this.deps.store.message.markActed(m.id);
        await emit("inbox.acted", { id: m.id, type: m.type, replied: true });
      }
    }
  }
}

/** Longest reason recorded on a session plan change; the planner's summary is cut to it. */
export const MAX_PLAN_REASON_CHARS = 500;

/** The reason a session plan change carries (spec B.5): the planner's summary, or a plain default. */
export function planReason(plan: Pick<SessionPlan, "summary">): string {
  const summary = plan.summary.trim();
  const reason = summary === "" ? "planned from the brief" : summary;
  return reason.length > MAX_PLAN_REASON_CHARS
    ? `${reason.slice(0, MAX_PLAN_REASON_CHARS - 1)}…`
    : reason;
}

/**
 * The plan within the work budget (U-040): items are taken in the planner's order, and one
 * that does not fit what is left is left out while the smaller ones after it still go in
 * (before, the first item that did not fit ended the plan, so one large task emptied it). The
 * items left out are on the plan as `leftOutForBudget`, in order, for the summary to name.
 */
export function cutPlanToBudget(plan: SessionPlan, workBudgetUsdMicro: number): SessionPlan {
  const items: PlanItem[] = [];
  const leftOut: PlanItem[] = [];
  let total = 0;
  for (const item of plan.items) {
    if (total + item.estimateUsdMicro > workBudgetUsdMicro) {
      leftOut.push(item);
      continue;
    }
    items.push(item);
    total += item.estimateUsdMicro;
  }
  return {
    items,
    estimateUsdMicro: total,
    summary:
      leftOut.length > 0
        ? `${plan.summary} (${leftOut.length} item(s) cut to fit the budget)`
        : plan.summary,
    ...(leftOut.length > 0 ? { leftOutForBudget: leftOut, workBudgetUsdMicro } : {}),
  };
}

/**
 * What a session that ended on a stop or pause read before the session-end writes still wrote
 * after reading it, and what it did not (spec E.4): the record of the session is written so the
 * next session and the peers know where it stopped; no further task is claimed or started.
 */
function endWritesAccount(x: {
  statusDoc: boolean;
  memory: boolean;
  lessonWarning: boolean;
  promotions: boolean;
  summaryCache: boolean;
  handoffs: boolean;
}): {
  written: string[];
  not_written: string[];
} {
  const written = ["task_states"];
  const notWritten = ["task_claims"];
  (x.statusDoc ? written : notWritten).push("status_doc");
  (x.memory ? written : notWritten).push("memory");
  (x.lessonWarning ? written : notWritten).push("lesson_warning");
  (x.promotions ? written : notWritten).push("promotions");
  (x.summaryCache ? written : notWritten).push("summary_cache");
  (x.handoffs ? written : notWritten).push("handoffs");
  written.push("human_note", "session_record");
  return { written, not_written: notWritten };
}

/**
 * Peers for handoffs: the project's explicit members (settings.members, agent ids) when set,
 * otherwise every other active principal agent that has touched the project (tasks, claims,
 * sessions).
 */
export function defaultPeers(store: StateStore) {
  return async (agentId: string, projectId: string | undefined): Promise<string[]> => {
    if (!projectId) return [];
    const project = await store.project.mustGet(projectId);
    const all = await store.agent.list({ kind: "principal", status: "active" } as never, {
      limit: 100,
    });
    const members = (project.settings as { members?: unknown }).members;
    if (Array.isArray(members) && members.length) {
      return all.filter((a) => a.id !== agentId && members.includes(a.id)).map((a) => a.id);
    }
    const touched = new Set<string>();
    for (const t of await store.task.list({ project_id: projectId } as never, { limit: 1000 })) {
      if (t.author_agent) touched.add(t.author_agent);
      if (t.claimed_by) touched.add(t.claimed_by);
      if (t.owner_agent_id) touched.add(t.owner_agent_id);
    }
    for (const s of await store.session.forProject(projectId, { limit: 1000 }))
      touched.add(s.agent_id);
    return all.filter((a) => a.id !== agentId && touched.has(a.id)).map((a) => a.id);
  };
}

/**
 * Plans the ready tasks in priority order; no model call. With an `EstimatePort` the learned
 * estimate (actual-versus-estimate per specialist and task kind, spec I) prices each item,
 * otherwise the task's own estimate, its budget or the default.
 */
export class StaticPlanner implements Planner {
  constructor(
    private readonly defaultEstimateUsdMicro = 500_000,
    private readonly estimates?: EstimatePort,
  ) {}
  async plan(ctx: PlannerContext): Promise<SessionPlan> {
    const free = ctx.readyTasks.filter(
      (t) => !t.claimed_by || (t.claim_expires && t.claim_expires < ctx.brief.generatedAt),
    );
    // The first-session plan approved with the project's intake decides the first session: its
    // ready tasks, in the approved order (U-038); after it ran, priority order.
    const first = firstSessionPlan(ctx.brief.project?.summary, free);
    const ordered = first
      ? first.tasks
      : free.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
    const items = ordered.map((t) => ({
      taskId: t.id,
      title: t.title,
      specialist: t.specialist ?? "coder",
      estimateUsdMicro: this.estimates
        ? planEstimateUsdMicro(this.estimates, t)
        : withinTaskBudget(
            t.est_cost_usd_micro || t.budget_usd_micro || this.defaultEstimateUsdMicro,
            t,
          ),
    }));
    return {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      summary: first
        ? `the first session you approved with the project plan: ${items.length} task(s) in its order`
        : `${items.length} ready task(s) in priority order`,
    };
  }
}
