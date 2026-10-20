/**
 * The desktop UI's door into an install of the scenario world (phase 5 gate, ADR 0045): the
 * daemon's own Hono app (`createDaemonApp`, `packages/runtime/src/daemon/server.ts`) over a
 * `RuntimeApp` assembled from the install's parts, so the simulated week is driven through
 * the routes the React UI calls (`apps/ui/src/api/client.ts`), never through the registry or
 * the store directly. `composeRuntime` binds an install to the store's first human, which is
 * why the scenario world assembles its two installs by hand (testing.md, Scenarios, Known
 * issues); this module does the same for the daemon layer on top of one install.
 *
 * What is real: the store, the clock, the tokens, the kill switch, the hooks, the driver, the
 * providers, the registry, the scheduler, the runner, the executor, the critic, the memory
 * loop, the command loop, the conversation agent, the notifier, the shells counter, the event
 * bus, the identity, the app version, `syncApprovals` (the blocked-findings and memory halves,
 * the two the week can reach) and `refreshMirrorSchedules` (no mirror settings: nothing to
 * schedule). What the week never opens (the Extensions panel, updates, the model watch, the
 * Cloudflare panel, desktop control, the Data tab, costs, the mirror, the sandbox, the schema
 * sync gate, the vault) is an `absent` stand-in: a route that reaches it fails with a clear
 * `unavailable` error naming the field, so a gap in the harness is a failure, never a silent
 * stub. `/health` reads several of them and is not part of the week.
 */
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { appDirs, ForerunnerError, join } from "@forerunner/platform";
import {
  type CommandLoop,
  type ConversationAgent,
  createDaemonApp,
  type DaemonServerOptions,
  type RemoteCommandWatcher,
  type RuntimeApp,
  ShellPresence,
  syncBlockedByFindings,
} from "@forerunner/runtime";
import type {
  ChangeLogView,
  ChatReplyView,
  CommandConfirmBody,
  CommandExecuteBody,
  CommandResultJson,
  HumanRequestView,
  InboxView,
  PendingChangeView,
  ProjectCard,
  SessionView,
  TaskView,
} from "@forerunner/runtime/daemon/api-types";
import type { DeviceRow } from "@forerunner/state";
import { SCENARIO_CHF_PER_USD } from "./scenario-commands.ts";
import type { ScenarioNotifier } from "./scenario-notify.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

export const SCENARIO_APP_VERSION = "1.0.0-scenario";

/**
 * A stand-in for a `RuntimeApp` field the week never reaches. Reading a property of it gives
 * another stand-in (the daemon's constructor stores references such as `rt.extensions.catalog`
 * without using them); calling one throws `unavailable` with the path, so a route that needs
 * the real thing fails visibly.
 */
export function absent(path: string): never {
  const fail = (): never => {
    throw new ForerunnerError(
      "unavailable",
      `the phase 5 harness stands in for no ${path}: the route that needs it is outside the simulated week`,
      { details: { path } },
    );
  };
  const target = (): undefined => undefined;
  return new Proxy(target, {
    get: (_t, prop) => {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return absent(`${path}.${String(prop)}`);
    },
    apply: fail,
    construct: fail,
  }) as never;
}

export interface DaemonDeps {
  commands: CommandLoop;
  conversation: ConversationAgent;
  notifier: ScenarioNotifier;
  /** The daemon's own `desktop` device row and watcher, when the install has them. */
  pcDevice?: DeviceRow | null;
  watcher?: RemoteCommandWatcher | null;
}

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

/** The UI's client, over the daemon app in process: the same paths and bodies as `apps/ui`. */
export class UiClient {
  /** Every call made, for the evidence (method, path, status). */
  readonly calls: { method: string; path: string; status: number }[] = [];

  constructor(
    readonly app: ReturnType<typeof createDaemonApp>["app"],
    readonly token: string,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<JsonResponse<T>> {
    const res = await this.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    this.calls.push({ method, path, status: res.status });
    return { status: res.status, body: parsed as T };
  }

  /** A call the UI expects to succeed; the status and body are in the error otherwise. */
  async ok<T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (r.status !== expected) {
      throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body;
  }

  me(): Promise<{ id: string; activeProjectId: string | null; agent: { id: string } }> {
    return this.ok("GET", "/me");
  }
  projects(): Promise<ProjectCard[]> {
    return this.ok("GET", "/projects");
  }
  inbox(): Promise<InboxView> {
    return this.ok("GET", "/inbox");
  }
  markRead(messageId: string): Promise<unknown> {
    return this.ok("POST", `/messages/${messageId}/read`, {});
  }
  createTask(projectId: string, body: CreateTaskInput): Promise<TaskView> {
    return this.ok("POST", `/projects/${projectId}/tasks`, body, 201);
  }
  transitionTask(taskId: string, body: { version: number; to: string; reason?: string }) {
    return this.ok<TaskView>("POST", `/tasks/${taskId}/transition`, body);
  }
  startSession(body: {
    agentId: string;
    projectId?: string;
    budgetUsdMicro?: number;
    trigger?: "manual" | "remote";
    reason?: string;
  }): Promise<{ result: string }> {
    return this.ok("POST", "/sessions", body, 202);
  }
  session(id: string): Promise<SessionView> {
    return this.ok("GET", `/sessions/${id}`);
  }
  chat(body: {
    humanId: string;
    agentId: string;
    projectId?: string;
    text: string;
    source?: "text" | "voice" | "phone";
  }): Promise<ChatReplyView> {
    return this.ok("POST", "/chat", body);
  }
  executeCommands(body: CommandExecuteBody): Promise<CommandResultJson> {
    return this.ok("POST", "/commands/execute", body);
  }
  confirmCommand(pendingId: string, body: CommandConfirmBody): Promise<CommandResultJson> {
    return this.ok("POST", `/commands/${pendingId}/confirm`, body);
  }
  pendingCommands(): Promise<PendingChangeView[]> {
    return this.ok("GET", "/commands/pending");
  }
  changes(query: { projectId?: string; undoable?: boolean; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (query.projectId) params.set("projectId", query.projectId);
    if (query.undoable) params.set("undoable", "true");
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.ok<ChangeLogView[]>("GET", `/changes${qs ? `?${qs}` : ""}`);
  }
  undoChange(changeId: string): Promise<CommandResultJson> {
    return this.ok("POST", `/changes/${changeId}/undo`, {});
  }
  requests(): Promise<HumanRequestView[]> {
    return this.inbox().then((i) => i.requests);
  }
  /** The header's "Resume" after a kill. */
  resumeKill(): Promise<{ killActive: boolean; ok: boolean }> {
    return this.ok("POST", "/kill/resume", {});
  }
}

/** `CreateTaskBody` of the daemon (`api-types.ts`), as the New task dialog fills it. */
export interface CreateTaskInput {
  title: string;
  outcome: string;
  acceptanceCriteria?: string[];
  riskTier?: number;
  priority?: number;
  milestoneId?: string;
  dependsOn?: string[];
  budgetUsdMicro?: number;
  status?: "draft" | "ready";
}

export interface ScenarioDaemon {
  rt: RuntimeApp;
  app: ReturnType<typeof createDaemonApp>["app"];
  token: string;
  /** The UI's calls. */
  ui: UiClient;
  close(): void;
}

/** The daemon app of one install of the world; see the module comment for what is real. */
export function daemonFor(
  world: ScenarioWorld,
  install: Install,
  deps: DaemonDeps,
  opts: DaemonServerOptions = {},
): ScenarioDaemon {
  const { store, clock } = world;
  const home = join(world.root, `daemon-${install.name.toLowerCase()}`);
  mkdirSync(home, { recursive: true });
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const humanId = install.human.id;
  const agentId = install.agent.id;
  const real: Partial<RuntimeApp> = {
    dirs,
    config: null,
    clock,
    store,
    tokens: install.tokens,
    kill: install.kill,
    hooks: install.hooks,
    driver: install.driver,
    providers: world.providers,
    provider: world.gated,
    registry: world.registry,
    specialistDriver: "loop",
    executor: install.executor,
    runner: install.runner,
    scheduler: install.scheduler,
    conversation: deps.conversation,
    gitHost: install.github,
    human: { id: humanId, name: install.human.name, timezone: install.human.timezone },
    agent: { id: agentId, name: install.agent.name },
    billingSourceId: `bs-${install.name.toLowerCase()}`,
    chfPerUsd: () => SCENARIO_CHF_PER_USD,
    events,
    appVersion: SCENARIO_APP_VERSION,
    startedAt: clock.now(),
    critic: install.critic,
    criticAgent: install.criticAgent,
    ...(install.memory ? { memory: install.memory } : {}),
    commands: deps.commands,
    notifier: deps.notifier.notifier,
    notifications: deps.notifier.producers,
    shells: new ShellPresence(),
    remote: {
      enabled: deps.watcher !== undefined && deps.watcher !== null,
      device: deps.pcDevice ?? null,
      watcher: deps.watcher ?? null,
      presence: null,
    },
    syncApprovals: async () => ({
      extensions: { approved: [], denied: [] },
      modelWatch: 0,
      memory: install.memory
        ? await install.memory.syncApprovals()
        : { applied: 0, skipped: 0, stale: 0 },
      findings: await syncBlockedByFindings({ store, clock, humanId, agentId }),
    }),
    refreshMirrorSchedules: async () => [],
    close: async () => undefined,
  };
  const ABSENT = [
    "vault",
    "specialists",
    "tools",
    "toolsForRun",
    "billing",
    "context",
    "costLedger",
    "extensions",
    "gate",
    "updates",
    "updateConfig",
    "restarter",
    "schemaSync",
    "modelWatch",
    "modelConfig",
    "pricingTable",
    "estimates",
    "desktop",
    "data",
    "mirror",
    "sandbox",
    "mirrorSync",
    ...(install.memory ? [] : ["memory"]),
  ] as const;
  const view: Record<string, unknown> = { ...real };
  for (const name of ABSENT) view[name] = absent(`rt.${name}`);
  const rt = view as unknown as RuntimeApp;
  const { app, token, closeStreams } = createDaemonApp(rt, opts);
  return { rt, app, token, ui: new UiClient(app, token), close: closeStreams };
}
