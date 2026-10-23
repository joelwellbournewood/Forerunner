import {
  type EventView,
  EventView as EventViewSchema,
  type HumanRequestView,
  HumanRequestView as HumanRequestViewSchema,
  type InboxView,
  InboxView as InboxViewSchema,
  type MessageView,
  MessageView as MessageViewSchema,
  type ProjectCard,
  ProjectCard as ProjectCardSchema,
  type SessionView,
  SessionView as SessionViewSchema,
} from "@forerunner/runtime/daemon/api-types";
import { z } from "zod";
import {
  type BiometricAssertion,
  BiometricTicketError,
  canonicalRequest,
  type DeviceSigner,
  HEADER_BIOMETRIC,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  pairingProofMessage,
} from "./state-signing.ts";

/**
 * The phone's client for the shared state service (`services/state-api`, ADR 0009, ADR 0024,
 * ADR 0026). The phone never talks to a PC's daemon: it pairs here, reads its inbox and
 * projects, answers requests, and enqueues remote commands that the PC runtime picks up.
 * Every mutation is signed by the device key (`DeviceSigner`); the biometric flag enters the
 * signed string only through a `BiometricAssertion` a `BiometricPort` produced. Responses are
 * validated with the daemon view schemas the service reuses (ADR 0011) or the view schemas
 * below. The session token and the key never appear in errors or logs.
 */
export type { EventView, HumanRequestView, InboxView, MessageView, ProjectCard, SessionView };

export const StateHealthView = z.looseObject({
  version: z.string(),
  schema: z
    .looseObject({
      code: z.number().int(),
      applied: z.number().int().nullable().optional(),
      state: z.string().optional(),
    })
    .optional(),
  time: z.string().optional(),
});
export type StateHealthView = z.infer<typeof StateHealthView>;

export const PairingResultView = z.object({
  deviceId: z.string(),
  humanId: z.string(),
  kind: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  scopes: z.array(z.string()),
  schemaVersion: z.number().int(),
});
export type PairingResultView = z.infer<typeof PairingResultView>;

export const MeView = z.looseObject({
  principal: z.string(),
  deviceId: z.string().nullable(),
  humanId: z.string().nullable(),
  humanName: z.string().nullable().optional(),
  kind: z.string().optional(),
  scopes: z.array(z.string()),
  expiresAt: z.string().optional(),
  signed: z.boolean().optional(),
  schemaVersion: z.number().int().optional(),
  /** The human's monthly hard cap (`humans.monthly_cap_usd_micro`), once the service sends it. */
  monthlyCap: z
    .object({ usdMicro: z.number().int(), chfMicro: z.number().int() })
    .nullable()
    .optional(),
});
export type MeView = z.infer<typeof MeView>;

export const RemoteCommandView = z.object({
  id: z.string(),
  deviceId: z.string(),
  target: z.string(),
  targetDeviceId: z.string().nullable(),
  command: z.string(),
  params: z.record(z.string(), z.unknown()),
  status: z.string(),
  pickedUpAt: z.string().nullable(),
  result: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type RemoteCommandView = z.infer<typeof RemoteCommandView>;

export const DeviceView = z.object({
  id: z.string(),
  ownerHumanId: z.string(),
  name: z.string(),
  platform: z.string(),
  kind: z.string(),
  publicKey: z.string(),
  lastSeen: z.string().nullable(),
  revoked: z.boolean(),
  revokedAt: z.string().nullable(),
  pairedAt: z.string(),
  version: z.number().int(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const QueueItemView = z.object({
  id: z.string(),
  projectId: z.string(),
  humanId: z.string(),
  kind: z.string(),
  text: z.string(),
  priority: z.number().int(),
  status: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type QueueItemView = z.infer<typeof QueueItemView>;

export const OutboxResultView = z.object({
  clientId: z.string(),
  status: z.enum(["applied", "duplicate", "rejected"]),
  code: z.string().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
});
export type OutboxResultView = z.infer<typeof OutboxResultView>;

const ProjectList = z.object({ projects: z.array(ProjectCardSchema) });
const RequestsView = z.object({
  requests: z.array(HumanRequestViewSchema),
  blockingCount: z.number().int(),
});
const RemoteCommandList = z.object({ commands: z.array(RemoteCommandView) });
const DeviceList = z.object({ devices: z.array(DeviceView) });
const SessionList = z.object({ sessions: z.array(SessionViewSchema) });
const EventPage = z.object({ events: z.array(EventViewSchema) });
const OutboxBatchView = z.object({ results: z.array(OutboxResultView) });
const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The service's remote verbs (`REMOTE_COMMANDS` in `routes/remote.ts`). */
export const REMOTE_VERBS = ["start", "pause", "stop", "kill"] as const;
export type RemoteVerb = (typeof REMOTE_VERBS)[number];

/** One registry command of a plan (module Q), as `packages/commands` names them. */
export interface PlanCommand {
  name: string;
  params: Record<string, unknown>;
}

/**
 * What the phone puts in `params` of a remote command (ADR 0032). `plan` carries module-Q
 * commands for the PC's executor, `chat` a quick-chat turn for the principal agent. The
 * verb (`verbForPlan`) names what the PC does first; session verbs are also inside the plan.
 */
export interface RemotePlanEnvelope {
  v: 1;
  kind: "plan";
  plan: PlanCommand[];
  wordsUsed: string;
  card: Record<string, unknown>;
  clientId: string;
  confirmedAt: string;
  /** Set when this plan undoes an earlier one (its clientId). */
  undoOf?: string;
}

export interface RemoteChatEnvelope {
  v: 1;
  kind: "chat";
  text: string;
  projectId: string | null;
  clientId: string;
}

export type RemoteEnvelope = RemotePlanEnvelope | RemoteChatEnvelope;

/** `kill` for the kill switch, `stop` / `pause` for pure session control, else `start` (run the plan). */
export function verbForPlan(plan: readonly PlanCommand[]): RemoteVerb {
  const names = plan.map((c) => c.name);
  if (names.length > 0 && names.every((n) => n === "session.stop")) {
    const all = plan.every((c) => c.params.scope === "all");
    return all ? "kill" : "stop";
  }
  if (names.length > 0 && names.every((n) => n === "session.pause")) return "pause";
  return "start";
}

export interface StateServiceConfig {
  /** Absolute base URL of the state service without a trailing slash. */
  baseUrl: string;
  /** The session token from pairing; null before pairing. */
  token: string | null;
}

export class StateApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StateApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
  /** 429: seconds to wait, when the service said. */
  get retryAfterSec(): number | null {
    const v = this.details.retryAfterSec;
    return typeof v === "number" ? v : null;
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
  headers?: Record<string, string>;
  /** Present only when a biometric prompt succeeded for this very request. */
  biometric?: BiometricAssertion | null;
  /** Public routes (pairing) send no bearer token. */
  anonymous?: boolean;
}

export interface OutboxActionInput {
  clientId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StateClient {
  readonly config: StateServiceConfig;
  readonly signer: DeviceSigner;
  /** The same client with another token (after pairing). */
  withToken(token: string | null): StateClient;
  url(path: string, query?: Query): string;
  raw(options: RawRequestOptions): Promise<Response>;

  health(signal?: AbortSignal): Promise<StateHealthView>;
  /** Public: the phone's key signs `pair:<code>`; the service answers with a scoped token. */
  completePairing(input: {
    code: string;
    name: string;
    platform: string;
    pushToken?: string;
  }): Promise<PairingResultView>;
  me(signal?: AbortSignal): Promise<MeView>;
  projects(signal?: AbortSignal): Promise<ProjectCard[]>;
  project(id: string, signal?: AbortSignal): Promise<ProjectCard>;
  inbox(humanId: string, signal?: AbortSignal): Promise<InboxView>;
  requests(signal?: AbortSignal): Promise<{ requests: HumanRequestView[]; blockingCount: number }>;
  request(id: string, signal?: AbortSignal): Promise<HumanRequestView>;
  /** High-risk requests need `biometric` (the service refuses otherwise: `biometric_required`). */
  answerRequest(
    id: string,
    body: { version: number; answer: unknown },
    opts?: { biometric?: BiometricAssertion | null },
  ): Promise<HumanRequestView>;
  receipt(messageId: string, state: "delivered" | "read" | "acted"): Promise<MessageView>;
  sendMessage(body: {
    fromAgentId: string;
    toAgentId?: string;
    toHumanId?: string;
    projectId?: string;
    taskId?: string;
    type?: string;
    body: string;
    requiresAck?: boolean;
    replyTo?: string;
  }): Promise<MessageView>;
  enqueueQueueItem(
    projectId: string,
    body: { kind: string; text: string; priority?: number },
  ): Promise<QueueItemView>;
  sendRemote(
    body: {
      target: "pc" | "cloud";
      targetDeviceId?: string;
      command: RemoteVerb;
      params: RemoteEnvelope | Record<string, unknown>;
    },
    opts?: { biometric?: BiometricAssertion | null },
  ): Promise<RemoteCommandView>;
  remoteCommands(
    filter?: { status?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<RemoteCommandView[]>;
  remoteCommand(id: string, signal?: AbortSignal): Promise<RemoteCommandView>;
  sessions(
    filter?: { agentId?: string; projectId?: string; status?: string },
    signal?: AbortSignal,
  ): Promise<SessionView[]>;
  session(id: string, signal?: AbortSignal): Promise<SessionView>;
  sessionEvents(id: string, afterSeq?: number, signal?: AbortSignal): Promise<EventView[]>;
  devices(signal?: AbortSignal): Promise<DeviceView[]>;
  device(id: string, signal?: AbortSignal): Promise<DeviceView>;
  syncOutbox(actions: OutboxActionInput[]): Promise<OutboxResultView[]>;
}

export interface StateClientOptions {
  fetch?: FetchLike;
  /** Milliseconds since the epoch; the signed timestamp. */
  now?: () => number;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createStateClient(
  config: StateServiceConfig,
  signer: DeviceSigner,
  options: StateClientOptions = {},
): StateClient {
  const cfg: StateServiceConfig = { baseUrl: stripSlash(config.baseUrl), token: config.token };
  const now = options.now ?? (() => Date.now());
  // The signed timestamp is strictly increasing per client, so two identical mutations in the
  // same millisecond never share a signature (the service accepts a mutation signature once).
  let lastTimestamp = 0;
  const nextTimestamp = () => {
    lastTimestamp = Math.max(now(), lastTimestamp + 1);
    return String(lastTimestamp);
  };
  const doFetch: FetchLike =
    options.fetch ??
    ((input, init) => {
      if (typeof fetch !== "function") {
        return Promise.reject(new StateApiError("ui.network", "fetch is not available", 0));
      }
      return fetch(input, init);
    });

  function url(path: string, query?: Query): string {
    const u = new URL(path.replace(/^\//, ""), `${cfg.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        u.searchParams.set(key, String(value));
      }
    }
    return u.toString();
  }

  async function raw(opts: RawRequestOptions): Promise<Response> {
    const target = new URL(url(opts.path, opts.query));
    const headers: Record<string, string> = {
      Accept: opts.accept ?? "application/json",
      ...(opts.headers ?? {}),
    };
    if (!opts.anonymous && cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const init: RequestInit = { method: opts.method, headers };
    if (opts.signal) init.signal = opts.signal;
    let bodyText = "";
    if (opts.body !== undefined) {
      bodyText = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
      init.body = bodyText;
    }
    // Mutations carry the device signature (ADR 0009). The flag comes only from an assertion,
    // and the signer signs a biometric=1 string only against that assertion's one-time ticket.
    if (opts.method !== "GET" && !opts.anonymous) {
      const assertion = opts.biometric?.asserted === true ? opts.biometric : null;
      const biometric = assertion !== null;
      const timestamp = nextTimestamp();
      const canonical = await canonicalRequest({
        method: opts.method,
        path: `${target.pathname}${target.search}`,
        body: bodyText,
        timestamp,
        biometric,
      });
      try {
        headers[HEADER_SIGNATURE] = await signer.sign(new TextEncoder().encode(canonical), {
          biometric: assertion,
        });
      } catch (error) {
        if (error instanceof BiometricTicketError) {
          throw new StateApiError("biometric_required", error.message, 403);
        }
        throw error;
      }
      headers[HEADER_TIMESTAMP] = timestamp;
      if (biometric) headers[HEADER_BIOMETRIC] = "1";
    }
    try {
      return await doFetch(target.toString(), init);
    } catch (error) {
      if (isAbort(error)) throw new StateApiError("ui.aborted", "request aborted", 0);
      const message = error instanceof Error ? error.message : String(error);
      throw new StateApiError(
        "ui.network",
        `state service unreachable at ${cfg.baseUrl}: ${message}`,
        0,
      );
    }
  }

  async function errorFromResponse(res: Response): Promise<StateApiError> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    try {
      const parsed = ErrorBody.safeParse(JSON.parse(text));
      if (parsed.success) {
        const details = { ...(parsed.data.details ?? {}) };
        const retry = res.headers.get("retry-after");
        if (retry && /^\d+$/.test(retry)) details.retryAfterSec = Number(retry);
        return new StateApiError(parsed.data.code, parsed.data.message, res.status, details);
      }
    } catch {
      // not JSON
    }
    const message =
      text.trim().length > 0 ? text.slice(0, 200) : res.statusText || "request failed";
    return new StateApiError("ui.http_error", `${res.status}: ${message}`, res.status);
  }

  async function request<T>(opts: RawRequestOptions, schema: z.ZodType<T>): Promise<T> {
    const res = await raw(opts);
    if (!res.ok) throw await errorFromResponse(res);
    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw new StateApiError(
        "ui.invalid_response",
        `state service returned a body that is not JSON for ${opts.method} ${opts.path}: ${
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
      throw new StateApiError(
        "ui.invalid_response",
        `state service response for ${opts.method} ${opts.path} does not match the contract: ${issues}`,
        res.status,
        { issues: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  const get = <T>(path: string, schema: z.ZodType<T>, query?: Query, signal?: AbortSignal) =>
    request({ method: "GET", path, query, signal }, schema);
  const post = <T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    extra: Partial<RawRequestOptions> = {},
  ) => request({ method: "POST", path, body: body ?? {}, ...extra }, schema);

  const client: StateClient = {
    config: cfg,
    signer,
    withToken: (token) => createStateClient({ ...cfg, token }, signer, options),
    url,
    raw,
    health: (signal) =>
      request({ method: "GET", path: "/health", signal, anonymous: true }, StateHealthView),
    completePairing: async (input) => {
      const code = input.code.trim().toUpperCase();
      const publicKey = await signer.publicKey();
      const proof = await signer.sign(pairingProofMessage(code));
      return post(
        "/pairing/complete",
        PairingResultView,
        {
          code,
          publicKey,
          proof,
          name: input.name.slice(0, 120),
          platform: input.platform.slice(0, 40),
          ...(input.pushToken ? { pushToken: input.pushToken } : {}),
        },
        { anonymous: true },
      );
    },
    me: (signal) => get("/me", MeView, undefined, signal),
    projects: async (signal) => (await get("/projects", ProjectList, undefined, signal)).projects,
    project: (id, signal) =>
      get(`/projects/${encodeURIComponent(id)}`, ProjectCardSchema, undefined, signal),
    inbox: (humanId, signal) => get("/inbox", InboxViewSchema, { humanId }, signal),
    requests: (signal) => get("/requests", RequestsView, undefined, signal),
    request: (id, signal) =>
      get(`/requests/${encodeURIComponent(id)}`, HumanRequestViewSchema, undefined, signal),
    answerRequest: (id, body, opts) =>
      post(`/requests/${encodeURIComponent(id)}/answer`, HumanRequestViewSchema, body, {
        biometric: opts?.biometric ?? null,
      }),
    receipt: (messageId, state) =>
      post(`/messages/${encodeURIComponent(messageId)}/receipt`, MessageViewSchema, { state }),
    sendMessage: (body) => post("/messages", MessageViewSchema, body),
    enqueueQueueItem: (projectId, body) =>
      post(`/projects/${encodeURIComponent(projectId)}/queue`, QueueItemView, {
        kind: body.kind,
        text: body.text,
        priority: body.priority ?? 0,
      }),
    sendRemote: (body, opts) =>
      post("/remote/commands", RemoteCommandView, body, { biometric: opts?.biometric ?? null }),
    remoteCommands: async (filter, signal) =>
      (
        await get(
          "/remote/commands",
          RemoteCommandList,
          { status: filter?.status, limit: filter?.limit },
          signal,
        )
      ).commands,
    remoteCommand: (id, signal) =>
      get(`/remote/commands/${encodeURIComponent(id)}`, RemoteCommandView, undefined, signal),
    sessions: async (filter, signal) =>
      (
        await get(
          "/sessions",
          SessionList,
          { agentId: filter?.agentId, projectId: filter?.projectId, status: filter?.status },
          signal,
        )
      ).sessions,
    session: (id, signal) =>
      get(`/sessions/${encodeURIComponent(id)}`, SessionViewSchema, undefined, signal),
    sessionEvents: async (id, afterSeq, signal) =>
      (await get(`/sessions/${encodeURIComponent(id)}/events`, EventPage, { afterSeq }, signal))
        .events,
    devices: async (signal) => (await get("/devices", DeviceList, undefined, signal)).devices,
    device: (id, signal) =>
      get(`/devices/${encodeURIComponent(id)}`, DeviceView, undefined, signal),
    syncOutbox: async (actions) =>
      (await post("/sync/outbox", OutboxBatchView, { actions })).results,
  };
  return client;
}

/** A banner line for an error; never the token, the key or a stack. */
export function describeStateError(error: unknown): string {
  if (error instanceof StateApiError) {
    switch (error.code) {
      case "ui.network":
        return "State service not reachable.";
      case "unauthorized":
        return "This device is no longer paired (token expired or revoked).";
      case "bad_signature":
        return "The service rejected this device's signature; check the phone's clock.";
      case "biometric_required": {
        // The phone's own refusal says why (not enrolled, cancelled, no answer from the prompt).
        const reason = error.details.reason;
        return typeof reason === "string" && reason.trim()
          ? `This answer needs a biometric confirmation (${reason.trim()}).`
          : "This answer needs a biometric confirmation.";
      }
      case "rate_limited":
        return `Too many requests; try again${
          error.retryAfterSec ? ` in ${error.retryAfterSec} s` : " shortly"
        }.`;
      case "pairing_invalid":
        return `Pairing failed: ${error.message}`;
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for very old WebViews: 32 random hex characters.
  const bytes = new Uint8Array(16);
  c?.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
