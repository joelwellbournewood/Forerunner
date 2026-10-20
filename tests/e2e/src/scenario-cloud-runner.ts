/**
 * The cloud runner of an install, composed in-process against the scenario world's shared
 * store (spec "Run modes" hybrid and cloud only; ADR 0026, ADR 0033; scenario 2 "Email task").
 *
 * `startCloudRunner` (services/cloud-runner/src/runner.ts) opens its own store connection by
 * URL; the scenario world's store is `sqlite::memory:` and cannot be reached by a second
 * connection, so this helper composes the runner's parts on the world's store instead, the way
 * `runner.ts` does: the runner's own `device` row (kind "runner"), the PC-wins presence rule
 * (`PcPresence`), the agent mailbox watcher (`EmailWatch`, the cloud runner's own module with
 * the production `EmailCommandGate`, `EmailCommandHandler` and `EmailPolicy` inside) and the
 * `StartCloudSessionPort` that turns a verified email task into a session recorded with runner
 * "cloud" and the runner's device, planned on that task only (the runner's `FocusedPlanner`),
 * run by the install's own executor, critic and memory. Every limit is the production code
 * path: the per-email cap is the session cap, the email autonomy level the session's. The
 * planner is the runner's (`new StaticPlanner(500_000, estimates)`, runner.ts) with the
 * estimate model composed as `composeRuntime` composes it (learned from the store, cold start
 * from the registry). Keep this file in step with runner.ts; a `store` seam on
 * `startCloudRunner` would let the scenario run the real composition root instead.
 */
import { randomBytes } from "node:crypto";
import type {
  CloudSessionRequest,
  CloudSessionStarted,
  CommandOutcome,
  InboundEmail,
  StartCloudSessionPort,
} from "@forerunner/capabilities/email/index";
import { join } from "@forerunner/platform";
import {
  EstimateModel,
  type EstimatePort,
  type ModelProvider,
  modelIdFor,
  type Planner,
  type PlannerContext,
  type SessionResult,
  SessionRunner,
  StaticPlanner,
} from "@forerunner/runtime";
import type { DeviceRow, SessionRow } from "@forerunner/state";
// `@forerunner/vault` is not declared in tests/e2e/package.json and the cloud runner is a
// service, not a package: both are reached by relative path (the same sources runner.ts
// composes).
import { MemoryVault } from "../../../packages/vault/src/index.ts";
import {
  EmailWatch,
  type EmailWatchState,
} from "../../../services/cloud-runner/src/email-watch.ts";
import { PcPresence, type PresenceVerdict } from "../../../services/cloud-runner/src/presence.ts";
import type { AgentMailbox } from "./scenario-mail.ts";
import type { Install, ScenarioEvent, ScenarioWorld } from "./scenario-world.ts";
import { flatPricing } from "./world.ts";

export interface CloudRunnerOptions {
  /** Runner id (its device name); default "runner-scenario". */
  runnerId?: string;
  /** Mailbox poll interval in simulated ms (default 30 s); push delivery is on by default. */
  pollIntervalMs?: number;
  /** A PC counts as online when its desktop device row was seen within this (default 3 min). */
  pcOnlineMs?: number;
  /** Model provider the watcher classifies with (default the world's gated provider). */
  provider?: ModelProvider;
  /**
   * The estimate port the planner prices tasks with (runner.ts: `rt.estimates`); default an
   * `EstimateModel` over the world's store with the registry's cold-start defaults, as
   * `composeRuntime` builds it.
   */
  estimates?: EstimatePort;
}

export interface EmailOutcomeRecord {
  outcome: CommandOutcome;
  message: InboundEmail;
  /** Simulated time the watcher finished with the message. */
  at: string;
}

export interface CloudSessionRecord {
  request: CloudSessionRequest;
  started: CloudSessionStarted;
  result: Promise<SessionResult>;
}

export interface ScenarioCloudRunner {
  runnerId: string;
  device: DeviceRow;
  presence: PcPresence;
  watch: EmailWatch;
  dataDir: string;
  /** Every inbound message the watcher handled, in order, with the handler's outcome. */
  outcomes: EmailOutcomeRecord[];
  /** Every cloud session the email port started. */
  sessions: CloudSessionRecord[];
  status(): EmailWatchState & { handled: number; lastMessageAt: string | null };
  /** The PC-wins rule as the runner applies it before a schedule, manual or message start. */
  pcOnline(): Promise<PresenceVerdict>;
  stop(): Promise<void>;
}

/** Plans like the runner; an email-triggered session works on its email task only. */
class FocusedPlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly focus: Map<string, string>,
  ) {}
  async plan(ctx: PlannerContext) {
    const plan = await this.inner.plan(ctx);
    const taskId = this.focus.get(ctx.session.agent_id);
    if (ctx.session.trigger !== "email" || !taskId) return plan;
    this.focus.delete(ctx.session.agent_id);
    const items = plan.items.filter((i) => i.taskId === taskId);
    return {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      summary: `email task ${taskId}`,
    };
  }
}

export async function scenarioCloudRunner(
  world: ScenarioWorld,
  install: Install,
  mail: AgentMailbox,
  opts: CloudRunnerOptions = {},
): Promise<ScenarioCloudRunner> {
  const { store, clock } = world;
  const runnerId = opts.runnerId ?? "runner-scenario";
  const provider = opts.provider ?? world.gated;
  // The runner's own device row: sessions reference it and its `last_seen` is its heartbeat.
  const device = await store.device.register({
    owner_human_id: install.human.id,
    name: runnerId,
    platform: `${process.platform}-runner`,
    public_key: randomBytes(32).toString("base64"),
    kind: "runner",
  });
  await store.device.seen(device.id);
  const presence = new PcPresence({
    store,
    clock,
    humanId: install.human.id,
    agentId: install.agent.id,
    pcOnlineMs: opts.pcOnlineMs ?? 3 * 60_000,
  });
  const dataDir = join(world.root, `cloud-${runnerId}`, "data");

  // Sessions on this runner: the install's executor, critic and memory, recorded with runner
  // "cloud" and this device; the planner keeps an email session on its task and prices it as
  // the runner's does (the default estimate and the estimate model, runner.ts).
  const estimates =
    opts.estimates ??
    (await EstimateModel.fromStore(store, {
      defaults: (name) => {
        const d = world.registry.specialists.get(name);
        return d
          ? { maxBudgetUsd: d.max_budget_usd, timeoutMinutes: d.timeout_minutes }
          : undefined;
      },
    }));
  const focus = new Map<string, string>();
  const runner = new SessionRunner({
    store,
    clock,
    tokens: install.tokens,
    kill: install.kill,
    planner: new FocusedPlanner(new StaticPlanner(500_000, estimates), focus),
    executor: install.executor,
    critic: install.critic,
    ...(install.memory ? { memory: install.memory } : {}),
  });
  const sessions: CloudSessionRecord[] = [];
  const outcomes: EmailOutcomeRecord[] = [];
  let watch: EmailWatch | null = null;

  const cloudPort: StartCloudSessionPort = {
    start: async (req) => {
      if (req.humanId !== install.human.id || req.agentId !== install.agent.id) {
        throw new Error("this runner serves another human's agent");
      }
      if (install.kill.isFrozen({ agentId: install.agent.id })) {
        throw new Error("the kill switch is active; resume it first");
      }
      const t0 = clock.now();
      let startedResolve: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      focus.set(req.agentId, req.taskId);
      const result = runner.start({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: "email",
        budgetCapUsdMicro: req.capUsdMicro,
        autonomy: req.autonomyLevel,
        appVersion: "1.0.0-scenario",
        runner: "cloud",
        deviceId: device.id,
        grant: install.grant,
        onEvent: (type, payload) => {
          if (type === "session.started") startedResolve();
          const e: ScenarioEvent = {
            seq: world.events.length,
            agentId: install.agent.id,
            agentName: install.agent.name,
            projectId: req.projectId,
            trigger: "email",
            type,
            payload,
            at: clock.nowIso(),
          };
          world.events.push(e);
        },
      });
      result.then(
        async (r) => {
          const task = await store.task.get(req.taskId);
          await watch?.completed({
            sessionId: r.sessionId,
            summary: r.summary,
            prUrls: task?.pr_url ? [task.pr_url] : [],
            logUrl: `forerunner://sessions/${r.sessionId}`,
            costUsdMicro: r.spentUsdMicro,
          });
        },
        () => focus.delete(req.agentId),
      );
      await Promise.race([started, result.then(() => undefined)]);
      const [row] = await store.session.list(
        { agent_id: req.agentId, trigger: "email" },
        { orderBy: "created_at desc", limit: 1 },
      );
      if (!row || Date.parse(row.created_at) < t0 - 1_000) {
        throw new Error("the email session row was not found");
      }
      const record: CloudSessionRecord = {
        request: req,
        started: {
          sessionId: row.id,
          startsAt: clock.nowIso(),
          logUrl: `forerunner://sessions/${row.id}`,
        },
        result,
      };
      sessions.push(record);
      return record.started;
    },
  };

  const workingModel = modelIdFor("sonnet", provider.name);
  watch = new EmailWatch({
    store,
    clock,
    // The runner's vault holds its mailbox credentials by reference; the test mailbox needs none.
    vault: new MemoryVault(),
    provider,
    agentId: install.agent.id,
    humanId: install.human.id,
    cloud: cloudPort,
    pricing: flatPricing,
    estimateModel: workingModel,
    classifierModel: modelIdFor("haiku", provider.name),
    rates: { chfPerUsd: async () => 0.8 },
    dataDir,
    pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    push: true,
    verifier: mail.verifier,
    mailboxFactory: mail.mailboxFactory,
    onOutcome: (outcome, message) => outcomes.push({ outcome, message, at: clock.nowIso() }),
  });
  const state = await watch.start();
  if (state.state !== "watching") {
    throw new Error(`the cloud runner's mail watch did not start: ${state.reason}`);
  }
  const theWatch = watch;
  return {
    runnerId,
    device,
    presence,
    watch: theWatch,
    dataDir,
    outcomes,
    sessions,
    status: () => theWatch.status,
    pcOnline: () => presence.check(),
    stop: async () => {
      await theWatch.stop();
    },
  };
}

/** The session row of a cloud session record, once it exists. */
export async function cloudSessionRow(
  world: ScenarioWorld,
  record: CloudSessionRecord,
): Promise<SessionRow> {
  return world.store.session.mustGet(record.started.sessionId);
}
