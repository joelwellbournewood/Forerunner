import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { type Clock, ForerunnerError, join, log, systemClock } from "@forerunner/platform";
import { serializeFrontmatter } from "./frontmatter.ts";
import {
  countEvalTasks,
  EVALS_DIR,
  PROPOSED_DIR,
  SPECIALIST_FILE,
  SPECIALISTS_DIR,
  validateSpecialistText,
} from "./loader.ts";
import {
  type LoadRegistryOptions,
  NAME_RE,
  type RegistryIssue,
  type SpecialistFrontmatterInput,
  SpecialistFrontmatterSchema,
} from "./types.ts";

/**
 * Spec C: "PM can propose a new specialist. It goes live after human approval and passing its
 * eval set." This module writes the proposal; approval and the eval gate are enforced later by
 * the registry approval flow (phase 3). Until then a proposal is loaded with `runnable: false`
 * and no capability token is ever issued for it.
 *
 * A proposal is written by a model's request, so the write path is defensive: the exact bytes
 * are validated with the loader's own checks before anything touches the disk, the name is
 * claimed with an exclusive create (`wx`, so two concurrent proposals cannot both win), and
 * if the claim cannot be completed the files this call wrote are removed again. A proposal
 * therefore never leaves a half-written or invalid directory behind, and a name is only locked
 * by a proposal that loads.
 */
export const MIN_EVAL_TASKS_FOR_ACTIVATION = 10;
export const ACTIVATION_PASS_RATE = 0.9;
export const PROPOSAL_FILE = "proposal.json";

export interface SpecialistProposal {
  /** Frontmatter without status (the proposal forces "proposed") and eval_set (derived). */
  frontmatter: Omit<SpecialistFrontmatterInput, "status" | "eval_set">;
  /** The role prompt in markdown. */
  prompt: string;
  /** Why the principal agent wants this specialist, in its own words. */
  rationale: string;
  /** Agent that proposed it, and the human it belongs to. */
  proposedBy: { agentId: string; humanId: string; projectId?: string };
}

export interface ProposalStep {
  step: "human_approval" | "eval_set" | "eval_pass";
  description: string;
  done: boolean;
}

export interface ProposalReceipt {
  name: string;
  status: "proposed";
  dir: string;
  file: string;
  proposalFile: string;
  promptVersion: string;
  evalSetDir: string;
  evalTaskCount: number;
  /** What must happen before the specialist can run. Nothing here is done by this call. */
  requiredToActivate: ProposalStep[];
}

export interface ProposeOptions extends LoadRegistryOptions {
  registryDir: string;
  clock?: Clock;
}

const logger = log("registry:proposals");

function errnoCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function issueList(issues: RegistryIssue[]): string {
  return issues.map((i) => `${i.field}: ${i.message}`).join("; ");
}

/** Remove the files this call wrote, then the directory if that left it empty. Best effort. */
function removeOwn(written: string[], dir: string): void {
  for (const f of written) {
    try {
      unlinkSync(f);
    } catch {
      // already gone; nothing else to do
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // not empty (someone else's files) or already gone
  }
}

/**
 * Write `<registry>/proposed/<name>/specialist.md` (status: proposed) and `proposal.json`.
 * Rejects names already taken by a specialist or a pending proposal (`claim_conflict`) and any
 * content the loader would refuse (`validation`), without writing. Returns the steps that
 * remain; the caller (a command, later the approval flow) records them as human requests.
 */
export function proposeSpecialist(
  input: SpecialistProposal,
  opts: ProposeOptions,
): ProposalReceipt {
  const clock = opts.clock ?? systemClock;
  const name = input.frontmatter.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ForerunnerError("validation", `invalid specialist name "${String(name)}"`, {
      details: { field: "name" },
    });
  }
  const fm = SpecialistFrontmatterSchema.safeParse({
    ...input.frontmatter,
    eval_set: `${EVALS_DIR}/${name}`,
    status: "proposed",
  });
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => ({
      field: i.path.map(String).join(".") || "-",
      message: i.message,
    }));
    throw new ForerunnerError(
      "validation",
      `specialist proposal "${name}" rejected: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      { details: { name, issues } },
    );
  }
  if (input.prompt.trim() === "") {
    throw new ForerunnerError("validation", "a proposal needs a role prompt", {
      details: { field: "prompt" },
    });
  }
  if (input.rationale.trim().length < 10) {
    throw new ForerunnerError("validation", "a proposal needs a rationale", {
      details: { field: "rationale" },
    });
  }

  // Serialize in a fixed key order so diffs between proposals stay readable. The serializer
  // refuses values the subset cannot round-trip, before anything is written.
  const data = fm.data;
  const ordered: Record<string, unknown> = {
    name: data.name,
    version: data.version,
    description: data.description,
    default_tier: data.default_tier,
    default_effort: data.default_effort,
    max_effort: data.max_effort,
    allowed_tools: data.allowed_tools,
    allowed_domains: data.allowed_domains,
    max_budget_usd: data.max_budget_usd,
    max_turns: data.max_turns,
    timeout_minutes: data.timeout_minutes,
    risk_tier_floor: data.risk_tier_floor,
    eval_set: data.eval_set,
    status: data.status,
    requires_sandbox: data.requires_sandbox,
    output_contract: data.output_contract,
  };
  const text = serializeFrontmatter(ordered, input.prompt);
  const dir = join(opts.registryDir, PROPOSED_DIR, name);
  const file = join(dir, SPECIALIST_FILE);
  const proposalFile = join(dir, PROPOSAL_FILE);

  // Validate the exact bytes as the loader will see them (prompt length, tools, name/directory,
  // round-trip through the parser) while nothing is on disk yet.
  const check = validateSpecialistText(text, file, opts.registryDir, "proposed", opts);
  if (!check.def) {
    throw new ForerunnerError(
      "validation",
      `specialist proposal "${name}" rejected: ${issueList(check.issues)}`,
      { details: { name, issues: check.issues } },
    );
  }
  const def = check.def;

  const existing = join(opts.registryDir, SPECIALISTS_DIR, name, SPECIALIST_FILE);
  if (existsSync(existing)) {
    throw new ForerunnerError("claim_conflict", `a specialist named "${name}" already exists`, {
      details: { name, file: existing },
    });
  }

  const evalSetDir = join(opts.registryDir, EVALS_DIR, name);
  const evalTaskCount = countEvalTasks(evalSetDir);
  const record = {
    name,
    status: "proposed",
    proposedAt: clock.nowIso(),
    proposedBy: input.proposedBy,
    rationale: input.rationale,
    promptVersion: def.promptVersion,
    evalSet: data.eval_set,
    approval: null,
    evalResult: null,
  };

  // Claim the name: an exclusive create of specialist.md is the lock. A pre-existing file (a
  // pending proposal, or a concurrent proposer who got there first) is a conflict and is never
  // overwritten.
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    const code = errnoCode(e);
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new ForerunnerError("claim_conflict", `a proposal named "${name}" is already pending`, {
        details: { name, file },
        cause: e,
      });
    }
    throw new ForerunnerError(
      "internal",
      `cannot write proposal "${name}": ${e instanceof Error ? e.message : String(e)}`,
      { details: { name, file }, cause: e },
    );
  }
  const written = [file];
  try {
    writeFileSync(proposalFile, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    written.push(proposalFile);
  } catch (e) {
    // The claim cannot be completed: take back what this call wrote and leave the rest alone.
    removeOwn(written, dir);
    if (errnoCode(e) === "EEXIST") {
      throw new ForerunnerError(
        "claim_conflict",
        `a proposal directory for "${name}" is already in use (${PROPOSED_DIR}/${name}/${PROPOSAL_FILE} exists)`,
        { details: { name, file: proposalFile }, cause: e },
      );
    }
    throw new ForerunnerError(
      "internal",
      `cannot write proposal "${name}": ${e instanceof Error ? e.message : String(e)}`,
      { details: { name, file: proposalFile }, cause: e },
    );
  }
  logger.info("specialist proposed", { name, promptVersion: def.promptVersion, dir });

  return {
    name,
    status: "proposed",
    dir,
    file,
    proposalFile,
    promptVersion: def.promptVersion,
    evalSetDir,
    evalTaskCount,
    requiredToActivate: [
      {
        step: "human_approval",
        description: `a human approves the proposal (recorded in ${PROPOSED_DIR}/${name}/${PROPOSAL_FILE})`,
        done: false,
      },
      {
        step: "eval_set",
        description: `an eval set with at least ${MIN_EVAL_TASKS_FOR_ACTIVATION} tasks exists at ${EVALS_DIR}/${name}/`,
        done: evalTaskCount >= MIN_EVAL_TASKS_FOR_ACTIVATION,
      },
      {
        step: "eval_pass",
        description: `the eval set passes at ${Math.round(ACTIVATION_PASS_RATE * 100)}% or better with the proposed prompt version`,
        done: false,
      },
    ],
  };
}
