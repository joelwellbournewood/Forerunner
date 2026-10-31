import { z } from "zod";
import { DEVICES_ROUTES } from "../devices/types.ts";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, TaskPrioritySchema } from "../priority.ts";
import { SECRET_STORE_ROUTES } from "../secrets/store-types.ts";
import { PLAN_ALLOWANCE_ROUTES, SETUP_ROUTES } from "../setup/types.ts";
import { VOICE_INSTALL_ROUTES } from "../voice/install-types.ts";
import { BILLING_ORDER_ROUTES } from "./billing-order-types.ts";

/** Settings -> Devices shapes (spec R.2): the daemon's `/devices` routes' bodies and answers. */
export {
  DaemonDeviceView,
  DEVICES_ROUTES,
  DeviceListView,
  PAIRING_KINDS,
  type PairingKind,
  PairingSetupView,
  PairingStartView,
  RevokeDeviceView,
  StartPairingBody,
} from "../devices/types.ts";
/** Secrets the app stores (U-054): the mailbox passwords and the cloud voice keys. */
export {
  isStorableSecretName,
  MAILBOX_PASSWORD_PATTERN,
  mailboxPasswordName,
  SECRET_STORE_ROUTES,
  STORABLE_SECRET_NAMES,
  STORABLE_SECRETS,
  type StorableSecretName,
  StoredSecretsView,
  StoreSecretBody,
  StoreSecretView,
  storableSecretInfo,
} from "../secrets/store-types.ts";
/** The setup assistant's shapes (ADR 0092): the `/setup` routes' bodies and answers. */
export {
  PLAN_ALLOWANCE_ROUTES,
  PlanAllowanceBody,
  PlanAllowanceView,
  SETUP_ROUTES,
  SetupAnthropicBody,
  SetupCheckView,
  SetupFinishView,
  SetupGitHubBody,
  SetupProfileBody,
  SetupStatusView,
} from "../setup/types.ts";
export type {
  SourceCandidateStatus,
  SourceKind,
} from "../sources/types.ts";
/** Source discovery shapes (spec A.4): the `/sources` routes' bodies and answers. */
export {
  AcceptCandidateBody,
  AcceptCandidateView,
  AddSourceBody,
  RemoveSourceView,
  ScanResultView,
  ScanSummary,
  SOURCE_CANDIDATE_STATUSES,
  SOURCES_ROUTES,
  SourceCandidateStatusSchema,
  SourceCandidateView,
  SourceKindSchema,
  SourceView,
  SUPPORTED_SOURCE_KINDS,
} from "../sources/types.ts";
/** Settings -> Voice shapes (ADR 0090): the voice profile, its install job and its progress. */
export {
  GpuView,
  VOICE_INSTALL_ROUTES,
  VOICE_PROFILE_INFO,
  VOICE_PROFILES,
  VoiceDeviceView,
  VoiceInstallBody,
  VoiceInstallEntryView,
  VoiceInstallEvent,
  VoiceInstallJobView,
  VoiceInstallView,
  type VoiceProfile,
  type VoiceProfileInfo,
  VoiceProfileSchema,
  voiceInstallCommand,
} from "../voice/install-types.ts";
/** Settings -> Claude: which to use first (U-078, ADR 0100): the person's order of credentials. */
export {
  BILLING_ORDER_ROUTES,
  BillingOrderBody,
  BillingOrderKind,
  BillingOrderSourceView,
  BillingOrderView,
} from "./billing-order-types.ts";

/**
 * Local daemon API contract (ADR 0011). The desktop and Android shells, the approvals web
 * page and the CLI talk to the runtime through this API; the UI never touches the database.
 * Every shape is a zod schema so both sides validate. Money is USD micro-units plus a CHF
 * figure computed by the daemon at the day's rate; the UI shows CHF.
 */

export const Money = z.object({ usdMicro: z.number().int(), chfMicro: z.number().int() });
export type Money = z.infer<typeof Money>;

export const ProjectCard = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  stage: z.string(),
  status: z.string(),
  autonomyLevel: z.number().int().min(0).max(4),
  nextMilestone: z
    .object({ id: z.string(), name: z.string(), targetDate: z.string().nullable() })
    .nullable(),
  /**
   * `blocked` only while something waits on the human in the Inbox (an open blocking request,
   * or a needs-human task with its card); see `needsYou` for a task that needs them without
   * one (U-071).
   */
  health: z.enum(["good", "attention", "blocked", "idle"]),
  /**
   * The first task marked as needing the human that has no Inbox card: the card says
   * "needs you: <title>" and links to it (U-071). Absent on a card the state service serves.
   */
  needsYou: z.object({ taskId: z.string(), title: z.string() }).nullable().optional(),
  spend: Money,
  budget: Money,
  waitingOnYou: z.number().int(),
  latestCriticGrade: z.number().int().min(0).max(100).nullable(),
  lastSessionAt: z.string().nullable(),
  active: z.boolean(),
  /**
   * Small-project mode (spec B.6): one milestone, a flat task list, new tasks at critic tier 0.
   * Absent on a card the state service serves, which does not carry the flag yet.
   */
  smallProjectMode: z.boolean().optional(),
  /** The tier a new task of this project gets when it names none (`defaultRiskTier`). */
  defaultRiskTier: z.number().int().min(0).max(3).optional(),
  /**
   * The project's repository links (`owner/name`, a clone URL or a linked local folder); empty
   * for a project without one, which the project page offers to create a repository for
   * (U-037). Absent on a card the state service serves.
   */
  repos: z.array(z.string()).optional(),
});
export type ProjectCard = z.infer<typeof ProjectCard>;

export const ProjectSummary = z.object({
  goal: z.string(),
  stage: z.string(),
  lastSession: z
    .object({
      id: z.string(),
      endedAt: z.string().nullable(),
      summary: z.string(),
      stopReason: z.string(),
    })
    .nullable(),
  nextSteps: z.array(z.string()),
  openQuestions: z.number().int(),
  spend: Money,
  /** Plain text for TTS. */
  spoken: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const TaskView = z.object({
  id: z.string(),
  projectId: z.string(),
  milestoneId: z.string().nullable(),
  title: z.string(),
  outcome: z.string(),
  acceptanceCriteria: z.array(z.string()),
  riskTier: z.number().int().min(0).max(3),
  status: z.string(),
  /** Low, medium or high (U-041): the stored number's level, higher runs first. */
  priority: z.enum(TASK_PRIORITIES),
  claimedBy: z.string().nullable(),
  claimExpires: z.string().nullable(),
  dependsOn: z.array(z.string()),
  budget: Money,
  estimate: Money,
  actual: Money,
  /**
   * What a run of the task stops at (U-042): what is left of `budget` when the task has one,
   * else its specialist's per-run limit. The estimate never caps a run.
   */
  cap: Money,
  capSource: z.enum(["task_budget", "specialist_limit", "unknown"]),
  specialist: z.string().nullable(),
  attempt: z.number().int(),
  prUrl: z.string().nullable(),
  branch: z.string().nullable(),
  reason: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type TaskView = z.infer<typeof TaskView>;

/**
 * `POST /tasks/:id/transition` (U-061): the task after the move, and the change log entry the
 * move wrote (the Tasks tab says it is logged and offers its Undo while `undoToken` is set).
 */
export const TaskTransitionView = TaskView.extend({
  change: z
    .object({
      changeLogId: z.string(),
      /** The change log id while the move can be undone (POST /changes/:id/undo); null for done. */
      undoToken: z.string().nullable(),
      sentence: z.string(),
    })
    .nullable(),
});
export type TaskTransitionView = z.infer<typeof TaskTransitionView>;

export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;

export const MilestoneView = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  successCriteria: z.array(z.string()),
  /** A calendar date (YYYY-MM-DD) or null. */
  targetDate: z.string().nullable(),
  status: z.enum(MILESTONE_STATUSES),
  orderIndex: z.number().int(),
  /** Reason for the last change, with its author (spec B.5): "" on a row never changed. */
  reason: z.string(),
  authorAgent: z.string().nullable(),
  authorHuman: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type MilestoneView = z.infer<typeof MilestoneView>;

/** Milestone target dates are calendar dates, the way the Plan tab's timeline reads them. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `POST /milestones/:id` (spec B.5): a change to a milestone made from the app. The reason is
 * the human's words and is required; the daemon records it on the row with the human as
 * author and the version check, so a stale `version` is a 409 conflict.
 */
export const ChangeMilestoneBody = z.object({
  version: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(200).optional(),
  successCriteria: z.array(z.string().trim().min(1)).max(50).optional(),
  targetDate: z.string().regex(DATE_ONLY, "a calendar date, YYYY-MM-DD").nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
});
export type ChangeMilestoneBody = z.infer<typeof ChangeMilestoneBody>;

/** `POST /projects/:id/plan` (spec B.6): the rows the plan became. */
export const PlanProjectView = z.object({
  /** Milestones written by this call, in order; one at most in small-project mode. */
  milestones: z.array(MilestoneView),
  /**
   * Small-project mode: the project's open milestone the tasks joined instead of a new one, as
   * it stands after `merged` was applied; null when this call created a milestone.
   */
  reusedMilestone: MilestoneView.nullable(),
  /**
   * What joining added to `reusedMilestone`: the plan's success criteria it did not have yet
   * (plan order, once each) and the plan's target date when later than its own, else null; the
   * milestone keeps its name. Null when nothing was added or a milestone was created.
   */
  merged: z
    .object({ successCriteria: z.array(z.string()), targetDate: z.string().nullable() })
    .nullable(),
  /** Tasks written by this call, dependencies before dependants. */
  tasks: z.array(TaskView),
});
export type PlanProjectView = z.infer<typeof PlanProjectView>;

export const RunView = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  sessionId: z.string(),
  specialist: z.string(),
  model: z.string(),
  provider: z.string(),
  effort: z.string(),
  promptVersion: z.string(),
  billingSourceId: z.string().nullable(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  cost: Money,
  ttftMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  outcome: z.string(),
  verdict: z.string().nullable(),
  reviewId: z.string().nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type RunView = z.infer<typeof RunView>;

export const SessionView = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  budgetCap: Money,
  spent: Money,
  stepCap: z.number().int(),
  steps: z.number().int(),
  currentTask: z.object({ id: z.string(), title: z.string(), specialist: z.string() }).nullable(),
  summary: z.string(),
  handoff: z.unknown().nullable(),
  runner: z.string(),
});
export type SessionView = z.infer<typeof SessionView>;

export const EventView = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  type: z.string(),
  /** Human-readable line for the live view. */
  text: z.string(),
  payload: z.unknown(),
  cost: Money,
  at: z.string(),
  /** Escalations and warnings are highlighted. */
  level: z.enum(["info", "warning", "escalation", "error"]),
});
export type EventView = z.infer<typeof EventView>;

export const MessageView = z.object({
  id: z.string(),
  fromAgentId: z.string(),
  fromAgentName: z.string(),
  toAgentId: z.string().nullable(),
  toHumanId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  type: z.string(),
  body: z.string(),
  requiresAck: z.boolean(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  actedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageView = z.infer<typeof MessageView>;

export const HumanRequestView = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  taskId: z.string().nullable(),
  /**
   * The title of the task the request is about (U-073: every card names its task and its
   * project); null when it names no task or in an answer's echo. `GET /inbox` fills it; absent
   * from a service older than the field.
   */
  taskTitle: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
  kind: z.string(),
  why: z.string(),
  steps: z.array(z.string()),
  options: z.array(z.string()),
  blocking: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  changeCard: z.unknown().nullable(),
  status: z.string(),
  answer: z.unknown().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type HumanRequestView = z.infer<typeof HumanRequestView>;

export const InboxView = z.object({
  requests: z.array(HumanRequestView),
  messages: z.array(MessageView),
  blockingCount: z.number().int(),
});
export type InboxView = z.infer<typeof InboxView>;

export const CostBucket = z.object({
  key: z.string(),
  label: z.string(),
  cost: Money,
  runs: z.number().int(),
  accepted: z.number().int().nullable(),
});
export const CostView = z.object({
  totals: Money,
  planUsageShare: z.number().nullable(),
  byModel: z.array(CostBucket),
  bySpecialist: z.array(CostBucket),
  byTask: z.array(CostBucket),
  byProject: z.array(CostBucket),
  savings: z.object({
    compressionTokens: z.number().int(),
    cacheTokens: z.number().int(),
    compression: Money,
    cache: Money,
  }),
  from: z.string(),
  to: z.string(),
});
export type CostView = z.infer<typeof CostView>;

export const ChatRequestBody = z.object({
  humanId: z.string(),
  agentId: z.string(),
  projectId: z.string().optional(),
  text: z.string().min(1),
  source: z.enum(["text", "voice", "phone"]).optional(),
  /**
   * The line was typed in a project's own Chat tab (U-056): its `projectId` is the turn's
   * project, whatever the active project is. Elsewhere (the conversation panel, voice, the
   * phone) the active project the registry recorded applies, so every channel uses one.
   */
  projectTab: z.boolean().optional(),
});
export type ChatRequestBody = z.infer<typeof ChatRequestBody>;

export const ChatActionView = z.object({
  /** The command name(s) that ran ("project.switch+budget.set"), or "undo". */
  kind: z.string(),
  summary: z.string(),
  /** The change log id. */
  id: z.string().optional(),
  /** The change log id while the change can still be undone (POST /changes/:id/undo). */
  undoToken: z.string().nullable().optional(),
});
export type ChatActionView = z.infer<typeof ChatActionView>;

/** The change card read back by chat or voice; the human answers with a yes, a tap or the device. */
export const ChatPendingView = z.object({
  /** The pending change's id (also its HumanRequest row; POST /commands/:id/confirm). */
  id: z.string(),
  readback: z.string(),
  /** The card's cost impact (0 when it has none). */
  estimate: Money,
  commands: z.array(z.string()),
  decision: z.enum(["needs_yes", "needs_device"]).nullable(),
});
export type ChatPendingView = z.infer<typeof ChatPendingView>;

export const ChatReplyView = z.object({
  reply: z.string(),
  actions: z.array(ChatActionView),
  pendingConfirmation: ChatPendingView.nullable(),
  /** One short question with options when the request was unclear (spec Q.2). */
  question: z.object({ text: z.string(), options: z.array(z.string()) }).nullable(),
  ttftMs: z.number().nullable(),
  cost: Money,
  transcriptId: z.string(),
  activeProjectId: z.string().nullable(),
});
export type ChatReplyView = z.infer<typeof ChatReplyView>;

/**
 * What `POST /sessions` answers (409, code `killed`) while Stop all is on: what happened and
 * what to do, said as the start dialog shows it (U-077; it was a 500 with the runner's words).
 */
export const KILL_ACTIVE_START_MESSAGE =
  "Stop all is on, so no session can start. Press Resume at the top of the window, then start the session again.";

export const StartSessionBody = z.object({
  agentId: z.string(),
  projectId: z.string().optional(),
  budgetUsdMicro: z.number().int().positive().optional(),
  trigger: z.enum(["manual", "remote"]).default("manual"),
  reason: z.string().optional(),
});
export type StartSessionBody = z.infer<typeof StartSessionBody>;

/**
 * The answer of `POST /sessions` (U-003): the scheduler's outcome, the start's id (what its
 * undo names), and the session the start began. `session` is null while the start is queued
 * behind a running session or deferred by quiet hours, and when the run has not created its
 * session within the wait (`SESSION_START_WAIT_MS`); the session list shows it then.
 */
export const StartSessionView = z.object({
  result: z.enum(["started", "queued", "deferred"]),
  startId: z.string(),
  session: SessionView.nullable(),
  /**
   * A waiting start (queued or deferred): how many of the agent's waiting starts come before it
   * (0: it starts when the running session ends). Waiting starts run in order, none replaced
   * (U-043). Absent for a start that began.
   */
  ahead: z.number().int().nonnegative().optional(),
});
export type StartSessionView = z.infer<typeof StartSessionView>;

// ---------------------------------------------------------------------------------------
// Next-session queue (spec J.2; U-004): notes, tasks, corrections and ideas the human leaves
// for the agent's next session. The literals mirror `QUEUE_KINDS` and `QUEUE_STATUSES` of
// @forerunner/state (this file stays importable by the browser); a test keeps them equal.

export const QUEUE_ITEM_KINDS = ["note", "task", "correction", "idea", "voice_note"] as const;
export const QUEUE_ITEM_STATUSES = ["queued", "consumed", "dismissed"] as const;

export const QueueItemView = z.object({
  id: z.string(),
  projectId: z.string(),
  humanId: z.string(),
  kind: z.enum(QUEUE_ITEM_KINDS),
  text: z.string(),
  priority: z.number().int(),
  status: z.enum(QUEUE_ITEM_STATUSES),
  consumedBySession: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type QueueItemView = z.infer<typeof QueueItemView>;

export const EnqueueBody = z.object({
  kind: z.enum(QUEUE_ITEM_KINDS),
  text: z.string().trim().min(1).max(4000),
  /** 0 (lowest) to 9; the panel offers 1 to 9 and starts at 5. */
  priority: z.number().int().min(0).max(9).default(5),
});
export type EnqueueBody = z.infer<typeof EnqueueBody>;

// ---------------------------------------------------------------------------------------
// Project docs (spec G.5, K.2 Docs tab; U-005): the standard doc set as this install has it.

export const DocView = z.object({
  /** Repository-relative, as `STANDARD_DOCS` names it ("docs/decisions/" is a folder). */
  path: z.string(),
  title: z.string(),
  exists: z.boolean(),
  sizeBytes: z.number().int(),
  updatedAt: z.string().nullable(),
  /** An open critic finding names this doc as drifted. */
  drift: z.boolean(),
  /** The finding when it drifted, else where the doc was read or why it is missing. */
  note: z.string(),
});
export type DocView = z.infer<typeof DocView>;

export const DocContentView = z.object({
  path: z.string(),
  /** The file's text (cut at 512 KiB), or the list of files of the decisions folder. */
  content: z.string(),
  updatedAt: z.string().nullable(),
});
export type DocContentView = z.infer<typeof DocContentView>;

export const KillBody = z.object({
  scope: z.union([
    z.literal("all"),
    z.object({ agentId: z.string().optional(), sessionId: z.string().optional() }),
  ]),
  reason: z.string().optional(),
});

export const CreateProjectBody = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  brief: z.string().optional(),
  repos: z.array(z.string()).optional(),
  autonomyLevel: z.number().int().min(0).max(4).optional(),
  budgetUsdMicro: z.number().int().nonnegative().optional(),
  /**
   * PM intake (spec A.2, ADR 0055): true runs the intake in the background once the project
   * exists, so the proposal (plan, doc set, first-session plan) lands in the inbox; the card
   * answers at once. Off by default: a client that wants the plan asks for it, or calls
   * `POST /projects/:id/intake` later.
   */
  intake: z.boolean().optional(),
});

/** `POST /projects/:id/intake`: an optional brief in place of the one kept at creation. */
export const IntakeRequestBody = z.object({
  brief: z.string().optional(),
});

/** The intake filed (or reused) its proposal; the inbox holds the request (`202`). */
export const IntakeProposalView = z.object({
  pending: z.literal(true),
  projectId: z.string(),
  requestId: z.string(),
  /** An open proposal for the project already existed; no model call was made. */
  reused: z.boolean(),
  summary: z.object({
    milestones: z.number().int(),
    tasks: z.number().int(),
    docs: z.number().int(),
    firstSessionTasks: z.number().int(),
  }),
  /** The first-session plan's estimate, USD micro-units. */
  estimateUsdMicro: z.number().int(),
  /** What the one planning call cost; 0 when reused. */
  costUsdMicro: z.number().int(),
  /** Where the doc set goes on approval. */
  docsTarget: z.enum(["repository", "workspace"]),
});
export type IntakeProposalView = z.infer<typeof IntakeProposalView>;

/** `GET /projects/:id/intake`: the project's latest intake and what became of it. */
export const IntakeStatusView = z.object({
  projectId: z.string(),
  /** `drafting`: the plan is being drafted in the background now (U-046). */
  state: z.enum(["none", "drafting", "pending", "approved", "rejected", "skipped", "failed"]),
  requestId: z.string().nullable(),
  /** The card's outcome once answered: `approved`, `rejected`, or why it was skipped. */
  outcome: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** Where the docs went on approval (target, paths written, kept and scaffolded, PR url). */
  docs: z.unknown().nullable(),
  /** Why the last automatic intake failed (`state: "failed"`). */
  error: z.string().nullable(),
});
export type IntakeStatusView = z.infer<typeof IntakeStatusView>;

export const CreateTaskBody = z.object({
  title: z.string().min(3),
  outcome: z.string().min(3),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Left out, the project's default applies: tier 0 in small-project mode, else 1 (B.6). */
  riskTier: z.number().int().min(0).max(3).optional(),
  /** Low, medium or high (U-041); an old client's number is read as its level. */
  priority: TaskPrioritySchema.default(DEFAULT_TASK_PRIORITY),
  milestoneId: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  budgetUsdMicro: z.number().int().nonnegative().default(0),
  status: z.enum(["draft", "ready"]).default("ready"),
});

export const TransitionTaskBody = z.object({
  version: z.number().int(),
  to: z.string(),
  reason: z.string().min(1),
});

/**
 * `POST /tasks/:id/dependencies` (U-040): the tasks this task waits on, all of them (an empty
 * list removes every dependency), with the version the screen loaded and a reason for the row.
 */
export const SetTaskDependenciesBody = z.object({
  version: z.number().int(),
  dependsOn: z.array(z.string()),
  reason: z.string().min(1),
});
export type SetTaskDependenciesBody = z.infer<typeof SetTaskDependenciesBody>;

/** A ready task as the start check names it: what the planner prices it at. */
export const StartCheckTaskView = z.object({
  taskId: z.string(),
  title: z.string(),
  estimate: Money,
});
export type StartCheckTaskView = z.infer<typeof StartCheckTaskView>;

/**
 * `GET /projects/:id/start-check` (U-040): what a session started now would plan. `runnable`
 * would run; `overBudget` would be left out because it does not fit the work budget (the cap
 * less the review reserve); `waiting` waits on a task that is not done, each dependency with
 * its title and status (both null for a task that does not exist).
 */
export const StartCheckView = z.object({
  projectId: z.string(),
  sessionBudget: Money,
  workBudget: Money,
  ready: z.number().int().nonnegative(),
  runnable: z.array(StartCheckTaskView),
  overBudget: z.array(StartCheckTaskView),
  waiting: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      waitsOn: z.array(
        z.object({
          taskId: z.string(),
          title: z.string().nullable(),
          status: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export type StartCheckView = z.infer<typeof StartCheckView>;

export const AnswerRequestBody = z.object({ version: z.number().int(), answer: z.unknown() });

/** Where task commands run on this machine (ADR 0007): a container when an engine is reachable. */
export const SandboxHealth = z.object({
  kind: z.enum(["container", "process"]),
  available: z.boolean(),
  engine: z.enum(["docker", "podman", "none"]),
  reason: z.string(),
});
export type SandboxHealth = z.infer<typeof SandboxHealth>;

export const ExtensionsHealth = z.object({
  enabled: z.number().int(),
  pending: z.number().int(),
});
export type ExtensionsHealth = z.infer<typeof ExtensionsHealth>;

/**
 * The schema sync gate (spec M): `paused` while this install and the shared state are on
 * different schema versions; `action` says which side has to update.
 */
export const SyncHealth = z.object({
  paused: z.boolean(),
  local: z.number().int(),
  peer: z.number().int().nullable(),
  minSchema: z.number().int(),
  action: z.enum(["none", "update_local", "update_peer"]),
  message: z.string(),
  checkedAt: z.string().nullable(),
});
export type SyncHealth = z.infer<typeof SyncHealth>;

export const HealthView = z.object({
  ok: z.literal(true),
  version: z.string(),
  profile: z.string(),
  uptimeMs: z.number(),
  platform: z.string(),
  stateUrl: z.string(),
  vaultBackend: z.string(),
  activeSessions: z.number().int(),
  killActive: z.boolean(),
  sandbox: SandboxHealth,
  extensions: ExtensionsHealth,
  sync: SyncHealth.optional(),
});
export type HealthView = z.infer<typeof HealthView>;

/**
 * Desktop control's on-screen indicator (spec S.32; ADR 0067): the `desktop.indicator` frame on
 * `GET /events`. `on` with the agent, session and app being controlled; `{ on: false }` when
 * control ends. A shell shows its banner while the latest frame is `on`.
 */
export const DesktopIndicatorEventData = z.object({
  on: z.boolean(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  humanId: z.string().optional(),
  app: z.string().optional(),
  message: z.string().optional(),
  at: z.string().optional(),
});
export type DesktopIndicatorEventData = z.infer<typeof DesktopIndicatorEventData>;

/**
 * The indicator's state as `GET /desktop/status` reports it (`desktopControl`), which a shell
 * re-reads whenever its `/events` stream (re)opens so a frame missed while disconnected never
 * leaves the banner wrong. The names are null while `active` is false (and `app` while the
 * controlled application is not known yet).
 */
export const DesktopControlView = z.object({
  active: z.boolean(),
  app: z.string().nullable(),
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  since: z.string().nullable(),
});
export type DesktopControlView = z.infer<typeof DesktopControlView>;

/**
 * One entry of a human's desktop allowlist (spec L, `@forerunner/capabilities` desktop): a name
 * matches the executable or the window class; an object names `app`, `exe` or `windowClass`.
 */
export const DesktopAllowEntryView = z.union([
  z.string(),
  z.object({
    app: z.string().optional(),
    exe: z.string().optional(),
    windowClass: z.string().optional(),
    note: z.string().optional(),
  }),
]);
export type DesktopAllowEntryView = z.infer<typeof DesktopAllowEntryView>;

/**
 * The heading of the Settings section that edits the desktop allowlist (U-060): the desktop
 * approval card names it ("add it in Settings under …", `@forerunner/capabilities` desktop).
 */
export const DESKTOP_ALLOWLIST_CONTROL = "Desktop control: allowed applications";

/** `GET` and `PUT /desktop/allowlist/:humanId` (Settings → Desktop control, U-060). */
export const DesktopAllowlistView = z.object({
  humanId: z.string(),
  entries: z.array(DesktopAllowEntryView),
});
export type DesktopAllowlistView = z.infer<typeof DesktopAllowlistView>;

/** `GET /desktop/status` (and the body of `POST /desktop/resume`): the controller's status. */
export const DesktopStatusView = z.looseObject({
  capability: z.string(),
  adapter: z.string(),
  revoked: z.boolean(),
  revokedReason: z.string().nullable(),
  indicatorOn: z.boolean(),
  desktopControl: DesktopControlView,
  inFlight: z.number().int(),
  queued: z.number().int(),
  actions: z.number().int(),
});
export type DesktopStatusView = z.infer<typeof DesktopStatusView>;

/** `POST /desktop/revoke`: what was stopped, plus the status after it. */
export const DesktopRevokeView = z.looseObject({
  reason: z.string(),
  interrupted: z.number().int(),
  dropped: z.number().int(),
  status: DesktopStatusView,
});
export type DesktopRevokeView = z.infer<typeof DesktopRevokeView>;

/** Merge a patch into `project.settings` with a version check (mirror, sandbox and other switches). */
export const UpdateProjectSettingsBody = z.object({
  version: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
});
export type UpdateProjectSettingsBody = z.infer<typeof UpdateProjectSettingsBody>;

export const MirrorSyncBody = z.object({ full: z.boolean().optional() });
export type MirrorSyncBody = z.infer<typeof MirrorSyncBody>;

/** A finished mirror run (`POST /projects/:id/mirror/sync`, 200). */
export const MirrorRunView = z.object({
  projectId: z.string(),
  githubProjectId: z.string(),
  githubProjectUrl: z.string(),
  scanned: z.number().int(),
  changed: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  archived: z.number().int(),
  deleted: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  stopped: z
    .object({ reason: z.literal("rate_limit"), retryAfterMs: z.number().nullable() })
    .nullable(),
  sessionId: z.string().nullable(),
  eventId: z.string().nullable(),
  durationMs: z.number(),
});
export type MirrorRunView = z.infer<typeof MirrorRunView>;

/**
 * The mirror asked the human before creating the board (`202`): the run finishes in the
 * background once the request is answered in the inbox; the UI follows `project.changed`.
 */
export const MirrorSyncPendingView = z.object({
  pending: z.literal(true),
  projectId: z.string(),
  requestId: z.string(),
});
export type MirrorSyncPendingView = z.infer<typeof MirrorSyncPendingView>;
export const MirrorSyncView = z.union([MirrorRunView, MirrorSyncPendingView]);
export type MirrorSyncView = z.infer<typeof MirrorSyncView>;

export const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  ownerHumanId: z.string(),
  kind: z.string(),
  status: z.string(),
});
export type AgentView = z.infer<typeof AgentView>;

/** The longest name a principal agent can be given from Settings (U-025), in UTF-16 units. */
export const AGENT_NAME_MAX = 60;

/**
 * What an agent's name may not contain (U-025): control characters (line breaks, tabs, escape
 * sequences), line and paragraph separators, and the invisible marks that reorder text or make
 * two names look alike (bidi controls, the zero-width space, the byte order mark). The name
 * shows in headers, notifications, commit authors and email signatures.
 */
export const AGENT_NAME_FORBIDDEN =
  /[\p{Cc}\p{Zl}\p{Zp}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * `POST /agents/:id/rename` (U-025): the new name of the signed-in human's principal agent,
 * NFC-normalized and trimmed before it is checked, 1 to AGENT_NAME_MAX characters, none of
 * AGENT_NAME_FORBIDDEN. That it differs from the human's other agents is the daemon's check.
 */
export const RenameAgentBody = z.object({
  name: z
    .string()
    .normalize("NFC")
    .trim()
    .min(1, "the agent needs a name")
    .max(AGENT_NAME_MAX, `a name has at most ${AGENT_NAME_MAX} characters`)
    .refine((s) => !AGENT_NAME_FORBIDDEN.test(s), {
      message: "a name cannot contain line breaks, tabs or other control characters",
    }),
});
export type RenameAgentBody = z.infer<typeof RenameAgentBody>;
export const HumanView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  timezone: z.string(),
  defaultAutonomy: z.number().int(),
  monthlyCap: Money,
  /**
   * The daemon's own `desktop` device row: the paired device this PC is (ADR 0030), which the
   * settings screen names when it confirms a high-risk change (`POST /commands/:id/confirm`
   * with `answer: "device"`). Null only when the daemon registered none.
   */
  desktopDeviceId: z.string().nullable(),
  /**
   * The one active project of every channel (U-056): what `project.switch` recorded, by the
   * header, the palette, chat, voice or the phone. The header shows it at start.
   */
  activeProjectId: z.string().nullable().optional(),
});

export const SettingView = z.object({
  key: z.string(),
  scope: z.enum(["global", "human", "agent", "project"]),
  scopeId: z.string().nullable(),
  value: z.unknown(),
  description: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  /** The plain name the settings screen shows in place of the key (U-060), e.g. "Quiet hours". */
  label: z.string().optional(),
});

/**
 * One D.4 setting as the settings screen shows it (spec D.4, ADR 0072): the value in force,
 * the value without the agent's override, and where each comes from.
 */
export const ModelSettingValueView = z.object({
  value: z.union([z.string(), z.number()]).nullable(),
  default: z.union([z.string(), z.number()]).nullable(),
  source: z.enum(["table", "specialist", "agent"]),
  defaultSource: z.enum(["table", "specialist"]),
});
export type ModelSettingValueView = z.infer<typeof ModelSettingValueView>;

/**
 * The settings of one agent mode or one specialist: model (rung and the provider's model id),
 * effort, max tokens, speed mode, timeout in minutes, and `temperature` only when the
 * provider's capability flag `acceptsTemperature` is true (absent otherwise, never null).
 */
export const RunSettingsView = z.object({
  mode: z.string(),
  model: z.string().nullable(),
  tier: ModelSettingValueView,
  effort: ModelSettingValueView,
  maxTokens: ModelSettingValueView,
  speedMode: ModelSettingValueView,
  timeoutMinutes: ModelSettingValueView,
  temperature: ModelSettingValueView.optional(),
  /**
   * False where the runs always go at standard speed whatever is set (chat and planning: no
   * fast-mode price, ADR 0072), so the screen offers no speed choice there (U-059).
   */
  speedModeApplies: z.boolean().optional(),
  /**
   * The highest model the row's runs use whatever is chosen (U-059, spec D.3): `raisable` when
   * a project's highest model (`critic_ceiling`) lifts it, with the sentence the screen shows.
   */
  ceiling: z
    .object({ tier: z.string(), raisable: z.boolean(), note: z.string() })
    .nullable()
    .optional(),
});
export type RunSettingsView = z.infer<typeof RunSettingsView>;

export const ModelSettingsView = z.object({
  provider: z.object({
    name: z.string().nullable(),
    acceptsTemperature: z.boolean(),
    fastMode: z.boolean(),
  }),
  /** The effort table in force (D.8 to D.15) with the D.4 columns: where the defaults come from. */
  table: z.array(
    z.object({
      mode: z.string(),
      tier: z.string(),
      effort: z.string(),
      maxTokens: z.number().int(),
      speedMode: z.string(),
      timeoutMinutes: z.number(),
      targetMs: z.number().int(),
    }),
  ),
  /** The human's agents; `editable` false for the critic (its tiers set its model, spec H). */
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      editable: z.boolean(),
      note: z.string().nullable(),
      modes: z.array(RunSettingsView),
    }),
  ),
  /** Runnable specialists with the principal agent's overrides (`overridesAgentId`). */
  specialists: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      maxEffort: z.string(),
      overridesAgentId: z.string(),
      settings: RunSettingsView,
    }),
  ),
  /** Why the principal's `model_config` was ignored, when it does not validate. */
  configError: z.string().nullable(),
});
export type ModelSettingsView = z.infer<typeof ModelSettingsView>;

export const DecisionView = z.object({
  id: z.string(),
  projectId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  chosen: z.string(),
  decidedBy: z.string(),
  rationale: z.string(),
  supersedes: z.string().nullable(),
  createdAt: z.string(),
});
export type DecisionView = z.infer<typeof DecisionView>;

export const PeerActivityView = z.object({
  agentId: z.string(),
  agentName: z.string(),
  online: z.boolean(),
  activeClaims: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      status: z.string(),
      expiresAt: z.string().nullable(),
    }),
  ),
  openPullRequests: z.array(z.object({ taskId: z.string(), title: z.string(), url: z.string() })),
  lastHandoff: z
    .object({
      at: z.string(),
      summary: z.string(),
      inFlight: z.array(z.string()),
      blocked: z.array(z.string()),
      next: z.array(z.string()),
    })
    .nullable(),
  inFlightFiles: z.record(z.string(), z.array(z.string())),
});
export type PeerActivityView = z.infer<typeof PeerActivityView>;
export const PeerFeedView = z.object({
  generatedAt: z.string(),
  projectId: z.string().nullable(),
  /** The shared store's schema version the feed was read at (spec M, the sync gate). */
  schemaVersion: z.number().int().optional(),
  peers: z.array(PeerActivityView),
});
export type PeerFeedView = z.infer<typeof PeerFeedView>;

// ---------------------------------------------------------------------------------------
// Reviews tab (spec H, K.2): findings, grades, verdicts, grade trend

export const FindingView = z.object({
  id: z.string(),
  reviewId: z.string(),
  taskId: z.string().nullable(),
  severity: z.string(),
  description: z.string(),
  requiredAction: z.string(),
  status: z.string(),
  resolvedByRun: z.string().nullable(),
  fingerprint: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type FindingView = z.infer<typeof FindingView>;

export const ReviewView = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  sessionId: z.string().nullable(),
  criticModel: z.string(),
  tier: z.number().int().min(0).max(3),
  grade: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  verdict: z.string(),
  evidence: z.array(z.unknown()),
  summary: z.string(),
  findings: z.array(FindingView),
  openFindings: z.number().int(),
  createdAt: z.string(),
});
export type ReviewView = z.infer<typeof ReviewView>;

export const GradeTrendPoint = z.object({
  at: z.string(),
  grade: z.number().int(),
  reviewId: z.string(),
  taskId: z.string().nullable(),
  verdict: z.string(),
});
export type GradeTrendPoint = z.infer<typeof GradeTrendPoint>;

export const ReviewsView = z.object({
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  reviews: z.array(ReviewView),
  openFindings: z.number().int(),
  /** Oldest first, for the chart. */
  gradeTrend: z.array(GradeTrendPoint),
  averageGrade: z.number().nullable(),
  verdicts: z.record(z.string(), z.number().int()),
});
export type ReviewsView = z.infer<typeof ReviewsView>;

// ---------------------------------------------------------------------------------------
// Performance view (spec D.7, D.19): time to first token and total time per mode against target

/** What a mode's target measures: first token, first audio, the whole run, or set by the task. */
export const PERFORMANCE_TARGET_KINDS = ["first_token", "first_audio", "total", "by_task"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Where a measurement came from: a Run row, a `chat.reply` event, a `voice.turn` event. */
export const PERFORMANCE_SOURCES = ["run", "chat", "voice"] as const;
/** The window `GET /performance` covers without `?days=`, and the longest it accepts. */
export const PERFORMANCE_DEFAULT_DAYS = 7;
export const PERFORMANCE_MAX_DAYS = 90;

export const PerformanceModeView = z.object({
  /** One of the ladder's modes (ladder.ts `Mode`). */
  mode: z.string(),
  label: z.string(),
  /** 0 when the target is set by the task budget and timeout. */
  targetMs: z.number().int().nonnegative(),
  targetKind: z.enum(PERFORMANCE_TARGET_KINDS),
  /** The rung the mode starts on in the effort table in force. */
  tier: z.string(),
  /**
   * The mode's effort before the offset: the table's (built-ins plus the adopted models.json),
   * or the principal agent's D.4 override where it sets one (`effortSource: "agent"`).
   */
  baseEffort: z.enum(EFFORT_LEVELS),
  /**
   * Where `baseEffort` comes from (spec D.4, ADR 0072): `table`, or `agent` when the principal's
   * `model_config` sets the effort (`modes.planning`, `modes.text_chat`, `specialists.coder`,
   * `specialists.researcher`), as the intake, the conversation agent and the executor read it.
   */
  effortSource: z.enum(["table", "agent"]),
  /**
   * The effort in force: the base, shifted by the project's offset where the code applies it,
   * held at `maxEffort`.
   */
  effort: z.enum(EFFORT_LEVELS),
  /** True when the project's speed-versus-quality offset reaches this mode's runs today. */
  offsetApplied: z.boolean(),
  /**
   * The registry `max_effort` the mode's runs are held at (the specialist's, the conversation
   * agent's, the project manager's, the critic's); null when nothing caps the mode.
   */
  maxEffort: z.enum(EFFORT_LEVELS).nullable(),
  /**
   * The effort a risky task raises the mode to (`effortForTask`: the coder at risk tier 2 and
   * above runs at high, a tier 3 critic review at max), with the offset and the cap applied as
   * for `effort`; null when no risk tier changes the mode's effort.
   */
  riskEffort: z.enum(EFFORT_LEVELS).nullable(),
  /** The lowest risk tier `riskEffort` applies from; null with it. */
  riskTierFrom: z.number().int().min(0).max(3).nullable(),
  /** Measurements in the window. */
  samples: z.number().int().nonnegative(),
  /** Median and 90th percentile by nearest rank over the samples that carry the figure. */
  ttftP50Ms: z.number().nullable(),
  ttftP90Ms: z.number().nullable(),
  totalP50Ms: z.number().nullable(),
  totalP90Ms: z.number().nullable(),
  /** Share of the samples whose measured figure met the target; null without samples or target. */
  withinTargetShare: z.number().min(0).max(1).nullable(),
  /** The p90 of the measured figure at or under the target; null without samples or target. */
  met: z.boolean().nullable(),
  /** When the newest measurement in the window was taken; null without one. */
  lastAt: z.string().nullable(),
});
export type PerformanceModeView = z.infer<typeof PerformanceModeView>;

export const PerformanceSampleView = z.object({
  /** The Run row id, or the event id of a chat or voice turn. */
  runId: z.string(),
  source: z.enum(PERFORMANCE_SOURCES),
  mode: z.string(),
  specialist: z.string(),
  model: z.string(),
  effort: z.string(),
  /** First token; for a voice turn, end of turn to first audio. */
  ttftMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  at: z.string(),
});
export type PerformanceSampleView = z.infer<typeof PerformanceSampleView>;

export const PerformanceView = z.object({
  generatedAt: z.string(),
  projectId: z.string().nullable(),
  /** The window: the last `days` days, from `from` to `generatedAt`. */
  days: z.number().int().positive(),
  from: z.string(),
  /** The project's speed-versus-quality offset (-1, 0, +1); 0 for all projects. */
  effortOffset: z.number().int(),
  modes: z.array(PerformanceModeView),
  /** The newest measurements across modes, newest first. */
  recent: z.array(PerformanceSampleView),
});
export type PerformanceView = z.infer<typeof PerformanceView>;

// ---------------------------------------------------------------------------------------
// Memory views (spec G, K.5): one view per scope, search, edit, delete, pin, consolidation

export const LessonView = z.object({
  id: z.string(),
  scope: z.enum(["agent_private", "critic", "shared"]),
  ownerAgentId: z.string().nullable(),
  projectId: z.string().nullable(),
  text: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
  confidence: z.number(),
  lastUsed: z.string().nullable(),
  hitCount: z.number().int(),
  supersededBy: z.string().nullable(),
  pinned: z.boolean(),
  status: z.string(),
  filePath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type LessonView = z.infer<typeof LessonView>;

/** The memory views: one per principal (private), the critic, shared. */
export const MemoryScopeView = z.object({
  scope: z.enum(["agent_private", "critic", "shared"]),
  ownerAgentId: z.string().nullable(),
  label: z.string(),
  active: z.number().int(),
  pinned: z.number().int(),
});
export type MemoryScopeView = z.infer<typeof MemoryScopeView>;

export const MemoryView = z.object({
  scope: z.enum(["agent_private", "critic", "shared"]),
  ownerAgentId: z.string().nullable(),
  query: z.string(),
  lessons: z.array(LessonView),
});
export type MemoryView = z.infer<typeof MemoryView>;

export const UpdateLessonBody = z.object({
  text: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});
export type UpdateLessonBody = z.infer<typeof UpdateLessonBody>;

export const PinLessonBody = z.object({ pinned: z.boolean() });

/** A cross-project offer (spec G.6): a promoted lesson matched to another project by its tags. */
export const LessonOfferView = z.object({
  requestId: z.string(),
  status: z.string(),
  lessonId: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  confidence: z.number(),
  projectId: z.string(),
  projectName: z.string(),
  sharedTags: z.array(z.string()),
  createdAt: z.string(),
  answer: z.unknown().nullable(),
  appliedAt: z.string().nullable(),
  copyId: z.string().nullable(),
  version: z.number().int(),
});
export type LessonOfferView = z.infer<typeof LessonOfferView>;

export const AnswerOfferBody = z.object({ answer: z.enum(["accept", "dismiss"]) });
export type AnswerOfferBody = z.infer<typeof AnswerOfferBody>;

export const ConsolidationReportView = z.object({
  scope: z.enum(["agent_private", "critic", "shared"]),
  ownerAgentId: z.string().nullable(),
  ranAt: z.string(),
  applied: z.boolean(),
  merged: z.array(
    z.object({
      keptId: z.string(),
      retiredIds: z.array(z.string()),
      cosine: z.number(),
      projectId: z.string().nullable(),
    }),
  ),
  contradictions: z.array(
    z.object({ a: z.string(), b: z.string(), reason: z.string(), cosine: z.number() }),
  ),
  retired: z.array(z.string()),
  proposals: z.array(z.string()),
});
export type ConsolidationReportView = z.infer<typeof ConsolidationReportView>;

/** A consolidation proposal (one approval request in the inbox) and what became of it. */
export const ConsolidationProposalView = z.object({
  requestId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  reports: z.array(ConsolidationReportView),
  proposals: z.array(z.string()),
  appliedAt: z.string().nullable(),
  answer: z.unknown().nullable(),
});
export type ConsolidationProposalView = z.infer<typeof ConsolidationProposalView>;

export const ConsolidationRunView = z.object({
  requestId: z.string().nullable(),
  proposals: z.number().int(),
  reports: z.array(ConsolidationReportView),
});
export type ConsolidationRunView = z.infer<typeof ConsolidationRunView>;

// ---------------------------------------------------------------------------------------
// Commands (spec Q): the registry, parse, execute, confirm, the change log, undo

export const CommandDefView = z.object({
  name: z.string(),
  description: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  reversible: z.boolean(),
  undoStrategy: z.string(),
  limit: z.boolean(),
  schema: z.unknown(),
});
export type CommandDefView = z.infer<typeof CommandDefView>;

export const CommandCallBody = z.object({
  name: z.string().min(1),
  params: z.unknown().optional(),
});

/** The channel a command route is called from; the change log records chat, voice or ui. */
export const CommandSourceBody = z.enum(["text", "voice", "phone", "ui"]);
export type CommandSourceBody = z.infer<typeof CommandSourceBody>;

export const CommandParseBody = z.object({
  text: z.string().min(1),
  source: CommandSourceBody.optional(),
  projectId: z.string().optional(),
  deviceId: z.string().optional(),
});
export type CommandParseBody = z.infer<typeof CommandParseBody>;

export const CommandParseView = z.object({
  commands: z.array(z.object({ name: z.string(), params: z.unknown() })),
  question: z.object({ text: z.string(), options: z.array(z.string()) }).nullable(),
  matched: z.enum(["pattern", "model", "none"]),
});
export type CommandParseView = z.infer<typeof CommandParseView>;

export const CommandExecuteBody = z.object({
  /** One command, or several as one change card and one change log row (spec Q.9). */
  commands: z.array(CommandCallBody).min(1),
  wordsUsed: z.string().optional(),
  /** `ui` from the settings screen (logged as `ui`); absent means typed chat. */
  source: CommandSourceBody.optional(),
  projectId: z.string().optional(),
  deviceId: z.string().optional(),
  /** The settings screen showed the card and got a tap: run without a pending card. */
  confirm: z.enum(["tap"]).optional(),
});
export type CommandExecuteBody = z.infer<typeof CommandExecuteBody>;

export const CommandResultViewSchema = z.object({
  status: z.enum(["done", "partial", "pending", "cancelled", "refused"]),
  sentence: z.string().optional(),
  readback: z.string().optional(),
  pendingId: z.string().optional(),
  decision: z.enum(["needs_yes", "needs_device"]).optional(),
  expiresAt: z.string().optional(),
  changeLogId: z.string().optional(),
  undoToken: z.string().nullable().optional(),
  reason: z.string().optional(),
  code: z.string().optional(),
  card: z.unknown().nullable().optional(),
  cost: Money.optional(),
  commands: z.array(z.string()),
});
export type CommandResultJson = z.infer<typeof CommandResultViewSchema>;

export const CommandConfirmBody = z.object({
  answer: z.enum(["yes", "no", "tap", "device"]),
  /**
   * For `device`: the paired device that confirms (`/me.desktopDeviceId` for this PC); a
   * phone also needs `biometric: true`. Left out (or the literal `desktop` an older settings
   * screen sent), the daemon-token holder is the human at this PC and the daemon's own
   * desktop row answers (an audit row says so).
   */
  deviceId: z.string().optional(),
  biometric: z.boolean().optional(),
});
export type CommandConfirmBody = z.infer<typeof CommandConfirmBody>;

export const PendingChangeView = z.object({
  id: z.string(),
  humanId: z.string(),
  card: z.unknown(),
  decision: z.enum(["needs_yes", "needs_device"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  wordsUsed: z.string(),
});
export type PendingChangeView = z.infer<typeof PendingChangeView>;

export const ChangeLogView = z.object({
  id: z.string(),
  humanId: z.string().nullable(),
  agentId: z.string().nullable(),
  wordsUsed: z.string(),
  commands: z.array(z.unknown()),
  before: z.unknown(),
  after: z.unknown(),
  scope: z.enum(["session", "project", "global"]),
  projectId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  undoState: z.enum(["undoable", "undone", "expired", "irreversible"]),
  undoneAt: z.string().nullable(),
  source: z.string(),
  sentence: z.string(),
  /** True while POST /changes/:id/undo would work. */
  undoable: z.boolean(),
  /**
   * Why Undo would not work although the row is still `undoable` (U-061): the task moved on,
   * the note was read. Absent or null when Undo is offered or the row is no longer undoable.
   */
  undoBlockedReason: z.string().nullable().optional(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type ChangeLogView = z.infer<typeof ChangeLogView>;

// ---------------------------------------------------------------------------------------
// Voice (spec O, Q.4, Q.5; ADR 0012, ADR 0048): the voice loop over the conversation agent,
// reached by the shells through these routes. Audio travels as 16-bit PCM; the daemon never
// stores it unless audio storage is on, and the views never carry a key.

export const VOICE_MODES = ["push_to_talk", "open_mic"] as const;
export type VoiceModeName = (typeof VOICE_MODES)[number];
export const VOICE_STATES = ["idle", "listening", "transcribing", "thinking", "speaking"] as const;
/**
 * How the agent replies in a voice session: `voice` speaks the reply; `text` streams it as text
 * only (the `model_delta` and `sentence` frames): no TTS, no audio frames, no first audio and no
 * heard figure; the turn ends when the text is complete and a press stops the generation.
 */
export const VOICE_REPLY_MODES = ["voice", "text"] as const;
/** How many ended turns `VoiceSessionView.recentTurns` carries. */
export const VOICE_RECENT_TURNS = 8;
export type VoiceReplyModeName = (typeof VOICE_REPLY_MODES)[number];

/** The provider the registry's policy picked, with the reason the Extensions panel shows. */
export const VoiceProviderView = z.object({
  name: z.string(),
  kind: z.enum(["local", "cloud", "fake"]),
  policy: z.enum(["preferred", "local", "cloud", "fake"]),
  reason: z.string(),
});
export type VoiceProviderView = z.infer<typeof VoiceProviderView>;

/** One registered provider: availability and, for a cloud one, its key by reference only. */
export const VoiceProviderStatusView = z.object({
  name: z.string(),
  kind: z.enum(["local", "cloud", "fake"]),
  available: z.boolean(),
  reason: z.string(),
  secretRef: z.string().optional(),
  secretConfigured: z.boolean().optional(),
  selected: z.boolean(),
});
export type VoiceProviderStatusView = z.infer<typeof VoiceProviderStatusView>;

/** One side's preferred provider: the Extensions row that chose it, or the environment override. */
export const VoicePreferenceView = z.object({
  name: z.string(),
  source: z.enum(["env", "extension"]),
  extensionId: z.string().nullable(),
  /** The row's name (`voice-deepgram`); null for the environment override. */
  extension: z.string().nullable(),
  /**
   * Every registered provider the row stands for on this side, `name` first (`voice-local`:
   * kokoro, piper); the row is in force when the pick is any of them. The environment names one.
   */
  providers: z.array(z.string()),
});
export type VoicePreferenceView = z.infer<typeof VoicePreferenceView>;

/**
 * A voice row that is not in force for a side, with the reason the panel shows: switched off,
 * its key not granted or without a value, another row in force, an environment override, or
 * none of its providers registered.
 */
export const VoicePreferenceSkipView = z.object({
  extensionId: z.string(),
  extension: z.string(),
  side: z.enum(["stt", "tts"]),
  provider: z.string().nullable(),
  reason: z.string(),
});
export type VoicePreferenceSkipView = z.infer<typeof VoicePreferenceSkipView>;

/** What the Extensions panel chose (spec O.4), read afresh for every status and session. */
export const VoicePreferencesView = z.object({
  stt: VoicePreferenceView.nullable(),
  tts: VoicePreferenceView.nullable(),
  skipped: z.array(VoicePreferenceSkipView),
});
export type VoicePreferencesView = z.infer<typeof VoicePreferencesView>;

export const VoiceStatusView = z.object({
  available: z.boolean(),
  /** Why voice is unavailable (no provider, no key, no model credential), or how it was picked. */
  reason: z.string(),
  stt: VoiceProviderView.nullable(),
  tts: VoiceProviderView.nullable(),
  statuses: z.object({
    stt: z.array(VoiceProviderStatusView),
    tts: z.array(VoiceProviderStatusView),
  }),
  /** The panel's choice per side and every enabled voice row not in force, with the reason. */
  preferences: VoicePreferencesView,
  sessions: z.number().int(),
  maxSessions: z.number().int(),
  modes: z.array(z.enum(VOICE_MODES)),
});
export type VoiceStatusView = z.infer<typeof VoiceStatusView>;

export const StartVoiceSessionBody = z.object({
  projectId: z.string().optional(),
  /** BCP-47; the spoken approval rules and the providers use it. */
  language: z.string().optional(),
  mode: z.enum(VOICE_MODES).optional(),
  /** Default `voice`. */
  replyMode: z.enum(VOICE_REPLY_MODES).optional(),
});
export type StartVoiceSessionBody = z.infer<typeof StartVoiceSessionBody>;

/** `replyMode` sets how this turn's reply (and the next ones) go out; the session keeps it. */
export const VoicePressBody = z.object({
  pressed: z.boolean(),
  replyMode: z.enum(VOICE_REPLY_MODES).optional(),
});
export type VoicePressBody = z.infer<typeof VoicePressBody>;

/** Capture rates real devices produce; the loop resamples to 16 kHz, so an absurd rate is refused. */
export const VOICE_SAMPLE_RATE = { min: 8000, max: 192_000 } as const;

/** A captured chunk: 16-bit signed little-endian PCM, base64 in JSON (or raw as octet-stream). */
export const VoiceAudioBody = z.object({
  pcm: z.string().min(1),
  sampleRate: z.number().int().min(VOICE_SAMPLE_RATE.min).max(VOICE_SAMPLE_RATE.max),
  channels: z.number().int().min(1).max(8),
  /** Position of the first sample on the capture timeline, ms. */
  timestampMs: z.number().nonnegative(),
});
export type VoiceAudioBody = z.infer<typeof VoiceAudioBody>;

/**
 * What the human heard (`POST /voice/sessions/:id/heard`): the panel's player measures, per
 * turn, from the push-to-talk release (Send or the hotkey) to the moment its first chunk of
 * the reply reaches the speaker (the chunk's scheduled start in context time mapped to the
 * page's clock, plus the output device's latency), on the page's own clock. One per turn; it
 * lands on the turn's `voice.turn` row as `latency.heardFirstAudioMs`, or as a `voice.heard`
 * row when that row was already written.
 */
export const VOICE_HEARD_MAX_MS = 3_600_000;
export const VoiceHeardBody = z.object({
  turn: z.number().int().min(1),
  heardFirstAudioMs: z.number().min(0).max(VOICE_HEARD_MAX_MS),
});
export type VoiceHeardBody = z.infer<typeof VoiceHeardBody>;

export const VoiceHeardView = z.object({
  turn: z.number().int(),
  /** Rounded to the millisecond. */
  heardFirstAudioMs: z.number().int(),
  /** `voice.turn` when the turn was still running, `voice.heard` when its row was written. */
  recordedOn: z.enum(["voice.turn", "voice.heard"]),
});
export type VoiceHeardView = z.infer<typeof VoiceHeardView>;

export const VoiceTextBody = z.object({
  text: z.string().min(1),
  replyMode: z.enum(VOICE_REPLY_MODES).optional(),
});
export type VoiceTextBody = z.infer<typeof VoiceTextBody>;

/** The shell's answer to a read-back without speaking: a tap confirms, "no" cancels. */
export const VoiceAnswerBody = z.object({ answer: z.enum(["tap", "no"]) });
export type VoiceAnswerBody = z.infer<typeof VoiceAnswerBody>;

const VoiceLatencyStage = z.object({
  ms: z.number().nullable(),
  targetMs: z.number(),
  withinTarget: z.boolean(),
});

/** The per-stage latency report of one turn (spec O.5): each part measured, shown, compared. */
export const VoiceLatencyView = z.object({
  turn: z.number().int(),
  endOfTurnMs: z.number().nullable(),
  finalTranscriptMs: z.number().nullable(),
  modelFirstTokenMs: z.number().nullable(),
  firstAudioMs: z.number().nullable(),
  totalToFirstAudioMs: z.number().nullable(),
  stages: z.object({
    endOfTurn: VoiceLatencyStage,
    finalTranscript: VoiceLatencyStage,
    modelFirstToken: VoiceLatencyStage,
    firstAudio: VoiceLatencyStage,
    total: VoiceLatencyStage,
  }),
  withinTarget: z.boolean(),
  firstSentenceMs: z.number().nullable(),
  ttsFirstByteMs: z.number().nullable(),
  interrupted: z.boolean(),
  noResponse: z.boolean(),
  targets: z.object({
    endOfTurnMs: z.number(),
    finalTranscriptMs: z.number(),
    modelFirstTokenMs: z.number(),
    firstAudioMs: z.number(),
    totalToFirstAudioMs: z.number(),
  }),
});
export type VoiceLatencyView = z.infer<typeof VoiceLatencyView>;

/**
 * A spoken or tapped approval decision, logged with the exact transcript line (spec O.7) and
 * the registry's outcome: `approved` is what the human's answer meant, `status` what the
 * registry did with it (`pending` when the line was not an answer and the card still waits,
 * `done` / `partial` / `cancelled`, or `refused` with the `reason`: a card answered elsewhere
 * or expired, a high-risk card that needs the paired device).
 */
export const VoiceApprovalView = z.object({
  turn: z.number().int(),
  line: z.string(),
  approved: z.boolean(),
  matched: z.string().nullable(),
  blockedBy: z.enum(["negation", "question", "qualifier", "deferral", "ambiguous"]).nullable(),
  at: z.string(),
  subject: z.string().optional(),
  method: z.enum(["spoken", "tap", "no"]),
  pendingId: z.string(),
  commands: z.array(z.string()),
  status: z.enum(["done", "partial", "pending", "cancelled", "refused"]),
  reason: z.string().nullable(),
});
export type VoiceApprovalView = z.infer<typeof VoiceApprovalView>;

export const VoiceTurnView = z.object({
  turn: z.number().int(),
  source: z.enum(["audio", "text"]),
  /** How the reply went out; a `text` reply played nothing (no first audio, nothing heard). */
  replyMode: z.enum(VOICE_REPLY_MODES),
  /**
   * A press came while this turn transcribed: its words went on in the next turn (no reply of
   * its own). `carriedFrom` on that next turn names it: its model call got both utterances.
   */
  continued: z.boolean(),
  carriedFrom: z.number().int().nullable(),
  /** The final transcript. */
  said: z.string(),
  /** The assistant line that was played. */
  heard: z.string(),
  /**
   * The agent's reply; null when the bridge answered the line itself: a spoken answer to a
   * card (refused and read back again, or confirmed or cancelled through the registry).
   */
  reply: ChatReplyView.nullable(),
  approval: VoiceApprovalView.nullable(),
  /** The registry's result when this turn answered a card (its sentence, change log id, undo). */
  outcome: CommandResultViewSchema.nullable(),
  /** The card waiting after this turn: read back, needs a yes, a tap or the device. */
  pending: ChatPendingView.nullable(),
  latency: VoiceLatencyView,
  audioChunks: z.number().int(),
  audioStored: z.boolean(),
  interrupted: z.boolean(),
  unspokenText: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type VoiceTurnView = z.infer<typeof VoiceTurnView>;

export const VoiceSessionView = z.object({
  id: z.string(),
  state: z.enum(VOICE_STATES),
  turn: z.number().int(),
  mode: z.enum(VOICE_MODES),
  /** How the next reply goes out (`StartVoiceSessionBody`, `VoicePressBody`). */
  replyMode: z.enum(VOICE_REPLY_MODES),
  language: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The conversation session whose event log holds the chat, the approvals and the turns. */
  conversationSessionId: z.string(),
  providers: z.object({ stt: VoiceProviderView, tts: VoiceProviderView }),
  pending: ChatPendingView.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turns: z.number().int(),
  lastTurn: VoiceTurnView.nullable(),
  /**
   * The last `VOICE_RECENT_TURNS` ended turns, in the order they ended (`lastTurn` is the last
   * of them): a shell without the event stream that missed a turn (a barge-in while it waited
   * for the previous one) completes its lines from here. Only `GET /voice/sessions/:id`
   * carries it; the press, start and stop answers leave it out.
   */
  recentTurns: z.array(VoiceTurnView).optional(),
  /** The last event's seq, for `GET /voice/sessions/:id/events?afterSeq=`. */
  lastSeq: z.number().int(),
});
export type VoiceSessionView = z.infer<typeof VoiceSessionView>;

/** What a captured chunk's post answers: the session's state, nothing more (many per second). */
export const VoiceAudioAckView = z.object({
  id: z.string(),
  state: z.enum(VOICE_STATES),
  turn: z.number().int(),
  lastSeq: z.number().int(),
});
export type VoiceAudioAckView = z.infer<typeof VoiceAudioAckView>;

export const VoiceAnswerView = z.object({
  pendingId: z.string(),
  answer: z.enum(["tap", "no"]),
  result: CommandResultViewSchema,
  approval: VoiceApprovalView,
});
export type VoiceAnswerView = z.infer<typeof VoiceAnswerView>;

/**
 * One frame of `GET /voice/sessions/:id/events`. `type` is the loop's event type (`state`,
 * `turn_start`, `transcript_partial`, `transcript_final`, `model_delta`, `sentence`, `audio`,
 * `speaking_start`, `speaking_end`, `barge_in`, `turn_end`, `error`) or the bridge's
 * (`voice.first_audio`, `voice.readback` = approval needed, `voice.approval`, `voice.answer`,
 * `voice.turn` = done, `voice.stopped`); `data` holds the event's fields without `type` and
 * `turn`. An `audio` frame's data is `{ sentenceIndex, sampleRate, channels, timestampMs,
 * pcm }` with `pcm` base64 16-bit PCM; audio frames are never replayed on a resume.
 */
export const VoiceEventView = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  turn: z.number().int().nullable(),
  data: z.unknown(),
});
export type VoiceEventView = z.infer<typeof VoiceEventView>;

/** Server-sent event names on GET /voice/sessions/:id/events. */
export type VoiceSseEvent =
  | { event: "voice.event"; data: VoiceEventView }
  | { event: "heartbeat"; data: { at: string } };

// ---------------------------------------------------------------------------------------
// Read aloud (spec A.6 "readable aloud", L.6 "TTS for summaries and alerts"; ADR 0063): a text
// synthesised sentence by sentence through the registry's TTS and streamed to the shell the
// way a voice turn's reply is. No model call: it works without a model credential.

export const SPEAK_STATES = ["speaking", "done", "cancelled", "failed"] as const;

export const SpeakSubjectView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("session"), id: z.string(), projectId: z.string().nullable() }),
  z.object({ kind: z.literal("notification"), id: z.string(), notificationKind: z.string() }),
]);
export type SpeakSubjectView = z.infer<typeof SpeakSubjectView>;

export const SpeakBody = z.object({
  /** BCP-47 for the provider; default: the provider's own. */
  language: z.string().optional(),
});
export type SpeakBody = z.infer<typeof SpeakBody>;

export const SpeakView = z.object({
  id: z.string(),
  subject: SpeakSubjectView,
  /** Who asked: `ui` (the button), `chat` / `voice` (the `summary.speak` command), `notification`. */
  source: z.string(),
  state: z.enum(SPEAK_STATES),
  /** The whole text, echoed so the screen shows what is being read. */
  text: z.string(),
  sentences: z.array(z.string()),
  /** The sentences whose playback started (what the person heard so far). */
  heard: z.string(),
  unspokenText: z.string().nullable(),
  audioChunks: z.number().int(),
  audioStored: z.literal(false),
  firstAudioMs: z.number().nullable(),
  provider: VoiceProviderView,
  /** The session whose log carries the `voice.speak` row. */
  conversationSessionId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The last event's seq, for `GET /speak/:id/events?afterSeq=`. */
  lastSeq: z.number().int(),
});
export type SpeakView = z.infer<typeof SpeakView>;

/**
 * One frame of `GET /speak/:id/events`: `sentence` (every sentence up front, `{ index, text }`),
 * `audio` (the voice loop's frame: `{ sentenceIndex, sampleRate, channels, timestampMs, pcm }`,
 * live only), `speaking_start` (`{ firstAudioMs }`), `speaking_end`, `error`, `speak.done`
 * (`{ record }`).
 */
export const SpeakEventView = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  data: z.unknown(),
});
export type SpeakEventView = z.infer<typeof SpeakEventView>;

/**
 * The `speak.started` frame on `GET /events`: a speech player attaches to the utterance's
 * stream to play it. `player` says who plays it: `requester` (the Read aloud button that asked
 * follows it itself) or `any` (an alert, `summary.speak` by chat: every speech player plays it).
 */
export const SpeakStartedView = z.object({
  id: z.string(),
  subject: SpeakSubjectView,
  source: z.string(),
  player: z.enum(["requester", "any"]),
  sentences: z.number().int(),
});
export type SpeakStartedView = z.infer<typeof SpeakStartedView>;

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Server-sent event names on GET /events and GET /sessions/:id/events. */
export type DaemonSseEvent =
  | { event: "session.event"; data: EventView }
  | { event: "inbox.changed"; data: { blockingCount: number } }
  | { event: "session.changed"; data: SessionView }
  | { event: "project.changed"; data: { id: string } }
  | { event: "extension.changed"; data: { type: string; id: string; name: string } }
  | {
      event: "restart.requested";
      data: { reason: string; targetVersion: string; fromVersion: string; exitCode: number };
    }
  /** Desktop control's on-screen indicator (spec S.32): the shells show a banner while `on`. */
  | { event: "desktop.indicator"; data: DesktopIndicatorEventData }
  | { event: "heartbeat"; data: { at: string } };

/**
 * Route table. Paths are relative to the daemon base URL (http://127.0.0.1:<port>); all need
 * `Authorization: Bearer <token>` where the token comes from the daemon file in the runtime
 * directory (desktop shell) or from a device pairing (phone, web).
 */
// ---------------------------------------------------------------------------------------------
// Agent email (spec S.15 to S.29, T.14): the Settings -> Capabilities -> Email page

export const EMAIL_MODES = [
  "off",
  "read_only",
  "draft_only",
  "allowlist",
  "full_discretion",
] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

/**
 * The agent's email configuration as `GET|PUT /agents/:agentId/email/settings` serve it: the
 * daemon's browser-safe copy of `AgentEmailConfigSchema` in
 * `packages/capabilities/src/email/types.ts` (which pulls `@forerunner/platform`). Field for
 * field; the mirror is more lenient (plain strings where the capability validates addresses,
 * domains, secret references and the marker) but never narrower.
 * `test/email-routes-wiring.test.ts` parses the daemon's answer with both and compares the
 * key sets so drift fails before a screen does. Mailbox credentials are secret references
 * (`secret:<name>`), never values: the capability refuses anything else on PUT.
 */
export const EmailImapView = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  user: z.string(),
  passwordRef: z.string(),
  folder: z.string(),
  draftsFolder: z.string(),
});
export const EmailSmtpView = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  user: z.string(),
  passwordRef: z.string(),
});
export const EmailMailboxView = z.object({
  /** The agent's own address, never the human's personal inbox (S.15). */
  address: z.string(),
  imap: EmailImapView.nullable(),
  smtp: EmailSmtpView.nullable(),
});
export type EmailMailboxView = z.infer<typeof EmailMailboxView>;
export const EmailSendingSettingsView = z.object({
  mode: z.enum(EMAIL_MODES),
  allowlist: z.object({ addresses: z.array(z.string()), domains: z.array(z.string()) }),
  dailySendCap: z.number().int().min(0),
  perRecipientDailyCap: z.number().int().min(0),
  signature: z.object({ enabled: z.boolean(), text: z.string() }),
  /** One-click pause (S.28): every send is held while true. */
  paused: z.boolean(),
  dailyDigest: z.boolean(),
  mailbox: EmailMailboxView.nullable(),
});
export const EmailCommandSettingsView = z.object({
  enabled: z.boolean(),
  registeredHumanAddress: z.string().nullable(),
  /** The private subject tag, e.g. "[FR-7k2q]"; `POST .../email/rotate-marker` replaces it. */
  marker: z.string(),
  pollIntervalMs: z.number().int(),
  perEmailCapChfMicro: z.number().int(),
  perEmailCapUsdMicro: z.number().int().nullable(),
  dailyTaskCap: z.number().int(),
  autonomyLevel: z.number().int().min(0).max(4),
});
export const EmailSettingsView = z.object({
  settings: EmailSendingSettingsView,
  commands: EmailCommandSettingsView,
});
export type EmailSettingsView = z.infer<typeof EmailSettingsView>;

/** The PUT body: a partial on either half (`AgentEmailConfigPatch`); the capability merges and validates. */
export interface EmailSettingsPatchBody {
  settings?: Partial<
    Omit<z.infer<typeof EmailSendingSettingsView>, "mailbox"> & {
      mailbox: {
        address: string;
        imap: Partial<z.infer<typeof EmailImapView>> | null;
        smtp: Partial<z.infer<typeof EmailSmtpView>> | null;
      } | null;
    }
  >;
  commands?: Partial<z.infer<typeof EmailCommandSettingsView>>;
}

/** One sent copy as `GET /agents/:agentId/email/sent` lists it (S.26), newest first. */
export const EmailSentRowView = z.looseObject({
  id: z.string(),
  kind: z.string(),
  messageId: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  mode: z.string(),
  signature: z.boolean(),
  toHuman: z.boolean(),
  sentAt: z.string(),
});
export type EmailSentRowView = z.infer<typeof EmailSentRowView>;
export const EmailSentView = z.object({ rows: z.array(EmailSentRowView), since: z.string() });
export type EmailSentView = z.infer<typeof EmailSentView>;

/**
 * One email command as `GET /agents/:agentId/email/commands` lists it (T.14): the email, its
 * interpretation and its result are one `email.command` audit row; `obeyed` false carries the
 * gate's reason in `deniedReason` (`ignored: <reason>`).
 */
export const EmailCommandRowView = z.object({
  id: z.string(),
  occurredAt: z.string(),
  obeyed: z.boolean(),
  deniedReason: z.string().nullable(),
  sessionId: z.string().nullable(),
  email: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});
export type EmailCommandRowView = z.infer<typeof EmailCommandRowView>;
export const EmailCommandsView = z.object({ rows: z.array(EmailCommandRowView) });
export type EmailCommandsView = z.infer<typeof EmailCommandsView>;
export const EmailPausedView = z.object({ paused: z.boolean() });
export type EmailPausedView = z.infer<typeof EmailPausedView>;
export const EmailMarkerView = z.object({ marker: z.string() });
export type EmailMarkerView = z.infer<typeof EmailMarkerView>;

// ---------------------------------------------------------------------------------------
// Cloud runner vault unlock, device side (spec S.12, ADR 0033, ADR 0068): the desktop inbox's
// unlock card asks the daemon, which holds the OS keyring, to wrap the runner's vault key to
// the challenge; the key never crosses this API, only the wrapped answer does.

/** Whether this computer can answer a runner's unlock: never the key, only its presence. */
export const RunnerKeyStatusView = z.object({
  runnerId: z.string(),
  available: z.boolean(),
  /** The vault backend the key would come from: keyring, file or memory. */
  backend: z.string(),
  /** Why the card is read-only here, when `available` is false. */
  reason: z.string().nullable(),
});
export type RunnerKeyStatusView = z.infer<typeof RunnerKeyStatusView>;

export const RunnerUnlockWrapBody = z.object({
  /**
   * The open unlock request the runner filed. The daemon reads the challenge from its own
   * store, never from the body, so a caller cannot have the key wrapped to a key pair of its
   * choosing.
   */
  requestId: z.string().min(1).max(200),
  /** Set (ISO-8601) or clear (null) the human's auto-unlock window with this answer. */
  autoUnlockUntil: z.string().nullable().optional(),
});
export type RunnerUnlockWrapBody = z.infer<typeof RunnerUnlockWrapBody>;

/** The answer the inbox sends to the request: ciphertext and public keys only. */
export const RunnerUnlockAnswerView = z.object({
  challengeId: z.string(),
  devicePublicKey: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  autoUnlockUntil: z.string().nullable().optional(),
});
export type RunnerUnlockAnswerView = z.infer<typeof RunnerUnlockAnswerView>;

export const DAEMON_ROUTES = {
  health: "GET /health",
  me: "GET /me",
  agents: "GET /agents",
  renameAgent:
    "POST /agents/:id/rename { name } (RenameAgentBody -> AgentView: renames the signed-in human's principal agent, U-025; the name is NFC-normalized and trimmed, 1 to 60 characters, no control characters, and differs (case-insensitively) from the human's other agents, else 409 conflict with cause validation; the critic and other non-principal agents keep their names (409, cause validation); 403 forbidden for another human's agent, 404 for an unknown one; one agent.rename audit row and an agent.changed frame on /events; the same name answers the agent unchanged, nothing written)",
  projects: "GET /projects",
  createProject: "POST /projects",
  project: "GET /projects/:id",
  projectSummary: "GET /projects/:id/summary",
  tasks: "GET /projects/:id/tasks?status=&limit=",
  createTask:
    "POST /projects/:id/tasks (CreateTaskBody -> 201 TaskView; dependsOn must name tasks of the project that are not cancelled, else 409 conflict with cause validation and a message naming them, U-040)",
  setTaskDependencies:
    "POST /tasks/:id/dependencies (SetTaskDependenciesBody { version, dependsOn, reason } -> TaskView: the tasks it waits on, all of them; an id that is no task of the project, the task itself, a cancelled task or a cycle is 409 conflict with cause validation and a message naming it, a stale version 409 conflict, nothing written; 404 for an unknown task; U-040)",
  startCheck:
    "GET /projects/:id/start-check?budgetUsdMicro= (StartCheckView: what a session started now would plan: the ready tasks it would run, those left out for budget and those waiting on a task not done, priced and cut as the runner does; without a budget the project's session cap; 404 for an unknown project; U-040)",
  planProject:
    "POST /projects/:id/plan (ProjectPlanBody -> 201 PlanProjectView: the plan written as milestone and task rows; one milestone and a flat task list in small-project mode, spec B.6, where a later plan joins the project's open milestone (reusedMilestone), which keeps its name and takes the plan's new success criteria and a later target date (merged says what was added; an audit row project.plan carries the plan's reason); an unknown dependency, a cycle, an empty plan or one over the caps is refused as 409 conflict with cause validation (ADR 0025) and nothing is written; 404 for an unknown project)",
  transitionTask: "POST /tasks/:id/transition",
  queue:
    "GET /projects/:id/queue?status= (QueueItemView[]: this human's items of the project, newest first, up to 200; status narrows to queued, consumed or dismissed; 404 for an unknown project, 403 forbidden for another human's)",
  enqueue:
    "POST /projects/:id/queue { kind, text, priority? } (EnqueueBody -> 201 QueueItemView: queued for the agent's next session, which reads it at its start)",
  dismissQueueItem:
    "POST /queue/:id/dismiss (QueueItemView: dismissed; 409 conflict when it is no longer queued, 403 forbidden for another human's item)",
  docs: "GET /projects/:id/docs (DocView[]: the standard doc set in order, read from the project's linked folder, this install's docs clone or its workspace, without fetching; drift from the open critic findings)",
  doc: "GET /projects/:id/docs/:path (DocContentView: one doc of the set, the path URL-encoded; 404 for a path outside the set or a doc not written yet)",
  milestones:
    "GET /projects/:id/milestones (MilestoneView[] in planning order, each with the reason and author of its last change, spec B.5; 404 for an unknown project)",
  changeMilestone:
    "POST /milestones/:id (ChangeMilestoneBody { version, reason, name?, successCriteria?, targetDate?, status? } -> MilestoneView: the change recorded with the human as author and the reason on the row, spec B.5; a missing or blank reason and a stale version are 409 conflict with cause validation / version_conflict, ADR 0025, and nothing moves; 404 for an unknown milestone)",
  runs: "GET /projects/:id/runs?limit=",
  sessions: "GET /sessions?agentId=&projectId=&status=",
  startSession:
    "POST /sessions (StartSessionBody -> 202 StartSessionView: started, queued behind the agent's running session, or deferred by quiet hours; a started one waits up to 15 s for its session and carries it; a waiting one carries `ahead`, the number of the agent's waiting starts before it, which run in order and are never replaced (U-043); a run that fails before its session begins answers that error)",
  session: "GET /sessions/:id",
  sessionEvents: "GET /sessions/:id/events?afterSeq= (JSON) | Accept: text/event-stream (SSE)",
  stopSession:
    "POST /sessions/:id/stop (SessionView; ends the session's runs and freezes nothing, a kill in force stays)",
  kill: "POST /kill",
  resume: "POST /kill/resume",
  shutdown:
    "POST /shutdown (202 { stopping, stoppedRuns, killedProcesses, revokedTokens, durationMs, scope }; stops every run, then the daemon exits 0; 409 when it cannot end its process; the desktop shell's Quit, ADR 0094)",
  inbox: "GET /inbox?humanId=",
  answerRequest: "POST /requests/:id/answer",
  decisions: "GET /projects/:id/decisions",
  peers: "GET /projects/:id/peers (what the other agents on the project are doing)",
  markRead: "POST /messages/:id/read",
  chat: "POST /chat (JSON) | POST /chat/stream (SSE tokens then a final reply event)",
  costs: "GET /costs?projectId=&from=&to=",
  costEstimates: "GET /costs/estimates (estimate-versus-actual accuracy, EstimateAccuracyView)",
  performance:
    "GET /performance?projectId=&days= (PerformanceView, spec D.7, D.19: per mode the samples, p50 and p90 by nearest rank of time to first token and total time, the target, met or not, the effort in force; from the Run rows and the chat and voice turns of the last days, 7 by default, at most 90; the install's human's agents only; 400 for a bad days, 404 for an unknown project)",
  auditExport:
    "GET /audit/export?agentId=&sessionId=&from=&to=&format=jsonl|csv (spec S.9: the audit log as a file download, streamed in pages; the install's human's rows and their agents' with the summaries as stored; Content-Disposition names the file; 404 for another human's agent, 400 for a bad format, timestamp or window)",
  settings: "GET /settings?scope=&scopeId=",
  modelSettings:
    "GET /settings/models (ModelSettingsView, spec D.4: per agent mode and per specialist the model, effort, max tokens, speed mode and timeout in force with the effort-table or registry default and the source; temperature only when the provider's acceptsTemperature flag is true; changed through POST /commands/execute with model.settings.set)",
  updateProjectSettings:
    "PUT /projects/:id/settings { version, settings } (merged; mirror schedule follows)",
  mirrorSync:
    "POST /projects/:id/mirror/sync { full? } (one-way GitHub Projects mirror run: 200 MirrorRunView, or 202 MirrorSyncPendingView while the human decides)",
  intake:
    "POST /projects/:id/intake (IntakeRequestBody -> 202 IntakeProposalView: PM intake, spec A.2, ADR 0055; one planning-rung model call turns the brief into the plan, the standard doc set and a first-session plan, filed as one blocking approval request whose card carries the whole proposal (change_card.key intake:<project>); an open proposal is reused without a call; nothing is written until the answer in the inbox: approve writes milestones and tasks (applyProjectPlan), the docs as a pull request on the project's repository or into its workspace directory, and the first-session plan onto the summary cache and the next-session queue; reject writes a queue note only; 409 conflict with cause validation when the model's reply is malformed or its plan cannot be written (a dependency cycle), with cause claim_conflict when a brief is given while a proposal is open; 503 without a model provider; 404 for an unknown project)",
  intakeStatus:
    "GET /projects/:id/intake (IntakeStatusView: the latest intake request and its outcome, where the docs went, or why the last automatic intake failed or an approved proposal could not be written: state failed, outcome apply_failed, the error; state drafting while the background draft runs)",
  intakeRetry:
    "POST /projects/:id/intake/retry (-> 202 IntakeStatusView: U-046, the project page's Retry after a failed intake; drafts the proposal again in the background and answers drafting at once; a plan waiting in the Inbox, a running draft or an answered intake is answered as it stands with no model call; 503 without a model provider, 404 for an unknown project)",
  extensions: "GET /extensions?kind=",
  extensionCatalog: "GET /extensions/catalog",
  extension: "GET /extensions/:id",
  addExtension:
    "POST /extensions { catalogId, confirmIn?: panel } | { url } (202 while the human decides; panel: confirmed in the panel, no Inbox card, U-026)",
  toggleExtension: "POST /extensions/:id/toggle { enabled }",
  approveExtension:
    "POST /extensions/:id/approve { answer?: device, deviceId?, biometric? } (a row added in the panel needs the device answer, U-026)",
  denyExtension: "POST /extensions/:id/deny",
  extensionPermissions: "PUT /extensions/:id/permissions { permissions }",
  removeExtension: "DELETE /extensions/:id",
  updates: "GET /updates (app, connector and model updates; local state, no network)",
  updatesStatus: "GET /updates/status (no network)",
  checkUpdates: "POST /updates/check (the human's Check for updates; asks the feed)",
  applyUpdate: "POST /updates/apply { version? } (202; the daemon exits with RESTART_EXIT_CODE)",
  rollbackUpdate: "POST /updates/rollback { reason? } (202; same restart contract)",
  modelWatchReports: "GET /model-watch/reports?limit=",
  modelWatchLatest: "GET /model-watch/reports/latest",
  modelWatchReport: "GET /model-watch/reports/:id",
  modelWatchRun: "POST /model-watch/run",
  modelWatchAnswer: "POST /model-watch/reports/:id/answer { decision, adopt?, by }",
  modelWatchSync: "POST /model-watch/sync",
  reviews:
    "GET /projects/:id/reviews?limit= (Reviews tab: ReviewsView with findings, verdicts, grade trend)",
  taskReviews: "GET /tasks/:id/reviews (ReviewsView for one task)",
  memoryScopes: "GET /memory/scopes (one view per principal, the critic and shared, with counts)",
  memory:
    "GET /memory?scope=&agentId=&projectId=&q=&tag=&status=&limit= (MemoryView; agentId required for agent_private)",
  updateLesson: "PUT /memory/lessons/:id { text?, tags?, confidence?, pinned? } (LessonView)",
  pinLesson: "POST /memory/lessons/:id/pin { pinned } (LessonView)",
  deleteLesson: "DELETE /memory/lessons/:id (retires the row and removes its file)",
  consolidation: "GET /memory/consolidation (ConsolidationProposalView[], newest first)",
  runConsolidation:
    "POST /memory/consolidation/run (report only; files the approval request the inbox answers; ConsolidationRunView)",
  proposeLesson:
    "POST /memory/lessons/:id/propose (spec G.6: tags the lesson general and proposes it for the shared store; the critic decides at the next session end; LessonView of the proposal; 404 for another human's private row; 409 for a global shared lesson or a project copy of one; 422 injection_suspected for a text that reads as an instruction)",
  memoryPromotions:
    "GET /memory/promotions (LessonView[]: this human's proposals the critic has not decided yet)",
  memoryOffers:
    "GET /memory/offers?limit= (LessonOfferView[], newest first: promoted lessons offered to this human's other projects by tag overlap)",
  answerOffer:
    "POST /memory/offers/:id/answer { answer: accept|dismiss } (applied at once: accept pins a copy in the project's shared memory, dismiss leaves it by relevance; one audit row; LessonOfferView)",
  commands: "GET /commands (the registry: CommandDefView[])",
  parseCommand:
    "POST /commands/parse { text, source?: text|voice|phone|ui, projectId?, deviceId? } (CommandParseView; nothing runs)",
  executeCommands:
    "POST /commands/execute { commands, wordsUsed?, source?: text|voice|phone|ui, projectId?, deviceId?, confirm? } (CommandResultView: one change card, one change log row logged with the source, ui for the settings screen; medium risk comes back pending, high needs the device)",
  pendingCommands: "GET /commands/pending (PendingChangeView[])",
  confirmCommand:
    "POST /commands/:id/confirm { answer: yes|no|tap|device, deviceId?, biometric? } (CommandResultView)",
  cancelCommand: "POST /commands/:id/cancel (CommandResultView)",
  changes: "GET /changes?projectId=&undoable=&limit= (ChangeLogView[], newest first)",
  undoChange: "POST /changes/:id/undo (CommandResultView; only while the row is undoable)",
  notificationPrefs:
    "GET /notifications/prefs (NotificationPrefsView: prefs, resolved timezone and email, channel statuses)",
  setNotificationPrefs:
    "PUT /notifications/prefs { NotificationPrefsPatch } (NotificationPrefsView; 400 validation; one audit row naming the keys changed)",
  testNotification:
    "POST /notifications/test ({ deliveries }: one test send per configured channel)",
  recentNotifications:
    "GET /notifications/recent?limit= ({ notifications: NotificationRecordView[] })",
  pendingNotifications:
    "GET /notifications/pending ({ held, digest }: quiet-hours and digest queues)",
  cloudflareSettings:
    "GET /cloudflare/projects/:projectId/settings (settings with the secret by reference, scope)",
  cloudflareToken:
    "GET /cloudflare/projects/:projectId/token (verifyToken: status, expiry, scopes, warnings)",
  desktopStatus:
    "GET /desktop/status (DesktopStatusView: the controller's status with desktopControl { active, app, sessionId, agentId, since }, plus detection: platform, display server, available, found, missing, notes)",
  desktopAllowlist:
    "GET /desktop/allowlist/:humanId ({ humanId, entries }; a human's own list only)",
  setDesktopAllowlist:
    "PUT /desktop/allowlist/:humanId { entries } ({ humanId, entries }; 400 validation, 403 another human's id; one audit row)",
  desktopRevoke:
    "POST /desktop/revoke { reason? } (live revocation: interrupts and drops desktop actions, refuses until resume; open to any caller)",
  desktopResume: "POST /desktop/resume (the signed-in human resumes; DesktopStatus)",
  sources:
    "GET /sources (SourceView[]: the daemon's human's connected sources with the counts of their candidates; spec A.4)",
  addSource:
    "POST /sources { kind: github_org|github_user|github_repo|local_folder, locator, displayName?, credentialRef? } (201 SourceView; a GitHub kind names its token as secret:<name>, default secret:github_token, and a token value is refused; 400 for gitlab and git_remote (later), a bad login, a relative or missing folder; 409 conflict when the same source is connected already)",
  source: "GET /sources/:id (SourceView; 403 forbidden for another human's source)",
  scanSource:
    "POST /sources/:id/scan (ScanResultView: one candidate per repository or folder, proposed, or duplicate when a project or another source already covers it, accepted ones kept, ones no longer found gone; existingInstall with the marker; a failed scan sets the source's status to error and answers 503 for a host or credential problem)",
  sourceCandidates: "GET /sources/:id/candidates?status= (SourceCandidateView[])",
  acceptCandidate:
    "POST /sources/candidates/:id/accept { name?, goal?, autonomyLevel?, budgetUsdMicro? } (201 AcceptCandidateView: the project created through the same path as POST /projects with no brief; 409 conflict for an accepted, duplicate or gone candidate, a repo a project took meanwhile, or a taken name)",
  removeSource:
    "DELETE /sources/:id ({ ok, id, candidatesRemoved }; projects created from it stay)",
  ...DEVICES_ROUTES,
  ...SETUP_ROUTES,
  // Settings -> Claude subscription allowance (U-052).
  ...PLAN_ALLOWANCE_ROUTES,
  // Settings -> Claude: which to use first (U-078).
  ...BILLING_ORDER_ROUTES,
  // The mailbox passwords and cloud voice keys typed in the app (U-054).
  ...SECRET_STORE_ROUTES,
  // Settings -> Voice (ADR 0090): the voice profile, its install and progress.
  ...VOICE_INSTALL_ROUTES,
  dataAssets: "GET /projects/:id/data (DataAssetView[])",
  registerDataAsset:
    "POST /projects/:id/data { locator, kind?, mode?, name?, sizeBytes? } | multipart file (+ kind, name) (201 DataAssetView; 413 above the upload cap)",
  importData:
    "POST /projects/:id/data/import { source: zip|folder|github, path|locator, copy?, tokenRef? } (ImportResultView; 400 for a hostile archive, nothing written; github clones under the project's repos dir onto forerunner/migration-<date>, the default branch untouched, the token by secret reference only)",
  dataAsset: "GET /data/:id (DataAssetView)",
  dataSample: "GET /data/:id/sample?rows=&bytes= (DataSample, capped by the data limits)",
  removeDataAsset: "DELETE /data/:id ({ ok, id, deletedFromDisk }; needs the daemon's human)",
  emailSettings:
    "GET /agents/:agentId/email/settings (EmailSettingsView; the daemon's human must own the agent, else 403 tool_not_allowed)",
  updateEmailSettings:
    "PUT /agents/:agentId/email/settings { settings?, commands? } (EmailSettingsView after the merge; 400 validation, credentials as secret references only; one email.settings audit row; the sending mode is not changed here: a mode change is the registry's email.mode.set through POST /commands/execute (high risk: a change card, a confirmation on a paired device, undo; spec Q), and a PUT whose settings.mode differs from the stored one is 403 tool_not_allowed with details.reason mode_change_needs_command, nothing written)",
  emailSent:
    "GET /agents/:agentId/email/sent?limit=&since= (EmailSentView: the owner's copies, newest first; since is an ISO-8601 instant, anything else is the 7-day default, the instant used echoed back)",
  pauseEmail:
    "POST /agents/:agentId/email/pause (EmailPausedView { paused: true }; every send is held until resume; the tray's one click, S.28)",
  resumeEmail: "POST /agents/:agentId/email/resume (EmailPausedView { paused: false })",
  rotateEmailMarker:
    "POST /agents/:agentId/email/rotate-marker (EmailMarkerView; the old command marker stops working at once)",
  emailCommands:
    "GET /agents/:agentId/email/commands?limit= (EmailCommandsView: every email command with its interpretation and result, newest first, T.14)",
  runnerKeyStatus:
    "GET /runner-unlock/:runnerId/key (RunnerKeyStatusView: whether this computer's vault holds the runner's vault key under cloud_runner_vault_key:<runner>, the backend, the reason when it does not; never the key; spec S.12, ADR 0068)",
  wrapRunnerKey:
    "POST /runner-unlock/wrap { requestId, autoUnlockUntil? } (RunnerUnlockAnswerView: the runner's vault key wrapped inside the daemon to the one-time runner key of the challenge on that stored, open unlock request of this human, the answer the inbox then sends to the request; 404 not_found for an unknown request or without the key, 403 for another human's request, 409 conflict when it is no longer open, 400 validation for a request that is not an unlock challenge, an expired challenge or a window over a week; one runner.unlock_answer_wrapped audit row without the key)",
  voiceStatus:
    "GET /voice/status (VoiceStatusView: available with the providers picked, or the reason voice is unavailable)",
  startVoiceSession:
    "POST /voice/sessions { projectId?, language?, mode?, replyMode?: voice|text } (201 VoiceSessionView; replyMode text streams every reply as text only, no TTS and no audio; 503 unavailable with the reason when no provider or no model credential is configured)",
  voiceSession:
    "GET /voice/sessions/:id (VoiceSessionView with recentTurns, the last 8 ended turns)",
  stopVoiceSession: "POST /voice/sessions/:id/stop (VoiceSessionView; immediate in every state)",
  voicePress:
    "POST /voice/sessions/:id/press { pressed, replyMode?: voice|text } (push-to-talk press or release; a press while the agent speaks or writes is the barge-in; a press while the last turn is transcribing waits for its final, ends that turn without a reply and answers once the new turn listens; replyMode only with pressed: true, for the turn the press starts; VoiceSessionView without recentTurns)",
  voiceAudio:
    "POST /voice/sessions/:id/audio { pcm (base64 int16 LE), sampleRate, channels, timestampMs } | application/octet-stream ?sampleRate=&channels=&timestampMs= (one captured chunk; VoiceAudioAckView { id, state, turn, lastSeq })",
  voiceText:
    "POST /voice/sessions/:id/text { text, replyMode?: voice|text } (the text fallback: one turn through the same loop, approval rules and TTS (none when the reply mode is text); VoiceTurnView once the turn has ended, with the registry's outcome when the line answered a card)",
  voiceAnswer:
    "POST /voice/sessions/:id/answer { answer: tap|no } (answers the read-back without speaking through the registry, which decides and whose status is on the decision; VoiceAnswerView; 404 without a card)",
  voiceHeard:
    "POST /voice/sessions/:id/heard { turn, heardFirstAudioMs } (the panel's player: push-to-talk release to the first reply chunk at the speaker, on the page's clock; once per turn; on the voice.turn row as latency.heardFirstAudioMs, or a voice.heard row when the row was written; VoiceHeardView; 404 for an unknown turn, 409 for a second figure, a bad one or a turn replied in text)",
  voiceEvents:
    "GET /voice/sessions/:id/events?afterSeq= (JSON VoiceEventView[]; 409 when afterSeq is not a number; a numeric Last-Event-ID header, which an EventSource sends when it reconnects, resumes after the later of the two) | Accept: text/event-stream (SSE voice.event frames: state, transcript (partial and final), model deltas and sentences (the reply's text as it is generated, before its audio), audio (with the sentence index), first audio, read-back = approval needed, approval with the registry's status, answer = the registry's result of a spoken, tapped or cancelled answer, turn = done; heartbeat; ?token= accepted)",
  speakProject:
    "POST /projects/:id/speak { language? } (201 SpeakView: the one-screen summary read aloud sentence by sentence through the registry's TTS, the text echoed; a new utterance cancels the one in flight; 403 forbidden for another human's project; 503 unavailable with the reason when no TTS provider can run)",
  speakSession:
    "POST /sessions/:id/speak { language? } (201 SpeakView: the session's summary read aloud; 409 validation when the session has no summary yet; 403 forbidden for another human's session)",
  speak: "GET /speak/:id (SpeakView; finished utterances are kept for a while, then 404)",
  cancelSpeak: "POST /speak/:id/cancel (SpeakView; immediate, a no-op once ended)",
  speakEvents:
    "GET /speak/:id/events?afterSeq= (JSON SpeakEventView[]; 409 when afterSeq is not a number; a numeric Last-Event-ID resumes after the later of the two) | Accept: text/event-stream (SSE speak.event frames: sentence, audio with the voice loop's PCM frame, speaking_start, speaking_end, error, speak.done; heartbeat; ?token= accepted)",
  events:
    "GET /events (SSE: session.event, inbox.changed, session.changed, project.changed, agent.changed ({ id, name }: an agent was renamed; re-read /me and /agents), extension.changed, restart.requested, notification, desktop.indicator, speak.started, heartbeat; ?client=shell or X-Forerunner-Client: shell marks a stream that shows notification frames as toasts; ?speech=play marks a stream whose client plays the speak.started utterances)",
} as const;
