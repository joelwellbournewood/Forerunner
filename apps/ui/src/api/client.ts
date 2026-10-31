import {
  type AcceptCandidateBody,
  type AcceptCandidateView,
  AcceptCandidateView as AcceptCandidateViewSchema,
  type AddSourceBody,
  AgentView as AgentViewSchema,
  type ChangeLogView,
  ChangeLogView as ChangeLogViewSchema,
  type ChangeMilestoneBody as ChangeMilestoneBodySchema,
  type ChatReplyView,
  ChatReplyView as ChatReplyViewSchema,
  type ChatRequestBody,
  type CommandConfirmBody,
  type CommandDefView,
  CommandDefView as CommandDefViewSchema,
  type CommandExecuteBody,
  type CommandParseBody,
  type CommandParseView,
  CommandParseView as CommandParseViewSchema,
  type CommandResultJson,
  CommandResultViewSchema,
  type ConsolidationProposalView,
  ConsolidationProposalView as ConsolidationProposalViewSchema,
  type ConsolidationRunView,
  ConsolidationRunView as ConsolidationRunViewSchema,
  type CostView,
  CostView as CostViewSchema,
  type CreateProjectBody as CreateProjectBodySchema,
  type CreateTaskBody as CreateTaskBodySchema,
  DAEMON_ROUTES,
  type DaemonDeviceView,
  type DecisionView,
  DecisionView as DecisionViewSchema,
  type DesktopControlView,
  type DesktopRevokeView,
  DesktopRevokeView as DesktopRevokeViewSchema,
  type DesktopStatusView,
  DesktopStatusView as DesktopStatusViewSchema,
  type DeviceListView,
  DeviceListView as DeviceListViewSchema,
  type EmailCommandRowView,
  type EmailCommandsView,
  EmailCommandsView as EmailCommandsViewSchema,
  type EmailMarkerView,
  EmailMarkerView as EmailMarkerViewSchema,
  type EmailMode,
  type EmailPausedView,
  EmailPausedView as EmailPausedViewSchema,
  type EmailSentRowView,
  type EmailSentView,
  EmailSentView as EmailSentViewSchema,
  type EmailSettingsPatchBody,
  type EmailSettingsView,
  EmailSettingsView as EmailSettingsViewSchema,
  ErrorBody,
  type EventView,
  EventView as EventViewSchema,
  type HealthView,
  HealthView as HealthViewSchema,
  type HumanRequestView,
  HumanRequestView as HumanRequestViewSchema,
  HumanView as HumanViewSchema,
  type InboxView,
  InboxView as InboxViewSchema,
  type KillBody as KillBodySchema,
  type LessonOfferView,
  LessonOfferView as LessonOfferViewSchema,
  type LessonView,
  LessonView as LessonViewSchema,
  type MemoryScopeView,
  MemoryScopeView as MemoryScopeViewSchema,
  type MemoryView,
  MemoryView as MemoryViewSchema,
  type MessageView,
  MessageView as MessageViewSchema,
  type MirrorSyncView,
  MirrorSyncView as MirrorSyncViewSchema,
  type ModelSettingsView,
  ModelSettingsView as ModelSettingsViewSchema,
  type PairingStartView,
  PairingStartView as PairingStartViewSchema,
  type PeerFeedView,
  PeerFeedView as PeerFeedViewSchema,
  type PendingChangeView,
  PendingChangeView as PendingChangeViewSchema,
  type PerformanceModeView,
  type PerformanceView,
  PerformanceView as PerformanceViewSchema,
  type ProjectCard,
  ProjectCard as ProjectCardSchema,
  type ProjectSummary,
  ProjectSummary as ProjectSummarySchema,
  type RemoveSourceView,
  RemoveSourceView as RemoveSourceViewSchema,
  type RenameAgentBody,
  type ReviewsView,
  ReviewsView as ReviewsViewSchema,
  type ReviewView,
  type RevokeDeviceView,
  RevokeDeviceView as RevokeDeviceViewSchema,
  type RunnerKeyStatusView,
  RunnerKeyStatusView as RunnerKeyStatusViewSchema,
  type RunnerUnlockAnswerView,
  RunnerUnlockAnswerView as RunnerUnlockAnswerViewSchema,
  type RunnerUnlockWrapBody,
  type RunView,
  RunView as RunViewSchema,
  type ScanResultView,
  ScanResultView as ScanResultViewSchema,
  type SessionView,
  SessionView as SessionViewSchema,
  SettingView as SettingViewSchema,
  type SetupCheckView,
  SetupCheckView as SetupCheckViewSchema,
  type SetupFinishView,
  SetupFinishView as SetupFinishViewSchema,
  type SetupGitHubBody,
  type SetupProfileBody,
  type SetupStatusView,
  SetupStatusView as SetupStatusViewSchema,
  type SourceCandidateStatus,
  type SourceCandidateView,
  SourceCandidateView as SourceCandidateViewSchema,
  type SourceView,
  SourceView as SourceViewSchema,
  type SpeakBody,
  type SpeakView,
  SpeakView as SpeakViewSchema,
  type StartPairingBody,
  type StartSessionBody as StartSessionBodySchema,
  type StartSessionView,
  StartSessionView as StartSessionViewSchema,
  type TaskView,
  TaskView as TaskViewSchema,
  type TransitionTaskBody as TransitionTaskBodySchema,
  type UpdateLessonBody,
  type UpdateProjectSettingsBody,
  type VoiceAudioAckView,
  VoiceAudioAckView as VoiceAudioAckViewSchema,
  type VoiceAudioBody,
  type VoiceHeardBody,
  type VoiceHeardView,
  VoiceHeardView as VoiceHeardViewSchema,
  type VoiceSessionView,
  VoiceSessionView as VoiceSessionViewSchema,
  type VoiceStatusView,
  VoiceStatusView as VoiceStatusViewSchema,
  type VoiceTurnView,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import type { DaemonConfig } from "./config.ts";
import {
  type AddExtensionInput,
  type ApplyUpdateResult,
  ApplyUpdateResult as ApplyUpdateResultSchema,
  type CatalogView,
  CatalogView as CatalogViewSchema,
  DataAssetList,
  type DataAssetView,
  DataAssetView as DataAssetViewSchema,
  type DocContentView,
  DocContentView as DocContentViewSchema,
  DocList,
  type DocView,
  type EnqueueInput,
  type EstimateAccuracyView,
  EstimateAccuracyView as EstimateAccuracyViewSchema,
  ExtensionList,
  type ExtensionView,
  ExtensionView as ExtensionViewSchema,
  type ImportInput,
  type ImportResultView,
  ImportResultView as ImportResultViewSchema,
  MilestoneList,
  type MilestoneView,
  MilestoneView as MilestoneViewSchema,
  type ModelWatchAnswerInput,
  type ModelWatchAnswerView,
  ModelWatchAnswerView as ModelWatchAnswerViewSchema,
  type ModelWatchReportsView,
  ModelWatchReportsView as ModelWatchReportsViewSchema,
  type ModelWatchReportView,
  ModelWatchReportView as ModelWatchReportViewSchema,
  type ModelWatchRunView,
  ModelWatchRunView as ModelWatchRunViewSchema,
  ModelWatchSyncView,
  OkView,
  type ProjectSettingsView,
  ProjectSettingsView as ProjectSettingsViewSchema,
  type QueueItemView,
  QueueItemView as QueueItemViewSchema,
  QueueList,
  type RegisterDataAssetInput,
  type RollbackResult,
  RollbackResult as RollbackResultSchema,
  type UpdatePermissionsInput,
  type UpdatesView,
  UpdatesView as UpdatesViewSchema,
} from "./contracts.ts";

export type {
  AcceptCandidateBody,
  AcceptCandidateView,
  AddSourceBody,
  ApplyUpdateResult,
  CatalogView,
  ChangeLogView,
  ChatReplyView,
  ChatRequestBody,
  CommandConfirmBody,
  CommandDefView,
  CommandExecuteBody,
  CommandParseBody,
  CommandParseView,
  CommandResultJson,
  ConsolidationProposalView,
  ConsolidationRunView,
  CostView,
  DaemonDeviceView,
  DataAssetView,
  DecisionView,
  DesktopControlView,
  DesktopRevokeView,
  DesktopStatusView,
  DeviceListView,
  DocContentView,
  DocView,
  EmailCommandRowView,
  EmailCommandsView,
  EmailMarkerView,
  EmailMode,
  EmailPausedView,
  EmailSentRowView,
  EmailSentView,
  EmailSettingsPatchBody,
  EmailSettingsView,
  EstimateAccuracyView,
  EventView,
  ExtensionView,
  HealthView,
  HumanRequestView,
  ImportResultView,
  InboxView,
  LessonOfferView,
  LessonView,
  MemoryScopeView,
  MemoryView,
  MessageView,
  MilestoneView,
  MirrorSyncView,
  ModelSettingsView,
  ModelWatchAnswerView,
  ModelWatchReportsView,
  ModelWatchReportView,
  ModelWatchRunView,
  PairingStartView,
  PeerFeedView,
  PendingChangeView,
  PerformanceModeView,
  PerformanceView,
  ProjectCard,
  ProjectSettingsView,
  ProjectSummary,
  QueueItemView,
  RemoveSourceView,
  ReviewsView,
  ReviewView,
  RevokeDeviceView,
  RollbackResult,
  RunView,
  ScanResultView,
  SessionView,
  SetupCheckView,
  SetupFinishView,
  SetupStatusView,
  SourceCandidateStatus,
  SourceCandidateView,
  SourceView,
  SpeakView,
  StartSessionView,
  TaskView,
  UpdateLessonBody,
  UpdateProjectSettingsBody,
  UpdatesView,
  VoiceAudioBody,
  VoiceSessionView,
  VoiceStatusView,
  VoiceTurnView,
};

/** Types the contract defines only as schemas. */
export type AgentView = z.infer<typeof AgentViewSchema>;
export type HumanView = z.infer<typeof HumanViewSchema>;
export type SettingView = z.infer<typeof SettingViewSchema>;
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export type TransitionTaskBody = z.infer<typeof TransitionTaskBodySchema>;
/** `POST /milestones/:id` (spec B.5): the change with the human's reason and the row's version. */
export type ChangeMilestoneInput = z.input<typeof ChangeMilestoneBodySchema>;
export type KillBody = z.infer<typeof KillBodySchema>;

/** Shapes the contract leaves open (ADR 0025): lists are bare arrays, kill reports its state. */
export const KillResult = z.looseObject({ killActive: z.boolean() });
export type KillResult = z.infer<typeof KillResult>;

export const ProjectList = z.array(ProjectCardSchema);
export const TaskList = z.array(TaskViewSchema);
export const RunList = z.array(RunViewSchema);
export const DecisionList = z.array(DecisionViewSchema);
export const SessionList = z.array(SessionViewSchema);
export const EventList = z.array(EventViewSchema);
export const SettingList = z.array(SettingViewSchema);
export const AgentList = z.array(AgentViewSchema);
export const MemoryScopeList = z.array(MemoryScopeViewSchema);
export const ChangeLogList = z.array(ChangeLogViewSchema);
export const CommandDefList = z.array(CommandDefViewSchema);
export const PendingChangeList = z.array(PendingChangeViewSchema);
export const ConsolidationList = z.array(ConsolidationProposalViewSchema);
export const LessonList = z.array(LessonViewSchema);
export const OfferList = z.array(LessonOfferViewSchema);
export const SourceList = z.array(SourceViewSchema);
export const SourceCandidateList = z.array(SourceCandidateViewSchema);

/** Query of GET /memory; `agentId` is required for the private scope. */
export interface MemoryFilter {
  scope: MemoryView["scope"];
  agentId?: string;
  projectId?: string;
  q?: string;
  tag?: string;
  status?: string;
  limit?: number;
}

/** Request bodies are typed as what the UI sends; the daemon applies the zod defaults. */
export type CreateTaskInput = z.input<typeof CreateTaskBodySchema>;
export type StartSessionInput = z.input<typeof StartSessionBodySchema>;
export type AnswerRequestInput = { version: number; answer: unknown };

/** Error codes the client raises on its own, next to the daemon's `ErrorBody.code`. */
export type ClientErrorCode =
  | "ui.not_connected"
  | "ui.network"
  | "ui.invalid_response"
  | "ui.http_error"
  | "ui.aborted";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * True when the daemon has no such route (ADR 0032): a 404/405/501 that is not a typed
 * `not_found` about an entity. Hono's default answer is plain text (`ui.http_error`); the
 * daemon's and the fake's catch-all say "no route".
 */
export function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 404 && error.status !== 405 && error.status !== 501) return false;
  if (error.code === "ui.http_error") return true;
  return /no route/i.test(error.message);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The audit export (spec S.9): the daemon's `GET /audit/export` as the page uses it. */
export type AuditExportFormat = "jsonl" | "csv";
export interface AuditExportFilter {
  agentId?: string;
  sessionId?: string;
  /** Inclusive lower bound on the time of the call (ISO-8601). */
  from?: string;
  /** Exclusive upper bound. */
  to?: string;
  format?: AuditExportFormat;
}
export interface AuditExportFile {
  /** The daemon's name for the file, base name only. */
  filename: string;
  contentType: string;
  text: string;
  /** Rows in the body (JSON lines, or CSV lines less the header). */
  rows: number;
}

/**
 * The file name of a `Content-Disposition` header, base name only: a server names the file,
 * never the directory it lands in.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!m?.[1]) return null;
  let name = m[1].trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.length > 0 && base !== "." && base !== ".." ? base : null;
}

export function countExportRows(text: string, format: AuditExportFormat): number {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0).length;
  return format === "csv" ? Math.max(0, lines - 1) : lines;
}

export type Query = Record<string, string | number | null | undefined>;

export interface RawRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
}

/** Route path with `:param` placeholders filled from `params`, URL-encoded. */
export function routePath(route: keyof typeof DAEMON_ROUTES, params: Record<string, string> = {}) {
  const spec = DAEMON_ROUTES[route];
  const afterVerb = spec.slice(spec.indexOf(" ") + 1);
  const pathOnly = afterVerb.split(/[ ?]/)[0] ?? afterVerb;
  return pathOnly.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`route ${route}: missing param ${name}`);
    return encodeURIComponent(value);
  });
}

export interface DaemonClient {
  readonly config: DaemonConfig;
  /** Absolute URL for a path and query; `withToken` adds the bearer token for EventSource. */
  url(path: string, query?: Query, withToken?: boolean): string;
  /** Low level request; returns the raw Response. Used by the SSE and chat-stream helpers. */
  raw(options: RawRequestOptions): Promise<Response>;

  health(signal?: AbortSignal): Promise<HealthView>;
  me(signal?: AbortSignal): Promise<HumanView>;
  agents(signal?: AbortSignal): Promise<AgentView[]>;
  /**
   * Settings -> Your agent (U-025): `POST /agents/:id/rename`, the human's principal agent
   * under a new name; the daemon trims and checks it and answers the agent as `/agents` lists it.
   */
  renameAgent(id: string, name: string): Promise<AgentView>;
  projects(signal?: AbortSignal): Promise<ProjectCard[]>;
  createProject(body: CreateProjectBody): Promise<ProjectCard>;
  project(id: string, signal?: AbortSignal): Promise<ProjectCard>;
  projectSummary(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  // Read aloud (spec A.6, L.6; ADR 0063): the daemon's voice provider reads a summary;
  // `lib/speech.ts` follows the utterance's stream and plays the frames.
  speakProject(id: string, body?: SpeakBody): Promise<SpeakView>;
  speakSession(id: string, body?: SpeakBody): Promise<SpeakView>;
  speak(id: string, signal?: AbortSignal): Promise<SpeakView>;
  cancelSpeak(id: string): Promise<SpeakView>;
  tasks(
    projectId: string,
    filter?: { status?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<TaskView[]>;
  createTask(projectId: string, body: CreateTaskInput): Promise<TaskView>;
  transitionTask(taskId: string, body: TransitionTaskBody): Promise<TaskView>;
  runs(projectId: string, filter?: { limit?: number }, signal?: AbortSignal): Promise<RunView[]>;
  /** Current decisions of a project (answered questions the agent never asks again). */
  decisions(projectId: string, signal?: AbortSignal): Promise<DecisionView[]>;
  /** What the other agents on the project are doing. */
  peers(projectId: string, signal?: AbortSignal): Promise<PeerFeedView>;
  sessions(
    filter?: { agentId?: string; projectId?: string; status?: string },
    signal?: AbortSignal,
  ): Promise<SessionView[]>;
  /** The start's outcome and, once its run has made it, the session (U-003). */
  startSession(body: StartSessionInput): Promise<StartSessionView>;
  session(id: string, signal?: AbortSignal): Promise<SessionView>;
  sessionEvents(id: string, afterSeq?: number, signal?: AbortSignal): Promise<EventView[]>;
  stopSession(id: string, reason?: string): Promise<SessionView>;
  kill(body: KillBody): Promise<KillResult>;
  resume(): Promise<KillResult>;
  /** `GET /desktop/status`: desktop control's state, with what the indicator shows (S.32). */
  desktopStatus(signal?: AbortSignal): Promise<DesktopStatusView>;
  /** `POST /desktop/revoke`: stop desktop control now; refused until resumed (S.8, S.32). */
  desktopRevoke(reason?: string): Promise<DesktopRevokeView>;
  /** `POST /desktop/resume`: allow desktop control again after a revoke. */
  desktopResume(): Promise<DesktopStatusView>;
  inbox(humanId: string, signal?: AbortSignal): Promise<InboxView>;
  answerRequest(requestId: string, body: AnswerRequestInput): Promise<HumanRequestView>;
  markRead(messageId: string): Promise<MessageView>;
  chat(body: ChatRequestBody): Promise<ChatReplyView>;
  // Voice (spec O; the daemon's /voice routes): the conversation panel's push-to-talk turn;
  // `voiceStatus` (declared with the Extensions methods below) says whether voice is available.
  startVoiceSession(body: {
    projectId?: string;
    language?: string;
    mode?: "push_to_talk" | "open_mic";
    /** `text`: the agent replies in text only (no TTS, no audio); default `voice`. */
    replyMode?: "voice" | "text";
  }): Promise<VoiceSessionView>;
  voiceSession(id: string, signal?: AbortSignal): Promise<VoiceSessionView>;
  /**
   * Push-to-talk press (true) or release (false); a press while the agent speaks (or writes,
   * replying in text) barges in. `replyMode` sets how this turn's reply goes out, and the next.
   */
  voicePress(id: string, pressed: boolean, replyMode?: "voice" | "text"): Promise<VoiceSessionView>;
  /** One captured chunk of 16-bit PCM (base64). */
  voiceAudio(id: string, chunk: VoiceAudioBody): Promise<VoiceAudioAckView>;
  /** What the human heard: the player's release-to-speaker first audio of a turn (once per turn). */
  voiceHeard(id: string, body: VoiceHeardBody): Promise<VoiceHeardView>;
  stopVoiceSession(id: string): Promise<VoiceSessionView>;
  costs(
    filter?: { projectId?: string; from?: string; to?: string },
    signal?: AbortSignal,
  ): Promise<CostView>;
  /** Estimate-versus-actual accuracy (spec I.3), shown on the Performance page. */
  costEstimates(signal?: AbortSignal): Promise<EstimateAccuracyView>;
  settings(
    filter?: { scope?: string; scopeId?: string },
    signal?: AbortSignal,
  ): Promise<SettingView[]>;
  /**
   * Model settings per agent mode and per specialist (spec D.4, ADR 0072): model, effort, max
   * tokens, speed mode, timeout with their defaults; temperature only where the provider
   * accepts one. Changes go through `executeCommands` with `model.settings.set`.
   */
  modelSettings(signal?: AbortSignal): Promise<ModelSettingsView>;
  /** Merge a patch into a project's settings with a version check. */
  updateProjectSettings(
    projectId: string,
    body: UpdateProjectSettingsBody,
  ): Promise<ProjectSettingsView>;
  /** One GitHub Projects mirror run; 202 while the human decides (MirrorSyncPendingView). */
  mirrorSync(projectId: string, full?: boolean): Promise<MirrorSyncView>;

  // Extensions panel (spec K.6, L.5)
  extensions(filter?: { kind?: string }, signal?: AbortSignal): Promise<ExtensionView[]>;
  extensionCatalog(signal?: AbortSignal): Promise<CatalogView>;
  extension(id: string, signal?: AbortSignal): Promise<ExtensionView>;
  /** 201 when installed at once, 202 (status `pending_approval`) while the human decides. */
  addExtension(body: AddExtensionInput): Promise<ExtensionView>;
  toggleExtension(id: string, enabled: boolean): Promise<ExtensionView>;
  approveExtension(id: string): Promise<ExtensionView>;
  denyExtension(id: string): Promise<void>;
  updateExtensionPermissions(
    id: string,
    permissions: UpdatePermissionsInput,
  ): Promise<ExtensionView>;
  removeExtension(id: string): Promise<void>;
  /**
   * Voice providers (spec O.4): the pair the next voice session uses and what the panel's
   * `voice-*` rows chose, with the reason for every row that is not in force; the conversation
   * panel (spec O) reads from it whether a voice session can start and why not.
   */
  voiceStatus(signal?: AbortSignal): Promise<VoiceStatusView>;

  // Updates screen (spec M)
  /** Local state with the last check's result; never asks the release feed. */
  updates(signal?: AbortSignal): Promise<UpdatesView>;
  /** What is known without the network. */
  updatesStatus(signal?: AbortSignal): Promise<UpdatesView>;
  /** The human's "Check for updates": the daemon asks the release feed (network). */
  checkUpdates(): Promise<UpdatesView>;
  /** 202: the daemon stages the version and exits with the restart code. */
  applyUpdate(version?: string): Promise<ApplyUpdateResult>;
  rollbackUpdate(reason?: string): Promise<RollbackResult>;

  // Model watch (spec D.6, M.5)
  modelWatchReports(limit?: number, signal?: AbortSignal): Promise<ModelWatchReportsView>;
  modelWatchLatest(signal?: AbortSignal): Promise<ModelWatchReportView>;
  modelWatchReport(id: string, signal?: AbortSignal): Promise<ModelWatchReportView>;
  modelWatchRun(): Promise<ModelWatchRunView>;
  modelWatchAnswer(id: string, body: ModelWatchAnswerInput): Promise<ModelWatchAnswerView>;
  modelWatchSync(): Promise<unknown>;

  // Reviews tab (spec H, K.2): every review with findings, the open count, the grade trend.
  reviews(
    projectId: string,
    filter?: { limit?: number },
    signal?: AbortSignal,
  ): Promise<ReviewsView>;
  taskReviews(taskId: string, signal?: AbortSignal): Promise<ReviewsView>;

  // Memory (spec G, K.5)
  memoryScopes(signal?: AbortSignal): Promise<MemoryScopeView[]>;
  memory(filter: MemoryFilter, signal?: AbortSignal): Promise<MemoryView>;
  updateLesson(id: string, body: UpdateLessonBody): Promise<LessonView>;
  pinLesson(id: string, pinned: boolean): Promise<LessonView>;
  /** Retires the lesson and removes its file; the retired row comes back. */
  deleteLesson(id: string): Promise<LessonView>;
  consolidation(signal?: AbortSignal): Promise<ConsolidationProposalView[]>;
  runConsolidation(): Promise<ConsolidationRunView>;
  // Cross-project sharing (spec G.6): propose, the pending proposals, the offers.
  /** Tags the lesson `general` and proposes it for every project; the critic decides at the next session end. */
  proposeLesson(id: string): Promise<LessonView>;
  memoryPromotions(signal?: AbortSignal): Promise<LessonView[]>;
  memoryOffers(signal?: AbortSignal): Promise<LessonOfferView[]>;
  /** Applied at once: accept pins a copy in the project's memory, dismiss leaves it by relevance. */
  answerOffer(id: string, answer: "accept" | "dismiss"): Promise<LessonOfferView>;

  // Commands and the change log (spec Q): the same registry chat and voice use.
  commandDefs(signal?: AbortSignal): Promise<CommandDefView[]>;
  parseCommand(body: CommandParseBody): Promise<CommandParseView>;
  /** One change card and one change log row; medium risk comes back `pending`. */
  executeCommands(body: CommandExecuteBody): Promise<CommandResultJson>;
  pendingCommands(signal?: AbortSignal): Promise<PendingChangeView[]>;
  confirmCommand(pendingId: string, body: CommandConfirmBody): Promise<CommandResultJson>;
  cancelCommand(pendingId: string): Promise<CommandResultJson>;
  changes(
    filter?: { projectId?: string; undoable?: boolean; limit?: number },
    signal?: AbortSignal,
  ): Promise<ChangeLogView[]>;
  undoChange(changeId: string): Promise<CommandResultJson>;

  // Agent email (spec S.15, S.28, S.29, T.14; ADR 0066): the Settings -> Capabilities -> Email
  // page; a daemon without the routes shows the "route not available" state.
  emailSettings(agentId: string, signal?: AbortSignal): Promise<EmailSettingsView>;
  updateEmailSettings(agentId: string, body: EmailSettingsPatchBody): Promise<EmailSettingsView>;
  emailSent(
    agentId: string,
    filter?: { limit?: number; since?: string },
    signal?: AbortSignal,
  ): Promise<EmailSentView>;
  pauseEmail(agentId: string): Promise<EmailPausedView>;
  resumeEmail(agentId: string): Promise<EmailPausedView>;
  rotateEmailMarker(agentId: string): Promise<EmailMarkerView>;
  emailCommands(
    agentId: string,
    filter?: { limit?: number },
    signal?: AbortSignal,
  ): Promise<EmailCommandsView>;

  // Cloud runner vault unlock (spec S.12, ADR 0068): the daemon holds the OS keyring and
  // wraps the runner's vault key to the challenge; the key never crosses this API.
  runnerKeyStatus(runnerId: string, signal?: AbortSignal): Promise<RunnerKeyStatusView>;
  wrapRunnerKey(body: RunnerUnlockWrapBody): Promise<RunnerUnlockAnswerView>;
  // The project page's panels (U-004 to U-006); pages still degrade when `isRouteMissing(error)`.
  queue(
    projectId: string,
    filter?: { status?: string },
    signal?: AbortSignal,
  ): Promise<QueueItemView[]>;
  enqueue(projectId: string, body: EnqueueInput): Promise<QueueItemView>;
  dismissQueueItem(id: string): Promise<QueueItemView>;
  milestones(projectId: string, signal?: AbortSignal): Promise<MilestoneView[]>;
  changeMilestone(id: string, body: ChangeMilestoneInput): Promise<MilestoneView>;
  dataAssets(projectId: string, signal?: AbortSignal): Promise<DataAssetView[]>;
  registerDataAsset(projectId: string, body: RegisterDataAssetInput): Promise<DataAssetView>;
  removeDataAsset(id: string): Promise<void>;
  importProject(projectId: string, body: ImportInput): Promise<ImportResultView>;
  docs(projectId: string, signal?: AbortSignal): Promise<DocView[]>;
  doc(projectId: string, path: string, signal?: AbortSignal): Promise<DocContentView>;
  /** The Performance view (spec D.7, D.19); `days` is the window, 7 by default, at most 90. */
  performance(
    filter?: { projectId?: string; days?: number },
    signal?: AbortSignal,
  ): Promise<PerformanceView>;
  /**
   * The audit log as a file (spec S.9): the daemon streams it in pages; the body comes back
   * whole with the name the daemon gave it, ready for `saveTextFile`.
   */
  auditExport(filter?: AuditExportFilter, signal?: AbortSignal): Promise<AuditExportFile>;

  // Source discovery (spec A.4): connected sources, scans, proposals, accept and remove.
  sources(signal?: AbortSignal): Promise<SourceView[]>;
  addSource(body: AddSourceBody): Promise<SourceView>;
  scanSource(id: string): Promise<ScanResultView>;
  sourceCandidates(
    id: string,
    filter?: { status?: SourceCandidateStatus },
    signal?: AbortSignal,
  ): Promise<SourceCandidateView[]>;
  acceptCandidate(id: string, body?: AcceptCandidateBody): Promise<AcceptCandidateView>;
  removeSource(id: string): Promise<RemoveSourceView>;

  // Settings -> Devices (spec R.2): the daemon proxies the state service; the admin token
  // stays in the daemon.
  devices(signal?: AbortSignal): Promise<DeviceListView>;
  startPairing(body?: StartPairingBody): Promise<PairingStartView>;
  revokeDevice(id: string): Promise<RevokeDeviceView>;

  // The setup assistant (ADR 0092): credentials pasted in the app, checked and stored by the
  // daemon like `fr setup`; values go to the daemon once and never come back.
  setupStatus(signal?: AbortSignal): Promise<SetupStatusView>;
  setupProfile(body: SetupProfileBody): Promise<SetupStatusView>;
  setupAnthropic(value: string): Promise<SetupCheckView>;
  setupGitHub(body: SetupGitHubBody): Promise<SetupCheckView>;
  setupFinish(): Promise<SetupFinishView>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createClient(config: DaemonConfig, fetchImpl?: FetchLike): DaemonClient {
  const doFetch: FetchLike =
    fetchImpl ??
    ((input, init) => {
      if (typeof fetch !== "function") {
        return Promise.reject(new ApiError("ui.network", "fetch is not available", 0));
      }
      return fetch(input, init);
    });

  function url(path: string, query?: Query, withToken = false): string {
    const u = new URL(path, `${config.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        u.searchParams.set(key, String(value));
      }
    }
    if (withToken && config.token) u.searchParams.set("token", config.token);
    return u.toString();
  }

  async function raw(options: RawRequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: options.accept ?? "application/json" };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const init: RequestInit = { method: options.method, headers };
    if (options.signal) init.signal = options.signal;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    try {
      return await doFetch(url(options.path, options.query), init);
    } catch (error) {
      if (isAbort(error)) throw new ApiError("ui.aborted", "request aborted", 0);
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError("ui.network", `daemon unreachable at ${config.baseUrl}: ${message}`, 0);
    }
  }

  async function errorFromResponse(res: Response): Promise<ApiError> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    try {
      const body = JSON.parse(text) as unknown;
      // The daemon's own routes answer the ErrorBody flat; the capability routes it mounts
      // (email, desktop, Cloudflare) wrap the same fields under `error`.
      const nested = (body as { error?: unknown } | null)?.error;
      const parsed = ErrorBody.safeParse(body).success
        ? ErrorBody.safeParse(body)
        : ErrorBody.safeParse(nested);
      if (parsed.success) {
        return new ApiError(parsed.data.code, parsed.data.message, res.status, parsed.data.details);
      }
    } catch {
      // not JSON
    }
    const message =
      text.trim().length > 0 ? text.slice(0, 200) : res.statusText || "request failed";
    return new ApiError("ui.http_error", `${res.status}: ${message}`, res.status);
  }

  async function request<T>(options: RawRequestOptions, schema: z.ZodType<T>): Promise<T> {
    const res = await raw(options);
    if (!res.ok) throw await errorFromResponse(res);
    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw new ApiError(
        "ui.invalid_response",
        `daemon returned a body that is not JSON for ${options.method} ${options.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        res.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new ApiError(
        "ui.invalid_response",
        `daemon response for ${options.method} ${options.path} does not match the contract: ${issues}`,
        res.status,
        { issues: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  const get = <T>(path: string, schema: z.ZodType<T>, query?: Query, signal?: AbortSignal) =>
    request({ method: "GET", path, query, signal }, schema);
  const post = <T>(path: string, schema: z.ZodType<T>, body?: unknown) =>
    request({ method: "POST", path, body: body ?? {} }, schema);
  const put = <T>(path: string, schema: z.ZodType<T>, body?: unknown) =>
    request({ method: "PUT", path, body: body ?? {} }, schema);
  const del = <T>(path: string, schema: z.ZodType<T>) =>
    request({ method: "DELETE", path }, schema);

  return {
    config,
    url,
    raw,
    health: (signal) => get(routePath("health"), HealthViewSchema, undefined, signal),
    me: (signal) => get(routePath("me"), HumanViewSchema, undefined, signal),
    agents: (signal) => get(routePath("agents"), AgentList, undefined, signal),
    renameAgent: (id, name) =>
      post(routePath("renameAgent", { id }), AgentViewSchema, { name } satisfies RenameAgentBody),
    projects: (signal) => get(routePath("projects"), ProjectList, undefined, signal),
    createProject: (body) => post(routePath("createProject"), ProjectCardSchema, body),
    project: (id, signal) =>
      get(routePath("project", { id }), ProjectCardSchema, undefined, signal),
    projectSummary: (id, signal) =>
      get(routePath("projectSummary", { id }), ProjectSummarySchema, undefined, signal),
    speakProject: (id, body) => post(routePath("speakProject", { id }), SpeakViewSchema, body),
    speakSession: (id, body) => post(routePath("speakSession", { id }), SpeakViewSchema, body),
    speak: (id, signal) => get(routePath("speak", { id }), SpeakViewSchema, undefined, signal),
    cancelSpeak: (id) => post(routePath("cancelSpeak", { id }), SpeakViewSchema),
    tasks: (projectId, filter, signal) =>
      get(
        routePath("tasks", { id: projectId }),
        TaskList,
        { status: filter?.status, limit: filter?.limit },
        signal,
      ),
    createTask: (projectId, body) =>
      post(routePath("createTask", { id: projectId }), TaskViewSchema, body),
    transitionTask: (taskId, body) =>
      post(routePath("transitionTask", { id: taskId }), TaskViewSchema, body),
    runs: (projectId, filter, signal) =>
      get(routePath("runs", { id: projectId }), RunList, { limit: filter?.limit }, signal),
    decisions: (projectId, signal) =>
      get(routePath("decisions", { id: projectId }), DecisionList, undefined, signal),
    peers: (projectId, signal) =>
      get(routePath("peers", { id: projectId }), PeerFeedViewSchema, undefined, signal),
    sessions: (filter, signal) =>
      get(
        routePath("sessions"),
        SessionList,
        { agentId: filter?.agentId, projectId: filter?.projectId, status: filter?.status },
        signal,
      ),
    startSession: (body) => post(routePath("startSession"), StartSessionViewSchema, body),
    session: (id, signal) =>
      get(routePath("session", { id }), SessionViewSchema, undefined, signal),
    sessionEvents: (id, afterSeq, signal) =>
      get(routePath("sessionEvents", { id }), EventList, { afterSeq }, signal),
    stopSession: (id, reason) =>
      post(routePath("stopSession", { id }), SessionViewSchema, reason ? { reason } : {}),
    kill: (body) => post(routePath("kill"), KillResult, body),
    resume: () => post(routePath("resume"), KillResult, {}),
    desktopStatus: (signal) =>
      get(routePath("desktopStatus"), DesktopStatusViewSchema, undefined, signal),
    desktopRevoke: (reason) =>
      post(routePath("desktopRevoke"), DesktopRevokeViewSchema, reason ? { reason } : {}),
    desktopResume: () => post(routePath("desktopResume"), DesktopStatusViewSchema, {}),
    inbox: (humanId, signal) => get(routePath("inbox"), InboxViewSchema, { humanId }, signal),
    answerRequest: (requestId, body) =>
      post(routePath("answerRequest", { id: requestId }), HumanRequestViewSchema, body),
    markRead: (messageId) => post(routePath("markRead", { id: messageId }), MessageViewSchema, {}),
    chat: (body) => post(routePath("chat"), ChatReplyViewSchema, body),
    startVoiceSession: (body) => post(routePath("startVoiceSession"), VoiceSessionViewSchema, body),
    voiceSession: (id, signal) =>
      get(routePath("voiceSession", { id }), VoiceSessionViewSchema, undefined, signal),
    voicePress: (id, pressed, replyMode) =>
      post(routePath("voicePress", { id }), VoiceSessionViewSchema, {
        pressed,
        ...(replyMode ? { replyMode } : {}),
      }),
    voiceAudio: (id, chunk) =>
      post(routePath("voiceAudio", { id }), VoiceAudioAckViewSchema, chunk),
    voiceHeard: (id, body) => post(routePath("voiceHeard", { id }), VoiceHeardViewSchema, body),
    stopVoiceSession: (id) =>
      post(routePath("stopVoiceSession", { id }), VoiceSessionViewSchema, {}),
    costs: (filter, signal) =>
      get(
        routePath("costs"),
        CostViewSchema,
        { projectId: filter?.projectId, from: filter?.from, to: filter?.to },
        signal,
      ),
    costEstimates: (signal) =>
      get(routePath("costEstimates"), EstimateAccuracyViewSchema, undefined, signal),
    settings: (filter, signal) =>
      get(
        routePath("settings"),
        SettingList,
        { scope: filter?.scope, scopeId: filter?.scopeId },
        signal,
      ),
    modelSettings: (signal) =>
      get(routePath("modelSettings"), ModelSettingsViewSchema, undefined, signal),
    updateProjectSettings: (projectId, body) =>
      put(routePath("updateProjectSettings", { id: projectId }), ProjectSettingsViewSchema, body),
    mirrorSync: (projectId, full) =>
      post(routePath("mirrorSync", { id: projectId }), MirrorSyncViewSchema, full ? { full } : {}),

    extensions: (filter, signal) =>
      get(routePath("extensions"), ExtensionList, { kind: filter?.kind }, signal),
    extensionCatalog: (signal) =>
      get(routePath("extensionCatalog"), CatalogViewSchema, undefined, signal),
    extension: (id, signal) =>
      get(routePath("extension", { id }), ExtensionViewSchema, undefined, signal),
    addExtension: (body) => post(routePath("addExtension"), ExtensionViewSchema, body),
    toggleExtension: (id, enabled) =>
      post(routePath("toggleExtension", { id }), ExtensionViewSchema, { enabled }),
    approveExtension: (id) => post(routePath("approveExtension", { id }), ExtensionViewSchema, {}),
    denyExtension: async (id) => {
      await post(routePath("denyExtension", { id }), OkView, {});
    },
    voiceStatus: (signal) =>
      get(routePath("voiceStatus"), VoiceStatusViewSchema, undefined, signal),
    updateExtensionPermissions: (id, permissions) =>
      put(routePath("extensionPermissions", { id }), ExtensionViewSchema, { permissions }),
    removeExtension: async (id) => {
      await del(routePath("removeExtension", { id }), OkView);
    },

    updates: (signal) => get(routePath("updates"), UpdatesViewSchema, undefined, signal),
    updatesStatus: (signal) =>
      get(routePath("updatesStatus"), UpdatesViewSchema, undefined, signal),
    checkUpdates: () => post(routePath("checkUpdates"), UpdatesViewSchema, {}),
    applyUpdate: (version) =>
      post(routePath("applyUpdate"), ApplyUpdateResultSchema, version ? { version } : {}),
    rollbackUpdate: (reason) =>
      post(routePath("rollbackUpdate"), RollbackResultSchema, reason ? { reason } : {}),

    modelWatchReports: (limit, signal) =>
      get(routePath("modelWatchReports"), ModelWatchReportsViewSchema, { limit }, signal),
    modelWatchLatest: (signal) =>
      get(routePath("modelWatchLatest"), ModelWatchReportViewSchema, undefined, signal),
    modelWatchReport: (id, signal) =>
      get(routePath("modelWatchReport", { id }), ModelWatchReportViewSchema, undefined, signal),
    modelWatchRun: () => post(routePath("modelWatchRun"), ModelWatchRunViewSchema, {}),
    modelWatchAnswer: (id, body) =>
      post(routePath("modelWatchAnswer", { id }), ModelWatchAnswerViewSchema, body),
    modelWatchSync: () => post(routePath("modelWatchSync"), ModelWatchSyncView, {}),

    reviews: (projectId, filter, signal) =>
      get(
        routePath("reviews", { id: projectId }),
        ReviewsViewSchema,
        { limit: filter?.limit },
        signal,
      ),
    taskReviews: (taskId, signal) =>
      get(routePath("taskReviews", { id: taskId }), ReviewsViewSchema, undefined, signal),
    memoryScopes: (signal) => get(routePath("memoryScopes"), MemoryScopeList, undefined, signal),
    memory: (filter, signal) =>
      get(
        routePath("memory"),
        MemoryViewSchema,
        {
          scope: filter.scope,
          agentId: filter.agentId,
          projectId: filter.projectId,
          q: filter.q,
          tag: filter.tag,
          status: filter.status,
          limit: filter.limit,
        },
        signal,
      ),
    updateLesson: (id, body) => put(routePath("updateLesson", { id }), LessonViewSchema, body),
    pinLesson: (id, pinned) => post(routePath("pinLesson", { id }), LessonViewSchema, { pinned }),
    deleteLesson: (id) => del(routePath("deleteLesson", { id }), LessonViewSchema),
    consolidation: (signal) =>
      get(routePath("consolidation"), ConsolidationList, undefined, signal),
    runConsolidation: () => post(routePath("runConsolidation"), ConsolidationRunViewSchema, {}),
    proposeLesson: (id) => post(routePath("proposeLesson", { id }), LessonViewSchema, {}),
    memoryPromotions: (signal) => get(routePath("memoryPromotions"), LessonList, undefined, signal),
    memoryOffers: (signal) => get(routePath("memoryOffers"), OfferList, undefined, signal),
    answerOffer: (id, answer) =>
      post(routePath("answerOffer", { id }), LessonOfferViewSchema, { answer }),
    commandDefs: (signal) => get(routePath("commands"), CommandDefList, undefined, signal),
    parseCommand: (body) => post(routePath("parseCommand"), CommandParseViewSchema, body),
    executeCommands: (body) => post(routePath("executeCommands"), CommandResultViewSchema, body),
    pendingCommands: (signal) =>
      get(routePath("pendingCommands"), PendingChangeList, undefined, signal),
    confirmCommand: (pendingId, body) =>
      post(routePath("confirmCommand", { id: pendingId }), CommandResultViewSchema, body),
    cancelCommand: (pendingId) =>
      post(routePath("cancelCommand", { id: pendingId }), CommandResultViewSchema, {}),
    changes: (filter, signal) =>
      get(
        routePath("changes"),
        ChangeLogList,
        {
          projectId: filter?.projectId,
          undoable: filter?.undoable ? "true" : undefined,
          limit: filter?.limit,
        },
        signal,
      ),
    undoChange: (changeId) =>
      post(routePath("undoChange", { id: changeId }), CommandResultViewSchema, {}),
    emailSettings: (agentId, signal) =>
      get(routePath("emailSettings", { agentId }), EmailSettingsViewSchema, undefined, signal),
    updateEmailSettings: (agentId, body) =>
      put(routePath("updateEmailSettings", { agentId }), EmailSettingsViewSchema, body),
    emailSent: (agentId, filter, signal) =>
      get(
        routePath("emailSent", { agentId }),
        EmailSentViewSchema,
        { limit: filter?.limit, since: filter?.since },
        signal,
      ),
    pauseEmail: (agentId) => post(routePath("pauseEmail", { agentId }), EmailPausedViewSchema, {}),
    resumeEmail: (agentId) =>
      post(routePath("resumeEmail", { agentId }), EmailPausedViewSchema, {}),
    rotateEmailMarker: (agentId) =>
      post(routePath("rotateEmailMarker", { agentId }), EmailMarkerViewSchema, {}),
    emailCommands: (agentId, filter, signal) =>
      get(
        routePath("emailCommands", { agentId }),
        EmailCommandsViewSchema,
        { limit: filter?.limit },
        signal,
      ),
    runnerKeyStatus: (runnerId, signal) =>
      get(routePath("runnerKeyStatus", { runnerId }), RunnerKeyStatusViewSchema, undefined, signal),
    wrapRunnerKey: (body) => post(routePath("wrapRunnerKey"), RunnerUnlockAnswerViewSchema, body),
    queue: (projectId, filter, signal) =>
      get(routePath("queue", { id: projectId }), QueueList, { status: filter?.status }, signal),
    enqueue: (projectId, body) =>
      post(routePath("enqueue", { id: projectId }), QueueItemViewSchema, body),
    dismissQueueItem: (id) => post(routePath("dismissQueueItem", { id }), QueueItemViewSchema, {}),
    milestones: (projectId, signal) =>
      get(routePath("milestones", { id: projectId }), MilestoneList, undefined, signal),
    changeMilestone: (id, body) =>
      post(routePath("changeMilestone", { id }), MilestoneViewSchema, body),
    dataAssets: (projectId, signal) =>
      get(routePath("dataAssets", { id: projectId }), DataAssetList, undefined, signal),
    registerDataAsset: (projectId, body) =>
      post(routePath("registerDataAsset", { id: projectId }), DataAssetViewSchema, body),
    removeDataAsset: async (id) => {
      await del(routePath("removeDataAsset", { id }), OkView);
    },
    // The daemon's import (U-006): the locator travels as `locator`, which it reads as the path.
    importProject: (projectId, body) =>
      post(routePath("importData", { id: projectId }), ImportResultViewSchema, {
        source: body.source,
        locator: body.locator,
      }),
    docs: (projectId, signal) =>
      get(routePath("docs", { id: projectId }), DocList, undefined, signal),
    doc: (projectId, path, signal) =>
      get(routePath("doc", { id: projectId, path }), DocContentViewSchema, undefined, signal),
    performance: (filter, signal) =>
      get(
        routePath("performance"),
        PerformanceViewSchema,
        { projectId: filter?.projectId, days: filter?.days },
        signal,
      ),
    sources: (signal) => get(routePath("sources"), SourceList, undefined, signal),
    addSource: (body) => post(routePath("addSource"), SourceViewSchema, body),
    scanSource: (id) => post(routePath("scanSource", { id }), ScanResultViewSchema, {}),
    sourceCandidates: (id, filter, signal) =>
      get(
        routePath("sourceCandidates", { id }),
        SourceCandidateList,
        { status: filter?.status },
        signal,
      ),
    acceptCandidate: (id, body) =>
      post(routePath("acceptCandidate", { id }), AcceptCandidateViewSchema, body ?? {}),
    removeSource: (id) => del(routePath("removeSource", { id }), RemoveSourceViewSchema),
    devices: (signal) => get(routePath("devices"), DeviceListViewSchema, undefined, signal),
    startPairing: (body) => post(routePath("startPairing"), PairingStartViewSchema, body ?? {}),
    revokeDevice: (id) => post(routePath("revokeDevice", { id }), RevokeDeviceViewSchema, {}),
    setupStatus: (signal) =>
      get(routePath("setupStatus"), SetupStatusViewSchema, undefined, signal),
    setupProfile: (body) => post(routePath("setupProfile"), SetupStatusViewSchema, body),
    setupAnthropic: (value) => post(routePath("setupAnthropic"), SetupCheckViewSchema, { value }),
    setupGitHub: (body) => post(routePath("setupGitHub"), SetupCheckViewSchema, body),
    setupFinish: () => post(routePath("setupFinish"), SetupFinishViewSchema, {}),
    auditExport: async (filter, signal) => {
      const format: AuditExportFormat = filter?.format ?? "jsonl";
      const res = await raw({
        method: "GET",
        path: routePath("auditExport"),
        query: {
          agentId: filter?.agentId,
          sessionId: filter?.sessionId,
          from: filter?.from,
          to: filter?.to,
          format,
        },
        accept: format === "csv" ? "text/csv" : "application/x-ndjson",
        signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      const text = await res.text();
      return {
        filename:
          filenameFromDisposition(res.headers.get("content-disposition")) ??
          `forerunner-audit.${format}`,
        contentType:
          res.headers.get("content-type") ??
          (format === "csv" ? "text/csv" : "application/x-ndjson"),
        text,
        rows: countExportRows(text, format),
      };
    },
  };
}

/** Plain-language message for a banner; never leaks the token or the stack. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "ui.network") return "Daemon not reachable.";
    if (error.status === 401) return "Daemon rejected the token.";
    // A typed 403 (a scope the human may not read, a grant that needs approval) keeps its
    // message; an untyped one is the token.
    if (error.status === 403 && (error.code === "ui.http_error" || error.code === "unauthorized")) {
      return "Daemon rejected the token.";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
