import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import {
  BillingRouter,
  BUILTIN_PRICING,
  CapChecker,
  CostLedger,
  FixedRateSource,
  loadPricing,
  PRICING_FILE_NAME,
  type RateSource,
} from "@forerunner/billing";
import {
  type email as agentEmail,
  cloudflare,
  type GitHost,
  GitHubHost,
  MemoryGitHost,
  MIRROR_APPROVE_OPTION,
  type MirrorApprovalAnswer,
  type MirrorApprovalRequest,
  type MirrorHumanPort,
  type MirrorRunResult,
  mirrorSettingsOf,
  mirrorStartHandler,
  ProjectsMirror,
  PrTaskExecutor,
  scheduleMirror,
} from "@forerunner/capabilities";
import {
  type AppDirs,
  appDirs,
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  type Platform,
  systemClock,
} from "@forerunner/platform";
import {
  type JsonValue,
  openStore,
  REVIEW_VERDICTS,
  type ReviewVerdict,
  type StateStore,
} from "@forerunner/state";
import { openVault, parseSecretRef, SecretResolver, type Vault } from "@forerunner/vault";
import { LoopAgentDriver } from "../agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../agent/tools.ts";
import {
  DEFAULT_HEADROOM_PORT,
  type HeadroomPort,
  headroomFromEnv,
  ManagedHeadroomProcess,
} from "../context/headroom.ts";
import { ContextManager } from "../context/manager.ts";
import { contextSettingsFrom } from "../context/pipeline.ts";
import { ConversationAgent } from "../conversation/agent.ts";
import type { EnforcementHooks, HookDeps, RunContext } from "../enforcement/hooks.ts";
import { KillFileWatcher } from "../enforcement/killfile.ts";
import { KillSwitch } from "../enforcement/killswitch.ts";
import type { CapDecision, CapScope, CapsPort } from "../enforcement/ports.ts";
import { TokenIssuer } from "../enforcement/token.ts";
import { EstimateModel, kindOfTask } from "../estimates/model.ts";
import { HumanRequestExtensionApprovals } from "../extensions/approvals.ts";
import { catalogUrlFromEnv, ExtensionCatalog, loadBuiltinCatalog } from "../extensions/catalog.ts";
import { ExtensionGate, GatedEnforcementHooks } from "../extensions/gate.ts";
import {
  DefaultMcpConnectorFactory,
  isBridgedTool,
  type McpConnectorFactory,
} from "../extensions/mcp.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import { CommandLoop, sessionCapFromSettings, sessionCommandPorts } from "../loop/commands.ts";
import { CriticLoop } from "../loop/critic.ts";
import {
  isMemoryConsolidationRequest,
  MemoryLoop,
  scheduleMemoryConsolidation,
} from "../loop/memory.ts";
import { LoopEvalRunner } from "../models/eval-runner.ts";
import {
  FetchPriceListSource,
  type PriceListSource,
  priceListUrlFromEnv,
  UnconfiguredPriceListSource,
} from "../models/price-list.ts";
import { FileModelSettingsStore } from "../models/settings.ts";
import {
  type EvalRunnerPort,
  isModelWatchRequest,
  ModelWatch,
  StateModelWatchApprovals,
  scheduleModelWatch,
} from "../models/watch.ts";
import {
  bindProducers,
  DesktopChannel,
  EmailChannel,
  NotificationEmitter,
  Notifier,
  notificationConfigFrom,
  type ProducerHooks,
  producers,
  SignalChannel,
  TelegramChannel,
  type TelegramFetch,
} from "../notifications/index.ts";
import { AnthropicMessagesProvider } from "../provider/anthropic.ts";
import { ProviderRegistry } from "../provider/registry.ts";
import type { ModelProvider } from "../provider/types.ts";
import { loadRegistry, type Registry, resolveRegistryDir } from "../registry/index.ts";
import { detectSandboxEngine, type EngineDetection } from "../sandbox/detect.ts";
import type { RunFn, WhichFn } from "../sandbox/types.ts";
import { LoopTaskExecutor, type RunSandboxPort, type SpecialistSpec } from "../session/executor.ts";
import { type BlockedSyncResult, syncBlockedByFindings } from "../session/findings.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../session/runner.ts";
import { Scheduler, type StartRequest } from "../session/triggers.ts";
import { readConfig, SECRET_NAMES, type SetupConfig } from "../setup/wizard.ts";
import { composeUpdateManager } from "../update/compose.ts";
import { readUpdateConfig, UpdateConfig } from "../update/config.ts";
import type { UpdateManager } from "../update/install.ts";
import type { Restarter } from "../update/ports.ts";
import { pricingFor, StateLedgerStore, stateSources } from "../wiring/billing-ports.ts";
import {
  AuditedNotificationHumans,
  notificationEmailPort,
  SecretCheckedChannel,
} from "../wiring/notification-ports.ts";
import { statePorts } from "../wiring/state-ports.ts";
import { DaemonRestarter, processExit, type RestartRequestFile } from "./restart.ts";
import { DetectingSandboxPort } from "./sandbox-port.ts";
import { ShellPresence } from "./shells.ts";
import { fileTools } from "./tools.ts";

/**
 * Composition root for one install: opens the store and the vault, picks the model provider,
 * wires enforcement, sessions, the conversation agent, the scheduler and the kill switch. The
 * daemon server, the CLI and the tests all go through this so there is exactly one wiring.
 */
export interface ComposeOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: AppDirs;
  config?: SetupConfig | null;
  clock?: Clock;
  stateUrl?: string;
  vault?: Vault;
  /** Injected model provider (tests); otherwise Anthropic from the vault credential. */
  provider?: ModelProvider;
  /** Injected git host (tests); otherwise GitHub from the vault token, else an in-memory host. */
  gitHost?: GitHost;
  /** Injected Headroom port (tests); otherwise the adapter from FORERUNNER_HEADROOM_* (ADR 0003). */
  headroom?: HeadroomPort;
  registryDir?: string;
  chfPerUsd?: number;
  rates?: RateSource;
  appVersion?: string;
  identity?: { humanName?: string; email?: string; timezone?: string; agentName?: string };
  /** MCP connector factory (tests use an in-memory transport). */
  connectors?: McpConnectorFactory;
  /** Extension catalog; default: the built-in one plus FORERUNNER_EXTENSION_CATALOG_URL. */
  catalog?: ExtensionCatalog;
  /** fetch for the release feed, the price list and the remote catalog (tests use 127.0.0.1). */
  fetchImpl?: typeof fetch;
  /** Eval runner for the model watch; default: the registry's eval sets through the loop driver. */
  evalRunner?: EvalRunnerPort;
  /** Price list URL; default FORERUNNER_PRICE_LIST_URL, else no price list (nothing is guessed). */
  priceListUrl?: string;
  /** Sandbox port for task commands; default: container when reachable, else the process stand-in. */
  sandbox?: RunSandboxPort;
  /** Pre-computed engine detection (tests never probe docker). */
  sandboxDetection?: EngineDetection;
  sandboxRun?: RunFn;
  sandboxWhich?: WhichFn;
  /** "Update and restart"; default: write the restart request and exit with RESTART_EXIT_CODE. */
  restarter?: Restarter;
  /** How the daemon ends the process on a restart request (tests record the code). */
  exit?: (code: number) => void;
  updateConfig?: UpdateConfig;
  /**
   * Start the background services: connect the enabled connectors, run the scheduler and the
   * kill-file watcher. Default true (the daemon); CLI one-shots pass false and only use the
   * composed objects.
   */
  startServices?: boolean;
  /**
   * Notification channel seams (tests): the OS tools the desktop and Signal channels run, the
   * fetch the Telegram channel uses, the platform, and the agent mailbox the email channel
   * sends through. Production uses the platform's `run`/`which`, `globalThis.fetch` and
   * `ImapSmtpMailbox` from the agent's email settings. `osNotifier` decides whether the
   * desktop channel falls back to the OS notifier (`notify-send`, a PowerShell toast) when no
   * shell holds `/events`; default: on for a set-up install (a `config.json` exists) unless
   * `FORERUNNER_OS_NOTIFY=0`, and `FORERUNNER_OS_NOTIFY=1` turns it on anywhere (ADR 0038).
   */
  notifications?: {
    run?: RunFn;
    which?: WhichFn;
    platform?: Platform;
    fetch?: TelegramFetch;
    mailboxFactory?: (config: agentEmail.MailboxConfig) => Promise<agentEmail.Mailbox>;
    osNotifier?: boolean;
  };
}

/** The runtime bus's `session` events as `startSession` emits them. */
interface SessionBusEvent {
  type: string;
  payload?: Record<string, unknown>;
  agentId?: string;
  projectId?: string;
}

function isReviewVerdict(v: string): v is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(v);
}

/** `FORERUNNER_OS_NOTIFY`: "1" forces the OS notifier on, "0" off; else on for a set-up install. */
export function osNotifierEnabled(
  env: NodeJS.ProcessEnv,
  config: SetupConfig | null,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const flag = env.FORERUNNER_OS_NOTIFY?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return config !== null;
}

/** What a manual mirror sync came back with: the run, or the approval it waits on. */
export type MirrorSyncOutcome =
  | { state: "done"; result: MirrorRunResult }
  | { state: "pending"; projectId: string; requestId: string };

export interface RuntimeApp {
  dirs: AppDirs;
  config: SetupConfig | null;
  clock: Clock;
  store: StateStore;
  vault: Vault;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  driver: LoopAgentDriver;
  providers: ProviderRegistry;
  provider: ModelProvider | null;
  registry: Registry;
  tools: ToolRegistry;
  executor: TaskExecutor;
  runner: SessionRunner;
  scheduler: Scheduler;
  conversation: ConversationAgent | null;
  gitHost: GitHost;
  human: { id: string; name: string; timezone: string };
  agent: { id: string; name: string };
  billingSourceId: string;
  chfPerUsd: () => number;
  /** Context layer per session: policy, Headroom probe, pipeline, savings (ADR 0003). */
  context: ContextManager;
  /** The billing ledger over the store; the cost view prices savings through it. */
  costLedger: CostLedger;
  events: EventEmitter;
  appVersion: string;
  startedAt: number;
  /** Extensions panel backend; its gate sits in front of every tool call. */
  extensions: ExtensionRegistry;
  gate: ExtensionGate;
  /** The critic in the loop (spec H): task reviews at their tier, the session review. */
  critic: CriticLoop;
  /** The critic AgentRow (kind `critic`): author of reviews, findings and critic lessons. */
  criticAgent: { id: string; name: string };
  /** Memory in the loop (spec G): recall under budget, lessons at session end, consolidation, views. */
  memory: MemoryLoop;
  /** The command registry (spec Q): the only way chat, voice, the UI and the phone change state. */
  commands: CommandLoop;
  /** Signed updates (spec M) over this process's store. */
  updates: UpdateManager;
  updateConfig: UpdateConfig;
  restarter: Restarter;
  /** Weekly model watch (spec D) on the registered providers. */
  modelWatch: ModelWatch;
  /** Estimate-versus-actual learning the planner consumes (spec I). */
  estimates: EstimateModel;
  /** One-way GitHub Projects mirror. */
  mirror: ProjectsMirror;
  sandbox: { port: RunSandboxPort; detection: EngineDetection };
  /**
   * Notifications (spec R.6, ADR 0017): the one notifier behind the daemon routes, and the
   * producer hooks bound to it (what the request path, the session runner, the kill switch, the
   * updater and the extension approvals call).
   */
  notifier: Notifier;
  notifications: ProducerHooks;
  /**
   * The toast-showing shells holding `/events` (`server.ts` attaches the streams that qualify,
   * `shells.ts` says which do); the desktop channel falls back to the OS notifier at zero.
   */
  shells: ShellPresence;
  /** The tool registry a run starts with: built-in tools plus the bridged extension tools. */
  toolsForRun(): ToolRegistry;
  /**
   * Apply answered human requests: extension grants, model watch decisions, memory
   * consolidations, and the rework/accept/cancel answers for tasks blocked by open findings.
   */
  syncApprovals(): Promise<{
    extensions: { approved: string[]; denied: string[] };
    modelWatch: number;
    memory: { applied: number; skipped: number };
    findings: BlockedSyncResult;
  }>;
  /** Add or drop mirror schedules after a project's settings changed. */
  refreshMirrorSchedules(): Promise<string[]>;
  /**
   * Run the mirror for a project now. Resolves with the run, or with the open approval request
   * as soon as the mirror asks the human (the run goes on in the background and finishes when
   * the request is answered in the inbox); a second call while a run is in flight joins it.
   */
  mirrorSync(projectId: string, opts?: { full?: boolean }): Promise<MirrorSyncOutcome>;
  close(): Promise<void>;
}

const DEFAULT_SESSION_CAP_USD_MICRO = 6_250_000; // CHF 5 at 0.8 CHF/USD

export function specialistSpecFrom(
  registry: Registry,
): (name: string) => SpecialistSpec | undefined {
  return (name) => {
    const d = registry.specialists.get(name);
    if (!d?.runnable) return undefined;
    return {
      name: d.name,
      prompt: d.prompt,
      promptVersion: d.promptVersion,
      defaultTier: d.default_tier,
      defaultEffort: d.default_effort,
      allowedTools: d.allowed_tools,
      allowedDomains: d.allowed_domains,
      maxBudgetUsdMicro: Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: d.max_turns,
      timeoutMs: d.timeout_minutes * 60_000,
    };
  };
}

/** Outer caps per call: the human's monthly cap and the project's budget looked up live. */
class DynamicCaps implements CapsPort {
  private readonly cache = new Map<
    string,
    { at: number; projectUsdMicro: number; monthUsdMicro: number }
  >();
  constructor(
    private readonly store: StateStore,
    private readonly checker: CapChecker,
    private readonly clock: Clock,
  ) {}
  async check(
    scope: CapScope,
    estimateUsdMicro: number,
    opts: { phase: "work" | "review" },
  ): Promise<CapDecision> {
    const key = `${scope.humanId}:${scope.projectId ?? ""}`;
    let caps = this.cache.get(key);
    if (!caps || this.clock.now() - caps.at > 60_000) {
      const human = await this.store.human.get(scope.humanId);
      const project = scope.projectId ? await this.store.project.get(scope.projectId) : undefined;
      caps = {
        at: this.clock.now(),
        monthUsdMicro: human?.monthly_cap_usd_micro ?? 0,
        projectUsdMicro: project?.budget_usd_micro ?? 0,
      };
      this.cache.set(key, caps);
    }
    const r = await this.checker.check(scope, estimateUsdMicro, {
      phase: opts.phase,
      caps: {
        monthUsdMicro: caps.monthUsdMicro > 0 ? caps.monthUsdMicro : Number.MAX_SAFE_INTEGER,
        projectUsdMicro: caps.projectUsdMicro > 0 ? caps.projectUsdMicro : undefined,
        sessionUsdMicro: Number.MAX_SAFE_INTEGER, // the session cap is enforced in-process by SessionBudget
      },
    });
    return {
      decision: r.decision,
      level: r.level ?? undefined,
      spentUsdMicro: r.spent,
      capUsdMicro: r.cap,
      remainingUsdMicro: r.remaining,
      message: r.message,
    };
  }
}

export async function composeRuntime(opts: ComposeOptions = {}): Promise<RuntimeApp> {
  const logger = log("compose");
  const env = opts.env ?? process.env;
  const dirs = opts.dirs ?? appDirs({ env });
  const config = opts.config === undefined ? readConfig(dirs) : opts.config;
  const clock = opts.clock ?? systemClock;
  const stateUrl =
    opts.stateUrl ??
    env.FORERUNNER_STATE_URL ??
    config?.stateUrl ??
    `sqlite:${join(dirs.data, "state.sqlite")}`;
  const store = await openStore({ url: stateUrl, clock });
  const vault = opts.vault ?? (await openVault({ profile: config?.profile ?? "default", env }));
  const events = new EventEmitter();
  events.setMaxListeners(100);

  // Identity: the first human and their principal agent are created on first run.
  const humans = await store.human.list(undefined, { limit: 1 });
  const human =
    humans[0] ??
    (await store.human.insert({
      name: opts.identity?.humanName ?? config?.humanName ?? env.USERNAME ?? env.USER ?? "me",
      email: opts.identity?.email ?? "",
      timezone: opts.identity?.timezone ?? config?.timezone ?? "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: Math.round(150 / (opts.chfPerUsd ?? 0.8)) * 1_000_000,
      locale: "en",
    }));
  const principals = await store.agent.principals(human.id);
  const agent =
    principals[0] ??
    (await store.agent.insert({
      name: opts.identity?.agentName ?? env.FORERUNNER_AGENT_NAME ?? "Alice",
      owner_human_id: human.id,
      model_config: {},
      memory_location: join(dirs.data, "memory", "agents"),
      status: "active",
      kind: "principal",
    }));
  // The critic is its own agent (spec H.1): a clean context, its own token, its own rows.
  const criticAgent =
    (
      await store.agent.list({ owner_human_id: human.id, kind: "critic" } as never, { limit: 1 })
    )[0] ??
    (await store.agent.insert({
      name: "Critic",
      owner_human_id: human.id,
      model_config: {},
      memory_location: join(dirs.data, "memory", "critic"),
      status: "active",
      kind: "critic",
    }));

  // Model provider: injected, else Anthropic from the vault, else none (chat and sessions refuse).
  const providers = new ProviderRegistry();
  let provider: ModelProvider | null = opts.provider ?? null;
  if (!provider) {
    const oauth = await vault.get(SECRET_NAMES.anthropicOauth);
    const key = await vault.get(SECRET_NAMES.anthropic);
    if (oauth || key) {
      provider = new AnthropicMessagesProvider({
        apiKey: key ?? undefined,
        authToken: key ? undefined : (oauth ?? undefined),
        baseURL: config?.anthropicApiBase,
        defaultHeaders: config?.anthropicWorkspaceId
          ? { "anthropic-workspace-id": config.anthropicWorkspaceId }
          : undefined,
        clock,
      });
    }
  }
  if (provider) providers.register(provider);

  // Billing: sources from the store (seeded from the vault on first run), caps, ledger, pricing.
  const sources = await stateSources(store)(human.id);
  let billingSourceId = sources[0]?.id ?? "";
  if (!billingSourceId) {
    const hasOauth = await vault.has(SECRET_NAMES.anthropicOauth);
    const hasKey = await vault.has(SECRET_NAMES.anthropic);
    if (hasOauth)
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "subscription",
          label: "Claude subscription",
          credential_ref: SECRET_NAMES.anthropicOauth,
          limits: { planShareCap: 0.95 },
          enabled: true,
          priority: 1,
        })
      ).id;
    else if (hasKey)
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "api_key",
          label: "Anthropic API key",
          credential_ref: SECRET_NAMES.anthropic,
          limits: {},
          enabled: true,
          priority: 2,
        })
      ).id;
    else
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "fake",
          label: "No credential (fake provider)",
          credential_ref: "none",
          limits: {},
          enabled: true,
          priority: 9,
        })
      ).id;
  }
  void BillingRouter;
  const rates =
    opts.rates ?? new FixedRateSource(opts.chfPerUsd ?? Number(env.FORERUNNER_CHF_PER_USD ?? 0.8));
  let lastRate = opts.chfPerUsd ?? 0.8;
  const chfPerUsd = () => lastRate;
  void rates.chfPerUsd(clock.nowIso()).then(
    (q) => {
      lastRate = typeof q === "number" ? q : (q as { rate: number }).rate;
    },
    () => undefined,
  );
  const ledgerStore = new StateLedgerStore(store);
  const costLedger = new CostLedger({
    sink: ledgerStore,
    query: ledgerStore,
    runs: ledgerStore,
    sessions: ledgerStore,
    rates,
    clock,
    pricing: await loadPricing(join(dirs.config, PRICING_FILE_NAME)),
  });

  // Context layer (ADR 0003): the native pipeline is always on; the Headroom proxy is probed
  // only for projects whose settings.context.compression is "headroom", never assumed.
  let headroom: HeadroomPort;
  if (opts.headroom) headroom = opts.headroom;
  else {
    const resolved = headroomFromEnv(env, { clock });
    if (resolved.error) logger.warn("headroom disabled", { error: resolved.error.message });
    headroom = resolved.port;
  }
  const managedHeadroom =
    !opts.headroom && env.FORERUNNER_HEADROOM_MANAGED === "1" && headroom.url
      ? new ManagedHeadroomProcess({
          port: Number(new URL(headroom.url).port) || DEFAULT_HEADROOM_PORT,
          logDir: dirs.logs,
          env,
        })
      : null;
  if (managedHeadroom && !managedHeadroom.start())
    logger.warn("headroom proxy could not be started; continuing without it");
  const context = new ContextManager({
    clock,
    headroom,
    originalsDir: join(dirs.cache, "context"),
    countTokens: (t) => (provider ?? unavailableProvider()).countTokens(t),
    settingsFor: async (projectId) =>
      contextSettingsFrom(projectId ? (await store.project.get(projectId))?.settings : undefined),
    onNotice: (sessionId, sel) =>
      logger.warn("headroom not in use", { sessionId, notice: sel.notice }),
  });
  const checker = new CapChecker({
    query: ledgerStore,
    clock,
    caps: { monthUsdMicro: Number.MAX_SAFE_INTEGER, sessionUsdMicro: Number.MAX_SAFE_INTEGER },
  });
  const caps = new DynamicCaps(store, checker, clock);

  // Enforcement.
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens, async (scope) => {
    // Freeze claims: release every claim held by the stopped agent(s) so peers can continue.
    const agents =
      scope === "all"
        ? (await store.agent.list(undefined, { limit: 100 })).map((a) => a.id)
        : scope.agentId
          ? [scope.agentId]
          : [];
    for (const id of agents)
      for (const t of await store.task.claimedBy(id))
        await store.task.releaseClaim(t.id, id, "kill switch").catch(() => undefined);
  });
  // A managed proxy dies with the global stop, like every other child process (ADR 0003).
  managedHeadroom?.bindKillSwitch(kill);
  const ports = statePorts(store, { chfPerUsd });
  const secrets = new SecretResolver(vault);

  // Extensions (spec K, L): the registry behind the panel and the gate in front of every tool
  // call. A disabled, pending, removed or errored extension's tool is refused in code.
  const catalog =
    opts.catalog ??
    new ExtensionCatalog(loadBuiltinCatalog(), {
      remoteUrl: catalogUrlFromEnv(env),
      fetch: opts.fetchImpl,
    });
  const extensions = new ExtensionRegistry({
    extensions: store.extension,
    audit: store.auditLog,
    clock,
    catalog,
    approvals: new HumanRequestExtensionApprovals(store.humanRequest),
    connectors: opts.connectors ?? new DefaultMcpConnectorFactory(),
    secrets,
    tokens,
    fetch: opts.fetchImpl,
    chfPerUsd,
    // Capability modules that charge through the ledger name the extension in the
    // `specialist` column as `extension:<id>`. Bridged MCP calls report no price of their
    // own, so a connector's cost reads 0 until a capability module charges through the ledger
    // (runtime.md, "Extension cost").
    ledgerCost: async (id) => {
      const key = `extension:${id}`;
      const buckets = await store.costLedger.breakdown("specialist");
      return buckets.find((b) => b.key === key)?.usd_micro ?? 0;
    },
    events: (e) => events.emit("extension", e),
  });
  const gate = new ExtensionGate({ registry: extensions, clock, audit: store.auditLog });
  const hookDeps: HookDeps = {
    tokens,
    caps,
    secrets,
    kill,
    clock,
    ledger: ports.ledger,
    audit: ports.audit,
    approvals: ports.approvals,
  };
  const hooks = new DaemonHooks(hookDeps, gate, extensions);
  const driver = new LoopAgentDriver({ hooks, kill, clock });

  // Registry and tools. A run starts with the built-in tools plus whatever the enabled
  // connectors bridge at that moment; the gate covers runs already in flight.
  const registryDir =
    opts.registryDir ?? env.FORERUNNER_REGISTRY_DIR ?? resolveRegistryDir(env).dir;
  const tools = fileTools();
  // Cloudflare deploys (spec J.9, J.10, S.5, S.6, ADR 0035): the four tools go through the
  // same hooks and gate as every other tool; the deployer reads `project.settings.cloudflare`
  // per call, resolves the token by reference from the vault and asks the human through
  // `human_request` rows (production below autonomy 4, money at every level).
  cloudflare.registerCloudflareTools(
    tools,
    cloudflare.cloudflareToolDeps({
      projects: store.project,
      vault,
      approvals: new cloudflare.HumanRequestCloudflareApprovals(store.humanRequest, clock),
      audit: store.auditLog,
      clock,
      fetchImpl: opts.fetchImpl,
    }),
  );
  const registry = loadRegistry(registryDir, { toolNames: tools.names() });
  const specialists = specialistSpecFrom(registry);
  const toolsForRun = (): ToolRegistry => {
    const out = new ToolRegistry();
    for (const name of tools.names()) {
      const t = tools.get(name);
      if (t) out.register(t);
    }
    for (const t of extensions.bridgedTools()) {
      if (!out.get(t.name)) out.register(t);
    }
    return out;
  };

  // Sandbox (ADR 0007): a container when an engine is reachable, else the process stand-in;
  // the health view reports which. Detection is probed once here (cached per process).
  const sandboxDetection =
    opts.sandboxDetection ??
    (await detectSandboxEngine({ env, clock, run: opts.sandboxRun, which: opts.sandboxWhich }));
  const sandboxPort: RunSandboxPort =
    opts.sandbox ??
    new DetectingSandboxPort({
      env,
      clock,
      store,
      audit: store.auditLog,
      detection: sandboxDetection,
      run: opts.sandboxRun,
      which: opts.sandboxWhich,
    });

  // Estimates (spec I): learned from finished tasks in the store; cold start from the registry.
  const estimates = await EstimateModel.fromStore(store, {
    defaults: (name) => {
      const d = registry.specialists.get(name);
      return d ? { maxBudgetUsd: d.max_budget_usd, timeoutMinutes: d.timeout_minutes } : undefined;
    },
  });

  // Git host and the PR executor.
  const ghToken = await vault.get(SECRET_NAMES.github);
  const gitHost: GitHost =
    opts.gitHost ??
    (ghToken
      ? new GitHubHost({ token: ghToken, baseUrl: config?.githubApiBase, clock })
      : new MemoryGitHost(human.name));
  const appVersion = opts.appVersion ?? env.FORERUNNER_VERSION ?? "0.1.0";

  // Memory (spec G): one root under the data directory; lessons per agent, critic and shared.
  const memory = new MemoryLoop({
    store,
    clock,
    root: join(dirs.data, "memory"),
    humanId: human.id,
  });
  // The critic (spec H): the registry critic prompt, the task's tier, the project's ceiling,
  // the diff from the task's worktree, the project's check commands, the session pipeline for
  // the compression bypass, critic memory for repeat findings.
  const critic = new CriticLoop({
    store,
    clock,
    tokens,
    driver,
    providers,
    providerName: provider?.name ?? "none",
    prompt: {
      prompt: registry.critic.prompt,
      promptVersion: registry.critic.promptVersion,
      max_effort: registry.critic.max_effort,
    },
    pricing: (modelId) => pricingForProvider(provider, modelId),
    billingSourceId,
    criticAgentId: criticAgent.id,
    context,
    memory,
    worktreeRoot: dirs.worktrees,
  });
  const makeLoop = (worktree?: string) =>
    new LoopTaskExecutor({
      store,
      clock,
      tokens,
      driver,
      provider: provider ?? unavailableProvider(),
      pricing: provider
        ? pricingForProvider(provider, defaultModelFor(provider))
        : { estimate: () => 0, cost: () => 0 },
      tools,
      toolsFor: toolsForRun,
      sandbox: sandboxPort,
      context,
      billingSourceId,
      specialists,
      memory,
      ...(worktree ? { worktreeFor: async () => worktree } : {}),
      onEvent: (taskId, ev) => events.emit("run", { taskId, ev }),
    });
  const executor = new PrTaskExecutor({
    store,
    clock,
    host: gitHost,
    inner: { execute: (ctx) => makeLoop().execute(ctx), withWorktree: (dir) => makeLoop(dir) },
    repoFor: async (task) => {
      const project = await store.project.get(task.project_id);
      const full = project?.repos[0];
      if (!full?.includes("/")) return null;
      const [owner, name] = full.split("/") as [string, string];
      const info = await gitHost.getRepo({ owner, name });
      return { clone: info.cloneUrl, repo: { owner, name }, base: info.defaultBranch };
    },
    worktreeRoot: dirs.worktrees,
    token: ghToken ?? undefined,
    identity: { name: `${agent.name} (Forerunner)`, email: human.email || "forerunner@localhost" },
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens,
    kill,
    planner: new StaticPlanner(500_000, estimates),
    executor,
    context,
    critic,
    memory,
    // Actual versus estimate at task.finished feeds the next plan (spec I).
    onTaskFinished: ({ task, item, result, durationMs }) => {
      const planned = estimates.estimate({
        specialist: item.specialist,
        risk_tier: task.risk_tier,
        est_cost_usd_micro: task.est_cost_usd_micro,
        budget_usd_micro: task.budget_usd_micro,
      });
      estimates.observe({
        specialist: item.specialist,
        kind: kindOfTask({ risk_tier: task.risk_tier }),
        estimateUsdMicro: item.estimateUsdMicro > 0 ? item.estimateUsdMicro : planned.usdMicro,
        actualUsdMicro: result.costUsdMicro,
        estimateWallMs: planned.wallMs,
        actualWallMs: durationMs,
        at: clock.nowIso(),
        taskId: task.id,
      });
    },
  });

  // GitHub Projects mirror: the host comes from the vault by the secret reference in the
  // project's settings (default secret:github_token) unless a host was injected. The approval
  // port tells the daemon which request a project waits on and wakes on an inbox answer.
  const mirrorApprovals = new DaemonMirrorApprovals(store, clock, { pollMs: 2_000 });
  const mirror = new ProjectsMirror({
    store,
    clock,
    vault,
    githubApiBase: config?.githubApiBase,
    fetchImpl: opts.fetchImpl,
    human: mirrorApprovals,
    humanId: human.id,
    ...(opts.gitHost ? { hostFor: () => gitHost } : {}),
  });
  const mirrorRuns = new Map<string, Promise<MirrorRunResult>>();
  const mirrorSync = async (
    projectId: string,
    o: { full?: boolean } = {},
  ): Promise<MirrorSyncOutcome> => {
    let running = mirrorRuns.get(projectId);
    if (!running) {
      running = mirror.sync(projectId, {
        full: o.full === true,
        trigger: "manual",
        agentId: agent.id,
      });
      mirrorRuns.set(projectId, running);
      running.then(
        (r) => {
          mirrorRuns.delete(projectId);
          events.emit("project", { id: r.projectId });
        },
        (e: unknown) => {
          mirrorRuns.delete(projectId);
          logger.warn("mirror sync failed", { projectId, error: errorMessage(e) });
        },
      );
    }
    // The caller gets whichever comes first: the run, or the approval the mirror filed.
    const pendingNow = mirrorApprovals.pendingRequest(projectId);
    const asked = pendingNow
      ? Promise.resolve(pendingNow)
      : new Promise<string>((resolve) => {
          const off = mirrorApprovals.onAsked((pid, requestId) => {
            if (pid !== projectId) return;
            off();
            resolve(requestId);
          });
          void running?.then(off, off);
        });
    return Promise.race([
      running.then((result) => ({ state: "done" as const, result })),
      asked.then((requestId) => ({ state: "pending" as const, projectId, requestId })),
    ]);
  };

  // Model watch (spec D): providers, pricing (built-in plus <config>/pricing.json), a price
  // list only when one is configured, the eval sets through the loop driver, decisions as
  // human requests. Nothing changes a ladder or a price without a recorded "adopt".
  const modelSettings = new FileModelSettingsStore({
    configDir: dirs.config,
    nowIso: () => clock.nowIso(),
  });
  const priceListUrl = opts.priceListUrl ?? priceListUrlFromEnv(env);
  const priceList: PriceListSource = priceListUrl
    ? new FetchPriceListSource({ url: priceListUrl, fetch: opts.fetchImpl })
    : new UnconfiguredPriceListSource();
  const evalWorkRoot = join(dirs.cache, "model-watch");
  const evalRunner =
    opts.evalRunner ??
    new LoopEvalRunner({
      registry,
      driver,
      providers,
      tokens,
      clock,
      humanId: human.id,
      agentId: agent.id,
      billingSourceId,
      workRoot: evalWorkRoot,
      tools: () => fileTools(),
      // Evals run commands where task runs do: inside a lease over the work directory.
      sandbox: sandboxPort,
    });
  const modelWatch = new ModelWatch({
    clock,
    store,
    providers,
    priceList,
    evals: evalRunner,
    approvals: new StateModelWatchApprovals(store, { agentId: agent.id }),
    settings: modelSettings,
    humanId: human.id,
    agentId: agent.id,
    pricing: BUILTIN_PRICING,
    ...(provider ? { evalProvider: provider.name } : {}),
  });

  // Updates (spec M) over this process's store; a bad update.json is reported, not fatal.
  const restarter =
    opts.restarter ??
    new DaemonRestarter({ dirs, clock, events, exit: opts.exit ?? processExit() });
  let updateConfig: UpdateConfig;
  try {
    updateConfig = opts.updateConfig ?? readUpdateConfig(dirs, env);
  } catch (e) {
    logger.warn("update.json ignored", { error: errorMessage(e) });
    updateConfig = UpdateConfig.parse({});
  }
  const updates = await composeUpdateManager({
    dirs,
    env,
    clock,
    store,
    humanId: human.id,
    runningVersion: appVersion,
    restarter,
    fetchImpl: opts.fetchImpl,
    config: updateConfig,
  });

  // Notifications (spec R.6, E.5, O.8, S.8; ADR 0017, ADR 0038). Channels in the fallback
  // order of ADR 0017; secrets by reference (the Telegram token is resolved through the vault
  // at send time); the human's preferences and quiet hours come from `human.notify_prefs`.
  // Desktop delivery is the SSE event `notification` on `/events` (the shells show the toast,
  // ADR 0031), else the OS notifier when `osNotifierEnabled`; a headless composition
  // (`startServices: false`: the CLI one-shots, the cloud runner) has no shell and no OS
  // notifier, so it carries no desktop channel at all.
  const notifyConfig = notificationConfigFrom(config, env);
  const notificationEmitter = new NotificationEmitter();
  const osTools = { run: opts.notifications?.run, which: opts.notifications?.which };
  const osNotifier = osNotifierEnabled(env, config, opts.notifications?.osNotifier);
  const emailPort = await notificationEmailPort({
    store,
    clock,
    vault,
    agentId: agent.id,
    humanId: human.id,
    mailboxFactory: opts.notifications?.mailboxFactory,
  });
  // Only the `/events` streams that show toasts count as shells (`shells.ts`): the UI's own
  // EventSource, the phone's web view and a browser tab receive the frame but show nothing,
  // so with none of the shells attached the OS notifier runs.
  const shells = new ShellPresence();
  // The bot token is checked for existence (never read here) so the settings screen says so
  // and the notifier skips the channel instead of failing every send before the fallback.
  const telegram = new SecretCheckedChannel(
    new TelegramChannel({
      fetch: opts.notifications?.fetch ?? opts.fetchImpl ?? globalThis.fetch,
      secrets,
      tokenRef: notifyConfig.telegramTokenRef,
      apiBase: notifyConfig.telegramApiBase,
    }),
    vault,
    { name: parseSecretRef(notifyConfig.telegramTokenRef), label: "bot token" },
  );
  const notifier = new Notifier({
    clock,
    channels: [
      ...(opts.startServices !== false
        ? [
            new DesktopChannel({
              emitter: notificationEmitter,
              shellsConnected: () => shells.count(),
              platform: opts.notifications?.platform,
              osFallback: osNotifier,
              ...osTools,
            }),
          ]
        : []),
      telegram,
      new SignalChannel({ account: notifyConfig.signalAccount, ...osTools }),
      new EmailChannel(emailPort),
    ],
    humans: new AuditedNotificationHumans(store, clock, { beforeRead: () => telegram.refresh() }),
    audit: store.auditLog,
    events: store.event,
    emitter: notificationEmitter,
  });
  notificationEmitter.on("notification", (payload) => events.emit("notification", payload));
  const notifications = bindProducers(notifier);
  const notifyLater = (p: Promise<unknown>, what: string): void => {
    p.catch((e: unknown) => logger.warn("notification not sent", { what, error: errorMessage(e) }));
  };
  // Producers: every human request this human gets (approvals from the hooks, the extension
  // registry, the mirror, the Cloudflare deployer, the critic, the updater, ...) is one insert
  // on the repo, so the hook lives there: blocking requests are urgent, the rest normal.
  const insertHumanRequest = store.humanRequest.insert.bind(store.humanRequest);
  store.humanRequest.insert = async (input) => {
    const row = await insertHumanRequest(input);
    if (row.human_id === human.id) {
      notifyLater(notifications.requestOpened(row, row.human_id), `request ${row.id}`);
      events.emit("inbox", {});
    }
    return row;
  };
  kill.onStop((report, reason) =>
    notifyLater(notifications.killSwitch(human.id, report, reason), "kill switch"),
  );
  events.on("restart", (r: RestartRequestFile) =>
    notifyLater(
      notifications.updateApplied(human.id, {
        reason: r.reason,
        targetVersion: r.targetVersion,
        fromVersion: r.fromVersion,
      }),
      `update ${r.reason}`,
    ),
  );
  // A critic escalation that filed no request of its own (a retry one rung up, a session
  // review the critic hands to the human) is raised to normal so it does not wait for the digest.
  // The bus event names no session; the review row the critic wrote does, so the delivery is
  // logged on the session it came from (as the session-end notification is).
  const escalate = async (e: SessionBusEvent, p: Record<string, unknown>): Promise<void> => {
    const verdict = typeof p.verdict === "string" ? p.verdict : "";
    if (!isReviewVerdict(verdict)) return;
    const reviewId = typeof p.reviewId === "string" ? p.reviewId : `${e.type}:${clock.now()}`;
    const review = typeof p.reviewId === "string" ? await store.review.get(reviewId) : undefined;
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : (review?.session_id ?? null);
    const taskId = typeof p.taskId === "string" ? p.taskId : (review?.task_id ?? null);
    const n = producers.criticVerdict(
      human.id,
      {
        id: reviewId,
        verdict,
        grade: typeof p.grade === "number" ? p.grade : (review?.grade ?? 0),
        task_id: taskId,
        session_id: sessionId,
        summary: typeof p.summary === "string" ? p.summary : (review?.summary ?? ""),
      },
      e.projectId ?? null,
    );
    await notifier.notify({ ...n, urgency: "normal" });
  };
  events.on("session", (e: SessionBusEvent) => {
    const p = e.payload;
    if (p?.escalation !== true || p.humanRequestId) return;
    if (e.type !== "critic.verdict" && e.type !== "critic.session_review") return;
    notifyLater(escalate(e, p), `escalation ${String(p.reviewId ?? e.type)}`);
  });
  const agentNameOf = async (agentId: string): Promise<string | undefined> =>
    agentId === agent.id ? agent.name : (await store.agent.get(agentId))?.name;

  const sessionGrant = (projectId?: string) => ({
    allowedTools: [...tools.names(), ...extensions.bridgedTools().map((t) => t.name)],
    allowedPaths: [dirs.worktrees],
    allowedDomains: [hostOf(config?.githubApiBase ?? "https://api.github.com"), "github.com"],
    grantedSecrets: ghToken ? [SECRET_NAMES.github] : [],
    maxDepth: 2,
    ...(projectId ? {} : {}),
  });
  const startSession = async (req: StartRequest) => {
    if (isModelWatchRequest(req)) return modelWatch.run();
    if (isMemoryConsolidationRequest(req)) return memory.propose();
    if (!provider)
      throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
    const project = req.projectId ? await store.project.mustGet(req.projectId) : null;
    // The cap the command registry wrote (a temporary override while its window is open, else
    // the permanent setting), so a session the scheduler starts honours "give it 20 francs
    // tonight" exactly as one started by the command (spec Q.12).
    const cap = sessionCapFromSettings(
      project?.settings,
      clock.now(),
      DEFAULT_SESSION_CAP_USD_MICRO,
    ).usdMicro;
    const budgetUsdMicro = (req as { budgetUsdMicro?: number }).budgetUsdMicro ?? cap;
    const result = await runner.start({
      agentId: req.agentId,
      projectId: req.projectId,
      trigger: req.trigger,
      budgetCapUsdMicro: budgetUsdMicro,
      appVersion,
      grant: sessionGrant(req.projectId),
      onEvent: (type, payload) =>
        events.emit("session", { type, payload, agentId: req.agentId, projectId: req.projectId }),
    });
    // Session end (spec E.5 "notify human"): the outcome, the counts and the summary; a
    // budget stop becomes the urgent `budget_stop` (the producer decides by `stopReason`).
    notifyLater(
      notifications.sessionEnded(human.id, {
        sessionId: result.sessionId,
        status: result.status,
        stopReason: result.stopReason,
        summary: result.summary,
        spentUsdMicro: result.spentUsdMicro,
        completed: result.completed,
        needsHuman: result.needsHuman,
        projectId: req.projectId ?? null,
        agentName: await agentNameOf(req.agentId),
      }),
      `session ${result.sessionId} ended`,
    );
    return result;
  };
  // Mirror requests run the mirror, the model watch its weekly check, everything else a session.
  const scheduler = new Scheduler({
    clock,
    start: mirrorStartHandler(mirror, startSession, { agentId: agent.id }),
  });
  scheduleModelWatch(scheduler, { timezone: human.timezone });
  // Weekly memory consolidation (spec G.4): report only; the human applies it from the inbox.
  scheduleMemoryConsolidation(scheduler, { timezone: human.timezone });
  // The command registry (spec Q): every change by chat, voice, the UI or the phone runs here.
  const commands = new CommandLoop({
    store,
    clock,
    ports: {
      chfPerUsd: async () => chfPerUsd(),
      // session.start reports the scheduler's outcome; the undo of a start that only queued
      // drops the waiting request instead of killing the running session (ADR 0036).
      ...sessionCommandPorts({ scheduler, kill }),
    },
  });
  const mirrorSchedules = new Set<string>();
  const refreshMirrorSchedules = async (): Promise<string[]> => {
    const projects = await store.project.list({}, { limit: 1000 });
    const wanted = new Set(projects.filter((p) => mirrorSettingsOf(p)).map((p) => p.id));
    for (const id of [...mirrorSchedules]) {
      if (wanted.has(id)) continue;
      scheduler.remove(`mirror:${id}`);
      mirrorSchedules.delete(id);
    }
    for (const id of wanted) {
      if (mirrorSchedules.has(id)) continue;
      scheduleMirror(scheduler, { projectId: id });
      mirrorSchedules.add(id);
    }
    return [...mirrorSchedules];
  };
  const syncApprovals = async () => {
    const out = {
      extensions: await extensions.syncApprovals({ humanId: human.id }),
      modelWatch: await modelWatch.syncPendingAnswers(),
      memory: await memory.syncApprovals(),
      findings: await syncBlockedByFindings({ store, clock, humanId: human.id, agentId: agent.id }),
    };
    // A mirror run waiting on its approval re-reads the request now, not at the next poll.
    mirrorApprovals.wake();
    return out;
  };
  const conversation = provider
    ? new ConversationAgent({
        store,
        clock,
        tokens,
        kill,
        provider,
        pricing: pricingForProvider(provider, chatModelFor(provider)),
        billingSourceId,
        hooksDriver: driver,
        startSession: (req) => scheduler.request(req),
        prompt: registry.principals.get("conversation-agent")?.prompt,
        modelId: chatModelFor(provider),
        commands,
      })
    : null;
  // Background services: the daemon starts them; a CLI one-shot (startServices: false) only
  // uses the composed objects and never connects a connector or ticks the scheduler.
  const services = opts.startServices !== false;
  const killWatcher = new KillFileWatcher(kill, clock, dirs.runtime);
  if (services) killWatcher.start();
  mkdirSync(evalWorkRoot, { recursive: true });
  if (services) await extensions.start();
  // The command table and the reverts of temporary changes whose window is still open.
  await commands.start();
  await syncApprovals();
  await refreshMirrorSchedules();
  if (services) scheduler.start();
  // Quiet-hours holds and the daily digest are flushed on the clock; a one-shot sends at once
  // or holds in memory and never ticks.
  const stopNotifier = services ? notifier.start() : () => undefined;
  logger.info("runtime composed", {
    stateUrl: stateUrl.replace(/\/\/[^@]*@/, "//[REDACTED]@"),
    vault: vault.backend,
    provider: provider?.name ?? "none",
    registry: registryDir,
    human: human.name,
    agent: agent.name,
    critic: criticAgent.name,
    sandbox: sandboxDetection.engine,
    bridgedTools: extensions.bridgedTools().length,
    mirrors: mirrorSchedules.size,
    services,
  });

  return {
    dirs,
    config,
    clock,
    store,
    vault,
    tokens,
    kill,
    hooks,
    driver,
    providers,
    provider,
    registry,
    tools,
    executor,
    runner,
    scheduler,
    conversation,
    gitHost,
    human: { id: human.id, name: human.name, timezone: human.timezone },
    agent: { id: agent.id, name: agent.name },
    billingSourceId,
    chfPerUsd,
    context,
    costLedger,
    critic,
    criticAgent: { id: criticAgent.id, name: criticAgent.name },
    memory,
    commands,
    events,
    appVersion,
    startedAt: clock.now(),
    extensions,
    gate,
    updates: updates.manager,
    updateConfig,
    restarter,
    modelWatch,
    estimates,
    mirror,
    sandbox: { port: sandboxPort, detection: sandboxDetection },
    notifier,
    notifications,
    shells,
    toolsForRun,
    syncApprovals,
    refreshMirrorSchedules,
    mirrorSync,
    async close() {
      scheduler.stop();
      stopNotifier();
      killWatcher.stop();
      commands.stop();
      context.close();
      managedHeadroom?.stop();
      await extensions.close();
      await updates.close();
      await store.close();
    },
  };
}

/**
 * The daemon's mirror approval port. Like `HumanRequestMirrorPort` it files one human request
 * before a board is created and waits for the answer through the clock, but it also tells the
 * daemon which request a project waits on (so `POST /projects/:id/mirror/sync` answers 202
 * instead of blocking until the human decides), wakes when a request is answered in the inbox
 * instead of waiting for the next poll, and reuses an open request for the same project (a
 * second sync, or a daemon restart, never files a duplicate). A timeout withdraws the request
 * and counts as deny; nothing is created meanwhile.
 */
export class DaemonMirrorApprovals implements MirrorHumanPort {
  private readonly pending = new Map<string, string>();
  private readonly wakers = new Set<() => void>();
  private readonly askListeners = new Set<(projectId: string, requestId: string) => void>();

  constructor(
    private readonly store: Pick<StateStore, "humanRequest">,
    private readonly clock: Clock,
    private readonly opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {}

  /** The open approval request a project's mirror run waits on, if any. */
  pendingRequest(projectId: string): string | undefined {
    return this.pending.get(projectId);
  }

  /** Called with the request id when `ask` has filed (or found) the request; returns the off switch. */
  onAsked(listener: (projectId: string, requestId: string) => void): () => void {
    this.askListeners.add(listener);
    return () => {
      this.askListeners.delete(listener);
    };
  }

  /** Re-read every awaited request now (an answer arrived in the inbox). */
  wake(): void {
    for (const w of [...this.wakers]) w();
  }

  async ask(req: MirrorApprovalRequest): Promise<MirrorApprovalAnswer> {
    const open = await this.store.humanRequest.open(
      { projectId: req.projectId, ...(req.humanId ? { humanId: req.humanId } : {}) },
      { limit: 50 },
    );
    const row =
      open.find((r) => r.kind === "approval" && r.options[0] === MIRROR_APPROVE_OPTION) ??
      (await this.store.humanRequest.insert({
        human_id: req.humanId,
        project_id: req.projectId,
        session_id: null,
        kind: "approval",
        why: req.why,
        steps: [
          `Forerunner will create the GitHub project "${req.title}" under ${req.owner}`,
          "Tasks are mirrored one way; edits on GitHub never change Forerunner",
        ],
        options: req.options,
        blocking: false,
        risk: "low",
      }));
    this.pending.set(req.projectId, row.id);
    for (const l of [...this.askListeners]) l(req.projectId, row.id);
    try {
      const pollMs = Math.max(100, this.opts.pollMs ?? 5_000);
      const deadline = this.clock.now() + (this.opts.timeoutMs ?? 24 * 60 * 60_000);
      while (this.clock.now() < deadline) {
        await this.sleepOrWake(pollMs);
        const cur = await this.store.humanRequest.mustGet(row.id);
        if (cur.status === "answered") return mirrorDecision(cur.answer, req.options);
        if (cur.status !== "open") return "deny";
      }
      try {
        const cur = await this.store.humanRequest.mustGet(row.id);
        if (cur.status === "open") await this.store.humanRequest.withdraw(cur.id, cur.version);
      } catch {
        // the answer is deny either way
      }
      return "deny";
    } finally {
      this.pending.delete(req.projectId);
    }
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const ac = new AbortController();
      const wake = () => {
        this.wakers.delete(wake);
        ac.abort();
        resolve();
      };
      this.wakers.add(wake);
      this.clock.sleep(ms, ac.signal).then(
        () => {
          this.wakers.delete(wake);
          resolve();
        },
        () => undefined,
      );
    });
  }
}

function mirrorDecision(answer: JsonValue | null, options: string[]): MirrorApprovalAnswer {
  const chosen =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? String(
            (answer as Record<string, JsonValue>).choice ??
              (answer as Record<string, JsonValue>).option ??
              "",
          )
        : "";
  if (chosen === options[0] || /^(approve|approved|yes|create)/i.test(chosen.trim()))
    return "approve";
  return "deny";
}

/**
 * The daemon's hooks: the extension gate in front of every tool call, and the cost of a
 * bridged tool call booked on its extension afterwards (kept here, not in hooks.ts). Bridged
 * MCP calls carry no price, so `recordCost` books nothing for them (it ignores 0): a
 * connector's cost column stays 0 until a capability module charges through the ledger.
 */
class DaemonHooks extends GatedEnforcementHooks {
  constructor(
    deps: HookDeps,
    gate: ExtensionGate,
    private readonly extensions: ExtensionRegistry,
  ) {
    super(deps, gate);
  }

  override async afterToolCall(
    ctx: RunContext,
    tool: ToolSpec,
    input: unknown,
    result: Parameters<EnforcementHooks["afterToolCall"]>[3],
  ): ReturnType<EnforcementHooks["afterToolCall"]> {
    const out = await super.afterToolCall(ctx, tool, input, result);
    if (isBridgedTool(tool)) {
      await this.extensions.recordCost(tool.extensionId, result.costUsdMicro ?? 0);
    }
    return out;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Real providers price from the billing table; fake providers count one micro-USD per token. */
function pricingForProvider(p: ModelProvider | null, modelId: string) {
  if (p && p.name === "anthropic") return pricingFor(modelId);
  return {
    estimate: (i: number, o: number) => i + o,
    cost: (u: { input_tokens: number; output_tokens: number }) => u.input_tokens + u.output_tokens,
  };
}

/** The ladder picks tier ids per provider; sessions default to the sonnet rung. */
function defaultModelFor(p: ModelProvider): string {
  return p.name === "anthropic" ? "claude-sonnet-5-5" : "fake-sonnet";
}
function chatModelFor(p: ModelProvider): string {
  return p.name === "anthropic" ? "claude-haiku-5-5" : "fake-haiku";
}

function unavailableProvider(): ModelProvider {
  const fail = () => {
    throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
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
