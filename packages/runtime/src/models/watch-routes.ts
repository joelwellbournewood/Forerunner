/**
 * Daemon routes for the model watch, mounted by the orchestrator (for example under
 * /model-watch). The updates screen (spec M.5) lists `GET /reports`; the inbox answers through
 * `POST /reports/:id/answer`. Every answer must carry the human id that gave it; the watch
 * refuses to change anything without it.
 */
import { ForerunnerError } from "@forerunner/platform";
import { Hono } from "hono";
import { z } from "zod";
import type { ModelWatch } from "./watch.ts";

export interface ModelWatchRoutesDeps {
  watch: ModelWatch;
}

export const ModelWatchAnswerBody = z
  .object({
    decision: z.enum(["adopt", "ignore", "remind"]),
    adopt: z.array(z.string().min(1)).optional(),
    by: z.string().min(1),
  })
  .strict();

function errorBody(e: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  if (e instanceof ForerunnerError) return { code: e.code, message: e.message, details: e.details };
  return { code: "internal", message: e instanceof Error ? e.message : String(e), details: {} };
}

export function createModelWatchRoutes(deps: ModelWatchRoutesDeps): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    const body = errorBody(e);
    if (body.code === "not_found") return c.json(body, 404);
    if (body.code === "validation") return c.json(body, 400);
    if (body.code === "approval_required") return c.json(body, 403);
    return c.json(body, 500);
  });

  app.get("/reports", async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 20;
    return c.json({ reports: await deps.watch.listReports({ limit }) });
  });

  app.get("/reports/latest", async (c) => {
    const found = await deps.watch.latestReport();
    if (!found) return c.json({ report: null, health: null });
    return c.json({ report: found.report, health: found.health });
  });

  app.get("/reports/:id", async (c) => {
    const found = await deps.watch.getReport(c.req.param("id"));
    return c.json({ report: found.report, health: found.health });
  });

  app.post("/run", async (c) => {
    const r = await deps.watch.run();
    return c.json({
      report: r.report,
      decision: r.decision,
      requestId: r.requestId,
      applied: r.applied,
    });
  });

  app.post("/reports/:id/answer", async (c) => {
    const parsed = ModelWatchAnswerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          code: "validation",
          message: "answer body is malformed",
          details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        },
        400,
      );
    }
    const r = await deps.watch.resolve(c.req.param("id"), parsed.data);
    return c.json({ decision: r.decision, applied: r.applied, status: r.release.status });
  });

  app.post("/sync", async (c) => c.json({ resolved: await deps.watch.syncPendingAnswers() }));

  return app;
}
