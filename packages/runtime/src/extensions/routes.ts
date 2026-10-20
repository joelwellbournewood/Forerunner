import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { CatalogEntry } from "./catalog.ts";
import type { ExtensionRegistry } from "./registry.ts";
import { type Actor, EXTENSION_PANEL_KINDS, ExtensionPermissions, ExtensionView } from "./types.ts";

/**
 * Routes of the Extensions panel, mounted by the daemon (`app.route("/", createExtensionsRoutes(deps))`).
 * Bodies and responses are zod shapes so the UI validates both sides.
 */
export const AddExtensionBody = z.union([
  z.object({ catalogId: z.string().min(1) }).strict(),
  z.object({ url: z.string().url() }).strict(),
]);
export type AddExtensionBody = z.infer<typeof AddExtensionBody>;

export const ToggleExtensionBody = z.object({ enabled: z.boolean() }).strict();
export type ToggleExtensionBody = z.infer<typeof ToggleExtensionBody>;

export const UpdatePermissionsBody = z
  .object({ permissions: ExtensionPermissions.partial() })
  .strict();
export type UpdatePermissionsBody = z.infer<typeof UpdatePermissionsBody>;

export const CatalogView = z.object({
  remoteUrl: z.string().nullable(),
  entries: z.array(CatalogEntry),
});
export type CatalogView = z.infer<typeof CatalogView>;

export const ExtensionListView = z.array(ExtensionView);

export const EXTENSION_ROUTES = [
  "GET /extensions",
  "GET /extensions/catalog",
  "GET /extensions/:id",
  "POST /extensions",
  "POST /extensions/:id/toggle",
  "POST /extensions/:id/approve",
  "POST /extensions/:id/deny",
  "PUT /extensions/:id/permissions",
  "DELETE /extensions/:id",
] as const;

export interface ExtensionsRoutesDeps {
  registry: ExtensionRegistry;
  /** Who is acting (the daemon's human); default: nobody named. */
  actor?: (c: Context) => Actor;
}

function statusFor(code: ForerunnerError["code"]): 400 | 403 | 404 | 409 | 503 | 500 {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
      return 400;
    case "version_conflict":
      return 409;
    case "approval_required":
    case "autonomy_insufficient":
    case "tool_not_allowed":
    case "domain_not_allowed":
    case "path_not_allowed":
    case "secret_not_granted":
      return 403;
    case "unavailable":
    case "provider_auth":
      return 503;
    default:
      return 500;
  }
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
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

export function createExtensionsRoutes(deps: ExtensionsRoutesDeps): Hono {
  const app = new Hono();
  const logger = log("extensions:routes");
  const actor = (c: Context): Actor => deps.actor?.(c) ?? {};

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      return c.json(
        { code: err.code, message: err.message, details: err.details },
        statusFor(err.code),
      );
    }
    logger.error("unhandled", { error: errorMessage(err) });
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  app.get("/extensions", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && !(EXTENSION_PANEL_KINDS as readonly string[]).includes(kind)) {
      throw new ForerunnerError("validation", `unknown kind ${kind}`);
    }
    const rows = await deps.registry.list(
      kind ? { kind: kind as (typeof EXTENSION_PANEL_KINDS)[number] } : {},
    );
    return c.json(ExtensionListView.parse(rows));
  });

  app.get("/extensions/catalog", (c) => {
    const view: CatalogView = {
      remoteUrl: deps.registry.catalog.remoteUrl,
      entries: deps.registry.catalog.entries(),
    };
    return c.json(view);
  });

  app.get("/extensions/:id", async (c) => c.json(await deps.registry.get(c.req.param("id"))));

  app.post("/extensions", async (c) => {
    const b = await body(c, AddExtensionBody);
    const view =
      "catalogId" in b
        ? await deps.registry.addFromCatalog(b.catalogId, actor(c))
        : await deps.registry.addFromUrl(b.url, actor(c));
    return c.json(view, view.status === "pending_approval" ? 202 : 201);
  });

  app.post("/extensions/:id/toggle", async (c) => {
    const b = await body(c, ToggleExtensionBody);
    return c.json(await deps.registry.toggle(c.req.param("id"), b.enabled, actor(c)));
  });

  // A yes at stage "discovery" runs discovery and asks for the grant: 202 while that is open.
  app.post("/extensions/:id/approve", async (c) => {
    const view = await deps.registry.approve(c.req.param("id"), actor(c));
    return c.json(view, view.status === "pending_approval" ? 202 : 200);
  });

  app.post("/extensions/:id/deny", async (c) => {
    await deps.registry.deny(c.req.param("id"), actor(c));
    return c.json({ ok: true });
  });

  app.put("/extensions/:id/permissions", async (c) => {
    const b = await body(c, UpdatePermissionsBody);
    const view = await deps.registry.updatePermissions(c.req.param("id"), b.permissions, actor(c));
    return c.json(view, view.status === "pending_approval" ? 202 : 200);
  });

  app.delete("/extensions/:id", async (c) => {
    await deps.registry.remove(c.req.param("id"), actor(c));
    return c.json({ ok: true });
  });

  return app;
}
