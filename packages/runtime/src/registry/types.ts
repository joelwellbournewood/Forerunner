import { z } from "zod";
import type { EffortLevel, ModelTier } from "../provider/types.ts";

/**
 * Registry file formats (spec C "specialists are files in forerunner-registry", spec D
 * "every run stores prompt version"). The registry is a directory:
 *
 *   specialists/<name>/specialist.md   frontmatter (SpecialistFrontmatterSchema) + role prompt
 *   proposed/<name>/specialist.md      the same shape with status: proposed (written by proposeSpecialist)
 *   principals/<name>.md               frontmatter (PromptFrontmatterSchema) + prompt
 *   critic/critic.md                   frontmatter (PromptFrontmatterSchema) + prompt
 *   evals/<name>/NNN-<slug>.json       golden tasks (schema lives in @forerunner/evals)
 *
 * docs/maintainers/adding-a-specialist.md documents every field.
 */
export const TIER_VALUES = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
] as const satisfies readonly ModelTier[];
export const EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];
export const SPECIALIST_STATUSES = ["active", "proposed", "retired"] as const;
export type SpecialistStatus = (typeof SPECIALIST_STATUSES)[number];

/** Strict semver 2.0.0 core with an optional pre-release tag. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** Registry names: lowercase, digits and single dashes, e.g. `science-evaluator`. */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Forerunner tool names, or Claude Code tools with the `cc:` prefix. Never a wildcard. */
export const TOOL_NAME_RE = /^(?:cc:)?[A-Za-z][A-Za-z0-9_.-]*$/;
export const CLAUDE_CODE_PREFIX = "cc:";

/** Claude Code tools a specialist may name with the `cc:` prefix (validated by the loader). */
export const KNOWN_CLAUDE_CODE_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
  "NotebookRead",
];

export function effortIndex(e: EffortLevel): number {
  return EFFORT_VALUES.indexOf(e);
}

const Tier = z.enum(TIER_VALUES);
const Effort = z.enum(EFFORT_VALUES);
const Name = z.string().regex(NAME_RE, "lowercase letters, digits and single dashes only");
const Semver = z.string().regex(SEMVER_RE, "must be semver, e.g. 1.0.0 (quote it in YAML)");
const ToolName = z
  .string()
  .refine((t) => !t.includes("*"), "wildcards are never allowed in allowed_tools")
  .refine(
    (t) => TOOL_NAME_RE.test(t),
    "tool names are letters, digits, '_', '.', '-' with an optional 'cc:' prefix",
  );
const Domain = z
  .string()
  .trim()
  .min(1)
  .refine(
    (d) => d !== "*" && !/^\*(\.\*)*$/.test(d),
    "'*' is not an allowed domain; list hosts or '*.example.com'",
  )
  .refine(
    (d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(d),
    "domains are hostnames, optionally with a leading '*.'",
  );
const RiskTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const effortOrder = (
  v: { default_effort: EffortLevel; max_effort: EffortLevel },
  ctx: z.RefinementCtx,
) => {
  if (effortIndex(v.default_effort) > effortIndex(v.max_effort)) {
    ctx.addIssue({
      code: "custom",
      path: ["default_effort"],
      message: `default_effort "${v.default_effort}" is above max_effort "${v.max_effort}"`,
    });
  }
};

export const SpecialistFrontmatterSchema = z
  .object({
    name: Name,
    version: Semver,
    description: z.string().trim().min(10, "say in one line what this specialist is for"),
    default_tier: Tier,
    default_effort: Effort,
    max_effort: Effort,
    allowed_tools: z.array(ToolName).min(1, "a specialist needs at least one tool"),
    allowed_domains: z.array(Domain).default([]),
    max_budget_usd: z.number().positive("max_budget_usd must be above 0"),
    max_turns: z.number().int().positive(),
    timeout_minutes: z.number().int().positive(),
    risk_tier_floor: RiskTier,
    eval_set: z.string().regex(/^evals\/[a-z][a-z0-9-]*$/, 'eval_set is "evals/<name>"'),
    status: z.enum(SPECIALIST_STATUSES),
    requires_sandbox: z.boolean(),
    output_contract: z.string().trim().min(10, "say what the specialist must return"),
  })
  .strict()
  .superRefine(effortOrder);

export type SpecialistFrontmatter = z.infer<typeof SpecialistFrontmatterSchema>;
/** What goes in (before defaults are applied). */
export type SpecialistFrontmatterInput = z.input<typeof SpecialistFrontmatterSchema>;

/** Principals (project manager, conversation agent) and the critic: prompt + model defaults only. */
export const PromptFrontmatterSchema = z
  .object({
    name: Name,
    version: Semver,
    description: z.string().trim().min(10),
    default_tier: Tier,
    default_effort: Effort,
    max_effort: Effort,
    allowed_tools: z.array(ToolName).default([]),
    status: z.enum(SPECIALIST_STATUSES).default("active"),
  })
  .strict()
  .superRefine(effortOrder);

export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

/** Everything the loader knows about one file beyond its frontmatter. */
export interface LoadedPrompt {
  /** Absolute path of the file. */
  file: string;
  /** Path relative to the registry root, forward slashes. */
  relPath: string;
  /** sha256 of the newline-normalised file content. */
  sha256: string;
  /** First eight hex digits of sha256; what runs record. */
  sha8: string;
  /** `<name>@<semver>+<sha8>`: the prompt_version every run stores (spec D, P). */
  promptVersion: string;
  /** The markdown role prompt (frontmatter removed). */
  prompt: string;
  /** Lines in the prompt, for the 120-line rule. */
  promptLines: number;
}

export interface SpecialistDef extends SpecialistFrontmatter, LoadedPrompt {
  kind: "specialist";
  /** Where the file was found: a proposal is never runnable. */
  location: "specialists" | "proposed";
  /** True only for status "active" under specialists/. Proposed and retired are loaded, not run. */
  runnable: boolean;
  /** Absolute path of the eval set directory named by eval_set (it may not exist yet). */
  evalSetDir: string;
  /** Number of task files in the eval set; 0 when the directory is missing. */
  evalTaskCount: number;
}

export interface PromptDef extends PromptFrontmatter, LoadedPrompt {
  kind: "principal" | "critic";
}

export interface RegistryIssue {
  /** Registry-relative posix path, or the directory when the file is missing. */
  file: string;
  /** Dotted frontmatter field, or "-" for file-level problems. */
  field: string;
  message: string;
}

export interface Registry {
  /** Absolute registry root. */
  dir: string;
  specialists: Map<string, SpecialistDef>;
  principals: Map<string, PromptDef>;
  critic: PromptDef;
  /**
   * Problems found under `proposed/` (content written at runtime on an agent's request). Never
   * fatal: the entry is left out of `specialists` and can never run; the approval flow shows
   * these to the human. `specialists/`, `principals/` and the critic are strict and fail the load.
   */
  invalidProposals: RegistryIssue[];
  /** sha256 per loaded file, keyed by registry-relative posix path. */
  files: Map<string, string>;
  /** sha256 over every file hash; changes when any prompt changes. */
  hash: string;
  /** prompt_version for a specialist, principal or the critic by name. Throws not_found. */
  version(name: string): string;
  /** A specialist by name. Throws not_found. */
  specialist(name: string): SpecialistDef;
  /** Only runnable specialists, sorted by name. */
  runnableSpecialists(): SpecialistDef[];
}

export interface LoadRegistryOptions {
  /** Forerunner tool names (ToolRegistry.names()); when given, unknown names are errors. */
  toolNames?: readonly string[];
  /** Claude Code tool names accepted behind the `cc:` prefix. Default KNOWN_CLAUDE_CODE_TOOLS. */
  claudeCodeTools?: readonly string[];
  /** Maximum prompt lines; registry prompts must stay short and concrete. Default 120. */
  maxPromptLines?: number;
}
