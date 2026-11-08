import { randomBytes } from "node:crypto";
import type {
  AgentView,
  BillingOrderKind,
  BillingOrderSourceView,
  BillingOrderView,
  ChangeLogView,
  ChatReplyView,
  CommandResultJson,
  ConsolidationProposalView,
  ConsolidationReportView,
  ConversationTurnView,
  ConversationView,
  DaemonDeviceView,
  DesktopAllowEntryView,
  DesktopControlView,
  DocView,
  EmailCommandRowView,
  EmailSentRowView,
  EmailSettingsPatchBody,
  EmailSettingsView,
  EventView,
  HumanRequestView,
  IntakeStatusView,
  LessonOfferView,
  LessonView,
  MemoryScopeView,
  MemoryView,
  MessageView,
  ModelSettingsView,
  ModelSettingValueView,
  PairingStartView,
  PendingChangeView,
  ProjectCard,
  ProjectPullRequestView,
  ReviewsView,
  ReviewView,
  SessionView,
  SetupStatusView,
  SourceCandidateView,
  SourceView,
  TaskView,
  VoiceInstallEntryView,
  VoiceInstallEvent,
  VoiceInstallView,
  VoiceSessionView,
  VoiceStatusView,
  VoiceTurnView,
} from "@forerunner/runtime/daemon/api-types";
import {
  AnswerRequestBody,
  ChangeMilestoneBody,
  ChatRequestBody,
  CreateProjectBody,
  CreateTaskBody,
  EMAIL_MODES,
  isStorableSecretName,
  KILL_ACTIVE_START_MESSAGE,
  KillBody,
  RenameAgentBody,
  RunnerUnlockWrapBody,
  SetTaskDependenciesBody,
  STORABLE_SECRET_NAMES,
  type StartCheckView,
  StartSessionBody,
  StartSessionView,
  StartVoiceSessionBody,
  storableSecretInfo,
  TaskActionBody,
  type TaskReviewEvidence,
  TransitionTaskBody,
  UpdateTaskBody,
  VoiceAudioBody,
  VoiceHeardBody,
  VoicePressBody,
} from "@forerunner/runtime/daemon/api-types";
import {
  auditExportContentType,
  auditExportFilename,
  csvHeader,
  csvLine,
  jsonlLine,
} from "@forerunner/runtime/daemon/audit-export";
import { cancelWorkLine } from "@forerunner/runtime/daemon/cancel-words";
import { duplicateProjectSentence } from "@forerunner/runtime/daemon/create-project";
import { eventAudience } from "@forerunner/runtime/daemon/event-audience";
import { NO_WEB_LIMITATION } from "@forerunner/runtime/daemon/model-settings-view";
import { planTaskViews } from "@forerunner/runtime/daemon/plan-tasks";
import {
  blockedTaskIds,
  overviewNext,
  progressOf,
  projectStatusLine,
  sinceLines,
} from "@forerunner/runtime/daemon/project-status";
import { requestWords } from "@forerunner/runtime/daemon/request-words";
import {
  quoted,
  TAKE_OUT_NOTICE_PREFIX,
  takeOutConflictSentence,
  takeOutOpenedSentence,
} from "@forerunner/runtime/daemon/take-out-words";
import { ACTION_WORDS } from "@forerunner/runtime/daemon/task-words";
import { ImportResultView } from "@forerunner/runtime/data/types";
import {
  MERGE_MODE_WORDS,
  mergeModeEffect,
  mergesAfterSentence,
} from "@forerunner/runtime/loop/merge-mode";
import { fastModeDescription, fastModeEffect } from "@forerunner/runtime/models/fast-mode";
import {
  SANDBOX_WHY,
  type SandboxPullEntryView,
  type SandboxState,
  type SandboxStatusView,
  sandboxNextStep,
  sandboxWords,
} from "@forerunner/runtime/sandbox/readiness-types";
import { CODE_COMMANDS_SETTING, codeCommandsOf } from "@forerunner/runtime/session/billing";
import {
  abilityTable,
  credentialChoiceFor,
  needsOf,
} from "@forerunner/runtime/session/credential-choice";
import { NO_MODEL_CHAT_REPLY, SETUP_ASSISTANT_PATH } from "@forerunner/runtime/setup/no-model";
import { type ChooserFacts, DEFAULT_CHOOSER_FACTS } from "@forerunner/runtime/wiring/billing-pick";
import {
  acceptsAnswer,
  budgetStopAnswer,
  cannotRunAnswer,
  personQuestionsAnswerFor,
  signoffAnswer,
} from "@forerunner/runtime/wiring/request-answers";
import {
  cleanSiteList,
  legacyBlocks,
  researchReadsLine,
  type WebAccess,
  webAccessNarrows,
  webAccessOf,
  webAccessWords,
} from "@forerunner/runtime/wiring/web-access";
import {
  decodeStoredKey,
  parseUnlockChallenge,
  wrapVaultKey,
} from "@forerunner/vault/runner-unlock";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { HumanView } from "../src/api/client.ts";
import type {
  ChangeCardView,
  DataAssetView,
  ExtensionPermissions,
  ExtensionView,
  MilestoneView,
  ModelWatchReportSummary,
  QueueItemView,
} from "../src/api/contracts.ts";
import { FULL_REVIEW_SPECIALISTS, FULL_REVIEW_TIER } from "../src/lib/task-actions.ts";
import { TASK_TRANSITIONS } from "../src/lib/task-transitions.ts";
import {
  actionSentence,
  actionTarget,
  createTaskMeta,
  type FakeTaskMeta,
  fakeTaskDetail,
  liveWork,
  projectTaskViews,
} from "./fake-tasks.ts";
import {
  AGENTS,
  AUDIT_EXPORT,
  CATALOG,
  CHANGES,
  COMMAND_DEFS,
  CONSOLIDATION,
  COSTS,
  DATA_ASSETS,
  DECISIONS,
  DEVICES,
  DOC_CONTENTS,
  DOCS,
  EMAIL_COMMANDS,
  EMAIL_SENT,
  EMAIL_SETTINGS,
  ESTIMATES,
  EVENTS,
  EXTENSIONS,
  HEALTH,
  LESSONS,
  ME,
  MESSAGES,
  MILESTONES,
  MODEL_SETTINGS,
  MODEL_WATCH_REPORTS,
  money,
  OFFERS,
  PAIRING,
  PEERS,
  PERFORMANCE,
  PROJECT_FILES,
  PROJECT_FOLDERS,
  PROJECT_PULL_REQUESTS,
  PROJECTS,
  PROMOTIONS,
  QUEUE,
  REQUESTS,
  REVIEW_PROJECTS,
  REVIEWS,
  RUNS,
  SESSIONS,
  SETTINGS,
  SOURCE_CANDIDATES,
  SOURCES,
  SUMMARIES,
  TASKS,
  UPDATES_FEED,
  UPDATES_STATUS,
  VOICE_INSTALL,
  VOICE_STATUS,
} from "./fixtures.ts";

/**
 * A fake daemon for UI tests (ADR 0011: "the UI is testable against a fake daemon"). Serves
 * every route in DAEMON_ROUTES from the fixtures, keeps mutable state for the phase-1
 * mutations, streams SSE on /events, /sessions/:id/events and /chat/stream, and records the
 * mutations at GET /__test/calls so a browser test can assert what the UI sent.
 *
 * Used two ways: in-process in the unit tests (`app.fetch`) and as a child process started
 * by playwright.config.ts (`startFakeDaemon`). No network beyond 127.0.0.1.
 */

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeDaemonOptions {
  /** The daemon has no usable voice provider: a speak start answers 503 with the reason. */
  voiceUnavailable?: boolean;
  /** Bearer token the fake expects; random when omitted. */
  token?: string;
  /** Spacing of the scripted events after POST /sessions; 150 ms by default. */
  eventDelayMs?: number;
  /**
   * What `POST /sessions` answers, as the real daemon's scheduler does (U-003): `started` (the
   * default) carries the new session; `queued` and `deferred` carry none.
   */
  startOutcome?: "started" | "queued" | "deferred";
  /**
   * With `startOutcome: "queued"`: the project the agent's other session works on. A start on
   * it with nothing ready waits for that session; on any other project it is refused, as the
   * daemon's `busyHere` decides (later #38). Unset: a project none of the tests start.
   */
  busyProjectId?: string;
  /** Heartbeat cadence on /events; 1 s by default. */
  heartbeatMs?: number;
  /** Delay between streamed chat tokens; 5 ms by default. */
  tokenDelayMs?: number;
  /**
   * The install has no Claude key yet (U-047), as the real daemon answers then: Chat runs the
   * commands that need no model ("add a task: …" adds a ready task) and answers any other line
   * with `NO_MODEL_CHAT_REPLY`, which names the setup assistant; nothing is refused with 503.
   */
  noModel?: boolean;
  /**
   * The install has no web access (ADR 0107: no Claude subscription and the web page reader
   * turned off, `FORERUNNER_WEB_FETCH=off`): `GET /settings/models` names the researcher's and
   * the science-evaluator's limitation, as the daemon's `buildModelSettingsView` does for every
   * entry that works from the web. Default: the install reads the web, no limitation.
   */
  noWebAccess?: boolean;
  /**
   * Only a Claude subscription is saved (no API key). Since 'sites' research reads pages there
   * too (Forerunner's reader through the Agent SDK's tool server), so nothing is limited.
   */
  subscriptionOnly?: boolean;
  /**
   * Cloud runner vault keys the fake's "OS keyring" holds, runner id -> base64 of 32 bytes
   * (spec S.12, ADR 0068). `/runner-unlock/wrap` wraps them as the daemon does.
   */
  runnerKeys?: Record<string, string>;
  /**
   * Paths the fake answers with 404 "no route" (ADR 0032), each matching itself and its
   * children ("/memory" covers "/memory/scopes" but "/updates" leaves "/updates/status"): a
   * daemon without the reviews, memory, command or other routes, so the pages' degraded
   * state is tested.
   */
  missingRoutes?: string[];
  /**
   * Settings -> Devices: false makes the fake answer like a daemon without a state service
   * (`pairingAvailable: false`, `POST /devices/pairing` 503 unavailable). Default true.
   */
  pairingAvailable?: boolean;
  /** FORERUNNER_PLAN_USD_MONTHLY decides the subscription allowance (U-052). Default false. */
  planAllowanceOverridden?: boolean;
  /**
   * Settings -> Claude: which to use first (U-078): the credentials `GET /settings/billing-order`
   * lists (each source's fields over a usable default), and the order chosen at start (none by
   * default). Default: a subscription and an API key, both usable.
   */
  billingOrder?: {
    sources?: Partial<BillingOrderSourceView>[];
    order?: BillingOrderKind[] | null;
  };
  /**
   * The credential chooser (U-078): what this install offers each credential, over the defaults
   * (the page reader on unless `noWebAccess`, no search on the key, no pages on the subscription,
   * no host commands). `GET /settings/models` and `GET /inbox` compute where each task runs with
   * the runtime's own `credentialChoiceFor` over the saved credentials in the person's order.
   */
  chooserFacts?: Partial<ChooserFacts>;
  /** Projects whose folder has dependencies to install (the coder's "its tests will not run"). */
  projectDependencies?: string[];
  /**
   * `GET /settings/billing-order`'s `startedWith`: the model the install was started with
   * outside the saved credentials (the bench's `bench`); null by default (U-078).
   */
  startedWith?: string | null;
  /**
   * The time a pairing's ten-minute expiry counts from (epoch ms); the wall clock by default.
   * The Devices tests share one stepped clock between the fake and the section.
   */
  now?: () => number;
  /** Fields that replace the `PAIRING` fixture's in `POST /devices/pairing` (e.g. a loopback URL). */
  pairing?: Partial<PairingStartView>;
  /**
   * Answer revocations like a daemon whose state service failed: the row is revoked in the
   * shared store (`via: "store"`) and this is the service's failure.
   */
  revokeServiceError?: string;
  /**
   * Exact paths the fake answers with an error body and status, e.g. the release feed being
   * unreachable (`{"/updates": {status: 503, code: "unavailable", message: "feed down"}}`).
   */
  failing?: Record<string, { status: number; code: string; message: string }>;
  /**
   * `POST /updates/check` answers 200 with the local view and this `app.lastError`, like the
   * real daemon when the release feed is unreachable.
   */
  updatesCheckError?: string;
  /**
   * Overrides of the `/me` answer, e.g. `desktopDeviceId: null` (a daemon that registered no
   * desktop row) or another id (a row this fake does not know, so a device confirmation
   * naming it is refused like the real executor refuses an unknown device).
   */
  me?: Partial<HumanView>;
  /**
   * Whether the fake's model provider accepts a temperature (spec D.4): false strips the
   * temperature from every row of `GET /settings/models` and refuses setting one. Default true.
   */
  acceptsTemperature?: boolean;
  /**
   * The voice loop (spec O): available with the fixture's providers (`VOICE_STATUS`) by default;
   * `{ available: false, reason }` makes /voice/status say why and POST /voice/sessions answer 503.
   */
  voice?: { available: boolean; reason?: string };
  /**
   * Settings → Voice (ADR 0090): changes to the fixture's `GET /voice/install` answer, and
   * `voiceInstallGpuFails` makes a switch to gpu end with the CPU standing in (exit code 2).
   */
  voiceInstall?: Partial<VoiceInstallView>;
  voiceInstallGpuFails?: string;
  /**
   * The job's first events stream ends after three events while the job still runs (a proxy
   * or a sleep dropping the connection); the next stream carries the rest and the job ends.
   */
  voiceInstallDropOnce?: boolean;
  /**
   * The job stays running after its first three events (streams end with nothing more) until
   * `POST /voice/install/cancel`, which ends it with the cancelled result.
   */
  voiceInstallHold?: boolean;
  /** The first install events request answers 500 (the card shows it, then re-attaches). */
  voiceInstallStreamFailsOnce?: boolean;
  /**
   * The setup assistant (ADR 0092): changes to `GET /setup`. By default the install is set up
   * (`complete`, nothing to show), so the app opens where each test mounts it.
   */
  setup?: Partial<SetupStatusView>;
  /** The available release's artefact for this platform, e.g. the desktop's MSI (ADR 0092). */
  updateArtifact?: { name: string; url: string };
  /**
   * Settings → Sandbox (Docker) (U-079): the state `GET /sandbox` starts in (default ready).
   * While it is not ready, the start check names the tier 2+ ready tasks as waiting for it.
   */
  sandbox?: { state: SandboxState; platform?: string; pullable?: boolean; waiting?: number };
  /** The state the next `POST /sandbox/check` finds (the person started Docker meanwhile). */
  sandboxAfterCheck?: SandboxState;
}

/** `GET /sandbox` as the daemon words it, from the same words module. */
export function fakeSandboxView(
  state: SandboxState,
  opts: { platform?: string; pullable?: boolean; waiting?: number } = {},
): SandboxStatusView {
  const platform = opts.platform ?? "windows";
  const pullable = opts.pullable ?? true;
  const image = pullable ? "ghcr.io/test-owner/forerunner-runner:1.0.5" : "forerunner-runner:local";
  const downloadBytes = state === "image_missing" || state === "pulling" ? 640_000_000 : null;
  const engine =
    state === "not_installed" || state === "not_running" || state === "windows_containers"
      ? "none"
      : "docker";
  const words = sandboxWords({
    state,
    platform,
    image,
    pullable,
    engine,
    engineVersion: "27.3.1",
    downloadBytes,
  });
  return {
    state,
    ready: state === "ready",
    engine,
    engineVersion: engine === "none" ? null : "27.3.1",
    platform,
    image,
    imageSource: pullable ? "build" : "local",
    pullable,
    downloadBytes,
    reason: engine === "none" ? "docker: fake daemon" : "docker 27.3.1 reachable",
    headline: words.headline,
    steps: words.steps,
    why: SANDBOX_WHY,
    waiting: state === "ready" ? 0 : (opts.waiting ?? 0),
    checkedAt: new Date().toISOString(),
    pull: null,
  };
}

type Listener = (event: string, data: unknown) => void;

export interface FakeDaemonState {
  /** What `POST /secrets/store` kept, by name (U-054); the routes never send a value back. */
  storedSecrets: Map<string, string>;
  /** `/agents`; `POST /agents/:id/rename` renames one of them (U-025). */
  agents: AgentView[];
  projects: ProjectCard[];
  tasks: TaskView[];
  /** Who paused which task, and the order tasks were added (the daemon's row authors and ages). */
  taskMeta: FakeTaskMeta;
  /**
   * The tasks' runs (`/projects/:id/runs`, the drawer's runs); the critic's are its reviews. A
   * test may give a run the files it changed, the web pages it read, and why a review stopped
   * (`GET /tasks/:id` serves them as the daemon reads them from the log and the Run row).
   */
  runs: ((typeof RUNS)[number] & {
    report?: string;
    fullReport?: string;
    files?: string[];
    webSources?: { url: string; title: string | null; refused: string | null }[];
    stoppedBecause?: string;
  })[];
  /**
   * What the critic's last review of a task ran and tried (ADR 0104), by task id; a done task
   * with an accepted review says "Reviewed and tried" when something was tried. A test seeds it.
   * As the daemon (ADR 0110), each try says what kind it was: a page opened, a command run with
   * sample input, or a server started and called (`kind`); a command or a server has no
   * screenshot.
   */
  reviewEvidence: Map<string, TaskReviewEvidence>;
  /** Screenshots `GET /tasks/:id/evidence?file=` serves, by `<task id>/<file>`, base64. */
  evidenceFiles: Map<string, string>;
  sessions: SessionView[];
  events: EventView[];
  requests: HumanRequestView[];
  /**
   * `GET /projects/:id/intake` per project (U-046); a project without an entry has had no
   * intake (`none`). `POST /projects/:id/intake/retry` moves a failed one to `drafting`.
   */
  intake: Record<string, IntakeStatusView>;
  /**
   * Where each project's files are on this computer (design §3.10), as the daemon's card says
   * (`folder`); a project without an entry has none yet. `files` are what `GET
   * /projects/:id/files` lists and reads, by project.
   */
  folders: Record<string, string>;
  files: Record<string, { path: string; content: string | null; updatedAt: string }[]>;
  /**
   * merged-copy (ADR 0113): what `GET /projects/:id/files` says of a repository project's copy
   * (`copy`: when it was last brought to what is merged, its Local only folder and line), by
   * project; a project without an entry answers `copy: null`, as the daemon does before the
   * first refresh of a copy or for a project without a repository.
   */
  copies: Record<
    string,
    { updatedAt: string | null; localOnly: { folder: string | null; line: string } | null }
  >;
  /**
   * `GET /projects/:id/pull-requests` by project (ADR 0106): the PRs that wait for the person,
   * or the host's error in words; a project without an entry has none waiting.
   */
  pullRequests: Record<
    string,
    {
      waiting: ProjectPullRequestView[];
      error: string | null;
      errorKind?: "no_token" | "refused" | "unreachable" | null;
    }
  >;
  /**
   * The person's Merge in the app (merge-in-app): the pull requests a click is merging, by
   * project and number, with how many reads of GET pull-requests still show them merging; the
   * next read after that drops them (merged), or shows `outcome`'s sentence when a test set one
   * (the merge step left it to the person). `after`: the pull requests of the same click it
   * merges after. A `waiting_checks` outcome is the first one's checks still running: it says
   * "#N merges when its checks pass.", and the ones after it wait their turn with a sentence
   * (`mergesAfterSentence`), as the daemon's view says them; neither is merging any more.
   */
  pullRequestMerges: Record<string, { number: number; reads: number; after: number[] }[]>;
  pullRequestMergeOutcome:
    | { state: "left_to_you" | "blocked"; sentence: string }
    | { state: "waiting_checks" }
    | null;
  /** How many times `GET /projects/:id/pull-requests` was read, by project (the Overview's polling). */
  pullRequestReads: Record<string, number>;
  /** merged-actions: set by a test, the next Take this work out conflicts in these files. */
  takeOutConflict: string[] | null;
  /** `GET /projects/:id/docs` by project: Atlas has the fixture set, the others none. */
  docs: Record<string, DocView[]>;
  messages: MessageView[];
  killActive: boolean;
  calls: RecordedCall[];
  pendingConfirmation: { id: string; readback: string } | null;
  /** When set, the next `/chat/stream` reply has this text (tests script the agent). */
  nextChatReply: string | null;
  /**
   * The conversations as the daemon stores them (design §3.9): one per project (the key is
   * the project id; "" for the one outside any project), each turn as
   * `GET /projects/:id/conversation` shows it. `/chat` and `/chat/stream` append to them.
   */
  conversations: Map<string, ConversationTurnView[]>;
  /**
   * The actions of that scripted reply, e.g. a change with its `undoToken` (the change log id),
   * as the daemon answers a chat command that ran (U-074).
   */
  nextChatActions: ChatReplyView["actions"] | null;
  listeners: Set<Listener>;
  timers: Set<ReturnType<typeof setTimeout>>;
  extensions: ExtensionView[];
  /** `GET /voice/status`: which voice providers are in force and what the panel chose. */
  voiceStatus: VoiceStatusView;
  /** The daemon's version as /health reports it; changes after an applied update. */
  version: string;
  modelWatchReports: ModelWatchReportSummary[];
  reviews: ReviewView[];
  lessons: LessonView[];
  changes: ChangeLogView[];
  consolidation: ConsolidationProposalView[];
  offers: LessonOfferView[];
  promotions: LessonView[];
  queue: QueueItemView[];
  milestones: MilestoneView[];
  dataAssets: DataAssetView[];
  /** Source discovery (spec A.4): connected sources and what their scans found. */
  sources: SourceView[];
  sourceCandidates: SourceCandidateView[];
  /** Settings -> Devices (spec R.2): the human's devices and the pairings started. */
  devices: DaemonDeviceView[];
  pairings: number;
  pendingCommands: Map<string, PendingCommand>;
  /** Email settings per agent id (Settings -> Capabilities -> Email), as the daemon stores them. */
  email: Record<string, EmailSettingsView>;
  /** Sent copies and the command audit of every agent, oldest first (answered newest first). */
  emailSent: EmailSentRowView[];
  emailCommands: EmailCommandRowView[];
  missingRoutes: string[];
  failing: Record<string, { status: number; code: string; message: string }>;
  /** The fake keyring's runner vault keys (runner id -> base64). */
  runnerKeys: Record<string, string>;
  /**
   * Opus fast mode per project id (spec D.20). A project listed here gets a
   * `project.fast_mode` row on `/settings`, as the daemon lists one for every project; the
   * default is none, so the fixtures' other settings tests keep their rows. `null` is a project
   * whose flag was never set: the row reads off and the card's old value is "unset", as the
   * daemon's `settings.set` card says.
   */
  fastMode: Record<string, boolean | null>;
  /**
   * Desktop control (spec S.32): what `GET /desktop/status` answers. `setDesktopControl`
   * changes it and emits the `desktop.indicator` frame the real daemon would.
   */
  desktop: { revoked: boolean; revokedReason: string | null; control: DesktopControlView };
  /** Each project's speed-versus-quality slider (spec D.16), as its settings hold it. */
  speedQuality: Record<string, -1 | 0 | 1>;
  /**
   * Values `settings.set` stored for the keys the fake keeps no other state for (U-060):
   * `key` for a global one, `key:projectId` for a project one; `/settings` reads them back.
   */
  settingValues: Record<string, unknown>;
  /** `GET`/`PUT /desktop/allowlist/:humanId` (Settings → Desktop control, U-060). */
  desktopAllowlist: DesktopAllowEntryView[];
  /** `GET /settings/models` with every temperature; `model.settings.set` changes it. */
  modelSettings: ModelSettingsView;
  acceptsTemperature: boolean;
  /** Voice sessions with the audio chunks received for the turn being spoken. */
  voiceSessions: Map<string, { view: VoiceSessionView; pressed: boolean; chunks: number }>;
  /** When set, the next released turn transcribes to this line (tests script the human). */
  nextVoiceLine: string | null;
  /** `GET /voice/install` and the last install job's events (ADR 0090). */
  voiceInstall: VoiceInstallView;
  /** `GET /sandbox` and the last download's events (U-079). */
  sandbox: SandboxStatusView;
  sandboxEntries: SandboxPullEntryView[];
  voiceInstallEntries: VoiceInstallEntryView[];
  /** The `afterSeq` of every install events stream opened (where a stream resumed). */
  voiceInstallStreamsAfter: number[];
  /**
   * When true, a release leaves the turn running (state `thinking`, no `lastTurn`): the reply
   * is still being generated or spoken, and a press is the barge-in. Tests stream its frames.
   */
  voiceHold: boolean;
  /**
   * When true, a press is not taken (the daemon answers the session as it was: the same turn,
   * not listening), the case the panel must roll back from.
   */
  voiceRefusePress: boolean;
}

const DESKTOP_OFF: DesktopControlView = {
  active: false,
  app: null,
  sessionId: null,
  agentId: null,
  since: null,
};

interface PendingCommand {
  card: ChangeCardView;
  decision: "needs_yes" | "needs_device";
  apply: () => CommandResultJson;
  createdAt: string;
  expiresAt: string;
  readback: string;
  wordsUsed: string;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * The repository a project is linked to, as the daemon's `projectRepository` reads `repos[0]`:
 * `owner/name` on GitHub; none for no link or a local folder.
 */
function repositoryOf(
  repos: readonly string[] | undefined,
): { fullName: string; url: string } | null {
  const first = repos?.[0]?.trim() ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(first)) return null;
  return { fullName: first, url: `https://github.com/${first}` };
}

/** The stand-in's scripted session lines that stand for what a person follows (design §3.7). */
const SCRIPTED_PERSON_TYPES = new Set([
  "task.claimed",
  "run.started",
  "run.finished",
  "escalation",
]);

/**
 * Who a line of the stand-in's log is for: the daemon's split (`eventAudience` with the line's
 * payload, so its marks `again`, `handedFrom`, `review`, `couldNot` and a killed run's outcome
 * split it as the daemon's `eventView` does; validation rule 3), and the scripted lines that
 * stand for what a person follows. Before, the payload was not passed, so a marked line was a
 * person line here and a detail on the real daemon.
 */
export function fakeEventAudience(type: string, payload: unknown): EventView["audience"] {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return eventAudience(type, p) === "person" || SCRIPTED_PERSON_TYPES.has(type)
    ? "person"
    : "detail";
}

function errorBody(c: Context, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
  return c.json({ code, message }, status);
}

/**
 * The daemon's dependency check (`TaskRepo.checkDependencies`, U-040) over the fake's tasks:
 * the checked list, or the refusal message the daemon answers 409 with.
 */
function checkFakeDependencies(
  tasks: readonly TaskView[],
  projectId: string,
  taskId: string | null,
  dependsOn: readonly string[],
): { ok: true; ids: string[] } | { ok: false; message: string } {
  const ids = [...new Set(dependsOn.map((d) => d.trim()).filter((d) => d.length > 0))];
  if (taskId !== null && ids.includes(taskId))
    return { ok: false, message: "A task cannot depend on itself." };
  const rows = new Map(
    tasks.filter((t) => t.projectId === projectId && ids.includes(t.id)).map((t) => [t.id, t]),
  );
  const unknown = ids.filter((id) => !rows.has(id));
  if (unknown.length)
    return {
      ok: false,
      message: `Depends on: ${unknown.map((u) => `"${u}"`).join(", ")} ${
        unknown.length === 1 ? "is not a task" : "are not tasks"
      } of this project. Pick the tasks it waits on from the project's list.`,
    };
  const cancelled = ids.filter((id) => rows.get(id)?.status === "cancelled");
  if (cancelled.length)
    return {
      ok: false,
      message: `Depends on: ${cancelled.map((c) => `"${rows.get(c)?.title}"`).join(", ")} ${
        cancelled.length === 1 ? "is" : "are"
      } cancelled and will never be done, so a task waiting on ${
        cancelled.length === 1 ? "it" : "them"
      } would never run.`,
    };
  if (taskId !== null) {
    const depsOf = new Map(tasks.map((t) => [t.id, t.dependsOn]));
    const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
    for (const start of ids) {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const at = stack.pop() as string;
        if (at === taskId)
          return {
            ok: false,
            message: `Depends on: "${titleOf(start)}" already waits on "${titleOf(taskId)}" (directly or through other tasks), so "${titleOf(taskId)}" cannot wait on it: neither would ever run.`,
          };
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(depsOf.get(at) ?? []));
      }
    }
  }
  return { ok: true, ids };
}

/** The daemon's session cap for a start without a budget (compose's default: CHF 5). */
const FAKE_SESSION_CAP_USD_MICRO = 6_250_000;

/**
 * The daemon's start check (U-040) over the fake's tasks: ready tasks by priority, those whose
 * dependencies are all done priced by their estimate (else budget, else the planner's
 * 500 000), cut to the cap less the 20% review reserve by skipping what does not fit.
 */
/** What is left of the fixture human's monthly cap (CHF 120 at the fake's rate of 0.8). */
const FAKE_MONTH_LEFT_USD_MICRO = 150_000_000;

/**
 * A task's price as the daemon's planner gives it: its estimate, else its budget, else the
 * planner's 500 000, never more than what is left of its own budget (`withinTaskBudget`).
 */
function fakePrice(t: TaskView): number {
  const estimate = t.estimate.usdMicro || t.budget.usdMicro || 500_000;
  if (!(t.budget.usdMicro > 0)) return estimate;
  return Math.min(estimate, Math.max(0, t.budget.usdMicro - t.actual.usdMicro));
}

function fakeStartCheck(
  tasks: readonly TaskView[],
  projectId: string,
  budgetUsdMicro: number | null,
  sandbox: SandboxStatusView | null = null,
  opts: {
    killActive?: boolean;
    /** The agent is in another session: a start is queued ("Starts after the current session"). */
    busy?: boolean;
    /**
     * That session works on this project, so its work can make tasks ready here and a start
     * waits for it rather than being refused. As the daemon's `busyHere` (later #38): another
     * project's session makes none of this project's tasks ready.
     */
    busyHere?: boolean;
  } = {},
): StartCheckView {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // High first, as the daemon's stored numbers order them (U-041).
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const ready = tasks
    .filter((t) => t.projectId === projectId && t.status === "ready")
    .sort((a, b) => rank[b.priority] - rank[a.priority]);
  const cap = budgetUsdMicro ?? FAKE_SESSION_CAP_USD_MICRO;
  const work = Math.floor(cap * 0.8);
  const runnable: StartCheckView["runnable"] = [];
  const overBudget: StartCheckView["overBudget"] = [];
  const waiting: StartCheckView["waiting"] = [];
  const sandboxTasks: StartCheckView["runnable"] = [];
  let total = 0;
  for (const t of ready) {
    const waitsOn = t.dependsOn
      .filter((d) => byId.get(d)?.status !== "done")
      .map((d) => ({
        taskId: d,
        title: byId.get(d)?.title ?? null,
        status: byId.get(d)?.status ?? null,
      }));
    if (waitsOn.length) {
      waiting.push({ taskId: t.id, title: t.title, waitsOn });
      continue;
    }
    const estimate = fakePrice(t);
    const named = { taskId: t.id, title: t.title, estimate: money(estimate) };
    // U-079: a full-review task waits while the Docker sandbox is not ready.
    if (sandbox && !sandbox.ready && t.riskTier >= 2) sandboxTasks.push(named);
    else if (total + estimate > work) overBudget.push(named);
    else {
      runnable.push(named);
      total += estimate;
    }
  }
  // As the daemon (design §3.6): what follows as it becomes ready, and why nothing would run.
  const comes = new Set(runnable.map((r) => r.taskId));
  const later: StartCheckView["later"] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of waiting) {
      if (comes.has(w.taskId) || !w.waitsOn.every((d) => comes.has(d.taskId))) continue;
      comes.add(w.taskId);
      const t = byId.get(w.taskId);
      later.push({
        taskId: w.taskId,
        title: w.title,
        estimate: money(t ? fakePrice(t) : 500_000),
      });
      changed = true;
    }
  }
  const stuckOn = waiting
    .flatMap((w) => w.waitsOn.map((d) => ({ w, d })))
    .find(({ d }) => ["failed", "cancelled", "needs_human", null].includes(d.status));
  const blocked: StartCheckView["blocked"] = opts.killActive
    ? {
        kind: "stopped",
        sentence: "Sessions are stopped (Stop all), so nothing can start.",
        action: { kind: "resume", label: "Allow sessions again", to: null },
      }
    : runnable.length > 0 || (opts.busy && opts.busyHere)
      ? null
      : stuckOn
        ? stuckOn.d.status === "needs_human"
          ? {
              kind: "nothing_runnable",
              sentence: `Nothing can run: "${stuckOn.d.title}" needs your answer.`,
              action: { kind: "link", label: "Open it", to: "/inbox" },
            }
          : {
              kind: "nothing_runnable",
              sentence: `Nothing can run: "${stuckOn.w.title}" waits on ${stuckOn.d.title ? `"${stuckOn.d.title}"` : "a task that does not exist"}, which ${stuckOn.d.status === "cancelled" ? "was cancelled" : stuckOn.d.status === "failed" ? "failed" : "does not exist"}.`,
              action: { kind: "link", label: "Open Tasks", to: `/projects/${projectId}/tasks` },
            }
        : sandboxTasks[0]
          ? {
              kind: "nothing_runnable",
              sentence: `Nothing can run: "${sandboxTasks[0].title}" is waiting for Docker.`,
              action: { kind: "link", label: "Set up Docker", to: "/settings#sandbox" },
            }
          : overBudget[0]
            ? {
                kind: "nothing_runnable",
                sentence: `Nothing can run within this budget: "${overBudget[0].title}" needs about CHF ${(overBudget[0].estimate.chfMicro / 1e6).toFixed(2)}.`,
                action: null,
              }
            : {
                kind: "nothing_runnable",
                sentence:
                  ready.length === 0
                    ? "Nothing can run: no task is ready."
                    : "Nothing can run: every ready task waits on another one.",
                action: { kind: "link", label: "Open Tasks", to: `/projects/${projectId}/tasks` },
              };
  return {
    projectId,
    sessionBudget: money(cap),
    workBudget: money(work),
    ready: ready.length,
    runnable,
    overBudget,
    waiting,
    later,
    blocked,
    monthLeft: money(FAKE_MONTH_LEFT_USD_MICRO),
    busy: opts.busy ?? false,
    waitingForSandbox:
      sandbox && !sandbox.ready && sandboxTasks.length > 0
        ? {
            state: sandbox.state,
            headline: sandbox.headline,
            step: sandboxNextStep({
              state: sandbox.state,
              platform: sandbox.platform,
              image: sandbox.image,
              pullable: sandbox.pullable,
            }),
            tasks: sandboxTasks,
          }
        : null,
  };
}

/**
 * The fixture's `/voice/status` answer, or an unavailable one with the reason when the test
 * passes `voice: { available: false, reason }` (the panel then says why and starts no turn).
 */
function initialVoiceStatus(options: FakeDaemonOptions): VoiceStatusView {
  const status = clone(VOICE_STATUS);
  if (!options.voice || options.voice.available) return status;
  return {
    ...status,
    available: false,
    reason: options.voice.reason ?? "voice is unavailable (test)",
    stt: null,
    tts: null,
  };
}

/** The specialists of the fixture that work from the web (the registry's researcher and science-evaluator). */
const WEB_SPECIALISTS = new Set(["researcher", "science-evaluator"]);

/**
 * `GET /settings/models` as the daemon answers it with or without web access (ADR 0107; since
 * 'sites' the page reader runs on both credentials, so only an install without it is limited).
 */
function withWebAccess(view: ModelSettingsView, web: boolean): ModelSettingsView {
  for (const s of view.specialists)
    s.limitation = WEB_SPECIALISTS.has(s.name) && !web ? NO_WEB_LIMITATION : null;
  return view;
}

/**
 * The registry entries' tools the credential chooser reads (U-078), as `evals/registry` writes
 * them for the specialists the fixtures name: research reads pages and searches, the
 * science-evaluator reads pages and runs commands, code work runs commands.
 */
const FAKE_REGISTRY_TOOLS: Record<string, string[]> = {
  coder: ["cc:Read", "cc:Edit", "cc:Write", "cc:Bash"],
  tester: ["cc:Read", "cc:Write", "cc:Bash"],
  "migration-specialist": ["cc:Read", "cc:Edit", "cc:Write", "cc:Bash"],
  "ops-deploy": ["cc:Read", "cc:Write", "cc:Bash"],
  "data-analyst": ["cc:Read", "cc:Write", "cc:Bash"],
  researcher: ["cc:Read", "cc:Write", "cc:WebFetch", "cc:WebSearch"],
  "science-evaluator": ["cc:Read", "cc:Write", "cc:Bash", "cc:WebFetch"],
  designer: ["cc:Read", "cc:Write", "cc:Edit"],
  "writer-marketing": ["cc:Read", "cc:Write", "cc:Edit"],
  reviewer: ["cc:Read", "cc:Bash"],
};

export function createFakeDaemon(options: FakeDaemonOptions = {}) {
  const token = options.token ?? randomBytes(16).toString("hex");
  const eventDelayMs = options.eventDelayMs ?? 150;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const tokenDelayMs = options.tokenDelayMs ?? 5;
  // The human as `/me` answers (`options.me` shapes the answer only); the one device row this
  // fake has is the fixture's own desktop (`ME.desktopDeviceId`, ADR 0030), the only id a
  // device confirmation may name, whatever `/me` said.
  const me: HumanView = { ...ME, ...options.me };
  let counter = 100;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  const state: FakeDaemonState = {
    storedSecrets: new Map(),
    agents: clone(AGENTS),
    projects: clone(PROJECTS),
    tasks: clone(TASKS),
    taskMeta: createTaskMeta(TASKS),
    reviewEvidence: new Map(),
    evidenceFiles: new Map(),
    runs: clone(RUNS),
    sessions: clone(SESSIONS),
    events: clone(EVENTS),
    requests: clone(REQUESTS),
    intake: {},
    folders: clone(PROJECT_FOLDERS),
    files: clone(PROJECT_FILES),
    copies: {},
    pullRequests: clone(PROJECT_PULL_REQUESTS),
    pullRequestMerges: {},
    pullRequestMergeOutcome: null,
    pullRequestReads: {},
    takeOutConflict: null,
    docs: { proj_atlas: clone(DOCS) },
    messages: clone(MESSAGES),
    killActive: false,
    calls: [],
    pendingConfirmation: null,
    nextChatReply: null,
    conversations: new Map(),
    nextChatActions: null,
    listeners: new Set(),
    timers: new Set(),
    extensions: clone(EXTENSIONS),
    voiceStatus: initialVoiceStatus(options),
    version: HEALTH.version,
    modelWatchReports: clone(MODEL_WATCH_REPORTS),
    reviews: clone(REVIEWS),
    lessons: clone(LESSONS),
    changes: clone(CHANGES),
    consolidation: clone(CONSOLIDATION),
    offers: clone(OFFERS),
    promotions: clone(PROMOTIONS),
    queue: clone(QUEUE),
    milestones: clone(MILESTONES),
    dataAssets: clone(DATA_ASSETS),
    sources: clone(SOURCES),
    sourceCandidates: clone(SOURCE_CANDIDATES),
    devices: clone(DEVICES),
    pairings: 0,
    pendingCommands: new Map(),
    email: clone(EMAIL_SETTINGS),
    emailSent: clone(EMAIL_SENT),
    emailCommands: clone(EMAIL_COMMANDS),
    missingRoutes: [...(options.missingRoutes ?? [])],
    failing: { ...(options.failing ?? {}) },
    runnerKeys: { ...(options.runnerKeys ?? {}) },
    fastMode: {},
    desktop: { revoked: false, revokedReason: null, control: { ...DESKTOP_OFF } },
    speedQuality: {},
    settingValues: {},
    desktopAllowlist: [{ app: "code" }],
    modelSettings: withWebAccess(clone(MODEL_SETTINGS), !options.noWebAccess),
    acceptsTemperature: options.acceptsTemperature ?? true,
    voiceSessions: new Map(),
    nextVoiceLine: null,
    voiceInstall: { ...clone(VOICE_INSTALL), ...(options.voiceInstall ?? {}) },
    voiceInstallEntries: [],
    voiceInstallStreamsAfter: [],
    sandbox: fakeSandboxView(options.sandbox?.state ?? "ready", options.sandbox ?? {}),
    sandboxEntries: [],
    voiceHold: false,
    voiceRefusePress: false,
  };

  const emit = (event: string, data: unknown) => {
    // As the daemon: `inbox.changed` also carries every open card (design §3.8).
    const sent =
      event === "inbox.changed" && data && typeof data === "object"
        ? { ...(data as object), needsYouCount: needsYouCount() }
        : data;
    for (const l of state.listeners) l(event, sent);
  };
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      state.timers.delete(t);
      fn();
    }, ms);
    state.timers.add(t);
    return t;
  };
  const blockingCount = () =>
    state.requests.filter((r) => r.status === "open" && r.blocking).length;
  /** Every open card waits on the person (design §3.8): the Inbox's and the header's count. */
  const needsYouCount = () => state.requests.filter((r) => r.status === "open").length;
  /**
   * A request as the daemon's `requestView` words it (design §3.8, `daemon/request-words.ts`):
   * the card's title, body, choices with their consequence lines, the reply it takes, and once
   * answered what came of it. What waits on its task is read from the tasks now.
   */
  const worded = (r: HumanRequestView): HumanRequestView => {
    const task = r.taskId ? state.tasks.find((t) => t.id === r.taskId) : undefined;
    const waiting = task
      ? state.tasks
          .filter(
            (t) => t.dependsOn.includes(task.id) && t.status !== "done" && t.status !== "cancelled",
          )
          .map((t) => t.title)
      : [];
    const words = requestWords(
      {
        kind: r.kind as never,
        why: r.why,
        steps: r.steps,
        options: r.options,
        change_card: (r.changeCard ?? null) as never,
        status: r.status as never,
        answer: (r.answer ?? null) as never,
      },
      {
        projectName: r.projectName,
        taskTitle: task?.title ?? r.taskTitle ?? null,
        taskStatus: task?.status ?? null,
        // The fake withdraws a card only on a person's task move.
        movedByYou: r.status === "withdrawn" && !!task,
        waiting,
      },
    );
    return { ...r, ...words };
  };

  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => origin,
      allowHeaders: ["Authorization", "Content-Type", "Accept"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  // Bearer token on every route; the two EventSource routes also accept ?token= (ADR 0025).
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization") ?? "";
    const query = c.req.query("token") ?? "";
    const sseRoute = c.req.path === "/events" || /^\/sessions\/[^/]+\/events$/.test(c.req.path);
    const ok = header === `Bearer ${token}` || (sseRoute && query === token);
    if (!ok) return errorBody(c, 401, "auth.unauthorized", "missing or wrong bearer token");
    return next();
  });
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE") {
      let body: unknown = null;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = null;
      }
      state.calls.push({ method: c.req.method, path: c.req.path, body });
    }
    return next();
  });
  // A hidden route answers a typed 404 "no route ..." body. The real daemon registers no
  // notFound handler (packages/runtime/src/daemon/server.ts), so a route it lacks answers
  // Hono's plain-text 404 instead; `isRouteMissing` reads both as a missing route
  // (`client.test.ts` covers the plain-text shape) and the pages degrade the same way.
  app.use("*", async (c, next) => {
    if (
      c.req.method !== "OPTIONS" &&
      state.missingRoutes.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))
    ) {
      return errorBody(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`);
    }
    const failure = state.failing[c.req.path];
    if (failure && c.req.method !== "OPTIONS") {
      return c.json({ code: failure.code, message: failure.message }, failure.status as 503);
    }
    return next();
  });

  const updatesChecked = { value: false };
  /** Starts answered queued or deferred so far: none of them ever begins in the fake. */
  const waitingStarts = { count: 0 };
  /** The projects whose sessions the last Stop all ended (POST /kill/resume names them). */
  const stoppedByKill: string[] = [];
  app.get("/__test/calls", (c) => c.json(state.calls));
  app.post("/__test/reset", (c) => {
    updatesChecked.value = false;
    waitingStarts.count = 0;
    state.agents = clone(AGENTS);
    state.projects = clone(PROJECTS);
    state.tasks = clone(TASKS);
    state.taskMeta = createTaskMeta(TASKS);
    state.reviewEvidence = new Map();
    state.evidenceFiles = new Map();
    state.sessions = clone(SESSIONS);
    state.events = clone(EVENTS);
    state.requests = clone(REQUESTS);
    state.intake = {};
    state.messages = clone(MESSAGES);
    state.killActive = false;
    state.calls = [];
    state.pendingConfirmation = null;
    state.nextChatReply = null;
    state.nextChatActions = null;
    state.extensions = clone(EXTENSIONS);
    state.voiceStatus = initialVoiceStatus(options);
    state.version = HEALTH.version;
    state.modelWatchReports = clone(MODEL_WATCH_REPORTS);
    state.reviews = clone(REVIEWS);
    state.lessons = clone(LESSONS);
    state.changes = clone(CHANGES);
    state.consolidation = clone(CONSOLIDATION);
    state.offers = clone(OFFERS);
    state.promotions = clone(PROMOTIONS);
    state.queue = clone(QUEUE);
    state.milestones = clone(MILESTONES);
    state.dataAssets = clone(DATA_ASSETS);
    state.sources = clone(SOURCES);
    state.sourceCandidates = clone(SOURCE_CANDIDATES);
    state.devices = clone(DEVICES);
    state.pairings = 0;
    state.pendingCommands.clear();
    state.email = clone(EMAIL_SETTINGS);
    state.emailSent = clone(EMAIL_SENT);
    state.emailCommands = clone(EMAIL_COMMANDS);
    state.missingRoutes = [...(options.missingRoutes ?? [])];
    state.failing = { ...(options.failing ?? {}) };
    state.runnerKeys = { ...(options.runnerKeys ?? {}) };
    state.desktop = { revoked: false, revokedReason: null, control: { ...DESKTOP_OFF } };
    state.speedQuality = {};
    return c.json({ ok: true });
  });
  app.post("/__test/fail", async (c) => {
    const body = (await c.req.json()) as {
      routes: Record<string, { status: number; code: string; message: string }>;
    };
    state.failing = { ...body.routes };
    return c.json({ ok: true });
  });
  app.post("/__test/missing", async (c) => {
    const body = (await c.req.json()) as { routes: string[] };
    state.missingRoutes = [...body.routes];
    return c.json({ ok: true });
  });
  app.post("/__test/emit", async (c) => {
    const body = (await c.req.json()) as { event: string; data: unknown };
    emit(body.event, body.data);
    return c.json({ ok: true });
  });

  app.get("/health", (c) =>
    c.json({
      ...HEALTH,
      version: state.version,
      activeSessions: state.sessions.filter((s) => s.status === "running").length,
      killActive: state.killActive,
      extensions: {
        enabled: state.extensions.filter((e) => e.status === "enabled").length,
        pending: state.extensions.filter((e) => e.status === "pending_approval").length,
      },
    }),
  );
  // The active project every channel uses (U-056): the one `project.switch` recorded.
  app.get("/me", (c) =>
    c.json({ ...me, activeProjectId: state.projects.find((p) => p.active)?.id ?? null }),
  );
  app.get("/agents", (c) => c.json(state.agents));
  // Settings -> Your agent (U-025), as the daemon answers it: 404 unknown, 403 `forbidden` for
  // another human's agent before the body is read, 409 `conflict` (cause validation) for a
  // non-principal, a bad name (`RenameAgentBody`) or one of the human's other agents' names
  // in any case; the same name changes nothing; a rename emits `agent.changed`.
  app.post("/agents/:id/rename", async (c) => {
    const agent = state.agents.find((a) => a.id === c.req.param("id"));
    if (!agent) return errorBody(c, 404, "not_found", `agent ${c.req.param("id")} not found`);
    if (agent.ownerHumanId !== me.id)
      return c.json({ code: "forbidden", message: "not your agent" }, 403);
    const refuse = (message: string) =>
      c.json({ code: "conflict", message, details: { cause: "validation" } }, 409);
    if (agent.kind !== "principal")
      return refuse(
        `${agent.name} is your ${agent.kind} agent; only your principal agent is renamed here`,
      );
    const parsed = RenameAgentBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return refuse(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { name } = parsed.data;
    if (name === agent.name) return c.json(agent);
    const taken = state.agents.find(
      (a) =>
        a.id !== agent.id &&
        a.ownerHumanId === me.id &&
        a.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) return refuse(`you already have an agent named ${taken.name}; choose another name`);
    agent.name = name;
    emit("agent.changed", { id: agent.id, name });
    return c.json(agent);
  });

  // ---------------------------------------------------------------------------------------
  // Agent email (spec S.15, S.28, S.29, T.14; ADR 0066): the capability's seven routes as
  // `emailRouteTable` serves them on the daemon. Errors come wrapped under `error`, the
  // capability routes' shape (`{ error: { code, message, details } }`), not the daemon's flat
  // body. The signed-in human (ME) must own the agent; another human's agent or an unknown
  // one is 403 `tool_not_allowed` before any read or write. PUT merges a partial patch the
  // way `mergeEmailConfig` does (allowlist and signature merged one level deep) and refuses
  // an unknown mode or a mailbox credential that is not a secret reference with 400.
  // ---------------------------------------------------------------------------------------

  /** `COMMANDS_NEED_SENDING_MODE` of the capabilities package, word for word. */
  const EMAIL_COMMANDS_NEED_SENDING_MODE =
    "Email commands need a sending mode other than off: at off the agent sends nothing, so it could not answer your commands. Choose a sending mode first (read only is enough to reply to you), then turn commands on.";
  const emailError = (c: Context, status: 400 | 403, code: string, message: string) =>
    c.json({ error: { code, message, details: {}, retryable: false } }, status);
  const emailAgentOf = (c: Context): string | Response => {
    const agentId = c.req.param("agentId") ?? "";
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent || agent.ownerHumanId !== ME.id) {
      return emailError(
        c,
        403,
        "tool_not_allowed",
        "the signed-in human does not own this agent; its email settings are not theirs to read or change",
      );
    }
    return agentId;
  };
  const defaultEmail = (agentId: string): EmailSettingsView => ({
    ...clone(EMAIL_SETTINGS.agent_critic as EmailSettingsView),
    commands: {
      ...clone((EMAIL_SETTINGS.agent_critic as EmailSettingsView).commands),
      marker: `[FR-${agentId.slice(-4)}]`,
    },
  });
  const emailOf = (agentId: string): EmailSettingsView => {
    state.email[agentId] ??= defaultEmail(agentId);
    return state.email[agentId] as EmailSettingsView;
  };
  const SECRET_REF = /^secret:[a-z][a-z0-9_.:-]{0,127}$/;
  app.get("/agents/:agentId/email/settings", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    return c.json(emailOf(agentId));
  });
  app.put("/agents/:agentId/email/settings", async (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const body = (await c.req.json().catch(() => null)) as EmailSettingsPatchBody | null;
    if (!body || typeof body !== "object") {
      return emailError(c, 400, "validation", "body must be an object");
    }
    const current = emailOf(agentId);
    const patch = body.settings ?? {};
    if (patch.mode !== undefined && !(EMAIL_MODES as readonly string[]).includes(patch.mode)) {
      return emailError(
        c,
        400,
        "validation",
        `invalid email settings: settings.mode: ${patch.mode}`,
      );
    }
    // As the daemon (ADR 0066 amended): the mode is the registry's `email.mode.set`; a PUT
    // that would change it is refused with nothing written, so a page that regressed to the
    // raw route fails here.
    if (patch.mode !== undefined && patch.mode !== current.settings.mode) {
      return emailError(
        c,
        403,
        "tool_not_allowed",
        "the email mode is a high-risk change: it is set with the email.mode.set command (a change card, then a confirmation on a paired device), not through this route; nothing was changed",
      );
    }
    for (const ref of [patch.mailbox?.imap?.passwordRef, patch.mailbox?.smtp?.passwordRef]) {
      if (ref !== undefined && !SECRET_REF.test(ref)) {
        return emailError(
          c,
          400,
          "validation",
          "invalid email settings: passwordRef: must be a secret reference (secret:<name>), never a value",
        );
      }
    }
    const mailbox =
      patch.mailbox === undefined
        ? current.settings.mailbox
        : patch.mailbox === null
          ? null
          : {
              address: patch.mailbox.address,
              imap: patch.mailbox.imap
                ? {
                    host: "",
                    port: 993,
                    secure: true,
                    user: "",
                    passwordRef: "",
                    folder: "INBOX",
                    draftsFolder: "Drafts",
                    ...patch.mailbox.imap,
                  }
                : null,
              smtp: patch.mailbox.smtp
                ? {
                    host: "",
                    port: 587,
                    secure: false,
                    user: "",
                    passwordRef: "",
                    ...patch.mailbox.smtp,
                  }
                : null,
            };
    const next: EmailSettingsView = {
      settings: {
        ...current.settings,
        ...patch,
        allowlist: { ...current.settings.allowlist, ...(patch.allowlist ?? {}) },
        signature: { ...current.settings.signature, ...(patch.signature ?? {}) },
        mailbox,
      },
      commands: { ...current.commands, ...(body.commands ?? {}) },
    };
    // ADR 0081, as the daemon's settings store: commands need a sending mode other than off.
    // Turning them on at off is a 400 with the plain message; a change to off turns them off.
    if (next.settings.mode === "off" && next.commands.enabled) {
      const inForce = current.commands.enabled && current.settings.mode !== "off";
      if (body.commands?.enabled === true && !inForce) {
        return emailError(c, 400, "validation", EMAIL_COMMANDS_NEED_SENDING_MODE);
      }
      next.commands = { ...next.commands, enabled: false };
    }
    state.email[agentId] = next;
    return c.json(next);
  });
  app.get("/agents/:agentId/email/sent", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const limit = Number(c.req.query("limit") ?? 50);
    const rows = state.emailSent.filter((r) => r.agentId === agentId).reverse();
    return c.json({ rows: rows.slice(0, limit), since: "2026-10-13T08:00:00.000Z" });
  });
  app.post("/agents/:agentId/email/pause", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const cfg = emailOf(agentId);
    cfg.settings.paused = true;
    return c.json({ paused: true });
  });
  app.post("/agents/:agentId/email/resume", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const cfg = emailOf(agentId);
    cfg.settings.paused = false;
    return c.json({ paused: false });
  });
  app.post("/agents/:agentId/email/rotate-marker", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const cfg = emailOf(agentId);
    cfg.commands.marker = `[FR-${nextId("m").slice(-4)}]`;
    return c.json({ marker: cfg.commands.marker });
  });
  app.get("/agents/:agentId/email/commands", (c) => {
    const agentId = emailAgentOf(c);
    if (typeof agentId !== "string") return agentId;
    const limit = Number(c.req.query("limit") ?? 50);
    // The fixtures belong to Alice's agent; another agent of hers has none yet.
    const rows = agentId === "agent_alice" ? [...state.emailCommands].reverse() : [];
    return c.json({ rows: rows.slice(0, limit) });
  });

  // As the daemon's card (design §2): the status sentence, "n of m done", the session working
  // on it and its folder, computed when read from the fake's tasks, cards, plan and sessions
  // with the daemon's own `projectStatusLine`.
  /**
   * 'sites': a project's "Web pages research may read" as the daemon reads it (`webAccessOf`):
   * `settings.set web_access`'s value, with the blocks a `PUT /projects/:id/settings` wrote as
   * `browser.blockedDomains` already taken into its never list.
   */
  const webAccessFake = (projectId: string): WebAccess =>
    webAccessOf({ web_access: state.settingValues[`web_access:${projectId}`] as never });
  const projectCardOf = (p: ProjectCard): ProjectCard => {
    const tasks = projectTaskViews(
      state.tasks,
      p.id,
      state.requests,
      state.sandbox.ready,
      state.taskMeta,
    );
    const session = state.sessions.find(
      (s) => s.projectId === p.id && ["planned", "running", "paused"].includes(s.status),
    );
    const working = session
      ? {
          sessionId: session.id,
          agentName: session.agentName,
          taskId: session.currentTask?.id ?? null,
          taskTitle: session.currentTask?.title ?? null,
          since: session.startedAt,
        }
      : null;
    // As the daemon's `projectCard`: a repository project's work is on the repository and in its
    // pull requests (ADR 0106), so its card names the repository and no folder.
    const repository = repositoryOf(p.repos);
    const folder = repository ? null : (state.folders[p.id] ?? null);
    const statusLine = projectStatusLine({
      projectId: p.id,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status as never,
        depends_on: t.dependsOn,
      })),
      displays: new Map(tasks.flatMap((t) => (t.display ? [[t.id, t.display] as const] : []))),
      cards: state.requests
        .filter((r) => r.status === "open" && r.projectId === p.id)
        .map((r) => ({
          id: r.id,
          task_id: r.taskId,
          change_card: (r.changeCard ?? null) as never,
        })),
      plan: state.intake[p.id]?.state ?? null,
      planError: state.intake[p.id]?.error ?? null,
      // U-078, as the daemon: a plan that waits for a credential, and tasks that wait for one.
      planWait: state.intake[p.id]?.wait
        ? {
            short: state.intake[p.id]?.wait?.short ?? "",
            save: state.intake[p.id]?.wait?.save ?? null,
          }
        : null,
      credentialWait: state.taskMeta.credentialWaits.get(p.id) ?? null,
      // As the daemon (`!!rt.provider`): `/me`'s provider, unknown when the fixture names none.
      hasModel: me.provider === undefined ? null : me.provider !== null,
      stopped: state.killActive,
      working,
      folder,
    });
    return {
      ...p,
      statusLine,
      progress: progressOf(tasks.map((t) => ({ status: t.status as never }))),
      working,
      folder,
      repository,
      // 'sites': as the daemon's card, from "Web pages research may read".
      researchReads: researchReadsLine(webAccessFake(p.id)),
    };
  };
  app.get("/projects", (c) => c.json(state.projects.map(projectCardOf)));
  app.post("/projects", async (c) => {
    const parsed = CreateProjectBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    // As the daemon: a name another project has is refused in a sentence, nothing written.
    const clash = state.projects.find((p) => p.name === parsed.data.name);
    if (clash) return errorBody(c, 409, "validation", duplicateProjectSentence(clash.name));
    const project: ProjectCard = {
      id: nextId("proj"),
      name: parsed.data.name,
      goal: parsed.data.goal,
      stage: "idea",
      status: "active",
      // U-058: the person's default autonomy, as the daemon's create path reads it.
      autonomyLevel: parsed.data.autonomyLevel ?? me.defaultAutonomy,
      nextMilestone: null,
      health: "idle",
      spend: money(0),
      budget: money(parsed.data.budgetUsdMicro ?? 62_500_000),
      waitingOnYou: 0,
      latestCriticGrade: null,
      lastSessionAt: null,
      active: false,
      // As the daemon (ADR 0103): a new project starts outside small-project mode whatever its
      // brief, so a task that names no tier gets light review (the critic reviews code tasks);
      // a short brief asks the planner for a small plan instead.
      smallProjectMode: false,
      defaultRiskTier: 1,
      repos: parsed.data.repos ?? [],
    };
    state.projects.push(project);
    // As the daemon: a brief with `intake: true` is drafted in the background (U-046).
    if (parsed.data.intake === true)
      state.intake[project.id] = {
        projectId: project.id,
        state: "drafting",
        requestId: null,
        outcome: null,
        appliedAt: null,
        docs: null,
        error: null,
      };
    emit("project.changed", { id: project.id });
    return c.json(projectCardOf(project), 201);
  });
  app.get("/projects/:id", (c) => {
    const p = state.projects.find((x) => x.id === c.req.param("id"));
    return p ? c.json(projectCardOf(p)) : errorBody(c, 404, "not_found", "no such project");
  });
  // The plan from the brief (U-046), as the daemon's intake status and Retry answer it.
  const intakeOf = (projectId: string): IntakeStatusView =>
    state.intake[projectId] ?? {
      projectId,
      state: "none",
      requestId: null,
      outcome: null,
      appliedAt: null,
      docs: null,
      error: null,
    };
  app.get("/projects/:id/intake", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id))
      return errorBody(c, 404, "not_found", "no such project");
    return c.json(intakeOf(id));
  });
  app.post("/projects/:id/intake/retry", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id))
      return errorBody(c, 404, "not_found", "no such project");
    const current = intakeOf(id);
    // As the daemon: a failed, rejected (Draft a new plan), waiting (U-078) or never run intake
    // is drafted again.
    if (
      current.state !== "failed" &&
      current.state !== "none" &&
      current.state !== "rejected" &&
      current.state !== "waiting"
    )
      return c.json(current, 202);
    // As the daemon: without a model the retry is refused before anything starts.
    if (me.provider === null)
      return c.json(
        {
          code: "unavailable",
          message: `Planning from the brief needs a Claude key or subscription. Add one in the app: ${SETUP_ASSISTANT_PATH}, then retry.`,
        },
        503,
      );
    state.intake[id] = {
      ...current,
      state: "drafting",
      requestId: null,
      error: null,
      wait: null,
    };
    // As the daemon: the screens hear the project changed ("Drafting the plan…").
    emit("project.changed", { id });
    return c.json(state.intake[id], 202);
  });
  app.get("/projects/:id/summary", (c) => {
    const id = c.req.param("id");
    const p = state.projects.find((x) => x.id === id);
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    // As the daemon: "Next" is computed when read from the tasks as they are now.
    const next = overviewNext(
      projectTaskViews(state.tasks, id, state.requests, state.sandbox.ready, state.taskMeta).map(
        (t) => ({
          task: { title: t.title, status: t.status as never },
          display: t.display as NonNullable<TaskView["display"]>,
        }),
      ),
    );
    const base = SUMMARIES[id] ?? {
      goal: p.goal,
      stage: p.stage,
      lastSession: null,
      nextSteps: [],
      openQuestions: 0,
      spend: p.spend,
      spoken: `${p.name} has not run yet.`,
    };
    // As the daemon (C-54): what became of the tasks the last session left for the person.
    const last = base.lastSession;
    const views = projectTaskViews(
      state.tasks,
      id,
      state.requests,
      state.sandbox.ready,
      state.taskMeta,
    );
    const since = last
      ? sinceLines(
          blockedTaskIds(state.sessions.find((s) => s.id === last.id)?.handoff),
          new Map(views.map((t) => [t.id, t])),
          (t) => t.display as NonNullable<TaskView["display"]>,
        )
      : [];
    return c.json({
      ...base,
      ...(last ? { lastSession: { ...last, ...(since.length ? { since } : {}) } } : {}),
      next,
    });
  });
  // Read aloud (spec A.6, L.6): the daemon reads a summary through its voice provider. The
  // fake answers `speaking` on the start and `done` on the next read, keeps the sentences
  // (the UI shows them) and records the cancel.
  const utterances = new Map<string, Record<string, unknown>>();
  const startSpeak = (c: Context, subject: Record<string, unknown>, text: string): Response => {
    const id = `speak_${utterances.size + 1}`;
    const view = {
      id,
      subject,
      source: "ui",
      state: "speaking",
      text,
      sentences: text.split(/(?<=[.!?])\s+/).filter(Boolean),
      heard: "",
      unspokenText: null,
      audioChunks: 0,
      audioStored: false,
      firstAudioMs: null,
      provider: { name: "fake-tts", kind: "fake", policy: "fake", reason: "fake" },
      conversationSessionId: "sess_conv",
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      lastSeq: 0,
    };
    utterances.set(id, view);
    return c.json(view, 201);
  };
  app.post("/projects/:id/speak", (c) => {
    const id = c.req.param("id");
    const p = state.projects.find((x) => x.id === id);
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    if (options.voiceUnavailable)
      return c.json({ code: "unavailable", message: "no TTS provider available" }, 503);
    const text = SUMMARIES[id]?.spoken ?? `${p.name} has not run yet.`;
    return startSpeak(c, { kind: "project", id, name: p.name }, text);
  });
  app.post("/sessions/:id/speak", (c) => {
    const id = c.req.param("id");
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return errorBody(c, 404, "not_found", "no such session");
    if (!s.summary) return errorBody(c, 409, "conflict", "the session has no summary yet");
    return startSpeak(c, { kind: "session", id, projectId: s.projectId }, s.summary);
  });
  // Still speaking for the first two reads (the UI polls once a second where it has no
  // EventSource), then done with everything heard.
  const reads = new Map<string, number>();
  app.get("/speak/:id", (c) => {
    const u = utterances.get(c.req.param("id"));
    if (!u) return errorBody(c, 404, "not_found", "no such utterance");
    const n = (reads.get(String(u.id)) ?? 0) + 1;
    reads.set(String(u.id), n);
    if (u.state !== "speaking" || n <= 2) return c.json(u);
    const ended = { ...u, state: "done", heard: u.text, endedAt: new Date().toISOString() };
    utterances.set(String(u.id), ended);
    return c.json(ended);
  });
  app.post("/speak/:id/cancel", (c) => {
    const u = utterances.get(c.req.param("id"));
    if (!u) return errorBody(c, 404, "not_found", "no such utterance");
    const cancelled = { ...u, state: "cancelled", endedAt: new Date().toISOString() };
    utterances.set(String(u.id), cancelled);
    return c.json(cancelled);
  });
  app.get("/speak/:id/events", (c) =>
    utterances.has(c.req.param("id"))
      ? c.json([])
      : errorBody(c, 404, "not_found", "no such utterance"),
  );
  // --- Tasks (design §3.5): the daemon's words (`task-words`), run order, every change logged
  // with its Undo, as the daemon's `task.*` commands do.
  const sandboxReady = () => state.sandbox.ready;
  /** As the daemon (ADR 0104): a done task the critic reviewed says how it was checked. */
  const withChecks = (views: TaskView[]): TaskView[] =>
    views.map((v) => {
      if (v.status !== "done" || /accepted without review/i.test(v.reason))
        return { ...v, check: null };
      const reviewed = state.runs.some((r) => r.taskId === v.id && r.reviewId);
      const evidence = state.reviewEvidence.get(v.id);
      if (!reviewed && !evidence) return { ...v, check: null };
      const tried = (evidence?.tried.length ?? 0) > 0;
      return {
        ...v,
        check: { label: tried ? ("Reviewed and tried" as const) : ("Reviewed" as const), tried },
      };
    });
  const taskViewsOf = (projectId: string) =>
    withChecks(
      projectTaskViews(state.tasks, projectId, state.requests, sandboxReady(), state.taskMeta),
    );
  const viewOf = (task: TaskView): TaskView =>
    taskViewsOf(task.projectId).find((v) => v.id === task.id) ?? task;
  /** The task as the screen showed it, or the daemon's 409 naming what it is now. */
  const stale = (c: Context, task: TaskView) =>
    c.json(
      {
        code: "conflict",
        message: `This task changed: it is now ${viewOf(task).display?.label ?? task.status}.`,
        details: { cause: "version_conflict", taskId: task.id, task: viewOf(task) },
      },
      409,
    );
  const touch = (task: TaskView) => {
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    emit("project.changed", { id: task.projectId });
  };
  const changeOf = (task: TaskView, entry: ChangeLogView) => ({
    ...viewOf(task),
    change: { changeLogId: entry.id, undoToken: entry.id, sentence: entry.sentence },
  });
  /** As the daemon: a person's move withdraws the task's open Inbox cards. */
  const withdrawCards = (taskId: string): string[] => {
    const ids: string[] = [];
    for (const r of state.requests)
      if (r.taskId === taskId && r.status === "open") {
        r.status = "withdrawn";
        ids.push(r.id);
      }
    if (ids.length) emit("inbox.changed", { blockingCount: blockingCount() });
    return ids;
  };
  /** As the daemon: a note for the agent is a queued note that names the task. */
  const queueTaskNote = (task: TaskView, note: string | undefined): string | null => {
    const text = note?.trim();
    if (!text) return null;
    const item: QueueItemView = {
      id: nextId("q"),
      projectId: task.projectId,
      humanId: ME.id,
      kind: "note",
      text: `About "${task.title}": ${text}`,
      priority: 0,
      status: "queued",
      consumedBySession: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    state.queue.unshift(item);
    return item.id;
  };
  app.get("/projects/:id/tasks", (c) => {
    const id = c.req.param("id");
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = taskViewsOf(id).filter((t) => !status || t.status === status);
    return c.json(rows.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100));
  });
  app.post("/projects/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const parsed = CreateTaskBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    // Like the daemon (U-040): an unknown or cancelled dependency is refused, nothing written.
    const deps = checkFakeDependencies(state.tasks, id, null, parsed.data.dependsOn);
    if (!deps.ok) return errorBody(c, 409, "conflict", deps.message);
    const task: TaskView = {
      id: nextId("task"),
      projectId: id,
      milestoneId: parsed.data.milestoneId ?? null,
      title: parsed.data.title,
      outcome: parsed.data.outcome,
      acceptanceCriteria: parsed.data.acceptanceCriteria,
      // Like the daemon: a task that names no tier gets the project's default (B.6).
      // A deploy or a migration is stored at the full review at least (`riskTierFor`, C-2).
      riskTier: Math.max(
        parsed.data.riskTier ?? project.defaultRiskTier ?? 1,
        FULL_REVIEW_SPECIALISTS.has(parsed.data.specialist ?? "") ? FULL_REVIEW_TIER : 0,
      ),
      status: parsed.data.status,
      priority: parsed.data.priority,
      claimedBy: null,
      claimExpires: null,
      dependsOn: deps.ids,
      budget: money(parsed.data.budgetUsdMicro),
      estimate: money(0),
      actual: money(0),
      // Like the daemon (U-042): the task's budget caps its runs; without one, the per-run
      // limit of the default specialist (the registry's coder: USD 3).
      ...(parsed.data.budgetUsdMicro > 0
        ? { cap: money(parsed.data.budgetUsdMicro), capSource: "task_budget" as const }
        : { cap: money(3_000_000), capSource: "specialist_limit" as const }),
      specialist: parsed.data.specialist ?? null,
      attempt: 0,
      prUrl: null,
      branch: null,
      reason: "Added by you",
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    state.tasks.push(task);
    state.taskMeta.added.set(task.id, state.taskMeta.added.size + 1000);
    const extra = [
      ...(parsed.data.priority !== "medium" ? [`${parsed.data.priority} priority`] : []),
      ...(parsed.data.specialist === "person"
        ? ["it asks you in the Inbox"]
        : parsed.data.specialist
          ? [`for the ${parsed.data.specialist}`]
          : []),
    ];
    const sentence = `Added "${task.title}" to ${project.name}${
      task.status === "draft" ? " as a draft (no session picks it up)" : ""
    }${extra.length ? `, ${extra.join(", ")}` : ""}.`;
    const entry = pushChange({
      commands: [{ name: "task.create", params: { title: task.title, project: id } }],
      before: { task_id: null, project_id: id },
      after: { task_id: task.id, project_id: id, status: task.status, title: task.title },
      scope: "project",
      projectId: id,
      source: "ui",
      wordsUsed: `New task: ${task.title}`,
      sentence,
      reversible: true,
    });
    // As the daemon: a task only the person can do is a question card at once (design §3.8).
    if (task.status === "ready" && task.specialist === "person") {
      task.status = "needs_human";
      const questions = task.acceptanceCriteria.length ? task.acceptanceCriteria : [task.title];
      state.requests.push({
        id: nextId("req"),
        projectId: id,
        projectName: project.name,
        taskId: task.id,
        taskTitle: task.title,
        sessionId: null,
        kind: "decision",
        why: `"${task.title}" needs your answers.`,
        steps: questions,
        options: ["Cancel the task"],
        blocking: true,
        risk: "low",
        changeCard: {
          key: `person_questions:${task.id}`,
          task_id: task.id,
          task_title: task.title,
          questions,
          source: "planned",
          on_answer: "done",
          context: null,
          applied_at: null,
        },
        status: "open",
        answer: null,
        createdAt: new Date().toISOString(),
        version: 1,
      });
      emit("inbox.changed", { blockingCount: blockingCount() });
    }
    emit("project.changed", { id });
    return c.json(changeOf(task, entry), 201);
  });
  app.get("/tasks/:id", (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const views = taskViewsOf(task.projectId);
    return c.json(
      fakeTaskDetail(
        views.find((v) => v.id === task.id) ?? task,
        views,
        state.requests,
        state.runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        state.reviewEvidence.get(task.id),
      ),
    );
  });
  // As the daemon (ADR 0104): a screenshot the task's review kept, and nothing else.
  app.get("/tasks/:id/evidence", (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const file = c.req.query("file") ?? "";
    const base64 = state.evidenceFiles.get(`${task.id}/${file}`);
    if (!base64)
      return errorBody(c, 404, "not_found", "This screenshot is not kept for this task.");
    return c.json({ file, contentType: "image/png", base64 });
  });
  app.put("/tasks/:id", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = UpdateTaskBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== task.version) return stale(c, task);
    if (!["draft", "ready", "needs_human", "failed"].includes(task.status))
      return errorBody(
        c,
        409,
        "conflict",
        task.status === "done" || task.status === "cancelled"
          ? `"${task.title}" is ${task.status}: ${task.status === "done" ? "Redo" : "Reopen"} it first, then edit it.`
          : `"${task.title}" is being worked on now: stop it first, then edit it.`,
      );
    const b = parsed.data;
    const before: Record<string, unknown> = {};
    const words: string[] = [];
    if (b.title !== undefined && b.title !== task.title) {
      before.title = task.title;
      task.title = b.title;
      words.push(`the title to "${b.title}"`);
    }
    if (b.outcome !== undefined && b.outcome !== task.outcome) {
      before.outcome = task.outcome;
      task.outcome = b.outcome;
      words.push("what done looks like");
    }
    if (
      b.acceptanceCriteria !== undefined &&
      JSON.stringify(b.acceptanceCriteria) !== JSON.stringify(task.acceptanceCriteria)
    ) {
      before.acceptanceCriteria = task.acceptanceCriteria;
      task.acceptanceCriteria = b.acceptanceCriteria;
      words.push("the criteria");
    }
    if (b.priority !== undefined && b.priority !== task.priority) {
      before.priority = task.priority;
      task.priority = b.priority;
      words.push(`priority to ${b.priority[0]?.toUpperCase()}${b.priority.slice(1)}`);
    }
    if (b.riskTier !== undefined && b.riskTier !== task.riskTier) {
      before.riskTier = task.riskTier;
      task.riskTier = b.riskTier;
      words.push(
        `review level to ${["Light review", "Light review", "Full review", "Full review and your sign-off"][b.riskTier]}`,
      );
    }
    if (b.budgetUsdMicro !== undefined && b.budgetUsdMicro !== task.budget.usdMicro) {
      before.budgetUsdMicro = task.budget.usdMicro;
      task.budget = money(b.budgetUsdMicro);
      words.push(
        b.budgetUsdMicro > 0
          ? `budget to CHF ${(b.budgetUsdMicro * 0.0000008).toFixed(2).replace(/\.00$/, "")}`
          : "no budget of its own",
      );
    }
    if (b.specialist !== undefined && (b.specialist ?? null) !== task.specialist) {
      before.specialist = task.specialist;
      task.specialist = b.specialist ?? null;
      words.push(
        `who does it to ${b.specialist === "person" ? "you" : (b.specialist ?? "the agent's choice")}`,
      );
    }
    // As the daemon's `riskTierFor` (C-2): a deploy or a migration stays at the full review.
    if (FULL_REVIEW_SPECIALISTS.has(task.specialist ?? "") && task.riskTier < FULL_REVIEW_TIER) {
      if (before.riskTier === undefined) before.riskTier = task.riskTier;
      task.riskTier = FULL_REVIEW_TIER;
      words.push("review level to Full review");
    }
    if (!words.length && !b.note?.trim())
      return errorBody(c, 409, "conflict", `Nothing to change on "${task.title}".`);
    touch(task);
    const noteId = queueTaskNote(task, b.note);
    const list =
      words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
    const entry = pushChange({
      commands: [{ name: "task.update", params: { task: task.id, project: task.projectId } }],
      before: { task_id: task.id, title: before.title ?? task.title, fields: before },
      after: { task_id: task.id, title: task.title, version: task.version, note_id: noteId },
      scope: "project",
      projectId: task.projectId,
      source: "ui",
      wordsUsed: b.note ?? `Edit ${task.title}`,
      sentence: `${words.length ? `Changed "${before.title ?? task.title}": ${list}.` : `Noted for "${task.title}".`}${noteId ? " Your note goes into its next brief." : ""}`,
      reversible: true,
    });
    return c.json(changeOf(task, entry));
  });
  // "Take this work out" (merged-actions), as the daemon's `TaskTakeOut` answers it: a merged
  // task's take-out pull request is opened (the next number on the project's list), the record
  // keeps it (the row reads "Taken out in #N (waiting for you to merge)") and the Overview lists
  // it under Waiting for you to merge; the done tasks that built on it are named. A task whose
  // work is not merged, or is being taken out already, is refused with the daemon's sentence.
  // `state.takeOutConflict` set by a test: the revert conflicts, and one Inbox notice is filed
  // per task while it is open, as `TaskTakeOut.notice` files it (the screens read it from
  // GET /inbox, worded by `request-words.ts`).
  app.post("/tasks/:id/take-out", (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const record = state.taskMeta.merges?.get(task.id);
    const refused = (sentence: string) =>
      c.json({ state: "refused", sentence, number: null, url: null, builtOn: [] });
    const title = quoted(task.title);
    if (task.status !== "done")
      return refused(`${title} is not done, so it has no merged work to take out.`);
    if (record?.take_out_state === "open" && record.take_out_pr_number)
      return refused(
        `${title} is being taken out in #${record.take_out_pr_number}: merge #${record.take_out_pr_number} to finish it.`,
      );
    if (record?.take_out_state === "merged" && record.take_out_pr_number)
      return refused(`${title} was taken out in #${record.take_out_pr_number}.`);
    if (record?.state !== "merged") {
      const n = record?.pr_number;
      return refused(
        n
          ? `#${n} is not merged, so ${title}'s work is not in main: close #${n} on GitHub if you do not want it.`
          : `${title} has no pull request, so there is nothing to take out of main.`,
      );
    }
    // The done tasks that built on it, directly or through another (`TaskTakeOut.builtOn`).
    const builtOn: string[] = [];
    const seen = new Set([task.id]);
    let frontier = [task.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const t of state.tasks)
        if (!seen.has(t.id) && t.dependsOn.some((d) => frontier.includes(d))) {
          seen.add(t.id);
          next.push(t.id);
          if (t.status === "done") builtOn.push(t.title);
        }
      frontier = next;
    }
    if (state.takeOutConflict) {
      const files = [...state.takeOutConflict];
      const sentence = takeOutConflictSentence(task.title, files);
      const key = `${TAKE_OUT_NOTICE_PREFIX}${task.id}`;
      const open = state.requests.some(
        (r) => r.status === "open" && (r.changeCard as { key?: unknown } | null)?.key === key,
      );
      if (!open) {
        const project = state.projects.find((p) => p.id === task.projectId);
        state.requests.push({
          id: nextId("req"),
          projectId: task.projectId,
          projectName: project?.name ?? null,
          taskId: null,
          taskTitle: null,
          sessionId: null,
          kind: "info",
          why: sentence,
          steps: [],
          options: [],
          blocking: false,
          risk: "low",
          changeCard: { key, task_id: task.id, task_title: task.title, files },
          status: "open",
          answer: null,
          createdAt: new Date().toISOString(),
          version: 1,
        });
        emit("inbox.changed", { blockingCount: blockingCount() });
      }
      return c.json({ state: "conflict", sentence, number: null, url: null, builtOn });
    }
    const prs = state.pullRequests[task.projectId] ?? { waiting: [], error: null };
    state.pullRequests[task.projectId] = prs;
    const number = Math.max(40, ...prs.waiting.map((w) => w.number)) + 1;
    const url = `https://example.test/org/atlas/pull/${number}`;
    record.take_out_pr_number = number;
    record.take_out_pr_url = url;
    record.take_out_state = "open";
    prs.waiting.push({
      kind: "take_out",
      taskId: task.id,
      title: `Take out: ${task.title}`,
      number,
      url,
      branch: `${task.branch ?? "fr/task"}-take-out`,
      review: null,
      merge: { state: "ready", canMerge: true, sentence: null, first: [] },
    });
    touch(task);
    emit("project.changed", { id: task.projectId });
    return c.json({
      state: "opened",
      sentence: takeOutOpenedSentence(task.title, number, builtOn),
      number,
      url,
      builtOn,
    });
  });
  app.post("/tasks/:id/action", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = TaskActionBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== task.version) return stale(c, task);
    const target = actionTarget(viewOf(task), parsed.data.action);
    if ("refused" in target) return errorBody(c, 409, "conflict", target.refused);
    const from = task.status;
    const { action, note } = parsed.data;
    // As the daemon: whether the move stops a live run or review (the cancel's sentence and
    // whether its work is set aside follow it).
    const live = liveWork(viewOf(task));
    // budget-resume: a paused task's work in progress is set aside too (as the daemon's
    // `setAsideWork`), and a project linked to the person's own folder keeps a run's (C-37).
    const shown = viewOf(task).display;
    const ownFolder = shown?.cancelWork === cancelWorkLine("own_folder");
    const setAside =
      target.to === "cancelled" &&
      ((live && !task.prUrl && !ownFolder) || shown?.blocker?.cardKind === "budget");
    // The row as it was, for the undo (as the daemon's change log records it).
    const was = {
      reason: task.reason,
      paused_by_person: state.taskMeta.pausedByPerson.has(task.id),
      attempt: task.attempt,
    };
    task.status = target.to;
    if (target.to === "needs_human") state.taskMeta.pausedByPerson.add(task.id);
    else state.taskMeta.pausedByPerson.delete(task.id);
    if (target.to !== "claimed" && target.to !== "in_progress") task.claimedBy = null;
    task.reason =
      note?.trim() ||
      {
        make_ready: "Made ready by you",
        pause: "Paused by you",
        stop: "Stopped by you",
        resume: "Resumed by you",
        go_ahead: "Go ahead without the answers: asked by you",
        try_again: "Try again: asked by you",
        cancel: "Cancelled by you",
        reopen: "Reopened by you",
        redo: "Redo asked by you",
      }[action];
    touch(task);
    const withdrawnIds =
      ["needs_human", "failed", "in_review"].includes(from) || target.to === "cancelled"
        ? withdrawCards(task.id)
        : [];
    const withdrawn = withdrawnIds.length;
    const withoutAnswers =
      action === "go_ahead" || (from === "needs_human" && withdrawn > 0 && target.to === "ready")
        ? queueTaskNote(
            task,
            "The person chose to go ahead without answering the questions asked about this task: decide yourself and say in the report what you assumed.",
          )
        : null;
    const noteId = queueTaskNote(task, note);
    const stuck =
      target.to === "cancelled"
        ? state.tasks
            .filter(
              (t) =>
                t.dependsOn.includes(task.id) && t.status !== "done" && t.status !== "cancelled",
            )
            .map((t) => t.title)
        : [];
    const entry = pushChange({
      commands: [
        {
          name:
            action === "pause" || action === "stop"
              ? "task.pause"
              : action === "resume" || action === "go_ahead"
                ? "task.resume"
                : action === "reopen" || action === "redo"
                  ? "task.reopen"
                  : "task.transition",
          params: { task: task.id, project: task.projectId },
        },
      ],
      before: { task_id: task.id, status: from, title: task.title, ...was },
      after: {
        task_id: task.id,
        status: task.status,
        title: task.title,
        ...(noteId ? { note_id: noteId } : {}),
        ...(withoutAnswers ? { without_answers_note_id: withoutAnswers } : {}),
        ...(withdrawn ? { withdrawn_requests: withdrawnIds } : {}),
        // The fake's own mark: the undo says the work is back, as the daemon's does.
        ...(setAside ? { set_aside: true } : {}),
      },
      scope: "project",
      projectId: task.projectId,
      source: "ui",
      // What the person pressed, in the button's words (Changes shows it as what they said).
      wordsUsed: note ?? ACTION_WORDS[action],
      sentence: actionSentence(task, from, task.status, {
        withdrawn,
        noted: noteId !== null,
        stuck,
        live,
        shown,
      }),
      reversible: true,
    });
    return c.json(changeOf(task, entry));
  });
  app.post("/tasks/:id/transition", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = TransitionTaskBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== task.version) return stale(c, task);
    // As the daemon's store: a person never puts a task where only an agent's claim does.
    if (["claimed", "in_progress"].includes(parsed.data.to))
      return errorBody(
        c,
        409,
        "conflict",
        `only an agent's session moves a task to ${parsed.data.to}; mark it ready and start a session`,
      );
    if (!(TASK_TRANSITIONS[task.status] ?? []).includes(parsed.data.to))
      return errorBody(
        c,
        409,
        "conflict",
        `task: illegal transition ${task.status} -> ${parsed.data.to}`,
      );
    const from = task.status;
    const live = liveWork(viewOf(task));
    const shown = viewOf(task).display;
    const setAside =
      parsed.data.to === "cancelled" &&
      ((live && !task.prUrl && shown?.cancelWork !== cancelWorkLine("own_folder")) ||
        shown?.blocker?.cardKind === "budget");
    task.status = parsed.data.to;
    task.reason = parsed.data.reason ?? parsed.data.note ?? `Moved by you`;
    if (parsed.data.to === "needs_human") state.taskMeta.pausedByPerson.add(task.id);
    touch(task);
    const entry = pushChange({
      commands: [
        {
          name: "task.transition",
          params: { task: task.id, to: parsed.data.to, project: task.projectId },
        },
      ],
      before: { task_id: task.id, status: from, title: task.title },
      after: {
        task_id: task.id,
        status: parsed.data.to,
        title: task.title,
        ...(setAside ? { set_aside: true } : {}),
      },
      scope: "project",
      projectId: task.projectId,
      source: "ui",
      wordsUsed: parsed.data.reason ?? "",
      sentence: actionSentence(task, from, parsed.data.to, { live, shown }),
      reversible: true,
    });
    return c.json(changeOf(task, entry));
  });
  app.post("/tasks/:id/dependencies", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = SetTaskDependenciesBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const deps = checkFakeDependencies(state.tasks, task.projectId, task.id, parsed.data.dependsOn);
    if (!deps.ok) return errorBody(c, 409, "conflict", deps.message);
    if (parsed.data.version !== task.version) return stale(c, task);
    const before = task.dependsOn;
    task.dependsOn = deps.ids;
    task.reason = parsed.data.reason ?? parsed.data.note ?? "What it waits for changed by you";
    touch(task);
    const noteId = queueTaskNote(task, parsed.data.note);
    const titles = deps.ids.map((d) => `"${state.tasks.find((t) => t.id === d)?.title ?? d}"`);
    const list =
      titles.length <= 1
        ? titles.join("")
        : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
    const entry = pushChange({
      commands: [{ name: "task.dependencies", params: { task: task.id, project: task.projectId } }],
      before: { task_id: task.id, title: task.title, depends_on: before },
      after: {
        task_id: task.id,
        title: task.title,
        depends_on: deps.ids,
        ...(noteId ? { note_id: noteId } : {}),
      },
      scope: "project",
      projectId: task.projectId,
      source: "ui",
      wordsUsed: parsed.data.reason ?? parsed.data.note ?? "Change what it waits for",
      sentence: `${titles.length ? `"${task.title}" now waits for ${list}.` : `"${task.title}" waits for no other task now.`}${noteId ? " Your note goes into its next brief." : ""}`,
      reversible: true,
    });
    return c.json(changeOf(task, entry));
  });
  app.get("/projects/:id/start-check", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const raw = Number(c.req.query("budgetUsdMicro") ?? "");
    const view = fakeStartCheck(
      state.tasks,
      id,
      Number.isInteger(raw) && raw > 0 ? raw : null,
      state.sandbox,
      {
        killActive: state.killActive,
        busy: (options.startOutcome ?? "started") === "queued",
        busyHere: options.busyProjectId === id,
      },
    );
    // As the daemon: with no task yet because the plan waits (or is drafted), the button is
    // the plan card (design §3.3, §3.6).
    const intake = state.intake[id]?.state;
    const nothing = view.blocked?.kind === "nothing_runnable" && view.ready === 0;
    if (nothing && intake === "pending")
      view.blocked = {
        kind: "nothing_runnable",
        sentence: "Nothing can run yet: the plan from your brief waits for your approval.",
        action: { kind: "link", label: "Review the plan", to: "/inbox" },
      };
    else if (nothing && intake === "drafting")
      view.blocked = {
        kind: "nothing_runnable",
        sentence: "Nothing can run yet: the plan from your brief is being drafted.",
        action: null,
      };
    // As the daemon (U-078): the plan waits for a Claude credential.
    else if (nothing && intake === "waiting") {
      const wait = state.intake[id]?.wait;
      view.blocked = {
        kind: "nothing_runnable",
        sentence: `Nothing can run yet. ${wait?.text ?? "Planning waits for a Claude credential."}`,
        action: wait?.save ? { kind: "link", label: wait.save.label, to: wait.save.to } : null,
      };
    }
    return c.json(view);
  });
  app.get("/projects/:id/runs", (c) => {
    const id = c.req.param("id");
    const taskIds = new Set(state.tasks.filter((t) => t.projectId === id).map((t) => t.id));
    return c.json(state.runs.filter((r) => r.taskId && taskIds.has(r.taskId)));
  });
  app.get("/projects/:id/decisions", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    return c.json(DECISIONS.filter((d) => d.projectId === id));
  });
  app.get("/projects/:id/peers", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    return c.json(PEERS[id] ?? { generatedAt: new Date().toISOString(), projectId: id, peers: [] });
  });

  app.get("/sessions", (c) => {
    const agentId = c.req.query("agentId");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");
    return c.json(
      state.sessions.filter(
        (s) =>
          (!agentId || s.agentId === agentId) &&
          (!projectId || s.projectId === projectId) &&
          (!status || s.status === status),
      ),
    );
  });
  app.post("/sessions", async (c) => {
    const parsed = StartSessionBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (state.killActive) {
      // As the real daemon answers it (U-077).
      return errorBody(c, 409, "killed", KILL_ACTIVE_START_MESSAGE);
    }
    const agent = AGENTS.find((a) => a.id === parsed.data.agentId);
    if (!agent) return errorBody(c, 404, "not_found", "no such agent");
    // As the daemon (later #38): nothing a session could run is refused with the start check's
    // sentence, whoever asks (the Start dialog, Continue where it stopped, the phone).
    if (parsed.data.projectId) {
      const check = fakeStartCheck(
        state.tasks,
        parsed.data.projectId,
        parsed.data.budgetUsdMicro ?? null,
        state.sandbox,
        {
          killActive: false,
          busy: (options.startOutcome ?? "started") === "queued",
          busyHere: options.busyProjectId === parsed.data.projectId,
        },
      );
      if (check.blocked?.kind === "nothing_runnable")
        return errorBody(c, 409, "conflict", check.blocked.sentence);
    }
    const startId = nextId("start");
    const outcome = options.startOutcome ?? "started";
    if (outcome !== "started") {
      // The real daemon's answer, checked against its schema so the two cannot drift (U-008).
      // Like its scheduler, waiting starts keep their order: each says how many wait before
      // it (U-043).
      const ahead = waitingStarts.count++;
      return c.json(
        StartSessionView.parse({ result: outcome, startId, session: null, ahead }),
        202,
      );
    }
    const session = beginSession({
      agent,
      projectId: parsed.data.projectId ?? null,
      trigger: parsed.data.trigger,
      budgetUsdMicro: parsed.data.budgetUsdMicro ?? 6_250_000,
      note: parsed.data.note,
    });
    return c.json(StartSessionView.parse({ result: "started", startId, session }), 202);
  });
  app.get("/sessions/:id", (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param("id"));
    return s ? c.json(s) : errorBody(c, 404, "not_found", "no such session");
  });
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const session = state.sessions.find((x) => x.id === id);
    if (!session) return errorBody(c, 404, "not_found", "no such session");
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const backlog = state.events.filter((e) => e.sessionId === id && e.seq > afterSeq);
    const wantsSse = (c.req.header("accept") ?? "").includes("text/event-stream");
    if (!wantsSse) return c.json(backlog);
    return streamSSE(c, async (stream) => {
      let open = true;
      const listener: Listener = (event, data) => {
        if (!open) return;
        if (event === "session.event" && (data as EventView).sessionId !== id) return;
        if (event === "session.changed" && (data as SessionView).id !== id) return;
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      for (const e of backlog) {
        await stream.writeSSE({ event: "session.event", data: JSON.stringify(e) });
      }
      state.listeners.add(listener);
      stream.onAbort(() => {
        open = false;
        state.listeners.delete(listener);
      });
      // The real daemon ends a session's stream once the session has ended (U-071).
      const ended = () => ["completed", "stopped", "failed", "killed"].includes(session.status);
      while (open && !ended()) {
        await stream.sleep(heartbeatMs);
        if (!open || ended()) break;
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }
      open = false;
      state.listeners.delete(listener);
    });
  });
  app.post("/sessions/:id/stop", (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param("id"));
    if (!s) return errorBody(c, 404, "not_found", "no such session");
    if (["running", "paused", "planned"].includes(s.status)) {
      // As the real daemon: Stop now ends it, says who stopped it, and is no error; an ended
      // session has no current task.
      s.status = "stopped";
      s.endedAt = new Date().toISOString();
      s.stopReason = "you";
      s.statusText = "Stopped by you";
      s.currentTask = null;
      pushEvent(s, "session.stopped", "Stopped by you.", "info");
      emit("session.changed", clone(s));
    }
    return c.json(s);
  });

  app.post("/sessions/:id/pause", (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param("id"));
    if (!s) return errorBody(c, 404, "not_found", "no such session");
    // As the real daemon: the row is paused and reads "Stopping after this task"; the scripted
    // run ends it after its task with "Stopped after the task, as asked".
    if (s.status === "running") {
      s.status = "paused";
      s.statusText = "Stopping after this task";
      emit("session.changed", clone(s));
    }
    return c.json(s);
  });

  app.post("/kill", async (c) => {
    const parsed = KillBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    return c.json({ killActive: true, stoppedSessions: stopAll() });
  });
  /**
   * Stop all, as the daemon's kill switch with `by: "stop_all"`: the header's POST /kill and
   * the chat's "stop everything" (its session.stop for everything) alike; the projects it
   * stopped are what Continue where it stopped starts again (later #60).
   */
  function stopAll(): number {
    state.killActive = true;
    let stopped = 0;
    for (const s of state.sessions) {
      if (s.status === "running" || s.status === "paused" || s.status === "planned") {
        // As the real daemon: whatever words the header sends, this is the person's Stop all
        // (design §4.9), never an error line.
        s.status = "killed";
        s.endedAt = new Date().toISOString();
        s.stopReason = "stop_all";
        s.statusText = "Stopped: Stop all";
        s.currentTask = null;
        pushEvent(s, "session.stopped", "Stopped: Stop all.", "info");
        stopped += 1;
        // As the daemon's kill switch (later #60): what Continue where it stopped starts again.
        if (s.projectId && !stoppedByKill.includes(s.projectId)) stoppedByKill.push(s.projectId);
        emit("session.changed", clone(s));
      }
    }
    return stopped;
  }
  app.post("/kill/resume", (c) => {
    state.killActive = false;
    const stoppedProjects = stoppedByKill.splice(0);
    return c.json({ killActive: false, stoppedSessions: 0, ok: true, stoppedProjects });
  });

  // Desktop control (spec S.32; ADR 0067): the status with what the indicator shows, revoke
  // (the banner's "Stop desktop control") and resume, as `packages/capabilities` answers them.
  const desktopStatus = () => ({
    capability: "desktop-control",
    adapter: "fake",
    revoked: state.desktop.revoked,
    revokedReason: state.desktop.revokedReason,
    indicatorOn: state.desktop.control.active,
    desktopControl: clone(state.desktop.control),
    inFlight: state.desktop.control.active ? 1 : 0,
    queued: 0,
    actions: 0,
  });
  app.get("/desktop/status", (c) => c.json(desktopStatus()));
  app.post("/desktop/revoke", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = body.reason ?? "revoked from the panel";
    const interrupted = state.desktop.control.active ? 1 : 0;
    state.desktop.revoked = true;
    state.desktop.revokedReason = reason;
    setDesktopControl(null);
    return c.json({ reason, interrupted, dropped: 0, status: desktopStatus() });
  });
  app.post("/desktop/resume", (c) => {
    state.desktop.revoked = false;
    state.desktop.revokedReason = null;
    return c.json(desktopStatus());
  });
  // Settings → Desktop control (U-060), as the daemon's capability routes: a human's own list
  // only (403 `tool_not_allowed` for another id), a bad entry 400.
  app.get("/desktop/allowlist/:humanId", (c) => {
    if (c.req.param("humanId") !== me.id) {
      return errorBody(
        c,
        403,
        "tool_not_allowed",
        "a human can read only their own desktop allowlist",
      );
    }
    return c.json({ humanId: me.id, entries: state.desktopAllowlist });
  });
  app.put("/desktop/allowlist/:humanId", async (c) => {
    if (c.req.param("humanId") !== me.id) {
      return errorBody(
        c,
        403,
        "tool_not_allowed",
        "a human can change only their own desktop allowlist",
      );
    }
    const body = (await c.req.json()) as { entries?: unknown };
    if (
      !Array.isArray(body.entries) ||
      body.entries.some((e) => typeof e === "string" && e.trim() === "")
    ) {
      return errorBody(c, 400, "validation", "entries: a list of application names");
    }
    // As the daemon stores it (`parseAllowEntry`): a name is `{ app }` in lower case.
    state.desktopAllowlist = (body.entries as DesktopAllowEntryView[]).map((e) =>
      typeof e === "string" ? { app: e.trim().toLowerCase() } : e,
    );
    return c.json({ humanId: me.id, entries: state.desktopAllowlist });
  });

  app.get("/inbox", async (c) => {
    const requests = state.requests.map(worded);
    // U-078, C-68 (as the daemon, with its `planTaskViews`): an open plan card's tasks as this
    // install would run them now.
    for (const r of requests) {
      const planTasks = await planTaskViews(
        { change_card: r.changeCard as never, project_id: r.projectId, status: r.status as never },
        {
          has: (name) => name in FAKE_REGISTRY_TOOLS,
          forTask: async ({ specialist, projectId, task }) =>
            runsOnFor(specialist, projectId, task),
        },
      );
      if (planTasks) r.planTasks = planTasks;
    }
    return c.json({
      requests,
      messages: state.messages,
      blockingCount: blockingCount(),
      needsYouCount: needsYouCount(),
    });
  });
  // Cloud runner unlock (spec S.12, ADR 0068): the daemon's keyring answers whether it holds
  // the runner's key and wraps it to the challenge; the key never leaves this handler.
  app.get("/runner-unlock/:runnerId/key", (c) => {
    const runnerId = c.req.param("runnerId");
    const available = Boolean(state.runnerKeys[runnerId]);
    return c.json({
      runnerId,
      available,
      backend: "keyring",
      reason: available ? null : `This computer's vault has no key for runner "${runnerId}".`,
    });
  });
  app.post("/runner-unlock/wrap", async (c) => {
    const parsed = RunnerUnlockWrapBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    // As the daemon: the challenge comes from the stored open request, never from the body.
    const r = state.requests.find((x) => x.id === parsed.data.requestId);
    if (!r) return errorBody(c, 404, "not_found", "no such request");
    if (r.status !== "open") return errorBody(c, 409, "conflict", `the request is ${r.status}`);
    const card = r.kind === "credential" ? parseUnlockChallenge(r.changeCard) : null;
    if (!card) return errorBody(c, 400, "validation", "not a runner unlock challenge");
    const key = decodeStoredKey(state.runnerKeys[card.runnerId] ?? null);
    if (!key) return errorBody(c, 404, "not_found", "no key for this runner");
    try {
      const answer = await wrapVaultKey(card, key, {
        now: Date.now(),
        ...(parsed.data.autoUnlockUntil !== undefined
          ? { autoUnlockUntil: parsed.data.autoUnlockUntil }
          : {}),
      });
      return c.json(answer);
    } catch (e) {
      return errorBody(c, 400, "validation", e instanceof Error ? e.message : String(e));
    } finally {
      key.fill(0);
    }
  });
  app.post("/requests/:id/answer", async (c) => {
    const r = state.requests.find((x) => x.id === c.req.param("id"));
    if (!r) return errorBody(c, 404, "not_found", "no such request");
    const parsed = AnswerRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== r.version) {
      return errorBody(c, 409, "conflict", "request changed since you loaded it");
    }
    // U-034, as the real daemon (`assertAnswerAccepted`): an answer the card cannot act on is
    // a 400 listing its options, and the request stays open.
    const check = acceptsAnswer(
      { kind: r.kind, options: r.options, change_card: r.changeCard },
      parsed.data.answer,
    );
    if (!check.ok) return errorBody(c, 400, "validation", check.message);
    r.status = "answered";
    r.answer = parsed.data.answer;
    r.version += 1;
    for (const p of state.projects) {
      if (p.id === r.projectId && p.waitingOnYou > 0) p.waitingOnYou -= 1;
    }
    // U-022, as the daemon's `syncPersonQuestions`: answers close a planned person task (done)
    // or send a paused one back to ready; "Cancel task" cancels it; "Go ahead without", which
    // only a specialist's card offers (the route above refuses it on the person's own card,
    // phase E), sends it back to ready without the answers (design §3.8). The card records the
    // outcome.
    const personCard = r.changeCard as { key?: unknown; on_answer?: unknown } | null;
    if (typeof personCard?.key === "string" && personCard.key.startsWith("person_questions:")) {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const read = personQuestionsAnswerFor(personCard, parsed.data.answer as never);
      if (task && read?.kind === "cancel") task.status = "cancelled";
      else if (task && read?.kind === "without") task.status = "ready";
      else if (task && read?.kind === "answers")
        task.status = personCard.on_answer === "ready" ? "ready" : "done";
      // As the daemon's resumeWork: an answer that leaves a task of the project runnable (the
      // task itself back at ready, or what waited on the person's task now done) starts a
      // session; nothing runnable, no start.
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const runnable = state.tasks.some(
        (t) =>
          t.projectId === r.projectId &&
          t.status === "ready" &&
          t.dependsOn.every((d) => byId.get(d)?.status === "done"),
      );
      r.changeCard = {
        ...personCard,
        applied_at: new Date().toISOString(),
        outcome:
          read?.kind === "cancel" ? "cancelled" : read?.kind === "without" ? "without" : "answered",
        ...(read?.kind !== "cancel" && runnable ? { start: "started" } : {}),
      };
    }
    // As the daemon's `syncSignoffAnswers` (design §3.8): Try again / Send it back sends the task
    // back to ready and a session starts; Mark done anyway closes it "accepted without review";
    // Cancel task cancels it.
    const signCard = r.changeCard as { key?: unknown; reason?: unknown } | null;
    if (signCard?.key === "critic:signoff") {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const read = signoffAnswer(parsed.data.answer as never);
      if (task && read === "revise") {
        task.status = "ready";
        task.reason = "you asked to try again in the Inbox";
      } else if (task && read === "accept") {
        task.status = "done";
        task.reason =
          signCard.reason === "verdict"
            ? "you accepted the work at sign-off"
            : "accepted without review: you marked it done in the Inbox";
      } else if (task && read === "cancel") {
        task.status = "cancelled";
        task.reason = "you cancelled it in the Inbox";
      }
      r.changeCard = {
        ...signCard,
        applied_at: new Date().toISOString(),
        outcome: read,
        ...(read !== "cancel" ? { start: "started" } : {}),
      };
    }
    // As the daemon's `syncBudgetStopAnswers` (budget-resume, ADR 0112 amended): Continue (CHF
    // N more) gives it that much more (its budget, or the session that continues it for a stop at
    // the session's budget) and a session starts at once; Cancel task cancels it and sets its work
    // aside. A card of before budget-resume ("Raise the budget") sets the budget it named.
    const budgetCard = r.changeCard as {
      key?: unknown;
      raise_to_usd_micro?: unknown;
      continue_usd_micro?: unknown;
      source?: unknown;
    } | null;
    if (budgetCard?.key === "task:budget_stop") {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const read = budgetStopAnswer(parsed.data.answer as never);
      const moved = !task || task.status !== "needs_human";
      let budget: number | null = null;
      let more: number | null = null;
      if (task && !moved && read === "continue") {
        const session = budgetCard.source === "session" || budgetCard.source === "session_budget";
        if (typeof budgetCard.continue_usd_micro === "number") {
          more = budgetCard.continue_usd_micro;
          budget = session
            ? task.budget.usdMicro
            : Math.max(task.budget.usdMicro, task.actual.usdMicro) + more;
        } else {
          more = Number(budgetCard.raise_to_usd_micro) || 0;
          budget = session ? task.budget.usdMicro : Math.max(task.budget.usdMicro, more);
        }
        task.budget = money(budget);
        task.cap = money(Math.max(0, budget - task.actual.usdMicro));
        if (!session) task.capSource = "task_budget";
        task.status = "ready";
        task.reason = `you gave it CHF ${(money(more).chfMicro / 1e6).toFixed(2)} more in the Inbox: it continues from where it stopped`;
        touch(task);
      } else if (task && !moved && read === "cancel") {
        task.status = "cancelled";
        task.reason = "you cancelled it in the Inbox when it paused at a budget";
        touch(task);
      }
      r.changeCard = {
        ...budgetCard,
        applied_at: new Date().toISOString(),
        outcome: moved ? "task_moved_on" : read,
        ...(budget !== null
          ? { budget_usd_micro: budget, continued_usd_micro: more, start: "started" }
          : {}),
        ...(!moved && read === "cancel" ? { set_aside: 1 } : {}),
      };
    }
    // As the daemon's `syncCannotRunAnswers` (live walk 4): Try again puts the task back to
    // ready and a session tries again; Cancel task cancels it.
    const cannotRun = r.changeCard as { key?: unknown } | null;
    if (cannotRun?.key === "task:cannot_run") {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const read = cannotRunAnswer(parsed.data.answer as never);
      const moved = !task || task.status !== "needs_human";
      if (task && !moved && read === "retry") {
        task.status = "ready";
        task.reason = "you asked to try again in the Inbox";
        touch(task);
      } else if (task && !moved && read === "cancel") {
        task.status = "cancelled";
        task.reason = "you cancelled it in the Inbox when it could not run";
        touch(task);
      }
      r.changeCard = {
        ...cannotRun,
        applied_at: new Date().toISOString(),
        outcome: moved ? "task_moved_on" : read,
        ...(!moved && read === "retry" ? { start: "started" } : {}),
      };
    }
    if (r.kind === "capability_grant") {
      const ext = state.extensions.find((e) => `req_${e.id}` === r.id);
      if (ext && parsed.data.answer === "Approve") approveExtension(ext);
      else if (ext) {
        state.extensions = state.extensions.filter((e) => e.id !== ext.id);
        emitExtension("extension.denied", ext);
      }
    }
    emit("inbox.changed", { blockingCount: blockingCount() });
    return c.json(worded(r));
  });
  app.post("/messages/:id/read", (c) => {
    const m = state.messages.find((x) => x.id === c.req.param("id"));
    if (!m) return errorBody(c, 404, "not_found", "no such message");
    m.readAt = m.readAt ?? new Date().toISOString();
    return c.json(m);
  });

  /** A change log row as the daemon records one (newest first). */
  const pushChange = (row: {
    commands: unknown[];
    before: unknown;
    after: unknown;
    scope: ChangeLogView["scope"];
    projectId: string | null;
    source: string;
    wordsUsed: string;
    sentence: string;
    reversible: boolean;
  }): ChangeLogView => {
    const entry: ChangeLogView = {
      id: nextId("chg"),
      humanId: ME.id,
      agentId: "agent_alice",
      wordsUsed: row.wordsUsed,
      commands: row.commands,
      before: row.before,
      after: row.after,
      scope: row.scope,
      projectId: row.projectId,
      expiresAt: null,
      undoState: row.reversible ? "undoable" : "irreversible",
      undoneAt: null,
      source: row.source,
      sentence: row.sentence,
      undoable: row.reversible,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    state.changes.unshift(entry);
    return entry;
  };
  /** A task row as the daemon's task.create writes one. */
  const newTask = (projectId: string, title: string, status: string): TaskView => ({
    id: nextId("task"),
    projectId,
    milestoneId: null,
    title,
    outcome: "",
    acceptanceCriteria: [],
    riskTier: 1,
    status,
    priority: "medium",
    cap: money(3_000_000),
    capSource: "specialist_limit" as const,
    claimedBy: null,
    claimExpires: null,
    dependsOn: [],
    budget: money(0),
    estimate: money(0),
    actual: money(0),
    specialist: null,
    attempt: 0,
    prUrl: null,
    branch: null,
    reason: "created by chat",
    updatedAt: new Date().toISOString(),
    version: 1,
  });

  /** The session each chat start began, by its action's id (the daemon's change log row). */
  const startedSessions = new Map<string, string>();
  const chatReply = (
    text: string,
    projectId: string | undefined,
    projectTab = false,
  ): ChatReplyView => {
    // As the daemon (U-056): the recorded active project is every channel's; a project's own
    // Chat tab wins for its turn only, and the reply names the active project, not the tab's.
    const active = () => state.projects.find((p) => p.active)?.id ?? null;
    const turnProject = projectTab && projectId ? projectId : (active() ?? projectId ?? null);
    const base = {
      actions: [] as ChatReplyView["actions"],
      pendingConfirmation: null as ChatReplyView["pendingConfirmation"],
      question: null as ChatReplyView["question"],
      ttftMs: 420,
      cost: money(12_000),
      transcriptId: nextId("tr"),
      activeProjectId: active() ?? (projectTab ? null : (projectId ?? null)),
    };
    const lower = text.trim().toLowerCase();
    const switchTo = /^switch to (.+)$/i.exec(text.trim());
    if (switchTo) {
      const wanted = (switchTo[1] ?? "").toLowerCase();
      const target = state.projects.find((p) => p.name.toLowerCase().includes(wanted));
      if (target) {
        const before = active();
        for (const p of state.projects) p.active = p.id === target.id;
        const sentence = `Switched the active project to ${target.name}. Undo.`;
        const entry = pushChange({
          commands: [{ name: "project.switch", params: { project: target.id } }],
          before: { activeProject: before },
          after: { activeProject: target.id },
          scope: "global",
          projectId: target.id,
          source: "chat",
          wordsUsed: text,
          sentence,
          reversible: true,
        });
        return {
          ...base,
          activeProjectId: target.id,
          reply: sentence,
          actions: [
            { kind: "project.switch", summary: sentence, id: entry.id, undoToken: entry.id },
          ],
        };
      }
    }
    const addTask = /^add a task:?\s+(.+)$/i.exec(text.trim());
    if (addTask && turnProject) {
      const target = state.projects.find((p) => p.id === turnProject);
      const title = (addTask[1] ?? "").trim();
      const task = newTask(turnProject, title, "ready");
      state.tasks.push(task);
      const sentence = `Added "${title}" to ${target?.name ?? turnProject}.`;
      const entry = pushChange({
        commands: [{ name: "task.create", params: { title, project: turnProject } }],
        before: { task_id: null, project_id: turnProject },
        after: { task_id: task.id, project_id: turnProject, status: "ready" },
        scope: "project",
        projectId: turnProject,
        source: "chat",
        wordsUsed: text,
        sentence,
        reversible: true,
      });
      return {
        ...base,
        reply: sentence,
        actions: [{ kind: "task.create", summary: sentence, id: entry.id, undoToken: entry.id }],
      };
    }
    if (state.pendingConfirmation && lower === "yes") {
      const confirmed = state.pendingConfirmation;
      state.pendingConfirmation = null;
      // As the daemon's session.start from the chat (phase E): the start waits for its run,
      // the reply is the change's sentence, and the turn's action names the session it began
      // (its change log's `after.session_id`), which the conversation links.
      const agent = AGENTS[0];
      const target = state.projects.find((p) => p.id === turnProject);
      if (agent) {
        const session = beginSession({
          agent,
          projectId: turnProject,
          trigger: "manual",
          budgetUsdMicro: 6_250_000,
        });
        startedSessions.set(confirmed.id, session.id);
      }
      const sentence = `Started a session on ${target?.name ?? "this project"} (up to CHF 5).`;
      return {
        ...base,
        reply: sentence,
        actions: [{ kind: "session.start", summary: sentence, id: confirmed.id }],
      };
    }
    if (state.pendingConfirmation && lower === "no") {
      state.pendingConfirmation = null;
      return { ...base, reply: "Cancelled. Nothing was started." };
    }
    // A "yes" with nothing waiting never reaches the model (the daemon's `YES_TO_WHAT_REPLY`).
    if (!state.pendingConfirmation && lower === "yes") {
      return { ...base, reply: "Yes to what? Nothing is waiting for your yes." };
    }
    // "stop everything" is Stop all and "resume" lifts it, as the daemon's session.stop (scope
    // all) and session.resume, with their sentences.
    if (lower === "stop everything") {
      stopAll();
      const sentence =
        'Stopped every running session. No session starts until you say "resume" or press Allow sessions again.';
      return {
        ...base,
        reply: sentence,
        actions: [{ kind: "session.stop", summary: sentence, id: nextId("chg"), undoToken: null }],
      };
    }
    if (lower === "resume") {
      state.killActive = false;
      const sentence =
        'Sessions can start again. Say "start a session" to continue where it stopped.';
      return {
        ...base,
        reply: sentence,
        actions: [
          { kind: "session.resume", summary: sentence, id: nextId("chg"), undoToken: null },
        ],
      };
    }
    if (state.nextChatReply !== null) {
      const reply = state.nextChatReply;
      const actions = state.nextChatActions ?? [];
      state.nextChatReply = null;
      state.nextChatActions = null;
      return { ...base, reply, actions };
    }
    // As the daemon's session.start (`startBlocked` with the plan): while the plan from the
    // brief waits and no task is written, the chat says so at once, with no Yes/No card.
    if (
      lower.includes("start a session") &&
      turnProject &&
      state.intake[turnProject]?.state === "pending" &&
      !state.tasks.some((t) => t.projectId === turnProject)
    ) {
      return {
        ...base,
        reply:
          "Nothing can run yet: the plan from your brief waits for your approval. Review it in the Inbox.",
      };
    }
    if (lower.includes("start a session")) {
      const id = nextId("confirm");
      const readback = "You want to start a session with a budget of CHF 4.00.";
      state.pendingConfirmation = { id, readback };
      return {
        ...base,
        reply: `${readback} Say yes to confirm.`,
        pendingConfirmation: {
          id,
          readback,
          estimate: money(5_000_000),
          commands: ["session.start"],
          decision: "needs_yes",
        },
      };
    }
    const project = state.projects.find((p) => p.id === projectId);
    // U-047, as the daemon without a Claude key: a command that needs no model runs ("add a
    // task: …" adds a ready task), any other line is told where the setup assistant is.
    if (options.noModel) {
      const added = /^add a task:\s*(.+)$/i.exec(text.trim());
      if (added?.[1] && project) {
        const title = added[1].trim();
        const task: TaskView = {
          id: nextId("task"),
          projectId: project.id,
          milestoneId: null,
          title,
          outcome: title,
          acceptanceCriteria: [],
          riskTier: project.defaultRiskTier ?? 1,
          status: "ready",
          priority: "medium",
          cap: money(3_000_000),
          capSource: "specialist_limit" as const,
          claimedBy: null,
          claimExpires: null,
          dependsOn: [],
          budget: money(0),
          estimate: money(0),
          actual: money(0),
          specialist: null,
          attempt: 0,
          prUrl: null,
          branch: null,
          reason: "",
          updatedAt: new Date().toISOString(),
          version: 1,
        };
        state.tasks.unshift(task);
        return {
          ...base,
          ttftMs: 0,
          cost: money(0),
          reply: `Created the ready task "${title}".`,
          actions: [{ kind: "task.create", summary: title, id: task.id }],
        };
      }
      return { ...base, ttftMs: 0, cost: money(0), reply: NO_MODEL_CHAT_REPLY };
    }
    return {
      ...base,
      reply: `${project ? `${project.name}: ` : ""}you asked "${text.trim()}". The last session opened PR #12; one question waits in the inbox.`,
    };
  };

  /** A turn kept in its conversation, as the daemon writes chat.human and chat.reply. */
  const keepTurn = (body: ChatRequestBody, reply: ChatReplyView): ChatReplyView => {
    const key = body.projectId ?? "";
    const turns = state.conversations.get(key) ?? [];
    const readback = reply.pendingConfirmation?.readback ?? null;
    const text =
      readback && reply.reply.startsWith(readback)
        ? reply.reply
            .slice(readback.length)
            .replace(/^\s*Say yes to confirm\.\s*/, "")
            .trim()
        : reply.reply;
    turns.push({
      id: reply.transcriptId,
      at: new Date().toISOString(),
      said: body.text,
      source: body.source ?? "text",
      reply: {
        text,
        actions: reply.actions.map((a) => ({
          kind: a.kind,
          sentence: a.summary,
          changeId: a.id ?? null,
          canUndo: !!a.undoToken,
          // The session a chat start began, as the daemon's conversation view links it.
          sessionId: (a.id ? startedSessions.get(a.id) : undefined) ?? null,
        })),
        question: reply.question,
        notice: false,
        readback,
        waiting: !!reply.pendingConfirmation,
        card: reply.pendingConfirmation ? "waiting" : null,
      },
    });
    // A yes or a no answers the card read back before it.
    const said = body.text.trim().toLowerCase();
    if (said === "yes" || said === "no")
      for (const t of turns.slice(0, -1)) if (t.reply?.card === "waiting") t.reply.card = said;
    // One card waits per conversation: an earlier one is no longer waiting.
    if (reply.pendingConfirmation)
      for (const t of turns.slice(0, -1)) if (t.reply) t.reply.waiting = false;
    state.conversations.set(key, turns);
    return reply;
  };
  const conversationOf = (key: string): ConversationView => {
    const turns = (state.conversations.get(key) ?? []).map((t) => ({
      ...t,
      reply: t.reply
        ? {
            ...t.reply,
            waiting:
              t.reply.waiting &&
              !!state.pendingConfirmation &&
              t.reply.readback === state.pendingConfirmation.readback,
            card:
              t.reply.card === "waiting" &&
              !(
                state.pendingConfirmation && t.reply.readback === state.pendingConfirmation.readback
              )
                ? "expired"
                : (t.reply.card ?? null),
            actions: t.reply.actions.map((a) => {
              const change = a.changeId ? state.changes.find((ch) => ch.id === a.changeId) : null;
              return { ...a, canUndo: change ? change.undoState === "undoable" : a.canUndo };
            }),
          }
        : null,
    }));
    const waiting = turns.find((t) => t.reply?.waiting);
    return {
      projectId: key || null,
      turns,
      waiting:
        waiting && state.pendingConfirmation
          ? {
              id: state.pendingConfirmation.id,
              readback: state.pendingConfirmation.readback,
              estimate: money(5_000_000),
              commands: ["session.start"],
              decision: "needs_yes",
            }
          : null,
    };
  };
  app.get("/projects/:id/conversation", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id))
      return errorBody(c, 404, "not_found", `project ${id} not found`);
    return c.json(conversationOf(id));
  });
  app.get("/conversation", (c) => c.json(conversationOf("")));

  app.post("/chat", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    return c.json(
      keepTurn(
        parsed.data,
        chatReply(parsed.data.text, parsed.data.projectId, parsed.data.projectTab),
      ),
    );
  });
  app.post("/chat/stream", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const reply = keepTurn(
      parsed.data,
      chatReply(parsed.data.text, parsed.data.projectId, parsed.data.projectTab),
    );
    return streamSSE(c, async (stream) => {
      const words = reply.reply.split(/(\s+)/).filter((w) => w.length > 0);
      for (const w of words) {
        await stream.writeSSE({ event: "token", data: JSON.stringify({ text: w }) });
        if (tokenDelayMs > 0) await stream.sleep(tokenDelayMs);
      }
      await stream.writeSSE({ event: "reply", data: JSON.stringify(reply) });
    });
  });

  // Voice (spec O): the daemon's /voice routes with fake providers. A press, audio chunks and
  // a release make one turn whose transcript is `nextVoiceLine` (or a fixed line) and whose
  // reply is the chat reply for it.
  const voiceProvider = {
    name: "fake",
    kind: "fake" as const,
    policy: "fake" as const,
    reason: "test",
  };
  const stage = (ms: number, targetMs: number) => ({ ms, targetMs, withinTarget: ms <= targetMs });
  const voiceTurn = (
    turn: number,
    said: string,
    projectId: string | undefined,
    chunks: number,
    replyMode: VoiceTurnView["replyMode"] = "voice",
  ): VoiceTurnView => {
    // An empty transcript gets no reply at all (nothing heard, nothing said back).
    const reply = said ? chatReply(said, projectId) : null;
    return {
      turn,
      source: "audio",
      replyMode,
      continued: false,
      carriedFrom: null,
      said,
      heard: reply?.reply ?? "",
      reply,
      approval: null,
      outcome: null,
      pending: null,
      latency: {
        turn,
        endOfTurnMs: 200,
        finalTranscriptMs: 150,
        modelFirstTokenMs: 400,
        firstAudioMs: 200,
        totalToFirstAudioMs: 950,
        stages: {
          endOfTurn: stage(200, 300),
          finalTranscript: stage(150, 300),
          modelFirstToken: stage(400, 600),
          firstAudio: stage(200, 300),
          total: stage(950, 1500),
        },
        withinTarget: true,
        firstSentenceMs: 450,
        ttsFirstByteMs: 120,
        interrupted: false,
        noResponse: false,
        targets: {
          endOfTurnMs: 300,
          finalTranscriptMs: 300,
          modelFirstTokenMs: 600,
          firstAudioMs: 300,
          totalToFirstAudioMs: 1500,
        },
      },
      audioChunks: chunks,
      audioStored: false,
      interrupted: false,
      unspokenText: null,
      error: null,
    };
  };
  const mustVoice = (c: Context) => state.voiceSessions.get(c.req.param("id") ?? "") ?? null;
  app.post("/voice/sessions", async (c) => {
    const parsed = StartVoiceSessionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (!state.voiceStatus.available)
      return c.json({ code: "voice.unavailable", message: state.voiceStatus.reason }, 503);
    const view: VoiceSessionView = {
      id: nextId("voice"),
      state: "idle",
      turn: 0,
      mode: parsed.data.mode ?? "push_to_talk",
      replyMode: parsed.data.replyMode ?? "voice",
      language: parsed.data.language ?? null,
      projectId: parsed.data.projectId ?? null,
      conversationSessionId: nextId("sess"),
      providers: { stt: voiceProvider, tts: voiceProvider },
      pending: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      turns: 0,
      lastTurn: null,
      recentTurns: [],
      lastSeq: 0,
    };
    state.voiceSessions.set(view.id, { view, pressed: false, chunks: 0 });
    return c.json(view, 201);
  });
  app.get("/voice/sessions/:id", (c) => {
    const v = mustVoice(c);
    return v ? c.json(v.view) : errorBody(c, 404, "not_found", "no such voice session");
  });
  app.post("/voice/sessions/:id/press", async (c) => {
    const v = mustVoice(c);
    if (!v) return errorBody(c, 404, "not_found", "no such voice session");
    const parsed = VoicePressBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.replyMode && !parsed.data.pressed)
      return errorBody(c, 409, "validation", "replyMode goes with a press");
    // As the daemon: only GET /voice/sessions/:id carries the recent turns.
    const lean = () => {
      const { recentTurns: _recent, ...rest } = v.view;
      return rest;
    };
    if (v.view.endedAt)
      return errorBody(c, 409, "validation", `voice session ${v.view.id} has ended`);
    if (parsed.data.pressed && state.voiceRefusePress) return c.json(lean());
    const end = (turn: VoiceTurnView) => {
      v.view = {
        ...v.view,
        turns: v.view.turns + 1,
        lastTurn: turn,
        recentTurns: [...(v.view.recentTurns ?? []), turn].slice(-8),
        lastSeq: v.view.lastSeq + 1,
      };
    };
    const said = () => {
      const line = state.nextVoiceLine ?? "what is next";
      state.nextVoiceLine = null;
      return line;
    };
    if (parsed.data.replyMode) v.view = { ...v.view, replyMode: parsed.data.replyMode };
    if (parsed.data.pressed) {
      // A press while a held turn is still replying is the barge-in: that turn ends, cut short.
      if (v.view.state === "thinking") {
        const cut = voiceTurn(
          v.view.turn,
          said(),
          v.view.projectId ?? undefined,
          0,
          v.view.replyMode,
        );
        end({
          ...cut,
          heard: "",
          interrupted: true,
          unspokenText: cut.reply?.reply ?? null,
          latency: { ...cut.latency, interrupted: true },
        });
      }
      v.pressed = true;
      v.chunks = 0;
      v.view = { ...v.view, state: "listening", turn: v.view.turn + 1 };
    } else if (v.pressed) {
      v.pressed = false;
      const turn = v.view.turn;
      if (state.voiceHold) {
        v.view = { ...v.view, state: "thinking" };
        return c.json(lean());
      }
      end(voiceTurn(turn, said(), v.view.projectId ?? undefined, v.chunks, v.view.replyMode));
      v.view = { ...v.view, state: "idle" };
    }
    return c.json(lean());
  });
  app.post("/voice/sessions/:id/audio", async (c) => {
    const v = mustVoice(c);
    if (!v) return errorBody(c, 404, "not_found", "no such voice session");
    const parsed = VoiceAudioBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (v.pressed) v.chunks += 1;
    // A lean acknowledgement, as the daemon answers a chunk.
    return c.json({
      id: v.view.id,
      state: v.view.state,
      turn: v.view.turn,
      lastSeq: v.view.lastSeq,
    });
  });
  // What the player heard (once per turn, as the daemon takes it; `state.calls` has the posts).
  app.post("/voice/sessions/:id/heard", async (c) => {
    const v = mustVoice(c);
    if (!v) return errorBody(c, 404, "not_found", "no such voice session");
    const parsed = VoiceHeardBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return errorBody(c, 409, "conflict", parsed.error.message);
    return c.json({
      turn: parsed.data.turn,
      heardFirstAudioMs: Math.round(parsed.data.heardFirstAudioMs),
      recordedOn: "voice.turn",
    });
  });
  app.post("/voice/sessions/:id/stop", (c) => {
    const v = mustVoice(c);
    if (!v) return errorBody(c, 404, "not_found", "no such voice session");
    v.pressed = false;
    v.view = { ...v.view, state: "idle", endedAt: v.view.endedAt ?? new Date().toISOString() };
    return c.json(v.view);
  });

  // Audit log export (spec S.9): the daemon streams a file; the fake serves the fixture rows
  // through the daemon's own serialisers, honouring the filters and the format.
  app.get("/audit/export", (c) => {
    const format = c.req.query("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "csv")
      return errorBody(c, 400, "validation", "format: must be jsonl or csv");
    const agentId = c.req.query("agentId");
    const sessionId = c.req.query("sessionId");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const rows = AUDIT_EXPORT.filter(
      (r) =>
        (!agentId || r.agentId === agentId) &&
        (!sessionId || r.sessionId === sessionId) &&
        (!from || r.occurredAt >= from) &&
        (!to || r.occurredAt < to),
    );
    const body =
      format === "csv" ? csvHeader() + rows.map(csvLine).join("") : rows.map(jsonlLine).join("");
    return c.body(body, 200, {
      "content-type": auditExportContentType(format),
      "content-disposition": `attachment; filename="${auditExportFilename(format, "2026-10-19T19:31:00.000Z")}"`,
      "cache-control": "no-store",
    });
  });
  app.get("/costs", (c) => {
    const projectId = c.req.query("projectId");
    if (projectId) {
      const found = COSTS[projectId];
      return found ? c.json(found) : c.json(COSTS.proj_beacon);
    }
    return c.json(COSTS.proj_atlas);
  });
  // Spec D.4 (ADR 0072): temperature only for a provider that accepts one.
  app.get("/settings/models", (c) => {
    const view = clone(state.modelSettings);
    view.provider.acceptsTemperature = state.acceptsTemperature;
    if (!state.acceptsTemperature) {
      for (const a of view.agents) for (const m of a.modes) delete m.temperature;
      for (const sp of view.specialists) delete sp.settings.temperature;
    }
    // U-078 (the credential chooser), as the daemon: where each specialist's task runs here
    // (for `?project=`) and why, and Settings' "What each can do here".
    const projectId = c.req.query("project") || null;
    for (const sp of view.specialists) sp.runsOn = runsOnFor(sp.name, projectId, null);
    view.credentials = abilityTable(chooserFactsNow(), savedKinds());
    return c.json(view);
  });
  app.get("/settings", (c) => {
    const scope = c.req.query("scope");
    const scopeId = c.req.query("scopeId");
    // Like the daemon, every project has its rows (settings-view.ts), read from the live project
    // (a command may have changed it); the fixtures name Atlas's.
    const projectRows = state.projects
      .filter((p) => !SETTINGS.some((s) => s.key === "project.autonomy" && s.scopeId === p.id))
      .map((p): (typeof SETTINGS)[number] => ({
        key: "project.autonomy",
        label: "Autonomy",
        scope: "project",
        scopeId: p.id,
        value: p.autonomyLevel,
        description: `Autonomy for ${p.name}`,
        risk: "medium",
      }));
    const rows = [...SETTINGS, ...projectRows].map((s) => {
      if (s.key === "project.autonomy") {
        const p = state.projects.find((x) => x.id === s.scopeId);
        return p ? { ...s, value: p.autonomyLevel } : s;
      }
      if (s.key === "project.speed_quality_offset" && s.scopeId) {
        return { ...s, value: state.speedQuality[s.scopeId] ?? 0 };
      }
      if (s.key === "human.default_autonomy") return { ...s, value: me.defaultAutonomy };
      const leaf = s.key.split(".").pop() ?? s.key;
      const slot = settingSlot(leaf, s.scope === "project" ? s.scopeId : null);
      return slot in state.settingValues ? { ...s, value: state.settingValues[slot] } : s;
    });
    // Like the daemon (settings-view.ts, C-57): a Status pull request row for each project on a
    // host repository (not a folder on this computer), off unless the person turned it on.
    for (const p of state.projects) {
      const first = p.repos?.[0]?.trim() ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(first)) continue;
      // merge-in-app: who merges accepted work, as the daemon's row says it.
      rows.push({
        key: "project.merge_mode",
        label: "Who merges accepted work",
        scope: "project",
        scopeId: p.id,
        value: mergeModeOfFake(p.id),
        description: `You press Merge (each accepted task's pull request waits for your Merge on ${p.name}'s Overview), or merge automatically after review (Forerunner merges it once the critic accepted it)`,
        risk: "medium",
      });
      rows.push({
        key: "project.status_pull_request",
        label: "Status pull request",
        scope: "project",
        scopeId: p.id,
        value: state.settingValues[settingSlot("status_pull_request", p.id)] === true,
        description: `Each session's status of ${p.name} as one pull request on GitHub (off: it stays in the app, under Docs, Status)`,
        risk: "low",
      });
    }
    // Like the daemon (settings-view.ts, 'sites'): "Web pages research may read" per project.
    for (const p of state.projects)
      rows.push({
        key: "project.web_access",
        label: "Web pages research may read",
        scope: "project",
        scopeId: p.id,
        value: webAccessFake(p.id) as never,
        description: `Any public website (the default, with an optional list of websites it never reads) or only the websites you list, for ${p.name}'s research on both credentials; each website covers its subdomains, and this computer and your home or office network are never read. The agent browser's own site list is separate and changes nothing here`,
        risk: "medium",
      });
    // Like the daemon: one fast-mode row per project, the effect and surcharge both ways.
    for (const [projectId, on] of Object.entries(state.fastMode)) {
      rows.push({
        key: "project.fast_mode",
        scope: "project",
        scopeId: projectId,
        value: on === true,
        description: fastModeDescription(),
        risk: "medium",
      });
    }
    return c.json(
      rows.filter((s) => (!scope || s.scope === scope) && (!scopeId || s.scopeId === scopeId)),
    );
  });

  // ---------------------------------------------------------------------------------------
  // Phase 3 to 7 routes: extensions, updates, model watch, estimates, project settings and
  // the mirror, plus the proposed routes of ADR 0032 (reviews, memory, commands and the change
  // log, the queue, milestones, data assets, docs, performance).
  // ---------------------------------------------------------------------------------------

  const emitExtension = (type: string, e: ExtensionView) =>
    emit("extension.changed", { type, id: e.id, name: e.name });
  const findExtension = (c: Context) => state.extensions.find((e) => e.id === c.req.param("id"));
  // As the daemon's registry (U-075): a row another screen owns is not switched, removed or
  // re-permissioned here.
  const managedRefusal = (c: Context, e: ExtensionView) =>
    errorBody(
      c,
      400,
      "validation",
      `${e.name} is set on the Email page, not in Extensions: open Settings → Capabilities → Email`,
    );
  const normalizePermissions = (p: Partial<ExtensionPermissions> | undefined) => ({
    tools: [...(p?.tools ?? [])],
    actionClasses: [...(p?.actionClasses ?? [])],
    domains: [...(p?.domains ?? [])],
    paths: [...(p?.paths ?? [])],
    secrets: [...(p?.secrets ?? [])],
    scopes: [...(p?.scopes ?? [])],
  });
  const widens = (current: ExtensionPermissions, next: ExtensionPermissions) =>
    (Object.keys(next) as Array<keyof ExtensionPermissions>).some((k) =>
      next[k].some((v) => !current[k].includes(v)),
    );

  app.get("/extensions", (c) => {
    const kind = c.req.query("kind");
    return c.json(state.extensions.filter((e) => !kind || e.kind === kind));
  });
  app.get("/extensions/catalog", (c) => c.json(CATALOG));
  // Voice providers (spec O.4): what the panel's voice rows put in force; tests mutate it. The
  // session count is the live one of the /voice/sessions routes above (spec O).
  app.get("/voice/status", (c) =>
    c.json({
      ...state.voiceStatus,
      sessions: [...state.voiceSessions.values()].filter((v) => !v.view.endedAt).length,
    }),
  );
  // Settings → Voice (ADR 0090): the profile and a scripted install job. The job runs to its end
  // at once; the events route replays it (JSON, or SSE that ends with the job).
  let voiceInstallDone: VoiceInstallView | null = null;
  let voiceInstallStreams = 0;

  // Settings → Sandbox (Docker) (U-079): the state, Check again, and a download that runs to
  // its end once its events are read (JSON, or SSE that ends with the download).
  let sandboxCheckUsed = false;
  let sandboxDone: SandboxStatusView | null = null;
  const sandboxOpts = () => ({
    platform: state.sandbox.platform,
    pullable: state.sandbox.pullable,
    waiting: state.sandbox.waiting,
  });
  app.get("/sandbox", (c) => c.json(state.sandbox));
  app.post("/sandbox/check", (c) => {
    if (options.sandboxAfterCheck && !sandboxCheckUsed) {
      sandboxCheckUsed = true;
      state.sandbox = fakeSandboxView(options.sandboxAfterCheck, sandboxOpts());
    } else state.sandbox = { ...state.sandbox, checkedAt: new Date().toISOString() };
    return c.json(state.sandbox);
  });
  app.post("/sandbox/pull", (c) => {
    if (state.sandbox.pull?.state === "running") return c.json(state.sandbox, 202);
    if (state.sandbox.state !== "image_missing" || !state.sandbox.pullable)
      return errorBody(
        c,
        409,
        "conflict",
        `the sandbox cannot be downloaded yet: ${state.sandbox.headline}`,
      );
    const image = state.sandbox.image;
    const events = [
      { type: "step" as const, message: `downloading ${image}` },
      { type: "layers" as const, done: 1, total: 3 },
      { type: "layers" as const, done: 3, total: 3 },
      { type: "result" as const, ok: true, image, message: `the sandbox ${image} is downloaded` },
    ];
    state.sandboxEntries = events.map((event, i) => ({ seq: i + 1, event }));
    const at = new Date().toISOString();
    const job = {
      id: nextId("pull"),
      image,
      startedAt: at,
      layersTotal: 3,
    };
    sandboxDone = {
      ...fakeSandboxView("ready", sandboxOpts()),
      pull: {
        ...job,
        state: "done",
        finishedAt: at,
        layersDone: 3,
        recent: state.sandboxEntries,
      },
    };
    state.sandbox = {
      ...fakeSandboxView("pulling", sandboxOpts()),
      pull: { ...job, state: "running", finishedAt: null, layersDone: 0, recent: [] },
    };
    return c.json(state.sandbox, 202);
  });
  app.get("/sandbox/pull/events", (c) => {
    const after = Number(c.req.query("afterSeq") ?? 0);
    const entries = state.sandboxEntries.filter((e) => e.seq > after);
    if (sandboxDone) {
      state.sandbox = sandboxDone;
      sandboxDone = null;
    }
    if (!(c.req.header("accept") ?? "").includes("text/event-stream")) return c.json(entries);
    return streamSSE(c, async (stream) => {
      for (const e of entries)
        await stream.writeSSE({
          event: "sandbox.pull",
          data: JSON.stringify(e),
          id: String(e.seq),
        });
    });
  });

  app.get("/voice/install", (c) => c.json(state.voiceInstall));
  app.post("/voice/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { profile?: string };
    const profile = body.profile;
    if (profile !== "none" && profile !== "cpu" && profile !== "gpu")
      return errorBody(c, 400, "validation", "profile must be one of none, cpu, gpu");
    if ([...state.voiceSessions.values()].some((v) => !v.view.endedAt))
      return errorBody(
        c,
        409,
        "conflict",
        "a voice session is open: stop it before switching the voice profile",
      );
    const fails = profile === "gpu" ? options.voiceInstallGpuFails : undefined;
    const ending: VoiceInstallEvent[] = fails
      ? [
          {
            type: "warning",
            message: `GPU check failed for speech recognition: ${fails}. Speech recognition runs on the CPU (int8) until this is fixed.`,
          },
          {
            type: "result",
            ok: true,
            profile,
            exitCode: 2,
            message: `voice profile ${profile} installed, but the GPU check failed`,
          },
        ]
      : [
          {
            type: "result",
            ok: true,
            profile,
            exitCode: 0,
            message: `voice profile ${profile} installed`,
          },
        ];
    const events: VoiceInstallEvent[] =
      profile === "none"
        ? [
            { type: "step", step: "remove", message: "turning local voice off" },
            {
              type: "result",
              ok: true,
              profile,
              exitCode: 0,
              message: "local voice is off and its packages and models are removed",
            },
          ]
        : [
            { type: "step", step: "venv", message: "managed Python environment" },
            { type: "step", step: "packages", message: `installing the ${profile} packages` },
            {
              type: "progress",
              what: "torch-2.11.0.whl",
              bytes: 1_376_500_000,
              total: 2_753_000_000,
            },
            {
              type: "progress",
              what: "torch-2.11.0.whl",
              bytes: 2_753_000_000,
              total: 2_753_000_000,
            },
            { type: "step", step: "verify", message: "checking speech recognition and speech" },
            ...ending,
          ];
    const at = new Date().toISOString();
    const voiceInstallBefore = { ...state.voiceInstall };
    state.voiceInstallEntries = events.map((event, i) => ({ seq: i + 1, event }));
    const device = profile === "gpu" ? "cuda" : "cpu";
    state.voiceInstall = {
      ...state.voiceInstall,
      profile,
      verifiedAt: profile === "none" ? null : at,
      stt:
        profile === "none"
          ? null
          : fails
            ? { device: "cpu", computeType: "int8", fallback: fails }
            : { device, computeType: profile === "gpu" ? "float16" : "int8", fallback: null },
      tts: profile === "none" ? null : { device, computeType: null, fallback: null },
      job: {
        id: `vi-${state.voiceInstallEntries.length}`,
        profile,
        state: "done",
        startedAt: at,
        finishedAt: at,
        exitCode: fails ? 2 : 0,
        recent: state.voiceInstallEntries,
      },
    };
    if (options.voiceInstallHold && state.voiceInstall.job) {
      state.voiceInstallEntries = state.voiceInstallEntries.slice(0, 3);
      const running = {
        ...state.voiceInstall.job,
        state: "running" as const,
        finishedAt: null,
        exitCode: null,
        recent: [],
      };
      state.voiceInstall = { ...voiceInstallBefore, job: running };
      return c.json(state.voiceInstall, 202);
    }
    if (options.voiceInstallDropOnce && state.voiceInstall.job) {
      // Running until the second stream has delivered the rest.
      voiceInstallDone = { ...state.voiceInstall };
      const running = {
        ...state.voiceInstall.job,
        state: "running" as const,
        finishedAt: null,
        exitCode: null,
        recent: [],
      };
      state.voiceInstall = { ...voiceInstallBefore, job: running };
      voiceInstallStreams = 0;
    }
    return c.json(state.voiceInstall, 202);
  });
  app.post("/voice/install/cancel", (c) => {
    const job = state.voiceInstall.job;
    if (job?.state !== "running")
      return errorBody(c, 409, "conflict", "no voice install is running");
    const seq = state.voiceInstallEntries.length;
    const ending: VoiceInstallEvent[] = [
      { type: "error", message: "cancelled; what was downloaded is kept" },
      {
        type: "result",
        ok: false,
        profile: job.profile,
        exitCode: 1,
        message: `voice profile ${job.profile} not installed: cancelled`,
      },
    ];
    state.voiceInstallEntries = [
      ...state.voiceInstallEntries,
      ...ending.map((event, i) => ({ seq: seq + i + 1, event })),
    ];
    state.voiceInstall = {
      ...state.voiceInstall,
      job: { ...job, state: "failed", exitCode: 1, finishedAt: new Date().toISOString() },
    };
    return c.json(state.voiceInstall, 202);
  });
  let voiceInstallFailed = false;
  app.get("/voice/install/events", (c) => {
    if (options.voiceInstallStreamFailsOnce && !voiceInstallFailed) {
      voiceInstallFailed = true;
      return c.json({ code: "internal", message: "stream broke" }, 500);
    }
    const after = Number(c.req.query("afterSeq") ?? 0);
    if ((c.req.header("accept") ?? "").includes("text/event-stream"))
      state.voiceInstallStreamsAfter.push(after);
    let entries = state.voiceInstallEntries.filter((e) => e.seq > after);
    if (voiceInstallDone) {
      voiceInstallStreams++;
      if (voiceInstallStreams === 1) entries = entries.slice(0, 3);
      else {
        state.voiceInstall = voiceInstallDone;
        voiceInstallDone = null;
      }
    }
    if (!(c.req.header("accept") ?? "").includes("text/event-stream")) return c.json(entries);
    return streamSSE(c, async (stream) => {
      for (const e of entries)
        await stream.writeSSE({
          event: "voice.install",
          data: JSON.stringify(e),
          id: String(e.seq),
        });
    });
  });
  app.get("/extensions/:id", (c) => {
    const e = findExtension(c);
    return e ? c.json(e) : errorBody(c, 404, "not_found", "no such extension");
  });
  app.post("/extensions", async (c) => {
    const body = (await c.req.json()) as { catalogId?: string; url?: string; confirmIn?: string };
    const now = new Date().toISOString();
    let view: ExtensionView;
    if (body.catalogId) {
      const entry = CATALOG.entries.find((e) => e.id === body.catalogId);
      if (!entry) return errorBody(c, 404, "not_found", `no catalog entry ${body.catalogId}`);
      // As the daemon's registry: every install waits for a decision, a built-in entry added
      // in the panel there (U-026: no Inbox card), anything else in the Inbox.
      view = {
        id: nextId("ext"),
        name: entry.name,
        kind: entry.kind,
        status: "pending_approval",
        enabled: false,
        description: entry.description,
        permissions: normalizePermissions(entry.permissions),
        pendingPermissions: null,
        pendingStage: "grant",
        confirmIn: body.confirmIn === "panel" ? "panel" : "inbox",
        managedIn: null,
        review: {
          tools:
            entry.kind === "connector"
              ? [
                  {
                    name: "list_issues",
                    bridgedName: `${entry.id}.list_issues`,
                    description: "List issues",
                    actionClass: "read",
                    risk: "low",
                    pathFields: [],
                    domainFields: [],
                    inferredFrom: "name pattern",
                  },
                ]
              : [],
          resources: [],
          permissions: normalizePermissions(entry.permissions),
          risk: entry.permissions.secrets.length > 0 ? "high" : "medium",
          summary: [
            `reaches ${entry.permissions.domains.join(", ") || "no domain"}`,
            ...entry.permissions.secrets.map((s) => `needs secret:${s}`),
          ],
        },
        cost: money(0),
        version: entry.version,
        source: `catalog:${entry.id}`,
        installedAt: now,
        updatedAt: now,
        rowVersion: 1,
        error: null,
        connected: false,
      };
    } else if (body.url) {
      let host = body.url;
      try {
        host = new URL(body.url).host;
      } catch {
        return errorBody(c, 400, "validation", "url must be an http(s) URL");
      }
      view = {
        id: nextId("ext"),
        name: host,
        kind: "connector",
        status: "pending_approval",
        enabled: false,
        description: `MCP server at ${body.url}`,
        permissions: normalizePermissions(undefined),
        pendingPermissions: normalizePermissions({ domains: [host], actionClasses: ["read"] }),
        // A URL install is discovered first (the human allows the connector to start), then granted.
        pendingStage: "discovery",
        confirmIn: "inbox",
        managedIn: null,
        review: {
          tools: [],
          resources: [],
          permissions: normalizePermissions({ domains: [host], actionClasses: ["read"] }),
          risk: "medium",
          summary: [`reaches ${host}`, "tools reviewed on first connection"],
        },
        cost: money(0),
        version: "",
        source: body.url,
        installedAt: now,
        updatedAt: now,
        rowVersion: 1,
        error: null,
        connected: false,
      };
    } else {
      return errorBody(c, 400, "validation", "body needs catalogId or url");
    }
    state.extensions.push(view);
    emitExtension("extension.requested", view);
    if (view.status === "pending_approval" && view.confirmIn === "inbox") {
      // The registry files a capability grant request in the inbox (spec L.5); answering it
      // approves or denies the extension.
      state.requests.unshift({
        id: `req_${view.id}`,
        projectId: null,
        projectName: null,
        taskId: null,
        // As `GET /inbox` names it (U-073): about no task.
        taskTitle: null,
        sessionId: null,
        kind: "capability_grant",
        why: `Allow ${view.name}: ${view.review?.summary.join("; ") ?? ""}`,
        steps: ["Review the permissions", "Approve or deny"],
        options: ["Approve", "Deny"],
        blocking: false,
        risk: view.review?.risk ?? "medium",
        changeCard: null,
        status: "open",
        answer: null,
        createdAt: now,
        version: 1,
      });
      emit("inbox.changed", { blockingCount: blockingCount() });
    }
    return c.json(view, view.status === "pending_approval" ? 202 : 201);
  });
  app.post("/extensions/:id/toggle", async (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    const body = (await c.req.json()) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return errorBody(c, 400, "validation", "enabled");
    if (e.managedIn) return managedRefusal(c, e);
    if (e.status === "pending_approval") {
      return c.json(
        { code: "approval_required", message: "approve the extension before enabling it" },
        403,
      );
    }
    e.enabled = body.enabled;
    e.status = body.enabled ? "enabled" : "disabled";
    e.connected = body.enabled && e.kind === "connector";
    e.rowVersion += 1;
    e.updatedAt = new Date().toISOString();
    emitExtension(body.enabled ? "extension.enabled" : "extension.disabled", e);
    return c.json(e);
  });
  const approveExtension = (e: ExtensionView) => {
    e.status = "enabled";
    e.enabled = true;
    e.connected = e.kind === "connector";
    if (e.pendingPermissions) e.permissions = e.pendingPermissions;
    e.pendingPermissions = null;
    e.pendingStage = null;
    e.confirmIn = null;
    e.rowVersion += 1;
    e.updatedAt = new Date().toISOString();
    emitExtension("extension.approved", e);
    withdrawExtensionRequest(e);
  };
  // As the daemon's registry: a decision in the panel (or a removal) takes the extension's
  // open card out of the inbox (U-021, U-030); a card answered in the inbox stays answered.
  const withdrawExtensionRequest = (e: ExtensionView) => {
    const req = state.requests.find((r) => r.id === `req_${e.id}` && r.status === "open");
    if (!req) return;
    req.status = "withdrawn";
    req.version += 1;
    emit("inbox.changed", { blockingCount: blockingCount() });
  };
  app.post("/extensions/:id/approve", async (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    let body: { answer?: string; deviceId?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    if (body.answer === "device") {
      // As the daemon (ADR 0096): this PC's own row when no id is named, the only device this
      // fake has; any other id is refused by the confirmation policy and the row still waits.
      const deviceId =
        !body.deviceId || body.deviceId === "desktop" ? me.desktopDeviceId : body.deviceId;
      if (!deviceId)
        return errorBody(
          c,
          403,
          "approval_required",
          "this PC has no paired device row to confirm with; restart Forerunner, then confirm again",
        );
      if (deviceId !== ME.desktopDeviceId)
        return errorBody(c, 403, "approval_required", "unknown device; pair it first");
    } else if (e.confirmIn === "panel") {
      return errorBody(
        c,
        403,
        "approval_required",
        `${e.name} is granted in the Extensions panel with Confirm on this device (high risk: a paired device confirms it)`,
      );
    }
    approveExtension(e);
    return c.json(e);
  });
  app.post("/extensions/:id/deny", (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    state.extensions = state.extensions.filter((x) => x.id !== e.id);
    emitExtension("extension.denied", e);
    withdrawExtensionRequest(e);
    return c.json({ ok: true });
  });
  app.put("/extensions/:id/permissions", async (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    const body = (await c.req.json()) as { permissions?: Partial<ExtensionPermissions> };
    if (e.managedIn) return managedRefusal(c, e);
    const next = normalizePermissions({ ...e.permissions, ...(body.permissions ?? {}) });
    e.rowVersion += 1;
    e.updatedAt = new Date().toISOString();
    if (widens(e.permissions, next)) {
      e.pendingPermissions = next;
      e.pendingStage = "grant";
      e.confirmIn = "inbox";
      e.status = "pending_approval";
      e.enabled = false;
      emitExtension("extension.requested", e);
      return c.json(e, 202);
    }
    e.permissions = next;
    emitExtension("extension.permissions_updated", e);
    return c.json(e);
  });
  app.delete("/extensions/:id", (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    if (e.managedIn) return managedRefusal(c, e);
    state.extensions = state.extensions.filter((x) => x.id !== e.id);
    emitExtension("extension.removed", e);
    withdrawExtensionRequest(e);
    return c.json({ ok: true });
  });

  const updatesView = (feed: boolean) => {
    const base = clone(feed ? UPDATES_FEED : UPDATES_STATUS);
    if (state.version !== HEALTH.version) {
      base.app.currentVersion = state.version;
      base.app.runningVersion = state.version;
      base.app.previousVersion = HEALTH.version;
      base.app.available = null;
      base.app.state = feed ? "up_to_date" : "unknown";
    }
    if (base.app.available && options.updateArtifact) {
      base.app.available.artifactName = options.updateArtifact.name;
      base.app.available.artifactUrl = options.updateArtifact.url;
    }
    return base;
  };
  // Like the daemon: opening reads local state; POST /updates/check asks the "feed" and the
  // screen keeps that result afterwards.
  app.get("/updates", (c) => c.json(updatesView(updatesChecked.value)));
  app.get("/updates/status", (c) => c.json(updatesView(updatesChecked.value)));
  app.post("/updates/check", (c) => {
    if (options.updatesCheckError) {
      const v = updatesView(updatesChecked.value);
      v.app.lastError = options.updatesCheckError;
      v.app.state = "unknown";
      return c.json(v);
    }
    updatesChecked.value = true;
    return c.json(updatesView(true));
  });
  app.post("/updates/apply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { version?: string };
    const target = body.version ?? UPDATES_FEED.app.available?.version ?? state.version;
    const from = state.version;
    // Like the daemon (U-070, `installerRefusal`): an installer is never applied as an update.
    const artifact = options.updateArtifact?.name;
    if (
      target === UPDATES_FEED.app.available?.version &&
      artifact &&
      /\.(msi|exe|appimage|deb|rpm)$/i.test(artifact)
    )
      return c.json(
        {
          code: "not_supported",
          message: `Release ${target} is an installer (${artifact}), which the background service cannot apply as an update. Download the installer from the Updates screen and run it: it installs over this version and keeps your settings and data.`,
          details: { reason: "installer_artifact", version: target, artifact },
        },
        400,
      );
    emit("restart.requested", {
      reason: "update",
      targetVersion: target,
      fromVersion: from,
      exitCode: 86,
    });
    // The fake "restarts" at once: the next /health answers with the new version.
    state.version = target;
    return c.json({ version: target, previous: from, state: "staged", restarting: true }, 202);
  });
  app.post("/updates/rollback", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const from = state.version;
    const to =
      state.version === HEALTH.version ? UPDATES_STATUS.app.previousVersion : HEALTH.version;
    emit("restart.requested", {
      reason: `rollback: ${body.reason ?? ""}`,
      targetVersion: to ?? from,
      fromVersion: from,
      exitCode: 86,
    });
    if (to) state.version = to;
    return c.json({ from, to, state: "rolled_back", restarting: true }, 202);
  });

  const reportDetail = (r: ModelWatchReportSummary) => ({
    id: r.id,
    generated_at: r.generated_at,
    summary: r.summary,
    recommendations:
      r.recommendations > 0
        ? [
            {
              id: "rec_1",
              kind: "switch_model",
              text: "Use haiku-5.6 for routing and quick chat.",
            },
            { id: "rec_2", kind: "reprice", text: "sonnet-5.5 input price -5%." },
          ].slice(0, r.recommendations)
        : [],
    skipped: [],
    // The daemon's report carries the most its evals may spend (`eval_budget_usd_micro`).
    eval_budget_usd_micro: 2_500_000,
    // A pending report withheld its paid evals (ADR 0089), as the daemon's default run does.
    evals_deferred:
      r.decision === "pending"
        ? {
            reason: "paid evals need the human's consent",
            planned: [{ specialist: "coder", model: "sonnet-5.5", effort: "medium" }],
          }
        : null,
  });
  const reportHealth = (r: ModelWatchReportSummary) => ({
    decision: r.decision,
    request_id: r.request_id,
    decided_at: r.decided_at,
    by: r.decided_at ? "human_alice" : null,
    applied: [],
    remind_at: null,
  });
  app.get("/model-watch/reports", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    return c.json({ reports: state.modelWatchReports.slice(0, limit > 0 ? limit : 20) });
  });
  app.get("/model-watch/reports/latest", (c) => {
    const r = state.modelWatchReports[0];
    return c.json(
      r ? { report: reportDetail(r), health: reportHealth(r) } : { report: null, health: null },
    );
  });
  app.get("/model-watch/reports/:id", (c) => {
    const r = state.modelWatchReports.find((x) => x.id === c.req.param("id"));
    if (!r) return errorBody(c, 404, "not_found", "no such report");
    return c.json({ report: reportDetail(r), health: reportHealth(r) });
  });
  app.post("/model-watch/run", (c) => {
    const r: ModelWatchReportSummary = {
      id: nextId("mw"),
      generated_at: new Date().toISOString(),
      status: "proposed",
      decision: "nothing_to_decide",
      request_id: null,
      decided_at: null,
      recommendations: 0,
      new_models: 0,
      retired_models: 0,
      repriced: 0,
      summary: "Nothing changed since the last run.",
    };
    state.modelWatchReports.unshift(r);
    return c.json({ report: reportDetail(r), decision: r.decision, requestId: null, applied: [] });
  });
  app.post("/model-watch/reports/:id/answer", async (c) => {
    const r = state.modelWatchReports.find((x) => x.id === c.req.param("id"));
    if (!r) return errorBody(c, 404, "not_found", "no such report");
    const body = (await c.req.json()) as { decision?: string; adopt?: string[]; by?: string };
    if (!body.by || !["adopt", "evaluate", "ignore", "remind"].includes(body.decision ?? "")) {
      return errorBody(c, 400, "validation", "answer body is malformed");
    }
    r.decision =
      body.decision === "adopt"
        ? "adopted"
        : body.decision === "ignore"
          ? "ignored"
          : body.decision === "evaluate"
            ? "evaluate"
            : "remind";
    r.decided_at = new Date().toISOString();
    r.status = "resolved";
    // As the daemon: the report's open Inbox card is the same question and is withdrawn (U-035).
    const card = state.requests.find((q) => q.id === r.request_id && q.status === "open");
    if (card) {
      card.status = "withdrawn";
      card.version += 1;
      emit("inbox.changed", { blockingCount: blockingCount() });
    }
    return c.json({
      decision: r.decision,
      applied: body.decision === "adopt" ? ["routing: haiku-5.6"] : [],
      status: r.status,
    });
  });
  app.post("/model-watch/sync", (c) => c.json({ resolved: 0 }));

  app.get("/costs/estimates", (c) => c.json(ESTIMATES));

  app.put("/projects/:id/settings", async (c) => {
    const p = state.projects.find((x) => x.id === c.req.param("id"));
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    const body = (await c.req.json()) as { version?: number; settings?: Record<string, unknown> };
    if (typeof body.version !== "number") return errorBody(c, 400, "validation", "version");
    // 'sites', as the daemon: the rule goes through settings.set (a yes before it widens), and
    // blocks written here as browser.blockedDomains are taken into its never list.
    if (body.settings && Object.hasOwn(body.settings, "web_access"))
      return errorBody(
        c,
        403,
        "approval_required",
        "Web pages research may read is changed in Settings (or with settings.set), which asks a yes before a change lets research read more.",
      );
    const settings: Record<string, unknown> = { ...(body.settings ?? {}) };
    const moved = legacyBlocks(settings);
    if (moved.length) {
      const now = webAccessFake(p.id);
      state.settingValues[`web_access:${p.id}`] = {
        ...now,
        never: [...now.never, ...moved.filter((m) => !now.never.includes(m))],
      };
      const browser = { ...(settings.browser as Record<string, unknown>) };
      delete browser.blockedDomains;
      if (Object.keys(browser).length) settings.browser = browser;
      else delete settings.browser;
      settings.web_access = state.settingValues[`web_access:${p.id}`];
    }
    return c.json({
      id: p.id,
      version: body.version + 1,
      settings,
      mirrorScheduled: Boolean(
        (body.settings?.mirror as { enabled?: boolean } | undefined)?.enabled,
      ),
    });
  });
  app.post("/projects/:id/mirror/sync", (c) => {
    const p = state.projects.find((x) => x.id === c.req.param("id"));
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    return c.json({
      projectId: p.id,
      githubProjectId: "PVT_1",
      githubProjectUrl: "https://example.test/orgs/org/projects/1",
      scanned: 3,
      changed: 1,
      created: 0,
      updated: 1,
      archived: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      stopped: null,
      sessionId: null,
      eventId: null,
      durationMs: 120,
    });
  });

  // Reviews (spec H, K.2): the daemon's ReviewsView for a project or one task.
  const reviewsViewFor = (
    rows: ReviewView[],
    filter: { projectId?: string; taskId?: string },
  ): ReviewsView => {
    const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // As the daemon counts (design §3.5): the tasks' reviews only; each open finding once per
    // task and finding; none for a done or cancelled task.
    const verdicts: Record<string, number> = {};
    const open = new Set<string>();
    for (const r of sorted) {
      if (!r.taskId) continue;
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      if (r.taskStatus === "done" || r.taskStatus === "cancelled") continue;
      for (const f of r.findings)
        if (f.status === "open") open.add(`${r.taskId}:${f.fingerprint || f.description}`);
    }
    const openFindings = open.size;
    const trend = sorted
      .filter((r) => r.taskId !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((r) => ({
        at: r.createdAt,
        grade: r.grade,
        reviewId: r.id,
        taskId: r.taskId,
        verdict: r.verdict,
      }));
    return {
      projectId: filter.projectId ?? null,
      taskId: filter.taskId ?? null,
      reviews: sorted,
      openFindings,
      gradeTrend: trend,
      averageGrade: trend.length
        ? Math.round((trend.reduce((a, p) => a + p.grade, 0) / trend.length) * 10) / 10
        : null,
      verdicts,
    };
  };
  app.get("/projects/:id/reviews", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const limit = Math.min(1000, Number(c.req.query("limit") ?? 200));
    const rows = state.reviews.filter((r) => REVIEW_PROJECTS[r.id] === id);
    return c.json(reviewsViewFor(rows.slice(0, limit > 0 ? limit : 200), { projectId: id }));
  });
  app.get("/tasks/:id/reviews", (c) => {
    const id = c.req.param("id");
    if (!state.tasks.some((t) => t.id === id))
      return errorBody(c, 404, "not_found", "no such task");
    return c.json(
      reviewsViewFor(
        state.reviews.filter((r) => r.taskId === id),
        { taskId: id },
      ),
    );
  });

  // Memory (spec G, K.5): one view per scope; a peer's private memory is listed, never readable.
  const countLessons = (scope: LessonView["scope"], owner?: string) => {
    const rows = state.lessons.filter(
      (l) => l.scope === scope && (!owner || l.ownerAgentId === owner),
    );
    return { active: rows.length, pinned: rows.filter((l) => l.pinned).length };
  };
  app.get("/memory/scopes", (c) => {
    const out: MemoryScopeView[] = AGENTS.filter(
      (a) => a.kind === "principal" && a.ownerHumanId === ME.id,
    ).map((a) => ({
      scope: "agent_private" as const,
      ownerAgentId: a.id,
      label: a.name,
      ...countLessons("agent_private", a.id),
    }));
    out.push(
      { scope: "critic", ownerAgentId: null, label: "Critic", ...countLessons("critic") },
      { scope: "shared", ownerAgentId: null, label: "Shared", ...countLessons("shared") },
    );
    return c.json(out);
  });
  app.get("/memory", (c) => {
    const scope = c.req.query("scope") ?? "shared";
    if (scope !== "agent_private" && scope !== "critic" && scope !== "shared") {
      return errorBody(c, 400, "validation", `unknown memory scope ${scope}`);
    }
    const owner = c.req.query("agentId") || undefined;
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const tag = c.req.query("tag") || undefined;
    const status = c.req.query("status") || "active";
    const projectId = c.req.query("projectId") || undefined;
    if (scope === "agent_private") {
      if (!owner) return errorBody(c, 400, "validation", "agentId is required for agent_private");
      const mine = AGENTS.find((a) => a.id === owner && a.ownerHumanId === ME.id);
      if (!mine) {
        return c.json(
          {
            code: "autonomy_insufficient",
            message: `private memory of ${owner} is not readable by this install`,
          },
          403,
        );
      }
    }
    const rows = state.lessons.filter(
      (l) =>
        l.scope === scope &&
        (!owner || l.ownerAgentId === owner) &&
        l.status === status &&
        (!projectId || l.projectId === projectId || l.projectId === null) &&
        (!tag || l.tags.includes(tag)) &&
        (!q || `${l.text} ${l.tags.join(" ")}`.toLowerCase().includes(q)),
    );
    const view: MemoryView = { scope, ownerAgentId: owner ?? null, query: q, lessons: rows };
    return c.json(view);
  });
  app.put("/memory/lessons/:id", async (c) => {
    const l = state.lessons.find((x) => x.id === c.req.param("id"));
    if (!l) return errorBody(c, 404, "not_found", "no such lesson");
    const body = (await c.req.json()) as {
      text?: unknown;
      tags?: unknown;
      confidence?: unknown;
      pinned?: unknown;
    };
    if (body.text !== undefined) {
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return errorBody(c, 400, "validation", "text: must not be empty");
      }
      l.text = body.text.trim();
    }
    if (Array.isArray(body.tags))
      l.tags = body.tags.filter((t): t is string => typeof t === "string");
    if (typeof body.confidence === "number") l.confidence = body.confidence;
    if (typeof body.pinned === "boolean") l.pinned = body.pinned;
    l.version += 1;
    l.updatedAt = new Date().toISOString();
    return c.json(l);
  });
  app.post("/memory/lessons/:id/pin", async (c) => {
    const l = state.lessons.find((x) => x.id === c.req.param("id"));
    if (!l) return errorBody(c, 404, "not_found", "no such lesson");
    const body = (await c.req.json()) as { pinned?: unknown };
    if (typeof body.pinned !== "boolean") return errorBody(c, 400, "validation", "pinned");
    l.pinned = body.pinned;
    l.version += 1;
    l.updatedAt = new Date().toISOString();
    return c.json(l);
  });
  app.delete("/memory/lessons/:id", (c) => {
    const l = state.lessons.find((x) => x.id === c.req.param("id"));
    if (!l) return errorBody(c, 404, "not_found", "no such lesson");
    state.lessons = state.lessons.filter((x) => x.id !== l.id);
    const retired: LessonView = { ...l, status: "retired", version: l.version + 1 };
    return c.json(retired);
  });
  // Cross-project sharing (spec G.6): propose, pending proposals, offers answered at once.
  app.post("/memory/lessons/:id/propose", (c) => {
    const l = state.lessons.find((x) => x.id === c.req.param("id"));
    if (!l) return errorBody(c, 404, "not_found", "no such lesson");
    if (l.scope === "shared" && (l.projectId === null || /(^|;)promotion:/.test(l.source))) {
      return errorBody(c, 400, "validation", "lesson is already shared across projects");
    }
    if (!l.tags.includes("general")) l.tags = [...l.tags, "general"];
    const existing = state.promotions.find((p) => p.source === `promotion:${l.id}`);
    if (existing) return c.json(existing);
    const now = new Date().toISOString();
    const proposal: LessonView = {
      ...l,
      id: nextId("les"),
      scope: "shared",
      ownerAgentId: null,
      projectId: null,
      source: `promotion:${l.id}`,
      status: "proposed",
      pinned: false,
      hitCount: 0,
      lastUsed: null,
      filePath: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    state.promotions.push(proposal);
    return c.json(proposal);
  });
  app.get("/memory/promotions", (c) => c.json(state.promotions));
  app.get("/memory/offers", (c) => c.json(state.offers));
  app.post("/memory/offers/:id/answer", async (c) => {
    const o = state.offers.find((x) => x.requestId === c.req.param("id"));
    if (!o) return errorBody(c, 404, "not_found", "no such offer");
    const body = (await c.req.json()) as { answer?: unknown };
    if (body.answer !== "accept" && body.answer !== "dismiss") {
      return errorBody(c, 400, "validation", "answer: accept or dismiss");
    }
    if (o.status !== "open") return errorBody(c, 409, "conflict", "offer already answered");
    const now = new Date().toISOString();
    o.status = "answered";
    o.answer = body.answer;
    o.appliedAt = now;
    o.version += 1;
    if (body.answer === "accept") {
      const copy: LessonView = {
        id: nextId("les"),
        scope: "shared",
        ownerAgentId: null,
        projectId: o.projectId,
        text: o.text,
        source: `promotion:${o.lessonId};human:${ME.id}`,
        tags: [...o.tags],
        confidence: o.confidence,
        lastUsed: null,
        hitCount: 0,
        supersededBy: null,
        pinned: true,
        status: "active",
        filePath: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      state.lessons.push(copy);
      o.copyId = copy.id;
    }
    emit("inbox.changed", { blockingCount: blockingCount() });
    return c.json(o);
  });
  app.get("/memory/consolidation", (c) => c.json(state.consolidation));
  app.post("/memory/consolidation/run", (c) => {
    const now = new Date().toISOString();
    const report: ConsolidationReportView = {
      scope: "agent_private",
      ownerAgentId: "agent_alice",
      ranAt: now,
      applied: false,
      merged: [],
      contradictions: [],
      retired: [],
      proposals: [],
    };
    const requestId = nextId("req");
    state.consolidation.unshift({
      requestId,
      status: "open",
      createdAt: now,
      reports: [report],
      proposals: [],
      appliedAt: null,
      answer: null,
    });
    emit("inbox.changed", { blockingCount: blockingCount() });
    return c.json({ requestId, proposals: 0, reports: [report] });
  });

  // Commands (spec Q): a small executor with the registry's risk rules for the commands the
  // settings screen sends, one card and one change log row per request, confirmation by
  // risk (medium a yes or a tap, high a paired device; the desktop app is one), undo.
  type Risk = "low" | "medium" | "high";
  const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
  const SOURCE_OF: Record<string, ChangeLogView["source"]> = {
    text: "chat",
    voice: "voice",
    phone: "chat",
    ui: "ui",
  };
  const projectByRef = (ref: string | undefined) =>
    ref
      ? state.projects.find((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase())
      : state.projects.find((p) => p.active);
  const card = (
    input: Partial<ChangeCardView> &
      Pick<ChangeCardView, "command" | "what" | "oldValue" | "newValue" | "scope" | "sentence">,
    risk: Risk,
  ): ChangeCardView => ({
    scopeLabel:
      input.scope === "session"
        ? "this session"
        : input.scope === "project"
          ? "this project"
          : "everything",
    duration: input.expiresAt ? `until ${input.expiresAt}` : "permanent",
    impact: { risk },
    undoHint: "Say undo or tap Undo in the change log.",
    projectId: null,
    projectName: null,
    usesActiveProject: false,
    expiresAt: null,
    reversible: true,
    ...input,
  });
  interface Planned {
    name: string;
    params: Record<string, unknown>;
    risk: Risk;
    card: ChangeCardView;
    /** Mutates the fake's state and returns the before/after values for the change log. */
    apply: () => { before: unknown; after: unknown };
  }
  type PlanOutcome = Planned | { refused: { reason: string; code: string } };
  const refuse = (reason: string, code = "validation"): PlanOutcome => ({
    refused: { reason, code },
  });
  /** What each slider position does, as `SPEED_QUALITY_EFFECT` in @forerunner/commands says it. */
  const SPEED_QUALITY_EFFECT: Record<-1 | 0 | 1, string> = {
    [-1]: "speed, every mode's default effort one step lower (faster and cheaper) from the next run, turn or planning session",
    0: "balanced, every mode at its default effort from the next run, turn or planning session",
    1: "quality, every mode's default effort one step higher (slower, more thorough) from the next run, turn or planning session",
  };
  /** The daemon's words for the modes (`EMAIL_MODE_LABELS` in @forerunner/commands). */
  const EMAIL_MODE_LABELS: Record<string, string> = {
    off: "Off",
    read_only: "Read only",
    draft_only: "Draft only",
    allowlist: "Allowlist",
    full_discretion: "Full discretion",
  };
  const SETTING_RISK: Record<string, Risk> = {
    speed_quality_offset: "low",
    small_project_mode: "low",
    fast_mode: "medium",
    status_pull_request: "low",
    // merge-in-app: medium, as SETTING_SPECS.merge_mode (turning automatic merges on asks a yes).
    merge_mode: "medium",
    critic_ceiling: "medium",
    session_reserve_share: "medium",
    quiet_hours: "low",
    shared_with: "high",
    notify_channel: "low",
    default_autonomy: "medium",
    language: "low",
    calibration: "medium",
    handover: "medium",
    voice_alerts: "low",
    model_watch: "medium",
    // U-078: medium, as SETTING_SPECS.mid_session_limit (use_other moves work onto money).
    mid_session_limit: "medium",
    // U-078: medium, as SETTING_SPECS.code_commands (the API key moves code work onto money).
    code_commands: "medium",
    // 'sites': medium, as SETTING_SPECS.web_access (widening asks a yes; narrowing acts at once).
    web_access: "medium",
  };
  /** Where `settings.set` keeps a key's value: `key`, or `key:projectId` for a project key. */
  const settingSlot = (key: string, projectId: string | null) =>
    projectId ? `${key}:${projectId}` : key;
  /** A project's merge mode as the daemon reads it (`mergeModeOf`, merge-in-app): "you" unless set. */
  const mergeModeOfFake = (projectId: string): "you" | "after_review" =>
    state.settingValues[settingSlot("merge_mode", projectId)] === "after_review"
      ? "after_review"
      : "you";
  const MERGE_MODE_LABELS = MERGE_MODE_WORDS;
  const MERGE_MODE_EFFECTS = {
    you: mergeModeEffect("you"),
    after_review: mergeModeEffect("after_review"),
  };
  const PROJECT_KEYS = new Set([
    "small_project_mode",
    "status_pull_request",
    "merge_mode",
    "critic_ceiling",
    "session_reserve_share",
    "handover",
    "shared_with",
  ]);
  const plan = (name: string, params: Record<string, unknown>): PlanOutcome => {
    const projectRef = typeof params.project === "string" ? params.project : undefined;
    if (name === "email.mode.set") {
      // As the daemon's command (spec S.15, Q high risk; ADR 0066 amended): the agent must be
      // the human's own, the card names the labels, and under ADR 0081 a change to off turns
      // email commands off in the same write; the undo restores both.
      const mode = typeof params.mode === "string" ? params.mode : "";
      if (!(EMAIL_MODES as readonly string[]).includes(mode)) {
        return refuse(`mode must be one of ${EMAIL_MODES.join(", ")}`);
      }
      const ref = typeof params.agent === "string" ? params.agent : "agent_alice";
      const agent = AGENTS.find((a) => a.id === ref || a.name === ref);
      if (!agent) return refuse(`no agent ${ref}`, "not_found");
      if (agent.ownerHumanId !== ME.id) {
        return refuse(
          `the agent ${agent.name} is not yours: its email mode is its owner's to change`,
          "tool_not_allowed",
        );
      }
      const cfg = emailOf(agent.id);
      const from = cfg.settings.mode;
      const switchedOff = mode === "off" && cfg.commands.enabled;
      const also = switchedOff
        ? "; email commands are turned off with it, because at Off the agent could not answer them"
        : "";
      const sentence = `Changed the email mode of ${agent.name} from ${EMAIL_MODE_LABELS[from]} to ${EMAIL_MODE_LABELS[mode] ?? mode}${also}. Undo.`;
      return {
        name,
        params,
        risk: "high",
        card: card(
          {
            command: name,
            what: `the email mode of ${agent.name}`,
            oldValue: EMAIL_MODE_LABELS[from] ?? from,
            newValue: EMAIL_MODE_LABELS[mode] ?? mode,
            scope: "global",
            sentence,
          },
          "high",
        ),
        apply: () => {
          const before = { agent_id: agent.id, mode: from, commands_enabled: cfg.commands.enabled };
          cfg.settings.mode = mode as EmailSettingsView["settings"]["mode"];
          if (switchedOff) cfg.commands.enabled = false;
          return {
            before,
            after: { agent_id: agent.id, mode, commands_switched_off: switchedOff },
          };
        },
      };
    }
    if (name === "autonomy.set") {
      const level = Number(params.level);
      const project = projectByRef(projectRef);
      if (!project || !Number.isInteger(level) || level < 0 || level > 4) {
        return refuse("level must be 0 to 4 and the project must exist");
      }
      const delta = Math.abs(level - project.autonomyLevel);
      const risk: Risk = delta === 0 ? "low" : delta === 1 ? "medium" : "high";
      const from = project.autonomyLevel;
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what: `autonomy for ${project.name}`,
            oldValue: String(from),
            newValue: String(level),
            scope: "project",
            sentence: `Set autonomy for ${project.name} from ${from} to ${level}. Undo.`,
            projectId: project.id,
            projectName: project.name,
            usesActiveProject: projectRef === undefined,
          },
          risk,
        ),
        apply: () => {
          project.autonomyLevel = level;
          emit("project.changed", { id: project.id });
          return { before: { autonomyLevel: from }, after: { autonomyLevel: level } };
        },
      };
    }
    if (name === "repo.create") {
      // As the daemon's `repo.create` (U-037): a project without a repository, the name from
      // the project's, under the token's account (the fake host's alice) unless an owner is
      // named; private is medium risk (a yes or a tap), public high (a paired device).
      const project = projectByRef(projectRef);
      if (!project) return refuse("no such project", "not_found");
      if ((project.repos ?? []).length > 0)
        return refuse(
          `${project.name} already has a repository (${project.repos?.[0]}); one is created only for a project without one`,
        );
      const isPrivate = params.private !== false;
      const owner = typeof params.owner === "string" && params.owner ? params.owner : "alice";
      const repoName =
        typeof params.name === "string" && params.name
          ? params.name
          : project.name
              .toLowerCase()
              .replace(/[^a-z0-9._-]+/g, "-")
              .replace(/^-+|-+$/g, "");
      const full = `${owner}/${repoName}`;
      const under = owner === "alice" ? "your GitHub account alice" : `the organization ${owner}`;
      const risk: Risk = isPrivate ? "medium" : "high";
      const visibility = isPrivate ? "private" : "public";
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what: `a GitHub repository for ${project.name}`,
            oldValue: "no repository",
            newValue: `${full} (${visibility}, under ${under})`,
            scope: "project",
            sentence: `Create the ${visibility} GitHub repository ${full} under ${under} for ${project.name}, push its workspace as the first commit and link it to the project.`,
            projectId: project.id,
            projectName: project.name,
            usesActiveProject: projectRef === undefined,
            reversible: false,
            undoHint: "This cannot be undone here.",
          },
          risk,
        ),
        apply: () => {
          project.repos = [full];
          emit("project.changed", { id: project.id });
          return { before: { repos: [] }, after: { repo: full } };
        },
      };
    }
    if (name === "budget.set") {
      const scope = typeof params.scope === "string" ? params.scope : "session";
      const amountChf = Number(params.amountChf);
      if (!Number.isFinite(amountChf) || amountChf <= 0) {
        return refuse("budget.set: amountChf must be a positive number");
      }
      if (scope === "month") {
        const fromChf = me.monthlyCap.chfMicro / 1_000_000;
        const raise = amountChf > fromChf;
        const monthRisk: Risk = raise ? "high" : "medium";
        return {
          name,
          params,
          risk: monthRisk,
          card: card(
            {
              command: name,
              what: "the monthly hard ceiling",
              oldValue: `CHF ${fromChf}`,
              newValue: `CHF ${amountChf}`,
              scope: "global",
              sentence: `${raise ? "Raised" : "Lowered"} the monthly hard ceiling from CHF ${fromChf} to CHF ${amountChf}. Undo.`,
            },
            monthRisk,
          ),
          apply: () => {
            me.monthlyCap = money(Math.round((amountChf * 1_000_000) / 0.8));
            return {
              before: { monthlyCapChf: fromChf },
              after: { monthlyCapChf: amountChf },
            };
          },
        };
      }
      const project = projectByRef(projectRef);
      if (!project) return refuse("no such project");
      if (scope === "project") {
        const fromChf = project.budget.chfMicro / 1_000_000;
        return {
          name,
          params,
          risk: "medium",
          card: card(
            {
              command: name,
              what: `the project budget for ${project.name}`,
              oldValue: `CHF ${fromChf}`,
              newValue: `CHF ${amountChf}`,
              scope: "project",
              sentence: `Set the project budget for ${project.name} from CHF ${fromChf} to CHF ${amountChf}. Undo.`,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            "medium",
          ),
          apply: () => {
            project.budget = money(Math.round((amountChf * 1_000_000) / 0.8));
            emit("project.changed", { id: project.id });
            return { before: { budgetChf: fromChf }, after: { budgetChf: amountChf } };
          },
        };
      }
      const until = typeof params.until === "string" ? params.until : null;
      const risk: Risk = amountChf > 1.6 ? "medium" : "low";
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what: `${until ? "tonight's" : "the"} session budget for ${project.name}`,
            oldValue: "CHF 5",
            newValue: `CHF ${amountChf}`,
            scope: "session",
            sentence: `Raised the session budget for ${project.name} from CHF 5 to CHF ${amountChf}${until ? `, until ${until}` : ""}. Undo.`,
            projectId: project.id,
            projectName: project.name,
            usesActiveProject: projectRef === undefined,
            expiresAt: until,
          },
          risk,
        ),
        apply: () => ({ before: { sessionBudgetChf: 5 }, after: { sessionBudgetChf: amountChf } }),
      };
    }
    if (name === "model.settings.set") {
      // Like the daemon's command (spec D.4): one field of an agent mode or a specialist;
      // null returns to the default; a temperature only where the provider accepts one.
      const keys: Record<string, keyof ModelSettingsView["specialists"][number]["settings"]> = {
        tier: "tier",
        effort: "effort",
        max_tokens: "maxTokens",
        speed_mode: "speedMode",
        timeout_minutes: "timeoutMinutes",
        temperature: "temperature",
      };
      const field = typeof params.field === "string" ? params.field : "";
      const key = keys[field];
      if (!key) return refuse(`unknown model setting ${field}`);
      if (field === "temperature" && params.value !== null && !state.acceptsTemperature)
        return refuse("the provider in use does not accept a temperature; nothing to set");
      const settings =
        typeof params.specialist === "string"
          ? state.modelSettings.specialists.find((x) => x.name === params.specialist)?.settings
          : state.modelSettings.agents
              .find((a) => a.id === params.agent && a.editable)
              ?.modes.find((m) => m.mode === params.mode);
      if (!settings) return refuse("no such agent mode or specialist", "not_found");
      const maxEffort =
        typeof params.specialist === "string"
          ? state.modelSettings.specialists.find((x) => x.name === params.specialist)?.maxEffort
          : undefined;
      const efforts = ["low", "medium", "high", "xhigh", "max"];
      if (
        field === "effort" &&
        typeof params.value === "string" &&
        maxEffort &&
        efforts.indexOf(params.value) > efforts.indexOf(maxEffort)
      )
        return refuse(
          `effort: the ${params.specialist} specialist runs at most at ${maxEffort} (its max_effort)`,
        );
      const current = settings[key] as ModelSettingValueView | undefined;
      if (!current || typeof current !== "object") return refuse("no such setting");
      const value = params.value as string | number | null;
      const risk: Risk =
        value !== null && (field === "tier" || field === "effort" || value === "fast")
          ? "medium"
          : "low";
      const subject =
        typeof params.specialist === "string"
          ? `the ${params.specialist} specialist for Alice`
          : `Alice's ${params.mode === "text_chat" ? "chat" : params.mode}`;
      // The daemon's words for each field (`MODEL_SETTING_LABELS` in packages/commands).
      const words: Record<string, string> = {
        tier: "the model",
        effort: "the effort",
        max_tokens: "the max tokens per call",
        speed_mode: "the speed mode",
        timeout_minutes: "the timeout in minutes",
        temperature: "the temperature",
      };
      const what = `${words[field] ?? field} of ${subject}`;
      const from = current.source === "agent" ? String(current.value) : "the default";
      const to = value === null ? "the default" : String(value);
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what,
            oldValue: from,
            newValue: to,
            scope: "global",
            sentence: `Set ${what} from ${from} to ${to}. Undo.`,
          },
          risk,
        ),
        apply: () => {
          const before = { ...current };
          const next: ModelSettingValueView =
            value === null
              ? { ...current, value: current.default, source: current.defaultSource }
              : { ...current, value, source: "agent" };
          (settings as Record<string, unknown>)[key] = next;
          return { before, after: next };
        },
      };
    }
    if (name === "settings.set") {
      const key = typeof params.key === "string" ? params.key : "";
      const risk = SETTING_RISK[key];
      if (!risk) return refuse(`unknown setting ${key}`);
      const project = projectByRef(projectRef);
      if (key === "web_access" && project) {
        // As SETTING_SPECS.web_access ('sites'): the one clean-up, refused entries in words, a
        // yes only when the rule widens (judged against the rule in force), the same value refused.
        const raw = (params.value ?? {}) as { mode?: unknown; only?: unknown; never?: unknown };
        const mode = raw.mode === "only" ? "only" : "any";
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        const only = mode === "only" ? cleanSiteList(list(raw.only), "only") : null;
        const never = cleanSiteList(list(raw.never), "never");
        const refused = [...(only?.refused ?? []), ...never.refused].map(
          (r) => `"${r.entry}" is ${r.why}.`,
        );
        if (only && only.sites.length === 0 && !refused.length)
          refused.push(
            "Only these websites needs at least one website, or research would be stuck.",
          );
        if (refused.length) return refuse(refused.join(" "));
        const value: WebAccess = { mode, only: only?.sites ?? [], never: never.sites };
        const before = webAccessFake(project.id);
        const what = `web pages research may read for ${project.name}`;
        if (JSON.stringify(before) === JSON.stringify(value))
          return refuse(
            `Web pages research may read for ${project.name} is already ${webAccessWords(before)}.`,
          );
        const effect =
          mode === "only"
            ? "research reads only these websites and their subdomains, on the API key and on the subscription"
            : "research reads any public website except the ones listed, on the API key and on the subscription";
        const r: Risk = webAccessNarrows(value, before) ? "low" : risk;
        return {
          name,
          params,
          risk: r,
          card: card(
            {
              command: name,
              what,
              oldValue: webAccessWords(before),
              newValue: `${webAccessWords(value)} (${effect})`,
              scope: "project",
              sentence: `Set ${what} from ${webAccessWords(before)} to ${webAccessWords(value)}: ${effect}. Undo.`,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            r,
          ),
          apply: () => {
            state.settingValues[settingSlot(key, project.id)] = value;
            return {
              before: { key, project_id: project.id, value: before },
              after: { key, project_id: project.id, value },
            };
          },
        };
      }
      if (key === "fast_mode" && project && typeof params.value === "boolean") {
        // The daemon's card for this key (SettingSpec.effect, ADR 0051 item 4): the effect
        // and the surcharge for the direction asked, in the change card and the sentence.
        const value = params.value;
        const before = state.fastMode[project.id] ?? null;
        const shown = before === null ? "unset" : String(before);
        const effect = fastModeEffect(value);
        const sentence = `Set Opus fast mode for ${project.name} from ${shown} to ${value}: ${effect}. Undo.`;
        return {
          name,
          params,
          risk,
          card: card(
            {
              command: name,
              what: `Opus fast mode for ${project.name}`,
              oldValue: shown,
              newValue: `${value} (${effect})`,
              scope: "project",
              sentence,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            risk,
          ),
          apply: () => {
            state.fastMode[project.id] = value;
            return { before: { fast_mode: before }, after: { fast_mode: value } };
          },
        };
      }
      if (
        key === "merge_mode" &&
        project &&
        (params.value === "you" || params.value === "after_review")
      ) {
        // The daemon's card for this key (`SETTING_SPECS.merge_mode`, merge-in-app): the mode in
        // words and what the new one means, in the card and the sentence; the same value is
        // refused; turning automatic merges off acts at once (narrows), on asks a yes.
        const value = params.value;
        const before = mergeModeOfFake(project.id);
        const what = `who merges accepted work for ${project.name}`;
        if (before === value && state.settingValues[settingSlot(key, project.id)] !== undefined)
          return refuse(
            `Who merges accepted work for ${project.name} is already ${MERGE_MODE_LABELS[before]}.`,
          );
        const effect = MERGE_MODE_EFFECTS[value];
        return {
          name,
          params,
          risk: value === "after_review" ? risk : "low",
          card: card(
            {
              command: name,
              what,
              oldValue: MERGE_MODE_LABELS[before],
              newValue: `${MERGE_MODE_LABELS[value]} (${effect})`,
              scope: "project",
              sentence: `Set ${what} from ${MERGE_MODE_LABELS[before]} to ${MERGE_MODE_LABELS[value]}: ${effect}. Undo.`,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            value === "after_review" ? risk : "low",
          ),
          apply: () => {
            const slot = settingSlot(key, project.id);
            const had = state.settingValues[slot];
            state.settingValues[slot] = value;
            return {
              before: { key, project_id: project.id, value: had ?? null },
              after: { key, project_id: project.id, value },
            };
          },
        };
      }
      if (key === "status_pull_request" && project && typeof params.value === "boolean") {
        // The daemon's card for this key (`SETTING_SPECS.status_pull_request`, C-57): on/off,
        // and what the new value does, in the card and the sentence; the same value is refused.
        const value = params.value;
        const slot = settingSlot(key, project.id);
        const before = state.settingValues[slot] === true;
        const onOff = (v: boolean) => (v ? "on" : "off");
        const what = `the status pull request for ${project.name}`;
        if (before === value)
          return refuse(`The status pull request for ${project.name} is already ${onOff(before)}.`);
        const effect = value
          ? "each session's status goes to the repository as one pull request, docs: project status, which you merge when you like"
          : "each session's status stays in the app (Docs, Status); no status pull request is opened";
        return {
          name,
          params,
          risk,
          card: card(
            {
              command: name,
              what,
              oldValue: onOff(before),
              newValue: `${onOff(value)} (${effect})`,
              scope: "project",
              sentence: `Set ${what} from ${onOff(before)} to ${onOff(value)}: ${effect}. Undo.`,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            risk,
          ),
          apply: () => {
            state.settingValues[slot] = value;
            return {
              before: { key, project_id: project.id, value: before },
              after: { key, project_id: project.id, value },
            };
          },
        };
      }
      if (key === "speed_quality_offset") {
        // Like the daemon (spec D.16): three positions, and the sentence says what the new one
        // does (`SPEED_QUALITY_EFFECT` in @forerunner/commands).
        const value = params.value;
        if (!project) return refuse("the project must exist");
        if (value !== -1 && value !== 0 && value !== 1) {
          // The daemon's words: `settings.set` joins the zod issues of
          // `z.number().int().min(-1).max(1)` after the key.
          const issue =
            typeof value !== "number"
              ? `Invalid input: expected number, received ${value === null ? "null" : typeof value}`
              : !Number.isInteger(value)
                ? "Invalid input: expected int, received number"
                : value < -1
                  ? "Too small: expected number to be >=-1"
                  : "Too big: expected number to be <=1";
          return refuse(`speed_quality_offset: ${issue}`);
        }
        const from = state.speedQuality[project.id];
        const effect = SPEED_QUALITY_EFFECT[value];
        const what = `the speed-versus-quality slider for ${project.name}`;
        return {
          name,
          params,
          risk,
          card: card(
            {
              command: name,
              what,
              oldValue: from === undefined ? "unset" : String(from),
              newValue: `${value} (${effect})`,
              scope: "project",
              sentence: `Set ${what} from ${from === undefined ? "unset" : from} to ${value}: ${effect}. Undo.`,
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            risk,
          ),
          apply: () => {
            state.speedQuality[project.id] = value;
            return {
              before: { key, project_id: project.id, value: from ?? null },
              after: { key, project_id: project.id, value },
            };
          },
        };
      }
      // The daemon's words for these values (`quietHoursWords`, `autonomyLevelWords` in
      // @forerunner/commands): times and names, never JSON; the same value again is refused.
      const AUTONOMY = ["Advisor", "Assisted", "Standard", "Trusted", "Autopilot"];
      const shown = (v: unknown): string => {
        if (key === "quiet_hours") {
          const o = v as { start?: unknown; end?: unknown } | null;
          return o && typeof o.start === "string" && typeof o.end === "string"
            ? `${o.start}–${o.end}`
            : "off";
        }
        if (key === "default_autonomy" && typeof v === "number")
          return `${AUTONOMY[v] ?? "level"} (level ${v})`;
        return v === undefined || v === null ? "unset" : JSON.stringify(v);
      };
      const currentValue =
        key === "default_autonomy"
          ? me.defaultAutonomy
          : (state.settingValues[
              settingSlot(key, PROJECT_KEYS.has(key) ? (project?.id ?? null) : null)
            ] ?? null);
      if (
        (key === "quiet_hours" || key === "default_autonomy") &&
        JSON.stringify(currentValue ?? null) === JSON.stringify(params.value ?? null)
      ) {
        const label =
          key === "quiet_hours" ? "Quiet hours" : "The default autonomy for new projects";
        return refuse(`${label} is already ${shown(currentValue)}.`);
      }
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what: `${key}${project ? ` for ${project.name}` : ""}`,
            oldValue: shown(currentValue),
            newValue: shown(params.value),
            scope: "project",
            sentence: `Set ${key}${project ? ` for ${project.name}` : ""} to ${shown(params.value)}. Undo.`,
            projectId: project?.id ?? null,
            projectName: project?.name ?? null,
            usesActiveProject: projectRef === undefined,
          },
          risk,
        ),
        apply: () => {
          // Like the daemon's card: the flag and the default tier of new tasks follow (B.6).
          if (key === "small_project_mode" && project && typeof params.value === "boolean") {
            project.smallProjectMode = params.value;
            project.defaultRiskTier = params.value ? 0 : 1;
          }
          if (key === "default_autonomy" && typeof params.value === "number") {
            me.defaultAutonomy = params.value;
          }
          const slot = settingSlot(key, PROJECT_KEYS.has(key) ? (project?.id ?? null) : null);
          const previous = state.settingValues[slot] ?? null;
          state.settingValues[slot] = params.value;
          return {
            before: {
              key,
              project_id: PROJECT_KEYS.has(key) ? (project?.id ?? null) : null,
              value: previous,
            },
            after: {
              key,
              project_id: PROJECT_KEYS.has(key) ? (project?.id ?? null) : null,
              value: params.value,
            },
          };
        },
      };
    }
    if (name === "note.add") {
      const project = projectByRef(projectRef);
      const text = typeof params.text === "string" ? params.text : "";
      if (!project || !text.trim()) return refuse("note.add needs text and a project");
      return {
        name,
        params,
        risk: "low",
        card: card(
          {
            command: name,
            what: `a note for ${project.name}`,
            oldValue: "",
            newValue: text,
            scope: "project",
            sentence: `Added a note to ${project.name}'s next session. Undo.`,
            projectId: project.id,
            projectName: project.name,
          },
          "low",
        ),
        apply: () => {
          const item: QueueItemView = {
            id: nextId("q"),
            projectId: project.id,
            humanId: ME.id,
            kind: "note",
            text,
            priority: 0,
            status: "queued",
            consumedBySession: null,
            createdAt: new Date().toISOString(),
            version: 1,
          };
          state.queue.unshift(item);
          return { before: null, after: { queueItem: item.id } };
        },
      };
    }
    if (name === "project.switch") {
      const project = projectByRef(projectRef);
      if (!project) return refuse("no such project");
      const before = state.projects.find((p) => p.active);
      return {
        name,
        params,
        risk: "low",
        card: card(
          {
            command: name,
            what: "the active project",
            oldValue: before?.name ?? "none",
            newValue: project.name,
            scope: "global",
            sentence: `Switched to ${project.name}. Undo.`,
            projectId: project.id,
            projectName: project.name,
          },
          "low",
        ),
        apply: () => {
          for (const p of state.projects) p.active = p.id === project.id;
          return {
            before: { activeProject: before?.id ?? null },
            after: { activeProject: project.id },
          };
        },
      };
    }
    if (name === "capability.grant") {
      const target = String(params.extension ?? params.name ?? "a capability");
      return {
        name,
        params,
        risk: "high",
        card: card(
          {
            command: name,
            what: `capability ${target}`,
            oldValue: "not granted",
            newValue: "granted",
            scope: "global",
            sentence: `Granted ${target}. Undo.`,
          },
          "high",
        ),
        apply: () => ({ before: { granted: false }, after: { granted: true } }),
      };
    }
    return refuse(`unknown command ${name}`, "not_found");
  };
  const logChange = (
    plans: Planned[],
    view: ChangeCardView,
    source: ChangeLogView["source"],
    wordsUsed: string,
  ): ChangeLogView => {
    const results = plans.map((p) => p.apply());
    const entry: ChangeLogView = {
      id: nextId("chg"),
      humanId: ME.id,
      agentId: "agent_alice",
      wordsUsed,
      commands: plans.map((p) => ({ name: p.name, params: p.params })),
      before: results.length === 1 ? results[0]?.before : results.map((r) => r.before),
      after: results.length === 1 ? results[0]?.after : results.map((r) => r.after),
      scope: view.scope,
      projectId: view.projectId,
      expiresAt: view.expiresAt,
      undoState: view.reversible ? "undoable" : "irreversible",
      undoneAt: null,
      source,
      sentence: view.sentence,
      undoable: view.reversible,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    state.changes.unshift(entry);
    return entry;
  };
  const decide = (risk: Risk) =>
    risk === "low" ? "act" : risk === "medium" ? "needs_yes" : "needs_device";
  const mergeCards = (plans: Planned[]): ChangeCardView => {
    const first = plans[0]?.card;
    if (!first) throw new Error("mergeCards: empty plan");
    if (plans.length === 1) return first;
    const risk = plans.map((p) => p.risk).reduce((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a));
    return {
      ...first,
      what: plans.map((p) => p.card.what).join(", "),
      impact: { ...first.impact, risk },
      sentence: plans
        .map((p) => p.card.sentence.replace(/ Undo\.$/, "."))
        .join(" ")
        .concat(" Undo."),
      parts: plans.map((p) => p.card),
    };
  };
  app.get("/commands", (c) => c.json(COMMAND_DEFS));
  app.post("/commands/parse", async (c) => {
    const body = (await c.req.json()) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return errorBody(c, 400, "validation", "text is required");
    const m = /^switch to (.+)$/i.exec(text);
    if (m) {
      return c.json({
        commands: [{ name: "project.switch", params: { project: m[1] } }],
        question: null,
        matched: "pattern",
      });
    }
    return c.json({ commands: [], question: null, matched: "none" });
  });
  app.post("/commands/execute", async (c) => {
    const body = (await c.req.json()) as {
      commands?: Array<{ name?: unknown; params?: unknown }>;
      wordsUsed?: string;
      source?: string;
      projectId?: string;
      deviceId?: string;
      confirm?: string;
    };
    if (!Array.isArray(body.commands) || body.commands.length === 0) {
      return errorBody(c, 400, "validation", "commands: at least one command");
    }
    const names: string[] = [];
    const plans: Planned[] = [];
    for (const call of body.commands) {
      if (typeof call.name !== "string") return errorBody(c, 400, "validation", "commands[].name");
      names.push(call.name);
      const params =
        call.params && typeof call.params === "object"
          ? (call.params as Record<string, unknown>)
          : {};
      const outcome = plan(call.name, params);
      if ("refused" in outcome) {
        const result: CommandResultJson = {
          status: "refused",
          reason: outcome.refused.reason,
          code: outcome.refused.code,
          card: null,
          commands: names,
        };
        return c.json(result);
      }
      plans.push(outcome);
    }
    const view = mergeCards(plans);
    const risk = view.impact.risk;
    const source = SOURCE_OF[body.source ?? "text"] ?? "chat";
    const wordsUsed = body.wordsUsed ?? "";
    const runAll = (): CommandResultJson => {
      const entry = logChange(plans, view, source, wordsUsed);
      return {
        status: "done",
        sentence: view.sentence,
        changeLogId: entry.id,
        undoToken: entry.undoable ? entry.id : null,
        card: view,
        commands: names,
      };
    };
    const decision = decide(risk);
    if (decision === "act" || (decision === "needs_yes" && body.confirm === "tap")) {
      return c.json(runAll());
    }
    const id = nextId("pend");
    const now = new Date();
    const readback = `${view.what}: ${view.oldValue || "nothing"} to ${view.newValue}. ${
      decision === "needs_yes" ? "Say yes to confirm." : "Confirm in the app on a paired device."
    }`;
    state.pendingCommands.set(id, {
      card: view,
      decision,
      apply: runAll,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      readback,
      wordsUsed,
    });
    emit("inbox.changed", { blockingCount: blockingCount() });
    const result: CommandResultJson = {
      status: "pending",
      readback,
      pendingId: id,
      decision,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      card: view,
      commands: names,
    };
    return c.json(result);
  });
  app.get("/commands/pending", (c) => {
    const rows: PendingChangeView[] = [...state.pendingCommands.entries()].map(([id, p]) => ({
      id,
      humanId: ME.id,
      card: p.card,
      decision: p.decision,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      readback: p.readback,
      wordsUsed: p.wordsUsed,
    }));
    return c.json(rows);
  });
  const noPending = (id: string): CommandResultJson => ({
    status: "refused",
    reason: `no pending change ${id}`,
    code: "not_found",
    card: null,
    commands: [],
  });
  app.post("/commands/:id/confirm", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      answer?: string;
      deviceId?: string;
      biometric?: boolean;
    };
    if (!["yes", "no", "tap", "device"].includes(body.answer ?? "")) {
      return errorBody(c, 400, "validation", "answer must be yes, no, tap or device");
    }
    const pending = state.pendingCommands.get(id);
    if (!pending) return c.json(noPending(id));
    const names = pending.card.parts?.map((p) => p.command) ?? [pending.card.command];
    if (body.answer === "no") {
      state.pendingCommands.delete(id);
      const result: CommandResultJson = {
        status: "cancelled",
        pendingId: id,
        card: pending.card,
        commands: names,
      };
      return c.json(result);
    }
    if (body.answer === "device") {
      // As the daemon's route: an answer without an id, or with the literal `desktop` an older
      // settings screen sent, is this PC's own row as `/me` names it; a daemon that names no
      // row refuses it (409 `conflict`, its message). An id is checked as given, and one that
      // is no paired device of the human is refused by the registry's policy ("unknown
      // device; pair it first"), the card staying open.
      const thisPc = !body.deviceId || body.deviceId === "desktop";
      const deviceId = thisPc ? me.desktopDeviceId : body.deviceId;
      if (!deviceId) {
        return errorBody(
          c,
          409,
          "conflict",
          "deviceId is required: this daemon has no desktop device row to answer for",
        );
      }
      if (deviceId !== ME.desktopDeviceId) {
        const result: CommandResultJson = {
          status: "refused",
          reason: "unknown device; pair it first",
          code: "approval_required",
          card: pending.card,
          pendingId: id,
          commands: names,
        };
        return c.json(result);
      }
    } else if (pending.decision === "needs_device") {
      const result: CommandResultJson = {
        status: "refused",
        reason:
          "a yes or a tap is not enough for a high-risk change: confirm in the app on a paired device",
        code: "approval_required",
        card: pending.card,
        pendingId: id,
        commands: names,
      };
      return c.json(result);
    }
    state.pendingCommands.delete(id);
    return c.json(pending.apply());
  });
  app.post("/commands/:id/cancel", (c) => {
    const id = c.req.param("id");
    const pending = state.pendingCommands.get(id);
    if (!pending) return c.json(noPending(id));
    state.pendingCommands.delete(id);
    const result: CommandResultJson = {
      status: "cancelled",
      pendingId: id,
      card: pending.card,
      commands: pending.card.parts?.map((p) => p.command) ?? [pending.card.command],
    };
    return c.json(result);
  });
  /** As the daemon's `undoBlocked` (U-061): why a still-undoable row's Undo would not work. */
  const undoBlocked = (ch: ChangeLogView): string | null => {
    const name = (ch.commands[0] as { name?: string } | undefined)?.name;
    const after = (ch.after ?? {}) as {
      task_id?: string;
      status?: string;
      title?: string;
      version?: number;
      depends_on?: string[];
      session_id?: string | null;
    };
    // As the daemon's `startUndoRefusal` (later #36): a start whose session ended has nothing
    // left to undo, and the row says so instead of offering Undo.
    if (name === "session.start") {
      const s = after.session_id
        ? state.sessions.find((x) => x.id === after.session_id)
        : undefined;
      return s && !["running", "paused", "planned"].includes(s.status)
        ? "the session this start began has already ended; there is nothing to undo"
        : null;
    }
    if (!name?.startsWith("task.")) return null;
    const task = state.tasks.find((t) => t.id === after.task_id);
    if (!task) return "the task no longer exists";
    if (name === "task.create") {
      if (task.status === "cancelled") return `the task "${task.title}" is already cancelled`;
      return (TASK_TRANSITIONS[task.status] ?? []).includes("cancelled")
        ? null
        : `the task "${task.title}" is ${task.status}; a ${task.status} task cannot be cancelled, so its creation cannot be undone`;
    }
    // As the daemon's `task.update` and `task.dependencies`: the undo works while nothing
    // changed them since.
    if (name === "task.update")
      return after.version === task.version
        ? null
        : `"${task.title}" was changed again since; undo would not put it back as it was`;
    if (name === "task.dependencies")
      return JSON.stringify(after.depends_on) === JSON.stringify(task.dependsOn)
        ? null
        : `what "${task.title}" waits for changed again since; undo would not put it back as it was`;
    // Every move is undone by putting back the status it had (design §3.5).
    if (task.status !== after.status) {
      return `"${task.title}" is ${viewOf(task).display?.label.toLowerCase() ?? task.status} now; undo would not put it back where it was`;
    }
    return null;
  };
  const withUndoable = (ch: ChangeLogView, now: string): ChangeLogView => {
    const open = ch.undoState === "undoable" && (!ch.expiresAt || ch.expiresAt > now);
    const blocked = open ? undoBlocked(ch) : null;
    return {
      ...ch,
      undoable: open && !blocked,
      ...(blocked ? { undoBlockedReason: blocked } : {}),
    };
  };
  /** The modes narrowest first: an undo to a wider one asks for the device (U-057). */
  const EMAIL_RANK: Record<string, number> = {
    off: 0,
    read_only: 1,
    draft_only: 2,
    allowlist: 3,
    full_discretion: 4,
  };
  /** As the daemon's `undoRisk` (U-057): an undo that raises or widens asks like the raise. */
  const undoRisk = (ch: ChangeLogView): Risk => {
    const name = (ch.commands[0] as { name?: string } | undefined)?.name;
    const before = (ch.before ?? {}) as Record<string, unknown>;
    const after = (ch.after ?? {}) as Record<string, unknown>;
    if (
      name === "budget.set" &&
      typeof before.monthlyCapChf === "number" &&
      typeof after.monthlyCapChf === "number"
    ) {
      return before.monthlyCapChf > after.monthlyCapChf ? "high" : "low";
    }
    if (name === "email.mode.set" && typeof before.mode === "string") {
      const now = emailOf(String(before.agent_id ?? "agent_alice")).settings.mode;
      return (EMAIL_RANK[before.mode] ?? 0) > (EMAIL_RANK[now] ?? 0) ? "high" : "low";
    }
    return "low";
  };
  app.get("/changes", (c) => {
    const projectId = c.req.query("projectId");
    const onlyUndoable = c.req.query("undoable") === "true";
    const limit = Math.min(1000, Number(c.req.query("limit") ?? 100));
    const now = new Date().toISOString();
    const rows = state.changes
      .map((ch) => withUndoable(ch, now))
      .filter((ch) => (!projectId || ch.projectId === projectId) && (!onlyUndoable || ch.undoable));
    return c.json(rows.slice(0, limit > 0 ? limit : 100));
  });
  app.post("/changes/:id/undo", (c) => {
    const entry = state.changes.find((ch) => ch.id === c.req.param("id"));
    if (!entry) return c.json(noPending(c.req.param("id")));
    const now = new Date().toISOString();
    const view = withUndoable(entry, now);
    if (!view.undoable) {
      const result: CommandResultJson = {
        status: "refused",
        reason:
          view.undoBlockedReason ?? `this change can no longer be undone (${entry.undoState})`,
        code: "validation",
        card: null,
        commands: ["undo"],
      };
      return c.json(result);
    }
    // U-057: an undo that raises or widens waits for the confirmation that raise needs.
    const risk = undoRisk(entry);
    const decision = decide(risk);
    if (decision !== "act") {
      const id = nextId("pend");
      const at = new Date();
      const expiresAt = new Date(at.getTime() + 10 * 60_000).toISOString();
      const what = entry.sentence.replace(/ Undo\.$/, "");
      const undoCard = card(
        {
          command: "undo",
          what: `undo: ${what}`,
          oldValue: "as it is now",
          newValue: "as it was before this change",
          scope: entry.scope,
          sentence: `Undo ${what}.`,
          projectId: entry.projectId,
        },
        risk,
      );
      const readback = `${undoCard.what}. ${
        decision === "needs_yes" ? "Say yes to confirm." : "Confirm in the app on a paired device."
      }`;
      state.pendingCommands.set(id, {
        card: undoCard,
        decision,
        apply: () => performUndo(entry),
        createdAt: at.toISOString(),
        expiresAt,
        readback,
        wordsUsed: "undo",
      });
      emit("inbox.changed", { blockingCount: blockingCount() });
      const result: CommandResultJson = {
        status: "pending",
        readback,
        pendingId: id,
        decision,
        expiresAt,
        card: undoCard,
        commands: ["undo"],
      };
      return c.json(result);
    }
    const undone = performUndo(entry);
    // As the daemon: an undo may bring a card back; the header's count follows at once.
    emit("inbox.changed", { blockingCount: blockingCount() });
    return c.json(undone);
  });
  const performUndo = (entry: ChangeLogView): CommandResultJson => {
    const now = new Date().toISOString();
    // Put the value back for the commands the fake applies to its state.
    const first = (entry.commands[0] ?? null) as { name?: string } | null;
    const before = (Array.isArray(entry.before) ? entry.before[0] : entry.before) as Record<
      string,
      unknown
    > | null;
    const project = state.projects.find((p) => p.id === entry.projectId);
    if (first?.name === "autonomy.set" && project && typeof before?.autonomyLevel === "number") {
      project.autonomyLevel = before.autonomyLevel;
      emit("project.changed", { id: project.id });
    }
    if (
      first?.name === "settings.set" &&
      project &&
      before?.key === "speed_quality_offset" &&
      (before.value === -1 || before.value === 0 || before.value === 1 || before.value === null)
    ) {
      if (before.value === null) delete state.speedQuality[project.id];
      else state.speedQuality[project.id] = before.value;
    }
    if (
      first?.name === "email.mode.set" &&
      typeof before?.agent_id === "string" &&
      typeof before?.mode === "string"
    ) {
      // ADR 0081: a change to off that turned email commands off is undone with them.
      const cfg = emailOf(before.agent_id);
      cfg.settings.mode = before.mode as EmailSettingsView["settings"]["mode"];
      const after = (Array.isArray(entry.after) ? entry.after[0] : entry.after) as Record<
        string,
        unknown
      > | null;
      if (after?.commands_switched_off === true && before.mode !== "off") {
        cfg.commands.enabled = true;
      }
    }
    if (first?.name === "budget.set" && project && typeof before?.budgetChf === "number") {
      project.budget = money(Math.round((before.budgetChf * 1_000_000) / 0.8));
      emit("project.changed", { id: project.id });
    }
    if (first?.name === "budget.set" && typeof before?.monthlyCapChf === "number") {
      me.monthlyCap = money(Math.round((before.monthlyCapChf * 1_000_000) / 0.8));
    }
    if (first?.name === "settings.set" && typeof before?.key === "string") {
      const slot = settingSlot(
        before.key,
        typeof before.project_id === "string" ? before.project_id : null,
      );
      if (before.value === null || before.value === undefined) delete state.settingValues[slot];
      else state.settingValues[slot] = before.value;
      if (before.key === "default_autonomy" && typeof before.value === "number") {
        me.defaultAutonomy = before.value;
      }
    }
    let sentence = `Undone: ${entry.sentence.replace(/ Undo\.$/, ".")}`;
    // As the daemon (U-061): a cancel is undone by reopening, a creation by cancelling.
    const after = (entry.after ?? {}) as {
      task_id?: string;
      status?: string;
      title?: string;
      note_id?: string;
      without_answers_note_id?: string;
      withdrawn_requests?: string[];
      set_aside?: boolean;
    };
    const task = state.tasks.find((t) => t.id === after.task_id);
    const words = (s: string) =>
      ({
        draft: "a draft",
        ready: "ready",
        needs_human: "paused",
        failed: "failed",
        done: "done",
        cancelled: "cancelled",
        in_review: "being reviewed",
      })[s] ?? s;
    const isMove = ["task.transition", "task.pause", "task.resume", "task.reopen"].includes(
      first?.name ?? "",
    );
    if (isMove && task && typeof before?.status === "string") {
      // As the daemon's `restoreStatus`: the status before the move, with its reason, who set
      // it and the retry count; an agent's own status (running, being reviewed) comes back as
      // ready. The cards the move withdrew are open again.
      const was = before as { reason?: unknown; paused_by_person?: unknown; attempt?: unknown };
      const previous = ["claimed", "in_progress", "in_review"].includes(before.status)
        ? "ready"
        : before.status;
      task.status = previous;
      if (typeof was.reason === "string") task.reason = was.reason;
      if (previous === "failed" && typeof was.attempt === "number") task.attempt = was.attempt;
      const byPerson =
        typeof was.paused_by_person === "boolean"
          ? was.paused_by_person
          : previous === "needs_human";
      if (previous === "needs_human" && byPerson) state.taskMeta.pausedByPerson.add(task.id);
      else state.taskMeta.pausedByPerson.delete(task.id);
      task.version += 1;
      const cards = after.withdrawn_requests ?? [];
      for (const r of state.requests)
        if (cards.includes(r.id) && r.status === "withdrawn") r.status = "open";
      if (cards.length) emit("inbox.changed", { blockingCount: blockingCount() });
      const again =
        previous === "needs_human" && cards.length
          ? "needs your answer again"
          : previous === "failed"
            ? "is marked failed again"
            : `is ${words(previous)} again`;
      const back = !cards.length
        ? ""
        : cards.length === 1
          ? "its card is back in the Inbox"
          : `its ${cards.length} cards are back in the Inbox`;
      sentence =
        after.status === "cancelled"
          ? `Undone: reopened the task "${task.title}"; it ${again}${back ? ` and ${back}` : ""}.`
          : `Undone: the task "${task.title}" ${again}${back ? `; ${back}` : ""}.`;
      // As the daemon (phase C): the undo of a cancel that set a run's work aside puts it back.
      if (after.set_aside)
        sentence += ["claimed", "in_progress", "in_review"].includes(before.status)
          ? " What it changed is back in the folder."
          : " Its work so far is back.";
    }
    if (first?.name === "task.update" && task) {
      const fields = ((before as { fields?: Record<string, unknown> } | null)?.fields ??
        {}) as Partial<TaskView> & { budgetUsdMicro?: number };
      const { budgetUsdMicro, ...rest } = fields;
      Object.assign(task, rest);
      if (budgetUsdMicro !== undefined) task.budget = money(budgetUsdMicro);
      task.version += 1;
      sentence = `Undone: "${task.title}" is as it was.`;
    }
    if (first?.name === "task.dependencies" && task) {
      task.dependsOn = ((before as { depends_on?: string[] } | null)?.depends_on ?? []).slice();
      task.version += 1;
      sentence = `Undone: "${task.title}" waits for what it waited for before.`;
    }
    for (const id of [after.note_id, after.without_answers_note_id]) {
      const note = state.queue.find((q) => q.id === id);
      if (note?.status === "queued") note.status = "dismissed";
    }
    if (task) emit("project.changed", { id: task.projectId });
    if (first?.name === "task.create" && task) {
      task.status = "cancelled";
      task.version += 1;
      sentence = `Undone: cancelled the task "${task.title}" you created.`;
    }
    entry.undoState = "undone";
    entry.undoneAt = now;
    entry.undoable = false;
    entry.version += 1;
    const undoRow: ChangeLogView = {
      ...entry,
      id: nextId("chg"),
      commands: [{ name: "undo", params: { of: entry.id } }],
      before: entry.after,
      after: entry.before,
      undoState: "irreversible",
      undoneAt: null,
      undoable: false,
      wordsUsed: "undo",
      source: "ui",
      sentence,
      createdAt: now,
      version: 1,
    };
    state.changes.unshift(undoRow);
    return {
      status: "done",
      sentence,
      changeLogId: undoRow.id,
      undoToken: null,
      card: null,
      commands: ["undo"],
    };
  };

  app.get("/projects/:id/queue", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const status = c.req.query("status");
    return c.json(
      state.queue
        .filter((q) => q.projectId === id && (!status || q.status === status))
        .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt)),
    );
  });
  app.post("/projects/:id/queue", async (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const body = (await c.req.json()) as { kind?: string; text?: string; priority?: number };
    if (
      !body.text?.trim() ||
      !["note", "task", "correction", "idea", "voice_note"].includes(body.kind ?? "")
    ) {
      return errorBody(c, 400, "validation", "kind and text are required");
    }
    const item: QueueItemView = {
      id: nextId("q"),
      projectId: id,
      humanId: ME.id,
      kind: body.kind as QueueItemView["kind"],
      text: body.text.trim(),
      priority: body.priority ?? 0,
      status: "queued",
      consumedBySession: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    state.queue.unshift(item);
    return c.json(item, 201);
  });
  app.post("/queue/:id/dismiss", (c) => {
    const item = state.queue.find((q) => q.id === c.req.param("id"));
    if (!item) return errorBody(c, 404, "not_found", "no such queue item");
    item.status = "dismissed";
    item.version += 1;
    return c.json(item);
  });

  app.get("/projects/:id/milestones", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    return c.json(state.milestones.filter((m) => m.projectId === id));
  });
  // Spec B.5: a milestone change needs the reason and the version; the daemon answers a
  // missing reason or a stale version as 409 conflict and records the human as author.
  app.post("/milestones/:id", async (c) => {
    const m = state.milestones.find((x) => x.id === c.req.param("id"));
    if (!m) return errorBody(c, 404, "not_found", "no such milestone");
    const parsed = ChangeMilestoneBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 409, "conflict", parsed.error.message);
    if (parsed.data.version !== m.version) {
      return errorBody(c, 409, "conflict", "milestone changed since you loaded it");
    }
    const { reason, name, successCriteria, targetDate, status } = parsed.data;
    if (name !== undefined) m.name = name;
    if (successCriteria !== undefined) m.successCriteria = successCriteria;
    if (targetDate !== undefined) m.targetDate = targetDate;
    if (status !== undefined) m.status = status;
    m.reason = reason;
    m.authorHuman = ME.id;
    m.authorAgent = null;
    m.version += 1;
    m.updatedAt = new Date().toISOString();
    return c.json(m);
  });

  // The setup assistant (ADR 0092), mirroring packages/runtime/src/setup/routes.ts: a key is
  // "valid" unless it contains "bad"; a value pasted in the wrong step is refused with 400.
  const setup: SetupStatusView = {
    complete: true,
    showAssistant: false,
    name: me.name,
    timezone: me.timezone,
    credentials: { github: true, anthropicApiKey: true, subscription: false },
    restartNeeded: false,
    links: {
      anthropicKeys: "https://console.anthropic.com/settings/keys",
      githubToken: "https://github.com/settings/personal-access-tokens/new?name=Forerunner",
    },
    githubPermissions: ["Contents: read and write", "Commit statuses: read (to see CI results)"],
    ...options.setup,
  };
  // Each harness gets its own copy: the routes below change it, and a test's fixture is shared.
  setup.credentials = { ...setup.credentials };
  const setupComplete = () => {
    const c = setup.credentials;
    setup.complete = c.github && (c.anthropicApiKey || c.subscription);
  };
  // As the daemon (U-049): a replaced key is read per call, so only a credential this process
  // started without needs the restart.
  const setupStartedWith = { ...setup.credentials };
  const setupRestartNeeded = () => {
    const c = setup.credentials;
    setup.restartNeeded =
      (c.github && !setupStartedWith.github) ||
      (c.anthropicApiKey && !setupStartedWith.anthropicApiKey) ||
      (c.subscription && !setupStartedWith.subscription);
  };
  app.get("/setup", (c) => c.json(setup));
  app.post("/setup/profile", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; timezone?: string };
    if (body.timezone === "Mars/Olympus") {
      return errorBody(c, 400, "validation", `unknown time zone: ${body.timezone}`);
    }
    if (body.name) setup.name = body.name;
    if (body.timezone) setup.timezone = body.timezone;
    // As the daemon: the human row too, so `/me` names the person so (Settings → Your name).
    if (body.name) me.name = body.name;
    if (body.timezone) me.timezone = body.timezone;
    return c.json(setup);
  });
  app.post("/setup/anthropic", async (c) => {
    const { value = "" } = (await c.req.json().catch(() => ({}))) as { value?: string };
    if (value.startsWith("github_pat_")) {
      return errorBody(
        c,
        400,
        "validation",
        "This is a GitHub token. Paste it in the GitHub step.",
      );
    }
    const subscription = value.startsWith("sk-ant-oat");
    const ok = !value.includes("bad");
    if (ok) {
      if (subscription) setup.credentials.subscription = true;
      else setup.credentials.anthropicApiKey = true;
      setupRestartNeeded();
      setupComplete();
      endRefusal(subscription ? "subscription" : "api_key");
    }
    return c.json({
      ok,
      kind: subscription ? "subscription" : "api_key",
      summary: ok ? "Key works; 12 models visible." : "Anthropic rejected the key (401).",
      problems: ok ? [] : ["The key is invalid or revoked."],
      status: setup,
    });
  });
  /**
   * As the daemon's `RuntimeApp.billing.waits.credentialSaved` (U-078): a new key or sign-in ends
   * its refusal at once. Settings no longer reads Refused, the refused card is closed ("A new one
   * is saved; ..."), and the work that waited for it starts by itself: a plan that waited is
   * drafted again, the tasks' rows lose their wait.
   */
  const endRefusal = (kind: BillingOrderKind) => {
    for (const s of billingSources)
      if (s.kind === kind && s.blocked === "refused") {
        s.blocked = null;
        s.usable = true;
      }
    let closed = false;
    for (const r of state.requests) {
      const card = (r.changeCard ?? {}) as { key?: unknown; credential_kind?: unknown };
      if (r.status !== "open" || card.key !== "credential:refused") continue;
      if ((card.credential_kind ?? "api_key") !== kind) continue;
      r.status = "withdrawn";
      closed = true;
    }
    if (closed) emit("inbox.changed", { blockingCount: blockingCount() });
    for (const [id, intake] of Object.entries(state.intake))
      if (intake.state === "waiting" && intake.wait?.reason === "refused") {
        state.intake[id] = { ...intake, state: "drafting", error: null, wait: null };
        emit("project.changed", { id });
      }
    for (const [projectId, wait] of [...state.taskMeta.credentialWaits])
      if (wait.save) {
        state.taskMeta.credentialWaits.delete(projectId);
        emit("project.changed", { id: projectId });
      }
  };
  app.post("/setup/github", async (c) => {
    const { token: pasted = "" } = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (pasted.startsWith("sk-ant-")) {
      return errorBody(
        c,
        400,
        "validation",
        "This is an Anthropic credential. Paste it in the Claude step.",
      );
    }
    const ok = !pasted.includes("bad");
    if (ok) {
      setup.credentials.github = true;
      setupRestartNeeded();
      setupComplete();
    }
    // As the daemon (U-051): the repositories the token reaches with their access; a token
    // with "none" in it reaches none, one with "readonly" only reads, and each is warned about.
    const repos: { fullName: string; access: "admin" | "write" | "read" }[] = pasted.includes(
      "none",
    )
      ? []
      : pasted.includes("readonly")
        ? [{ fullName: "joel/site", access: "read" }]
        : [
            { fullName: "joel/site", access: "write" },
            { fullName: "joel/notes", access: "read" },
          ];
    const warnings =
      repos.length === 0
        ? [
            "The token reaches no repository. On GitHub, edit the token: under Repository access choose Only select repositories, pick the ones your agent may work in, and give them Contents: Read and write.",
          ]
        : repos.every((r) => r.access === "read")
          ? [
              "The token can only read every repository it reaches: your agent cannot push branches or open pull requests. On GitHub, give the token Contents: Read and write and Pull requests: Read and write.",
            ]
          : repos
              .filter((r) => r.access === "read")
              .map(
                (r) =>
                  `${r.fullName}: read only. Your agent cannot push there; give the token Contents: Read and write on it, or leave it out.`,
              );
    return c.json({
      ok,
      kind: "github",
      summary: ok
        ? `Token works for joel.${repos.length ? ` It reaches ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}.` : " It reaches no repository."}`
        : "GitHub rejected the token (401).",
      problems: ok ? warnings : ["The token is invalid, expired or revoked."],
      ...(ok ? { login: "joel", repos } : {}),
      status: setup,
    });
  });
  // Settings -> Claude subscription allowance (U-052), mirroring
  // packages/runtime/src/setup/plan-allowance-routes.ts: CHF in, USD stored at the day's rate.
  const allowanceRate = 0.8;
  const allowance = {
    usdMonthly: 50,
    origin: "default",
    overridden: options.planAllowanceOverridden ?? false,
  };
  const allowanceView = () => ({
    subscription: setup.credentials.subscription,
    usdMonthly: allowance.usdMonthly,
    chfMonthly: Math.round(allowance.usdMonthly * allowanceRate * 100) / 100,
    chfPerUsd: allowanceRate,
    origin: allowance.overridden ? "env" : allowance.origin,
    overridden: allowance.overridden,
    stopShare: 0.95,
  });
  app.get("/settings/plan-allowance", (c) => c.json(allowanceView()));
  app.post("/settings/plan-allowance", async (c) => {
    const { chfMonthly } = (await c.req.json().catch(() => ({}))) as { chfMonthly?: unknown };
    if (typeof chfMonthly !== "number" || !(chfMonthly > 0) || chfMonthly > 100_000) {
      return errorBody(
        c,
        400,
        "validation",
        "Enter the allowance as a positive amount of CHF per month, e.g. 160.",
      );
    }
    if (allowance.overridden) {
      return errorBody(
        c,
        409,
        "validation",
        "FORERUNNER_PLAN_USD_MONTHLY is set on this computer and decides the allowance; remove it to set the allowance here.",
      );
    }
    allowance.usdMonthly = Math.round((chfMonthly / allowanceRate) * 100) / 100;
    allowance.origin = "config";
    return c.json(allowanceView());
  });
  // Settings -> Claude: which to use first (U-078), mirroring
  // packages/runtime/src/daemon/billing-order-routes.ts: the rows in the person's order (else
  // the task runs' default, subscription first), the order stored through settings.set (a
  // change log row with Undo), each kind once.
  const KIND_NAMES: Record<BillingOrderKind, string> = {
    subscription: "Claude subscription",
    api_key: "API key",
    plan_credits: "Plan credits",
  };
  // The saved credentials: both by default; only the API key on an install without web access
  // (no subscription, ADR 0107), only the subscription with `subscriptionOnly`.
  const defaultSources: Partial<BillingOrderSourceView>[] = options.noWebAccess
    ? [{ kind: "api_key" }]
    : options.subscriptionOnly
      ? [{ kind: "subscription" }]
      : [{ kind: "subscription" }, { kind: "api_key" }];
  const billingSources: BillingOrderSourceView[] = (
    options.billingOrder?.sources ?? defaultSources
  ).map((s, i) => {
    const kind = s.kind ?? "api_key";
    return {
      id: `bs_${kind}_${i}`,
      kind,
      name: KIND_NAMES[kind],
      via: kind === "subscription" ? "claude_code" : "api",
      usable: true,
      blocked: null,
      restingUntil: null,
      planShare: kind === "subscription" ? 0 : null,
      planShareCap: kind === "subscription" ? 0.95 : null,
      monthSpent: { usdMicro: 0, chfMicro: 0 },
      monthlyCap: null,
      ...s,
    };
  });
  let billingOrder: BillingOrderKind[] | null = options.billingOrder?.order ?? null;
  const BILLING_DEFAULT_ORDER: BillingOrderKind[] = ["subscription", "plan_credits", "api_key"];
  const billingOrderView = (): BillingOrderView => {
    const order = billingOrder ?? BILLING_DEFAULT_ORDER;
    const rank = (k: BillingOrderKind) => {
      const i = order.indexOf(k);
      return i >= 0 ? i : order.length + BILLING_DEFAULT_ORDER.indexOf(k);
    };
    return {
      chosen: billingOrder !== null,
      order: [...order],
      sources: [...billingSources].sort((a, b) => rank(a.kind) - rank(b.kind)),
      startedWith: options.startedWith ?? null,
    };
  };
  // The credential chooser (U-078) with the runtime's own functions: the saved credentials in
  // the person's order, what this install offers each, and the registry entries' tools.
  const chooserFactsNow = (): ChooserFacts => ({
    ...DEFAULT_CHOOSER_FACTS,
    webFetch: !options.noWebAccess,
    // 'sites': as the daemon's chooserFacts, the page reader runs on the subscription too.
    subscriptionPages: !options.noWebAccess,
    ...(options.chooserFacts ?? {}),
  });
  const savedKinds = () =>
    billingOrderView()
      .sources.filter((s) => s.blocked !== "no_credential" && s.blocked !== "disabled")
      .map((s) => s.kind);
  const runsOnFor = (
    name: string,
    projectId: string | null,
    task: { title: string; outcome: string; acceptance_criteria: readonly string[] } | null,
  ) =>
    credentialChoiceFor({
      kindsInOrder: savedKinds(),
      needs: needsOf({
        registryTools: FAKE_REGISTRY_TOOLS[name] ?? [],
        task,
        codeCommands: codeCommandsOf(state.settingValues[CODE_COMMANDS_SETTING]),
      }),
      facts: chooserFactsNow(),
      specialist: name,
      dependencies: projectId !== null && (options.projectDependencies ?? []).includes(projectId),
    });
  const ORDER_WORDS: Record<BillingOrderKind, string> = {
    subscription: "the Claude subscription",
    api_key: "the API key",
    plan_credits: "the plan credits",
  };
  const orderWords = (o: BillingOrderKind[] | null) =>
    o ? o.map((k) => ORDER_WORDS[k]).join(", then ") : "not chosen (the defaults)";
  app.get("/settings/billing-order", (c) => c.json(billingOrderView()));
  app.post("/settings/billing-order", async (c) => {
    const { order } = (await c.req.json().catch(() => ({}))) as { order?: unknown };
    const kinds = ["subscription", "api_key", "plan_credits"];
    const valid =
      Array.isArray(order) &&
      order.length >= 1 &&
      order.length <= 3 &&
      order.every((k) => typeof k === "string" && kinds.includes(k)) &&
      new Set(order).size === order.length;
    if (!valid) {
      return errorBody(
        c,
        400,
        "validation",
        "Give the order as a list of your credentials, each once: subscription, api_key, plan_credits.",
      );
    }
    const next = order as BillingOrderKind[];
    pushChange({
      commands: [{ name: "settings.set", params: { key: "billing_order", value: next } }],
      before: { key: "billing_order", project_id: null, value: billingOrder },
      after: { key: "billing_order", project_id: null, value: next },
      scope: "global",
      projectId: null,
      source: "ui",
      wordsUsed: `Settings: use ${next.join(", then ")} first`,
      sentence: `Set which Claude credential is used first from ${orderWords(billingOrder)} to ${orderWords(next)}: every model call uses them in this order, and when one cannot be used the next one is. Undo.`,
      reversible: true,
    });
    billingOrder = next;
    return c.json(billingOrderView());
  });
  // The mailbox passwords and cloud voice keys typed in the app (U-054), mirroring
  // packages/runtime/src/secrets/store-routes.ts: an allowlist, the value kept here for the
  // tests to read (`state.storedSecrets`), never sent back.
  app.get("/secrets/store", (c) => {
    const asked = c.req.queries("name") ?? [];
    const names = [
      ...new Set([
        ...STORABLE_SECRET_NAMES,
        ...asked.filter((n) => isStorableSecretName(n) && !n.startsWith("forerunner.")),
      ]),
    ];
    return c.json({
      secrets: names.map((name) => ({
        name,
        label: storableSecretInfo(name).label,
        stored: state.storedSecrets.has(name),
      })),
    });
  });
  app.post("/secrets/store", async (c) => {
    const { name = "", value = "" } = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      value?: string;
    };
    if (name.startsWith("forerunner.") || !isStorableSecretName(name)) {
      return errorBody(c, 400, "validation", `"${name}" is not a secret the app stores.`);
    }
    const v = value.trim();
    if (!v) return errorBody(c, 400, "validation", "The value is empty.");
    if (/[\r\n]/.test(v)) {
      return errorBody(
        c,
        400,
        "validation",
        "It has a line break inside, so it was not saved. Copy it again in one piece and paste it.",
      );
    }
    state.storedSecrets.set(name, v);
    return c.json({ name, stored: true, ref: `secret:${name}` });
  });
  app.post("/setup/finish", (c) => {
    const restarting = setup.restartNeeded;
    setup.showAssistant = false;
    setup.restartNeeded = false;
    // The restarted daemon starts with what the vault holds now.
    Object.assign(setupStartedWith, setup.credentials);
    return c.json({ status: setup, restarting });
  });

  // Settings -> Devices (spec R.2): the daemon's /devices routes, mirroring
  // packages/runtime/src/devices: the list with this install marked, a pairing (503 without
  // a state service), the revocation (400 for this install's own device, 404 unknown).
  const pairingAvailable = options.pairingAvailable ?? true;
  // While pairing is off (no service address here), what it needs (U-055); a token stored
  // through `POST /secrets/store` shows as saved, as on the daemon.
  app.get("/devices", (c) => {
    const tokenSaved = state.storedSecrets.has("state_api_admin");
    const ready = pairingAvailable;
    return c.json({
      devices: state.devices,
      pairingAvailable: ready,
      ...(ready
        ? {}
        : {
            pairingSetup: {
              serviceUrl: null,
              adminSecretName: "state_api_admin",
              adminSecretStored: tokenSaved,
              guideUrl:
                "https://github.com/joelwellbournewood/Forerunner/blob/HEAD/docs/setup-guide.md#what-to-set-up-first-the-shared-state-service",
            },
          }),
    });
  });
  app.post("/devices/pairing", async (c) => {
    if (!pairingAvailable) {
      return c.json(
        {
          code: "unavailable",
          message:
            "Pairing needs Forerunner's shared state service, and this computer does not know where it is. Put the service's address in the environment variable FORERUNNER_STATE_API_URL (a setting of your user account that Forerunner reads when it starts), start Forerunner again and save the service's admin token; Settings → Devices lists the steps.",
        },
        503,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string };
    if (body.kind !== undefined && body.kind !== "phone" && body.kind !== "web") {
      return errorBody(c, 400, "validation", "invalid request body");
    }
    state.pairings++;
    const issuedAt = options.now?.() ?? Date.now();
    return c.json(
      {
        ...PAIRING,
        ...options.pairing,
        kind: body.kind ?? "phone",
        expiresAt: new Date(issuedAt + 10 * 60_000).toISOString(),
      },
      201,
    );
  });
  app.post("/devices/:id/revoke", (c) => {
    const d = state.devices.find((x) => x.id === c.req.param("id"));
    if (!d) return errorBody(c, 404, "not_found", "device not found");
    if (d.current) {
      return errorBody(
        c,
        400,
        "validation",
        "this is the device the app runs on; revoke it from another device",
      );
    }
    if (!d.revoked) {
      d.revoked = true;
      d.revokedAt = "2026-10-23T09:01:00.000Z";
      d.version++;
    }
    return c.json(
      options.revokeServiceError
        ? { device: d, tokensRevoked: null, via: "store", serviceError: options.revokeServiceError }
        : { device: d, tokensRevoked: 1, via: "service", serviceError: null },
    );
  });

  // Source discovery (spec A.4): the daemon's /sources routes. A scan of a fresh source
  // finds two repositories or folders named after the locator, one an existing install; a
  // scan of the fixture source is idempotent; accepting a proposal creates a project card.
  const summarise = (sourceId: string) => {
    const rows = state.sourceCandidates.filter((c) => c.sourceId === sourceId);
    const s = { total: rows.length, proposed: 0, accepted: 0, duplicate: 0, gone: 0, installs: 0 };
    for (const c of rows) {
      s[c.status]++;
      if (c.existingInstall) s.installs++;
    }
    return s;
  };
  const sourceWithCounts = (src: SourceView): SourceView => ({
    ...src,
    candidates: summarise(src.id),
  });
  app.get("/sources", (c) => c.json(state.sources.map(sourceWithCounts)));
  app.post("/sources", async (c) => {
    const body = (await c.req.json()) as {
      kind?: string;
      locator?: string;
      displayName?: string;
      credentialRef?: string;
    };
    if (!body.kind || !body.locator?.trim()) {
      return errorBody(c, 400, "validation", "kind and locator are required");
    }
    if (body.kind === "gitlab" || body.kind === "git_remote") {
      return errorBody(c, 400, "not_supported", `${body.kind} sources come later`);
    }
    const github = body.kind !== "local_folder";
    const ref = github ? body.credentialRef?.trim() || "secret:github_token" : null;
    if (ref !== null && !ref.startsWith("secret:")) {
      return errorBody(
        c,
        400,
        "validation",
        "a GitHub source needs a secret reference of the form secret:<name>; a token value is never stored",
      );
    }
    if (state.sources.some((s) => s.kind === body.kind && s.locator === body.locator?.trim())) {
      return errorBody(c, 409, "conflict", `${body.kind} ${body.locator} is already connected`);
    }
    const now = new Date().toISOString();
    const empty = { total: 0, proposed: 0, accepted: 0, duplicate: 0, gone: 0, installs: 0 };
    const view: SourceView = {
      id: nextId("src"),
      kind: body.kind as SourceView["kind"],
      displayName: body.displayName?.trim() || body.locator.trim(),
      locator: body.locator.trim(),
      credentialRef: ref,
      status: "connected",
      lastScanAt: null,
      scanSummary: null,
      error: null,
      candidates: empty,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    state.sources.push(view);
    return c.json(view, 201);
  });
  app.post("/sources/candidates/:id/accept", async (c) => {
    const cand = state.sourceCandidates.find((x) => x.id === c.req.param("id"));
    if (!cand) return errorBody(c, 404, "not_found", "no such candidate");
    if (cand.status !== "proposed") {
      return errorBody(c, 409, "conflict", `${cand.locator} is ${cand.status}`);
    }
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; goal?: string };
    const name = body.name?.trim() || cand.proposedName;
    const project: ProjectCard = {
      ...clone(PROJECTS[0] as ProjectCard),
      id: nextId("proj"),
      name,
      goal: body.goal?.trim() || `Project from the repository ${cand.locator}`,
      stage: "planning",
      health: "idle",
      waitingOnYou: 0,
      lastSessionAt: null,
    };
    state.projects.push(project);
    cand.status = "accepted";
    cand.projectId = project.id;
    cand.version += 1;
    emit("project.changed", { id: project.id });
    return c.json({ candidate: cand, project: { id: project.id, name } }, 201);
  });
  app.get("/sources/:id", (c) => {
    const src = state.sources.find((s) => s.id === c.req.param("id"));
    return src ? c.json(sourceWithCounts(src)) : errorBody(c, 404, "not_found", "no such source");
  });
  app.post("/sources/:id/scan", (c) => {
    const src = state.sources.find((s) => s.id === c.req.param("id"));
    if (!src) return errorBody(c, 404, "not_found", "no such source");
    const now = new Date().toISOString();
    if (!state.sourceCandidates.some((x) => x.sourceId === src.id)) {
      const folder = src.kind === "local_folder";
      for (const [name, install] of [
        ["one", false],
        ["two", true],
      ] as const) {
        state.sourceCandidates.push({
          id: nextId("cand"),
          sourceId: src.id,
          kind: folder ? "folder" : "repo",
          name,
          locator: `${src.locator}/${name}`,
          key: folder
            ? `folder:${src.locator}/${name}`
            : `github:${src.locator.toLowerCase()}/${name}`,
          proposedName: name,
          status: "proposed",
          existingInstall: install,
          installMarker: install ? ".forerunner/project.json" : null,
          projectId: null,
          isGit: true,
          details: {},
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
      }
    }
    src.lastScanAt = now;
    src.scanSummary = summarise(src.id);
    src.updatedAt = now;
    src.version += 1;
    const candidates = state.sourceCandidates.filter((x) => x.sourceId === src.id);
    return c.json({ source: sourceWithCounts(src), candidates, summary: src.scanSummary });
  });
  app.get("/sources/:id/candidates", (c) => {
    const src = state.sources.find((s) => s.id === c.req.param("id"));
    if (!src) return errorBody(c, 404, "not_found", "no such source");
    const status = c.req.query("status");
    return c.json(
      state.sourceCandidates.filter(
        (x) => x.sourceId === src.id && (!status || x.status === status),
      ),
    );
  });
  app.delete("/sources/:id", (c) => {
    const src = state.sources.find((s) => s.id === c.req.param("id"));
    if (!src) return errorBody(c, 404, "not_found", "no such source");
    const n = state.sourceCandidates.filter((x) => x.sourceId === src.id).length;
    state.sourceCandidates = state.sourceCandidates.filter((x) => x.sourceId !== src.id);
    state.sources = state.sources.filter((s) => s.id !== src.id);
    return c.json({ ok: true, id: src.id, candidatesRemoved: n });
  });

  app.get("/projects/:id/data", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    return c.json(state.dataAssets.filter((a) => a.projectIds.includes(id)));
  });
  app.post("/projects/:id/data", async (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const body = (await c.req.json()) as { locator?: string; kind?: string };
    if (!body.locator?.trim() || !body.kind?.trim()) {
      return errorBody(c, 400, "validation", "locator and kind are required");
    }
    const asset: DataAssetView = {
      id: nextId("da"),
      projectIds: [id],
      locator: body.locator.trim(),
      name: body.locator.trim().split(/[\\/]/).pop() ?? body.locator.trim(),
      sizeBytes: 0,
      kind: body.kind.trim(),
      ownerDeviceId: null,
      sample: null,
      registeredBy: ME.id,
      createdAt: new Date().toISOString(),
    };
    state.dataAssets.unshift(asset);
    return c.json(asset, 201);
  });
  app.delete("/data/:id", (c) => {
    const asset = state.dataAssets.find((a) => a.id === c.req.param("id"));
    if (!asset) return errorBody(c, 404, "not_found", "no such data asset");
    state.dataAssets = state.dataAssets.filter((a) => a.id !== asset.id);
    return c.json({ ok: true });
  });
  // The daemon's import (`POST /projects/:id/data/import`, U-006), answered in its own schema so
  // the two cannot drift: a github source on a migration branch, a zip or folder copied in.
  app.post("/projects/:id/data/import", async (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const body = (await c.req.json()) as { source?: string; locator?: string; path?: string };
    const locator = (body.path ?? body.locator ?? "").trim();
    if (!locator || !["zip", "folder", "github"].includes(body.source ?? "")) {
      return errorBody(c, 400, "validation", "source and path or locator are required");
    }
    if (body.source === "github") {
      const slug = locator.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
      return c.json(
        ImportResultView.parse({
          source: "github",
          projectId: id,
          destination: `/data/projects/${id}/repos/${slug}`,
          imported: [],
          skipped: [],
          totalBytes: 0,
          entryCount: 1,
          gitignore: null,
          note: null,
          repository: {
            slug,
            url: `https://example.test/${slug}.git`,
            worktree: `/data/projects/${id}/repos/${slug}`,
            branch: "forerunner/migration-2026-10-30",
            defaultBranch: "main",
            headSha: "0123456789abcdef0123456789abcdef01234567",
            assetId: null,
            reused: false,
          },
        }),
      );
    }
    return c.json(
      ImportResultView.parse({
        source: body.source,
        projectId: id,
        destination: `/data/projects/${id}/data`,
        imported: [{ rel: "site/index.html", sizeBytes: 1200, assetId: null }],
        skipped: [],
        totalBytes: 1200,
        entryCount: 1,
        gitignore: null,
        note: null,
        repository: null,
      }),
    );
  });

  app.get("/projects/:id/docs", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    return c.json(state.docs[id] ?? []);
  });
  app.get("/projects/:id/docs/:path", (c) => {
    const doc = DOC_CONTENTS[c.req.param("path")];
    return doc ? c.json(doc) : errorBody(c, 404, "not_found", "no such doc");
  });
  // The Files tab (design §3.10), as the daemon's docs-routes.ts answers it: the folder and
  // its files with every folder on their path, and one file's text; a path that leaves the
  // folder is 404.
  // A repository project's pull requests that wait for the person (ADR 0106), as the daemon's
  // docs-routes.ts answers them: the repository with its page and the waiting PRs (each with
  // who checked it, `review`: critic, you, none, or null for Forerunner's docs PRs), or the
  // host's error in words; no repository answers repository null.
  app.get("/projects/:id/pull-requests", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 404, "not_found", "no such project");
    const repository = repositoryOf(project.repos);
    const prs = state.pullRequests[id];
    state.pullRequestReads[id] = (state.pullRequestReads[id] ?? 0) + 1;
    // merge-in-app: a Merge pressed in the app shows "merging" for a read, then the rows are
    // gone (merged, as GitHub lists open pull requests only) or carry the outcome's sentence.
    const merging = state.pullRequestMerges[id] ?? [];
    if (prs)
      for (const m of [...merging]) {
        if (m.reads > 0) {
          m.reads -= 1;
          continue;
        }
        merging.splice(merging.indexOf(m), 1);
        const row = prs.waiting.find((r) => r.number === m.number);
        if (!row) continue;
        const outcome = state.pullRequestMergeOutcome;
        if (outcome?.state === "waiting_checks") {
          // The first one's checks run; each later one waits its turn behind it (not merging).
          row.merge = {
            state: "waiting_checks",
            canMerge: false,
            sentence: m.after.length
              ? mergesAfterSentence(m.number, m.after, m.after.slice(0, 1))
              : `#${m.number} merges when its checks pass.`,
            first: m.after,
          };
        } else if (outcome)
          row.merge = {
            state: outcome.state,
            canMerge: outcome.state === "left_to_you",
            sentence: outcome.sentence,
            first: [],
          };
        else prs.waiting = prs.waiting.filter((r) => r.number !== m.number);
      }
    const mode = mergeModeOfFake(id);
    return c.json({
      repository,
      waiting: repository ? (prs?.waiting ?? []) : [],
      error: repository ? (prs?.error ?? null) : null,
      errorKind: repository ? (prs?.errorKind ?? null) : null,
      mode: { key: mode, label: MERGE_MODE_WORDS[mode] },
    });
  });
  // The person's Merge on the Overview (merge-in-app), as the daemon answers it: at once, the
  // pull requests it builds on first; a row that offers no Merge is refused with its sentence.
  app.post("/projects/:id/pull-requests/:number/merge", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 403, "forbidden", "not your project");
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0)
      return errorBody(c, 400, "validation", "not a pull request number");
    const prs = state.pullRequests[id];
    const row = prs?.waiting.find((r) => r.number === number);
    if (!prs || !row)
      return c.json({
        state: "refused",
        sentence: `#${number} does not wait to be merged: it may be merged or closed already.`,
        order: [],
      });
    if (row.merge && !row.merge.canMerge)
      return c.json({
        state: "refused",
        sentence: row.merge.sentence ?? `#${number} cannot be merged here: merge it on GitHub.`,
        order: [],
      });
    const order = [...(row.merge?.first ?? []), number];
    const merging = state.pullRequestMerges[id] ?? [];
    state.pullRequestMerges[id] = merging;
    for (const [i, n] of order.entries()) {
      const r = prs.waiting.find((w) => w.number === n);
      if (!r) continue;
      r.merge = { state: "merging", canMerge: false, sentence: null, first: [] };
      merging.push({ number: n, reads: 1, after: order.slice(0, i) });
    }
    const names = order.map((n) => `#${n}`);
    const list =
      names.length <= 1
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return c.json({
      state: "queued",
      sentence: order.length > 1 ? `Merging ${list} in order.` : `Merging ${list}.`,
      order,
    });
  });
  // "Open this version" (merged-actions), as the daemon's `ProjectPullRequests.preview` answers
  // it: a waiting pull request's folder beside the copy, replacing the project's earlier
  // preview; the row then carries it (`preview`). A pull request that does not wait is refused.
  app.post("/projects/:id/pull-requests/:number/preview", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 403, "forbidden", "not your project");
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0)
      return errorBody(c, 400, "validation", "not a pull request number");
    const prs = state.pullRequests[id];
    const row = prs?.waiting.find((r) => r.number === number);
    if (!prs || !row)
      return c.json({
        state: "refused",
        sentence: `#${number} does not wait to be merged: it may be merged or closed already.`,
        folder: null,
        number,
      });
    const folder = `/home/you/.forerunner/worktrees/docs/previews/${id}/pr-${number}`;
    const sentence = `#${number} as it would be merged. Changes here are not kept.`;
    for (const r of prs.waiting) delete r.preview;
    row.preview = { folder, sentence };
    return c.json({ state: "ready", sentence, folder, number });
  });
  app.get("/projects/:id/files", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id))
      return errorBody(c, 404, "not_found", "no such project");
    const folder = state.folders[id] ?? null;
    const files = folder ? (state.files[id] ?? []) : [];
    const dirs = new Map<string, string>();
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!dirs.has(dir) || (dirs.get(dir) ?? "") < f.updatedAt) dirs.set(dir, f.updatedAt);
      }
    }
    const entries = [
      ...[...dirs].map(([path, updatedAt]) => ({
        path,
        kind: "dir" as const,
        sizeBytes: 0,
        updatedAt,
      })),
      ...files.map((f) => ({
        path: f.path,
        kind: "file" as const,
        sizeBytes: f.content?.length ?? 2048,
        updatedAt: f.updatedAt,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    // merged-copy: a repository project's copy, as the daemon's `ProjectDocs.copyView` says it.
    return c.json({ folder, entries, truncated: false, copy: state.copies[id] ?? null });
  });
  app.get("/projects/:id/files/:path", (c) => {
    const id = c.req.param("id");
    const rel = c.req.param("path");
    const f = (state.folders[id] ? (state.files[id] ?? []) : []).find((x) => x.path === rel);
    if (!f) return errorBody(c, 404, "not_found", `${rel} is not a file of this project`);
    return c.json({
      path: f.path,
      content: f.content,
      sizeBytes: f.content?.length ?? 2048,
      updatedAt: f.updatedAt,
      binary: f.content === null,
      truncated: false,
    });
  });

  // The daemon's `GET /performance` (runtime daemon/views.ts `performanceView`): the fixture in
  // the runtime shape, with the window and the project of the query; a bad `days` is 400 and an
  // unknown project 404, as the daemon answers.
  app.get("/performance", (c) => {
    const raw = c.req.query("days");
    // Decimal digits only, as the daemon parses it.
    const days =
      raw === undefined || raw === "" ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(days) || days < 1) {
      return errorBody(c, 400, "validation", "days must be a positive integer");
    }
    const projectId = c.req.query("projectId") || null;
    if (projectId && !state.projects.some((p) => p.id === projectId)) {
      return errorBody(c, 404, "not_found", `project ${projectId} not found`);
    }
    const window = Math.min(days, 90);
    const generated = Date.parse(PERFORMANCE.generatedAt);
    // The project's speed-versus-quality slider shifts each mode it reaches one step from its
    // base (the table's, or the principal's D.4 override), held at the registry cap
    // (`maxEffort`), as the daemon's view computes the effort in force.
    const offset = projectId ? (state.speedQuality[projectId] ?? 0) : 0;
    const scale = ["low", "medium", "high", "xhigh", "max"] as const;
    const shift = (e: (typeof scale)[number], cap: (typeof scale)[number] | null) => {
      const i = Math.min(scale.length - 1, Math.max(0, scale.indexOf(e) + offset));
      return scale[cap === null ? i : Math.min(i, scale.indexOf(cap))] ?? e;
    };
    return c.json({
      ...PERFORMANCE,
      projectId,
      days: window,
      from: new Date(generated - window * 86_400_000).toISOString(),
      effortOffset: offset,
      modes: PERFORMANCE.modes.map((m) => {
        // The principal's D.4 effort override (what Settings sets through model.settings.set)
        // replaces the base effort of planning, text chat and the coder and research rows.
        const set =
          m.mode === "coder" || m.mode === "researcher"
            ? state.modelSettings.specialists.find((x) => x.name === m.mode)?.settings.effort
            : state.modelSettings.agents
                .find((a) => a.editable)
                ?.modes.find((x) => x.mode === m.mode)?.effort;
        const override =
          set?.source === "agent" && scale.includes(set.value as (typeof scale)[number])
            ? (set.value as (typeof scale)[number])
            : null;
        const base = override ?? m.baseEffort;
        const effortSource = override ? ("agent" as const) : ("table" as const);
        if (!m.offsetApplied) return { ...m, baseEffort: base, effortSource };
        const effort = shift(base, m.maxEffort);
        // A risky task's effort is shown only where it differs from the mode's.
        const risk = m.riskEffort === null ? null : shift(m.riskEffort, m.maxEffort);
        return risk === effort
          ? { ...m, baseEffort: base, effortSource, effort, riskEffort: null, riskTierFrom: null }
          : { ...m, baseEffort: base, effortSource, effort, riskEffort: risk };
      }),
    });
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const listener: Listener = (event, data) => {
        if (!open) return;
        // As the daemon's install-wide stream (server.ts `onSession`): what happened in a
        // session travels as `session.changed` with `{ type, payload }`, never a session view
        // and never the log line itself (that is the session's own stream).
        if (event === "session.event") {
          const ev = data as EventView;
          void stream.writeSSE({
            event: "session.changed",
            data: JSON.stringify({ type: ev.type, payload: ev.payload ?? {} }),
          });
          return;
        }
        if (event === "session.changed") {
          const view = data as SessionView;
          const type = ["completed", "stopped", "failed", "killed"].includes(view.status)
            ? "session.ended"
            : view.status === "running"
              ? "session.started"
              : "session.updated";
          void stream.writeSSE({
            event: "session.changed",
            data: JSON.stringify({ type, payload: { sessionId: view.id } }),
          });
          if (view.projectId)
            void stream.writeSSE({
              event: "project.changed",
              data: JSON.stringify({ id: view.projectId }),
            });
          return;
        }
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      state.listeners.add(listener);
      stream.onAbort(() => {
        open = false;
        state.listeners.delete(listener);
      });
      await stream.writeSSE({
        event: "inbox.changed",
        data: JSON.stringify({ blockingCount: blockingCount(), needsYouCount: needsYouCount() }),
      });
      while (open) {
        await stream.sleep(heartbeatMs);
        if (!open) break;
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }
    }),
  );

  app.notFound((c) => errorBody(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`));

  function pushEvent(
    session: SessionView,
    type: string,
    text: string,
    level: EventView["level"],
    payload: unknown = {},
    costUsdMicro = 0,
  ) {
    const seq = state.events.filter((e) => e.sessionId === session.id).length + 1;
    const event: EventView = {
      id: nextId("ev"),
      sessionId: session.id,
      seq,
      type,
      text,
      payload,
      cost: money(costUsdMicro),
      at: new Date().toISOString(),
      level,
      // The daemon's split (design §3.7), with the line's payload (`fakeEventAudience`).
      audience: fakeEventAudience(type, payload),
    };
    state.events.push(event);
    emit("session.event", event);
    return event;
  }

  /**
   * A session begins, as the daemon's start does once its run began: POST /sessions and the
   * chat's yes to "start a session" (phase E: the chat's start waits for its run and links it).
   */
  function beginSession(start: {
    agent: { id: string; name: string };
    projectId: string | null;
    trigger: string;
    budgetUsdMicro: number;
    note?: string | undefined;
  }): SessionView {
    const session: SessionView = {
      id: nextId("sess"),
      agentId: start.agent.id,
      agentName: start.agent.name,
      projectId: start.projectId,
      trigger: start.trigger,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      budgetCap: money(start.budgetUsdMicro),
      spent: money(0),
      stepCap: 200,
      steps: 0,
      currentTask: null,
      summary: "",
      // As the daemon: the note for the session is kept on its handoff.
      handoff: start.note?.trim() ? { note: start.note.trim() } : null,
      runner: "desktop",
      stopReason: null,
      statusText: "Working",
    };
    state.sessions.push(session);
    emit("session.changed", clone(session));
    scheduleScriptedEvents(session);
    return session;
  }

  /** After POST /sessions: a short scripted run with a warning and an escalation. */
  function scheduleScriptedEvents(session: SessionView) {
    // The real runner's event types and payloads (session/runner.ts): a task begins
    // (`task.started` with its title and specialist), one `task.step` per tool call with its
    // line, and ends (`task.finished`).
    const task = {
      taskId: "task_3",
      title: "Decide the versioning scheme",
      specialist: "researcher",
    };
    const script: Array<[string, string, EventView["level"], number, Record<string, unknown>]> = [
      ["session.started", "Session started", "info", 0, {}],
      ["task.started", 'Started "Decide the versioning scheme"', "info", 0, task],
      [
        "task.step",
        "read docs/versioning.md",
        "info",
        0,
        { ...task, text: "read docs/versioning.md" },
      ],
      ["budget.warning", "Session spend at 80% of the cap", "warning", 2_000_000, {}],
      ["escalation", "Choice of versioning scheme needs your decision", "escalation", 0, {}],
      ["task.finished", 'Finished "Decide the versioning scheme"', "info", 2_500_000, task],
    ];
    script.forEach(([type, text, level, cost, extra], i) => {
      later(
        () => {
          // Stop after this task (the real daemon's pause): the task in flight finishes, then
          // the session ends.
          if (session.status === "paused" && type === "task.finished") {
            session.status = "stopped";
            session.endedAt = new Date().toISOString();
            session.currentTask = null;
            session.stopReason = "stopped_after_task";
            session.statusText = "Stopped after the task, as asked";
            pushEvent(session, type, text, level, { step: session.steps, ...extra }, cost);
            emit("session.changed", clone(session));
            return;
          }
          if (session.status !== "running" && session.status !== "paused") return;
          session.steps += 1;
          session.spent = money(session.spent.usdMicro + cost);
          if (type === "task.started") {
            session.currentTask = {
              id: "task_3",
              title: "Decide the versioning scheme",
              specialist: "researcher",
            };
          }
          pushEvent(session, type, text, level, { step: session.steps, ...extra }, cost);
          emit("session.changed", clone(session));
          if (i === script.length - 1) {
            session.status = "completed";
            session.statusText = "Done";
            session.stopReason = "completed";
            session.endedAt = new Date().toISOString();
            session.currentTask = null;
            session.summary = "Decided the versioning scheme and wrote the ADR.";
            emit("session.changed", clone(session));
          }
        },
        eventDelayMs * (i + 1),
      );
    });
  }

  /**
   * Desktop control turns on (with the names) or off (`null`): the status view changes and the
   * `desktop.indicator` frame goes to every open `/events` stream, as the real daemon does.
   * `silent` changes only the status (a frame the UI missed while disconnected).
   */
  function setDesktopControl(
    on: { app?: string; sessionId: string; agentId: string; at?: string } | null,
    silent = false,
  ) {
    if (on) {
      const at = on.at ?? new Date().toISOString();
      state.desktop.control = {
        active: true,
        app: on.app ?? null,
        sessionId: on.sessionId,
        agentId: on.agentId,
        since: at,
      };
      if (!silent) {
        emit("desktop.indicator", {
          on: true,
          ...(on.app ? { app: on.app } : {}),
          sessionId: on.sessionId,
          agentId: on.agentId,
          runId: "run_desktop",
          humanId: "human_alice",
          message: `Forerunner agent ${on.agentId} is controlling ${on.app ?? "the desktop"}`,
          at,
        });
      }
    } else {
      const wasOn = state.desktop.control.active;
      state.desktop.control = { ...DESKTOP_OFF };
      if (wasOn && !silent) emit("desktop.indicator", { on: false });
    }
  }

  function close() {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    state.listeners.clear();
  }

  return { app, state, token, close, setDesktopControl };
}

export interface RunningFakeDaemon {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1; port 0 picks a free one. */
export function startFakeDaemon(
  options: FakeDaemonOptions & { port?: number } = {},
): Promise<RunningFakeDaemon> {
  const daemon = createFakeDaemon(options);
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: daemon.app.fetch, hostname: "127.0.0.1", port: options.port ?? 0 },
      (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          token: daemon.token,
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              daemon.close();
              server.close(() => done());
            }),
        });
      },
    );
    server.on("error", reject);
  });
}

const invokedDirectly =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /fake-daemon\.(ts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  const port = Number(process.env.FAKE_DAEMON_PORT ?? "0");
  const token = process.env.FAKE_DAEMON_TOKEN;
  const eventDelayMs = Number(process.env.FAKE_DAEMON_EVENT_DELAY_MS ?? "150");
  startFakeDaemon({
    port: Number.isFinite(port) ? port : 0,
    token: token || undefined,
    eventDelayMs: Number.isFinite(eventDelayMs) && eventDelayMs > 0 ? eventDelayMs : 150,
  })
    .then((running) => {
      console.log(`fake daemon listening on ${running.url}`);
      const stop = () => {
        void running.close().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
