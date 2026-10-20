/**
 * Agent email: settings, modes, limits and the small ports the module needs from the rest of
 * Forerunner (spec: Security -> "Agent email" and "Email commands"; requirements S.15-S.29,
 * T.1-T.14). Everything a human can adjust lives here as data with a zod schema; every limit is
 * enforced in code by policy.ts and commands.ts, never by prompt text.
 *
 * Settings are persisted per agent in the state store as an `extension` row of kind
 * "capability" named `email:<agentId>` (config column holds `{ settings, commands }`); see
 * ADR 0013 and docs/maintainers/email.md. Mailbox credentials are secret references
 * (`secret:<name>`), never values: the schema refuses anything else.
 */
import { type Clock, ForerunnerError, shortToken } from "@forerunner/platform";
import type { ExtensionRepo, ExtensionRow, JsonObject } from "@forerunner/state";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Modes and defaults

export const EMAIL_MODES = [
  "off",
  "read_only",
  "draft_only",
  "allowlist",
  "full_discretion",
] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export const DEFAULT_DAILY_SEND_CAP = 20;
export const DEFAULT_PER_RECIPIENT_DAILY_CAP = 5;
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** CHF 5 in micro-units; converted to USD at the day's rate when the cap is applied. */
export const DEFAULT_PER_EMAIL_CAP_CHF_MICRO = 5_000_000;
export const DEFAULT_DAILY_TASK_CAP = 10;
export const DEFAULT_EMAIL_AUTONOMY_LEVEL = 2;
/** Placeholders {agent} and {human} are filled in at send time. */
export const DEFAULT_SIGNATURE_TEXT =
  "{agent} is an AI agent acting for {human}. This message was written and sent by the agent.";

/** Same shape as the vault's SECRET_NAME_PATTERN behind the "secret:" prefix. */
export const SECRET_REFERENCE_PATTERN = /^secret:[a-z][a-z0-9_.:-]{0,127}$/;
export const MARKER_PATTERN = /^\[[A-Za-z0-9-]{4,32}\]$/;

const secretReference = z
  .string()
  .regex(SECRET_REFERENCE_PATTERN, "must be a secret reference (secret:<name>), never a value");

const address = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "must be an email address" }));

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    "must be a domain such as example.com or *.example.com",
  );

// ---------------------------------------------------------------------------------------------
// Mailbox configuration (never values)

export const ImapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1),
  passwordRef: secretReference,
  folder: z.string().min(1).default("INBOX"),
  draftsFolder: z.string().min(1).default("Drafts"),
});
export type ImapConfig = z.infer<typeof ImapConfigSchema>;

export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().min(1),
  passwordRef: secretReference,
});
export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

export const MailboxConfigSchema = z.object({
  /** The agent's own address, never the human's personal inbox (S.15). */
  address,
  imap: ImapConfigSchema.nullable().default(null),
  smtp: SmtpConfigSchema.nullable().default(null),
});
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>;

// ---------------------------------------------------------------------------------------------
// Sending settings (modes S.16-S.20, limits S.21-S.28)

export const AllowlistSchema = z.object({
  addresses: z.array(address).default([]),
  domains: z.array(domain).default([]),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;

export const SignatureSchema = z.object({
  enabled: z.boolean().default(true),
  text: z.string().min(1).default(DEFAULT_SIGNATURE_TEXT),
});

export const EmailSettingsSchema = z.object({
  mode: z.enum(EMAIL_MODES).default("off"),
  allowlist: AllowlistSchema.default({ addresses: [], domains: [] }),
  dailySendCap: z.number().int().min(0).default(DEFAULT_DAILY_SEND_CAP),
  perRecipientDailyCap: z.number().int().min(0).default(DEFAULT_PER_RECIPIENT_DAILY_CAP),
  signature: SignatureSchema.default({ enabled: true, text: DEFAULT_SIGNATURE_TEXT }),
  /** One-click pause: nothing leaves the mailbox; sends are queued (S.28). */
  paused: z.boolean().default(false),
  dailyDigest: z.boolean().default(false),
  mailbox: MailboxConfigSchema.nullable().default(null),
});
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;
export type EmailSettingsInput = z.input<typeof EmailSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Email command settings (T.1-T.14), a separate toggle from the sending mode

export const EmailCommandSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** The one address whose mail is obeyed (T.3). */
  registeredHumanAddress: address.nullable().default(null),
  /** Private subject tag, e.g. "[FR-7k2q]". Rotated with rotateMarker(). */
  marker: z
    .string()
    .regex(MARKER_PATTERN)
    .default(() => newMarker()),
  pollIntervalMs: z.number().int().min(10_000).default(DEFAULT_POLL_INTERVAL_MS),
  /** Per-email cost cap in CHF micro-units; converted at the day's rate (T.12). */
  perEmailCapChfMicro: z.number().int().min(0).default(DEFAULT_PER_EMAIL_CAP_CHF_MICRO),
  /** Explicit USD cap; when set it replaces the CHF conversion. */
  perEmailCapUsdMicro: z.number().int().min(0).nullable().default(null),
  dailyTaskCap: z.number().int().min(0).default(DEFAULT_DAILY_TASK_CAP),
  autonomyLevel: z.number().int().min(0).max(4).default(DEFAULT_EMAIL_AUTONOMY_LEVEL),
});
export type EmailCommandSettings = z.infer<typeof EmailCommandSettingsSchema>;
export type EmailCommandSettingsInput = z.input<typeof EmailCommandSettingsSchema>;

export const AgentEmailConfigSchema = z.object({
  settings: EmailSettingsSchema.default(() => EmailSettingsSchema.parse({})),
  commands: EmailCommandSettingsSchema.default(() => EmailCommandSettingsSchema.parse({})),
});
export type AgentEmailConfig = z.infer<typeof AgentEmailConfigSchema>;

export interface AgentEmailConfigPatch {
  settings?: Partial<EmailSettingsInput>;
  commands?: Partial<EmailCommandSettingsInput>;
}

/** A fresh private marker such as "[FR-7k2q]". */
export function newMarker(): string {
  return `[${shortToken(4, "FR-")}]`;
}

export function defaultEmailConfig(): AgentEmailConfig {
  return AgentEmailConfigSchema.parse({});
}

/** Merge a patch into a config and validate the result. Throws `validation` on bad input. */
export function mergeEmailConfig(
  current: AgentEmailConfig,
  patch: AgentEmailConfigPatch,
): AgentEmailConfig {
  const merged = {
    settings: {
      ...current.settings,
      ...(patch.settings ?? {}),
      ...(patch.settings?.allowlist
        ? { allowlist: { ...current.settings.allowlist, ...patch.settings.allowlist } }
        : {}),
      ...(patch.settings?.signature
        ? { signature: { ...current.settings.signature, ...patch.settings.signature } }
        : {}),
    },
    commands: { ...current.commands, ...(patch.commands ?? {}) },
  };
  const parsed = AgentEmailConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `invalid email settings: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      { details: { issues: parsed.error.issues.map((i) => i.path.join(".")) } },
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Persistence: one extension row per agent

export const EMAIL_EXTENSION_KIND = "capability" as const;

export function emailExtensionName(agentId: string): string {
  return `email:${agentId}`;
}

export interface EmailSettingsStoreOptions {
  /** Author recorded on writes (an agent or human id). */
  authorHuman?: string | null;
}

/**
 * Reads and writes the per-agent email configuration in the `extension` table. The row is
 * created on first read so the command marker is stable from the start.
 */
export class EmailSettingsStore {
  constructor(
    private readonly extensions: ExtensionRepo,
    private readonly clock: Clock,
  ) {}

  private decode(row: ExtensionRow): AgentEmailConfig {
    const parsed = AgentEmailConfigSchema.safeParse(row.config);
    if (parsed.success) return parsed.data;
    // A row written by an older version: keep what validates, default the rest.
    const fallback = defaultEmailConfig();
    const config = row.config as Partial<{ settings: unknown; commands: unknown }>;
    const settings = EmailSettingsSchema.safeParse(config.settings ?? {});
    const commands = EmailCommandSettingsSchema.safeParse(config.commands ?? {});
    return {
      settings: settings.success ? settings.data : fallback.settings,
      commands: commands.success ? commands.data : fallback.commands,
    };
  }

  private async row(agentId: string): Promise<ExtensionRow | undefined> {
    return this.extensions.byName(EMAIL_EXTENSION_KIND, emailExtensionName(agentId));
  }

  /** The agent's configuration; defaults are persisted when no row exists yet. */
  async get(agentId: string): Promise<AgentEmailConfig> {
    const existing = await this.row(agentId);
    if (existing) return this.decode(existing);
    const config = defaultEmailConfig();
    await this.extensions.insert({
      kind: EMAIL_EXTENSION_KIND,
      name: emailExtensionName(agentId),
      enabled: false,
      permissions: permissionsOf(config),
      config: config as unknown as JsonObject,
      status: "installed",
      author_agent: agentId,
    });
    return config;
  }

  async update(
    agentId: string,
    patch: AgentEmailConfigPatch,
    opts: EmailSettingsStoreOptions = {},
  ): Promise<AgentEmailConfig> {
    const current = await this.get(agentId);
    const next = mergeEmailConfig(current, patch);
    const row = await this.row(agentId);
    if (!row) throw new ForerunnerError("internal", "email settings row vanished");
    await this.extensions.update(row.id, row.version, {
      config: next as unknown as JsonObject,
      enabled: next.settings.mode !== "off" || next.commands.enabled,
      permissions: permissionsOf(next),
      author_human: opts.authorHuman ?? null,
      author_agent: opts.authorHuman ? null : agentId,
    });
    return next;
  }

  setPaused(agentId: string, paused: boolean, opts?: EmailSettingsStoreOptions) {
    return this.update(agentId, { settings: { paused } }, opts);
  }

  /** Rotate the command marker; the old one stops working at once (T.3). */
  async rotateMarker(agentId: string, opts?: EmailSettingsStoreOptions): Promise<string> {
    const next = await this.update(agentId, { commands: { marker: newMarker() } }, opts);
    return next.commands.marker;
  }

  /** Add an approved recipient (allowlist mode, after a "yes"). */
  async addAllowlisted(
    agentId: string,
    entry: { address?: string; domain?: string },
    opts?: EmailSettingsStoreOptions,
  ): Promise<AgentEmailConfig> {
    const current = await this.get(agentId);
    const addresses = new Set(current.settings.allowlist.addresses);
    const domains = new Set(current.settings.allowlist.domains);
    if (entry.address) addresses.add(entry.address.trim().toLowerCase());
    if (entry.domain) domains.add(entry.domain.trim().toLowerCase());
    return this.update(
      agentId,
      { settings: { allowlist: { addresses: [...addresses], domains: [...domains] } } },
      opts,
    );
  }

  /** ISO timestamp of the store's clock, for callers that log settings changes. */
  now(): string {
    return this.clock.nowIso();
  }
}

function permissionsOf(config: AgentEmailConfig): string[] {
  const out = [`email:${config.settings.mode}`];
  if (config.commands.enabled) out.push("email-commands");
  if (config.settings.paused) out.push("paused");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ports wired by the orchestrator (production adapters live next to the fakes in ports.ts)

/** Who the agent acts for; resolved from the agent and human rows. */
export interface EmailIdentity {
  agentId: string;
  agentName: string;
  humanId: string;
  humanName: string;
  humanEmail: string;
  /** IANA time zone used for day boundaries of the caps. */
  timezone: string;
}

export interface IdentityPort {
  lookup(agentId: string): Promise<EmailIdentity>;
}

/** Subset of @forerunner/billing's RateSource: CHF per USD for a day. */
export interface RatePort {
  chfPerUsd(dateIso: string): Promise<number>;
}

/** Same signature as @forerunner/billing's estimateUsdMicro (minus the pricing table). */
export type CostEstimatePort = (
  est: { inputTokens: number; maxOutputTokens: number },
  modelId: string,
) => number;

export interface EventSink {
  append(sessionId: string, type: string, payload: JsonObject): Promise<void>;
}

export type ApprovalAnswer = "yes" | "no" | "pending";

export interface EmailApprovalRequest {
  humanId: string;
  agentId: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  /** What is asked, in a sentence the human reads. */
  why: string;
  kind: "send_email" | "new_recipient" | "paid_signup" | "terms_acceptance" | "command_action";
  risk: "low" | "medium" | "high";
  /** Data the policy needs back when the answer arrives (the draft, the recipients). */
  payload: JsonObject;
}

export interface EmailApprovalTicket {
  id: string;
  answer: ApprovalAnswer;
  request: EmailApprovalRequest;
  answeredBy?: string | null;
}

/** Anything that needs a human goes through this port (HumanRequestRepo in production). */
export interface EmailApprovalPort {
  ask(req: EmailApprovalRequest): Promise<EmailApprovalTicket>;
  get(id: string): Promise<EmailApprovalTicket | undefined>;
  /** Record an answer that arrived by email reply or through the UI. */
  answer(id: string, answer: "yes" | "no", by: string): Promise<EmailApprovalTicket>;
}

export interface CloudSessionRequest {
  agentId: string;
  humanId: string;
  projectId: string;
  taskId: string;
  /** Hard budget for the session in USD micro-units (the per-email cap). */
  capUsdMicro: number;
  /** Autonomy level in force for the session (the email autonomy level). */
  autonomyLevel: 0 | 1 | 2 | 3 | 4;
  trigger: "email";
  source: { messageId: string | null; subject: string; from: string };
}

export interface CloudSessionStarted {
  sessionId: string;
  /** ISO timestamp the session starts (now, or when the runner wakes). */
  startsAt: string;
  logUrl?: string;
}

export interface StartCloudSessionPort {
  start(req: CloudSessionRequest): Promise<CloudSessionStarted>;
}

export interface ContentClassification {
  blocked: boolean;
  classes: string[];
  reason?: string;
}

/** Optional model-backed check behind the rules (policy.ts). */
export interface ContentClassifier {
  classify(
    text: string,
    ctx: { subject: string; recipients: string[] },
  ): Promise<ContentClassification>;
}

// ---------------------------------------------------------------------------------------------
// Drafts and outbound messages

export interface EmailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface EmailSendContext {
  agentId: string;
  humanId: string;
  sessionId?: string;
  runId?: string;
  projectId?: string;
  taskId?: string;
  /** Set by resolveApproval when a human already said yes to this exact draft. */
  approved?: { requestId: string; kind: EmailApprovalRequest["kind"] };
  /** Why this mail is sent; recorded with the copy. */
  kind?: "send" | "reply" | "ack" | "completion" | "approval_request" | "digest";
  /** Links an approval email to its ticket so a "yes" reply can be matched. */
  approvalRequestId?: string;
}

export type SendOutcome =
  | { status: "sent"; messageId: string; logId: string }
  | { status: "queued"; logId: string; reason: "paused" }
  | { status: "awaiting_approval"; requestId: string; reason: EmailApprovalRequest["kind"] }
  | { status: "refused"; requestId: string; reason: string };
