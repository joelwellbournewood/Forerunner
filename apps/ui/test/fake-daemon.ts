import { randomBytes } from "node:crypto";
import type {
  ChangeLogView,
  ChatReplyView,
  CommandResultJson,
  ConsolidationProposalView,
  ConsolidationReportView,
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
  PendingChangeView,
  ProjectCard,
  ReviewsView,
  ReviewView,
  SessionView,
  SourceCandidateView,
  SourceView,
  TaskView,
} from "@forerunner/runtime/daemon/api-types";
import {
  AnswerRequestBody,
  ChatRequestBody,
  CreateProjectBody,
  CreateTaskBody,
  EMAIL_MODES,
  KillBody,
  StartSessionBody,
  TransitionTaskBody,
} from "@forerunner/runtime/daemon/api-types";
import {
  auditExportContentType,
  auditExportFilename,
  csvHeader,
  csvLine,
  jsonlLine,
} from "@forerunner/runtime/daemon/audit-export";
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
  MODEL_WATCH_REPORTS,
  money,
  OFFERS,
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
  /** Bearer token the fake expects; random when omitted. */
  token?: string;
  /** Spacing of the scripted events after POST /sessions; 150 ms by default. */
  eventDelayMs?: number;
  /** Heartbeat cadence on /events; 1 s by default. */
  heartbeatMs?: number;
  /** Delay between streamed chat tokens; 5 ms by default. */
  tokenDelayMs?: number;
  /**
   * Paths the fake answers with 404 "no route" (ADR 0032), each matching itself and its
   * children ("/memory" covers "/memory/scopes" but "/updates" leaves "/updates/status"): a
   * daemon without the reviews, memory, command or other routes, so the pages' degraded
   * state is tested.
   */
  missingRoutes?: string[];
  /**
   * Exact paths the fake answers with an error body and status, e.g. the release feed being
   * unreachable (`{"/updates": {status: 503, code: "unavailable", message: "feed down"}}`).
   */
  failing?: Record<string, { status: number; code: string; message: string }>;
  /**
   * Overrides of the `/me` answer, e.g. `desktopDeviceId: null` (a daemon that registered no
   * desktop row) or another id (a row this fake does not know, so a device confirmation
   * naming it is refused like the real executor refuses an unknown device).
   */
  me?: Partial<HumanView>;
}

type Listener = (event: string, data: unknown) => void;

export interface FakeDaemonState {
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
  dataAssets: DataAssetView[];
  /** Source discovery (spec A.4): connected sources and what their scans found. */
  sources: SourceView[];
  sourceCandidates: SourceCandidateView[];
  pendingCommands: Map<string, PendingCommand>;
  /** Email settings per agent id (Settings -> Capabilities -> Email), as the daemon stores them. */
  email: Record<string, EmailSettingsView>;
  /** Sent copies and the command audit of every agent, oldest first (answered newest first). */
  emailSent: EmailSentRowView[];
  emailCommands: EmailCommandRowView[];
  missingRoutes: string[];
  failing: Record<string, { status: number; code: string; message: string }>;
}

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

function errorBody(c: Context, status: 400 | 401 | 404 | 409, code: string, message: string) {
  return c.json({ code, message }, status);
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
    version: HEALTH.version,
    modelWatchReports: clone(MODEL_WATCH_REPORTS),
    reviews: clone(REVIEWS),
    lessons: clone(LESSONS),
    changes: clone(CHANGES),
    consolidation: clone(CONSOLIDATION),
    offers: clone(OFFERS),
    promotions: clone(PROMOTIONS),
    queue: clone(QUEUE),
    dataAssets: clone(DATA_ASSETS),
    sources: clone(SOURCES),
    sourceCandidates: clone(SOURCE_CANDIDATES),
    pendingCommands: new Map(),
    email: clone(EMAIL_SETTINGS),
    emailSent: clone(EMAIL_SENT),
    emailCommands: clone(EMAIL_COMMANDS),
    missingRoutes: [...(options.missingRoutes ?? [])],
    failing: { ...(options.failing ?? {}) },
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

  app.get("/__test/calls", (c) => c.json(state.calls));
  app.post("/__test/reset", (c) => {
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
    state.version = HEALTH.version;
    state.modelWatchReports = clone(MODEL_WATCH_REPORTS);
    state.reviews = clone(REVIEWS);
    state.lessons = clone(LESSONS);
    state.changes = clone(CHANGES);
    state.consolidation = clone(CONSOLIDATION);
    state.offers = clone(OFFERS);
    state.promotions = clone(PROMOTIONS);
    state.queue = clone(QUEUE);
    state.dataAssets = clone(DATA_ASSETS);
    state.sources = clone(SOURCES);
    state.sourceCandidates = clone(SOURCE_CANDIDATES);
    state.pendingCommands.clear();
    state.email = clone(EMAIL_SETTINGS);
    state.emailSent = clone(EMAIL_SENT);
    state.emailCommands = clone(EMAIL_COMMANDS);
    state.missingRoutes = [...(options.missingRoutes ?? [])];
    state.failing = { ...(options.failing ?? {}) };
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
  app.get("/agents", (c) => c.json(AGENTS));

  // ---------------------------------------------------------------------------------------
  // Agent email (spec S.15, S.28, S.29, T.14; ADR 0066): the capability's seven routes as
  // `emailRouteTable` serves them on the daemon. Errors come wrapped under `error`, the
  // capability routes' shape (`{ error: { code, message, details } }`), not the daemon's flat
  // body. The signed-in human (ME) must own the agent; another human's agent or an unknown
  // one is 403 `tool_not_allowed` before any read or write. PUT merges a partial patch the
  // way `mergeEmailConfig` does (allowlist and signature merged one level deep) and refuses
  // an unknown mode or a mailbox credential that is not a secret reference with 400.
  // ---------------------------------------------------------------------------------------

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
      dependsOn: parsed.data.dependsOn,
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
    return c.json(session, 201);
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

  app.get("/inbox", (c) =>
    c.json({ requests: state.requests, messages: state.messages, blockingCount: blockingCount() }),
  );
  app.post("/requests/:id/answer", async (c) => {
    const r = state.requests.find((x) => x.id === c.req.param("id"));
    if (!r) return errorBody(c, 404, "not_found", "no such request");
    const parsed = AnswerRequestBody.safeParse(await c.req.json());
    if (!parsed.success) return errorBody(c, 400, "validation", parsed.error.message);
    if (parsed.data.version !== r.version) {
      return errorBody(c, 409, "conflict", "request changed since you loaded it");
    }
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
  app.get("/settings", (c) => {
    const scope = c.req.query("scope");
    const scopeId = c.req.query("scopeId");
    // Like the daemon, the project rows read the live project (a command may have changed it).
    const rows = SETTINGS.map((s) => {
      if (s.key === "project.autonomy") {
        const p = state.projects.find((x) => x.id === s.scopeId);
        return p ? { ...s, value: p.autonomyLevel } : s;
      }
      return s;
    });
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
  app.get("/extensions/:id", (c) => {
    const e = findExtension(c);
    return e ? c.json(e) : errorBody(c, 404, "not_found", "no such extension");
  });
  app.post("/extensions", async (c) => {
    const body = (await c.req.json()) as { catalogId?: string; url?: string };
    const now = new Date().toISOString();
    let view: ExtensionView;
    if (body.catalogId) {
      const entry = CATALOG.entries.find((e) => e.id === body.catalogId);
      if (!entry) return errorBody(c, 404, "not_found", `no catalog entry ${body.catalogId}`);
      const pending = entry.kind === "connector";
      view = {
        id: nextId("ext"),
        name: entry.name,
        kind: entry.kind,
        status: pending ? "pending_approval" : "enabled",
        enabled: !pending,
        description: entry.description,
        permissions: pending
          ? normalizePermissions(undefined)
          : normalizePermissions(entry.permissions),
        pendingPermissions: pending ? normalizePermissions(entry.permissions) : null,
        pendingStage: pending ? "grant" : null,
        review: pending
          ? {
              tools: [],
              resources: [],
              permissions: normalizePermissions(entry.permissions),
              risk: entry.permissions.secrets.length > 0 ? "high" : "medium",
              summary: [
                `reaches ${entry.permissions.domains.join(", ") || "no domain"}`,
                ...entry.permissions.secrets.map((s) => `needs secret:${s}`),
              ],
            }
          : null,
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
    if (view.status === "pending_approval") {
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
    e.rowVersion += 1;
    e.updatedAt = new Date().toISOString();
    emitExtension("extension.approved", e);
    const req = state.requests.find((r) => r.id === `req_${e.id}` && r.status === "open");
    if (req) req.status = "answered";
  };
  app.post("/extensions/:id/approve", (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    approveExtension(e);
    return c.json(e);
  });
  app.post("/extensions/:id/deny", (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    state.extensions = state.extensions.filter((x) => x.id !== e.id);
    emitExtension("extension.denied", e);
    return c.json({ ok: true });
  });
  app.put("/extensions/:id/permissions", async (c) => {
    const e = findExtension(c);
    if (!e) return errorBody(c, 404, "not_found", "no such extension");
    const body = (await c.req.json()) as { permissions?: Partial<ExtensionPermissions> };
    const next = normalizePermissions({ ...e.permissions, ...(body.permissions ?? {}) });
    e.rowVersion += 1;
    e.updatedAt = new Date().toISOString();
    if (widens(e.permissions, next)) {
      e.pendingPermissions = next;
      e.pendingStage = "grant";
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
    state.extensions = state.extensions.filter((x) => x.id !== e.id);
    emitExtension("extension.removed", e);
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
    return base;
  };
  app.get("/updates", (c) => c.json(updatesView(true)));
  app.get("/updates/status", (c) => c.json(updatesView(false)));
  app.post("/updates/apply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { version?: string };
    const target = body.version ?? UPDATES_FEED.app.available?.version ?? state.version;
    const from = state.version;
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
    if (!body.by || !["adopt", "ignore", "remind"].includes(body.decision ?? "")) {
      return errorBody(c, 400, "validation", "answer body is malformed");
    }
    r.decision =
      body.decision === "adopt" ? "adopted" : body.decision === "ignore" ? "ignored" : "remind";
    r.decided_at = new Date().toISOString();
    r.status = "resolved";
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
    if (l.scope === "shared" && l.projectId === null) {
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
  const SETTING_RISK: Record<string, Risk> = {
    speed_quality_offset: "low",
    small_project_mode: "low",
    critic_ceiling: "medium",
    session_reserve_share: "medium",
    quiet_hours: "low",
    shared_with: "high",
    notify_channel: "low",
    default_autonomy: "medium",
    language: "low",
  };
  const plan = (name: string, params: Record<string, unknown>): PlanOutcome => {
    const projectRef = typeof params.project === "string" ? params.project : undefined;
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
    if (name === "settings.set") {
      const key = typeof params.key === "string" ? params.key : "";
      const risk = SETTING_RISK[key];
      if (!risk) return refuse(`unknown setting ${key}`);
      const project = projectByRef(projectRef);
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
    return c.json(MILESTONES.filter((m) => m.projectId === id));
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
  app.post("/projects/:id/import", async (c) => {
    const id = c.req.param("id");
    if (!state.projects.some((p) => p.id === id)) {
      return errorBody(c, 404, "not_found", "no such project");
    }
    const body = (await c.req.json()) as { source?: string; locator?: string };
    if (!body.locator?.trim() || !["zip", "folder", "repo"].includes(body.source ?? "")) {
      return errorBody(c, 400, "validation", "source and locator are required");
    }
    const task: TaskView = {
      id: nextId("task"),
      projectId: id,
      milestoneId: null,
      title: `Import ${body.source} ${body.locator.trim()}`,
      outcome: "The original is preserved; the migration runs on a branch.",
      acceptanceCriteria: ["Original untouched", "Migration branch opened"],
      riskTier: 1,
      status: "ready",
      priority: 6,
      claimedBy: null,
      claimExpires: null,
      dependsOn: [],
      budget: money(0),
      estimate: money(0),
      actual: money(0),
      specialist: "migration",
      attempt: 0,
      prUrl: null,
      branch: null,
      reason: "import requested from the app",
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    state.tasks.unshift(task);
    return c.json(
      {
        status: "queued",
        taskId: task.id,
        requestId: null,
        message: `Import queued as ${task.id}; the migration specialist runs it on a branch.`,
      },
      202,
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

  app.get("/performance", (c) =>
    c.json({ ...PERFORMANCE, projectId: c.req.query("projectId") ?? null }),
  );

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

  function close() {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    state.listeners.clear();
  }

  return { app, state, token, close };
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
