import { z } from "zod";

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
  health: z.enum(["good", "attention", "blocked", "idle"]),
  spend: Money,
  budget: Money,
  waitingOnYou: z.number().int(),
  latestCriticGrade: z.number().int().min(0).max(100).nullable(),
  lastSessionAt: z.string().nullable(),
  active: z.boolean(),
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
  priority: z.number().int(),
  claimedBy: z.string().nullable(),
  claimExpires: z.string().nullable(),
  dependsOn: z.array(z.string()),
  budget: Money,
  estimate: Money,
  actual: Money,
  specialist: z.string().nullable(),
  attempt: z.number().int(),
  prUrl: z.string().nullable(),
  branch: z.string().nullable(),
  reason: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type TaskView = z.infer<typeof TaskView>;

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

export const StartSessionBody = z.object({
  agentId: z.string(),
  projectId: z.string().optional(),
  budgetUsdMicro: z.number().int().positive().optional(),
  trigger: z.enum(["manual", "remote"]).default("manual"),
  reason: z.string().optional(),
});
export type StartSessionBody = z.infer<typeof StartSessionBody>;

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
});

export const CreateTaskBody = z.object({
  title: z.string().min(3),
  outcome: z.string().min(3),
  acceptanceCriteria: z.array(z.string()).default([]),
  riskTier: z.number().int().min(0).max(3).default(1),
  priority: z.number().int().min(1).max(9).default(5),
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
});
export type HealthView = z.infer<typeof HealthView>;

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
export const HumanView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  timezone: z.string(),
  defaultAutonomy: z.number().int(),
  monthlyCap: Money,
});

export const SettingView = z.object({
  key: z.string(),
  scope: z.enum(["global", "human", "agent", "project"]),
  scopeId: z.string().nullable(),
  value: z.unknown(),
  description: z.string(),
  risk: z.enum(["low", "medium", "high"]),
});

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

export const CommandParseBody = z.object({
  text: z.string().min(1),
  source: z.enum(["text", "voice", "phone"]).optional(),
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
  source: z.enum(["text", "voice", "phone"]).optional(),
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
  /** For `device`: the paired device that confirms; a phone also needs `biometric: true`. */
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
  createdAt: z.string(),
  version: z.number().int(),
});
export type ChangeLogView = z.infer<typeof ChangeLogView>;

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
  | {
      event: "desktop.indicator";
      data: {
        on: boolean;
        agentId?: string;
        sessionId?: string;
        runId?: string;
        humanId?: string;
        app?: string;
        message?: string;
        at?: string;
      };
    }
  | { event: "heartbeat"; data: { at: string } };

/**
 * Route table. Paths are relative to the daemon base URL (http://127.0.0.1:<port>); all need
 * `Authorization: Bearer <token>` where the token comes from the daemon file in the runtime
 * directory (desktop shell) or from a device pairing (phone, web).
 */
export const DAEMON_ROUTES = {
  health: "GET /health",
  me: "GET /me",
  agents: "GET /agents",
  projects: "GET /projects",
  createProject: "POST /projects",
  project: "GET /projects/:id",
  projectSummary: "GET /projects/:id/summary",
  tasks: "GET /projects/:id/tasks?status=&limit=",
  createTask: "POST /projects/:id/tasks",
  transitionTask: "POST /tasks/:id/transition",
  runs: "GET /projects/:id/runs?limit=",
  sessions: "GET /sessions?agentId=&projectId=&status=",
  startSession: "POST /sessions",
  session: "GET /sessions/:id",
  sessionEvents: "GET /sessions/:id/events?afterSeq= (JSON) | Accept: text/event-stream (SSE)",
  stopSession: "POST /sessions/:id/stop",
  kill: "POST /kill",
  resume: "POST /kill/resume",
  inbox: "GET /inbox?humanId=",
  answerRequest: "POST /requests/:id/answer",
  decisions: "GET /projects/:id/decisions",
  peers: "GET /projects/:id/peers (what the other agents on the project are doing)",
  markRead: "POST /messages/:id/read",
  chat: "POST /chat (JSON) | POST /chat/stream (SSE tokens then a final reply event)",
  costs: "GET /costs?projectId=&from=&to=",
  costEstimates: "GET /costs/estimates (estimate-versus-actual accuracy, EstimateAccuracyView)",
  settings: "GET /settings?scope=&scopeId=",
  updateProjectSettings:
    "PUT /projects/:id/settings { version, settings } (merged; mirror schedule follows)",
  mirrorSync:
    "POST /projects/:id/mirror/sync { full? } (one-way GitHub Projects mirror run: 200 MirrorRunView, or 202 MirrorSyncPendingView while the human decides)",
  extensions: "GET /extensions?kind=",
  extensionCatalog: "GET /extensions/catalog",
  extension: "GET /extensions/:id",
  addExtension: "POST /extensions { catalogId } | { url } (202 while the human decides)",
  toggleExtension: "POST /extensions/:id/toggle { enabled }",
  approveExtension: "POST /extensions/:id/approve",
  denyExtension: "POST /extensions/:id/deny",
  extensionPermissions: "PUT /extensions/:id/permissions { permissions }",
  removeExtension: "DELETE /extensions/:id",
  updates: "GET /updates (app, connector and model updates; asks the feed)",
  updatesStatus: "GET /updates/status (no network)",
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
  commands: "GET /commands (the registry: CommandDefView[])",
  parseCommand:
    "POST /commands/parse { text, source?, projectId?, deviceId? } (CommandParseView; nothing runs)",
  executeCommands:
    "POST /commands/execute { commands, wordsUsed?, source?, projectId?, deviceId?, confirm? } (CommandResultView: one change card, one change log row; medium risk comes back pending, high needs the device)",
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
    "GET /desktop/status (DesktopStatus plus detection: platform, display server, available, found, missing, notes)",
  desktopAllowlist:
    "GET /desktop/allowlist/:humanId ({ humanId, entries }; a human's own list only)",
  setDesktopAllowlist:
    "PUT /desktop/allowlist/:humanId { entries } ({ humanId, entries }; 400 validation, 403 another human's id; one audit row)",
  desktopRevoke:
    "POST /desktop/revoke { reason? } (live revocation: interrupts and drops desktop actions, refuses until resume; open to any caller)",
  desktopResume: "POST /desktop/resume (the signed-in human resumes; DesktopStatus)",
  dataAssets: "GET /projects/:id/data (DataAssetView[])",
  registerDataAsset:
    "POST /projects/:id/data { locator, kind?, mode?, name?, sizeBytes? } | multipart file (+ kind, name) (201 DataAssetView; 413 above the upload cap)",
  importData:
    "POST /projects/:id/data/import { source: zip|folder, path|locator, copy? } (ImportResultView; 400 for a hostile archive, nothing written)",
  dataAsset: "GET /data/:id (DataAssetView)",
  dataSample: "GET /data/:id/sample?rows=&bytes= (DataSample, capped by the data limits)",
  removeDataAsset: "DELETE /data/:id ({ ok, id, deletedFromDisk }; needs the daemon's human)",
  events:
    "GET /events (SSE: session.event, inbox.changed, session.changed, project.changed, extension.changed, restart.requested, notification, desktop.indicator, heartbeat; ?client=shell or X-Forerunner-Client: shell marks a stream that shows notification frames as toasts)",
} as const;
