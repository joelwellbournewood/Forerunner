/**
 * The scenario world: one reusable world for the nine release scenarios (spec, "Phase 8 — Full
 * integration and release 1.0"). Everything runs in-process on the fake provider with no network
 * beyond 127.0.0.1: two humans (J and M) with one principal agent each (Alice and Bob) on two
 * installs that share one state store, a sample project in the fake git host with a plan, the
 * real session runner, PR executor, critic loop and memory loop per install, a scheduler per
 * install, the fake mail server and a simulated clock. Nothing here loosens a limit: the hooks,
 * the budget, the claims, the verdict rules and the retry ladder are the production code paths.
 *
 * ## API
 *
 * `scenarioWorld(options)` builds the world; `world.close()` tears it down (temp root removed).
 *
 * People and installs
 * - `world.j`, `world.m`: the humans (`id`, `name`, `email`, `timezone`, `login`, `mailbox`).
 * - `world.alice`, `world.bob`: the installs (`Install`): the human, the principal agent, the
 *   critic agent, the install's own token issuer, kill switch, hooks, driver, critic loop,
 *   memory loop, PR executor, session runner and scheduler, its worktree root, its git host
 *   client (`github`) and the grant a session runs with.
 * - `world.installs`: both, in order; `world.installOf(agentId)` finds one.
 *
 * Project and plan
 * - `world.project`: `{ id, milestoneId, repo, fullName, cloneUrl }`; the repository exists in
 *   the fake git host (`world.gitHost`) with the files from `options.project.files`.
 * - `world.addTask(input)`: one ready task of the plan (title, outcome, criteria, specialist,
 *   risk tier, priority, estimate, budget, dependsOn).
 * - `world.leaveNote(human, text, { kind, priority })`: an item in the next-session queue.
 * - `world.setEstimate(taskId, usdMicro)`: the plan estimate a session uses for the task.
 *
 * Running
 * - `world.runSession(install, { trigger, budgetCapUsdMicro, projectId })`: one session, resolved
 *   when it ends (manual trigger by default).
 * - `world.schedule(install, { time: "06:00", kind: "daily" | "weekdays" })`: a schedule on the
 *   install's scheduler (the human's time zone). `world.advanceTo(iso)` moves the simulated clock
 *   in scheduler ticks; sessions the schedulers start are in `world.scheduled` and
 *   `world.scheduledResult(install)` awaits the latest one of an install.
 * - `world.holdModelCalls(when)`: a hold on the model calls matching `when` (`ModelRequest`);
 *   `waiting` resolves with the first held request, `release()` lets them through. Scenarios use
 *   it to freeze a session mid-task deterministically.
 * - `world.holdPlan(install)`: the same for the install's planner (the session waits with its
 *   plan made, before it claims), so two sessions can plan the same task on purpose.
 * - `world.waitForEvent(install, type, predicate?)`: the next session event of that type.
 *
 * Reading back (real rows, never log text)
 * - `world.inbox(humanOrInstall)`: messages addressed to the human or the install's agent.
 * - `world.humanRequests(human, { status })`: the human's requests (questions, approvals).
 * - `world.changeLog(projectId?)`: the change log rows of the project.
 * - `world.auditRows(filter)`: audit rows (every tool call of every run).
 * - `world.eventsOf(sessionId)`: the session's event rows; `world.events` is the live list.
 * - `world.runEvents`: the loop driver's run events per task (model calls, tool calls, warnings).
 * - `world.briefs`: the brief text every session handed its planner.
 * - `world.pullRequests({ state })`, `world.fileOnHost(path, ref)`: the fake git host's view.
 * - `world.provider.calls`: every model request the fake provider saw.
 * - `world.mail`, `world.mailboxes`: the local mail server and the four mailboxes.
 *
 * ## Extending it
 *
 * Other scenarios add helper modules next to this one (`tests/e2e/src/scenario-<name>.ts`) that
 * take a `ScenarioWorld` and add what they need (fake STT/TTS providers, the state service, a
 * cloud runner) without editing this file. Options cover the common knobs: the clock start, the
 * script, the humans' names and time zones, the sample repository's files, project settings,
 * the session cap, the specialist caps, memory on or off, the mail server on or off.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  GitHubHost,
  PrTaskExecutor,
  type PullRequestInfo,
  type RepoRef,
} from "@forerunner/capabilities";
import { errorMessage, join, log, SimulatedClock } from "@forerunner/platform";
import {
  AllowAllCaps,
  CriticLoop,
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  LoopTaskExecutor,
  loadRegistry,
  MemoryLoop,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  NoSecrets,
  type Planner,
  type PlannerContext,
  ProviderRegistry,
  type Registry,
  type RunEvent,
  resolveRegistryDir,
  type Schedule,
  Scheduler,
  type SessionPlan,
  type SessionResult,
  SessionRunner,
  type SessionStartOptions,
  type SessionTriggerKind,
  type SpecialistSpec,
  type StartRequest,
  StaticPlanner,
  type StreamEvent,
  sessionCapFromSettings,
  statePorts,
  type TaskExecutor,
  TokenIssuer,
} from "@forerunner/runtime";
import { fileTools } from "@forerunner/runtime/daemon/tools";
import {
  type AuditFilter,
  type AuditLogRow,
  type ChangeLogRow,
  type EventRow,
  type HumanRequestRow,
  type HumanRequestStatus,
  type JsonObject,
  type MessageRow,
  openStore,
  type QueueItemRow,
  type QueueKind,
  type StateStore,
  type TaskRow,
} from "@forerunner/state";
import {
  FakeGitHost,
  FakeProvider,
  generateDkimKeyPair,
  LocalMailServer,
  type Mailbox,
  type ScriptedReply,
} from "@forerunner/testenv";
import { type CapturedBrief, flatPricing, SPECIALIST_TOOLS } from "./world.ts";

const logger = log("scenario-world");

/** Default start: midnight in Zurich on Tuesday 3 November 2026 (23:00Z the day before). */
export const DEFAULT_SCENARIO_START = "2026-11-02T23:00:00Z";
/** Default session cap: CHF 5 at 0.8 CHF per USD, the spec's default. */
export const DEFAULT_SCENARIO_SESSION_CAP_USD_MICRO = 6_250_000;
/** Real-time bound on a hold or an event wait, so a broken scenario fails instead of hanging. */
export const DEFAULT_HOLD_TIMEOUT_MS = 60_000;

export interface ScenarioHumanInput {
  name: string;
  email: string;
  timezone: string;
  agentName: string;
  /** Login on the fake git host. */
  login: string;
}

export interface ScenarioProjectInput {
  name?: string;
  goal?: string;
  /** Repository owner (an org on the fake git host, both humans are members) and name. */
  owner?: string;
  repo?: string;
  /** Files of the initial commit on main; keys are POSIX paths. */
  files?: Record<string, string>;
  /** Extra project settings (`checks`, `critic_ceiling`, `memory_token_budget`, ...). */
  settings?: JsonObject;
  milestone?: string;
  autonomyLevel?: number;
  budgetUsdMicro?: number;
}

export interface ScenarioWorldOptions {
  /** ISO start of the simulated clock. */
  start?: string;
  /** Initial script of the fake provider (more can be pushed through `world.provider`). */
  replies?: ScriptedReply[];
  /** What the fake provider does with an unscripted request (default "throw"). */
  onNoMatch?: "echo" | "throw";
  /** Wire the memory loop into the runner, the executor and the critic (default true). */
  memory?: boolean;
  /** Start the local mail server with a mailbox per human and agent (default true). */
  mail?: boolean;
  humans?: { j?: Partial<ScenarioHumanInput>; m?: Partial<ScenarioHumanInput> };
  project?: ScenarioProjectInput;
  /** Session cap when a session is started without one (and no project setting applies). */
  sessionCapUsdMicro?: number;
  /** Caps of the in-process specialists (registry prompt and caps, the file tools). */
  specialist?: { maxTurns?: number; maxBudgetUsdMicro?: number; timeoutMs?: number };
  /** Scheduler tick (simulated ms); `advanceTo` moves the clock in these steps. Default 60 s. */
  schedulerTickMs?: number;
  /** Real-time bound on holds and event waits. */
  holdTimeoutMs?: number;
}

export interface ScenarioHuman {
  id: string;
  name: string;
  email: string;
  timezone: string;
  login: string;
  mailbox: Mailbox | null;
}

export interface ScenarioTaskInput {
  title: string;
  outcome: string;
  acceptanceCriteria?: string[];
  specialist?: string;
  riskTier?: number;
  priority?: number;
  estimateUsdMicro?: number;
  budgetUsdMicro?: number;
  dependsOn?: string[];
}

export interface RunSessionOptions {
  trigger?: SessionTriggerKind;
  budgetCapUsdMicro?: number;
  projectId?: string;
  planApproved?: boolean;
}

export interface ScheduleInput {
  time: string;
  kind?: "daily" | "weekdays";
  projectId?: string;
  id?: string;
}

export interface ScenarioEvent {
  seq: number;
  agentId: string;
  agentName: string;
  projectId: string | null;
  trigger: SessionTriggerKind;
  type: string;
  payload: Record<string, unknown>;
  /** Simulated clock time when the event was raised. */
  at: string;
}

export interface RunEventRecord {
  agentId: string;
  taskId: string;
  event: RunEvent;
  at: string;
}

export interface ScheduledSession {
  agentId: string;
  request: StartRequest;
  /** Simulated time the scheduler started it. */
  at: string;
  result: Promise<SessionResult>;
}

export interface Hold<T> {
  /** Resolves with the first held item; rejects when the hold times out before one arrives. */
  waiting: Promise<T>;
  release(): void;
  readonly released: boolean;
}

export interface Install {
  name: string;
  human: ScenarioHuman;
  agent: { id: string; name: string };
  criticAgent: { id: string; name: string };
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  driver: LoopAgentDriver;
  /** The git host client of this install (its own token, by reference in production). */
  github: GitHubHost;
  /**
   * The token's value, only so a scenario can assert it leaked into no row or event. Never
   * print it; the install sends it as a header and the logger redacts its shape.
   */
  gitTokenValue: string;
  worktreeRoot: string;
  memoryRoot: string;
  memory: MemoryLoop | null;
  critic: CriticLoop;
  executor: PrTaskExecutor;
  runner: SessionRunner;
  scheduler: Scheduler;
  grant: SessionStartOptions["grant"];
}

export interface ScenarioProject {
  id: string;
  milestoneId: string;
  repo: RepoRef;
  fullName: string;
  cloneUrl: string;
}

export interface ScenarioWorld {
  clock: SimulatedClock;
  store: StateStore;
  /** The script and the call log; what the installs call is `gated`. */
  provider: FakeProvider;
  gated: GatedProvider;
  providers: ProviderRegistry;
  registry: Registry;
  gitHost: FakeGitHost;
  mail: LocalMailServer | null;
  /** Mailboxes by address local part: the humans' and the agents' (lower case). */
  mailboxes: Map<string, Mailbox>;
  j: ScenarioHuman;
  m: ScenarioHuman;
  alice: Install;
  bob: Install;
  installs: Install[];
  project: ScenarioProject;
  root: string;
  events: ScenarioEvent[];
  runEvents: RunEventRecord[];
  briefs: CapturedBrief[];
  scheduled: ScheduledSession[];
  installOf(agentId: string): Install;
  addTask(input: ScenarioTaskInput): Promise<TaskRow>;
  leaveNote(
    human: ScenarioHuman,
    text: string,
    opts?: { kind?: QueueKind; priority?: number },
  ): Promise<QueueItemRow>;
  setEstimate(taskId: string, usdMicro: number): void;
  runSession(install: Install, opts?: RunSessionOptions): Promise<SessionResult>;
  schedule(install: Install, input: ScheduleInput): Schedule;
  advanceTo(iso: string | number): Promise<void>;
  scheduledResult(install: Install): Promise<SessionResult>;
  holdModelCalls(when: (req: ModelRequest) => boolean): Hold<ModelRequest>;
  holdPlan(install: Install): Hold<PlannerContext>;
  waitForEvent(
    install: Install,
    type: string,
    predicate?: (e: ScenarioEvent) => boolean,
    opts?: { past?: boolean; timeoutMs?: number },
  ): Promise<ScenarioEvent>;
  inbox(target: ScenarioHuman | Install, opts?: { unreadOnly?: boolean }): Promise<MessageRow[]>;
  humanRequests(
    human: ScenarioHuman,
    opts?: { status?: HumanRequestStatus },
  ): Promise<HumanRequestRow[]>;
  changeLog(projectId?: string): Promise<ChangeLogRow[]>;
  auditRows(filter?: AuditFilter): Promise<AuditLogRow[]>;
  eventsOf(sessionId: string): Promise<EventRow[]>;
  pullRequests(opts?: { state?: "open" | "closed" | "all" }): Promise<PullRequestInfo[]>;
  fileOnHost(path: string, ref?: string): Promise<string | null>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Holds: a promise a scenario releases, bounded in real time

class HoldImpl<T> implements Hold<T> {
  readonly waiting: Promise<T>;
  readonly gate: Promise<void>;
  released = false;
  private resolveWaiting!: (v: T) => void;
  private rejectWaiting!: (e: Error) => void;
  private resolveGate!: () => void;
  private seen = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(label: string, timeoutMs: number) {
    this.waiting = new Promise<T>((res, rej) => {
      this.resolveWaiting = res;
      this.rejectWaiting = rej;
    });
    // A never-awaited rejection must not crash the process when the scenario ignores `waiting`.
    this.waiting.catch(() => undefined);
    this.gate = new Promise<void>((res) => {
      this.resolveGate = res;
    });
    this.timer = setTimeout(() => {
      if (this.released) return;
      logger.warn("hold timed out; releasing", { label, timeoutMs });
      if (!this.seen)
        this.rejectWaiting(new Error(`hold "${label}" saw nothing in ${timeoutMs} ms`));
      this.release();
    }, timeoutMs);
    this.timer.unref?.();
  }

  /** Called with every matching item; the first one resolves `waiting`. */
  async hold(item: T): Promise<void> {
    if (!this.seen) {
      this.seen = true;
      this.resolveWaiting(item);
    }
    if (this.released) return;
    await this.gate;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    this.resolveGate();
  }
}

/**
 * A model provider that can hold requests matching a predicate until a scenario releases them.
 * Same name as the inner provider so the ladder's model ids (`fake-sonnet`, ...) still apply.
 */
export class GatedProvider implements ModelProvider {
  readonly name: string;
  private readonly holds: { when: (req: ModelRequest) => boolean; hold: HoldImpl<ModelRequest> }[] =
    [];

  constructor(
    private readonly inner: ModelProvider,
    private readonly timeoutMs: number,
  ) {
    this.name = inner.name;
  }

  hold(when: (req: ModelRequest) => boolean, label = "model calls"): Hold<ModelRequest> {
    const hold = new HoldImpl<ModelRequest>(label, this.timeoutMs);
    this.holds.push({ when, hold });
    return hold;
  }

  releaseAll(): void {
    for (const h of this.holds) h.hold.release();
  }

  private async gate(req: ModelRequest): Promise<void> {
    for (const h of this.holds) {
      if (h.hold.released) continue;
      if (!h.when(req)) continue;
      await h.hold.hold(req);
    }
  }

  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    await this.gate(req);
    yield* this.inner.stream(req);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    await this.gate(req);
    return this.inner.complete(req);
  }
}

/**
 * The install's planner: the static planner (ready tasks in priority order) with the scenario's
 * estimate overrides, a hold a scenario can put before the plan, and the brief text captured.
 */
class ScenarioPlanner implements Planner {
  private readonly inner = new StaticPlanner();
  private hold: HoldImpl<PlannerContext> | null = null;

  constructor(
    private readonly briefs: CapturedBrief[],
    private readonly estimates: Map<string, number>,
    private readonly timeoutMs: number,
  ) {}

  holdNext(label: string): Hold<PlannerContext> {
    this.hold = new HoldImpl<PlannerContext>(label, this.timeoutMs);
    return this.hold;
  }

  release(): void {
    this.hold?.release();
  }

  async plan(ctx: PlannerContext): Promise<SessionPlan> {
    this.briefs.push({
      sessionId: ctx.session.id,
      agentId: ctx.session.agent_id,
      projectId: ctx.session.project_id,
      text: ctx.briefText,
    });
    const plan = await this.inner.plan(ctx);
    const items = plan.items.map((item) => {
      const override = this.estimates.get(item.taskId);
      return override === undefined ? item : { ...item, estimateUsdMicro: override };
    });
    // The hold sits after the plan is made from the ready tasks the runner read, so a held
    // session keeps a task in its plan that a peer claims meanwhile (the collision scenario).
    if (this.hold && !this.hold.released) await this.hold.hold(ctx);
    return {
      ...plan,
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
    };
  }
}

function withDefaults(
  partial: Partial<ScenarioHumanInput> | undefined,
  defaults: ScenarioHumanInput,
): ScenarioHumanInput {
  return { ...defaults, ...(partial ?? {}) };
}

// ---------------------------------------------------------------------------------------

export async function scenarioWorld(opts: ScenarioWorldOptions = {}): Promise<ScenarioWorld> {
  const clock = new SimulatedClock(opts.start ?? DEFAULT_SCENARIO_START);
  const holdTimeoutMs = opts.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  const store = await openStore({ url: "sqlite::memory:", clock });
  const root = await mkdtemp(join(tmpdir(), "fr-scenario-"));
  const registry = loadRegistry(resolveRegistryDir().dir);
  const provider = new FakeProvider({
    mode: "script",
    replies: opts.replies ?? [],
    clock,
    latency: "none",
    onNoMatch: opts.onNoMatch ?? "throw",
  });
  const gated = new GatedProvider(provider, holdTimeoutMs);
  const providers = new ProviderRegistry().register(gated);
  const ports = statePorts(store, { chfPerUsd: () => 0.8 });

  // People: two humans, one principal agent each, one critic agent per install (spec H.1).
  const jInput = withDefaults(opts.humans?.j, {
    name: "J",
    email: "j@example.test",
    timezone: "Europe/Zurich",
    agentName: "Alice",
    login: "j",
  });
  const mInput = withDefaults(opts.humans?.m, {
    name: "M",
    email: "m@example.test",
    timezone: "Europe/Zurich",
    agentName: "Bob",
    login: "m",
  });
  const insertHuman = async (h: ScenarioHumanInput) =>
    (
      await store.human.insert({
        name: h.name,
        email: h.email,
        timezone: h.timezone,
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 500_000_000,
        locale: "en",
      })
    ).id;
  const jId = await insertHuman(jInput);
  const mId = await insertHuman(mInput);

  // Mail: one local domain, a mailbox per human and per agent.
  const domain = jInput.email.split("@")[1] ?? "example.test";
  let mail: LocalMailServer | null = null;
  const mailboxes = new Map<string, Mailbox>();
  if (opts.mail !== false) {
    mail = await LocalMailServer.start({
      domains: [domain],
      dkim: { selector: "scenario", ...generateDkimKeyPair(2048) },
      clock,
    });
    const password = ["scenario", "mailbox", "pass"].join("-"); // not-a-secret
    for (const local of [
      jInput.email.split("@")[0] ?? "j",
      mInput.email.split("@")[0] ?? "m",
      jInput.agentName.toLowerCase(),
      mInput.agentName.toLowerCase(),
    ]) {
      mailboxes.set(local, mail.createMailbox(`${local}@${domain}`, password));
    }
  }
  const j: ScenarioHuman = {
    id: jId,
    ...jInput,
    mailbox: mailboxes.get(jInput.email.split("@")[0] ?? "") ?? null,
  };
  const m: ScenarioHuman = {
    id: mId,
    ...mInput,
    mailbox: mailboxes.get(mInput.email.split("@")[0] ?? "") ?? null,
  };

  // The git host: both humans are users, the project's org has both as members, one classic
  // token per human (the value stays in memory; the install sends it as a header).
  const gitHost = await FakeGitHost.start({ rootDir: join(root, "githost"), clock });
  gitHost.createUser({ login: j.login, name: j.name, email: j.email });
  gitHost.createUser({ login: m.login, name: m.name, email: m.email });
  const owner = opts.project?.owner ?? "sample";
  const repoName = opts.project?.repo ?? "service";
  gitHost.createOrg({ login: owner, members: [j.login, m.login] });
  const repoSummary = await gitHost.createRepo({
    owner,
    name: repoName,
    private: true,
    defaultBranch: "main",
    initialFiles: opts.project?.files ?? {
      "README.md": "# service\n\nA sample service for the release scenarios.\n",
      "src/index.ts": "export const service = { name: 'service' };\n",
    },
  });
  const fullName = `${owner}/${repoName}`;
  const repo: RepoRef = { owner, name: repoName };
  // Git over HTTP when `git http-backend` is present (pushes then raise the host's push and
  // pull_request events); the bare repository on disk otherwise (the REST API still serves PRs).
  const cloneUrl = gitHost.gitHttpAvailable ? gitHost.cloneUrl(fullName) : repoSummary.dir;
  if (!gitHost.gitHttpAvailable)
    logger.warn("git http-backend not found; cloning the bare repository directly");

  // The project with its plan container (one milestone).
  const projectId = (
    await store.project.insert({
      name: opts.project?.name ?? "Sample service",
      goal: opts.project?.goal ?? "A small service the two agents build together",
      repos: [fullName],
      stage: "build",
      status: "active",
      budget_usd_micro: opts.project?.budgetUsdMicro ?? 200_000_000,
      autonomy_level: opts.project?.autonomyLevel ?? 2,
      summary_cache: {},
      data_assets: [],
      settings: { ...(opts.project?.settings ?? {}) },
      small_project_mode: false,
      active: true,
      author_human: jId,
    })
  ).id;
  const milestoneId = (
    await store.milestone.insert({
      project_id: projectId,
      name: opts.project?.milestone ?? "Release 0.1",
      success_criteria: ["The planned tasks are done with a PR each"],
      order_index: 0,
      author_human: jId,
    })
  ).id;

  const events: ScenarioEvent[] = [];
  const runEvents: RunEventRecord[] = [];
  const briefs: CapturedBrief[] = [];
  const scheduled: ScheduledSession[] = [];
  const estimates = new Map<string, number>();
  const waiters: {
    agentId: string;
    type: string;
    predicate?: (e: ScenarioEvent) => boolean;
    resolve: (e: ScenarioEvent) => void;
  }[] = [];
  const planners = new Map<string, ScenarioPlanner>();
  const sessionCap = opts.sessionCapUsdMicro ?? DEFAULT_SCENARIO_SESSION_CAP_USD_MICRO;
  const tickMs = opts.schedulerTickMs ?? 60_000;

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
      // The registry's caps (as the daemon applies them) unless the scenario narrows them; a
      // held session may sit for simulated minutes, so a short timeout would end its run.
      maxBudgetUsdMicro:
        opts.specialist?.maxBudgetUsdMicro ?? Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: opts.specialist?.maxTurns ?? d.max_turns,
      timeoutMs: opts.specialist?.timeoutMs ?? d.timeout_minutes * 60_000,
    };
  };

  const emitEvent = (e: ScenarioEvent) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.agentId !== e.agentId || w.type !== e.type) continue;
      if (w.predicate && !w.predicate(e)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  };

  const makeInstall = async (human: ScenarioHuman, agentName: string): Promise<Install> => {
    const agentRow = await store.agent.insert({
      name: agentName,
      owner_human_id: human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    const criticRow = await store.agent.insert({
      name: `Critic (${agentName})`,
      owner_human_id: human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "critic",
    });
    const installRoot = join(root, `install-${agentName.toLowerCase()}`);
    const worktreeRoot = join(installRoot, "worktrees");
    const memoryRoot = join(installRoot, "memory");
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(memoryRoot, { recursive: true });
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
    const gitToken = gitHost.createToken({
      owner: human.login,
      kind: "classic",
      scopes: ["repo"],
    }).token;
    const github = new GitHubHost({ token: gitToken, baseUrl: gitHost.baseUrl, clock });
    const memory =
      opts.memory === false
        ? null
        : new MemoryLoop({ store, clock, root: memoryRoot, humanId: human.id });
    const billingSourceId = `bs-${agentName.toLowerCase()}`;
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
      ...(memory ? { memory } : {}),
    });
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
      ...(memory ? { memory } : {}),
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
        const project = await store.project.get(task.project_id);
        const full = project?.repos[0];
        if (!full?.includes("/")) return null;
        const [o, n] = full.split("/") as [string, string];
        const info = await github.getRepo({ owner: o, name: n });
        return {
          clone: gitHost.gitHttpAvailable ? info.cloneUrl : cloneUrl,
          repo: { owner: o, name: n },
          base: info.defaultBranch,
        };
      },
      worktreeRoot,
      token: gitToken,
      identity: { name: `${agentName} (Forerunner)`, email: human.email },
    });
    const planner = new ScenarioPlanner(briefs, estimates, holdTimeoutMs);
    planners.set(agentRow.id, planner);
    const runner = new SessionRunner({
      store,
      clock,
      tokens,
      kill,
      planner,
      executor,
      critic,
      ...(memory ? { memory } : {}),
    });
    const grant: SessionStartOptions["grant"] = {
      allowedTools: [...SPECIALIST_TOOLS],
      allowedPaths: [worktreeRoot],
      allowedDomains: [new URL(gitHost.baseUrl).host],
      grantedSecrets: [],
      maxDepth: 2,
    };
    const install: Install = {
      name: agentName,
      human,
      agent: { id: agentRow.id, name: agentRow.name },
      criticAgent: { id: criticRow.id, name: criticRow.name },
      tokens,
      kill,
      hooks,
      driver,
      github,
      gitTokenValue: gitToken,
      worktreeRoot,
      memoryRoot,
      memory,
      critic,
      executor,
      runner,
      // Filled below: the scheduler needs the install to start sessions for it.
      scheduler: undefined as unknown as Scheduler,
      grant,
    };
    install.scheduler = new Scheduler(
      {
        clock,
        // A scheduled start carries no cap (`StartRequest`); the session's cap comes from the
        // project's settings or the world's default, as the daemon's scheduler start does.
        start: (req) => {
          const result = startSession(install, {
            trigger: req.trigger,
            projectId: req.projectId,
          });
          scheduled.push({ agentId: install.agent.id, request: req, at: clock.nowIso(), result });
          return result;
        },
      },
      tickMs,
    );
    install.scheduler.start();
    return install;
  };

  /** One session of an install: the cap from the project's settings (a command's override wins). */
  const startSession = async (install: Install, o: RunSessionOptions): Promise<SessionResult> => {
    const pid = o.projectId ?? projectId;
    const project = await store.project.mustGet(pid);
    const cap =
      o.budgetCapUsdMicro ??
      sessionCapFromSettings(project.settings, clock.now(), sessionCap).usdMicro;
    const trigger = o.trigger ?? "manual";
    return install.runner.start({
      agentId: install.agent.id,
      projectId: pid,
      trigger,
      budgetCapUsdMicro: cap,
      appVersion: "1.0.0-scenario",
      grant: install.grant,
      ...(o.planApproved !== undefined ? { planApproved: o.planApproved } : {}),
      onEvent: (type, payload) =>
        emitEvent({
          seq: events.length,
          agentId: install.agent.id,
          agentName: install.agent.name,
          projectId: pid,
          trigger,
          type,
          payload,
          at: clock.nowIso(),
        }),
    });
  };

  const alice = await makeInstall(j, jInput.agentName);
  const bob = await makeInstall(m, mInput.agentName);
  await store.project.patch(projectId, {
    settings: {
      members: [alice.agent.id, bob.agent.id],
      ...(opts.project?.settings ?? {}),
    },
  });
  const installs = [alice, bob];
  const project: ScenarioProject = { id: projectId, milestoneId, repo, fullName, cloneUrl };

  const installOf = (agentId: string): Install => {
    const found = installs.find((i) => i.agent.id === agentId);
    if (!found) throw new Error(`no install for agent ${agentId}`);
    return found;
  };

  const world: ScenarioWorld = {
    clock,
    store,
    provider,
    gated,
    providers,
    registry,
    gitHost,
    mail,
    mailboxes,
    j,
    m,
    alice,
    bob,
    installs,
    project,
    root,
    events,
    runEvents,
    briefs,
    scheduled,
    installOf,
    addTask: (input) =>
      store.task.insert({
        project_id: projectId,
        milestone_id: milestoneId,
        title: input.title,
        outcome: input.outcome,
        acceptance_criteria: input.acceptanceCriteria ?? [
          "The outcome described in the goal is achieved and verified.",
        ],
        risk_tier: input.riskTier ?? 1,
        status: "ready",
        priority: input.priority ?? 5,
        depends_on: input.dependsOn ?? [],
        budget_usd_micro: input.budgetUsdMicro ?? 1_000_000,
        est_cost_usd_micro: input.estimateUsdMicro ?? 50_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "planned",
        specialist: input.specialist ?? "coder",
        author_human: jId,
      }),
    leaveNote: (human, text, o = {}) =>
      store.queue.enqueue({
        project_id: projectId,
        human_id: human.id,
        kind: o.kind ?? "note",
        text,
        priority: o.priority ?? 0,
        author_human: human.id,
      }),
    setEstimate: (taskId, usdMicro) => {
      estimates.set(taskId, usdMicro);
    },
    runSession: (install, o = {}) => startSession(install, o),
    schedule: (install, input) => {
      const s: Schedule = {
        id:
          input.id ?? `${install.agent.name.toLowerCase()}:${input.kind ?? "daily"}:${input.time}`,
        agentId: install.agent.id,
        projectId: input.projectId ?? projectId,
        kind: input.kind ?? "daily",
        time: input.time,
        timezone: install.human.timezone,
        enabled: true,
      };
      install.scheduler.add(s);
      return s;
    },
    advanceTo: async (iso) => {
      const target = typeof iso === "number" ? iso : new Date(iso).getTime();
      while (clock.now() < target) {
        await clock.advance(Math.min(tickMs, target - clock.now()));
      }
    },
    scheduledResult: (install) => {
      const mine = scheduled.filter((s) => s.agentId === install.agent.id);
      const last = mine[mine.length - 1];
      if (!last) return Promise.reject(new Error(`no scheduled session of ${install.name}`));
      return last.result;
    },
    holdModelCalls: (when) => gated.hold(when),
    holdPlan: (install) => {
      const planner = planners.get(install.agent.id);
      if (!planner) throw new Error(`no planner for ${install.name}`);
      return planner.holdNext(`plan of ${install.name}`);
    },
    waitForEvent: (install, type, predicate, o = {}) => {
      if (o.past) {
        const past = events.find(
          (e) => e.agentId === install.agent.id && e.type === type && (!predicate || predicate(e)),
        );
        if (past) return Promise.resolve(past);
      }
      return new Promise<ScenarioEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === done);
          if (i >= 0) waiters.splice(i, 1);
          reject(
            new Error(
              `no ${type} event of ${install.name} within ${o.timeoutMs ?? holdTimeoutMs} ms`,
            ),
          );
        }, o.timeoutMs ?? holdTimeoutMs);
        timer.unref?.();
        const done = (e: ScenarioEvent) => {
          clearTimeout(timer);
          resolve(e);
        };
        waiters.push({ agentId: install.agent.id, type, predicate, resolve: done });
      });
    },
    inbox: (target, o = {}) =>
      "agent" in target
        ? store.message.inbox({ agentId: target.agent.id }, { unreadOnly: o.unreadOnly })
        : store.message.inbox({ humanId: target.id }, { unreadOnly: o.unreadOnly }),
    humanRequests: (human, o = {}) =>
      store.humanRequest.list({
        human_id: human.id,
        ...(o.status ? { status: o.status } : {}),
      }),
    changeLog: (pid = projectId) => store.changeLog.forProject(pid),
    auditRows: (filter = {}) => store.auditLog.list(filter),
    eventsOf: (sessionId) => store.event.list(sessionId),
    pullRequests: (o = {}) => alice.github.listPullRequests(repo, { state: o.state ?? "all" }),
    fileOnHost: async (path, ref) => (await alice.github.getFile(repo, path, ref))?.content ?? null,
    close: async () => {
      gated.releaseAll();
      for (const p of planners.values()) p.release();
      for (const i of installs) i.scheduler.stop();
      try {
        await mail?.stop();
      } catch (e) {
        logger.warn("mail server did not stop cleanly", { error: errorMessage(e) });
      }
      try {
        await gitHost.stop();
      } catch (e) {
        logger.warn("git host did not stop cleanly", { error: errorMessage(e) });
      }
      await store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  return world;
}
