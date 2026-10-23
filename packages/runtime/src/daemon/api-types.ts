import { z } from "zod";

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
  /**
   * Small-project mode (spec B.6): one milestone, a flat task list, new tasks at critic tier 0.
   * Absent on a card the state service serves, which does not carry the flag yet.
   */
  smallProjectMode: z.boolean().optional(),
  /** The tier a new task of this project gets when it names none (`defaultRiskTier`). */
  defaultRiskTier: z.number().int().min(0).max(3).optional(),
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
  state: z.enum(["none", "pending", "approved", "rejected", "skipped", "failed"]),
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
});

export const SettingView = z.object({
  key: z.string(),
  scope: z.enum(["global", "human", "agent", "project"]),
  scopeId: z.string().nullable(),
  value: z.unknown(),
  description: z.string(),
  risk: z.enum(["low", "medium", "high"]),
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
  /** The table's effort for the mode (built-ins plus the adopted models.json), before the offset. */
  baseEffort: z.enum(EFFORT_LEVELS),
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
});
export type VoicePreferenceView = z.infer<typeof VoicePreferenceView>;

/** An enabled voice row that is not in force for a side, with the reason the panel shows. */
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
});
export type StartVoiceSessionBody = z.infer<typeof StartVoiceSessionBody>;

export const VoicePressBody = z.object({ pressed: z.boolean() });
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

export const VoiceTextBody = z.object({ text: z.string().min(1) });
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
  /** The last event's seq, for `GET /voice/sessions/:id/events?afterSeq=`. */
  lastSeq: z.number().int(),
});
export type VoiceSessionView = z.infer<typeof VoiceSessionView>;

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
  projects: "GET /projects",
  createProject: "POST /projects",
  project: "GET /projects/:id",
  projectSummary: "GET /projects/:id/summary",
  tasks: "GET /projects/:id/tasks?status=&limit=",
  createTask: "POST /projects/:id/tasks",
  planProject:
    "POST /projects/:id/plan (ProjectPlanBody -> 201 PlanProjectView: the plan written as milestone and task rows; one milestone and a flat task list in small-project mode, spec B.6, where a later plan joins the project's open milestone (reusedMilestone), which keeps its name and takes the plan's new success criteria and a later target date (merged says what was added; an audit row project.plan carries the plan's reason); an unknown dependency, a cycle, an empty plan or one over the caps is refused as 409 conflict with cause validation (ADR 0025) and nothing is written; 404 for an unknown project)",
  transitionTask: "POST /tasks/:id/transition",
  milestones:
    "GET /projects/:id/milestones (MilestoneView[] in planning order, each with the reason and author of its last change, spec B.5; 404 for an unknown project)",
  changeMilestone:
    "POST /milestones/:id (ChangeMilestoneBody { version, reason, name?, successCriteria?, targetDate?, status? } -> MilestoneView: the change recorded with the human as author and the reason on the row, spec B.5; a missing or blank reason and a stale version are 409 conflict with cause validation / version_conflict, ADR 0025, and nothing moves; 404 for an unknown milestone)",
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
    "POST /projects/:id/intake (IntakeRequestBody -> 202 IntakeProposalView: PM intake, spec A.2, ADR 0055; one planning-rung model call turns the brief into the plan, the standard doc set and a first-session plan, filed as one blocking approval request whose card carries the whole proposal (change_card.key intake:<project>); an open proposal is reused without a call; nothing is written until the answer in the inbox: approve writes milestones and tasks (applyProjectPlan), the docs as a pull request on the project's repository or into its workspace directory, and the first-session plan onto the summary cache and the next-session queue; reject writes a queue note only; 409 conflict with cause validation when the model's reply is malformed; 503 without a model provider; 404 for an unknown project)",
  intakeStatus:
    "GET /projects/:id/intake (IntakeStatusView: the latest intake request and its outcome, where the docs went, or why the last automatic intake failed)",
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
  proposeLesson:
    "POST /memory/lessons/:id/propose (spec G.6: tags the lesson general and proposes it for the shared store; the critic decides at the next session end; LessonView of the proposal; 404 for another human's private row)",
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
  dataAssets: "GET /projects/:id/data (DataAssetView[])",
  registerDataAsset:
    "POST /projects/:id/data { locator, kind?, mode?, name?, sizeBytes? } | multipart file (+ kind, name) (201 DataAssetView; 413 above the upload cap)",
  importData:
    "POST /projects/:id/data/import { source: zip|folder, path|locator, copy? } (ImportResultView; 400 for a hostile archive, nothing written)",
  dataAsset: "GET /data/:id (DataAssetView)",
  dataSample: "GET /data/:id/sample?rows=&bytes= (DataSample, capped by the data limits)",
  removeDataAsset: "DELETE /data/:id ({ ok, id, deletedFromDisk }; needs the daemon's human)",
  emailSettings:
    "GET /agents/:agentId/email/settings (EmailSettingsView; the daemon's human must own the agent, else 403 tool_not_allowed)",
  updateEmailSettings:
    "PUT /agents/:agentId/email/settings { settings?, commands? } (EmailSettingsView after the merge; 400 validation, credentials as secret references only; one email.settings audit row)",
  emailSent:
    "GET /agents/:agentId/email/sent?limit=&since= (EmailSentView: the owner's copies, newest first, 7 days by default)",
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
    "POST /voice/sessions { projectId?, language?, mode? } (201 VoiceSessionView; 503 unavailable with the reason when no provider or no model credential is configured)",
  voiceSession: "GET /voice/sessions/:id (VoiceSessionView)",
  stopVoiceSession: "POST /voice/sessions/:id/stop (VoiceSessionView; immediate in every state)",
  voicePress:
    "POST /voice/sessions/:id/press { pressed } (push-to-talk press or release; a press while the agent speaks is the barge-in; VoiceSessionView)",
  voiceAudio:
    "POST /voice/sessions/:id/audio { pcm (base64 int16 LE), sampleRate, channels, timestampMs } | application/octet-stream ?sampleRate=&channels=&timestampMs= (one captured chunk; VoiceSessionView)",
  voiceText:
    "POST /voice/sessions/:id/text { text } (the text fallback: one turn through the same loop, approval rules and TTS; VoiceTurnView once the turn has ended, with the registry's outcome when the line answered a card)",
  voiceAnswer:
    "POST /voice/sessions/:id/answer { answer: tap|no } (answers the read-back without speaking through the registry, which decides and whose status is on the decision; VoiceAnswerView; 404 without a card)",
  voiceEvents:
    "GET /voice/sessions/:id/events?afterSeq= (JSON VoiceEventView[]; 409 when afterSeq is not a number) | Accept: text/event-stream (SSE voice.event frames: state, transcript, model deltas, sentences, audio, first audio, read-back = approval needed, approval with the registry's status, answer = the registry's result of a spoken, tapped or cancelled answer, turn = done; heartbeat; ?token= accepted)",
  speakProject:
    "POST /projects/:id/speak { language? } (201 SpeakView: the one-screen summary read aloud sentence by sentence through the registry's TTS, the text echoed; a new utterance cancels the one in flight; 403 forbidden for another human's project; 503 unavailable with the reason when no TTS provider can run)",
  speakSession:
    "POST /sessions/:id/speak { language? } (201 SpeakView: the session's summary read aloud; 409 validation when the session has no summary yet; 403 forbidden for another human's session)",
  speak: "GET /speak/:id (SpeakView; finished utterances are kept for a while, then 404)",
  cancelSpeak: "POST /speak/:id/cancel (SpeakView; immediate, a no-op once ended)",
  speakEvents:
    "GET /speak/:id/events?afterSeq= (JSON SpeakEventView[]; 409 when afterSeq is not a number) | Accept: text/event-stream (SSE speak.event frames: sentence, audio with the voice loop's PCM frame, speaking_start, speaking_end, error, speak.done; heartbeat; ?token= accepted)",
  events:
    "GET /events (SSE: session.event, inbox.changed, session.changed, project.changed, extension.changed, restart.requested, notification, desktop.indicator, speak.started, heartbeat; ?client=shell or X-Forerunner-Client: shell marks a stream that shows notification frames as toasts; ?speech=play marks a stream whose client plays the speak.started utterances)",
} as const;
