import type { ColumnType } from "./db/dialect.ts";
import {
  AGENT_KINDS,
  AGENT_STATUSES,
  BILLING_KINDS,
  BUDGET_SCOPES,
  BUDGET_STATES,
  CHANGE_SCOPES,
  CHANGE_SOURCES,
  COST_KINDS,
  DEVICE_KINDS,
  EXTENSION_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  HUMAN_REQUEST_KINDS,
  HUMAN_REQUEST_STATUSES,
  LESSON_SCOPES,
  LESSON_STATUSES,
  MESSAGE_TYPES,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  QUEUE_KINDS,
  QUEUE_STATUSES,
  RELEASE_STATUSES,
  REMOTE_COMMAND_STATUSES,
  REMOTE_TARGETS,
  REVIEW_VERDICTS,
  RISK_LEVELS,
  RUNNERS,
  SECRET_GRANT_STATUSES,
  SECRET_SCOPES,
  SESSION_STATUSES,
  SESSION_TRIGGERS,
  SOURCE_CANDIDATE_KINDS,
  SOURCE_CANDIDATE_STATUSES,
  SOURCE_KINDS,
  TASK_STATUSES,
  UNDO_STATES,
} from "./types.ts";

/**
 * Declarative schema. This file is the single truth: migration v1 is generated from it
 * (and snapshotted), repositories encode and decode rows from it, and
 * docs/maintainers/data-model.md is rendered from it. Change the schema here, then add a
 * migration (see docs/maintainers/migrations.md); never edit a shipped migration.
 */

export type { ColumnType } from "./db/dialect.ts";

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Literal default, used in the DDL and filled in by Repository.insert when the value is missing. */
  default?: unknown;
  references?: { table: string; column: string };
  description: string;
  /** Allowed values, enforced with a CHECK constraint. */
  enum?: readonly string[];
  /** Extra CHECK expression on this column, e.g. "risk_tier BETWEEN 0 AND 3". */
  check?: string;
}

export interface IndexDef {
  columns: string[];
  unique?: boolean;
  /** Partial index predicate (same syntax in both dialects). */
  where?: string;
}

export interface EntityDef {
  table: string;
  description: string;
  /** Entity-specific columns. The common envelope is prepended by allColumns(). */
  columns: ColumnDef[];
  indexes: IndexDef[];
  /** False only for bookkeeping tables without the record envelope. */
  envelope: boolean;
  /** Primary key column when envelope is false. */
  primaryKey?: string;
  /** Rows can be inserted but never updated or deleted (enforced by triggers). */
  appendOnly?: boolean;
}

type Opts = Partial<Pick<ColumnDef, "nullable" | "default" | "references" | "enum" | "check">>;

function col(type: ColumnType) {
  return (name: string, description: string, opts: Opts = {}): ColumnDef => ({
    name,
    type,
    nullable: opts.nullable ?? false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    ...(opts.references ? { references: opts.references } : {}),
    ...(opts.enum ? { enum: opts.enum } : {}),
    ...(opts.check ? { check: opts.check } : {}),
    description,
  });
}

const text = col("text");
const int = col("int");
const real = col("real");
const bool = col("bool");
const json = col("json");
const ts = col("timestamp");
const money = col("money");

const ref = (table: string) => ({ references: { table, column: "id" } });
const nullableRef = (table: string) => ({ nullable: true, references: { table, column: "id" } });

/** Columns every entity carries, in this order. */
export const COMMON_COLUMNS: readonly ColumnDef[] = [
  text("id", "Application-generated UUIDv7 (time ordered)."),
  ts("created_at", "When the record was created (ISO-8601 UTC)."),
  ts("updated_at", "Last write, from the injected Clock (ISO-8601 UTC)."),
  text("author_agent", "Agent id that made the last change, if an agent.", { nullable: true }),
  text("author_human", "Human id that made the last change, if a human.", { nullable: true }),
  int("version", "Optimistic concurrency counter; every write bumps it.", { default: 1 }),
];

export const ENTITIES: Record<string, EntityDef> = {
  human: {
    table: "human",
    description: "One per person. Owns agents, devices, billing sources and the monthly cap.",
    envelope: true,
    columns: [
      text("name", "Display name."),
      text("email", "Primary email; unique."),
      text("timezone", "IANA time zone for schedules and quiet hours.", { default: "UTC" }),
      json("notify_prefs", "Notification preferences (channels, quiet hours).", { default: {} }),
      int("default_autonomy", "Default autonomy level 0-4 for new projects.", {
        default: 1,
        check: "default_autonomy BETWEEN 0 AND 4",
      }),
      money("monthly_cap_usd_micro", "Hard monthly spending cap in micro-USD.", { default: 0 }),
      text("locale", "UI locale, e.g. de-CH.", { default: "en" }),
    ],
    indexes: [{ columns: ["email"], unique: true }],
  },
  agent: {
    table: "agent",
    description: "Principal, specialist, conversation and critic agents. Peers, no hierarchy.",
    envelope: true,
    columns: [
      text("name", "Agent name (Alice, Bob, ...)."),
      text("owner_human_id", "Human this agent acts for.", ref("human")),
      json("model_config", "Model, effort and provider preferences.", { default: {} }),
      text("memory_location", "Where private memory lives (path or URI).", { default: "" }),
      text("status", "Lifecycle status.", { default: "active", enum: AGENT_STATUSES }),
      text("kind", "Role of the agent.", { default: "principal", enum: AGENT_KINDS }),
    ],
    indexes: [
      { columns: ["owner_human_id"] },
      { columns: ["owner_human_id", "name"], unique: true },
    ],
  },
  project: {
    table: "project",
    description: "A shared unit of work with repos, budget and autonomy. Forerunner itself is one.",
    envelope: true,
    columns: [
      text("name", "Project name; unique."),
      text("goal", "One-paragraph goal.", { default: "" }),
      json("repos", "Repository locators (URLs or paths).", { default: [] }),
      text("stage", "Free-form stage label (idea, build, launch, maintain).", { default: "idea" }),
      text("status", "Lifecycle status.", { default: "active", enum: PROJECT_STATUSES }),
      money("budget_usd_micro", "Project budget cap in micro-USD.", { default: 0 }),
      int("autonomy_level", "Autonomy level 0-4.", {
        default: 1,
        check: "autonomy_level BETWEEN 0 AND 4",
      }),
      json("summary_cache", "Cached state brief for session start.", { default: {} }),
      json("data_assets", "Ids of registered data assets.", { default: [] }),
      json(
        "settings",
        "Per-project knobs: speed_quality_offset, critic_ceiling, escalation caps, reserve share.",
        { default: {} },
      ),
      bool("small_project_mode", "One milestone, flat task list, critic tier 0 by default.", {
        default: false,
      }),
      bool("active", "False when archived or paused for scheduling purposes.", { default: true }),
    ],
    indexes: [{ columns: ["name"], unique: true }, { columns: ["status"] }],
  },
  milestone: {
    table: "milestone",
    description: "Milestones of a project with checkable success criteria.",
    envelope: true,
    columns: [
      text("project_id", "Owning project.", ref("project")),
      text("name", "Milestone name."),
      json("success_criteria", "Checkable statements.", { default: [] }),
      ts("target_date", "Target date, if any.", { nullable: true }),
      text("status", "Lifecycle status.", { default: "planned", enum: MILESTONE_STATUSES }),
      int("order_index", "Display and planning order inside the project.", { default: 0 }),
      text("reason", "Reason for the last change (versioned with author; spec B.5).", {
        default: "",
      }),
    ],
    indexes: [{ columns: ["project_id", "order_index"] }],
  },
  task: {
    table: "task",
    description:
      "A unit of delegated work with outcome, acceptance criteria, risk tier, budget and claim.",
    envelope: true,
    columns: [
      text("project_id", "Owning project.", ref("project")),
      text("milestone_id", "Milestone this task belongs to.", nullableRef("milestone")),
      text("title", "Short title."),
      text("outcome", "What done looks like.", { default: "" }),
      json("acceptance_criteria", "Checkable acceptance criteria.", { default: [] }),
      int("risk_tier", "Risk tier 0-3.", { default: 0, check: "risk_tier BETWEEN 0 AND 3" }),
      text("status", "Workflow status; see the task graph in Invariants.", {
        default: "draft",
        enum: TASK_STATUSES,
      }),
      int("priority", "Higher runs first.", { default: 0 }),
      text("claimed_by", "Agent holding the claim.", nullableRef("agent")),
      ts("claim_expires", "When the claim lapses unless renewed.", { nullable: true }),
      json("depends_on", "Task ids that must be done first.", { default: [] }),
      money("budget_usd_micro", "Cap for this task in micro-USD.", { default: 0 }),
      money("est_cost_usd_micro", "Estimate before the run.", { default: 0 }),
      money("actual_cost_usd_micro", "Recorded after the runs.", { default: 0 }),
      text("owner_agent_id", "Agent responsible for the task.", nullableRef("agent")),
      text("specialist", "Specialist name chosen for the task.", { nullable: true }),
      int("attempt", "Retry counter; failed -> ready increments it.", { default: 0 }),
      text("pr_url", "Pull request URL once opened.", { nullable: true }),
      text("branch", "Working branch name.", { nullable: true }),
      text("reason", "Reason for the last change (versioned with author).", { default: "" }),
    ],
    indexes: [
      { columns: ["project_id", "status"] },
      { columns: ["milestone_id"] },
      { columns: ["claimed_by"] },
      { columns: ["status", "claim_expires"] },
    ],
  },
  session: {
    table: "session",
    description: "One agent session: plan, caps, spend, steps and handoff. Groups runs and events.",
    envelope: true,
    columns: [
      text("agent_id", "Agent running the session.", ref("agent")),
      text("project_id", "Active project, if any.", nullableRef("project")),
      text("trigger", "What started the session.", { default: "manual", enum: SESSION_TRIGGERS }),
      json("plan", "Planned steps.", { default: [] }),
      money("budget_cap_usd_micro", "Session budget cap.", { default: 0 }),
      int("step_cap", "Maximum model calls.", { default: 0 }),
      money("spent_usd_micro", "Spend so far (the ledger is the truth).", { default: 0 }),
      int("steps", "Steps so far.", { default: 0 }),
      ts("started_at", "Start time.", { nullable: true }),
      ts("ended_at", "End time.", { nullable: true }),
      text("status", "Lifecycle status; see the session graph.", {
        default: "planned",
        enum: SESSION_STATUSES,
      }),
      text("summary", "Session summary for humans.", { default: "" }),
      json("handoff", "Handoff note: done, in flight, blocked, next.", { default: {} }),
      text("runner", "Where it ran.", { default: "pc", enum: RUNNERS }),
      text("device_id", "Device that ran it.", nullableRef("device")),
      int("headroom_saved_tokens", "Tokens the Headroom proxy saved during the session.", {
        default: 0,
      }),
      text("reason", "Reason for the last change to the plan (versioned with author; spec B.5).", {
        default: "",
      }),
    ],
    indexes: [{ columns: ["agent_id", "status"] }, { columns: ["project_id"] }],
  },
  event: {
    table: "event",
    description: "Append-only session log entries with a per-session sequence number.",
    envelope: true,
    appendOnly: true,
    columns: [
      text("session_id", "Session the event belongs to.", ref("session")),
      int("seq", "1-based sequence inside the session."),
      text("type", "Event type (tool_call, model_call, note, ...)."),
      json("payload", "Event body; secrets already redacted.", { default: {} }),
      money("cost_usd_micro", "Cost attributed to this event.", { default: 0 }),
      bool("redacted", "True when the payload was redacted on write.", { default: false }),
    ],
    indexes: [{ columns: ["session_id", "seq"], unique: true }],
  },
  message: {
    table: "message",
    description: "Typed messages between agents and humans with delivery receipts.",
    envelope: true,
    columns: [
      text("from_agent_id", "Sending agent.", ref("agent")),
      text("to_agent_id", "Receiving agent, if any.", nullableRef("agent")),
      text("to_human_id", "Receiving human, if any.", nullableRef("human")),
      text("project_id", "Related project.", nullableRef("project")),
      text("task_id", "Related task.", nullableRef("task")),
      text("type", "Message type.", { enum: MESSAGE_TYPES }),
      text("body", "Message body."),
      bool("requires_ack", "Must be acted on; resurfaces until acted_at is set.", {
        default: false,
      }),
      ts("delivered_at", "Delivery receipt.", { nullable: true }),
      ts("read_at", "Read receipt.", { nullable: true }),
      ts("acted_at", "Acted-on receipt.", { nullable: true }),
      text("reply_to", "Message this replies to.", nullableRef("message")),
      text("mirrored_url", "URL of the GitHub mirror comment, if mirrored.", { nullable: true }),
    ],
    indexes: [
      { columns: ["to_agent_id", "read_at"] },
      { columns: ["to_human_id", "read_at"] },
      { columns: ["from_agent_id", "requires_ack", "acted_at"] },
    ],
  },
  decision: {
    table: "decision",
    description: "Answered questions per project so agents do not ask twice.",
    envelope: true,
    columns: [
      text("project_id", "Project the decision belongs to.", ref("project")),
      text("question", "The question as asked."),
      text("question_normalised", "Lower-cased, whitespace-collapsed question for lookups."),
      json("options", "Options that were considered.", { default: [] }),
      text("chosen", "The chosen option."),
      text("decided_by", "Human or agent id that decided."),
      text("rationale", "Why.", { default: "" }),
      text("supersedes", "Older decision this replaces.", nullableRef("decision")),
      text("superseded_by", "Newer decision that replaced this one.", nullableRef("decision")),
    ],
    indexes: [{ columns: ["project_id", "question_normalised"] }],
  },
  human_request: {
    table: "human_request",
    description: "Requests to a human: decisions, credentials, approvals, information.",
    envelope: true,
    columns: [
      text("human_id", "Addressee, if a specific human.", nullableRef("human")),
      text("project_id", "Related project.", nullableRef("project")),
      text("task_id", "Related task.", nullableRef("task")),
      text("session_id", "Session that raised it.", nullableRef("session")),
      text("kind", "What is asked for.", { enum: HUMAN_REQUEST_KINDS }),
      text("why", "Why the agent needs it."),
      json("steps", "Exact steps for the human.", { default: [] }),
      json("options", "Options for a decision.", { default: [] }),
      bool("blocking", "True when work cannot continue without it.", { default: false }),
      json("answer", "The answer, once given.", { nullable: true }),
      ts("answered_at", "When answered.", { nullable: true }),
      text("answered_by", "Human id that answered.", { nullable: true }),
      text("status", "Lifecycle status.", { default: "open", enum: HUMAN_REQUEST_STATUSES }),
      text("risk", "Risk level of what is asked.", { default: "low", enum: RISK_LEVELS }),
      json("change_card", "Change card shown before a change (module Q).", { nullable: true }),
    ],
    indexes: [{ columns: ["status", "blocking"] }, { columns: ["human_id", "status"] }],
  },
  review: {
    table: "review",
    description: "Critic reviews of a task or session with grade, confidence and verdict.",
    envelope: true,
    columns: [
      text("task_id", "Reviewed task.", nullableRef("task")),
      text("session_id", "Reviewed session.", nullableRef("session")),
      text("critic_model", "Model that reviewed."),
      int("tier", "Critic tier.", { default: 0 }),
      int("grade", "Grade 0-100.", { default: 0, check: "grade BETWEEN 0 AND 100" }),
      real("confidence", "Critic confidence 0-1.", { default: 0 }),
      text("verdict", "Review verdict.", { enum: REVIEW_VERDICTS }),
      json("evidence", "Evidence links.", { default: [] }),
      text("summary", "Review summary.", { default: "" }),
    ],
    indexes: [{ columns: ["task_id"] }, { columns: ["session_id"] }],
  },
  finding: {
    table: "finding",
    description: "Individual findings of a review. Open findings block task close.",
    envelope: true,
    columns: [
      text("review_id", "Review that raised it.", ref("review")),
      text("task_id", "Task it applies to.", nullableRef("task")),
      text("severity", "Severity.", { enum: FINDING_SEVERITIES }),
      text("description", "What is wrong."),
      text("required_action", "What must happen to resolve it.", { default: "" }),
      text("status", "Lifecycle status.", { default: "open", enum: FINDING_STATUSES }),
      text("resolved_by_run", "Run that resolved it.", nullableRef("run")),
      text("fingerprint", "Stable hash for repeat detection across sessions.", { default: "" }),
    ],
    indexes: [
      { columns: ["task_id", "status"] },
      { columns: ["review_id"] },
      { columns: ["fingerprint"] },
    ],
  },
  run: {
    table: "run",
    description:
      "One specialist call: model, tokens, cost, timing and outcome. Retries are new runs.",
    envelope: true,
    columns: [
      text("task_id", "Task the run worked on.", nullableRef("task")),
      text("session_id", "Session that made the call.", ref("session")),
      text("specialist", "Specialist name."),
      text("model", "Model id."),
      text("provider", "Provider name.", { default: "" }),
      text("effort", "Effort level.", { default: "" }),
      text("prompt_version", "Prompt version from the registry.", { default: "" }),
      text("billing_source_id", "Billing source charged.", { nullable: true }),
      int("tokens_in", "Input tokens.", { default: 0 }),
      int("tokens_out", "Output tokens.", { default: 0 }),
      int("cache_read_tokens", "Prompt-cache read tokens.", { default: 0 }),
      int("cache_write_tokens", "Prompt-cache write tokens.", { default: 0 }),
      money("cost_usd_micro", "Cost in micro-USD.", { default: 0 }),
      money("cost_chf_micro", "Cost in micro-CHF at the day's rate.", { default: 0 }),
      int("ttft_ms", "Time to first token.", { nullable: true }),
      int("duration_ms", "Wall-clock duration.", { nullable: true }),
      text("outcome", "Outcome label (success, failed, timeout, ...).", { default: "" }),
      json("artifacts", "Produced artifacts (paths, URLs).", { default: [] }),
      int("depth", "Subagent depth; 0 for the principal.", { default: 0 }),
      text("parent_run_id", "Parent run when spawned as a subagent.", nullableRef("run")),
      bool("timed_out", "True when the run hit its time limit.", { default: false }),
      int("tokens_before_compression", "Context size before compression.", { default: 0 }),
      int("tokens_after_compression", "Context size after compression.", { default: 0 }),
      json("context_transforms", "Context transforms applied to tool results (ADR 0003).", {
        default: [],
      }),
      bool("headroom_used", "True when the Headroom proxy served the run's model calls.", {
        default: false,
      }),
    ],
    indexes: [{ columns: ["session_id"] }, { columns: ["task_id"] }],
  },
  lesson: {
    table: "lesson",
    description: "The memory unit in three scopes: agent-private, critic, shared.",
    envelope: true,
    columns: [
      text("scope", "Memory scope; private lessons are only readable by their owner.", {
        enum: LESSON_SCOPES,
      }),
      text("owner_agent_id", "Owner for agent_private lessons.", nullableRef("agent")),
      text("project_id", "Project the lesson is about, if any.", nullableRef("project")),
      text("text", "The lesson."),
      text("source", "Where it came from (session, review, human).", { default: "" }),
      json("tags", "Tags for retrieval.", { default: [] }),
      real("confidence", "Confidence 0-1.", { default: 0.5 }),
      ts("last_used", "Last retrieval.", { nullable: true }),
      int("hit_count", "Times retrieved.", { default: 0 }),
      text("superseded_by", "Newer lesson that replaces this one.", nullableRef("lesson")),
      json("embedding", "Embedding vector for similarity search.", { nullable: true }),
      bool("pinned", "Always loaded.", { default: false }),
      text("status", "Lifecycle status.", { default: "active", enum: LESSON_STATUSES }),
      text("file_path", "Markdown file this lesson is exported to or canonical in.", {
        nullable: true,
      }),
    ],
    indexes: [
      { columns: ["scope", "owner_agent_id"] },
      { columns: ["project_id"] },
      { columns: ["status"] },
    ],
  },
  command: {
    table: "command",
    description: "Registry of typed commands with parameter schema, risk and undo strategy.",
    envelope: true,
    columns: [
      text("name", "Command name, e.g. budget.set; unique."),
      json("parameters_schema", "JSON schema of the parameters.", { default: {} }),
      text("risk", "Risk level that sets the confirmation path.", {
        default: "low",
        enum: RISK_LEVELS,
      }),
      text("undo_strategy", "How the command is undone.", { default: "" }),
      text("description", "What the command does.", { default: "" }),
    ],
    indexes: [{ columns: ["name"], unique: true }],
  },
  change_log: {
    table: "change_log",
    description:
      "Every change made by conversation or UI: who, words used, commands, before/after, undo.",
    envelope: true,
    columns: [
      text("human_id", "Human who asked.", { nullable: true }),
      text("agent_id", "Agent that executed.", { nullable: true }),
      text("words_used", "The words the human used.", { default: "" }),
      json("commands", "Commands run with their parameters.", { default: [] }),
      json("before", "Values before.", { default: {} }),
      json("after", "Values after.", { default: {} }),
      text("scope", "Scope of the change.", { default: "project", enum: CHANGE_SCOPES }),
      text("project_id", "Project the change applies to.", { nullable: true }),
      ts("expires_at", "When a temporary change reverts.", { nullable: true }),
      text("undo_state", "Undo state.", { default: "undoable", enum: UNDO_STATES }),
      ts("undone_at", "When undone.", { nullable: true }),
      text("source", "Channel the change came from.", { default: "ui", enum: CHANGE_SOURCES }),
      text("sentence", "Plain sentence posted to the activity log.", { default: "" }),
    ],
    indexes: [{ columns: ["undo_state", "expires_at"] }, { columns: ["project_id"] }],
  },
  device: {
    table: "device",
    description: "Paired devices with their public keys; revocable at once.",
    envelope: true,
    columns: [
      text("owner_human_id", "Owner.", ref("human")),
      text("name", "Device name."),
      text("platform", "windows, linux, android, web, ..."),
      text("public_key", "Device public key (Ed25519, base64)."),
      text("kind", "Device kind.", { enum: DEVICE_KINDS }),
      ts("last_seen", "Last contact.", { nullable: true }),
      bool("revoked", "True once revoked.", { default: false }),
      ts("revoked_at", "When revoked.", { nullable: true }),
      ts("paired_at", "When paired."),
      text("push_token", "Push notification token.", { nullable: true }),
      text(
        "wrap_public_key",
        "X25519 public key (raw, base64) of the install holding this device's vault; shared secrets are wrapped to it.",
        { nullable: true },
      ),
    ],
    indexes: [
      { columns: ["owner_human_id", "revoked"] },
      { columns: ["public_key"], unique: true },
    ],
  },
  source: {
    table: "source",
    description: "Connected orgs, accounts, git hosts and folders that projects come from.",
    envelope: true,
    columns: [
      text("kind", "Source kind.", { enum: SOURCE_KINDS }),
      text("display_name", "Display name."),
      text("locator", "URL, org/user name or folder path."),
      text("credential_ref", "Secret reference name used to access it.", { nullable: true }),
      ts("last_scan", "Last scan time.", { nullable: true }),
      text("status", "connected, error, scanning, ...", { default: "connected" }),
      json("scan_result", "Last scan result (repos found).", { default: {} }),
    ],
    indexes: [{ columns: ["kind", "locator"], unique: true }],
  },
  source_candidate: {
    table: "source_candidate",
    description:
      "What a scan of a source found: one proposed project per repository or folder, with duplicate and existing-install detection (spec A.4).",
    envelope: true,
    columns: [
      text("source_id", "The source the scan belongs to.", ref("source")),
      text("kind", "Repository on a git host, or a folder.", { enum: SOURCE_CANDIDATE_KINDS }),
      text("name", "Repository or folder name."),
      text(
        "locator",
        "What a project's repos entry carries: owner/name, or the absolute folder path.",
      ),
      text(
        "key",
        "Normalised duplicate key (github:owner/name lower-cased, folder:<path>); unique per source.",
      ),
      text("proposed_name", "Project name a scan proposes."),
      text("status", "proposed, accepted, duplicate or gone.", {
        default: "proposed",
        enum: SOURCE_CANDIDATE_STATUSES,
      }),
      bool("existing_install", "A Forerunner install was detected in it.", { default: false }),
      text(
        "install_marker",
        "What marked the install: the .forerunner/project.json file or the install record.",
        {
          nullable: true,
        },
      ),
      text(
        "project_id",
        "The project this candidate became, or the one it duplicates.",
        nullableRef("project"),
      ),
      bool("is_git", "A git repository (always for a host repo; a folder with .git).", {
        default: true,
      }),
      json("details", "Host facts: url, default branch, private, duplicate_of.", { default: {} }),
      ts("last_seen_at", "Last scan that found it."),
    ],
    indexes: [
      { columns: ["source_id", "key"], unique: true },
      { columns: ["key"] },
      { columns: ["status"] },
    ],
  },
  cost_ledger: {
    table: "cost_ledger",
    description:
      "Every charge: USD and CHF, tokens, and what it was for. The ledger is the truth for caps.",
    envelope: true,
    columns: [
      text("human_id", "Human whose billing paid."),
      text("agent_id", "Agent that spent.", { nullable: true }),
      text("project_id", "Project.", { nullable: true }),
      text("session_id", "Session.", { nullable: true }),
      text("task_id", "Task.", { nullable: true }),
      text("run_id", "Run.", { nullable: true }),
      text("billing_source_id", "Billing source charged.", { nullable: true }),
      text("kind", "Charge kind.", { enum: COST_KINDS }),
      money("usd_micro", "Amount in micro-USD."),
      money("chf_micro", "Amount in micro-CHF at the day's rate.", { default: 0 }),
      real("rate_chf_per_usd", "Exchange rate used.", { default: 0 }),
      real("plan_usage_share", "Share of the plan limit consumed (subscriptions).", {
        nullable: true,
      }),
      text("model", "Model id."),
      text("specialist", "Specialist name, for breakdowns.", { nullable: true }),
      int("tokens_in", "Input tokens.", { default: 0 }),
      int("tokens_out", "Output tokens.", { default: 0 }),
      int("cache_read_tokens", "Prompt-cache read tokens.", { default: 0 }),
      int("cache_write_tokens", "Prompt-cache write tokens.", { default: 0 }),
      ts("occurred_at", "When the charge happened."),
    ],
    indexes: [
      { columns: ["human_id", "occurred_at"] },
      { columns: ["project_id"] },
      { columns: ["session_id"] },
      { columns: ["task_id"] },
      { columns: ["run_id"] },
    ],
  },
  secret_ref: {
    table: "secret_ref",
    description: "Names of secrets in the vault and who may use them. Never the value.",
    envelope: true,
    columns: [
      text("name", "Reference name, e.g. github_pat."),
      text("scope", "Who the secret belongs to.", { enum: SECRET_SCOPES }),
      text("owner_human_id", "Owning human.", ref("human")),
      json("granted_to", "Agent ids allowed to use it.", { default: [] }),
      text("kind", "api_key, token, password, ssh_key, ..."),
      text("created_by", "Human or agent id that created it."),
      ts("last_used", "Last injection into a tool call.", { nullable: true }),
    ],
    indexes: [{ columns: ["owner_human_id", "name"], unique: true }],
  },
  secret_grant: {
    table: "secret_grant",
    description:
      "A shared secret's grant to named agents (spec S.13): who must approve, who did, and the value wrapped per install. Never the value.",
    envelope: true,
    columns: [
      text("name", "Reference name the named agents use, e.g. org_deploy_token."),
      text("owner_human_id", "Human whose vault holds the value.", ref("human")),
      text("kind", "api_key, token, password, ssh_key, ...", { default: "token" }),
      text("why", "Why the owner shares it; shown on the approval card.", { default: "" }),
      json("agent_ids", "Agents that may read it once the grant is active.", { default: [] }),
      json("required_human_ids", "Humans other than the owner whose approval the grant needs.", {
        default: [],
      }),
      json("approvals", "Approvals given: human id -> { at, request_id }.", { default: {} }),
      json("request_ids", "Approval requests opened for the required humans.", { default: [] }),
      json(
        "blobs",
        "Per (agent, device): the value wrapped to that install's key. Ciphertext only; emptied when the grant ends.",
        { default: [] },
      ),
      text("status", "Lifecycle status.", { default: "pending", enum: SECRET_GRANT_STATUSES }),
      ts("activated_at", "When the last required approval arrived.", { nullable: true }),
      ts("last_served", "Last time a wrapped blob was served to an install.", { nullable: true }),
      ts("ended_at", "When the grant was cancelled or revoked.", { nullable: true }),
      text("ended_reason", "Why it ended.", { nullable: true }),
    ],
    indexes: [{ columns: ["owner_human_id", "name"] }, { columns: ["status"] }],
  },
  extension: {
    table: "extension",
    description: "Connectors, MCP servers, skills, specialists, capabilities and providers.",
    envelope: true,
    columns: [
      text("kind", "Extension kind.", { enum: EXTENSION_KINDS }),
      text("name", "Name; unique per kind."),
      text("ext_version", "Installed version of the extension.", { default: "" }),
      bool("enabled", "Enabled flag.", { default: false }),
      json("permissions", "Granted scopes shown in the Extensions panel.", { default: [] }),
      money("cost_usd_micro", "Cost attributed so far.", { default: 0 }),
      text("source_url", "Where it was installed from.", { nullable: true }),
      text("status", "installed, error, updating, ...", { default: "installed" }),
      json("config", "Extension configuration (no secrets).", { default: {} }),
    ],
    indexes: [{ columns: ["kind", "name"], unique: true }],
  },
  data_asset: {
    table: "data_asset",
    description: "Large datasets registered where they sit, by path or URI.",
    envelope: true,
    columns: [
      json("project_ids", "Projects that use it.", { default: [] }),
      text("locator", "Path or URI."),
      int("size_bytes", "Size in bytes.", { default: 0 }),
      text("owner_device_id", "Device that holds it.", nullableRef("device")),
      text("kind", "csv, parquet, folder, database, ..."),
      json("sample", "Small sample or schema summary.", { nullable: true }),
      text("registered_by", "Human or agent id."),
    ],
    indexes: [{ columns: ["locator"] }],
  },
  release: {
    table: "release",
    description: "Forerunner releases: version, channel, signature, rollout status and health.",
    envelope: true,
    columns: [
      text(
        "release_version",
        "Semantic version of the release (the envelope's version is the row counter).",
      ),
      text("channel", "stable, beta, canary."),
      text("changelog", "Changelog text.", { default: "" }),
      text("signature", "Detached signature of the artifacts.", { default: "" }),
      text("status", "Rollout status.", { default: "draft", enum: RELEASE_STATUSES }),
      json("artifacts", "Artifact names, hashes and URLs per platform.", { default: [] }),
      ts("published_at", "When published.", { nullable: true }),
      json("health", "Health signals after install.", { nullable: true }),
    ],
    indexes: [{ columns: ["channel", "release_version"], unique: true }],
  },
  audit_log: {
    table: "audit_log",
    description:
      "Append-only record of every tool call: who, what, when, cost, result. Exportable.",
    envelope: true,
    appendOnly: true,
    columns: [
      text("session_id", "Session.", { nullable: true }),
      text("run_id", "Run.", { nullable: true }),
      text("agent_id", "Agent.", { nullable: true }),
      text("human_id", "Human on whose behalf.", { nullable: true }),
      text("tool", "Tool name."),
      text("input_summary", "Redacted summary of the input.", { default: "" }),
      text("result_summary", "Redacted summary of the result.", { default: "" }),
      bool("allowed", "Whether the hook allowed the call."),
      text("denied_reason", "Why it was denied.", { nullable: true }),
      money("cost_usd_micro", "Cost of the call.", { default: 0 }),
      ts("occurred_at", "When the call happened."),
      text("token_id", "Capability token used.", { nullable: true }),
    ],
    indexes: [{ columns: ["session_id", "occurred_at"] }, { columns: ["occurred_at"] }],
  },
  queue_item: {
    table: "queue_item",
    description: "Notes, tasks, corrections and ideas queued for the next session.",
    envelope: true,
    columns: [
      text("project_id", "Project.", ref("project")),
      text("human_id", "Who queued it.", ref("human")),
      text("kind", "Item kind.", { enum: QUEUE_KINDS }),
      text("text", "The note or request."),
      int("priority", "Higher first.", { default: 0 }),
      text("status", "Lifecycle status.", { default: "queued", enum: QUEUE_STATUSES }),
      text("consumed_by_session", "Session that picked it up.", nullableRef("session")),
      text("transcript", "Voice note transcript.", { nullable: true }),
    ],
    indexes: [{ columns: ["project_id", "status", "priority"] }],
  },
  remote_command: {
    table: "remote_command",
    description:
      "Commands from a phone or web client to a PC or cloud runner; picked up atomically.",
    envelope: true,
    columns: [
      text("device_id", "Device that issued it.", ref("device")),
      text("target", "Where it should run.", { enum: REMOTE_TARGETS }),
      text("target_device_id", "Specific target device, if any.", nullableRef("device")),
      text("command", "Command name (session.start, session.stop, ...)."),
      json("params", "Command parameters.", { default: {} }),
      text("status", "Lifecycle status.", { default: "pending", enum: REMOTE_COMMAND_STATUSES }),
      ts("picked_up_at", "When a runner took it.", { nullable: true }),
      json("result", "Result or error.", { nullable: true }),
    ],
    indexes: [{ columns: ["status", "target", "created_at"] }],
  },
  billing_source: {
    table: "billing_source",
    description: "How a human pays: subscription, plan credits, API key or the fake provider.",
    envelope: true,
    columns: [
      text("human_id", "Owner.", ref("human")),
      text("kind", "Billing kind.", { enum: BILLING_KINDS }),
      text("label", "Display label."),
      text("credential_ref", "Secret reference used to authenticate.", { nullable: true }),
      json("limits", "Plan limits and reset rules.", { default: {} }),
      bool("enabled", "Enabled flag.", { default: true }),
      int("priority", "Routing priority; lower first.", { default: 100 }),
    ],
    indexes: [{ columns: ["human_id", "enabled", "priority"] }],
  },
  budget_window: {
    table: "budget_window",
    description: "Fast cap checks per scope and period. The cost ledger stays the truth.",
    envelope: true,
    columns: [
      text("scope", "Cap scope.", { enum: BUDGET_SCOPES }),
      text("scope_id", "Id of the human (month), project, session or task."),
      ts("period_start", "Window start."),
      ts("period_end", "Window end (exclusive)."),
      money("cap_usd_micro", "Cap in micro-USD."),
      money("spent_usd_micro", "Spend recorded in the window.", { default: 0 }),
      text("state", "ok below 80%, warn80 at 80%, stopped at 100%.", {
        default: "ok",
        enum: BUDGET_STATES,
      }),
    ],
    indexes: [{ columns: ["scope", "scope_id", "period_start"], unique: true }],
  },
  schema_migrations: {
    table: "schema_migrations",
    description: "Applied schema migrations.",
    envelope: false,
    primaryKey: "version",
    columns: [
      int("version", "Migration version (primary key)."),
      text("name", "Migration name."),
      ts("applied_at", "When it was applied."),
    ],
    indexes: [],
  },
};

/** All columns of an entity including the envelope, in DDL order. */
export function allColumns(entity: EntityDef): ColumnDef[] {
  return entity.envelope ? [...COMMON_COLUMNS, ...entity.columns] : [...entity.columns];
}

export function entityFor(table: string): EntityDef {
  const e = ENTITIES[table];
  if (!e) throw new Error(`unknown entity: ${table}`);
  return e;
}

export function primaryKeyOf(entity: EntityDef): string {
  return entity.envelope ? "id" : (entity.primaryKey ?? "id");
}

/**
 * Table names in dependency order (parents before children). Stable topological sort over
 * foreign keys: declared order is kept wherever dependencies allow; self references are
 * ignored; a cycle or a dangling reference throws.
 */
export function tableOrder(entities: Record<string, EntityDef> = ENTITIES): string[] {
  const byTable = new Map<string, EntityDef>();
  for (const e of Object.values(entities)) byTable.set(e.table, e);
  const remaining = Object.values(entities).map((e) => e.table);
  const done = new Set<string>();
  const order: string[] = [];
  while (remaining.length > 0) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const table = remaining[i] as string;
      const entity = byTable.get(table) as EntityDef;
      const deps = entity.columns
        .map((c) => c.references?.table)
        .filter((t): t is string => t !== undefined && t !== table);
      for (const dep of deps) {
        if (!byTable.has(dep)) throw new Error(`schema: ${table} references unknown table ${dep}`);
      }
      if (deps.every((d) => done.has(d))) {
        order.push(table);
        done.add(table);
        remaining.splice(i, 1);
        progressed = true;
        i -= 1;
      }
    }
    if (!progressed) throw new Error(`schema: reference cycle among ${remaining.join(", ")}`);
  }
  return order;
}
