import type { JsonObject, ProjectRow, SessionRow, TaskRow } from "@forerunner/state";
import type { ToolSpec } from "../agent/tools.ts";
import type { SessionBudget } from "../enforcement/budget.ts";
import type { SignedToken } from "../enforcement/token.ts";
import { DEFAULT_CEILING, nextRung } from "../models/ladder.ts";
import type { ModelTier } from "../provider/types.ts";
import type { PlanItem, TaskExecutionResult } from "../session/runner.ts";

/**
 * The seams of the core loop (spec build order, phase 3: "the core loop is now complete").
 * The session runner, the task executor and the conversation agent talk to the critic, to
 * memory and to the command registry only through these ports. The implementations live in
 * `src/loop/*.ts` over `@forerunner/critic`, `@forerunner/memory` and `@forerunner/commands`;
 * those packages depend on this one, so the wiring is loaded on demand by the composition
 * root (ADR 0036) and this file imports none of them. Tests run the runner with fakes of
 * these ports and the real implementations with the fake provider.
 */

// ---------------------------------------------------------------------------------------
// Critic (spec H, B.4, D.2, D.3)
// ---------------------------------------------------------------------------------------

export type ReviewVerdictKind = "accept" | "revise" | "escalate" | "human";

/** What the runner does with a task after its review (the retry ladder of spec D.2). */
export type ReviewDecision =
  | "accepted"
  | "revise"
  | "retry"
  | "human"
  /** The verdict was accept but a finding from another review is still open (B.4). */
  | "blocked_by_findings"
  /** The review itself could not run (provider failure); the task stays in review. */
  | "review_failed";

export type RetryRung = "improve_brief" | "split_or_change_specialist" | "escalate";

export interface ReviewFindingSummary {
  id?: string;
  severity: string;
  description: string;
  requiredAction: string;
}

export interface LessonCandidate {
  text: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  pinned?: boolean;
}

export interface TaskReviewRequest {
  task: TaskRow;
  session: SessionRow;
  /** The session token: the critic's own token copies its ids and never exceeds it. */
  token: SignedToken;
  budget: SessionBudget;
  item: PlanItem;
  result: TaskExecutionResult;
  /** The principal agent that ran the task (owner of the retry message). */
  agentId: string;
  signal: AbortSignal;
}

export interface TaskReviewOutcome {
  reviewId: string | null;
  tier: 0 | 1 | 2 | 3;
  verdict: ReviewVerdictKind;
  grade: number;
  confidence: number;
  summary: string;
  findings: ReviewFindingSummary[];
  /** Open findings on the task after the verdict was applied. */
  openFindings: number;
  decision: ReviewDecision;
  /** The ladder rung chosen for a `retry` decision. */
  retry?: RetryRung;
  /** Attempt count after the verdict (failed -> ready moves so far). */
  attempt: number;
  /** The rung the next run starts on when the ladder escalated. */
  nextTier?: ModelTier | null;
  humanRequestId?: string;
  costUsdMicro: number;
  /** Earlier findings this review resolved. */
  resolvedFindingIds: string[];
  /** Repeat findings the critic turned into lesson proposals (recorded in critic memory by the port). */
  lessonProposals: LessonCandidate[];
  /** Proposals that read like instructions: not recorded, quoted to the human by the runner. */
  quarantinedLessons: { text: string; rules: string[] }[];
  /** The task row after the transition. */
  task: TaskRow;
}

export interface SessionReviewRequest {
  sessionId: string;
  token: SignedToken;
  budget: SessionBudget;
  agentId: string;
  projectId: string | null;
}

export interface SessionReviewOutcome {
  reviewId: string | null;
  tier: 0 | 1 | 2 | 3;
  verdict: ReviewVerdictKind;
  grade: number;
  confidence: number;
  summary: string;
  findings: ReviewFindingSummary[];
  humanRequestId?: string;
  costUsdMicro: number;
}

/**
 * A lesson proposed for the shared store, as the critic reviews it (spec G.6): the proposal
 * row's text, tags and confidence plus where it came from. Never the origin's private file.
 */
export interface PromotionCandidate {
  /** The proposal row (shared scope, status `proposed`). */
  id: string;
  text: string;
  tags: string[];
  confidence: number;
  originId: string | null;
  originScope: string | null;
  originProjectId: string | null;
}

export interface PromotionReviewRequest {
  lesson: PromotionCandidate;
  /** The session token: the critic's own token copies its ids and never exceeds it. */
  token: SignedToken;
  budget: SessionBudget;
  /** The session's project settings (ceiling, effort offset); null for none. */
  projectSettings?: JsonObject | null;
  signal?: AbortSignal;
}

export interface PromotionReviewOutcome {
  reviewId: string | null;
  verdict: ReviewVerdictKind;
  grade: number;
  confidence: number;
  summary: string;
  /** False when the review run did not complete (limit, provider failure): nothing is decided. */
  completed: boolean;
  costUsdMicro: number;
}

export interface PromotionResolution {
  /** `pending` when the review did not complete or accepted without a persisted review row. */
  status: "promoted" | "rejected" | "pending";
  /** Offers filed for other projects of the same human (one approval request each). */
  offers: { projectId: string; requestId: string }[];
}

/** Proposals the critic reviews at one session's end; the rest wait for the next (spec G.6). */
export const MAX_PROMOTION_REVIEWS_PER_SESSION = 5;
/** Cap of one promotion review run; the session token's budget is the hard upper bound. */
export const PROMOTION_REVIEW_BUDGET_USD_MICRO = 250_000;

export interface CriticPort {
  /** Review a finished task at its tier and apply the verdict through the state workflow. */
  reviewTask(req: TaskReviewRequest): Promise<TaskReviewOutcome>;
  /** The honesty, plan and cost check of a finished session (H.6). */
  reviewSession(req: SessionReviewRequest): Promise<SessionReviewOutcome>;
  /**
   * A tier-1 light read of a lesson proposed for the shared store (G.6). Optional: a critic
   * without it leaves every proposal pending.
   */
  reviewPromotion?(req: PromotionReviewRequest): Promise<PromotionReviewOutcome>;
}

// ---------------------------------------------------------------------------------------
// Memory (spec G, N)
// ---------------------------------------------------------------------------------------

export type MemoryGrantKind = "principal" | "conversation" | "critic" | "specialist";

export interface MemoryRecallRequest {
  /** The asking agent (its own private scope plus what its kind may read). */
  agentId: string;
  kind: MemoryGrantKind;
  projectId: string | null;
  /** The text retrieval ranks against: the state brief, or a task's title and outcome. */
  query: string;
  tags?: string[];
  /** Hard cap on the rendered block; the port never returns more. */
  maxTokens: number;
  /**
   * The counter the cap is measured with (the chat passes its provider's `countTokens`);
   * default the memory package's estimate.
   */
  countTokens?: (text: string) => number;
}

export interface MemoryRecallResult {
  /** Rendered block (data, never instructions); empty when nothing applies. */
  block: string;
  tokens: number;
  lessonIds: string[];
  /** Scopes the grant asked for but could not read. */
  denied: string[];
  warnings: string[];
}

export interface MemoryRecordRequest {
  agentId: string;
  sessionId: string;
  projectId: string | null;
  scope?: "agent_private" | "critic" | "shared";
  lessons: LessonCandidate[];
  authorHuman?: string | null;
}

export interface MemoryRecordResult {
  recorded: number;
  merged: number;
  /** Candidates not stored: the lint rules, or `injection` with the rules an instruction-shaped text matched. */
  rejected: { text: string; error: string; injection?: string[] }[];
  /**
   * Shared-store proposals (proposal row ids) for the recorded critic or shared lessons tagged
   * `general` (spec G.6); a private lesson is proposed only by its human from the memory view.
   */
  proposed?: string[];
}

export interface MemoryPort {
  recall(req: MemoryRecallRequest): Promise<MemoryRecallResult>;
  record(req: MemoryRecordRequest): Promise<MemoryRecordResult>;
  /** Proposals of this human's agents the critic has not decided yet (G.6). Optional. */
  pendingPromotions?(): Promise<PromotionCandidate[]>;
  /** Apply the critic's decision: promote and offer, reject, or leave pending. Optional. */
  resolvePromotion?(id: string, review: PromotionReviewOutcome): Promise<PromotionResolution>;
}

/** Memory loaded per session stays under this many tokens unless the project says otherwise (ADR 0036). */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 1500;
/** A specialist brief gets a smaller slice of lessons (ADR 0036). */
export const DEFAULT_TASK_MEMORY_TOKEN_BUDGET = 400;
export const MEMORY_BUDGET_SETTING = "memory_token_budget";
export const TASK_MEMORY_BUDGET_SETTING = "task_memory_token_budget";

/** The retrieval budget of a project: its setting when it is a positive integer, else the default. */
export function memoryBudgetOf(
  settings: JsonObject | null | undefined,
  key: string = MEMORY_BUDGET_SETTING,
  fallback: number = DEFAULT_MEMORY_TOKEN_BUDGET,
): number {
  const v = settings?.[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

// ---------------------------------------------------------------------------------------
// Retry ladder (spec D.2): the rung a run starts on is derived from the attempt count
// ---------------------------------------------------------------------------------------

/** Failed attempts after which the next run goes one rung up (the ladder's third rung). */
export const ESCALATE_AFTER_ATTEMPTS = 3;

/**
 * The model rung for a run of a task that failed `attempt` times (failed -> ready moves): the
 * specialist's rung until the third failure, then one rung up when the ceiling allows (D.2,
 * D.3). Nothing is stored on the task; the attempt count the state workflow keeps is the truth.
 */
export function tierForAttempt(
  base: ModelTier,
  attempt: number,
  ceiling: ModelTier = DEFAULT_CEILING,
): ModelTier {
  if (attempt < ESCALATE_AFTER_ATTEMPTS) return base;
  return nextRung(base, ceiling) ?? base;
}

// ---------------------------------------------------------------------------------------
// Commands (spec Q): the conversation agent's only way to change anything
// ---------------------------------------------------------------------------------------

export interface CommandTurn {
  humanId: string;
  /** The principal agent the conversation speaks for. */
  agentId: string;
  activeProjectId: string | null;
  /** The conversation session whose log receives the spoken sentence. */
  sessionId: string;
  /**
   * The channel: typed chat, voice, the phone's relayed chat, or the UI's own screens (the
   * settings screen, the Changes screen); the change log records `chat`, `voice` or `ui`.
   */
  source: "text" | "voice" | "phone" | "ui";
  /** The words the human used (stored in the change log). */
  wordsUsed: string;
  deviceId?: string | null;
  /** The previous chat message, for "make this a task" (looked up from the log when absent). */
  lastMessage?: string;
}

export interface CommandCallLike {
  name: string;
  params: unknown;
}

export interface ParsedIntent {
  commands: CommandCallLike[];
  /** One short question with options when the request was unclear (spec Q.2). */
  question?: { text: string; options: string[] };
  /**
   * `pattern`: understood deterministically; `model`: by the intent model port; `none`: no
   * pattern matched and there is no model port, so the conversation model answers (with the
   * command tools) instead of the parser's fallback question.
   */
  matched: "pattern" | "model" | "none";
}

export interface CommandResultView {
  status: "done" | "partial" | "pending" | "cancelled" | "refused";
  /** The past-tense sentence of a done change ("... Undo."). */
  sentence?: string;
  /** The card read out before a pending change. */
  readback?: string;
  pendingId?: string;
  /** How a pending change confirms: a yes (chat, voice, tap, email) or the paired device. */
  decision?: "needs_yes" | "needs_device";
  expiresAt?: string;
  changeLogId?: string;
  /** The change log id while the change is undoable. */
  undoToken?: string | null;
  reason?: string;
  /** The error code of a refusal. */
  code?: string;
  /** The change card as JSON (what changes, old -> new, scope, duration, impact, undo). */
  card?: Record<string, unknown> | null;
  /** The card's cost impact, when it has one. */
  costUsdMicro?: number;
  /** The commands that ran or were planned. */
  commands: string[];
}

export interface ConversationCommands {
  /** Deterministic understanding before any model call; `matched: "none"` means ask the model. */
  parse(text: string, turn: CommandTurn): Promise<ParsedIntent>;
  /** One change card and one change log row for one or several commands. */
  compose(calls: CommandCallLike[], turn: CommandTurn): Promise<CommandResultView>;
  /** The command tools for the model path; `onResult` reports each run so the agent can read it back. */
  tools(turn: CommandTurn, onResult: (r: CommandResultView) => void): ToolSpec[];
  confirmByText(pendingId: string, text: string, turn: CommandTurn): Promise<CommandResultView>;
  /** Undo one change, or the latest undoable one of the human when no id is given. */
  undo(changeLogId: string | null, turn: CommandTurn): Promise<CommandResultView>;
  /** The active project the registry keeps for the human. */
  activeProject(humanId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------------------
// Project docs (spec G.5: the PM keeps the standard doc set current)
// ---------------------------------------------------------------------------------------

/** The session's outcome as task titles, for the entry in `docs/status.md`. */
export interface SessionStatusUpdate {
  sessionId: string;
  /** ISO-8601 UTC instant the session ended, from the Clock. */
  endedAt: string;
  done: string[];
  inFlight: string[];
  blocked: string[];
  next: string[];
  /** One line: the stop reason, the spend. */
  note?: string;
}

/** Where the scaffold went: a branch and pull request of the repository, or the data dir. */
export interface DocsScaffoldOutcome {
  location: "repo" | "data_dir";
  branch?: string;
  prUrl?: string | null;
  /** The directory the docs were written to (the data dir without a repository). */
  dir?: string;
  /** Repo-relative POSIX paths written, and the ones found and left alone. */
  created: string[];
  existing: string[];
  /**
   * The install marker `.forerunner/project.json` (spec A.4, ADR 0056) written beside the set:
   * `created`, `kept` when this project's was there, or `other_project` when the file names
   * another project (its id, or null for a hand-written marker) and was left as it is.
   */
  marker?:
    | { path: string; status: "created" | "kept" }
    | { path: string; status: "other_project"; project: string | null };
}

export interface SessionStatusOutcome {
  location: "repo" | "data_dir";
  /** Repo-relative POSIX path of the doc (`docs/status.md`). */
  path: string;
  /** Repository: the branch the update was committed to and the pull request carrying it. */
  branch?: string;
  prUrl?: string | null;
  dir?: string;
  /** True when the doc did not exist and was scaffolded first. */
  created: boolean;
}

export interface ProjectDocsPort {
  /** Scaffold the missing docs of the standard set for a new project; never overwrites. */
  scaffoldProject(project: ProjectRow): Promise<DocsScaffoldOutcome>;
  /**
   * Write the session's update into `docs/status.md`: on the session's pull request branch
   * when it opened one (`prBranch`), else on a small PR of its own; without a repository
   * under the project's data directory.
   */
  writeSessionStatus(input: {
    project: ProjectRow;
    session: SessionRow;
    update: SessionStatusUpdate;
    prBranch?: string | null;
  }): Promise<SessionStatusOutcome>;
}

// ---------------------------------------------------------------------------------------
// Merge of a reviewed pull request (spec J.9: level 3 Trusted merges reviewed PRs; ADR 0062)
// ---------------------------------------------------------------------------------------

/**
 * What became of a reviewed pull request: merged, or left open and why. `not_allowed`: the
 * hooks refused the `merge_pr` call (the autonomy level, the grant); `unverified`: the
 * reviewed commit is not known (no task worktree), so nothing proves the PR head is what the
 * critic read. The other refusals file a request for the human.
 */
export type MergeStatus =
  | "merged"
  | "not_allowed"
  | "unverified"
  | "checks_failed"
  | "checks_pending"
  | "conflict"
  | "head_moved"
  | "closed"
  | "failed";

export interface MergeRequest {
  /** The task after its accepting review (status done, `pr_url` set). */
  task: TaskRow;
  session: SessionRow;
  /** The session token: the merge runs on a token derived from it (`merge_pr` only). */
  token: SignedToken;
  budget: SessionBudget;
  signal: AbortSignal;
  agentId: string;
}

export interface MergeOutcome {
  taskId: string;
  prUrl: string;
  status: MergeStatus;
  /** One line for the human: what happened, or why the PR is left open. */
  reason: string;
  /** The merge commit on the base branch. */
  mergeSha?: string;
  /** The head that was merged or checked (after a rebase, the rebased head). */
  headSha?: string;
  /** True when the branch was rebased onto a base that had moved before the merge. */
  rebased?: boolean;
  failedChecks?: string[];
  pendingChecks?: string[];
  conflicts?: string[];
  /** The request filed for the human (red check, conflict, moved head, checks still running). */
  humanRequestId?: string;
}

export interface MergePort {
  /** After an accepting review: merge the task's PR through the hooks, or say why not; null without a PR. */
  mergeReviewed(req: MergeRequest): Promise<MergeOutcome | null>;
}
