import { randomBytes } from "node:crypto";
import type {
  ChatReplyView,
  EventView,
  HumanRequestView,
  MessageView,
  ProjectCard,
  SessionView,
  TaskView,
} from "@forerunner/runtime/daemon/api-types";
import {
  AnswerRequestBody,
  ChatRequestBody,
  CreateProjectBody,
  CreateTaskBody,
  KillBody,
  StartSessionBody,
  TransitionTaskBody,
} from "@forerunner/runtime/daemon/api-types";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  AGENTS,
  COSTS,
  DECISIONS,
  EVENTS,
  HEALTH,
  ME,
  MESSAGES,
  money,
  PEERS,
  PROJECTS,
  REQUESTS,
  RUNS,
  SESSIONS,
  SETTINGS,
  SUMMARIES,
  TASKS,
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
      allowMethods: ["GET", "POST", "OPTIONS"],
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
    if (c.req.method === "POST") {
      let body: unknown = null;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = null;
      }
      state.calls.push({ method: "POST", path: c.req.path, body });
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
      activeSessions: state.sessions.filter((s) => s.status === "running").length,
      killActive: state.killActive,
    }),
  );
  app.get("/me", (c) => c.json(ME));
  app.get("/agents", (c) => c.json(AGENTS));

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
    if (!state.projects.some((p) => p.id === id)) {
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
      riskTier: parsed.data.riskTier,
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
        pendingConfirmation: { id, readback, estimate: money(5_000_000) },
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
    return c.json(
      SETTINGS.filter((s) => (!scope || s.scope === scope) && (!scopeId || s.scopeId === scopeId)),
    );
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
