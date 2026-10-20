import { EventEmitter } from "node:events";
import { BillingRouter, CapChecker, FixedRateSource, type RateSource } from "@forerunner/billing";
import { type GitHost, GitHubHost, MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import {
  type AppDirs,
  appDirs,
  type Clock,
  ForerunnerError,
  join,
  log,
  systemClock,
} from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { openVault, SecretResolver, type Vault } from "@forerunner/vault";
import { LoopAgentDriver } from "../agent/loop.ts";
import type { ToolRegistry } from "../agent/tools.ts";
import { ConversationAgent } from "../conversation/agent.ts";
import { EnforcementHooks } from "../enforcement/hooks.ts";
import { KillFileWatcher } from "../enforcement/killfile.ts";
import { KillSwitch } from "../enforcement/killswitch.ts";
import type { CapDecision, CapScope, CapsPort } from "../enforcement/ports.ts";
import { TokenIssuer } from "../enforcement/token.ts";
import { AnthropicMessagesProvider } from "../provider/anthropic.ts";
import { ProviderRegistry } from "../provider/registry.ts";
import type { ModelProvider } from "../provider/types.ts";
import { loadRegistry, type Registry, resolveRegistryDir } from "../registry/index.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../session/executor.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../session/runner.ts";
import { Scheduler } from "../session/triggers.ts";
import { readConfig, SECRET_NAMES, type SetupConfig } from "../setup/wizard.ts";
import { pricingFor, StateLedgerStore, stateSources } from "../wiring/billing-ports.ts";
import { statePorts } from "../wiring/state-ports.ts";
import { fileTools } from "./tools.ts";

/**
 * Composition root for one install: opens the store and the vault, picks the model provider,
 * wires enforcement, sessions, the conversation agent, the scheduler and the kill switch. The
 * daemon server, the CLI and the tests all go through this so there is exactly one wiring.
 */
export interface ComposeOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: AppDirs;
  config?: SetupConfig | null;
  clock?: Clock;
  stateUrl?: string;
  vault?: Vault;
  /** Injected model provider (tests); otherwise Anthropic from the vault credential. */
  provider?: ModelProvider;
  /** Injected git host (tests); otherwise GitHub from the vault token, else an in-memory host. */
  gitHost?: GitHost;
  registryDir?: string;
  chfPerUsd?: number;
  rates?: RateSource;
  appVersion?: string;
  identity?: { humanName?: string; email?: string; timezone?: string; agentName?: string };
}

export interface RuntimeApp {
  dirs: AppDirs;
  config: SetupConfig | null;
  clock: Clock;
  store: StateStore;
  vault: Vault;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  driver: LoopAgentDriver;
  providers: ProviderRegistry;
  provider: ModelProvider | null;
  registry: Registry;
  tools: ToolRegistry;
  executor: TaskExecutor;
  runner: SessionRunner;
  scheduler: Scheduler;
  conversation: ConversationAgent | null;
  gitHost: GitHost;
  human: { id: string; name: string; timezone: string };
  agent: { id: string; name: string };
  billingSourceId: string;
  chfPerUsd: () => number;
  events: EventEmitter;
  appVersion: string;
  startedAt: number;
  close(): Promise<void>;
}

const DEFAULT_SESSION_CAP_USD_MICRO = 6_250_000; // CHF 5 at 0.8 CHF/USD

export function specialistSpecFrom(
  registry: Registry,
): (name: string) => SpecialistSpec | undefined {
  return (name) => {
    const d = registry.specialists.get(name);
    if (!d || !d.runnable) return undefined;
    return {
      name: d.name,
      prompt: d.prompt,
      promptVersion: d.promptVersion,
      defaultTier: d.default_tier,
      defaultEffort: d.default_effort,
      allowedTools: d.allowed_tools,
      allowedDomains: d.allowed_domains,
      maxBudgetUsdMicro: Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: d.max_turns,
      timeoutMs: d.timeout_minutes * 60_000,
    };
  };
}

/** Outer caps per call: the human's monthly cap and the project's budget looked up live. */
class DynamicCaps implements CapsPort {
  private readonly cache = new Map<
    string,
    { at: number; projectUsdMicro: number; monthUsdMicro: number }
  >();
  constructor(
    private readonly store: StateStore,
    private readonly checker: CapChecker,
    private readonly clock: Clock,
  ) {}
  async check(
    scope: CapScope,
    estimateUsdMicro: number,
    opts: { phase: "work" | "review" },
  ): Promise<CapDecision> {
    const key = `${scope.humanId}:${scope.projectId ?? ""}`;
    let caps = this.cache.get(key);
    if (!caps || this.clock.now() - caps.at > 60_000) {
      const human = await this.store.human.get(scope.humanId);
      const project = scope.projectId ? await this.store.project.get(scope.projectId) : undefined;
      caps = {
        at: this.clock.now(),
        monthUsdMicro: human?.monthly_cap_usd_micro ?? 0,
        projectUsdMicro: project?.budget_usd_micro ?? 0,
      };
      this.cache.set(key, caps);
    }
    const r = await this.checker.check(scope, estimateUsdMicro, {
      phase: opts.phase,
      caps: {
        monthUsdMicro: caps.monthUsdMicro > 0 ? caps.monthUsdMicro : Number.MAX_SAFE_INTEGER,
        projectUsdMicro: caps.projectUsdMicro > 0 ? caps.projectUsdMicro : undefined,
        sessionUsdMicro: Number.MAX_SAFE_INTEGER, // the session cap is enforced in-process by SessionBudget
      },
    });
    return {
      decision: r.decision,
      level: r.level ?? undefined,
      spentUsdMicro: r.spent,
      capUsdMicro: r.cap,
      remainingUsdMicro: r.remaining,
      message: r.message,
    };
  }
}

export async function composeRuntime(opts: ComposeOptions = {}): Promise<RuntimeApp> {
  const logger = log("compose");
  const env = opts.env ?? process.env;
  const dirs = opts.dirs ?? appDirs({ env });
  const config = opts.config === undefined ? readConfig(dirs) : opts.config;
  const clock = opts.clock ?? systemClock;
  const stateUrl =
    opts.stateUrl ??
    env.FORERUNNER_STATE_URL ??
    config?.stateUrl ??
    `sqlite:${join(dirs.data, "state.sqlite")}`;
  const store = await openStore({ url: stateUrl, clock });
  const vault = opts.vault ?? (await openVault({ profile: config?.profile ?? "default", env }));
  const events = new EventEmitter();
  events.setMaxListeners(100);

  // Identity: the first human and their principal agent are created on first run.
  const humans = await store.human.list(undefined, { limit: 1 });
  const human =
    humans[0] ??
    (await store.human.insert({
      name: opts.identity?.humanName ?? config?.humanName ?? env.USERNAME ?? env.USER ?? "me",
      email: opts.identity?.email ?? "",
      timezone: opts.identity?.timezone ?? config?.timezone ?? "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: Math.round(150 / (opts.chfPerUsd ?? 0.8)) * 1_000_000,
      locale: "en",
    }));
  const principals = await store.agent.principals(human.id);
  const agent =
    principals[0] ??
    (await store.agent.insert({
      name: opts.identity?.agentName ?? env.FORERUNNER_AGENT_NAME ?? "Alice",
      owner_human_id: human.id,
      model_config: {},
      memory_location: join(dirs.data, "memory", "agents"),
      status: "active",
      kind: "principal",
    }));

  // Model provider: injected, else Anthropic from the vault, else none (chat and sessions refuse).
  const providers = new ProviderRegistry();
  let provider: ModelProvider | null = opts.provider ?? null;
  if (!provider) {
    const oauth = await vault.get(SECRET_NAMES.anthropicOauth);
    const key = await vault.get(SECRET_NAMES.anthropic);
    if (oauth || key) {
      provider = new AnthropicMessagesProvider({
        apiKey: key ?? undefined,
        authToken: key ? undefined : (oauth ?? undefined),
        baseURL: config?.anthropicApiBase,
        clock,
      });
    }
  }
  if (provider) providers.register(provider);

  // Billing: sources from the store (seeded from the vault on first run), caps, ledger, pricing.
  const sources = await stateSources(store)(human.id);
  let billingSourceId = sources[0]?.id ?? "";
  if (!billingSourceId) {
    const hasOauth = await vault.has(SECRET_NAMES.anthropicOauth);
    const hasKey = await vault.has(SECRET_NAMES.anthropic);
    if (hasOauth)
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "subscription",
          label: "Claude subscription",
          credential_ref: SECRET_NAMES.anthropicOauth,
          limits: { planShareCap: 0.95 },
          enabled: true,
          priority: 1,
        })
      ).id;
    else if (hasKey)
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "api_key",
          label: "Anthropic API key",
          credential_ref: SECRET_NAMES.anthropic,
          limits: {},
          enabled: true,
          priority: 2,
        })
      ).id;
    else
      billingSourceId = (
        await store.billingSource.insert({
          human_id: human.id,
          kind: "fake",
          label: "No credential (fake provider)",
          credential_ref: "none",
          limits: {},
          enabled: true,
          priority: 9,
        })
      ).id;
  }
  void BillingRouter;
  const rates =
    opts.rates ?? new FixedRateSource(opts.chfPerUsd ?? Number(env.FORERUNNER_CHF_PER_USD ?? 0.8));
  let lastRate = opts.chfPerUsd ?? 0.8;
  const chfPerUsd = () => lastRate;
  void rates.chfPerUsd(clock.nowIso()).then(
    (q) => {
      lastRate = typeof q === "number" ? q : (q as { rate: number }).rate;
    },
    () => undefined,
  );
  const ledgerStore = new StateLedgerStore(store);
  const checker = new CapChecker({
    query: ledgerStore,
    clock,
    caps: { monthUsdMicro: Number.MAX_SAFE_INTEGER, sessionUsdMicro: Number.MAX_SAFE_INTEGER },
  });
  const caps = new DynamicCaps(store, checker, clock);

  // Enforcement.
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens, async (scope) => {
    // Freeze claims: release every claim held by the stopped agent(s) so peers can continue.
    const agents =
      scope === "all"
        ? (await store.agent.list(undefined, { limit: 100 })).map((a) => a.id)
        : scope.agentId
          ? [scope.agentId]
          : [];
    for (const id of agents)
      for (const t of await store.task.claimedBy(id))
        await store.task.releaseClaim(t.id, id, "kill switch").catch(() => undefined);
  });
  const ports = statePorts(store, { chfPerUsd });
  const secrets = new SecretResolver(vault);
  const hooks = new EnforcementHooks({
    tokens,
    caps,
    secrets,
    kill,
    clock,
    ledger: ports.ledger,
    audit: ports.audit,
    approvals: ports.approvals,
  });
  const driver = new LoopAgentDriver({ hooks, kill, clock });

  // Registry and tools.
  const registryDir =
    opts.registryDir ?? env.FORERUNNER_REGISTRY_DIR ?? resolveRegistryDir(env).dir;
  const tools = fileTools();
  const registry = loadRegistry(registryDir, { toolNames: tools.names() });
  const specialists = specialistSpecFrom(registry);

  // Git host and the PR executor.
  const ghToken = await vault.get(SECRET_NAMES.github);
  const gitHost: GitHost =
    opts.gitHost ??
    (ghToken
      ? new GitHubHost({ token: ghToken, baseUrl: config?.githubApiBase, clock })
      : new MemoryGitHost(human.name));
  const appVersion = opts.appVersion ?? env.FORERUNNER_VERSION ?? "0.1.0";
  const makeLoop = (worktree?: string) =>
    new LoopTaskExecutor({
      store,
      clock,
      tokens,
      driver,
      provider: provider ?? unavailableProvider(),
      pricing: provider
        ? pricingFor(defaultModelFor(provider))
        : { estimate: () => 0, cost: () => 0 },
      tools,
      billingSourceId,
      specialists,
      ...(worktree ? { worktreeFor: async () => worktree } : {}),
      onEvent: (taskId, ev) => events.emit("run", { taskId, ev }),
    });
  const executor = new PrTaskExecutor({
    store,
    clock,
    host: gitHost,
    inner: { execute: (ctx) => makeLoop().execute(ctx), withWorktree: (dir) => makeLoop(dir) },
    repoFor: async (task) => {
      const project = await store.project.get(task.project_id);
      const full = project?.repos[0];
      if (!full || !full.includes("/")) return null;
      const [owner, name] = full.split("/") as [string, string];
      const info = await gitHost.getRepo({ owner, name });
      return { clone: info.cloneUrl, repo: { owner, name }, base: info.defaultBranch };
    },
    worktreeRoot: dirs.worktrees,
    token: ghToken ?? undefined,
    identity: { name: `${agent.name} (Forerunner)`, email: human.email || "forerunner@localhost" },
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens,
    kill,
    planner: new StaticPlanner(),
    executor,
  });

  const sessionGrant = (projectId?: string) => ({
    allowedTools: tools.names(),
    allowedPaths: [dirs.worktrees],
    allowedDomains: [hostOf(config?.githubApiBase ?? "https://api.github.com"), "github.com"],
    grantedSecrets: ghToken ? [SECRET_NAMES.github] : [],
    maxDepth: 2,
    ...(projectId ? {} : {}),
  });
  const scheduler = new Scheduler({
    clock,
    start: async (req) => {
      if (!provider)
        throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
      const project = req.projectId ? await store.project.mustGet(req.projectId) : null;
      const cap =
        (project?.settings as { session_cap_usd_micro?: number } | null)?.session_cap_usd_micro ??
        DEFAULT_SESSION_CAP_USD_MICRO;
      const budgetUsdMicro = (req as { budgetUsdMicro?: number }).budgetUsdMicro ?? cap;
      return runner.start({
        agentId: req.agentId,
        projectId: req.projectId,
        trigger: req.trigger,
        budgetCapUsdMicro: budgetUsdMicro,
        appVersion,
        grant: sessionGrant(req.projectId),
        onEvent: (type, payload) =>
          events.emit("session", { type, payload, agentId: req.agentId, projectId: req.projectId }),
      });
    },
  });
  const conversation = provider
    ? new ConversationAgent({
        store,
        clock,
        tokens,
        kill,
        provider,
        pricing: pricingForProvider(provider, chatModelFor(provider)),
        billingSourceId,
        hooksDriver: driver,
        startSession: (req) => scheduler.request(req),
        prompt: registry.principals.get("conversation-agent")?.prompt,
        modelId: chatModelFor(provider),
      })
    : null;
  const killWatcher = new KillFileWatcher(kill, clock, dirs.runtime);
  killWatcher.start();
  scheduler.start();
  logger.info("runtime composed", {
    stateUrl: stateUrl.replace(/\/\/[^@]*@/, "//[REDACTED]@"),
    vault: vault.backend,
    provider: provider?.name ?? "none",
    registry: registryDir,
    human: human.name,
    agent: agent.name,
  });

  return {
    dirs,
    config,
    clock,
    store,
    vault,
    tokens,
    kill,
    hooks,
    driver,
    providers,
    provider,
    registry,
    tools,
    executor,
    runner,
    scheduler,
    conversation,
    gitHost,
    human: { id: human.id, name: human.name, timezone: human.timezone },
    agent: { id: agent.id, name: agent.name },
    billingSourceId,
    chfPerUsd,
    events,
    appVersion,
    startedAt: clock.now(),
    async close() {
      scheduler.stop();
      killWatcher.stop();
      await store.close();
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Real providers price from the billing table; fake providers count one micro-USD per token. */
function pricingForProvider(p: ModelProvider | null, modelId: string) {
  if (p && p.name === "anthropic") return pricingFor(modelId);
  return {
    estimate: (i: number, o: number) => i + o,
    cost: (u: { input_tokens: number; output_tokens: number }) => u.input_tokens + u.output_tokens,
  };
}

/** The ladder picks tier ids per provider; sessions default to the sonnet rung. */
function defaultModelFor(p: ModelProvider): string {
  return p.name === "anthropic" ? "claude-sonnet-5-5" : "fake-sonnet";
}
function chatModelFor(p: ModelProvider): string {
  return p.name === "anthropic" ? "claude-haiku-5-5" : "fake-haiku";
}

function unavailableProvider(): ModelProvider {
  const fail = () => {
    throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
  };
  return {
    name: "none",
    listModels: async () => [],
    countTokens: (t) => Math.ceil(t.length / 4),
    stream: async function* () {
      yield* [];
      fail();
    },
    complete: async () => fail(),
  };
}
