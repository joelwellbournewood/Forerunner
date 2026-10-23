import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import type { SourceActor, SourceDiscovery } from "./discovery.ts";
import {
  AcceptCandidateBody,
  AcceptCandidateView,
  AddSourceBody,
  RemoveSourceView,
  ScanResultView,
  SOURCE_CANDIDATE_STATUSES,
  type SourceCandidateStatus,
  SourceCandidateView,
  SourceView,
} from "./types.ts";

/**
 * The daemon's `/sources` routes (spec A.4), mounted by `createDaemonApp`
 * (`app.route("/", createSourcesRoutes(deps))`) behind its bearer check. Every body and
 * answer is a zod shape from `types.ts`; the actor is the daemon's human, and a source of
 * another human answers 403 `forbidden` the way the inbox does (ADR 0041 item 4).
 */
export interface SourcesRoutesDeps {
  discovery: SourceDiscovery;
  actor: (c: Context) => SourceActor;
}

function statusFor(err: ForerunnerError): 400 | 403 | 404 | 409 | 503 | 500 {
  if (err.code === "validation" && err.details.conflict === true) return 409;
  switch (err.code) {
    case "not_found":
      return 404;
    case "validation":
    case "not_supported":
      return 400;
    case "tool_not_allowed":
    case "approval_required":
    case "autonomy_insufficient":
    case "path_not_allowed":
      return 403;
    case "provider_auth":
    case "provider_rate_limit":
    case "provider_error":
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown = {};
  const text = await c.req.text();
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ForerunnerError("validation", "request body must be JSON");
    }
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

function statusQuery(c: Context): SourceCandidateStatus | undefined {
  const raw = c.req.query("status");
  if (raw === undefined || raw === "") return undefined;
  if (!(SOURCE_CANDIDATE_STATUSES as readonly string[]).includes(raw)) {
    throw new ForerunnerError(
      "validation",
      `status must be one of ${SOURCE_CANDIDATE_STATUSES.join(", ")}`,
      {
        details: { reason: "bad_query", param: "status" },
      },
    );
  }
  return raw as SourceCandidateStatus;
}

export function createSourcesRoutes(deps: SourcesRoutesDeps): Hono {
  const app = new Hono();
  const logger = log("sources:routes");

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      const status = statusFor(err);
      const code =
        status === 409
          ? "conflict"
          : status === 403 && err.details.forbidden
            ? "forbidden"
            : err.code;
      return c.json(
        { code, message: err.message, details: { ...err.details, cause: err.code } },
        status,
      );
    }
    logger.error("unhandled", { error: errorMessage(err) });
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  app.get("/sources", async (c) =>
    c.json((await deps.discovery.list(deps.actor(c))).map((v) => SourceView.parse(v))),
  );

  app.post("/sources", async (c) => {
    const body = await jsonBody(c, AddSourceBody);
    return c.json(SourceView.parse(await deps.discovery.add(body, deps.actor(c))), 201);
  });

  // Before `/sources/:id` so "candidates" is never read as a source id.
  app.post("/sources/candidates/:id/accept", async (c) => {
    const body = await jsonBody(c, AcceptCandidateBody);
    const result = await deps.discovery.accept(c.req.param("id"), body, deps.actor(c));
    return c.json(AcceptCandidateView.parse(result), 201);
  });

  app.get("/sources/:id", async (c) =>
    c.json(SourceView.parse(await deps.discovery.get(c.req.param("id"), deps.actor(c)))),
  );

  app.post("/sources/:id/scan", async (c) =>
    c.json(ScanResultView.parse(await deps.discovery.scan(c.req.param("id"), deps.actor(c)))),
  );

  app.get("/sources/:id/candidates", async (c) => {
    const status = statusQuery(c);
    const rows = await deps.discovery.candidates(c.req.param("id"), deps.actor(c), status);
    return c.json(rows.map((r) => SourceCandidateView.parse(r)));
  });

  app.delete("/sources/:id", async (c) =>
    c.json(RemoveSourceView.parse(await deps.discovery.remove(c.req.param("id"), deps.actor(c)))),
  );

  return app;
}
