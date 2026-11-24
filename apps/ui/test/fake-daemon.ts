import { randomBytes } from "node:crypto";
import type {
  AgentView,
  BillingOrderKind,
  BillingOrderSourceView,
  BillingOrderView,
  ChangeLogView,
  ChatOfferView as ChatOfferViewT,
  ChatReplyView,
  CommandResultJson,
  ConsolidationProposalView,
  ConsolidationReportView,
  ConversationTurnView,
  ConversationView,
  CostView,
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
  JoinPreviewView,
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
  ProjectSessionRowView,
  ReviewsView,
  ReviewView,
  RunningView,
  SessionTaskView,
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
  ProjectSessionsView,
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
import {
  includesWorkSentence,
  joinAsk,
  joinedIntoSentence,
  joinedRefusalSentence,
  joinSentence,
  joinUndoneSentence,
  OPEN_ON_A_CLOSED_PROJECT,
  sessionsBeforeJoinSentence,
} from "@forerunner/runtime/daemon/join-words";
import {
  closeFailedSentence,
  closeNotCancelledSentence,
  closeNotOpenSentence,
  pullRequestClosedSentence,
} from "@forerunner/runtime/daemon/pull-request-close-words";
import { reviewPartUsdMicro } from "@forerunner/runtime/estimates/model";
import {
  STATUS_ISSUE_EFFECT,
  STATUS_NOT_YET_SENTENCE,
  statusIssueRowWords,
} from "@forerunner/runtime/loop/status-board-words";
import { openPlanSentence } from "@forerunner/runtime/session/intake-words";
import {
  type Elsewhere,
  elsewhereSentence,
  inUseSentence,
  nothingToTakeOverSentence,
  otherHostSentence,
  TAKE_OVER_NO_REPOSITORY,
  TAKE_OVER_NOT_TAKEN,
  TAKE_OVER_NOTHING_TO_RETRY,
  type TakeOverRetryFailure,
  TOGETHER_OVERVIEW_DETAILS,
  TOGETHER_OVERVIEW_LINE,
  takeOverAsk,
  takeOverDetails,
  takeOverLine,
  takeOverRetryFailedSentence,
  takeOverRetryOpenedSentence,
  togetherDocNote,
  togetherLine,
  tookOverSentence,
} from "@forerunner/runtime/sources/repository-words";

/**
 * A link as the fake compares it (the daemon's `identityOf` reads folders from the disk, which
 * a page's test cannot): a GitHub repository in any spelling as `o/n`, another host by its
 * name, an absolute path as it is.
 */
function fakeLinkOf(
  entry: string,
): { kind: "repo"; locator: string } | { kind: "folder"; path: string } | { host: string } | null {
  const t = entry.trim().replace(/\/+$/, "");
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return { kind: "folder", path: t };
  const url =
    /^(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?([^/:]+\.[^/:]+)[/:]([^/]+)\/([^/]+)/i.exec(t);
  if (url?.[1] && url[2] && url[3]) {
    if (url[1].toLowerCase() !== "github.com") return { host: url[1].toLowerCase() };
    return { kind: "repo", locator: `${url[2]}/${url[3].replace(/\.git$/, "")}`.toLowerCase() };
  }
  const plain = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  if (plain?.[1] && plain[2])
    return { kind: "repo", locator: `${plain[1]}/${plain[2].replace(/\.git$/, "")}`.toLowerCase() };
  return null;
}

import {
  type CredentialFacts,
  credentialPolicyOf,
  credentialPolicySection,
  policyChangeWords,
} from "@forerunner/runtime/daemon/credential-policy-view";
import { eventAudience } from "@forerunner/runtime/daemon/event-audience";
import {
  type HeldTask,
  heldBlocker,
  heldDependency,
  outerLimitHold,
} from "@forerunner/runtime/daemon/held-words";
import { NO_WEB_LIMITATION } from "@forerunner/runtime/daemon/model-settings-view";
import {
  comesAfterSentence,
  leftOutSentence,
  oversizedAsk,
  oversizedSentence,
  reviewMayWaitLine,
} from "@forerunner/runtime/daemon/oversize-words";
import { planTaskViews } from "@forerunner/runtime/daemon/plan-tasks";
import type { StartsWait } from "@forerunner/runtime/daemon/project-status";
import {
  blockedTaskIds,
  overviewNext,
  progressOf,
  projectStatusLine,
  sinceLines,
} from "@forerunner/runtime/daemon/project-status";
import { requestWords, resetDay } from "@forerunner/runtime/daemon/request-words";
import { runText, startOfferOf, stopChoices } from "@forerunner/runtime/daemon/run-words";
import {
  quoted,
  TAKE_OUT_NOTICE_PREFIX,
  takeOutConflictSentence,
  takeOutOpenedSentence,
} from "@forerunner/runtime/daemon/take-out-words";
import {
  TASK_PROPOSAL_KEY,
  TASK_PROPOSAL_OPTIONS,
} from "@forerunner/runtime/daemon/task-proposal-words";
import { ACTION_WORDS } from "@forerunner/runtime/daemon/task-words";
import { ImportResultView } from "@forerunner/runtime/data/types";
import {
  MERGE_MODE_WORDS,
  mergeModeEffect,
  mergesAfterSentence,
} from "@forerunner/runtime/loop/merge-mode";
import { fastModeDescription, fastModeEffect } from "@forerunner/runtime/models/fast-mode";
import { fileTheWordsWrite, writesNoFileLine } from "@forerunner/runtime/registry/tools";
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
import { nothingRunsYetSentence } from "@forerunner/runtime/session/credential-wait";
import { INTERRUPTED_UPDATE_LEAD } from "@forerunner/runtime/session/recovery-words";
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
  WEB_ACCESS_ROW_WORDS,
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
import { formatChf } from "../src/lib/money.ts";
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
   * leftovers7-tailrun TR-12: the agent drafts a plan now (a planning call holds it), as the
   * daemon's `planning`; with `startOutcome: "queued"` a Start waits for the plan.
   */
  agentPlanning?: boolean;
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
   * l4-cred-engine, run L4 (L4-creds-1, CE-6): the change line a save answers with when the
   * raise ended the subscription's share stop ("Your subscription's allowance is raised: ...").
   * Default null (nothing waited for the share).
   */
  planAllowanceChangeLine?: string | null;
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
   * d1109-cred-screens (CS-1): the person's stored credential policy at start (none: derived from
   * `billingOrder.order` and `mid_session_limit`, else the default), and a standing yes to the
   * API key for the subscription's stop now (`grant`).
   */
  credentialPolicy?: {
    stored?: string | null;
    midSessionLimit?: "wait" | "use_other";
    grant?: boolean;
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
    /** C5-left-1, CS-6: a run the policy moved to another credential (the daemon's words). */
    switchLine?: string;
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
  /**
   * What `GET /costs?projectId=` answers, by project (l3-money-screens: a test sets a project's
   * savings to zero, or prices one line at nothing); a project not in it reads as Beacon's.
   */
  costs: Record<string, CostView>;
  sessions: SessionView[];
  /**
   * d1109-run-visible: entries `GET /running` adds after the running sessions (a person's session
   * waiting to go on, the critic's monthly check), in the daemon's words. A test seeds them and
   * calls `emitRunning()`; `POST /projects/:id/continuation/cancel` drops a waiting one.
   */
  runningExtra: RunningView[];
  /**
   * d1109-cred-screens (CS-7), as the daemon's run fold and `askWaiting` read them for a running
   * session: the credential kind its running task went on with (' on your API key') and the
   * tasks that wait on the open ask card (' · 1 task waits for your answer' with Answer).
   */
  runCredential: Record<string, { on?: string; asking?: { count: number; to: string } }>;
  /**
   * l4-starts-sessions (L4-money-208), as the daemon's run fold: the task the critic checks in a
   * running session, by session id (the bar's 'the critic checks "X"'; no task is in flight).
   */
  runReview: Record<string, string>;
  /**
   * l4-starts-sessions (the review of run L4g), as the daemon's `plan.startedBy.continues`: the
   * session each Continue went on with, by the new session's id.
   */
  continuesOf: Record<string, string>;
  /**
   * d1109-run-visible (V-3): what waits to start for a project, as the daemon's `startsWaitOf`
   * reads it (the person's session going on, a kept Start, a held hands-off start, a person start
   * behind another session); its status line says it. Cancel drops a continuation or kept start.
   */
  startsWait: Record<string, StartsWait>;
  /**
   * d1109-run-visible (V-5): a session's wait block after Cancel, by session id, as the daemon's
   * `waitBlockOf` reads it then (a test seeds both the block on the session and this one).
   */
  waitBlockAfterCancel: Record<string, SessionView["waitBlock"]>;
  /**
   * d1109-sessions (ADR 0116): each project's ended sessions as `GET /projects/:id/sessions`
   * lists them (newest first), every word as the daemon writes it; the working ones are read
   * from `sessions` (running, paused, planned) with the project's working sentence. A test
   * seeds them.
   */
  projectSessions: Record<string, ProjectSessionRowView[]>;
  /** "Chat about this project: CHF 0.03." by project, when chat about it cost anything. */
  projectSessionsChat: Record<
    string,
    { spent: { usdMicro: number; chfMicro: number }; words: string }
  >;
  /** `GET /sessions/:id/tasks` by session: the session page's "Tasks in this session". */
  sessionTasks: Record<string, SessionTaskView[]>;
  events: EventView[];
  requests: HumanRequestView[];
  /**
   * `GET /projects/:id/intake` per project (U-046); a project without an entry has had no
   * intake (`none`). `POST /projects/:id/intake/retry` moves a failed one to `drafting`.
   */
  intake: Record<string, IntakeStatusView>;
  /**
   * d1109-onerepo-link: what a repository itself says (its marker and marked pull requests),
   * by `owner/name` in lower case, as the daemon's `readRepository` and `verdictOf` read it: a
   * project that is not on this computer, with its offer. Absent: nothing (a free repository).
   */
  repositoryElsewhere: Record<string, Elsewhere>;
  /**
   * OR-07: per project id, the Overview's line about its repository, as the daemon's
   * `RepositoryUse.overviewOf` gives it (`ProjectCard.repositoryElsewhere`). `repo.take_over`
   * removes it (its Undo puts it back); a test sets it.
   */
  repositoryOverview: Record<string, NonNullable<ProjectCard["repositoryElsewhere"]>>;
  /**
   * w8-status-write: per project id, where its status is on GitHub, as the daemon's status
   * board says it (`StatusBoard.words`): Settings' sentence under the switch, the Docs tab's
   * Status note, and whether the repository is public. Absent: nothing written yet. A test sets it.
   */
  statusIssue: Record<
    string,
    { sentence: string | null; docsNote: string | null; public: boolean | null }
  >;
  /**
   * OR-07: why a `repo.take_over` row's Undo would not work now, as the daemon's
   * `RepositoryUse.takeOverUndoBlocked` says it (`TAKE_OVER_UNDO_OPEN`, `_MERGED`,
   * `_UNREADABLE`): its docs pull request is open or merged, or GitHub did not answer. Null: the
   * Undo works. A test sets it.
   */
  takeOverUndoBlocked: string | null;
  /**
   * l4-github-carried (L4e-left-1): set by a test, the next Try again of the take-over's docs
   * pull request for this project id fails (`refused`: GitHub refused the push; `blocked`:
   * another docs pull request is in its way; w8-repo-guide, L4i-left-6: `unreachable`, GitHub
   * did not answer; `branches`, its branches hold another project's docs), as
   * `retryTakeOverDocs` answers it.
   */
  takeOverRetryFails: Record<string, TakeOverRetryFailure>;
  /**
   * d1109-onerepo-join (OJ-01): per project id, the Overview's line about the other projects here
   * on its repository or folder, as the daemon's `sharesRepositoryWith` gives it. A test sets it;
   * `project.join` clears it for the projects it made one (its Undo puts it back).
   */
  sharedRepository: Record<string, NonNullable<ProjectCard["sharesRepositoryWith"]>>;
  /** OJ-05: per project id, `GET /projects/:id/join-preview` as the daemon answers it. */
  joinPreviews: Record<string, JoinPreviewView>;
  /**
   * OJ-06: per closed project id, where Make one project put its work (`ProjectCard.joinedInto`);
   * `project.join` writes it, its Undo removes it. A joined project leaves `GET /projects`.
   */
  joined: Record<string, NonNullable<ProjectCard["joinedInto"]>>;
  /** OJ-02: the sentence that holds `project.join` now, as the daemon's `joinRefusal`. */
  joinRefusal: string | null;
  /** OJ-04: why the join's Undo would not work now, as `project.join`'s `undoBlocked`. */
  joinUndoBlocked: string | null;
  /**
   * R-startcred (leftovers7-web): per project, the wait every ready task's credential meets now
   * (as `RuntimeApp.billing.waits.now`): the Start check says it in one sentence
   * (`nothingRunsYetSentence`), and the project's ready line names it (W15-67).
   */
  /**
   * d1109-cred-screens (CS-3): per project, what the Start dialog says of which Claude does the
   * work (`StartCheckView.credential`, as `credential-start.ts` words it); a test sets it.
   * `POST /sessions` with `useOtherCredential` is refused in words without its `runOut`, else it
   * records the yes (`credentialGrants`), ends the project's wait and starts (or the waiting
   * session goes on).
   */
  startCredential: Record<string, StartCheckView["credential"]>;
  /** CS-4: the plan card's foot line (`HumanRequestView.planCredentialLine`); a test sets it. */
  planCredentialLine: string | null;
  credentialGrants: string[];
  credentialWaitNow: Record<
    string,
    {
      text: string;
      save: { label: string; to: string } | null;
      /** leftovers7-tailrun TR-2: no Start kept the wait yet: `text` is the whole sentence, Start stays on. */
      startable?: boolean;
      /** d1109-starts-engine S-10: the person's session waits to go on: Cancel drops it. */
      kept?: boolean;
      /** S-10: a kept person Start, as the daemon: "Starts at 15:40 (your subscription's limit)". */
      startsAt?: string;
      /** l4-cred-screens (L4-creds-26): under "ask", the stop in a few words; Start asks first. */
      askFirst?: string;
      /**
       * fixup-l4-starts-carried, as the daemon's `KeptStart.id`: the start chat kept for the
       * reset; its Undo drops that start only and is refused once it no longer waits.
       */
      keptId?: string;
    }
  >;
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
    {
      updatedAt: string | null;
      localOnly: { folder: string | null; line: string } | null;
      /** leftovers7-merge2 (R-copystuck): the copy stopped following what is merged, and why. */
      stopped?: {
        reason: "changed" | "in_the_way" | "other";
        files: string[];
        line: string;
      };
    }
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
  /**
   * l3-merge, run L3: what the daemon's press finds before it merges anything, by
   * `<project id>#<number>` (a test sets it): the pull request's head moved on GitHub since the
   * review (L3-github-3: `blocked`, "#N changed after the review: ..."), or its branch still
   * holds work that was closed and is rebuilt without it (L3-github-1: `left_to_you`, "#N was
   * rebuilt without #M, ..."). The press is refused at once with that sentence, as the daemon's
   * `ProjectPullRequests.merge` answers it, and the row then says it as the merge step leaves it.
   * fixup-l4-github-merge (L4-github-124 (a)): `closedDependency`, the task whose pull request
   * the chain builds on and the press read closed on GitHub; its merge record is settled at the
   * press ("#N was closed without merging."), so its Tasks row reads "Accepted · pull request
   * closed" at once, as the daemon's `closedAtPress` leaves it.
   */
  pullRequestPressFinds: Record<
    string,
    {
      row: "blocked" | "left_to_you";
      sentence: string;
      closedDependency?: { taskId: string; number: number };
    }
  >;
  /** How many times `GET /projects/:id/pull-requests` was read, by project (the Overview's polling). */
  pullRequestReads: Record<string, number>;
  /**
   * l4-github-carried (L4-github-130): the Close presses that closed a cancelled task's pull
   * request, in order (the daemon makes one PATCH on GitHub for each, never a branch delete).
   */
  pullRequestCloses: { projectId: string; number: number }[];
  /**
   * l4-github-carried: set by a test, the next Close of `<project id>#<number>` fails as GitHub
   * refuses or does not answer; the row stays, as the daemon's `ProjectPullRequests.close`.
   */
  pullRequestCloseFails: Record<string, "refused_token" | "no_access" | "unreachable">;
  /** How many times `GET /projects` was read (leftovers7-merge: the list follows other changes). */
  projectListReads: number;
  /**
   * A test holds the sessions it starts (`POST /__test/hold-sessions`): their scripted events
   * play, but they end only when stopped (R-testpaths: the e2e's Stop now ran only when the
   * machine was fast enough to see it before the session ended by itself).
   */
  holdSessions: boolean;
  /** merged-actions: set by a test, the next Take this work out conflicts in these files. */
  takeOutConflict: string[] | null;
  /** `GET /projects/:id/docs` by project: Atlas has the fixture set, the others none. */
  docs: Record<string, DocView[]>;
  messages: MessageView[];
  killActive: boolean;
  calls: RecordedCall[];
  /** l4-selftasks-carried (L4f-left-6): the paths of the GET requests, in order. */
  gets: string[];
  /** `keptAt` (L4a-left-5): chat's start is kept for the credential's reset at that time. */
  pendingConfirmation: { id: string; readback: string; keptAt?: string; words?: string } | null;
  /**
   * As the daemon (review of l4-chat-answers): the line the parser's "Which project: …?" asked
   * about; the option pressed next (a project's name alone) finishes it.
   */
  askedProjectLine: string | null;
  /** When set, the next `/chat/stream` reply has this text (tests script the agent). */
  nextChatReply: string | null;
  /**
   * d1109-chat-recall: the records the next scripted reply rests on (`ChatReplyView.sources`,
   * kept on its conversation turn as the daemon keeps `reply.sources`).
   */
  nextChatSources: { kind: string; title: string; date: string; link: string | null }[] | null;
  /**
   * d1109-chat-depth: what the next `/chat` or `/chat/stream` turn does beyond its reply, as the
   * daemon does it: its step lines (with `reset` on a hand-over), a hold until Stop or Answer now
   * (`hold`), how deep it went and the lines under it (`footer`, `offer`).
   */
  nextChatTurn: {
    steps?: { text: string; reset?: boolean }[];
    hold?: boolean;
    depth?: string;
    footer?: string | null;
    offer?: ChatOfferViewT | null;
    /** C5-left-3: the turn is a hold reply with "Use API key" (the daemon's words). */
    oneOff?: { label: string; explain: string } | null;
    /** C5-left-3: the reply text of this turn (a hold reply, or the answer the press gets). */
    reply?: string;
    /**
     * l4-cred-engine L4-creds-4: the reply says the answer failed (the daemon's chat.reply row
     * with `failed`, a notice): the conversation's turn has `failed`, so Ask again is under it.
     */
    failed?: boolean;
  } | null;
  /** C5-left-3: what the last chat posts asked for: the text and whether it was the one-off. */
  chatPosts: { text: string; oneOff: boolean }[];
  /** d1109-chat-depth: the turn being answered now (the conversation's `answering`; Stop ends it). */
  answering: {
    turnId: string;
    key: string;
    step: string | null;
    since: string;
    depth: string;
    stopped: boolean;
    answeredNow: boolean;
    release: () => void;
  } | null;
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
  /**
   * Projects whose creation was undone (W15-36), by id: the name their rows read ("<name>
   * (removed)") and the name they had.
   */
  removedProjects: Record<string, { name: string; was: string }>;
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
  /**
   * The learned cost ratio of the plan's tasks (leftovers7-session): as the daemon, `GET /inbox`
   * gives each plan task the figure the Start dialog will show (the plan's figure times it).
   * Absent: 1 (nothing learned).
   */
  planEstimateRatio?: number;
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
 * l4-chat-depth (L4-chat-207), as `task.dependencies` says it: when a ready task runs after a
 * change to what it waits for (the fake runs no session, so the next Start).
 */
function fakeDependenciesNextLine(tasks: readonly TaskView[], task: TaskView): string {
  if (task.status !== "ready") return "";
  const deps = task.dependsOn
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is TaskView => !!t);
  const undone = deps.filter((d) => d.status !== "done");
  if (!undone.length) return " It runs at your next Start.";
  const one = undone.length === 1;
  const who =
    undone.length === deps.length
      ? one
        ? "it is"
        : "they are"
      : `${undone.map((d) => `"${d.title}"`).join(" and ")} ${one ? "is" : "are"}`;
  return ` It runs after ${who} done, at your next Start.`;
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
 * planner's 500 000, plus its review part as the runtime's estimate adds it (d1116-budget-all,
 * BA-10: `reviewPartUsdMicro`), never more than what is left of its own budget, the budget less
 * its one figure (`withinTaskBudget`).
 */
function fakePrice(t: TaskView): number {
  const work = t.estimate.usdMicro || t.budget.usdMicro || 500_000;
  const estimate =
    work +
    reviewPartUsdMicro({
      specialist: t.specialist,
      risk_tier: t.riskTier,
      outcome: t.outcome,
      acceptance_criteria: t.acceptanceCriteria,
    });
  if (!(t.budget.usdMicro > 0)) return estimate;
  return Math.min(estimate, Math.max(0, t.budget.usdMicro - fakeTotal(t)));
}

/** d1116-budget-all (BA-10): a task's one figure, its work, reviews and fixes (as the ledger). */
/**
 * C4b-left-5: one critic call's worst case at a light review, as the daemon's critic prices it
 * (`reviewCallUsdMicro`) for the stand-in model (USD 0.018).
 */
const FAKE_REVIEW_CALL_WORST_USD_MICRO = 18_000;

function fakeTotal(t: Pick<TaskView, "actual" | "spent">): number {
  return Math.max(t.actual.usdMicro, t.spent?.usdMicro ?? 0);
}

/**
 * As the daemon's `continuableTasks` (d1109-oversize-pause, OP-0): the tasks a start takes in
 * their turn from their kept work, waiting on an open budget card at a session's budget or at
 * their specialist's limit that got further (`no_progress` not true).
 */
function fakeContinuing(requests: readonly HumanRequestView[]): Set<string> {
  const ids = new Set<string>();
  for (const r of requests) {
    const card = (r.changeCard ?? {}) as Record<string, unknown>;
    if (r.status !== "open" || card.key !== "task:budget_stop" || !r.taskId) continue;
    if (card.no_progress === true) continue;
    if (["session", "session_budget", "specialist_limit"].includes(String(card.source)))
      ids.add(r.taskId);
  }
  return ids;
}

/**
 * As the daemon's `heldFacts` (l4-starts-carried, L4g-left-1): why each of the project's
 * `needs_human` tasks holds (an open card asks, a limit only Settings changes, the person's own
 * pause) and the first one a card or a limit holds.
 */
function fakeHeld(
  tasks: readonly TaskView[],
  requests: readonly HumanRequestView[],
  pausedByPerson: ReadonlySet<string>,
  projectId: string,
): { needsYou: HeldTask | null; held: Record<string, HeldTask> } {
  const held: Record<string, HeldTask> = {};
  let needsYou: HeldTask | null = null;
  for (const t of tasks) {
    if (t.projectId !== projectId || t.status !== "needs_human") continue;
    const open = requests.filter((r) => r.taskId === t.id && r.status === "open");
    const limit = open
      .map((r) => outerLimitHold((r.changeCard ?? null) as never, resetDay))
      .find((h) => h !== null);
    // fixup-l4-starts-carried, as the daemon: a pause no card asks about that the person did not
    // make is a pause too ("which is paused").
    const one: HeldTask = limit
      ? { title: t.title, why: "limit", ...limit }
      : open.length > 0
        ? { title: t.title, why: "answer" }
        : { title: t.title, why: "paused", byYou: pausedByPerson.has(t.id) };
    held[t.id] = one;
    if (!needsYou && one.why !== "paused") needsYou = one;
  }
  return { needsYou, held };
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
    /** OP-0: paused tasks the start takes in their turn (`fakeContinuing`). */
    continuing?: ReadonlySet<string>;
    /** L4g-left-1: what holds the tasks that wait on the person (`fakeHeld`). */
    held?: { needsYou: HeldTask | null; held: Record<string, HeldTask> };
  } = {},
): StartCheckView {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // High first, as the daemon's stored numbers order them (U-041).
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const ready = tasks
    .filter(
      (t) =>
        t.projectId === projectId &&
        (t.status === "ready" || (t.status === "needs_human" && !!opts.continuing?.has(t.id))),
    )
    .sort((a, b) => rank[b.priority] - rank[a.priority]);
  const cap = budgetUsdMicro ?? FAKE_SESSION_CAP_USD_MICRO;
  const work = Math.floor(cap * 0.8);
  const runnable: StartCheckView["runnable"] = [];
  const overBudget: (StartCheckView["overBudget"][number] & { at: number })[] = [];
  const waiting: StartCheckView["waiting"] = [];
  const sandboxTasks: StartCheckView["runnable"] = [];
  let total = 0;
  /**
   * D4: the first ready task whose figure alone is more than the work budget, at its place in the
   * plan's order with the room left (d1109-oversize-pause, OP-0, as the runner's cut).
   */
  let larger:
    | (StartCheckView["runnable"][number] & { at: number; aheadUsd: number; roomUsd: number })
    | null = null;
  for (const [at, t] of ready.entries()) {
    const waitsOn = t.dependsOn
      .filter((d) => byId.get(d)?.status !== "done")
      .map((d) => {
        // fixup-l4-starts-carried, as the daemon: what holds a dependency that waits on the
        // person, in the dialog's words.
        const h = byId.get(d)?.status === "needs_human" ? opts.held?.held[d] : undefined;
        return {
          taskId: d,
          title: byId.get(d)?.title ?? null,
          status: byId.get(d)?.status ?? null,
          ...(h ? { held: heldDependency(h) } : {}),
        };
      });
    if (waitsOn.length) {
      waiting.push({ taskId: t.id, title: t.title, waitsOn });
      continue;
    }
    const estimate = fakePrice(t);
    const named = { taskId: t.id, title: t.title, estimate: money(estimate) };
    // U-079: a full-review task waits while the Docker sandbox is not ready.
    if (sandbox && !sandbox.ready && t.riskTier >= 2) sandboxTasks.push(named);
    // D4 (d1109-oversize-pause, OP-0): every task after the larger one waits behind it.
    else if (larger) overBudget.push({ ...named, ahead: money(total), why: "after_large", at });
    // Larger than the whole work budget: in at its place with what is left, when that is at
    // least a fifth of the work budget; else it waits (no_room) and the cut goes on.
    else if (estimate > work) {
      const left = work - total;
      if (left >= Math.max(1, Math.ceil(work * 0.2))) {
        larger = { ...named, at, aheadUsd: total, roomUsd: left };
        total += left;
      } else overBudget.push({ ...named, ahead: money(total), why: "no_room", at });
    }
    // C-45: what the tasks before it take (polish-screens, wave 13).
    else if (total + estimate > work)
      overBudget.push({ ...named, ahead: money(total), why: "after_others", at });
    else {
      runnable.push(named);
      total += estimate;
    }
  }
  // As the daemon (design §3.6): what follows as it becomes ready, and why nothing would run.
  const comes = new Set([...runnable.map((r) => r.taskId), ...(larger ? [larger.taskId] : [])]);
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
  // S-6, as the daemon's `cutFollowers`: without a larger task, the work budget left after the
  // tasks ready now holds the followers in order; the first that does not fit and those after it
  // wait for a later Start.
  const laterBeyond: StartCheckView["laterBeyond"] = [];
  if (!larger) {
    let room = work - total;
    const taken = [];
    for (const l of later) {
      if (laterBeyond.length > 0 || l.estimate.usdMicro > room) laterBeyond.push(l);
      else {
        taken.push(l);
        room -= l.estimate.usdMicro;
      }
    }
    later.splice(0, later.length, ...taken);
  }
  // D4 (OP-0): the larger task gets what the tasks before it in the plan's order leave; the
  // tasks after it (ready now or later) run only if it leaves budget.
  const chf = (m: { chfMicro: number }) => ({ chfMicro: m.chfMicro, text: formatChf(m.chfMicro) });
  let oversized: StartCheckView["oversized"] = null;
  if (larger) {
    const { at, aheadUsd, roomUsd, ...named } = larger;
    const comesAfter = [
      ...overBudget.filter((o) => o.why === "after_large").map((o) => o.title),
      ...later.map((l) => l.title),
    ];
    oversized = {
      ...named,
      room: money(roomUsd),
      after: runnable.length > 0,
      sentence: oversizedSentence({
        title: named.title,
        estimate: chf(named.estimate),
        workBudget: chf(money(work)),
        room: runnable.length > 0 ? chf(money(roomUsd)) : null,
        before: runnable.map((r) => r.title),
      }),
      comesAfter,
      afterSentence: comesAfterSentence(comesAfter, named.title),
    };
    overBudget.push({ ...named, ahead: money(aheadUsd), why: "oversized", at });
    overBudget.sort((a, b) => a.at - b.at);
  }
  const overBudgetView: StartCheckView["overBudget"] = overBudget.map(({ at: _at, ...o }) => ({
    ...o,
    sentence:
      o.why === "oversized" && oversized
        ? oversized.sentence
        : leftOutSentence(
            o.why === "oversized" || o.why === "one_large" || !o.why ? "after_others" : o.why,
            {
              title: o.title,
              estimate: chf(o.estimate),
              workBudget: chf(money(work)),
              ahead: chf(o.ahead ?? money(0)),
              after: oversized?.title ?? null,
            },
          ),
  }));
  const stuckOn = waiting
    .flatMap((w) => w.waitsOn.map((d) => ({ w, d })))
    .find(({ d }) => ["failed", "cancelled", "needs_human", null].includes(d.status));
  const blocked: StartCheckView["blocked"] = opts.killActive
    ? {
        kind: "stopped",
        sentence: "Sessions are stopped (Stop all), so nothing can start.",
        action: { kind: "resume", label: "Allow sessions again", to: null },
      }
    : runnable.length > 0 || oversized || (opts.busy && opts.busyHere)
      ? null
      : stuckOn
        ? stuckOn.d.status === "needs_human"
          ? // L4g-left-1, as the daemon: a limit only Settings changes, or the person's pause.
            opts.held?.held[stuckOn.d.taskId ?? ""] &&
            opts.held.held[stuckOn.d.taskId ?? ""]?.why !== "answer"
            ? heldBlocker(
                opts.held.held[stuckOn.d.taskId ?? ""] as HeldTask,
                stuckOn.w.title,
                `/projects/${projectId}/tasks`,
              )
            : {
                kind: "nothing_runnable",
                sentence: `Nothing can run: "${stuckOn.d.title}" needs your answer.`,
                action: { kind: "link", label: "Open it", to: "/inbox" },
                holds: "answer",
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
          : // C2-left-2, L4g-left-1, as the daemon: nothing is ready because a task waits on
            // the person's card, or on a limit only Settings changes: name it.
            ready.length === 0 && opts.held?.needsYou
            ? heldBlocker(opts.held.needsYou, null, `/projects/${projectId}/tasks`)
            : // D4: a task larger than the work budget is no blocker: the session takes it.
              {
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
    overBudget: overBudgetView,
    waiting,
    later,
    laterBeyond,
    blocked,
    oversized,
    // d1109-cred-screens (CS-3): set per project by the route (`state.startCredential`).
    credential: null,
    // C4b-left-5, as the daemon: a task the session takes whose own budget may leave too little
    // for its review (its figure plus one critic call's worst case against what is left).
    reviewMayWait: [...runnable, ...later].flatMap((r) => {
      const t = byId.get(r.taskId);
      if (!t || !(t.budget.usdMicro > 0)) return [];
      const left = Math.max(0, t.budget.usdMicro - fakeTotal(t));
      if (r.estimate.usdMicro + FAKE_REVIEW_CALL_WORST_USD_MICRO <= left) return [];
      return [{ taskId: t.id, title: t.title, line: reviewMayWaitLine(t.title, chf(t.budget)) }];
    }),
    monthLeft: money(FAKE_MONTH_LEFT_USD_MICRO),
    busy: opts.busy ?? false,
    planning: false,
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
  for (const s of view.specialists) {
    s.limitation = WEB_SPECIALISTS.has(s.name) && !web ? NO_WEB_LIMITATION : null;
    // l4-selftasks-chat (L4-other-1): the daemon's `writesNoFile` (registry/tools.ts): a
    // specialist none of whose tools writes a file, in the daemon's words.
    s.writesNoFile = WRITES_NO_FILE.has(s.name)
      ? `The ${s.name} writes no file: its findings are its report, which you read in the task's drawer.`
      : null;
  }
  return view;
}

/**
 * l4-selftasks-chat (L4-other-1): the registry's reviewer beside the fixture's specialists, as
 * the real daemon lists it (a copy of the researcher's settings under the reviewer's name).
 */
function withReviewer(view: ModelSettingsView): ModelSettingsView {
  const model = view.specialists.find((x) => x.name === "researcher");
  if (model && !view.specialists.some((x) => x.name === "reviewer"))
    view.specialists.push({
      ...clone(model),
      name: "reviewer",
      description: "Reviews work and reports what it finds; writes no file.",
    });
  return view;
}

/** The registry's specialists with no write tool (the reviewer: cc:Read, cc:Bash, cc:Grep, cc:Glob). */
const WRITES_NO_FILE = new Set(["reviewer"]);

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
    costs: clone(COSTS),
    runs: clone(RUNS),
    sessions: clone(SESSIONS),
    runningExtra: [],
    runCredential: {},
    runReview: {},
    continuesOf: {},
    startsWait: {},
    waitBlockAfterCancel: {},
    projectSessions: clone(PROJECT_SESSIONS),
    projectSessionsChat: {},
    sessionTasks: clone(SESSION_TASKS),
    events: clone(EVENTS),
    requests: clone(REQUESTS),
    intake: {},
    repositoryElsewhere: {},
    repositoryOverview: {},
    statusIssue: {},
    takeOverUndoBlocked: null,
    takeOverRetryFails: {},
    sharedRepository: {},
    joinPreviews: {},
    joined: {},
    joinRefusal: null,
    joinUndoBlocked: null,
    credentialWaitNow: {},
    startCredential: {},
    planCredentialLine: null,
    credentialGrants: [],
    folders: clone(PROJECT_FOLDERS),
    files: clone(PROJECT_FILES),
    copies: {},
    pullRequests: clone(PROJECT_PULL_REQUESTS),
    pullRequestMerges: {},
    pullRequestMergeOutcome: null,
    pullRequestPressFinds: {},
    pullRequestCloses: [],
    pullRequestCloseFails: {},
    pullRequestReads: {},
    projectListReads: 0,
    holdSessions: false,
    takeOutConflict: null,
    docs: { proj_atlas: clone(DOCS) },
    messages: clone(MESSAGES),
    killActive: false,
    calls: [],
    gets: [],
    pendingConfirmation: null,
    askedProjectLine: null,
    nextChatReply: null,
    nextChatSources: null,
    nextChatTurn: null,
    chatPosts: [],
    answering: null,
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
    removedProjects: {},
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
    settingValues: {
      ...(options.credentialPolicy?.stored
        ? { credential_policy: options.credentialPolicy.stored }
        : {}),
      ...(options.credentialPolicy?.midSessionLimit
        ? { mid_session_limit: options.credentialPolicy.midSessionLimit }
        : {}),
    },
    desktopAllowlist: [{ app: "code" }],
    modelSettings: withWebAccess(withReviewer(clone(MODEL_SETTINGS)), !options.noWebAccess),
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
    // d1109-run-visible: as the daemon's debounced emitter, a session's change moves the run
    // indicator: its list follows on the stream.
    if (event === "session.changed")
      for (const l of state.listeners) l("run.changed", fakeRunning());
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
   * d1109-run-visible: the run indicator as the daemon reads it (`runViews`, in its words): each
   * running or paused session (its task in flight, or picking the next; paused: stops after it),
   * then the seeded extras (a waiting session, the monthly check) whose project runs nothing.
   */
  const fakeRunning = (): RunningView[] => {
    const views: RunningView[] = [];
    const busy = new Set<string>();
    for (const s of state.sessions) {
      if (!["running", "paused", "planned"].includes(s.status) || !s.projectId) continue;
      const project = state.projects.find((p) => p.id === s.projectId);
      if (!project) continue;
      busy.add(project.id);
      const review = state.runReview[s.id];
      const task = review ? null : s.currentTask;
      const runState: RunningView["state"] =
        s.status === "paused" ? "stopping" : review ? "reviewing" : task ? "working" : "between";
      // CS-7, as the daemon: the running task on the credential its choice puts second, and
      // the tasks that wait for the person's answer on the ask card.
      const credential = state.runCredential[s.id];
      const words = {
        state: runState,
        taskTitle: review ?? task?.title ?? null,
        specialist: task?.specialist ?? null,
        ...(runState === "working" && credential?.on ? { on: credential.on } : {}),
        ...(credential?.asking ? { asking: credential.asking.count } : {}),
      };
      const text = runText({ projectName: project.name, ...words });
      views.push({
        key: s.id,
        sessionId: s.id,
        projectId: project.id,
        projectName: project.name,
        state: runState,
        what: text.slice(project.name.length + 3),
        text,
        since: s.startedAt,
        stop: stopChoices(runState),
        cancel: false,
        nextProject: null,
        explain: null,
        ...(credential?.asking ? { links: [{ label: "Answer", to: credential.asking.to }] } : {}),
      });
    }
    for (const extra of state.runningExtra)
      if (!extra.projectId || !busy.has(extra.projectId)) views.push(clone(extra));
    return views;
  };
  /** d1109-run-visible: the `run.changed` frame, as the daemon sends it when the list changed. */
  const emitRunning = () => emit("run.changed", fakeRunning());
  /** The reset's time in a credential wait's sentence ("... until 09:30 (...)"), or null. */
  const fakeResetAt = (text: string): string | null => /until (\d\d:\d\d)/.exec(text)?.[1] ?? null;
  /**
   * d1109-starts-engine S-9, as the daemon's `preparedContextOf`: what an open card's options that
   * prepare work meet now (a session of the project running, another one, the hands-off setting).
   */
  const preparedOfFake = (projectId: string) => {
    const live = state.sessions.filter((s) => s.status === "running" || s.status === "planned");
    const running = live.some((s) => s.projectId === projectId)
      ? ("this_project" as const)
      : live.length
        ? ("other" as const)
        : null;
    const byItself = state.settingValues[`start_by_itself:${projectId}`] === true;
    return { running, ...(byItself ? { startsByItself: true } : {}) };
  };
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
        // L-20 (polish-words): the plan card says the docs pull request while Approve works.
        ...(repositoryOf(state.projects.find((p) => p.id === r.projectId)?.repos ?? [])
          ? { projectRepository: true }
          : {}),
        // W15-56: as the daemon's `taskHeldWork`, an open budget card's task holds work only
        // when its run wrote some (a test adds it to `taskMeta.heldWork`).
        ...(r.status === "open" &&
        task &&
        (r.changeCard as { key?: unknown } | null)?.key === "task:budget_stop"
          ? { heldWork: !!state.taskMeta.heldWork?.has(task.id) }
          : {}),
        // d1109-starts-engine S-9: as the daemon's `preparedContextOf`, an open card's options
        // that prepare work say what pressing them does now (a session of the project running,
        // another one running, "Start a session by itself" on).
        // l4-starts-sessions (L4-money-205), as the daemon: an answered card whose answer joined
        // a session says so only while one of the project runs.
        ...((r.status === "open" ||
          (r.changeCard as { start?: unknown } | null)?.start === "joined") &&
        r.projectId
          ? preparedOfFake(r.projectId)
          : {}),
        // d1109-cred-engine, as the daemon's `credentialAskFor`: the ask card is worded in the
        // person's clock at the time it was filed; the fake keeps every stop's session waiting.
        ...((r.changeCard as { key?: unknown } | null)?.key === "credential:ask"
          ? {
              credentialAsk: {
                timezone: me.timezone,
                nowMs: Date.parse(
                  String((r.changeCard as { filed_at?: unknown }).filed_at ?? r.createdAt),
                ),
                sessionWaits: true,
              },
            }
          : {}),
      },
    );
    // d1109-run-visible (V-6): as the daemon's `requestView`, the Done line's Start.
    const offer = startOfferOf(r.changeCard, r.status, r.projectId) ? { startOffer: true } : {};
    return { ...r, ...words, ...offer };
  };

  /**
   * OJ-06 (d1109-onerepo-join), as the daemon's executor and queue route: a project closed into
   * another takes no new work: '"Beacon" joined "Atlas", so its work runs there.'; null for any
   * other project.
   */
  const joinedRefusalOf = (projectId: string | null | undefined): string | null => {
    const into = projectId ? state.joined[projectId] : undefined;
    const row = into ? state.projects.find((p) => p.id === projectId) : undefined;
    return into && row ? joinedRefusalSentence(row.name, into.name) : null;
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
    } else if (c.req.method === "GET") state.gets.push(c.req.path);
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
    state.costs = clone(COSTS);
    state.sessions = clone(SESSIONS);
    state.projectSessions = clone(PROJECT_SESSIONS);
    state.projectSessionsChat = {};
    state.sessionTasks = clone(SESSION_TASKS);
    state.events = clone(EVENTS);
    state.requests = clone(REQUESTS);
    state.intake = {};
    state.repositoryElsewhere = {};
    state.repositoryOverview = {};
    state.statusIssue = {};
    state.takeOverUndoBlocked = null;
    state.sharedRepository = {};
    state.joinPreviews = {};
    state.joined = {};
    state.joinRefusal = null;
    state.joinUndoBlocked = null;
    state.messages = clone(MESSAGES);
    state.killActive = false;
    state.calls = [];
    state.gets = [];
    state.pendingConfirmation = null;
    state.nextChatReply = null;
    state.nextChatActions = null;
    state.nextChatSources = null;
    state.nextChatTurn = null;
    state.answering?.release();
    state.answering = null;
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
    state.holdSessions = false;
    state.runningExtra = [];
    state.runCredential = {};
    state.runReview = {};
    state.continuesOf = {};
    state.startsWait = {};
    return c.json({ ok: true });
  });
  // l4-starts-sessions (L4-money-208): a person's session waiting to go on, for a browser test:
  // its project's line (`startsWait`) and the run indicator's entry, as the daemon has them.
  app.post("/__test/waiting", async (c) => {
    const body = (await c.req.json()) as { projectId: string; head: string; view: RunningView };
    state.startsWait[body.projectId] = { kind: "continuation", head: body.head };
    state.runningExtra = [
      ...state.runningExtra.filter((r) => r.projectId !== body.projectId),
      body.view,
    ];
    emitRunning();
    return c.json({ ok: true });
  });
  app.post("/__test/hold-sessions", async (c) => {
    const body = (await c.req.json()) as { hold: boolean };
    state.holdSessions = body.hold === true;
    return c.json({ ok: true });
  });
  // d1109-chat-depth: what the next chat turn does beyond its reply (its steps, a hold until
  // Stop, its depth, footer and offer), for a browser test.
  app.post("/__test/next-chat-turn", async (c) => {
    state.nextChatTurn = (await c.req.json()) as FakeDaemonState["nextChatTurn"];
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

  // d1109-run-visible: what runs now, the run indicator's list (the daemon's `GET /running`).
  app.get("/running", (c) => c.json(fakeRunning()));
  app.get("/health", (c) =>
    c.json({
      ...HEALTH,
      version: state.version,
      // As the daemon: the run indicator's first entry, a running session before a waiting one.
      running: (() => {
        const all = fakeRunning();
        const first = all.find((v) => v.state !== "waiting") ?? all[0];
        return first
          ? {
              projectName: first.projectName,
              what: first.what,
              text: first.text,
              waiting: first.state === "waiting",
            }
          : null;
      })(),
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
    // L4-github-115, as the daemon's `projectCard`: a project closed into another has no folder
    // of its own (never the docs clone's path with its id).
    const folder = repository || state.joined[p.id] ? null : (state.folders[p.id] ?? null);
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
      // W15-67, as the daemon's `projectCard`: the wait now, asked only while a task is ready.
      credentialWaitNow: tasks.some((t) => t.display?.key === "ready")
        ? (state.credentialWaitNow[p.id] ?? null)
        : null,
      // As the daemon (`!!rt.provider`): `/me`'s provider, unknown when the fixture names none.
      hasModel: me.provider === undefined ? null : me.provider !== null,
      stopped: state.killActive,
      working,
      // l4-starts-sessions (L4-money-208), as the daemon: the working line in the bar's words.
      workingWhat: session
        ? (fakeRunning().find((v) => v.sessionId === session.id && v.state !== "waiting")?.what ??
          null)
        : null,
      folder,
      // OJ-06, as the daemon: a project closed into another reads where its work went.
      joinedInto: state.joined[p.id]
        ? { text: state.joined[p.id]?.text ?? "", projectId: state.joined[p.id]?.projectId ?? "" }
        : null,
      // d1109-run-visible (V-3), as the daemon: what waits to start, while nothing of it runs.
      startsWait: working ? null : (state.startsWait[p.id] ?? null),
    });
    const includes = Object.entries(state.joined)
      .filter(([, j]) => j.projectId === p.id)
      .flatMap(([id]) => {
        const row = state.projects.find((x) => x.id === id);
        return row ? [{ id: row.id, name: row.name }] : [];
      });
    return {
      ...p,
      statusLine,
      // L4-money-209, as the daemon: the project whose session this one's start waits behind.
      startsAfter:
        !working && state.startsWait[p.id]?.kind === "queued"
          ? ((state.startsWait[p.id] as { behind: string }).behind ?? null)
          : null,
      // L4g-left-4, as the daemon: the project's own start waits (goes on, or a kept Start).
      startWait: working
        ? null
        : state.startsWait[p.id]?.kind === "continuation"
          ? "goes_on"
          : state.startsWait[p.id]?.kind === "kept_start"
            ? "kept"
            : null,
      progress: progressOf(tasks.map((t) => ({ status: t.status as never }))),
      working,
      folder,
      repository,
      // 'sites': as the daemon's card, from "Web pages research may read".
      researchReads: researchReadsLine(webAccessFake(p.id)),
      // OR-07: the repository is also a project that is not on this computer (or together).
      repositoryElsewhere: state.repositoryOverview[p.id] ?? null,
      // OJ-01 and OJ-06 (d1109-onerepo-join), as the daemon's card.
      sharesRepositoryWith: state.sharedRepository[p.id] ?? null,
      joinedInto: state.joined[p.id] ?? null,
      includesWorkOf: includes.length
        ? { text: includesWorkSentence(includes.map((x) => x.name)), projects: includes }
        : null,
    };
  };
  app.get("/projects", (c) => {
    state.projectListReads += 1;
    // As the daemon (active projects only): a project closed into another leaves Home.
    return c.json(state.projects.filter((p) => !state.joined[p.id]).map(projectCardOf));
  });
  /**
   * As the daemon's `RepositoryUse.checkHere`: a project here (not archived, not `except`) that
   * uses the link, as the 409's sentence and details; null when none does.
   */
  const linkInUse = (
    entry: string,
    except?: string,
  ): { message: string; details: Record<string, unknown> } | null => {
    const r = fakeLinkOf(entry);
    if (!r || "host" in r) return null;
    for (const p of state.projects) {
      if (p.status === "archived" || p.id === except) continue;
      for (const theirs of p.repos ?? []) {
        const t = fakeLinkOf(theirs);
        if (!t || "host" in t) continue;
        const same =
          r.kind === "repo"
            ? t.kind === "repo" && t.locator === r.locator
            : t.kind === "folder" && (r.path === t.path || r.path.startsWith(`${t.path}/`));
        if (!same) continue;
        return {
          message: inUseSentence(
            { kind: r.kind, locator: r.kind === "repo" ? r.locator : r.path },
            p.name,
          ),
          details: { cause: "repository_in_use", projectId: p.id, projectName: p.name },
        };
      }
    }
    return null;
  };
  app.post("/projects", async (c) => {
    const parsed = CreateProjectBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    // As the daemon (d1109-onerepo-link, `RepositoryUse.check`): the link first, before
    // anything is written: a URL on another host, a project here that uses it, the repository's
    // own project that is not on this computer (the offer, Take it over, Work together).
    const refuse = (message: string, details: Record<string, unknown>) =>
      c.json({ code: "conflict", message, details }, 409);
    let togetherId: string | null = null;
    let togetherName: string | null = null;
    for (const entry of parsed.data.repos ?? []) {
      const r = fakeLinkOf(entry);
      if (!r) continue;
      if ("host" in r) return refuse(otherHostSentence(r.host), { cause: "other_host" });
      const inUse = linkInUse(entry);
      if (inUse) return refuse(inUse.message, inUse.details);
      const repo = r.kind === "repo" ? r : null;
      const e = repo ? state.repositoryElsewhere[repo.locator] : undefined;
      if (repo && e) {
        const together = parsed.data.together?.project;
        const takeOver = parsed.data.takeOver?.projects;
        if (together && e.canWorkTogether && together === e.ids[0]) {
          togetherId = together;
          togetherName = e.name;
          continue;
        }
        if (
          !together &&
          takeOver &&
          e.canTakeOver &&
          [...takeOver].sort().join() === [...e.ids].sort().join()
        )
          continue;
        return refuse(elsewhereSentence(repo.locator, e, "UTC"), {
          cause: "repository_used_elsewhere",
          projects: e.ids,
          ...(e.name ? { projectName: e.name } : {}),
          canWorkTogether: e.canWorkTogether,
          canTakeOver: e.canTakeOver,
          ...(e.canWorkTogether
            ? { togetherLine: togetherLine(e, !!parsed.data.brief?.trim()) }
            : {}),
          ...(e.canTakeOver
            ? { takeOverLine: takeOverLine(e), takeOverDetails: takeOverDetails(e) }
            : {}),
        });
      }
    }
    // As the daemon: a name another project has is refused in a sentence, nothing written.
    const clash = state.projects.find((p) => p.name === parsed.data.name);
    if (clash) return errorBody(c, 409, "validation", duplicateProjectSentence(clash.name));
    const project: ProjectCard = {
      id: togetherId ?? nextId("proj"),
      name: togetherName ?? parsed.data.name,
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
    // As the daemon (D9, L4-creds-23): a project made with Work together is one, so its Overview
    // says so and its Docs rows say who writes what it does not have.
    if (togetherId)
      state.repositoryOverview[project.id] = {
        kind: "together",
        text: TOGETHER_OVERVIEW_LINE,
        canTakeOver: false,
        takeOverLine: null,
        details: TOGETHER_OVERVIEW_DETAILS,
      };
    // As the daemon (W15-36): `switch: true` (the New project dialog) makes it the active
    // project in the same change, one Changes row whose Undo removes it and puts the previous
    // active project back.
    if (parsed.data.switch === true) {
      const previous = state.projects.find((p) => p.active && p.id !== project.id);
      for (const p of state.projects) p.active = p.id === project.id;
      state.changes.unshift({
        id: nextId("chg"),
        humanId: ME.id,
        agentId: "agent_alice",
        wordsUsed: `New project: ${project.name}`,
        commands: [
          {
            name: "project.create",
            params: {
              name: project.name,
              goal: project.goal,
              repos: project.repos ?? [],
              switch: true,
            },
          },
        ],
        before: { project_id: null, active_project: previous?.id ?? null },
        after: { project_id: project.id, active_project: project.id },
        scope: "global",
        projectId: project.id,
        expiresAt: null,
        undoState: "undoable",
        undoneAt: null,
        source: "ui",
        sentence: `Created the project ${project.name} and made it the active project. Undo.`,
        undoable: true,
        createdAt: new Date().toISOString(),
        version: 1,
      });
    }
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
  // OJ-05 (d1109-onerepo-join): the Make one project dialog's facts, as the test set them.
  app.get("/projects/:id/join-preview", (c) => {
    const p = state.projects.find((x) => x.id === c.req.param("id"));
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    return c.json(
      state.joinPreviews[p.id] ?? {
        projectId: p.id,
        shared: null,
        projects: [],
        ifKept: {},
        keepOnly: null,
        keepOnlyLine: null,
      },
    );
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
  // As the daemon (`POST /projects/:id/intake`, d1109-onerepo-link's Add to it): a new brief
  // for a project that exists files its plan card in the Inbox (202); while one waits, the
  // answer names the project and what to do, never an id. A project with tasks, or one worked
  // on together, gets the plan-only form (OR-08): its card says `plan_only` and names no place
  // documents go, and the answer's `docsTarget` is null (the review of the fix: the card read
  // "the docs go to the project's repository as a pull request" for a plan that writes none).
  // The options are the daemon's `INTAKE_OPTIONS`; the plan is one task from the brief.
  app.post("/projects/:id/intake", async (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 404, "not_found", "no such project");
    const body = (await c.req.json().catch(() => ({}))) as { brief?: string };
    const key = `intake:${id}`;
    const open = state.requests.find(
      (r) =>
        r.status === "open" &&
        (r.changeCard as { key?: unknown } | null)?.key === key &&
        r.projectId === id,
    );
    if (open && body.brief !== undefined)
      return c.json(
        {
          code: "conflict",
          message: openPlanSentence(project.name),
          details: { requestId: open.id, reason: "proposal_open", cause: "claim_conflict" },
        },
        409,
      );
    const planOnly =
      state.tasks.some((t) => t.projectId === id) ||
      state.repositoryOverview[id]?.kind === "together";
    const docsTarget = planOnly
      ? null
      : (project.repos ?? []).length > 0
        ? ("repository" as const)
        : ("workspace" as const);
    const title = (body.brief ?? project.goal).trim().split("\n")[0]?.slice(0, 80) || project.name;
    const requestId = open?.id ?? nextId("req");
    if (!open)
      state.requests.unshift({
        id: requestId,
        projectId: id,
        projectName: project.name,
        taskId: null,
        taskTitle: null,
        sessionId: null,
        kind: "approval",
        why: planOnly
          ? `Intake for "${project.name}": 1 milestone(s), 1 new task(s) and a first-session plan of 1 task. Approve to add them to the project; nothing is written until then.`
          : `Intake for "${project.name}": 1 milestone(s), 1 task(s), 0 doc(s) and a first-session plan of 1 task. Approve to write the plan and the docs; nothing is written until then.`,
        steps: [],
        options: ["Approve and start", "Change the plan", "Reject"],
        blocking: true,
        risk: "medium",
        changeCard: {
          key,
          project_id: id,
          proposal: {
            plan: {
              reason: "the brief",
              milestones: [
                {
                  name: "From the brief",
                  successCriteria: [],
                  targetDate: null,
                  tasks: [{ key: "brief", title, priority: 5, dependsOn: [] }],
                },
              ],
              tasks: [],
            },
            docs: {},
            firstSession: { summary: title, items: [{ key: "brief", estimateUsdMicro: 300_000 }] },
          },
          cost_usd_micro: 0,
          ...(planOnly ? { plan_only: true } : { docs_target: docsTarget }),
          applied_at: null,
        },
        status: "open",
        answer: null,
        createdAt: new Date().toISOString(),
        version: 1,
      } as HumanRequestView);
    state.intake[id] = {
      projectId: id,
      state: "pending",
      requestId,
      outcome: null,
      appliedAt: null,
      docs: null,
      error: null,
    };
    emit("project.changed", { id });
    return c.json(
      {
        pending: true,
        projectId: id,
        requestId,
        reused: !!open,
        summary: { milestones: 1, tasks: 1, docs: 0, firstSessionTasks: 1 },
        estimateUsdMicro: 300_000,
        costUsdMicro: 0,
        docsTarget,
      },
      202,
    );
  });
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
    // l4-chat-answers (L4-chat-103), as the daemon's resultAfterWait: a stored "...; then your
    // session goes on." reads "...; then it runs at your next Start." once no wait is kept.
    const kept =
      !!state.credentialWaitNow[id]?.kept ||
      state.startsWait[id]?.kind === "continuation" ||
      state.startsWait[id]?.kind === "kept_start";
    const last =
      base.lastSession && !kept
        ? {
            ...base.lastSession,
            summary: base.lastSession.summary.replace(
              "; then your session goes on.",
              "; then it runs at your next Start.",
            ),
          }
        : base.lastSession;
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
    // d1109-sessions: the Overview's "All N sessions" counts what the Sessions list holds.
    const sessionCount =
      (state.projectSessions[id] ?? []).length +
      state.sessions.filter(
        (s) => s.projectId === id && ["running", "paused", "planned"].includes(s.status),
      ).length;
    return c.json({
      ...base,
      ...(last ? { lastSession: { ...last, ...(since.length ? { since } : {}) } } : {}),
      next,
      sessionCount,
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
  /** W15-04, as the daemon's `task.reopen`: a done task's open merge cards, withdrawn by its Redo. */
  const withdrawMergeCards = (taskId: string): string[] => {
    const ids: string[] = [];
    for (const r of state.requests)
      if (
        r.taskId === taskId &&
        r.status === "open" &&
        (r.changeCard as { key?: unknown } | null)?.key === "merge:left_open"
      ) {
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
    // OJ-06, as the daemon's executor: a project closed into another takes no new task.
    const closed = joinedRefusalOf(id);
    if (closed) return errorBody(c, 409, "conflict", closed);
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
      spent: money(0),
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
          ? `#${n} is not merged, so the work of ${title} is not in main: close #${n} on GitHub if you do not want it.`
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
    // W15-04, as the daemon's `task.reopen`: Redo of a done task answers its open merge card (a
    // conflict notice, a rebuild's card) as the card's own Redo does, with the move's other cards
    // (its Undo opens it again), and the redo starts from main.
    const fromMain = action === "redo" && from === "done" ? withdrawMergeCards(task.id) : [];
    withdrawnIds.push(...fromMain);
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
        fromMain: fromMain.length > 0,
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
      sentence: `${titles.length ? `"${task.title}" now waits for ${list}.` : `"${task.title}" waits for no other task now.`}${fakeDependenciesNextLine(state.tasks, task)}${noteId ? " Your note goes into its next brief." : ""}`,
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
        continuing: fakeContinuing(state.requests),
        held: fakeHeld(state.tasks, state.requests, state.taskMeta.pausedByPerson, id),
      },
    );
    // leftovers7-tailrun TR-12: a planning call holds the agent, as the daemon says it.
    if (options.agentPlanning) {
      view.busy = true;
      view.planning = true;
    }
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
    // As the daemon (R-startcred): tasks would run, but each one's credential waits.
    const credentialWait = state.credentialWaitNow[id];
    if (credentialWait && !view.blocked && view.runnable.length > 0)
      view.blocked = {
        kind: "nothing_runnable",
        // W15-78: one sentence with a subject, as the daemon's `startBlocked`.
        // l4-cred-screens (L4-creds-26), as the daemon: a kept person Start says when it starts.
        sentence: credentialWait.startable
          ? credentialWait.text
          : credentialWait.kept && credentialWait.startsAt
            ? `${credentialWait.startsAt}.`
            : nothingRunsYetSentence(credentialWait.text),
        action: credentialWait.save
          ? { kind: "link", label: credentialWait.save.label, to: credentialWait.save.to }
          : null,
        ...(credentialWait.startable ? { startable: true } : {}),
        ...(credentialWait.kept ? { kept: true } : {}),
        // d1109-starts-engine S-10, as the daemon: a Start now is kept for the reset.
        ...(credentialWait.startable && fakeResetAt(credentialWait.text)
          ? { startLabel: `Start at ${fakeResetAt(credentialWait.text)}` }
          : {}),
      };
    // d1109-cred-screens (CS-3), as the daemon: which Claude does the work, and when the
    // project's own session already waits, its line in place of the wait's sentence. As the
    // daemon (the review of the fix-up): a start that runs nothing (unless the project's own
    // session waits) or that Stop all refuses says nothing of the stop and offers no Use API key.
    view.credential = state.startCredential[id] ?? null;
    if (
      view.credential?.runOut &&
      (state.killActive ||
        (view.runnable.length === 0 && !view.oversized && !view.credential.runOut.goesOnLine))
    )
      view.credential = { line: null, runOut: null };
    const goesOn = view.credential?.runOut?.goesOnLine ?? null;
    const stoppedLine = view.credential?.runOut?.stoppedLine ?? null;
    if (goesOn && view.blocked) view.blocked = { ...view.blocked, sentence: goesOn };
    else if (stoppedLine && view.blocked?.startable)
      view.blocked = { ...view.blocked, sentence: stoppedLine };
    // C2-left-2 and L4g-left-1 are the start check's own (`fakeHeld`), as in the daemon.
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
  // d1109-sessions (ADR 0116), as the daemon: the project's sessions, the working ones on top
  // (first page) in the project's working sentence, then the ended ones newest first, a page at
  // a time with an opaque cursor; 404 "No such project.", 400 for a cursor it cannot read.
  app.get("/projects/:id/sessions", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 404, "not_found", "No such project.");
    const rawLimit = Number(c.req.query("limit") ?? "20");
    const limit = Math.max(1, Math.min(50, Number.isInteger(rawLimit) ? rawLimit : 20));
    const before = c.req.query("before");
    const ended = state.projectSessions[id] ?? [];
    let from = 0;
    if (before) {
      const at = fakeSessionsCursorId(before);
      const index = at === null ? -1 : ended.findIndex((r) => r.id === at);
      if (index < 0)
        return errorBody(
          c,
          400,
          "validation",
          "This list cannot go on from there. Open Sessions again.",
        );
      from = index + 1;
    }
    const working = before
      ? []
      : state.sessions
          .filter((s) => s.projectId === id && ["running", "paused", "planned"].includes(s.status))
          .map((s) => {
            // As the daemon's `workingWords` (d1109-run-visible): the run indicator's words.
            const gist =
              fakeRunning().find((v) => v.sessionId === s.id)?.text ??
              `${state.projects.find((p) => p.id === id)?.name ?? ""} · picks the next task`;
            return fakeWorkingRow(s, gist);
          });
    const rows = ended.slice(from, from + limit);
    const last = rows[rows.length - 1];
    const next = from + limit < ended.length && last ? fakeSessionsCursor(last) : null;
    return c.json(
      ProjectSessionsView.parse({
        projectId: id,
        count: working.length + ended.length,
        working,
        rows,
        next,
        chat: before ? null : (state.projectSessionsChat[id] ?? null),
        // OJ-10, as the daemon: the projects joined into this one kept their sessions.
        joined: before
          ? []
          : Object.entries(state.joined)
              .filter(
                ([closedId, j]) => j.projectId === id && state.projectSessions[closedId]?.length,
              )
              .map(([closedId]) => {
                const name = state.projects.find((p) => p.id === closedId)?.name ?? "";
                const count = state.projectSessions[closedId]?.length ?? 0;
                return {
                  projectId: closedId,
                  name,
                  count,
                  words: sessionsBeforeJoinSentence(name, count),
                };
              }),
      }),
    );
  });
  app.get("/sessions/:id/tasks", (c) => {
    const id = c.req.param("id");
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return errorBody(c, 404, "not_found", "no such session");
    return c.json({ sessionId: id, projectId: s.projectId, tasks: state.sessionTasks[id] ?? [] });
  });
  // d1109-starts-engine (S-10), as the daemon: Cancel on a session that waits to go on after its
  // Claude credential (a wait marked `kept`): the wait stays, its kept start goes, and the tasks
  // wait for the next Start ("; then it runs at your next Start.").
  app.post("/projects/:id/continuation/cancel", (c) => {
    const project = state.projects.find((p) => p.id === c.req.param("id"));
    if (!project) return errorBody(c, 404, "not_found", "no such project");
    // d1109-run-visible (V-5): the session page's block says what is true after Cancel.
    for (const sess of state.sessions)
      if (sess.projectId === project.id && sess.id in state.waitBlockAfterCancel) {
        sess.waitBlock = state.waitBlockAfterCancel[sess.id] ?? null;
        delete state.waitBlockAfterCancel[sess.id];
      }
    // d1109-run-visible: a continuation or a kept Start on the project's line goes with it;
    // l4-starts-sessions (L4-money-209): so does a person's start waiting in line.
    const startsWait = state.startsWait[project.id];
    if (
      startsWait?.kind === "continuation" ||
      startsWait?.kind === "kept_start" ||
      startsWait?.kind === "queued"
    ) {
      delete state.startsWait[project.id];
      state.runningExtra = state.runningExtra.filter(
        (r) => !(r.state === "waiting" && r.projectId === project.id),
      );
      emit("project.changed", { id: project.id });
      emitRunning();
      if (startsWait.kind === "queued")
        return c.json({
          cancelled: true,
          sentence: `Cancelled: the session of ${project.name} does not start; its tasks wait for your Start.`,
        });
      if (!state.credentialWaitNow[project.id]?.kept)
        return c.json({
          cancelled: true,
          sentence: "Cancelled: nothing goes on by itself; its tasks run at your next Start.",
        });
    }
    const wait = state.credentialWaitNow[project.id];
    if (!wait?.kept)
      return c.json({ cancelled: false, sentence: "Nothing waits to go on for this project." });
    state.credentialWaitNow[project.id] = {
      text: wait.text.replace("; then your session goes on.", "; then it runs at your next Start."),
      save: wait.save,
    };
    // d1109-run-visible: the run indicator's waiting entry goes with it.
    state.runningExtra = state.runningExtra.filter(
      (r) => !(r.state === "waiting" && r.projectId === project.id),
    );
    emitRunning();
    return c.json({
      cancelled: true,
      sentence: "Cancelled: nothing goes on by itself; its tasks run at your next Start.",
    });
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
    // S-10 and L4g-left-4, as the daemon: one wait per project: while the project's own session
    // waits to go on (or a Start is kept for the reset), a start keeps nothing new and starts
    // nothing (409 with when it goes on). "Use API key" is the wait's own answer (below).
    const ownWait = parsed.data.projectId ? state.startsWait[parsed.data.projectId] : undefined;
    if (
      !parsed.data.useOtherCredential &&
      (ownWait?.kind === "continuation" || ownWait?.kind === "kept_start")
    )
      return errorBody(
        c,
        409,
        "claim_conflict",
        ownWait.kind === "continuation"
          ? `${ownWait.head}; then your session goes on.`
          : `${ownWait.head}.`,
      );
    // d1109-cred-screens (CS-3), as the daemon: the Start dialog's "Use API key" is the person's
    // yes for this stop; refused in words when the dialog offered none. The project's wait ends
    // (the key serves), and the start goes on as usual below.
    if (parsed.data.useOtherCredential && parsed.data.projectId) {
      const offered = state.startCredential[parsed.data.projectId]?.runOut;
      // As the daemon: nothing to run is refused with the start's own sentence, before any yes.
      const check = fakeStartCheck(
        state.tasks,
        parsed.data.projectId,
        parsed.data.budgetUsdMicro ?? null,
        state.sandbox,
        {
          killActive: false,
          busy: (options.startOutcome ?? "started") === "queued",
          busyHere: options.busyProjectId === parsed.data.projectId,
          continuing: fakeContinuing(state.requests),
          held: fakeHeld(
            state.tasks,
            state.requests,
            state.taskMeta.pausedByPerson,
            parsed.data.projectId,
          ),
        },
      );
      if (
        check.blocked?.kind === "nothing_runnable" &&
        check.runnable.length === 0 &&
        !check.oversized &&
        !offered?.goesOnLine
      )
        return errorBody(c, 400, "validation", check.blocked.sentence);
      if (!offered)
        return errorBody(
          c,
          400,
          "validation",
          "Use API key is not offered for this start now: open Start again to see what it does.",
        );
      state.credentialGrants.push(parsed.data.projectId);
      delete state.credentialWaitNow[parsed.data.projectId];
      state.startCredential[parsed.data.projectId] = null;
    }
    // d1109-starts-engine (S-10), as the daemon: Continue goes on with the ended session, with the
    // rest of its budget (its cap less its spend, less what a session that already went on with
    // it took: its spend, or its cap while it works), and is refused in words when none is left.
    if (parsed.data.continues) {
      const earlier = state.sessions.find((x) => x.id === parsed.data.continues);
      if (!earlier) return errorBody(c, 404, "not_found", "no such session");
      const taken = state.sessions
        .filter((x) => x.id !== earlier.id && state.continuesOf[x.id] === earlier.id)
        .reduce((n, x) => n + (x.endedAt ? x.spent.usdMicro : x.budgetCap.usdMicro), 0);
      const left = earlier.budgetCap.usdMicro - earlier.spent.usdMicro - taken;
      if (left <= 0)
        return errorBody(
          c,
          409,
          "validation",
          "That session used its whole budget: start a new one to go on.",
        );
      parsed.data.projectId ??= earlier.projectId ?? undefined;
      parsed.data.budgetUsdMicro = left;
    }
    // W15B-02, as the daemon: a removed project (its creation undone) starts nothing, refused in
    // one sentence with its name before the removal (the daemon keeps it in the settings; the
    // fake's card has only "<name> (removed)").
    const removed = state.projects.find(
      (p) => p.id === parsed.data.projectId && p.status === "archived",
    );
    if (removed)
      return errorBody(
        c,
        409,
        "conflict",
        `The project "${removed.name.replace(/ \(removed(?: \d+)?\)$/, "")}" was removed, so nothing of it runs.`,
      );
    // d1109-starts-engine S-10, as the daemon: while a credential's reset no Start kept yet holds
    // the work, the Start is kept for the reset: no session now, its sentence says when, and the
    // wait reads as the person's kept Start (Cancel the wait drops it).
    const resting = parsed.data.projectId ? state.credentialWaitNow[parsed.data.projectId] : null;
    // l4-starts-carried (L4d-left-2), as the daemon: a refused credential the work needs refuses
    // a person's start in the Start dialog's sentence, kept session or not; nothing starts.
    if (
      parsed.data.projectId &&
      resting &&
      !resting.startable &&
      resting.save?.to === "/setup" &&
      !parsed.data.useOtherCredential &&
      state.tasks.some((t) => t.projectId === parsed.data.projectId && t.status === "ready")
    )
      return errorBody(
        c,
        400,
        "validation",
        resting.kept && resting.startsAt
          ? `${resting.startsAt}.`
          : nothingRunsYetSentence(resting.text),
      );
    const at = resting?.startable ? fakeResetAt(resting.text) : null;
    if (parsed.data.projectId && resting && at) {
      const project = state.projects.find((p) => p.id === parsed.data.projectId);
      const limit = /\(([^)]+)\)/.exec(resting.text)?.[1] ?? "its limit";
      state.credentialWaitNow[parsed.data.projectId] = {
        text: `Waits until ${at} (${limit}); then your session goes on.`,
        save: null,
        kept: true,
      };
      return c.json(
        StartSessionView.parse({
          result: "kept",
          startId: "",
          session: null,
          sentence: `A session of ${project?.name ?? "the project"} starts at ${at}.`,
        }),
        202,
      );
    }
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
          continuing: fakeContinuing(state.requests),
          held: fakeHeld(
            state.tasks,
            state.requests,
            state.taskMeta.pausedByPerson,
            parsed.data.projectId,
          ),
        },
      );
      // l4-cred-screens (L4-creds-21), as the daemon: a refusal in words is a 400 "validation".
      if (check.blocked?.kind === "nothing_runnable")
        return errorBody(c, 400, "validation", check.blocked.sentence);
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
    if (parsed.data.continues) state.continuesOf[session.id] = parsed.data.continues;
    // As the daemon's `closeByStart` (d1109-oversize-pause, OP-0): the session takes a task paused
    // at a session's budget (or its specialist's limit) that got further in its turn; its card
    // closes with the Done line and the task is ready again. A pause at its own budget, one that
    // got no further and one at an outer limit stay on their cards.
    if (parsed.data.projectId) {
      const continuing = fakeContinuing(state.requests);
      const startedAt = session.startedAt ?? new Date().toISOString();
      const at = startedAt.slice(11, 16);
      for (const r of state.requests) {
        if (r.status !== "open" || !r.taskId || !continuing.has(r.taskId)) continue;
        const task = state.tasks.find(
          (t) => t.id === r.taskId && t.projectId === parsed.data.projectId,
        );
        if (task?.status !== "needs_human") continue;
        task.status = "ready";
        task.reason = "this session goes on with it from where it stopped";
        touch(task);
        r.status = "withdrawn";
        r.version += 1;
        r.changeCard = {
          ...((r.changeCard ?? {}) as Record<string, unknown>),
          applied_at: startedAt,
          outcome: "went_on_at_start",
          started_session_id: session.id,
          started_session_time: at,
        };
      }
      emit("inbox.changed", { blockingCount: blockingCount() });
    }
    return c.json(StartSessionView.parse({ result: "started", startId, session }), 202);
  });
  app.get("/sessions/:id", (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param("id"));
    return s ? c.json(s) : errorBody(c, 404, "not_found", "no such session");
  });
  /**
   * d1109-selftasks-chat (SC-6), as the daemon: a change line names its change log row and
   * whether its Undo works now, else why not in words.
   */
  const withChangeUndo = (e: EventView): EventView => {
    const changeLogId = (e.payload as { changeLogId?: unknown } | null)?.changeLogId;
    if (e.type !== "change" || typeof changeLogId !== "string") return e;
    const entry = state.changes.find((ch) => ch.id === changeLogId);
    if (!entry) return e;
    const view = withUndoable(entry, new Date().toISOString());
    // l4-chat-carried (L4-selftasks-129), as the daemon: an undone line keeps the undo's sentence.
    const undoneSentence =
      entry.undoState === "undone"
        ? state.changes.find((ch) => {
            const step = ch.commands[0] as { name?: string; params?: { of?: unknown } } | undefined;
            return step?.name === "undo" && step.params?.of === entry.id;
          })?.sentence
        : undefined;
    return {
      ...e,
      changeId: entry.id,
      undoable: view.undoable,
      undoBlocked: view.undoable ? null : (view.undoBlockedReason ?? null),
      undone: entry.undoState === "undone",
      ...(undoneSentence ? { undoneSentence } : {}),
    };
  };
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const session = state.sessions.find((x) => x.id === id);
    if (!session) return errorBody(c, 404, "not_found", "no such session");
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const backlog = state.events
      .filter((e) => e.sessionId === id && e.seq > afterSeq)
      .map(withChangeUndo);
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
    // As the daemon (S-10): Stop all drops every session kept to go on after its credential wait.
    state.runningExtra = state.runningExtra.filter((r) => r.state !== "waiting");
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
          // W15B-07, as the daemon: who reads web pages, from the registry entry.
          readsWeb: (name) => (FAKE_REGISTRY_TOOLS[name] ?? []).includes("cc:WebFetch"),
          // As the daemon: the figure the Start dialog will show (leftovers7-session), and the
          // project's site rule the notes read (W15B-07).
          estimate: {
            project: {
              name: r.projectId ?? "",
              small_project_mode: false,
              settings: {
                web_access: (state.settingValues[`web_access:${r.projectId}`] ?? null) as never,
              },
            },
            of: (t) => Math.round(t.est_cost_usd_micro * (state.planEstimateRatio ?? 1)),
          },
          // D4 (d1109-oversize-start), as the daemon: the project's session work budget (the
          // fake's default session cap less the fifth kept for reviews).
          workBudget: {
            usdMicro: async () => Math.floor(FAKE_SESSION_CAP_USD_MICRO * 0.8),
            chfPerUsd: 0.8,
          },
        },
      );
      if (planTasks) r.planTasks = planTasks;
      // d1109-cred-screens (CS-4), as the daemon: the plan card's foot line, read when shown
      // (`state.planCredentialLine`, as `planCredentialLine` words it).
      if (planTasks) r.planCredentialLine = state.planCredentialLine;
    }
    return c.json({
      requests,
      // L4-money-207, as the daemon's `crashContinueOf`: a restart's Update about an interrupted
      // session offers Continue while a task of its project is ready, its budget has something
      // left, no session of the project works now and none began since it ended.
      messages: state.messages.map((m) => {
        if (m.type !== "info" || !m.projectId || !m.body.startsWith(INTERRUPTED_UPDATE_LEAD))
          return m;
        if (
          state.sessions.some(
            (s) =>
              s.projectId === m.projectId && ["running", "paused", "planned"].includes(s.status),
          )
        )
          return m;
        const ended = state.sessions.find(
          (s) => s.projectId === m.projectId && s.stopReason === "interrupted",
        );
        const left = ended ? ended.budgetCap.chfMicro - ended.spent.chfMicro : 0;
        const ready = state.tasks.some((t) => t.projectId === m.projectId && t.status === "ready");
        const later = state.sessions.some(
          (s) =>
            s.projectId === m.projectId &&
            s.id !== ended?.id &&
            (s.startedAt ?? "") > (ended?.endedAt ?? ""),
        );
        if (!ended || left <= 0 || !ready || later) return m;
        const budgetLeft = {
          usdMicro: ended.budgetCap.usdMicro - ended.spent.usdMicro,
          chfMicro: left,
        };
        return {
          ...m,
          action: {
            kind: "continue" as const,
            label: "Continue",
            explain: `Opens Start with the rest of your last session and the ${formatChf(left)} left of its budget.`,
            projectId: m.projectId,
            sessionId: ended.id,
            budgetLeft,
          },
        };
      }),
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
  /**
   * As the daemon's `syncTaskProposals` (d1109-selftasks-run, ADR 0119 point 7): the agent's
   * suggested task changes, approved with "Make these changes", are made as ONE change with one
   * Undo, each checked on the tasks now (a split of a task that is no longer Draft or Ready is
   * left out and named). The person answered in the app, so the row's source is `ui`. Nothing
   * starts a session.
   */
  const applyTaskProposal = (r: HumanRequestView, card: Record<string, unknown>) => {
    const project = state.projects.find((p) => p.id === r.projectId);
    const changes = (Array.isArray(card.changes) ? card.changes : []) as {
      line: string;
      calls: { name: string; params: Record<string, unknown> }[];
    }[];
    const leftOut: string[] = [];
    const said: string[] = [];
    const undoWords: string[] = [];
    const restore: { id: string; title: string; acceptanceCriteria: string[] }[] = [];
    const created: string[] = [];
    const added: string[] = [];
    const waited: { id: string; dependsOn: string[] }[] = [];
    const calls: { name: string; params: Record<string, unknown> }[] = [];
    let changed = 0;
    const statusWord = (s: string) => (s === "needs_human" ? "paused" : s.replace(/_/g, " "));
    const newTask = (
      from: Partial<TaskView> & Pick<TaskView, "title" | "outcome" | "acceptanceCriteria">,
      reason: string,
    ): TaskView => {
      const task: TaskView = {
        id: nextId("task"),
        projectId: r.projectId ?? "",
        milestoneId: from.milestoneId ?? null,
        title: from.title,
        outcome: from.outcome,
        acceptanceCriteria: from.acceptanceCriteria,
        riskTier: from.riskTier ?? 1,
        status: "ready",
        priority: from.priority ?? "medium",
        claimedBy: null,
        claimExpires: null,
        dependsOn: from.dependsOn ?? [],
        budget: money(0),
        estimate: money(0),
        actual: money(0),
        spent: money(0),
        cap: money(3_000_000),
        capSource: "specialist_limit",
        specialist: from.specialist ?? null,
        attempt: 0,
        prUrl: null,
        branch: null,
        reason,
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      state.tasks.push(task);
      state.taskMeta.added.set(task.id, state.taskMeta.added.size + 1000);
      created.push(task.id);
      return task;
    };
    for (const change of changes) {
      const split = change.calls.find((x) => x.name === "task.split");
      const target = split ? state.tasks.find((t) => t.id === split.params.task) : undefined;
      if (split && (!target || !["draft", "ready"].includes(target.status))) {
        leftOut.push(
          `${change.line.replace(/\.$/, "")}: ${target ? `"${target.title}" is ${statusWord(target.status)}, so it is not split.` : "the task is gone."}`,
        );
        continue;
      }
      for (const call of change.calls) {
        calls.push(call);
        if (call.name === "task.split" && target) {
          const parts = (call.params.parts ?? []) as {
            title: string;
            acceptance_criteria?: string[];
          }[];
          const was = target.title;
          restore.push({
            id: target.id,
            title: target.title,
            acceptanceCriteria: [...target.acceptanceCriteria],
          });
          for (const t of state.tasks)
            if (t.dependsOn.includes(target.id))
              waited.push({ id: t.id, dependsOn: [...t.dependsOn] });
          target.title = parts[0]?.title ?? target.title;
          target.acceptanceCriteria = parts[0]?.acceptance_criteria ?? target.acceptanceCriteria;
          touch(target);
          let previous = target;
          const madeIds: string[] = [];
          for (const part of parts.slice(1)) {
            const made = newTask(
              {
                ...target,
                title: part.title,
                acceptanceCriteria: part.acceptance_criteria ?? [],
                dependsOn:
                  call.params.order === "side_by_side" ? [...target.dependsOn] : [previous.id],
              },
              `Split from "${was}" by the agent`,
            );
            madeIds.push(made.id);
            previous = made;
          }
          for (const w of waited)
            if (w.dependsOn.includes(target.id)) {
              const t = state.tasks.find((x) => x.id === w.id);
              if (t) t.dependsOn = [...new Set([...t.dependsOn, ...madeIds])];
            }
          said.push(change.line);
          undoWords.push(`"${was}" is one task again`);
        }
        if (call.name === "task.create") {
          const p = call.params;
          const made = newTask(
            {
              title: String(p.title),
              outcome: String(p.outcome ?? ""),
              acceptanceCriteria: (p.acceptance_criteria as string[] | undefined) ?? [],
              specialist: typeof p.specialist === "string" ? p.specialist : null,
              dependsOn: (p.depends_on as string[] | undefined) ?? [],
            },
            "Added by the agent",
          );
          added.push(made.id);
          said.push(
            `Added "${made.title}" to ${project?.name ?? "the project"}${made.specialist ? `, for the ${made.specialist}` : ""}.`,
          );
          undoWords.push(`cancelled the task "${made.title}" you created`);
        }
      }
      changed += 1;
    }
    const at = new Date().toISOString();
    if (!changed) {
      r.changeCard = { ...card, outcome: "not_applied", left_out: leftOut };
      return;
    }
    const entry: ChangeLogView = {
      id: nextId("chg"),
      humanId: ME.id,
      agentId: "agent_alice",
      wordsUsed: TASK_PROPOSAL_OPTIONS[0],
      commands: calls,
      before: { tasks: restore, waited } as never,
      after: {
        task_proposal: {
          restore,
          created,
          added,
          waited,
          words: `Undone: ${undoWords.join("; ")}.`,
        },
      } as never,
      scope: "project",
      projectId: r.projectId ?? null,
      expiresAt: null,
      undoState: "undoable",
      undoneAt: null,
      source: "ui",
      sentence: said.join(" "),
      undoable: true,
      createdAt: at,
      version: 1,
    };
    state.changes.unshift(entry);
    const running = state.sessions.some(
      (x) => x.projectId === r.projectId && (x.status === "running" || x.status === "planned"),
    );
    r.changeCard = {
      ...card,
      outcome: "applied",
      changed,
      change_log_id: entry.id,
      approved_task_ids: created,
      running,
      ...(leftOut.length ? { left_out: leftOut } : {}),
    };
    if (r.projectId) emit("project.changed", { id: r.projectId });
  };

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
      // As the daemon's prepareAnswer (d1109-starts-engine S-2, ADR 0118): an answer that leaves
      // a task of the project runnable (the task itself back at ready, or what waited on the
      // person's task now done) prepares it: with no session running here it waits for the
      // person's next Start; nothing runnable, nothing said.
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
        ...(read?.kind !== "cancel" && runnable ? { start: "waits_start" } : {}),
      };
    }
    // d1109-cred-engine CE-7, as the daemon's `syncAskAnswers`: Use API key grants this stop
    // (the waiting work goes on), Wait moves nothing; the card keeps the outcome its Done line
    // reads. The fake runs nothing for the grant.
    const askCard = r.changeCard as { key?: unknown } | null;
    if (askCard?.key === "credential:ask") {
      const use = String(parsed.data.answer).trim().toLowerCase() === "use api key";
      r.changeCard = {
        ...askCard,
        applied_at: new Date().toISOString(),
        outcome: use ? "granted" : "waited",
        session_goes_on: true,
      };
    }
    // As the daemon's `syncSignoffAnswers` (design §3.8): Try again / Send it back sends the task
    // back to ready, prepared for the person's next Start (S-2); Mark done anyway closes it
    // "accepted without review"; Cancel task cancels it.
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
      // As the daemon: what the answer made runnable is prepared; Mark done anyway says so only
      // when work that waited on the task can run now.
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const runnable = state.tasks.some(
        (t) =>
          t.projectId === r.projectId &&
          t.status === "ready" &&
          t.dependsOn.every((d) => byId.get(d)?.status === "done"),
      );
      r.changeCard = {
        ...signCard,
        applied_at: new Date().toISOString(),
        outcome: read,
        ...(read === "revise" || (read === "accept" && runnable) ? { start: "waits_start" } : {}),
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
      const moved = task?.status !== "needs_human";
      let budget: number | null = null;
      let more: number | null = null;
      if (task && !moved && read === "continue") {
        const session = budgetCard.source === "session" || budgetCard.source === "session_budget";
        if (typeof budgetCard.continue_usd_micro === "number") {
          more = budgetCard.continue_usd_micro;
          budget = session
            ? task.budget.usdMicro
            : Math.max(task.budget.usdMicro, fakeTotal(task)) + more;
        } else {
          more = Number(budgetCard.raise_to_usd_micro) || 0;
          budget = session ? task.budget.usdMicro : Math.max(task.budget.usdMicro, more);
        }
        task.budget = money(budget);
        // BA-10: what is left is the budget less the task's one figure.
        task.cap = money(Math.max(0, budget - fakeTotal(task)));
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
    // ready for the person's next Start (S-2); Cancel task cancels it.
    const cannotRun = r.changeCard as { key?: unknown } | null;
    if (cannotRun?.key === "task:cannot_run") {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const read = cannotRunAnswer(parsed.data.answer as never);
      const moved = task?.status !== "needs_human";
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
        ...(!moved && read === "retry" ? { start: "waits_start" } : {}),
      };
    }
    const proposal = r.changeCard as { key?: unknown } | null;
    if (proposal?.key === TASK_PROPOSAL_KEY) {
      if (parsed.data.answer === TASK_PROPOSAL_OPTIONS[0])
        applyTaskProposal(r, proposal as Record<string, unknown>);
      else r.changeCard = { ...proposal, outcome: "kept" };
    }
    if (r.kind === "capability_grant") {
      const ext = state.extensions.find((e) => `req_${e.id}` === r.id);
      if (ext && parsed.data.answer === "Approve") approveExtension(ext);
      else if (ext) {
        state.extensions = state.extensions.filter((e) => e.id !== ext.id);
        emitExtension("extension.denied", ext);
      }
    }
    // l4-selftasks-carried (L4f-left-1), as the daemon's close of a card (`onClosed`): a chat
    // read-back's card is its Inbox request (the same id); answered here, the read-back leaves
    // the chat and its conversation is told (conversation.changed), with the project's line.
    const readBack = state.pendingConfirmation?.id === r.id ? state.pendingConfirmation : null;
    if (readBack) state.pendingConfirmation = null;
    emit("inbox.changed", { blockingCount: blockingCount() });
    if (r.projectId) emit("project.changed", { id: r.projectId });
    if (readBack) emit("conversation.changed", { projectId: r.projectId ?? null });
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
    spent: money(0),
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
  /** fixup-l4-starts-carried: the wait a start kept from chat replaced, by its id (its Undo). */
  const keptBefore = new Map<string, FakeDaemonState["credentialWaitNow"][string]>();
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
    // As the daemon (review of l4-chat-answers): only the reply just before can be answered by
    // pressing one of its project options.
    const asked = state.askedProjectLine;
    state.askedProjectLine = null;
    const pressed = asked ? state.projects.find((p) => p.name.toLowerCase() === lower) : undefined;
    // l4-chat-answers (L4-chat-104): "open X" switches as "switch to X" does (the Chat tab then
    // opens X); "switch to X" in another project's own Chat tab says that tab stays on it.
    const switchTo = /^(?:switch to|open) (.+)$/i.exec(text.trim());
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
          reply: (() => {
            const tab = projectTab ? state.projects.find((p) => p.id === projectId) : undefined;
            return tab && tab.id !== target.id && !/^open\b/i.test(text.trim())
              ? sentence.replace(/ Undo\.$/, ` This chat stays about ${tab.name}. Undo.`)
              : sentence;
          })(),
          actions: [
            { kind: "project.switch", summary: sentence, id: entry.id, undoToken: entry.id },
          ],
        };
      }
    }
    // As the daemon's parser (l4-chat-answers, L4-selftasks-119 and its review): "add a task to
    // <project>: …" adds there; "add a task there: …" with two projects and none named asks
    // "Which project: …?", and the option pressed next adds there; other words stay the title.
    const line = pressed && asked ? asked : text.trim();
    const aimed =
      /^add a task(?:\s+(?:to|in|for)\s+(?:the\s+)?(.+?)|\s+(there))(?:\s*[:,]|\s+[-–—])\s*(.+)$/i.exec(
        line,
      );
    const named = aimed?.[1]
      ? state.projects.find((p) => p.name.toLowerCase() === (aimed[1] ?? "").toLowerCase())
      : undefined;
    if (aimed?.[2] && !pressed && state.projects.length > 1) {
      state.askedProjectLine = line;
      const names = state.projects.slice(0, 6).map((p) => p.name);
      const ask = `Which project: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`;
      return {
        ...base,
        reply: ask,
        question: { text: ask, options: names },
      };
    }
    const addTask =
      (named || aimed?.[2]) && aimed?.[3]
        ? ([line, aimed[3]] as const)
        : /^add a task:?\s+(.+)$/i.exec(line);
    const addTo = pressed?.id ?? named?.id ?? turnProject;
    if (addTask && addTo) {
      const target = state.projects.find((p) => p.id === addTo);
      const words = (addTask[1] ?? "").trim();
      const title = named || aimed?.[2] ? words.charAt(0).toUpperCase() + words.slice(1) : words;
      const task = newTask(addTo, title, "ready");
      state.tasks.push(task);
      const sentence = `Added "${title}" to ${target?.name ?? addTo}.`;
      const entry = pushChange({
        commands: [{ name: "task.create", params: { title, project: addTo } }],
        before: { task_id: null, project_id: addTo },
        after: { task_id: task.id, project_id: addTo, status: "ready" },
        scope: "project",
        projectId: addTo,
        source: "chat",
        wordsUsed: line,
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
      // l4-starts-carried (L4a-left-5), as the daemon: a start kept for the credential's reset
      // starts no session now; the wait reads as the person's kept Start (Cancel drops it).
      if (confirmed.keptAt && turnProject) {
        const target = state.projects.find((p) => p.id === turnProject);
        const resting = state.credentialWaitNow[turnProject];
        const limit = /\(([^)]+)\)/.exec(resting?.text ?? "")?.[1] ?? "its limit";
        // fixup-l4-starts-carried, as the daemon: the start is kept with its own id, and the
        // change it records offers an Undo that drops that start only.
        const keptId = nextId("kept");
        if (resting) keptBefore.set(keptId, { ...resting });
        state.credentialWaitNow[turnProject] = {
          text: `Waits until ${confirmed.keptAt} (${limit}); then your session goes on.`,
          save: null,
          kept: true,
          keptId,
        };
        const sentence = `A session of ${target?.name ?? "the project"} starts at ${confirmed.keptAt}.`;
        const entry = pushChange({
          commands: [{ name: "session.start", params: { project: turnProject } }],
          before: { session_id: null, remote_command_id: null },
          after: { session_id: null, kept_start: true, kept_id: keptId, project_id: turnProject },
          scope: "session",
          projectId: turnProject,
          source: "chat",
          wordsUsed: confirmed.words ?? line,
          sentence,
          reversible: true,
        });
        return {
          ...base,
          reply: sentence,
          actions: [
            {
              kind: "session.start",
              summary: sentence,
              id: confirmed.id,
              undoToken: entry.id,
            },
          ],
        };
      }
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
      const sentence = `Started a session on ${target?.name ?? "this project"} (up to CHF 5.00).`;
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
      // l4-chat-answers (L4-chat-102): the line names a next step.
      return {
        ...base,
        reply:
          'Yes to what? Nothing is waiting for your yes. Say what you want done, for example "run it now" to start a session.',
      };
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
      const sources = state.nextChatSources;
      state.nextChatReply = null;
      state.nextChatActions = null;
      state.nextChatSources = null;
      return { ...base, reply, actions, ...(sources?.length ? { sources } : {}) };
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
    // l4-chat-depth (L4-chat-210), as the daemon's session.start read-back from chat: the
    // project's name and the budget with two decimals.
    if (/^(?:run it now|start now|start working now)[.!]?$/.test(lower) && turnProject) {
      const id = nextId("confirm");
      const name = state.projects.find((p) => p.id === turnProject)?.name ?? "this project";
      // l4-starts-carried (L4a-left-5), as the daemon: while the credential rests and nothing is
      // kept, the start is kept for its reset and read back with its time.
      const resting = state.credentialWaitNow[turnProject];
      const keptAt = resting?.startable ? fakeResetAt(resting.text) : null;
      const readback = keptAt
        ? `Start a session on ${name} at ${keptAt} (up to CHF 5.00)?`
        : `Start a session on ${name} (up to CHF 5.00)?`;
      state.pendingConfirmation = { id, readback, words: line, ...(keptAt ? { keptAt } : {}) };
      return {
        ...base,
        reply: readback,
        pendingConfirmation: {
          id,
          readback,
          estimate: money(6_250_000),
          commands: ["session.start"],
          decision: "needs_yes",
        },
      };
    }
    if (lower.includes("start a session")) {
      const id = nextId("confirm");
      // D4 (d1109-oversize-start), as the daemon's startWarning: a session that would take a
      // task larger than its work budget reads the warning back after its question.
      const big = turnProject
        ? fakeStartCheck(state.tasks, turnProject, null, state.sandbox)
        : null;
      // d1109-oversize-pause (OP-0): then the tasks after it in the plan's order.
      const warning = big?.oversized
        ? ` ${oversizedAsk(big.oversized.title, {
            chfMicro: big.workBudget.chfMicro,
            text: formatChf(big.workBudget.chfMicro),
          })}${big.oversized.afterSentence ? ` ${big.oversized.afterSentence}` : ""}`
        : "";
      const readback = `You want to start a session with a budget of CHF 4.00.${warning}`;
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
          spent: money(0),
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
  /**
   * l4-cred-screens (L4-creds-19), as the daemon: the one-off press answers the newest held turn
   * with the same words in its place, so its line and hold reply leave the conversation.
   */
  const dropHeldTurn = (body: ChatRequestBody) => {
    if (!body.oneOff || !body.heldTurn) return;
    const key = body.projectId ?? "";
    const turns = state.conversations.get(key) ?? [];
    const last = turns.at(-1);
    if (last?.id === body.heldTurn && last.reply?.oneOff && last.said.trim() === body.text.trim())
      state.conversations.set(key, turns.slice(0, -1));
  };
  const keepTurn = (body: ChatRequestBody, reply: ChatReplyView, failed = false): ChatReplyView => {
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
        notice: failed,
        readback,
        waiting: !!reply.pendingConfirmation,
        card: reply.pendingConfirmation ? "waiting" : null,
        // d1109-chat-recall: the records the reply rests on, as the daemon keeps them.
        ...(reply.sources?.length ? { sources: reply.sources } : {}),
        // d1109-chat-depth: how deep it went and the lines under it.
        depth: reply.depth ?? "quick",
        footer: reply.footer ?? null,
        offer: reply.offer ?? null,
        oneOff: reply.oneOff ?? null,
      },
      // L4-creds-4: a reply that says the answer failed (Ask again under it).
      ...(failed ? { failed: true } : {}),
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
    // As the daemon: only the newest answer's offer can be taken.
    turns.forEach((t, i) => {
      if (t.reply?.offer && i < turns.length - 1)
        t.reply = { ...t.reply, offer: { ...t.reply.offer, action: null } };
    });
    const a = state.answering && state.answering.key === key ? state.answering : null;
    return {
      projectId: key || null,
      turns,
      answering: a ? { turnId: a.turnId, step: a.step, since: a.since, depth: a.depth } : null,
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

  // As the daemon (W15-29): what a chat turn changed is heard by the screens, its project as
  // `project.changed` and a card waiting for a yes as `inbox.changed`.
  const heardChat = (
    reply: ChatReplyView,
    projectId: string | null | undefined,
    closed: string | null = null,
    said = "",
  ) => {
    // l4-selftasks-carried (L4f-left-1), as the daemon's close of a card: a yes or a no in chat
    // answers the read-back's Inbox request (the same id), and the screens hear it at once.
    const card = closed
      ? state.requests.find((r) => r.id === closed && r.status === "open")
      : undefined;
    if (card) {
      card.status = "answered";
      // As the daemon's executor (verdict "no" for a cancel): the answer is what chat said.
      card.answer = /^\s*(?:no|nein)\b/i.test(said) ? "no" : "yes";
      card.version += 1;
    }
    if ((reply.actions.length || card) && projectId) emit("project.changed", { id: projectId });
    if (reply.pendingConfirmation || card)
      emit("inbox.changed", { blockingCount: blockingCount() });
  };
  app.post("/chat", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const extra = state.nextChatTurn;
    state.nextChatTurn = null;
    state.chatPosts.push({ text: parsed.data.text, oneOff: parsed.data.oneOff === true });
    dropHeldTurn(parsed.data);
    const waitingBefore = state.pendingConfirmation?.id ?? null;
    const base = chatReply(parsed.data.text, parsed.data.projectId, parsed.data.projectTab);
    const closedNow =
      waitingBefore && state.pendingConfirmation?.id !== waitingBefore ? waitingBefore : null;
    const reply = keepTurn(
      parsed.data,
      {
        ...base,
        ...(extra?.reply ? { reply: extra.reply } : {}),
        depth: extra?.depth ?? "quick",
        footer: extra?.footer ?? null,
        offer: extra?.offer ?? null,
        oneOff: extra?.oneOff ?? null,
      },
      extra?.failed === true,
    );
    heardChat(reply, parsed.data.projectId, closedNow, parsed.data.text);
    return c.json(reply);
  });
  // d1109-chat-depth: Stop and Answer now on the turn being answered, as the daemon answers them.
  app.post("/chat/turns/:id/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { humanId?: unknown };
    if (typeof body.humanId === "string" && body.humanId !== ME.id)
      return errorBody(c, 403, "not_yours", "not your conversation");
    const a = state.answering;
    if (!a || a.turnId !== c.req.param("id")) return c.json({ stopped: false });
    a.stopped = true;
    a.step = "Stopping…";
    a.release();
    return c.json({ stopped: true });
  });
  app.post("/chat/turns/:id/answer-now", (c) => {
    const a = state.answering;
    if (!a || a.turnId !== c.req.param("id") || a.depth === "quick") return c.json({ done: false });
    a.answeredNow = true;
    a.release();
    return c.json({ done: true });
  });
  app.post("/chat/stream", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const extra = state.nextChatTurn;
    state.nextChatTurn = null;
    state.chatPosts.push({ text: parsed.data.text, oneOff: parsed.data.oneOff === true });
    dropHeldTurn(parsed.data);
    const waitingBefore = state.pendingConfirmation?.id ?? null;
    const base = chatReply(parsed.data.text, parsed.data.projectId, parsed.data.projectTab);
    const closedNow =
      waitingBefore && state.pendingConfirmation?.id !== waitingBefore ? waitingBefore : null;
    const key = parsed.data.projectId ?? "";
    const startedAt = new Date().toISOString();
    // d1109-chat-depth: a held turn is in its conversation without a reply (the daemon wrote the
    // person's line) and in flight (answering) until Stop or Answer now ends it.
    if (extra?.hold) {
      const turns = state.conversations.get(key) ?? [];
      turns.push({
        id: base.transcriptId,
        at: startedAt,
        said: parsed.data.text,
        source: parsed.data.source ?? "text",
        reply: null,
      });
      state.conversations.set(key, turns);
    }
    let release: () => void = () => undefined;
    const ended = new Promise<void>((r) => {
      release = r;
    });
    if (extra?.hold)
      state.answering = {
        turnId: base.transcriptId,
        key,
        step: extra.steps?.at(-1)?.text ?? null,
        since: startedAt,
        depth: extra.depth ?? "quick",
        stopped: false,
        answeredNow: false,
        release,
      };
    const finish = (): ChatReplyView => {
      const stopped = state.answering?.turnId === base.transcriptId && state.answering.stopped;
      if (state.answering?.turnId === base.transcriptId) state.answering = null;
      const reply: ChatReplyView = {
        ...base,
        ...(extra?.reply ? { reply: extra.reply } : {}),
        ...(stopped ? { reply: "" } : {}),
        oneOff: stopped ? null : (extra?.oneOff ?? null),
        depth: extra?.depth ?? "quick",
        footer: stopped
          ? "You stopped this answer: under CHF 0.01 spent."
          : (extra?.footer ?? null),
        offer: stopped ? null : (extra?.offer ?? null),
      };
      if (extra?.hold) {
        const turns = state.conversations.get(key) ?? [];
        state.conversations.set(
          key,
          turns.filter((t) => t.id !== base.transcriptId),
        );
      }
      keepTurn(parsed.data, reply, extra?.failed === true && !stopped);
      heardChat(reply, parsed.data.projectId, closedNow, parsed.data.text);
      emit("conversation.changed", { projectId: parsed.data.projectId ?? null });
      return reply;
    };
    if (extra?.hold) emit("conversation.changed", { projectId: parsed.data.projectId ?? null });
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "turn",
        data: JSON.stringify({ turnId: base.transcriptId, startedAt }),
      });
      for (const step of extra?.steps ?? [])
        await stream.writeSSE({
          event: "step",
          data: JSON.stringify({
            text: step.text,
            at: new Date().toISOString(),
            ...(step.reset ? { reset: true } : {}),
          }),
        });
      if (extra?.hold) await ended;
      const reply = finish();
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
      const found = state.costs[projectId];
      return found ? c.json(found) : c.json(state.costs.proj_beacon);
    }
    return c.json(state.costs.proj_atlas);
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
    // leftovers7-tailrun TR-11: the words New task typed so far, as the daemon reads them.
    const typed = {
      title: c.req.query("title") ?? "",
      outcome: c.req.query("outcome") ?? "",
      acceptance_criteria: (c.req.query("criteria") ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    };
    const words = typed.title || typed.outcome || typed.acceptance_criteria.length ? typed : null;
    for (const sp of view.specialists) sp.runsOn = runsOnFor(sp.name, projectId, words);
    // l4-selftasks-carried (L4-other-1 D-5), as the daemon: the line of a specialist that writes
    // no file names a file the typed words ask for.
    const file = fileTheWordsWrite([typed.outcome, ...typed.acceptance_criteria]);
    for (const sp of view.specialists)
      if (sp.writesNoFile) sp.writesNoFile = writesNoFileLine(sp.name, file);
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
    // Like the daemon (settings-view.ts): each project's budget, 0 meaning no budget (later #43;
    // polish-screens, wave 13).
    const budgetRows = state.projects.map((p): (typeof SETTINGS)[number] => ({
      key: "project.budget",
      label: "Project budget",
      scope: "project",
      scopeId: p.id,
      value: p.budget,
      description: `The most ${p.name} may spend in all. 0 means no budget: only the monthly cap limits it`,
      risk: "medium",
    }));
    const rows = [...SETTINGS, ...projectRows, ...budgetRows].map((s) => {
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
    // Like the daemon (settings-view.ts, w8-status-write): a Status issue on GitHub row for each
    // project on a host repository (not a folder on this computer), on unless turned off.
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
        description: `You press Merge (each accepted task's pull request waits for your Merge on the Overview of ${p.name}), or merge automatically after review (Forerunner merges it once the critic accepted it)`,
        risk: "medium",
      });
      // w8-status-write (W8-write-10): the status issue's switch, a together project's too, with
      // where the status is now in the daemon's words (`statusIssueRowWords`).
      const on = state.settingValues[settingSlot("status_issue", p.id)] !== false;
      rows.push({
        key: "project.status_issue",
        label: "Status issue on GitHub",
        scope: "project",
        scopeId: p.id,
        value: on,
        description: statusIssueRowWords(
          { name: p.name, settings: on ? {} : { status_issue: false } },
          on
            ? (state.statusIssue[p.id] ?? { sentence: STATUS_NOT_YET_SENTENCE, public: null })
            : {
                sentence: `Status stays in the app: the status issue is turned off for "${p.name}" in Settings.`,
                public: null,
              },
        ),
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
        description: WEB_ACCESS_ROW_WORDS,
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
  /** "Set X to b? <Effect>." as settings.set's `askOf`. */
  const askWith = (what: string, value: string, effect: string) =>
    `Set ${what} to ${value}? ${effect.charAt(0).toUpperCase()}${effect.slice(1)}.`;
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
    status_issue: "low",
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
    // d1109-starts-engine S-5: medium, as SETTING_SPECS.start_by_itself (turning on asks a yes).
    start_by_itself: "medium",
    // d1109-cred-engine CE-13: medium, as SETTING_SPECS.credential_policy (more money asks a yes).
    credential_policy: "medium",
    // l4-chat-depth (L4-chat-211): medium, as SETTING_SPECS.chat_ask_above (a higher amount
    // asks a yes; a lower one acts at once). Before, it was missing here, so the fake refused
    // "unknown setting chat_ask_above" and its own branch below never ran.
    chat_ask_above: "medium",
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
  /** The yes/no keys (`z.boolean()` in SETTING_SPECS): "on" or "off", off until set (W15B-16). */
  const BOOLEAN_KEYS = new Set(["small_project_mode", "voice_alerts", "start_by_itself"]);
  const PROJECT_KEYS = new Set([
    "start_by_itself",
    "small_project_mode",
    "status_issue",
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
    if (name === "project.join") {
      // OJ-02, as the daemon's `project.join` (medium: the dialog's press is the yes): the
      // closed projects' tasks move into the kept one and they leave Home; Undo puts them back.
      const keep = projectByRef(typeof params.keep === "string" ? params.keep : undefined);
      const closeRefs = Array.isArray(params.close) ? params.close.map(String) : [];
      const close = closeRefs.flatMap((ref) => {
        const row = projectByRef(ref);
        return row ? [row] : [];
      });
      if (!keep || !close.length) return refuse("no such project", "not_found");
      if (state.joinRefusal) return refuse(state.joinRefusal);
      const names = close.map((x) => x.name);
      return {
        name,
        params,
        risk: "medium",
        card: {
          ...card(
            {
              command: "project.join",
              what: "the projects on one repository",
              oldValue: [keep.name, ...names].map((n) => `"${n}"`).join(", "),
              newValue: `"${keep.name}"`,
              scope: "project",
              sentence: joinSentence(keep.name, names),
              projectId: keep.id,
              projectName: keep.name,
            },
            "medium",
          ),
          ask: joinAsk(keep.name, names),
        },
        apply: () => {
          const at = new Date().toISOString();
          const moved: Record<string, string[]> = {};
          const lines: Record<string, unknown> = {};
          for (const p of [keep, ...close]) {
            lines[p.id] = state.sharedRepository[p.id] ?? null;
            delete state.sharedRepository[p.id];
          }
          for (const p of close) {
            moved[p.id] = state.tasks.filter((t) => t.projectId === p.id).map((t) => t.id);
            for (const t of state.tasks) if (t.projectId === p.id) t.projectId = keep.id;
            state.joined[p.id] = {
              projectId: keep.id,
              name: keep.name,
              at,
              text: joinedIntoSentence({ project: keep.id, name: keep.name, at }, "UTC"),
            };
            emit("project.changed", { id: p.id });
          }
          emit("project.changed", { id: keep.id });
          return {
            before: { lines, closed: close.map((p) => ({ id: p.id, name: p.name })) },
            after: { keep: { id: keep.id, name: keep.name }, moved },
          };
        },
      };
    }
    if (name === "repo.take_over") {
      // OR-07, as the daemon's `repo.take_over`: the Overview's Take it over (medium: the press
      // is the yes); the line goes, and the Undo puts it back.
      const project = projectByRef(projectRef);
      if (!project) return refuse("no such project", "not_found");
      const line = state.repositoryOverview[project.id];
      const locator = project.repos?.[0] ?? "the repository";
      if (line?.kind !== "elsewhere") return refuse(nothingToTakeOverSentence(locator));
      if (!line.canTakeOver)
        return refuse(`${line.text.replace(/\.$/, "")}, so it cannot be taken over now.`);
      const shown = /"([^"]+)"/.exec(line.text)?.[1] ?? null;
      const e = { ids: ["elsewhere"], name: shown };
      return {
        name,
        params,
        risk: "medium",
        card: {
          ...card(
            {
              command: "repo.take_over",
              what: `the repository ${locator}`,
              oldValue: shown ? `"${shown}"` : "another Forerunner project",
              newValue: `"${project.name}"`,
              scope: "project",
              sentence: tookOverSentence(locator, e),
              projectId: project.id,
              projectName: project.name,
              usesActiveProject: projectRef === undefined,
            },
            "medium",
          ),
          ask: takeOverAsk(locator, e),
        },
        apply: () => {
          delete state.repositoryOverview[project.id];
          emit("project.changed", { id: project.id });
          return { before: { line }, after: { took_over: { name: shown ?? "" } } };
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
      if (
        !Number.isFinite(amountChf) ||
        amountChf < 0 ||
        (amountChf === 0 && scope !== "project")
      ) {
        return refuse(
          scope === "month"
            ? "The monthly cap must be more than CHF 0.00: it is the limit that stops all spending, so it cannot be turned off. Enter the most you want to spend in a month."
            : scope === "project"
              ? "budget.set: amountChf must be a number"
              : // The daemon's `ZERO_REFUSED.session` (W15B-16).
                "The budget per session must be more than CHF 0.00: a session plans its work within it. Enter the most a session may spend.",
        );
      }
      // The daemon's amounts (`chfExact`) and verbs (budget.ts `describe`, W15B-16): "CHF 150.00",
      // "Raised" up, "Lowered" down.
      const chf2 = (n: number) => `CHF ${n.toFixed(2)}`;
      const verbOf = (from: number, to: number) =>
        to > from ? "Raised" : to < from ? "Lowered" : "Set";
      const askVerbOf = (from: number, to: number) =>
        to > from ? "Raise" : to < from ? "Lower" : "Set";
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
              what: "the monthly cap",
              oldValue: chf2(fromChf),
              newValue: chf2(amountChf),
              scope: "global",
              ask: `${askVerbOf(fromChf, amountChf)} the monthly cap to ${chf2(amountChf)}?`,
              sentence: `${verbOf(fromChf, amountChf)} the monthly cap from ${chf2(fromChf)} to ${chf2(amountChf)}. Undo.`,
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
        // later #43: 0 is no budget, said so.
        const words = (chf: number) => (chf <= 0 ? "no budget" : chf2(chf));
        const verb = fromChf <= 0 || amountChf <= 0 ? "Set" : verbOf(fromChf, amountChf);
        return {
          name,
          params,
          risk: "medium",
          card: card(
            {
              command: name,
              what: `the project budget for ${project.name}`,
              oldValue: words(fromChf),
              newValue: words(amountChf),
              scope: "project",
              sentence: `${verb} the project budget for ${project.name} from ${words(fromChf)} to ${words(amountChf)}${amountChf <= 0 ? ": only the monthly cap limits its spending" : ""}. Undo.`,
              ...(amountChf <= 0
                ? {
                    ask: `Remove the project budget for ${project.name}? Only the monthly cap limits its spending then.`,
                  }
                : {}),
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
            oldValue: chf2(5),
            newValue: chf2(amountChf),
            scope: "session",
            sentence: `${verbOf(5, amountChf)} the session budget for ${project.name} from ${chf2(5)} to ${chf2(amountChf)}${until ? `, until ${until}` : ""}. Undo.`,
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
          : `Alice's ${
              params.mode === "text_chat"
                ? "chat"
                : params.mode === "chat_thorough"
                  ? "chat's thorough answers"
                  : params.mode
            }`;
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
      // d1109-cred-screens (CS-1), as SETTING_SPECS.credential_policy: a change that moves less
      // money acts at once, one that moves more asks the person's yes; the default stored as
      // the person's choice is a change too; the same stored value is refused.
      if (key === "credential_policy") {
        const presets = [
          "subscription_then_wait",
          "subscription_then_ask",
          "subscription_then_key",
          "key_then_subscription",
          "key_only",
        ];
        const value = String(params.value ?? "");
        if (!presets.includes(value)) return refuse(`${value} is not a preset`);
        const before = fakePolicy();
        if (before.id === value && before.chosen === "stored")
          return refuse(`Which Claude does the work is already ${value}.`);
        const words = policyChangeWords(before.id, value as never);
        const r: Risk = words.narrows ? "low" : "medium";
        return {
          name,
          params,
          risk: r,
          card: card(
            {
              command: name,
              what: "which Claude does the work",
              oldValue: before.id,
              newValue: value,
              scope: "global",
              sentence: words.sentence,
              ask: words.ask,
            },
            r,
          ),
          apply: () => {
            const previous = state.settingValues.credential_policy ?? null;
            state.settingValues.credential_policy = value;
            return {
              before: { key, project_id: null, value: previous },
              after: { key, project_id: null, value },
            };
          },
        };
      }
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
        // As webAccessEffect (l3-chat-claims, L3-run-9): "except the ones listed" only with a
        // never list.
        const effect =
          mode === "only"
            ? "research reads only these websites and their subdomains, on the API key and on the subscription"
            : never.sites.length
              ? "research reads any public website except the ones listed, on the API key and on the subscription"
              : "research reads any public website, on the API key and on the subscription";
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
              newValue: webAccessWords(value),
              ask: askWith(what, webAccessWords(value), effect),
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
        // A yes/no setting reads "on" or "off", never "true" or "unset" (W15B-16).
        const shown = before === true ? "on" : "off";
        const effect = fastModeEffect(value);
        const sentence = `Set Opus fast mode for ${project.name} from ${shown} to ${value ? "on" : "off"}: ${effect}. Undo.`;
        return {
          name,
          params,
          risk,
          card: card(
            {
              command: name,
              what: `Opus fast mode for ${project.name}`,
              oldValue: shown,
              newValue: value ? "on" : "off",
              ask: askWith(`Opus fast mode for ${project.name}`, value ? "on" : "off", effect),
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
              newValue: MERGE_MODE_LABELS[value],
              ask: askWith(what, MERGE_MODE_LABELS[value], effect),
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
      if (key === "chat_ask_above" && typeof params.value === "number") {
        // d1109-chat-depth, as SETTING_SPECS.chat_ask_above: a lower amount acts at once, a
        // higher one is read back; a negative amount is refused in words; the same is refused.
        const value = params.value;
        if (!Number.isFinite(value) || value < 0)
          return refuse(
            "The amount is in CHF, 0 or more: 0 makes chat ask before every longer answer.",
          );
        const had = state.settingValues.chat_ask_above;
        const before = typeof had === "number" ? had : 0.1;
        // l4-chat-depth (L4-chat-211): the amount alone; what 0 means after the amounts.
        const words = (v: number) => `CHF ${Math.max(0, v).toFixed(2)}`;
        const means = value <= 0 ? ": chat asks before every longer answer" : "";
        const what = "the amount above which chat asks first";
        if (before === value && had !== undefined)
          return refuse(`The amount above which chat asks first is already ${words(before)}.`);
        const r: Risk = value < before ? "low" : risk;
        return {
          name,
          params,
          risk: r,
          card: card(
            {
              command: name,
              what,
              oldValue: words(before),
              newValue: words(value),
              ask: `Set ${what} to ${words(value)}?`,
              scope: "global",
              sentence: `Set ${what} from ${words(before)} to ${words(value)}${means}. Undo.`,
              projectId: null,
              projectName: null,
              usesActiveProject: false,
            },
            r,
          ),
          apply: () => {
            state.settingValues.chat_ask_above = value;
            return {
              before: { key, project_id: null, value: had ?? null },
              after: { key, project_id: null, value },
            };
          },
        };
      }
      if (key === "status_issue" && project && typeof params.value === "boolean") {
        // The daemon's card for this key (`SETTING_SPECS.status_issue`, w8-status-write): on/off,
        // and what the new value does, in the card and the sentence; the same value is refused.
        const value = params.value;
        const slot = settingSlot(key, project.id);
        const before = state.settingValues[slot] !== false;
        const onOff = (v: boolean) => (v ? "on" : "off");
        const what = `the status issue on GitHub for ${project.name}`;
        if (before === value)
          return refuse(
            `The status issue on GitHub for ${project.name} is already ${onOff(before)}.`,
          );
        const effect = value ? STATUS_ISSUE_EFFECT.on : STATUS_ISSUE_EFFECT.off;
        return {
          name,
          params,
          risk,
          card: card(
            {
              command: name,
              what,
              oldValue: onOff(before),
              newValue: onOff(value),
              ask: askWith(what, onOff(value), effect),
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
              newValue: String(value),
              ask: askWith(what, String(value), effect),
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
        // A yes/no setting reads "on" or "off" (W15B-16), as the daemon's `showFor`.
        if (typeof v === "boolean" || ((v === undefined || v === null) && BOOLEAN_KEYS.has(key)))
          return v === true ? "on" : "off";
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
            // As note.add words it (commands/note.ts): no possessive of the project's name
            // (L3-github-8's sibling; review of run L3).
            sentence: `Noted for the next session on ${project.name}: "${text.replace(/\s+/g, " ").trim().slice(0, 80)}". Undo.`,
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
      const planned = plan(call.name, params);
      // OJ-06, as the daemon's executor (`refuseClosedProject`): a command for a project closed
      // into another is new work for it and is refused, except the ones it still answers.
      const closed =
        !("refused" in planned) && !OPEN_ON_A_CLOSED_PROJECT.has(call.name)
          ? joinedRefusalOf(planned.card.projectId)
          : null;
      const outcome: PlanOutcome = closed ? refuse(closed, "validation") : planned;
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
    const readback = view.ask
      ? decision === "needs_device"
        ? `${view.ask} Confirm in the app on a paired device.`
        : view.ask
      : `${view.what}: ${view.oldValue || "nothing"} to ${view.newValue}. ${
          decision === "needs_yes"
            ? "Say yes to confirm."
            : "Confirm in the app on a paired device."
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
    // As the daemon (W15-36): a removed project's other changes say so instead of an Undo.
    const removed = ch.projectId ? state.removedProjects[ch.projectId] : undefined;
    if (removed && name !== "project.create") return `the project ${removed.was} was removed`;
    // …and a switch is never undone back to a removed project.
    const left = (ch.before as { active_project?: unknown } | null)?.active_project;
    const leftRemoved = typeof left === "string" ? state.removedProjects[left] : undefined;
    if (name === "project.switch" && leftRemoved)
      return `the project ${leftRemoved.was} was removed`;
    // OR-07: as `RepositoryUse.takeOverUndoBlocked` (its docs pull request open or merged).
    if (name === "repo.take_over") return state.takeOverUndoBlocked;
    // OJ-04: as `project.join`'s undoBlocked (a session on the kept project, a merge, a task).
    if (name === "project.join") return state.joinUndoBlocked;
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
      // fixup-l4-starts-carried, as the daemon (`KEPT_START_GONE_REASON`): a start kept from chat
      // for the reset is undone only while that same start still waits.
      const kept = (ch.after ?? {}) as { kept_start?: unknown; kept_id?: unknown };
      if (kept.kept_start === true) {
        const wait = ch.projectId ? state.credentialWaitNow[ch.projectId] : undefined;
        return wait?.kept && wait.keptId === kept.kept_id
          ? null
          : "the start kept for the reset has already run or was cancelled; there is nothing to undo";
      }
      const s = after.session_id
        ? state.sessions.find((x) => x.id === after.session_id)
        : undefined;
      return s && !["running", "paused", "planned"].includes(s.status)
        ? "the session this start began has already ended; there is nothing to undo"
        : null;
    }
    // d1109-selftasks-run: as the daemon's split and create, the approved set is undone while
    // none of its tasks has run since.
    const proposal = (
      ch.after as {
        task_proposal?: { restore: { id: string }[]; created: string[]; added: string[] };
      } | null
    )?.task_proposal;
    if (proposal) {
      for (const id of [...proposal.restore.map((r) => r.id), ...proposal.created]) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t || ["draft", "ready", "cancelled"].includes(t.status)) continue;
        // l4-chat-carried (L4-selftasks-129): a part a session took reads as running.
        return proposal.added.includes(t.id)
          ? `the task "${t.title}" is ${t.status}; a ${t.status} task cannot be cancelled, so its creation cannot be undone`
          : ["claimed", "in_progress", "in_review"].includes(t.status)
            ? `"${t.title}" is running now, so the split cannot be undone`
            : `"${t.title}" has run since, so the split cannot be undone`;
      }
      return null;
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
    // A fixture may give the reason a state of its own would (d1109-selftasks-chat SC-6).
    const blocked = open ? (ch.undoBlockedReason ?? undoBlocked(ch)) : null;
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
    // As the daemon (W15-36): each row's project and people in words; a removed project reads
    // "<name> (removed)".
    const named = (ch: ChangeLogView): ChangeLogView => {
      const live = ch.projectId ? state.projects.find((p) => p.id === ch.projectId) : undefined;
      const removed = ch.projectId ? state.removedProjects[ch.projectId] : undefined;
      const agent = ch.agentId ? state.agents.find((a) => a.id === ch.agentId) : undefined;
      return {
        ...ch,
        projectName: removed?.name ?? live?.name ?? ch.projectName ?? null,
        projectRemoved: !!removed,
        humanName: ch.humanName ?? (ch.humanId === me.id ? me.name : null),
        agentName: ch.agentName ?? agent?.name ?? null,
        // d1109-selftasks-chat (SC-7), as the daemon: the agent's own change says so.
        byAgent: ch.byAgent ?? false,
        // l4-selftasks-carried (L4f-left-4), as the daemon: a set of the agent's fixes with the
        // person's own change names both.
        byYouAndAgent: ch.byYouAndAgent ?? false,
      };
    };
    const rows = state.changes
      .map((ch) => named(withUndoable(ch, now)))
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
      // As the daemon (W15-34): one plain question, 'Take back "<the change>"?' for a change
      // the fake has no words of its own for; the card's `what` is the change, never "undo: …".
      const ask = `Take back "${(what.split(/:\s/)[0] ?? what).replace(/[.\s]+$/, "")}"?`;
      const undoCard = {
        ...card(
          {
            command: "undo",
            what,
            oldValue: "as it is now",
            newValue: "as it was before this change",
            scope: entry.scope,
            sentence: `Undo ${what}.`,
            projectId: entry.projectId,
          },
          risk,
        ),
        ask,
      };
      const readback =
        decision === "needs_yes" ? ask : `${ask} Confirm in the app on a paired device.`;
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
    // fixup-l4-starts-carried, as the daemon: the Undo of a start kept from chat drops that start
    // (the wait is as it was before it: "Start at 11:40" again), nothing else.
    const keptId = (entry.after as { kept_id?: unknown } | null)?.kept_id;
    if (first?.name === "session.start" && typeof keptId === "string" && entry.projectId) {
      const was = keptBefore.get(keptId);
      if (was) state.credentialWaitNow[entry.projectId] = was;
      else delete state.credentialWaitNow[entry.projectId];
      keptBefore.delete(keptId);
      emit("project.changed", { id: entry.projectId });
    }
    // W15-36: the New project dialog's create: the project goes, the previous one is active.
    if (first?.name === "project.create" && project) {
      state.projects = state.projects.filter((p) => p.id !== project.id);
      // As the daemon: the name is free again; its rows read "<name> (removed)".
      const taken = new Set(Object.values(state.removedProjects).map((r) => r.name));
      let n = 1;
      while (taken.has(n === 1 ? `${project.name} (removed)` : `${project.name} (removed ${n})`))
        n += 1;
      state.removedProjects[project.id] = {
        name: n === 1 ? `${project.name} (removed)` : `${project.name} (removed ${n})`,
        was: project.name,
      };
      const back = typeof before?.active_project === "string" ? before.active_project : null;
      // Another project made active since stays active.
      if (project.active) for (const p of state.projects) p.active = p.id === back;
      emit("project.changed", { id: project.id });
    }
    // OJ-04: Make one project's Undo: the tasks go back, the closed projects come back on Home
    // with their Overview lines.
    if (first?.name === "project.join") {
      const after = (Array.isArray(entry.after) ? entry.after[0] : entry.after) as {
        moved?: Record<string, string[]>;
      } | null;
      const lines = (before?.lines ?? {}) as Record<
        string,
        NonNullable<ProjectCard["sharesRepositoryWith"]> | null
      >;
      for (const [closedId, ids] of Object.entries(after?.moved ?? {})) {
        for (const t of state.tasks) if (ids.includes(t.id)) t.projectId = closedId;
        delete state.joined[closedId];
        emit("project.changed", { id: closedId });
      }
      for (const [id, line] of Object.entries(lines)) if (line) state.sharedRepository[id] = line;
      if (entry.projectId) emit("project.changed", { id: entry.projectId });
    }
    // OR-07: repo.take_over's Undo: the Overview's line comes back.
    if (first?.name === "repo.take_over" && project && before?.line) {
      state.repositoryOverview[project.id] = before.line as NonNullable<
        ProjectCard["repositoryElsewhere"]
      >;
      emit("project.changed", { id: project.id });
    }
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
    // OJ-04, as `project.join`'s undoSentence.
    if (first?.name === "project.join") {
      const closed = ((before?.closed ?? []) as { name?: string }[]).map((c) => c.name ?? "");
      sentence = joinUndoneSentence(closed);
    }
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
    // d1109-selftasks-run (ADR 0119): the agent's task changes approved on one card are undone
    // together, each in its own words in one sentence, as the daemon's composed Undo says them.
    const proposal = (
      entry.after as {
        task_proposal?: {
          restore: { id: string; title: string; acceptanceCriteria: string[] }[];
          created: string[];
          waited: { id: string; dependsOn: string[] }[];
          words: string;
        };
      } | null
    )?.task_proposal;
    if (proposal) {
      for (const w of proposal.waited) {
        const t = state.tasks.find((x) => x.id === w.id);
        if (t) t.dependsOn = [...w.dependsOn];
      }
      for (const id of proposal.created) {
        const t = state.tasks.find((x) => x.id === id);
        if (t) {
          t.status = "cancelled";
          touch(t);
        }
      }
      for (const back of proposal.restore) {
        const t = state.tasks.find((x) => x.id === back.id);
        if (t) {
          t.title = back.title;
          t.acceptanceCriteria = [...back.acceptanceCriteria];
          touch(t);
        }
      }
      sentence = proposal.words;
      if (entry.projectId) emit("project.changed", { id: entry.projectId });
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
    // OJ-06, as the daemon: a project closed into another has no next session to note for.
    const closed = joinedRefusalOf(id);
    if (closed) return errorBody(c, 409, "conflict", closed);
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
      // leftovers7-tailrun TR-10: a subscription saved beside an API key is served at once.
      (c.subscription && !setupStartedWith.subscription && !setupStartedWith.anthropicApiKey);
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
    // l4-cred-engine, run L4 (L4-creds-1): what the work that waited for the share does now.
    return c.json({ ...allowanceView(), changeLine: options.planAllowanceChangeLine ?? null });
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
    // d1109-cred-screens (CS-2, C5-left-4), as billing-order-routes.ts: the order is stored as the
    // credential policy it maps onto (the rule kept), through settings.set credential_policy.
    const before = fakePolicy();
    const preset =
      next[0] === "subscription"
        ? before.rule.whenStopped === "ask"
          ? "subscription_then_ask"
          : before.rule.whenStopped === "next"
            ? "subscription_then_key"
            : "subscription_then_wait"
        : before.rule.whenStopped === "next"
          ? "key_then_subscription"
          : "key_only";
    if (preset !== before.id || before.chosen !== "stored") {
      const words = policyChangeWords(before.id, preset);
      pushChange({
        commands: [{ name: "settings.set", params: { key: "credential_policy", value: preset } }],
        before: {
          key: "credential_policy",
          project_id: null,
          value: state.settingValues.credential_policy ?? null,
        },
        after: { key: "credential_policy", project_id: null, value: preset },
        scope: "global",
        projectId: null,
        source: "ui",
        wordsUsed: `Settings: Which Claude does the work to ${preset}`,
        sentence: words.sentence,
        reversible: true,
      });
      state.settingValues.credential_policy = preset;
    }
    billingOrder = next;
    return c.json(billingOrderView());
  });
  // d1109-cred-screens CS-1, mirroring credential-policy-routes.ts with the runtime's own
  // builder: the preset in force (stored, derived from the earlier order, or the default), the
  // saved credentials' state from their rows, a standing yes and the open ask card.
  const fakePolicy = () =>
    credentialPolicyOf({
      ...(state.settingValues.credential_policy
        ? { credential_policy: state.settingValues.credential_policy }
        : {}),
      ...(billingOrder ? { billing_order: billingOrder } : {}),
      ...(state.settingValues.mid_session_limit
        ? { mid_session_limit: state.settingValues.mid_session_limit }
        : {}),
    });
  let credentialGrant = options.credentialPolicy?.grant === true;
  const nextMonthStart = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  };
  const credentialPolicyViewNow = () => {
    const credentials: CredentialFacts[] = billingSources.map((s) => {
      const stop =
        s.blocked === "resting" && s.restingUntil
          ? { reason: "limit" as const, until: s.restingUntil, stopKey: `limit:${s.restingUntil}` }
          : s.blocked === "refused"
            ? { reason: "refused" as const, until: null, stopKey: "refused:fake" }
            : s.blocked === "allowance"
              ? { reason: "share" as const, until: nextMonthStart(), stopKey: "share:fake" }
              : s.blocked === "monthly_cap"
                ? {
                    reason: "key_month" as const,
                    until: nextMonthStart(),
                    stopKey: "key_month:fake",
                  }
                : null;
      return {
        kind: s.kind,
        saved: s.blocked !== "no_credential",
        enabled: s.blocked !== "disabled",
        stop,
        planShare: s.planShare,
        monthChfMicro: s.monthSpent.chfMicro,
        grant:
          credentialGrant && stop && s.kind === "subscription"
            ? { to: "api_key" as const, stopKey: stop.stopKey }
            : null,
      };
    });
    const ask = state.requests.find(
      (r) =>
        r.status === "open" && (r.changeCard as { key?: unknown } | null)?.key === "credential:ask",
    );
    return credentialPolicySection({
      policy: fakePolicy(),
      credentials,
      openAskId: ask?.id ?? null,
      startedWith: options.startedWith ?? null,
      opts: { timezone: "UTC", nowMs: Date.now() },
    });
  };
  app.get("/settings/credential-policy", (c) => c.json(credentialPolicyViewNow()));
  app.post("/settings/credential-policy/grant/end", (c) => {
    credentialGrant = false;
    return c.json(credentialPolicyViewNow());
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
    // l4-chat-depth (L4-chat-204), as the daemon: a closed project takes no new data.
    const joinedData = joinedRefusalOf(id);
    if (joinedData)
      return c.json(
        {
          code: "conflict",
          message: joinedData,
          details: { cause: "project_joined", projectId: id },
        },
        409,
      );
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
    // l4-chat-depth (L4-chat-204), as the daemon: a closed project takes no import.
    const joinedImport = joinedRefusalOf(id);
    if (joinedImport)
      return c.json(
        {
          code: "conflict",
          message: joinedImport,
          details: { cause: "project_joined", projectId: id },
        },
        409,
      );
    const body = (await c.req.json()) as { source?: string; locator?: string; path?: string };
    const locator = (body.path ?? body.locator ?? "").trim();
    if (!locator || !["zip", "folder", "github"].includes(body.source ?? "")) {
      return errorBody(c, 400, "validation", "source and path or locator are required");
    }
    if (body.source === "github") {
      // As the daemon (OR-04, C2-left-12, L4-creds-23): a repository another project here uses
      // is refused before anything is cloned, 409 "conflict" with the cause the offer reads.
      // L4e-left-10 (l4-github-carried): a URL on another host too, as the daemon's checkHere.
      const link = fakeLinkOf(locator);
      if (link && "host" in link)
        return c.json(
          {
            code: "conflict",
            message: otherHostSentence(link.host),
            details: { cause: "other_host" },
          },
          409,
        );
      const inUse = linkInUse(locator, id);
      if (inUse)
        return c.json({ code: "conflict", message: inUse.message, details: inUse.details }, 409);
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
    const rows = state.docs[id];
    // As the daemon (C2-left-13, L4-creds-23): a together project writes no docs, so each doc it
    // does not have says who writes it (notWrittenHere), never "not written yet"; its Status row
    // is its own (w8-status-write): where its status is on GitHub.
    const project = state.projects.find((p) => p.id === id);
    if (!rows && project && state.repositoryOverview[id]?.kind === "together")
      return c.json(
        DOCS.map((d) =>
          d.path === "docs/status.md"
            ? {
                path: d.path,
                title: d.title,
                exists: false,
                sizeBytes: 0,
                updatedAt: null,
                drift: false,
                note: state.statusIssue[id]?.docsNote ?? STATUS_NOT_YET_SENTENCE,
              }
            : {
                path: d.path,
                title: d.title,
                exists: false,
                sizeBytes: 0,
                updatedAt: null,
                drift: false,
                note: togetherDocNote(project.name),
                notWrittenHere: true,
              },
        ),
      );
    // w8-status-write: a seeded status note is the Status row's (the daemon's status board).
    const note = state.statusIssue[id]?.docsNote;
    if (rows && note)
      return c.json(rows.map((r) => (r.path === "docs/status.md" ? { ...r, note } : r)));
    return c.json(rows ?? []);
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
    // W15-05: a merge that waits for what is left in its task's folder (the row names the
    // folder) keeps the press and answers with why it waits; the row stays as it is.
    if (row.folder && row.merge?.sentence)
      return c.json({
        state: "queued",
        sentence: row.merge.sentence,
        order: [...row.merge.first, number],
      });
    if (row.merge && !row.merge.canMerge)
      return c.json({
        state: "refused",
        sentence: row.merge.sentence ?? `#${number} cannot be merged here: merge it on GitHub.`,
        order: [],
      });
    // l3-merge, run L3: what the press finds before it merges (`pullRequestPressFinds`).
    const finds = state.pullRequestPressFinds[`${id}#${number}`];
    if (finds) {
      delete state.pullRequestPressFinds[`${id}#${number}`];
      row.merge = {
        state: finds.row,
        canMerge: finds.row === "left_to_you",
        sentence: finds.sentence,
        first: [],
      };
      // fixup-l4-github-merge (L4-github-124 (a)), as the daemon's press: the pull request the
      // chain builds on, read closed, is settled at once; the screens hear the project changed.
      const dep = finds.closedDependency;
      if (dep) {
        state.taskMeta.merges?.set(dep.taskId, {
          approval: "none",
          ...state.taskMeta.merges.get(dep.taskId),
          state: "left_to_you",
          sentence: `#${dep.number} was closed without merging.`,
          pr_number: dep.number,
          last_outcome: "closed",
        });
        emit("project.changed", { id });
      }
      return c.json({ state: "refused", sentence: finds.sentence, order: [] });
    }
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
    // A cancelled task's open pull request (L3-github-10) does not wait to be merged either, nor
    // does a docs pull request that names no project (`listed`, L4i-left-2).
    const row = prs?.waiting.find(
      (r) => r.number === number && r.kind !== "cancelled" && r.kind !== "listed",
    );
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
  // l4-github-carried (L4e-left-1, owner question OQ-L4e-1's default), as the daemon's
  // `retryTakeOverDocs`: only the take-over's no-pull-request line is tried again; opened, the
  // line goes and the docs pull request waits on the Overview; a failure set by a test keeps it.
  const takeOverOpened = new Set<string>();
  app.post("/projects/:id/take-over/retry", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 404, "not_found", "no such project");
    const refused = (sentence: string) => c.json({ state: "refused", sentence, prUrl: null });
    const line = state.repositoryOverview[id];
    // w8-repo-guide (L4i-left-5): the repository as the line above names it (owner/name), as
    // the daemon's `RepositoryUse.locatorOf` reads any spelling the person typed.
    const typed = project.repos?.[0]?.trim() ?? "";
    const named =
      /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[\w.-]+@[\w.-]+:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
        typed,
      );
    const locator = named ? `${named[1]}/${named[2]}` : null;
    if (line?.outcome !== "took_over_no_pull_request") {
      // L4i-left-7: answered by the real state.
      if (!locator) return refused(TAKE_OVER_NO_REPOSITORY);
      // The fake knows a take-over by its line: one tried again here once had it.
      if (!takeOverOpened.has(id)) return refused(TAKE_OVER_NOT_TAKEN);
      return refused(TAKE_OVER_NOTHING_TO_RETRY);
    }
    const fails = state.takeOverRetryFails[id];
    if (fails) {
      delete state.takeOverRetryFails[id];
      return refused(takeOverRetryFailedSentence(locator ?? typed, fails));
    }
    delete state.repositoryOverview[id];
    takeOverOpened.add(id);
    const prs = state.pullRequests[id] ?? { waiting: [], error: null };
    state.pullRequests[id] = prs;
    const number = Math.max(1, ...prs.waiting.map((r) => r.number + 1));
    const repository = repositoryOf(project.repos);
    const url = `${repository?.url ?? "https://github.com/o/repo"}/pull/${number}`;
    prs.waiting.push({
      kind: "docs",
      taskId: null,
      title: "The project's standard docs",
      number,
      url,
      branch: "fr/docs-scaffold",
      review: null,
      merge: { state: "ready", canMerge: true, sentence: null, first: [] },
    });
    emit("project.changed", { id });
    return c.json({ state: "opened", sentence: takeOverRetryOpenedSentence(number), prUrl: url });
  });
  // l4-github-carried (L4-github-130, the owner's decision of 2026-11-18), as the daemon's
  // `ProjectPullRequests.close` answers it: only a cancelled task's open pull request is closed
  // (one close, its branch kept), its merge record then says closed and the row is gone; a
  // failure set by a test keeps the row and says why in one sentence.
  app.post("/projects/:id/pull-requests/:number/close", (c) => {
    const id = c.req.param("id");
    const project = state.projects.find((p) => p.id === id);
    if (!project) return errorBody(c, 403, "forbidden", "not your project");
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0)
      return errorBody(c, 400, "validation", "not a pull request number");
    const refused = (sentence: string) => c.json({ state: "refused", sentence, number });
    if (!repositoryOf(project.repos)) return refused("This project has no repository.");
    const prs = state.pullRequests[id];
    if (prs?.error) return refused(prs.error);
    const row = prs?.waiting.find((r) => r.number === number);
    if (!prs || !row) return refused(closeNotOpenSentence(number));
    if (row.kind !== "cancelled" || !row.taskId) return refused(closeNotCancelledSentence(number));
    const fails = state.pullRequestCloseFails[`${id}#${number}`];
    if (fails) {
      delete state.pullRequestCloseFails[`${id}#${number}`];
      return refused(closeFailedSentence(number, fails));
    }
    prs.waiting = prs.waiting.filter((r) => r.number !== number);
    state.pullRequestCloses.push({ projectId: id, number });
    state.taskMeta.merges?.set(row.taskId, {
      approval: "none",
      ...state.taskMeta.merges.get(row.taskId),
      state: "left_to_you",
      sentence: `#${number} was closed without merging.`,
      pr_number: number,
      last_outcome: "closed",
    });
    emit("project.changed", { id });
    return c.json({ state: "closed", sentence: pullRequestClosedSentence(number), number });
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
          if (i === script.length - 1 && !state.holdSessions) {
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

/** The daemon's cursor shape (`sessionsCursor`): the last row's start and id, base64url. */
function fakeSessionsCursor(row: ProjectSessionRowView): string {
  return Buffer.from(JSON.stringify([row.startedAt, row.id]), "utf8").toString("base64url");
}

function fakeSessionsCursorId(cursor: string): string | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(v) && typeof v[1] === "string" ? v[1] : null;
  } catch {
    return null;
  }
}

/**
 * A working session's row, as the daemon writes it (`workingWords`): the run indicator's sentence
 * ('Atlas · the coder works on "X"'), "CHF … so far", no length while it works.
 */
function fakeWorkingRow(s: SessionView, gist: string): ProjectSessionRowView {
  const text = gist;
  const chf = (s.spent.chfMicro / 1_000_000).toFixed(2);
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: null,
    durationMs: null,
    working: true,
    planning: false,
    gist: text,
    tasks: { done: 0, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 },
    countsWords: "",
    endedWords: null,
    spent: s.spent,
    spentWords: `CHF ${chf} so far on your API key`,
    startedBy: null,
  };
}

/**
 * d1109-sessions: Atlas's sessions as the daemon lists them: the fixture's session (sess_1), the
 * planning call before it. Every word is the daemon's own (`session-list.ts`).
 */
const PROJECT_SESSIONS: Record<string, ProjectSessionRowView[]> = {
  proj_atlas: [
    {
      id: "sess_1",
      startedAt: "2026-10-19T19:00:00.000Z",
      endedAt: "2026-10-19T21:10:00.000Z",
      durationMs: 130 * 60_000,
      working: false,
      planning: false,
      gist: 'Did 1 task: "Index the documentation pages".',
      tasks: { done: 1, failed: 0, paused: 0, needsYou: 1, cancelled: 0, leftForYou: 0 },
      countsWords: "1 done, 1 needed you",
      endedWords: "Done",
      spent: money(7_250_000),
      spentWords: "CHF 5.80 on your API key",
      startedBy: null,
    },
    {
      id: "sess_plan_atlas",
      startedAt: "2026-10-19T18:40:00.000Z",
      endedAt: "2026-10-19T18:41:00.000Z",
      durationMs: 60_000,
      working: false,
      planning: true,
      gist: "Drafted a plan of 4 tasks; you approved it.",
      tasks: { done: 0, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 },
      countsWords: "",
      endedWords: null,
      spent: money(50_000),
      spentWords: "CHF 0.04 on your API key",
      startedBy: null,
    },
  ],
};

/** The session page's "Tasks in this session" for the fixture's session. */
const SESSION_TASKS: Record<string, SessionTaskView[]> = {
  sess_1: [
    {
      id: "task_1",
      title: "Index the documentation pages",
      projectId: "proj_atlas",
      here: "Done",
      now: null,
      spent: money(2_750_000),
      spentWords: "CHF 2.20",
    },
    {
      id: "task_2",
      title: "Add the search box to the header",
      projectId: "proj_atlas",
      here: "Needed your answer",
      now: "Being reviewed",
      spent: money(4_500_000),
      spentWords: "CHF 3.60",
    },
  ],
};

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
