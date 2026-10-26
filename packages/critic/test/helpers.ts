import { SimulatedClock } from "@forerunner/platform";
import {
  AllowAllCaps,
  AutoApprove,
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  loadRegistry,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
  ProviderRegistry,
  type RunPricing,
  resolveRegistryDir,
  SessionBudget,
  type SignedToken,
  TokenIssuer,
} from "@forerunner/runtime";
import {
  type JsonObject,
  type JsonValue,
  openStore,
  type StateStore,
  type TaskRow,
  type TaskStatus,
} from "@forerunner/state";
import {
  FakeProvider,
  type ReplyOptions,
  type ScriptedReply,
  textReply,
  toolReply,
} from "@forerunner/testenv";
import {
  type CriticDeps,
  type CriticPromptSource,
  CriticService,
  type ReviewContext,
} from "../src/critic.ts";
import { SUBMIT_REVIEW_TOOL, type SubmitReviewInput } from "../src/schema.ts";
import type { ReviewEvidence, ReviewOutput } from "../src/types.ts";

/** 1 USD per 1M tokens in and out: one token is one micro-USD, easy arithmetic in tests. */
export const flatPricing: RunPricing = {
  estimate: (inTok, maxOut) => inTok + maxOut,
  cost: (u) => u.input_tokens + u.output_tokens,
};

const registry = loadRegistry(resolveRegistryDir().dir);

/** The real registry critic prompt, so tests exercise what production sends. */
export const CRITIC_PROMPT: CriticPromptSource = {
  prompt: registry.critic.prompt,
  promptVersion: registry.critic.promptVersion,
  max_effort: registry.critic.max_effort,
};

/** A scripted `submit_review` call; the defaults are an unremarkable accept. */
export function submitReply(
  input: Partial<SubmitReviewInput> = {},
  opts: Pick<ReplyOptions, "when" | "times" | "ttftMs" | "totalMs" | "usage"> = {},
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
    opts,
  );
}

/** The closing text turn after the tool result. */
export function closingReply(): ScriptedReply {
  return textReply("Rationale recorded.", {
    when: { lastUserIncludes: "Review recorded" },
    times: Number.POSITIVE_INFINITY,
  });
}

export function baseEvidence(over: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    brief: "Add a clamp function with tests.",
    acceptanceCriteria: ["src/math.ts exports clamp", "tests pass"],
    changedFiles: ["src/math.ts", "test/math.test.ts"],
    diff: "--- a/src/math.ts\n+++ b/src/math.ts\n+export function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }\n",
    testOutput: "ok 1 clamp\n1..1",
    checkResults: [{ name: "tests", passed: true, output: "1 passing" }],
    finalReport: "Done. clamp added with a test.",
    ...over,
  };
}

export interface WorldOptions {
  replies?: ScriptedReply[];
  taskStatus?: TaskStatus;
  projectSettings?: JsonObject;
  deps?: Partial<CriticDeps>;
  /** Extra plan or summary for the session row. */
  session?: { plan?: JsonValue; summary?: string; budgetCapUsdMicro?: number };
  /**
   * The fake provider's latency. "none" (default) answers at once; "simulated" sleeps each
   * reply's `ttftMs` and `totalMs` on the world's clock, so the test must `advance` it.
   */
  latency?: "simulated" | "none";
}

export interface World {
  clock: SimulatedClock;
  store: StateStore;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  ledger: MemoryLedger;
  audit: MemoryAudit;
  provider: FakeProvider;
  providers: ProviderRegistry;
  driver: LoopAgentDriver;
  critic: CriticService;
  ids: {
    human: string;
    owner: string;
    critic: string;
    project: string;
    session: string;
    task: string;
  };
  sessionToken: SignedToken;
  budget: SessionBudget;
  ctx(over?: Partial<ReviewContext>): ReviewContext;
  tokenFor(sessionId: string, taskId?: string): SignedToken;
  newSession(over?: Record<string, unknown>): Promise<string>;
  newTask(over?: Record<string, unknown>): Promise<TaskRow>;
  close(): Promise<void>;
}

export async function world(opts: WorldOptions = {}): Promise<World> {
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const ledger = new MemoryLedger();
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill,
    clock,
    ledger,
    audit,
    approvals: new AutoApprove("approved"),
  });
  const provider = new FakeProvider({
    replies: opts.replies ?? [],
    clock,
    latency: opts.latency ?? "none",
  });
  const providers = new ProviderRegistry().register(provider);
  const driver = new LoopAgentDriver({ hooks, kill, clock });

  const human = await store.human.insert({ name: "Joel", email: "joel@example.invalid" });
  const owner = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    kind: "principal",
  });
  const critic = await store.agent.insert({
    name: "Critic",
    owner_human_id: human.id,
    kind: "critic",
  });
  const project = await store.project.insert({
    name: "Fixture",
    settings: opts.projectSettings ?? {},
  });
  const session = await store.session.insert({
    agent_id: owner.id,
    project_id: project.id,
    status: "running",
    started_at: clock.nowIso(),
    budget_cap_usd_micro: opts.session?.budgetCapUsdMicro ?? 5_000_000,
    step_cap: 200,
    plan: opts.session?.plan ?? { items: [], estimateUsdMicro: 0, summary: "" },
    // A row created with its plan names the reason and the author (B.5, the insert guard).
    reason: "fixture session",
    author_agent: owner.id,
    summary: opts.session?.summary ?? "",
  });
  const task = await store.task.insert({
    project_id: project.id,
    title: "Add clamp",
    outcome: "clamp exists with a test",
    acceptance_criteria: ["src/math.ts exports clamp", "tests pass"],
    risk_tier: 1,
    status: opts.taskStatus ?? "in_review",
    owner_agent_id: owner.id,
    specialist: "coder",
    budget_usd_micro: 500_000,
  });

  const tokenFor = (sessionId: string, taskId?: string): SignedToken =>
    tokens.issue({
      runId: `run-${sessionId}`,
      sessionId,
      agentId: owner.id,
      ownerHumanId: human.id,
      projectId: project.id,
      taskId,
      allowedTools: ["echo"],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 2_000_000,
      depth: 0,
      maxDepth: 3,
      autonomy: 2,
      planApproved: true,
      expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
    });
  const sessionToken = tokenFor(session.id, task.id);
  const budget = new SessionBudget({
    sessionId: session.id,
    budgetUsdMicro: 5_000_000,
    stepCap: 200,
    deadlineMs: clock.now() + 3_600_000,
    reserveShare: 0.2,
  });
  const criticService = new CriticService({
    store,
    clock,
    tokens,
    driver,
    providers,
    providerName: "fake",
    prompt: CRITIC_PROMPT,
    pricing: () => flatPricing,
    billingSourceId: "bs-test",
    criticAgentId: critic.id,
    ...opts.deps,
  });

  return {
    clock,
    store,
    tokens,
    kill,
    hooks,
    ledger,
    audit,
    provider,
    providers,
    driver,
    critic: criticService,
    ids: {
      human: human.id,
      owner: owner.id,
      critic: critic.id,
      project: project.id,
      session: session.id,
      task: task.id,
    },
    sessionToken,
    budget,
    ctx: (over = {}) => ({ sessionToken, budget, ...over }),
    tokenFor,
    newSession: async (over = {}) => {
      const s = await store.session.insert({
        agent_id: owner.id,
        project_id: project.id,
        status: "running",
        budget_cap_usd_micro: 5_000_000,
        ...over,
      });
      return s.id;
    },
    newTask: (over = {}) =>
      store.task.insert({
        project_id: project.id,
        title: "Another task",
        acceptance_criteria: ["it works"],
        status: "in_review",
        owner_agent_id: owner.id,
        ...over,
      }),
    close: () => store.close(),
  };
}

/** A ReviewOutput as the service would return it, for follow-up tests that need no model. */
export function reviewOutput(over: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    grade: 90,
    confidence: 0.9,
    verdict: "accept",
    findings: [],
    evidence: [],
    summary: "Fine.",
    model: "fake-sonnet",
    tier: 1,
    durationMs: 1,
    costUsdMicro: 0,
    outcome: "completed",
    adjustments: [],
    patterns: [],
    lessonProposals: [],
    ...over,
  };
}

/**
 * Polls `cond` on real timers (never the simulated clock) until it holds, for a review that
 * must have reached the provider before the test advances the clock. Throws after about 2 s.
 */
export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
