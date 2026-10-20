import { DelegationBriefSchema } from "@forerunner/runtime";
import { NAME_RE } from "@forerunner/runtime/registry/types";
import { z } from "zod";

/**
 * Golden eval task format (spec phase 3: "golden eval set per specialist"). One JSON file per
 * task at `evals/registry/evals/<specialist>/NNN-<slug>.json`. The README next to the tasks
 * explains each field for authors; this file is the schema the loader and CI enforce.
 */

/** Relative, forward-slash, no `..`, no leading slash or drive letter. */
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\\"), "use forward slashes")
  .refine(
    (p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p),
    "paths are relative to the task directory",
  )
  .refine(
    (p) => !p.split("/").some((seg) => seg === ".." || seg === ""),
    "no '..' or empty segments",
  );

const FileMap = z.record(RelPath, z.string());

const CheckBase = {
  /** Shown in reports; defaults to a rendering of the check. */
  label: z.string().optional(),
};

export const FileExistsCheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("file_exists"),
    path: RelPath,
    expect: z.enum(["present", "absent"]).default("present"),
  })
  .strict();

export const FileContainsCheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("file_contains"),
    /** Omit to check the driver's final text instead of a file. */
    path: RelPath.optional(),
    text: z.string().min(1),
    expect: z.enum(["present", "absent"]).default("present"),
  })
  .strict();

export const RegexCheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("regex"),
    /** Omit to check the driver's final text instead of a file. */
    path: RelPath.optional(),
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[gimsuy]*$/, "JavaScript regex flags only")
      .default(""),
    expect: z.enum(["match", "no_match"]).default("match"),
  })
  .strict();

export const CommandExit0CheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("command_exit0"),
    /** argv array, never a shell string. `node` is always available; other binaries must be on PATH. */
    argv: z.array(z.string().min(1)).min(1),
    /** Working directory relative to the task directory. */
    cwd: RelPath.optional(),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  })
  .strict();

export const JsonPathCheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("json_path"),
    path: RelPath,
    /** RFC 6901 JSON pointer, e.g. "/scripts/test". "" is the whole document. */
    pointer: z.string().regex(/^(\/[^/]*)*$/, "must be a JSON pointer like /a/b/0"),
    /** When given, the value at the pointer must deep-equal this. */
    equals: z.unknown().optional(),
    /** When false, the pointer must NOT resolve. */
    exists: z.boolean().default(true),
  })
  .strict();

export const RubricCheckSchema = z
  .object({
    ...CheckBase,
    kind: z.literal("rubric"),
    /** Criteria the critic grades; the runner reports "needs_model" for these. */
    criteria: z.array(z.string().min(5)).min(1),
    passThreshold: z.number().min(0).max(100).default(75),
  })
  .strict();

export const CheckSchema = z.discriminatedUnion("kind", [
  FileExistsCheckSchema,
  FileContainsCheckSchema,
  RegexCheckSchema,
  CommandExit0CheckSchema,
  JsonPathCheckSchema,
  RubricCheckSchema,
]);
export type EvalCheck = z.infer<typeof CheckSchema>;
export type CheckKind = EvalCheck["kind"];

/** The delegation brief minus the fields the runner fills in (specialist, ids). */
export const EvalBriefSchema = DelegationBriefSchema.omit({
  specialist: true,
  taskId: true,
  projectId: true,
  timeoutMs: true,
});
export type EvalBrief = z.infer<typeof EvalBriefSchema>;

export const SeededDefectSchema = z
  .object({
    description: z.string().min(10),
    how_to_detect: z.string().min(10),
    /** Files that replace the expected ones to produce the defective variant. */
    files: FileMap.optional(),
    /** Final text of the defective variant, when the task grades final text. */
    final_text: z.string().optional(),
  })
  .strict();

export const EvalTaskSchema = z
  .object({
    /** `<specialist>-NNN`, matching the file name's NNN. */
    id: z.string().regex(/^[a-z][a-z0-9-]*-\d{3}$/, "id is <specialist>-NNN"),
    specialist: z.string().regex(NAME_RE),
    title: z.string().min(5),
    brief: EvalBriefSchema,
    setup: z
      .object({
        /** Fixture files written into the task directory before the specialist runs. */
        files: FileMap.default({}),
        /** Free-form fixture data a driver may use (never read by the runner). */
        fixtures: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .default({ files: {} }),
    checks: z.array(CheckSchema).min(1),
    /** Files written after the specialist finishes and before checks run (hidden graders). */
    grader_files: FileMap.optional(),
    /** The reference solution: what a correct specialist would leave in the task directory. */
    expected_files: FileMap.optional(),
    /** Reference final text, when the task grades the final message. */
    expected_final_text: z.string().optional(),
    /** One line on what a clean result looks like, for humans reading the report. */
    expected_clean_output: z.string().optional(),
    /** The same task with a planted defect; the critic calibration gate uses it. */
    seeded_defect: SeededDefectSchema.optional(),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type EvalTask = z.infer<typeof EvalTaskSchema>;
export type EvalTaskInput = z.input<typeof EvalTaskSchema>;

export type EvalVariant = "clean" | "seeded_defect";

export type CheckStatus = "pass" | "fail" | "needs_model" | "error";

export interface CheckResult {
  kind: CheckKind;
  label: string;
  status: CheckStatus;
  /** One line a human can verify: what was looked at and what was found. */
  evidence: string;
  /** Longer output (command output tail, matched text) when useful. */
  detail?: string;
  durationMs: number;
}

export type TaskStatus = "pass" | "fail" | "needs_model" | "error";

export interface EvalTaskResult {
  taskId: string;
  title: string;
  variant: EvalVariant;
  status: TaskStatus;
  checks: CheckResult[];
  /** Evidence lines across checks plus driver notes, in order. */
  evidence: string[];
  finalText: string;
  costUsdMicro: number;
  durationMs: number;
  /** Set when the driver threw or the work directory could not be prepared. */
  error?: { code: string; message: string };
  /** Kept only with keepWorkDirs. */
  workDir?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  needsModel: number;
  errors: number;
  /** passed / (passed + failed); tasks waiting on the critic are not counted either way. */
  passRate: number;
  costUsdMicro: number;
  durationMs: number;
}

export interface EvalSetResult {
  specialist: string;
  variant: EvalVariant;
  /** `<name>@<semver>+<sha8>` of the specialist prompt used, when the driver knows it. */
  promptVersion?: string;
  startedAt: string;
  results: EvalTaskResult[];
  summary: EvalSummary;
}
