/**
 * Scripted specialist and critic replies for the release scenarios: what the fake provider
 * answers when a coder or the critic is asked. A scenario composes these per task; the
 * production runner, executor, critic loop and PR flow do everything else.
 *
 * - `coderWrites(title, files, report)`: the coder on the task whose brief carries `title`
 *   writes each file (one tool call per file, audited) and then reports.
 * - `coderRunaway(title, active)`: the coder keeps calling `read_file` with a long reply as long
 *   as `active()` holds; the budget hooks are what stop it.
 * - `criticAccepts()`: the critic accepts with high confidence on every review (the rules in
 *   code still turn a tier 3 accept into a human sign-off).
 */
import type { ModelRequest, ScriptedReply } from "@forerunner/testenv";
import { textReply, toolReply } from "@forerunner/testenv";
import {
  briefOf,
  closingReply,
  hasTool,
  lastIsToolResult,
  specialistReportTurn,
  specialistTurn,
  submitReview,
} from "./world.ts";

/** The coder's request for the task whose brief names `title`. */
export function coderOn(title: string): (req: ModelRequest) => boolean {
  return (req) => hasTool(req, "write_file") && briefOf(req).includes(title);
}

/** Files already written in this conversation (the write_file calls the model made so far). */
function writtenSoFar(req: ModelRequest): Set<string> {
  const out = new Set<string>();
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const block = b as { type?: string; name?: string; input?: { path?: unknown } };
      if (
        block.type === "tool_use" &&
        block.name === "write_file" &&
        typeof block.input?.path === "string"
      )
        out.add(block.input.path);
    }
  }
  return out;
}

export function coderWrites(
  title: string,
  files: Record<string, string>,
  report = "Implemented the change and verified it by reading the file back.",
): ScriptedReply[] {
  const on = coderOn(title);
  const paths = Object.keys(files);
  const replies: ScriptedReply[] = [];
  for (const path of paths) {
    replies.push(
      toolReply("write_file", { path, content: files[path] ?? "" }, `Writing ${path}.`, {
        when: (req) =>
          on(req) && !writtenSoFar(req).has(path) && (specialistTurn(req) || lastIsToolResult(req)),
        times: Number.POSITIVE_INFINITY,
      }),
    );
  }
  replies.push(
    textReply(report, {
      when: (req) => on(req) && specialistReportTurn(req),
      times: Number.POSITIVE_INFINITY,
    }),
  );
  return replies;
}

export function coderRunaway(title: string, active: () => boolean, chars = 4000): ScriptedReply {
  const on = coderOn(title);
  return toolReply("read_file", { path: "README.md" }, "x".repeat(chars), {
    when: (req) => active() && on(req),
    times: Number.POSITIVE_INFINITY,
  });
}

export function criticAccepts(summary?: string): ScriptedReply[] {
  return [submitReview(summary ? { summary } : {}), closingReply()];
}
