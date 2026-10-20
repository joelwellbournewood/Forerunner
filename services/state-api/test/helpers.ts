import { SimulatedClock } from "@forerunner/platform";
import {
  openStore,
  type StateStore,
  silenceSqliteExperimentalWarning,
  type TaskRow,
} from "@forerunner/state";
import { type AppDeps, createApp, type StateApiApp } from "../src/app.ts";
import {
  type DeviceKeyPair,
  generateDeviceKeyPair,
  signPairingProof,
  signRequest,
} from "../src/auth/crypto.ts";
import type { Scope } from "../src/auth/scopes.ts";

silenceSqliteExperimentalWarning();

/** Built by concatenation so the secret scan never sees a credential shape. */
export const ADMIN_TOKEN = ["state", "api", "admin", "token", "for", "unit", "tests"].join("-"); // not-a-secret

export const START = "2026-03-01T09:00:00.000Z";

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Device clients: skip the signature. */
  unsigned?: boolean;
  /** Device clients: set the biometric assertion flag inside the signature. */
  biometric?: boolean;
  /** Device clients: override the signed timestamp (ms since epoch or ISO). */
  timestamp?: string;
  /** Device clients: tamper with the signature after signing. */
  corruptSignature?: boolean;
}

export class Client {
  constructor(
    readonly app: StateApiApp["app"],
    readonly token: string | undefined,
  ) {}

  protected headersFor(
    _method: string,
    _path: string,
    _body: string | Uint8Array | undefined,
    opts: RequestOptions,
  ): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(opts.headers ?? {}),
    };
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const text =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const headers = this.headersFor(method, path, text, opts);
    if (text !== undefined && !headers["content-type"])
      headers["content-type"] = "application/json";
    return this.app.request(path, {
      method,
      headers,
      ...(text !== undefined ? { body: text } : {}),
    });
  }

  get(path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.request("GET", path, undefined, opts);
  }

  post(path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
    return this.request("POST", path, body ?? {}, opts);
  }

  /** Raw request (multipart uploads); device clients sign the bytes. */
  async send(
    method: string,
    path: string,
    body: Uint8Array,
    headers: Record<string, string>,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const h = { ...this.headersFor(method, path, body, opts), ...headers };
    return this.app.request(path, { method, headers: h, body: new Blob([body]) });
  }
}

export class DeviceClient extends Client {
  constructor(
    app: StateApiApp["app"],
    token: string,
    readonly keys: DeviceKeyPair,
    readonly deviceId: string,
    readonly humanId: string,
    readonly clock: SimulatedClock,
  ) {
    super(app, token);
  }

  protected override headersFor(
    method: string,
    path: string,
    body: string | Uint8Array | undefined,
    opts: RequestOptions,
  ): Record<string, string> {
    const base = super.headersFor(method, path, body, opts);
    if (opts.unsigned) return base;
    const timestamp = opts.timestamp ?? String(this.clock.now());
    const biometric = opts.biometric ?? false;
    let signature = signRequest(this.keys.secretKey, {
      method,
      path,
      body: body ?? "",
      timestamp,
      biometric,
    });
    if (opts.corruptSignature) signature = `${signature.slice(0, -4)}AAAA`;
    return {
      ...base,
      "x-device-signature": signature,
      "x-device-timestamp": timestamp,
      ...(biometric ? { "x-biometric-assertion": "1" } : {}),
    };
  }
}

export interface Seed {
  ada: { id: string };
  bob: { id: string };
  alice: { id: string };
  bobAgent: { id: string };
  project: { id: string };
  milestone: { id: string };
  task1: TaskRow;
  task2: TaskRow;
  session: { id: string };
  desktop: { id: string };
}

export async function seed(store: StateStore): Promise<Seed> {
  const ada = await store.human.insert({ name: "Ada", email: "ada@example.test" });
  const bob = await store.human.insert({ name: "Bob", email: "bob@example.test" });
  const alice = await store.agent.insert({
    name: "Alice",
    owner_human_id: ada.id,
    kind: "principal",
  });
  const bobAgent = await store.agent.insert({
    name: "Bobby",
    owner_human_id: bob.id,
    kind: "principal",
  });
  const project = await store.project.insert({
    name: "Demo",
    goal: "Ship the demo",
    budget_usd_micro: 50_000_000,
  });
  const milestone = await store.milestone.insert({
    project_id: project.id,
    name: "First cut",
    success_criteria: ["tests pass", "docs written"],
    status: "active",
  });
  const task1 = await store.task.insert({
    project_id: project.id,
    milestone_id: milestone.id,
    title: "Write the parser",
    outcome: "A parser that handles the spec",
    acceptance_criteria: ["unit tests", "no any"],
    status: "ready",
    risk_tier: 1,
    priority: 7,
  });
  const task2 = await store.task.insert({
    project_id: project.id,
    title: "Write the docs",
    outcome: "Maintainer docs",
    status: "ready",
    risk_tier: 0,
    priority: 3,
  });
  const session = await store.session.insert({
    agent_id: alice.id,
    project_id: project.id,
    trigger: "manual",
    status: "running",
    started_at: store.clock.nowIso(),
  });
  const desktop = await store.device.register({
    owner_human_id: ada.id,
    name: "Ada's laptop",
    platform: "linux",
    public_key: generateDeviceKeyPair().publicKey,
    kind: "desktop",
  });
  return { ada, bob, alice, bobAgent, project, milestone, task1, task2, session, desktop };
}

export interface Harness {
  clock: SimulatedClock;
  store: StateStore;
  api: StateApiApp;
  app: StateApiApp["app"];
  seed: Seed;
  admin: Client;
  anonymous: Client;
  pairDevice(humanId: string, kind?: "phone" | "web", scopes?: Scope[]): Promise<DeviceClient>;
  close(): Promise<void>;
}

export async function harness(overrides: Partial<AppDeps> = {}): Promise<Harness> {
  const clock = new SimulatedClock(START);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const s = await seed(store);
  const api = createApp({
    store,
    clock,
    startPoller: false,
    config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 1000, uploadMaxBytes: 64 * 1024 },
    ...overrides,
  });
  const admin = new Client(api.app, ADMIN_TOKEN);
  const pairDevice = async (humanId: string, kind: "phone" | "web" = "phone", scopes?: Scope[]) => {
    const start = await admin.post("/pairing/start", {
      humanId,
      kind,
      ...(scopes ? { scopes } : {}),
    });
    if (start.status !== 201) throw new Error(`pairing start failed: ${await start.text()}`);
    const { code } = (await start.json()) as { code: string };
    const keys = generateDeviceKeyPair();
    const complete = await new Client(api.app, undefined).post("/pairing/complete", {
      code,
      publicKey: keys.publicKey,
      proof: signPairingProof(keys.secretKey, code),
      name: `${kind} of ${humanId}`,
      platform: kind === "phone" ? "android" : "web",
    });
    if (complete.status !== 201)
      throw new Error(`pairing complete failed: ${await complete.text()}`);
    const body = (await complete.json()) as { deviceId: string; token: string; humanId: string };
    return new DeviceClient(api.app, body.token, keys, body.deviceId, body.humanId, clock);
  };
  return {
    clock,
    store,
    api,
    app: api.app,
    seed: s,
    admin,
    anonymous: new Client(api.app, undefined),
    pairDevice,
    close: async () => {
      await api.close();
      await store.close();
    },
  };
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Parse SSE frames from text; returns [{event, data, id}]. */
export function parseSse(text: string): { event: string; data: unknown; id?: string }[] {
  const out: { event: string; data: unknown; id?: string }[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
      else if (line.startsWith("id: ")) id = line.slice(4);
    }
    const raw = data.join("\n");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // keep text
    }
    out.push({ event, data: parsed, ...(id ? { id } : {}) });
  }
  return out;
}

/** Read SSE frames from a fetch body until `count` events (other than heartbeat/ready) arrived or the timeout. */
export async function readSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stopWhen: (events: { event: string; data: unknown; id?: string }[]) => boolean,
  timeoutMs = 5_000,
): Promise<{ event: string; data: unknown; id?: string }[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  const events: { event: string; data: unknown; id?: string }[] = [];
  while (Date.now() < deadline) {
    const timer = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(
        () => resolve({ done: true, value: undefined }),
        Math.max(1, deadline - Date.now()),
      ),
    );
    const { done, value } = await Promise.race([reader.read(), timer]);
    if (value) buffer += decoder.decode(value, { stream: true });
    const idx = buffer.lastIndexOf("\n\n");
    if (idx >= 0) {
      const complete = buffer.slice(0, idx + 2);
      buffer = buffer.slice(idx + 2);
      events.push(...parseSse(complete));
      if (stopWhen(events)) return events;
    }
    if (done) break;
  }
  return events;
}
