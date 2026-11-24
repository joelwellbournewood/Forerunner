import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import { reviseCause } from "@forerunner/critic";
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
import {
  REVIEW_RESUMED_EVENT,
  TASK_CHECK_LEFT_OUT_EVENT,
  TASK_CHECKED_EVENT,
  TASK_CONTINUES_EVENT,
  TOOK_LARGER_EVENT,
} from "../daemon/event-audience.ts";
import { couldNotWords } from "../daemon/event-lines.ts";
import {
  cardKindOf,
  holdsTask,
  isDockerCard,
  isPausedByPerson,
  withoutNoActionGiven,
} from "../daemon/task-words.ts";
import type { AutonomyLevel } from "../enforcement/autonomy.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import type { KillSwitch } from "../enforcement/killswitch.ts";
import type { SignedToken, TokenIssuer } from "../enforcement/token.ts";
import {
  type EstimatePort,
  estimateLeftUsdMicro,
  KEPT_WORK_OUTCOMES,
  type KeptWork,
  keptWorkFor,
  withinTaskBudget,
} from "../estimates/model.ts";
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
import { isCodeChange } from "../loop/project-checks.ts";
import { isSandboxNotReady } from "../sandbox/readiness.ts";
import type { SchemaSyncPort } from "../update/sync.ts";
import { decisionSentence, plainRows } from "../wiring/state-ports.ts";
import {
  BILLING_BACK_EVENT,
  BILLING_FALLBACK_EVENT,
  BILLING_SWITCH_EVENT,
  type RunSwitch,
} from "./billing.ts";
import { renderStateBrief, type StateBrief } from "./brief.ts";
import {
  BUDGET_STOP_KEY,
  budgetCardSource,
  budgetStopTitle,
  closeByStart,
  continuableTasks,
  fileBudgetStopCard,
  offersContinue,
} from "./budget-card.ts";
import {
  type BudgetStopSource,
  handoffOf,
  type KeptCheck,
  keptArtifact,
  keptOf,
  limitWords,
  madeProgress,
  pauseSaid,
  REVIEW_PAUSED_EVENT,
  type RunHandoff,
  reviewPausedWords,
  stopEndsSession,
} from "./budget-pause.ts";
import { fileCannotRunCard, plainStopReason } from "./cannot-run-card.ts";
import { type ChecklistInput, carriedFromLastEnd, runStartupChecklist } from "./checklist.ts";
import { CREDENTIAL_ASK_KEY } from "./credential-ask.ts";
import { type SessionSwitchRow, sessionSwitches } from "./credential-switch.ts";
import {
  CREDENTIAL_REFUSED_KEY,
  CREDENTIAL_WAIT_REASON,
  CREDENTIAL_WAIT_STOP,
  type CredentialWait,
  clockTime,
  goesOnAtWords,
  stoppedRunSentence,
  stopReasonOf,
  waitSentence,
} from "./credential-wait.ts";
import { backLogLine, switchRunLine } from "./credential-words.ts";
import {
  fileBlockedByFindingsRequest,
  fileFailedTaskCard,
  fileReviewFailedRequest,
} from "./findings.ts";
import { describeRejectedLessons, type RejectedLesson, screenLessons } from "./lessons.ts";
import { type HeardDelivery, type HeardLine, heardLineOf } from "./live-chat.ts";
import type { AdmitHandle, AdmitOutcome, LiveSessions } from "./live-sessions.ts";
import { moneyWords } from "./money-words.ts";
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
import { cutFollowers, followersOf } from "./promise.ts";
import { namesOf } from "./recovery.ts";
import {
  closeFinishedWork,
  collectEndState,
  type LastSessionOutcome,
  MERGE_WAITS,
  type NamedTask,
  sessionResultLines,
  sessionUpdateLine,
  type TaskChangeFact,
  taskCheckLeftOutLine,
  waitingOf,
} from "./result.ts";
import {
  clearPending,
  keepPending,
  keptResult,
  latestWorkRun,
  pendingOfRun,
  reviewPendingOf,
  workHash,
} from "./review-pending.ts";
import { type ReviewRefusal, reviewRefusalOf } from "./review-refusal.ts";
import {
  needsContainerSandbox,
  type SandboxGate,
  type SandboxGateAnswer,
  type SandboxWaitingTask,
  summarizeSandboxWaiting,
} from "./sandbox-gate.ts";
import {
  budgetStopReasonOf,
  endedStatusText,
  type PersonStop,
  personStopOf,
  stopLimitWords,
  taskReasonForStop,
} from "./stop-words.ts";
import {
  checkAtBoundary,
  TASK_CHECKS_PER_SESSION,
  type TaskCheckRunnerPort,
} from "./task-check.ts";
import {
  keepNotes,
  keptNotesOf,
  notCausedByTask,
  reviewNoteLines,
  type TaskListLine,
  type TaskListNote,
  takeNotes,
} from "./task-list-notes.ts";
import { type StartBy, startByOf } from "./triggers.ts";
import type { WebSource } from "./web-sources.ts";

/**
 * Who asked for a session, kept on its plan (`plan.startedBy`, d1109-starts-engine S-1): who, and
 * for a session that goes on with an earlier one (S-10) that session and its start time in the
 * person's zone, which the Sessions list says ("goes on with your session of 14:05").
 */
export interface SessionStartedBy {
  by: StartBy;
  continues?: string;
  continuesAt?: string;
}

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

/** S-6: the session's promise at its start (`{ taskIds, estimateUsdMicro, afterLarge? }`). */
export const PROMISED_EVENT = "session.promised";
/** S-7: work prepared outside the session joined it (`{ taskId, title, estimateUsdMicro, by }`). */
export const JOINED_EVENT = "session.joined";
/** S-7: work that asked to join and did not fit, at the session's end (`{ tasks }`). */
export const LEFT_FOR_NEXT_START_EVENT = "session.left_for_next_start";
/**
 * d1109-selftasks-run (ADR 0119): one task check at a boundary. l4-selftasks-108: a person line
 * with its cost on its row (`event-audience.ts`, where the constant now lives).
 */
export { TASK_CHECKED_EVENT };
/** S-10: the session goes on with the person's earlier one (`{ continues, at }`). */
export const CONTINUES_EVENT = "session.continues";

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
  /**
   * L3-run-2: the session took this task again after planning it once (the critic sent it
   * back, its run failed and is tried again, the larger task came back ready). The item records
   * the attempt; its figure is not added to the plan's (`SessionPlan.estimateUsdMicro` stays
   * what the person was shown), and the session review counts the task once.
   */
  again?: boolean;
  /**
   * D4 (d1109-oversize-pause, OP-0): set on the item of a task whose figure alone is more than
   * the work budget, which the plan takes at its place with the room left: its whole figure, its
   * `estimateUsdMicro` being that room (what the session review measures it against).
   */
  wholeEstimateUsdMicro?: number;
  /**
   * d1116-budget-all (BA-4): the room the task's review needs in its own budget, set before each
   * work run of a task with a budget of its own: the review part of its estimate (`R`,
   * `Planner.reviewPartOf`) plus one critic call's worst case (`W`,
   * `CriticPort.reviewCallUsdMicro`). The executor keeps it out of the run's cap when the budget
   * left can hold it (`workRunCapOf`). Absent: nothing kept.
   */
  reviewRoomUsdMicro?: number;
}

/** A plan's summary with how many of its items the budget cut, when it cut any. */
function cutClause(summary: string, cut: number): string {
  return cut > 0
    ? `${summary} (${cut} ${cut === 1 ? "item" : "items"} cut to fit the budget)`
    : summary;
}

/**
 * Why a ready task was left out of a session's plan for its budget (U-040; D4, the owner's
 * decision of 2026-11-09, ordered by the owner's answer 5 of 2026-11-09): `after_others`, it fits
 * the work budget but not after the tasks before it; `after_large`, it comes after a task larger
 * than the work budget in the plan's order, which works until the wrap-up line (the session's own:
 * a re-plan takes it if that task leaves room, else it waits for the next session); `no_room`,
 * its figure alone is more than the work budget and the tasks before it leave less than a fifth
 * of it (`OVERSIZED_MIN_ROOM_SHARE`). (d1109-oversize-start's `one_large`, a second such task, is
 * gone: it comes after the first, `after_large`.)
 */
export type LeftOutReason = "after_others" | "after_large" | "no_room";

/** A planned item left out for the budget, with why (absent on a plan written before D4). */
export interface LeftOutItem extends PlanItem {
  reason?: LeftOutReason;
  /** `after_large`: the title of the larger task it comes after. */
  after?: string;
}

export interface SessionPlan {
  items: PlanItem[];
  estimateUsdMicro: number;
  summary: string;
  /** Planned items that did not fit the work budget (`cutPlanToBudget`, U-040), in order. */
  leftOutForBudget?: LeftOutItem[];
  /** The work budget the plan was cut to, set with `leftOutForBudget` or `oversized`. */
  workBudgetUsdMicro?: number;
  /**
   * D4: the ready task whose figure alone is more than the work budget that the plan takes at its
   * place in the planner's order (d1109-oversize-pause, OP-0), with that whole figure and the room
   * it gets (`roomUsdMicro`: its item in `items` carries that room as its planned figure). The
   * last such task the session took when a re-plan took another.
   */
  oversized?: PlanItem & { roomUsdMicro?: number };
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
  /**
   * D4 (d1109-oversize-start): the work a task's paused runs kept (`keptWorkFor` over the
   * store), so a task that resumes from it is planned at what is left of its estimate. Absent:
   * every task at its whole estimate.
   */
  keptWork?(task: TaskRow): Promise<KeptWork | null>;
}

export interface Planner {
  plan(ctx: PlannerContext): Promise<SessionPlan>;
  /**
   * d1109-oversize-pause (OP-6, OP-8): the whole estimate the plan prices a task from (the learned
   * estimate, else its own figure, its budget or the default), before its kept work is counted.
   * A pause's card stores it and what is left of it, so the card's Continue and the next Start
   * price the task alike. Absent: the task's own figure.
   */
  wholeEstimateOf?(task: TaskRow): number | undefined;
  /**
   * d1116-budget-all: the review part of the task's whole estimate (`EstimateResult.reviewUsdMicro`),
   * what a work run keeps room for beside one critic call's worst case. Absent: none.
   */
  reviewPartOf?(task: TaskRow): number | undefined;
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
   * d1109-selftasks-run (ADR 0119): the lines the specialist wrote under its report's "For the
   * task list:" heading, data only; a line that reads like an instruction is `flagged` (never
   * sent to the model, quoted on the card). The session's task check reads them.
   */
  taskListNotes?: TaskListLine[];
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
  /**
   * The web search results the run saw ('web-search'): their address and title, and the
   * injection scan's rules when their plain fields read like instructions. A result whose page
   * was not opened is no source; the critic is told which those are (`webSourceEvidence`).
   */
  searchSeen?: SearchSeen[];
  /**
   * The project's "Web pages research may read" line the run's brief carried (W15-25), when it
   * limits anything: the critic judges the run under the rule it ran under.
   */
  webRule?: string;
  /**
   * The review-only pass (W15-27): the result of an earlier session's run whose review a limit
   * refused, reviewed now without running the specialist again (`session/review-pending.ts`).
   */
  reviewOnly?: boolean;
}

/** One web search result a run saw ('web-search'), as the critic is told of it. */
export interface SearchSeen {
  url: string;
  title: string;
  /** The injection scan's rules, when the result's plain fields read like instructions. */
  flagged?: string[];
}

/**
 * d1109-oversize-pause (OP-2): the project's own checks on a paused run's kept work, in the task's
 * sandbox (`loop/kept-work-check.ts`): no network, no model, nothing booked, the output redacted.
 * `notRun` says why none ran (no sandbox here, it could not open).
 */
export type KeptWorkCheckPort = (input: {
  task: TaskRow;
  worktree: string | null;
  changedFiles: readonly string[];
  signal: AbortSignal;
}) => Promise<{ checks?: KeptCheck[]; notRun?: string }>;

/** What the runner learnt of a paused run's kept work (OP-2, OP-4, OP-8), for its card. */
export interface PausedWork {
  /** It got further than the task's last paused run (`madeProgress`). */
  progress: boolean;
  /** The names of the checks that passed and failed on its kept work, when they ran. */
  checks?: { passed: string[]; failed: string[] };
  /** The task's whole estimate at the pause, and what is left of it after its kept work. */
  estimateUsdMicro: number;
  estimateLeftUsdMicro: number;
  /** d1116-budget-all (BA-5): the estimate left before the task's budget caps it. */
  estimateLeftUncappedUsdMicro: number;
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
  /**
   * d1116-budget-all (BA-4): at the task's budget, what the run kept of it for its review (its
   * card says it beside what was spent). Absent: nothing kept.
   */
  roomUsdMicro?: number;
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
    /**
     * Called once when the task's run really starts: after its credential pick and any hand-over
     * to another specialist, with the specialist that runs (the leftovers of wave 7, W5-20). The
     * session log's start line is written then; a task whose pick waits for a credential, so no
     * run starts, gets none.
     */
    onStarted?: (info: {
      specialist: string;
      /** C5-left-1 (CE-11): the kind of credential the run is on. */
      sourceKind?: string;
      /** C5-left-1 (CE-11): the pick went to another credential than the stopped first choice. */
      switched?: RunSwitch;
      /** The run goes on with work its credential stopped (`lastRunCredentialStopped`). */
      continues?: boolean;
    }) => void;
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
  /**
   * The review-only pass (W15-27): makes the task's workspace ready for a review of its kept
   * result without running the specialist (a repository task's worktree on its branch; a
   * project's folder is in place) and says where it is. Null: it cannot be made ready (the
   * worktree is gone, it is on another branch), and the specialist runs again. Absent: no pass.
   */
  prepareReview?(task: TaskRow): Promise<{ worktree?: string } | null>;
}

/** The finding a review sent the work back for (W15-58): its first blocking one, else its first. */
function blockingFindingOf(
  findings: readonly { severity: string; description: string }[],
): string | undefined {
  const order = ["critical", "high", "medium", "low"];
  for (const level of order) {
    const f = findings.find((x) => x.severity === level && x.description.trim());
    if (f) return f.description.trim();
  }
  return undefined;
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
  | {
      kind: "tool";
      name: string;
      input?: unknown;
      isError: boolean;
      denied?: boolean;
      /** Why a denied step was refused: the hook's code (`path_not_allowed`, ...). */
      deniedCode?: string;
    }
  /** A line of the run's own (its budget line, its wrap-up, ADR 0112): the log says `text`. */
  | { kind: "note"; text: string };

export interface SessionStartOptions {
  agentId: string;
  projectId?: string;
  trigger: SessionTriggerKind;
  /**
   * Who asked for the session (d1109-starts-engine S-1, ADR 0118): written on `session.started`
   * and on the row's plan (`plan.startedBy`), which the Sessions list words. Absent: read from
   * the trigger (`startByOf`).
   */
  by?: StartBy;
  /**
   * The session this one goes on with (S-10): a continuation after a credential wait, or the
   * person's Continue of an ended session. Kept on `plan.startedBy` with that session's start
   * time in the person's zone (`continuesAt`).
   */
  continues?: string;
  /**
   * S-10: a schedule the person set (the monthly handover test of a project they turned it on
   * for): its session goes on after a credential wait like the person's own.
   */
  personSchedule?: boolean;
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
  /**
   * Of `needsHuman`, the tasks paused at a budget with their card open at the end (budget-resume):
   * the budget-stop notification says to continue them from it.
   */
  paused?: string[];
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
  /**
   * C5-left-1 (CE-11): the tasks this session moved to another credential than the stopped first
   * choice, each with the USD the ledger booked to it on that credential. Absent when none moved.
   */
  switched?: SessionSwitchRow[];
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
  /**
   * d1109-starts-engine (S-10, ADR 0118): keeps the continuation of a person's session that ended
   * to wait for its Claude credential on the project's wait (billing-pick's `keepContinuation`);
   * false when nothing waits. Absent: no session goes on by itself.
   */
  continuation?: {
    keep(
      projectId: string,
      kept: { continues: string; budgetUsdMicro: number; at: string },
    ): Promise<boolean>;
  };
  /**
   * d1109-starts-engine (S-7, ADR 0118): the registry of running sessions. A session of a project
   * registers its admit handle here, so work prepared outside it joins only if it fits what the
   * session promised (option C). Absent: nothing joins from outside (a one-shot, a test).
   */
  live?: LiveSessions;
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
   * d1109-oversize-pause (OP-2): the project's own checks on a paused run's kept work, in the
   * task's sandbox (`loop/kept-work-check.ts`). Absent: no check runs (the card says nothing of
   * checks), as before.
   */
  keptWorkCheck?: KeptWorkCheckPort;
  /**
   * d1109-selftasks-run (ADR 0119; the owner, 2026-11-09: "I want it to be able to fix its tasks.
   * Like as part of a run"): the task check at a task boundary, on evidence only (a report's "For
   * the task list:" lines, the critic's notes the task did not cause, notes kept from before), at
   * most three a session, never after the wrap-up line, paid only from the room the session's
   * promise leaves. Absent: no check runs (a test world, a one-shot).
   */
  taskCheck?: TaskCheckRunnerPort;
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
 * What a refused tool step would have done, as a verb phrase ("write /tmp/a.json", "read the web
 * page example.com/x", "run npm test"), for the line that says it was refused.
 */
function refusedWhat(name: string, step: Extract<TaskStep, { kind: "tool" }>, path: string) {
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  if (/^(read_file|read)$/.test(name)) return `read ${cut(path || "a file")}`;
  if (/^(write_file|write|edit|multiedit)$/.test(name)) return `write ${cut(path || "a file")}`;
  if (/^(list_dir|ls|glob)$/.test(name)) return `look at ${cut(path || "a folder")}`;
  if (/^(run_command|bash)$/.test(name)) {
    const cmd = inputField(step.input, "command", "argv", "cmd");
    return `run ${cut(cmd || "a command")}`;
  }
  if (name === "web_fetch" || name === "webfetch") {
    const url = inputField(step.input, "url");
    return url ? `read the web page ${cut(webPageName(url))}` : "read a web page";
  }
  return `use ${name.replace(/_/g, " ")}`;
}

/**
 * The line of a refused step (l3-small, run L3; live check 3, L3-run-7): what was refused and
 * why, in words. Before, every refusal read "was not allowed to use write file", beside the
 * coder's other writes, when only one path outside the folder was refused.
 */
function refusedLine(name: string, step: Extract<TaskStep, { kind: "tool" }>, path: string) {
  const what = refusedWhat(name, step, path);
  switch (step.deniedCode) {
    case "path_not_allowed":
      return `was not allowed to ${what} (outside the project's folder)`;
    case "domain_not_allowed":
      return `was not allowed to ${what} (not a site this task may read)`;
    case "tool_not_allowed":
      return `was not allowed to use ${name.replace(/_/g, " ")} (not one of its tools)`;
    case "approval_required":
      return `was not allowed to ${what}: you said no`;
    case "autonomy_insufficient":
      return `was not allowed to ${what} without you`;
    case "validation":
      return `could not ${what}: the call was not valid`;
    default:
      return `was not allowed to ${what}`;
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
  if (step.denied) return refusedLine(name, step, path);
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
  // 'web-search': Anthropic's search on an API key, Claude Code's WebSearch on a subscription.
  if (name === "web_search" || name === "websearch") {
    const query = inputField(step.input, "query");
    return query ? `searched the web for ${cut(query)}${failed}` : `searched the web${failed}`;
  }
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
 * d1116-budget-all (BA-8): the mark on a plan whose estimates hold each task's review (and,
 * through the learned ratios, its fixes): the session review sets the planned tasks' whole cost
 * against it (`planCountsAll` in `@forerunner/critic`). A plan without it was written before.
 */
export const PLAN_COUNTS_ALL = "all";

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

/**
 * A review a limit or a credential refused before its verdict (`reviewRefusalOf`): no verdict
 * and no failed try; the task pauses at that limit or waits for the credential.
 */
interface ReviewRefused {
  refused: ReviewRefusal;
  /**
   * d1116-budget-all: where the review's own cap came from: what was left of the task's budget,
   * when the task has one and it was no more than the session token's budget, else the session's.
   */
  capSource: "task_budget" | "session";
}

/**
 * Which limit refused a task's review (ADR 0112). The critic's run may spend what the session's
 * token allows, and, for a task with a budget of its own, no more than what is left of it
 * (d1116-budget-all): a refusal at the run's own cap ("run") names the limit that set that cap.
 */
function reviewStopSource(
  level: string | null,
  capSource: "task_budget" | "session" = "session",
): BudgetStopSource {
  switch (level) {
    case "project":
      return "project";
    case "month":
      return "month";
    case "plan":
      return "plan";
    case "task":
      return "task_budget";
    case "run":
      return capSource;
    default:
      return "session";
  }
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

    // S-1: who asked is on the row from its first write, and on every plan written after.
    const by = startByOf(opts);
    const continued = opts.continues
      ? await store.session.get(opts.continues).catch(() => undefined)
      : undefined;
    const startedBy: SessionStartedBy | undefined = by
      ? {
          by,
          ...(opts.continues ? { continues: opts.continues } : {}),
          ...(continued?.started_at
            ? {
                continuesAt: clockTime(
                  continued.started_at,
                  (await store.human.get(agent.owner_human_id).catch(() => undefined))?.timezone ??
                    undefined,
                  clock.now(),
                ),
              }
            : {}),
        }
      : undefined;
    let session = await store.session.insert({
      agent_id: agent.id,
      project_id: project?.id ?? null,
      trigger: opts.trigger,
      plan: (startedBy ? { startedBy } : {}) as never,
      // A row born with a plan says why (spec B.5): who asked for the session.
      ...(startedBy ? { reason: "who asked for the session" } : {}),
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
    // S-10: the person's session going on after its credential wait says so first, as its log's
    // first line ("Goes on with your session of 14:05."), before the budget line.
    if (startedBy?.by === "continuation")
      await emit(CONTINUES_EVENT, {
        continues: opts.continues ?? null,
        at: startedBy.continuesAt ?? null,
      });
    await emit("session.started", {
      trigger: opts.trigger,
      ...(startedBy ? { by: startedBy.by } : {}),
      ...(opts.continues ? { continues: opts.continues } : {}),
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
    /**
     * d1109-selftasks-run (ADR 0119): the evidence the task check reads at the next boundary
     * (gathered beside the lessons), the checks made, the notes kept from before that this
     * session took, the changes the agent made and the new tasks it added.
     */
    const taskListNotes: TaskListNote[] = [];
    let taskChecks = 0;
    let keptLoaded = false;
    const fromProject = new Set<TaskListNote>();
    const tasksChanged: TaskChangeFact[] = [];
    let addedByChecks = 0;
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
    /** OP-0: paused tasks this start took in its turn; each card closes as it is claimed. */
    const continuingIds = new Set<string>();
    let sandboxAnswer: SandboxGateAnswer | null = null;
    /** The Claude credential the session's work waits for, when it ended on one (U-078). */
    let credentialWait: CredentialWait | null = null;
    /** A task of this session waits for a Claude credential: the session ends saying so. */
    let waitedForCredential = false;
    /**
     * C5-left-1 (CE-11, ADR 0120): the stops this session moved for (`billing.switch`) and those
     * whose first choice served again (`billing.back`), read once from the session's own log, so
     * each stop's line is written once per session, also by a runtime composed again.
     */
    let switchLog: { switched: Map<string, RunSwitch>; back: Set<string> } | null = null;
    const switchLogOf = async () => {
      if (switchLog) return switchLog;
      const seen = { switched: new Map<string, RunSwitch>(), back: new Set<string>() };
      const rows = await store.event
        .ofTypes(session.id, [BILLING_SWITCH_EVENT, BILLING_BACK_EVENT], { limit: 500 })
        .catch(() => []);
      for (const e of [...rows].reverse()) {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const key = typeof p.stopKey === "string" ? p.stopKey : "";
        if (!key) continue;
        if (e.type === BILLING_BACK_EVENT) seen.back.add(key);
        else if (!seen.switched.has(key)) seen.switched.set(key, p as unknown as RunSwitch);
      }
      switchLog = seen;
      return seen;
    };
    let ownerZone: { tz?: string } | null = null;
    /** The switch's line: once per stop and session; a later task's switch is a detail. */
    const saySwitch = async (
      task: { id: string; title: string },
      sw: RunSwitch,
      continues: boolean,
      at: string,
    ) => {
      const seen = await switchLogOf();
      const repeat = seen.switched.has(sw.stopKey);
      if (!repeat) seen.switched.set(sw.stopKey, sw);
      if (!ownerZone) {
        const owner = await store.human.get(agent.owner_human_id).catch(() => undefined);
        ownerZone = owner?.timezone ? { tz: owner.timezone } : {};
      }
      const until = sw.until ? clockTime(sw.until, ownerZone.tz, clock.now()) : null;
      await emit(BILLING_SWITCH_EVENT, {
        taskId: task.id,
        title: task.title,
        from: sw.from,
        to: sw.to,
        stop: sw.stop,
        until: sw.until,
        stopKey: sw.stopKey,
        by: sw.by,
        // The credential it went on with and when (the ledger's rows on it since are the
        // switch's spend: the session page's line, `SessionResult.switched`).
        toSourceId: sw.toSourceId,
        at,
        sentence: switchRunLine(task.title, sw, until, continues),
        ...(repeat ? { repeat: true } : {}),
      });
    };
    /** The first choice serves again after a switch of this session: once per stop. */
    const sayBack = async (kind: string) => {
      const seen = await switchLogOf();
      for (const [key, sw] of seen.switched) {
        if (seen.back.has(key) || sw.from !== kind) continue;
        seen.back.add(key);
        await emit(BILLING_BACK_EVENT, {
          from: sw.to,
          to: sw.from,
          stopKey: key,
          sentence: backLogLine(sw.from),
        });
      }
    };
    let plan: SessionPlan | null = null;
    /**
     * d1109-starts-engine (S-6, S-7): what this session promised at its start (its own tasks,
     * `own`, each with the estimate it was promised at) and the work that joined it since
     * (`joined`); `asked` holds the newcomers that asked to join and did not fit ("Left for your
     * next Start"). A newcomer joins only when its estimate fits the work budget left after the
     * remaining estimates of the session's own tasks and of what joined.
     */
    let promise: { taskIds: string[]; estimateUsdMicro: number; afterLarge?: string[] } | null =
      null;
    /** S-10: the earlier session's promise this one goes on with, when it continues one. */
    let continuedPromise: string[] | null = null;
    const own = new Set<string>();
    const ownEstimate = new Map<string, number>();
    const joined = new Map<string, number>();
    const asked = new Map<string, { title: string; estimateUsdMicro: number; waitsFor?: string }>();
    /** Promised tasks a step added before them took out of the promise (D7). */
    const leftPromise = new Set<string>();
    /** The run in flight and what the session had spent when it began (its remaining estimate). */
    let inFlight: { taskId: string; spentAtStart: number } | null = null;
    let liveHandle: AdmitHandle | null = null;
    let unregisterLive: () => void = () => undefined;
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
     * d1116-budget-all (BA-7): the finished hook (`onTaskFinished`, the estimates' live feed) runs
     * once, at the task's close: done, failed after its tries or cancelled, after the verdict that
     * closes it. Before, it ran at every task.finished, before the review and once per try, so the
     * live sample held neither the task's reviews nor its later tries, and a restart's fold, which
     * reads each finished task once from its final rows, moved the figures. Each run's facts are
     * kept here until then.
     */
    const finishedRuns = new Map<string, TaskFinishedInfo>();
    const closeIfFinished = async (taskId: string) => {
      const info = finishedRuns.get(taskId);
      if (!info || !this.deps.onTaskFinished) return;
      const now = await store.task.get(taskId).catch(() => undefined);
      if (!now || !["done", "failed", "cancelled"].includes(now.status)) return;
      finishedRuns.delete(taskId);
      try {
        await this.deps.onTaskFinished({ ...info, task: now });
      } catch (e) {
        this.logger.warn("task finished hook failed", { taskId, error: errorMessage(e) });
      }
    };
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
      // A cancel (or a person's Done) closes the task: its sample, from its final rows.
      await closeIfFinished(t.id);
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
      // D4: a task that resumes from the work its paused runs kept is planned at what is left.
      const keptWork = (t: TaskRow) => keptWorkFor(store, t);
      let readyTasks = project ? await store.task.readyTasks(project.id, { limit: 100 }) : [];
      // d1109-oversize-pause (OP-0, the owner's answer 5: "continue next time"): a task paused at
      // a session's budget (or at its specialist's limit, as its session's last pause) with
      // progress is ready for this start's plan, in its turn, from its kept work; its card closes
      // when the session claims it (`closeByStart`). Only the start's plan takes it: the session
      // that paused it does not take it again.
      if (project) {
        const continuing = await continuableTasks(store, project.id);
        for (const t of continuing) continuingIds.add(t.id);
        if (continuing.length)
          readyTasks = [...readyTasks, ...continuing].sort(
            (a, b) =>
              b.priority - a.priority ||
              a.created_at.localeCompare(b.created_at) ||
              a.id.localeCompare(b.id),
          );
      }
      // S-10: a session that goes on with an earlier one (a continuation, the person's Continue)
      // promises the rest of that one's promise: its start plans only those tasks; work made
      // ready since joins by the room rule (S-7).
      if (opts.continues) {
        const earlier = await store.session.get(opts.continues).catch(() => undefined);
        const promised = (earlier?.plan as { promise?: { taskIds?: unknown } } | undefined)?.promise
          ?.taskIds;
        if (Array.isArray(promised)) {
          continuedPromise = promised.filter((id): id is string => typeof id === "string");
          const keep = new Set(continuedPromise);
          readyTasks = readyTasks.filter((t) => keep.has(t.id));
        }
      }
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
        keptWork,
      });
      /** What the session's tasks may spend: its cap less the review reserve. */
      const workBudgetUsdMicro = Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare));
      // D4 (d1109-oversize-pause, OP-0, the owner's answer 5): the first task whose figure alone
      // is more than the work budget goes in at its place in the plan's order with what is left
      // (`plan.oversized`); the tasks after it wait behind it (`after_large`).
      plan = cutPlanToBudget(plan, workBudgetUsdMicro);
      /** The plan's items before its larger task: what the session runs before it. */
      const beforeLarger = (p: SessionPlan): PlanItem[] => {
        const at = p.items.findIndex((i) => i.wholeEstimateUsdMicro !== undefined);
        return at < 0 ? p.items : p.items.slice(0, at);
      };
      /** Every task row the session planned, by id (the start's ready tasks, then each re-plan). */
      const knownTasks = new Map<string, TaskRow>(readyTasks.map((t) => [t.id, t]));
      // What cannot run is named, never silent (U-040): the ready tasks that wait on a task not
      // done (a cancelled or failed one waits for good) and the items left out for budget.
      waiting = project ? await store.task.waitingTasks(project.id) : [];
      // d1109-starts-engine (S-6, ADR 0118; the owner: "the session keeps its promise"): what this
      // start promises, as the Start dialog's check computes it (`promiseOf`): the plan's items
      // (the larger task with its room), the tasks after it, then the followers that fit the
      // work budget left after them, in run order. A session that goes on with an earlier one
      // (S-10, a Continue) promises the rest of that one's promise instead.
      if (project) {
        const inFlight = await store.task.forProject(
          project.id,
          { status: ["claimed", "in_progress", "in_review"] },
          { limit: 1_000 },
        );
        const afterLarge = (plan.leftOutForBudget ?? [])
          .filter((l) => l.reason === "after_large")
          .map((l) => l.taskId);
        const first = new Set([...plan.items.map((i) => i.taskId), ...afterLarge]);
        const comes = new Set([...first, ...inFlight.map((t) => t.id)]);
        const priced: { taskId: string; title: string; estimateUsdMicro: number }[] = [];
        for (const t of followersOf(
          waiting.map((w) => ({ ...w, task: w.task })),
          comes,
          needsContainerSandbox,
        ))
          priced.push({ taskId: t.id, title: t.title, estimateUsdMicro: await this.priceNow(t) });
        const planned = plan.items.reduce((sum, i) => sum + i.estimateUsdMicro, 0);
        const { taken } = cutFollowers(priced, Math.max(0, workBudgetUsdMicro - planned));
        for (const i of plan.items) ownEstimate.set(i.taskId, i.estimateUsdMicro);
        for (const l of plan.leftOutForBudget ?? [])
          if (l.reason === "after_large") ownEstimate.set(l.taskId, l.estimateUsdMicro);
        for (const f of taken) ownEstimate.set(f.taskId, f.estimateUsdMicro);
        promise = {
          taskIds: [...first, ...taken.map((f) => f.taskId)],
          estimateUsdMicro: planned + taken.reduce((sum, f) => sum + f.estimateUsdMicro, 0),
          ...(afterLarge.length ? { afterLarge } : {}),
        };
        // S-10: the rest of the earlier session's promise, still open now.
        if (continuedPromise) {
          const open = new Set(
            (
              await store.task.forProject(
                project.id,
                { status: ["ready", "claimed", "in_progress", "needs_human", "draft"] },
                { limit: 1_000 },
              )
            ).map((t) => t.id),
          );
          const rest = continuedPromise.filter((id) => open.has(id));
          for (const id of rest)
            if (!ownEstimate.has(id)) {
              const row = await store.task.get(id);
              if (row) ownEstimate.set(id, await this.priceNow(row));
            }
          promise = {
            taskIds: rest,
            estimateUsdMicro: rest.reduce((sum, id) => sum + (ownEstimate.get(id) ?? 0), 0),
          };
        }
        for (const id of promise.taskIds) own.add(id);
      }
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
        { ...plan, startedBy, ...(promise ? { promise } : {}), counts: PLAN_COUNTS_ALL } as never,
        planReason(plan),
        { agentId: agent.id },
      );
      // With a larger task, `items` and `estimateUsdMicro` count what runs before it (the
      // Details line: 'Plan: 1 task, about CHF 0.03, then "X" (about CHF 6.40), ...').
      const plannedBefore = plan.oversized ? beforeLarger(plan) : plan.items;
      // l4-money-pause, run L4 (L4-github-110): when the promise's line follows, the session's
      // size is said there, once (live check 4: "Plan: 1 task, about CHF 0.09" beside "It
      // promised 3 tasks, about CHF 0.34"); the Plan line then says only how the tasks were
      // chosen.
      const promised = promise && promise.taskIds.length > 0 ? promise.taskIds.length : 0;
      await emit("session.planned", {
        items: plannedBefore.length,
        ...(promised > 0 ? { promised } : {}),
        estimateUsdMicro: plan.oversized
          ? plannedBefore.reduce((s, i) => s + i.estimateUsdMicro, 0)
          : plan.estimateUsdMicro,
        summary: plan.summary,
        ...(plan.leftOutForBudget?.length
          ? {
              leftOutForBudget: plan.leftOutForBudget.map((i) => ({
                taskId: i.taskId,
                title: i.title,
                estimateUsdMicro: i.estimateUsdMicro,
                ...(i.reason ? { reason: i.reason } : {}),
              })),
              workBudgetUsdMicro: plan.workBudgetUsdMicro,
            }
          : {}),
        // D4: the task larger than the work budget the session takes at its place in the plan.
        ...(plan.oversized
          ? {
              oversized: {
                taskId: plan.oversized.taskId,
                title: plan.oversized.title,
                estimateUsdMicro: plan.oversized.estimateUsdMicro,
              },
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
      // S-6: the promise is said once, as the Start dialog said it (its tasks and figure).
      if (promise && promise.taskIds.length > 0)
        await emit(PROMISED_EVENT, {
          taskIds: promise.taskIds,
          estimateUsdMicro: promise.estimateUsdMicro,
          ...(promise.afterLarge ? { afterLarge: promise.afterLarge } : {}),
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
      /**
       * What this session plans to run (D4, d1109-oversize-pause OP-0): its items in the plan's
       * order, the task larger than the work budget at its place with its whole figure, then the
       * tasks after it (`after_large`, the session's own: they run if it leaves room). At levels 0
       * and 1 the person approves them all.
       */
      const planned = (p: SessionPlan): PlanItem[] => [
        ...p.items.map(({ wholeEstimateUsdMicro, ...i }) =>
          wholeEstimateUsdMicro !== undefined
            ? { ...i, estimateUsdMicro: wholeEstimateUsdMicro }
            : i,
        ),
        ...(p.leftOutForBudget ?? [])
          .filter((l) => l.reason === "after_large")
          .map(({ reason: _r, after: _a, ...i }) => i),
      ];
      try {
        await this.deps.onPlanned?.({
          sessionId: session.id,
          projectId: project?.id ?? null,
          plan: { ...plan, items: planned(plan) },
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
      const approvalItems = planned(plan);
      const approval = planApprovalOf(opts.planApproved, approvalItems);
      if (
        (autonomy === 0 || autonomy === 1) &&
        approval !== "approved" &&
        approvalItems.length > 0
      ) {
        const changed = approval === "changed";
        const approvedPlanId = typeof opts.planApproved === "string" ? opts.planApproved : null;
        const planId = planIdOf(session.id, approvalItems);
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
          steps: approvalItems.map(
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
          items: approvalItems.length,
          changed,
          approvedPlanId,
        });
      } else {
        if (approval === "approved" && typeof opts.planApproved === "string") {
          token = issueToken(true);
          await emit("session.plan_approved", {
            planId: opts.planApproved,
            approvedSessionId: parsePlanId(opts.planApproved)?.sessionId ?? null,
            items: approvalItems.length,
          });
        }
        // Nothing runnable means nothing is consumed, reviewed or graded (design §4.8).
        // D4: a task larger than the work budget runs too, in its turn (OP-0).
        if (approvalItems.length === 0) stopReason = NOTHING_RUNNABLE;
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
        const onlyThese = autonomy < 2 ? new Set(approvalItems.map((i) => i.taskId)) : null;
        /** What the session's own tasks and the joined work still need of the work budget. */
        const stillNeeded = async (): Promise<number> => {
          if (!project) return 0;
          const ids = [...own, ...joined.keys()];
          if (ids.length === 0) return 0;
          const rows = await store.task.forProject(
            project.id,
            { status: ["ready", "claimed", "in_progress"] },
            { limit: 1_000 },
          );
          const open = new Set(rows.map((r) => r.id));
          const spentNow = budget.snapshot().sessionSpentUsdMicro;
          let sum = 0;
          for (const id of new Set(ids)) {
            // A task paused, cancelled, done or waiting on the person gives its room back; one
            // this session will not take again holds none.
            if (!open.has(id) || notAgain.has(id)) continue;
            const est = joined.get(id) ?? ownEstimate.get(id) ?? 0;
            sum +=
              inFlight?.taskId === id ? Math.max(0, est - (spentNow - inFlight.spentAtStart)) : est;
          }
          return sum;
        };
        /** What the work budget has left for a newcomer now. */
        const roomForNewcomers = async (): Promise<number> =>
          workBudgetUsdMicro - budget.snapshot().sessionSpentUsdMicro - (await stillNeeded());
        /** The session takes no new work (Stop after this task, the wrap-up, its last look). */
        const takesNothingNew = async (): Promise<boolean> =>
          (liveHandle?.closing ?? false) ||
          budget.noNewWork ||
          controller.signal.aborted ||
          (await store.session.get(session.id))?.status === "paused";
        /** Remaining room each promised task split into parts still offers its parts (D7). */
        const partRoom = new Map<string, number>();
        if (project && this.deps.live) {
          const handle: AdmitHandle = {
            sessionId: session.id,
            agentId: agent.id,
            projectId: project.id,
            closing: false,
            admit: async (taskIds, by, context) => {
              const out = new Map<string, AdmitOutcome>();
              const rows = await Promise.all(taskIds.map((id) => store.task.get(id)));
              const prices = new Map<string, number>();
              for (const row of rows) if (row) prices.set(row.id, await this.priceNow(row));
              // Decided after the reads, so a look that closed meanwhile is seen (the race).
              const stopping = await takesNothingNew();
              let room = await roomForNewcomers();
              for (const row of rows) {
                if (!row) continue;
                const est = prices.get(row.id) ?? 0;
                if (stopping) {
                  notAgain.add(row.id);
                  out.set(row.id, "stopping");
                  continue;
                }
                if (own.has(row.id) || joined.has(row.id)) {
                  notAgain.delete(row.id);
                  out.set(row.id, "joined");
                  continue;
                }
                // D7: a part of a promised task is the session's own within that task's room.
                const whole = context?.partOf;
                if (whole && own.has(whole)) {
                  const left = partRoom.get(whole) ?? ownEstimate.get(whole) ?? 0;
                  if (est <= left) {
                    partRoom.set(whole, left - est);
                    // d1109-selftasks-run: the part's room comes out of the whole's estimate, so
                    // the promise is counted once (before, both were counted in full).
                    ownEstimate.set(whole, Math.max(0, (ownEstimate.get(whole) ?? 0) - est));
                    own.add(row.id);
                    ownEstimate.set(row.id, est);
                    if (onlyThese && by !== "agent") onlyThese.add(row.id);
                    out.set(row.id, "joined");
                    continue;
                  }
                }
                // A task larger than the whole work budget never joins (D4: it runs in its turn
                // at the next Start).
                if (est > workBudgetUsdMicro || est > room) {
                  asked.set(row.id, { title: row.title, estimateUsdMicro: est });
                  // L4-money-203: a task above the whole work budget never fits here, so its
                  // line never says it may join (live check 4's "It joins this session if
                  // budget is left ..." for a CHF 1.10 task in a CHF 1.00 session).
                  out.set(row.id, est > workBudgetUsdMicro ? "too_large" : "no_room");
                  // D7: a step added before a promised task that does not fit takes that task
                  // out of the promise with it; both wait for the next Start.
                  const next = context?.before;
                  if (next && own.has(next)) {
                    own.delete(next);
                    leftPromise.add(next);
                    notAgain.add(next);
                    notAgain.add(row.id);
                    const nextRow = await store.task.get(next);
                    if (nextRow)
                      asked.set(next, {
                        title: nextRow.title,
                        estimateUsdMicro: ownEstimate.get(next) ?? 0,
                        // D7: named after the step it waits for ("which waits for it").
                        waitsFor: row.title,
                      });
                  }
                  continue;
                }
                room -= est;
                joined.set(row.id, est);
                notAgain.delete(row.id);
                asked.delete(row.id);
                // At levels 0 and 1 the person's own preparation joins the approved work; the
                // agent's does not (it is asked first, D7).
                if (onlyThese && by !== "agent") onlyThese.add(row.id);
                out.set(row.id, "joined");
                await emit(JOINED_EVENT, {
                  taskId: row.id,
                  title: row.title,
                  estimateUsdMicro: est,
                  by,
                });
              }
              return out;
            },
            // l4-starts-carried (L4g-left-2): the admit's answer, read-only, for chat's
            // read-back of a move (before, the preview had no estimate and always said the room
            // rule's words, also for a task larger than the whole work budget).
            preview: async (taskIds) => {
              const out = new Map<string, AdmitOutcome>();
              const rows = await Promise.all(taskIds.map((id) => store.task.get(id)));
              const stopping = await takesNothingNew();
              for (const row of rows) {
                if (!row) continue;
                if (stopping) out.set(row.id, "stopping");
                else if (own.has(row.id) || joined.has(row.id)) out.set(row.id, "joined");
                else
                  out.set(
                    row.id,
                    (await this.priceNow(row)) > workBudgetUsdMicro ? "too_large" : "no_room",
                  );
              }
              return out;
            },
            readmit: (taskIds) => {
              for (const id of taskIds) {
                own.add(id);
                notAgain.delete(id);
              }
            },
          };
          liveHandle = handle;
          unregisterLive = this.deps.live.register(handle);
        }
        /**
         * D4 (d1109-oversize-pause, OP-0; the owner's answer 5 of 2026-11-09): a task larger than
         * the work budget runs at its place in the plan's order, so it is taken at its turn with
         * what is left of the work budget then, when that is at least a fifth of it and the
         * session still takes new work; else it is left out (`no_room`) and the tasks after it are
         * the re-plan's, by the room left. Its planned figure becomes that room (the plan row and
         * the session review measure what it was allowed to spend) and the log says the take
         * once. The run itself is capped as every run is (its own budget left, else its
         * specialist's limit per run, the work budget left, the hooks' outer caps). Before
         * (d1109-oversize-start) it was held out of the queue until the work that fits was done
         * and a re-plan added nothing, one a session.
         */
        const takeLarger = async (item: PlanItem): Promise<boolean> => {
          const whole = item.wholeEstimateUsdMicro ?? item.estimateUsdMicro;
          const room = budget.workRemainingUsdMicro();
          const current = plan as SessionPlan;
          if (budget.noNewWork || room < oversizedMinRoomUsdMicro(workBudgetUsdMicro)) {
            notAgain.add(item.taskId);
            plan = {
              ...current,
              items: current.items.filter((i) => i !== item),
              estimateUsdMicro: current.estimateUsdMicro - (item.again ? 0 : item.estimateUsdMicro),
              leftOutForBudget: [
                ...(current.leftOutForBudget ?? []).filter((l) => l.taskId !== item.taskId),
                {
                  ...item,
                  estimateUsdMicro: whole,
                  wholeEstimateUsdMicro: undefined,
                  reason: "no_room",
                },
              ],
              workBudgetUsdMicro,
            };
            // The tasks that waited behind it are the re-plan's now, by the room left.
            for (const l of plan.leftOutForBudget ?? [])
              if (l.reason === "after_large" && l.after === item.title) l.reason = "after_others";
            return false;
          }
          // Its planned figure is the room it gets now, in place (L3-run-2: a take again adds
          // nothing to the plan's figure).
          const taken: PlanItem = { ...item, estimateUsdMicro: room };
          plan = {
            ...current,
            items: current.items.map((i) => (i === item ? taken : i)),
            estimateUsdMicro:
              current.estimateUsdMicro + (item.again ? 0 : room - item.estimateUsdMicro),
            oversized: { ...item, estimateUsdMicro: whole, roomUsdMicro: room },
            workBudgetUsdMicro,
          };
          const fresh = await store.session.mustGet(session.id);
          session = await store.session.setPlan(
            fresh.id,
            fresh.version,
            {
              ...plan,
              startedBy,
              ...(promise ? { promise } : {}),
              counts: PLAN_COUNTS_ALL,
            } as never,
            `took "${item.title}", larger than this session's work budget, with what is left`,
            { agentId: agent.id },
          );
          if (!item.again)
            await emit(TOOK_LARGER_EVENT, {
              taskId: item.taskId,
              title: item.title,
              estimateUsdMicro: whole,
              roomUsdMicro: room,
              workBudgetUsdMicro,
            });
          Object.assign(item, taken);
          return true;
        };

        /** Tasks whose run failed with a transient error and were tried again at once. */
        const transientRetried = new Set<string>();
        /** How often a credential stopped each task and the next one took over (U-078). */
        const movedOnCredential = new Map<string, number>();
        /**
         * l4-money-pause, run L4 (L4-money-102; option C, the owner's "the session keeps its
         * promise and spare budget isn't wasted"): after a pause at the session's work budget,
         * whether the session goes on: "go_on" while it takes new work and the room left fits the
         * smallest task that waited behind a larger one (or none waited: the re-plan then takes
         * what fits, if anything); "room" when it still takes new work but that room is too small
         * for them (the session ends with no budget stop: its spend is under the work budget);
         * "end" once it takes no new work (a call was refused at its cap, or its spend reached the
         * work line). Before, every such pause ended the session as "the budget is used": a
         * larger task's clean wrap-up at CHF 0.23 of a CHF 0.32 work budget left the tagline task
         * after it (about CHF 0.06) for the next session (live check 4, LC-C7). A pause at an
         * outer limit always ends it.
         */
        const roomAfterPause = (
          stop: Pick<BudgetStop, "source" | "stoppedBy">,
          queued: readonly PlanItem[],
        ): "go_on" | "room" | "end" => {
          // A hard stop there (its next step did not fit what was left) used the work budget;
          // only a clean wrap-up leaves its reserve unspent.
          if (stop.source !== "session" || stop.stoppedBy !== "wrap_up" || budget.noNewWork)
            return "end";
          const next = [
            ...((plan as SessionPlan | null)?.leftOutForBudget ?? []).filter(
              (l) => l.reason === "after_large",
            ),
            ...queued,
          ].map((l) => l.estimateUsdMicro);
          if (next.length === 0) return "go_on";
          return budget.workRemainingUsdMicro() >= Math.min(...next) ? "go_on" : "room";
        };
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
          // S-7 (option C): the session's own tasks and the work that joined come first; a ready
          // task that is neither is a newcomer, taken in priority order only while its estimate
          // fits what the work budget has left after them (it then joins). Before, every ready
          // task that fit the room left was taken, so a Redo could take the room the promise's
          // followers needed.
          if (promise) {
            const newcomers = ready.filter((t) => !own.has(t.id) && !joined.has(t.id));
            if (newcomers.length > 0) {
              let room = await roomForNewcomers();
              const take = new Set<string>();
              for (const t of newcomers) {
                const est = await this.priceNow(t);
                if (est <= workBudgetUsdMicro && est <= room) {
                  room -= est;
                  take.add(t.id);
                  joined.set(t.id, est);
                  asked.delete(t.id);
                  await emit(JOINED_EVENT, {
                    taskId: t.id,
                    title: t.title,
                    estimateUsdMicro: est,
                    by: "system",
                  });
                } else if (!asked.has(t.id))
                  asked.set(t.id, { title: t.title, estimateUsdMicro: est });
              }
              ready = ready.filter((t) => own.has(t.id) || joined.has(t.id) || take.has(t.id));
              if (ready.length === 0) return [];
            }
          }
          for (const t of ready) knownTasks.set(t.id, t);
          const planned = await this.deps.planner.plan({
            brief,
            briefText,
            readyTasks: ready,
            budgetUsdMicro: opts.budgetCapUsdMicro,
            reserveShare,
            session,
            token,
            budget,
            keptWork,
          });
          // D4 (d1109-oversize-pause, OP-0): the tasks that waited behind a larger task are the
          // session's own after it: the re-plan takes them first, in the plan's order, then the
          // rest in the planner's order.
          const behind = ((plan as SessionPlan).leftOutForBudget ?? [])
            .filter((l) => l.reason === "after_large")
            .map((l) => l.taskId);
          const rank = (i: PlanItem) => {
            const at = behind.indexOf(i.taskId);
            return at < 0 ? behind.length : at;
          };
          const next: SessionPlan = {
            ...planned,
            items: planned.items
              .map((i, at) => ({ i, at }))
              .sort((a, b) => rank(a.i) - rank(b.i) || a.at - b.at)
              .map(({ i }) => i),
          };
          // What is left of the work budget now, not at the start.
          const room = Math.max(
            0,
            Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare)) -
              budget.snapshot().sessionSpentUsdMicro,
          );
          // A task larger than the whole work budget is told apart from one that only does not
          // fit what is left (D4): it goes in at its place with the room left, and the tasks
          // after it wait behind it (`after_large`), as at the start.
          const cut = cutPlanToBudget(next, room, workBudgetUsdMicro);
          const current = plan as SessionPlan;
          // L4-money-102: a task that waited behind a larger one and still does not fit what
          // that task left stays behind it (`after_large`), so the result says what it left
          // ('"B" (about CHF 0.30) waits for your next session: "Build the shop" left CHF 0.04
          // of this one.'), not that this session's budget was used.
          const wasBehind = new Map(
            (current.leftOutForBudget ?? [])
              .filter((l) => l.reason === "after_large")
              .map((l) => [l.taskId, l.after] as const),
          );
          const cutLeftOut: LeftOutItem[] = (cut.leftOutForBudget ?? []).map((l) =>
            l.reason === "after_others" && wasBehind.has(l.taskId)
              ? { ...l, reason: "after_large", after: wasBehind.get(l.taskId) }
              : l,
          );
          // What the cut took or left out again is said as it is now: a task that waited behind
          // a larger one and runs now is no longer left out, and one that no longer fits is
          // left out for that (OP-0: "Left for next time").
          const recut = new Set([...cut.items, ...cutLeftOut].map((i) => i.taskId));
          const before = (current.leftOutForBudget ?? []).filter((l) => !recut.has(l.taskId));
          const leftOut = cutLeftOut;
          // A task left out waits for the next session, except one behind a larger task: it is
          // the session's own and a later re-plan takes it if that task leaves room.
          for (const i of cutLeftOut) if (i.reason !== "after_large") notAgain.add(i.taskId);
          const changedLeftOut =
            leftOut.length > 0 || before.length !== (current.leftOutForBudget ?? []).length;
          if (cut.items.length === 0 && !changedLeftOut) return [];
          // L3-run-2 (live check 3): a task this session already planned and takes again (the
          // critic sent it back, its run failed and is tried again) is one planned task. Its
          // item is kept, marked `again`, so the row records what ran, and the plan's figure
          // stays the one the person was shown on the plan line and the Start dialog. Before,
          // each retry's estimate was added to it, and the session review set the work against
          // "an estimate of CHF 0.21" where every screen had said about CHF 0.11.
          const taken = cut.items.map((i) =>
            current.items.some((c) => c.taskId === i.taskId) ? { ...i, again: true } : i,
          );
          const newEstimate = taken
            .filter((i) => !i.again)
            .reduce((s, i) => s + i.estimateUsdMicro, 0);
          const stillLeftOut = [...before, ...leftOut];
          plan = {
            ...current,
            items: [...current.items, ...taken],
            estimateUsdMicro: current.estimateUsdMicro + newEstimate,
            ...(leftOut.length || current.leftOutForBudget
              ? {
                  // OP-0: none left out any more (the tasks behind a larger one all ran) reads
                  // as a plan that left nothing out.
                  leftOutForBudget: stillLeftOut.length ? stillLeftOut : undefined,
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
            {
              ...plan,
              startedBy,
              ...(promise ? { promise } : {}),
              counts: PLAN_COUNTS_ALL,
            } as never,
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
          return taken;
        };
        /**
         * d1109-selftasks-run (ADR 0119 point 3): the check at a task boundary (no task of the
         * session runs now). Answers true when the agent changed the task list: the queue is
         * dropped and planned again from the tasks as they are now, through the admit rule.
         */
        const checkTaskList = async (): Promise<boolean> => {
          const port = this.deps.taskCheck;
          if (!project || !port) return false;
          if (!keptLoaded) {
            keptLoaded = true;
            const kept = keptNotesOf(await store.project.get(project.id));
            for (const n of kept) fromProject.add(n);
            taskListNotes.unshift(...kept);
          }
          if (!taskListNotes.length) return false;
          // At most three a session; none after the wrap-up line or once the session takes no
          // new work: the notes stay and are kept on the project at its end.
          if (taskChecks >= TASK_CHECKS_PER_SESSION || (await takesNothingNew())) return false;
          const notes = taskListNotes.splice(0);
          const fresh = await store.project.mustGet(project.id);
          const after = [...notes].reverse().find((n) => !fromProject.has(n))?.taskTitle ?? null;
          const done = await checkAtBoundary(port, {
            session: await store.session.mustGet(session.id),
            budget,
            agentId: agent.id,
            ownerHumanId: agent.owner_human_id,
            project: fresh,
            notes,
            // The check is paid only from what the promise and what joined leave.
            roomUsdMicro: await roomForNewcomers(),
            level: autonomy,
            addedThisSession: addedByChecks,
            after,
            chfPerUsd: this.deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD,
          }).catch((e: unknown) => {
            this.logger.warn("the task check failed", {
              sessionId: session.id,
              error: errorMessage(e),
            });
            return null;
          });
          // l4-selftasks-108 (ADR 0119 point 9, dated note of 2026-11-22): the check's cost is
          // booked on its line's row, so the line gets its CHF like a task's and the person-level
          // lines add up to the session's spend; `called` keeps a check with no call a detail.
          if (!done || done.keep) {
            taskListNotes.unshift(...notes);
            if (done?.called) taskChecks++;
            if (done?.line)
              await emit(
                TASK_CHECKED_EVENT,
                {
                  sentence: done.line,
                  costUsdMicro: done.costUsdMicro,
                  called: done.called,
                },
                done.costUsdMicro,
              );
            return false;
          }
          if (done.called) taskChecks++;
          // Notes kept from before are checked once: they leave the project now.
          if (notes.some((n) => fromProject.has(n))) await takeNotes(store, project.id);
          if (done.line)
            await emit(
              TASK_CHECKED_EVENT,
              {
                sentence: done.line,
                costUsdMicro: done.costUsdMicro,
                called: done.called,
                changed: done.applied.length,
                // l4-selftasks-103: what it left out, quoted on its line (data; never sent on).
                ...(done.quotes.length ? { flagged: done.quotes.map((q) => q.text) } : {}),
                ...(done.proposalId ? { proposed: true } : {}),
                ...(done.refused.length
                  ? { refused: done.refused.map((r) => `${r.what}: ${r.reason}`) }
                  : {}),
              },
              done.costUsdMicro,
            );
          // l4-selftasks-104: what the fence and the commands refused, as a Details line.
          const leftOut = taskCheckLeftOutLine(done.refused);
          if (done.line && leftOut)
            await emit(TASK_CHECK_LEFT_OUT_EVENT, {
              sentence: leftOut,
              refused: done.refused.map((r) => `${r.what}: ${r.reason}`),
            });
          if (!done.applied.length) return false;
          tasksChanged.push(...done.facts);
          // The new tasks join only by the admit rule (D6, option C): a part of a promised task
          // within its room, a step before a promised task only if the room after the promise
          // covers it; the agent's preparation never starts a session.
          for (const a of done.applied) {
            addedByChecks += a.made.length;
            for (const m of a.made)
              await liveHandle?.admit(
                [m.taskId],
                "agent",
                m.partOf ? { partOf: m.partOf } : m.before ? { before: m.before } : undefined,
              );
          }
          return true;
        };
        for (;;) {
          if (controller.signal.aborted) throw new ForerunnerError("killed", "session stopped");
          budget.checkWallClock(clock.now());
          // d1109-selftasks-run: the task boundary; after a change the session plans again.
          if (await checkTaskList()) {
            queue.length = 0;
            continue;
          }
          if (queue.length === 0) {
            // "Stop after this task" (the pause port marks the row `paused`): nothing more.
            if ((await store.session.get(session.id))?.status === "paused") break;
            if (!budget.noNewWork) {
              // S-7: the last look closes the session to newcomers first, so work prepared
              // between an empty look and the session's end never hears "joins".
              if (liveHandle) liveHandle.closing = true;
              const more = await replan();
              if (more.length > 0) {
                if (liveHandle) liveHandle.closing = false;
                queue.push(...more);
                continue;
              }
            }
            if (liveHandle) liveHandle.closing = true;
            break;
          }
          let item = queue.shift() as PlanItem;
          if (budget.noNewWork) {
            skipped.push(item.taskId);
            continue;
          }
          // S-7 (D7): a promised task a step added before it took out of the promise waits for
          // the next Start with that step.
          if (leftPromise.has(item.taskId)) {
            skipped.push(item.taskId);
            continue;
          }
          // D4 (OP-0): the task larger than the work budget, at its turn, with what is left.
          if (item.wholeEstimateUsdMicro !== undefined && !(await takeLarger(item))) continue;
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
          // OP-0: a paused task this start took goes back to ready with its card closed, in one
          // transaction, as the session claims it; nothing is added to any budget.
          if (continuingIds.has(item.taskId)) {
            continuingIds.delete(item.taskId);
            await closeByStart({
              store,
              task: { id: item.taskId },
              session,
              agentId: agent.id,
              startTime: clockTime(
                session.started_at ?? clock.nowIso(),
                (await store.human.get(agent.owner_human_id).catch(() => undefined))?.timezone ??
                  undefined,
                clock.now(),
              ),
              now: clock.nowIso(),
            }).catch((e: unknown) =>
              this.logger.warn("the card of a task this start took was not closed", {
                taskId: item.taskId,
                error: errorMessage(e),
              }),
            );
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
          inFlight = { taskId: item.taskId, spentAtStart: budget.snapshot().sessionSpentUsdMicro };
          let task = claim.task;
          // S-8 (ADR 0118): edits apply before a task starts: the claimed row's title and the
          // specialist the person set replace the plan's before the specialist is chosen and the
          // start line is said (the estimate the plan was promised with stays).
          item = {
            ...item,
            title: task.title,
            ...(task.specialist && task.specialist !== item.specialist
              ? { specialist: task.specialist }
              : {}),
          };
          if (task.status === "claimed")
            task = await store.task.transition(
              task.id,
              task.version,
              "in_progress",
              `session ${session.id} started work`,
              { agentId: agent.id },
            );
          // W15-27 (TR-15): a task whose last run finished and whose review a limit refused is
          // reviewed now, without running its specialist again, while its attempt and its work
          // are unchanged; anything else runs it again, as before. Before, the next session ran
          // the specialist again first (live check 2, RUN-6), although its card said the work
          // was done and only its review waited.
          const kept = await this.reviewOnlyResult(task);
          // W15B-14: the session log says the waiting review goes on (before: nothing until the
          // verdict, and no "started" line, since the specialist does not run). Not a
          // `task.started`: no `task.finished` follows a pass without a run, and the session
          // page, the drawer, the project's header and the chat read the last `task.started` as
          // the task in flight, so they said the reviewed task still ran after its verdict.
          if (kept)
            await emit(REVIEW_RESUMED_EVENT, {
              taskId: task.id,
              title: task.title,
              specialist: "critic",
            });
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
          const chosenItem: PlanItem = chosen ? { ...item, specialist: chosen } : item;
          // d1116-budget-all (BA-4): the room its review needs in its own budget (R + W), for the
          // executor to keep out of the run's cap when the budget can hold it (a copy: the plan's
          // item is not changed).
          const reviewRoom = await this.reviewRoomOf(task, chosenItem);
          const runItem: PlanItem =
            reviewRoom > 0 ? { ...chosenItem, reviewRoomUsdMicro: reviewRoom } : chosenItem;
          const before = startedWith.get(task.id);
          const again = before !== undefined;
          // Who ran it last, in this session or an earlier one: another specialist taking over
          // says so ("The migration specialist takes over … from the coder").
          const previous = before ?? (chosen ? await lastWorkSpecialist(store, task.id) : null);
          // The log's start line is written when the run really starts (the leftovers of wave
          // 7, W5-20): the executor says so (`onStarted`) after its credential pick and any
          // hand-over, with the specialist that runs. Before, it was written here, so a run
          // handed to another specialist for the web named the planned one, and a task whose
          // credential pick then waited read "The writer started …" although nothing ran. An
          // executor that does not say it is started at its first step, or when it returns
          // (unless it waited for a credential before any run).
          let started = false;
          const sayStarted = async (specialist: string) => {
            if (started) return;
            started = true;
            startedWith.set(task.id, specialist);
            await emit("task.started", {
              taskId: task.id,
              title: task.title,
              specialist,
              estimateUsdMicro: item.estimateUsdMicro,
              ...(again ? { again: true } : {}),
              ...(previous && previous !== specialist ? { handedFrom: previous } : {}),
            });
          };
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
          // The review-only pass writes no brief: what was said waits for a run.
          const said = kept ? [] : heard.filter((h) => h.deliveredTo === null);
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
          const notes = kept ? [] : notesForTask(brief.queue.items, task, [...knownTasks.values()]);
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
          // W15-21 (design §4.14): each model call's cost reaches the task while it runs, not
          // only when the run returns (the drawer and the Tasks row read CHF 0.00 until then);
          // what was booked live is not added again at the end.
          let bookedLive = 0;
          const recordStep = async (t: TaskRow, step: TaskStep) => {
            if (step.kind === "model") {
              const cost = Math.max(0, step.costUsdMicro);
              await store.session.recordSpend(session.id, cost, 1);
              if (cost > 0) {
                await store.task.addCost(t.id, cost);
                bookedLive += cost;
              }
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
            result =
              kept ??
              (await this.deps.executor.execute({
                task,
                session,
                token,
                budget,
                item: runItem,
                signal: taskController.signal,
                heard: said.map(({ deliveredTo: _to, ...line }) => line),
                ...(notes.length ? { notes } : {}),
                ...(opts.note?.trim() ? { sessionNote: opts.note.trim() } : {}),
                onStarted: ({ specialist, switched, continues, sourceKind }) => {
                  const startedAt = clock.nowIso();
                  steps = steps
                    .then(() => sayStarted(specialist))
                    // C5-left-1 (CE-11): the switch's line after the start line; the back line
                    // when this run is on the first choice again.
                    .then(() =>
                      switched
                        ? saySwitch(task, switched, continues === true, startedAt)
                        : sourceKind
                          ? sayBack(sourceKind)
                          : undefined,
                    )
                    .catch((e: unknown) =>
                      this.logger.warn("start not recorded", { error: errorMessage(e) }),
                    );
                },
                onStep: (step) => {
                  steps = steps
                    .then(() => sayStarted(runItem.specialist))
                    .then(() => recordStep(task, step))
                    .catch((e: unknown) =>
                      this.logger.warn("step not recorded", { error: errorMessage(e) }),
                    );
                },
              }));
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
          // An executor that never said it started (a person's task, a test's executor) is
          // started now, before its end; a task whose credential pick waited before any run
          // never started, and its wait's line says so.
          if (result.outcome !== "usage_limit" && !result.reviewOnly)
            await sayStarted(result.specialist ?? runItem.specialist);
          // TR-13: added in one statement, so the tail a stopped run reports later (added the
          // same way, `lateRunCost`) is never written over by this. W15-21: less what each model
          // call already booked while it ran (the steps are all recorded before this).
          await steps;
          const rest = (result.costUsdMicro ?? 0) - bookedLive;
          if (rest > 0) await store.task.addCost(task.id, rest);
          task = await store.task.mustGet(task.id);
          await store.task.patch(task.id, {
            ...(result.prUrl ? { pr_url: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(task.owner_agent_id ? {} : { owner_agent_id: agent.id }),
          });
          task = await store.task.mustGet(task.id);
          // A run the person cancelled changed nothing that stays (`recordMove` sets it aside):
          // the session's result and the task's files never list it.
          if (result.changedFiles?.length && task.status !== "cancelled" && !result.reviewOnly) {
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
          if (!result.reviewOnly)
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
          // d1116-budget-all (BA-7): the finished hook waits for the task's close
          // (`closeIfFinished`), after the verdict that closes it.
          finishedRuns.set(task.id, {
            sessionId: session.id,
            task,
            item,
            result,
            durationMs: Math.max(0, Math.round(clock.monotonic() - execStarted)),
          });
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
            // A second task waiting for the same credential is a detail (design §4.5: a blocker
            // is named once); the session's end says the wait again.
            const sameWait =
              !!credentialWait &&
              !!result.credentialWait &&
              credentialWait.sourceId === result.credentialWait.sourceId &&
              credentialWait.reason === result.credentialWait.reason;
            const tries = (movedOnCredential.get(task.id) ?? 0) + 1;
            movedOnCredential.set(task.id, tries);
            const waits = !!result.credentialWait || tries > MAX_CREDENTIAL_MOVES;
            // C5-left-1 (CE-11): when another credential takes over now, the run that goes on
            // writes the switch's line ('"X" goes on with your API key from where it stopped:
            // ...'), once per stop and session; this stop's own line is then a detail. Before,
            // the log said '...; "X" continues on your API key now.' and again for each task.
            await emit(BILLING_FALLBACK_EVENT, {
              taskId: task.id,
              title: task.title,
              sentence: result.summary,
              ...(sameWait || !waits ? { repeat: true } : {}),
            });
            await releaseIfHeld(
              task.id,
              waits ? CREDENTIAL_WAIT_REASON : "a Claude credential could not serve: back to ready",
            );
            if (waits) {
              // Nothing this task may run on can be billed now: it waits (one sentence, no
              // failed task) and starts by itself at the reset, or once a new credential is
              // saved (the executor noted the wait). Only this task waits (ADR 0100 point 10):
              // the session goes on with the rest of its queue, where each task's own pick
              // decides whether it runs now or waits too. Before, the session ended here and
              // skipped the queue, a task whose first choice could serve now included (the
              // leftovers of wave 7).
              credentialWait ??= result.credentialWait ?? null;
              waitedForCredential = true;
              skipped.push(task.id);
              notAgain.add(task.id);
              continue;
            }
            // Another credential takes over now ("Use the other one", or after a refusal): the
            // task goes on at once in this session.
            queue.unshift(item);
            continue;
          }
          lessonCandidates.push(...(result.lessons ?? []));
          // d1109-selftasks-run: the report's "For the task list:" lines, for the next boundary.
          if (result.taskListNotes?.length)
            taskListNotes.push({
              source: "report",
              taskId: task.id,
              taskTitle: task.title,
              specialist: result.specialist ?? runItem.specialist,
              runId: result.runId ?? null,
              lines: result.taskListNotes,
              at: clock.nowIso(),
            });
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
            } else if ("refused" in reviewed) {
              // A limit or a credential refused the review before its verdict (the leftovers of
              // wave 7): nobody judged the work, so it is no verdict and no failed try. Before,
              // the critic made it an "escalate" verdict: the retry ladder ran the specialist
              // again up to four times and filed '"X" failed 4 times'. A task the person moved
              // meanwhile stays as they set it.
              const now = await store.task.mustGet(task.id);
              if (now.status !== "in_review") {
                await recordMove(now, "review_failed", "review", stoppedByMove(reviewController));
                continue;
              }
              const refusal = reviewed.refused;
              if (refusal.kind === "credential") {
                // ADR 0100 point 9: the work waits; it never fails for want of a credential. The
                // task goes back to ready without a try (as a run a credential stopped), the
                // project is kept on the credential it waits for, and the session's wait line
                // says when it goes on; the next session runs it and reviews it.
                const wait = refusal.wait as CredentialWait;
                await store.task.restoreStatus(
                  now.id,
                  now.version,
                  "in_review",
                  CREDENTIAL_WAIT_REASON,
                  { agentId: agent.id },
                );
                heldClaims.delete(task.id);
                notAgain.add(task.id);
                // W15-27: the work waits only for its review; it is reviewed without a run.
                await this.keepForReview(now, result, runItem.specialist);
                const owner = await store.human.get(agent.owner_human_id).catch(() => undefined);
                const personsOwn =
                  startedBy?.by === "person" ||
                  startedBy?.by === "continuation" ||
                  opts.personSchedule === true;
                await emit(BILLING_FALLBACK_EVENT, {
                  taskId: task.id,
                  title: task.title,
                  review: true,
                  sentence: stoppedRunSentence(
                    { reason: stopReasonOf(wait), kind: wait.kind },
                    task.title,
                    { wait },
                    {
                      ...(owner?.timezone ? { timezone: owner.timezone } : {}),
                      nowMs: clock.now(),
                      // S-10: the person's own session goes on after the wait, when their
                      // quiet hours end if they hold it past the reset.
                      goesOn: personsOwn,
                      ...(personsOwn && wait.reason === "limit"
                        ? goesOnAtWords(owner, wait.until)
                        : {}),
                    },
                  ),
                });
                // As a task a credential stopped (U-078): only this task waits, and the session
                // goes on with the rest; it starts by itself once the credential serves.
                credentialWait ??= wait;
                waitedForCredential = true;
                skipped.push(task.id);
                continue;
              }
              // ADR 0112 point 6: the review paused at its limit, as a run does: one card that
              // names the limit (Continue where a bigger budget helps; at the project's budget,
              // the month's cap or the subscription's share the task goes on by itself once that
              // limit changed), and a stop at an outer limit or the session's own ends the
              // session. The next session reviews the kept result without running the specialist
              // again when the attempt and the changed files are unchanged (W15-27,
              // `keepForReview` / `reviewOnlyResult`), else it runs the task again first.
              const rate = this.deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD;
              const source = reviewStopSource(refusal.level, reviewed.capSource);
              const stop: BudgetStop = {
                capUsdMicro:
                  source === "task_budget"
                    ? now.budget_usd_micro
                    : source === "session"
                      ? budget.limits.budgetUsdMicro
                      : (refusal.capUsdMicro ?? budget.limits.budgetUsdMicro),
                spentUsdMicro: now.actual_cost_usd_micro,
                source,
                specialist: result.specialist ?? runItem.specialist,
                stoppedBy: "budget",
              };
              // L4-money-111: the work is done; the title says only the review waits.
              const title = budgetStopTitle(now, stop, rate, { reviewWaits: true });
              const waiting = await store.task.transition(
                now.id,
                now.version,
                "needs_human",
                `${title}.`,
                { agentId: agent.id },
              );
              needsHuman.push(task.id);
              try {
                await fileBudgetStopCard({
                  store,
                  task: waiting,
                  session,
                  humanId: agent.owner_human_id,
                  agentId: agent.id,
                  runId: result.runId ?? null,
                  stop,
                  handoff: null,
                  // TR-14: the specialist finished; only the review waits for room.
                  reviewWaits: true,
                  now: clock.nowIso(),
                  chfPerUsd: rate,
                  // d1116-budget-all (BA-5): one Continue gives the review what its calls need.
                  ...(source === "task_budget"
                    ? {
                        needsUsdMicro: await this.needsAtTaskBudget(waiting, runItem, 0, {
                          refusedUsdMicro: refusal.estimateUsdMicro ?? null,
                        }),
                      }
                    : {}),
                });
              } catch (e) {
                this.logger.warn("card of the paused review not filed", {
                  taskId: task.id,
                  error: errorMessage(e),
                });
              }
              // W15-27: the run's result is kept for the review alone (TR-15).
              await this.keepForReview(waiting, result, runItem.specialist);
              await emit(REVIEW_PAUSED_EVENT, {
                taskId: task.id,
                title: task.title,
                source,
                text: reviewPausedWords(task.title, stop, (n) =>
                  formatChf(usdToChfMicro(Math.max(0, Math.round(n)), rate)),
                ),
              });
              if (stopEndsSession(source)) {
                stopReason = budgetStopReasonOf(source);
                // The subscription's share is a fraction, not money: no amount is kept.
                stopCapUsdMicro = source === "plan" ? null : stop.capUsdMicro;
                skipped.push(...queue.map((i) => i.taskId));
                queue.length = 0;
                break;
              }
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
              // d1109-selftasks-run: the critic's findings the task did not cause, for the next
              // boundary's task check (data, flagged where they read like an instruction).
              // l4-selftasks-102: only those (ADR 0119 point 3); an ordinary note about the
              // task's own work is no evidence and pays for no check.
              if (reviewed.reviewId && this.deps.taskCheck) {
                const notes = reviewNoteLines(
                  (
                    await store.finding.list({ review_id: reviewed.reviewId } as never, {
                      limit: 50,
                    })
                  )
                    .filter(notCausedByTask)
                    .map((f) => f.description),
                );
                if (notes.length)
                  taskListNotes.push({
                    source: "review",
                    taskId: task.id,
                    taskTitle: task.title,
                    specialist: null,
                    runId: result.runId ?? null,
                    lines: notes,
                    at: clock.nowIso(),
                  });
              }
              // A resolved finding always comes from an earlier review, so its row is loaded:
              // the lesson says what was wrong and what fixed it, not that something was.
              for (const id of reviewed.resolvedFindingIds) {
                const finding = await store.finding.get(id);
                lessonCandidates.push({
                  text: `Critic finding resolved on "${task.title}" (${result.specialist ?? runItem.specialist}): ${
                    finding
                      ? // L3-left-7 (d1109-chat-recall): a finding the critic named no fix for
                        // reads as what it found, as run L3 made Reviews and the cards say it.
                        withoutNoActionGiven(
                          `[${finding.severity}] ${finding.description} -> ${finding.required_action}`,
                        )
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
              // The verdict that closes the task (an accept, or failed after its tries): its
              // sample, with every try and every review (d1116-budget-all, BA-7).
              await closeIfFinished(task.id);
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
            // d1109-oversize-pause (OP-2, OP-4): what the pause kept, checked and compared with
            // the task's last pause, kept on its Run row; and whether it got further.
            const pause =
              result.outcome === "paused" && result.budgetStop
                ? await this.keepPausedWork(task, item, result, controller.signal)
                : null;
            // OP-5 (the owner's "the agent will do as much as it can"): a pause at its
            // specialist's limit per run is one run's bound, not the session's: while it got
            // further, the session still takes new work, a fifth of the work budget is left, the
            // person did not press Stop after this task and the runs allow, the task goes on at
            // once from where it stopped, with no card in between. Never at its own budget or an
            // outer limit, and never after a pause that got no further.
            if (
              pause &&
              result.budgetStop?.source === "specialist_limit" &&
              pause.progress &&
              !budget.noNewWork &&
              budget.workRemainingUsdMicro() >= oversizedMinRoomUsdMicro(workBudgetUsdMicro) &&
              (runsOf.get(task.id) ?? 0) < MAX_RUNS_PER_TASK_IN_SESSION &&
              (await store.session.get(session.id))?.status !== "paused"
            ) {
              await releaseIfHeld(task.id, "it goes on in this session from where it stopped");
              await emit(TASK_CONTINUES_EVENT, {
                taskId: task.id,
                title: task.title,
                specialist: result.budgetStop.specialist,
              });
              // A run again of the same planned task: no second take of a larger one, nothing
              // added to the plan's figure (L3-run-2).
              queue.unshift({ ...item, wholeEstimateUsdMicro: undefined, again: true });
              continue;
            }
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
                  // OP-8: one place per fact: the card stores what every screen reads of it.
                  ...(pause
                    ? {
                        noProgress: !pause.progress,
                        keptChecks: pause.checks,
                        estimateUsdMicro: pause.estimateUsdMicro,
                        estimateLeftUsdMicro: pause.estimateLeftUsdMicro,
                        runSpentUsdMicro: Math.max(0, result.costUsdMicro),
                      }
                    : {}),
                  // d1116-budget-all (BA-5): at its own budget, what one Continue must add so
                  // the work's estimate left and its review's first call fit.
                  ...(pause && result.budgetStop.source === "task_budget"
                    ? {
                        needsUsdMicro: await this.needsAtTaskBudget(
                          waiting,
                          runItem,
                          pause.estimateLeftUncappedUsdMicro,
                        ),
                      }
                    : {}),
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
            const after =
              result.outcome === "paused" &&
              result.budgetStop &&
              stopEndsSession(result.budgetStop.source)
                ? roomAfterPause(result.budgetStop, queue)
                : "go_on";
            if (after !== "go_on" && result.budgetStop) {
              // The session names the limit that ended it (review of budget-stop): before, it
              // said "the session's budget is used" at 1% of its own budget. L4-money-102: a
              // pause at the session's work budget that left room, too little for the tasks
              // after it, is no budget stop (its result says what the larger task left).
              if (after === "end") {
                stopReason = budgetStopReasonOf(result.budgetStop.source);
                // The subscription's share is a fraction (0..1), not money: no amount is kept
                // (the leftovers of wave 7: it was stored converted as if it were USD).
                stopCapUsdMicro =
                  result.budgetStop.source === "plan" ? null : result.budgetStop.capUsdMicro;
              }
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
        // Tasks that wait for a credential (U-078): the session ran what could run and ends on
        // the wait's sentence.
        if (stopReason === "completed" && waitedForCredential) stopReason = CREDENTIAL_WAIT_STOP;
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
      if (liveHandle) liveHandle.closing = true;
      unregisterLive();
      await releaseAll(personStop ? taskReasonForStop(personStop) : `session ${stopReason}`);
      unregister();
    }

    // S-10 (ADR 0118; the owner, 2026-11-09: "A session the person started keeps going by itself
    // until its work is done, including after a credential wait inside it"): a session the
    // person started (or a continuation of one, or a schedule the person set) that ended to wait
    // for its Claude credential keeps its continuation on the wait, with the rest of its budget,
    // once; never one the person stopped (Stop after this task, Stop now) or that was wrapping
    // up when it ended to wait, and none with nothing of its budget left.
    let goesOn = false;
    if (waitedForCredential && credentialWait && project && this.deps.continuation) {
      const who = startedBy?.by;
      const persons = who === "person" || who === "continuation" || opts.personSchedule === true;
      const row = await store.session.get(session.id).catch(() => undefined);
      const stopping = row?.status === "paused" || personStop !== null || budget.noNewWork;
      const left =
        opts.budgetCapUsdMicro - (row?.spent_usd_micro ?? budget.snapshot().sessionSpentUsdMicro);
      if (persons && !stopping && left > 0)
        goesOn = await this.deps.continuation
          .keep(project.id, { continues: session.id, budgetUsdMicro: left, at: clock.nowIso() })
          .catch((e: unknown) => {
            this.logger.warn("the continuation of a session was not kept", {
              sessionId: session.id,
              error: errorMessage(e),
            });
            return false;
          });
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
    // d1109-selftasks-run (ADR 0119 point 9): evidence no check handled (its cap, the wrap-up
    // line, three checks done, the session's end) is kept on the project for the next session's
    // first boundary and chat's "fix the tasks"; notes it took from the project and did not
    // check are still there.
    if (project && taskListNotes.length)
      await keepNotes(
        store,
        project.id,
        taskListNotes.filter((n) => !fromProject.has(n)),
      ).catch((e: unknown) =>
        this.logger.warn("the task list notes were not kept", { error: errorMessage(e) }),
      );
    const endState = await collectEndState(store, project?.id ?? null, [
      ...completed,
      ...inReview,
      ...failed,
      ...needsHuman,
      ...reviewFailed,
      ...blockedByFindings,
      ...retried,
      ...skipped,
      ...cancelled,
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
                // A limit no Continue lifts: it goes on by itself once raised or reset.
                ...(offersContinue(source) ? {} : { waits: true }),
                // L3-research-2: its run heard the wrap-up and paused before the limit ran out.
                ...(card.stopped_by === "wrap_up" && card.review_waits !== true
                  ? { before: true }
                  : {}),
                // L4-money-111: the work is done and only its review waits for room.
                ...(card.review_waits === true ? { reviewWaits: true } : {}),
                // d1109-oversize-pause (OP-7, OP-8): from the card, the one place of the fact.
                ...failedChecksOf(card),
                ...(card.no_progress === true ? { noProgress: true } : {}),
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
      // L4-money-214: what the person paused while it ran (Pause or Stop), still paused by them.
      ...(uniq(needsHuman).some(pausedByYou)
        ? { pausedByYou: uniq(needsHuman).filter(pausedByYou).map(named) }
        : {}),
      // W15-59: what the person cancelled while it ran or was reviewed, still cancelled now.
      ...(uniq(cancelled).some((id) => endState.rows.get(id)?.status === "cancelled")
        ? {
            cancelled: uniq(cancelled)
              .filter((id) => endState.rows.get(id)?.status === "cancelled")
              .map(named),
          }
        : {}),
      stopReason,
      // The outer limit's amount, while the session still ends there (ADR 0112).
      ...(stopCapUsdMicro !== null && stopLimitWords(stopReason) !== null
        ? { stopCapChfMicro: usdToChfMicro(stopCapUsdMicro, rate) }
        : {}),
      ...(credentialWait
        ? {
            credentialWait: waitSentence(credentialWait, {
              goesOn,
              // S-10: the continuation goes on when the person's quiet hours end, if later.
              ...(goesOn ? goesOnAtWords(waitOwner, credentialWait.until) : {}),
              ...(waitOwner?.timezone ? { timezone: waitOwner.timezone } : {}),
              nowMs: clock.now(),
            }),
          }
        : {}),
      spentChfMicro: spentChf,
    };
    const readyAtEnd = (id: string) =>
      endState.readyNow.some((r) => r.id === id) && !completed.includes(id);
    // D7 (d1109-selftasks-run): a promised task a step added before it took out of the promise
    // is not runnable while it waits for that step; it is named with it ("which waits for it").
    const leftForNext = [...asked]
      .filter(
        ([id, t]) =>
          readyAtEnd(id) ||
          (!!t.waitsFor &&
            !completed.includes(id) &&
            [...asked].some(([sid, s]) => s.title === t.waitsFor && readyAtEnd(sid))),
      )
      .map(([id, t]) => ({ id, ...t }));
    if (leftForNext.length)
      await emit(LEFT_FOR_NEXT_START_EVENT, {
        tasks: leftForNext.map((t) => ({
          taskId: t.id,
          title: t.title,
          estimateUsdMicro: t.estimateUsdMicro,
        })),
      });
    const resultFacts = {
      outcome,
      inReview: inReviewNow.map(named),
      leftOutForBudget: (plan?.leftOutForBudget ?? [])
        .filter((i) => endState.readyNow.some((r) => r.id === i.taskId))
        .map((i) => ({
          id: i.taskId,
          title: i.title,
          estimateChfMicro: usdToChfMicro(Math.max(0, Math.round(i.estimateUsdMicro)), rate),
          // D4: why it waits (after a task larger than the session, or too little left).
          ...(i.reason ? { reason: i.reason } : {}),
          ...(i.reason === "after_large" && i.after ? { after: i.after } : {}),
        })),
      // S-7: work that asked to join and did not fit, still ready now (not run here).
      ...(leftForNext.length
        ? {
            leftForNextStart: leftForNext.map((t) => ({
              id: t.id,
              title: t.title,
              estimateChfMicro: usdToChfMicro(Math.max(0, Math.round(t.estimateUsdMicro)), rate),
              ...(t.waitsFor ? { waitsFor: t.waitsFor } : {}),
            })),
          }
        : {}),
      // d1109-selftasks-run: what the agent changed in its own task list.
      ...(tasksChanged.length ? { tasksChanged } : {}),
      sessionCapChfMicro: usdToChfMicro(opts.budgetCapUsdMicro, rate),
      ...(plan?.workBudgetUsdMicro !== undefined
        ? {
            workBudgetChfMicro: usdToChfMicro(plan.workBudgetUsdMicro, rate),
            // L4-money-102: what was left of it at the end, as the session's budget counts it.
            workLeftChfMicro: usdToChfMicro(budget.workRemainingUsdMicro(), rate),
          }
        : {}),
      openTasks: endState.openTasks,
      mergedPrs: merges.filter((m) => m.status === "merged").length,
      // merge-in-app: a merge that waits for its checks (or a silent GitHub) merges by itself
      // later, so it is not one the person must merge.
      openPrs: merges.filter((m) => m.status !== "merged" && !MERGE_WAITS.has(m.status)).length,
      // W15-70: the checks that still run and a GitHub that did not answer, said apart.
      checksPendingPrs: merges.filter((m) => m.status === "checks_pending").length,
      unansweredPrs: merges.filter((m) => m.status === "unreachable").length,
    };
    const resultLines = sessionResultLines(resultFacts);
    const summary = resultLines.join("\n");
    // What the session says beyond its cards (design §4.3, §5.10: the person hears once): each
    // open card was notified when it was filed and stands in the Inbox's Needs you, so the
    // Update and the session-end notification leave out what a card says (the session page and
    // the Overview keep the whole result). Before, one failed task was told by its card, by the
    // session end's '"X" needs your decision' and by an Update under the card (phase E, #87).
    // l4-cred-engine L4-creds-3: the person's open card of the credential stop the session waits
    // for (Anthropic refused it, or the stop's ask card; neither has a project) tells the wait.
    const credentialCard = credentialWait
      ? (
          await store.humanRequest
            .open({ humanId: agent.owner_human_id }, { limit: 200 })
            .catch(() => [])
        ).some((r) => {
          const card = (r.change_card ?? {}) as {
            key?: unknown;
            source_id?: unknown;
            stop_key?: unknown;
          };
          if (card.source_id !== credentialWait?.sourceId) return false;
          // fixup-l4-cred-engine (review): a card tells only its own stop's wait. Before, an
          // open ask card of an earlier stop on the same credential hid this session's wait, so
          // the person heard of it from nothing.
          if (card.key === CREDENTIAL_REFUSED_KEY) return credentialWait?.reason === "refused";
          return (
            card.key === CREDENTIAL_ASK_KEY &&
            (!credentialWait?.stopKey || card.stop_key === credentialWait.stopKey)
          );
        })
      : false;
    const news = sessionResultLines(resultFacts, {
      tasks: carded,
      docker: openCards.some(isDockerCard),
      plan: true,
      ...(credentialCard ? { credential: true } : {}),
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
        // How it ended, as the Sessions list says it (the handoff's blocked and paused), never
        // the raw stop reason (L3-github-6: "Note: stop reason completed; spent CHF 0.09").
        const pausedIds = new Set((outcome.paused ?? []).map((t) => t.id));
        // L4-money-214: a task the person paused waits on nobody (as `needsYouNow` reads it);
        // before, the note said "Ended: 1 task needs you." for their own Stop.
        const waits = uniq([...needsHuman, ...failed]).filter((id) => !pausedByYou(id));
        // L4g-left-3 (l4-starts-carried): one money wording everywhere (W14-6): an amount above
        // zero never reads "CHF 0.00" (the result beside it says "Less than CHF 0.01.").
        const endedNote = `${endedStatusText(status, stopReason, {
          needYou: waits.filter((id) => !pausedIds.has(id)).length,
          paused: waits.filter((id) => pausedIds.has(id)).length,
        })}. Spent ${moneyWords(formatChf(spentChf), spentChf)}.`;
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
              note: endedNote,
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
      // The tasks paused at a budget with their card open (ADR 0112): the session review grades
      // a pause as a pause, not as work that waits for the person (the leftovers of wave 7).
      paused: (outcome.paused ?? []).map((t) => t.id),
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
      // What the session did, named (d1109-sessions, ADR 0116): the project's Sessions list and
      // the session page read it from the row itself, after a restart and after later sessions
      // (before, only the project's last session kept it, in the project's cache).
      outcome,
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
      // d1109-selftasks-run: the one Update counts the agent's changes to its tasks.
      tasksChanged,
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
        // L3-run-8 (live check 3): a review that sends nothing back of a session whose work
        // waits only for the person (nothing done or sent back; each task it left waiting or
        // failed holds its card) says what they can do: answer the questions, or decide in the
        // Inbox (a failed task's card: Try again, Mark done anyway, Cancel task). Before, it
        // read "Session review: sent back for changes" (its verdict's words for a task review)
        // though nothing was sent back.
        const waitingOnYou = [...needsYouNow.filter((id) => !pausedCards.has(id)), ...failedNow];
        const sentBackHere = retried.filter(
          (id) => !completed.includes(id) && !failed.includes(id) && !needsHuman.includes(id),
        );
        const cardOf = (id: string) => openCards.find((r) => r.task_id === id && holdsTask(r));
        const waitsFor =
          sessionReview.verdict === "revise" &&
          waitingOnYou.length > 0 &&
          doneNow.length === 0 &&
          sentBackHere.length === 0 &&
          waitingOnYou.every((id) => cardOf(id))
            ? waitingOnYou.every((id) => cardKindOf(cardOf(id)) === "questions")
              ? ("answers" as const)
              : ("decision" as const)
            : null;
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
            ...(waitsFor ? { waitsFor } : {}),
            // L4-money-112: what a revise noted, for the line the person reads (its first finding
            // above low, a fact of the store, never a model's words).
            ...(sessionReview.verdict === "revise" && reviseCause(sessionReview.findings)
              ? { noted: reviseCause(sessionReview.findings) }
              : {}),
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
      // not "needs you" (design §2); W15-69: a task paused at a budget is counted as paused.
      needsHuman: needsYouNow.filter((id) => !pausedCards.has(id)).length,
      paused: pausedNow.length,
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
    // C5-left-1 (CE-11): the tasks it moved, summed from the ledger.
    const switchedTasks = (await sessionSwitches(store, session.id).catch(() => null))?.tasks ?? [];
    return {
      ...(switchedTasks.length ? { switched: switchedTasks } : {}),
      sessionId: session.id,
      status: finalStatus,
      brief: brief as StateBrief,
      plan,
      completed,
      inReview,
      failed,
      skipped: notStarted,
      needsHuman,
      ...(outcome.paused?.length ? { paused: outcome.paused.map((t) => t.id) } : {}),
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
   * d1109-oversize-pause (OP-2, OP-4, OP-8): what a paused run kept, kept on its Run row as
   * `{ kept }` (`keptArtifact`): the fingerprint of the files the task changed (`workHash`), and
   * the project's own checks on that work when the run changed a code file and the daemon wired
   * the check (`keptWorkCheck`: in the task's sandbox, no network, no model, nothing booked; its
   * output redacted). Whether it got further than the task's last paused run (`madeProgress`),
   * and the task's estimate and what is left of it, for its card. A failure to check or keep it
   * is logged and counts as progress: the pause is filed as before.
   */
  private async keepPausedWork(
    task: TaskRow,
    item: PlanItem,
    result: TaskExecutionResult,
    signal: AbortSignal,
  ): Promise<PausedWork> {
    const { store } = this.deps;
    const files = result.changedFiles ?? [];
    let hash = "";
    let progress = true;
    let checks: KeptCheck[] | undefined;
    let notRun: string | undefined;
    try {
      hash = workHash(result.worktree, files);
      // The task's earlier pauses: a wrap-up (`paused`) or a hard stop at a limit
      // (`budget_exceeded`, a pause at the project's budget or this month's cap is mostly one).
      // Before (the review of d1109-oversize-pause), only `paused` counted, so a hard stop at the
      // project's budget that got no further was never one, and its card went on by itself at
      // each raise.
      const earlier = (await store.run.forTask(task.id))
        .filter(
          (r) =>
            r.specialist !== "critic" &&
            !r.parent_run_id &&
            r.id !== result.runId &&
            KEPT_WORK_OUTCOMES.includes(r.outcome),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const last = earlier.find((r) => keptOf(r.artifacts));
      const lastKept = last ? keptOf(last.artifacts) : null;
      // C2-left-3: what the run said (its report and handoff) counts too.
      const thisRun = result.runId ? await store.run.get(result.runId) : undefined;
      progress = madeProgress(
        {
          hash,
          leftToDo: result.handoff?.leftToDo.length ?? 0,
          said: pauseSaid(thisRun?.artifacts, result.handoff ?? null),
        },
        last && lastKept
          ? {
              hash: lastKept.hash,
              leftToDo: handoffOf(last.artifacts)?.leftToDo.length ?? 0,
              said: pauseSaid(last.artifacts, handoffOf(last.artifacts)),
            }
          : null,
      );
      if (this.deps.keptWorkCheck && isCodeChange(files)) {
        const checked = await this.deps.keptWorkCheck({
          task,
          worktree: result.worktree ?? null,
          changedFiles: files,
          signal,
        });
        checks = checked.checks;
        notRun = checked.notRun;
      }
      if (result.runId) {
        const run = await store.run.get(result.runId);
        if (run)
          await store.run.patch(run.id, {
            artifacts: [
              ...(run.artifacts ?? []).filter(
                (a) => !(a && typeof a === "object" && !Array.isArray(a) && "kept" in a),
              ),
              keptArtifact({
                hash,
                ...(checks ? { checks } : {}),
                ...(notRun ? { notRun } : {}),
                ...(progress ? {} : { noProgress: true }),
              }) as never,
            ],
          });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      this.logger.warn("the paused run's kept work was not checked", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
    const fresh = (await store.task.get(task.id)) ?? task;
    // Priced as the planner and the Start check price it (the learned estimate when there is
    // one), so the card's Continue and the next Start's plan agree on what is left.
    const estimateUsdMicro =
      this.deps.planner.wholeEstimateOf?.(fresh) ??
      (fresh.est_cost_usd_micro > 0
        ? fresh.est_cost_usd_micro
        : (item.wholeEstimateUsdMicro ?? item.estimateUsdMicro));
    const uncapped = estimateLeftUsdMicro(
      estimateUsdMicro,
      await keptWorkFor(store, fresh),
    ).usdMicro;
    const left = { usdMicro: withinTaskBudget(uncapped, fresh) };
    return {
      progress,
      ...(checks
        ? {
            checks: {
              passed: checks.filter((c) => c.passed).map((c) => c.name),
              failed: checks.filter((c) => !c.passed).map((c) => c.name),
            },
          }
        : {}),
      estimateUsdMicro,
      estimateLeftUsdMicro: left.usdMicro,
      // d1116-budget-all (BA-5): before the budget caps it, what Continue's needs count from.
      estimateLeftUncappedUsdMicro: uncapped,
    };
  }

  /**
   * d1116-budget-all (BA-5): what a task paused at its own budget needs beyond what is left of it,
   * so one Continue lets it finish and be reviewed: its estimate left (`workUsdMicro`, uncapped;
   * it holds the review part) plus one critic call's worst case, less what is left. For a review
   * that waits, `review` gives the review part and the refused call's estimate: the review part
   * plus the larger of that call and one call's worst case, less what is left. Never below 0.
   */
  private async needsAtTaskBudget(
    task: TaskRow,
    item: PlanItem,
    workUsdMicro: number,
    review?: { refusedUsdMicro: number | null },
  ): Promise<number> {
    const fresh = (await this.deps.store.task.get(task.id).catch(() => undefined)) ?? task;
    const left = Math.max(0, fresh.budget_usd_micro - fresh.actual_cost_usd_micro);
    const worst =
      (await this.deps.critic?.reviewCallUsdMicro?.(fresh, item.specialist).catch(() => null))
        ?.worstUsdMicro ?? 0;
    const needs = review
      ? (this.deps.planner.reviewPartOf?.(fresh) ?? 0) +
        Math.max(review.refusedUsdMicro ?? 0, worst)
      : workUsdMicro + worst;
    return Math.max(0, Math.round(needs - left));
  }

  /**
   * d1116-budget-all (BA-4): the room a task's review needs in its own budget: the review part of
   * its estimate (`R`) plus one critic call's worst case at its review tier (`W`, what the hooks
   * admit a call on), so a reading review's calls pass the precheck. 0 for a task without a
   * budget of its own (its review is the session's), or without a critic that prices its call.
   */
  private async reviewRoomOf(task: TaskRow, item: PlanItem): Promise<number> {
    // l4-money-pause, run L4 (L4-money-103): also for a task without a budget of its own, whose
    // run an outer limit's remainder may cap (the executor keeps the room there when it can).
    const critic = this.deps.critic;
    if (!critic?.reviewCallUsdMicro) return 0;
    try {
      const price = await critic.reviewCallUsdMicro(task, item.specialist);
      const review = this.deps.planner.reviewPartOf?.(task) ?? 0;
      return Math.max(0, Math.round(review + price.worstUsdMicro));
    } catch (e) {
      this.logger.warn("the review's room was not priced", {
        taskId: task.id,
        error: errorMessage(e),
      });
      return 0;
    }
  }

  /**
   * W15-27 (TR-15): keeps the result of a run whose review a limit refused on its Run row, for
   * the review-only pass. A failure to keep it only costs the rerun of today.
   */
  private async keepForReview(
    task: TaskRow,
    result: TaskExecutionResult,
    specialist: string,
  ): Promise<void> {
    if (!result.runId) return;
    try {
      await keepPending(
        this.deps.store,
        result.runId,
        reviewPendingOf(result, task.attempt, result.specialist ?? specialist),
      );
    } catch (e) {
      this.logger.warn("the run's result was not kept for its review", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }

  /** W15B-14: `{ card }` of the card a verdict filed, as `cardKindOf` reads it; {} unread. */
  private async verdictCardKind(requestId: string): Promise<{ card?: string }> {
    const row = await this.deps.store.humanRequest.get(requestId).catch(() => undefined);
    return row ? { card: cardKindOf(row) } : {};
  }

  /**
   * A task priced as the planner prices it now (S-6, S-7): its whole estimate (the learned one,
   * its own, its budget, the default), less what its paused runs kept, within its own budget.
   */
  private async priceNow(task: TaskRow): Promise<number> {
    const whole =
      this.deps.planner.wholeEstimateOf?.(task) ??
      (task.est_cost_usd_micro || task.budget_usd_micro || 500_000);
    return withinTaskBudget(
      estimateLeftUsdMicro(whole, await keptWorkFor(this.deps.store, task)).usdMicro,
      task,
    );
  }

  /**
   * W15-27 (TR-15): the kept result of the task's latest run, to review without running the
   * specialist, when the run kept one (`reviewPending`), the attempt is the same, the executor
   * can make its workspace ready (`prepareReview`) and the work there is unchanged (`workHash`).
   * The entry is cleared when the pass takes it, and when it no longer applies. Null: run it.
   */
  private async reviewOnlyResult(task: TaskRow): Promise<TaskExecutionResult | null> {
    const { store, executor } = this.deps;
    if (!this.deps.critic || !executor.prepareReview) return null;
    try {
      const run = await latestWorkRun(store, task.id);
      const pending = run ? pendingOfRun(run) : null;
      if (!run || !pending) return null;
      const ready = pending.attempt === task.attempt ? await executor.prepareReview(task) : null;
      const same = !!ready && workHash(ready.worktree, pending.changedFiles) === pending.workHash;
      await clearPending(store, run);
      if (!ready || !same) {
        this.logger.info("the kept result no longer matches the work: the specialist runs again", {
          taskId: task.id,
          attempt: task.attempt === pending.attempt,
          ready: !!ready,
        });
        return null;
      }
      return keptResult(run, pending, ready.worktree);
    } catch (e) {
      this.logger.warn("the review-only pass was not prepared: the specialist runs again", {
        taskId: task.id,
        error: errorMessage(e),
      });
      return null;
    }
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
  ): Promise<TaskReviewOutcome | ReviewFailure | ReviewRefused | null> {
    const { emit, ranBy, ...request } = req;
    const critic = this.deps.critic;
    if (!critic) return null;
    // L3-run-10 (live check 3): "The critic started ..." is said once the review runs (its
    // first model call under way, `onStarted`), or just before a verdict reached without one;
    // a review a limit refused before it ran says only that it paused. Before, the line came
    // first whatever happened: "The critic started a light review (attempt 1)." and then
    // '"X" paused before its review: the project's budget ... has no room for it.'
    let started: Promise<void> | null = null;
    const sayStarted = () => {
      started ??= emit("critic.review_started", {
        taskId: request.task.id,
        tier: request.task.risk_tier,
        attempt: request.task.attempt,
      }).catch((e: unknown) =>
        this.logger.warn("the review's start line was not written", {
          taskId: request.task.id,
          error: errorMessage(e),
        }),
      );
      return started;
    };
    // d1116-budget-all (the owner's "yes it should count critics reviews, and fixes."): each
    // of the review's model calls is added to the task's own figure as it ends, as each of the
    // work's calls is (W15-21, `recordStep`), one after the other; every branch below waits for
    // them, so the verdict, a refusal's pause and a failure's card all read the whole figure.
    // Booking never moves the task's version (`task.addCost`), and the review's total
    // (`outcome.costUsdMicro`) or a refusal's `spentUsdMicro` is never added again.
    let booked: Promise<void> = Promise.resolve();
    const taskId = request.task.id;
    const store = this.deps.store;
    const bookReview = (usdMicro: number) => {
      const cost = Math.max(0, Math.round(usdMicro));
      if (cost <= 0) return;
      booked = booked
        .then(() => store.task.addCost(taskId, cost))
        .then(
          () => {},
          (e: unknown) =>
            this.logger.warn("a review call's cost was not added to its task", {
              taskId,
              usdMicro: cost,
              error: errorMessage(e),
            }),
        );
    };
    // d1116-budget-all (BA-3): a task with a budget of its own is reviewed within what is left
    // of it, read now (the work and every earlier review are in its figure), so its reviews
    // never take it past its budget. A refusal at the review's own cap then names the task's
    // budget when that is what set the cap (no more than the session token's budget), and the
    // task pauses there with its work kept (ADR 0112); the session goes on. Without a budget of
    // its own the review stays under the session's token and its reserve, as before.
    const fresh = (await store.task.get(taskId)) ?? request.task;
    const left =
      fresh.budget_usd_micro > 0
        ? Math.max(0, fresh.budget_usd_micro - fresh.actual_cost_usd_micro)
        : undefined;
    const capSource: ReviewRefused["capSource"] =
      left !== undefined && left <= request.token.claims.budgetUsdMicro ? "task_budget" : "session";
    if (left !== undefined) {
      // Not started: what is left is below the price of the review's output cap alone, a lower
      // bound of its first call. No check runs, no critic Run row is written, and the task
      // pauses as at a refused first call.
      const price = await critic
        .reviewCallUsdMicro?.(fresh, request.item.specialist)
        .catch((e: unknown) => {
          this.logger.warn("the review's price was not read", { taskId, error: errorMessage(e) });
          return null;
        });
      if (price && left < price.floorUsdMicro)
        return {
          refused: {
            kind: "budget",
            level: "task",
            capUsdMicro: fresh.budget_usd_micro,
            spentUsdMicro: 0,
            message: "the task's budget has no room for its review",
            estimateUsdMicro: price.floorUsdMicro,
          },
          capSource: "task_budget",
        };
    }
    let outcome: TaskReviewOutcome;
    try {
      outcome = await critic.reviewTask({
        ...request,
        onStarted: () => {
          void sayStarted();
        },
        onCost: bookReview,
        ...(left !== undefined ? { budgetUsdMicro: left } : {}),
      });
    } catch (e) {
      await booked;
      await started;
      // A limit or a credential refused the review before its verdict: the caller pauses the
      // task or lets it wait (no verdict, no failed try).
      const refused = reviewRefusalOf(e);
      if (refused && (refused.kind === "budget" || refused.wait)) return { refused, capSource };
      // The caller files the card and reports it (U-045).
      return { failed: true, error: errorMessage(e) };
    }
    await booked;
    // The row after the verdict, with every review call booked on it.
    outcome = { ...outcome, task: (await store.task.get(taskId)) ?? outcome.task };
    await sayStarted();
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
        // W15B-14: the kind of card the verdict filed (questions, sign-off, decision), so the
        // log's line names it as the card does.
        ...(outcome.decision === "human" && outcome.humanRequestId
          ? await this.verdictCardKind(outcome.humanRequestId)
          : {}),
        ...(outcome.decision === "human" || outcome.retry === "escalate"
          ? { escalation: true }
          : {}),
        ...(outcome.decision === "blocked_by_findings"
          ? {
              warning: `cannot close "${request.task.title}": ${outcome.openFindings} finding(s) from an earlier review still open`,
            }
          : {}),
        summary: outcome.summary.slice(0, 400),
        // W15-58: the finding the work went back for, which the log's line names.
        ...(blockingFindingOf(outcome.findings)
          ? { blocking: blockingFindingOf(outcome.findings)?.slice(0, 400) }
          : {}),
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
 * The least share of the work budget a task larger than the session is taken with (D4): a fifth,
 * the share a run keeps to wrap up (`WRAP_UP_SHARE` in `enforcement/budget.ts`), so less room
 * would be mostly that reserve.
 */
export const OVERSIZED_MIN_ROOM_SHARE = 0.2;

/** The least room, in micro-USD, a larger task is taken with in a session of this work budget. */
export function oversizedMinRoomUsdMicro(workBudgetUsdMicro: number): number {
  return Math.max(1, Math.ceil(workBudgetUsdMicro * OVERSIZED_MIN_ROOM_SHARE));
}

/**
 * The plan within the work budget (U-040): items are taken in the planner's order, and one
 * that does not fit what is left is left out while the smaller ones after it still go in
 * (before, the first item that did not fit ended the plan, so one large task emptied it). The
 * items left out are on the plan as `leftOutForBudget`, in order and with why, for the summary
 * to name.
 *
 * D4 (the owner's decision of 2026-11-09, "it should get a warning, but it should get done
 * anyway"), as the owner's answer 5 of 2026-11-09 orders it (d1109-oversize-pause, OP-0: "it
 * should work on tasks even when it cannot complete them, and be able to wrap up and continue
 * next time"; no special ordering): a task whose figure alone is more than the work budget
 * (`workBudgetUsdMicro`, the session's cap less the review reserve) goes in at its place in the
 * planner's order with what is left of `roomUsdMicro` as its planned figure, when that is at least
 * a fifth of the work budget (`OVERSIZED_MIN_ROOM_SHARE`), and is also returned as `oversized`
 * (its whole figure, `roomUsdMicro` the room); it works until the wrap-up line, so every item
 * after it waits behind it (`after_large`, a fitting one too; the runner's re-plan takes them by
 * the room it leaves). With less than a fifth left at its turn it is left out (`no_room`) and the
 * cut goes on with the items after it, as for any task that does not fit. Before (d1109-oversize-
 * start), it was held apart and taken after the work that fits, one a session (`one_large`).
 * `roomUsdMicro` is what the items may take: the work budget at a session's start, what is left
 * of it at a re-plan.
 */
export function cutPlanToBudget(
  plan: SessionPlan,
  roomUsdMicro: number,
  workBudgetUsdMicro: number = roomUsdMicro,
): SessionPlan {
  const items: PlanItem[] = [];
  const leftOut: LeftOutItem[] = [];
  let larger: (PlanItem & { roomUsdMicro: number }) | undefined;
  let total = 0;
  for (const item of plan.items) {
    if (larger) {
      leftOut.push({ ...item, reason: "after_large", after: larger.title });
      continue;
    }
    if (item.estimateUsdMicro > workBudgetUsdMicro) {
      const left = roomUsdMicro - total;
      if (left < oversizedMinRoomUsdMicro(workBudgetUsdMicro)) {
        leftOut.push({ ...item, reason: "no_room" });
        continue;
      }
      larger = { ...item, roomUsdMicro: left };
      items.push({ ...item, estimateUsdMicro: left, wholeEstimateUsdMicro: item.estimateUsdMicro });
      total += left;
      continue;
    }
    if (total + item.estimateUsdMicro > roomUsdMicro) {
      leftOut.push({ ...item, reason: "after_others" });
      continue;
    }
    items.push(item);
    total += item.estimateUsdMicro;
  }
  return {
    items,
    estimateUsdMicro: total,
    // l4-money-pause, run L4 (L4-money-104): a task that comes after a larger one is the
    // session's own (it runs if that task leaves room), never "cut to fit the budget".
    summary: cutClause(plan.summary, leftOut.filter((l) => l.reason !== "after_large").length),
    ...(leftOut.length > 0 || larger ? { workBudgetUsdMicro } : {}),
    ...(leftOut.length > 0 ? { leftOutForBudget: leftOut } : {}),
    ...(larger ? { oversized: larger } : {}),
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
  wholeEstimateOf(t: TaskRow): number {
    return this.estimates
      ? this.estimates.estimate({
          specialist: t.specialist,
          risk_tier: t.risk_tier,
          est_cost_usd_micro: t.est_cost_usd_micro,
          budget_usd_micro: t.budget_usd_micro,
          outcome: t.outcome,
          acceptance_criteria: t.acceptance_criteria,
        }).usdMicro
      : t.est_cost_usd_micro || t.budget_usd_micro || this.defaultEstimateUsdMicro;
  }
  /** d1116-budget-all: the review part of `wholeEstimateOf` (0 without an estimate port). */
  reviewPartOf(t: TaskRow): number {
    return this.estimates
      ? (this.estimates.estimate({
          specialist: t.specialist,
          risk_tier: t.risk_tier,
          est_cost_usd_micro: t.est_cost_usd_micro,
          budget_usd_micro: t.budget_usd_micro,
          outcome: t.outcome,
          acceptance_criteria: t.acceptance_criteria,
        }).reviewUsdMicro ?? 0)
      : 0;
  }
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
    const items: PlanItem[] = [];
    for (const t of ordered) {
      // D4: a task that resumes from its kept work is planned at what is left of its estimate.
      const kept = ctx.keptWork ? await ctx.keptWork(t) : null;
      items.push({
        taskId: t.id,
        title: t.title,
        specialist: t.specialist ?? "coder",
        // `planEstimateUsdMicro` with the learned estimates, the task's own figure without.
        estimateUsdMicro: withinTaskBudget(
          estimateLeftUsdMicro(this.wholeEstimateOf(t), kept).usdMicro,
          t,
        ),
      });
    }
    return {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      // W15-60: plurals as the number says (design §5 rule 6; before: "task(s)").
      // L4-github-110: the first session's words count nothing: `items` are its tasks that are
      // ready now, not what the person approved ("1 task in its order" when 3 were approved and
      // 2 waited on the first); the promise's line says the session's size.
      summary: first
        ? "the first session you approved with the project plan, in its order"
        : `${items.length} ready ${items.length === 1 ? "task" : "tasks"} in priority order`,
    };
  }
}

/** OP-7: `{ checksFail }` of a budget card's `kept_checks` when a check failed, else {}. */
function failedChecksOf(card: Record<string, unknown>): { checksFail?: string[] } {
  const k = card.kept_checks as { failed?: unknown } | null | undefined;
  const failed = Array.isArray(k?.failed)
    ? k.failed.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  return failed.length ? { checksFail: failed } : {};
}
