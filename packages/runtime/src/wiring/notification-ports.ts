/**
 * Adapters the daemon composition hands the notifier: the human port whose preference writes
 * leave an audit row, and the email sender over the agent's own mailbox (the agent email
 * capability's policy applies). Nothing here decides routing or urgency; that is the notifier's.
 */
import type { email as agentEmail } from "@forerunner/capabilities";
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { HumanRow, JsonObject, StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import type { EmailPort } from "../notifications/channels/email.ts";
import type { Channel, ChannelContext, ChannelResult } from "../notifications/channels/types.ts";
import type { HumanLookup } from "../notifications/notifier.ts";
import { readPrefs } from "../notifications/prefs.ts";
import type { ChannelName, Notification } from "../notifications/types.ts";
import { type AgentEmailPorts, agentEmailPorts, storedEmailConfig } from "./email-ports.ts";

/** Audit row of every notification preference write (the keys that changed, never the values). */
export const NOTIFY_PREFS_TOOL = "notify.prefs";

/**
 * The keys whose value differs between two stored objects. The known keys are compared after
 * `readPrefs` fills their defaults on both sides, so the first write (which stores every
 * default) names only what the patch changed; other modules' keys are compared as stored.
 */
function changedKeys(before: JsonObject | null | undefined, after: JsonObject): string[] {
  const prev: Record<string, unknown> = { ...(before ?? {}), ...readPrefs(before) };
  const next: Record<string, unknown> = { ...after, ...readPrefs(after) };
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys]
    .filter((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null))
    .sort();
}

/**
 * The notifier's `HumanLookup` over the store. A preference write is a plain settings write
 * (not a limit, so not a command-registry change card): it lands in `human.notify_prefs` and
 * appends one `audit_log` row naming the keys that changed. Values (chat ids, numbers,
 * addresses) stay out of the row.
 */
export class AuditedNotificationHumans implements HumanLookup {
  constructor(
    private readonly store: Pick<StateStore, "human" | "auditLog">,
    private readonly clock: Clock,
    private readonly opts: {
      /**
       * Runs before every read. The notifier reads the human before each preferences view,
       * test send and dispatch, which is the moment the composition refreshes what its
       * channels can only report synchronously (`SecretCheckedChannel.refresh`).
       */
      beforeRead?: () => Promise<void>;
    } = {},
  ) {}

  async get(id: string): Promise<HumanRow | undefined> {
    await this.opts.beforeRead?.();
    return this.store.human.get(id);
  }

  async patch(id: string, patch: Partial<HumanRow>): Promise<HumanRow> {
    const before = patch.notify_prefs !== undefined ? await this.store.human.get(id) : undefined;
    const row = await this.store.human.patch(id, patch);
    if (patch.notify_prefs !== undefined) {
      const changed = changedKeys(before?.notify_prefs, patch.notify_prefs);
      await this.store.auditLog.append({
        tool: NOTIFY_PREFS_TOOL,
        allowed: true,
        human_id: id,
        input_summary: changed.length ? `keys: ${changed.join(", ")}` : "no change",
        result_summary: "notification preferences saved",
        occurred_at: this.clock.nowIso(),
      });
    }
    return row;
  }
}

/** What `SecretCheckedChannel` asks the vault: whether a name is set, never its value. */
export interface SecretExistence {
  has(name: string): Promise<boolean>;
}

/**
 * A channel that also reports its secret as missing (by name, never by value), so the settings
 * screen shows "bot token not set" and the notifier skips the channel instead of failing a
 * send before the fallback (ADR 0038 point 1). `configured()` is synchronous and the vault is
 * not: `refresh()` asks the vault and caches the answer; the composition runs it before every
 * read of the human (`AuditedNotificationHumans`, `beforeRead`), so a token stored while the
 * daemon runs counts at the next view or send. A vault that cannot answer leaves the channel
 * to report the problem from its own send.
 */
export class SecretCheckedChannel implements Channel {
  readonly name: ChannelName;
  private missing: string | null = null;

  constructor(
    private readonly inner: Channel,
    private readonly vault: SecretExistence,
    private readonly secret: { name: string; label: string },
  ) {
    this.name = inner.name;
  }

  async refresh(): Promise<void> {
    try {
      const present = await this.vault.has(this.secret.name);
      this.missing = present ? null : `${this.secret.label} not set (secret ${this.secret.name})`;
    } catch {
      this.missing = null;
    }
  }

  configured(ctx: ChannelContext): string | null {
    return this.inner.configured(ctx) ?? this.missing;
  }

  send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    return this.inner.send(n, ctx);
  }
}

export interface NotificationEmailDeps {
  store: Pick<StateStore, "extension" | "agent" | "human" | "auditLog" | "humanRequest" | "event">;
  clock: Clock;
  vault: Vault;
  /** The principal whose mailbox sends. */
  agentId: string;
  humanId: string;
  /** Tests hand in a fake mailbox; production opens `ImapSmtpMailbox` from the settings. */
  mailboxFactory?: (config: agentEmail.MailboxConfig) => Promise<agentEmail.Mailbox>;
  /**
   * The capability's ports when the composition built them already (the `email_*` tools
   * share them, ADR 0047); otherwise built here over the same store and vault.
   */
  ports?: AgentEmailPorts;
}

/**
 * The notifier's email sender over the agent email capability, or null when the agent has no
 * mailbox configured (the settings row is read, never created). Every send goes through
 * `EmailPolicy.send` as the agent, so the mode gate, the content rules, the caps and the sent
 * log apply exactly as for any other outbound mail; a notification to the human's own address
 * is a reply to the registered human and passes in every mode but `off`. A send the policy did
 * not complete (queued while paused, awaiting an approval, refused) is reported as a failure so
 * the notifier falls back to the next channel.
 */
export async function notificationEmailPort(
  deps: NotificationEmailDeps,
): Promise<EmailPort | null> {
  const configured = (await storedEmailConfig(deps.store.extension, deps.agentId))?.settings
    .mailbox;
  if (!configured) return null;
  const ports = deps.ports ?? agentEmailPorts(deps);
  return {
    async sendEmail(to, subject, body) {
      const outcome = await ports.policy.send(
        { to: [to], subject, text: body },
        { agentId: deps.agentId, humanId: deps.humanId, kind: "send" },
      );
      if (outcome.status !== "sent") {
        throw new ForerunnerError(
          "unavailable",
          `email not sent: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`,
        );
      }
    },
  };
}
