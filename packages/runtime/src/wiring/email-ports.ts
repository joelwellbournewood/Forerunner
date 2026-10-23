/**
 * The daemon's side of agent email (spec S.15 to S.29; ADR 0013, ADR 0047): the capability's
 * ports built once over the store and the vault, shared by the four `email_*` tools and the
 * notifier's email channel, so one mailbox connection and one policy serve both. The mode,
 * the caps and the blocked content are the policy's per call (`EmailPolicy.send`); here only
 * the presence switch is decided: the tools are offered to a run when the agent's settings
 * row names a mailbox and the mode is not `off`, read afresh at every session start.
 */
import { email as agentEmail } from "@forerunner/capabilities";
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { SecretResolver, type Vault } from "@forerunner/vault";
import type { ToolSpec } from "../agent/tools.ts";
import { CapabilityPresence } from "./browser-ports.ts";

export interface AgentEmailDeps {
  store: Pick<StateStore, "extension" | "agent" | "human" | "auditLog" | "humanRequest" | "event">;
  clock: Clock;
  vault: Vault;
  /** The principal whose mailbox reads and sends. */
  agentId: string;
  /** Tests hand in a fake mailbox; production opens `ImapSmtpMailbox` from the settings. */
  mailboxFactory?: (config: agentEmail.MailboxConfig) => Promise<agentEmail.Mailbox>;
}

export interface AgentEmailPorts {
  settings: agentEmail.EmailSettingsStore;
  identity: agentEmail.IdentityPort;
  sentLog: agentEmail.SentLog;
  approvals: agentEmail.EmailApprovalPort;
  policy: agentEmail.EmailPolicy;
  /** The agent's mailbox, opened on first use from the settings in force and kept. */
  mailboxFor: agentEmail.MailboxProvider;
  /** The four `email_*` tool specs over these ports (`emailTools`). */
  tools: ToolSpec[];
  /** The settings row as stored (read, never created): null until a human configured email. */
  config(): Promise<agentEmail.AgentEmailConfig | null>;
}

/** The agent's email settings as stored, or null when no row exists or it does not parse. */
export async function storedEmailConfig(
  extensions: Pick<StateStore["extension"], "byName">,
  agentId: string,
): Promise<agentEmail.AgentEmailConfig | null> {
  const row = await extensions.byName(
    agentEmail.EMAIL_EXTENSION_KIND,
    agentEmail.emailExtensionName(agentId),
  );
  if (!row) return null;
  const parsed = agentEmail.AgentEmailConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

/**
 * The capability's ports over the daemon's store: settings (`extension` row per agent),
 * identity (the agent and its human), the sent log (`audit_log`), approvals (`human_request`
 * rows), the policy with its event sink, and the mailbox opened by reference from the vault.
 * Nothing connects at construction; the first send or read opens the mailbox, and a failure
 * to open leaves the next call to try again.
 */
export function agentEmailPorts(deps: AgentEmailDeps): AgentEmailPorts {
  const settings = new agentEmail.EmailSettingsStore(deps.store.extension, deps.clock, {
    audit: deps.store.auditLog,
  });
  const identity = new agentEmail.StoreIdentityLookup(deps.store.agent, deps.store.human);
  const sentLog = new agentEmail.AuditSentLog(deps.store.auditLog, deps.clock);
  const approvals = new agentEmail.HumanRequestApprovalPort(deps.store.humanRequest);
  let mailbox: Promise<agentEmail.Mailbox> | null = null;
  const open = async (): Promise<agentEmail.Mailbox> => {
    const current = (await settings.get(deps.agentId)).settings.mailbox;
    if (!current) {
      throw new ForerunnerError(
        "unavailable",
        "no agent mailbox configured: set one in Settings, Capabilities, Email",
      );
    }
    if (deps.mailboxFactory) return deps.mailboxFactory(current);
    const granted = new Set<string>();
    for (const ref of [current.imap?.passwordRef, current.smtp?.passwordRef]) {
      if (ref) granted.add(ref.replace(/^secret:/, ""));
    }
    return new agentEmail.ImapSmtpMailbox({
      config: current,
      secrets: new SecretResolver(deps.vault),
      granted,
      clock: deps.clock,
    });
  };
  const mailboxFor: agentEmail.MailboxProvider = () => {
    mailbox ??= open().catch((e: unknown) => {
      mailbox = null;
      throw e;
    });
    return mailbox;
  };
  const policy = new agentEmail.EmailPolicy({
    settings,
    identity,
    sentLog,
    approvals,
    mailboxFor,
    clock: deps.clock,
    events: new agentEmail.StoreEventSink(deps.store.event, deps.agentId),
  });
  const tools = agentEmail.emailTools({
    policy,
    settings,
    identity,
    sentLog,
    mailboxFor,
    clock: deps.clock,
  });
  return {
    settings,
    identity,
    sentLog,
    approvals,
    policy,
    mailboxFor,
    tools,
    config: () => storedEmailConfig(deps.store.extension, deps.agentId),
  };
}

/** The email capability's presence: a mailbox is configured and the mode is not `off`. */
export function emailPresence(ports: Pick<AgentEmailPorts, "config">): CapabilityPresence {
  return new CapabilityPresence("email", async () => {
    const config = await ports.config();
    return config !== null && config.settings.mailbox !== null && config.settings.mode !== "off";
  });
}
