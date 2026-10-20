import type { JsonObject, SessionRow, TaskRow } from "@forerunner/state";
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

export interface CriticPort {
  /** Review a finished task at its tier and apply the verdict through the state workflow. */
  reviewTask(req: TaskReviewRequest): Promise<TaskReviewOutcome>;
  /** The honesty, plan and cost check of a finished session (H.6). */
  reviewSession(req: SessionReviewRequest): Promise<SessionReviewOutcome>;
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
}

export interface MemoryPort {
  recall(req: MemoryRecallRequest): Promise<MemoryRecallResult>;
  record(req: MemoryRecordRequest): Promise<MemoryRecordResult>;
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
  source: "text" | "voice" | "phone";
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
