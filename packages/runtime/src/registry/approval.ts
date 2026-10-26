import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PricingTable } from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, join, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { loadEvalTasksLite, PROCESS_SANDBOX_REFUSED } from "../models/eval-runner.ts";
import type { EvalRunnerPort, EvalRunOutcome } from "../models/watch.ts";
import type { EffortLevel } from "../provider/types.ts";
import { isPidAlive } from "../update/lock.ts";
import {
  countEvalTasks,
  EVALS_DIR,
  loadRegistry,
  PROPOSED_DIR,
  readSpecialistFile,
  SPECIALIST_FILE,
  SPECIALISTS_DIR,
  validateSpecialistText,
} from "./loader.ts";
import {
  ACTIVATION_PASS_RATE,
  MIN_EVAL_TASKS_FOR_ACTIVATION,
  PROPOSAL_FILE,
  type ProposalReceipt,
  type ProposeOptions,
  proposeSpecialist,
  type SpecialistProposal,
} from "./proposals.ts";
import type { LoadRegistryOptions, RegistryIssue, SpecialistDef } from "./types.ts";

/**
 * The approval gate for a proposed specialist (spec C.5: "PM can propose a new specialist; it
 * goes live only after human approval and passing its eval set"; ADR 0071).
 *
 *   propose -> `proposed/<name>/` written (proposals.ts) and one blocking `approval` request
 *              filed, its card keyed `specialist:<name>` with the summary, the prompt version
 *              the human is looking at, the eval-set size and the gate it must pass.
 *   approve -> the eval set runs through the `EvalRunnerPort` (the daemon's `LoopEvalRunner`:
 *              every call under the enforcement hooks, charged to the approving human, the
 *              whole run capped by the approval eval budget before the first call); the
 *              result is recorded in `proposal.json` (pass rate, counts, model, date, the
 *              threshold). On a pass the directory moves to `specialists/<name>/` with
 *              `status: active` (one line changed, nothing else) and the loader makes it
 *              runnable; on anything else it stays proposed, the failure goes on the card
 *              and a note goes to the human's inbox.
 *   reject  -> the proposal is withdrawn: `proposed/<name>/` is removed (the card and the
 *              audit row keep the record) and the name is free again.
 *
 * Every answered request is acted on once: the card is claimed (`applied_at`, outcome
 * `evaluating`) with a versioned write before anything runs, so the poll, the answer route,
 * a restart and the CLI never evaluate the same answer twice. Only the install whose
 * `proposal.json` names the request applies it (another composition of the same human over a
 * shared store, the cloud runner or a second install, leaves it alone). While an evaluation
 * is live (its process alive and inside the set's worst-case duration) the name can be
 * neither filed nor answered again; one whose process is gone or that overran is recovered:
 * the card says `interrupted`, a note goes to the inbox and the proposal is filed again.
 * Only the human the proposal belongs to may approve it: an answer by anyone else is
 * refused, recorded, and the proposal is filed again for its own human. A proposal edited
 * after it was filed (another prompt version than the card names) is never evaluated under
 * the old approval: it is filed again.
 */
export const SPECIALIST_KEY_PREFIX = "specialist:";
export const SPECIALIST_APPROVAL_OPTIONS = ["approve", "reject"] as const;
export type SpecialistAnswer = (typeof SPECIALIST_APPROVAL_OPTIONS)[number];
/** Audit row per answered request (the name, the outcome, the pass rate; never the prompt). */
export const SPECIALIST_APPROVAL_AUDIT_TOOL = "registry.specialist_approval";
/** Upper bound of what one approval's eval run may spend, in micro-USD (ADR 0071). */
export const DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO = 5_000_000;
/** The testing share of a human's monthly cap (spec budget pacing: testing and live evals 20%). */
export const APPROVAL_TESTING_SHARE = 0.2;

/** What the gate demands, recorded with every result so a later reader knows the bar. */
export interface ActivationThreshold {
  passRate: number;
  minTasks: number;
}
export const ACTIVATION_THRESHOLD: ActivationThreshold = Object.freeze({
  passRate: ACTIVATION_PASS_RATE,
  minTasks: MIN_EVAL_TASKS_FOR_ACTIVATION,
});

/** The eval result as `proposal.json` records it (ADR 0071). */
export interface ProposalEvalResult {
  passed: boolean;
  passRate: number;
  total: number;
  passedTasks: number;
  failedTasks: number;
  needsModel: number;
  /** Tasks decided mechanically (passed + failed); the gate needs `threshold.minTasks` of them. */
  decided: number;
  threshold: ActivationThreshold;
  provider: string;
  model: string;
  effort: EffortLevel;
  /** The prompt version the set ran against (the proposed file's). */
  promptVersion: string;
  costUsdMicro: number;
  durationMs: number;
  ranAt: string;
  /** The human whose approval started the run (and whose caps it was charged to). */
  approvedBy: string;
  /** Why it did not pass, in one line; absent on a pass. */
  reason?: string;
}

export type ProposalApprovalStatus =
  | "pending"
  | "evaluating"
  | "interrupted"
  | "active"
  | "eval_failed"
  | "withdrawn";

export interface ProposalApproval {
  status: ProposalApprovalStatus;
  requestId: string | null;
  by?: string | null;
  at?: string;
  /** While `evaluating`: the process running it (a live one keeps the name locked). */
  pid?: number;
  /** While `evaluating`: a token of that process (a reused pid is not the same process). */
  process?: string;
}

/** `proposal.json` as written by `proposeSpecialist` and kept up to date here. */
export interface ProposalRecord {
  name: string;
  status: "proposed" | "active" | "withdrawn";
  proposedAt: string;
  proposedBy: { agentId: string; humanId: string; projectId?: string };
  rationale: string;
  promptVersion: string;
  evalSet: string;
  approval: ProposalApproval | null;
  evalResult: ProposalEvalResult | null;
  /** Every run, oldest first; `evalResult` is the last one. */
  evalHistory?: ProposalEvalResult[];
  /** After promotion: the prompt version of the active file (only the status line differs). */
  activePromptVersion?: string;
  activatedAt?: string;
}

/** The model an approval's eval set runs on; null when no model is configured. */
export interface ApprovalEvalTarget {
  provider: string;
  model: string;
  effort: EffortLevel;
  pricing: PricingTable;
}

export interface SpecialistApprovalDeps {
  store: StateStore;
  clock: Clock;
  registryDir: string;
  /** The install's human: the only one whose proposals this instance files and applies. */
  humanId: string;
  /** The principal agent the requests, audit rows and inbox notes name. */
  agentId: string;
  evals: EvalRunnerPort;
  /** Which model and effort run the set; null: no model (the approval is kept, nothing runs). */
  target: (def: SpecialistDef) => ApprovalEvalTarget | null;
  loadOptions?: LoadRegistryOptions;
  /**
   * The per-run cap of one approval's eval run, micro-USD (default
   * `DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO`). Whatever it is, a run never gets more than what
   * is left this month of the human's testing share of the monthly cap.
   */
  evalBudgetUsdMicro?: number;
  /** Called with the runnable definition after a promotion (the daemon updates its registry). */
  onPromoted?: (def: SpecialistDef) => void;
  /** Whether a process id is alive (default: `isPidAlive`, signal 0); injected by tests. */
  processAlive?: (pid: number) => boolean;
}

export type SpecialistApplyOutcome =
  | "promoted"
  | "eval_failed"
  | "eval_set_too_small"
  | "over_budget"
  /** The eval set runs commands, no container engine exists and the process sandbox is not allowed (ADR 0089). */
  | "sandbox_unavailable"
  /** The human's month (or plan) is past its 80% line or at its cap: no eval task starts (ADR 0089). */
  | "cap_reached"
  | "no_model"
  | "eval_error"
  | "name_taken"
  | "withdrawn"
  | "proposal_missing"
  | "proposal_changed"
  | "wrong_human"
  | "unrecognized_answer"
  | "claimed_elsewhere"
  | "interrupted";

export interface SpecialistApplyResult {
  name: string;
  requestId: string;
  outcome: SpecialistApplyOutcome;
  evalResult?: ProposalEvalResult;
  /** The request filed again (proposal changed, wrong human). */
  refiledRequestId?: string;
  detail?: string;
}

export interface SpecialistSyncResult {
  promoted: number;
  failed: number;
  rejected: number;
  skipped: number;
  /** Applications started in the background and not finished yet (daemon only). */
  running: number;
}

export interface PendingProposal {
  name: string;
  description: string;
  promptVersion: string;
  evalTaskCount: number;
  record: ProposalRecord | null;
  openRequestId: string | null;
}

const logger = log("registry:approval");

/** Added to an eval set's worst-case duration before a silent evaluation counts as stale. */
export const EVALUATION_LEASE_MARGIN_MS = 15 * 60_000;
/** The lease when the proposal no longer loads (its duration cannot be computed). */
const FALLBACK_LEASE_MS = 24 * 3_600_000;

/** This process, as `proposal.json` names the runner of an evaluation (pids are reused). */
const PROCESS_TOKEN = randomUUID();
/** Evaluations running in this process, by registry directory and name (all instances). */
const LIVE = new Set<string>();
const liveKey = (registryDir: string, name: string) => `${registryDir}\u0000${name}`;

/** First instant of the current UTC month, ISO. */
function monthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function specialistKeyOf(name: string): string {
  return `${SPECIALIST_KEY_PREFIX}${name}`;
}

/** The specialist a request's card names, or null when it is not a specialist approval. */
export function specialistOfRequest(row: Pick<HumanRequestRow, "change_card">): string | null {
  const key = row.change_card?.key;
  return typeof key === "string" && key.startsWith(SPECIALIST_KEY_PREFIX)
    ? key.slice(SPECIALIST_KEY_PREFIX.length)
    : null;
}

/** The answer as one of the options, or null. */
export function specialistAnswer(answer: JsonValue | null): SpecialistAnswer | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).option ??
          (answer as JsonObject).choice ??
          (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/^(approve|approved|yes|activate|ok)$/.test(v)) return "approve";
  if (/^(reject|rejected|no|deny|denied|withdraw|drop)$/.test(v)) return "reject";
  return null;
}

/** Whether a run outcome passes the gate, and why not. Pure; the threshold is ADR 0071's. */
export function gateVerdict(
  outcome: Pick<EvalRunOutcome, "total" | "passed" | "failed" | "passRate">,
  threshold: ActivationThreshold = ACTIVATION_THRESHOLD,
): { passed: boolean; reason?: string } {
  const decided = outcome.passed + outcome.failed;
  if (outcome.total < threshold.minTasks) {
    return {
      passed: false,
      reason: `the eval set ran ${outcome.total} task(s); the gate needs at least ${threshold.minTasks}`,
    };
  }
  if (decided < threshold.minTasks) {
    return {
      passed: false,
      reason: `only ${decided} task(s) were decided mechanically (the rest wait on the critic); the gate needs ${threshold.minTasks}`,
    };
  }
  if (outcome.passRate < threshold.passRate) {
    return {
      passed: false,
      reason: `pass rate ${pct(outcome.passRate)} is below the ${pct(threshold.passRate)} the gate needs`,
    };
  }
  return { passed: true };
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function cut(s: string, n = 480): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

function proposedDir(registryDir: string, name: string): string {
  return join(registryDir, PROPOSED_DIR, name);
}

export function readProposalRecord(dir: string): ProposalRecord | null {
  const file = join(dir, PROPOSAL_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ProposalRecord;
  } catch {
    return null;
  }
}

function writeProposalRecord(dir: string, record: ProposalRecord): void {
  writeFileSync(join(dir, PROPOSAL_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * The active file's text: the proposed file with its one `status: proposed` frontmatter line
 * changed to `status: active`, every other byte as evaluated. Throws when the line is not
 * there exactly once.
 */
export function activeTextOf(proposedText: string): string {
  const text = proposedText.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const offset = lines[0]?.replace(/^\uFEFF/, "").trim() === "---" ? 1 : -1;
  const close = offset > 0 ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) : -1;
  if (close < 0) throw new ForerunnerError("validation", "proposal has no frontmatter block");
  const hits: number[] = [];
  for (let i = 1; i < close; i++) {
    if (/^status:\s*["']?proposed["']?\s*(#.*)?$/.test(lines[i] as string)) hits.push(i);
  }
  if (hits.length !== 1) {
    throw new ForerunnerError(
      "validation",
      `proposal frontmatter must hold exactly one "status: proposed" line (found ${hits.length})`,
    );
  }
  lines[hits[0] as number] = "status: active";
  return lines.join("\n");
}

/** Frontmatter fields that must be identical between the evaluated and the promoted file. */
const COMPARED_FIELDS = [
  "name",
  "version",
  "description",
  "default_tier",
  "default_effort",
  "max_effort",
  "allowed_tools",
  "allowed_domains",
  "max_budget_usd",
  "max_turns",
  "timeout_minutes",
  // The run settings of spec D.4 (ADR 0072): what was evaluated is what goes live.
  "max_tokens",
  "speed_mode",
  "temperature",
  "risk_tier_floor",
  "eval_set",
  "requires_sandbox",
  "output_contract",
  "prompt",
] as const;

export class SpecialistApprovals {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: SpecialistApprovalDeps) {}

  /**
   * Write the proposal (`proposeSpecialist`) and file its approval request. The proposal must
   * name the install's human; the request is the one place the human approves it. This is
   * what the `specialist.propose` command (the PM's tool on the model path, the palette) calls
   * through `specialistCommandPort`; the proposer is audited before the request is filed.
   */
  async propose(
    input: SpecialistProposal,
    opts: Omit<ProposeOptions, "registryDir"> = {},
  ): Promise<{ receipt: ProposalReceipt; request: HumanRequestRow }> {
    if (input.proposedBy.humanId !== this.deps.humanId) {
      throw new ForerunnerError(
        "approval_required",
        "a proposal is filed for the install's own human only",
        { details: { proposedFor: input.proposedBy.humanId } },
      );
    }
    const receipt = proposeSpecialist(input, {
      ...this.deps.loadOptions,
      ...opts,
      registryDir: this.deps.registryDir,
      clock: this.deps.clock,
    });
    // The gate's invariant, checked in code and not only by construction: what was written is
    // a proposal the loader keeps `runnable: false` until the human's approve and a passing
    // eval set promote it. A file that would load any other way is removed again and refused,
    // so nothing a caller passes can make the registry run it.
    const check = readSpecialistFile(
      receipt.file,
      this.deps.registryDir,
      "proposed",
      this.deps.loadOptions,
    );
    if (!check.def || check.def.runnable || check.def.status !== "proposed") {
      rmSync(receipt.dir, { recursive: true, force: true });
      throw new ForerunnerError(
        "internal",
        `proposal "${receipt.name}" would run before its approval; refused and removed`,
        { details: { name: receipt.name, issues: check.issues } },
      );
    }
    await this.audit(
      true,
      {
        action: "proposed",
        name: receipt.name,
        promptVersion: receipt.promptVersion,
        by: input.proposedBy.agentId,
        ...(input.proposedBy.projectId ? { projectId: input.proposedBy.projectId } : {}),
      },
      "proposed",
    );
    const request = await this.file(receipt.name);
    return { receipt, request };
  }

  /**
   * The undo of `specialist.propose`: take a proposal back while it still waits for the
   * human. Unlike `reject`, an answer the human already gave is never overridden: a request
   * answered and waiting to be applied, and a running evaluation, refuse with
   * `claim_conflict`; a proposal that is gone (promoted, withdrawn) is `not_found`.
   */
  async withdraw(name: string, by: string): Promise<SpecialistApplyResult> {
    if (by !== this.deps.humanId) {
      await this.audit(false, { action: "withdraw", name, by }, "wrong_human");
      throw new ForerunnerError(
        "approval_required",
        "only the install's human can withdraw a specialist proposal",
        { details: { name } },
      );
    }
    const dir = proposedDir(this.deps.registryDir, name);
    if (!existsSync(join(dir, SPECIALIST_FILE))) {
      throw new ForerunnerError(
        "not_found",
        `no pending proposal named "${name}" (it went live or was withdrawn)`,
        { details: { name } },
      );
    }
    const record = readProposalRecord(dir);
    if (record?.approval?.status === "evaluating") this.assertNotLive(name, record);
    if (record?.approval?.requestId) {
      const req = await this.deps.store.humanRequest.get(record.approval.requestId);
      if (req?.status === "answered" && !(req.change_card as JsonObject | null)?.applied_at) {
        throw new ForerunnerError(
          "claim_conflict",
          `the proposal "${name}" was already answered (${specialistAnswer(req.answer) ?? "an answer"} waits to be applied); the answer stands`,
          { details: { name, requestId: req.id } },
        );
      }
    }
    return this.answerAndApply(name, by, "reject");
  }

  /**
   * File the approval request for a pending proposal, or return the open one that already
   * names it (idempotent). Refuses a proposal of another human and one the loader refuses.
   */
  async file(name: string, opts: { fromApply?: boolean } = {}): Promise<HumanRequestRow> {
    const { store, clock } = this.deps;
    const def = this.readProposal(name);
    const dir = proposedDir(this.deps.registryDir, name);
    let record = readProposalRecord(dir);
    const owner = record?.proposedBy.humanId ?? this.deps.humanId;
    if (owner !== this.deps.humanId) {
      throw new ForerunnerError(
        "approval_required",
        `proposal "${name}" belongs to another human; only that human can approve it`,
        { details: { name } },
      );
    }
    // A live evaluation keeps the name: no second request, no second run, no withdrawal
    // under it. One whose process is gone is recovered first. (`apply` refiles its own.)
    if (!opts.fromApply && record?.approval?.status === "evaluating") {
      this.assertNotLive(name, record);
      await this.markInterrupted(name, record);
      record = readProposalRecord(dir);
    }
    const open = await this.openRequest(name);
    if (open) return open;
    const threshold = ACTIVATION_THRESHOLD;
    const projectId = record?.proposedBy.projectId
      ? ((await store.project.get(record.proposedBy.projectId))?.id ?? null)
      : null;
    const summary = cut(
      `${def.description}${record?.rationale ? ` Why: ${record.rationale}` : ""}`,
      600,
    );
    const evalLine =
      def.evalTaskCount >= threshold.minTasks
        ? `Approving runs its eval set (${def.evalTaskCount} tasks at ${EVALS_DIR}/${name}/); it goes live only if at least ${pct(threshold.passRate)} pass.`
        : `Its eval set has ${def.evalTaskCount} task(s) at ${EVALS_DIR}/${name}/; at least ${threshold.minTasks} are needed before an approval can activate it.`;
    const row = await store.humanRequest.insert({
      human_id: this.deps.humanId,
      project_id: projectId,
      task_id: null,
      session_id: null,
      kind: "approval",
      why: cut(`New specialist proposed: "${name}". ${def.description}`, 400),
      steps: [
        `Read the proposal: ${PROPOSED_DIR}/${name}/${SPECIALIST_FILE} (${def.promptVersion}).`,
        evalLine,
        "Reject withdraws the proposal and frees the name.",
      ],
      options: [...SPECIALIST_APPROVAL_OPTIONS],
      blocking: true,
      risk: "medium",
      change_card: {
        key: specialistKeyOf(name),
        name,
        summary,
        description: def.description,
        rationale: record?.rationale ?? "",
        prompt_version: def.promptVersion,
        eval_set: def.eval_set,
        eval_task_count: def.evalTaskCount,
        threshold: { pass_rate: threshold.passRate, min_tasks: threshold.minTasks },
        allowed_tools: [...def.allowed_tools],
        allowed_domains: [...def.allowed_domains],
        max_budget_usd: def.max_budget_usd,
        risk_tier_floor: def.risk_tier_floor,
        default_tier: def.default_tier,
        proposed_by: record?.proposedBy ? { ...record.proposedBy } : null,
      },
      author_agent: this.deps.agentId,
    });
    // The record names the request: only the install holding it applies the answer. A
    // hand-written proposal without one gets a minimal record here.
    const base: ProposalRecord = record ?? {
      name,
      status: "proposed",
      proposedAt: clock.nowIso(),
      proposedBy: { agentId: this.deps.agentId, humanId: this.deps.humanId },
      rationale: "",
      promptVersion: def.promptVersion,
      evalSet: def.eval_set,
      approval: null,
      evalResult: null,
    };
    writeProposalRecord(dir, {
      ...base,
      approval: { status: "pending", requestId: row.id, at: clock.nowIso() },
    });
    await this.audit(true, { action: "filed", name, requestId: row.id }, "filed");
    logger.info("specialist approval filed", { name, requestId: row.id });
    return row;
  }

  /**
   * File requests for the install's pending proposals that have none yet (written by an
   * earlier build or by hand). A proposal whose last approval failed waits for an explicit
   * `approve` (the CLI) instead of being asked again at once.
   */
  async fileMissing(): Promise<string[]> {
    const filed: string[] = [];
    // A directory scan, not a registry load: the daemon runs this on every approvals sync.
    for (const name of this.proposalNames()) {
      const record = readProposalRecord(proposedDir(this.deps.registryDir, name));
      if (record?.proposedBy?.humanId !== this.deps.humanId) continue;
      const approval = record.approval;
      if (approval && approval.status !== "pending") continue;
      if (approval?.requestId) {
        // Open, or answered and waiting to be applied: nothing to file.
        const req = await this.deps.store.humanRequest.get(approval.requestId);
        if (req?.status === "open") continue;
        if (req?.status === "answered" && !(req.change_card as JsonObject | null)?.applied_at) {
          continue;
        }
      }
      try {
        const row = await this.file(name);
        filed.push(row.id);
      } catch (e) {
        logger.warn("could not file a specialist approval", {
          name,
          error: errorMessage(e),
        });
      }
    }
    return filed;
  }

  /**
   * Recover evaluations whose process is gone or that overran the set's worst-case duration
   * (an exit, a crash, a kill after the claim): the card says `interrupted`, the record too,
   * a note goes to the inbox and the proposal is filed again. Nothing is re-run without a new
   * approve. Returns the names recovered.
   */
  async recoverInterrupted(): Promise<string[]> {
    const out: string[] = [];
    for (const name of this.proposalNames()) {
      const record = readProposalRecord(proposedDir(this.deps.registryDir, name));
      if (record?.approval?.status !== "evaluating") continue;
      if (record.proposedBy?.humanId !== this.deps.humanId) continue;
      if (this.isLive(name, record)) continue;
      await this.markInterrupted(name, record);
      await this.refile(name);
      out.push(name);
    }
    return out;
  }

  /** Pending proposals on disk with their record and open request (for the CLI and the UI). */
  pending(): PendingProposal[] {
    const reg = loadRegistry(this.deps.registryDir, this.deps.loadOptions);
    const out: PendingProposal[] = [];
    for (const def of reg.specialists.values()) {
      if (def.location !== "proposed") continue;
      out.push({
        name: def.name,
        description: def.description,
        promptVersion: def.promptVersion,
        evalTaskCount: def.evalTaskCount,
        record: readProposalRecord(proposedDir(this.deps.registryDir, def.name)),
        openRequestId: null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `pending()` with the open request of each. */
  async pendingWithRequests(): Promise<PendingProposal[]> {
    const out = this.pending();
    for (const p of out) p.openRequestId = (await this.openRequest(p.name))?.id ?? null;
    return out;
  }

  /** Problems the loader found under `proposed/` (never runnable; shown to the human). */
  invalidProposals(): RegistryIssue[] {
    return loadRegistry(this.deps.registryDir, this.deps.loadOptions).invalidProposals;
  }

  /**
   * Apply every answered specialist request of the human not applied yet. `background`: the
   * requests are claimed now and the eval runs go on after this returns (the daemon's answer
   * route and poll); `settled()` waits for them.
   */
  async syncAnswers(opts: { background?: boolean } = {}): Promise<SpecialistSyncResult> {
    const out: SpecialistSyncResult = {
      promoted: 0,
      failed: 0,
      rejected: 0,
      skipped: 0,
      running: 0,
    };
    await this.recoverInterrupted();
    for (const row of await this.unapplied()) {
      const work = this.apply(row);
      if (opts.background) {
        out.running++;
        const p = work
          .catch((e: unknown) =>
            logger.warn("specialist approval failed", {
              requestId: row.id,
              error: errorMessage(e),
            }),
          )
          .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
        continue;
      }
      count(out, await work);
    }
    return out;
  }

  /** Wait for the background applications started by `syncAnswers({ background: true })`. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /**
   * The headless path (`fr specialists approve <name>`): `by` approves as the install's human.
   * The open request is answered (filed first when there is none, e.g. after a failed run) and
   * applied at once, through the same steps as an inbox answer.
   */
  async approve(name: string, by: string): Promise<SpecialistApplyResult> {
    return this.answerAndApply(name, by, "approve");
  }

  /** The headless reject: withdraws the proposal through the same steps as an inbox answer. */
  async reject(name: string, by: string): Promise<SpecialistApplyResult> {
    return this.answerAndApply(name, by, "reject");
  }

  private async answerAndApply(
    name: string,
    by: string,
    answer: SpecialistAnswer,
  ): Promise<SpecialistApplyResult> {
    if (by !== this.deps.humanId) {
      await this.audit(false, { action: answer, name, by }, "wrong_human");
      throw new ForerunnerError(
        "approval_required",
        `only the install's human can ${answer} a specialist proposal`,
        { details: { name } },
      );
    }
    await this.recoverInterrupted();
    const record = readProposalRecord(proposedDir(this.deps.registryDir, name));
    if (record?.approval?.status === "evaluating") this.assertNotLive(name, record);
    // An answer already given (the inbox, the phone) and not applied yet is applied as given:
    // filing a second request would run the set twice or leave that answer unapplied.
    const previous =
      record?.approval?.status === "pending" && record.approval.requestId
        ? await this.deps.store.humanRequest.get(record.approval.requestId)
        : undefined;
    if (
      previous?.status === "answered" &&
      !(previous.change_card as JsonObject | null)?.applied_at
    ) {
      return this.apply(previous);
    }
    const open = (await this.openRequest(name)) ?? (await this.file(name));
    const answered = await this.deps.store.humanRequest.answer(open.id, open.version, answer, by);
    return this.apply(answered);
  }

  // -------------------------------------------------------------------------------------

  private readProposal(name: string): SpecialistDef {
    const file = join(proposedDir(this.deps.registryDir, name), SPECIALIST_FILE);
    if (!existsSync(file)) {
      throw new ForerunnerError("not_found", `no pending proposal named "${name}"`, {
        details: { name },
      });
    }
    const r = readSpecialistFile(file, this.deps.registryDir, "proposed", this.deps.loadOptions);
    if (!r.def) {
      throw new ForerunnerError(
        "validation",
        `proposal "${name}" does not load: ${r.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
        { details: { name, issues: r.issues } },
      );
    }
    return r.def;
  }

  /** Names under `proposed/` that hold a specialist file. */
  private proposalNames(): string[] {
    const root = join(this.deps.registryDir, PROPOSED_DIR);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, SPECIALIST_FILE)))
      .map((d) => d.name)
      .sort();
  }

  /** Whether this install's record names the request (the one place it may be applied). */
  private owns(name: string, requestId: string): boolean {
    return (
      readProposalRecord(proposedDir(this.deps.registryDir, name))?.approval?.requestId ===
      requestId
    );
  }

  /** The longest an evaluation of the set may take: every task at its timeout, plus a margin. */
  private leaseMs(name: string): number {
    try {
      const def = this.readProposal(name);
      return (
        Math.max(1, countEvalTasks(def.evalSetDir)) * def.timeout_minutes * 60_000 +
        EVALUATION_LEASE_MARGIN_MS
      );
    } catch {
      return FALLBACK_LEASE_MS;
    }
  }

  /** Whether an `evaluating` record's run is still going (here, or in a live process). */
  private isLive(name: string, record: ProposalRecord): boolean {
    if (LIVE.has(liveKey(this.deps.registryDir, name))) return true;
    const a = record.approval;
    if (a?.status !== "evaluating") return false;
    // This process wrote it and runs nothing for it any more: it ended without a result.
    if (a.process === PROCESS_TOKEN) return false;
    if (typeof a.pid === "number" && !(this.deps.processAlive ?? isPidAlive)(a.pid)) return false;
    const at = a.at ? Date.parse(a.at) : Number.NaN;
    if (Number.isNaN(at)) return false;
    return this.deps.clock.now() - at < this.leaseMs(name);
  }

  private assertNotLive(name: string, record: ProposalRecord): void {
    if (!this.isLive(name, record)) return;
    throw new ForerunnerError(
      "claim_conflict",
      `the eval set of "${name}" is running (approved by request ${record.approval?.requestId ?? "?"}); wait for its result`,
      { details: { name, requestId: record.approval?.requestId ?? null } },
    );
  }

  /** Close an evaluation that ended without a result: card, record, audit, a note. */
  private async markInterrupted(name: string, record: ProposalRecord): Promise<void> {
    const { store, clock } = this.deps;
    const dir = proposedDir(this.deps.registryDir, name);
    const requestId = record.approval?.requestId ?? null;
    const reason =
      "the evaluation stopped before it finished (the process running it ended or overran); nothing was promoted";
    const row = requestId ? await store.humanRequest.get(requestId) : undefined;
    const card = (row?.change_card ?? null) as JsonObject | null;
    if (row && card && card.outcome === "evaluating") {
      await store.humanRequest.patch(row.id, {
        change_card: { ...card, outcome: "interrupted", reason, applied_at: clock.nowIso() },
      });
    }
    writeProposalRecord(dir, {
      ...record,
      approval: {
        status: "interrupted",
        requestId,
        by: record.approval?.by ?? null,
        at: clock.nowIso(),
      },
    });
    await this.audit(false, { name, requestId }, "interrupted");
    await this.note(
      `The evaluation of specialist "${name}" was interrupted: ${reason}. It stays proposed and is asked again.`,
      row?.project_id ?? null,
    );
    logger.warn("specialist evaluation interrupted", { name, requestId });
  }

  private async openRequest(name: string): Promise<HumanRequestRow | undefined> {
    const key = specialistKeyOf(name);
    const rows = await this.deps.store.humanRequest.list(
      { kind: "approval", human_id: this.deps.humanId, status: "open" },
      { orderBy: [{ column: "created_at" }, { column: "id" }], limit: 1000 },
    );
    return rows.find((r) => r.change_card?.key === key);
  }

  private async unapplied(): Promise<HumanRequestRow[]> {
    const out: HumanRequestRow[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.deps.store.humanRequest.list(
        { kind: "approval", human_id: this.deps.humanId, status: "answered", blocking: true },
        { orderBy: [{ column: "created_at" }, { column: "id" }], limit: 200, offset },
      );
      for (const row of page) {
        const name = specialistOfRequest(row);
        if (name === null) continue;
        if ((row.change_card as JsonObject).applied_at) continue;
        // Only the install whose proposal.json names the request applies it: another
        // composition of the same human (the cloud runner, a second install on a shared
        // store) has no such proposal and must not consume the answer.
        if (!this.owns(name, row.id)) continue;
        out.push(row);
      }
      if (page.length < 200) return out;
    }
  }

  private async audit(allowed: boolean, input: JsonObject, result: string, cost = 0) {
    await this.deps.store.auditLog.append({
      session_id: null,
      run_id: null,
      agent_id: this.deps.agentId,
      human_id: this.deps.humanId,
      tool: SPECIALIST_APPROVAL_AUDIT_TOOL,
      input_summary: cut(JSON.stringify(input)),
      result_summary: cut(result),
      allowed,
      ...(allowed ? {} : { denied_reason: cut(result, 200) }),
      cost_usd_micro: cost,
      occurred_at: this.deps.clock.nowIso(),
    });
  }

  private async note(body: string, projectId: string | null): Promise<void> {
    await this.deps.store.message.send({
      from_agent_id: this.deps.agentId,
      to_human_id: this.deps.humanId,
      project_id: projectId,
      type: "warning",
      body,
      requires_ack: false,
      author_agent: this.deps.agentId,
    });
  }

  /** Act once on one answered request. */
  private async apply(row: HumanRequestRow): Promise<SpecialistApplyResult> {
    const { store, clock } = this.deps;
    const name = specialistOfRequest(row) as string;
    const card = (row.change_card ?? {}) as JsonObject;
    // Claim: a versioned write, so two appliers (the poll and the CLI) never both run it.
    let claimed: HumanRequestRow;
    try {
      claimed = await store.humanRequest.update(row.id, row.version, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome: "evaluating" },
      });
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "version_conflict") {
        return { name, requestId: row.id, outcome: "claimed_elsewhere" };
      }
      throw e;
    }
    // From the claim on, the record says who runs it, so a crash is recognised later and a
    // second request or a withdrawal cannot start under it.
    const key = liveKey(this.deps.registryDir, name);
    LIVE.add(key);
    try {
      const dir = proposedDir(this.deps.registryDir, name);
      const record = readProposalRecord(dir);
      if (record && record.proposedBy.humanId === this.deps.humanId) {
        writeProposalRecord(dir, {
          ...record,
          approval: {
            status: "evaluating",
            requestId: row.id,
            by: row.answered_by,
            at: clock.nowIso(),
            pid: process.pid,
            process: PROCESS_TOKEN,
          },
        });
      }
      return await this.applyClaimed(row, claimed);
    } finally {
      LIVE.delete(key);
    }
  }

  private async applyClaimed(
    row: HumanRequestRow,
    claimed: HumanRequestRow,
  ): Promise<SpecialistApplyResult> {
    const { store, clock } = this.deps;
    const name = specialistOfRequest(row) as string;
    const card = (row.change_card ?? {}) as JsonObject;
    let current = (claimed.change_card ?? {}) as JsonObject;
    const finish = async (
      outcome: SpecialistApplyOutcome,
      extra: JsonObject = {},
    ): Promise<void> => {
      current = { ...current, ...extra, outcome, applied_at: clock.nowIso() };
      await store.humanRequest.patch(row.id, { change_card: current });
    };
    const result = (
      outcome: SpecialistApplyOutcome,
      more: Partial<SpecialistApplyResult> = {},
    ): SpecialistApplyResult => ({ name, requestId: row.id, outcome, ...more });

    if (row.answered_by !== this.deps.humanId) {
      // Another human's answer approves nothing; the proposal waits for its own human.
      await finish("wrong_human");
      await this.audit(false, { name, requestId: row.id, by: row.answered_by }, "wrong_human");
      logger.warn("specialist answer by someone other than the addressee refused", {
        requestId: row.id,
      });
      const refiled = await this.refile(name);
      return result("wrong_human", refiled ? { refiledRequestId: refiled } : {});
    }
    const answer = specialistAnswer(row.answer);
    if (!answer) {
      await finish("unrecognized_answer");
      await this.audit(false, { name, requestId: row.id }, "unrecognized_answer");
      const refiled = await this.refile(name);
      return result("unrecognized_answer", refiled ? { refiledRequestId: refiled } : {});
    }
    const dir = proposedDir(this.deps.registryDir, name);
    if (!existsSync(join(dir, SPECIALIST_FILE))) {
      await finish("proposal_missing");
      await this.audit(false, { name, requestId: row.id, answer }, "proposal_missing");
      return result("proposal_missing");
    }
    const record = readProposalRecord(dir);
    if (record && record.proposedBy.humanId !== this.deps.humanId) {
      await finish("wrong_human");
      await this.audit(false, { name, requestId: row.id }, "proposal of another human");
      return result("wrong_human", { detail: "the proposal belongs to another human" });
    }

    if (answer === "reject") {
      rmSync(dir, { recursive: true, force: true });
      await finish("withdrawn", {
        withdrawn_at: clock.nowIso(),
        ...(record ? { record: record as unknown as JsonObject } : {}),
      });
      await this.audit(true, { name, requestId: row.id, answer }, "withdrawn");
      logger.info("specialist proposal withdrawn", { name, requestId: row.id });
      return result("withdrawn");
    }

    // approve: the file must be the one the human looked at.
    let def: SpecialistDef;
    try {
      def = this.readProposal(name);
    } catch (e) {
      if (record && existsSync(dir)) {
        writeProposalRecord(dir, {
          ...record,
          approval: {
            status: "eval_failed",
            requestId: row.id,
            by: row.answered_by,
            at: clock.nowIso(),
          },
        });
      }
      await finish("proposal_missing", { error: errorMessage(e) });
      await this.audit(false, { name, requestId: row.id }, "proposal does not load");
      return result("proposal_missing", { detail: errorMessage(e) });
    }
    if (typeof card.prompt_version === "string" && card.prompt_version !== def.promptVersion) {
      await finish("proposal_changed", { current_prompt_version: def.promptVersion });
      await this.audit(false, { name, requestId: row.id }, "proposal_changed");
      const refiled = await this.refile(name);
      return result("proposal_changed", refiled ? { refiledRequestId: refiled } : {});
    }
    const keep = async (
      outcome: SpecialistApplyOutcome,
      reason: string,
      evalResult?: ProposalEvalResult,
      next = `fix the prompt or the eval set and approve again (fr specialists approve ${name}), or reject it`,
    ): Promise<SpecialistApplyResult> => {
      // The directory can be gone (removed by hand); the card still gets the outcome.
      if (record && existsSync(dir)) {
        writeProposalRecord(dir, {
          ...record,
          status: "proposed",
          approval: {
            status: "eval_failed",
            requestId: row.id,
            by: row.answered_by,
            at: clock.nowIso(),
          },
          ...(evalResult
            ? {
                evalResult,
                evalHistory: [...(record.evalHistory ?? []), evalResult],
              }
            : {}),
        });
      }
      await finish(outcome, {
        reason,
        ...(evalResult ? { eval_result: evalResult as unknown as JsonObject } : {}),
      });
      await this.audit(
        false,
        { name, requestId: row.id, answer, promptVersion: def.promptVersion },
        `${outcome}: ${reason}`,
        evalResult?.costUsdMicro ?? 0,
      );
      await this.note(
        `Specialist "${name}" was approved but stays proposed: ${reason}. The result is recorded in ${PROPOSED_DIR}/${name}/${PROPOSAL_FILE}; ${next}.`,
        row.project_id,
      );
      logger.info("specialist stays proposed", { name, outcome, reason });
      return result(outcome, { ...(evalResult ? { evalResult } : {}), detail: reason });
    };

    if (existsSync(join(this.deps.registryDir, SPECIALISTS_DIR, name, SPECIALIST_FILE))) {
      return keep("name_taken", `a specialist named "${name}" is already active`);
    }
    const taskCount = countEvalTasks(def.evalSetDir);
    if (taskCount < ACTIVATION_THRESHOLD.minTasks) {
      return keep(
        "eval_set_too_small",
        `its eval set has ${taskCount} task(s) at ${EVALS_DIR}/${name}/; at least ${ACTIVATION_THRESHOLD.minTasks} are needed`,
      );
    }
    const target = this.deps.target(def);
    if (!target) {
      return keep("no_model", "no model is configured to run its eval set (add a credential)");
    }
    // The run's worst case (every task spending its whole budget) must fit the approval
    // budget before the first call; each call is still checked by the hooks.
    let ceiling: number;
    try {
      ceiling = loadEvalTasksLite(def.evalSetDir).reduce((s, t) => s + t.brief.budgetUsdMicro, 0);
    } catch (e) {
      return keep("eval_error", `its eval set does not load: ${errorMessage(e)}`);
    }
    const { budget, shareLeft } = await this.evalBudget();
    if (ceiling > budget) {
      const left =
        shareLeft !== null && shareLeft <= budget
          ? ` (what is left of this month's testing share after earlier approval runs)`
          : "";
      return keep(
        "over_budget",
        `its eval set may spend up to $${(ceiling / 1e6).toFixed(2)}; the approval eval budget is $${(budget / 1e6).toFixed(2)}${left}`,
      );
    }
    if (record) {
      writeProposalRecord(dir, {
        ...record,
        approval: {
          status: "evaluating",
          requestId: row.id,
          by: row.answered_by,
          at: clock.nowIso(),
          pid: process.pid,
          process: PROCESS_TOKEN,
        },
      });
    }
    let outcome: EvalRunOutcome;
    try {
      outcome = await this.deps.evals.run({
        specialist: name,
        candidate: def,
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        pricing: target.pricing,
      });
    } catch (e) {
      // Two refusals are not a failure of the proposal and say what the human can do (ADR 0089).
      if (e instanceof ForerunnerError && e.details?.reason === PROCESS_SANDBOX_REFUSED) {
        const again = `install Docker or Podman, or allow the process sandbox, then approve again (fr specialists approve ${name})`;
        return keep(
          "sandbox_unavailable",
          `its eval set runs commands and this machine has no container engine; nothing ran. To evaluate it, ${again}`,
          undefined,
          again,
        );
      }
      if (e instanceof ForerunnerError && e.code === "budget_exceeded") {
        const level = typeof e.details?.level === "string" ? e.details.level : "month";
        const what = level === "plan" ? "the subscription's plan share is" : `the ${level} cap is`;
        const again = `approve again (fr specialists approve ${name}) once the cap resets or is raised`;
        return keep(
          "cap_reached",
          `${level === "month" ? "month cap past 80%" : `${what} past 80%`}: no eval task starts (${errorMessage(e)})`,
          undefined,
          again,
        );
      }
      return keep("eval_error", `the eval run failed: ${errorMessage(e)}`);
    }
    const verdict = gateVerdict(outcome);
    const evalResult: ProposalEvalResult = {
      passed: verdict.passed,
      passRate: outcome.passRate,
      total: outcome.total,
      passedTasks: outcome.passed,
      failedTasks: outcome.failed,
      needsModel: outcome.needsModel,
      decided: outcome.passed + outcome.failed,
      threshold: { ...ACTIVATION_THRESHOLD },
      provider: target.provider,
      model: target.model,
      effort: target.effort,
      promptVersion: def.promptVersion,
      costUsdMicro: outcome.costUsdMicro,
      durationMs: outcome.durationMs,
      ranAt: clock.nowIso(),
      approvedBy: row.answered_by ?? this.deps.humanId,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
    if (!verdict.passed) return keep("eval_failed", verdict.reason ?? "failed", evalResult);

    // Promote: write specialists/<name>/ (exclusive create), then remove proposed/<name>/.
    let active: SpecialistDef;
    try {
      active = this.promote(def, record, evalResult, row);
    } catch (e) {
      const taken = e instanceof ForerunnerError && e.code === "claim_conflict";
      return keep(taken ? "name_taken" : "eval_error", errorMessage(e), evalResult);
    }
    await finish("promoted", {
      eval_result: evalResult as unknown as JsonObject,
      active_prompt_version: active.promptVersion,
    });
    await this.audit(
      true,
      { name, requestId: row.id, answer, promptVersion: def.promptVersion },
      `promoted at ${pct(evalResult.passRate)} (${active.promptVersion})`,
      evalResult.costUsdMicro,
    );
    logger.info("specialist promoted", {
      name,
      passRate: evalResult.passRate,
      promptVersion: active.promptVersion,
    });
    try {
      this.deps.onPromoted?.(active);
    } catch (e) {
      logger.warn("onPromoted failed", { name, error: errorMessage(e) });
    }
    return result("promoted", { evalResult });
  }

  private promote(
    def: SpecialistDef,
    record: ProposalRecord | null,
    evalResult: ProposalEvalResult,
    row: HumanRequestRow,
  ): SpecialistDef {
    const { clock, registryDir } = this.deps;
    const src = proposedDir(registryDir, def.name);
    const destDir = join(registryDir, SPECIALISTS_DIR, def.name);
    const destFile = join(destDir, SPECIALIST_FILE);
    const text = activeTextOf(readFileSync(def.file, "utf8"));
    const check = validateSpecialistText(
      text,
      destFile,
      registryDir,
      "specialists",
      this.deps.loadOptions,
    );
    if (!check.def?.runnable) {
      throw new ForerunnerError(
        "validation",
        `the active file would not load: ${check.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      );
    }
    const active = check.def;
    for (const f of COMPARED_FIELDS) {
      if (JSON.stringify(active[f]) !== JSON.stringify(def[f])) {
        throw new ForerunnerError("internal", `promotion would change "${f}"; refused`);
      }
    }
    mkdirSync(destDir, { recursive: true });
    try {
      writeFileSync(destFile, text, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") {
        throw new ForerunnerError(
          "claim_conflict",
          `a specialist named "${def.name}" already exists`,
        );
      }
      throw e;
    }
    const now = clock.nowIso();
    const base: ProposalRecord = record ?? {
      name: def.name,
      status: "proposed",
      proposedAt: now,
      proposedBy: { agentId: this.deps.agentId, humanId: this.deps.humanId },
      rationale: "",
      promptVersion: def.promptVersion,
      evalSet: def.eval_set,
      approval: null,
      evalResult: null,
    };
    writeProposalRecord(destDir, {
      ...base,
      status: "active",
      approval: { status: "active", requestId: row.id, by: row.answered_by, at: now },
      evalResult,
      evalHistory: [...(base.evalHistory ?? []), evalResult],
      activePromptVersion: active.promptVersion,
      activatedAt: now,
    });
    rmSync(src, { recursive: true, force: true });
    return active;
  }

  private async refile(name: string): Promise<string | null> {
    try {
      return (await this.file(name, { fromApply: true })).id;
    } catch (e) {
      logger.warn("specialist approval not filed again", { name, error: errorMessage(e) });
      return null;
    }
  }

  /**
   * What this approval's run may spend: the per-run cap (`evalBudgetUsdMicro`, default
   * `DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO`), and, when the human has a monthly cap, no more
   * than what is left of the testing share this UTC month after the earlier approval runs
   * (their cost is on the `registry.specialist_approval` audit rows).
   */
  private async evalBudget(): Promise<{ budget: number; shareLeft: number | null }> {
    const perRun = this.deps.evalBudgetUsdMicro ?? DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO;
    const human = await this.deps.store.human.get(this.deps.humanId);
    const share = Math.floor((human?.monthly_cap_usd_micro ?? 0) * APPROVAL_TESTING_SHARE);
    if (share <= 0) return { budget: perRun, shareLeft: null };
    const rows = await this.deps.store.auditLog.list({
      tool: SPECIALIST_APPROVAL_AUDIT_TOOL,
      humanId: this.deps.humanId,
      from: monthStartIso(this.deps.clock.now()),
    });
    const spent = rows.reduce((sum, r) => sum + (r.cost_usd_micro ?? 0), 0);
    const shareLeft = Math.max(0, share - spent);
    return { budget: Math.min(perRun, shareLeft), shareLeft };
  }
}

function count(out: SpecialistSyncResult, r: SpecialistApplyResult): void {
  if (r.outcome === "promoted") out.promoted++;
  else if (r.outcome === "withdrawn") out.rejected++;
  else if (
    r.outcome === "eval_failed" ||
    r.outcome === "eval_set_too_small" ||
    r.outcome === "over_budget" ||
    r.outcome === "sandbox_unavailable" ||
    r.outcome === "cap_reached" ||
    r.outcome === "no_model" ||
    r.outcome === "eval_error" ||
    r.outcome === "name_taken"
  )
    out.failed++;
  else out.skipped++;
}
