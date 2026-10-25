import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import {
  type BillingSource,
  type BillingSourceProbe,
  BUILTIN_PRICING,
  CapChecker,
  CostLedger,
  FixedRateSource,
  loadPricing,
  PRICING_FILE_NAME,
  type PricingTable,
  type RateSource,
} from "@forerunner/billing";
import {
  type email as agentEmail,
  browser,
  cloudflare,
  desktop,
  type GitHost,
  GitHubHost,
  githubHostForSecretRef,
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
import { criticSettingsOf } from "@forerunner/critic";
import {
  type AppDirs,
  appDirs,
  type Clock,
  currentPlatform,
  errorMessage,
  ForerunnerError,
  isAbsolute,
  join,
  log,
  osFacts,
  type Platform,
  safeSegment,
  systemClock,
} from "@forerunner/platform";
import {
  type DeviceRow,
  type HumanRow,
  type JsonObject,
  type JsonValue,
  type NewAuditLog,
  openStore,
  type ProjectRow,
  REVIEW_VERDICTS,
  type ReviewVerdict,
  type StateStore,
} from "@forerunner/state";
import {
  ensureInstallWrapKey,
  openVault,
  parseSecretRef,
  SecretResolver,
  type Vault,
} from "@forerunner/vault";
import { claudeCodeToolNames } from "../agent/cc-tools.ts";
import { LoopAgentDriver, type RunEvent, type RunPricing } from "../agent/loop.ts";
import { type QueryLike, SdkAgentDriver } from "../agent/sdk.ts";
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
import { DataAssets } from "../data/assets.ts";
import { DataImporter } from "../data/import.ts";
import { registerDataTools } from "../data/tools.ts";
import type { DataLimits } from "../data/types.ts";
import { DeviceManager } from "../devices/index.ts";
import type { EnforcementHooks, HookDeps, RunContext } from "../enforcement/hooks.ts";
import { KillFileWatcher } from "../enforcement/killfile.ts";
import { KillSwitch } from "../enforcement/killswitch.ts";
import type { CapDecision, CapScope, CapsBilling, CapsPort } from "../enforcement/ports.ts";
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
import {
  CalibrationJob,
  calibrationSettingsOf,
  HandoverJob,
  isCalibrationRequest,
  isHandoverRequest,
  SeedOnlyPlanner,
  scheduleCalibration,
  syncHandoverSchedules,
} from "../jobs/index.ts";
import { CommandLoop, sessionCapFromSettings, sessionCommandPorts } from "../loop/commands.ts";
import { CriticLoop } from "../loop/critic.ts";
import { ProjectDocs, parseRepoRef } from "../loop/docs.ts";
import {
  isMemoryConsolidationRequest,
  MemoryLoop,
  memoryCommandPort,
  openPrivateIndex,
  privateIndexUrl,
  scheduleMemoryConsolidation,
} from "../loop/memory.ts";
import { MERGE_PR_TOOL, ReviewedPrMerge } from "../loop/merge.ts";
import { LoopEvalRunner } from "../models/eval-runner.ts";
import { modelIdFor } from "../models/ladder.ts";
import {
  FetchPriceListSource,
  type PriceListSource,
  priceListUrlFromEnv,
  UnconfiguredPriceListSource,
} from "../models/price-list.ts";
import { type EffectiveModelConfig, FileModelSettingsStore } from "../models/settings.ts";
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
  speakThrough,
  TelegramChannel,
  type TelegramFetch,
  VOICE_IN_CONVERSATION,
  VOICE_NO_PLAYER,
  VoiceChannel,
} from "../notifications/index.ts";
import { isQuietAt, resolvePrefs } from "../notifications/prefs.ts";
import { AnthropicMessagesProvider } from "../provider/anthropic.ts";
import { ProviderRegistry } from "../provider/registry.ts";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  type ModelProvider,
  type ModelTier,
  providerCapabilities,
} from "../provider/types.ts";
import { SpecialistApprovals, type SpecialistSyncResult } from "../registry/approval.ts";
import {
  type DroppedTool,
  loadRegistry,
  loopToolsFor,
  type Registry,
  resolveRegistryDir,
  type SpecialistDef,
  type SpecialistDriver,
  TOOL_UNMAPPED_AUDIT,
} from "../registry/index.ts";
import { DesktopPresence, RemoteCommandWatcher, registerDesktopDevice } from "../remote/index.ts";
import { detectSandboxEngine, type EngineDetection } from "../sandbox/detect.ts";
import type { RunFn, WhichFn } from "../sandbox/types.ts";
import {
  type ProposedSharedSecret,
  proposeSharedSecret,
  SHARED_SECRET_AUDIT,
  type SharedGrantView,
  SharedSecretVault,
  StoreSharedSecretService,
  sharedSecretNamesFor,
} from "../secrets/index.ts";
import type { TaskBillingPort } from "../session/billing.ts";
import { LoopTaskExecutor, type RunSandboxPort, type SpecialistSpec } from "../session/executor.ts";
import {
  type BlockedSyncResult,
  type SignoffSyncResult,
  syncBlockedByFindings,
  syncSignoffAnswers,
} from "../session/findings.ts";
import {
  DEFAULT_GITHOST_POLL_MS,
  fileCursorStore,
  GitHostWatcher,
} from "../session/githost-watcher.ts";
import { IntakeService, type IntakeSyncResult } from "../session/intake.ts";
import { type LateApprovalSyncResult, syncLateApprovals } from "../session/late-approval.ts";
import {
  type PlanApprovalSyncResult,
  reportingPlanStartFailures,
  syncPlanApprovals,
} from "../session/plan-approval.ts";
import {
  SessionRunner,
  type SessionRunnerDeps,
  type SessionStartOptions,
  StaticPlanner,
  type TaskExecutor,
} from "../session/runner.ts";
import { fileFiredKeys, Scheduler, type StartRequest } from "../session/triggers.ts";
import { readInstallRecord } from "../setup/install-record.ts";
import {
  describePlanAllowance,
  PLAN_USD_MONTHLY_ENV,
  type PlanAllowance,
  resolvePlanAllowance,
} from "../setup/plan-allowance.ts";
import { readConfig, rememberBoundHuman, SECRET_NAMES, type SetupConfig } from "../setup/wizard.ts";
import { SourceDiscovery } from "../sources/discovery.ts";
import { repoHostsFor } from "../sources/locators.ts";
import { composeUpdateManager } from "../update/compose.ts";
import { readUpdateConfig, UpdateConfig } from "../update/config.ts";
import type { UpdateManager } from "../update/install.ts";
import type { Restarter } from "../update/ports.ts";
import { SchemaSync } from "../update/sync.ts";
import {
  buildVoiceRegistry,
  resolveVoicePreferences,
  SpeakSessions,
  type VoicePreferences,
  VoiceRelay,
  VoiceSessions,
  vaultHasSecret,
  voiceExtensionRows,
} from "../voice/index.ts";
import {
  type AudioSink,
  type LatencyTargets,
  type SttProvider,
  type TtsProvider,
  VoiceProviderRegistry,
} from "../voice/pkg.ts";
import {
  RouterTaskBilling,
  sdkHostCommandsEnabled,
  seedBillingSources,
} from "../wiring/billing-pick.ts";
import {
  credentialFor,
  pricingFor,
  StateLedgerStore,
  stateSources,
} from "../wiring/billing-ports.ts";
import {
  BROWSER_CAPABILITY_NAME,
  type BrowserMode,
  browserBindingResolver,
  browserModeFor,
  browserPresence,
  browserSettingsOf,
  type CapabilityPresence,
} from "../wiring/browser-ports.ts";
import {
  BusIndicator,
  desktopBindingResolver,
  GuardedAllowlistStore,
  UnavailableDesktopAdapter,
} from "../wiring/desktop-ports.ts";
import { type AgentEmailPorts, agentEmailPorts, emailPresence } from "../wiring/email-ports.ts";
import { readEffectiveModelConfig } from "../wiring/model-config.ts";
import {
  AuditedNotificationHumans,
  notificationEmailPort,
  SecretCheckedChannel,
} from "../wiring/notification-ports.ts";
import { sessionPausePorts } from "../wiring/session-ports.ts";
import { specialistCommandPort } from "../wiring/specialist-ports.ts";
import { statePorts } from "../wiring/state-ports.ts";
import type { SpeakStartedView } from "./api-types.ts";
import { conversationSessionId } from "./conversation-session.ts";
import { createProjectRecord } from "./create-project.ts";
import {
  bindInstallHuman,
  type InstallIdentity,
  installIdentitySelectors,
  pickPrincipal,
} from "./identity.ts";
import { DaemonRestarter, processExit, type RestartRequestFile } from "./restart.ts";
import { DetectingSandboxPort } from "./sandbox-port.ts";
import { ShellPresence } from "./shells.ts";
import { fileTools } from "./tools.ts";

/**
 * Composition root for one install: opens the store and the vault, picks the model provider,
 * wires enforcement, sessions, the conversation agent, the scheduler and the kill switch. The
 * daemon server, the CLI and the tests all go through this so there is exactly one wiring.
 */
/** The approvals poll (`ComposeOptions.approvalsPollMs`): answers from other devices within 5 s. */
export const DEFAULT_APPROVALS_POLL_MS = 5_000;

export interface ComposeOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: AppDirs;
  config?: SetupConfig | null;
  clock?: Clock;
  stateUrl?: string;
  /**
   * The private memory index (ADR 0083): a `sqlite:` URL, or null for none. Default
   * `privateIndexUrl(stateUrl, dirs)`: none for a `sqlite:` state, `<data>/memory/private.sqlite`
   * for a shared one. Tests force an index next to an in-memory state.
   */
  privateIndexUrl?: string | null;
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
  /**
   * Who this install is (ADR 0082). `humanId` (an id or an email) binds the install to that
   * human ahead of `FORERUNNER_HUMAN` and `config.json`; the cloud runner passes the human it
   * resolved. `email` finds the human by email or names the one created on first run (ahead of
   * `config.json` `humanEmail`). `humanName` and `timezone` are used only when the human is
   * created; `agentName` picks the principal agent among the human's own (created with that
   * name when there is none).
   */
  identity?: {
    humanId?: string;
    humanName?: string;
    email?: string;
    timezone?: string;
    agentName?: string;
  };
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
  /**
   * Desktop control seams (tests): the adapter in place of platform detection (a
   * `FakeDesktopAdapter`), the detection itself, the allowlist store (default
   * `<config>/desktop-allowlist.json`) and an extra indicator next to the bus event.
   * Production detects the adapter once at compose (`detectAdapter`) and, when this machine
   * has no usable desktop, installs one that refuses every action (ADR 0039).
   */
  desktop?: {
    adapter?: desktop.DesktopAdapter;
    detect?: () => Promise<desktop.AdapterDetection>;
    allowlist?: desktop.DesktopAllowlistStore;
    indicator?: desktop.Indicator;
  };
  /** Data assets (spec L.1): the projects root (default `<data>/projects`) and limit overrides. */
  data?: {
    projectsRoot?: string;
    limits?: Partial<DataLimits>;
    /**
     * Where a repository import resolves `owner/name`, and the one origin the install's own
     * GitHub token is sent to (ADR 0069). Default `https://github.com`; tests: the fake host.
     */
    gitRemoteBase?: string;
  };
  /**
   * The schema sync gate's view of this install (tests): the schema version the code ships
   * (default `MIGRATIONS.length`) and the oldest one the release supports (default 1).
   */
  schemaSync?: {
    localSchemaVersion?: number;
    minSchema?: number;
  };
  /**
   * Remote commands from paired devices and the PC's presence row (spec R.4, R.8; ADR 0041).
   * `enabled` overrides `remoteCommandsEnabled` (on when the background services run and the
   * state is shared, i.e. not a `sqlite:` URL; `FORERUNNER_REMOTE_COMMANDS=1|0` overrides too);
   * `pollMs` (`FORERUNNER_REMOTE_POLL_MS`, default 500) is the command poll, `heartbeatMs`
   * (`FORERUNNER_PRESENCE_HEARTBEAT_MS`, default 60 000) the desktop heartbeat, `deviceName`
   * (`FORERUNNER_DEVICE_NAME`, default the host name) names the daemon's device row.
   */
  remote?: {
    enabled?: boolean;
    pollMs?: number;
    heartbeatMs?: number;
    deviceName?: string;
  };
  /**
   * Settings -> Devices (spec R.2): the state service the daemon starts pairings at and
   * revokes through with its admin token. Defaults: `FORERUNNER_STATE_API_URL` and the vault
   * secret named by `FORERUNNER_STATE_API_ADMIN_TOKEN_REF` (default `secret:state_api_admin`);
   * `serviceUrl: null` turns the service off (list and revoke over the store, no pairing).
   * `adminToken` and `fetch` replace the vault read and the network (tests).
   */
  devices?: {
    serviceUrl?: string | null;
    adminToken?: string;
    fetch?: typeof fetch;
  };
  /**
   * How often answered approvals are applied from the shared state
   * (`FORERUNNER_APPROVALS_POLL_MS`, default `DEFAULT_APPROVALS_POLL_MS`): an answer given on
   * the phone or in the web approvals reaches no route of this daemon, so `syncApprovals()`
   * runs on this poll wherever answers can arrive from another device (the same condition
   * as the remote commands: shared state, services running).
   */
  approvalsPollMs?: number;
  /**
   * CI results and PR comments start sessions (spec E.1, ADR 0075): the git host poller over
   * the open PRs of this install's agent. `enabled` overrides `githostWatchEnabled` (on when
   * the background services run and a real git host is configured, i.e. the vault holds the
   * GitHub token or a host was injected; `FORERUNNER_GITHOST_WATCH=1|0` overrides too);
   * `pollMs` (`FORERUNNER_GITHOST_POLL_MS`, default `DEFAULT_GITHOST_POLL_MS`, a minute) is
   * the poll; `cursorPath` (default `<data>/githost/cursor-<agent>.json`) is where the
   * cursor survives a restart.
   */
  githostWatch?: {
    enabled?: boolean;
    pollMs?: number;
    cursorPath?: string;
  };
  /**
   * Per-task billing and the Agent SDK path (ADR 0044). `personalRunner`: whether this
   * install is the human's own runner (the PC: true; `FORERUNNER_RUNNER_PERSONAL=0` says no);
   * `probe` replaces the vault-and-ledger probe (tests); `hostCommands` lets `cc:Bash` run
   * where the Claude Code subprocess runs (`FORERUNNER_SDK_HOST_COMMANDS=1`; default off);
   * `sdkQuery` replaces the SDK's `query` so a test never spawns Claude Code.
   */
  billing?: {
    personalRunner?: boolean;
    probe?: BillingSourceProbe;
    hostCommands?: boolean;
    /** The subscription's plan allowance in USD per month, ahead of the environment and `config.json`. */
    planUsdMonthly?: number;
  };
  sdkQuery?: QueryLike;
  /**
   * The sandboxed browser (ADR 0047): `mode` ahead of `FORERUNNER_BROWSER_MODE` and the
   * Chromium probe (`static` never launches Chromium: the page reader over HTTP; tests pass
   * it), `fetch` the static mode's fetch (tests reach their loopback servers; default
   * `fetchImpl`, else `globalThis.fetch`), `launchTimeoutMs` Playwright's launch limit.
   */
  browser?: {
    mode?: BrowserMode;
    fetch?: browser.FetchLike;
    launchTimeoutMs?: number;
  };
  /**
   * Voice (spec O; ADR 0012, ADR 0048). Production registers the local helpers and the cloud
   * providers by secret reference (`buildVoiceRegistry`) and prefers what the Extensions
   * panel's enabled `voice-*` rows name, with `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS`
   * as the override, read at every session start (`resolveVoicePreferences`); tests inject
   * the fake providers (`stt`, `tts`) or a whole `registry`, fixed `preferred` names in place
   * of the panel, and a `sink` in place of the paced one. `storeAudio`
   * (`FORERUNNER_VOICE_STORE_AUDIO=1`) writes WAVs under `<data>/voice/<session>`; off by default.
   */
  voice?: {
    stt?: SttProvider;
    tts?: TtsProvider;
    registry?: VoiceProviderRegistry;
    preferred?: VoicePreferences;
    sink?: (clock: Clock) => AudioSink;
    storeAudio?: boolean;
    targets?: Partial<LatencyTargets>;
    maxSessions?: number;
    /** Stopped sessions kept for a late `GET` or stream (default 8) and for how long (default 10 min). */
    keepStopped?: number;
    retainStoppedMs?: number;
    /** How long a read-aloud waits for its player's stream before playing (default 1.5 s). */
    awaitListenerMs?: number;
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

/**
 * Whether the daemon consumes `target: "pc"` remote commands and heartbeats its desktop row:
 * only when the background services run; then `override` (tests), else
 * `FORERUNNER_REMOTE_COMMANDS` ("1" on, "0" off), else on exactly when the state is shared (a
 * phone reaches the daemon only through the state service over a shared Postgres; a local
 * `sqlite:` state has no remote devices).
 */
export function remoteCommandsEnabled(
  env: NodeJS.ProcessEnv,
  stateUrl: string,
  services: boolean,
  override?: boolean,
): boolean {
  if (!services) return false;
  if (override !== undefined) return override;
  const flag = env.FORERUNNER_REMOTE_COMMANDS?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !stateUrl.trim().toLowerCase().startsWith("sqlite");
}

/**
 * Whether the daemon polls the git host for CI results and PR comments (spec E.1, ADR 0075):
 * only when the background services run; then `override` (tests), else
 * `FORERUNNER_GITHOST_WATCH` ("1" on, "0" off), else on exactly when a real host is there (the
 * GitHub token in the vault or an injected host; the in-memory stand-in has nothing to poll).
 */
export function githostWatchEnabled(
  env: NodeJS.ProcessEnv,
  services: boolean,
  realHost: boolean,
  override?: boolean,
): boolean {
  if (!services) return false;
  if (override !== undefined) return override;
  const flag = env.FORERUNNER_GITHOST_WATCH?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return realHost;
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
  /**
   * The driver specialists run on by default; decides how the registry's `cc:` tool names
   * are mapped (ADR 0043). Per task the executor may pick the other one (ADR 0044): a task
   * billed to a subscription runs on the Agent SDK driver with the names as written.
   */
  specialistDriver: SpecialistDriver;
  /**
   * A runnable registry entry as the executor sees it: `allowed_tools` mapped for
   * `specialistDriver`, or for the driver named as the second argument.
   */
  specialists: (name: string, driver?: SpecialistDriver) => SpecialistSpec | undefined;
  tools: ToolRegistry;
  executor: TaskExecutor;
  runner: SessionRunner;
  /**
   * PM intake (spec A.2, ADR 0055): the brief as one proposal in the inbox (plan, doc set,
   * first-session plan), applied on the approving answer by `syncApprovals`.
   */
  intake: IntakeService;
  /**
   * Proposed specialists (spec C.5, ADR 0071): `propose` writes `proposed/<name>/` and files
   * the approval request; the approving answer (inbox through `syncApprovals`, or
   * `fr specialists approve`) runs the eval set and promotes the file only on a pass.
   */
  specialistApprovals: SpecialistApprovals;
  scheduler: Scheduler;
  conversation: ConversationAgent | null;
  gitHost: GitHost;
  human: { id: string; name: string; timezone: string };
  /** How `human` was chosen (ADR 0082): the selector and where it came from. */
  identity: InstallIdentity;
  agent: { id: string; name: string };
  /**
   * The source the loop paths are billed to (the critic, chat, the model watch's evals): the
   * API key when the vault has one, else the subscription, else the fake source. Task runs
   * pick their own source through `billing.pick` (ADR 0044).
   */
  billingSourceId: string;
  /**
   * Per-task billing (ADR 0044): the human's sources (both when both credentials exist), the
   * router's pick per task, and the Agent SDK driver a subscription pick runs on.
   */
  billing: {
    sources: () => Promise<BillingSource[]>;
    pick: TaskBillingPort;
    sdk: SdkAgentDriver;
    /** Whether `cc:Bash` is granted on the SDK path (see `ComposeOptions.billing.hostCommands`). */
    hostCommands: boolean;
    /** The plan allowance the subscription row was seeded with, and where it came from. */
    planAllowance: PlanAllowance;
  };
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
  /**
   * The local private memory index when the state is shared (`<data>/memory/private.sqlite`,
   * ADR 0083): the only store that holds this install's `agent_private` rows. Null in solo mode,
   * where `store` holds every scope.
   */
  privateMemory: StateStore | null;
  /**
   * Project docs (spec G.5): the standard doc set scaffolded at project creation (a branch and
   * pull request with a repository, the data dir without) and `docs/status.md` updated at
   * session end.
   */
  docs: ProjectDocs;
  /**
   * The merge of a reviewed PR after an accepting review (spec J.9, ADR 0062): one `merge_pr`
   * call through the daemon's hooks; level 3 merges, below it the PR stays open.
   */
  merge: ReviewedPrMerge;
  /**
   * The grant a session of this agent on `projectId` starts with (ADR 0044), as `startSession`
   * computes it: the tools (`merge_pr` among them, J.9), the worktrees root, the git host's and
   * the project's domains, the granted secret names.
   */
  sessionGrant(projectId?: string | null): Promise<SessionStartOptions["grant"]>;
  /** The command registry (spec Q): the only way chat, voice, the UI and the phone change state. */
  commands: CommandLoop;
  /**
   * Voice sessions (spec O; ADR 0048): the voice loop over the conversation agent behind the
   * `/voice` routes; `status()` says whether a provider pair is usable and why not.
   */
  voice: VoiceSessions;
  /**
   * Read aloud (spec A.6, L.6; ADR 0063): the project and session summaries and urgent
   * notifications through the registry's TTS, behind the `/speak` routes, the `summary.speak`
   * command and the voice notification channel. Needs no model credential.
   */
  speech: SpeakSessions;
  /** Signed updates (spec M) over this process's store. */
  updates: UpdateManager;
  updateConfig: UpdateConfig;
  restarter: Restarter;
  /**
   * The schema sync gate (spec M, last bullet): evaluated at compose, by every peer feed and
   * after an update's health check; a session start, `syncApprovals`, `mirrorSync`, the
   * scheduler's mirror runs and the peer feed are refused (`unavailable`) while it is paused.
   * The model watch and the memory consolidation are local jobs and are not held.
   */
  schemaSync: SchemaSync;
  /** Weekly model watch (spec D) on the registered providers. */
  modelWatch: ModelWatch;
  /**
   * The ladder and effort table in force (spec D, ADR 0039): built-ins plus the adopted
   * `<config>/models.json`, replaced in place when the model watch adopts a change. Every
   * run and chat turn reads it at start.
   */
  modelConfig: () => EffectiveModelConfig;
  /** The pricing table in force: built-ins plus `<config>/pricing.json`, replaced on an adopt. */
  pricingTable: () => PricingTable;
  /** Estimate-versus-actual learning the planner consumes (spec I). */
  estimates: EstimateModel;
  /**
   * Desktop control (spec L.4, S.32; ADR 0021): the one controller per daemon behind the six
   * `desktop_*` tools, the per-human allowlist store and the adapter detection the status
   * route reports.
   */
  desktop: {
    controller: desktop.DesktopController;
    allowlist: desktop.DesktopAllowlistStore;
    detect: () => Promise<desktop.AdapterDetection>;
  };
  /** Files and data (spec L.1, A.3): the registry behind the Data tab routes and the data tools. */
  data: {
    assets: DataAssets;
    importer: DataImporter;
  };
  /**
   * Source discovery (spec A.4, ADR 0056): the one `SourceDiscovery` behind the `/sources`
   * routes and `fr sources`; a GitHub source's host comes from the vault by the source's
   * credential reference at scan time (an injected `gitHost` stands in for every source).
   */
  sources: SourceDiscovery;
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
  /**
   * The `/events` streams that play speech (`?speech=play`, ADR 0063: the UI where it has Web
   * Audio); the voice channel speaks and `summary.speak` reads aloud only with one attached.
   */
  speechPlayers: ShellPresence;
  /**
   * This PC as a device and the remote control of it (spec R.4, R.8; ADR 0030, ADR 0041):
   * the daemon's own `desktop` device row (registered on every store: it is the paired device
   * a high-risk change from the desktop app is confirmed on, and `GET /me` names its id;
   * null only in a hand-built runtime), the watcher that executes the phone's `target: "pc"`
   * commands and the heartbeat the cloud runner's PC-wins rule reads, both null when
   * `remoteCommandsEnabled` said no.
   */
  remote: {
    enabled: boolean;
    device: DeviceRow | null;
    watcher: RemoteCommandWatcher | null;
    presence: DesktopPresence | null;
  };
  /**
   * CI results and PR comments as session triggers (spec E.1, ADR 0075): the git host poller
   * firing `ci` and `pr_comment` through the scheduler, or null when `githostWatchEnabled`
   * said no.
   */
  githostWatcher: GitHostWatcher | null;
  /**
   * Settings -> Devices (spec R.2): the human's paired devices, a new pairing through the
   * state service (its admin token stays here) and the immediate revocation.
   */
  devices: DeviceManager;
  /**
   * Shared secrets (spec S.13, ADR 0065): the vault the hooks resolve through (this install's
   * own vault, then the wrapped copies for this agent), the service over the shared store, the
   * owner-side calls the `/secrets/shared` routes expose, and the names active for this agent.
   */
  sharedSecrets: {
    vault: SharedSecretVault;
    service: StoreSharedSecretService;
    propose(input: {
      name: string;
      agentIds: string[];
      why?: string;
      kind?: string;
    }): Promise<ProposedSharedSecret>;
    revoke(grantId: string): Promise<SharedGrantView>;
    list(): Promise<SharedGrantView[]>;
    names(): Promise<string[]>;
  };
  /**
   * The sandboxed browser and agent email inside the daemon (spec L.2, L.3; ADR 0047): the
   * browser mode and session manager, the email ports the tools and the notifier share, the
   * presence switches (`enabled()`: whether the next run is offered the tools), the project
   * site allowlists in force, and `refresh()`, which re-reads all of them (every session
   * start does).
   */
  capabilities: {
    browser: {
      mode: BrowserMode;
      manager: browser.BrowserSessionManager;
      presence: CapabilityPresence;
    };
    email: { ports: AgentEmailPorts; presence: CapabilityPresence };
    /** Every project's `settings.browser.allowedDomains`, as read at the last refresh. */
    browserDomains(): readonly string[];
    refresh(): Promise<void>;
  };
  /**
   * The tool registry a run starts with: the built-in tools, the capability tools whose
   * presence switch is on, plus the bridged extension tools.
   */
  toolsForRun(): ToolRegistry;
  /**
   * Apply answered human requests: extension grants, model watch decisions, memory
   * consolidations, the rework/accept/cancel answers for tasks blocked by open findings, the
   * accept/revise/cancel answers to critic sign-offs, the approve/reject answers to session
   * plans (an approved plan is handed to the scheduler as a start bound to it, ADR 0053; only
   * while the services run, a CLI one-shot starts no session), the yes/no answers to hooks
   * approvals whose session has ended (the task back at `ready` and one start that consumes
   * the answer, ADR 0088; the same one-shot rule) and the approve/reject answers to intake
   * proposals (ADR 0055). Runs after every answer given through this daemon's route, when a
   * session ends and, where answers can arrive from another device, on the approvals poll
   * (`approvalsPollMs`).
   */
  syncApprovals(): Promise<{
    extensions: { approved: string[]; denied: string[] };
    modelWatch: number;
    memory: { applied: number; skipped: number };
    /** Answered cross-project offers applied (spec G.6). */
    memoryOffers: { accepted: number; dismissed: number; stale: number };
    findings: BlockedSyncResult;
    signoffs: SignoffSyncResult;
    plans: PlanApprovalSyncResult;
    /**
     * Hooks approvals answered after their session ended (ADR 0088): the task back at `ready`
     * and one `message` start per approval, which consumes the answer; a refusal consumed.
     */
    late: LateApprovalSyncResult;
    intake: IntakeSyncResult;
    /** Answered specialist proposals (ADR 0071): the daemon runs them in the background; a one-shot applies none. */
    specialists: SpecialistSyncResult;
  }>;
  /** Add or drop mirror schedules after a project's settings changed. */
  refreshMirrorSchedules(): Promise<string[]>;
  /**
   * The monthly jobs (ADR 0060): the critic calibration (spec H.7, on by default, day and
   * time from `human.notify_prefs.calibration`) and the handover test (spec P.15, per project
   * whose `settings.handover.enabled` is true, off until one is). Their schedules are re-read
   * from the settings before every scheduler tick and by `refreshSchedules()`.
   */
  jobs: {
    calibration: CalibrationJob;
    handover: HandoverJob;
    refreshSchedules(): Promise<JobSchedules>;
  };
  /**
   * Run the mirror for a project now. Resolves with the run, or with the open approval request
   * as soon as the mirror asks the human (the run goes on in the background and finishes when
   * the request is answered in the inbox); a second call while a run is in flight joins it.
   */
  mirrorSync(projectId: string, opts?: { full?: boolean }): Promise<MirrorSyncOutcome>;
  close(): Promise<void>;
}

const DEFAULT_SESSION_CAP_USD_MICRO = 6_250_000; // CHF 5 at 0.8 CHF/USD

/** What `jobs.refreshSchedules()` answers: the calibration's switch and the handover projects. */
export interface JobSchedules {
  calibration: boolean;
  handover: string[];
}

/**
 * How `specialistSpecFrom` turns a registry entry's `allowed_tools` into the names a run token
 * carries (ADR 0043). The registry names Claude Code tools (`cc:Read`, ...) for the Agent SDK
 * driver; on the loop driver the token gets their built-in equivalents (`loopToolsFor`),
 * resolved against the tools registered at the moment of the lookup (bridged extension tools
 * come and go), so the hooks check the names the driver actually calls.
 */
export interface SpecialistSpecOptions {
  /** The driver the executor runs specialists on: "sdk" keeps `cc:` names as written. */
  driver: SpecialistDriver;
  /** The loop driver's tool names right now (`toolsForRun().names()`). */
  tools: () => readonly string[];
  /** Whether the entry may get `run_command` (`cc:Bash`); default: when it requires a sandbox. */
  commands?: (d: SpecialistDef) => boolean;
  /** Told at every lookup about each name the loop driver will not offer; never silent. */
  onDropped?: (specialist: string, drop: DroppedTool) => void;
  /**
   * Domains added to an entry's own `allowed_domains` at lookup, given the tool names the run
   * will carry (ADR 0047: an entry that names a browser tool gets the projects' site
   * allowlists; the session token caps them to the session's project when the run token is
   * derived, so nothing is widened beyond the session grant).
   */
  extraDomains?: (d: SpecialistDef, tools: readonly string[]) => readonly string[];
}

/**
 * The registry's runnable entries as the executor's `SpecialistSpec`s, their `allowed_tools`
 * in the form of the driver the options name (see `SpecialistSpecOptions`). The driver is
 * never defaulted: a caller that names none gets an error at the call, not the SDK form on a
 * loop-driver executor. Executors built outside `composeRuntime` take `RuntimeApp.specialists`.
 */
export function specialistSpecFrom(
  registry: Registry,
  opts: SpecialistSpecOptions,
): (name: string, driver?: SpecialistDriver) => SpecialistSpec | undefined {
  const defaultDriver: SpecialistDriver | undefined = opts?.driver;
  if (defaultDriver !== "loop" && defaultDriver !== "sdk") {
    throw new ForerunnerError(
      "validation",
      'specialistSpecFrom needs the driver the executor runs specialists on ("loop" or "sdk")',
    );
  }
  // The second argument is the executor's per-task choice (ADR 0044): a subscription run asks
  // for the "sdk" form of the same entry; anything else gets the composition's default.
  return (name, driver = defaultDriver) => {
    const d = registry.specialists.get(name);
    if (!d?.runnable) return undefined;
    let allowedTools = [...d.allowed_tools];
    if (driver === "loop") {
      const mapping = loopToolsFor(d.allowed_tools, {
        available: opts.tools(),
        commands: opts.commands ? opts.commands(d) : d.requires_sandbox,
      });
      for (const drop of mapping.dropped) opts.onDropped?.(d.name, drop);
      allowedTools = mapping.tools;
    }
    const extra = opts.extraDomains?.(d, allowedTools) ?? [];
    return {
      name: d.name,
      prompt: d.prompt,
      promptVersion: d.promptVersion,
      defaultTier: d.default_tier,
      defaultEffort: d.default_effort,
      maxEffort: d.max_effort,
      allowedTools,
      allowedDomains: extra.length
        ? [...new Set([...d.allowed_domains, ...extra])]
        : d.allowed_domains,
      maxBudgetUsdMicro: Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: d.max_turns,
      timeoutMs: d.timeout_minutes * 60_000,
      // The D.4 settings the file names (ADR 0072); absent ones come from the effort table.
      ...(d.max_tokens !== undefined ? { maxTokens: d.max_tokens } : {}),
      ...(d.speed_mode !== undefined ? { speedMode: d.speed_mode } : {}),
      ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
    };
  };
}

/** The audit row kind for a registry tool a run will not offer (ADR 0043); declared in the registry module. */
export { TOOL_UNMAPPED_AUDIT };

/**
 * The audit row kind of an `injection_flagged` run event (ADR 0047): one per run and tool,
 * `allowed: true` (the content was wrapped as data and ignored, nothing was refused), the
 * source, the rules and the score in the summaries, never the flagged passages.
 */
export const INJECTION_FLAGGED_AUDIT = "injection.flagged";

/**
 * Audit rows for the names `specialistSpecFrom` drops: one row per specialist and tool for the
 * life of the composition (a later lookup that drops a name already on record adds nothing),
 * each naming the specialist and the tool, `allowed: false`, the reason as `denied_reason`.
 * `flush()` waits for the rows in flight; compose calls it after looking every runnable entry
 * up once, so every drop is on record before the first run.
 */
export function droppedToolAudit(deps: {
  audit: { append(row: NewAuditLog): Promise<unknown> };
  agentId: string;
  humanId: string;
  warn?: (message: string, context: Record<string, unknown>) => void;
}): { onDropped: (specialist: string, drop: DroppedTool) => void; flush: () => Promise<void> } {
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  const onDropped = (specialist: string, drop: DroppedTool): void => {
    const key = `${specialist}\n${drop.tool}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.warn?.("specialist tool not offered on the loop driver", {
      specialist,
      tool: drop.tool,
      reason: drop.reason,
    });
    pending.push(
      deps.audit
        .append({
          agent_id: deps.agentId,
          human_id: deps.humanId,
          tool: TOOL_UNMAPPED_AUDIT,
          input_summary: `${specialist}: ${drop.tool}`,
          result_summary: `dropped (${drop.reason})`,
          allowed: false,
          denied_reason: `tool_not_allowed: ${drop.message}`,
        })
        .then(
          () => undefined,
          (e: unknown) => {
            deps.warn?.("could not record the dropped tool", {
              specialist,
              tool: drop.tool,
              error: errorMessage(e),
            });
          },
        ),
    );
  };
  return {
    onDropped,
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
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
    opts: { phase: "work" | "review"; billing?: CapsBilling },
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
    // A subscription run adds the plan level (spec I.1, ADR 0044): the share the run reports
    // against the source's cap; at 80% of it finish the current task, at the cap stop.
    const plan = opts.billing?.kind === "subscription" ? opts.billing : undefined;
    const r = await this.checker.check(scope, estimateUsdMicro, {
      phase: opts.phase,
      caps: {
        monthUsdMicro: caps.monthUsdMicro > 0 ? caps.monthUsdMicro : Number.MAX_SAFE_INTEGER,
        projectUsdMicro: caps.projectUsdMicro > 0 ? caps.projectUsdMicro : undefined,
        sessionUsdMicro: Number.MAX_SAFE_INTEGER, // the session cap is enforced in-process by SessionBudget
        ...(plan?.planShareCap !== undefined ? { planShareCap: plan.planShareCap } : {}),
      },
      ...(plan && typeof plan.planUsageShare === "number"
        ? { planUsageShare: plan.planUsageShare, sourceKind: "subscription" as const }
        : {}),
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
  // Private memory stays on this PC (spec "never leave that PC", ADR 0002): next to a shared
  // state the agent_private scope lives in a local index; the shared store never sees it.
  const indexUrl =
    opts.privateIndexUrl === undefined ? privateIndexUrl(stateUrl, dirs) : opts.privateIndexUrl;
  let privateStore: StateStore | null = null;
  if (indexUrl) {
    try {
      privateStore = await openPrivateIndex(indexUrl, clock);
    } catch (e) {
      await store.close().catch(() => undefined);
      throw e;
    }
  }
  const vault = opts.vault ?? (await openVault({ profile: config?.profile ?? "default", env }));
  const events = new EventEmitter();
  events.setMaxListeners(100);

  // Identity (ADR 0082): this install's own human, by selector (the caller's, FORERUNNER_HUMAN,
  // config.json's id, then its email), never the store's first row: on a shared store that row
  // is another person. Created on first run only when nothing names one and the store holds
  // none (or none with the configured email); several humans and no selector refuse the start.
  const identitySelectors = installIdentitySelectors({
    humanId: opts.identity?.humanId,
    email: opts.identity?.email,
    env,
    config,
  });
  let human: HumanRow;
  let identity: InstallIdentity;
  try {
    ({ human, identity } = await bindInstallHuman(store, identitySelectors, (email) =>
      store.human.insert({
        name: opts.identity?.humanName ?? config?.humanName ?? env.USERNAME ?? env.USER ?? "me",
        email: email ?? "",
        timezone: opts.identity?.timezone ?? config?.timezone ?? "UTC",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: Math.round(150 / (opts.chfPerUsd ?? 0.8)) * 1_000_000,
        locale: "en",
      }),
    ));
  } catch (e) {
    await store.close().catch(() => undefined);
    throw e;
  }
  logger.info("install identity", { humanId: human.id, source: identity.source });
  // An install started from its config.json records the human it found or created there, so
  // a later email change in the store never rebinds it; an override from the environment or
  // the caller is for this start only and is never written.
  if (
    opts.config === undefined &&
    config &&
    (identity.source === "email" || identity.source === "only" || identity.source === "created") &&
    rememberBoundHuman(dirs, human.id)
  ) {
    logger.info("install identity recorded in config.json", { humanId: human.id });
  }
  const principals = await store.agent.principals(human.id);
  const agent =
    pickPrincipal(principals, opts.identity?.agentName ?? env.FORERUNNER_AGENT_NAME) ??
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

  // Schema compatibility with the shared state (spec M): the store's applied migration version
  // against the one this code ships. A mismatch pauses every sync below from here on, audits
  // it and files one inbox item; the peer feed and the update health check re-evaluate.
  const schemaSync = new SchemaSync({
    store,
    clock,
    humanId: human.id,
    localSchemaVersion: opts.schemaSync?.localSchemaVersion,
    minSchema: opts.schemaSync?.minSchema,
  });
  await schemaSync.refresh("startup");

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

  // Billing (ADR 0044): the human's sources from the vault, both when both credentials exist
  // (a `subscription` row for the OAuth token, an `api_key` row for the key; a `fake` row only
  // when nothing else exists), the pick per task through the router (below), and the source
  // the loop paths (critic, chat, evals) are billed to: the one the Messages provider above
  // authenticates with, which is the key when there is one.
  // The plan allowance (`limits.planUsdMicro`): the option, the environment, config.json,
  // else the default, so the plan share cap is never silently absent.
  const planAllowance = resolvePlanAllowance([
    { value: opts.billing?.planUsdMonthly, origin: "option" },
    { value: env[PLAN_USD_MONTHLY_ENV], origin: "env" },
    { value: config?.subscription?.planUsdMonthly, origin: "config" },
  ]);
  const billingRows = await seedBillingSources({
    store,
    vault,
    humanId: human.id,
    env,
    planAllowance,
  });
  const rowFor = (ref: string) => billingRows.find((r) => r.credential_ref === ref && r.enabled);
  const hasKey = await vault.has(SECRET_NAMES.anthropic);
  const hasOauth = await vault.has(SECRET_NAMES.anthropicOauth);
  const billingSourceId =
    (hasKey ? rowFor(SECRET_NAMES.anthropic)?.id : undefined) ??
    (hasOauth ? rowFor(SECRET_NAMES.anthropicOauth)?.id : undefined) ??
    billingRows.find((r) => r.enabled)?.id ??
    billingRows[0]?.id ??
    "";
  const personalRunner =
    opts.billing?.personalRunner ?? env.FORERUNNER_RUNNER_PERSONAL?.trim() !== "0";
  const taskBilling = new RouterTaskBilling({
    store,
    vault,
    clock,
    humanId: human.id,
    personalRunner,
    ...(opts.billing?.probe ? { probe: opts.billing.probe } : {}),
  });
  const sdkHostCommands = sdkHostCommandsEnabled(env, opts.billing?.hostCommands);
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
  // The pricing table in force: built-ins plus <config>/pricing.json; the model watch's
  // onAdopted replaces it (below) so the next run is priced at the adopted rows.
  let pricingTable: PricingTable = await loadPricing(join(dirs.config, PRICING_FILE_NAME));
  const costLedger = new CostLedger({
    sink: ledgerStore,
    query: ledgerStore,
    runs: ledgerStore,
    sessions: ledgerStore,
    rates,
    clock,
    pricing: pricingTable,
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
  // Shared secrets (spec S.13, ADR 0065): the resolver reads this install's own vault first
  // and then the wrapped copy the shared state holds for this agent on this install, bound
  // once the daemon's device row exists (below, with the remote presence). Nothing is cached
  // in clear; every unwrap for a tool call is an audit row naming the secret, never the value.
  const sharedSecretService = new StoreSharedSecretService(store, { clock, installId: null });
  const sharedSecrets = new SharedSecretVault({
    local: vault,
    source: sharedSecretService,
    agentId: agent.id,
    onResolved: async (info) => {
      await store.auditLog.append({
        tool: SHARED_SECRET_AUDIT.resolved,
        human_id: human.id,
        agent_id: agent.id,
        input_summary: `name=${info.name} grant=${info.grantId} owner=${info.ownerHumanId}`,
        result_summary: "unwrapped for a tool call on this install",
        allowed: true,
        occurred_at: clock.nowIso(),
      });
    },
  });
  const secrets = new SecretResolver(sharedSecrets);

  // The ladder and effort table in force (spec D, ADR 0039): the built-ins with the adopted
  // <config>/models.json applied; a malformed file is ignored with an audit row. The holder is
  // replaced in place when the model watch adopts a change (onAdopted, below), so the next run
  // and the next chat turn pick the adopted rung and effort without a restart.
  const modelSettings = new FileModelSettingsStore({
    configDir: dirs.config,
    nowIso: () => clock.nowIso(),
  });
  const modelConfig = await readEffectiveModelConfig({
    settings: modelSettings,
    audit: store.auditLog,
    clock,
    humanId: human.id,
  });
  /**
   * The rung model of a tier on the provider, from the tables in force; `ladder.ts` is the
   * one source of model ids, so a provider the ladder does not know throws here as it does
   * in the executor (the closures below call this per run, never at compose).
   */
  const rungModelFor = (p: ModelProvider, tier: ModelTier): string =>
    modelIdFor(tier, p.name, modelConfig.get().ladder);
  /** Pricing closures that follow the tables in force, so an adopted change prices the next call. */
  const livePricing = (p: ModelProvider, modelOf: () => string): RunPricing => ({
    estimate: (inputTokens, maxOutputTokens) =>
      pricingForProvider(p, modelOf(), pricingTable).estimate(inputTokens, maxOutputTokens),
    cost: (usage) => pricingForProvider(p, modelOf(), pricingTable).cost(usage),
  });

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
  // The Agent SDK driver (ADR 0004): the same hooks, kill switch and clock; `queryImpl` is
  // the test seam so no test spawns Claude Code. A task picks it when its billing source is a
  // subscription (ADR 0044); the credential is read from the vault at that run's start.
  const sdkDriver = new SdkAgentDriver({
    hooks,
    kill,
    clock,
    ...(opts.sdkQuery ? { queryImpl: opts.sdkQuery } : {}),
  });
  // The driver specialists run on by default (ADR 0004, ADR 0043): the in-process loop
  // driver built above, on an API-style source. The registry names Claude Code tools and
  // each driver maps them, so the default is set here, next to the drivers, and
  // `specialistSpecFrom` follows it: "loop" maps `cc:` names to the built-ins, "sdk" passes
  // them through unchanged. Per task the executor asks for the "sdk" form when the billing
  // pick names a subscription (ADR 0044).
  const specialistDriver: SpecialistDriver = "loop";

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
  // Files and data (spec L.1, A.3, K.2): the registry behind the Data tab routes and the four
  // data tools. The tools run behind the hooks like any other; `data_register` outside the
  // run's allowed roots (or a URI) asks the human through the same approval port the hooks
  // use. Nothing under the projects root is ever a worktree.
  const dataAssets = new DataAssets({
    store,
    clock,
    projectsRoot: opts.data?.projectsRoot ?? join(dirs.data, "projects"),
    ...(opts.data?.limits ? { limits: opts.data.limits } : {}),
  });
  // A GitHub repository import (A.3, ADR 0069) resolves its token from the vault by reference
  // (the install's own `secret:github_token` when the request names none and the URL is on the
  // git remote base) and hands it to git through the process environment; the clone lands
  // under `<data>/projects/<id>/repos`.
  const dataImporter = new DataImporter({
    assets: dataAssets,
    store,
    clock,
    vault,
    defaultTokenRef: `secret:${SECRET_NAMES.github}`,
    ...(opts.data?.gitRemoteBase ? { gitRemoteBase: opts.data.gitRemoteBase } : {}),
  });
  registerDataTools(tools, { assets: dataAssets, approvals: ports.approvals });
  // Desktop control (spec L.4, S.32; ADR 0021, ADR 0039): one controller per daemon behind the
  // six desktop_* tools. The gate inside every tool reads the binding per call: the
  // `desktop-control` extension row (off until a human installs and enables it), the project's
  // autonomy level and the human's allowlist. A machine without a usable desktop gets an
  // adapter that refuses every action in code. The indicator is a runtime bus event the
  // attached shells render as a banner; the log line is the fallback.
  const desktopDetect = opts.desktop?.detect ?? (() => desktop.detectAdapter({ env }));
  const desktopDetection = opts.desktop?.adapter ? null : await desktopDetect();
  // The file store guarded: a hand-edited file that does not read is a `validation` error
  // naming the file (every action refused, one audit row per refused read), never
  // `internal` with the parser's message.
  const desktopAllowlistFile = join(dirs.config, desktop.DESKTOP_ALLOWLIST_FILE);
  const desktopAllowlist =
    opts.desktop?.allowlist ??
    new GuardedAllowlistStore(
      new desktop.FileAllowlistStore({ path: desktopAllowlistFile }),
      desktopAllowlistFile,
      { audit: store.auditLog, clock },
    );
  const desktopController = new desktop.DesktopController({
    adapter:
      opts.desktop?.adapter ??
      desktopDetection?.adapter ??
      new UnavailableDesktopAdapter(
        desktopDetection ?? { platform: currentPlatform(), missing: ["desktop adapter"] },
      ),
    binding: desktopBindingResolver({
      extensions: store.extension,
      projects: store.project,
      humans: store.human,
      allowlist: desktopAllowlist,
    }),
    indicator: new desktop.CompositeIndicator([
      new BusIndicator(events),
      ...(opts.desktop?.indicator ? [opts.desktop.indicator] : []),
      new desktop.LogIndicator(),
    ]),
    audit: ports.audit,
    clock,
    kill,
    approvals: new desktop.HumanRequestDesktopApprovals(store.humanRequest),
    // Under the data dir of this install (never a worktree); `dirs` honours FORERUNNER_HOME.
    screenshotDir: (agentId) =>
      join(dirs.data, "desktop", safeSegment(agentId, "agent"), "screenshots"),
  });
  desktopController.attachKillSwitch(kill);
  desktopController.attachExtensionRegistry(extensions);
  desktop.registerDesktopTools(tools, desktopController);
  // Sandboxed browser (spec L.2, S.30, S.31; ADR 0014, ADR 0047): one session manager per
  // daemon behind the eight browser_* tools. The binding per run is the run token's domains
  // (the hooks refused a URL outside them already; the session policy covers subresources,
  // redirects and WebSockets), the project's block list and autonomy level. Chromium through
  // Playwright when the probe finds one, else the static page reader over HTTP with the same
  // policy, the same hop cap and the same extractor (`FORERUNNER_BROWSER_MODE` decides too).
  // The tools are offered to a run only while the `browser` capability row is installed and
  // enabled (added from the catalog, approved in the inbox); the gate refuses a run in flight
  // when it is toggled off, and the manager revokes its sessions at once.
  const browserProbe = browser.resolveChromiumExecutable(env);
  const browserMode = browserModeFor(env, browserProbe, opts.browser?.mode);
  const browserBinding = browserBindingResolver({
    claims: (runId) => tokens.claimsForRun(runId),
    projects: store.project,
    humans: store.human,
  });
  const browserManager = new browser.BrowserSessionManager({
    binding: browserBinding,
    approvals: new browser.HumanRequestApprovalPort(store.humanRequest, clock),
    audit: ports.audit,
    clock,
    launch: {
      appDirs: { env },
      ...(browserProbe.executablePath ? { executablePath: browserProbe.executablePath } : {}),
      timeoutMs: opts.browser?.launchTimeoutMs ?? 60_000,
    },
  });
  browserManager.attachKillSwitch(kill);
  const realBrowserTools = browser.browserTools(browserManager);
  const browserToolSpecs: ToolSpec[] =
    browserMode === "chromium"
      ? realBrowserTools
      : browser.staticBrowserTools(realBrowserTools, {
          binding: browserBinding,
          audit: ports.audit,
          clock,
          fetch: opts.browser?.fetch ?? opts.fetchImpl,
        });
  const browserToolNames = new Set(browserToolSpecs.map((t) => t.name));
  const browserOn = browserPresence(store.extension);
  extensions.onEvent((e) => {
    if (e.name !== BROWSER_CAPABILITY_NAME) return;
    browserOn.refresh().catch((err: unknown) => {
      logger.warn("browser capability presence not refreshed", { error: errorMessage(err) });
    });
    if (e.type === "extension.disabled" || e.type === "extension.removed") {
      browserManager
        .revoke(
          "all",
          `${BROWSER_CAPABILITY_NAME} ${e.type === "extension.removed" ? "removed" : "disabled"} in the Extensions panel`,
        )
        .catch((err: unknown) => {
          logger.warn("browser revoke after extension change failed", { error: errorMessage(err) });
        });
    }
  });
  // Agent email (spec S.15 to S.29; ADR 0013, ADR 0047): the four email_* tools over the
  // capability's ports (settings row, identity, sent log, approvals, policy, the mailbox
  // opened by reference from the vault), which the notifier's email channel shares below.
  // The mode, the caps and the blocked content are the policy's per call; the tools are
  // offered to a run only while the agent's settings name a mailbox and the mode is not off.
  const emailPorts = agentEmailPorts({
    store,
    clock,
    vault,
    agentId: agent.id,
    ...(opts.notifications?.mailboxFactory
      ? { mailboxFactory: opts.notifications.mailboxFactory }
      : {}),
  });
  const emailOn = emailPresence(emailPorts);
  // The projects' site allowlists (`settings.browser.allowedDomains`), read at compose and at
  // every session start: the session grant carries its project's; a registry entry that
  // names a browser tool gets the union, which the derived run token caps to the session's.
  let browserDomains: readonly string[] = [];
  const refreshBrowserDomains = async (): Promise<void> => {
    const projects = await store.project.list({}, { limit: 1000 });
    browserDomains = [
      ...new Set(projects.flatMap((p) => browserSettingsOf(p.settings).allowedDomains)),
    ].sort();
  };
  const refreshCapabilities = async (): Promise<void> => {
    await Promise.all([browserOn.refresh(), emailOn.refresh(), refreshBrowserDomains()]);
  };
  await refreshCapabilities();
  /** The capability tools the next run is offered: those whose presence switch is on now. */
  const capabilityTools = (): ToolSpec[] => [
    ...(browserOn.enabled() ? browserToolSpecs : []),
    ...(emailOn.enabled() ? emailPorts.tools : []),
  ];
  const registry = loadRegistry(registryDir, {
    toolNames: [...tools.names(), ...browserToolNames, ...emailPorts.tools.map((t) => t.name)],
  });
  const toolsForRun = (): ToolRegistry => {
    const out = new ToolRegistry();
    for (const name of tools.names()) {
      const t = tools.get(name);
      if (t) out.register(t);
    }
    for (const t of capabilityTools()) {
      if (!out.get(t.name)) out.register(t);
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

  // Specialists (ADR 0043): the registry entries as the executor's `SpecialistSpec`s, their
  // `allowed_tools` mapped for the driver in use against the tools registered at each run
  // start. Every name the loop driver will not offer is an audit row
  // (`registry.tool_unmapped`) naming the specialist and the tool: once per pair, for every
  // runnable entry before the first run, and for a bridged tool that is gone at a later run
  // start.
  const droppedTools = droppedToolAudit({
    audit: store.auditLog,
    agentId: agent.id,
    humanId: human.id,
    warn: (message, context) => logger.warn(message, context),
  });
  const specialists = specialistSpecFrom(registry, {
    driver: specialistDriver,
    tools: () => toolsForRun().names(),
    // The daemon sandboxes every command, so `cc:Bash` yields `run_command` whether or not
    // the entry says `requires_sandbox`: `makeLoop` below hands the executor `sandboxPort`,
    // a run with a worktree opens a lease on it and pins `run_command` to that sandbox
    // (`withSandboxedCommands`; a lease the port refuses, a tier 2+ task with no engine and no
    // `allowProcessSandbox`, ends the run before any command), and without a worktree the
    // daemon's `run_command` refuses to run with no working directory. No command reaches the
    // host either way, which is the promise `commands` stands for.
    commands: () => true,
    onDropped: droppedTools.onDropped,
    extraDomains: (_d, mapped) =>
      mapped.some((t) => browserToolNames.has(t)) ? browserDomains : [],
  });
  for (const d of registry.runnableSpecialists()) specialists(d.name);
  await droppedTools.flush();

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
  // With a shared state the private scope is routed to the local index opened above.
  const memory = new MemoryLoop({
    store,
    ...(privateStore ? { privateStore } : {}),
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
    pricing: (modelId) => pricingForProvider(provider, modelId, pricingTable),
    billingSourceId,
    criticAgentId: criticAgent.id,
    context,
    memory,
    worktreeRoot: dirs.worktrees,
    // The tables in force at every review's pick (ADR 0039): an adopted sonnet or opus rung
    // moves the tier-1 and tier-2/3 reviews with the executor and the chat.
    modelConfig: () => modelConfig.get(),
    // Opus fast mode (spec D.20, ADR 0057): the project's flag reaches the Opus reviews when
    // the source the critic is billed to is API-style, priced from the table in force.
    fastMode: async () => ({
      sourceKind: (await store.billingSource.get(billingSourceId))?.kind ?? null,
      pricing: pricingTable,
    }),
  });
  // `withMemory: false` is the handover test's executor (spec P.15 "only the repo and docs",
  // ADR 0060): its specialists get no lesson, the shared scope included.
  const makeLoop = (worktree?: string, withMemory = true) =>
    new LoopTaskExecutor({
      store,
      clock,
      tokens,
      driver,
      provider: provider ?? unavailableProvider(),
      // Priced at the sonnet rung in force; the tables follow an adopt (ADR 0039).
      pricing: provider
        ? livePricing(provider, () => rungModelFor(provider, "sonnet"))
        : { estimate: () => 0, cost: () => 0 },
      // Every loop run priced by the model its records name, from the table in force: its own
      // rung, or the fast-mode variant of the Opus rung (spec D.20, ADR 0057).
      ...(provider
        ? { pricingFor: (modelId: string) => pricingForProvider(provider, modelId, pricingTable) }
        : {}),
      pricingTable: () => pricingTable,
      tools,
      toolsFor: toolsForRun,
      sandbox: sandboxPort,
      context,
      billingSourceId,
      // Per-task billing (ADR 0044): the router picks the source; a subscription pick runs on
      // the SDK driver with the OAuth token read from the vault by the source's reference,
      // priced from the table in force for the Anthropic model id the ladder names.
      billing: taskBilling,
      sdk: {
        driver: sdkDriver,
        credential: (source) => credentialFor(source, vault),
        workRoot: join(dirs.worktrees, "sdk-runs"),
        pricing: (modelId) => pricingFor(modelId, pricingTable),
        hostCommands: sdkHostCommands,
      },
      specialists,
      ...(withMemory ? { memory } : {}),
      modelConfig: () => modelConfig.get(),
      // The project's escalation ceiling (`critic_ceiling`, spec D.3): a retry climbs the
      // ladder under it, never under the default ceiling.
      projectCeiling: (settings) => criticSettingsOf(settings).ceiling,
      // The speed-versus-quality slider (spec D.16) is not a dependency: the executor reads
      // `speed_quality_offset` from the project row it loads per run, as the conversation agent
      // (chat and voice) does per turn, the intake per planning session and the critic per
      // review, so a slider change applies to the next one without a restart.
      ...(worktree ? { worktreeFor: async () => worktree } : {}),
      onEvent: (taskId, ev) => {
        events.emit("run", { taskId, ev });
        // The run's teardown: the desktop indicator goes off when nothing else is active.
        if (ev.type === "run_end")
          desktopController.endRun(taskId).catch((e: unknown) => {
            logger.warn("desktop indicator did not turn off", { taskId, error: errorMessage(e) });
          });
      },
    });
  // A project's repository (`repos[0]`, as owner/name or a clone URL) on the git host: the
  // PR executor's target and the project docs' target are the same resolution.
  const repoOfProject = async (project: ProjectRow | null | undefined) => {
    const ref = parseRepoRef(project?.repos[0] ?? "");
    if (!ref) return null;
    const info = await gitHost.getRepo(ref);
    return { clone: info.cloneUrl, repo: ref, base: info.defaultBranch };
  };
  const gitIdentity = {
    name: `${agent.name} (Forerunner)`,
    email: human.email || "forerunner@localhost",
  };
  const prExecutor = (withMemory: boolean) =>
    new PrTaskExecutor({
      store,
      clock,
      host: gitHost,
      inner: {
        execute: (ctx) => makeLoop(undefined, withMemory).execute(ctx),
        withWorktree: (dir) => makeLoop(dir, withMemory),
      },
      repoFor: async (task) => {
        const project = await store.project.get(task.project_id);
        const full = project?.repos[0];
        // A local folder linked by a source scan (spec A.4) is not a host repository: the
        // inner executor runs without the branch-and-PR flow, as for a project without one.
        if (!full?.includes("/") || isAbsolute(full)) return null;
        return repoOfProject(project);
      },
      worktreeRoot: dirs.worktrees,
      token: ghToken ?? undefined,
      identity: gitIdentity,
    });
  const executor = prExecutor(true);
  // Project docs (spec G.5, ADR 0058): the standard doc set on a branch and PR of the
  // project's repository, or under the project's data dir without one.
  const docs = new ProjectDocs({
    store,
    clock,
    host: gitHost,
    repoFor: repoOfProject,
    worktreeRoot: join(dirs.worktrees, "docs"),
    projectsRoot: dataAssets.projectsRoot,
    token: ghToken ?? undefined,
    identity: gitIdentity,
  });
  // The merge of a reviewed PR (spec J.9, ADR 0062): after an accepting review one `merge_pr`
  // call through the hooks on the task worktree; level 3 merges at the reviewed head once the
  // host's checks pass, below it the hooks refuse and the PR stays open for the human.
  const merge = new ReviewedPrMerge({
    store,
    clock,
    tokens,
    hooks,
    host: gitHost,
    worktreeRoot: dirs.worktrees,
    token: ghToken ?? undefined,
    identity: gitIdentity,
  });
  // The runner's ports; the handover job builds a second runner over the same ones (below).
  const runnerDeps: Omit<SessionRunnerDeps, "planner"> = {
    store,
    clock,
    tokens,
    kill,
    executor,
    context,
    critic,
    memory,
    docs,
    merge,
    schemaSync,
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
  };
  const runner = new SessionRunner({
    ...runnerDeps,
    planner: new StaticPlanner(500_000, estimates),
  });

  // PM intake (spec A.2, ADR 0055): one planning-rung call through the loop driver and the
  // hooks, the proposal as one blocking request; the approving answer writes the plan through
  // `applyProjectPlan`, the docs through the executor's branch-and-PR flow on `gitHost` (or
  // into the project's workspace under the projects root) and the first-session plan onto the
  // summary cache and the queue. Without a provider `propose` is `unavailable`.
  const intake = new IntakeService({
    store,
    clock,
    tokens,
    driver,
    provider,
    pricing: provider
      ? livePricing(provider, () =>
          rungModelFor(provider, modelConfig.get().modeDefaults.planning.tier),
        )
      : null,
    // Priced as the model the call uses: the principal's planning rung may differ (spec D.4).
    ...(provider ? { pricingFor: (model: string) => livePricing(provider, () => model) } : {}),
    // The planning rung stays under the project's ceiling, as a specialist run does (D.3).
    projectCeiling: (settings) => criticSettingsOf(settings).ceiling,
    billingSourceId,
    modelConfig: () => modelConfig.get(),
    prompt: registry.principals.get("project-manager")?.prompt,
    maxEffort: registry.principals.get("project-manager")?.max_effort,
    promptVersion: registry.principals.get("project-manager")?.promptVersion,
    human: { id: human.id },
    agent: { id: agent.id, name: agent.name },
    gitHost,
    ...(ghToken ? { gitToken: ghToken } : {}),
    identity: { name: `${agent.name} (Forerunner)`, email: human.email || "forerunner@localhost" },
    projectsRoot: dataAssets.projectsRoot,
    worktreeRoot: dirs.worktrees,
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
    await schemaSync.assertCanSync("mirror.sync");
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
  // human requests. Nothing changes a ladder or a price without a recorded "adopt"; after one,
  // `onAdopted` swaps the tables in force so the next run uses them (ADR 0039).
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
  // Proposed specialists (spec C.5, ADR 0071): the approving answer runs the proposal's eval
  // set through the same eval runner as the model watch (every call under the hooks, charged
  // to this human, the run capped by the approval eval budget before the first call) on the
  // rung of the proposal's default tier; a pass moves it to specialists/ and the live
  // registry picks it up at once, so the executor's next lookup finds it runnable.
  const specialistApprovals = new SpecialistApprovals({
    store,
    clock,
    registryDir,
    humanId: human.id,
    agentId: agent.id,
    evals: evalRunner,
    loadOptions: {
      toolNames: [...tools.names(), ...browserToolNames, ...emailPorts.tools.map((t) => t.name)],
    },
    target: (def) =>
      provider
        ? {
            provider: provider.name,
            model: rungModelFor(provider, def.default_tier),
            effort: def.default_effort,
            pricing: pricingTable,
          }
        : null,
    onPromoted: (def) => {
      registry.specialists.set(def.name, def);
    },
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
    onAdopted: (ev) => {
      modelConfig.adopt(ev.config);
      pricingTable = ev.pricing;
      logger.info("model settings adopted", { reportId: ev.reportId, applied: ev.applied });
    },
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
    ports: emailPorts,
  });
  // Only the `/events` streams that show toasts count as shells (`shells.ts`): the UI's own
  // EventSource, the phone's web view and a browser tab receive the frame but show nothing,
  // so with none of the shells attached the OS notifier runs.
  const shells = new ShellPresence();
  // The clients that play `speak.started` utterances (ADR 0063); without one nothing is heard,
  // so the voice channel skips and `summary.speak` answers with the text.
  const speechPlayers = new ShellPresence();
  // The voice loop's sessions are composed later; an alert never talks over an open one.
  let voiceBusy: () => string | null = () => null;
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
  // The speaker (ADR 0063) is composed after the command registry and the voice registry;
  // the voice channel and the `speak` command port reach it through this binding, and a
  // request before it exists (none in practice: nothing dispatches during compose) is refused.
  let speech: SpeakSessions | null = null;
  const speaker = (): SpeakSessions => {
    if (!speech) throw new ForerunnerError("unavailable", "the speaker is not composed yet");
    return speech;
  };
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
            // Urgent alerts read aloud on top of the toast, with a shell attached and outside
            // quiet hours, when the human turned voice alerts on (ADR 0063).
            new VoiceChannel({
              clock,
              playersConnected: () => speechPlayers.count(),
              busy: () => voiceBusy(),
              speak: speakThrough(speaker),
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
  // ADR 0081: a mode change to off turns email commands off in the settings store; the
  // owner hears it here whoever changed the mode (the audit row is the store's).
  emailPorts.settings.onCommandsSwitchedOff((e) =>
    notifyLater(notifications.emailCommandsOff(human.id, e), "email commands off"),
  );
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
  // Prompt injection seen and ignored (spec S.2, S.25; ADR 0047): every `injection_flagged`
  // run event of either driver (the hooks scanned an untrusted tool result and wrapped it as
  // data) is one audit row and one urgent notification, once per run and tool. The report's
  // rules, counts and score travel; the flagged passages never leave the session log.
  const flaggedByTask = new Map<string, Set<string>>();
  const flagInjection = async (
    taskId: string,
    ev: Extract<RunEvent, { type: "injection_flagged" }>,
  ): Promise<void> => {
    // One run of a task at a time: the task's set is the run's, cleared at its `run_end`.
    const seen = flaggedByTask.get(taskId) ?? new Set<string>();
    if (seen.has(ev.tool)) return;
    seen.add(ev.tool);
    flaggedByTask.set(taskId, seen);
    const runs = await store.run.forTask(taskId);
    const run = runs.find((r) => r.outcome === "running") ?? runs[runs.length - 1];
    const task = await store.task.get(taskId);
    const rules = [...new Set(ev.report.matches.map((m) => m.rule))].sort();
    await store.auditLog.append({
      session_id: run?.session_id ?? null,
      run_id: run?.id ?? null,
      agent_id: agent.id,
      human_id: human.id,
      tool: INJECTION_FLAGGED_AUDIT,
      input_summary: `${ev.tool}: ${ev.report.source}`,
      result_summary: `ignored: ${ev.report.matches.length} instruction-like passage(s), rules ${rules.join(", ")}, score ${ev.report.score}; the human was notified`,
      allowed: true,
      occurred_at: clock.nowIso(),
    });
    await notifications.injectionFlagged(human.id, ev.report, {
      origin: ev.tool,
      sessionId: run?.session_id,
      projectId: task?.project_id ?? null,
    });
  };
  events.on("run", (e: { taskId: string; ev: RunEvent }) => {
    if (e.ev.type === "run_end") {
      // A retry of the task is a new run: its flags count again.
      flaggedByTask.delete(e.taskId);
      return;
    }
    if (e.ev.type !== "injection_flagged") return;
    notifyLater(flagInjection(e.taskId, e.ev), `injection flagged in ${e.ev.tool}`);
  });
  const agentNameOf = async (agentId: string): Promise<string | undefined> =>
    agentId === agent.id ? agent.name : (await store.agent.get(agentId))?.name;

  // The session grant (ADR 0044): the loop tools, the bridged tools and, when a subscription
  // source exists, the Claude Code names, so a run token derived for the SDK path can carry
  // the registry's `cc:` names (a derived token only narrows); the loop driver never offers a
  // `cc:` name, so an install without the OAuth token declares none. The SDK work root sits
  // under the worktrees root, which the grant's paths cover.
  // The capability tools present at this start join the grant; the project's own site
  // allowlist (`settings.browser.allowedDomains`) joins the domains (ADR 0047).
  // The shared secrets active for this agent join the grant by name (spec S.13): the hooks'
  // granted-names rule is unchanged, the resolver finds the value by reference.
  const sessionGrant = (project: { settings: JsonObject } | null, sharedNames: string[]) => ({
    allowedTools: [
      ...tools.names(),
      ...capabilityTools().map((t) => t.name),
      ...extensions.bridgedTools().map((t) => t.name),
      ...(hasOauth ? claudeCodeToolNames() : []),
      // The runtime's merge step (J.9, ADR 0062); no model is offered it (no registry has it).
      MERGE_PR_TOOL,
    ],
    allowedPaths: [dirs.worktrees],
    allowedDomains: [
      ...new Set([
        hostOf(config?.githubApiBase ?? "https://api.github.com"),
        "github.com",
        ...browserSettingsOf(project?.settings).allowedDomains,
      ]),
    ],
    grantedSecrets: [...(ghToken ? [SECRET_NAMES.github] : []), ...sharedNames],
    maxDepth: 2,
  });
  // Monthly jobs (ADR 0060). The calibration runs the critic over the registry's eval sets
  // under a budget from the human's settings; the handover runs ONE session of a fresh agent
  // on the flagged project, planned over the seeded task alone and without a memory port
  // (`runSession` below is that session: the same ports, grant and gate as any other).
  const calibrationJob = new CalibrationJob({
    store,
    clock,
    tokens,
    critic: critic.service,
    registry,
    outDir: join(dirs.data, "critic"),
    notifier,
    humanId: human.id,
    agentId: agent.id,
    criticAgentId: criticAgent.id,
    settings: async () => calibrationSettingsOf((await store.human.mustGet(human.id)).notify_prefs),
    // The once-a-month check is the human's local month, as the schedule's (ADR 0060).
    timezone: async () => (await store.human.mustGet(human.id)).timezone,
  });
  const handoverJob = new HandoverJob({
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    reportDir: join(dirs.data, "handover"),
    notifier,
    timezone: async () => (await store.human.mustGet(human.id)).timezone,
    runSession: async ({ agentId, projectId, taskId, budgetCapUsdMicro }) => {
      await schemaSync.assertCanSync("session.start");
      if (!provider)
        throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
      const project = await store.project.mustGet(projectId);
      await refreshCapabilities();
      // No memory anywhere in the session (spec P.15 "only the repo and docs", ADR 0060):
      // neither the runner's lessons block nor the executor's per-task recall.
      const handoverRunner = new SessionRunner({
        ...runnerDeps,
        executor: prExecutor(false),
        memory: undefined,
        planner: new SeedOnlyPlanner(taskId, new StaticPlanner(500_000, estimates)),
      });
      return handoverRunner.start({
        agentId,
        projectId,
        trigger: "schedule",
        budgetCapUsdMicro,
        appVersion,
        grant: sessionGrant(project, await sharedSecretNamesFor(store, agentId)),
        onEvent: (type, payload) => events.emit("session", { type, payload, agentId, projectId }),
      });
    },
  });
  /**
   * The jobs' schedules from the settings as they stand: the calibration's day, time and
   * switch from the human's prefs, one handover entry per flagged project. Run at compose,
   * before every scheduler tick (so a settings change by any route, command or device takes
   * effect at the next tick) and by the project settings route.
   */
  const refreshJobSchedules = async (target: Scheduler): Promise<JobSchedules> => {
    const h = await store.human.mustGet(human.id);
    const cal = calibrationSettingsOf(h.notify_prefs);
    scheduleCalibration(target, {
      timezone: h.timezone,
      day: cal.day,
      time: cal.time,
      enabled: cal.enabled,
    });
    const projects = await store.project.list({}, { limit: 1000 });
    return {
      calibration: cal.enabled,
      handover: syncHandoverSchedules(target, projects, h.timezone),
    };
  };
  const startSession = async (req: StartRequest) => {
    // The model watch, the memory consolidation and the monthly jobs are local jobs (this
    // install's providers and this human's memory); only a session syncs with peers, so only
    // it waits on the gate (the handover's own session does, inside the job).
    if (isModelWatchRequest(req)) return modelWatch.run();
    if (isMemoryConsolidationRequest(req)) return memory.propose();
    if (isCalibrationRequest(req)) return calibrationJob.run();
    if (isHandoverRequest(req)) return handoverJob.run(req.projectId as string);
    return runSession(req);
  };
  // The scheduler runs a start in the background and only logs a rejection: one bound to an
  // approved plan is reported on the plan request and the human is warned (ADR 0053).
  const runSession = reportingPlanStartFailures(
    { store, clock, humanId: human.id, agentId: agent.id },
    async (req: StartRequest) => {
      await schemaSync.assertCanSync("session.start");
      if (!provider)
        throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
      const project = req.projectId ? await store.project.mustGet(req.projectId) : null;
      // What the run is offered is decided now: the capability rows and settings as they stand.
      await refreshCapabilities();
      // The cap the command registry wrote (a temporary override while its window is open, else
      // the permanent setting), so a session the scheduler starts honours "give it 20 francs
      // tonight" exactly as one started by the command (spec Q.12).
      const cap = sessionCapFromSettings(
        project?.settings,
        clock.now(),
        DEFAULT_SESSION_CAP_USD_MICRO,
      ).usdMicro;
      // A start bound to an approved plan carries the filing session's cap (`syncPlanApprovals`).
      const budgetUsdMicro = req.budgetUsdMicro ?? cap;
      const result = await runner.start({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: req.trigger,
        budgetCapUsdMicro: budgetUsdMicro,
        // The approved plan's id from the inbox answer (`syncPlanApprovals`); never a bare true.
        ...(req.planApproved ? { planApproved: req.planApproved } : {}),
        appVersion,
        grant: sessionGrant(project, await sharedSecretNamesFor(store, req.agentId)),
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
      // An answer that came while the session ran, for a call it did not re-make (a task it
      // had already moved past), is late now (ADR 0088): apply it at once rather than at the
      // next answer or poll. The result stands whatever the sync does.
      if (!schemaSync.paused) {
        await syncApprovals().catch((e: unknown) =>
          logger.warn("answers not applied at session end", {
            sessionId: result.sessionId,
            error: errorMessage(e),
          }),
        );
      }
      return result;
    },
  );
  // Mirror requests run the mirror, the model watch its weekly check, everything else a session.
  // The scheduler's mirror runs go through the gate like `mirrorSync` (same audit site): a
  // paused install keeps its schedules but no run reads the shared state or pushes to GitHub.
  const gatedMirror: Pick<ProjectsMirror, "sync"> = {
    sync: async (projectId, o) => {
      await schemaSync.assertCanSync("mirror.sync");
      return mirror.sync(projectId, o);
    },
  };
  const scheduler = new Scheduler({
    clock,
    start: mirrorStartHandler(gatedMirror, startSession, { agentId: agent.id }),
    // The fired day or month of every schedule survives a restart (a monthly job on a live
    // model must not run twice because the daemon came back after its time, ADR 0060).
    fired: fileFiredKeys(join(dirs.data, "scheduler-fired.json")),
    refresh: async (target) => {
      await refreshJobSchedules(target);
    },
  });
  scheduleModelWatch(scheduler, { timezone: human.timezone });
  // Weekly memory consolidation (spec G.4): report only; the human applies it from the inbox.
  scheduleMemoryConsolidation(scheduler, { timezone: human.timezone });
  // The command registry (spec Q): every change by chat, voice, the UI or the phone runs here.
  // session.start reports the scheduler's outcome; the undo of a start that only queued drops
  // the waiting request (ADR 0036), of a start still running stops that session only, and of
  // a start whose session ended is a no-op the loop refuses with the reason (RT-P5-2).
  const { startUndoState, ...sessionPorts } = sessionCommandPorts({ scheduler, kill, store });
  const commands = new CommandLoop({
    store,
    clock,
    startUndoState,
    ports: {
      chfPerUsd: async () => chfPerUsd(),
      // The prices in force for an effect that quotes one (fast_mode, ADR 0057).
      pricingTable: () => pricingTable,
      ...sessionPorts,
      // session.pause is the graceful stop: the row reads `paused` at once and a session
      // running in this process ends at the next task boundary (the runner reads the pause
      // message between tasks); its undo withdraws the message (wiring/session-ports.ts).
      ...sessionPausePorts({ store, kill, agentId: agent.id, humanId: human.id }),
      // An answer by chat, voice, the palette or the phone applies at once, as the inbox
      // route's does (an approved plan starts its follow-up, ADR 0053). The answer stands
      // when the sync fails: the next sync (an answer, the poll, a restart) applies it.
      requestAnswered: async (requestId) => {
        if (schemaSync.paused) return;
        try {
          await syncApprovals();
        } catch (e) {
          logger.warn("answer not applied yet", { requestId, error: errorMessage(e) });
        }
      },
      // memory.record (spec O.2, ADR 0061): a lesson stated in chat or voice goes into the
      // principal's private memory through the same loop the sessions use.
      memory: memoryCommandPort(memory),
      // specialist.propose (spec C.5, ADR 0071): the PM's proposal, by the model path's tool
      // or the palette, goes through the approval gate above: the file under proposed/ (never
      // runnable) and the human's blocking request; approve runs the eval set, a pass promotes.
      specialists: specialistCommandPort({ approvals: specialistApprovals, registryDir }),
      // summary.speak (spec A.6): the speaker over the registry's TTS; without a usable
      // provider the command answers with the text instead (the reason comes back here).
      speak: async (req) => {
        // Nothing would play it: the command answers with the text instead of a silent "aloud".
        if (speechPlayers.count() <= 0) return { spoken: false, reason: VOICE_NO_PLAYER };
        try {
          const u = await speaker().say({
            text: req.text,
            subject: { kind: "project", id: req.projectId, name: req.projectName },
            source: req.source,
          });
          return { spoken: true, id: u.id };
        } catch (e) {
          return { spoken: false, reason: errorMessage(e) };
        }
      },
      // model.settings.set (spec D.4, ADR 0072): the runnable specialists and what the
      // provider in use accepts, read per command (a temperature is refused where it would
      // never be sent).
      modelSettings: {
        specialists: () => registry.runnableSpecialists().map((d) => d.name),
        maxEffort: (name) => registry.specialists.get(name)?.max_effort,
        capabilities: () =>
          provider ? providerCapabilities(provider) : { ...DEFAULT_PROVIDER_CAPABILITIES },
      },
      // email.mode.set goes through the capability's settings store (ADR 0081): a change to
      // off turns email commands off there, with its audit row and the owner's notification
      // (the `onCommandsSwitchedOff` listener above); its undo turns them back on.
      emailMode: async ({ agentId, mode, authorHuman, restoreCommands }) => {
        const before = await emailPorts.settings.get(agentId);
        const next = await emailPorts.settings.update(
          agentId,
          { settings: { mode }, ...(restoreCommands ? { commands: { enabled: true } } : {}) },
          { authorHuman },
        );
        return { commandsSwitchedOff: before.commands.enabled && !next.commands.enabled };
      },
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
  const syncSpecialistApprovals = async (): Promise<SpecialistSyncResult> => {
    const out = await specialistApprovals.syncAnswers({ background: true });
    await specialistApprovals.fileMissing().catch((e: unknown) => {
      logger.warn("specialist proposals not filed", { error: errorMessage(e) });
    });
    return out;
  };
  // One sync at a time: the answer route, the command registry's request.answer, the poll and
  // the compose-time call each read the answered requests and then act, so two that overlap
  // would both find the same answer unapplied (the plan mark is conditional as well).
  let syncChain: Promise<unknown> = Promise.resolve();
  const syncApprovals = () => {
    const run = syncChain.then(() => syncApprovalsOnce());
    syncChain = run.catch(() => undefined);
    return run;
  };
  const syncApprovalsOnce = async () => {
    await schemaSync.assertCanSync("approvals.sync");
    const out = {
      extensions: await extensions.syncApprovals({ humanId: human.id }),
      modelWatch: await modelWatch.syncPendingAnswers(),
      memory: await memory.syncApprovals(),
      memoryOffers: await memory.syncOffers(),
      findings: await syncBlockedByFindings({ store, clock, humanId: human.id, agentId: agent.id }),
      signoffs: await syncSignoffAnswers({ store, clock, humanId: human.id, agentId: agent.id }),
      // An approved session plan (spec J.6, J.7; ADR 0053) becomes a "message" start bound to
      // that plan; the scheduler keeps one session per agent. A CLI one-shot
      // (`startServices: false`) is no place to start a session from: the daemon does it.
      plans:
        opts.startServices !== false
          ? await syncPlanApprovals({
              store,
              clock,
              humanId: human.id,
              agentId: agent.id,
              start: (req) => scheduler.requestStart(req),
            })
          : { started: 0, rejected: 0, skipped: 0 },
      // A hooks approval answered after its session ended (ADR 0088): the task goes back to
      // `ready` and one "message" start of the project consumes the answer; a refusal is
      // consumed with nothing run. The same one-shot rule as the plans above.
      late:
        opts.startServices !== false
          ? await syncLateApprovals({
              store,
              clock,
              humanId: human.id,
              agentId: agent.id,
              start: (req) => scheduler.requestStart(req),
            })
          : { started: 0, refused: 0, skipped: 0 },
      intake: await intake.syncAnswers(),
      // Proposed specialists (ADR 0071): the daemon claims an approved proposal's answer here
      // and runs its eval set (minutes, real spend) in the background, recovers evaluations
      // that ended without a result, and files requests for proposals that reached disk
      // without one. A one-shot (`startServices: false`: every `fr` command, the cloud runner)
      // leaves inbox answers to the daemon, as it does plan approvals; `fr specialists
      // approve` applies its own request.
      specialists:
        opts.startServices !== false
          ? await syncSpecialistApprovals()
          : { promoted: 0, failed: 0, rejected: 0, skipped: 0, running: 0 },
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
        // The text_chat rung in force (haiku by default); the tables follow an adopt.
        pricing: livePricing(provider, () =>
          rungModelFor(provider, modelConfig.get().modeDefaults.text_chat.tier),
        ),
        // A turn is priced as the model it calls: the principal's chat rung may differ (D.4).
        pricingFor: (model: string) => livePricing(provider, () => model),
        billingSourceId,
        hooksDriver: driver,
        startSession: (req) => scheduler.request(req),
        prompt: registry.principals.get("conversation-agent")?.prompt,
        maxEffort: registry.principals.get("conversation-agent")?.max_effort,
        modelConfig: () => modelConfig.get(),
        commands,
        // Spec J.1, O.2 (ADR 0061): the principal's lessons and the project's doc sections
        // for the question, each under its token budget, in the volatile context.
        memory,
        docsDirs: async (projectId) => {
          const project = await store.project.get(projectId);
          return project ? docs.docsDirsFor(project) : [];
        },
      })
    : null;
  // Voice (spec O; ADR 0012, ADR 0048): the loop over the conversation agent, behind the
  // daemon's /voice routes. The providers are the local helpers and the cloud ones by secret
  // reference; none is probed here. Which one is preferred is the Extensions panel's choice
  // (the enabled `voice-*` rows, spec O.4) under the environment override, read at every
  // status read and session start so a toggle applies at the next session. Without a usable
  // pair, or without a model credential, `voice.status()` reports why and a session start is
  // refused with `unavailable`.
  const voiceRegistry =
    opts.voice?.registry ??
    (opts.voice?.stt || opts.voice?.tts
      ? injectedVoiceRegistry(opts.voice.stt, opts.voice.tts)
      : buildVoiceRegistry({ env, vault, clock }));
  const fixedVoicePreferences = opts.voice?.preferred;
  const voiceRows = voiceExtensionRows(extensions);
  // One source of the preferred providers for the voice sessions and the speaker (below), so
  // the TTS chosen in the Extensions panel is the one that reads summaries and alerts too.
  const voicePreferenceSource = fixedVoicePreferences
    ? () => fixedVoicePreferences
    : () =>
        resolveVoicePreferences({
          env,
          extensions: voiceRows,
          hasSecret: vaultHasSecret(vault),
          registered: { stt: voiceRegistry.sttNames(), tts: voiceRegistry.ttsNames() },
        });
  const voice = new VoiceSessions({
    registry: voiceRegistry,
    preferences: voicePreferenceSource,
    hasSecret: vaultHasSecret(vault),
    conversation: () => conversation,
    commands,
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    ...(opts.voice?.sink ? { sink: opts.voice.sink } : {}),
    storeAudio: opts.voice?.storeAudio ?? env.FORERUNNER_VOICE_STORE_AUDIO?.trim() === "1",
    audioDir: join(dirs.data, "voice"),
    env,
    ...(opts.voice?.targets ? { targets: opts.voice.targets } : {}),
    ...(opts.voice?.maxSessions ? { maxSessions: opts.voice.maxSessions } : {}),
    ...(opts.voice?.keepStopped !== undefined ? { keepStopped: opts.voice.keepStopped } : {}),
    ...(opts.voice?.retainStoppedMs !== undefined
      ? { retainStoppedMs: opts.voice.retainStoppedMs }
      : {}),
  });
  voiceBusy = () => (voice.open().length > 0 ? VOICE_IN_CONVERSATION : null);
  // Read aloud (spec A.6, L.6; ADR 0063): one speaker over the same registry, TTS only, no
  // model call; one voice at a time. Every utterance is announced on the bus (`speak`, the
  // `speak.started` frame on `/events`, with who plays it) so a speech player (the UI with
  // `/events?speech=play`) attaches to its stream and plays it; playback waits for that.
  const speechSessions = new SpeakSessions({
    registry: voiceRegistry,
    // Read per utterance from the same source as the voice sessions' providers, so the TTS
    // the human chose for the voice chat (the Extensions panel, spec O.4) is the one that
    // reads summaries and alerts.
    preferences: voicePreferenceSource,
    hasSecret: vaultHasSecret(vault),
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    sessionIdFor: () => conversationSessionId({ conversation, agent, store, clock }),
    ...(opts.voice?.sink ? { sink: opts.voice.sink } : {}),
    ...(opts.voice?.awaitListenerMs !== undefined
      ? { awaitListenerMs: opts.voice.awaitListenerMs }
      : {}),
    onStart: (u) => {
      const payload: SpeakStartedView = {
        id: u.id,
        subject: u.subject,
        source: u.source,
        player: u.player,
        sentences: u.sentences.length,
      };
      events.emit("speak", payload);
    },
  });
  speech = speechSessions;
  // The phone's push-to-talk turns (ADR 0080) arrive as remote commands and run through the
  // same sessions, one held per phone between turns.
  const voiceRelay = new VoiceRelay(voice, { clock });
  // Background services: the daemon starts them; a CLI one-shot (startServices: false) only
  // uses the composed objects and never connects a connector or ticks the scheduler.
  const services = opts.startServices !== false;
  // Remote control of this PC (spec R.4, R.8; ADR 0032 item 4, ADR 0033 items 8b and 9, ADR
  // 0041): on a shared state the daemon heartbeats its desktop row (the cloud runner's
  // PC-wins rule reads it) and polls the phone's `target: "pc"` commands. The store's pick-up
  // is keyed on this agent's owner; the watcher checks the issuing device again and runs
  // plans through the command registry, chat through the conversation agent, and the plain
  // verbs through the kill switch and scheduler.
  const remoteEnabled = remoteCommandsEnabled(env, stateUrl, services, opts.remote?.enabled);
  let remoteDevice: DeviceRow | null = null;
  let remoteWatcher: RemoteCommandWatcher | null = null;
  let presence: DesktopPresence | null = null;
  // This PC as a paired device (ADR 0030: a high-risk change from the desktop app is
  // confirmed on the desktop's own device row, ADR 0041 item 6): the daemon registers itself
  // as a `desktop` device of the human on every store, shared or local. `GET /me` names the
  // row's id, the settings screen sends it with a high-risk confirmation and the registry's
  // policy checks the row like any other device. The row is also where the install's
  // wrapping key lives (spec S.13, ADR 0065). It is registered whenever the daemon runs its
  // services, remote control is on, or it was asked for explicitly (a test, a one-shot); the
  // watcher and the heartbeat still need remote control. The cloud runner composes without
  // services or the option and keeps its own `runner` row. The identity file under the
  // config dir keeps the row stable across restarts.
  const registerDevice = services || remoteEnabled || opts.remote?.enabled === true;
  if (registerDevice) {
    // The install's wrapping key: created in the vault on first use and registered on the
    // device row, so a peer can wrap a shared secret to this install.
    const wrapKey = await ensureInstallWrapKey(vault);
    remoteDevice = await registerDesktopDevice({
      store,
      dirs,
      humanId: human.id,
      name: opts.remote?.deviceName ?? env.FORERUNNER_DEVICE_NAME?.trim() ?? osFacts(env).hostname,
      platform: currentPlatform(),
      wrapPublicKey: wrapKey.publicKey,
    });
    sharedSecretService.installId = remoteDevice.id;
    sharedSecrets.bind({
      deviceId: remoteDevice.id,
      // Read from the vault at every unwrap: the vault is the only holder of the private key.
      privateKey: async () => (await ensureInstallWrapKey(vault)).privateKey,
    });
  }
  if (remoteEnabled && remoteDevice) {
    presence = new DesktopPresence({
      store,
      clock,
      deviceId: remoteDevice.id,
      intervalMs: positiveMs(
        opts.remote?.heartbeatMs ?? env.FORERUNNER_PRESENCE_HEARTBEAT_MS,
        60_000,
      ),
    });
    const pcDeviceId = remoteDevice.id;
    remoteWatcher = new RemoteCommandWatcher({
      store,
      clock,
      kill,
      // The entry, not the bare outcome: its id is the start's identity the row's result
      // carries for the undo (ADR 0049).
      start: (req) => scheduler.requestStart(req),
      commands,
      chat: conversation ? (req) => conversation.chat(req) : null,
      voice: (req) => voiceRelay.turn(req),
      conversationSessionId: () =>
        conversation
          ? conversation.conversationSessionId(agent.id, null)
          : ensureConversationSession(store, clock, agent.id),
      deviceId: pcDeviceId,
      agentId: agent.id,
      humanId: human.id,
      pollMs: positiveMs(opts.remote?.pollMs ?? env.FORERUNNER_REMOTE_POLL_MS, 500),
    });
  }
  // CI results and PR comments start sessions (spec E.1, ADR 0075): the agent's open PRs (the
  // task rows' `pr_url`) are polled on the clock; a failed check or a green head fires `ci`,
  // a comment or review by anyone but the agent fires `pr_comment`, through the scheduler (one
  // active session per agent). The comment reaches the agent's inbox quoted as data; an
  // instruction-like one is audited and reported like any flagged content. Quiet hours are the
  // human's notification window (`notify_prefs.quiet_hours`): the PRs wait until it ends.
  const githostWatcher = githostWatchEnabled(
    env,
    services,
    ghToken !== null || opts.gitHost !== undefined,
    opts.githostWatch?.enabled,
  )
    ? new GitHostWatcher({
        store,
        clock,
        host: gitHost,
        agentIds: [agent.id],
        humanId: human.id,
        start: (req) => scheduler.requestStart(req),
        cursorStore: fileCursorStore(
          opts.githostWatch?.cursorPath ??
            join(dirs.data, "githost", `cursor-${safeSegment(agent.id, "agent")}.json`),
        ),
        isQuietHours: async (_agentId, now) => {
          const h = await store.human.get(human.id);
          if (!h) return false;
          const prefs = resolvePrefs(h);
          return isQuietAt(prefs.quiet_hours, prefs.timezone, now);
        },
        // A paused install reads nothing from the shared state and starts nothing.
        enabled: () => !schemaSync.paused,
        onInjection: async (report, origin, projectId) => {
          const rules = [...new Set(report.matches.map((m) => m.rule))].sort();
          await store.auditLog.append({
            agent_id: agent.id,
            human_id: human.id,
            tool: INJECTION_FLAGGED_AUDIT,
            input_summary: `githost: ${origin}`,
            result_summary: `ignored: ${report.matches.length} instruction-like passage(s), rules ${rules.join(", ")}, score ${report.score}; quoted as data in the inbox; the human was notified`,
            allowed: true,
            occurred_at: clock.nowIso(),
          });
          notifyLater(
            notifications.injectionFlagged(human.id, report, { origin, projectId }),
            `injection flagged in ${origin}`,
          );
        },
        pollMs: positiveMs(
          opts.githostWatch?.pollMs ?? env.FORERUNNER_GITHOST_POLL_MS,
          DEFAULT_GITHOST_POLL_MS,
        ),
      })
    : null;
  // Settings -> Devices (spec R.2): the admin token is read from the vault per call and
  // never reaches the app; without a service URL the list and the revocation use the store.
  const deviceServiceUrl =
    opts.devices?.serviceUrl === undefined
      ? env.FORERUNNER_STATE_API_URL?.trim() || null
      : opts.devices.serviceUrl;
  const adminTokenName = parseSecretRef(
    env.FORERUNNER_STATE_API_ADMIN_TOKEN_REF?.trim() || "secret:state_api_admin",
  );
  const devices = new DeviceManager({
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    currentDeviceId: () => remoteDevice?.id ?? null,
    service: deviceServiceUrl
      ? {
          baseUrl: deviceServiceUrl,
          adminToken: async () => opts.devices?.adminToken ?? (await vault.get(adminTokenName)),
          ...(opts.devices?.fetch ? { fetch: opts.devices.fetch } : {}),
        }
      : null,
  });
  const killWatcher = new KillFileWatcher(kill, clock, dirs.runtime);
  if (services) killWatcher.start();
  mkdirSync(evalWorkRoot, { recursive: true });
  if (services) await extensions.start();
  // The command table and the reverts of temporary changes whose window is still open.
  await commands.start();
  // A paused install still composes (the updates screen is how it gets fixed); the answered
  // approvals it would apply from the shared state wait for the resume.
  if (schemaSync.paused) logger.warn("sync paused at compose", { ...schemaSync.status() });
  else await syncApprovals();
  await refreshMirrorSchedules();
  const jobSchedules = await refreshJobSchedules(scheduler);
  if (services) scheduler.start();
  // The PC's heartbeat and the phone's commands (only built when the services run).
  presence?.start();
  remoteWatcher?.start();
  githostWatcher?.start();
  // Answers given on another device (the phone, the web approvals) land in the shared state
  // and reach no route of this daemon: the approvals poll applies them within
  // `approvalsPollMs`, the way the remote watcher picks up the phone's commands. Only where
  // answers can come from elsewhere; the daemon's answer route and the `request.answer`
  // command (chat, voice, the palette: the `requestAnswered` port) apply at once.
  const approvalsPollMs = positiveMs(
    opts.approvalsPollMs ?? env.FORERUNNER_APPROVALS_POLL_MS,
    DEFAULT_APPROVALS_POLL_MS,
  );
  let approvalsTimer: (() => void) | null = null;
  const stopApprovalsPoll = () => {
    approvalsTimer?.();
    approvalsTimer = null;
  };
  if (services && remoteEnabled) {
    const tick = async () => {
      if (!schemaSync.paused) {
        try {
          await syncApprovals();
        } catch (e) {
          logger.warn("approvals poll failed", { error: errorMessage(e) });
        }
      }
      if (approvalsTimer) approvalsTimer = clock.setTimeout(tick, approvalsPollMs);
    };
    approvalsTimer = clock.setTimeout(tick, approvalsPollMs);
  }
  // Quiet-hours holds and the daily digest are flushed on the clock; a one-shot sends at once
  // or holds in memory and never ticks.
  const stopNotifier = services ? notifier.start() : () => undefined;

  // Source discovery (spec A.4, ADR 0056): a GitHub source's host from the vault by the
  // source's own credential reference (never a value in the row), an injected host standing
  // in for every source in tests; an accepted proposal creates the project the way
  // POST /projects does; the install record tells a scanned folder that is this checkout. A
  // repository URL may name the install's git hosts only (the API base and the git remote
  // base): one on another host is refused, never read from GitHub under its owner and name.
  const sources = new SourceDiscovery({
    store,
    clock,
    repoHosts: repoHostsFor({
      githubApiBase: config?.githubApiBase,
      gitRemoteBase: opts.data?.gitRemoteBase,
    }),
    hostFor: async (source) =>
      opts.gitHost ??
      githubHostForSecretRef({
        vault,
        ref: source.credential_ref ?? undefined,
        baseUrl: config?.githubApiBase,
        clock,
        fetchImpl: opts.fetchImpl,
        audit: (name) => {
          void store.auditLog.append({
            human_id: human.id,
            tool: "secret.resolve",
            input_summary: `secret:${name} for source ${source.id}`,
            result_summary: "github host",
            allowed: true,
            occurred_at: clock.nowIso(),
          });
        },
      }),
    createProject: async (input) => {
      const p = await createProjectRecord(
        { store, human: { id: human.id }, agent: { id: agent.id }, events, conversation },
        {
          name: input.name,
          goal: input.goal,
          repos: input.repos,
          ...(input.autonomyLevel !== undefined ? { autonomyLevel: input.autonomyLevel } : {}),
          ...(input.budgetUsdMicro !== undefined ? { budgetUsdMicro: input.budgetUsdMicro } : {}),
        },
      );
      return { id: p.id, name: p.name };
    },
    installRecord: () => readInstallRecord(dirs),
  });
  logger.info("runtime composed", {
    stateUrl: stateUrl.replace(/\/\/[^@]*@/, "//[REDACTED]@"),
    vault: vault.backend,
    provider: provider?.name ?? "none",
    registry: registryDir,
    human: human.name,
    agent: agent.name,
    critic: criticAgent.name,
    sandbox: sandboxDetection.engine,
    browser: browserMode,
    email: emailOn.enabled() ? "on" : "off",
    billingSources: billingRows.filter((r) => r.enabled).map((r) => r.kind),
    planAllowance: describePlanAllowance(planAllowance),
    sdkHostCommands,
    bridgedTools: extensions.bridgedTools().length,
    mirrors: mirrorSchedules.size,
    calibration: jobSchedules.calibration ? "monthly" : "off",
    handoverProjects: jobSchedules.handover.length,
    services,
    desktopDevice: remoteDevice?.name ?? "none",
    remote: remoteEnabled ? "on" : "off",
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
    specialistDriver,
    specialists,
    tools,
    executor,
    runner,
    scheduler,
    conversation,
    gitHost,
    human: { id: human.id, name: human.name, timezone: human.timezone },
    identity,
    agent: { id: agent.id, name: agent.name },
    billingSourceId,
    billing: {
      sources: () => stateSources(store)(human.id),
      pick: taskBilling,
      sdk: sdkDriver,
      hostCommands: sdkHostCommands,
      planAllowance,
    },
    chfPerUsd,
    context,
    costLedger,
    critic,
    criticAgent: { id: criticAgent.id, name: criticAgent.name },
    memory,
    privateMemory: privateStore,
    docs,
    merge,
    sessionGrant: async (projectId) =>
      sessionGrant(
        projectId ? await store.project.mustGet(projectId) : null,
        await sharedSecretNamesFor(store, agent.id),
      ),
    commands,
    voice,
    speech: speechSessions,
    events,
    appVersion,
    startedAt: clock.now(),
    extensions,
    gate,
    updates: updates.manager,
    updateConfig,
    restarter,
    schemaSync,
    modelWatch,
    modelConfig: () => modelConfig.get(),
    pricingTable: () => pricingTable,
    estimates,
    desktop: { controller: desktopController, allowlist: desktopAllowlist, detect: desktopDetect },
    data: { assets: dataAssets, importer: dataImporter },
    sources,
    mirror,
    sandbox: { port: sandboxPort, detection: sandboxDetection },
    notifier,
    notifications,
    shells,
    speechPlayers,
    remote: {
      enabled: remoteEnabled,
      device: remoteDevice,
      watcher: remoteWatcher,
      presence,
    },
    githostWatcher,
    devices,
    sharedSecrets: {
      vault: sharedSecrets,
      service: sharedSecretService,
      propose: (input) =>
        proposeSharedSecret({
          vault,
          service: sharedSecretService,
          ownerHumanId: human.id,
          name: input.name,
          agentIds: input.agentIds,
          ...(input.why !== undefined ? { why: input.why } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
        }),
      revoke: (grantId) => sharedSecretService.revoke(grantId, human.id),
      list: () => sharedSecretService.list(human.id),
      names: () => sharedSecretNamesFor(store, agent.id),
    },
    capabilities: {
      browser: { mode: browserMode, manager: browserManager, presence: browserOn },
      email: { ports: emailPorts, presence: emailOn },
      browserDomains: () => browserDomains,
      refresh: refreshCapabilities,
    },
    toolsForRun,
    syncApprovals,
    refreshMirrorSchedules,
    jobs: {
      calibration: calibrationJob,
      handover: handoverJob,
      refreshSchedules: () => refreshJobSchedules(scheduler),
    },
    mirrorSync,
    intake,
    specialistApprovals,
    async close() {
      await voiceRelay.close();
      await voice.close();
      await speechSessions.close();
      stopApprovalsPoll();
      await specialistApprovals.settled();
      remoteWatcher?.stop();
      githostWatcher?.stop();
      await browserManager.closeAll().catch((e: unknown) => {
        logger.warn("browser sessions did not close cleanly", { error: errorMessage(e) });
      });
      presence?.stop();
      scheduler.stop();
      stopNotifier();
      killWatcher.stop();
      commands.stop();
      context.close();
      managedHeadroom?.stop();
      await desktopController.close().catch((e: unknown) => {
        logger.warn("desktop controller did not close cleanly", { error: errorMessage(e) });
      });
      await extensions.close();
      await updates.close();
      await store.close();
      await privateStore?.close();
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

/** A positive integer number of milliseconds from an option or an environment value, else the default. */
function positiveMs(value: number | string | undefined, fallback: number): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The principal's conversation session without a conversation agent (no model credential):
 * the activity log a remote plan's sentence goes to. The same row `server.ts` uses.
 */
async function ensureConversationSession(
  store: StateStore,
  clock: Clock,
  agentId: string,
): Promise<string> {
  const existing = await store.session.list(
    { agent_id: agentId, trigger: "manual", summary: "conversation" } as never,
    { limit: 1 },
  );
  if (existing[0]) return existing[0].id;
  const row = await store.session.insert({
    agent_id: agentId,
    project_id: null,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1_000_000,
    spent_usd_micro: 0,
    steps: 0,
    started_at: clock.nowIso(),
    status: "planned",
    summary: "conversation",
    handoff: {},
    runner: "pc",
    author_agent: agentId,
  });
  return row.id;
}

/**
 * Real providers price from the billing table in force (built-ins plus the adopted
 * overrides); fake providers count one micro-USD per token.
 */
function pricingForProvider(p: ModelProvider | null, modelId: string, table?: PricingTable) {
  if (p && p.name === "anthropic") return pricingFor(modelId, table);
  return {
    estimate: (i: number, o: number) => i + o,
    cost: (u: { input_tokens: number; output_tokens: number }) => u.input_tokens + u.output_tokens,
  };
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

/** A registry of the injected providers only (tests): a missing side makes voice unavailable. */
function injectedVoiceRegistry(stt?: SttProvider, tts?: TtsProvider): VoiceProviderRegistry {
  const registry = new VoiceProviderRegistry();
  if (stt) registry.registerStt(stt);
  if (tts) registry.registerTts(tts);
  return registry;
}
