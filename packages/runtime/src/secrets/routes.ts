import { isForerunnerError } from "@forerunner/platform";
import { SECRET_NAME_PATTERN } from "@forerunner/vault";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ProposedSharedSecret } from "./propose.ts";
import type { SharedGrantView } from "./shared-grants.ts";

/**
 * The daemon's shared-secret routes (spec S.13, ADR 0065), for the app on this install:
 *   POST /secrets/shared { name, agentIds, why?, kind? }  -> 201 { grant, requestIds, targets }
 *   GET  /secrets/shared                                  -> { grants }
 *   POST /secrets/shared/:id/revoke                       -> { grant }
 * The value is read from this install's vault and wrapped inside the runtime; no body carries
 * it in either direction. Mounted behind the daemon's bearer check.
 */
export interface SharedSecretRoutesDeps {
  sharedSecrets: {
    propose(input: {
      name: string;
      agentIds: string[];
      why?: string;
      kind?: string;
    }): Promise<ProposedSharedSecret>;
    revoke(grantId: string): Promise<SharedGrantView>;
    list(): Promise<SharedGrantView[]>;
  };
}

const ProposeBody = z.object({
  name: z.string().regex(SECRET_NAME_PATTERN, "invalid secret name"),
  agentIds: z.array(z.string().min(1)).min(1).max(50),
  why: z.string().max(2000).optional(),
  kind: z.string().max(40).optional(),
});

function statusFor(code: string): ContentfulStatusCode {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
      return 400;
    case "secret_not_granted":
    case "tool_not_allowed":
      return 403;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

export function createSharedSecretRoutes(deps: SharedSecretRoutesDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (isForerunnerError(err)) {
      const status = statusFor(err.code);
      return c.json(
        {
          code: err.code,
          message: status === 500 ? "internal error" : err.message,
          details: status === 500 ? {} : (err.details ?? {}),
        },
        status,
      );
    }
    return c.json({ code: "internal", message: "internal error", details: {} }, 500);
  });

  app.get("/secrets/shared", async (c) => c.json({ grants: await deps.sharedSecrets.list() }));

  app.post("/secrets/shared", async (c) => {
    const parsed = ProposeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          code: "validation",
          message: "invalid request body",
          details: { issues: parsed.error.issues.map((i) => i.path.join(".")) },
        },
        400,
      );
    }
    return c.json(await deps.sharedSecrets.propose(parsed.data), 201);
  });

  app.post("/secrets/shared/:id/revoke", async (c) =>
    c.json({ grant: await deps.sharedSecrets.revoke(c.req.param("id")) }),
  );

  return app;
}
