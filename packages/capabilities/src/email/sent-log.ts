/**
 * Every outward email action is an audit row (S.9, S.26, T.14). The sent log is the subset of
 * `audit_log` rows with tool "email.send" and allowed = true: one row per sent email with the
 * full (redacted) copy in input_summary as JSON and the delivery result in result_summary.
 * Caps count these rows per local day; thread detection matches In-Reply-To/References against
 * their Message-IDs; approval replies find their ticket through `approvalRequestId`. ADR 0013
 * records why no new table was added.
 */
import { type Clock, redact } from "@forerunner/platform";
import type { AuditLogRepo, AuditLogRow, JsonObject } from "@forerunner/state";
import type { EmailDraft, EmailMode } from "./types.ts";

export const EMAIL_SEND_TOOL = "email.send";
export const EMAIL_DRAFT_TOOL = "email.draft";
export const EMAIL_QUEUED_TOOL = "email.queued";
export const EMAIL_COMMAND_TOOL = "email.command";
export const EMAIL_INBOUND_FLAGGED_TOOL = "email.inbound_flagged";
export const EMAIL_SETTINGS_TOOL = "email.settings";

export type SentKind = "send" | "reply" | "ack" | "completion" | "approval_request" | "digest";

export interface SentLogEntry {
  kind: SentKind;
  messageId: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The full body as sent (signature included), redacted. */
  text: string;
  inReplyTo: string | null;
  references: string[];
  mode: EmailMode;
  signature: boolean;
  projectId?: string;
  taskId?: string;
  approvalRequestId?: string;
  /** True when every recipient is the registered human. */
  toHuman: boolean;
}

export interface SentLogContext {
  agentId: string;
  humanId: string;
  sessionId?: string;
  runId?: string;
}

export interface SentLogRow extends SentLogEntry {
  id: string;
  agentId: string | null;
  humanId: string | null;
  sessionId: string | null;
  sentAt: string;
}

export interface SentLog {
  record(ctx: SentLogContext, entry: SentLogEntry): Promise<SentLogRow>;
  /** Sent rows of an agent since an ISO instant, oldest first. */
  recent(agentId: string, sinceIso: string, limit?: number): Promise<SentLogRow[]>;
  /** Message-IDs the agent sent since an ISO instant (thread detection). */
  threadIds(agentId: string, sinceIso: string): Promise<Set<string>>;
  byMessageId(
    agentId: string,
    messageId: string,
    sinceIso: string,
  ): Promise<SentLogRow | undefined>;
  /** A refused, blocked or failed send: an audit row with allowed = false. */
  recordBlocked(
    ctx: SentLogContext,
    draft: EmailDraft,
    reason: string,
    details?: JsonObject,
  ): Promise<void>;
  /** A draft saved or a send queued while paused: an audit row under its own tool name. */
  recordOther(
    ctx: SentLogContext,
    tool: typeof EMAIL_DRAFT_TOOL | typeof EMAIL_QUEUED_TOOL,
    draft: EmailDraft,
    result: JsonObject,
  ): Promise<string>;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function sentRowFromAudit(row: AuditLogRow): SentLogRow | null {
  if (row.tool !== EMAIL_SEND_TOOL || !row.allowed) return null;
  const input = parseJson(row.input_summary);
  if (!input || typeof input.messageId !== "string") return null;
  const kind = input.kind;
  return {
    id: row.id,
    agentId: row.agent_id,
    humanId: row.human_id,
    sessionId: row.session_id,
    sentAt: row.occurred_at,
    kind: (typeof kind === "string" ? kind : "send") as SentKind,
    messageId: input.messageId,
    to: strings(input.to),
    cc: strings(input.cc),
    subject: typeof input.subject === "string" ? input.subject : "",
    text: typeof input.text === "string" ? input.text : "",
    inReplyTo: typeof input.inReplyTo === "string" ? input.inReplyTo : null,
    references: strings(input.references),
    mode: (typeof input.mode === "string" ? input.mode : "off") as EmailMode,
    signature: input.signature === true,
    toHuman: input.toHuman === true,
    ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
    ...(typeof input.approvalRequestId === "string"
      ? { approvalRequestId: input.approvalRequestId }
      : {}),
  };
}

export function draftSummary(draft: EmailDraft): JsonObject {
  return {
    to: draft.to,
    cc: draft.cc ?? [],
    subject: draft.subject,
    text: redact(draft.text),
    inReplyTo: draft.inReplyTo ?? null,
  };
}

export class AuditSentLog implements SentLog {
  constructor(
    private readonly audit: AuditLogRepo,
    private readonly clock: Clock,
  ) {}

  async record(ctx: SentLogContext, entry: SentLogEntry): Promise<SentLogRow> {
    const input: JsonObject = {
      kind: entry.kind,
      messageId: entry.messageId,
      to: entry.to,
      cc: entry.cc,
      subject: entry.subject,
      text: redact(entry.text),
      inReplyTo: entry.inReplyTo,
      references: entry.references,
      mode: entry.mode,
      signature: entry.signature,
      toHuman: entry.toHuman,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.approvalRequestId ? { approvalRequestId: entry.approvalRequestId } : {}),
    };
    const row = await this.audit.append({
      tool: EMAIL_SEND_TOOL,
      allowed: true,
      agent_id: ctx.agentId,
      human_id: ctx.humanId,
      session_id: ctx.sessionId ?? null,
      run_id: ctx.runId ?? null,
      input_summary: JSON.stringify(input),
      result_summary: JSON.stringify({ status: "sent", messageId: entry.messageId }),
      cost_usd_micro: 0,
      occurred_at: this.clock.nowIso(),
      author_agent: ctx.agentId,
    });
    const parsed = sentRowFromAudit(row);
    if (!parsed) throw new Error("sent log row did not round-trip");
    return parsed;
  }

  async recent(agentId: string, sinceIso: string, limit?: number): Promise<SentLogRow[]> {
    const rows = await this.audit.list(
      { agentId, tool: EMAIL_SEND_TOOL, allowed: true, from: sinceIso },
      limit !== undefined ? { limit } : {},
    );
    return rows.map(sentRowFromAudit).filter((r): r is SentLogRow => r !== null);
  }

  async threadIds(agentId: string, sinceIso: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const row of await this.recent(agentId, sinceIso)) out.add(row.messageId);
    return out;
  }

  async byMessageId(
    agentId: string,
    messageId: string,
    sinceIso: string,
  ): Promise<SentLogRow | undefined> {
    const rows = await this.recent(agentId, sinceIso);
    return rows.find((r) => r.messageId === messageId);
  }

  async recordBlocked(
    ctx: SentLogContext,
    draft: EmailDraft,
    reason: string,
    details: JsonObject = {},
  ): Promise<void> {
    await this.audit.append({
      tool: EMAIL_SEND_TOOL,
      allowed: false,
      denied_reason: redact(reason),
      agent_id: ctx.agentId,
      human_id: ctx.humanId,
      session_id: ctx.sessionId ?? null,
      run_id: ctx.runId ?? null,
      input_summary: JSON.stringify(draftSummary(draft)),
      result_summary: JSON.stringify({ status: "blocked", reason: redact(reason), ...details }),
      cost_usd_micro: 0,
      occurred_at: this.clock.nowIso(),
      author_agent: ctx.agentId,
    });
  }

  async recordOther(
    ctx: SentLogContext,
    tool: typeof EMAIL_DRAFT_TOOL | typeof EMAIL_QUEUED_TOOL,
    draft: EmailDraft,
    result: JsonObject,
  ): Promise<string> {
    const row = await this.audit.append({
      tool,
      allowed: true,
      agent_id: ctx.agentId,
      human_id: ctx.humanId,
      session_id: ctx.sessionId ?? null,
      run_id: ctx.runId ?? null,
      input_summary: JSON.stringify(draftSummary(draft)),
      result_summary: JSON.stringify(result),
      cost_usd_micro: 0,
      occurred_at: this.clock.nowIso(),
      author_agent: ctx.agentId,
    });
    return row.id;
  }
}

/** In-memory sent log for unit tests of callers that do not need the store. */
export class MemorySentLog implements SentLog {
  readonly rows: SentLogRow[] = [];
  readonly blocked: Array<{ draft: EmailDraft; reason: string }> = [];
  readonly other: Array<{ tool: string; draft: EmailDraft; result: JsonObject }> = [];
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  async record(ctx: SentLogContext, entry: SentLogEntry): Promise<SentLogRow> {
    const row: SentLogRow = {
      ...entry,
      id: `sent-${++this.seq}`,
      agentId: ctx.agentId,
      humanId: ctx.humanId,
      sessionId: ctx.sessionId ?? null,
      sentAt: this.clock.nowIso(),
    };
    this.rows.push(row);
    return row;
  }
  async recent(agentId: string, sinceIso: string, limit?: number): Promise<SentLogRow[]> {
    const rows = this.rows.filter((r) => r.agentId === agentId && r.sentAt >= sinceIso);
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }
  async threadIds(agentId: string, sinceIso: string): Promise<Set<string>> {
    return new Set((await this.recent(agentId, sinceIso)).map((r) => r.messageId));
  }
  async byMessageId(agentId: string, messageId: string, sinceIso: string) {
    return (await this.recent(agentId, sinceIso)).find((r) => r.messageId === messageId);
  }
  async recordBlocked(_ctx: SentLogContext, draft: EmailDraft, reason: string): Promise<void> {
    this.blocked.push({ draft, reason });
  }
  async recordOther(
    _ctx: SentLogContext,
    tool: typeof EMAIL_DRAFT_TOOL | typeof EMAIL_QUEUED_TOOL,
    draft: EmailDraft,
    result: JsonObject,
  ): Promise<string> {
    this.other.push({ tool, draft, result });
    return `other-${this.other.length}`;
  }
}
