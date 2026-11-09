import type {
  BashOutput,
  FileEditOutput,
  FileReadOutput,
  FileWriteOutput,
  GlobOutput,
  GrepOutput,
  NotebookEditOutput,
  TodoWriteOutput,
  WebFetchOutput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { z } from "zod";

/**
 * The output shapes of the Claude Code built-in tools a run on the Agent SDK path may be given
 * (W15-12, TR-1's guard). A built-in tool's output that holds a resolved secret is handed back to
 * Claude Code with the value scrubbed out of its strings (`EnforcementHooks.redactToolOutput`).
 * Claude Code checks that replacement against the tool's own output schema and, when it does not
 * match, silently keeps the ORIGINAL output: the unredacted value would reach the model. So a
 * replacement is sent only when the original is one of the shapes below and the replacement is
 * that same shape; otherwise the hook refuses the output and the run stops before the model sees
 * it (fail closed).
 *
 * The Agent SDK ships these shapes as TypeScript types only (`sdk-tools.d.ts`, no runtime
 * validators), so they are written out here as strict schemas: every key the type names and no
 * other, every fixed word (`type`, `mode`, `status`, ...) as the literal it must be. The ties at
 * the end make `pnpm typecheck` fail when an SDK upgrade changes a shape; the typed fixtures in
 * `test/security-sdk.test.ts` (one per tool, `satisfies` the SDK type) check the same from
 * the other side. A key the SDK adds later reads as "none of its shapes": refused when it holds
 * a secret, never passed.
 */

const num = z.number();
const str = z.string();

const patchHunk = z.strictObject({
  oldStart: num,
  oldLines: num,
  newStart: num,
  newLines: num,
  lines: z.array(str),
});

const gitDiff = z.strictObject({
  filename: str,
  status: z.enum(["modified", "added"]),
  additions: num,
  deletions: num,
  changes: num,
  patch: str,
  repository: str.nullable().optional(),
});

const BashShape = z.strictObject({
  stdout: str,
  stderr: str,
  rawOutputPath: str.optional(),
  interrupted: z.boolean(),
  isImage: z.boolean().optional(),
  backgroundTaskId: str.optional(),
  backgroundedByUser: z.boolean().optional(),
  timedOutAfterMs: num.optional(),
  backgroundCwdHint: str.optional(),
  backgroundEndsWithFinalResponse: z.literal(true).optional(),
  dangerouslyDisableSandbox: z.boolean().optional(),
  returnCodeInterpretation: str.optional(),
  noOutputExpected: z.boolean().optional(),
  structuredContent: z.array(z.unknown()).optional(),
  persistedOutputPath: str.optional(),
  persistedOutputSize: num.optional(),
  staleReadFileStateHint: str.optional(),
  ghRateLimitHint: str.optional(),
  gitOperation: z
    .strictObject({
      commit: z
        .strictObject({
          sha: str,
          kind: z.enum(["committed", "amended", "cherry-picked"]),
          branch: str.optional(),
        })
        .optional(),
      push: z.strictObject({ branch: str }).optional(),
      branch: z.strictObject({ ref: str, action: z.enum(["merged", "rebased"]) }).optional(),
      pr: z
        .strictObject({
          number: num,
          url: str.optional(),
          action: z.enum([
            "created",
            "edited",
            "merged",
            "commented",
            "closed",
            "reopened",
            "ready",
            "draft",
            "auto-merge-enabled",
            "auto-merge-disabled",
          ]),
        })
        .optional(),
    })
    .optional(),
});

const imageType = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const ReadShape = z.union([
  z.strictObject({
    type: z.literal("text"),
    file: z.strictObject({
      filePath: str,
      content: str,
      numLines: num,
      startLine: num,
      totalLines: num,
      truncatedByTokenCap: z.boolean().optional(),
    }),
    artifactRead: z.strictObject({ slug: str, ver: str }).optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    file: z.strictObject({
      base64: str,
      type: imageType,
      originalSize: num,
      dimensions: z
        .strictObject({
          originalWidth: num.optional(),
          originalHeight: num.optional(),
          displayWidth: num.optional(),
          displayHeight: num.optional(),
        })
        .optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("notebook"),
    file: z.strictObject({ filePath: str, cells: z.array(z.unknown()) }),
  }),
  z.strictObject({
    type: z.literal("pdf"),
    file: z.strictObject({ filePath: str, base64: str, originalSize: num }),
  }),
  z.strictObject({
    type: z.literal("parts"),
    file: z.strictObject({ filePath: str, originalSize: num, count: num, outputDir: str }),
    firstPage: num.optional(),
    pages: z
      .array(z.strictObject({ base64: str, mediaType: imageType, error: str.optional() }))
      .optional(),
  }),
  z.strictObject({
    type: z.literal("file_unchanged"),
    file: z.strictObject({ filePath: str }),
    source: z.literal("seeded").optional(),
  }),
]);

const EditShape = z.strictObject({
  filePath: str,
  oldString: str,
  newString: str,
  originalFile: str.nullable(),
  structuredPatch: z.array(patchHunk),
  userModified: z.boolean(),
  replaceAll: z.boolean(),
  gitDiff: gitDiff.optional(),
  staged: z.boolean().optional(),
});

const WriteShape = z.strictObject({
  type: z.enum(["create", "update"]),
  filePath: str,
  content: str,
  structuredPatch: z.array(patchHunk),
  originalFile: str.nullable(),
  gitDiff: gitDiff.optional(),
  userModified: z.boolean().optional(),
  staged: z.boolean().optional(),
});

const GlobShape = z.strictObject({
  durationMs: num,
  numFiles: num,
  filenames: z.array(str),
  truncated: z.boolean(),
  totalMatches: num.optional(),
  countIsComplete: z.boolean().optional(),
});

const GrepShape = z.strictObject({
  mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  numFiles: num,
  filenames: z.array(str),
  content: str.optional(),
  numLines: num.optional(),
  numMatches: num.optional(),
  totalFiles: num.optional(),
  totalLines: num.optional(),
  appliedLimit: num.optional(),
  appliedOffset: num.optional(),
});

const NotebookEditShape = z.strictObject({
  new_source: str,
  old_source: str.optional(),
  cell_id: str.optional(),
  cell_type: z.enum(["code", "markdown"]),
  language: str,
  edit_mode: str,
  error: str.optional(),
  notebook_path: str,
  original_file: str,
  updated_file: str,
});

const todo = z.strictObject({
  content: str,
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: str,
});
const TodoWriteShape = z.strictObject({ oldTodos: z.array(todo), newTodos: z.array(todo) });

const WebFetchShape = z.strictObject({
  bytes: num,
  code: num,
  codeText: str,
  result: str,
  durationMs: num,
  url: str,
  artifactRead: z
    .strictObject({ slug: str, ver: str.optional(), seeded: z.literal(false).optional() })
    .optional(),
});

const WebSearchShape = z.strictObject({
  query: str,
  results: z.array(
    z.union([
      z.strictObject({
        tool_use_id: str,
        content: z.array(z.strictObject({ title: str, url: str, snippet: str.optional() })),
      }),
      str,
    ]),
  ),
  durationSeconds: num,
  searchCount: num.optional(),
});

/**
 * Each built-in tool whose output may be handed back with a secret scrubbed out, with its
 * shape. A built-in tool not named here (LS, MultiEdit, NotebookRead, Task, ...: Claude Code
 * has no output type for them, or one this guard does not know) is refused when its output
 * holds a resolved secret.
 */
export const CC_TOOL_OUTPUT_SHAPES: Readonly<Record<string, z.ZodType>> = Object.freeze({
  Bash: BashShape,
  Read: ReadShape,
  Edit: EditShape,
  Write: WriteShape,
  Glob: GlobShape,
  Grep: GrepShape,
  NotebookEdit: NotebookEditShape,
  TodoWrite: TodoWriteShape,
  WebFetch: WebFetchShape,
  WebSearch: WebSearchShape,
});

/**
 * Why a built-in tool's replacement output cannot be confirmed to keep the tool's own shape, or
 * null when it can: the tool has a known shape, the output Claude Code gave matches it, and the
 * replacement matches it too (a fixed word changed by the scrub fails here).
 */
export function unconfirmedToolOutput(
  tool: string,
  original: unknown,
  replacement: unknown,
): string | null {
  const shape = Object.hasOwn(CC_TOOL_OUTPUT_SHAPES, tool) ? CC_TOOL_OUTPUT_SHAPES[tool] : null;
  if (!shape) return `Claude Code's ${tool} tool has no output shape this run can check`;
  if (!shape.safeParse(original).success)
    return `Claude Code's ${tool} tool gave an output in a shape this run does not know`;
  if (!shape.safeParse(replacement).success)
    return `the scrubbed output of Claude Code's ${tool} tool would not keep its shape`;
  return null;
}

// The ties to the SDK's own types: a shape that drifts from `sdk-tools.d.ts` fails typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function tie<_T extends true>(): void {}
tie<Same<z.infer<typeof BashShape>, BashOutput>>();
tie<Same<z.infer<typeof ReadShape>, FileReadOutput>>();
tie<Same<z.infer<typeof EditShape>, FileEditOutput>>();
tie<Same<z.infer<typeof WriteShape>, FileWriteOutput>>();
tie<Same<z.infer<typeof GlobShape>, GlobOutput>>();
tie<Same<z.infer<typeof GrepShape>, GrepOutput>>();
tie<Same<z.infer<typeof NotebookEditShape>, NotebookEditOutput>>();
tie<Same<z.infer<typeof TodoWriteShape>, TodoWriteOutput>>();
tie<Same<z.infer<typeof WebFetchShape>, WebFetchOutput>>();
tie<Same<z.infer<typeof WebSearchShape>, WebSearchOutput>>();
