import { randomBytes } from "node:crypto";
import type {
  EventView,
  HumanRequestView,
  MessageView,
  ProjectCard,
  SessionView,
} from "@forerunner/runtime/daemon/api-types";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
// The real verification, imported from the service's own crypto module so the fake can never
// drift from what the service checks (canonical string, proof message, token hashing). A
// relative path because this wave may not run `pnpm install`; the maintainer doc lists the
// workspace link (`@forerunner/state-api`) as the follow-up.
import {
  hashToken,
  isValidPublicKey,
  newPairingCode,
  newSessionToken,
  verifyPairingProof,
  verifyRequestSignature,
} from "../../../services/state-api/src/auth/crypto.ts";

/**
 * A fake shared state service for the phone screens: the routes the phone uses, the real
 * Ed25519 verification of pairing proofs and request signatures (ADR 0009: canonical string,
 * ±5 minute timestamp window, single-use mutation signatures, `confirm:high` only with the
 * biometric flag inside the signature), scoped tokens, revocation, the change feed over SSE,
 * remote commands with a simulated PC that picks them up and completes them, and test hooks
 * (`/__test/*`, admin token) that record every call. In-process in unit tests (`app.fetch`)
 * and as a child process for Playwright (`startFakeStateService`). Nothing leaves 127.0.0.1.
 */
export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  signed: boolean;
  biometric: boolean;
  principal: "admin" | "device" | "none";
  deviceId: string | null;
}

export interface FakeStateOptions {
  /** Admin bearer token (the desktop runtime's); random when omitted. */
  adminToken?: string;
  heartbeatMs?: number;
  /** The simulated PC: picks a command up after this many ms and completes it after as many again; null = manual. */
  pcAutoCompleteMs?: number | null;
  signatureWindowMs?: number;
  now?: () => number;
}

export interface FakeDevice {
  id: string;
  ownerHumanId: string;
  name: string;
  platform: string;
  kind: string;
  publicKey: string;
  lastSeen: string | null;
  revoked: boolean;
  revokedAt: string | null;
  pairedAt: string;
  version: number;
}

interface FakeToken {
  hash: string;
  deviceId: string;
  humanId: string;
  scopes: string[];
  expiresAt: string;
}

interface PendingPairing {
  code: string;
  humanId: string;
  kind: "phone" | "web";
  scopes: string[];
  expiresAt: string;
}

export interface FakeRemoteCommand {
  id: string;
  deviceId: string;
  target: string;
  targetDeviceId: string | null;
  command: string;
  params: Record<string, unknown>;
  status: "pending" | "picked_up" | "done" | "failed";
  pickedUpAt: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface QueueItem {
  id: string;
  projectId: string;
  humanId: string;
  kind: string;
  text: string;
  priority: number;
  status: string;
  createdAt: string;
  version: number;
}

interface ChangeEvent {
  seq: number;
  type: string;
  at: string;
  humanId: string | null;
  projectId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  origin: string;
}

type Principal =
  | { kind: "admin" }
  | { kind: "device"; device: FakeDevice; scopes: string[]; signed: boolean; biometric: boolean };

type Env = { Variables: { principal: Principal } };
type Ctx = Context<Env>;

export interface FakeStateState {
  humans: { id: string; name: string }[];
  agents: { id: string; name: string; ownerHumanId: string }[];
  projects: ProjectCard[];
  requests: HumanRequestView[];
  messages: MessageView[];
  devices: FakeDevice[];
  tokens: FakeToken[];
  pairings: Map<string, PendingPairing>;
  remoteCommands: FakeRemoteCommand[];
  sessions: SessionView[];
  events: EventView[];
  queue: QueueItem[];
  calls: RecordedCall[];
  /** Access log lines, as a real service would log them: never a token or a key. */
  log: string[];
  seq: number;
  feed: ChangeEvent[];
  listeners: Set<(e: ChangeEvent) => void>;
  replay: Set<string>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

export const SCOPES_PHONE = [
  "read",
  "write:inbox",
  "write:queue",
  "write:remote",
  "write:approvals",
];
export const SCOPES_WEB = ["read", "write:inbox", "write:queue", "write:approvals"];

export const RATE = 0.8;
export const money = (usdMicro: number) => ({ usdMicro, chfMicro: Math.round(usdMicro * RATE) });

export const HUMAN_J = { id: "human_j", name: "J" };
export const AGENT_J = { id: "agent_j", name: "J's agent", ownerHumanId: "human_j" };

export const FAKE_PROJECTS: ProjectCard[] = [
  {
    id: "proj_pharma",
    name: "PharmaWatch",
    goal: "Watch regulatory feeds and summarise changes weekly.",
    stage: "build",
    status: "active",
    autonomyLevel: 2,
    nextMilestone: { id: "ms_feeds", name: "Feeds parsed", targetDate: "2026-11-01" },
    health: "attention",
    spend: money(12_500_000),
    budget: money(62_500_000),
    waitingOnYou: 2,
    latestCriticGrade: 78,
    lastSessionAt: "2026-10-19T20:00:00.000Z",
    active: true,
  },
  {
    id: "proj_supp",
    name: "Supplement site",
    goal: "A small shop for supplements with a content calendar.",
    stage: "idea",
    status: "active",
    autonomyLevel: 1,
    nextMilestone: null,
    health: "good",
    spend: money(0),
    budget: money(25_000_000),
    waitingOnYou: 0,
    latestCriticGrade: null,
    lastSessionAt: null,
    active: false,
  },
  {
    id: "proj_game",
    name: "Space game",
    goal: "A browser space trading game with a weekly release.",
    stage: "build",
    status: "active",
    autonomyLevel: 2,
    nextMilestone: { id: "ms_trade", name: "Trading loop", targetDate: "2026-11-15" },
    health: "good",
    spend: money(5_000_000),
    budget: money(50_000_000),
    waitingOnYou: 1,
    latestCriticGrade: 85,
    lastSessionAt: "2026-10-18T22:00:00.000Z",
    active: false,
  },
];

export const FAKE_REQUESTS: HumanRequestView[] = [
  {
    id: "req_merge",
    projectId: "proj_pharma",
    projectName: "PharmaWatch",
    taskId: "task_1",
    sessionId: null,
    kind: "approval",
    why: "Merge the feed parser PR?",
    steps: ["Critic grade 82", "CI green"],
    options: ["Approve", "Reject", "Ask later"],
    blocking: true,
    risk: "medium",
    changeCard: null,
    status: "open",
    answer: null,
    createdAt: "2026-10-20T07:00:00.000Z",
    version: 1,
  },
  {
    id: "req_cap",
    projectId: null,
    projectName: null,
    taskId: null,
    sessionId: null,
    kind: "approval",
    why: "Raise the monthly hard ceiling from CHF 150 to CHF 250?",
    steps: [],
    options: ["Confirm", "Decline"],
    blocking: false,
    risk: "high",
    changeCard: {
      command: "budget.set",
      what: "the monthly cap",
      oldValue: "CHF 150",
      newValue: "CHF 250",
      scope: "global",
      scopeLabel: "everything",
      duration: "permanent",
      impact: { risk: "high", costChfMicro: 100_000_000 },
      undoHint: "Say undo or tap Undo in the change log.",
      sentence: "Raised the monthly cap from CHF 150 to CHF 250. Undo.",
      projectId: null,
      projectName: null,
      usesActiveProject: false,
      expiresAt: null,
      reversible: true,
    },
    status: "open",
    answer: null,
    createdAt: "2026-10-20T06:30:00.000Z",
    version: 1,
  },
  {
    id: "req_name",
    projectId: "proj_game",
    projectName: "Space game",
    taskId: null,
    sessionId: null,
    kind: "decision",
    why: "Which name for the trading hub?",
    steps: [],
    options: ["Nexus", "Harbour"],
    blocking: false,
    risk: "low",
    changeCard: null,
    status: "open",
    answer: null,
    createdAt: "2026-10-20T05:00:00.000Z",
    version: 1,
  },
];

export const FAKE_MESSAGES: MessageView[] = [
  {
    id: "msg_handoff",
    fromAgentId: "agent_j",
    fromAgentName: "J's agent",
    toAgentId: null,
    toHumanId: "human_j",
    projectId: "proj_pharma",
    taskId: null,
    type: "handoff",
    body: "Done: parser skeleton. In flight: feed fixtures. Next: schedule.",
    requiresAck: true,
    deliveredAt: "2026-10-20T06:00:00.000Z",
    readAt: null,
    actedAt: null,
    createdAt: "2026-10-20T06:00:00.000Z",
  },
  {
    id: "msg_info",
    fromAgentId: "agent_j",
    fromAgentName: "J's agent",
    toAgentId: null,
    toHumanId: "human_j",
    projectId: "proj_game",
    taskId: null,
    type: "info",
    body: "Weekly release tagged.",
    requiresAck: false,
    deliveredAt: "2026-10-19T22:00:00.000Z",
    readAt: "2026-10-19T22:30:00.000Z",
    actedAt: null,
    createdAt: "2026-10-19T22:00:00.000Z",
  },
];

const clone = <T>(value: T): T => structuredClone(value);
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const PUBLIC_PATHS = new Set(["/health", "/pairing/complete"]);

function errorBody(
  c: Ctx,
  status: 400 | 401 | 403 | 404 | 409,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return c.json({ code, message, details }, status);
}

function parseTimestamp(raw: string): number | undefined {
  if (/^\d{10,16}$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

export function createFakeStateService(options: FakeStateOptions = {}) {
  const adminToken = options.adminToken ?? randomBytes(16).toString("hex");
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const pcAutoCompleteMs = options.pcAutoCompleteMs === undefined ? 150 : options.pcAutoCompleteMs;
  const windowMs = options.signatureWindowMs ?? SIGNATURE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();
  let counter = 100;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  const state: FakeStateState = {
    humans: [clone(HUMAN_J)],
    agents: [clone(AGENT_J)],
    projects: clone(FAKE_PROJECTS),
    requests: clone(FAKE_REQUESTS),
    messages: clone(FAKE_MESSAGES),
    devices: [],
    tokens: [],
    pairings: new Map(),
    remoteCommands: [],
    sessions: [],
    events: [],
    queue: [],
    calls: [],
    log: [],
    seq: 0,
    feed: [],
    listeners: new Set(),
    replay: new Set(),
    timers: new Set(),
  };

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      state.timers.delete(t);
      fn();
    }, ms);
    state.timers.add(t);
    return t;
  };

  const announce = (
    type: string,
    payload: Record<string, unknown>,
    extra: { humanId?: string | null; projectId?: string | null; sessionId?: string | null } = {},
  ) => {
    const event: ChangeEvent = {
      seq: ++state.seq,
      type,
      at: nowIso(),
      humanId: extra.humanId ?? null,
      projectId: extra.projectId ?? null,
      sessionId: extra.sessionId ?? null,
      payload,
      origin: "fake",
    };
    state.feed.push(event);
    if (state.feed.length > 500) state.feed.shift();
    for (const l of state.listeners) l(event);
  };

  const blockingCount = (humanId: string) =>
    state.requests.filter((r) => r.status === "open" && r.blocking && humanOf(r) === humanId)
      .length;
  const humanOf = (_r: HumanRequestView) => HUMAN_J.id;

  const startPairing = (humanId: string, kind: "phone" | "web", scopes?: string[]) => {
    let code = newPairingCode();
    while (state.pairings.has(code)) code = newPairingCode();
    const pending: PendingPairing = {
      code,
      humanId,
      kind,
      scopes: scopes ?? (kind === "phone" ? [...SCOPES_PHONE] : [...SCOPES_WEB]),
      expiresAt: new Date(now() + 10 * 60 * 1000).toISOString(),
    };
    state.pairings.set(code, pending);
    return pending;
  };

  const sessionFor = (projectId: string, budgetUsd: number): SessionView => ({
    id: nextId("sess"),
    agentId: AGENT_J.id,
    agentName: AGENT_J.name,
    projectId,
    trigger: "remote",
    status: "running",
    startedAt: nowIso(),
    endedAt: null,
    budgetCap: money(budgetUsd),
    spent: money(0),
    stepCap: 60,
    steps: 0,
    currentTask: null,
    summary: "",
    handoff: null,
    runner: "pc",
  });

  /** The simulated PC: picks the command up, runs the plan, reports a result. */
  const simulatePc = (id: string) => {
    if (pcAutoCompleteMs === null) return;
    later(() => {
      const row = state.remoteCommands.find((r) => r.id === id);
      if (row?.status !== "pending") return;
      pickUp(row);
      later(() => {
        const current = state.remoteCommands.find((r) => r.id === id);
        if (current?.status !== "picked_up") return;
        complete(current, executeOnPc(current));
      }, pcAutoCompleteMs);
    }, pcAutoCompleteMs);
  };

  const pickUp = (row: FakeRemoteCommand) => {
    row.status = "picked_up";
    row.pickedUpAt = nowIso();
    row.updatedAt = nowIso();
    row.version += 1;
    const issuer = state.devices.find((d) => d.id === row.deviceId);
    announce(
      "remote_command.changed",
      {
        id: row.id,
        version: row.version,
        status: row.status,
        target: row.target,
        command: row.command,
      },
      { humanId: issuer?.ownerHumanId ?? null },
    );
  };

  const complete = (row: FakeRemoteCommand, result: unknown, failed = false) => {
    row.status = failed ? "failed" : "done";
    row.result = result;
    row.updatedAt = nowIso();
    row.version += 1;
    const issuer = state.devices.find((d) => d.id === row.deviceId);
    announce(
      "remote_command.changed",
      {
        id: row.id,
        version: row.version,
        status: row.status,
        target: row.target,
        command: row.command,
      },
      { humanId: issuer?.ownerHumanId ?? null },
    );
  };

  const executeOnPc = (row: FakeRemoteCommand): unknown => {
    const params = row.params;
    if (params.kind === "chat" && typeof params.text === "string") {
      return { reply: `PC agent: I read "${params.text}". Nothing to do.` };
    }
    if (params.kind === "plan" && Array.isArray(params.plan)) {
      const executed: string[] = [];
      let sessionId: string | null = null;
      let projectId: string | null = null;
      for (const step of params.plan as { name: string; params: Record<string, unknown> }[]) {
        executed.push(step.name);
        if (step.name === "project.switch" && typeof step.params.project === "string") {
          projectId = step.params.project;
          for (const p of state.projects) p.active = p.id === projectId;
        }
        if (step.name === "session.start") {
          const pid = typeof step.params.project === "string" ? step.params.project : projectId;
          const budgetChf = typeof step.params.budgetChf === "number" ? step.params.budgetChf : 5;
          const session = sessionFor(
            pid ?? "proj_pharma",
            Math.round((budgetChf / RATE) * 1_000_000),
          );
          state.sessions.push(session);
          sessionId = session.id;
          announce(
            "session.changed",
            { id: session.id, version: 1, status: "running" },
            {
              humanId: HUMAN_J.id,
              projectId: session.projectId,
              sessionId: session.id,
            },
          );
        }
        if (step.name === "session.stop") {
          for (const s of state.sessions) {
            if (s.status === "running") {
              s.status = "killed";
              s.endedAt = nowIso();
              announce(
                "session.changed",
                { id: s.id, version: 2, status: s.status },
                {
                  humanId: HUMAN_J.id,
                  sessionId: s.id,
                },
              );
            }
          }
        }
      }
      return { executed, sessionId, changeLogId: nextId("change"), undoOf: params.undoOf ?? null };
    }
    if (row.command === "kill" || row.command === "stop") {
      for (const s of state.sessions) {
        if (s.status === "running") {
          s.status = "killed";
          s.endedAt = nowIso();
        }
      }
      return { stopped: true };
    }
    return { ok: true };
  };

  const app = new Hono<Env>();
  app.use(
    "*",
    cors({
      origin: (origin) => origin,
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Accept",
        "Last-Event-ID",
        "X-Device-Signature",
        "X-Device-Timestamp",
        "X-Biometric-Assertion",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
      exposeHeaders: ["Retry-After"],
    }),
  );

  // Authentication: admin token, or a device session token plus the device signature.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const url = new URL(c.req.url);
    const isPublic = PUBLIC_PATHS.has(url.pathname);
    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? new Uint8Array()
        : new Uint8Array(await c.req.arrayBuffer());
    const bodyText = new TextDecoder().decode(body);
    let parsedBody: unknown = null;
    if (bodyText) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }
    }
    const record = (principal: Principal | null) => {
      if (c.req.method !== "POST") return;
      state.calls.push({
        method: c.req.method,
        path: url.pathname,
        body: parsedBody,
        signed: principal?.kind === "device" ? principal.signed : false,
        biometric: principal?.kind === "device" ? principal.biometric : false,
        principal: principal ? principal.kind : "none",
        deviceId: principal?.kind === "device" ? principal.device.id : null,
      });
    };
    const logLine = (principal: string, status: string) => {
      state.log.push(
        `${c.req.method} ${url.pathname}${url.search} principal=${principal} ${status}`,
      );
    };
    if (isPublic) {
      record(null);
      logLine("none", "public");
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m?.[1]) {
      logLine("none", "401");
      return errorBody(c, 401, "unauthorized", "authentication required");
    }
    const token = m[1];
    if (token === adminToken) {
      c.set("principal", { kind: "admin" } satisfies Principal);
      record({ kind: "admin" });
      logLine("admin", "ok");
      return next();
    }
    const hash = hashToken(token);
    const rec = state.tokens.find((t) => t.hash === hash);
    if (!rec || rec.expiresAt <= nowIso()) {
      logLine("none", "401");
      return errorBody(c, 401, "unauthorized", "invalid or expired session token");
    }
    const device = state.devices.find((d) => d.id === rec.deviceId);
    if (!device || device.revoked) {
      logLine("device", "401 revoked");
      return errorBody(c, 401, "unauthorized", "device revoked", { deviceId: rec.deviceId });
    }
    device.lastSeen = nowIso();
    let signed = false;
    let biometric = false;
    const signature = c.req.header("x-device-signature");
    if (signature) {
      const timestamp = c.req.header("x-device-timestamp") ?? "";
      const ts = parseTimestamp(timestamp);
      if (ts === undefined) return errorBody(c, 401, "bad_signature", "X-Device-Timestamp missing");
      if (Math.abs(now() - ts) > windowMs) {
        return errorBody(c, 401, "bad_signature", "X-Device-Timestamp outside the allowed window", {
          windowMs,
        });
      }
      const flag = c.req.header("x-biometric-assertion");
      biometric = flag === "1" || flag === "true";
      const ok = verifyRequestSignature(device.publicKey, signature, {
        method: c.req.method,
        path: `${url.pathname}${url.search}`,
        body,
        timestamp,
        biometric,
      });
      if (!ok) {
        logLine("device", "401 bad_signature");
        return errorBody(c, 401, "bad_signature", "device signature does not verify");
      }
      if (c.req.method !== "GET") {
        if (state.replay.has(signature)) {
          return errorBody(
            c,
            401,
            "bad_signature",
            "signed request replayed; sign again with a fresh timestamp",
          );
        }
        state.replay.add(signature);
      }
      signed = true;
    }
    const principal: Principal = { kind: "device", device, scopes: rec.scopes, signed, biometric };
    c.set("principal", principal);
    record(principal);
    logLine(`device:${device.id}`, signed ? (biometric ? "signed+biometric" : "signed") : "ok");
    return next();
  });

  const principalOf = (c: Ctx): Principal => c.get("principal");
  const requireScope = (c: Ctx, p: Principal, scope: string) => {
    if (p.kind === "admin") return null;
    if (!p.scopes.includes(scope))
      return errorBody(c, 403, "forbidden", `scope ${scope} required`, { scope });
    return null;
  };
  const requireSigned = (c: Ctx, p: Principal) => {
    if (p.kind === "device" && !p.signed) {
      return errorBody(c, 401, "bad_signature", "mutations need X-Device-Signature");
    }
    return null;
  };

  // ---------------------------------------------------------------------------------
  // Test hooks (admin only)

  app.get("/__test/calls", (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    return c.json(state.calls);
  });
  app.get("/__test/log", (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    return c.json(state.log);
  });
  app.get("/__test/state", (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    return c.json({
      devices: state.devices,
      remoteCommands: state.remoteCommands,
      requests: state.requests,
      messages: state.messages,
      sessions: state.sessions,
      queue: state.queue,
      projects: state.projects,
    });
  });
  app.post("/__test/reset", (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    state.projects = clone(FAKE_PROJECTS);
    state.requests = clone(FAKE_REQUESTS);
    state.messages = clone(FAKE_MESSAGES);
    state.devices = [];
    state.tokens = [];
    state.pairings.clear();
    state.remoteCommands = [];
    state.sessions = [];
    state.events = [];
    state.queue = [];
    state.calls = [];
    state.log = [];
    state.replay.clear();
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    return c.json({ ok: true });
  });
  /** What the desktop would do: start a pairing and show the code. */
  app.post("/__test/pair", async (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
      humanId?: string;
      kind?: "phone" | "web";
      scopes?: string[];
    };
    const pending = startPairing(body.humanId ?? HUMAN_J.id, body.kind ?? "phone", body.scopes);
    return c.json(
      { code: pending.code, expiresAt: pending.expiresAt, humanId: pending.humanId },
      201,
    );
  });
  app.post("/__test/request", async (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    const body = (await c.req.json()) as Partial<HumanRequestView>;
    const row: HumanRequestView = {
      id: body.id ?? nextId("req"),
      projectId: body.projectId ?? null,
      projectName: body.projectName ?? null,
      taskId: null,
      sessionId: null,
      kind: body.kind ?? "approval",
      why: body.why ?? "Approve?",
      steps: body.steps ?? [],
      options: body.options ?? ["Approve", "Reject"],
      blocking: body.blocking ?? false,
      risk: body.risk ?? "medium",
      changeCard: body.changeCard ?? null,
      status: "open",
      answer: null,
      createdAt: nowIso(),
      version: 1,
    };
    state.requests.unshift(row);
    announce(
      "human_request.changed",
      { id: row.id, version: 1, status: "open", blocking: row.blocking },
      {
        humanId: HUMAN_J.id,
        projectId: row.projectId,
      },
    );
    return c.json(row, 201);
  });
  app.post("/__test/emit", async (c) => {
    if (principalOf(c).kind !== "admin") return errorBody(c, 403, "forbidden", "admin only");
    const body = (await c.req.json()) as {
      type: string;
      payload?: Record<string, unknown>;
      humanId?: string;
    };
    announce(body.type, body.payload ?? {}, { humanId: body.humanId ?? HUMAN_J.id });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------
  // Public

  app.get("/health", (c) =>
    c.json({
      version: "fake-state-service",
      schema: { code: 1, applied: 1, state: "current" },
      compatibleSchemaVersion: 1,
      time: nowIso(),
      realtime: { instance: "fake" },
      mirror: { enabled: false, repo: null },
    }),
  );

  app.post("/pairing/complete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      code?: string;
      publicKey?: string;
      proof?: string;
      name?: string;
      platform?: string;
      pushToken?: string;
    } | null;
    if (
      !body ||
      typeof body.code !== "string" ||
      typeof body.publicKey !== "string" ||
      typeof body.proof !== "string" ||
      typeof body.platform !== "string"
    ) {
      return errorBody(c, 400, "validation", "invalid request body");
    }
    const code = body.code.trim().toUpperCase();
    const pending = state.pairings.get(code);
    if (!pending || pending.expiresAt <= nowIso()) {
      return errorBody(c, 400, "pairing_invalid", "unknown or expired pairing code");
    }
    if (!isValidPublicKey(body.publicKey)) {
      return errorBody(c, 400, "pairing_invalid", "publicKey must be a 32-byte base64 Ed25519 key");
    }
    if (!verifyPairingProof(body.publicKey, code, body.proof)) {
      return errorBody(c, 400, "pairing_invalid", "proof does not verify against publicKey");
    }
    state.pairings.delete(code);
    const existing = state.devices.find((d) => d.publicKey === body.publicKey);
    if (existing) {
      return errorBody(c, 409, "pairing_invalid", "this public key is already paired", {
        deviceId: existing.id,
        revoked: existing.revoked,
      });
    }
    const device: FakeDevice = {
      id: nextId("dev"),
      ownerHumanId: pending.humanId,
      name: (body.name ?? `${pending.kind} device`).slice(0, 120),
      platform: body.platform.slice(0, 40),
      kind: pending.kind,
      publicKey: body.publicKey,
      lastSeen: null,
      revoked: false,
      revokedAt: null,
      pairedAt: nowIso(),
      version: 1,
    };
    state.devices.push(device);
    const token = newSessionToken();
    const expiresAt = new Date(now() + 30 * 24 * 3600 * 1000).toISOString();
    state.tokens.push({
      hash: hashToken(token),
      deviceId: device.id,
      humanId: device.ownerHumanId,
      scopes: pending.scopes,
      expiresAt,
    });
    announce(
      "device.changed",
      { id: device.id, version: 1, revoked: false },
      { humanId: device.ownerHumanId },
    );
    return c.json(
      {
        deviceId: device.id,
        humanId: device.ownerHumanId,
        kind: device.kind,
        token,
        expiresAt,
        scopes: pending.scopes,
        schemaVersion: 1,
      },
      201,
    );
  });

  // ---------------------------------------------------------------------------------
  // Devices and pairing (admin)

  app.post("/pairing/start", async (c) => {
    const p = principalOf(c);
    if (p.kind !== "admin")
      return errorBody(c, 403, "forbidden", "only the desktop runtime starts a pairing");
    const body = (await c.req.json()) as {
      humanId: string;
      kind?: "phone" | "web";
      scopes?: string[];
    };
    const pending = startPairing(body.humanId, body.kind ?? "phone", body.scopes);
    return c.json(
      {
        code: pending.code,
        expiresAt: pending.expiresAt,
        kind: pending.kind,
        scopes: pending.scopes,
        qr: { v: 1, code: pending.code, humanId: pending.humanId, kind: pending.kind },
      },
      201,
    );
  });

  app.get("/me", (c) => {
    const p = principalOf(c);
    if (p.kind === "admin")
      return c.json({
        principal: "admin",
        scopes: ["*"],
        humanId: null,
        deviceId: null,
        installId: null,
      });
    const human = state.humans.find((h) => h.id === p.device.ownerHumanId);
    const rec = state.tokens.find((t) => t.deviceId === p.device.id);
    return c.json({
      principal: "device",
      deviceId: p.device.id,
      humanId: p.device.ownerHumanId,
      humanName: human?.name ?? null,
      kind: p.device.kind,
      scopes: p.scopes,
      expiresAt: rec?.expiresAt ?? nowIso(),
      signed: p.signed,
      schemaVersion: 1,
    });
  });

  app.get("/devices", (c) => {
    const p = principalOf(c);
    const rows =
      p.kind === "admin"
        ? state.devices
        : state.devices.filter((d) => d.ownerHumanId === p.device.ownerHumanId);
    return c.json({ devices: rows });
  });
  app.get("/devices/:id", (c) => {
    const p = principalOf(c);
    const d = state.devices.find((x) => x.id === c.req.param("id"));
    if (!d) return errorBody(c, 404, "not_found", "device not found");
    if (p.kind === "device" && d.ownerHumanId !== p.device.ownerHumanId)
      return errorBody(c, 403, "forbidden", "not your device");
    return c.json(d);
  });
  app.post("/devices/:id/revoke", (c) => {
    const p = principalOf(c);
    if (p.kind !== "admin")
      return errorBody(c, 403, "forbidden", "devices are revoked from the desktop");
    const d = state.devices.find((x) => x.id === c.req.param("id"));
    if (!d) return errorBody(c, 404, "not_found", "device not found");
    d.revoked = true;
    d.revokedAt = nowIso();
    d.version += 1;
    const before = state.tokens.length;
    state.tokens = state.tokens.filter((t) => t.deviceId !== d.id);
    announce(
      "device.changed",
      { id: d.id, version: d.version, revoked: true },
      { humanId: d.ownerHumanId },
    );
    return c.json({ device: d, tokensRevoked: before - state.tokens.length });
  });

  // ---------------------------------------------------------------------------------
  // Projects, inbox, requests, messages, queue

  app.get("/projects", (c) => {
    const p = principalOf(c);
    const scopeError = requireScope(c, p, "read");
    if (scopeError) return scopeError;
    return c.json({ projects: state.projects });
  });
  app.get("/projects/:id", (c) => {
    const row = state.projects.find((x) => x.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "project not found");
    return c.json(row);
  });

  app.get("/inbox", (c) => {
    const p = principalOf(c);
    const humanId = c.req.query("humanId");
    if (p.kind === "device" && humanId && humanId !== p.device.ownerHumanId) {
      return errorBody(c, 403, "forbidden", "not your human", { humanId });
    }
    const id = p.kind === "device" ? p.device.ownerHumanId : humanId;
    if (!id) return errorBody(c, 400, "validation", "humanId is required");
    return c.json({
      messages: state.messages.filter((m) => m.toHumanId === id),
      requests: state.requests.filter((r) => r.status === "open"),
      blockingCount: blockingCount(id),
    });
  });

  app.get("/requests", (c) => {
    const p = principalOf(c);
    const open = state.requests.filter((r) => r.status === "open");
    return c.json({
      requests: open,
      blockingCount: blockingCount(p.kind === "device" ? p.device.ownerHumanId : HUMAN_J.id),
    });
  });
  app.get("/requests/:id", (c) => {
    const row = state.requests.find((r) => r.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "request not found");
    return c.json(row);
  });
  app.post("/requests/:id/answer", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const scopeError = requireScope(c, p, "write:approvals");
    if (scopeError) return scopeError;
    const row = state.requests.find((r) => r.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "request not found");
    const body = (await c.req.json().catch(() => null)) as {
      version?: number;
      answer?: unknown;
    } | null;
    if (!body || typeof body.version !== "number")
      return errorBody(c, 400, "validation", "invalid request body");
    const cardRisk =
      row.changeCard && typeof row.changeCard === "object" && !Array.isArray(row.changeCard)
        ? ((row.changeCard as { impact?: { risk?: unknown }; risk?: unknown }).impact?.risk ??
          (row.changeCard as { risk?: unknown }).risk)
        : null;
    if ((row.risk === "high" || cardRisk === "high") && p.kind === "device") {
      if (!p.signed)
        return errorBody(
          c,
          403,
          "forbidden",
          "high-risk confirmation needs a device-signed request",
        );
      if (!p.biometric)
        return errorBody(
          c,
          403,
          "biometric_required",
          "high-risk confirmation needs the biometric assertion flag",
        );
    }
    if (row.status !== "open")
      return errorBody(c, 409, "version_conflict", "request already answered");
    if (body.version !== row.version) return errorBody(c, 409, "version_conflict", "stale version");
    row.status = "answered";
    row.answer = body.answer ?? null;
    row.version += 1;
    announce(
      "human_request.changed",
      { id: row.id, version: row.version, status: row.status, blocking: row.blocking },
      {
        humanId: HUMAN_J.id,
        projectId: row.projectId,
      },
    );
    return c.json(row);
  });

  app.get("/messages/:id", (c) => {
    const row = state.messages.find((m) => m.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "message not found");
    return c.json(row);
  });
  app.post("/messages", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const scopeError = requireScope(c, p, "write:inbox");
    if (scopeError) return scopeError;
    const body = (await c.req.json()) as Partial<MessageView> & {
      fromAgentId: string;
      body: string;
    };
    const from = state.agents.find((a) => a.id === body.fromAgentId);
    if (!from) return errorBody(c, 404, "not_found", "agent not found");
    const row: MessageView = {
      id: nextId("msg"),
      fromAgentId: from.id,
      fromAgentName: from.name,
      toAgentId: body.toAgentId ?? null,
      toHumanId: body.toHumanId ?? null,
      projectId: body.projectId ?? null,
      taskId: body.taskId ?? null,
      type: body.type ?? "info",
      body: body.body,
      requiresAck: body.requiresAck ?? false,
      deliveredAt: null,
      readAt: null,
      actedAt: null,
      createdAt: nowIso(),
    };
    state.messages.unshift(row);
    announce(
      "message.changed",
      {
        id: row.id,
        version: 1,
        toAgentId: row.toAgentId,
        toHumanId: row.toHumanId,
        type: row.type,
      },
      {
        humanId: row.toHumanId,
        projectId: row.projectId,
      },
    );
    return c.json(row, 201);
  });
  app.post("/messages/:id/receipt", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const scopeError = requireScope(c, p, "write:inbox");
    if (scopeError) return scopeError;
    const row = state.messages.find((m) => m.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "message not found");
    if (p.kind === "device" && row.toHumanId !== p.device.ownerHumanId) {
      return errorBody(c, 403, "forbidden", "only the addressee acknowledges a message");
    }
    const body = (await c.req.json()) as { state: "delivered" | "read" | "acted" };
    const at = nowIso();
    if (body.state === "delivered" && !row.deliveredAt) row.deliveredAt = at;
    if (body.state === "read") {
      row.deliveredAt ??= at;
      row.readAt ??= at;
    }
    if (body.state === "acted") {
      row.deliveredAt ??= at;
      row.readAt ??= at;
      row.actedAt ??= at;
    }
    announce(
      "message.changed",
      { id: row.id, version: 2, receipt: body.state },
      { humanId: row.toHumanId },
    );
    return c.json(row);
  });

  app.get("/projects/:id/queue", (c) =>
    c.json({
      items: state.queue.filter((q) => q.projectId === c.req.param("id") && q.status === "queued"),
    }),
  );
  app.post("/projects/:id/queue", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const scopeError = requireScope(c, p, "write:queue");
    if (scopeError) return scopeError;
    const projectId = c.req.param("id");
    if (!state.projects.some((x) => x.id === projectId))
      return errorBody(c, 404, "not_found", "project not found");
    const body = (await c.req.json()) as { kind?: string; text?: string; priority?: number };
    if (!body.text) return errorBody(c, 400, "validation", "text is required");
    const row: QueueItem = {
      id: nextId("queue"),
      projectId,
      humanId: p.kind === "device" ? p.device.ownerHumanId : HUMAN_J.id,
      kind: body.kind ?? "note",
      text: body.text,
      priority: body.priority ?? 0,
      status: "queued",
      createdAt: nowIso(),
      version: 1,
    };
    state.queue.push(row);
    announce(
      "queue_item.changed",
      { id: row.id, version: 1, status: row.status },
      { humanId: row.humanId, projectId },
    );
    return c.json(row, 201);
  });

  // ---------------------------------------------------------------------------------
  // Remote commands

  const REMOTE_VERBS = new Set(["start", "pause", "stop", "kill"]);

  const enqueueRemote = (
    c: Ctx,
    p: Principal,
    body: {
      target?: string;
      targetDeviceId?: string;
      command?: string;
      params?: Record<string, unknown>;
      deviceId?: string;
    },
  ): FakeRemoteCommand | Response => {
    if (body.target !== "pc" && body.target !== "cloud")
      return errorBody(c, 400, "validation", "target must be pc or cloud");
    if (typeof body.command !== "string" || !REMOTE_VERBS.has(body.command)) {
      return errorBody(c, 400, "validation", "invalid request body", {
        issues: [{ path: "command", message: "start | pause | stop | kill" }],
      });
    }
    const deviceId = p.kind === "device" ? p.device.id : body.deviceId;
    if (!deviceId) return errorBody(c, 400, "validation", "deviceId is required for admin callers");
    const row: FakeRemoteCommand = {
      id: nextId("cmd"),
      deviceId,
      target: body.target,
      targetDeviceId: body.targetDeviceId ?? null,
      command: body.command,
      params: body.params ?? {},
      status: "pending",
      pickedUpAt: null,
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: 1,
    };
    state.remoteCommands.push(row);
    announce(
      "remote_command.changed",
      { id: row.id, version: 1, status: row.status, target: row.target, command: row.command },
      {
        humanId: p.kind === "device" ? p.device.ownerHumanId : null,
      },
    );
    simulatePc(row.id);
    return row;
  };

  app.post("/remote/commands", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const scopeError = requireScope(c, p, "write:remote");
    if (scopeError) return scopeError;
    const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof enqueueRemote>[2];
    const row = enqueueRemote(c, p, body);
    if (row instanceof Response) return row;
    return c.json(row, 201);
  });
  app.get("/remote/commands/pending", (c) => {
    const p = principalOf(c);
    if (p.kind !== "admin") return errorBody(c, 403, "forbidden", "only runtimes pick commands up");
    const target = c.req.query("target");
    const row = state.remoteCommands.find((r) => r.status === "pending" && r.target === target);
    if (!row) return c.body(null, 204);
    pickUp(row);
    return c.json(row);
  });
  app.get("/remote/commands", (c) => {
    const p = principalOf(c);
    const rows =
      p.kind === "admin"
        ? state.remoteCommands
        : state.remoteCommands.filter((r) =>
            state.devices.some(
              (d) => d.id === r.deviceId && d.ownerHumanId === p.device.ownerHumanId,
            ),
          );
    const status = c.req.query("status");
    return c.json({ commands: [...rows].reverse().filter((r) => !status || r.status === status) });
  });
  app.get("/remote/commands/:id", (c) => {
    const p = principalOf(c);
    const row = state.remoteCommands.find((r) => r.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "command not found");
    if (p.kind === "device") {
      const issuer = state.devices.find((d) => d.id === row.deviceId);
      if (issuer?.ownerHumanId !== p.device.ownerHumanId)
        return errorBody(c, 403, "forbidden", "not your command");
    }
    return c.json(row);
  });
  for (const outcome of ["complete", "fail"] as const) {
    app.post(`/remote/commands/:id/${outcome}`, async (c) => {
      const p = principalOf(c);
      if (p.kind !== "admin")
        return errorBody(c, 403, "forbidden", "only runtimes report command outcomes");
      const row = state.remoteCommands.find((r) => r.id === c.req.param("id"));
      if (!row) return errorBody(c, 404, "not_found", "command not found");
      const body = (await c.req.json().catch(() => ({}))) as { result?: unknown };
      complete(row, body.result ?? null, outcome === "fail");
      return c.json(row);
    });
  }

  // ---------------------------------------------------------------------------------
  // Sessions

  app.get("/sessions", (c) => {
    const status = c.req.query("status");
    const projectId = c.req.query("projectId");
    return c.json({
      sessions: state.sessions.filter(
        (s) => (!status || s.status === status) && (!projectId || s.projectId === projectId),
      ),
    });
  });
  app.get("/sessions/:id", (c) => {
    const row = state.sessions.find((s) => s.id === c.req.param("id"));
    if (!row) return errorBody(c, 404, "not_found", "session not found");
    return c.json(row);
  });
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const row = state.sessions.find((s) => s.id === id);
    if (!row) return errorBody(c, 404, "not_found", "session not found");
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const events = state.events.filter((e) => e.sessionId === id && e.seq > afterSeq);
    if (!(c.req.header("accept") ?? "").includes("text/event-stream")) return c.json({ events });
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ sessionId: id, afterSeq, at: nowIso() }),
      });
      for (const e of events)
        await stream.writeSSE({
          event: "session.event",
          data: JSON.stringify(e),
          id: String(e.seq),
        });
      const listener = (e: ChangeEvent) => {
        if (closed || e.sessionId !== id) return;
        const session = state.sessions.find((s) => s.id === id);
        if (session)
          void stream.writeSSE({ event: "session.changed", data: JSON.stringify(session) });
      };
      state.listeners.add(listener);
      try {
        while (!closed) {
          await stream.sleep(heartbeatMs);
          if (closed) break;
          await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ at: nowIso() }) });
        }
      } finally {
        state.listeners.delete(listener);
      }
    });
  });

  // ---------------------------------------------------------------------------------
  // Change feed

  app.get("/events", (c) => {
    const p = principalOf(c);
    const scopeError = requireScope(c, p, "read");
    if (scopeError) return scopeError;
    const humanId = p.kind === "device" ? p.device.ownerHumanId : null;
    const raw = c.req.header("last-event-id") ?? c.req.query("lastEventId");
    const lastSeq = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const visible = (e: ChangeEvent) =>
      humanId === null || e.humanId === null || e.humanId === humanId;
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ seq: state.seq, at: nowIso(), instance: "fake" }),
      });
      if (lastSeq !== undefined) {
        const oldest = state.feed[0]?.seq ?? state.seq + 1;
        if (lastSeq + 1 < oldest && state.feed.length > 0) {
          await stream.writeSSE({
            event: "resync",
            data: JSON.stringify({ reason: "last-event-id too old" }),
          });
        } else {
          for (const e of state.feed) {
            if (e.seq > lastSeq && visible(e))
              await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(e.seq) });
          }
        }
      }
      const queue: ChangeEvent[] = [];
      const listener = (e: ChangeEvent) => {
        if (visible(e)) queue.push(e);
      };
      state.listeners.add(listener);
      // Heartbeats pace on real time: the simulated clock only stamps events.
      let lastBeat = Date.now();
      try {
        while (!closed) {
          await stream.sleep(25);
          if (closed) break;
          while (queue.length) {
            const e = queue.shift() as ChangeEvent;
            await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(e.seq) });
          }
          if (Date.now() - lastBeat >= heartbeatMs) {
            lastBeat = Date.now();
            await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ at: nowIso() }) });
          }
        }
      } finally {
        state.listeners.delete(listener);
      }
    });
  });

  // ---------------------------------------------------------------------------------
  // Offline outbox

  app.post("/sync/outbox", async (c) => {
    const p = principalOf(c);
    const signedError = requireSigned(c, p);
    if (signedError) return signedError;
    const body = (await c.req.json()) as {
      actions: {
        clientId: string;
        kind: string;
        payload: Record<string, unknown>;
        createdAt: string;
      }[];
    };
    const results: {
      clientId: string;
      status: "applied" | "duplicate" | "rejected";
      code?: string;
      message?: string;
      result?: unknown;
    }[] = [];
    for (const action of body.actions ?? []) {
      if (seenClientIds.has(action.clientId)) {
        results.push({
          clientId: action.clientId,
          status: "duplicate",
          result: seenClientIds.get(action.clientId),
        });
        continue;
      }
      const outcome = applyOutboxAction(c, p, action);
      if (outcome instanceof Response) {
        const parsed = (await outcome.json()) as { code: string; message: string };
        results.push({
          clientId: action.clientId,
          status: "rejected",
          code: parsed.code,
          message: parsed.message,
        });
      } else {
        seenClientIds.set(action.clientId, outcome);
        results.push({ clientId: action.clientId, status: "applied", result: outcome });
      }
    }
    return c.json({ results });
  });
  const seenClientIds = new Map<string, unknown>();

  const applyOutboxAction = (
    c: Ctx,
    p: Principal,
    action: { kind: string; payload: Record<string, unknown> },
  ): unknown => {
    switch (action.kind) {
      case "request.answer": {
        const scopeError = requireScope(c, p, "write:approvals");
        if (scopeError) return scopeError;
        const row = state.requests.find((r) => r.id === action.payload.id);
        if (!row) return errorBody(c, 404, "not_found", "request not found");
        if (row.risk === "high" && p.kind === "device" && !p.biometric) {
          return errorBody(
            c,
            403,
            "biometric_required",
            "high-risk confirmation needs the biometric assertion flag",
          );
        }
        if (row.status !== "open" || row.version !== action.payload.version) {
          return errorBody(c, 409, "version_conflict", "stale version");
        }
        row.status = "answered";
        row.answer = action.payload.answer ?? null;
        row.version += 1;
        announce(
          "human_request.changed",
          { id: row.id, version: row.version, status: row.status, blocking: row.blocking },
          { humanId: HUMAN_J.id },
        );
        return { id: row.id, version: row.version };
      }
      case "message.receipt": {
        const scopeError = requireScope(c, p, "write:inbox");
        if (scopeError) return scopeError;
        const row = state.messages.find((m) => m.id === action.payload.id);
        if (!row) return errorBody(c, 404, "not_found", "message not found");
        const at = nowIso();
        row.deliveredAt ??= at;
        if (action.payload.state === "read" || action.payload.state === "acted") row.readAt ??= at;
        if (action.payload.state === "acted") row.actedAt ??= at;
        return { id: row.id, version: 2 };
      }
      case "queue.enqueue": {
        const scopeError = requireScope(c, p, "write:queue");
        if (scopeError) return scopeError;
        const projectId = String(action.payload.projectId ?? "");
        if (!state.projects.some((x) => x.id === projectId))
          return errorBody(c, 404, "not_found", "project not found");
        const row: QueueItem = {
          id: nextId("queue"),
          projectId,
          humanId: p.kind === "device" ? p.device.ownerHumanId : HUMAN_J.id,
          kind: String(action.payload.kind ?? "note"),
          text: String(action.payload.text ?? ""),
          priority: Number(action.payload.priority ?? 0),
          status: "queued",
          createdAt: nowIso(),
          version: 1,
        };
        state.queue.push(row);
        return { id: row.id, version: 1 };
      }
      case "remote.enqueue": {
        const scopeError = requireScope(c, p, "write:remote");
        if (scopeError) return scopeError;
        const row = enqueueRemote(c, p, action.payload as Parameters<typeof enqueueRemote>[2]);
        if (row instanceof Response) return row;
        return { id: row.id, version: row.version, status: row.status };
      }
      default:
        return errorBody(c, 400, "validation", `unknown action kind ${action.kind}`);
    }
  };

  app.notFound((c) =>
    c.json(
      { code: "not_found", message: `no route ${c.req.method} ${c.req.path}`, details: {} },
      404,
    ),
  );

  const close = () => {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    state.listeners.clear();
  };

  return { app, state, adminToken, startPairing, pickUp, complete, close };
}

export type FakeStateService = ReturnType<typeof createFakeStateService>;

export interface RunningFakeStateService {
  url: string;
  adminToken: string;
  port: number;
  close(): Promise<void>;
}

export function startFakeStateService(
  options: FakeStateOptions & { port?: number } = {},
): Promise<RunningFakeStateService> {
  const service = createFakeStateService(options);
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: service.app.fetch, hostname: "127.0.0.1", port: options.port ?? 0 },
      (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          adminToken: service.adminToken,
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              service.close();
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
  /fake-state-service\.(ts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  const port = Number(process.env.FAKE_STATE_PORT ?? "0");
  const adminToken = process.env.FAKE_STATE_ADMIN_TOKEN;
  const pcMs = Number(process.env.FAKE_STATE_PC_MS ?? "300");
  startFakeStateService({
    port: Number.isFinite(port) ? port : 0,
    adminToken: adminToken || undefined,
    pcAutoCompleteMs: Number.isFinite(pcMs) && pcMs >= 0 ? pcMs : 300,
  })
    .then((running) => {
      console.log(`fake state service listening on ${running.url}`);
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
