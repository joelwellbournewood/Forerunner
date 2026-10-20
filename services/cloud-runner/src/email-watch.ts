import {
  AuditSentLog,
  AuthResultsHeaderVerifier,
  type AuthVerifier,
  type CommandOutcome,
  EmailCommandGate,
  EmailCommandHandler,
  type EmailIdentity,
  EmailPolicy,
  EmailSettingsStore,
  HumanRequestApprovalPort,
  ImapSmtpMailbox,
  type InboundEmail,
  MailauthVerifier,
  type Mailbox,
  type MailboxConfig,
  type MailboxWatch,
  ModelCommandClassifier,
  pollLoop,
  type RatePort,
  type StartCloudSessionPort,
  StoreEventSink,
  StoreIdentityLookup,
} from "@forerunner/capabilities/email/index";
import { type Clock, errorMessage, join, log } from "@forerunner/platform";
import type { ModelProvider, RunPricing } from "@forerunner/runtime";
import type { StateStore } from "@forerunner/state";
import { SecretResolver, type Vault } from "@forerunner/vault";

/**
 * The agent mailbox watcher (spec "Email commands: tasks by email, run in the cloud"; T.2,
 * T.10, T.13). Composes the email module the way the orchestrator does (email.md, "Ports to
 * wire") around the agent's own mailbox and feeds every inbound message to
 * `EmailCommandHandler`, which applies the verification chain in code (owner's address, DKIM,
 * SPF, marker or thread) and acts on obeyed mail. A task command starts a cloud session through
 * the runner's `StartCloudSessionPort` with the per-email cost cap and the email autonomy level;
 * the handler acknowledges within a minute and the runner sends the completion summary when
 * the session ends.
 *
 * Checking: IMAP IDLE push when the host offers it, the configured poll interval otherwise
 * (`FORERUNNER_RUNNER_MAIL_CHECK_MS`, default five minutes). `FORERUNNER_RUNNER_MAIL_PUSH=false`
 * (`push: false`) never opens the push connection: the watcher lists the unseen messages at the
 * poll interval itself (`pollOnly`). The mailbox credentials are secret references resolved from
 * the runner's vault at call time; values never sit on the watcher.
 */
export type EmailWatchState =
  | { state: "disabled"; reason: string }
  | { state: "watching"; address: string; pushActive: boolean; startedAt: string };

export interface EmailWatchDeps {
  store: StateStore;
  clock: Clock;
  vault: Vault;
  provider: ModelProvider;
  agentId: string;
  humanId: string;
  cloud: StartCloudSessionPort;
  /** Prices the pre-run estimate; the same table the executor uses for the working model. */
  pricing: RunPricing;
  estimateModel: string;
  classifierModel: string;
  rates: RatePort;
  /** Root for attachments: `<dataDir>/projects/<project>/agents/<agent>/inbox/<message>/`. */
  dataDir: string;
  pollIntervalMs: number;
  /** False: polling only, no push (IDLE) connection even when the host offers one. */
  push: boolean;
  verifier?: AuthVerifier;
  /** "mailauth" (re-verify with DNS) or "header" (trust the listed authserv-ids). */
  verifierKind?: "mailauth" | "header";
  trustedAuthservIds?: string[];
  /** Tests hand in the testenv mailbox; production builds ImapSmtpMailbox from the settings. */
  mailboxFactory?: (config: MailboxConfig) => Promise<Mailbox>;
  onOutcome?: (outcome: CommandOutcome, message: InboundEmail) => void;
}

export class EmailWatch {
  private readonly logger = log("cloud-runner:email");
  readonly settings: EmailSettingsStore;
  readonly identity: StoreIdentityLookup;
  readonly sentLog: AuditSentLog;
  readonly approvals: HumanRequestApprovalPort;
  readonly policy: EmailPolicy;
  readonly handler: EmailCommandHandler;
  private mailbox: Mailbox | null = null;
  private watch: MailboxWatch | null = null;
  private startedAt: string | null = null;
  private lastMessageAt: string | null = null;
  private handledCount = 0;
  private current: EmailWatchState = { state: "disabled", reason: "not started" };
  /** The message being handled right now; a completion waits for it (its audit row threads the reply). */
  private handling: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EmailWatchDeps) {
    const { store, clock } = deps;
    this.settings = new EmailSettingsStore(store.extension, clock);
    this.identity = new StoreIdentityLookup(store.agent, store.human);
    this.sentLog = new AuditSentLog(store.auditLog, clock);
    this.approvals = new HumanRequestApprovalPort(store.humanRequest);
    const events = new StoreEventSink(store.event, deps.agentId);
    const mailboxFor = async () => this.openMailbox();
    this.policy = new EmailPolicy({
      settings: this.settings,
      identity: this.identity,
      sentLog: this.sentLog,
      approvals: this.approvals,
      mailboxFor,
      clock,
      events,
    });
    const gate = new EmailCommandGate({
      settings: this.settings,
      verifier: deps.verifier ?? this.defaultVerifier(),
      sentLog: this.sentLog,
      clock,
    });
    this.handler = new EmailCommandHandler({
      gate,
      settings: this.settings,
      identity: this.identity,
      policy: this.policy,
      classifier: new ModelCommandClassifier(deps.provider, deps.classifierModel),
      store: {
        task: store.task,
        queue: store.queue,
        project: store.project,
        auditLog: store.auditLog,
      },
      approvals: this.approvals,
      cloud: deps.cloud,
      estimateUsdMicro: (est) => deps.pricing.estimate(est.inputTokens, est.maxOutputTokens),
      estimateModel: deps.estimateModel,
      rates: deps.rates,
      clock,
      projectDataDir: (projectId, agentId) =>
        join(deps.dataDir, "projects", projectId, "agents", agentId),
      events,
      mailboxFor,
    });
  }

  private defaultVerifier(): AuthVerifier {
    const kind = this.deps.verifierKind ?? "mailauth";
    if (kind === "header") {
      return new AuthResultsHeaderVerifier({
        trustedAuthservIds: this.deps.trustedAuthservIds ?? [],
      });
    }
    // Loaded on first use so a runner without email never touches the DNS verifier.
    let verifier: Promise<MailauthVerifier> | null = null;
    return {
      verify: async (message) => {
        verifier ??= MailauthVerifier.create();
        return (await verifier).verify(message);
      },
    };
  }

  /** The agent's mailbox from its settings; the same instance for the life of the watch. */
  private async openMailbox(): Promise<Mailbox> {
    if (this.mailbox) return this.mailbox;
    const config = await this.settings.get(this.deps.agentId);
    const mailboxConfig = config.settings.mailbox;
    if (!mailboxConfig) {
      throw new Error("the agent has no mailbox configured (Settings -> Capabilities -> Email)");
    }
    if (this.deps.mailboxFactory) {
      this.mailbox = await this.deps.mailboxFactory(mailboxConfig);
      return this.mailbox;
    }
    const granted = new Set<string>();
    for (const ref of [mailboxConfig.imap?.passwordRef, mailboxConfig.smtp?.passwordRef]) {
      if (ref) granted.add(ref.replace(/^secret:/, ""));
    }
    this.mailbox = new ImapSmtpMailbox({
      config: mailboxConfig,
      secrets: new SecretResolver(this.deps.vault),
      granted,
      clock: this.deps.clock,
    });
    return this.mailbox;
  }

  get status(): EmailWatchState & { handled: number; lastMessageAt: string | null } {
    return { ...this.current, handled: this.handledCount, lastMessageAt: this.lastMessageAt };
  }

  /** Who the agent acts for (the registered address is the owner's). */
  whoFor(): Promise<EmailIdentity> {
    return this.identity.lookup(this.deps.agentId);
  }

  /**
   * Start watching when commands are enabled and a mailbox is configured; otherwise report why
   * and watch nothing. Never throws for a configuration gap: the runner still runs schedules.
   */
  async start(): Promise<EmailWatchState> {
    if (this.watch) return this.current;
    const config = await this.settings.get(this.deps.agentId);
    if (!config.commands.enabled) {
      this.current = { state: "disabled", reason: "email commands are off for this agent" };
    } else if (!config.commands.registeredHumanAddress) {
      this.current = { state: "disabled", reason: "no registered human address" };
    } else if (!config.settings.mailbox) {
      this.current = { state: "disabled", reason: "no mailbox configured" };
    } else {
      try {
        const mailbox = await this.openMailbox();
        this.watch = this.deps.push
          ? await mailbox.watch((message) => this.onMessage(message), {
              pollIntervalMs: this.deps.pollIntervalMs,
              catchUp: true,
            })
          : await this.pollOnly(mailbox);
        this.startedAt = this.deps.clock.nowIso();
        this.current = {
          state: "watching",
          address: mailbox.address,
          pushActive: this.watch.pushActive,
          startedAt: this.startedAt,
        };
        this.logger.info("watching the agent mailbox", {
          address: mailbox.address,
          push: this.deps.push,
          pushActive: this.watch.pushActive,
          pollIntervalMs: this.deps.pollIntervalMs,
        });
      } catch (e) {
        this.current = { state: "disabled", reason: `mailbox unavailable: ${errorMessage(e)}` };
      }
    }
    if (this.current.state === "disabled")
      this.logger.warn("email watch not started", { reason: this.current.reason });
    return this.current;
  }

  async stop(): Promise<void> {
    const w = this.watch;
    this.watch = null;
    if (w) await w.stop();
    this.current = { state: "disabled", reason: "stopped" };
  }

  /**
   * Polling only (`push: false`): no push connection is ever opened; the unseen messages are
   * listed at the poll interval (a catch-up sweep first) and each is handed over once. The
   * handler marks a handled message seen; one it could not mark is remembered while it stays
   * unseen, so a later poll never hands it over again.
   */
  private async pollOnly(mailbox: Mailbox): Promise<MailboxWatch> {
    const delivered = new Set<string>();
    let stopped = false;
    let inFlight: Promise<void> = Promise.resolve();
    const sweep = async () => {
      if (stopped) return;
      const unseen = await mailbox.listUnseen({ limit: 200 });
      const ids = new Set(unseen.map((m) => m.id));
      for (const id of [...delivered]) if (!ids.has(id)) delivered.delete(id);
      for (const message of unseen) {
        if (stopped || delivered.has(message.id)) continue;
        delivered.add(message.id);
        inFlight = this.onMessage(message).catch(() => undefined);
        await inFlight;
      }
    };
    await sweep().catch((e: unknown) => {
      this.logger.warn("catch-up poll failed; retrying at the interval", {
        error: errorMessage(e),
      });
    });
    const cancel = pollLoop(this.deps.clock, this.deps.pollIntervalMs, sweep);
    return {
      pushActive: false,
      async stop() {
        stopped = true;
        cancel();
        await inFlight;
      },
    };
  }

  private onMessage(message: InboundEmail): Promise<void> {
    this.handling = this.handleOne(message);
    return this.handling;
  }

  private async handleOne(message: InboundEmail): Promise<void> {
    this.lastMessageAt = this.deps.clock.nowIso();
    try {
      const outcome = await this.handler.handle(this.deps.agentId, message);
      this.handledCount++;
      this.logger.info("inbound email handled", {
        id: message.id,
        from: message.from,
        outcome: outcome.kind,
      });
      this.deps.onOutcome?.(outcome, message);
    } catch (e) {
      this.logger.warn("inbound email failed", { id: message.id, error: errorMessage(e) });
    }
  }

  /** Completion summary for an email-triggered session (T.10); the handler threads it. */
  async completed(input: {
    sessionId: string;
    summary: string;
    prUrls?: string[];
    files?: string[];
    logUrl?: string;
    costUsdMicro?: number;
  }): Promise<string | null> {
    // A short session can end before the command that started it finished its bookkeeping;
    // the summary threads under the original email only once that audit row exists.
    await this.handling.catch(() => undefined);
    try {
      return await this.handler.onSessionCompleted({ agentId: this.deps.agentId, ...input });
    } catch (e) {
      this.logger.warn("completion email failed", {
        sessionId: input.sessionId,
        error: errorMessage(e),
      });
      return null;
    }
  }
}
