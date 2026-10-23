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
import { type Clock, errorMessage, ForerunnerError, log, shortToken } from "@forerunner/platform";
import type { AuditLogRepo, ExtensionRepo, ExtensionRow, JsonObject } from "@forerunner/state";
import { z } from "zod";
import { EMAIL_SETTINGS_TOOL } from "./sent-log.ts";

const logger = log("capabilities:email:settings");

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

/**
 * Names of the install's own credentials, which a mailbox password may never be. Whoever can
 * write the settings row also names the host the password is sent to, and the runner grants
 * the mailbox exactly the secrets the row names: `passwordRef: secret:anthropic_api_key` on
 * an attacker's IMAP host would hand over the model key on the next poll. A mailbox credential
 * is a password created for the mailbox; a name that says API key, token, PAT, client secret
 * or private key is refused.
 */
export const INSTALL_CREDENTIAL_NAME_PATTERN =
  /api[_.-]?key|apikey|token|(private|signing|secret|access)[_.-]?key|(^|[_.-])pat([_.-]|$)|client[_.-]?secret/;

const mailboxSecretReference = secretReference.refine(
  (ref) => !INSTALL_CREDENTIAL_NAME_PATTERN.test(ref.slice("secret:".length)),
  {
    message:
      "must name a password created for the mailbox, never an API key, token or private key of the install",
  },
);

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
  passwordRef: mailboxSecretReference,
  folder: z.string().min(1).default("INBOX"),
  draftsFolder: z.string().min(1).default("Drafts"),
});
export type ImapConfig = z.infer<typeof ImapConfigSchema>;

export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().min(1),
  passwordRef: mailboxSecretReference,
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

/**
 * Email commands are in force only while the toggle is on and the sending mode is not `off`
 * (ADR 0081): at mode off the mailbox sends nothing, not even the acknowledgement a command
 * needs, so a command would start a task the owner never hears about. The settings store
 * keeps the pair consistent; the gate and the runner's watcher read this as well, so a row
 * written before the rule (commands on at mode off) obeys nothing either.
 */
export function emailCommandsActive(config: AgentEmailConfig): boolean {
  return config.commands.enabled && config.settings.mode !== "off";
}

/** The plain refusal when commands are turned on at mode off (the settings page shows it). */
export const COMMANDS_NEED_SENDING_MODE =
  "Email commands need a sending mode other than off: at off the agent sends nothing, so it could not answer your commands. Choose a sending mode first (read only is enough to reply to you), then turn commands on.";

/** What the owner is told when switching the mode to off turned email commands off. */
export interface EmailCommandsSwitchedOff {
  agentId: string;
  /** The human who changed the mode, when known. */
  byHuman: string | null;
  modeBefore: EmailMode;
  at: string;
  /** One sentence for the owner. */
  message: string;
}

export type EmailCommandsSwitchedOffListener = (event: EmailCommandsSwitchedOff) => unknown;

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

export interface EmailSettingsStoreDeps {
  /** Where the automatic switch-off of email commands is recorded (`email.settings` row). */
  audit?: Pick<AuditLogRepo, "append">;
}

/**
 * Reads and writes the per-agent email configuration in the `extension` table. The row is
 * created on first read so the command marker is stable from the start.
 *
 * Commands and mode stay consistent here, in the store every writer goes through (ADR 0081):
 * turning commands on while the mode is (or becomes) `off` is refused with
 * `COMMANDS_NEED_SENDING_MODE`; switching the mode to `off` while commands are on turns them
 * off in the same write, records an `email.settings` audit row and tells the listeners
 * (`onCommandsSwitchedOff`), which the daemon binds to the owner's notifications.
 */
export class EmailSettingsStore {
  private readonly switchedOffListeners = new Set<EmailCommandsSwitchedOffListener>();

  constructor(
    private readonly extensions: ExtensionRepo,
    private readonly clock: Clock,
    private readonly deps: EmailSettingsStoreDeps = {},
  ) {}

  /** Called after a mode change to `off` turned email commands off; returns the unsubscribe. */
  onCommandsSwitchedOff(listener: EmailCommandsSwitchedOffListener): () => void {
    this.switchedOffListeners.add(listener);
    return () => {
      this.switchedOffListeners.delete(listener);
    };
  }

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
    let next = mergeEmailConfig(current, patch);
    let switchedOff = false;
    if (next.settings.mode === "off" && next.commands.enabled) {
      // Turning commands on (they were not in force) at mode off is refused so the owner
      // hears why; a mode change to off with commands on, or any other write over a row
      // stored before the rule, turns them off instead.
      if (patch.commands?.enabled === true && !emailCommandsActive(current)) {
        throw new ForerunnerError("validation", COMMANDS_NEED_SENDING_MODE, {
          details: { reason: "commands_need_sending_mode", issues: ["commands.enabled"] },
        });
      }
      next = { ...next, commands: { ...next.commands, enabled: false } };
      switchedOff = true;
    }
    const row = await this.row(agentId);
    if (!row) throw new ForerunnerError("internal", "email settings row vanished");
    await this.extensions.update(row.id, row.version, {
      config: next as unknown as JsonObject,
      enabled: next.settings.mode !== "off" || next.commands.enabled,
      permissions: permissionsOf(next),
      author_human: opts.authorHuman ?? null,
      author_agent: opts.authorHuman ? null : agentId,
    });
    if (switchedOff) await this.commandsSwitchedOff(agentId, current.settings.mode, opts);
    return next;
  }

  /**
   * The audit row and the listeners after commands were turned off with the mode. The write
   * already happened: a failing audit store or listener is logged and never undoes it.
   */
  private async commandsSwitchedOff(
    agentId: string,
    modeBefore: EmailMode,
    opts: EmailSettingsStoreOptions,
  ): Promise<void> {
    const at = this.clock.nowIso();
    const byHuman = opts.authorHuman ?? null;
    const event: EmailCommandsSwitchedOff = {
      agentId,
      byHuman,
      modeBefore,
      at,
      message:
        "Email commands were turned off because the sending mode is now off: at off the agent sends nothing, so it could not answer your commands. Choose a sending mode and turn commands on again to use them.",
    };
    try {
      await this.deps.audit?.append({
        tool: EMAIL_SETTINGS_TOOL,
        allowed: true,
        agent_id: agentId,
        human_id: byHuman,
        input_summary: JSON.stringify({
          action: "commands_switched_off",
          reason: "mode_off",
          modeBefore,
          modeAfter: "off",
        }),
        result_summary: JSON.stringify({ status: "commands_off", reason: "mode_off" }),
        cost_usd_micro: 0,
        occurred_at: at,
        author_human: byHuman,
      });
    } catch (e) {
      logger.warn("commands switch-off not audited", { agentId, error: errorMessage(e) });
    }
    logger.info("email commands turned off with the sending mode", { agentId, modeBefore });
    for (const listener of this.switchedOffListeners) {
      try {
        await listener(event);
      } catch (e) {
        logger.warn("commands switch-off listener failed", { agentId, error: errorMessage(e) });
      }
    }
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
