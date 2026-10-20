import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SUBMIT_REVIEW_TOOL, type SubmitReviewInput } from "@forerunner/critic";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { LoopAgentDriver, type RunPricing } from "../src/agent/loop.ts";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CriticLoop, type CriticLoopDeps, type DiffResult } from "../src/loop/critic.ts";
import { MemoryLoop } from "../src/loop/memory.ts";
import { ProviderRegistry } from "../src/provider/registry.ts";
import { loadRegistry } from "../src/registry/index.ts";
import {
  SessionRunner,
  type SessionRunnerDeps,
  type SessionStartOptions,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";

/** 1 USD per 1M tokens in and out: one token is one micro-USD. */
export const flatPricing: RunPricing = {
  estimate: (inTok, maxOut) => inTok + maxOut,
  cost: (u) => u.input_tokens + u.output_tokens,
};

const REGISTRY = join(process.cwd(), "evals", "registry");
const registry = loadRegistry(REGISTRY);

/** The real registry critic prompt, so the loop runs what production sends. */
export const CRITIC_PROMPT = {
  prompt: registry.critic.prompt,
  promptVersion: registry.critic.promptVersion,
  max_effort: registry.critic.max_effort,
};

/** A scripted `submit_review` call; the defaults are an unremarkable accept. */
export function submitReply(
  input: Partial<SubmitReviewInput> = {},
  opts: { when?: ScriptedReply["when"]; times?: number } = {},
): ScriptedReply {
  return toolReply(
    SUBMIT_REVIEW_TOOL,
    {
      grade: 92,
      confidence: "high",
      verdict: "accept",
      summary: "Criteria met; tests pass; nothing out of scope.",
      findings: [],
      criteria: [],
      checks_run: [],
      ...input,
    },
    "Reviewing the evidence.",
    { when: reviewTurn, ...opts },
  );
}

/** The critic's first turn: the review tool is offered and no tool result has come back yet. */
function reviewTurn(req: {
  messages: { content: unknown }[];
  tools?: { name: string }[];
}): boolean {
  if (!(req.tools ?? []).some((t) => t.name === SUBMIT_REVIEW_TOOL)) return false;
  const last = req.messages.at(-1)?.content;
  return !(
    Array.isArray(last) && last.some((b) => (b as { type?: string }).type === "tool_result")
  );
}

/** The closing text turn after the critic's tool result. */
export function closingReply(): ScriptedReply {
  return textReply("Rationale recorded.", {
    when: { lastUserIncludes: "Review recorded" },
    times: Number.POSITIVE_INFINITY,
  });
}

export const grant = {
  allowedTools: ["echo", "write_file", "read_file"],
  allowedPaths: [],
  allowedDomains: [],
  grantedSecrets: [],
};

export interface LoopWorld {
  clock: SimulatedClock;
  store: StateStore;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  provider: FakeProvider;
  providers: ProviderRegistry;
  driver: LoopAgentDriver;
  human: string;
  alice: string;
  bob: string;
  criticAgent: string;
  project: string;
  memoryRoot: string;
  memory: MemoryLoop;
  critic: CriticLoop;
  events: { type: string; payload: Record<string, unknown> }[];
  addTask(title: string, over?: Record<string, unknown>): Promise<TaskRow>;
  runner(executor: TaskExecutor, deps?: Partial<SessionRunnerDeps>): SessionRunner;
  start(
    runner: SessionRunner,
    over?: Partial<SessionStartOptions>,
  ): ReturnType<SessionRunner["start"]>;
  close(): Promise<void>;
}

export interface LoopWorldOptions {
  replies?: ScriptedReply[];
  projectSettings?: Record<string, unknown>;
  critic?: Partial<CriticLoopDeps>;
  diff?: DiffResult | null;
}

export async function loopWorld(opts: LoopWorldOptions = {}): Promise<LoopWorld> {
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const hooks = new EnforcementHooks({
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill,
    clock,
    ledger: new MemoryLedger(),
    audit: new MemoryAudit(),
    approvals: new AutoApprove("approved"),
  });
  const provider = new FakeProvider({ replies: opts.replies ?? [], clock, latency: "none" });
  const providers = new ProviderRegistry().register(provider);
  const driver = new LoopAgentDriver({ hooks, kill, clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const agentRow = async (name: string, kind: "principal" | "critic") =>
    (
      await store.agent.insert({
        name,
        owner_human_id: human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind,
      })
    ).id;
  const alice = await agentRow("Alice", "principal");
  const bob = await agentRow("Bob", "principal");
  const criticAgent = await agentRow("Critic", "critic");
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [alice], ...(opts.projectSettings ?? {}) },
      small_project_mode: false,
      active: true,
    })
  ).id;
  const memoryRoot = await mkdtemp(join(tmpdir(), "fr-loop-"));
  const memory = new MemoryLoop({ store, clock, root: memoryRoot, humanId: human });
  const critic = new CriticLoop({
    store,
    clock,
    tokens,
    driver,
    providers,
    providerName: "fake",
    prompt: CRITIC_PROMPT,
    pricing: () => flatPricing,
    billingSourceId: "bs-test",
    criticAgentId: criticAgent,
    memory,
    diff: {
      diffFor: async () =>
        opts.diff === undefined
          ? {
              diff: "--- a/src/x.ts\n+++ b/src/x.ts\n+export const x = 1;\n",
              changedFiles: ["src/x.ts"],
            }
          : opts.diff,
    },
    ...opts.critic,
  });
  const events: LoopWorld["events"] = [];
  const addTask = (title: string, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 400_000,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
      author_agent: alice,
      ...over,
    });
  const runner = (executor: TaskExecutor, deps: Partial<SessionRunnerDeps> = {}) =>
    new SessionRunner({
      store,
      clock,
      tokens,
      kill,
      planner: new StaticPlanner(),
      executor,
      critic,
      memory,
      ...deps,
    });
  const start = (r: SessionRunner, over: Partial<SessionStartOptions> = {}) =>
    r.start({
      agentId: alice,
      projectId: project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (type, payload) => events.push({ type, payload }),
      ...over,
    });
  return {
    clock,
    store,
    tokens,
    kill,
    hooks,
    provider,
    providers,
    driver,
    human,
    alice,
    bob,
    criticAgent,
    project,
    memoryRoot,
    memory,
    critic,
    events,
    addTask,
    runner,
    start,
    close: async () => {
      await store.close();
      await rm(memoryRoot, { recursive: true, force: true });
    },
  };
}

/** An executor that reports done with a final report; the cost lands in the ledger. */
export function doneExecutor(
  w: Pick<LoopWorld, "store" | "clock" | "human" | "project">,
  opts: {
    outcome?: TaskExecutionResult["outcome"];
    finalReport?: string;
    costPerTask?: number;
    checksPassed?: boolean;
  } = {},
): TaskExecutor & { executed: string[] } {
  const executed: string[] = [];
  const cost = opts.costPerTask ?? 300_000;
  return {
    executed,
    async execute({ task, session, budget }) {
      executed.push(task.id);
      const runId = `run-${task.id}-${task.attempt}`;
      budget.record(runId, cost);
      await w.store.run.insert({
        id: runId,
        task_id: task.id,
        session_id: session.id,
        specialist: "coder",
        model: "fake-sonnet",
        provider: "fake",
        effort: "medium",
        prompt_version: "coder@0.1.0+test",
        billing_source_id: null,
        tokens_in: 100,
        tokens_out: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd_micro: cost,
        cost_chf_micro: Math.round(cost * 0.8),
        ttft_ms: 10,
        duration_ms: 100,
        outcome: "completed",
        artifacts: [],
        depth: 1,
        parent_run_id: null,
        timed_out: false,
        tokens_before_compression: 0,
        tokens_after_compression: 0,
        context_transforms: [],
        headroom_used: false,
        author_agent: session.agent_id,
      });
      await w.store.costLedger.record({
        human_id: w.human,
        agent_id: session.agent_id,
        project_id: w.project,
        session_id: session.id,
        task_id: task.id,
        run_id: runId,
        billing_source_id: null,
        kind: "api",
        usd_micro: cost,
        chf_micro: Math.round(cost * 0.8),
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
        tokens_in: 100,
        tokens_out: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: w.clock.nowIso(),
      });
      const outcome = opts.outcome ?? "done";
      return {
        outcome,
        summary: `${task.title}: ${outcome}`,
        costUsdMicro: cost,
        checksPassed: opts.checksPassed ?? outcome === "done",
        runId,
        finalReport: opts.finalReport ?? `Done: ${task.title}. Tests pass.`,
        changedFiles: ["src/x.ts"],
      };
    },
  };
}
