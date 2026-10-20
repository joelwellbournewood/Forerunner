import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  ChangeEvent,
  DeviceView,
  HumanRequestView,
  MessageView,
  ProjectCard,
  RemoteCommandView,
  SessionView,
} from "../src/api/types.ts";
import { browserClock, type Clock } from "../src/lib/clock.ts";

/**
 * An in-process stand-in for the state service (services/state-api) on `node:http`, bound
 * to 127.0.0.1: pairing with a one-time code, hashed scoped session tokens, Ed25519 request
 * signatures with the five-minute window and the replay guard, scope checks, version
 * conflicts, the high-risk rule, the `/confirm/challenge` stand-in, remote commands with a
 * scripted PC, and `GET /events` as SSE. It records every call so tests can assert what
 * went over the wire (and what never did: the token in a URL, the code in a query string).
 * Hono is not among this app's declared dependencies, hence the plain http server.
 */
export interface CallRecord {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeOptions {
  clock?: Clock;
  humanId?: string;
  humanName?: string;
  /** A desktop device seen just now (default true). */
  pcOnline?: boolean;
  /** Serve `POST /confirm/challenge` (default true); false answers 404 like the real service today. */
  supportsConfirm?: boolean;
  /** Accept `command: "chat"` (default true); false answers 400 like the real service today. */
  supportsChat?: boolean;
  /** The scripted PC answers chat commands with this; null leaves them pending. */
  autoReply?: ((text: string, projectId: string) => string) | null;
  /** Refuse `POST /remote/commands` for this target with 503 (a runner the service cannot reach). */
  rejectCommandsFor?: "pc" | "cloud" | null;
  /** Delay before the scripted PC picks a command up. */
  pickupDelayMs?: number;
  tokenTtlMs?: number;
  signatureWindowMs?: number;
}

interface TokenRecord {
  deviceId: string;
  humanId: string;
  scopes: string[];
  expiresAt: string;
}

interface Pairing {
  humanId: string;
  kind: string;
  scopes: string[];
  expiresAt: string;
  name: string | undefined;
}

interface Challenge {
  id: string;
  requestId: string;
  code: string;
  expiresAt: string;
  used: boolean;
}

export interface FakeState {
  human: { id: string; name: string };
  projects: ProjectCard[];
  requests: HumanRequestView[];
  messages: MessageView[];
  devices: DeviceView[];
  sessions: SessionView[];
  commands: RemoteCommandView[];
  tokens: Map<string, TokenRecord>;
  pairings: Map<string, Pairing>;
  challenges: Map<string, Challenge>;
  lastCode: string | null;
  calls: CallRecord[];
  seenSignatures: Set<string>;
}

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const WEB_SCOPES = ["read", "write:inbox", "write:queue", "write:approvals"];
const REMOTE_COMMANDS = new Set(["start", "pause", "stop", "kill"]);

function newCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  return out;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function verifyEd25519(publicKeyB64: string, signatureB64: string, message: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyB64, "base64")]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function money(usdMicro: number) {
  return { usdMicro, chfMicro: Math.round(usdMicro * 0.8) };
}

/** Fixtures: two projects, five open requests, two messages, one desktop device. */
export function fixtures(human: { id: string; name: string }, now: number, pcOnline: boolean) {
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const projects: ProjectCard[] = [
    {
      id: "proj-1",
      name: "PharmaWatch",
      goal: "Track trials",
      stage: "build",
      status: "active",
      autonomyLevel: 2,
      nextMilestone: { id: "ms-1", name: "Alpha", targetDate: null },
      health: "blocked",
      spend: money(1_000_000),
      budget: money(10_000_000),
      waitingOnYou: 3,
      latestCriticGrade: 82,
      lastSessionAt: iso(-3600_000),
      active: true,
    },
    {
      id: "proj-2",
      name: "Space game",
      goal: "Ship a demo",
      stage: "plan",
      status: "active",
      autonomyLevel: 2,
      nextMilestone: null,
      health: "good",
      spend: money(0),
      budget: money(5_000_000),
      waitingOnYou: 2,
      latestCriticGrade: null,
      lastSessionAt: null,
      active: true,
    },
  ];
  const base = {
    taskId: null,
    sessionId: null,
    changeCard: null,
    status: "open",
    answer: null,
    version: 1,
  };
  const requests: HumanRequestView[] = [
    {
      ...base,
      id: "req-approval",
      projectId: "proj-2",
      projectName: "Space game",
      kind: "approval",
      why: "The demo needs a public repository.",
      steps: ["Create the repository", "Push the demo"],
      options: ["Approve", "Reject"],
      blocking: false,
      risk: "low",
      createdAt: iso(-60_000),
    },
    {
      ...base,
      id: "req-blocking",
      projectId: "proj-1",
      projectName: "PharmaWatch",
      kind: "decision",
      why: "The schema depends on it and nothing can be built before.",
      steps: ["Read the plan summary", "Pick a store"],
      options: ["Postgres", "SQLite"],
      blocking: true,
      risk: "low",
      createdAt: iso(-600_000),
    },
    {
      ...base,
      id: "req-high",
      projectId: "proj-1",
      projectName: "PharmaWatch",
      kind: "approval",
      why: "The month's work will not fit under the current ceiling.",
      steps: [],
      options: ["Yes, raise it", "No"],
      blocking: false,
      risk: "high",
      changeCard: { risk: "high", summary: "Raise the monthly hard ceiling to CHF 300" },
      createdAt: iso(-120_000),
    },
    {
      ...base,
      id: "req-free",
      projectId: "proj-2",
      projectName: "Space game",
      kind: "info",
      why: "Release notes name the launch time zone.",
      steps: [],
      options: [],
      blocking: false,
      risk: "low",
      createdAt: iso(-180_000),
    },
    {
      ...base,
      id: "req-cred",
      projectId: "proj-2",
      projectName: "Space game",
      kind: "credential",
      why: "Deploying the demo needs a Cloudflare token.",
      steps: ["Create a token scoped to the demo zone"],
      options: [],
      blocking: false,
      risk: "medium",
      createdAt: iso(-240_000),
    },
  ];
  const messages: MessageView[] = [
    {
      id: "msg-1",
      fromAgentId: "agent-pm",
      fromAgentName: "Alice's PM",
      toAgentId: null,
      toHumanId: human.id,
      projectId: "proj-1",
      taskId: null,
      type: "info",
      body: "Session 12 finished: three tasks done, one in review.",
      requiresAck: false,
      deliveredAt: iso(-30_000),
      readAt: null,
      actedAt: null,
      createdAt: iso(-30_000),
    },
    {
      id: "msg-2",
      fromAgentId: "agent-bob",
      fromAgentName: "Bob's PM",
      toAgentId: "agent-pm",
      toHumanId: null,
      projectId: "proj-1",
      taskId: null,
      type: "handoff",
      body: "Handing the ingest task over; the branch is pushed.",
      requiresAck: true,
      deliveredAt: null,
      readAt: null,
      actedAt: null,
      createdAt: iso(-90_000),
    },
  ];
  const devices: DeviceView[] = [
    {
      id: "dev-pc",
      ownerHumanId: human.id,
      name: "Alice's PC",
      platform: "linux",
      kind: "desktop",
      publicKey: "",
      lastSeen: pcOnline ? iso(-5000) : iso(-3 * 3600_000),
      revoked: false,
      revokedAt: null,
      pairedAt: iso(-86_400_000),
      version: 1,
    },
  ];
  return { projects, requests, messages, devices };
}

export interface FakeStateService {
  url: string;
  port: number;
  state: FakeState;
  clock: Clock;
  options: Required<Pick<FakeOptions, "supportsConfirm" | "supportsChat" | "pcOnline">> & {
    autoReply: ((text: string, projectId: string) => string) | null;
    rejectCommandsFor: "pc" | "cloud" | null;
  };
  /** Issue a one-time code the way the desktop would (`POST /pairing/start`). */
  startPairing(opts?: { scopes?: string[]; kind?: "web" | "phone"; ttlMs?: number }): string;
  /** The link the human receives: the page URL with the code in the fragment. */
  issueLink(pageUrl: string, opts?: { scopes?: string[]; ttlMs?: number }): string;
  emit(event: Omit<ChangeEvent, "seq" | "at" | "origin">): ChangeEvent;
  /** End every open `/events` stream (a proxy or network drop); the service stays up. */
  dropStreams(): void;
  pickUp(commandId: string): void;
  completeCommand(commandId: string, result: unknown): void;
  failCommand(commandId: string, result: unknown): void;
  calls(path?: string): CallRecord[];
  close(): Promise<void>;
}

export async function startFakeStateService(opts: FakeOptions = {}): Promise<FakeStateService> {
  const clock = opts.clock ?? browserClock;
  const human = { id: opts.humanId ?? "h1", name: opts.humanName ?? "Alice" };
  const pcOnline = opts.pcOnline ?? true;
  const fx = fixtures(human, clock.now(), pcOnline);
  const options = {
    supportsConfirm: opts.supportsConfirm ?? true,
    supportsChat: opts.supportsChat ?? true,
    pcOnline,
    autoReply: opts.autoReply === undefined ? (text: string) => `Echo: ${text}` : opts.autoReply,
    rejectCommandsFor: opts.rejectCommandsFor ?? null,
  };
  const pickupDelayMs = opts.pickupDelayMs ?? 20;
  const tokenTtlMs = opts.tokenTtlMs ?? 30 * 24 * 3600_000;
  const signatureWindowMs = opts.signatureWindowMs ?? 5 * 60_000;
  const state: FakeState = {
    human,
    ...fx,
    sessions: [],
    commands: [],
    tokens: new Map(),
    pairings: new Map(),
    challenges: new Map(),
    lastCode: null,
    calls: [],
    seenSignatures: new Set(),
  };
  let seq = 0;
  let counter = 0;
  const buffer: ChangeEvent[] = [];
  const subscribers = new Set<ServerResponse>();
  const iso = () => new Date(clock.now()).toISOString();

  const emit = (input: Omit<ChangeEvent, "seq" | "at" | "origin">): ChangeEvent => {
    seq += 1;
    const event: ChangeEvent = { ...input, seq, at: iso(), origin: "fake" };
    buffer.push(event);
    if (buffer.length > 200) buffer.shift();
    for (const res of subscribers) {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    return event;
  };

  const updateCommand = (id: string, patch: Partial<RemoteCommandView>) => {
    const c = state.commands.find((x) => x.id === id);
    if (!c) throw new Error(`no command ${id}`);
    Object.assign(c, patch, { updatedAt: iso(), version: c.version + 1 });
    emit({
      type: "remote_command.changed",
      humanId: human.id,
      projectId: null,
      sessionId: null,
      payload: { id: c.id, version: c.version, status: c.status, command: c.command },
    });
  };

  const pickUp = (id: string) => updateCommand(id, { status: "picked_up", pickedUpAt: iso() });
  const completeCommand = (id: string, result: unknown) =>
    updateCommand(id, { status: "done", result });
  const failCommand = (id: string, result: unknown) =>
    updateCommand(id, { status: "failed", result });

  const scriptedPc = (c: RemoteCommandView) => {
    if (!options.pcOnline || c.target !== "pc") return;
    setTimeout(() => {
      if (!state.commands.some((x) => x.id === c.id && x.status === "pending")) return;
      pickUp(c.id);
      if (c.command === "chat") {
        if (!options.autoReply) return;
        const text = typeof c.params.text === "string" ? c.params.text : "";
        const projectId = typeof c.params.projectId === "string" ? c.params.projectId : "";
        setTimeout(() => completeCommand(c.id, { reply: options.autoReply?.(text, projectId) }), 5);
      } else if (c.command === "kill") {
        setTimeout(() => completeCommand(c.id, { stopped: 2 }), 5);
      }
    }, pickupDelayMs);
  };

  function startPairing(o: { scopes?: string[]; kind?: "web" | "phone"; ttlMs?: number } = {}) {
    const code = newCode();
    state.pairings.set(code, {
      humanId: human.id,
      kind: o.kind ?? "web",
      scopes: o.scopes ?? WEB_SCOPES,
      expiresAt: new Date(clock.now() + (o.ttlMs ?? 600_000)).toISOString(),
      name: undefined,
    });
    return code;
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  type Principal = { deviceId: string; humanId: string; scopes: string[]; device: DeviceView };

  function authenticate(req: IncomingMessage, url: URL, bodyText: string): Principal {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m?.[1]) throw new FakeApiError(401, "unauthorized", "missing bearer token");
    const record = state.tokens.get(m[1]);
    if (!record || record.expiresAt <= iso()) {
      throw new FakeApiError(401, "unauthorized", "invalid or expired session token");
    }
    const device = state.devices.find((d) => d.id === record.deviceId);
    if (!device || device.revoked) throw new FakeApiError(401, "unauthorized", "device revoked");
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const signature = req.headers["x-device-signature"];
      const timestamp = req.headers["x-device-timestamp"];
      if (typeof signature !== "string" || !signature) {
        throw new FakeApiError(401, "bad_signature", "mutations need X-Device-Signature");
      }
      if (typeof timestamp !== "string" || !/^\d{10,16}$/.test(timestamp)) {
        throw new FakeApiError(401, "bad_signature", "X-Device-Timestamp missing");
      }
      if (Math.abs(clock.now() - Number(timestamp)) > signatureWindowMs) {
        throw new FakeApiError(401, "bad_signature", "X-Device-Timestamp outside the window");
      }
      const biometricHeader = req.headers["x-biometric-assertion"];
      const biometric = biometricHeader === "1" || biometricHeader === "true";
      const canonical = [
        method,
        `${url.pathname}${url.search}`,
        sha256Hex(bodyText),
        timestamp,
        biometric ? "biometric=1" : "biometric=0",
      ].join("\n");
      if (!verifyEd25519(device.publicKey, signature, canonical)) {
        throw new FakeApiError(401, "bad_signature", "device signature does not verify");
      }
      if (state.seenSignatures.has(signature)) {
        throw new FakeApiError(401, "bad_signature", "signed request replayed");
      }
      state.seenSignatures.add(signature);
    }
    return { deviceId: device.id, humanId: record.humanId, scopes: record.scopes, device };
  }

  const requireScope = (p: Principal, scope: string) => {
    if (!p.scopes.includes(scope))
      throw new FakeApiError(403, "forbidden", `scope ${scope} required`, { scope });
  };

  function parseJson(text: string): Record<string, unknown> {
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new FakeApiError(400, "validation", "body must be a JSON object");
  }

  function requestView(r: HumanRequestView): HumanRequestView {
    return { ...r };
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    bodyText: string,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    // Test-only controls and public routes.
    if (path === "/__test/emit" && method === "POST") {
      const body = parseJson(bodyText) as unknown as Omit<ChangeEvent, "seq" | "at" | "origin">;
      return json(res, 200, emit(body));
    }
    if (path === "/health" && method === "GET") {
      return json(res, 200, {
        ok: true,
        service: "state-api",
        version: "fake",
        time: iso(),
        schema: { code: 1, applied: 1, state: "current" },
      });
    }
    if (path === "/pairing/complete" && method === "POST") {
      const body = parseJson(bodyText);
      const code = String(body.code ?? "")
        .trim()
        .toUpperCase();
      const pairing = state.pairings.get(code);
      if (!pairing || pairing.expiresAt <= iso()) {
        throw new FakeApiError(400, "pairing_invalid", "unknown or expired pairing code");
      }
      const publicKey = String(body.publicKey ?? "");
      if (Buffer.from(publicKey, "base64").length !== 32) {
        throw new FakeApiError(400, "pairing_invalid", "publicKey must be 32 bytes");
      }
      if (!verifyEd25519(publicKey, String(body.proof ?? ""), `pair:${code}`)) {
        throw new FakeApiError(400, "pairing_invalid", "proof does not verify");
      }
      state.pairings.delete(code);
      if (state.devices.some((d) => d.publicKey === publicKey)) {
        throw new FakeApiError(409, "pairing_invalid", "this public key is already paired");
      }
      counter += 1;
      const device: DeviceView = {
        id: `dev-web-${counter}`,
        ownerHumanId: pairing.humanId,
        name: String(body.name ?? pairing.name ?? `${pairing.kind} device`).slice(0, 120),
        platform: String(body.platform ?? "web").slice(0, 40),
        kind: pairing.kind,
        publicKey,
        lastSeen: null,
        revoked: false,
        revokedAt: null,
        pairedAt: iso(),
        version: 1,
      };
      state.devices.push(device);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(clock.now() + tokenTtlMs).toISOString();
      state.tokens.set(token, {
        deviceId: device.id,
        humanId: pairing.humanId,
        scopes: [...pairing.scopes],
        expiresAt,
      });
      return json(res, 201, {
        deviceId: device.id,
        humanId: pairing.humanId,
        kind: pairing.kind,
        token,
        expiresAt,
        scopes: pairing.scopes,
        schemaVersion: 1,
      });
    }

    const p = authenticate(req, url, bodyText);

    if (path === "/me" && method === "GET") {
      const record = [...state.tokens.values()].find((t) => t.deviceId === p.deviceId);
      return json(res, 200, {
        principal: "device",
        deviceId: p.deviceId,
        humanId: p.humanId,
        humanName: human.name,
        kind: p.device.kind,
        scopes: p.scopes,
        expiresAt: record?.expiresAt ?? iso(),
        signed: false,
        schemaVersion: 1,
      });
    }
    if (path === "/projects" && method === "GET") {
      requireScope(p, "read");
      return json(res, 200, { projects: state.projects.filter((x) => x.active) });
    }
    if (path === "/inbox" && method === "GET") {
      requireScope(p, "read");
      const humanId = url.searchParams.get("humanId") ?? p.humanId;
      if (humanId !== p.humanId) throw new FakeApiError(403, "forbidden", "not your human");
      const requests = state.requests.filter((r) => r.status === "open").map(requestView);
      return json(res, 200, {
        messages: state.messages,
        requests,
        blockingCount: requests.filter((r) => r.blocking).length,
      });
    }
    const answer = /^\/requests\/([^/]+)\/answer$/.exec(path);
    if (answer && method === "POST") {
      requireScope(p, "write:approvals");
      const id = decodeURIComponent(answer[1] ?? "");
      const r = state.requests.find((x) => x.id === id);
      if (r?.status !== "open") throw new FakeApiError(404, "not_found", `request ${id}`);
      const body = parseJson(bodyText);
      if (typeof body.version !== "number") throw new FakeApiError(400, "validation", "version");
      if (body.version !== r.version) {
        throw new FakeApiError(409, "version_conflict", "stale version", {
          current: r.version,
        });
      }
      const cardRisk =
        r.changeCard && typeof r.changeCard === "object"
          ? (r.changeCard as { risk?: unknown }).risk
          : null;
      if (r.risk === "high" || cardRisk === "high") {
        const confirmation = body.confirmation as
          | { challengeId?: unknown; code?: unknown }
          | undefined;
        if (!confirmation || !options.supportsConfirm) {
          throw new FakeApiError(
            403,
            "biometric_required",
            "high-risk confirmation needs the biometric assertion flag",
          );
        }
        const ch = state.challenges.get(String(confirmation.challengeId ?? ""));
        if (
          !ch ||
          ch.used ||
          ch.requestId !== r.id ||
          ch.expiresAt <= iso() ||
          String(confirmation.code ?? "").toUpperCase() !== ch.code
        ) {
          throw new FakeApiError(403, "confirmation_invalid", "code wrong, used or expired");
        }
        ch.used = true;
      }
      r.status = "answered";
      r.answer = body.answer ?? null;
      r.version += 1;
      emit({
        type: "human_request.changed",
        humanId: p.humanId,
        projectId: r.projectId,
        sessionId: null,
        payload: { id: r.id, version: r.version, status: r.status, blocking: r.blocking },
      });
      return json(res, 200, requestView(r));
    }
    const receipt = /^\/messages\/([^/]+)\/receipt$/.exec(path);
    if (receipt && method === "POST") {
      requireScope(p, "write:inbox");
      const id = decodeURIComponent(receipt[1] ?? "");
      const m = state.messages.find((x) => x.id === id);
      if (!m) throw new FakeApiError(404, "not_found", `message ${id}`);
      const body = parseJson(bodyText);
      if (body.state === "read" && !m.readAt) m.readAt = iso();
      if (body.state === "delivered" && !m.deliveredAt) m.deliveredAt = iso();
      if (body.state === "acted" && !m.actedAt) m.actedAt = iso();
      emit({
        type: "message.changed",
        humanId: p.humanId,
        projectId: m.projectId,
        sessionId: null,
        payload: { id: m.id, receipt: body.state },
      });
      return json(res, 200, m);
    }
    if (path === "/confirm/challenge" && method === "POST") {
      if (!options.supportsConfirm) {
        throw new FakeApiError(404, "not_found", "no route POST /confirm/challenge");
      }
      requireScope(p, "write:approvals");
      const body = parseJson(bodyText);
      const r = state.requests.find((x) => x.id === body.requestId);
      if (!r) throw new FakeApiError(404, "not_found", "request not found");
      counter += 1;
      const ch: Challenge = {
        id: `ch-${counter}`,
        requestId: r.id,
        code: newCode(),
        expiresAt: new Date(clock.now() + 600_000).toISOString(),
        used: false,
      };
      state.challenges.set(ch.id, ch);
      state.lastCode = ch.code;
      return json(res, 201, { challengeId: ch.id, expiresAt: ch.expiresAt, channel: "your phone" });
    }
    if (path === "/devices" && method === "GET") {
      requireScope(p, "read");
      return json(res, 200, {
        devices: state.devices.filter((d) => d.ownerHumanId === p.humanId),
      });
    }
    if (path === "/sessions" && method === "GET") {
      requireScope(p, "read");
      const statuses = url.searchParams.get("status")?.split(",") ?? null;
      return json(res, 200, {
        sessions: state.sessions.filter((s) => !statuses || statuses.includes(s.status)),
      });
    }
    if (path === "/remote/commands" && method === "GET") {
      requireScope(p, "read");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const mine = new Set(
        state.devices.filter((d) => d.ownerHumanId === p.humanId).map((d) => d.id),
      );
      const commands = state.commands
        .filter((c) => mine.has(c.deviceId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return json(res, 200, { commands });
    }
    if (path === "/remote/commands" && method === "POST") {
      requireScope(p, "write:remote");
      const body = parseJson(bodyText);
      const target = String(body.target ?? "");
      const command = String(body.command ?? "");
      if (target !== "pc" && target !== "cloud") {
        throw new FakeApiError(400, "validation", "target must be pc or cloud");
      }
      if (!REMOTE_COMMANDS.has(command) && !(options.supportsChat && command === "chat")) {
        throw new FakeApiError(400, "validation", "invalid enum value for command");
      }
      if (options.rejectCommandsFor === target) {
        throw new FakeApiError(503, "unavailable", `the ${target} runner cannot be reached`);
      }
      counter += 1;
      const c: RemoteCommandView = {
        id: `cmd-${counter}`,
        deviceId: p.deviceId,
        target,
        targetDeviceId: typeof body.targetDeviceId === "string" ? body.targetDeviceId : null,
        command,
        params:
          body.params && typeof body.params === "object"
            ? (body.params as Record<string, unknown>)
            : {},
        status: "pending",
        pickedUpAt: null,
        result: null,
        createdAt: iso(),
        updatedAt: iso(),
        version: 1,
      };
      state.commands.push(c);
      emit({
        type: "remote_command.changed",
        humanId: p.humanId,
        projectId: null,
        sessionId: null,
        payload: { id: c.id, version: c.version, status: c.status, command: c.command },
      });
      scriptedPc(c);
      return json(res, 201, c);
    }
    const one = /^\/remote\/commands\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      requireScope(p, "read");
      const id = decodeURIComponent(one[1] ?? "");
      const c = state.commands.find((x) => x.id === id);
      if (!c) throw new FakeApiError(404, "not_found", `command ${id}`);
      return json(res, 200, c);
    }
    if (path === "/events" && method === "GET") {
      requireScope(p, "read");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ seq, at: iso(), instance: "fake" })}\n\n`);
      const last = req.headers["last-event-id"];
      if (typeof last === "string" && /^\d+$/.test(last)) {
        const from = Number(last);
        const oldest = buffer[0]?.seq ?? seq + 1;
        if (from + 1 < oldest && seq > from) {
          res.write(`event: resync\ndata: ${JSON.stringify({ reason: "too old" })}\n\n`);
        } else {
          for (const e of buffer) {
            if (e.seq > from)
              res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          }
        }
      }
      subscribers.add(res);
      // `res` closes when the client goes away; `req` "close" fires once the request is read.
      res.on("close", () => {
        subscribers.delete(res);
      });
      return;
    }
    throw new FakeApiError(404, "not_found", `no route ${method} ${path}`);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown = null;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      state.calls.push({
        method: (req.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.search,
        headers,
        body: parsedBody,
      });
      route(req, res, url, bodyText).catch((err: unknown) => {
        if (err instanceof FakeApiError) {
          json(res, err.status, { code: err.code, message: err.message, details: err.details });
        } else {
          json(res, 500, { code: "internal", message: "fake service failed", details: {} });
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    state,
    clock,
    options,
    startPairing,
    issueLink: (pageUrl, o = {}) => `${pageUrl}#code=${startPairing(o)}`,
    emit,
    dropStreams: () => {
      for (const res of subscribers) res.end();
      subscribers.clear();
    },
    pickUp,
    completeCommand,
    failCommand,
    calls: (path) => (path ? state.calls.filter((c) => c.path === path) : [...state.calls]),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of subscribers) res.end();
        subscribers.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
