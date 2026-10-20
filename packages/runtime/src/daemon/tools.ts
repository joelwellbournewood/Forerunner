import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ForerunnerError, isInside, join, resolve, run } from "@forerunner/platform";
import { z } from "zod";
import { ToolRegistry, type ToolSpec } from "../agent/tools.ts";

/**
 * Forerunner's built-in tools for in-process specialists: files inside the worktree and a
 * command runner pinned to it. Paths are checked by the hooks (pathFields) and again here.
 */
function inside(ctx: { cwd?: string; allowedPaths: readonly string[] }, p: string): string {
  const abs = resolve(ctx.cwd ?? ".", p);
  if (!ctx.allowedPaths.some((root) => isInside(root, abs))) {
    throw new ForerunnerError("path_not_allowed", `path outside the worktree: ${p}`);
  }
  return abs;
}

export function fileTools(): ToolRegistry {
  const readFile: ToolSpec<{ path: string }> = {
    name: "read_file",
    description: "Read a UTF-8 text file inside the worktree.",
    schema: z.object({ path: z.string().min(1) }),
    actionClass: "read",
    risk: "low",
    pathFields: ["path"],
    async execute(input, ctx) {
      const abs = inside(ctx, input.path);
      const text = readFileSync(abs, "utf8");
      return {
        content: text.length > 200_000 ? `${text.slice(0, 200_000)}\n…[truncated]` : text,
        untrusted: { source: "repo_file", origin: input.path },
      };
    },
  };
  const writeFile: ToolSpec<{ path: string; content: string }> = {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file inside the worktree.",
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["path"],
    async execute(input, ctx) {
      const abs = inside(ctx, input.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, input.content);
      return { content: `wrote ${input.path} (${input.content.length} chars)` };
    },
  };
  const listDir: ToolSpec<{ path?: string; depth?: number }> = {
    name: "list_dir",
    description: "List files under a directory of the worktree (depth 1-3).",
    schema: z.object({
      path: z.string().optional(),
      depth: z.number().int().min(1).max(3).optional(),
    }),
    actionClass: "read",
    risk: "low",
    pathFields: ["path"],
    async execute(input, ctx) {
      const root = inside(ctx, input.path ?? ".");
      const out: string[] = [];
      const walk = (dir: string, depth: number, prefix: string) => {
        for (const e of readdirSync(dir)) {
          if (e === ".git" || e === "node_modules") continue;
          const p = join(dir, e);
          const isDir = statSync(p).isDirectory();
          out.push(`${prefix}${e}${isDir ? "/" : ""}`);
          if (isDir && depth > 1) walk(p, depth - 1, `${prefix}${e}/`);
          if (out.length > 2000) return;
        }
      };
      walk(root, input.depth ?? 2, "");
      return { content: out.join("\n") || "(empty)" };
    },
  };
  const runCommand: ToolSpec<{ argv: string[]; timeoutSec?: number }> = {
    name: "run_command",
    description:
      'Run a command (argv array, no shell) inside the worktree, e.g. ["pnpm","test"]. Output is captured.',
    schema: z.object({
      argv: z.array(z.string().min(1)).min(1),
      timeoutSec: z.number().int().min(1).max(1800).optional(),
    }),
    actionClass: "routine_reversible",
    risk: "medium",
    timeoutMs: 30 * 60 * 1000,
    async execute(input, ctx) {
      if (!ctx.cwd) return { content: "no worktree for this run", isError: true };
      const r = await run(input.argv, {
        cwd: ctx.cwd,
        timeoutMs: (input.timeoutSec ?? 600) * 1000,
        allowFailure: true,
        signal: ctx.signal,
        maxOutputBytes: 512 * 1024,
      });
      const content = `exit ${r.code}${r.timedOut ? " (timeout)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      return {
        content,
        isError: r.code !== 0,
        untrusted: { source: "tool_output", origin: input.argv[0] },
      };
    },
  };
  return new ToolRegistry()
    .register(readFile)
    .register(writeFile)
    .register(listDir)
    .register(runCommand);
}
