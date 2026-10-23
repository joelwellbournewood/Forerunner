import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PricingTable } from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, join, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { loadEvalTasksLite } from "../models/eval-runner.ts";
import type { EvalRunnerPort, EvalRunOutcome } from "../models/watch.ts";
import type { EffortLevel } from "../provider/types.ts";
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
 * a restart and the CLI never evaluate the same answer twice. Only the human the proposal
 * belongs to may approve it: an answer by anyone else is refused, recorded, and the proposal
 * is filed again for its own human. A proposal edited after it was filed (another prompt
 * version than the card names) is never evaluated under the old approval: it is filed again.
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
  | "active"
  | "eval_failed"
  | "withdrawn";

export interface ProposalApproval {
  status: ProposalApprovalStatus;
  requestId: string | null;
  by?: string | null;
  at?: string;
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
   * The cap of one approval's eval run, micro-USD. Default: the smaller of
   * `DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO` and the human's testing share of the monthly cap.
   */
  evalBudgetUsdMicro?: number;
  /** Called with the runnable definition after a promotion (the daemon updates its registry). */
  onPromoted?: (def: SpecialistDef) => void;
}

export type SpecialistApplyOutcome =
  | "promoted"
  | "eval_failed"
  | "eval_set_too_small"
  | "over_budget"
  | "no_model"
  | "eval_error"
  | "name_taken"
  | "withdrawn"
  | "proposal_missing"
  | "proposal_changed"
  | "wrong_human"
  | "unrecognized_answer"
  | "claimed_elsewhere";

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
   * name the install's human; the request is the one place the human approves it.
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
    const request = await this.file(receipt.name);
    return { receipt, request };
  }

  /**
   * File the approval request for a pending proposal, or return the open one that already
   * names it (idempotent). Refuses a proposal of another human and one the loader refuses.
   */
  async file(name: string): Promise<HumanRequestRow> {
    const { store, clock } = this.deps;
    const def = this.readProposal(name);
    const dir = proposedDir(this.deps.registryDir, name);
    const record = readProposalRecord(dir);
    const owner = record?.proposedBy.humanId ?? this.deps.humanId;
    if (owner !== this.deps.humanId) {
      throw new ForerunnerError(
        "approval_required",
        `proposal "${name}" belongs to another human; only that human can approve it`,
        { details: { name } },
      );
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
    if (record) {
      writeProposalRecord(dir, {
        ...record,
        approval: { status: "pending", requestId: row.id, at: clock.nowIso() },
      });
    }
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
    for (const p of await this.pendingWithRequests()) {
      if (p.openRequestId) continue;
      const owner = p.record?.proposedBy.humanId;
      if (owner !== this.deps.humanId) continue;
      if (p.record?.approval && p.record.approval.status !== "pending") continue;
      try {
        const row = await this.file(p.name);
        filed.push(row.id);
      } catch (e) {
        logger.warn("could not file a specialist approval", {
          name: p.name,
          error: errorMessage(e),
        });
      }
    }
    return filed;
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
        if (specialistOfRequest(row) === null) continue;
        if ((row.change_card as JsonObject).applied_at) continue;
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
    ): Promise<SpecialistApplyResult> => {
      if (record) {
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
        `Specialist "${name}" was approved but stays proposed: ${reason}. The result is recorded in ${PROPOSED_DIR}/${name}/${PROPOSAL_FILE}; fix the prompt or the eval set and approve again (fr specialists approve ${name}), or reject it.`,
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
    const budget = await this.evalBudget();
    if (ceiling > budget) {
      return keep(
        "over_budget",
        `its eval set may spend up to $${(ceiling / 1e6).toFixed(2)}; the approval eval budget is $${(budget / 1e6).toFixed(2)}`,
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
      return (await this.file(name)).id;
    } catch (e) {
      logger.warn("specialist approval not filed again", { name, error: errorMessage(e) });
      return null;
    }
  }

  private async evalBudget(): Promise<number> {
    if (this.deps.evalBudgetUsdMicro !== undefined) return this.deps.evalBudgetUsdMicro;
    const human = await this.deps.store.human.get(this.deps.humanId);
    const share = Math.floor((human?.monthly_cap_usd_micro ?? 0) * APPROVAL_TESTING_SHARE);
    return share > 0
      ? Math.min(DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO, share)
      : DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO;
  }
}

function count(out: SpecialistSyncResult, r: SpecialistApplyResult): void {
  if (r.outcome === "promoted") out.promoted++;
  else if (r.outcome === "withdrawn") out.rejected++;
  else if (
    r.outcome === "eval_failed" ||
    r.outcome === "eval_set_too_small" ||
    r.outcome === "over_budget" ||
    r.outcome === "no_model" ||
    r.outcome === "eval_error" ||
    r.outcome === "name_taken"
  )
    out.failed++;
  else out.skipped++;
}
