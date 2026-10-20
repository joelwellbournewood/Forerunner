import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  applyVerdict,
  type CheckCommand,
  type CriticDeps,
  type CriticPromptSource,
  CriticService,
  DEFAULT_WORK_TIER,
  escalationCeiling,
  type FollowupDecision,
  type ReviewEvidence,
  type ReviewOutput,
  type ReviewTier,
  type SourceFileEvidence,
} from "@forerunner/critic";
import { checkDocDrift } from "@forerunner/memory";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isInside,
  join,
  log,
  type RunOptions,
  type RunResult,
  resolve,
  run as runProcess,
  safeSegment,
  toPosix,
} from "@forerunner/platform";
import type { JsonObject, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import type { LoopAgentDriver, RunPricing } from "../agent/loop.ts";
import type { ContextManager } from "../context/manager.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import { DEFAULT_CEILING, nextRung, retryAction, tierOfModel } from "../models/ladder.ts";
import type { EffectiveModelConfig } from "../models/settings.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { ModelTier } from "../provider/types.ts";
import { screenLessons } from "../session/lessons.ts";
import type {
  CriticPort,
  LessonCandidate,
  MemoryPort,
  RetryRung,
  ReviewDecision,
  ReviewFindingSummary,
  SessionReviewOutcome,
  SessionReviewRequest,
  TaskReviewOutcome,
  TaskReviewRequest,
} from "./ports.ts";

/**
 * The critic in the loop (spec H, phase 3). For every task the runner finished above the
 * mechanical path, this port assembles the evidence (the diff of the PR branch or the
 * worktree, the changed files, the unchanged files the task names read from the worktree as
 * source files, the project's check commands, the standard-doc drift, the specialist's final
 * report as claims), runs `@forerunner/critic` at the task's tier under the
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
/** A diff longer than this is cut with a marker; the files list stays complete. */
export const MAX_DIFF_CHARS = 200_000;
/** Caps for the source files read from the worktree into the evidence (ADR 0041). */
export const MAX_SOURCE_FILE_BYTES = 64 * 1024;
export const MAX_SOURCE_TOTAL_BYTES = 256 * 1024;
/** How many path-like names a task's text may yield; the rest are ignored. */
export const MAX_NAMED_PATHS = 32;

const PATH_TOKEN_RE =
  /(?<![\w./:-])(?:\.\/)?(?:[\w.-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w/-])/g;

/**
 * Relative file paths a text names (`src/cli.ts`, `docs/status-q2.md`, `README.md`): segments
 * with forward slashes and a letter-led extension (so `v1.0` is not one), not inside a URL,
 * never absolute, never `..`. Whether a name is a file is decided against the worktree by
 * `readSourceFiles`, so a dotted word that is not one (`e.g`) costs a stat and nothing else.
 */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const p = m[0].replace(/^\.\//, "");
    if (p.split("/").some((seg) => seg === "" || seg === "..")) continue;
    out.add(p);
    if (out.size >= MAX_NAMED_PATHS) break;
  }
  return [...out];
}

export interface ReadSourceFilesOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/**
 * The named files that exist in the worktree and the task did not change, as source evidence:
 * a regular file inside the worktree (a path that escapes it is skipped), text (no NUL byte in
 * its first 8 KiB), cut at the per-file cap and stopped at the total cap. A changed file is the
 * diff's business and is never repeated here; a missing or unreadable one is skipped.
 */
export function readSourceFiles(
  worktree: string,
  paths: readonly string[],
  changedFiles: readonly string[],
  opts: ReadSourceFilesOptions = {},
): SourceFileEvidence[] {
  const maxFile = opts.maxFileBytes ?? MAX_SOURCE_FILE_BYTES;
  const maxTotal = opts.maxTotalBytes ?? MAX_SOURCE_TOTAL_BYTES;
  const changed = new Set(changedFiles.map((f) => toPosix(f)));
  const out: SourceFileEvidence[] = [];
  let total = 0;
  for (const rel of paths) {
    if (changed.has(rel)) continue;
    if (total >= maxTotal) break;
    const abs = resolve(worktree, fromPosix(rel));
    if (!isInside(worktree, abs)) continue;
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    const take = Math.min(size, maxFile, maxTotal - total);
    let buf: Buffer;
    try {
      const fd = openSync(abs, "r");
      try {
        buf = Buffer.alloc(take);
        buf = buf.subarray(0, readSync(fd, buf, 0, take, 0));
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue;
    total += buf.length;
    out.push({
      path: rel,
      content: buf.toString("utf8"),
      ...(take < size ? { truncated: true } : {}),
    });
  }
  return out;
}

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
 * (`origin/HEAD...HEAD`, the merge base) plus what is still uncommitted in the worktree. A
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
      const hasOrigin = (await git(["rev-parse", "--verify", "--quiet", "origin/HEAD"])).code === 0;
      const parts: string[] = [];
      const files = new Set<string>();
      if (hasOrigin) {
        const committed = await git(["diff", "origin/HEAD...HEAD"]);
        if (committed.code === 0 && committed.stdout.trim()) parts.push(committed.stdout);
        const names = await git(["diff", "--name-only", "origin/HEAD...HEAD"]);
        for (const f of names.stdout.split(/\r?\n/)) if (f.trim()) files.add(f.trim());
      }
      const pending = await git(["diff", "HEAD"]);
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
    const tier = (Math.min(3, Math.max(0, task.risk_tier)) | 0) as ReviewTier;
    const project = await store.project.get(task.project_id);
    const settings = project?.settings ?? null;
    const worktree =
      result.worktree ??
      (this.deps.worktreeRoot ? join(this.deps.worktreeRoot, safeSegment(task.id)) : undefined);

    // Evidence: the diff and the changed files, the project's checks, the standard-doc drift.
    const diff = await this.diffPort.diffFor(task, worktree);
    const changedFiles = result.changedFiles?.length
      ? result.changedFiles
      : (diff?.changedFiles ?? []);
    const { checks, invalid } = checksFromSettings(settings);
    // Source files (ADR 0041): the unchanged files the task's own text names, read from the
    // worktree, so the critic checks the result's claims against the inputs it cites.
    const named = namedPaths([task.title, task.outcome, ...task.acceptance_criteria].join("\n"));
    const sourceFiles =
      worktree && named.length ? readSourceFiles(worktree, named, changedFiles) : [];
    const evidence: ReviewEvidence = {
      acceptanceCriteria: task.acceptance_criteria.length
        ? task.acceptance_criteria
        : ["The outcome described in the goal is achieved and verified."],
      brief: `${task.title}: ${task.outcome}`,
      finalReport: result.finalReport ?? result.summary,
      ...(diff?.diff ? { diff: diff.diff } : {}),
      ...(changedFiles.length ? { changedFiles } : {}),
      ...(sourceFiles.length ? { sourceFiles } : {}),
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      artifacts: [
        `attempt ${task.attempt + 1} by ${req.item.specialist}`,
        ...(invalid ? [`${invalid} malformed check(s) in settings.checks ignored`] : []),
        ...(result.artifacts ?? []).map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
      ],
    };
    if (tier >= 2 && worktree && changedFiles.length) {
      // Doc drift of the project's standard doc set (spec G.5, memory package); a drift is a
      // non-required check, so it is a low finding the human sees and the PM fixes at session
      // end, never a reason to block a correct change (ADR 0036).
      try {
        const drift = await checkDocDrift(worktree, { changedFiles, tasksChanged: true });
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

    const sessionContext = await this.deps.context?.forSession(session.id, task.project_id);
    const criticService = sessionContext
      ? new CriticService(this.serviceDeps(sessionContext.pipeline))
      : this.service;
    const owner = req.token.claims.ownerHumanId;
    const output: ReviewOutput = await criticService.review(
      { subject: { kind: "task", taskId: task.id }, tier, evidence },
      {
        sessionToken: req.token,
        budget: req.budget,
        projectSettings: settings,
        checks,
        cwd: worktree,
        signal: req.signal,
        humanId: owner,
      },
    );

    // The rung the failed attempt ran on, for the ladder: the Run row's model.
    const currentTier = await this.tierOfRun(result.runId);
    const ceiling = (await escalationCeiling(store, task)) ?? DEFAULT_CEILING;
    let decision: ReviewDecision;
    let followup: FollowupDecision | null = null;
    let blockedOpen = 0;
    try {
      followup = await applyVerdict(task.id, output, {
        store,
        criticAgentId: this.deps.criticAgentId,
        currentTier,
        humanId: owner,
        ownerAgentId: req.agentId,
        runId: result.runId ?? null,
        sessionId: session.id,
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

    // The retry ladder (D.2) also runs for a plain revise: after the last rung the human
    // decides instead of an endless loop of revisions.
    let retry: RetryRung | undefined;
    let nextTier: ModelTier | null | undefined;
    let humanRequestId = output.humanRequestId;
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
        current = await store.task.transition(
          current.id,
          current.version,
          "needs_human",
          `retry ladder exhausted after ${followup.attempt} failed attempt(s) at ${currentTier} (ceiling ${ceiling}): human decides`,
          { agentId: this.deps.criticAgentId },
        );
        const request = await store.humanRequest.insert({
          human_id: owner,
          project_id: task.project_id,
          task_id: task.id,
          session_id: session.id,
          kind: "approval",
          why: `Retry ladder exhausted for "${task.title}" after ${followup.attempt} failed attempt(s) (ceiling ${ceiling}): ${output.summary}`.slice(
            0,
            4000,
          ),
          steps: output.findings.map(
            (f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`,
          ),
          options: ["accept", "revise", "cancel"],
          blocking: true,
          risk: output.findings.some((f) => f.severity === "critical" || f.severity === "high")
            ? "high"
            : "medium",
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
   * The ladder rung the work ran on: from the Run row's model on the ladder in force (an
   * adopted rung id is a rung too); the coder's default otherwise.
   */
  private async tierOfRun(runId: string | undefined): Promise<ModelTier> {
    if (!runId) return DEFAULT_WORK_TIER;
    const run = await this.deps.store.run.get(runId);
    return (run && tierOfModel(run.model, this.deps.modelConfig?.().ladder)) || DEFAULT_WORK_TIER;
  }
}
