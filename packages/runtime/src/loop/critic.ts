import { existsSync, rmSync } from "node:fs";
import { DEPS_BASE_REF } from "@forerunner/capabilities";
import {
  applyVerdict,
  type CheckCommand,
  type CheckRunner,
  type CriticDeps,
  type CriticPromptSource,
  CriticService,
  DEFAULT_WORK_TIER,
  escalationCeiling,
  type FollowupDecision,
  type MeasuredFinding,
  measuredFindingOf,
  quotedWords,
  RETRY_CARD_OPTIONS,
  type ReviewEvidence,
  type ReviewOutput,
  type ReviewTier,
  retryCardWords,
  saidByName,
  signoffCard,
  type TriedEvidence,
  triedTimes,
} from "@forerunner/critic";
import { checkDocDrift, STATUS_DOC } from "@forerunner/memory";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  type RunOptions,
  type RunResult,
  run as runProcess,
  safeSegment,
  stripAnsi,
  which,
  withoutForcedColour,
} from "@forerunner/platform";
import type { JsonObject, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import type { LoopAgentDriver, RunPricing } from "../agent/loop.ts";
import type { ToolSpec } from "../agent/tools.ts";
import type { ContextManager } from "../context/manager.ts";
import { fileTools } from "../daemon/tools.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import { DEFAULT_CEILING, nextRung, retryAction, tierOfModel } from "../models/ladder.ts";
import type { EffectiveModelConfig } from "../models/settings.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { ModelTier } from "../provider/types.ts";
import type { Sandbox } from "../sandbox/types.ts";
import type { RunSandboxPort } from "../session/executor.ts";
import { screenLessons } from "../session/lessons.ts";
import { TASK_FILES_EVENT } from "../session/peers.ts";
import {
  filePersonQuestions,
  listedQuestions,
  questionsReason,
  reportedQuestions,
  wentAheadWithout,
} from "../session/person-questions.ts";
import { withReviewWait } from "../session/review-refusal.ts";
import { keptSourcesOf, type WebSource, webSourceEvidence } from "../session/web-sources.ts";
import {
  type CriticPort,
  type LessonCandidate,
  type MemoryPort,
  PROMOTION_REVIEW_BUDGET_USD_MICRO,
  type PromotionReviewOutcome,
  type PromotionReviewRequest,
  type RetryRung,
  type ReviewDecision,
  type ReviewFindingSummary,
  type SessionReviewOutcome,
  type SessionReviewRequest,
  type TaskReviewOutcome,
  type TaskReviewRequest,
} from "./ports.ts";
import {
  isCodeChange,
  type MarkerCheck,
  markerChecks,
  notRunWords,
  PROJECT_CHECK_TIMEOUT_MS,
  projectChecks,
  projectFileList,
  scriptsBefore,
  untestedFiles,
} from "./project-checks.ts";
import { MAX_PAGES_TRIED, pagesToTry, type TryItPort } from "./try-it.ts";
import { planTries, TRY_FOLDER, type TryPlan } from "./try-plan.ts";
import { holdFolder, runTries } from "./try-run.ts";
import { outcomeCriterion, reviewFloorOf, reviewTierOf, signoffReasonOf } from "./verification.ts";

/**
 * The critic in the loop (spec H, phase 3). For every task the runner finished above the
 * mechanical path, this port assembles the evidence (the diff of the PR branch or the
 * worktree, the changed files, the project's check commands, the standard-doc drift, the
 * specialist's final report as claims), runs `@forerunner/critic` at the task's tier under the
 * project's ceiling and speed-versus-quality offset, and applies the verdict through the
 * state workflow with the retry ladder of spec D.2:
 *
 *   accept  -> findings resolved, in_review -> done (refused while another finding is open);
 *   revise  -> failed -> ready (attempt + 1) and the owner agent is told; after the ladder's
 *              last rung the human decides instead;
 *   escalate-> the runtime's retry policy from the attempt count: improve the brief, split or
 *              change the specialist, one rung up under the ceiling, then the human;
 *   human   -> needs_human with the sign-off request.
 *
 * A run whose report says it needs the person's answers (U-022, `reportedQuestions`) and that
 * the critic does not accept goes to the person instead: its questions are filed in the Inbox
 * (no sign-off), the task waits in needs_human, and no rung of the ladder runs.
 *
 * Repeat findings the critic turned into lesson proposals go to critic memory through the
 * memory port. Nothing here loosens a rule of the critic package; it only feeds it.
 */
export interface CriticLoopDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  driver: LoopAgentDriver;
  providers: ProviderRegistry;
  providerName: string;
  prompt: CriticPromptSource;
  pricing: (modelId: string) => RunPricing;
  billingSourceId: string;
  /** The critic AgentRow (kind `critic`). */
  criticAgentId: string;
  /** Session pipelines, so the critic's evidence shows the compression bypass (ADR 0003). */
  context?: ContextManager;
  /** Lesson proposals (repeat findings) are recorded in critic memory through this. */
  memory?: Pick<MemoryPort, "record">;
  /** Where `PrTaskExecutor` keeps worktrees (`<worktrees>/<task id>`), for the diff. */
  worktreeRoot?: string;
  /** The diff of the work under review; default: git in the worktree. Tests inject one. */
  diff?: DiffPort;
  /** Process runner for the default diff port. */
  run?: (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;
  /** Session review tier (H.6); default 0 (deterministic checks, no model). */
  sessionReviewTier?: ReviewTier;
  /** Check runner for the critic package (sandboxed executors inject one). */
  checkRunner?: CriticDeps["checkRunner"];
  /**
   * The ladder and effort table in force (ADR 0039), read at every review's model pick and
   * when the rung a run sat on is looked up, never once: an adopted rung or effort reaches
   * the next review without a restart. Absent: the built-in tables.
   */
  modelConfig?: () => EffectiveModelConfig;
  /**
   * Opus fast mode (spec D.20, ADR 0057): the kind of the critic's billing source and the
   * price table in force, read at every review, so a project's `fast_mode` reaches its Opus
   * reviews on an API-style source. Absent: the critic package's default (API-style, built-ins).
   */
  fastMode?: CriticDeps["fastMode"];
  /**
   * The sandbox every run opens a lease on (ADR 0007, U-079): the review's checks (the project's
   * build, lint and tests, ADR 0104) run in a lease on the task's folder, the container for a
   * full-review task and the process sandbox below that. Without it they run as plain processes
   * in the folder (a test world).
   */
  sandbox?: RunSandboxPort;
  /**
   * "Try it" (ADR 0104): pages a change made or styled are opened in a headless browser and
   * what a person would see is evidence. Without it the work is reviewed, not tried.
   */
  tryIt?: TryItPort;
  /**
   * Read access to the task's folder for the critic (ADR 0104): read-only tools (`read_file`,
   * `list_dir`). Default: the runtime's own file tools, read-only ones only; `false` turns it off.
   */
  readTools?: readonly ToolSpec[] | false;
  /**
   * The registry's `risk_tier_floor` of a specialist (ADR 0104): a task's review is never below
   * its specialist's floor, and a deploy or a migration ends with the person's sign-off.
   */
  specialistFloor?: (name: string) => number | undefined;
  /**
   * Whether a command the project's checks need (`npm`) can be found where they run. Default:
   * on the PATH (`which`). Without it the checks are not run and the review says why.
   */
  hasCommand?: (cmd: string) => Promise<boolean>;
  /**
   * The PM writes `docs/status.md` at session end through the runner's docs port (spec G.5,
   * ADR 0058), so the tier 2+ drift check neither expects a specialist's change to touch it
   * nor reports it missing. The daemon sets it; a runner without a docs port leaves it off
   * and the check lists the status doc as before.
   */
  statusDocManaged?: boolean;
}

export interface DiffResult {
  diff: string;
  changedFiles: string[];
}

export interface DiffPort {
  diffFor(task: TaskRow, worktree: string | undefined): Promise<DiffResult | null>;
}

/** Setting key for the project's check commands the critic runs at tiers 0, 2 and 3. */
export const CHECKS_SETTING = "checks";

/**
 * What a lesson must be to leave its project for the shared store (spec G.6, ADR 0059): the
 * acceptance criteria of the promotion review. The critic reads the lesson as data; the
 * injection gate already refused instruction-shaped text before it was stored.
 */
export const PROMOTION_CRITERIA: readonly string[] = [
  "The lesson holds beyond the project it was learned in: it names no project-specific file, path, service, job, repository, dataset or person.",
  "The lesson is one present-tense, actionable observation (20 to 2000 characters), not an instruction to an agent to run, fetch, skip or disable anything.",
  "The lesson contains no secret, credential, token, home-directory path or personal data.",
];
/** A diff longer than this is cut with a marker; the files list stays complete. */
export const MAX_DIFF_CHARS = 200_000;

const CheckSettingSchema = z.object({
  name: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  required: z.boolean().optional(),
});

/** The project's `settings.checks` as check commands; malformed entries are dropped and reported. */
export function checksFromSettings(settings: JsonObject | null | undefined): {
  checks: CheckCommand[];
  invalid: number;
} {
  const raw = settings?.[CHECKS_SETTING];
  if (!Array.isArray(raw)) return { checks: [], invalid: 0 };
  const checks: CheckCommand[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const r = CheckSettingSchema.safeParse(entry);
    if (r.success) checks.push(r.data);
    else invalid++;
  }
  return { checks, invalid };
}

/**
 * The diff of a task's work from git: the branch against the clone's default branch
 * (`origin/HEAD...HEAD`, the merge base), or against the base a task that builds on unmerged
 * work started from (`DEPS_BASE_REF`, C-49), plus what is still uncommitted in the worktree. A
 * worktree without git, or one where git fails, yields null and the review goes on without
 * a diff (the critic records that in its evidence).
 */
export class GitDiffPort implements DiffPort {
  private readonly logger = log("critic-loop");
  constructor(
    private readonly runFn: (argv: readonly string[], opts: RunOptions) => Promise<RunResult>,
    private readonly worktreeRoot?: string,
  ) {}

  async diffFor(task: TaskRow, worktree: string | undefined): Promise<DiffResult | null> {
    const dir =
      worktree ?? (this.worktreeRoot ? join(this.worktreeRoot, safeSegment(task.id)) : undefined);
    if (!dir) return null;
    const git = (args: string[]) =>
      this.runFn(["git", ...args], { cwd: dir, allowFailure: true, timeoutMs: 60_000 });
    try {
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0) return null;
      // A task that builds on unmerged work (C-49, ADR 0106) started from the default branch
      // with its dependencies' branches merged in (`DEPS_BASE_REF`): its own change is what it
      // added on top of that, never the dependencies' files. Any other task: its branch
      // against the default branch, from where they part.
      const depsBase =
        (await git(["rev-parse", "--verify", "--quiet", `${DEPS_BASE_REF}^{commit}`])).code === 0;
      const hasOrigin = (await git(["rev-parse", "--verify", "--quiet", "origin/HEAD"])).code === 0;
      const range = depsBase ? [DEPS_BASE_REF, "HEAD"] : hasOrigin ? ["origin/HEAD...HEAD"] : null;
      const parts: string[] = [];
      const files = new Set<string>();
      // The diff the critic reads is git's own, plain: a person's `color.ui=always` or external
      // diff tool in their git config never reaches it.
      if (range) {
        const committed = await git(["diff", "--no-color", "--no-ext-diff", ...range]);
        if (committed.code === 0 && committed.stdout.trim()) parts.push(committed.stdout);
        const names = await git(["diff", "--name-only", ...range]);
        for (const f of names.stdout.split(/\r?\n/)) if (f.trim()) files.add(f.trim());
      }
      const pending = await git(["diff", "--no-color", "--no-ext-diff", "HEAD"]);
      if (pending.code === 0 && pending.stdout.trim()) parts.push(pending.stdout);
      const pendingNames = await git(["diff", "--name-only", "HEAD"]);
      for (const f of pendingNames.stdout.split(/\r?\n/)) if (f.trim()) files.add(f.trim());
      const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
      for (const f of untracked.stdout.split(/\r?\n/)) if (f.trim()) files.add(f.trim());
      let diff = parts.join("\n");
      if (diff.length > MAX_DIFF_CHARS)
        diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[... diff cut at ${MAX_DIFF_CHARS} characters; ${files.size} file(s) changed]`;
      return { diff, changedFiles: [...files] };
    } catch (e) {
      this.logger.warn("diff failed", { taskId: task.id, error: errorMessage(e) });
      return null;
    }
  }
}

export class CriticLoop implements CriticPort {
  private readonly logger = log("critic-loop");
  readonly service: CriticService;
  private readonly diffPort: DiffPort;

  constructor(private readonly deps: CriticLoopDeps) {
    this.service = new CriticService(this.serviceDeps());
    this.diffPort = deps.diff ?? new GitDiffPort(deps.run ?? runProcess, deps.worktreeRoot);
  }

  /**
   * The critic package's deps. `ladder` and `modeDefaults` are accessors over the tables in
   * force, not copies: `CriticService` reads them at every pick, so a rung or an effort a
   * human adopted after this loop was built decides the next review (ADR 0039). Without a
   * `modelConfig` the package's built-in tables apply.
   */
  private serviceDeps(context?: CriticDeps["context"]): CriticDeps {
    const { deps } = this;
    const base: CriticDeps = {
      store: deps.store,
      clock: deps.clock,
      tokens: deps.tokens,
      driver: deps.driver,
      providers: deps.providers,
      providerName: deps.providerName,
      prompt: deps.prompt,
      pricing: deps.pricing,
      billingSourceId: deps.billingSourceId,
      criticAgentId: deps.criticAgentId,
      ...(context ? { context } : {}),
      ...(deps.checkRunner ? { checkRunner: deps.checkRunner } : {}),
      ...(deps.fastMode ? { fastMode: deps.fastMode } : {}),
    };
    const modelConfig = deps.modelConfig;
    if (!modelConfig) return base;
    return {
      ...base,
      get ladder() {
        return modelConfig().ladder;
      },
      get modeDefaults() {
        return modelConfig().modeDefaults;
      },
    };
  }

  get criticAgentId(): string {
    return this.deps.criticAgentId;
  }

  async reviewTask(req: TaskReviewRequest): Promise<TaskReviewOutcome> {
    const { store } = this.deps;
    const { task, session, result } = req;
    // Every task is reviewed by the critic (ADR 0104): a task at tier 0 gets the light review,
    // the lowest review there is ("automated checks only" no longer closes a task), never below
    // its specialist's registry floor; an accepted deploy or migration ends with the person's
    // sign-off whatever its tier says.
    const specialist = req.item.specialist || task.specialist;
    const tier = reviewTierOf(task.risk_tier, reviewFloorOf(specialist, this.deps.specialistFloor));
    const signoff = signoffReasonOf(specialist);
    const project = await store.project.get(task.project_id);
    const settings = project?.settings ?? null;
    const worktree =
      result.worktree ??
      (this.deps.worktreeRoot ? join(this.deps.worktreeRoot, safeSegment(task.id)) : undefined);

    // Evidence: the diff and the changed files, the project's checks, the standard-doc drift.
    const diff = await this.diffPort.diffFor(task, worktree);
    const runFiles = result.changedFiles?.length ? result.changedFiles : (diff?.changedFiles ?? []);
    // What the task changed over all its attempts, this run's files first (ADR 0104, the review
    // of 2026-11-02): the review checks the task's work, not the last run's diff. On the bench a
    // retry that changed no file got no checks and no try, its accept closed a test that still
    // failed, and the task was Done. (On the workspace path every run is committed, so the diff
    // of a run that changed nothing is empty.)
    const changedFiles = await this.filesOfTask(task.id, session.id, runFiles);
    // A failed check or try still open is measured again, whatever this run changed.
    const measured = (await store.finding.openFor(task.id))
      .map((f) => measuredFindingOf(f.description))
      .filter((m): m is MeasuredFinding => m !== null);
    const { checks: configured, invalid } = checksFromSettings(settings);
    // ADR 0104: the project's build, lint and tests always run for a code task, besides the
    // commands the project's settings name.
    const root = worktree && existsSync(worktree) ? worktree : undefined;
    const code = isCodeChange(changedFiles) || measured.some((m) => m.kind === "check");
    // L-5: a task that changed package.json is checked with the scripts as they were before it.
    const before =
      code && root && changedFiles.includes("package.json")
        ? await scriptsBefore(root, task.id, this.deps.run ?? runProcess)
        : null;
    const own = code ? projectChecks(root, before) : { checks: [], skipped: null, notes: [] };
    const ownChecks = own.checks.filter((c) => !configured.some((k) => k.name === c.name));
    let checks = [...configured, ...ownChecks];
    // C-3: the project's tests in other languages, found by their marker files.
    let markers: MarkerCheck[] = code
      ? markerChecks(root).filter((m) => !configured.some((k) => k.name === m.name))
      : [];
    const untested = code ? untestedFiles(root) : null;
    // C-1 (ADR 0110): a command line tool is run, a server started and called, in the lease.
    let plan: TryPlan = code
      ? planTries({
          changedFiles,
          root,
          brief: {
            title: task.title,
            outcome: task.outcome,
            criteria: task.acceptance_criteria,
          },
        })
      : { commands: [], servers: [], notTried: [] };
    const report = result.finalReport ?? result.summary;
    const questions = listedQuestions(report);
    const evidence: ReviewEvidence = {
      acceptanceCriteria: task.acceptance_criteria.length
        ? task.acceptance_criteria
        : [outcomeCriterion(task.outcome)],
      brief: `${task.title}: ${task.outcome}`,
      // W15-25: the site rule the run read pages under, which the critic judges a refusal by.
      ...(result.webRule ? { webRule: result.webRule } : {}),
      finalReport: report,
      ...(questions.length ? { questionsForPerson: questions } : {}),
      notChecked: [
        ...(own.skipped ? [own.skipped] : []),
        ...(untested ? [untested] : []),
        ...plan.notTried,
      ],
      ...(signoff ? { signoffRequired: signoff } : {}),
      ...(diff?.diff ? { diff: diff.diff } : {}),
      ...(changedFiles.length ? { changedFiles } : {}),
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      artifacts: [
        `attempt ${task.attempt + 1} by ${req.item.specialist}`,
        ...(runFiles.length === 0 && changedFiles.length
          ? [
              `attempt ${task.attempt + 1} changed no file; the changed files listed are what the task's earlier attempts changed, and its checks and tries ran on them again`,
            ]
          : []),
        ...(invalid ? [`${invalid} malformed check(s) in settings.checks ignored`] : []),
        ...own.notes,
        ...(result.artifacts ?? []).map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
      ],
    };
    // The web pages the run read (ADR 0107): the critic checks each cited claim against the
    // text the specialist got, as data, and sees which pages could not be read.
    // 'web-search': the search results it saw but did not open are listed beside the pages, and a
    // claim whose only source is one of them is not sourced.
    // W15-26: and the pages earlier runs of the task read, which the work may rest on (live
    // check 2, research F6: a run paused at its budget after reading ten pages, the continued
    // run read none, and its review saw none and was told the evidence was complete).
    const sources = webSourceEvidence(
      result.webSources,
      result.searchSeen,
      await this.sourcesOfTask(task.id, result.runId),
    );
    if (sources.inputFiles.length)
      evidence.inputFiles = [...(evidence.inputFiles ?? []), ...sources.inputFiles];
    if (sources.artifacts.length)
      evidence.artifacts = [...(evidence.artifacts ?? []), ...sources.artifacts];
    if (sources.unavailable.length)
      evidence.unavailable = [...(evidence.unavailable ?? []), ...sources.unavailable];
    if (tier >= 2 && worktree && changedFiles.length) {
      // Doc drift of the project's standard doc set (spec G.5, memory package); a drift is a
      // non-required check, so it is a low finding the human sees and the PM fixes at session
      // end, never a reason to block a correct change (ADR 0036). The status doc the PM
      // itself writes after this review (`statusDocManaged`) is not the specialist's drift.
      try {
        const drift = (await checkDocDrift(worktree, { changedFiles, tasksChanged: true })).filter(
          (d) => !(this.deps.statusDocManaged && d.doc === STATUS_DOC),
        );
        evidence.checkResults = [
          {
            name: "docs-drift",
            passed: drift.length === 0,
            output: drift.length
              ? drift.map((d) => `${d.doc}: ${d.reason}`).join("\n")
              : "standard docs consistent with the change",
            required: false,
          },
        ];
        evidence.docsTouched = changedFiles.filter(
          (f) => f === "README.md" || f.startsWith("docs/"),
        );
      } catch (e) {
        this.logger.warn("doc drift check failed", { taskId: task.id, error: errorMessage(e) });
      }
    }

    // Try it (ADR 0104): a page the task made or styled is opened as a person would, and a
    // page an open finding says did not work is opened again first.
    const again = measured.flatMap((m) =>
      m.kind === "tried" && root && existsSync(join(root, ...m.target.split("/")))
        ? [m.target]
        : [],
    );
    const pages = this.deps.tryIt
      ? [...new Set([...again, ...pagesToTry(changedFiles, root)])].slice(0, MAX_PAGES_TRIED)
      : [];
    if (pages.length && root && this.deps.tryIt) {
      try {
        const tried = await this.deps.tryIt.tryPages({
          taskId: task.id,
          reviewKey: safeSegment(result.runId ?? `attempt-${task.attempt + 1}`),
          root,
          pages,
          // ADR 0110: a full review's page is opened only with the browser's own sandbox.
          ...(tier >= 2 ? { fullReview: true } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        if ("tried" in tried)
          evidence.tried = tried.tried.map((t) => attributeTry(t, changedFiles));
        else evidence.notChecked?.push(`${pagesWords(pages)} not tried: ${tried.unavailable}`);
      } catch (e) {
        evidence.notChecked?.push(
          `${pagesWords(pages)} not tried: ${errorMessage(e).split("\n")[0]?.slice(0, 200)}`,
        );
      }
    }
    // A review stopped while its page was opened (a Cancel in the first moment of "Being
    // reviewed", Stop now, Quit; L-8) goes no further: no lease, no checks, no critic run.
    if (req.signal?.aborted)
      throw new ForerunnerError("killed", "the review was stopped before it began");
    // Read access to the task's folder (ADR 0104): the critic reads what it needs, not only
    // the diff; the list of the folder's files saves it a call.
    const readTools =
      this.deps.readTools === false ? [] : (this.deps.readTools ?? defaultReadTools());
    if (root && readTools.length) evidence.projectFiles = projectFileList(root);

    const sessionContext = await this.deps.context?.forSession(session.id, task.project_id);
    const criticService = sessionContext
      ? new CriticService(this.serviceDeps(sessionContext.pipeline))
      : this.service;
    const owner = req.token.claims.ownerHumanId;
    // The checks run in the task's sandbox (the container for a full review, the process
    // sandbox below that), never on the host when a sandbox port is wired: a lease the port
    // refuses means the checks are not run, and the review says why.
    let lease: Awaited<ReturnType<RunSandboxPort["open"]>> | null = null;
    const tries = plan.commands.length + plan.servers.length;
    if ((checks.length || markers.length || tries) && root && this.deps.sandbox) {
      try {
        lease = await this.deps.sandbox.open({
          task,
          worktree: root,
          allowedDomains: [],
          timeoutMs: Math.max(
            PROJECT_CHECK_TIMEOUT_MS,
            checks.reduce((n, c) => n + (c.timeoutMs ?? 120_000), 0),
          ),
          signal: req.signal ?? new AbortController().signal,
        });
      } catch (e) {
        this.logger.warn("review sandbox not opened; the checks are not run", {
          taskId: task.id,
          error: errorMessage(e),
        });
        const why = `the sandbox could not be opened (${errorMessage(e).split("\n")[0]?.slice(0, 200)})`;
        const names = [...checks.map((c) => c.name), ...markers.map((m) => m.name)];
        if (names.length) evidence.notChecked?.push(`${names.join(", ")} not run: ${why}`);
        for (const t of [...plan.commands, ...plan.servers])
          evidence.notChecked?.push(`${t.target} was not tried: ${why}`);
        checks = [];
        markers = [];
        plan = { ...plan, commands: [], servers: [] };
      }
    } else if (tries && root) {
      // A runner composed without a sandbox (a test world): nothing the work made is started on
      // the host.
      for (const t of [...plan.commands, ...plan.servers])
        evidence.notChecked?.push(`${t.target} was not tried: there is no sandbox to run it in`);
      plan = { ...plan, commands: [], servers: [] };
    }
    // The project's scripts need npm where they run (in the lease, whose environment is not
    // the daemon's); without it they are not run, and the review says so instead of failing the
    // work for a tool the computer lacks, or failing the review on a command that cannot start.
    if (ownChecks.length && checks.length) {
      const hasNpm = this.deps.hasCommand
        ? await this.deps.hasCommand("npm")
        : lease
          ? await startsIn(lease.sandbox, ["npm", "--version"])
          : await onPath("npm");
      if (!hasNpm) {
        evidence.notChecked?.push(
          `${notRunWords(ownChecks.map((c) => c.name))}: npm is not installed where the checks run`,
        );
        checks = checks.filter((c) => !ownChecks.includes(c));
      }
    }
    let output: ReviewOutput;
    try {
      if (root) {
        const held = lease;
        // A check's output is read, not shown in a terminal: no colour (`PLAIN_CHECK_ENV`).
        const exec: ExecFn = held
          ? (argv, o) =>
              held.sandbox.run(argv, {
                timeoutMs: o.timeoutMs,
                maxOutputBytes: 256 * 1024,
                env: { ...PLAIN_CHECK_ENV, ...(o.env ?? {}) },
                ...(req.signal ? { signal: req.signal } : {}),
              })
          : (argv, o) =>
              runProcess(argv, {
                cwd: root,
                allowFailure: true,
                timeoutMs: o.timeoutMs,
                env: withoutForcedColour({ ...process.env, ...(o.env ?? {}) }),
                ...(req.signal ? { signal: req.signal } : {}),
              });
        for (const m of markers) {
          const r = await runMarkerCheck(m, exec, root);
          if ("notRun" in r) evidence.notChecked?.push(r.notRun);
          else evidence.checkResults = [...(evidence.checkResults ?? []), r.result];
        }
        if (held && (plan.commands.length || plan.servers.length)) {
          const ran = await runTries(plan, {
            sandbox: held.sandbox,
            root,
            // The runner image has `node`; the process sandbox starts the daemon's own Node.
            node: held.sandbox.kind === "process" ? process.execPath : "node",
            ...(req.signal ? { signal: req.signal } : {}),
          });
          if (ran.tried.length) evidence.tried = [...(evidence.tried ?? []), ...ran.tried];
          evidence.notChecked?.push(...ran.notTried);
        }
      }
      output = await (lease
        ? new CriticService({
            ...this.serviceDeps(sessionContext?.pipeline),
            checkRunner: sandboxCheckRunner(lease.sandbox),
          })
        : criticService
      ).review(
        { subject: { kind: "task", taskId: task.id }, tier, evidence },
        {
          sessionToken: req.token,
          budget: req.budget,
          projectSettings: settings,
          checks,
          cwd: worktree,
          signal: req.signal,
          humanId: owner,
          ...(root && readTools.length ? { project: { root, tools: readTools } } : {}),
        },
      );
    } catch (e) {
      // A credential refused the review and no other could serve it (ADR 0100 point 9): what it
      // waits for is kept for the task's project, and the session lets the task wait.
      throw await withReviewWait(e, {
        provider: this.deps.providers.get(this.deps.providerName),
        store,
        nowMs: this.deps.clock.now(),
        projectId: task.project_id,
        agentId: req.agentId,
        onError: (what, err) =>
          this.logger.warn(what, { taskId: task.id, error: errorMessage(err) }),
      });
    } finally {
      await lease?.sandbox.destroy().catch(() => {});
      // The try's own files (samples, a build folder of the checks) never stay in the folder.
      if (root) rmSync(join(root, TRY_FOLDER), { recursive: true, force: true });
    }

    // The rung the failed attempt ran on, for the ladder: the Run row's model.
    const currentTier = await this.tierOfRun(result.runId);
    const ceiling = (await escalationCeiling(store, task)) ?? DEFAULT_CEILING;
    let decision: ReviewDecision;
    let followup: FollowupDecision | null = null;
    let blockedOpen = 0;
    // U-022: a run that reports it needs the person's answers and that the critic does not
    // accept waits for the person. Its questions are filed, not a sign-off (which asks nothing
    // the person can answer), and the retry ladder stops at this first verdict: a rerun by a
    // specialist cannot answer them, it only spends again. Once the person chose "Go ahead
    // without" on the task, a run that still cannot go on without them (an input file that is
    // missing) asks once more, in its own words, but without offering Go ahead without again
    // (live L-3: the second card offered it again, which only ran the same ask, a run's cost
    // each time).
    const reported =
      output.verdict === "accept" ? null : reportedQuestions(result.finalReport ?? result.summary);
    let askedPerson: string | undefined;
    if (reported) {
      askedPerson = await this.askPersonInstead({
        task,
        output,
        result,
        sessionId: session.id,
        humanId: owner,
        agentId: req.agentId,
        questions: reported.questions,
      });
      decision = "human";
    } else {
      try {
        followup = await applyVerdict(task.id, output, {
          store,
          criticAgentId: this.deps.criticAgentId,
          currentTier,
          humanId: owner,
          ownerAgentId: req.agentId,
          runId: result.runId ?? null,
          sessionId: session.id,
          // A retry card quotes the specialist's own report (design §3.8).
          workReport: result.finalReport ?? result.summary,
          specialist: req.item.specialist,
        });
        decision = followup.action;
      } catch (e) {
        if (e instanceof ForerunnerError && e.code === "findings_open") {
          // B.4: the verdict was accept but a finding of an earlier review is still open. The
          // task stays in review; the runner surfaces it and the next attempt resolves it.
          decision = "blocked_by_findings";
          blockedOpen = (await store.finding.openFor(task.id)).length;
        } else throw e;
      }
    }

    // The retry ladder (D.2) also runs for a plain revise: after the last rung the human
    // decides instead of an endless loop of revisions.
    let retry: RetryRung | undefined;
    let nextTier: ModelTier | null | undefined;
    let humanRequestId = askedPerson ?? output.humanRequestId;
    let attempt = followup ? followup.task.attempt : task.attempt;
    let current = followup?.task ?? (await store.task.mustGet(task.id));
    if (followup?.action === "retry") {
      retry = followup.retry;
      nextTier = followup.nextTier;
      humanRequestId = undefined;
    } else if (followup?.action === "human") {
      humanRequestId = followup.humanRequestId;
    } else if (followup?.action === "revise") {
      const rung = retryAction(followup.attempt, currentTier, ceiling);
      if (rung === "human") {
        // How often it was tried (its runs), not the retry counter (design §1, true now), which
        // Try again's way back to ready also moves: the card and the Tasks tab's "tried N
        // times" (read from this reason) say the same number.
        const tried = await triedTimes(store, task.id, followup.attempt);
        current = await store.task.transition(
          current.id,
          current.version,
          "needs_human",
          `retry ladder exhausted after ${tried} failed attempt(s) at ${currentTier} (ceiling ${ceiling}): human decides`,
          { agentId: this.deps.criticAgentId },
        );
        // Design §3.8: one card after the last retry. Its title names the task and how often
        // it failed; its body is what the specialist said about its work, in its own words (the
        // critic's summary only when the run reported nothing); the options say what they do.
        const reported = quotedWords(result.finalReport ?? result.summary);
        const said = reported ?? quotedWords(output.summary);
        const saidBy = reported ? saidByName(req.item.specialist) : "critic";
        const words = retryCardWords({ title: task.title, attempts: tried, said, saidBy });
        const request = await store.humanRequest.insert({
          human_id: owner,
          project_id: task.project_id,
          task_id: task.id,
          session_id: session.id,
          kind: "approval",
          why: words.why.slice(0, 4000),
          steps: output.findings.map(
            (f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`,
          ),
          options: [...RETRY_CARD_OPTIONS],
          blocking: true,
          risk: output.findings.some((f) => f.severity === "critical" || f.severity === "high")
            ? "high"
            : "medium",
          // The card `syncSignoffAnswers` (session/findings.ts) applies the answer through.
          change_card: signoffCard({
            taskId: task.id,
            reviewId: output.reviewId ?? null,
            runId: result.runId ?? null,
            findingIds: output.reviewId
              ? (await store.finding.forReview(output.reviewId)).map((f) => f.id)
              : [],
            reason: "retry_ladder_exhausted",
            title: words.title,
            said,
            saidBy,
          }),
          author_agent: this.deps.criticAgentId,
        });
        humanRequestId = request.id;
        decision = "human";
        attempt = current.attempt;
      } else {
        retry = rung;
        nextTier = rung === "escalate" ? nextRung(currentTier, ceiling) : null;
      }
    }

    // Repeat findings become critic memory (H.5): the critic proposes, memory stores. The
    // proposals are model output over the specialist's work, so the injection gate runs
    // first; a refused one is returned for the runner to quote to the human.
    const proposals = screenLessons(
      output.lessonProposals.map(
        (p): LessonCandidate => ({
          text: p.text,
          tags: p.tags,
          confidence: p.confidence,
          source: `session:${session.id}${output.reviewId ? `;review:${output.reviewId}` : ""}`,
        }),
      ),
      "agent_output",
    );
    if (this.deps.memory && proposals.kept.length) {
      try {
        const recorded = await this.deps.memory.record({
          agentId: this.deps.criticAgentId,
          sessionId: session.id,
          projectId: task.project_id,
          scope: "critic",
          lessons: proposals.kept,
        });
        for (const r of recorded.rejected)
          if (r.injection)
            proposals.rejected.push({
              text: r.text,
              rules: r.injection,
              score: 0,
              source: "agent_output",
              error: r.error,
            });
      } catch (e) {
        this.logger.warn("could not record critic lessons", { error: errorMessage(e) });
      }
    }

    const findingRows = output.reviewId ? await store.finding.forReview(output.reviewId) : [];
    const findings: ReviewFindingSummary[] = output.findings.map((f) => ({
      id: findingRows.find((r) => r.fingerprint === f.fingerprint)?.id,
      severity: f.severity,
      description: f.description,
      requiredAction: f.requiredAction,
    }));
    const openFindings =
      decision === "blocked_by_findings"
        ? blockedOpen
        : (await store.finding.openFor(task.id)).length;
    return {
      reviewId: output.reviewId ?? null,
      tier,
      verdict: output.verdict,
      grade: output.grade,
      confidence: output.confidence,
      summary: output.summary,
      findings,
      openFindings,
      decision,
      ...(retry ? { retry } : {}),
      attempt,
      ...(nextTier !== undefined ? { nextTier } : {}),
      ...(humanRequestId ? { humanRequestId } : {}),
      costUsdMicro: output.costUsdMicro,
      resolvedFindingIds: [
        ...(output.resolvedFindingIds ?? []),
        ...(followup?.action === "accepted" ? followup.resolvedFindingIds : []),
      ].filter((id, i, all) => all.indexOf(id) === i),
      lessonProposals: proposals.kept,
      quarantinedLessons: proposals.rejected.map((r) => ({ text: r.text, rules: r.rules })),
      task: current,
    };
  }

  async reviewSession(req: SessionReviewRequest): Promise<SessionReviewOutcome> {
    const tier = this.deps.sessionReviewTier ?? 0;
    const output = await this.service.review(
      {
        subject: { kind: "session", sessionId: req.sessionId },
        tier,
        evidence: { acceptanceCriteria: [] },
      },
      {
        sessionToken: req.token,
        budget: req.budget,
        humanId: req.token.claims.ownerHumanId,
      },
    );
    return {
      reviewId: output.reviewId ?? null,
      tier,
      verdict: output.verdict,
      grade: output.grade,
      confidence: output.confidence,
      summary: output.summary,
      findings: output.findings.map((f) => ({
        severity: f.severity,
        description: f.description,
        requiredAction: f.requiredAction,
      })),
      ...(output.humanRequestId ? { humanRequestId: output.humanRequestId } : {}),
      costUsdMicro: output.costUsdMicro,
    };
  }

  /**
   * The promotion review (spec G.6): a tier-1 light read of the proposed lesson against the
   * promotion criteria on the critic's own model, under the session token and a small cap,
   * persisted as a review with no task (the memory loop promotes on an accepting row). The
   * verdict decides nothing here; the caller resolves the proposal.
   */
  async reviewPromotion(req: PromotionReviewRequest): Promise<PromotionReviewOutcome> {
    const { lesson } = req;
    const origin = lesson.originScope
      ? `${lesson.originScope} memory${lesson.originProjectId ? ` of project ${lesson.originProjectId}` : ""}`
      : "memory";
    const output = await this.service.review(
      {
        subject: { kind: "lesson", lessonId: lesson.id },
        tier: 1,
        evidence: {
          acceptanceCriteria: [...PROMOTION_CRITERIA],
          brief: `Promotion of lesson ${lesson.id} from ${origin} to the shared store, where every project of every agent retrieves it by relevance. Decide whether the lesson, as written, is general enough to leave its project.`,
          inputFiles: [{ path: "lesson.md", content: lesson.text }],
          finalReport: lesson.text,
          artifacts: [
            `tags: ${lesson.tags.join(", ")}`,
            `confidence: ${lesson.confidence}`,
            ...(lesson.originId ? [`origin lesson: ${lesson.originId}`] : []),
          ],
        },
      },
      {
        sessionToken: req.token,
        budget: req.budget,
        projectSettings: req.projectSettings ?? null,
        budgetUsdMicro: PROMOTION_REVIEW_BUDGET_USD_MICRO,
        signal: req.signal,
        humanId: req.token.claims.ownerHumanId,
      },
    );
    return {
      reviewId: output.reviewId ?? null,
      verdict: output.verdict,
      grade: output.grade,
      confidence: output.confidence,
      summary: output.summary,
      completed: output.outcome === "completed",
      costUsdMicro: output.costUsdMicro,
    };
  }

  /**
   * U-022: the run's blocker is the person. The sign-off the critic filed for a `human`
   * verdict is withdrawn, the task moves `in_review -> needs_human`, and the person's questions
   * are filed (the report's own, else the task's); the critic's summary goes on the card as
   * context. Returns the questions card's id.
   */
  private async askPersonInstead(args: {
    task: TaskRow;
    output: ReviewOutput;
    result: TaskReviewRequest["result"];
    sessionId: string;
    humanId: string;
    agentId: string;
    questions: readonly string[];
  }): Promise<string> {
    const { store } = this.deps;
    const { output } = args;
    if (output.humanRequestId) {
      const signoff = await store.humanRequest.get(output.humanRequestId);
      if (signoff?.status === "open")
        await store.humanRequest.withdraw(signoff.id, signoff.version);
    }
    let current = await store.task.mustGet(args.task.id);
    if (current.status === "in_review" || current.status === "in_progress")
      current = await store.task.transition(
        current.id,
        current.version,
        "needs_human",
        `waits for your answers: the work needs them (critic ${output.verdict}, grade ${output.grade}); not retried`,
        { agentId: this.deps.criticAgentId },
      );
    const { request } = await filePersonQuestions(store, {
      task: current,
      humanId: args.humanId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      runId: args.result.runId ?? null,
      source: "critic",
      questions: args.questions,
      // The card says what the specialist said (design §3.8): its report's own words. Live
      // (2026-11-02) a report that made no chart was accepted by the critic, and the card
      // quoted "The critic: Accepted ..." as the specialist's words; and a card quoted the
      // report's first words (': I made no edits…') instead of why it asks (L-12): the
      // report's sentence about the questions comes first.
      context:
        questionsReason(args.result.finalReport ?? args.result.summary, args.questions) ??
        quotedWords(args.result.finalReport ?? args.result.summary) ??
        `The critic: ${output.summary}`,
      // The person went ahead without answering on this task before: no Go ahead without again.
      goAhead: !(await wentAheadWithout(store, current.id)),
    });
    return request.id;
  }

  /**
   * The files a task changed over all its attempts (ADR 0104): this run's, then those of the
   * task's earlier runs from their sessions' `task.files` events (the runner writes one per run
   * that changed files, before the review). Relative paths, forward slashes, each once.
   */
  private async filesOfTask(
    taskId: string,
    sessionId: string,
    runFiles: readonly string[],
  ): Promise<string[]> {
    const { store } = this.deps;
    const files = new Set(runFiles.map(relPath));
    const sessions = new Set([sessionId]);
    for (const r of await store.run.forTask(taskId)) if (r.session_id) sessions.add(r.session_id);
    for (const id of sessions) {
      for (const e of await store.event.list(id, 0, 10_000)) {
        if (e.type !== TASK_FILES_EVENT) continue;
        const p = (e.payload ?? {}) as { taskId?: unknown; files?: unknown };
        if (p.taskId !== taskId || !Array.isArray(p.files)) continue;
        for (const f of p.files) if (typeof f === "string" && f.trim()) files.add(relPath(f));
      }
    }
    return [...files];
  }

  /**
   * The pages the task's other work runs read, newest first (W15-26): what each kept for a
   * later review (`keptSourcesOf`; a row written before keeps the addresses only). The run under
   * review (`currentRunId`) is left out: its own pages come with its result.
   */
  private async sourcesOfTask(
    taskId: string,
    currentRunId: string | undefined,
  ): Promise<WebSource[]> {
    const runs = (await this.deps.store.run.forTask(taskId))
      .filter((r) => r.id !== currentRunId && r.specialist !== "critic" && !r.parent_run_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return runs.flatMap((r) => keptSourcesOf(r.artifacts));
  }

  /**
   * The ladder rung the work ran on: from the Run row's model on the ladder in force (an
   * adopted rung id is a rung too); the coder's default otherwise.
   */
  private async tierOfRun(runId: string | undefined): Promise<ModelTier> {
    if (!runId) return DEFAULT_WORK_TIER;
    const run = await this.deps.store.run.get(runId);
    return (run && tierOfModel(run.model, this.deps.modelConfig?.().ladder)) || DEFAULT_WORK_TIER;
  }
}

/** The runtime's read-only file tools for the critic (ADR 0104): `read_file` and `list_dir`. */
export function defaultReadTools(): ToolSpec[] {
  const all = fileTools();
  return [all.get("read_file"), all.get("list_dir")].filter((t): t is ToolSpec => !!t);
}

/** Output kept per check (its end, where test runners print the summary). */
const CHECK_OUTPUT_TAIL = 4000;

/**
 * What the project's checks run with in a sandbox: their output is read by the critic and the
 * person, not shown in a terminal, so no colour (the process sandbox also drops the host's
 * FORCE_COLOR; the container never has it). Colour a test runner prints anyway is stripped.
 */
const PLAIN_CHECK_ENV: Record<string, string> = { NO_COLOR: "1" };

/**
 * A check runner over a sandbox lease: the command runs in the task's sandbox, with the same
 * evidence as a process check ("<argv> -> exit <code> in <ms> ms", then the end of the output,
 * as plain text). A relative `cwd` runs under the worktree; an absolute one is refused by the
 * sandbox, so it runs at the worktree's root.
 */
export function sandboxCheckRunner(sandbox: Sandbox): CheckRunner {
  return {
    async run(cmd, opts) {
      const relative = cmd.cwd && !/^([a-zA-Z]:)?[\\/]/.test(cmd.cwd) ? cmd.cwd : undefined;
      let r: Awaited<ReturnType<Sandbox["run"]>>;
      try {
        r = await sandbox.run(cmd.argv, {
          ...(relative ? { cwd: relative } : {}),
          env: PLAIN_CHECK_ENV,
          timeoutMs: cmd.timeoutMs ?? 120_000,
          ...(opts.signal ? { signal: opts.signal } : {}),
          maxOutputBytes: 256 * 1024,
        });
      } catch (e) {
        // A command that cannot start (not installed in the sandbox) is a check that did not
        // pass, with the reason as its output, never a review that failed with an error.
        if (opts.signal?.aborted) throw e;
        return {
          name: cmd.name,
          passed: false,
          output: `${cmd.argv.join(" ")} -> could not start: ${errorMessage(e).split("\n")[0]?.slice(0, 300)}`,
          required: cmd.required !== false,
        };
      }
      const body = stripAnsi(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`).trim();
      const tail = body.length > CHECK_OUTPUT_TAIL ? `...${body.slice(-CHECK_OUTPUT_TAIL)}` : body;
      const head = `${cmd.argv.join(" ")} -> ${r.timedOut ? "timeout" : `exit ${r.code}`} in ${r.durationMs} ms`;
      return {
        name: cmd.name,
        passed: r.code === 0 && !r.timedOut,
        output: tail ? `${head}\n${tail}` : head,
        required: cmd.required !== false,
      };
    },
  };
}

/** A changed file as the review compares it: forward slashes, no leading "./". */
function relPath(f: string): string {
  return f.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Files a page loads that run nothing (styles, images, fonts): they cannot throw an error. */
const INERT_FILE = /\.(css|png|jpe?g|gif|webp|avif|bmp|ico|svg|woff2?|ttf|otf|eot)$/i;

/**
 * Who a page's error belongs to (ADR 0104, the review of 2026-11-02). A page that opened and
 * threw an error is the task's blocker when the task changed a file that runs on the page (the
 * page itself, a script, data it reads; a file the page asked for and the task deleted). When the
 * task changed none of them (it only styled the page) the error was there before the task: it is
 * told in the try's output and becomes a low finding, never a reason to send the task back that
 * no rework of the task can remove. A page that did not open is always a blocker.
 */
export function attributeTry(t: TriedEvidence, taskFiles: readonly string[]): TriedEvidence {
  if (t.ok || !t.blocking || !t.pageFiles?.length) return t;
  if (/did not open/i.test(t.output)) return t;
  const runs = t.pageFiles.map(relPath).filter((f) => !INERT_FILE.test(f));
  const changed = new Set(taskFiles.map(relPath));
  if (runs.some((f) => changed.has(f))) return t;
  return {
    ...t,
    blocking: false,
    causedByTask: false,
    output: `${t.output}\nnot caused by this task: it changed none of the files that run on this page (${runs.join(", ")})`,
  };
}

/** "index.html was" / "index.html and about.html were", for a line about pages. */
function pagesWords(pages: readonly string[]): string {
  return pages.length === 1 ? `${pages[0]} was` : `${pages.join(" and ")} were`;
}

async function onPath(cmd: string): Promise<boolean> {
  return (await which(cmd).catch(() => null)) !== null;
}

type ExecFn = (
  argv: readonly string[],
  opts: { env?: Record<string, string>; timeoutMs: number },
) => Promise<RunResult>;

type MarkerOutcome =
  | { result: { name: string; passed: boolean; output: string; required: boolean } }
  | { notRun: string };

/**
 * One marker check (C-3): the first candidate whose probe starts runs (pytest, else unittest);
 * none starting is "not run, because <tool> is not installed where the checks run"; a run that
 * could not get its dependencies, or found no tests, is not run either. Never a failed review.
 * The folder stays as the work left it (`holdFolder`): what the run wrote is removed again, a
 * go.mod or Cargo.lock it rewrote is put back, and the check's output says so.
 */
export async function runMarkerCheck(
  m: MarkerCheck,
  exec: ExecFn,
  root: string,
): Promise<MarkerOutcome> {
  const restore = holdFolder(root);
  let out: MarkerOutcome;
  let note: string | null = null;
  try {
    out = await markerCheckIn(m, exec, root);
  } finally {
    note = restore();
  }
  if (note && "result" in out)
    out.result.output = `${out.result.output}
${note}`;
  return out;
}

async function markerCheckIn(m: MarkerCheck, exec: ExecFn, root: string): Promise<MarkerOutcome> {
  const notRun = (why: string) => ({
    notRun: `the project's ${m.language} tests were not run: ${why}`,
  });
  for (const c of m.candidates) {
    const probe = await exec(c.probe, { timeoutMs: 30_000, ...(m.env ? { env: m.env } : {}) })
      .then((r) => r.code === 0 && !r.timedOut)
      .catch(() => false);
    if (!probe) continue;
    let r: RunResult;
    try {
      r = await exec(c.argv, {
        timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
        ...(m.env ? { env: m.env } : {}),
      });
    } catch (e) {
      return notRun(
        `${c.argv[0]} could not start (${errorMessage(e).split("\n")[0]?.slice(0, 200)})`,
      );
    }
    const body = stripAnsi(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`).trim();
    const because = m.notRunBecause?.(body, root);
    if (because) return notRun(because);
    if (r.code === 5 && !r.timedOut) return notRun(`${c.name} found no tests in them`);
    const tail = body.length > CHECK_OUTPUT_TAIL ? `...${body.slice(-CHECK_OUTPUT_TAIL)}` : body;
    const head = `${c.argv.join(" ")} -> ${r.timedOut ? "timeout" : `exit ${r.code}`} in ${r.durationMs} ms`;
    return {
      result: {
        name: c.name,
        passed: r.code === 0 && !r.timedOut,
        output: tail ? `${head}\n${tail}` : head,
        required: true,
      },
    };
  }
  return notRun(m.missing);
}

/** Whether a command starts and exits 0 in a sandbox (a probe such as `npm --version`). */
async function startsIn(sandbox: Sandbox, argv: readonly string[]): Promise<boolean> {
  try {
    const r = await sandbox.run(argv, { timeoutMs: 30_000, maxOutputBytes: 4096 });
    return r.code === 0 && !r.timedOut;
  } catch {
    return false;
  }
}
