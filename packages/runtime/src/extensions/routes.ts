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
  // `confirmIn: "panel"`: the panel's Add on a catalog entry, confirmed there (U-026).
  z.object({ catalogId: z.string().min(1), confirmIn: z.literal("panel").optional() }).strict(),
  z.object({ url: z.string().url() }).strict(),
]);
export type AddExtensionBody = z.infer<typeof AddExtensionBody>;

export const ToggleExtensionBody = z.object({ enabled: z.boolean() }).strict();
export type ToggleExtensionBody = z.infer<typeof ToggleExtensionBody>;

/**
 * The panel's confirmation of a grant (U-026, ADR 0096): a device answer, as on a high-risk
 * change card (`POST /commands/:id/confirm`). No `deviceId`: this PC's own desktop device row.
 * An empty body is the plain yes of an Inbox-asked row, refused for a row confirmed in the panel.
 */
export const ApproveExtensionBody = z
  .object({
    answer: z.literal("device").optional(),
    deviceId: z.string().min(1).optional(),
    biometric: z.boolean().optional(),
  })
  .strict();
export type ApproveExtensionBody = z.infer<typeof ApproveExtensionBody>;

/** What the device check gets: the device named (null: this PC) and the biometric flag. */
export interface DeviceConfirmation {
  deviceId: string | null;
  biometric: boolean;
}

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
  /**
   * The high-risk confirmation on a paired device (ADR 0030, 0096): resolves when the device
   * may confirm a grant for this human, throws `approval_required` with the reason otherwise.
   * The daemon wires the command registry's confirmation policy over this PC's device row.
   * Absent: a device answer is refused (503), never taken as a yes.
   */
  confirmOnDevice?: (answer: DeviceConfirmation, extension: ExtensionView) => Promise<void>;
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

async function body<T>(c: Context, schema: z.ZodType<T>, empty?: unknown): Promise<T> {
  let json: unknown;
  try {
    const text = await c.req.text();
    json = text.trim() === "" && empty !== undefined ? empty : JSON.parse(text);
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
        ? await deps.registry.addFromCatalog(b.catalogId, actor(c), {
            ...(b.confirmIn ? { confirmIn: b.confirmIn } : {}),
          })
        : await deps.registry.addFromUrl(b.url, actor(c));
    return c.json(view, view.status === "pending_approval" ? 202 : 201);
  });

  app.post("/extensions/:id/toggle", async (c) => {
    const b = await body(c, ToggleExtensionBody);
    return c.json(await deps.registry.toggle(c.req.param("id"), b.enabled, actor(c)));
  });

  // A yes at stage "discovery" runs discovery and asks for the grant: 202 while that is open.
  // A row added in the panel is granted only on a device confirmation (U-026, ADR 0096), the
  // bar of every high-risk change on this PC; a device answer is checked for any row.
  app.post("/extensions/:id/approve", async (c) => {
    const id = c.req.param("id");
    const b = await body(c, ApproveExtensionBody, {});
    const current = await deps.registry.get(id);
    if (b.answer === "device") {
      if (!deps.confirmOnDevice) {
        throw new ForerunnerError(
          "unavailable",
          "this service cannot check a device confirmation; confirm in the Forerunner app",
        );
      }
      await deps.confirmOnDevice(
        { deviceId: b.deviceId ?? null, biometric: b.biometric === true },
        current,
      );
    } else if (current.confirmIn === "panel") {
      throw new ForerunnerError(
        "approval_required",
        `${current.name} is granted in the Extensions panel with Confirm on this device (high risk: a paired device confirms it)`,
        { details: { extensionId: id, confirmIn: "panel" } },
      );
    }
    const view = await deps.registry.approve(id, actor(c));
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
