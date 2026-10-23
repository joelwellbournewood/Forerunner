import { isForerunnerError } from "@forerunner/platform";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DeviceManager } from "./manager.ts";
import { StartPairingBody } from "./types.ts";

/**
 * The daemon's device routes (spec R.2), for Settings -> Devices in the app on this install:
 *   GET  /devices                       -> { devices, pairingAvailable }
 *   POST /devices/pairing { kind?, name? } -> 201 PairingStartView (503 without the service)
 *   POST /devices/:id/revoke            -> RevokeDeviceView
 * The state service's admin token stays in the daemon. Mounted behind the bearer check.
 */
export interface DeviceRoutesDeps {
  devices: Pick<DeviceManager, "list" | "startPairing" | "revoke" | "pairingAvailable">;
}

function statusFor(code: string): ContentfulStatusCode {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
      return 400;
    case "tool_not_allowed":
      return 403;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

export function createDeviceRoutes(deps: DeviceRoutesDeps): Hono {
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

  app.get("/devices", async (c) =>
    c.json({
      devices: await deps.devices.list(),
      pairingAvailable: deps.devices.pairingAvailable,
    }),
  );

  app.post("/devices/pairing", async (c) => {
    const parsed = StartPairingBody.safeParse(await c.req.json().catch(() => ({})));
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
    return c.json(await deps.devices.startPairing(parsed.data), 201);
  });

  app.post("/devices/:id/revoke", async (c) =>
    c.json(await deps.devices.revoke(c.req.param("id"))),
  );

  return app;
}
