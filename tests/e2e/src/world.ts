import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { renderFilesAsDiff, SUBMIT_REVIEW_TOOL, type SubmitReviewInput } from "@forerunner/critic";
import { join, SimulatedClock, safeSegment, toPosix } from "@forerunner/platform";
import {
  AllowAllCaps,
  CriticLoop,
  type DiffPort,
  type DiffResult,
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  LoopTaskExecutor,
  loadRegistry,
  MemoryLoop,
  type ModelProvider,
  NoSecrets,
  type Planner,
  type PlannerContext,
  ProviderRegistry,
  type Registry,
  type RunPricing,
  resolveRegistryDir,
  SessionBudget,
  type SessionPlan,
  type SessionResult,
  SessionRunner,
  type SignedToken,
  type SpecialistSpec,
  StaticPlanner,
  statePorts,
  TokenIssuer,
} from "@forerunner/runtime";
import { fileTools } from "@forerunner/runtime/daemon/tools";
import { type JsonObject, openStore, type StateStore, type TaskRow } from "@forerunner/state";
import {
  FakeProvider,
  lastUserText,
  type ModelRequest,
  type ScriptedReply,
  textReply,
  toolReply,
} from "@forerunner/testenv";

/**
 * The world the phase 3 and phase 4 gate harnesses run in: the real session runner, the real
 * task executor with the built-in file tools in a worktree per task, the real critic loop and
 * the real memory loop, all on the fake provider with an in-memory SQLite store and a
 * simulated clock. Nothing here loosens a limit: the hooks, the budget, the ladder, the
 * verdict rules and the memory budget are the production code paths.
 */

/** 1 USD per 1M tokens in and out: one token is one micro-USD, easy arithmetic in a harness. */
export const flatPricing: RunPricing = {
  estimate: (inTok, maxOut) => inTok + maxOut,
  cost: (u) => u.input_tokens + u.output_tokens,
};

export const SPECIALIST_TOOLS = ["write_file", "read_file"] as const;

export interface SessionEvent {
  agentId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CapturedBrief {
  sessionId: string;
  agentId: string;
  projectId: string | null;
  text: string;
}

export interface GateWorldOptions {
  replies?: ScriptedReply[];
  /** ISO start of the simulated clock. */
  start?: string;
  /** Wire the memory loop into the runner, the executor and the critic (default true). */
  memory?: boolean;
  /** What the fake provider does with an unscripted request (default "throw": a gap in the script is a failure). */
  onNoMatch?: "echo" | "throw";
  /**
   * A live provider for the critic (the opt-in live calibration): registered next to the fake
   * one, the critic loop runs on it with this pricing. Specialists stay on the fake provider.
   */
  critic?: { provider: ModelProvider; pricing: (modelId: string) => RunPricing };
}

export interface ProjectInput {
  name: string;
  goal: string;
  /** Agent ids that are members (peers for handoffs); the runner reads `settings.members`. */
  members: string[];
  settings?: JsonObject;
}

export interface TaskInput {
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
  specialist: string;
  riskTier?: number;
  priority?: number;
}

export interface SessionInput {
  agentId: string;
  projectId: string;
  budgetCapUsdMicro?: number;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export interface GateWorld {
  clock: SimulatedClock;
  store: StateStore;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  provider: FakeProvider;
  providers: ProviderRegistry;
  driver: LoopAgentDriver;
  registry: Registry;
  human: string;
  alice: string;
  bob: string;
  criticAgent: string;
  memory: MemoryLoop | null;
  critic: CriticLoop;
  runner: SessionRunner;
  worktreeRoot: string;
  memoryRoot: string;
  /** Every session event, tagged with the agent and project of the session that raised it. */
  events: SessionEvent[];
  /** The brief text every session handed to the planner (the lessons block is its last part). */
  briefs: CapturedBrief[];
  addProject(input: ProjectInput): Promise<string>;
  addTask(projectId: string, input: TaskInput): Promise<TaskRow>;
  startSession(input: SessionInput): Promise<SessionResult>;
  /**
   * A session row, token and budget for a direct critic call (calibration). The budget is the
   * hard cap every review of that session runs under: the hooks refuse a call that would
   * exceed it, so a live run cannot spend past it.
   */
  reviewContext(
    projectId: string,
    budgetUsdMicro?: number,
  ): Promise<{ sessionToken: SignedToken; budget: SessionBudget; sessionId: string }>;
  close(): Promise<void>;
}

/** Files under a worktree as posix paths relative to it (the critic's changed-files list). */
export function listWorktreeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".git" || entry === "node_modules") continue;
      const abs = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push(toPosix(rel));
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

/**
 * The critic's diff of a task's work: every file the specialist left in the worktree, rendered
 * as a new-file diff. The harness has no git repository per task, so this stands in for the
 * `GitDiffPort`; the evidence shape the critic reads is the same.
 */
export class WorktreeDiffPort implements DiffPort {
  async diffFor(_task: TaskRow, worktree: string | undefined): Promise<DiffResult | null> {
    if (!worktree || !existsSync(worktree)) return null;
    const changedFiles = listWorktreeFiles(worktree);
    return { diff: renderFilesAsDiff(worktree, changedFiles), changedFiles };
  }
}

/** A planner that keeps the brief text it was handed, so the harness can count its lessons. */
export class RecordingPlanner implements Planner {
  private readonly inner = new StaticPlanner();
  constructor(private readonly sink: CapturedBrief[]) {}
  plan(ctx: PlannerContext): Promise<SessionPlan> {
    this.sink.push({
      sessionId: ctx.session.id,
      agentId: ctx.session.agent_id,
      projectId: ctx.session.project_id,
      text: ctx.briefText,
    });
    return this.inner.plan(ctx);
  }
}

/** The registry's real specialist prompt with the harness's file tools and small caps. */
export function specialistFromRegistry(
  registry: Registry,
  name: string,
): SpecialistSpec | undefined {
  const d = registry.specialists.get(name);
  if (!d) return undefined;
  return {
    name: d.name,
    prompt: d.prompt,
    promptVersion: d.promptVersion,
    defaultTier: d.default_tier,
    defaultEffort: d.default_effort,
    allowedTools: [...SPECIALIST_TOOLS],
    allowedDomains: [],
    maxBudgetUsdMicro: 500_000,
    maxTurns: 6,
    timeoutMs: 60_000,
  };
}

// ---------------------------------------------------------------------------------------
// Script helpers: who is asking (specialist or critic) and which turn it is

export function lastIsToolResult(req: ModelRequest): boolean {
  const last = req.messages.at(-1);
  return (
    !!last &&
    Array.isArray(last.content) &&
    last.content.some((b) => (b as { type?: string }).type === "tool_result")
  );
}

export function hasTool(req: ModelRequest, name: string): boolean {
  return (req.tools ?? []).some((t) => t.name === name);
}

/** The critic's first turn: the review tool is offered and no tool result has come back yet. */
export function criticTurn(req: ModelRequest): boolean {
  return hasTool(req, SUBMIT_REVIEW_TOOL) && !lastIsToolResult(req);
}

/** A specialist's first turn: the file tools are offered and nothing has been written yet. */
export function specialistTurn(req: ModelRequest): boolean {
  return hasTool(req, "write_file") && !lastIsToolResult(req);
}

/** A specialist's turn after its tool call came back. */
export function specialistReportTurn(req: ModelRequest): boolean {
  return hasTool(req, "write_file") && lastIsToolResult(req);
}

/** The brief a specialist was handed (its first user message). */
export function briefOf(req: ModelRequest): string {
  const first = req.messages[0];
  if (first?.role !== "user") return "";
  return typeof first.content === "string" ? first.content : lastUserText(req);
}

/** The lessons part of a brief: from the memory block's header to the end (empty without one). */
export function lessonsSection(text: string): string {
  const starts = ["# Standing notes", "# Lessons from memory"]
    .map((h) => text.indexOf(h))
    .filter((i) => i >= 0);
  if (starts.length === 0) return "";
  return text.slice(Math.min(...starts));
}

/** A scripted `submit_review` call; the defaults are an unremarkable accept. */
export function submitReview(
  input: Partial<SubmitReviewInput> = {},
  opts: { when?: ScriptedReply["when"]; times?: number } = {},
): ScriptedReply {
  return toolReply(
    SUBMIT_REVIEW_TOOL,
    {
      grade: 92,
      confidence: "high",
      verdict: "accept",
      summary: "Criteria met with evidence; checks pass; nothing out of scope.",
      findings: [],
      criteria: [],
      checks_run: [],
      ...input,
    },
    "Reviewing the evidence.",
    { when: opts.when ?? criticTurn, times: opts.times ?? Number.POSITIVE_INFINITY },
  );
}

/** The critic's closing text turn after its tool result. */
export function closingReply(): ScriptedReply {
  return textReply("Rationale recorded.", {
    when: (req) => hasTool(req, SUBMIT_REVIEW_TOOL) && lastIsToolResult(req),
    times: Number.POSITIVE_INFINITY,
  });
}

// ---------------------------------------------------------------------------------------

export async function gateWorld(opts: GateWorldOptions = {}): Promise<GateWorld> {
  const clock = new SimulatedClock(opts.start ?? "2026-11-02T06:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const ports = statePorts(store, { chfPerUsd: () => 0.8 });
  const hooks = new EnforcementHooks({
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill,
    clock,
    ledger: ports.ledger,
    audit: ports.audit,
    approvals: ports.approvals,
  });
  const provider = new FakeProvider({
    mode: "script",
    replies: opts.replies ?? [],
    clock,
    latency: "none",
    onNoMatch: opts.onNoMatch ?? "throw",
  });
  const providers = new ProviderRegistry().register(provider);
  if (opts.critic) providers.register(opts.critic.provider);
  const driver = new LoopAgentDriver({ hooks, kill, clock });
  const registry = loadRegistry(resolveRegistryDir().dir);

  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 500_000_000,
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

  const root = await mkdtemp(join(tmpdir(), "fr-gate-"));
  const worktreeRoot = join(root, "worktrees");
  const memoryRoot = join(root, "memory");
  mkdirSync(worktreeRoot, { recursive: true });
  const memory =
    opts.memory === false
      ? null
      : new MemoryLoop({ store, clock, root: memoryRoot, humanId: human });

  const critic = new CriticLoop({
    store,
    clock,
    tokens,
    driver,
    providers,
    providerName: opts.critic?.provider.name ?? "fake",
    prompt: {
      prompt: registry.critic.prompt,
      promptVersion: registry.critic.promptVersion,
      max_effort: registry.critic.max_effort,
    },
    pricing: opts.critic?.pricing ?? (() => flatPricing),
    billingSourceId: "bs-gate",
    criticAgentId: criticAgent,
    diff: new WorktreeDiffPort(),
    ...(memory ? { memory } : {}),
  });
  const executor = new LoopTaskExecutor({
    store,
    clock,
    tokens,
    driver,
    provider,
    pricing: flatPricing,
    tools: fileTools(),
    billingSourceId: "bs-gate",
    specialists: (name) => specialistFromRegistry(registry, name),
    worktreeFor: async (task) => {
      const dir = join(worktreeRoot, safeSegment(task.id));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    ...(memory ? { memory } : {}),
  });
  const briefs: CapturedBrief[] = [];
  const runner = new SessionRunner({
    store,
    clock,
    tokens,
    kill,
    planner: new RecordingPlanner(briefs),
    executor,
    critic,
    ...(memory ? { memory } : {}),
  });
  const events: SessionEvent[] = [];
  const grant = {
    allowedTools: [...SPECIALIST_TOOLS],
    allowedPaths: [worktreeRoot],
    allowedDomains: [] as string[],
    grantedSecrets: [] as string[],
  };

  return {
    clock,
    store,
    tokens,
    kill,
    hooks,
    provider,
    providers,
    driver,
    registry,
    human,
    alice,
    bob,
    criticAgent,
    memory,
    critic,
    runner,
    worktreeRoot,
    memoryRoot,
    events,
    briefs,
    addProject: async (input) =>
      (
        await store.project.insert({
          name: input.name,
          goal: input.goal,
          repos: [],
          stage: "build",
          status: "active",
          budget_usd_micro: 200_000_000,
          autonomy_level: 2,
          summary_cache: {},
          data_assets: [],
          settings: { members: input.members, ...(input.settings ?? {}) },
          small_project_mode: false,
          active: true,
        })
      ).id,
    addTask: (projectId, input) =>
      store.task.insert({
        project_id: projectId,
        title: input.title,
        outcome: input.outcome,
        acceptance_criteria: input.acceptanceCriteria,
        risk_tier: input.riskTier ?? 1,
        status: "ready",
        priority: input.priority ?? 5,
        depends_on: [],
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 50_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "gate harness",
        specialist: input.specialist,
        author_agent: alice,
      }),
    startSession: (input) =>
      runner.start({
        agentId: input.agentId,
        projectId: input.projectId,
        trigger: "schedule",
        budgetCapUsdMicro: input.budgetCapUsdMicro ?? 5_000_000,
        grant,
        onEvent: (type, payload) => {
          events.push({ agentId: input.agentId, projectId: input.projectId, type, payload });
          input.onEvent?.(type, payload);
        },
      }),
    reviewContext: async (projectId, budgetUsdMicro = 50_000_000) => {
      const session = await store.session.insert({
        agent_id: alice,
        project_id: projectId,
        trigger: "manual",
        plan: { items: [], estimateUsdMicro: 0, summary: "calibration" },
        // Created with its plan, so the row names the reason and the author (B.5).
        reason: "calibration review context",
        author_agent: alice,
        budget_cap_usd_micro: budgetUsdMicro,
        step_cap: 10_000,
        spent_usd_micro: 0,
        steps: 0,
        started_at: clock.nowIso(),
        status: "running",
        summary: "",
        handoff: {},
        runner: "pc",
      });
      const sessionToken = tokens.issue({
        runId: `run-${session.id}`,
        sessionId: session.id,
        agentId: alice,
        ownerHumanId: human,
        projectId,
        allowedTools: [],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro,
        depth: 0,
        maxDepth: 3,
        autonomy: 2,
        planApproved: true,
        expiresAt: new Date(clock.now() + 24 * 3_600_000).toISOString(),
      });
      const budget = new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro,
        stepCap: 10_000,
        deadlineMs: clock.now() + 24 * 3_600_000,
        reserveShare: 0.1,
      });
      return { sessionToken, budget, sessionId: session.id };
    },
    close: async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
