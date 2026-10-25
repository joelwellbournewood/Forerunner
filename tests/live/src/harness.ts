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
  claudeCodeToolNames,
  composeRuntime,
  type ModelProvider,
  type QueryLike,
  type RuntimeApp,
  resolveRegistryDir,
  SDK_RUN_PROVIDER,
  SECRET_NAMES,
  type SessionResult,
  type SessionStartOptions,
} from "@forerunner/runtime";
import type { JsonObject, RunRow, StateStore, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { budgetConfigFromEnv, LiveBudget, type LiveBudgetConfig } from "./budget.ts";
import { findRepoRoot, type LiveCredentials, loadBuildEnv, redactCredentials } from "./env.ts";
import { LEDGER_FILE_NAME, SpendLedger, type SpendRow } from "./ledger.ts";
import { type LiveCall, MeteredProvider } from "./metered.ts";
import {
  LIVE_CODER_OVERRIDES,
  LIVE_SDK_CODER_OVERRIDES,
  prepareLiveRegistry,
  type SpecialistOverrides,
} from "./registry.ts";
import { runIdFromEnv } from "./report.ts";

/**
 * Removing the harness's temporary tree. On Windows a handle still held a moment after close
 * (SQLite, a worktree file, possibly a killed SDK subprocess's cwd) made the removal fail with
 * EPERM (live run of 2026-10-25). `maxRetries` makes Node retry EBUSY, EMFILE, ENFILE,
 * ENOTEMPTY and EPERM with a linear back-off (about 11 s at most here).
 */
export const RM_TREE = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;

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

/** The audit row of an Agent SDK run settled into the spend ledger as plan usage. */
export const SUBSCRIPTION_RUN_AUDIT_TOOL = "live.subscription_run";

/**
 * Host-session variables kept for the Claude Code subprocess: the proxy flag is about the
 * network path (the egress proxy resolves hosts), not about identity or billing.
 */
export const HOST_SESSION_ENV_KEPT: readonly string[] = ["CLAUDE_CODE_PROXY_RESOLVES_HOSTS"];

/**
 * When the build box is itself a Claude Code session, its environment carries that session's
 * `CLAUDECODE` and `CLAUDE_CODE_*` variables (remote transport, a host-managed provider, the
 * messaging socket, the session and account ids). The runtime's `scrubEnv` hands the SDK
 * subprocess everything that is not credential-shaped, so a nested `claude` would inherit
 * them and could run as the host's session rather than on the subscription token. The live
 * harness therefore removes them from the worker's environment before a real subprocess
 * starts; a daemon on a human's PC never has them. Returns the names removed (never values).
 */
export function scrubHostSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (name !== "CLAUDECODE" && !name.startsWith("CLAUDE_")) continue;
    if (HOST_SESSION_ENV_KEPT.includes(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed.sort();
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

  /** One row per SDK run: plan usage, no USD; the SDK's own figure in the summary. */
  async recordSubscriptionRun(run: RunRow, row: SpendRow): Promise<void> {
    if (!this.store) return;
    await this.store.auditLog.append({
      session_id: run.session_id,
      run_id: run.id,
      agent_id: this.ids.agentId,
      human_id: this.ids.humanId,
      tool: SUBSCRIPTION_RUN_AUDIT_TOOL,
      input_summary: `${run.model} on the subscription (${run.specialist})`,
      result_summary: `${run.outcome}: ${row.tokensIn} in, ${row.tokensOut} out, ${row.note ?? ""}`,
      allowed: true,
      denied_reason: null,
      cost_usd_micro: 0,
      occurred_at: run.updated_at,
      token_id: null,
    });
  }
}

/** The SDK's own list-price figure of a Run that went through the Agent SDK driver, in USD. */
export function sdkCostUsdOf(run: RunRow): number | null {
  for (const a of run.artifacts) {
    if (a && typeof a === "object" && (a as { driver?: unknown }).driver === "sdk") {
      const micro = (a as { sdk_cost_usd_micro?: unknown }).sdk_cost_usd_micro;
      if (typeof micro === "number" && Number.isFinite(micro)) return micro / 1_000_000;
    }
  }
  return null;
}

/**
 * The spend ledger row of one Agent SDK run on the subscription (ADR 0044): the tokens the
 * SDK reported per turn (what the Run row carries), `usd` 0 because plan usage has no USD
 * price (the live caps ignore it), `kind: "subscription"`, and the note the task asks for with
 * the SDK's own list-price figure, followed by the outcome when the run did not complete and
 * by the hooks' API-equivalent estimate when the SDK reported no figure at all.
 */
export function subscriptionSpendRow(run: RunRow, liveRun: string, date: string): SpendRow {
  const sdkUsd = sdkCostUsdOf(run);
  const parts = [`subscription: plan usage, est. USD ${(sdkUsd ?? 0).toFixed(4)}`];
  if (run.outcome !== "completed") parts.push(run.outcome);
  if (sdkUsd === null || sdkUsd === 0) {
    parts.push(
      `no SDK cost reported, hooks est. USD ${(run.cost_usd_micro / 1_000_000).toFixed(4)}`,
    );
  }
  return {
    date,
    run: liveRun,
    model: run.model,
    tokensIn: run.tokens_in,
    tokensOut: run.tokens_out,
    cacheRead: run.cache_read_tokens,
    cacheWrite: run.cache_write_tokens,
    usd: 0,
    kind: "subscription",
    note: parts.join("; "),
  };
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
  /**
   * Specialist overrides for the registry copy; default: the coder on the file tools, or on
   * the registry's `cc:` names when `subscription` is set (`LIVE_SDK_CODER_OVERRIDES`).
   */
  specialists?: Record<string, SpecialistOverrides>;
  /**
   * The subscription half (ADR 0044): the vault also holds the subscription token under its
   * usual name, so both billing sources exist and the router picks the subscription for the
   * human's own agent on the personal runner; the session grant then lists the `cc:` names.
   * Requires `credentials.subscriptionToken`; a missing token is a `provider_auth` error.
   */
  subscription?: boolean;
  /** The SDK's `query` in place of the real one (the dry run); never set on a live run. */
  sdkQuery?: QueryLike;
  /** The plan allowance (USD of API-equivalent usage per month) the subscription row carries. */
  planUsdMonthly?: number;
  /**
   * What to do with the hosting Claude Code session's variables in `process.env` before a real
   * SDK subprocess runs (`scrubHostSessionEnv`): "scrub" (the default when `subscription` is
   * set and no `sdkQuery` fake is given) or "keep".
   */
  hostSessionEnv?: "scrub" | "keep";
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
  /** Whether the vault holds the subscription token beside the key (the subscription half). */
  subscription: boolean;
  /** The host-session variable names removed from `process.env` for the SDK subprocess. */
  hostEnvScrubbed: string[];
  /**
   * The grant a daemon session runs under (the built-in tools, the worktrees root, the host,
   * and the Claude Code names when the subscription token is in the vault, as the daemon's
   * own grant lists them).
   */
  grant(): SessionStartOptions["grant"];
  /**
   * Settle the session's Agent SDK runs into the spend ledger: one `subscription` row per
   * finished SDK Run row not settled yet (USD 0, the note with the SDK's figure) and an audit
   * row each. The SDK subprocess calls the provider itself, so these runs never pass the
   * metered gate; this is how the ledger still records them. Returns the rows appended.
   */
  settleSubscriptionRuns(sessionId: string): Promise<SpendRow[]>;
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
  const subscription = opts.subscription === true;
  if (subscription && !live.credentials.subscriptionToken) {
    throw new ForerunnerError(
      "provider_auth",
      "no subscription token: set FORERUNNER_SUBSCRIPTION_TOKEN or put it in .env.build at the repository root",
    );
  }
  // A real Claude Code subprocess is about to run on the subscription: the hosting session's
  // own variables must not reach it (see `scrubHostSessionEnv`).
  const scrubHost = opts.hostSessionEnv ?? (subscription && !opts.sdkQuery ? "scrub" : "keep");
  const hostEnvScrubbed = scrubHost === "scrub" ? scrubHostSessionEnv() : [];
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
    opts.specialists ?? { coder: subscription ? LIVE_SDK_CODER_OVERRIDES : LIVE_CODER_OVERRIDES },
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
  // The vault holds the credentials by their usual names: the key always (the critic and chat
  // run on the Messages provider), the subscription token only for the subscription half,
  // where the runtime reads it by reference for the SDK subprocess (ADR 0044 item 4).
  const vault = new MemoryVault({
    [SECRET_NAMES.anthropic]: live.credentials.apiKey,
    [SECRET_NAMES.github]: token,
    ...(subscription && live.credentials.subscriptionToken
      ? { [SECRET_NAMES.anthropicOauth]: live.credentials.subscriptionToken }
      : {}),
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
      // The daemon's own policy: this install is the human's personal runner, so a subscription
      // may serve its sessions; `cc:Bash` stays withheld (no sandbox lease covers the subprocess).
      billing: {
        personalRunner: true,
        hostCommands: false,
        ...(opts.planUsdMonthly !== undefined ? { planUsdMonthly: opts.planUsdMonthly } : {}),
      },
      ...(opts.sdkQuery ? { sdkQuery: opts.sdkQuery } : {}),
    });
  } catch (e) {
    await host.stop().catch(() => undefined);
    rmSync(root, RM_TREE);
    throw e;
  }
  live.audit.attach(app.store, { agentId: app.agent.id, humanId: app.human.id });
  for (const c of live.audit.pending.splice(0)) await live.audit.record(c);

  const hostName = new URL(host.baseUrl).hostname;
  const grant = (): SessionStartOptions["grant"] => ({
    allowedTools: [
      ...app.tools.names(),
      ...app.extensions.bridgedTools().map((t) => t.name),
      // As the daemon's grant: a derived run token only narrows, so the registry's `cc:` names
      // must be here for the SDK path to carry them (ADR 0044 item 3).
      ...(subscription ? claudeCodeToolNames() : []),
    ],
    allowedPaths: [app.dirs.worktrees],
    allowedDomains: [hostName],
    grantedSecrets: [SECRET_NAMES.github],
    maxDepth: 2,
  });
  const settled = new Set<string>();
  const settleSubscriptionRuns = async (sessionId: string): Promise<SpendRow[]> => {
    const rows: SpendRow[] = [];
    for (const run of await app.store.run.forSession(sessionId, { limit: 10_000 })) {
      if (run.provider !== SDK_RUN_PROVIDER || run.outcome === "running" || settled.has(run.id))
        continue;
      settled.add(run.id);
      const row = subscriptionSpendRow(run, live.run, clock.nowIso().slice(0, 10));
      live.ledger.append(row);
      await live.audit.recordSubscriptionRun(run, row);
      rows.push(row);
    }
    return rows;
  };

  return {
    ...live,
    app,
    host,
    repo: { ...repo, full: `${repo.owner}/${repo.name}` },
    root,
    registryDir: registry.dir,
    subscription,
    hostEnvScrubbed,
    grant,
    settleSubscriptionRuns,
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
      // A temp tree left behind is harmless; a run whose cases passed is not failed for it.
      try {
        rmSync(root, RM_TREE);
      } catch (err) {
        console.warn(
          `live harness: could not remove the temporary tree ${root} (${(err as Error).message}); remove it by hand`,
        );
      }
    },
  };
}

/** The repository's registry directory (for callers that want the unpatched eval sets). */
export function repositoryRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveRegistryDir(env).dir);
}
