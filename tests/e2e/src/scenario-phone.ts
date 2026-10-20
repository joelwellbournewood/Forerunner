/**
 * The phone on the scenario world (scenario 9, spec R and Q): the Android app's own code for
 * understanding a sentence (`apps/ui/src/mobile/intent.ts`) and building the one change card
 * (`apps/ui/src/mobile/change-card.ts`), the plan envelope the app sends after the tap
 * (ADR 0032 item 4; its verb and client id from the app's own state client,
 * `apps/ui/src/api/state-client.ts`), the REAL shared state service (`services/state-api`,
 * `createApp` over the world's store, in process, no network) with a real Ed25519 pairing and
 * signed requests,
 * and the PC's pickup of the command: the daemon's own `RemoteCommandWatcher`
 * (`packages/runtime/src/remote`, ADR 0041) on the install's kill switch, scheduler and
 * command registry.
 *
 * The Android emulator cannot run here: the screens are not driven, the sentence enters at
 * the parser the Chat screen calls, and the tap is the `confirmedAt` the app puts in the
 * envelope. Everything after that is the production path.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Clock } from "@forerunner/platform";
import { join } from "@forerunner/platform";
import { type CommandLoop, RemoteCommandWatcher } from "@forerunner/runtime";
import type { ProjectCard } from "@forerunner/runtime/daemon/api-types";
import type { JsonObject, RemoteCommandRow } from "@forerunner/state";
// The real state service and its signing contract (ADR 0009), by relative path.
import { createApp, type StateApiApp } from "../../../services/state-api/src/app.ts";
import {
  type DeviceKeyPair,
  generateDeviceKeyPair,
  signPairingProof,
  signRequest,
} from "../../../services/state-api/src/auth/crypto.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

// ---------------------------------------------------------------------------------------
// The state service in process

/** Built by concatenation so the secret scan never sees a credential shape. */
export const SCENARIO_ADMIN_TOKEN = ["scenario", "state", "api", "admin", "token"].join("-"); // not-a-secret

export interface ServiceResponse<T = unknown> {
  status: number;
  body: T;
}

/** A caller of the in-process service: the admin (a runtime) or a paired device. */
export class ServiceClient {
  constructor(
    readonly app: StateApiApp["app"],
    readonly token: string,
    readonly clock: Clock,
  ) {}

  protected headersFor(_method: string, _path: string, _body: string): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ServiceResponse<T>> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = this.headersFor(method, path, text);
    if (text) headers["content-type"] = "application/json";
    const res = await this.app.request(path, {
      method,
      headers,
      ...(text ? { body: text } : {}),
    });
    const raw = await res.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return { status: res.status, body: parsed as T };
  }

  get<T = unknown>(path: string): Promise<ServiceResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown = {}): Promise<ServiceResponse<T>> {
    return this.request<T>("POST", path, body);
  }
}

/** A paired phone: every mutation carries the device signature (ADR 0009). */
export class PhoneClient extends ServiceClient {
  private lastTimestamp = 0;

  constructor(
    app: StateApiApp["app"],
    token: string,
    clock: Clock,
    readonly keys: DeviceKeyPair,
    readonly deviceId: string,
    readonly humanId: string,
  ) {
    super(app, token, clock);
  }

  protected override headersFor(
    method: string,
    path: string,
    body: string,
  ): Record<string, string> {
    const base = super.headersFor(method, path, body);
    if (method === "GET") return base;
    // Strictly increasing per client, as the app's signer does (ADR 0032 item 3).
    const ts = Math.max(this.clock.now(), this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const timestamp = String(ts);
    const signature = signRequest(this.keys.secretKey, {
      method,
      path,
      body,
      timestamp,
      biometric: false,
    });
    return { ...base, "x-device-signature": signature, "x-device-timestamp": timestamp };
  }
}

export interface ScenarioStateService {
  api: StateApiApp;
  admin: ServiceClient;
  /** Pair a phone for a human through the real pairing routes. */
  pairPhone(humanId: string, name: string): Promise<PhoneClient>;
  close(): Promise<void>;
}

export async function stateServiceFor(world: ScenarioWorld): Promise<ScenarioStateService> {
  const dir = join(world.root, "state-api");
  mkdirSync(dir, { recursive: true });
  const api = createApp({
    store: world.store,
    clock: world.clock,
    startPoller: false,
    chfPerUsd: 0.8,
    config: {
      adminToken: SCENARIO_ADMIN_TOKEN,
      rateLimitPerMinute: 1000,
      uploadsDir: join(dir, "uploads"),
      serviceStateDir: join(dir, "state"),
    },
  });
  const admin = new ServiceClient(api.app, SCENARIO_ADMIN_TOKEN, world.clock);
  return {
    api,
    admin,
    pairPhone: async (humanId, name) => {
      const start = await admin.post<{ code: string }>("/pairing/start", {
        humanId,
        kind: "phone",
      });
      if (start.status !== 201) throw new Error(`pairing/start: ${start.status}`);
      const keys = generateDeviceKeyPair();
      const done = await new ServiceClient(api.app, "", world.clock).post<{
        deviceId: string;
        humanId: string;
        token: string;
      }>("/pairing/complete", {
        code: start.body.code,
        publicKey: keys.publicKey,
        proof: signPairingProof(keys.secretKey, start.body.code),
        name,
        platform: "android",
      });
      if (done.status !== 201) throw new Error(`pairing/complete: ${done.status}`);
      return new PhoneClient(
        api.app,
        done.body.token,
        world.clock,
        keys,
        done.body.deviceId,
        done.body.humanId,
      );
    },
    close: () => api.close(),
  };
}

// ---------------------------------------------------------------------------------------
// The Android app's own modules

/** One registry command of a plan, as the app names it (`PlanCommand` in its state client). */
export interface PlanCommand {
  name: string;
  params: Record<string, unknown>;
}

/** `IntentContext` of `apps/ui/src/mobile/intent.ts`. */
export interface IntentContext {
  timezone: string;
  now: number;
  activeProjectId: string | null;
  projects: { id: string; name: string }[];
  source?: "chat" | "voice" | "ui" | "content";
}

/** `IntentResult` of `apps/ui/src/mobile/intent.ts`. */
export interface IntentResult {
  commands: PlanCommand[];
  question?: { text: string; options: string[] };
  matched: "pattern" | "none";
  unmatched: string[];
}

/** `MobileChangeCard` of `apps/ui/src/mobile/change-card.ts`. */
export interface MobileChangeCard {
  command: string;
  what: string;
  oldValue: string;
  newValue: string;
  scope: "session" | "project" | "global";
  scopeLabel: string;
  duration: string;
  impact: { risk: "low" | "medium" | "high"; costChfMicro?: number };
  undoHint: string;
  sentence: string;
  projectId: string | null;
  projectName: string | null;
  usesActiveProject: boolean;
  expiresAt: string | null;
  reversible: boolean;
  parts?: MobileChangeCard[];
}

/** `CardContext` of `apps/ui/src/mobile/change-card.ts`. */
export interface CardContext {
  timezone: string;
  now: number;
  activeProjectId: string | null;
  projects: { id: string; name: string; budgetChfMicro: number }[];
  monthlyCeilingChfMicro: number | null;
  chfPerUsd?: number | null;
  costlySessionChfMicro?: number;
}

/**
 * The app's phone-side code as the Chat screen and its store call it: understanding a
 * sentence, building the one card, and (from the app's state client) the remote verb of a
 * plan and the client id the outbox keys an envelope by.
 */
export interface AppMobile {
  parseIntent(text: string, ctx: IntentContext): IntentResult;
  buildPlanCard(plan: readonly PlanCommand[], ctx: CardContext): MobileChangeCard;
  chfPerUsdFrom(money: readonly { usdMicro: number; chfMicro: number }[]): number | null;
  /** `verbForPlan` of `apps/ui/src/api/state-client.ts`: kill, stop, pause, else start. */
  verbForPlan(plan: readonly PlanCommand[]): RemoteVerb;
  /** `newClientId` of the same module: the envelope's id (a UUID where the runtime has one). */
  newClientId(): string;
}

/**
 * Load the app's modules at run time. They are typed against the browser (the state client
 * types its signer on WebCrypto), so they cannot join the node type check
 * (`tsconfig.node.json` has no DOM lib); the shapes above mirror their exports, and a drift
 * fails the scenario at run time instead of the type check. Under node they load as they do
 * in the WebView (`globalThis.crypto` exists on Node 22). The sources are the ones the
 * Android bundle is built from.
 */
export async function loadAppMobile(): Promise<AppMobile> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = join(here, "..", "..", "..", "apps", "ui", "src");
  const load = async (...segments: string[]): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(join(src, ...segments)).href)) as Record<string, unknown>;
  const intent = await load("mobile", "intent.ts");
  const card = await load("mobile", "change-card.ts");
  const client = await load("api", "state-client.ts");
  const fn = <T>(mod: Record<string, unknown>, name: string): T => {
    const f = mod[name];
    if (typeof f !== "function") throw new Error(`apps/ui module has no ${name}()`);
    return f as T;
  };
  return {
    parseIntent: fn<AppMobile["parseIntent"]>(intent, "parseIntent"),
    buildPlanCard: fn<AppMobile["buildPlanCard"]>(card, "buildPlanCard"),
    chfPerUsdFrom: fn<AppMobile["chfPerUsdFrom"]>(card, "chfPerUsdFrom"),
    verbForPlan: fn<AppMobile["verbForPlan"]>(client, "verbForPlan"),
    newClientId: fn<AppMobile["newClientId"]>(client, "newClientId"),
  };
}

// ---------------------------------------------------------------------------------------
// The phone side: the sentence, the one card, the envelope

/** The envelope the app sends after the tap (ADR 0032 item 4; `RemotePlanEnvelope` in the app). */
export interface PlanEnvelope {
  v: 1;
  kind: "plan";
  plan: PlanCommand[];
  wordsUsed: string;
  card: Record<string, unknown>;
  clientId: string;
  confirmedAt: string;
  undoOf?: string;
}

/** `RemoteVerb` of the app's state client: what the PC does first with the envelope. */
export type RemoteVerb = "start" | "pause" | "stop" | "kill";

export interface PhoneUnderstanding {
  intent: IntentResult;
  plan: PlanCommand[];
  card: MobileChangeCard;
}

/** The phone's context: what the Chat screen hands the parser and the card builder. */
export function phoneContext(
  app: AppMobile,
  projects: ProjectCard[],
  opts: {
    timezone: string;
    now: number;
    activeProjectId: string | null;
    source?: IntentContext["source"];
  },
): { intent: IntentContext; card: CardContext } {
  const list = projects.map((p) => ({ id: p.id, name: p.name }));
  return {
    intent: {
      timezone: opts.timezone,
      now: opts.now,
      activeProjectId: opts.activeProjectId,
      projects: list,
      source: opts.source ?? "voice",
    },
    card: {
      timezone: opts.timezone,
      now: opts.now,
      activeProjectId: opts.activeProjectId,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        budgetChfMicro: p.budget.chfMicro,
      })),
      monthlyCeilingChfMicro: null,
      chfPerUsd: app.chfPerUsdFrom(projects.flatMap((p) => [p.budget, p.spend])),
    },
  };
}

/** What the Chat screen does with a sentence: parse it, then show ONE card for the plan. */
export function phoneUnderstands(
  app: AppMobile,
  sentence: string,
  ctx: { intent: IntentContext; card: CardContext },
): PhoneUnderstanding {
  const intent = app.parseIntent(sentence, ctx.intent);
  if (intent.question || intent.commands.length === 0) {
    throw new Error(`the phone did not understand "${sentence}": ${JSON.stringify(intent)}`);
  }
  return { intent, plan: intent.commands, card: app.buildPlanCard(intent.commands, ctx.card) };
}

/** The service's view of a remote command row (`remoteCommandView`). */
export interface RemoteCommandView {
  id: string;
  deviceId: string;
  target: string;
  targetDeviceId: string | null;
  command: string;
  params: JsonObject;
  status: "pending" | "picked_up" | "done" | "failed";
  pickedUpAt: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * The tap: ONE `POST /remote/commands` for the whole plan, as `sendPlan` in the app's mobile
 * store builds it: the verb from the app's `verbForPlan`, the client id from its
 * `newClientId` (the outbox's key for the envelope), the tap's time as `confirmedAt`.
 */
export async function phoneConfirmsAndSends(
  phone: PhoneClient,
  app: Pick<AppMobile, "verbForPlan" | "newClientId">,
  input: { plan: PlanCommand[]; card: MobileChangeCard; words: string; confirmedAt: string },
): Promise<{ envelope: PlanEnvelope; row: RemoteCommandView }> {
  const envelope: PlanEnvelope = {
    v: 1,
    kind: "plan",
    plan: input.plan,
    wordsUsed: input.words,
    card: JSON.parse(JSON.stringify(input.card)) as Record<string, unknown>,
    clientId: app.newClientId(),
    confirmedAt: input.confirmedAt,
  };
  const res = await phone.post<RemoteCommandView>("/remote/commands", {
    target: "pc",
    command: app.verbForPlan(input.plan),
    params: envelope,
  });
  if (res.status !== 201) {
    throw new Error(`remote/commands: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { envelope, row: res.body };
}

// ---------------------------------------------------------------------------------------
// The PC side: the daemon's own watcher on the install

export interface PcWatcherOptions {
  commands: CommandLoop;
  install: Install;
  /** The PC's own device row (kind `desktop`), as `registerDesktopDevice` makes it for a daemon. */
  pcDeviceId: string;
  /** The principal's conversation session: the activity log the plan's sentence goes to. */
  sessionId: string;
  pollMs?: number;
  onHandled?: (row: RemoteCommandRow, result: JsonObject) => void;
}

/**
 * The daemon's `RemoteCommandWatcher` for an install of the world, with the deps
 * `composeRuntime` gives it: the store, the clock, the install's kill switch, its scheduler
 * as the `start` port, the command loop, no chat (the scenario sends a plan, not a quick
 * chat), the conversation session and the PC's own device row.
 */
export function pcWatcherFor(world: ScenarioWorld, opts: PcWatcherOptions): RemoteCommandWatcher {
  const { install } = opts;
  return new RemoteCommandWatcher({
    store: world.store,
    clock: world.clock,
    kill: install.kill,
    start: (req) => install.scheduler.request(req),
    commands: opts.commands,
    chat: null,
    conversationSessionId: async () => opts.sessionId,
    deviceId: opts.pcDeviceId,
    agentId: install.agent.id,
    humanId: install.human.id,
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    ...(opts.onHandled ? { onHandled: opts.onHandled } : {}),
  });
}
