import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  type Clock,
  dirname,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isInside,
  join,
  log,
  newId,
  resolve,
  safeSegment,
} from "@forerunner/platform";
import { z } from "zod";
import type { LoopAgentDriver } from "../agent/loop.ts";
import { ToolRegistry } from "../agent/tools.ts";
import { renderBrief, validateBrief } from "../brief.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { Registry } from "../registry/index.ts";
import { loopToolsFor } from "../registry/tools.ts";
import {
  RUN_COMMAND_TOOL,
  type RunSandboxLease,
  type RunSandboxPort,
  withSandboxedCommands,
} from "../session/executor.ts";
import { pricingFor } from "../wiring/billing-ports.ts";
import type { EvalRunInput, EvalRunnerPort, EvalRunOutcome } from "./watch.ts";

/**
 * The eval runner the daemon gives the weekly model watch: it runs a specialist's golden eval
 * set (the JSON task files the registry names in `eval_set`) through the in-process loop
 * driver on the composed provider and grades the mechanical checks itself. Rubric checks are
 * the critic's and count as "needs model". `@forerunner/evals` holds the authoritative task
 * schema and grader and depends on this package, so this runner reads the same files with a
 * tolerant schema instead of importing it (the orchestrator may inject the evals-backed
 * runner through `ComposeOptions.evalRunner`; see the ADR on daemon wiring).
 *
 * Every model call goes through the composed enforcement hooks with a token of its own
 * (depth 0, the task's budget, only the work directory as an allowed path, only the loop
 * driver's equivalents of the specialist's `allowed_tools`), so the monthly cap, the kill
 * switch and the audit log apply to evals exactly as to any run. Commands never run on the
 * host: the model's `run_command` and the grader's `command_exit0` checks execute inside a
 * sandbox lease over the work directory with no egress (the same `RunSandboxPort` as task
 * runs); without a sandbox port `run_command` is not offered and command checks are errors.
 */
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\\"), "use forward slashes")
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), "paths are relative")
  .refine((p) => !p.split("/").some((s) => s === ".." || s === ""), "no '..' or empty segments");

const FileMap = z.record(RelPath, z.string());
const Presence = z.enum(["present", "absent"]).default("present");

const Check = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file_exists"), path: RelPath, expect: Presence }).loose(),
  z
    .object({
      kind: z.literal("file_contains"),
      path: RelPath.optional(),
      text: z.string().min(1),
      expect: Presence,
    })
    .loose(),
  z
    .object({
      kind: z.literal("regex"),
      path: RelPath.optional(),
      pattern: z.string().min(1),
      flags: z
        .string()
        .regex(/^[gimsuy]*$/)
        .default(""),
      expect: z.enum(["match", "no_match"]).default("match"),
    })
    .loose(),
  z
    .object({
      kind: z.literal("command_exit0"),
      argv: z.array(z.string().min(1)).min(1),
      cwd: RelPath.optional(),
      timeoutMs: z.number().int().positive().max(600_000).default(60_000),
    })
    .loose(),
  z
    .object({
      kind: z.literal("json_path"),
      path: RelPath,
      pointer: z.string().regex(/^(\/[^/]*)*$/),
      equals: z.unknown().optional(),
      exists: z.boolean().default(true),
    })
    .loose(),
  z.object({ kind: z.literal("rubric") }).loose(),
]);
type Check = z.infer<typeof Check>;

const EvalTaskLite = z
  .object({
    id: z.string().min(1),
    specialist: z.string().min(1),
    title: z.string().min(1),
    brief: z
      .object({
        goal: z.string(),
        contextLinks: z.array(z.string()).default([]),
        constraints: z.array(z.string()).default([]),
        acceptanceCriteria: z.array(z.string()).default([]),
        budgetUsdMicro: z.number().int().positive(),
        riskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      })
      .loose(),
    setup: z
      .object({ files: FileMap.default({}) })
      .loose()
      .default({ files: {} }),
    checks: z.array(Check).min(1),
    grader_files: FileMap.optional(),
  })
  .loose();
export type EvalTaskLite = z.infer<typeof EvalTaskLite>;

export const EVAL_TASK_FILE_RE = /^(\d{3})-([a-z0-9-]+)\.json$/;

/** Load the task files of one eval set directory (sorted); a malformed file is `validation`. */
export function loadEvalTasksLite(dir: string): EvalTaskLite[] {
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new ForerunnerError("not_found", `eval set directory not found: ${root}`, {
      details: { dir: root },
    });
  }
  const out: EvalTaskLite[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!EVAL_TASK_FILE_RE.test(name)) continue;
    const file = join(root, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new ForerunnerError("validation", `${name}: not valid JSON: ${errorMessage(e)}`, {
        details: { file },
      });
    }
    const parsed = EvalTaskLite.safeParse(raw);
    if (!parsed.success) {
      throw new ForerunnerError(
        "validation",
        `${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        { details: { file } },
      );
    }
    out.push(parsed.data);
  }
  return out;
}

export interface LoopEvalRunnerDeps {
  registry: Registry;
  driver: LoopAgentDriver;
  providers: ProviderRegistry;
  tokens: TokenIssuer;
  clock: Clock;
  /** The human whose caps apply and the agent the audit rows name. */
  humanId: string;
  agentId: string;
  billingSourceId: string;
  /** Directory the per-task work directories are created under (removed after each task). */
  workRoot: string;
  /** Tools a specialist may get inside the work directory (the daemon's file tools). */
  tools: () => ToolRegistry;
  /**
   * Where the model's commands and the grader's `command_exit0` checks run: one lease per
   * eval task over its work directory, no egress, the brief's risk tier. Absent: `run_command`
   * is not offered to the model and command checks count as errors; nothing executes on the host.
   */
  sandbox?: RunSandboxPort;
  /** Upper bound on tasks per eval set (cost and time); default: the whole set. */
  maxTasks?: number;
  keepWorkDirs?: boolean;
}

type Status = "pass" | "fail" | "needs_model" | "error";

function pickTools(base: ToolRegistry, names: readonly string[]): ToolRegistry {
  const out = new ToolRegistry();
  for (const name of names) {
    const t = base.get(name);
    if (t) out.register(t);
  }
  return out;
}

export class LoopEvalRunner implements EvalRunnerPort {
  private readonly logger = log("model-watch:evals");

  constructor(private readonly deps: LoopEvalRunnerDeps) {}

  async run(input: EvalRunInput): Promise<EvalRunOutcome> {
    const { clock } = this.deps;
    const spec = input.candidate ?? this.deps.registry.specialists.get(input.specialist);
    if (input.candidate) {
      // The approval gate evaluates a proposal before it may run anywhere else: only a
      // proposed definition, under the name asked for.
      if (input.candidate.name !== input.specialist || input.candidate.location !== "proposed") {
        throw new ForerunnerError(
          "validation",
          `eval candidate must be the pending proposal "${input.specialist}"`,
          { details: { specialist: input.specialist, candidate: input.candidate.name } },
        );
      }
    } else if (!spec?.runnable) {
      throw new ForerunnerError("not_found", `specialist ${input.specialist} is not runnable`, {
        details: { specialist: input.specialist },
      });
    }
    if (!spec) throw new ForerunnerError("internal", "unreachable");
    const provider = this.deps.providers.get(input.provider);
    const timeoutMs = spec.timeout_minutes * 60_000;
    // Unknown prices throw here, before any call: the watch never costs a run by guessing.
    const pricing = pricingFor(input.model, input.pricing);
    const started = clock.monotonic();
    const all = loadEvalTasksLite(spec.evalSetDir);
    const tasks = this.deps.maxTasks ? all.slice(0, this.deps.maxTasks) : all;
    const counts = { total: tasks.length, passed: 0, failed: 0, needsModel: 0 };
    let cost = 0;
    for (const task of tasks) {
      input.signal?.throwIfAborted();
      const workDir = resolve(
        join(
          this.deps.workRoot,
          safeSegment(`${task.id}-${input.model}-${input.effort}-${newId(clock.now())}`),
        ),
      );
      mkdirSync(workDir, { recursive: true });
      let status: Status;
      let lease: RunSandboxLease | null = null;
      try {
        writeFiles(workDir, task.setup.files);
        const brief = validateBrief({
          goal: task.brief.goal,
          contextLinks: task.brief.contextLinks.length ? task.brief.contextLinks : ["none"],
          constraints: task.brief.constraints.length ? task.brief.constraints : ["none stated"],
          acceptanceCriteria: task.brief.acceptanceCriteria.length
            ? task.brief.acceptanceCriteria
            : ["The outcome described in the goal is achieved and verified."],
          budgetUsdMicro: task.brief.budgetUsdMicro,
          riskTier: task.brief.riskTier,
          specialist: spec.name,
          timeoutMs,
        });
        // The specialist's tools only (the loop driver's equivalents of its `cc:` names, ADR
        // 0043); commands only inside a sandbox lease over the work dir, so without a sandbox
        // port `run_command` is dropped with the other names the driver cannot offer.
        const base = this.deps.tools();
        const mapping = loopToolsFor(spec.allowed_tools, {
          available: base.names(),
          commands: this.deps.sandbox !== undefined,
        });
        for (const drop of mapping.dropped) {
          this.logger.warn("eval: specialist tool not offered to the model", {
            task: task.id,
            specialist: spec.name,
            tool: drop.tool,
            reason: drop.reason,
          });
        }
        const allowed = mapping.tools;
        const wantsCommands = allowed.includes(RUN_COMMAND_TOOL);
        const needsSandbox = wantsCommands || task.checks.some((c) => c.kind === "command_exit0");
        let tools = pickTools(
          base,
          allowed.filter((n) => n !== RUN_COMMAND_TOOL),
        );
        if (needsSandbox && this.deps.sandbox) {
          lease = await this.deps.sandbox.open({
            task: { id: `eval:${task.id}`, project_id: "", risk_tier: task.brief.riskTier },
            worktree: workDir,
            allowedDomains: [],
            timeoutMs,
            signal: input.signal ?? new AbortController().signal,
          });
          for (const w of lease.warnings) this.logger.warn(w, { task: task.id });
          if (wantsCommands) tools = withSandboxedCommands(tools, lease.sandbox);
        }
        const runId = newId(clock.now());
        const sessionId = `model-watch:${runId}`;
        const token = this.deps.tokens.issue({
          runId,
          sessionId,
          agentId: this.deps.agentId,
          ownerHumanId: this.deps.humanId,
          allowedTools: tools.names(),
          allowedPaths: [workDir],
          allowedDomains: [],
          grantedSecrets: [],
          budgetUsdMicro: brief.budgetUsdMicro,
          depth: 0,
          maxDepth: 0,
          autonomy: 4,
          planApproved: true,
          expiresAt: new Date(clock.now() + timeoutMs).toISOString(),
        });
        const budget = new SessionBudget({
          sessionId,
          budgetUsdMicro: brief.budgetUsdMicro,
          stepCap: Math.max(10, spec.max_turns * 4),
          deadlineMs: clock.now() + timeoutMs,
          reserveShare: 0,
        });
        const result = await this.deps.driver.run({
          token,
          budget,
          provider,
          model: input.model,
          billingSourceId: this.deps.billingSourceId,
          system: spec.prompt,
          messages: [{ role: "user", content: renderBrief(brief) }],
          tools,
          pricing,
          timeoutMs,
          maxTurns: spec.max_turns,
          effort: input.effort,
          cwd: workDir,
          // Evals measure the model, not the context layer: results stay byte-identical.
          compression: "off",
          label: `eval ${task.id} on ${input.model} at ${input.effort}`,
        });
        cost += result.costUsdMicro;
        if (task.grader_files) writeFiles(workDir, task.grader_files);
        status =
          result.outcome === "completed" || result.outcome === "max_turns"
            ? await this.grade(task.checks, workDir, result.finalText, lease)
            : "error";
      } catch (e) {
        if (e instanceof ForerunnerError && isFatal(e.code)) throw e;
        this.logger.warn("eval task failed to run", { task: task.id, error: errorMessage(e) });
        status = "error";
      } finally {
        if (lease) {
          await lease.sandbox.destroy().catch((e: unknown) => {
            this.logger.warn("sandbox destroy failed", { task: task.id, error: errorMessage(e) });
          });
        }
        if (!this.deps.keepWorkDirs) rmSync(workDir, { recursive: true, force: true });
      }
      if (status === "pass") counts.passed++;
      else if (status === "needs_model") counts.needsModel++;
      else counts.failed++;
    }
    const decided = counts.passed + counts.failed;
    return {
      total: counts.total,
      passed: counts.passed,
      failed: counts.failed,
      needsModel: counts.needsModel,
      passRate: decided ? counts.passed / decided : 0,
      costUsdMicro: Math.round(cost),
      durationMs: Math.max(0, Math.round(clock.monotonic() - started)),
    };
  }

  /** Mechanical checks; the first failure decides, a rubric without failures is "needs model". */
  private async grade(
    checks: Check[],
    workDir: string,
    finalText: string,
    lease: RunSandboxLease | null,
  ): Promise<Status> {
    let needsModel = false;
    for (const c of checks) {
      const r = await this.check(c, workDir, finalText, lease);
      if (r === "fail" || r === "error") return r;
      if (r === "needs_model") needsModel = true;
    }
    return needsModel ? "needs_model" : "pass";
  }

  private async check(
    c: Check,
    workDir: string,
    finalText: string,
    lease: RunSandboxLease | null,
  ): Promise<Status> {
    const file = (rel: string | undefined): string | null => {
      if (rel === undefined) return null;
      const abs = resolve(workDir, fromPosix(rel));
      if (!isInside(workDir, abs)) throw new ForerunnerError("path_not_allowed", rel);
      return abs;
    };
    const text = (rel: string | undefined): string | null => {
      const abs = file(rel);
      if (abs === null) return finalText;
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    switch (c.kind) {
      case "file_exists": {
        const abs = file(c.path) as string;
        return existsSync(abs) === (c.expect === "present") ? "pass" : "fail";
      }
      case "file_contains": {
        const t = text(c.path);
        const has = t?.includes(c.text) === true;
        return has === (c.expect === "present") ? "pass" : "fail";
      }
      case "regex": {
        const t = text(c.path);
        const matched = t !== null && new RegExp(c.pattern, c.flags).test(t);
        return matched === (c.expect === "match") ? "pass" : "fail";
      }
      case "json_path": {
        const t = text(c.path);
        if (t === null) return "fail";
        let doc: unknown;
        try {
          doc = JSON.parse(t);
        } catch {
          return "fail";
        }
        const found = pointer(doc, c.pointer);
        if (!found.exists) return c.exists ? "fail" : "pass";
        if (!c.exists) return "fail";
        if (c.equals === undefined) return "pass";
        return JSON.stringify(found.value) === JSON.stringify(c.equals) ? "pass" : "fail";
      }
      case "command_exit0": {
        // The command runs the files the model wrote, so it runs where the model's commands
        // run: inside the lease, never on the host.
        if (!lease) {
          this.logger.warn("command check not run: no sandbox", { argv: c.argv[0] });
          return "error";
        }
        if (c.cwd) file(c.cwd);
        try {
          const r = await lease.sandbox.run(c.argv, {
            cwd: c.cwd,
            timeoutMs: c.timeoutMs,
            maxOutputBytes: 64 * 1024,
          });
          return r.code === 0 && !r.timedOut ? "pass" : "fail";
        } catch (e) {
          this.logger.debug("command check failed to run", { error: errorMessage(e) });
          return "error";
        }
      }
      case "rubric":
        return "needs_model";
    }
  }
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, fromPosix(rel));
    if (!isInside(root, abs)) throw new ForerunnerError("path_not_allowed", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function pointer(doc: unknown, p: string): { exists: boolean; value?: unknown } {
  if (p === "") return { exists: true, value: doc };
  let cur: unknown = doc;
  for (const raw of p.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { exists: false };
      cur = cur[i];
    } else if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else return { exists: false };
  }
  return { exists: true, value: cur };
}

function isFatal(code: string): boolean {
  return code === "killed" || code === "budget_exceeded";
}
