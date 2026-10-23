/**
 * The handover on the scenario world (scenario 8, spec P "Handover test" and Phase 8): a
 * fresh agent with only the repository and its docs fixes a seeded bug.
 *
 * - `SEEDED_REPO`: a small library with the standard doc set (README, docs/overview.md,
 *   docs/testing.md, docs/runbook.md), a seeded defect in `src/clamp.js` and the failing test
 *   `test/clamp.test.js` (node:test, no dependencies). `SEEDED_CHECKS` is the project setting
 *   that makes the critic run that test at tier 2 (`settings.checks`). `CLAMP_SEED` is the
 *   task. All three come from the runtime's handover seed module, which the daemon's monthly
 *   handover job (spec P.15, ADR 0060) runs from.
 * - `runSeededTest(root, files)`: writes the files to a fresh directory and runs the test
 *   with node, so the scenario proves the test fails before the fix and passes after it.
 * - `freshInstall(world, { agentName })`: a NEW principal agent row for J with an empty
 *   private memory, composed like the world's installs (its own token issuer, kill switch,
 *   hooks, driver, git host client, critic, memory loop on an empty root, PR executor and
 *   session runner) so the session runs on the production code paths; `runSession` collects
 *   the session events, the run events and the planner briefs.
 * - `coderReadsDocsThenWrites(title, reads, files, report)`: the scripted specialist reads
 *   the files in order (one `read_file` per path, each audited), then writes, then reports;
 *   `report` carries the "Lesson: ..." lines that become the agent's first memory.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, run, safeSegment } from "@forerunner/platform";
import {
  AllowAllCaps,
  CriticLoop,
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  LoopTaskExecutor,
  MemoryLoop,
  type ModelRequest,
  NoSecrets,
  type Planner,
  type PlannerContext,
  type RunEvent,
  type SessionResult,
  SessionRunner,
  type SessionStartOptions,
  type SessionTriggerKind,
  type SpecialistSpec,
  StaticPlanner,
  statePorts,
  type TaskExecutor,
  TokenIssuer,
} from "@forerunner/runtime";
import { fileTools } from "@forerunner/runtime/daemon/tools";
import { type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { coderOn } from "./scenario-scripts.ts";
import type { RunEventRecord, ScenarioEvent, ScenarioWorld } from "./scenario-world.ts";
import {
  type CapturedBrief,
  flatPricing,
  lastIsToolResult,
  SPECIALIST_TOOLS,
  specialistReportTurn,
  specialistTurn,
} from "./world.ts";

/**
 * The seeded repository, its checks setting and the task that fixes the defect live in the
 * runtime (`packages/runtime/src/jobs/handover-seed.ts`, ADR 0060): the daemon's monthly
 * handover job and this scenario share them. Re-exported so the scenario reads as before.
 */
export {
  CLAMP_BUGGY,
  CLAMP_FIXED,
  CLAMP_SEED,
  CLAMP_TEST,
  SEEDED_CHECKS,
  SEEDED_REPO,
} from "@forerunner/runtime";

/** Write `files` under a fresh directory and run the seeded test there with node. */
export async function runSeededTest(
  root: string,
  files: Record<string, string>,
  label: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = join(root, `seeded-${safeSegment(label)}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const r = await run(["node", "--test", "test/clamp.test.js"], {
    cwd: dir,
    allowFailure: true,
    timeoutMs: 60_000,
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------------------
// A fresh install: a new agent row with no memory, on the world's store and git host

export interface FreshInstallOptions {
  agentName: string;
  /** Default: J. */
  humanId?: string;
}

export interface FreshInstall {
  name: string;
  humanId: string;
  agent: { id: string; name: string };
  criticAgent: { id: string; name: string };
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  driver: LoopAgentDriver;
  github: GitHubHost;
  worktreeRoot: string;
  memoryRoot: string;
  memory: MemoryLoop;
  critic: CriticLoop;
  executor: PrTaskExecutor;
  runner: SessionRunner;
  grant: SessionStartOptions["grant"];
  events: ScenarioEvent[];
  runEvents: RunEventRecord[];
  briefs: CapturedBrief[];
  runSession(opts?: {
    trigger?: SessionTriggerKind;
    budgetCapUsdMicro?: number;
    projectId?: string;
  }): Promise<SessionResult>;
}

/** The planner of the fresh install: the static planner with the brief text captured. */
class BriefCapturingPlanner implements Planner {
  private readonly inner = new StaticPlanner();
  constructor(private readonly sink: CapturedBrief[]) {}
  plan(ctx: PlannerContext) {
    this.sink.push({
      sessionId: ctx.session.id,
      agentId: ctx.session.agent_id,
      projectId: ctx.session.project_id,
      text: ctx.briefText,
    });
    return this.inner.plan(ctx);
  }
}

export async function freshInstall(
  world: ScenarioWorld,
  opts: FreshInstallOptions,
): Promise<FreshInstall> {
  const { store, clock, gated, providers, registry, gitHost, project } = world;
  const humanId = opts.humanId ?? world.j.id;
  const human = await store.human.mustGet(humanId);
  const login = humanId === world.j.id ? world.j.login : world.m.login;
  const agentRow = await store.agent.insert({
    name: opts.agentName,
    owner_human_id: humanId,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const criticRow = await store.agent.insert({
    name: `Critic (${opts.agentName})`,
    owner_human_id: humanId,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "critic",
  });
  const installRoot = join(world.root, `install-${safeSegment(opts.agentName.toLowerCase())}`);
  const worktreeRoot = join(installRoot, "worktrees");
  const memoryRoot = join(installRoot, "memory");
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  const ports = statePorts(store, { chfPerUsd: () => 0.8 });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens, async (scope) => {
    const ids =
      scope === "all" ? [agentRow.id, criticRow.id] : scope.agentId ? [scope.agentId] : [];
    for (const id of ids)
      for (const t of await store.task.claimedBy(id))
        await store.task.releaseClaim(t.id, id, "kill switch").catch(() => undefined);
  });
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
  const driver = new LoopAgentDriver({ hooks, kill, clock });
  const gitToken = gitHost.createToken({ owner: login, kind: "classic", scopes: ["repo"] }).token;
  const github = new GitHubHost({ token: gitToken, baseUrl: gitHost.baseUrl, clock });
  const memory = new MemoryLoop({ store, clock, root: memoryRoot, humanId });
  const billingSourceId = `bs-${safeSegment(opts.agentName.toLowerCase())}`;
  const critic = new CriticLoop({
    store,
    clock,
    tokens,
    driver,
    providers,
    providerName: gated.name,
    prompt: {
      prompt: registry.critic.prompt,
      promptVersion: registry.critic.promptVersion,
      max_effort: registry.critic.max_effort,
    },
    pricing: () => flatPricing,
    billingSourceId,
    criticAgentId: criticRow.id,
    worktreeRoot,
    memory,
  });
  const specialistSpec = (name: string): SpecialistSpec | undefined => {
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
      maxBudgetUsdMicro: Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: d.max_turns,
      timeoutMs: d.timeout_minutes * 60_000,
    };
  };
  const events: ScenarioEvent[] = [];
  const runEvents: RunEventRecord[] = [];
  const briefs: CapturedBrief[] = [];
  const loopDeps = {
    store,
    clock,
    tokens,
    driver,
    provider: gated,
    pricing: flatPricing,
    tools: fileTools(),
    billingSourceId,
    specialists: specialistSpec,
    memory,
    onEvent: (taskId: string, ev: RunEvent) =>
      runEvents.push({ agentId: agentRow.id, taskId, event: ev, at: clock.nowIso() }),
  };
  const inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } = {
    execute: (ctx) => new LoopTaskExecutor(loopDeps).execute(ctx),
    withWorktree: (dir) => new LoopTaskExecutor({ ...loopDeps, worktreeFor: async () => dir }),
  };
  const executor = new PrTaskExecutor({
    store,
    clock,
    host: github,
    inner,
    repoFor: async (task) => {
      const row = await store.project.get(task.project_id);
      const full = row?.repos[0];
      if (!full?.includes("/")) return null;
      const [o, n] = full.split("/") as [string, string];
      const info = await github.getRepo({ owner: o, name: n });
      return {
        clone: gitHost.gitHttpAvailable ? info.cloneUrl : project.cloneUrl,
        repo: { owner: o, name: n },
        base: info.defaultBranch,
      };
    },
    worktreeRoot,
    token: gitToken,
    identity: { name: `${opts.agentName} (Forerunner)`, email: human.email },
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens,
    kill,
    planner: new BriefCapturingPlanner(briefs),
    executor,
    critic,
    memory,
  });
  const grant: SessionStartOptions["grant"] = {
    allowedTools: [...SPECIALIST_TOOLS],
    allowedPaths: [worktreeRoot],
    allowedDomains: [new URL(gitHost.baseUrl).host],
    grantedSecrets: [],
    maxDepth: 2,
  };
  return {
    name: opts.agentName,
    humanId,
    agent: { id: agentRow.id, name: agentRow.name },
    criticAgent: { id: criticRow.id, name: criticRow.name },
    tokens,
    kill,
    hooks,
    driver,
    github,
    worktreeRoot,
    memoryRoot,
    memory,
    critic,
    executor,
    runner,
    grant,
    events,
    runEvents,
    briefs,
    runSession: (o = {}) => {
      const pid = o.projectId ?? project.id;
      const trigger = o.trigger ?? "manual";
      return runner.start({
        agentId: agentRow.id,
        projectId: pid,
        trigger,
        budgetCapUsdMicro: o.budgetCapUsdMicro ?? 6_250_000,
        appVersion: "1.0.0-scenario",
        grant,
        onEvent: (type, payload) =>
          events.push({
            seq: events.length,
            agentId: agentRow.id,
            agentName: agentRow.name,
            projectId: pid,
            trigger,
            type,
            payload,
            at: clock.nowIso(),
          }),
      });
    },
  };
}

// ---------------------------------------------------------------------------------------
// The scripted specialist: reads the docs first, then fixes the bug, then reports

/** Files already read in this conversation (the read_file calls the model made so far). */
export function readSoFar(req: ModelRequest): Set<string> {
  const out = new Set<string>();
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const block = b as { type?: string; name?: string; input?: { path?: unknown } };
      if (
        block.type === "tool_use" &&
        block.name === "read_file" &&
        typeof block.input?.path === "string"
      )
        out.add(block.input.path);
    }
  }
  return out;
}

/**
 * The coder on the task `title`: one `read_file` per path of `reads`, in order (the next read
 * only once the earlier ones came back), then one `write_file` per entry of `files`, then the
 * report. The write replies match only after every read is done, so the docs are read first.
 */
export function coderReadsDocsThenWrites(
  title: string,
  reads: string[],
  files: Record<string, string>,
  report: string,
): ScriptedReply[] {
  const on = coderOn(title);
  const allRead = (req: ModelRequest) => reads.every((p) => readSoFar(req).has(p));
  const replies: ScriptedReply[] = [];
  reads.forEach((path, i) => {
    replies.push(
      toolReply("read_file", { path }, `Reading ${path}.`, {
        when: (req) =>
          on(req) &&
          !readSoFar(req).has(path) &&
          reads.slice(0, i).every((p) => readSoFar(req).has(p)) &&
          (specialistTurn(req) || lastIsToolResult(req)),
        times: Number.POSITIVE_INFINITY,
      }),
    );
  });
  for (const [path, content] of Object.entries(files)) {
    replies.push(
      toolReply("write_file", { path, content }, `Writing ${path}.`, {
        when: (req) => on(req) && allRead(req) && !writtenSoFar(req).has(path),
        times: Number.POSITIVE_INFINITY,
      }),
    );
  }
  replies.push(
    textReply(report, {
      when: (req) =>
        on(req) &&
        allRead(req) &&
        Object.keys(files).every((p) => writtenSoFar(req).has(p)) &&
        specialistReportTurn(req),
      times: Number.POSITIVE_INFINITY,
    }),
  );
  return replies;
}

function writtenSoFar(req: ModelRequest): Set<string> {
  const out = new Set<string>();
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const block = b as { type?: string; name?: string; input?: { path?: unknown } };
      if (
        block.type === "tool_use" &&
        block.name === "write_file" &&
        typeof block.input?.path === "string"
      )
        out.add(block.input.path);
    }
  }
  return out;
}
