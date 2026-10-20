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

export const ChatReplyView = z.object({
  reply: z.string(),
  actions: z.array(z.object({ kind: z.string(), summary: z.string(), id: z.string().optional() })),
  pendingConfirmation: z
    .object({ id: z.string(), readback: z.string(), estimate: Money })
    .nullable(),
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
});
export type HealthView = z.infer<typeof HealthView>;

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
  markRead: "POST /messages/:id/read",
  chat: "POST /chat (JSON) | POST /chat/stream (SSE tokens then a final reply event)",
  costs: "GET /costs?projectId=&from=&to=",
  settings: "GET /settings?scope=&scopeId=",
  events:
    "GET /events (SSE: session.event, inbox.changed, session.changed, project.changed, heartbeat)",
} as const;
