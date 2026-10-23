/**
 * Row types and enums for every table. The declarative schema in schema.ts references the
 * enum arrays below so CHECK constraints, TypeScript unions and the generated doc agree.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Columns every record carries. */
export interface BaseRow {
  id: string;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC, set from the Clock on every write. */
  updated_at: string;
  author_agent: string | null;
  author_human: string | null;
  /** Optimistic concurrency: bumped on every write. */
  version: number;
}

/** Input for an insert: required keys, everything else optional; the envelope is filled in. */
export type New<T extends BaseRow, Required extends keyof T = never> = Pick<T, Required> &
  Partial<Omit<T, Required | "created_at" | "updated_at" | "version">> & {
    created_at?: string;
  };

export const AGENT_KINDS = ["principal", "specialist", "conversation", "critic"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_STATUSES = ["active", "paused", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PROJECT_STATUSES = ["active", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const TASK_STATUSES = [
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "in_review",
  "needs_human",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SESSION_TRIGGERS = [
  "manual",
  "schedule",
  "message",
  "ci",
  "pr_comment",
  "email",
  "budget_reset",
  "remote",
] as const;
export type SessionTrigger = (typeof SESSION_TRIGGERS)[number];
export const SESSION_STATUSES = [
  "planned",
  "running",
  "paused",
  "stopped",
  "completed",
  "failed",
  "killed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const RUNNERS = ["pc", "cloud"] as const;
export type Runner = (typeof RUNNERS)[number];

export const MESSAGE_TYPES = [
  "info",
  "question",
  "request",
  "warning",
  "decision",
  "handoff",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const HUMAN_REQUEST_KINDS = ["decision", "credential", "approval", "info"] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];
export const HUMAN_REQUEST_STATUSES = ["open", "answered", "expired", "withdrawn"] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const REVIEW_VERDICTS = ["accept", "revise", "escalate", "human"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_STATUSES = ["open", "resolved", "wontfix", "pattern"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const LESSON_SCOPES = ["agent_private", "critic", "shared"] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];
export const LESSON_STATUSES = ["active", "retired", "proposed"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const CHANGE_SCOPES = ["session", "project", "global"] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];
export const UNDO_STATES = ["undoable", "undone", "expired", "irreversible"] as const;
export type UndoState = (typeof UNDO_STATES)[number];
export const CHANGE_SOURCES = ["ui", "chat", "voice", "email", "api", "palette"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const DEVICE_KINDS = ["desktop", "phone", "runner", "web"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const SOURCE_KINDS = [
  "github_org",
  "github_user",
  "github_repo",
  "gitlab",
  "git_remote",
  "local_folder",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What a scan of a source proposes a project for: a repository on a git host or a folder. */
export const SOURCE_CANDIDATE_KINDS = ["repo", "folder"] as const;
export type SourceCandidateKind = (typeof SOURCE_CANDIDATE_KINDS)[number];

/**
 * proposed: a project can be created from it; accepted: it was (project_id names it);
 * duplicate: an existing project or another source's candidate already covers it, never
 * proposed; gone: a rescan no longer found it (back to proposed when it reappears).
 */
export const SOURCE_CANDIDATE_STATUSES = ["proposed", "accepted", "duplicate", "gone"] as const;
export type SourceCandidateStatus = (typeof SOURCE_CANDIDATE_STATUSES)[number];

export const COST_KINDS = ["api", "subscription", "plan_credits"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const SECRET_SCOPES = ["human", "agent", "project", "shared"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export const EXTENSION_KINDS = [
  "connector",
  "mcp_server",
  "skill",
  "specialist",
  "capability",
  "model_provider",
  "voice_provider",
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const RELEASE_STATUSES = [
  "draft",
  "published",
  "installed",
  "rolled_back",
  "failed",
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const QUEUE_KINDS = ["note", "task", "correction", "idea", "voice_note"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];
export const QUEUE_STATUSES = ["queued", "consumed", "dismissed"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const REMOTE_TARGETS = ["pc", "cloud"] as const;
export type RemoteTarget = (typeof REMOTE_TARGETS)[number];
export const REMOTE_COMMAND_STATUSES = ["pending", "picked_up", "done", "failed"] as const;
export type RemoteCommandStatus = (typeof REMOTE_COMMAND_STATUSES)[number];

export const BILLING_KINDS = ["subscription", "plan_credits", "api_key", "fake"] as const;
export type BillingKind = (typeof BILLING_KINDS)[number];

export const BUDGET_SCOPES = ["month", "project", "session", "task"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];
export const BUDGET_STATES = ["ok", "warn80", "stopped"] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

export interface HumanRow extends BaseRow {
  name: string;
  email: string;
  timezone: string;
  notify_prefs: JsonObject;
  default_autonomy: number;
  monthly_cap_usd_micro: number;
  locale: string;
}
export type NewHuman = New<HumanRow, "name" | "email">;

export interface AgentRow extends BaseRow {
  name: string;
  owner_human_id: string;
  model_config: JsonObject;
  memory_location: string;
  status: AgentStatus;
  kind: AgentKind;
}
export type NewAgent = New<AgentRow, "name" | "owner_human_id">;

export interface ProjectRow extends BaseRow {
  name: string;
  goal: string;
  repos: string[];
  stage: string;
  status: ProjectStatus;
  budget_usd_micro: number;
  autonomy_level: number;
  summary_cache: JsonObject;
  data_assets: string[];
  /** speed_quality_offset, critic_ceiling, escalation caps and other per-project knobs. */
  settings: JsonObject;
  small_project_mode: boolean;
  active: boolean;
}
export type NewProject = New<ProjectRow, "name">;

export interface MilestoneRow extends BaseRow {
  project_id: string;
  name: string;
  success_criteria: string[];
  target_date: string | null;
  status: MilestoneStatus;
  order_index: number;
}
export type NewMilestone = New<MilestoneRow, "project_id" | "name">;

export interface TaskRow extends BaseRow {
  project_id: string;
  milestone_id: string | null;
  title: string;
  outcome: string;
  acceptance_criteria: string[];
  risk_tier: number;
  status: TaskStatus;
  priority: number;
  claimed_by: string | null;
  claim_expires: string | null;
  depends_on: string[];
  budget_usd_micro: number;
  est_cost_usd_micro: number;
  actual_cost_usd_micro: number;
  owner_agent_id: string | null;
  specialist: string | null;
  attempt: number;
  pr_url: string | null;
  branch: string | null;
  reason: string;
}
export type NewTask = New<TaskRow, "project_id" | "title">;

export interface RunRow extends BaseRow {
  task_id: string | null;
  session_id: string;
  specialist: string;
  model: string;
  provider: string;
  effort: string;
  prompt_version: string;
  billing_source_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micro: number;
  cost_chf_micro: number;
  ttft_ms: number | null;
  duration_ms: number | null;
  outcome: string;
  artifacts: JsonValue[];
  depth: number;
  parent_run_id: string | null;
  timed_out: boolean;
  tokens_before_compression: number;
  tokens_after_compression: number;
  /** Names of the context transforms applied to this run's tool results (ADR 0003). */
  context_transforms: string[];
  headroom_used: boolean;
}
export type NewRun = New<RunRow, "session_id" | "specialist" | "model">;

export interface SessionRow extends BaseRow {
  agent_id: string;
  project_id: string | null;
  trigger: SessionTrigger;
  plan: JsonValue;
  budget_cap_usd_micro: number;
  step_cap: number;
  spent_usd_micro: number;
  steps: number;
  started_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  summary: string;
  handoff: JsonValue;
  runner: Runner;
  device_id: string | null;
  /** Headroom proxy `/stats` tokens_saved delta between session start and end (ADR 0003). */
  headroom_saved_tokens: number;
}
export type NewSession = New<SessionRow, "agent_id">;

export interface EventRow extends BaseRow {
  session_id: string;
  seq: number;
  type: string;
  payload: JsonValue;
  cost_usd_micro: number;
  redacted: boolean;
}

export interface MessageRow extends BaseRow {
  from_agent_id: string;
  to_agent_id: string | null;
  to_human_id: string | null;
  project_id: string | null;
  task_id: string | null;
  type: MessageType;
  body: string;
  requires_ack: boolean;
  delivered_at: string | null;
  read_at: string | null;
  acted_at: string | null;
  reply_to: string | null;
  mirrored_url: string | null;
}
export type NewMessage = New<MessageRow, "from_agent_id" | "type" | "body">;

export interface DecisionRow extends BaseRow {
  project_id: string;
  question: string;
  /** Lower-cased, whitespace-collapsed question used for lookups. */
  question_normalised: string;
  options: JsonValue[];
  chosen: string;
  decided_by: string;
  rationale: string;
  supersedes: string | null;
  superseded_by: string | null;
}
export type NewDecision = New<DecisionRow, "project_id" | "question" | "chosen" | "decided_by">;

export interface HumanRequestRow extends BaseRow {
  human_id: string | null;
  project_id: string | null;
  task_id: string | null;
  session_id: string | null;
  kind: HumanRequestKind;
  why: string;
  steps: string[];
  options: JsonValue[];
  blocking: boolean;
  answer: JsonValue | null;
  answered_at: string | null;
  answered_by: string | null;
  status: HumanRequestStatus;
  risk: RiskLevel;
  change_card: JsonObject | null;
}
export type NewHumanRequest = New<HumanRequestRow, "kind" | "why">;

export interface ReviewRow extends BaseRow {
  task_id: string | null;
  session_id: string | null;
  critic_model: string;
  tier: number;
  grade: number;
  confidence: number;
  verdict: ReviewVerdict;
  evidence: JsonValue[];
  summary: string;
}
export type NewReview = New<ReviewRow, "critic_model" | "verdict">;

export interface FindingRow extends BaseRow {
  review_id: string;
  task_id: string | null;
  severity: FindingSeverity;
  description: string;
  required_action: string;
  status: FindingStatus;
  resolved_by_run: string | null;
  fingerprint: string;
}
export type NewFinding = New<FindingRow, "review_id" | "severity" | "description">;

export interface LessonRow extends BaseRow {
  scope: LessonScope;
  owner_agent_id: string | null;
  project_id: string | null;
  text: string;
  source: string;
  tags: string[];
  confidence: number;
  last_used: string | null;
  hit_count: number;
  superseded_by: string | null;
  embedding: number[] | null;
  pinned: boolean;
  status: LessonStatus;
  file_path: string | null;
}
export type NewLesson = New<LessonRow, "scope" | "text">;

export interface CommandRow extends BaseRow {
  name: string;
  parameters_schema: JsonObject;
  risk: RiskLevel;
  undo_strategy: string;
  description: string;
}
export type NewCommand = New<CommandRow, "name">;

export interface ChangeLogRow extends BaseRow {
  human_id: string | null;
  agent_id: string | null;
  words_used: string;
  commands: JsonValue[];
  before: JsonValue;
  after: JsonValue;
  scope: ChangeScope;
  project_id: string | null;
  expires_at: string | null;
  undo_state: UndoState;
  undone_at: string | null;
  source: ChangeSource;
  sentence: string;
}
export type NewChangeLog = New<ChangeLogRow, "commands" | "scope" | "source" | "sentence">;

export interface DeviceRow extends BaseRow {
  owner_human_id: string;
  name: string;
  platform: string;
  public_key: string;
  kind: DeviceKind;
  last_seen: string | null;
  revoked: boolean;
  revoked_at: string | null;
  paired_at: string;
  push_token: string | null;
}
export type NewDevice = New<
  DeviceRow,
  "owner_human_id" | "name" | "platform" | "public_key" | "kind"
>;

export interface SourceRow extends BaseRow {
  kind: SourceKind;
  display_name: string;
  locator: string;
  credential_ref: string | null;
  last_scan: string | null;
  status: string;
  scan_result: JsonValue;
}
export type NewSource = New<SourceRow, "kind" | "display_name" | "locator">;

export interface SourceCandidateRow extends BaseRow {
  source_id: string;
  kind: SourceCandidateKind;
  name: string;
  locator: string;
  key: string;
  proposed_name: string;
  status: SourceCandidateStatus;
  existing_install: boolean;
  install_marker: string | null;
  project_id: string | null;
  is_git: boolean;
  details: JsonValue;
  last_seen_at: string;
}
export type NewSourceCandidate = New<
  SourceCandidateRow,
  "source_id" | "kind" | "name" | "locator" | "key" | "proposed_name" | "last_seen_at"
>;

export interface CostLedgerRow extends BaseRow {
  human_id: string;
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  billing_source_id: string | null;
  kind: CostKind;
  usd_micro: number;
  chf_micro: number;
  rate_chf_per_usd: number;
  plan_usage_share: number | null;
  model: string;
  specialist: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  occurred_at: string;
}
export type NewCostLedger = New<CostLedgerRow, "human_id" | "kind" | "usd_micro" | "model">;

export interface SecretRefRow extends BaseRow {
  name: string;
  scope: SecretScope;
  owner_human_id: string;
  granted_to: string[];
  kind: string;
  created_by: string;
  last_used: string | null;
}
export type NewSecretRef = New<
  SecretRefRow,
  "name" | "scope" | "owner_human_id" | "kind" | "created_by"
>;

export interface ExtensionRow extends BaseRow {
  kind: ExtensionKind;
  name: string;
  version: number;
  ext_version: string;
  enabled: boolean;
  permissions: JsonValue;
  cost_usd_micro: number;
  source_url: string | null;
  status: string;
  config: JsonObject;
}
export type NewExtension = New<ExtensionRow, "kind" | "name">;

export interface DataAssetRow extends BaseRow {
  project_ids: string[];
  locator: string;
  size_bytes: number;
  owner_device_id: string | null;
  kind: string;
  sample: JsonValue | null;
  registered_by: string;
}
export type NewDataAsset = New<DataAssetRow, "locator" | "kind" | "registered_by">;

export interface ReleaseRow extends BaseRow {
  release_version: string;
  channel: string;
  changelog: string;
  signature: string;
  status: ReleaseStatus;
  artifacts: JsonValue[];
  published_at: string | null;
  health: JsonValue | null;
}
export type NewRelease = New<ReleaseRow, "release_version" | "channel">;

export interface AuditLogRow extends BaseRow {
  session_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  human_id: string | null;
  tool: string;
  input_summary: string;
  result_summary: string;
  allowed: boolean;
  denied_reason: string | null;
  cost_usd_micro: number;
  occurred_at: string;
  token_id: string | null;
}
export type NewAuditLog = New<AuditLogRow, "tool" | "allowed">;

export interface QueueItemRow extends BaseRow {
  project_id: string;
  human_id: string;
  kind: QueueKind;
  text: string;
  priority: number;
  status: QueueStatus;
  consumed_by_session: string | null;
  transcript: string | null;
}
export type NewQueueItem = New<QueueItemRow, "project_id" | "human_id" | "kind" | "text">;

export interface RemoteCommandRow extends BaseRow {
  device_id: string;
  target: RemoteTarget;
  target_device_id: string | null;
  command: string;
  params: JsonObject;
  status: RemoteCommandStatus;
  picked_up_at: string | null;
  result: JsonValue | null;
}
export type NewRemoteCommand = New<RemoteCommandRow, "device_id" | "target" | "command">;

export interface BillingSourceRow extends BaseRow {
  human_id: string;
  kind: BillingKind;
  label: string;
  credential_ref: string | null;
  limits: JsonObject;
  enabled: boolean;
  priority: number;
}
export type NewBillingSource = New<BillingSourceRow, "human_id" | "kind" | "label">;

export interface BudgetWindowRow extends BaseRow {
  scope: BudgetScope;
  scope_id: string;
  period_start: string;
  period_end: string;
  cap_usd_micro: number;
  spent_usd_micro: number;
  state: BudgetState;
}
export type NewBudgetWindow = New<
  BudgetWindowRow,
  "scope" | "scope_id" | "period_start" | "period_end" | "cap_usd_micro"
>;

export interface SchemaMigrationRow {
  version: number;
  name: string;
  applied_at: string;
}
