import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type DataAssets, normalizeKind } from "./assets.ts";
import type { DataImporter } from "./import.ts";
import {
  type DataActor,
  DataAssetList,
  DataAssetView,
  DataSample,
  ImportResultView,
} from "./types.ts";

/**
 * Routes of the project page's Data tab, mounted by the daemon
 * (`app.route("/", createDataRoutes(deps))`). Shapes are zod so the UI validates both sides;
 * the list and register responses are a superset of the UI's proposed `DataAssetView`.
 */
export const RegisterDataBody = z
  .object({
    locator: z.string().min(1).max(4096),
    /** The UI's kinds (folder, csv, parquet, sqlite, zip, dataset, other) or file|folder|dataset. */
    kind: z.string().max(40).optional(),
    mode: z.enum(["copy", "link"]).optional(),
    name: z.string().min(1).max(200).optional(),
    sizeBytes: z.number().int().min(0).optional(),
  })
  .strict();
export type RegisterDataBody = z.infer<typeof RegisterDataBody>;

export const ImportDataBody = z
  .object({
    source: z.enum(["zip", "folder"]),
    path: z.string().min(1).max(4096).optional(),
    /** Alias of `path`, the UI's word. */
    locator: z.string().min(1).max(4096).optional(),
    copy: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.path !== undefined || b.locator !== undefined, {
    message: "path (or locator) is required",
  });
export type ImportDataBody = z.infer<typeof ImportDataBody>;

export const OkView = z.object({
  ok: z.literal(true),
  id: z.string(),
  deletedFromDisk: z.boolean(),
});

export const DATA_ROUTES = [
  "GET /projects/:id/data",
  "POST /projects/:id/data",
  "POST /projects/:id/data/import",
  "GET /data/:id",
  "GET /data/:id/sample",
  "DELETE /data/:id",
] as const;

export interface DataRoutesDeps {
  assets: DataAssets;
  importer: DataImporter;
  /** Who is acting: the daemon's human. `DELETE` refuses an actor without a human. */
  actor: (c: Context) => DataActor;
  /** The project worktree, when known, so imports can add the gitignore line. */
  worktreeFor?: (projectId: string) => Promise<string | undefined> | string | undefined;
}

function statusFor(err: ForerunnerError): 400 | 403 | 404 | 409 | 413 | 500 | 503 {
  if (err.code === "validation" && err.details.tooLarge === true) return 413;
  switch (err.code) {
    case "not_found":
      return 404;
    case "validation":
    case "not_supported":
      return 400;
    case "version_conflict":
      return 409;
    case "approval_required":
    case "autonomy_insufficient":
    case "tool_not_allowed":
    case "domain_not_allowed":
    case "path_not_allowed":
      return 403;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ForerunnerError("validation", "request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ForerunnerError("validation", "invalid request body", {
      details: {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

function intQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new ForerunnerError("validation", `${name} must be a positive integer`);
  return n;
}

export function createDataRoutes(deps: DataRoutesDeps): Hono {
  const app = new Hono();
  const logger = log("data:routes");

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, statusFor(err));
    }
    logger.error("unhandled", { error: errorMessage(err) });
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  app.get("/projects/:id/data", async (c) => {
    const views = await deps.assets.list(c.req.param("id"));
    return c.json(DataAssetList.parse(views));
  });

  // JSON registers a path or URI; multipart (field "file", optional "kind", "name") uploads.
  app.post("/projects/:id/data", async (c) => {
    const projectId = c.req.param("id");
    const actor = deps.actor(c);
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const form = await c.req.parseBody({ all: false });
      const file = form.file;
      if (!(file instanceof File)) {
        throw new ForerunnerError("validation", "multipart field 'file' is required");
      }
      if (file.size > deps.assets.limits.uploadMaxBytes) {
        throw new ForerunnerError(
          "validation",
          `upload of ${file.size} bytes exceeds the cap of ${deps.assets.limits.uploadMaxBytes}; register large data by path or URI instead`,
          { details: { tooLarge: true, maxBytes: deps.assets.limits.uploadMaxBytes } },
        );
      }
      const kind = typeof form.kind === "string" ? normalizeKind(form.kind) : undefined;
      const name = typeof form.name === "string" && form.name ? form.name : file.name || "upload";
      const view = await deps.assets.registerUpload(
        { projectId, name, bytes: new Uint8Array(await file.arrayBuffer()), kind },
        actor,
      );
      return c.json(DataAssetView.parse(view), 201);
    }
    const b = await jsonBody(c, RegisterDataBody);
    const view = await deps.assets.register(
      {
        projectId,
        source: b.locator,
        kind: normalizeKind(b.kind),
        mode: b.mode,
        name: b.name,
        sizeBytes: b.sizeBytes,
      },
      actor,
    );
    return c.json(DataAssetView.parse(view), 201);
  });

  app.post("/projects/:id/data/import", async (c) => {
    const projectId = c.req.param("id");
    const b = await jsonBody(c, ImportDataBody);
    const path = (b.path ?? b.locator) as string;
    const worktreePath = await deps.worktreeFor?.(projectId);
    const opts = { actor: deps.actor(c), worktreePath, copy: b.copy };
    const result =
      b.source === "zip"
        ? await deps.importer.importZip(path, projectId, opts)
        : await deps.importer.importFolder(path, projectId, opts);
    return c.json(ImportResultView.parse(result));
  });

  app.get("/data/:id", async (c) =>
    c.json(DataAssetView.parse(await deps.assets.get(c.req.param("id")))),
  );

  app.get("/data/:id/sample", async (c) => {
    const s = await deps.assets.sample(c.req.param("id"), {
      rows: intQuery(c, "rows"),
      bytes: intQuery(c, "bytes"),
    });
    return c.json(DataSample.parse(s));
  });

  app.delete("/data/:id", async (c) => {
    const r = await deps.assets.remove(c.req.param("id"), deps.actor(c));
    return c.json(OkView.parse({ ok: true, ...r }));
  });

  return app;
}
