import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PricingTable } from "@forerunner/billing";
import { GitHubHost } from "@forerunner/capabilities";
import {
  appDirs,
  type Clock,
  ForerunnerError,
  join,
  resolve,
  systemClock,
} from "@forerunner/platform";
import {
  AnthropicMessagesProvider,
  composeRuntime,
  type ModelProvider,
  type RuntimeApp,
  resolveRegistryDir,
  SECRET_NAMES,
  type SessionResult,
  type SessionStartOptions,
} from "@forerunner/runtime";
import type { JsonObject, StateStore, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { budgetConfigFromEnv, LiveBudget, type LiveBudgetConfig } from "./budget.ts";
import { findRepoRoot, type LiveCredentials, loadBuildEnv, redactCredentials } from "./env.ts";
import { LEDGER_FILE_NAME, SpendLedger } from "./ledger.ts";
import { type LiveCall, MeteredProvider } from "./metered.ts";
import { prepareLiveRegistry, type SpecialistOverrides } from "./registry.ts";
import { runIdFromEnv } from "./report.ts";

/**
 * The live harness: the real provider behind the budget gate, and the real runtime composed
 * through `composeRuntime` (the daemon's one wiring) against an in-memory SQLite store, an
 * in-memory vault holding the key by its usual name (so the billing source is an `api_key`
 * source, as on a real install), the testenv fake git host as the GitHub stand-in, a copy of
 * the registry with the coder on the built-in file tools, and the process sandbox stand-in.
 * Everything else is what the daemon runs: hooks, caps, kill switch, PR executor, critic loop,
 * memory, commands, conversation agent.
 */
export interface LiveProvider {
  credentials: LiveCredentials;
  provider: MeteredProvider;
  budget: LiveBudget;
  ledger: SpendLedger;
  run: string;
  /** Appends an audit row for every live call once a store is attached. */
  audit: AuditSink;
}

export interface LiveProviderOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** The run id; default `FORERUNNER_LIVE_RUN`, else the clock's ISO time. */
  run?: string;
  /** The ledger file; default `tests/live/spend.json`. */
  ledgerPath?: string;
  config?: LiveBudgetConfig;
  /** The price table the ledger uses; default the billing package's built-ins. */
  pricing?: PricingTable;
  /** Credentials; default `.env.build` / the environment. A dry run passes fake ones. */
  credentials?: LiveCredentials;
  /** The provider to meter; default the Anthropic adapter on the credentials. */
  inner?: ModelProvider;
  onWarn?: (line: string) => void;
}

/** Audit rows for live calls land in whichever store is attached (the composed app's). */
export class AuditSink {
  private store: Pick<StateStore, "auditLog"> | null = null;
  private ids: { agentId: string | null; humanId: string | null } = {
    agentId: null,
    humanId: null,
  };
  readonly pending: LiveCall[] = [];

  attach(store: Pick<StateStore, "auditLog">, ids: { agentId: string; humanId: string }): void {
    this.store = store;
    this.ids = ids;
  }

  async record(call: LiveCall): Promise<void> {
    if (!this.store) {
      this.pending.push(call);
      return;
    }
    await this.store.auditLog.append({
      session_id: null,
      run_id: null,
      agent_id: this.ids.agentId,
      human_id: this.ids.humanId,
      tool: "live.model_call",
      input_summary: `${call.model} estimate USD ${call.estimateUsd.toFixed(4)}`,
      result_summary:
        call.status === "refused"
          ? "refused by the live budget"
          : `${call.status}: ${call.tokensIn} in, ${call.tokensOut} out, USD ${call.usd.toFixed(6)}, ${call.durationMs} ms`,
      allowed: call.status !== "refused",
      denied_reason: call.status === "refused" ? (call.reason ?? "live budget") : null,
      cost_usd_micro: Math.round(call.usd * 1_000_000),
      occurred_at: call.at,
      token_id: null,
    });
  }
}

export function defaultLedgerPath(): string {
  const root = findRepoRoot();
  if (!root)
    throw new ForerunnerError("not_found", "repository root not found for the spend ledger");
  return join(root, "tests", "live", LEDGER_FILE_NAME);
}

/** The metered provider and its budget; no runtime, no network until the first call. */
export function liveProvider(opts: LiveProviderOptions = {}): LiveProvider {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const credentials = opts.credentials ?? loadBuildEnv({ env });
  if (!credentials) {
    throw new ForerunnerError(
      "provider_auth",
      "no live credentials: set FORERUNNER_ANTHROPIC_KEY or put it in .env.build at the repository root",
    );
  }
  const run = opts.run ?? runIdFromEnv(env, clock.nowIso());
  const ledger = SpendLedger.load(opts.ledgerPath ?? defaultLedgerPath());
  const budget = new LiveBudget({
    ledger,
    run,
    config: opts.config ?? budgetConfigFromEnv(env),
    clock,
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
    ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
  });
  const audit = new AuditSink();
  const inner =
    opts.inner ??
    new AnthropicMessagesProvider({
      apiKey: credentials.apiKey,
      clock,
      ...(env.FORERUNNER_ANTHROPIC_API ? { baseURL: env.FORERUNNER_ANTHROPIC_API } : {}),
      ...(credentials.workspaceId
        ? { defaultHeaders: { "anthropic-workspace-id": credentials.workspaceId } }
        : {}),
    });
  const provider = new MeteredProvider(inner, budget, {
    clock,
    onCall: (c) => audit.record(c),
    redact: (text) => redactCredentials(text, credentials),
  });
  return { credentials, provider, budget, ledger, run, audit };
}

export interface LiveHarnessOptions extends LiveProviderOptions {
  /** Specialist overrides for the registry copy; default: the coder on the file tools. */
  specialists?: Record<string, SpecialistOverrides>;
  /** Files of the sample repository's initial commit. */
  repoFiles?: Record<string, string>;
  repo?: { owner: string; name: string };
  identity?: { humanName?: string; timezone?: string; agentName?: string };
}

export interface LiveHarness extends LiveProvider {
  app: RuntimeApp;
  host: FakeGitHost;
  repo: { owner: string; name: string; full: string };
  root: string;
  registryDir: string;
  /** The grant a daemon session runs under (the built-in tools, the worktrees root, the host). */
  grant(): SessionStartOptions["grant"];
  addProject(input: {
    name: string;
    goal: string;
    budgetUsdMicro?: number;
    settings?: JsonObject;
  }): Promise<string>;
  addTask(
    projectId: string,
    input: {
      title: string;
      outcome: string;
      acceptanceCriteria: string[];
      budgetUsdMicro?: number;
      estimateUsdMicro?: number;
      riskTier?: 0 | 1 | 2 | 3;
      priority?: number;
      specialist?: string;
    },
  ): Promise<TaskRow>;
  startSession(input: {
    projectId: string;
    budgetCapUsdMicro: number;
    trigger?: SessionStartOptions["trigger"];
    onEvent?: SessionStartOptions["onEvent"];
  }): Promise<SessionResult>;
  close(): Promise<void>;
}

export const DEFAULT_REPO_FILES: Record<string, string> = {
  "README.md": "# sample\n\nA tiny TypeScript library the live harness works on.\n",
  "package.json":
    '{\n  "name": "sample",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "node --experimental-strip-types --test \\"test/*.test.ts\\""\n  }\n}\n',
  "src/index.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "test/add.test.ts":
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/index.ts";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
};

export async function composeLive(opts: LiveHarnessOptions = {}): Promise<LiveHarness> {
  const live = liveProvider(opts);
  const clock = opts.clock ?? systemClock;
  const root = mkdtempSync(join(tmpdir(), "fr-live-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const baseEnv = opts.env ?? process.env;
  // The composed runtime reads only FORERUNNER_* from here; the SDK's own ANTHROPIC_* variables
  // are dropped so the adapter uses exactly the credentials and base URL it was given.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(baseEnv).filter(([k]) => !k.startsWith("ANTHROPIC_")),
  );
  env.FORERUNNER_HOME = home;
  const registry = prepareLiveRegistry(
    resolveRegistryDir(baseEnv).dir,
    join(root, "registry"),
    opts.specialists,
  );
  env.FORERUNNER_REGISTRY_DIR = registry.dir;
  const dirs = appDirs({ env });

  const host = await FakeGitHost.start({ rootDir: join(root, "githost"), clock });
  const repo = opts.repo ?? { owner: "live", name: "sample" };
  host.createUser({ login: repo.owner, name: "Live harness", email: "live@example.test" });
  const token = host.createToken({ owner: repo.owner, kind: "classic", scopes: ["repo"] }).token;
  await host.createRepo({
    owner: repo.owner,
    name: repo.name,
    private: true,
    initialFiles: opts.repoFiles ?? DEFAULT_REPO_FILES,
  });
  const vault = new MemoryVault({
    [SECRET_NAMES.anthropic]: live.credentials.apiKey,
    [SECRET_NAMES.github]: token,
  });
  const gitHost = new GitHubHost({ token, baseUrl: host.baseUrl, clock });

  let app: RuntimeApp;
  try {
    app = await composeRuntime({
      env,
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: live.provider,
      gitHost,
      registryDir: registry.dir,
      identity: {
        humanName: opts.identity?.humanName ?? "J",
        timezone: opts.identity?.timezone ?? "UTC",
        agentName: opts.identity?.agentName ?? "Alice",
      },
      sandboxDetection: {
        engine: "none",
        reason: "live harness: process stand-in",
        checkedAt: clock.nowIso(),
      },
      startServices: false,
      notifications: { osNotifier: false },
      exit: () => undefined,
    });
  } catch (e) {
    await host.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  live.audit.attach(app.store, { agentId: app.agent.id, humanId: app.human.id });
  for (const c of live.audit.pending.splice(0)) await live.audit.record(c);

  const hostName = new URL(host.baseUrl).hostname;
  const grant = (): SessionStartOptions["grant"] => ({
    allowedTools: [...app.tools.names(), ...app.extensions.bridgedTools().map((t) => t.name)],
    allowedPaths: [app.dirs.worktrees],
    allowedDomains: [hostName],
    grantedSecrets: [SECRET_NAMES.github],
    maxDepth: 2,
  });

  return {
    ...live,
    app,
    host,
    repo: { ...repo, full: `${repo.owner}/${repo.name}` },
    root,
    registryDir: registry.dir,
    grant,
    addProject: async (input) =>
      (
        await app.store.project.insert({
          name: input.name,
          goal: input.goal,
          repos: [`${repo.owner}/${repo.name}`],
          stage: "build",
          status: "active",
          budget_usd_micro: input.budgetUsdMicro ?? 5_000_000,
          autonomy_level: 2,
          summary_cache: {},
          data_assets: [],
          settings: { members: [app.agent.id], ...(input.settings ?? {}) },
          small_project_mode: false,
          active: true,
        })
      ).id,
    addTask: (projectId, input) =>
      app.store.task.insert({
        project_id: projectId,
        title: input.title,
        outcome: input.outcome,
        acceptance_criteria: input.acceptanceCriteria,
        risk_tier: input.riskTier ?? 1,
        status: "ready",
        priority: input.priority ?? 5,
        depends_on: [],
        budget_usd_micro: input.budgetUsdMicro ?? 400_000,
        est_cost_usd_micro: input.estimateUsdMicro ?? 100_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "live harness",
        specialist: input.specialist ?? "coder",
        author_agent: app.agent.id,
      }),
    startSession: (input) =>
      app.runner.start({
        agentId: app.agent.id,
        projectId: input.projectId,
        trigger: input.trigger ?? "manual",
        budgetCapUsdMicro: input.budgetCapUsdMicro,
        appVersion: app.appVersion,
        grant: grant(),
        onEvent: (type, payload) => {
          app.events.emit("session", {
            type,
            payload,
            agentId: app.agent.id,
            projectId: input.projectId,
          });
          input.onEvent?.(type, payload);
        },
      }),
    close: async () => {
      await app.close().catch(() => undefined);
      await host.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The repository's registry directory (for callers that want the unpatched eval sets). */
export function repositoryRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveRegistryDir(env).dir);
}
