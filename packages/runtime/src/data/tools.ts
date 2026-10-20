import { ForerunnerError, isInside, resolve } from "@forerunner/platform";
import { z } from "zod";
import type { ToolExecutionContext, ToolRegistry, ToolSpec } from "../agent/tools.ts";
import type { ApprovalPort } from "../enforcement/ports.ts";
import type { DataAssets } from "./assets.ts";
import { parseUri } from "./metadata.ts";
import { DATA_ASSET_KINDS, type DataAssetView, type DataSample, formatBytes } from "./types.ts";

/**
 * The four data tools an agent may hold. None returns a whole file: `data_sample` is capped
 * at `limits.sampleBytes` by its schema and again by the service; `data_describe` returns
 * metadata and the stored sample. Output is marked untrusted (it comes from files other
 * people wrote) so the hooks wrap it as data and scan it. `data_register` for a path outside
 * the run's allowed roots, or for a URI, asks the human through the approval port first.
 * There is no removal tool: deleting data always needs a human (spec S.6).
 */
export const DATA_TOOL_NAMES = [
  "data_list",
  "data_describe",
  "data_sample",
  "data_register",
] as const;
export type DataToolName = (typeof DATA_TOOL_NAMES)[number];

export interface DataToolsDeps {
  assets: DataAssets;
  approvals: ApprovalPort;
}

function projectOf(ctx: ToolExecutionContext): string {
  if (!ctx.projectId) {
    throw new ForerunnerError("validation", "this run has no project; data tools need one");
  }
  return ctx.projectId;
}

/** An asset is visible to a run only when it belongs to the run's project. */
function assertInProject(view: DataAssetView, ctx: ToolExecutionContext): void {
  const projectId = projectOf(ctx);
  if (!view.projectIds.includes(projectId)) {
    throw new ForerunnerError(
      "not_found",
      `data asset ${view.id} is not registered in this project`,
      {
        details: { id: view.id, projectId },
      },
    );
  }
}

function summaryLine(v: DataAssetView): string {
  const rows =
    v.metadata?.rowCount != null
      ? `, ${v.metadata.rowCount}${v.metadata.rowCountExact ? "" : "~"} rows`
      : "";
  const dims = v.metadata?.dimensions
    ? `, ${v.metadata.dimensions.width}x${v.metadata.dimensions.height}`
    : "";
  return `${v.id}  ${v.kind}/${v.format}  ${v.name}  ${formatBytes(v.sizeBytes)}${rows}${dims}  ${v.storage}${v.available ? "" : "  (unavailable)"}`;
}

export function renderSample(view: DataAssetView, sample: DataSample, cap: number): string {
  const header = `${view.name} (${view.format}, ${formatBytes(view.sizeBytes)}): ${sample.note}`;
  let body: string;
  switch (sample.kind) {
    case "rows":
      body = (sample.rows ?? []).map((r) => JSON.stringify(r)).join("\n");
      break;
    case "entries":
      body = (sample.entries ?? []).join("\n");
      break;
    case "text":
      body = sample.text ?? "";
      break;
    default:
      body = "(no sample available)";
  }
  if (body.length > cap)
    body = `${body.slice(0, cap)}\n…[truncated at the sample cap of ${cap} bytes]`;
  return `${header}\n${body}`;
}

export function dataTools(deps: DataToolsDeps): ToolSpec[] {
  const limits = deps.assets.limits;

  const list: ToolSpec<Record<string, never>> = {
    name: "data_list",
    description:
      "List the data assets registered for this project: id, kind/format, name, size, row count, where the bytes live. Use data_describe and data_sample for details.",
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    actionClass: "read",
    risk: "low",
    async execute(_input, ctx) {
      const views = await deps.assets.list(projectOf(ctx));
      const content =
        views.length === 0 ? "(no data assets registered)" : views.map(summaryLine).join("\n");
      return { content, untrusted: { source: "attachment", origin: "data assets" } };
    },
  };

  const describe: ToolSpec<{ assetId: string }> = {
    name: "data_describe",
    description:
      "Metadata of one data asset: format, mime, encoding, columns with inferred types, row count, image dimensions, folder entries, plus a small stored sample. Never the whole file.",
    schema: z.object({ assetId: z.string().min(1) }).strict(),
    actionClass: "read",
    risk: "low",
    async execute(input, ctx) {
      const view = await deps.assets.describe(input.assetId);
      assertInProject(view, ctx);
      const { sample, ...rest } = view;
      let content = JSON.stringify({ ...rest, storedSample: sample }, null, 1);
      if (content.length > limits.sampleBytes)
        content = `${content.slice(0, limits.sampleBytes)}\n…[truncated]`;
      return { content, untrusted: { source: "attachment", origin: view.name } };
    },
  };

  const sample: ToolSpec<{ assetId: string; rows?: number; bytes?: number }> = {
    name: "data_sample",
    description: `First rows (csv, jsonl, json arrays), first bytes (text) or first entries (folders) of a data asset. Hard cap ${limits.sampleBytes} bytes and ${limits.maxSampleRows} rows per call; nothing returns a whole file.`,
    schema: z
      .object({
        assetId: z.string().min(1),
        rows: z.number().int().min(1).max(limits.maxSampleRows).optional(),
        bytes: z.number().int().min(1).max(limits.sampleBytes).optional(),
      })
      .strict(),
    actionClass: "read",
    risk: "low",
    async execute(input, ctx) {
      const view = await deps.assets.describe(input.assetId);
      assertInProject(view, ctx);
      const cap = Math.min(input.bytes ?? limits.sampleBytes, limits.sampleBytes);
      const s = await deps.assets.sample(input.assetId, {
        rows: Math.min(input.rows ?? limits.sampleRows, limits.maxSampleRows),
        bytes: cap,
      });
      return {
        content: renderSample(view, s, cap),
        untrusted: { source: "attachment", origin: view.name },
      };
    },
  };

  const register: ToolSpec<{
    source: string;
    kind?: (typeof DATA_ASSET_KINDS)[number];
    mode?: "copy" | "link";
    name?: string;
  }> = {
    name: "data_register",
    description:
      "Register a file, folder or dataset for this project by absolute path or URI (s3://, r2://, gs://, https://). Paths outside the run's allowed roots and URIs need the human's approval. Large sources are linked, never copied.",
    schema: z
      .object({
        source: z.string().min(1).max(4096),
        kind: z.enum(DATA_ASSET_KINDS).optional(),
        mode: z.enum(["copy", "link"]).optional(),
        name: z.string().min(1).max(200).optional(),
      })
      .strict(),
    actionClass: "non_routine",
    risk: "medium",
    async execute(input, ctx) {
      const projectId = projectOf(ctx);
      const uri = parseUri(input.source);
      const remote = uri !== null;
      // A URI is reduced to scheme://host/path here, before the approval text, the row, the
      // audit log or this tool's output can carry credentials or a signed query.
      let source = uri ? uri.locator : input.source;
      let needsApproval = remote;
      if (!uri) {
        source = ctx.cwd ? resolve(ctx.cwd, input.source) : resolve(input.source);
        needsApproval = !ctx.allowedPaths.some((root) => isInside(root, source));
      }
      if (needsApproval) {
        const outcome = await deps.approvals.request({
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          agentId: ctx.agentId,
          humanId: ctx.humanId,
          projectId,
          taskId: ctx.taskId,
          tool: "data_register",
          actionClass: "capability_grant",
          risk: "medium",
          why: remote
            ? `register the remote dataset ${source} for the project (agents will see its description only)`
            : `register ${source}, which lies outside the run's allowed roots, as project data`,
          input: { ...input, source },
        });
        if (outcome !== "approved") {
          throw new ForerunnerError(
            "approval_required",
            outcome === "pending"
              ? "a human must approve registering this source; the request is in the inbox"
              : "the human declined registering this source",
            { details: { outcome, source } },
          );
        }
      }
      const view = await deps.assets.register(
        { projectId, source, kind: input.kind, mode: input.mode, name: input.name },
        { agentId: ctx.agentId, humanId: ctx.humanId, sessionId: ctx.sessionId, runId: ctx.runId },
      );
      const note = view.note ? `\n${view.note}` : "";
      return { content: `registered ${summaryLine(view)}${note}` };
    },
  };

  return [list, describe, sample, register];
}

export function registerDataTools(registry: ToolRegistry, deps: DataToolsDeps): ToolRegistry {
  for (const t of dataTools(deps)) registry.register(t);
  return registry;
}
