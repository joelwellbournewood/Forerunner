import {
  AgentView as AgentViewSchema,
  type ChatReplyView,
  ChatReplyView as ChatReplyViewSchema,
  type ChatRequestBody,
  type CostView,
  CostView as CostViewSchema,
  type CreateProjectBody as CreateProjectBodySchema,
  type CreateTaskBody as CreateTaskBodySchema,
  DAEMON_ROUTES,
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
  type MessageView,
  MessageView as MessageViewSchema,
  type ProjectCard,
  ProjectCard as ProjectCardSchema,
  type ProjectSummary,
  ProjectSummary as ProjectSummarySchema,
  type RunView,
  RunView as RunViewSchema,
  type SessionView,
  SessionView as SessionViewSchema,
  SettingView as SettingViewSchema,
  type StartSessionBody as StartSessionBodySchema,
  type TaskView,
  TaskView as TaskViewSchema,
  type TransitionTaskBody as TransitionTaskBodySchema,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import type { DaemonConfig } from "./config.ts";

export type {
  ChatReplyView,
  ChatRequestBody,
  CostView,
  EventView,
  HealthView,
  HumanRequestView,
  InboxView,
  MessageView,
  ProjectCard,
  ProjectSummary,
  RunView,
  SessionView,
  TaskView,
};

/** Types the contract defines only as schemas. */
export type AgentView = z.infer<typeof AgentViewSchema>;
export type HumanView = z.infer<typeof HumanViewSchema>;
export type SettingView = z.infer<typeof SettingViewSchema>;
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export type TransitionTaskBody = z.infer<typeof TransitionTaskBodySchema>;
export type KillBody = z.infer<typeof KillBodySchema>;

/** Shapes the contract leaves open (ADR 0014): lists are bare arrays, kill reports its state. */
export const KillResult = z.looseObject({ killActive: z.boolean() });
export type KillResult = z.infer<typeof KillResult>;

export const ProjectList = z.array(ProjectCardSchema);
export const TaskList = z.array(TaskViewSchema);
export const RunList = z.array(RunViewSchema);
export const SessionList = z.array(SessionViewSchema);
export const EventList = z.array(EventViewSchema);
export const SettingList = z.array(SettingViewSchema);
export const AgentList = z.array(AgentViewSchema);

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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | null | undefined>;

export interface RawRequestOptions {
  method: "GET" | "POST";
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
  projects(signal?: AbortSignal): Promise<ProjectCard[]>;
  createProject(body: CreateProjectBody): Promise<ProjectCard>;
  project(id: string, signal?: AbortSignal): Promise<ProjectCard>;
  projectSummary(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  tasks(
    projectId: string,
    filter?: { status?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<TaskView[]>;
  createTask(projectId: string, body: CreateTaskInput): Promise<TaskView>;
  transitionTask(taskId: string, body: TransitionTaskBody): Promise<TaskView>;
  runs(projectId: string, filter?: { limit?: number }, signal?: AbortSignal): Promise<RunView[]>;
  sessions(
    filter?: { agentId?: string; projectId?: string; status?: string },
    signal?: AbortSignal,
  ): Promise<SessionView[]>;
  startSession(body: StartSessionInput): Promise<SessionView>;
  session(id: string, signal?: AbortSignal): Promise<SessionView>;
  sessionEvents(id: string, afterSeq?: number, signal?: AbortSignal): Promise<EventView[]>;
  stopSession(id: string, reason?: string): Promise<SessionView>;
  kill(body: KillBody): Promise<KillResult>;
  resume(): Promise<KillResult>;
  inbox(humanId: string, signal?: AbortSignal): Promise<InboxView>;
  answerRequest(requestId: string, body: AnswerRequestInput): Promise<HumanRequestView>;
  markRead(messageId: string): Promise<MessageView>;
  chat(body: ChatRequestBody): Promise<ChatReplyView>;
  costs(
    filter?: { projectId?: string; from?: string; to?: string },
    signal?: AbortSignal,
  ): Promise<CostView>;
  settings(
    filter?: { scope?: string; scopeId?: string },
    signal?: AbortSignal,
  ): Promise<SettingView[]>;
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
      const parsed = ErrorBody.safeParse(JSON.parse(text));
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

  return {
    config,
    url,
    raw,
    health: (signal) => get(routePath("health"), HealthViewSchema, undefined, signal),
    me: (signal) => get(routePath("me"), HumanViewSchema, undefined, signal),
    agents: (signal) => get(routePath("agents"), AgentList, undefined, signal),
    projects: (signal) => get(routePath("projects"), ProjectList, undefined, signal),
    createProject: (body) => post(routePath("createProject"), ProjectCardSchema, body),
    project: (id, signal) =>
      get(routePath("project", { id }), ProjectCardSchema, undefined, signal),
    projectSummary: (id, signal) =>
      get(routePath("projectSummary", { id }), ProjectSummarySchema, undefined, signal),
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
    sessions: (filter, signal) =>
      get(
        routePath("sessions"),
        SessionList,
        { agentId: filter?.agentId, projectId: filter?.projectId, status: filter?.status },
        signal,
      ),
    startSession: (body) => post(routePath("startSession"), SessionViewSchema, body),
    session: (id, signal) =>
      get(routePath("session", { id }), SessionViewSchema, undefined, signal),
    sessionEvents: (id, afterSeq, signal) =>
      get(routePath("sessionEvents", { id }), EventList, { afterSeq }, signal),
    stopSession: (id, reason) =>
      post(routePath("stopSession", { id }), SessionViewSchema, reason ? { reason } : {}),
    kill: (body) => post(routePath("kill"), KillResult, body),
    resume: () => post(routePath("resume"), KillResult, {}),
    inbox: (humanId, signal) => get(routePath("inbox"), InboxViewSchema, { humanId }, signal),
    answerRequest: (requestId, body) =>
      post(routePath("answerRequest", { id: requestId }), HumanRequestViewSchema, body),
    markRead: (messageId) => post(routePath("markRead", { id: messageId }), MessageViewSchema, {}),
    chat: (body) => post(routePath("chat"), ChatReplyViewSchema, body),
    costs: (filter, signal) =>
      get(
        routePath("costs"),
        CostViewSchema,
        { projectId: filter?.projectId, from: filter?.from, to: filter?.to },
        signal,
      ),
    settings: (filter, signal) =>
      get(
        routePath("settings"),
        SettingList,
        { scope: filter?.scope, scopeId: filter?.scopeId },
        signal,
      ),
  };
}

/** Plain-language message for a banner; never leaks the token or the stack. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "ui.network") return "Daemon not reachable.";
    if (error.status === 401 || error.status === 403) return "Daemon rejected the token.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
