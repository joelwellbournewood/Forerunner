import { ForerunnerError } from "@forerunner/platform";
// Deep import (no runtime index): the runtime package imports this package, so reading the
// schemas through `@forerunner/runtime` would meet a half-initialised module.
import {
  EFFORT_VALUES,
  MaxTokensSchema,
  NAME_RE,
  SEMVER_RE,
  SpeedModeSchema,
  TemperatureSchema,
  TIER_VALUES,
  TimeoutMinutesSchema,
} from "@forerunner/runtime/registry/types";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type {
  CommandContext,
  CommandDef,
  SpecialistCommandPort,
  SpecialistNameState,
} from "../types.ts";
import { asObject } from "./shared.ts";

/**
 * specialist.propose (spec C.5 "PM can propose a new specialist; it goes live only after human
 * approval and passing its eval set", ADR 0071): the principal agent's way to reach the
 * approval gate from a session. The command writes nothing itself. On the yes it hands the
 * proposal to `CommandPorts.specialists` (the runtime's `SpecialistApprovals.propose`), which
 * validates it with the loader's own checks, writes `proposed/<name>/` with `status: proposed`
 * (never runnable) and files the human's blocking approval request. Medium risk: the change
 * card needs a yes, so a model cannot flood the inbox with proposals; the yes files the
 * proposal and activates nothing. The undo withdraws the proposal while it waits.
 *
 * The parameters are the registry file's frontmatter fields by their file names (see
 * adding-a-specialist.md), plus `prompt` (the role prompt, markdown) and `rationale` (why).
 * `status` and `eval_set` are never parameters: the gate forces `proposed` and derives
 * `evals/<name>`. The limits default to a cautious new specialist (one dollar per run, 20
 * turns, 15 minutes, risk tier floor 1, sandboxed); the loader's full checks (known tools,
 * domains, effort order, the 120-line prompt rule, a free name) run in the gate before
 * anything touches the disk.
 */
const RiskTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const params = z.object({
  /** Registry name: lowercase letters, digits and single dashes; also the directory name. */
  name: z.string().regex(NAME_RE, "lowercase letters, digits and single dashes only"),
  version: z.string().regex(SEMVER_RE, "must be semver, e.g. 0.1.0").default("0.1.0"),
  /** One line, shown on the approval card and in the extensions panel. */
  description: z.string().trim().min(10, "say in one line what this specialist is for").max(300),
  /** Why the principal agent wants it; shown to the human on the card. */
  rationale: z.string().trim().min(10, "say why this specialist is needed").max(2000),
  /** The role prompt (markdown). Kept under the registry's 120-line rule by the gate. */
  prompt: z.string().min(1, "a proposal needs a role prompt").max(40_000),
  default_tier: z.enum(TIER_VALUES),
  default_effort: z.enum(EFFORT_VALUES).default("medium"),
  max_effort: z.enum(EFFORT_VALUES).default("high"),
  /** Forerunner tool names or Claude Code tools as `cc:Read`; never a wildcard. */
  allowed_tools: z.array(z.string().min(1)).min(1, "a specialist needs at least one tool").max(32),
  allowed_domains: z.array(z.string().min(1)).max(32).default([]),
  max_budget_usd: z.number().positive().default(1),
  max_turns: z.number().int().positive().default(20),
  timeout_minutes: TimeoutMinutesSchema.default(15),
  max_tokens: MaxTokensSchema.optional(),
  speed_mode: SpeedModeSchema.optional(),
  temperature: TemperatureSchema.optional(),
  risk_tier_floor: RiskTier.default(1),
  requires_sandbox: z.boolean().default(true),
  /** What the specialist must return; the critic checks the result against it. */
  output_contract: z.string().trim().min(10, "say what the specialist must return").max(1000),
});
export type SpecialistProposeParams = z.infer<typeof params>;

const WHAT = "the specialist registry";

function specialistPort(ctx: CommandContext): SpecialistCommandPort {
  if (!ctx.ports.specialists) {
    throw new ForerunnerError("unavailable", "the specialist approval gate is not connected here");
  }
  return ctx.ports.specialists;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function usd(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
}

function oldValueOf(name: string): string {
  return `no specialist "${name}"`;
}

function newValueOf(p: SpecialistProposeParams): string {
  return `a proposed specialist "${p.name}" (${p.default_tier}; tools ${p.allowed_tools.join(", ")}; USD ${usd(p.max_budget_usd)} per run; risk tier floor ${p.risk_tier_floor}) waiting for your approval in the inbox`;
}

function sentenceOf(
  p: SpecialistProposeParams,
  gate: Pick<SpecialistNameState, "evalTaskCount" | "minEvalTasks" | "passRate">,
): string {
  return `Proposed the specialist "${p.name}" (${p.default_tier}): approve it in your inbox; it goes live only after your approve and a passing eval set (${gate.evalTaskCount} task${gate.evalTaskCount === 1 ? "" : "s"} at evals/${p.name} today; at least ${gate.minEvalTasks} are needed and ${pct(gate.passRate)} must pass). Undo.`;
}

/** A free name, or the refusal with its code (the gate would refuse the same way after the yes). */
async function freeName(
  p: SpecialistProposeParams,
  ctx: CommandContext,
): Promise<SpecialistNameState> {
  const state = await specialistPort(ctx).check(p.name);
  if (state.taken === "active") {
    throw new ForerunnerError("claim_conflict", `a specialist named "${p.name}" already exists`, {
      details: { name: p.name },
    });
  }
  if (state.taken === "proposed") {
    throw new ForerunnerError("claim_conflict", `a proposal named "${p.name}" is already pending`, {
      details: { name: p.name },
    });
  }
  return state;
}

/** The agent the proposal is recorded for: the model's own id on the model path, else the principal. */
function proposerOf(ctx: CommandContext): string {
  const agentId = ctx.actor.kind === "agent" ? ctx.actor.id : ctx.agentId;
  if (!agentId) {
    throw new ForerunnerError("validation", "no principal agent to propose a specialist for");
  }
  return agentId;
}

export const specialistPropose: CommandDef<SpecialistProposeParams> = {
  name: "specialist.propose",
  description:
    "Propose a new specialist (role prompt, model tier, tools, limits) for the human to approve. It is written as a proposal and goes live only after the human approves it in the inbox and its eval set (evals/<name>, at least 10 tasks) passes; this never activates anything.",
  params,
  risk: "medium",
  scope: "global",
  reversible: true,
  undoStrategy: "withdraw the proposal while it still waits for the human's approval",
  actionClass: "non_routine",
  async plan(p, ctx) {
    const state = await freeName(p, ctx);
    return buildCard({
      command: "specialist.propose",
      what: WHAT,
      oldValue: oldValueOf(p.name),
      newValue: newValueOf(p),
      scope: "global",
      risk: "medium",
      sentence: sentenceOf(p, state),
      reversible: true,
    });
  },
  async run(p, ctx) {
    const port = specialistPort(ctx);
    const agentId = proposerOf(ctx);
    await freeName(p, ctx);
    const r = await port.propose({
      frontmatter: {
        name: p.name,
        version: p.version,
        description: p.description,
        default_tier: p.default_tier,
        default_effort: p.default_effort,
        max_effort: p.max_effort,
        allowed_tools: p.allowed_tools,
        allowed_domains: p.allowed_domains,
        max_budget_usd: p.max_budget_usd,
        max_turns: p.max_turns,
        timeout_minutes: p.timeout_minutes,
        ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
        ...(p.speed_mode !== undefined ? { speed_mode: p.speed_mode } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        risk_tier_floor: p.risk_tier_floor,
        requires_sandbox: p.requires_sandbox,
        output_contract: p.output_contract,
      },
      prompt: p.prompt,
      rationale: p.rationale,
      proposedBy: {
        agentId,
        humanId: ctx.humanId,
        ...(ctx.activeProjectId ? { projectId: ctx.activeProjectId } : {}),
      },
    });
    // The row records what was proposed and where, never the prompt (the file holds it).
    return {
      before: { name: p.name, status: null },
      after: {
        name: r.name,
        status: "proposed",
        prompt_version: r.promptVersion,
        request_id: r.requestId,
        file: r.file,
        eval_set: r.evalSet,
        eval_task_count: r.evalTaskCount,
      },
      sentence: sentenceOf(p, r),
      projectId: null,
    };
  },
  async undo(p, _before, after, ctx) {
    const a = asObject(after);
    const name = typeof a.name === "string" ? a.name : p.name;
    await specialistPort(ctx).withdraw({ name, humanId: ctx.humanId });
  },
};
