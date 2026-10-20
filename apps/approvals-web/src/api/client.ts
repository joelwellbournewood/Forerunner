import type { z } from "zod";
import { browserClock, type Clock } from "../lib/clock.ts";
import {
  canonicalRequest,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  importSigningKey,
  signBytes,
  utf8,
} from "./crypto.ts";
import type { FetchLike, WebSession } from "./session.ts";
import {
  ConfirmChallengeView,
  DeviceList,
  type DeviceView,
  ErrorBody,
  HealthView,
  HumanRequestView,
  InboxView,
  MessageView,
  MeView,
  type ProjectCard,
  ProjectList,
  RemoteCommandList,
  type RemoteCommandName,
  RemoteCommandView,
  type RemoteTarget,
  SessionList,
  type SessionView,
} from "./types.ts";

/**
 * A small typed client over the state service routes this page uses (ADR 0024, spec R).
 * Every mutation is signed with the tab's device key (ADR 0009: `X-Device-Signature` over
 * `METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0`), every response is validated
 * with the zod schemas in `types.ts`, and every failure is an `ApiError` with a stable code
 * that `describeError` turns into plain words. The token travels only in the
 * `Authorization` header: never in a URL, never in an error message.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AnswerInput {
  version: number;
  answer: unknown;
  /** The re-entered code for a high-risk answer (the web stand-in for the phone's biometric). */
  confirmation?: { challengeId: string; code: string };
}

export interface RemoteCommandInput {
  target: RemoteTarget;
  command: RemoteCommandName;
  params?: Record<string, unknown>;
  targetDeviceId?: string;
}

export interface StreamOptions {
  lastEventId?: string | null;
  signal?: AbortSignal;
}

export interface StateClient {
  readonly baseUrl: string;
  readonly session: WebSession;
  hasScope(scope: string): boolean;
  health(): Promise<z.infer<typeof HealthView>>;
  me(): Promise<z.infer<typeof MeView>>;
  projects(): Promise<ProjectCard[]>;
  inbox(): Promise<z.infer<typeof InboxView>>;
  answerRequest(id: string, input: AnswerInput): Promise<HumanRequestView>;
  markRead(messageId: string): Promise<MessageView>;
  confirmChallenge(requestId: string): Promise<z.infer<typeof ConfirmChallengeView>>;
  devices(): Promise<DeviceView[]>;
  sessions(statuses?: readonly string[]): Promise<SessionView[]>;
  remoteCommands(limit?: number): Promise<RemoteCommandView[]>;
  remoteCommand(id: string): Promise<RemoteCommandView>;
  sendRemoteCommand(input: RemoteCommandInput): Promise<RemoteCommandView>;
  /** Raw authenticated GET for `/events` (SSE); the caller reads the body stream. */
  stream(path: string, options?: StreamOptions): Promise<Response>;
}

export interface ClientOptions {
  baseUrl: string;
  session: WebSession;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function createClient(opts: ClientOptions): StateClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const clock = opts.clock ?? browserClock;
  const { baseUrl, session } = opts;
  let signingKey: Promise<CryptoKey> | null = null;
  const key = () => {
    signingKey ??= importSigningKey(session.privateJwk);
    return signingKey;
  };

  async function signedHeaders(
    method: string,
    url: string,
    body: string,
  ): Promise<Record<string, string>> {
    const u = new URL(url);
    const timestamp = String(clock.now());
    const canonical = await canonicalRequest({
      method,
      path: `${u.pathname}${u.search}`,
      body,
      timestamp,
      biometric: false,
    });
    const signature = await signBytes(await key(), utf8(canonical));
    return { [HEADER_SIGNATURE]: signature, [HEADER_TIMESTAMP]: timestamp };
  }

  async function request<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = joinUrl(baseUrl, path);
    const headers: Record<string, string> = {
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      const text = JSON.stringify(body ?? {});
      headers["content-type"] = "application/json";
      Object.assign(headers, await signedHeaders(method, url, text));
      init.body = text;
    }
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError("web.aborted", "The request was cancelled.", 0);
      }
      throw new ApiError("web.network", "Cannot reach the state service.", 0);
    }
    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(data);
      if (parsed.success) {
        throw new ApiError(
          parsed.data.code,
          parsed.data.message,
          res.status,
          parsed.data.details ?? {},
        );
      }
      throw new ApiError("web.http_error", `The state service answered ${res.status}.`, res.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiError(
        "web.invalid_response",
        "The state service answered with something this page cannot read.",
        res.status,
        { path },
      );
    }
    return parsed.data;
  }

  return {
    baseUrl,
    session,
    hasScope: (scope) => session.scopes.includes(scope),
    health: () => request(HealthView, "GET", "/health"),
    me: () => request(MeView, "GET", "/me"),
    projects: async () => (await request(ProjectList, "GET", "/projects")).projects,
    inbox: () => request(InboxView, "GET", `/inbox${query({ humanId: session.humanId })}`),
    answerRequest: (id, input) =>
      request(HumanRequestView, "POST", `/requests/${encodeURIComponent(id)}/answer`, {
        version: input.version,
        answer: input.answer,
        ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      }),
    markRead: (messageId) =>
      request(MessageView, "POST", `/messages/${encodeURIComponent(messageId)}/receipt`, {
        state: "read",
      }),
    confirmChallenge: (requestId) =>
      request(ConfirmChallengeView, "POST", "/confirm/challenge", { requestId }),
    devices: async () =>
      (await request(DeviceList, "GET", `/devices${query({ humanId: session.humanId })}`)).devices,
    sessions: async (statuses) =>
      (await request(SessionList, "GET", `/sessions${query({ status: statuses?.join(",") })}`))
        .sessions,
    remoteCommands: async (limit = 20) =>
      (await request(RemoteCommandList, "GET", `/remote/commands${query({ limit })}`)).commands,
    remoteCommand: (id) =>
      request(RemoteCommandView, "GET", `/remote/commands/${encodeURIComponent(id)}`),
    sendRemoteCommand: (input) =>
      request(RemoteCommandView, "POST", "/remote/commands", {
        target: input.target,
        command: input.command,
        params: input.params ?? {},
        ...(input.targetDeviceId ? { targetDeviceId: input.targetDeviceId } : {}),
      }),
    stream: (path, options = {}) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${session.token}`,
        accept: "text/event-stream",
      };
      if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
      return fetchImpl(joinUrl(baseUrl, path), {
        method: "GET",
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  };
}

/** Plain words for a failure. Never includes a token (no code path puts one in a message). */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "version_conflict":
        return "This changed on another device. Reload to see the latest.";
      case "unauthorized":
        return "Your link has expired or was revoked. Ask for a new link.";
      case "bad_signature":
        return "This page could not prove it is the paired device. Reload and try again.";
      case "forbidden":
        return "This link does not allow that.";
      case "biometric_required":
        return "This answer needs a confirmation this page cannot give. Confirm it from your phone or the desktop app.";
      case "confirmation_invalid":
        return "The code was wrong or has expired. Ask for a new one.";
      case "rate_limited":
        return "Too many requests. Wait a moment and try again.";
      case "not_found":
        return "That no longer exists on the state service.";
      case "validation":
        return `The state service refused the request: ${err.message}`;
      case "web.network":
        return "Cannot reach the state service. Check your connection.";
      case "web.invalid_response":
        return "The state service answered with something this page cannot read.";
      case "web.aborted":
        return "Cancelled.";
      default:
        return err.message || `The state service answered ${err.status}.`;
    }
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
