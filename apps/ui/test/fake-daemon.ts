import { randomBytes } from "node:crypto";
import type {
  AgentView,
  ChangeLogView,
  ChatReplyView,
  CommandResultJson,
  ConsolidationProposalView,
  ConsolidationReportView,
  DaemonDeviceView,
  DesktopControlView,
  EmailCommandRowView,
  EmailSentRowView,
  EmailSettingsPatchBody,
  EmailSettingsView,
  EventView,
  HumanRequestView,
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
  TransitionTaskBody,
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
import { ImportResultView } from "@forerunner/runtime/data/types";
import { fastModeDescription, fastModeEffect } from "@forerunner/runtime/models/fast-mode";
import { acceptsAnswer } from "@forerunner/runtime/wiring/request-answers";
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
  /** Heartbeat cadence on /events; 1 s by default. */
  heartbeatMs?: number;
  /** Delay between streamed chat tokens; 5 ms by default. */
  tokenDelayMs?: number;
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
}

type Listener = (event: string, data: unknown) => void;

export interface FakeDaemonState {
  /** What `POST /secrets/store` kept, by name (U-054); the routes never send a value back. */
  storedSecrets: Map<string, string>;
  /** `/agents`; `POST /agents/:id/rename` renames one of them (U-025). */
  agents: AgentView[];
  projects: ProjectCard[];
  tasks: TaskView[];
  sessions: SessionView[];
  events: EventView[];
  requests: HumanRequestView[];
  messages: MessageView[];
  killActive: boolean;
  calls: RecordedCall[];
  pendingConfirmation: { id: string; readback: string } | null;
  /** When set, the next `/chat/stream` reply has this text (tests script the agent). */
  nextChatReply: string | null;
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
  /** `GET /settings/models` with every temperature; `model.settings.set` changes it. */
  modelSettings: ModelSettingsView;
  acceptsTemperature: boolean;
  /** Voice sessions with the audio chunks received for the turn being spoken. */
  voiceSessions: Map<string, { view: VoiceSessionView; pressed: boolean; chunks: number }>;
  /** When set, the next released turn transcribes to this line (tests script the human). */
  nextVoiceLine: string | null;
  /** `GET /voice/install` and the last install job's events (ADR 0090). */
  voiceInstall: VoiceInstallView;
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
function fakeStartCheck(
  tasks: readonly TaskView[],
  projectId: string,
  budgetUsdMicro: number | null,
): StartCheckView {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = tasks
    .filter((t) => t.projectId === projectId && t.status === "ready")
    .sort((a, b) => b.priority - a.priority);
  const cap = budgetUsdMicro ?? FAKE_SESSION_CAP_USD_MICRO;
  const work = Math.floor(cap * 0.8);
  const runnable: StartCheckView["runnable"] = [];
  const overBudget: StartCheckView["overBudget"] = [];
  const waiting: StartCheckView["waiting"] = [];
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
    const estimate = t.estimate.usdMicro || t.budget.usdMicro || 500_000;
    const named = { taskId: t.id, title: t.title, estimate: money(estimate) };
    if (total + estimate > work) overBudget.push(named);
    else {
      runnable.push(named);
      total += estimate;
    }
  }
  return {
    projectId,
    sessionBudget: money(cap),
    workBudget: money(work),
    ready: ready.length,
    runnable,
    overBudget,
    waiting,
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
    sessions: clone(SESSIONS),
    events: clone(EVENTS),
    requests: clone(REQUESTS),
    messages: clone(MESSAGES),
    killActive: false,
    calls: [],
    pendingConfirmation: null,
    nextChatReply: null,
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
    modelSettings: clone(MODEL_SETTINGS),
    acceptsTemperature: options.acceptsTemperature ?? true,
    voiceSessions: new Map(),
    nextVoiceLine: null,
    voiceInstall: { ...clone(VOICE_INSTALL), ...(options.voiceInstall ?? {}) },
    voiceInstallEntries: [],
    voiceInstallStreamsAfter: [],
    voiceHold: false,
    voiceRefusePress: false,
  };

  const emit = (event: string, data: unknown) => {
    for (const l of state.listeners) l(event, data);
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
  app.get("/__test/calls", (c) => c.json(state.calls));
  app.post("/__test/reset", (c) => {
    updatesChecked.value = false;
    state.agents = clone(AGENTS);
    state.projects = clone(PROJECTS);
    state.tasks = clone(TASKS);
    state.sessions = clone(SESSIONS);
    state.events = clone(EVENTS);
    state.requests = clone(REQUESTS);
    state.messages = clone(MESSAGES);
    state.killActive = false;
    state.calls = [];
    state.pendingConfirmation = null;
    state.nextChatReply = null;
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
  app.get("/me", (c) => c.json(me));
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

  app.get("/projects", (c) => c.json(state.projects));
  app.post("/projects", async (c) => {
    const parsed = CreateProjectBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const project: ProjectCard = {
      id: nextId("proj"),
      name: parsed.data.name,
      goal: parsed.data.goal,
      stage: "idea",
      status: "active",
      autonomyLevel: parsed.data.autonomyLevel ?? 2,
      nextMilestone: null,
      health: "idle",
      spend: money(0),
      budget: money(parsed.data.budgetUsdMicro ?? 62_500_000),
      waitingOnYou: 0,
      latestCriticGrade: null,
      lastSessionAt: null,
      active: false,
      smallProjectMode: false,
      defaultRiskTier: 1,
    };
    state.projects.push(project);
    emit("project.changed", { id: project.id });
    return c.json(project, 201);
  });
  app.get("/projects/:id", (c) => {
    const p = state.projects.find((x) => x.id === c.req.param("id"));
    return p ? c.json(p) : errorBody(c, 404, "not_found", "no such project");
  });
  app.get("/projects/:id/summary", (c) => {
    const id = c.req.param("id");
    const p = state.projects.find((x) => x.id === id);
    if (!p) return errorBody(c, 404, "not_found", "no such project");
    return c.json(
      SUMMARIES[id] ?? {
        goal: p.goal,
        stage: p.stage,
        lastSession: null,
        nextSteps: [],
        openQuestions: 0,
        spend: p.spend,
        spoken: `${p.name} has not run yet.`,
      },
    );
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
  app.get("/projects/:id/tasks", (c) => {
    const id = c.req.param("id");
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = state.tasks.filter((t) => t.projectId === id && (!status || t.status === status));
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
      riskTier: parsed.data.riskTier ?? project.defaultRiskTier ?? 1,
      status: parsed.data.status,
      priority: parsed.data.priority,
      claimedBy: null,
      claimExpires: null,
      dependsOn: deps.ids,
      budget: money(parsed.data.budgetUsdMicro),
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
    return c.json(task, 201);
  });
  app.post("/tasks/:id/transition", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = TransitionTaskBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== task.version) {
      return errorBody(c, 409, "conflict", "task changed since you loaded it");
    }
    task.status = parsed.data.to;
    task.reason = parsed.data.reason;
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    return c.json(task);
  });
  app.post("/tasks/:id/dependencies", async (c) => {
    const task = state.tasks.find((t) => t.id === c.req.param("id"));
    if (!task) return errorBody(c, 404, "not_found", "no such task");
    const parsed = SetTaskDependenciesBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const deps = checkFakeDependencies(state.tasks, task.projectId, task.id, parsed.data.dependsOn);
    if (!deps.ok) return errorBody(c, 409, "conflict", deps.message);
    if (parsed.data.version !== task.version) {
      return errorBody(c, 409, "conflict", "task changed since you loaded it");
    }
    task.dependsOn = deps.ids;
    task.reason = parsed.data.reason;
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    return c.json(task);
  });
  app.get("/projects/:id/start-check", (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const raw = Number(c.req.query("budgetUsdMicro") ?? "");
    return c.json(fakeStartCheck(state.tasks, id, Number.isInteger(raw) && raw > 0 ? raw : null));
  });
  app.get("/projects/:id/runs", (c) => {
    const id = c.req.param("id");
    const taskIds = new Set(state.tasks.filter((t) => t.projectId === id).map((t) => t.id));
    return c.json(RUNS.filter((r) => r.taskId && taskIds.has(r.taskId)));
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
      return errorBody(c, 409, "kill.active", "kill switch is active; resume first");
    }
    const agent = AGENTS.find((a) => a.id === parsed.data.agentId);
    if (!agent) return errorBody(c, 404, "not_found", "no such agent");
    const startId = nextId("start");
    const outcome = options.startOutcome ?? "started";
    if (outcome !== "started") {
      // The real daemon's answer, checked against its schema so the two cannot drift (U-008).
      return c.json(StartSessionView.parse({ result: outcome, startId, session: null }), 202);
    }
    const session: SessionView = {
      id: nextId("sess"),
      agentId: agent.id,
      agentName: agent.name,
      projectId: parsed.data.projectId ?? null,
      trigger: parsed.data.trigger,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      budgetCap: money(parsed.data.budgetUsdMicro ?? 6_250_000),
      spent: money(0),
      stepCap: 200,
      steps: 0,
      currentTask: null,
      summary: "",
      handoff: null,
      runner: "desktop",
    };
    state.sessions.push(session);
    emit("session.changed", clone(session));
    scheduleScriptedEvents(session);
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
      while (open) {
        await stream.sleep(heartbeatMs);
        if (!open) break;
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }
    });
  });
  app.post("/sessions/:id/stop", (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param("id"));
    if (!s) return errorBody(c, 404, "not_found", "no such session");
    if (["running", "paused", "planned"].includes(s.status)) {
      s.status = "stopped";
      s.endedAt = new Date().toISOString();
      pushEvent(s, "session.stopped", "Session stopped by the human", "info");
      emit("session.changed", clone(s));
    }
    return c.json(s);
  });

  app.post("/kill", async (c) => {
    const parsed = KillBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    state.killActive = true;
    let stopped = 0;
    for (const s of state.sessions) {
      if (s.status === "running" || s.status === "paused" || s.status === "planned") {
        s.status = "killed";
        s.endedAt = new Date().toISOString();
        stopped += 1;
        emit("session.changed", clone(s));
      }
    }
    return c.json({ killActive: true, stoppedSessions: stopped });
  });
  app.post("/kill/resume", (c) => {
    state.killActive = false;
    return c.json({ killActive: false, stoppedSessions: 0 });
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

  app.get("/inbox", (c) =>
    c.json({ requests: state.requests, messages: state.messages, blockingCount: blockingCount() }),
  );
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
    if (r.kind === "capability_grant") {
      const ext = state.extensions.find((e) => `req_${e.id}` === r.id);
      if (ext && parsed.data.answer === "Approve") approveExtension(ext);
      else if (ext) {
        state.extensions = state.extensions.filter((e) => e.id !== ext.id);
        emitExtension("extension.denied", ext);
      }
    }
    emit("inbox.changed", { blockingCount: blockingCount() });
    return c.json(r);
  });
  app.post("/messages/:id/read", (c) => {
    const m = state.messages.find((x) => x.id === c.req.param("id"));
    if (!m) return errorBody(c, 404, "not_found", "no such message");
    m.readAt = m.readAt ?? new Date().toISOString();
    return c.json(m);
  });

  const chatReply = (text: string, projectId: string | undefined): ChatReplyView => {
    const base = {
      actions: [] as ChatReplyView["actions"],
      pendingConfirmation: null as ChatReplyView["pendingConfirmation"],
      question: null as ChatReplyView["question"],
      ttftMs: 420,
      cost: money(12_000),
      transcriptId: nextId("tr"),
      activeProjectId: projectId ?? null,
    };
    const lower = text.trim().toLowerCase();
    if (state.pendingConfirmation && lower === "yes") {
      const confirmed = state.pendingConfirmation;
      state.pendingConfirmation = null;
      return {
        ...base,
        reply: "Confirmed. Starting the session now.",
        actions: [{ kind: "session_start", summary: confirmed.readback, id: confirmed.id }],
      };
    }
    if (state.pendingConfirmation && lower === "no") {
      state.pendingConfirmation = null;
      return { ...base, reply: "Cancelled. Nothing was started." };
    }
    if (state.nextChatReply !== null) {
      const reply = state.nextChatReply;
      state.nextChatReply = null;
      return { ...base, reply };
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
    return {
      ...base,
      reply: `${project ? `${project.name}: ` : ""}you asked "${text.trim()}". The last session opened PR #12; one question waits in the inbox.`,
    };
  };

  app.post("/chat", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    return c.json(chatReply(parsed.data.text, parsed.data.projectId));
  });
  app.post("/chat/stream", async (c) => {
    const parsed = ChatRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    const reply = chatReply(parsed.data.text, parsed.data.projectId);
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
    return c.json(view);
  });
  app.get("/settings", (c) => {
    const scope = c.req.query("scope");
    const scopeId = c.req.query("scopeId");
    // Like the daemon, the project rows read the live project (a command may have changed it).
    const rows = SETTINGS.map((s) => {
      if (s.key === "project.autonomy") {
        const p = state.projects.find((x) => x.id === s.scopeId);
        return p ? { ...s, value: p.autonomyLevel } : s;
      }
      if (s.key === "project.speed_quality_offset" && s.scopeId) {
        return { ...s, value: state.speedQuality[s.scopeId] ?? 0 };
      }
      return s;
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
    return c.json({
      id: p.id,
      version: body.version + 1,
      settings: { ...(body.settings ?? {}) },
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
    const verdicts: Record<string, number> = {};
    let openFindings = 0;
    for (const r of sorted) {
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      openFindings += r.openFindings;
    }
    const trend = [...sorted]
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
    critic_ceiling: "medium",
    session_reserve_share: "medium",
    quiet_hours: "low",
    shared_with: "high",
    notify_channel: "low",
    default_autonomy: "medium",
    language: "low",
    calibration: "medium",
    handover: "medium",
  };
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
    if (name === "budget.set") {
      const scope = typeof params.scope === "string" ? params.scope : "session";
      const amountChf = Number(params.amountChf);
      if (!Number.isFinite(amountChf) || amountChf <= 0) {
        return refuse("budget.set: amountChf must be a positive number");
      }
      if (scope === "month") {
        const fromChf = ME.monthlyCap.chfMicro / 1_000_000;
        return {
          name,
          params,
          risk: "high",
          card: card(
            {
              command: name,
              what: "the monthly hard ceiling",
              oldValue: `CHF ${fromChf}`,
              newValue: `CHF ${amountChf}`,
              scope: "global",
              sentence: `Raised the monthly hard ceiling from CHF ${fromChf} to CHF ${amountChf}. Undo.`,
            },
            "high",
          ),
          apply: () => ({
            before: { monthlyCapChf: fromChf },
            after: { monthlyCapChf: amountChf },
          }),
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
      return {
        name,
        params,
        risk,
        card: card(
          {
            command: name,
            what: `${key}${project ? ` for ${project.name}` : ""}`,
            oldValue: "unset",
            newValue: JSON.stringify(params.value),
            scope: "project",
            sentence: `Set ${key}${project ? ` for ${project.name}` : ""} to ${JSON.stringify(params.value)}. Undo.`,
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
          return { before: { [key]: null }, after: { [key]: params.value } };
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
  const withUndoable = (ch: ChangeLogView, now: string): ChangeLogView => ({
    ...ch,
    undoable: ch.undoState === "undoable" && (!ch.expiresAt || ch.expiresAt > now),
  });
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
    if (!withUndoable(entry, now).undoable) {
      const result: CommandResultJson = {
        status: "refused",
        reason: `change is ${entry.undoState}`,
        code: "validation",
        card: null,
        commands: ["undo"],
      };
      return c.json(result);
    }
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
    entry.undoState = "undone";
    entry.undoneAt = now;
    entry.undoable = false;
    entry.version += 1;
    const sentence = `Undone: ${entry.sentence.replace(/ Undo\.$/, ".")}`;
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
      sentence,
      createdAt: now,
      version: 1,
    };
    state.changes.unshift(undoRow);
    const result: CommandResultJson = {
      status: "done",
      sentence,
      changeLogId: undoRow.id,
      undoToken: null,
      card: null,
      commands: ["undo"],
    };
    return c.json(result);
  });

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
    }
    return c.json({
      ok,
      kind: subscription ? "subscription" : "api_key",
      summary: ok ? "Key works; 12 models visible." : "Anthropic rejected the key (401).",
      problems: ok ? [] : ["The key is invalid or revoked."],
      status: setup,
    });
  });
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
    return c.json(id === "proj_atlas" ? DOCS : []);
  });
  app.get("/projects/:id/docs/:path", (c) => {
    const doc = DOC_CONTENTS[c.req.param("path")];
    return doc ? c.json(doc) : errorBody(c, 404, "not_found", "no such doc");
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
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      state.listeners.add(listener);
      stream.onAbort(() => {
        open = false;
        state.listeners.delete(listener);
      });
      await stream.writeSSE({
        event: "inbox.changed",
        data: JSON.stringify({ blockingCount: blockingCount() }),
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
    };
    state.events.push(event);
    emit("session.event", event);
    return event;
  }

  /** After POST /sessions: a short scripted run with a warning and an escalation. */
  function scheduleScriptedEvents(session: SessionView) {
    const script: Array<[string, string, EventView["level"], number]> = [
      ["session.started", "Session started; reading the state brief", "info", 0],
      ["task.claimed", "Claimed task_3 Decide the versioning scheme for researcher", "info", 0],
      ["run.started", "researcher started on sonnet-5.5 (effort high)", "info", 0],
      ["budget.warning", "Session spend at 80% of the cap", "warning", 2_000_000],
      ["escalation", "Choice of versioning scheme needs your decision", "escalation", 0],
      ["run.finished", "researcher finished task_3", "info", 2_500_000],
    ];
    script.forEach(([type, text, level, cost], i) => {
      later(
        () => {
          if (session.status !== "running") return;
          session.steps += 1;
          session.spent = money(session.spent.usdMicro + cost);
          if (type === "task.claimed") {
            session.currentTask = {
              id: "task_3",
              title: "Decide the versioning scheme",
              specialist: "researcher",
            };
          }
          pushEvent(session, type, text, level, { step: session.steps }, cost);
          emit("session.changed", clone(session));
          if (i === script.length - 1) {
            session.status = "completed";
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
