import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type GitHost, PrTaskExecutor } from "@forerunner/capabilities";
import type {
  AuthVerifier,
  CloudSessionRequest,
  CloudSessionStarted,
  CommandOutcome,
  InboundEmail,
  Mailbox,
  MailboxConfig,
  StartCloudSessionPort,
} from "@forerunner/capabilities/email/index";
import {
  type AppDirs,
  appDirs,
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  systemClock,
} from "@forerunner/platform";
import {
  type AutonomyLevel,
  composeRuntime,
  type EngineDetection,
  KillFileWatcher,
  LoopTaskExecutor,
  type ModelProvider,
  modelIdFor,
  type Planner,
  type PlannerContext,
  pricingFor,
  type RunPricing,
  type RuntimeApp,
  type Schedule,
  Scheduler,
  SECRET_NAMES,
  type SessionResult,
  SessionRunner,
  type SessionTriggerKind,
  type StartRequest,
  StaticPlanner,
} from "@forerunner/runtime";
import {
  type AgentRow,
  type DeviceRow,
  type HumanRow,
  openStore,
  type StateStore,
} from "@forerunner/state";
import { EncryptedFileVault, type Vault } from "@forerunner/vault";
import { z } from "zod";
import {
  type BillingSourceProbe,
  pickRunnerBillingSource,
  type RunnerBillingChoice,
  VaultCredentialProbe,
} from "./billing.ts";
import { describeConfig, type RunnerConfig, redactStoreUrl } from "./config.ts";
import { EmailWatch } from "./email-watch.ts";
import { type HealthServer, removeReadyFile, startHealthServer, writeReadyFile } from "./health.ts";
import { type InboxRequestOutcome, InboxTrigger, type InboxTriggerStats } from "./inbox-trigger.ts";
import { PcPresence, type PresenceVerdict } from "./presence.ts";
import { RemoteCommandWatcher } from "./remote.ts";
import { RunnerVaultUnlock, type UnlockState } from "./vault-unlock.ts";

/**
 * The headless runner (spec "Run modes": hybrid and cloud only; ADR 0026 "the cloud runner
 * runs the same runtime headless"; ADR 0033). It composes the runtime against the shared
 * Postgres state, unlocks its vault blob with the key the human's device releases, runs the
 * agent's schedules while no PC daemon is online, honours the kill switch from the shared state
 * and watches the agent mailbox for email commands. Every session it starts is recorded with
 * runner "cloud" and the runner's device id, and is billed to the human's own source.
 */
export const SCHEDULE_SETTINGS_KEY = "schedules";
export const DEVICE_FILE_NAME = "runner-device.json";
/** Exit code main.ts uses when the vault key was forgotten and the runner should start afresh. */
export const RELOCK_EXIT_CODE = 75;

export const ProjectScheduleSchema = z.object({
  id: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  kind: z.enum(["daily", "weekdays", "every"]),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  everyMinutes: z.number().int().min(5).optional(),
  timezone: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
});
export type ProjectSchedule = z.infer<typeof ProjectScheduleSchema>;

export interface CloudStartRequest extends StartRequest {
  budgetUsdMicro?: number;
  autonomy?: AutonomyLevel;
  /** Run regardless of a PC being online (remote and email triggers). */
  force?: boolean;
}

export interface CloudRunnerDeps {
  config: RunnerConfig;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** Injected vault (tests). An `EncryptedFileVault` goes through the unlock flow; any other backend is used as is. */
  vault?: Vault;
  provider?: ModelProvider;
  gitHost?: GitHost;
  probe?: BillingSourceProbe;
  registryDir?: string;
  mailboxFactory?: (config: MailboxConfig) => Promise<Mailbox>;
  verifier?: AuthVerifier;
  sandboxDetection?: EngineDetection;
  /** The vault key was forgotten and no session is running: the process should start afresh. */
  onRestart?: (reason: string) => void;
  onEmailOutcome?: (outcome: CommandOutcome, message: InboundEmail) => void;
}

export interface RunnerStatus {
  runnerId: string;
  version: string;
  uptimeMs: number;
  stateUrl: string;
  human: { id: string; name: string };
  agent: { id: string; name: string };
  deviceId: string;
  vault: { backend: string } & UnlockState;
  billing: { sourceId: string; kind: string };
  provider: string;
  pcOnline: PresenceVerdict | null;
  activeSessions: number;
  killActive: boolean;
  schedules: number;
  sessionsStarted: number;
  schedulesSkipped: number;
  email: EmailWatch["status"];
  remote: RemoteCommandWatcher["stats"];
  /** Inbox trigger counters, or null when `FORERUNNER_RUNNER_INBOX_POLL_MS` is 0. */
  inbox: InboxTriggerStats | null;
  ready: boolean;
}

export interface CloudRunner {
  config: RunnerConfig;
  runnerId: string;
  dirs: AppDirs;
  clock: Clock;
  rt: RuntimeApp;
  store: StateStore;
  human: HumanRow;
  agent: AgentRow;
  device: DeviceRow;
  billing: RunnerBillingChoice;
  scheduler: Scheduler;
  presence: PcPresence;
  unlock: RunnerVaultUnlock | null;
  remote: RemoteCommandWatcher;
  email: EmailWatch | null;
  inbox: InboxTrigger | null;
  health: HealthServer;
  /**
   * Start a session now; `force` ignores an online PC (the rule applies to schedules, inbox
   * and unforced manual triggers). "deferred" also when the PC rule left the firing to the PC;
   * "failed" when the start threw before a session existed (the reason is in the log).
   */
  startSession(
    req: Partial<CloudStartRequest> & { trigger?: SessionTriggerKind },
  ): Promise<"started" | "queued" | "deferred" | "failed">;
  /** Re-read the projects' schedules into the scheduler (also done every tick). */
  refreshSchedules(): Promise<Schedule[]>;
  status(): Promise<RunnerStatus>;
  stop(): Promise<void>;
}

/** Plans like the daemon; an email-triggered session works on its email task only. */
class FocusedPlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly focus: Map<string, string>,
  ) {}
  async plan(ctx: PlannerContext) {
    const plan = await this.inner.plan(ctx);
    const taskId = this.focus.get(ctx.session.agent_id);
    if (ctx.session.trigger !== "email" || !taskId) return plan;
    this.focus.delete(ctx.session.agent_id);
    const items = plan.items.filter((i) => i.taskId === taskId);
    return {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      summary: `email task ${taskId}`,
    };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Real providers price from the billing table; the fake provider counts one micro-USD per token. */
function pricingForProvider(provider: ModelProvider, modelId: string): RunPricing {
  if (provider.name === "anthropic") return pricingFor(modelId);
  return {
    estimate: (i, o) => i + o,
    cost: (u) => u.input_tokens + u.output_tokens,
  };
}

async function resolveHuman(store: StateStore, selector: string | undefined): Promise<HumanRow> {
  if (selector) {
    const byId = await store.human.get(selector);
    if (byId) return byId;
    const byEmail = await store.human.byEmail(selector);
    if (byEmail) return byEmail;
    throw new ForerunnerError("not_found", `no human with id or email ${selector}`);
  }
  const [first] = await store.human.list(undefined, { limit: 1 });
  if (!first) {
    throw new ForerunnerError(
      "not_found",
      "the shared state has no human yet; run the desktop setup first",
    );
  }
  return first;
}

async function resolveAgent(
  store: StateStore,
  human: HumanRow,
  selector: string | undefined,
): Promise<AgentRow> {
  const principals = await store.agent.principals(human.id);
  if (selector) {
    const found =
      principals.find((a) => a.id === selector) ??
      principals.find((a) => a.name.toLowerCase() === selector.toLowerCase());
    if (!found) {
      throw new ForerunnerError(
        "not_found",
        `human ${human.name} has no active principal agent with id or name ${selector}`,
      );
    }
    return found;
  }
  const [first] = principals;
  if (!first)
    throw new ForerunnerError("not_found", `human ${human.name} has no active principal agent`);
  return first;
}

/**
 * The runner's own `device` row (kind "runner"): sessions reference it, remote commands can be
 * addressed to it and its `last_seen` is the runner's heartbeat. The public key is an
 * identifier persisted next to the runner's config (runners authenticate to the state service
 * with the admin token, ADR 0009), generated once.
 */
async function registerRunnerDevice(
  store: StateStore,
  dirs: AppDirs,
  humanId: string,
  runnerId: string,
): Promise<DeviceRow> {
  const file = join(dirs.config, DEVICE_FILE_NAME);
  let publicKey: string | null = null;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { publicKey?: unknown };
      if (typeof parsed.publicKey === "string" && parsed.publicKey.length > 0)
        publicKey = parsed.publicKey;
    } catch {
      publicKey = null;
    }
  }
  if (publicKey) {
    const existing = await store.device.byPublicKey(publicKey);
    if (existing && !existing.revoked) return existing;
  }
  const named = (
    await store.device.list({ owner_human_id: humanId, kind: "runner", name: runnerId })
  )
    .filter((d) => !d.revoked)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (named) {
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(file, JSON.stringify({ runnerId, publicKey: named.public_key }, null, 2), {
      mode: 0o600,
    });
    return named;
  }
  const fresh = randomBytes(32).toString("base64");
  const row = await store.device.register({
    owner_human_id: humanId,
    name: runnerId,
    platform: `${process.platform}-runner`,
    public_key: fresh,
    kind: "runner",
  });
  mkdirSync(dirs.config, { recursive: true });
  writeFileSync(file, JSON.stringify({ runnerId, publicKey: fresh }, null, 2), { mode: 0o600 });
  return row;
}

export async function startCloudRunner(deps: CloudRunnerDeps): Promise<CloudRunner> {
  const logger = log("cloud-runner");
  const { config } = deps;
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const dirs = appDirs({ env });
  for (const d of [dirs.config, dirs.data, dirs.runtime, dirs.worktrees, dirs.cache, dirs.logs])
    mkdirSync(d, { recursive: true });
  const startedAt = clock.now();
  logger.info("runner starting", describeConfig(config));

  // 1. Identity and the runner's device row, through a store of our own (the runtime composes
  //    its own connection below; the unlock flow needs the shared state before that).
  const storeOpts = {
    url: config.stateUrl,
    clock,
    ...(config.stateSchema ? { schema: config.stateSchema } : {}),
  };
  const preStore = await openStore(storeOpts);
  let storeNow: StateStore = preStore;
  const storeRef = () => storeNow;
  let human: HumanRow;
  let agent: AgentRow;
  let device: DeviceRow;
  try {
    human = await resolveHuman(preStore, config.human);
    agent = await resolveAgent(preStore, human, config.agent);
    device = await registerRunnerDevice(preStore, dirs, human.id, config.runnerId);
    await preStore.device.seen(device.id);
  } catch (e) {
    await preStore.close().catch(() => undefined);
    throw e;
  }

  // 2. The vault: an encrypted blob whose key the human's device holds.
  const vault: Vault = deps.vault ?? new EncryptedFileVault({ path: config.vaultPath, env });
  let restartPending: string | null = null;
  let rtRef: RuntimeApp | null = null;
  const unlock =
    vault instanceof EncryptedFileVault
      ? new RunnerVaultUnlock({
          vault,
          store: storeRef,
          clock,
          humanId: human.id,
          runnerId: config.runnerId,
          agentId: agent.id,
          policy: config.unlock.policy,
          challengeTtlMs: config.unlock.challengeTtlMs,
          pollMs: config.unlock.pollMs,
          timeoutMs: config.unlock.timeoutMs,
          tickMs: config.unlock.tickMs,
          onForget: (reason) => {
            restartPending = reason;
            maybeRestart();
          },
        })
      : null;
  if (unlock) {
    try {
      const outcome = await unlock.ensureUnlocked("runner start");
      logger.info("vault ready", { via: outcome.via, unlockedUntil: outcome.unlockedUntil });
    } catch (e) {
      await preStore.close().catch(() => undefined);
      throw e;
    }
  }

  // 3. The same runtime as the daemon, headless: no daemon services (we run our own scheduler,
  //    kill watcher and mail watcher), the runner's vault, the shared store.
  let rt: RuntimeApp;
  try {
    rt = await composeRuntime({
      env,
      dirs,
      config: null,
      clock,
      stateUrl: config.stateUrl,
      vault,
      provider: deps.provider,
      gitHost: deps.gitHost,
      registryDir: deps.registryDir,
      appVersion: config.version,
      sandboxDetection: deps.sandboxDetection,
      identity: { humanName: human.name, email: human.email, timezone: human.timezone },
      startServices: false,
    });
  } catch (e) {
    await preStore.close().catch(() => undefined);
    throw e;
  }
  rtRef = rt;
  storeNow = rt.store;
  await preStore.close().catch(() => undefined);
  const store = rt.store;
  try {
    await rt.extensions.start();
  } catch (e) {
    logger.warn("extensions did not start; bridged tools unavailable", { error: errorMessage(e) });
  }

  // 4. Billing: the human's own source for cloud work (subscription only on a personal runner).
  const probe = deps.probe ?? new VaultCredentialProbe(vault);
  let billing: RunnerBillingChoice;
  try {
    billing = await pickRunnerBillingSource({
      store,
      humanId: human.id,
      agentId: agent.id,
      agentOwnerHumanId: agent.owner_human_id,
      personal: config.personal,
      probe,
    });
  } catch (e) {
    if (rt.provider?.name === "fake" || !rt.provider) {
      // No credential anywhere: the fake provider needs no source; mirror the daemon's seed.
      const row = await store.billingSource.insert({
        human_id: human.id,
        kind: "fake",
        label: "No credential (fake provider)",
        credential_ref: "none",
        limits: {},
        enabled: true,
        priority: 9,
      });
      billing = {
        sourceId: row.id,
        kind: "fake",
        label: row.label,
        reason: "no source: fake",
        skipped: [],
      };
      logger.warn("no usable billing source; using a fake source for the fake provider", {
        error: errorMessage(e),
      });
    } else {
      await rt.close().catch(() => undefined);
      throw e;
    }
  }

  // 5. Sessions on this runner: the daemon's executor stack with the runner's billing source,
  //    recorded with runner "cloud" and this device.
  const provider = rt.provider;
  const workingModel = provider ? modelIdFor("sonnet", provider.name) : "none";
  const pricing: RunPricing = provider
    ? pricingForProvider(provider, workingModel)
    : { estimate: () => 0, cost: () => 0 };
  const ghToken = await vault.get(SECRET_NAMES.github).catch(() => null);
  const githubApiBase = env.FORERUNNER_GITHUB_API_BASE || "https://api.github.com";
  // The composed runtime's specialists: the registry's `cc:` tool names mapped for the driver
  // the runtime runs them on (ADR 0043), so the loop executor below offers the built-ins.
  const specialists = rt.specialists;
  const makeLoop = (worktree?: string) =>
    new LoopTaskExecutor({
      store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider: provider ?? noProvider(),
      pricing,
      tools: rt.tools,
      toolsFor: rt.toolsForRun,
      sandbox: rt.sandbox.port,
      context: rt.context,
      billingSourceId: billing.sourceId,
      specialists,
      ...(worktree ? { worktreeFor: async () => worktree } : {}),
      onEvent: (taskId, ev) => rt.events.emit("run", { taskId, ev }),
    });
  const executor = new PrTaskExecutor({
    store,
    clock,
    host: rt.gitHost,
    inner: { execute: (ctx) => makeLoop().execute(ctx), withWorktree: (dir) => makeLoop(dir) },
    repoFor: async (task) => {
      const project = await store.project.get(task.project_id);
      const full = project?.repos[0];
      if (!full?.includes("/")) return null;
      const [owner, name] = full.split("/") as [string, string];
      const info = await rt.gitHost.getRepo({ owner, name });
      return { clone: info.cloneUrl, repo: { owner, name }, base: info.defaultBranch };
    },
    worktreeRoot: dirs.worktrees,
    token: ghToken ?? undefined,
    identity: { name: `${agent.name} (Forerunner)`, email: human.email || "forerunner@localhost" },
  });
  const focus = new Map<string, string>();
  const sessions = new SessionRunner({
    store,
    clock,
    tokens: rt.tokens,
    kill: rt.kill,
    planner: new FocusedPlanner(new StaticPlanner(500_000, rt.estimates), focus),
    executor,
    context: rt.context,
  });
  const grant = () => ({
    allowedTools: [...rt.tools.names(), ...rt.extensions.bridgedTools().map((t) => t.name)],
    allowedPaths: [dirs.worktrees],
    allowedDomains: [hostOf(githubApiBase), "github.com"],
    grantedSecrets: ghToken ? [SECRET_NAMES.github] : [],
    maxDepth: 2,
  });
  let sessionsStarted = 0;
  let schedulesSkipped = 0;
  let lastActivity = clock.now();
  const sessionCapFor = async (projectId?: string): Promise<number> => {
    const project = projectId ? await store.project.get(projectId) : null;
    const settings = (project?.settings ?? {}) as { session_cap_usd_micro?: unknown };
    return typeof settings.session_cap_usd_micro === "number" && settings.session_cap_usd_micro > 0
      ? settings.session_cap_usd_micro
      : config.sessionCapUsdMicro;
  };
  const runSession = async (
    req: CloudStartRequest,
    onStarted?: () => void,
  ): Promise<SessionResult> => {
    if (!provider)
      throw new ForerunnerError("provider_auth", "no model credential in the runner vault");
    // S.14: this runner's vault and billing source serve its own agent only, whatever asked.
    if (req.agentId !== agent.id) {
      throw new ForerunnerError(
        "validation",
        `forbidden: agent ${req.agentId} is not this runner's agent (${agent.id})`,
      );
    }
    if (unlock) await unlock.ensureUnlocked(`session (${req.trigger})`);
    const cap = req.budgetUsdMicro ?? (await sessionCapFor(req.projectId));
    sessionsStarted++;
    lastActivity = clock.now();
    try {
      return await sessions.start({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: req.trigger,
        budgetCapUsdMicro: cap,
        ...(req.autonomy !== undefined ? { autonomy: req.autonomy } : {}),
        // The approved plan's id (`StartRequest.planApproved`, from the inbox trigger): the
        // runner runs the plan only while it is still that plan (ADR 0053).
        ...(req.planApproved ? { planApproved: req.planApproved } : {}),
        appVersion: config.version,
        runner: "cloud",
        deviceId: device.id,
        grant: grant(),
        onEvent: (type, payload) => {
          if (type === "session.started") onStarted?.();
          rt.events.emit("session", {
            type,
            payload,
            agentId: req.agentId,
            projectId: req.projectId,
          });
        },
      });
    } finally {
      lastActivity = clock.now();
      maybeRestart();
    }
  };

  // 6. Precedence: a PC daemon that is online wins; schedules and inbox triggers then stay
  //    with the PC.
  const presence = new PcPresence({
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    pcOnlineMs: config.pcOnlineMs,
  });
  const PC_RULE_TRIGGERS: ReadonlySet<SessionTriggerKind> = new Set([
    "schedule",
    "manual",
    "message",
  ]);
  // `scheduler.request` answers "started" before `start` below has looked at the PC: callers
  // that must know what the start decided (inbox triggers, which may not forget an item the
  // PC rule dropped; `startSession`) register here and `requestDecided` waits for the decision.
  const decisions = new WeakMap<StartRequest, (outcome: InboxRequestOutcome) => void>();
  const decide = (req: StartRequest, outcome: InboxRequestOutcome) => {
    const resolve = decisions.get(req);
    if (!resolve) return;
    decisions.delete(req);
    resolve(outcome);
  };
  const scheduler = new Scheduler(
    {
      clock,
      start: async (req) => {
        const r = req as CloudStartRequest;
        if (!r.force && PC_RULE_TRIGGERS.has(r.trigger)) {
          let verdict: PresenceVerdict;
          try {
            verdict = await presence.check();
          } catch (e) {
            decide(req, "failed");
            throw e;
          }
          if (verdict.pcOnline) {
            schedulesSkipped++;
            logger.info("session not started here: a PC daemon is online", {
              trigger: r.trigger,
              reason: verdict.reason,
              deviceId: verdict.deviceId ?? null,
              sessionId: verdict.sessionId ?? null,
            });
            decide(req, "skipped");
            return { skipped: "pc_online", verdict };
          }
        }
        decide(req, "started");
        return runSession(r);
      },
    },
    config.scheduleTickMs,
  );
  /** `scheduler.request` plus the start's decision: "skipped" when the PC rule dropped it. */
  const requestDecided = (req: CloudStartRequest): Promise<InboxRequestOutcome> =>
    new Promise((resolve) => {
      decisions.set(req, resolve);
      scheduler.request(req).then(
        (answer) => {
          if (answer !== "started") decide(req, answer);
        },
        (e: unknown) => {
          logger.warn("session request failed", { trigger: req.trigger, error: errorMessage(e) });
          decide(req, "failed");
        },
      );
    });
  const refreshSchedules = async (): Promise<Schedule[]> => {
    const projects = await store.project.list({ status: "active" }, { limit: 1000 });
    const wanted = new Map<string, Schedule>();
    for (const p of projects) {
      const settings = p.settings as { members?: unknown; [SCHEDULE_SETTINGS_KEY]?: unknown };
      const members = settings.members;
      if (Array.isArray(members) && members.length > 0 && !members.includes(agent.id)) continue;
      const raw = settings[SCHEDULE_SETTINGS_KEY];
      if (!Array.isArray(raw)) continue;
      raw.forEach((entry, index) => {
        const parsed = ProjectScheduleSchema.safeParse(entry);
        if (!parsed.success) {
          logger.warn("ignoring an invalid schedule", { projectId: p.id, index });
          return;
        }
        const s = parsed.data;
        if (s.agentId && s.agentId !== agent.id) return;
        const id = `project:${p.id}:${s.id ?? index}`;
        wanted.set(id, {
          id,
          agentId: agent.id,
          projectId: p.id,
          kind: s.kind,
          time: s.time,
          everyMinutes: s.everyMinutes,
          timezone: s.timezone ?? human.timezone,
          enabled: s.enabled,
        });
      });
    }
    for (const s of scheduler.list()) {
      if (s.id.startsWith("project:") && !wanted.has(s.id)) scheduler.remove(s.id);
    }
    for (const s of wanted.values()) scheduler.add(s);
    return scheduler.list();
  };

  // 7. The kill switch from the shared state (and the local kill file).
  const remote = new RemoteCommandWatcher({
    store,
    clock,
    kill: rt.kill,
    runnerDeviceId: device.id,
    agentId: agent.id,
    humanId: human.id,
    pollMs: config.commandPollMs,
    start: (req) => scheduler.request({ ...req, force: true } as CloudStartRequest),
  });
  const killFile = new KillFileWatcher(rt.kill, clock, dirs.runtime, config.commandPollMs);

  // 7b. Inbox triggers: a peer's message or the human's answer to a session's question starts
  //     a "message" session while no PC is online (the PC rule above applies to it as well).
  const inbox =
    config.inboxPollMs > 0
      ? new InboxTrigger({
          store,
          clock,
          agentId: agent.id,
          isActive: () =>
            scheduler.isActive(agent.id) ||
            rt.kill.activeCount({ agentId: agent.id }) > 0 ||
            rt.kill.isFrozen({ agentId: agent.id }),
          shouldDefer: async () => (await presence.check()).pcOnline,
          request: (req) => requestDecided(req as CloudStartRequest),
          pollMs: config.inboxPollMs,
          since: startedAt,
          deferMs: config.pcOnlineMs,
        })
      : null;

  // 8. Email commands: the mailbox watcher starts cloud sessions through this port with the
  //    per-email cap and the email autonomy level; the ack goes out as soon as the session row
  //    exists, the summary when the session ends. A busy agent fails fast (the handler tells the
  //    human the task waits for the next session).
  let emailWatch: EmailWatch | null = null;
  const cloudPort: StartCloudSessionPort = {
    start: async (req: CloudSessionRequest): Promise<CloudSessionStarted> => {
      if (req.humanId !== human.id || req.agentId !== agent.id) {
        throw new ForerunnerError("validation", "this runner serves another human's agent");
      }
      if (rt.kill.isFrozen({ agentId: agent.id })) {
        throw new ForerunnerError("killed", "the kill switch is active; resume it first");
      }
      const t0 = clock.now();
      let startedResolve: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      focus.set(req.agentId, req.taskId);
      const done = runSession(
        {
          agentId: req.agentId,
          projectId: req.projectId,
          trigger: "email",
          reason: `email ${req.source.messageId ?? "(no id)"}`,
          budgetUsdMicro: req.capUsdMicro,
          autonomy: req.autonomyLevel,
          force: true,
        },
        startedResolve,
      );
      done.then(
        async (result) => {
          const task = await store.task.get(req.taskId);
          await emailWatch?.completed({
            sessionId: result.sessionId,
            summary: result.summary,
            prUrls: task?.pr_url ? [task.pr_url] : [],
            logUrl: `forerunner://sessions/${result.sessionId}`,
            costUsdMicro: result.spentUsdMicro,
          });
        },
        (e: unknown) => {
          focus.delete(req.agentId);
          logger.warn("email session failed", { taskId: req.taskId, error: errorMessage(e) });
        },
      );
      await Promise.race([started, done.then(() => undefined)]);
      const [row] = await store.session.list(
        { agent_id: req.agentId, trigger: "email" },
        { orderBy: "created_at desc", limit: 1 },
      );
      if (!row || Date.parse(row.created_at) < t0 - 1_000) {
        throw new ForerunnerError("internal", "the email session row was not found");
      }
      return {
        sessionId: row.id,
        startsAt: clock.nowIso(),
        logUrl: `forerunner://sessions/${row.id}`,
      };
    },
  };
  if (provider) {
    emailWatch = new EmailWatch({
      store,
      clock,
      vault,
      provider,
      agentId: agent.id,
      humanId: human.id,
      cloud: cloudPort,
      pricing,
      estimateModel: workingModel,
      classifierModel: modelIdFor("haiku", provider.name),
      rates: { chfPerUsd: async () => rt.chfPerUsd() },
      dataDir: dirs.data,
      pollIntervalMs: config.mail.checkIntervalMs,
      push: config.mail.push,
      verifier: deps.verifier,
      verifierKind: config.mail.verifier,
      trustedAuthservIds: config.mail.trustedAuthservIds,
      mailboxFactory: deps.mailboxFactory,
      onOutcome: deps.onEmailOutcome,
    });
  } else {
    logger.warn(
      "no model provider: sessions and email commands are refused until a credential exists",
    );
  }

  // 9. Heartbeat, idle lock, restart-after-forget.
  let ready = false;
  let stopped = false;
  const cancelTimers: (() => void)[] = [];
  const every = (ms: number, fn: () => Promise<void> | void) => {
    let cancel: (() => void) | null = null;
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (e) {
        logger.warn("periodic task failed", { error: errorMessage(e) });
      }
      if (!stopped) cancel = clock.setTimeout(tick, ms);
    };
    cancel = clock.setTimeout(tick, ms);
    cancelTimers.push(() => cancel?.());
  };
  function maybeRestart(): void {
    if (!restartPending || stopped || !rtRef) return;
    if (rtRef.kill.activeCount({ agentId: agent.id }) > 0) return;
    const reason = restartPending;
    restartPending = null;
    logger.warn("vault key forgotten and the runner is idle; asking the supervisor to restart", {
      reason,
    });
    deps.onRestart?.(reason);
  }
  every(config.heartbeatMs, async () => {
    await store.device.seen(device.id);
    await presence.check();
  });
  every(config.scheduleTickMs, async () => {
    await refreshSchedules();
  });
  if (unlock && config.unlock.idleLockMs > 0) {
    every(Math.max(1_000, Math.min(config.unlock.idleLockMs, 60_000)), () => {
      if (
        !unlock.state.locked &&
        rt.kill.activeCount({ agentId: agent.id }) === 0 &&
        clock.now() - lastActivity >= config.unlock.idleLockMs
      )
        unlock.lock("idle");
    });
  }

  // 10. Health route and readiness file.
  const status = async (): Promise<RunnerStatus> => ({
    runnerId: config.runnerId,
    version: config.version,
    uptimeMs: clock.now() - startedAt,
    stateUrl: redactStoreUrl(config.stateUrl),
    human: { id: human.id, name: human.name },
    agent: { id: agent.id, name: agent.name },
    deviceId: device.id,
    vault: {
      backend: vault.backend,
      ...(unlock
        ? unlock.state
        : {
            locked: false,
            unlockedUntil: null,
            cachedKey: false,
            pendingRequestId: null,
            attempts: 0,
            refusals: 0,
          }),
    },
    billing: { sourceId: billing.sourceId, kind: billing.kind },
    provider: provider?.name ?? "none",
    pcOnline: presence.lastVerdict,
    activeSessions: rt.kill.activeCount({ agentId: agent.id }),
    killActive: rt.kill.isFrozen({ agentId: agent.id }),
    schedules: scheduler.list().length,
    sessionsStarted,
    schedulesSkipped,
    email: emailWatch?.status ?? {
      state: "disabled",
      reason: "no model provider",
      handled: 0,
      lastMessageAt: null,
    },
    remote: remote.stats,
    inbox: inbox?.stats ?? null,
    ready,
  });
  const health = await startHealthServer({
    host: config.health.host,
    port: config.health.port,
    status,
    ready: () => ready,
  });

  // 11. Go.
  await refreshSchedules();
  await presence.check();
  unlock?.start();
  scheduler.start();
  remote.start();
  killFile.start();
  inbox?.start();
  if (emailWatch) await emailWatch.start();
  ready = true;
  writeReadyFile(config.health.readyFile, {
    runnerId: config.runnerId,
    pid: process.pid,
    healthUrl: health.url,
    readyAt: clock.nowIso(),
    version: config.version,
  });
  logger.info("runner ready", {
    runnerId: config.runnerId,
    human: human.name,
    agent: agent.name,
    deviceId: device.id,
    billing: billing.kind,
    provider: provider?.name ?? "none",
    schedules: scheduler.list().length,
    email: emailWatch?.status.state ?? "disabled",
    inbox: inbox ? `every ${config.inboxPollMs} ms` : "off",
    health: health.url,
  });

  return {
    config,
    runnerId: config.runnerId,
    dirs,
    clock,
    rt,
    store,
    human,
    agent,
    device,
    billing,
    scheduler,
    presence,
    unlock,
    remote,
    email: emailWatch,
    inbox,
    health,
    startSession: async (req) => {
      const outcome = await requestDecided({
        agentId: req.agentId ?? agent.id,
        projectId: req.projectId,
        trigger: req.trigger ?? "manual",
        reason: req.reason ?? "runner start request",
        ...(req.budgetUsdMicro ? { budgetUsdMicro: req.budgetUsdMicro } : {}),
        ...(req.autonomy !== undefined ? { autonomy: req.autonomy } : {}),
        ...(req.force ? { force: true } : {}),
      } as CloudStartRequest);
      return outcome === "skipped" ? "deferred" : outcome;
    },
    refreshSchedules,
    status,
    async stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      scheduler.stop();
      remote.stop();
      killFile.stop();
      inbox?.stop();
      unlock?.stop();
      for (const c of cancelTimers) c();
      await emailWatch?.stop();
      await health.close();
      removeReadyFile(config.health.readyFile);
      await rt.close();
      logger.info("runner stopped", { runnerId: config.runnerId });
    },
  };
}

function noProvider(): ModelProvider {
  const fail = () => {
    throw new ForerunnerError("provider_auth", "no model credential in the runner vault");
  };
  return {
    name: "none",
    listModels: async () => [],
    countTokens: (t) => Math.ceil(t.length / 4),
    stream: async function* () {
      yield* [];
      fail();
    },
    complete: async () => fail(),
  };
}
